# meal-platform-backend

Backend API for the factory meal management platform. NestJS + TypeScript,
PostgreSQL via Prisma 7, REST/JSON. All routes are served under the `/v1`
prefix.

This repository is the API half of a two-repository system. The frontend lives
in `meal-platform-frontend`. The API is the only place that enforces
authorization, scope, cutoff rules, and transactions.

## Quick start (backend and frontend)

Clone both repositories into the same parent folder, then run these steps in
order. You need Node.js 20.12 or later, npm, and Docker.

```bash
git clone https://github.com/quangnguyen-pnj/meal-platform-backend.git
git clone https://github.com/quangnguyen-pnj/meal-platform-frontend.git
```

1. Start PostgreSQL and prepare the backend (port 3000):

   ```bash
   cd meal-platform-backend
   cp .env.example .env
   docker compose up -d postgres
   npm install
   npm run prisma:generate
   npm run prisma:migrate
   npm run prisma:seed
   npm run start:dev
   ```

   `prisma:migrate` and `prisma:seed` read `DATABASE_URL` and `SEED_PASSWORD`
   from `.env`. The seed password in `.env.example` is for local use only.

2. In a second terminal, start the frontend (port 3001):

   ```bash
   cd meal-platform-frontend
   cp .env.example .env
   npm install
   npm run dev
   ```

3. Open <http://localhost:3001> and log in with a seeded account, for example
   `lan.tt01@pnj.com.vn`, using the `SEED_PASSWORD` value from the backend
   `.env`. See [Phase 0 seed data](#phase-0-seed-data) for every account.

If `docker compose` is not available, start PostgreSQL with
`docker run -d --name meal-platform-postgres -e POSTGRES_USER=meal_platform -e POSTGRES_PASSWORD=meal_platform -e POSTGRES_DB=meal_platform -p 5432:5432 postgres:17-alpine`.

## Requirements

- Node.js 20+ (developed on 22)
- npm
- Docker (for the local PostgreSQL container)

## Local setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create your local environment file:

   ```bash
   cp .env.example .env
   ```

   Adjust values if needed. Never commit `.env`.

3. Start PostgreSQL (and only PostgreSQL) with Docker Compose:

   ```bash
   docker compose up -d postgres
   ```

   The container reads `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, and
   `POSTGRES_PORT` from `.env`. The API and web apps are run with local commands,
   not inside Compose.

4. Generate the Prisma client and apply migrations:

   ```bash
   npm run prisma:generate
   npm run prisma:migrate
   ```

   `prisma:migrate` runs `prisma migrate dev`, which applies the migrations in
   `prisma/migrations` to the database in `DATABASE_URL`.

5. Seed the Phase 0 mock data:

   ```bash
   SEED_PASSWORD='choose-a-local-password' npm run prisma:seed
   ```

   `SEED_PASSWORD` is required and is hashed with Argon2id for every seeded
   account. Set it locally (or in your `.env`); never commit a real secret. The
   seed is idempotent, so you can re-run it safely. See
   [Phase 0 seed data](#phase-0-seed-data) for what it creates.

6. Start the API:

   ```bash
   npm run start:dev
   ```

   The server listens on `PORT` (default `3000`).

## Health check

```bash
curl http://localhost:3000/v1/health
```

Returns JSON:

```json
{ "status": "ok", "database": "up", "timestamp": "2025-01-01T00:00:00.000Z" }
```

`status` is `degraded` and `database` is `down` when the database is
unreachable. Every response carries an `x-request-id` header.

## Error format

All errors use a single shape:

```json
{
  "code": "VALIDATION_ERROR",
  "message": "Validation failed.",
  "details": { "violations": ["email must be an email"] },
  "requestId": "b1c2..."
}
```

- `code` is a stable machine-readable code (see `src/common/errors/app-error.ts`).
- `details` is optional and carries structured context, including validation
  violations from the global `ValidationPipe`.
- `requestId` matches the `x-request-id` response header for log correlation.

## Authentication

Authentication sits behind an `IdentityProvider` abstraction
(`src/common/auth/identity-provider.ts`). Phase 0-2 ships a single
`LocalIdentityProvider` that verifies an email against the account's Argon2id
password hash. Domain and workforce modules never see passwords or SSO details;
they only ever receive a resolved principal. An `EnterpriseSsoIdentityProvider`
can be added later as another implementation of the same interface, swapped in
at the `IDENTITY_PROVIDER` binding in `AuthModule`, without touching any domain
module.

Tokens:

- A short-lived **JWT access token** (default 15 min, `JWT_ACCESS_TTL_SECONDS`)
  sent as `Authorization: Bearer <token>`. Claims are minimal (`sub`, `org`,
  `jti`, plus standard timing claims). Role names are deliberately not in the
  token; `/auth/me` and the scope guard resolve roles and permissions from the
  database so a revoked role takes effect immediately.
- An opaque **refresh token** (default 30 days, `JWT_REFRESH_TTL_SECONDS`).
  Only a SHA-256 **hash** of it is stored in `refresh_session`; the raw token
  never touches the database. Refreshing **rotates** the token: the old session
  is revoked and a new token pair is issued, so a refresh token is single-use.

Endpoints (all under `/v1`):

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/auth/login` | Exchange `{ email, password }` for a token pair. |
| `POST` | `/auth/refresh` | Rotate `{ refreshToken }` into a new token pair. |
| `POST` | `/auth/logout` | Revoke the refresh session for `{ refreshToken }`. |
| `GET` | `/auth/me` | Return the authenticated principal (requires Bearer). |

`GET /auth/me` returns the account, linked employee (if any), role codes,
de-duplicated permission codes, and the scope grants the account holds.

Wrong password or unknown account returns `401` with code `UNAUTHORIZED`; the
response never reveals whether the email exists.

CORS is enabled for `WEB_ORIGIN` (comma-separated list) with credentials, so a
browser web client can call the API cross-origin.

Example local login:

```bash
curl -s -X POST http://localhost:3000/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"lan.tt01@pnj.com.vn","password":"<your SEED_PASSWORD>"}'
```

## Prisma 7 notes

- The datasource connection string lives in `prisma.config.ts`
  (`datasource.url`), not in `schema.prisma`. Prisma 7 no longer allows `url`
  inside the schema file.
- The runtime client and the migrate CLI both connect through the
  `@prisma/adapter-pg` driver adapter built from `DATABASE_URL`.
- The generated client is written to `src/generated/prisma` and is gitignored;
  run `npm run prisma:generate` after cloning.
- Offline/sandbox note: if `prisma generate` cannot reach the engine CDN
  (`binaries.prisma.sh`), point it at a no-op binary and skip the checksum
  fetch:

  ```bash
  printf '#!/bin/sh\nexit 0\n' > .fake-schema-engine && chmod +x .fake-schema-engine
  PRISMA_SCHEMA_ENGINE_BINARY="$PWD/.fake-schema-engine" \
    PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1 npm run prisma:generate
  ```

  `.fake-schema-engine` is gitignored. In a normal network this is unnecessary.

## Scripts

| Script | Purpose |
|---|---|
| `npm run start:dev` | Start with watch mode |
| `npm run build` | Compile to `dist/` |
| `npm run start:prod` | Run the compiled server (`node dist/main.js`) |
| `npm run lint` | ESLint (zero warnings allowed) |
| `npm run format` | Prettier write |
| `npm test` | Jest unit tests |
| `npm run prisma:generate` | Generate the Prisma client |
| `npm run prisma:migrate` | Create/apply migrations (`migrate dev`) |
| `npm run prisma:validate` | Validate the Prisma schema |
| `npm run prisma:seed` | Seed Phase 0 mock data (requires `SEED_PASSWORD`) |

## Phase 0 seed data

`prisma/seed.ts` creates a fictional PNJP tenant for local development. No real
personal data is used; emails only mimic the `name.initials##@pnj.com.vn`
format and are written as literal seed values, never derived from names.

The seed creates:

- Organization `PNJP` and factory `PNJP-F1`.
- Departments `San xuat`, `Van hanh`, `Bao tri`; teams `Cat`, `Lap rap`, `QC`
  (under `San xuat`).
- Roles `OrganizationAdmin`, `FactoryAdmin`, `TeamRepresentative`, `Employee`
  with their permission grants.
- People, each a fictional employee:

  | Employee code | Team | Role (scope) | Account | Device |
  |---|---|---|---|---|
  | PNJP-0001 | Lap rap | OrganizationAdmin (organization) | yes | yes |
  | PNJP-0002 | Lap rap | FactoryAdmin (factory) | yes | yes |
  | PNJP-0003 | Cat | TeamRepresentative (team `Cat`) | yes | yes |
  | PNJP-0004 | Cat | Employee (self, team `Cat`) | yes | yes |
  | PNJP-0005 | Cat | production worker, no account | no | no |
  | PNJP-0006 | Cat | production worker, no account | no | no |
  | PNJP-0007 | Lap rap | production worker, no account | no | yes |
  | PNJP-0008 | QC | production worker, no account | no | no |

  Employees `PNJP-0006`, `PNJP-0007`, and `PNJP-0008` are extra account-less
  workers so that scope filtering is visible in a demo: all teams (`Cat`,
  `Lap rap`, `QC`) sit under the `San xuat` department, team `Cat` holds
  `PNJP-0003` through `PNJP-0006`, and `PNJP-0007` and `PNJP-0008` sit in
  `Lap rap` and `QC`. The OrganizationAdmin account sees every employee, while
  the TeamRepresentative scoped to `Cat` sees only the `Cat` members.

Every account shares the Argon2id hash of `SEED_PASSWORD`. The scoped grants use
the `user_role` table, which carries a database `CHECK` constraint
(`user_role_single_scope`) so a grant targets exactly one scope level.

## Employee import sample

`prisma/samples/employee-import-sample.xlsx` is a filled, ready-to-upload
workbook for the import screen. Its three fictional rows use the seeded tenant
codes, so every row validates and the apply creates the employees:

| employeeCode | fullName | email | factoryCode | departmentCode | teamCode | hasPersonalDevice |
|---|---|---|---|---|---|---|
| PNJP-1001 | Ngo Van Khoa | khoa.nv11@pnj.com.vn | PNJP-F1 | SAN-XUAT | CAT | true |
| PNJP-1002 | Ly Thi Thu | | PNJP-F1 | SAN-XUAT | LAP-RAP | false |
| PNJP-1003 | Tran Van Binh | binh.tv13@pnj.com.vn | PNJP-F1 | SAN-XUAT | QC | true |

The teams are all under `SAN-XUAT`, so every row uses `departmentCode=SAN-XUAT`;
a row that names a different department for one of these teams fails the
team-under-department check and the whole file is reported as invalid (and
cannot be applied), which is the behaviour to show for an error case.

Column order is the single source of truth in `TEMPLATE_COLUMNS`
(`src/modules/employee-imports/employee-imports.types.ts`); the template served
by `GET /v1/employee-imports/template` uses the same header. Regenerate the
sample after changing those codes:

```bash
npx tsx prisma/samples/build-sample-import.ts
```

## Project structure

```text
src/
  config/            Environment validation
  common/
    database/        PrismaService + global DatabaseModule
    errors/          AppError, standard error response, global exception filter
    request-context/ Request id middleware
  modules/
    health/          GET /v1/health
prisma/
  schema.prisma      Data model (domain tables added in later tasks)
  migrations/        SQL migrations
prisma.config.ts     Prisma 7 config (datasource url + pg driver adapter)
docker-compose.yml   Local PostgreSQL only
```

## Testing and invariant coverage

Unit tests run against in-memory Prisma doubles (`npm test`), so they do not
touch a real database. The doubles model row filtering and stage transactional
writes faithfully enough to prove the service-level logic (scope filtering,
audit atomicity, idempotent import apply). They cannot exercise database-only
guarantees, so a few invariants are covered by the test only to the extent the
TypeScript enforces them. Two gaps rely on a real Postgres and are not asserted
here:

- The `(organizationId, employeeCode)` unique index on `employee`. Import apply
  upserts on this key; the no-duplicate guarantee is a database property the
  double simulates.
- The `user_role_single_scope` CHECK on `user_role`. The "exactly one scope
  level" rule is enforced in `toGrantScope` under test, but the constraint
  itself is only exercised in a real database.
- The reserve pool over-allocation guarantee (P2-10). `ReserveService.allocate`
  does its check-and-insert inside one transaction that first takes a row lock
  on the `ReservePoolSetting` row (`SELECT ... FOR UPDATE`), so concurrent
  allocations for the same session dish serialize and the pool quantity can
  never be exceeded. The in-memory `$transaction`/`$queryRaw` double has no
  locking or isolation, so the unit tests only prove the sequential case (a
  second awaited allocation re-reads the committed total and is rejected). The
  concurrent, two-overlapping-transaction case that the invariant actually
  rests on is a real-Postgres property, exercised only against a live database.

Containment between tenant-tree levels (a team's `departmentId` and `factoryId`
lining up, and an employee's three foreign keys agreeing) is also enforced only
in the services for Phase 0 (see the schema comment on `Team`). These are
documented, intentional gaps for Phase 0; close them with an integration test
against a real Postgres (and, for containment, composite foreign keys) when the
database can be stood up in CI.
