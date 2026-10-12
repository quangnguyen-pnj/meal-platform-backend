# Phase 0 review — meal-platform-api + meal-platform-web

Phase 0 builds the tenant tree, local JWT auth behind an `IdentityProvider` seam, DB-resolved RBAC, a `ScopeAuthorizer` enforcing the Organization→Factory→Department→Team subtree, an `AuditService` that writes inside the mutation's transaction, organization/employee/role-grant CRUD, and an atomic idempotent Excel import. The build, lint, and 68 unit tests pass against in-memory Prisma doubles. Most invariants hold with real evidence, but the organization-tree **list** endpoints widen a department- or team-scoped grant to the whole factory, which leaks sibling units across scope — and the tests never exercise a department/team-scoped principal, so the suite is green while the invariant is broken.

Watch for: (1) **confirmed** scope leak in `listDepartments`/`listTeams`/`getScopeTree` — a department/team-scoped principal sees every unit in its factory; (2) **confirmed** `grantRole` does not confine the target account to the principal's organization, allowing a cross-tenant role grant; (3) **likely** refresh-token rotation is not transactional, so concurrent refreshes can both succeed; (4) **likely** import silently merges duplicate `employeeCode`s within one file instead of flagging them.

**Verdict**: NEEDS_CHANGES

## Resolution (Phase 0 fixes applied)

- **Blocker 1 (list scope leak)** — fixed. `listDepartments`, `listTeams`, and
  `getScopeTree` now derive their `where` from the principal's actual grants via
  `ScopeAuthorizer.listableScopeGrants`, mapping each grant to the narrowest
  column on each tenant-tree table. A department/team-scoped principal no longer
  sees sibling units. The `visibleFactoryIds` widening helper was removed.
- **Blocker 2 (cross-org role grant)** — fixed. `WorkforceService.loadAccount`
  now confines the target account to the principal's organization through its
  linked employee and rejects a cross-org (or employee-less) target as
  NOT_FOUND.
- **Blocker 3 (missing narrow-scope tests)** — fixed. The organizations spec now
  exercises department- and team-scoped principals and asserts no sibling leak
  through the lists or the scope tree; a cross-org grant-target test was added
  to the workforce spec.
- **Should-fix 4 (refresh double-spend)** — fixed. `AuthService.refresh` now
  revokes conditionally (`updateMany where revokedAt null`) inside one
  transaction and rejects a zero-count claim as UNAUTHORIZED; a second refresh
  with the same token is proven to fail.
- **Should-fix 5 (intra-file duplicate employeeCode)** — fixed. Whole-file
  validation flags every row that shares an employeeCode with another row,
  failing the job instead of silently merging.
- **Should-fix 6 (containment not DB-enforced)** — DEFERRED, documented. Kept
  service-enforced for Phase 0. Composite foreign keys would need composite
  unique keys and relations on the parent rows, a schema change this
  environment cannot author or verify offline (Prisma engine CDN blocked, so
  `prisma migrate dev` cannot run). Rather than half-apply a migration that
  cannot be validated, the invariant stays in the services (the only writers in
  Phase 0) with an explicit schema comment and a TODO on the `Team` model.
- **Should-fix 7 (no DB coverage for unique index / CHECK)** — DEFERRED,
  documented. A real Postgres is not available here, so instead of faking it the
  gap is documented in the README "Testing and invariant coverage" section:
  `(organizationId, employeeCode)` and `user_role_single_scope` are exercised
  only against a real database.
- **Nit 8 (grantRole can assign higher-privilege roles within scope)** — left
  as-is for Phase 0. This is scope-bounded (never a cross-tenant escalation): a
  principal with `role:assign` can mint roles only at or below its own scope.
  Whether a factory admin may create more factory admins is an intended Phase 0
  affordance; tightening it (for example, a role-rank ceiling) is a policy
  decision for a later phase.
- **Nit 9 (explicit-id narrowing)** — confirmed safe. The optional
  `?factoryId`/`?departmentId` filters are ANDed on top of the scope filter, so
  they can only shrink the result; a test proves an explicit `factoryId` cannot
  widen a department-scoped grant past its scope.

## High-level view

Scope enforcement runs on two different code paths, and only one is correct. Single-resource reads/writes and the employee list go through `ScopeAuthorizer` (`assertScope` for a target, `scopeFilter` for a list), which keeps a team-scoped grant pinned to its team. The organization-tree lists go through a separate helper, `visibleFactoryIds`, that collapses any factory/department/team grant down to a *set of factory ids* and filters by `factoryId IN (...)`. A department- or team-scoped principal therefore sees every department and team in the whole factory, through `listDepartments`, `listTeams`, and `getScopeTree`. This is the one invariant that does not hold.

Role granting is scope-bounded (you cannot grant at a scope outside your own) and the Employee role is correctly pinned to the holder's own team, but the account being granted is loaded without an organization filter, so a role scoped to the principal's org can be attached to an account from another org — a trust-boundary gap on a mutation.

Auth is otherwise solid: Argon2id everywhere, no plaintext in source or responses, uniform "Invalid email or password" with no user enumeration, permissions and scope resolved fresh from the DB on every request and never trusted from the JWT. The one soft spot is that refresh rotation reads-then-updates the session in two statements outside a transaction, so two concurrent refreshes presenting the same token can both pass the liveness check.

Audit atomicity holds structurally: every mutation runs through `recordWithTransaction`/`record`, which inserts the audit row on the same `$transaction` client as the change. Containment holds in code for teams and employee placement, and the import re-validates placement and scope per row and upserts on `(organizationId, employeeCode)` so a bad file writes nothing and re-applying creates no duplicates — the one hole being duplicate codes *within a single file*, which the loop silently collapses.

The invariants are verified mostly against in-memory Prisma doubles. Those doubles model row filtering and transaction staging faithfully enough for the logic under test, but they cannot exercise the `user_role_single_scope` CHECK, the `(organizationId, employeeCode)` unique index, or real transactional isolation — so a few invariants are proven by the test only to the extent the production code already enforces them in TypeScript.

<details>
<summary>Issues (9)</summary>

1. **Org-tree list scope leak (blocker)** — `listDepartments`, `listTeams`, and `getScopeTree` filter by `visibleFactoryIds`, which widens a department/team grant to its whole factory. Filter these lists through `ScopeAuthorizer.scopeFilter` (as the employee list does) so a narrow grant stays narrow.
2. **Cross-org role grant (blocker)** — `grantRole`'s `loadAccount` has no organization filter, so a role scoped to the principal's org can be granted to an account in another org. Load/validate the account within `principal.organizationId`.
3. **No test for narrow-scope org-tree lists (blocker)** — the organizations spec only tests factory- and org-scoped principals, so the leak in #1 passes CI. Add a department/team-scoped list test.
4. **Non-transactional refresh rotation (should-fix)** — `refresh` reads the session then updates `revokedAt` in a separate statement; concurrent refreshes with one token can both succeed. Revoke conditionally (`updateMany where revokedAt null`) and treat a zero-count update as already-used, inside one transaction.
5. **Duplicate employeeCode within a file (should-fix)** — the apply loop upserts row by row, so two rows with the same code silently merge into one employee with the last row's values. Detect duplicate codes during whole-file validation and fail the row.
6. **Containment not DB-enforced (should-fix)** — nothing at the DB level ties `team.departmentId` to `team.factoryId`, or an employee's three FKs to one another; containment is TypeScript-only. A direct write or future code path can produce an inconsistent tree. Consider composite FKs.
7. **No DB coverage for scope CHECK / unique indexes (should-fix)** — invariants 4 and 6 lean on `(organizationId, employeeCode)` and `user_role_single_scope`, which the in-memory doubles cannot exercise. Add at least one integration test against a real Postgres, or document the gap.
8. **`grantRole` can assign higher-privilege roles within scope (nit)** — a principal with `role:assign` can grant any role (e.g. one carrying `role:assign`) at its own scope. Bounded by scope so not an escalation across tenants, but worth an explicit decision.
9. **Factory-scoped `departmentId` list filter is unbounded by visibility (nit)** — in `listDepartments`/`listTeams`, a caller-supplied `departmentId`/`teamId` filter is ANDed on top of `factoryId IN visible`, which is safe today only because the factory filter already bounds it; once #1 is fixed, confirm the explicit-id narrowing still cannot escape scope.

</details>

<details>
<summary>Details</summary>

### Invariant 1 — Tenant isolation / scope (PARTIALLY HOLDS — blocker)

Two enforcement paths exist and they disagree.

The correct path is `ScopeAuthorizer` (`scope-authorizer.service.ts`). `assertScope` walks the principal's grants against a fully-pathed `ResourceScope` and denies anything outside the subtree; `scopeFilter` builds a Prisma `where` that pins each grant to its narrowest level (`{ teamId }`, `{ departmentId }`, `{ factoryId }`, or org-only) and ORs multiple grants. `WorkforceService.listEmployees` uses `scopeFilter`, so a team-scoped principal's employee list is correctly bounded — covered by the "lists only employees in the principal scope" test (`workforce.service.spec.ts:393`).

The broken path is `OrganizationsService.visibleFactoryIds` (`organizations.service.ts`). For any non-org grant it collects `grant.factoryId` for every grant and returns that set; department- and team-level grants contribute *their containing factory*. `listDepartments`, `listTeams`, and `getScopeTree` then filter by `factoryId IN (...)`:

```ts
if (grantsInOrg.some((grant) => !grant.factoryId)) {
  return 'all';
}
const factoryIds = new Set<string>();
for (const grant of grantsInOrg) {
  if (grant.factoryId) factoryIds.add(grant.factoryId);
}
return [...factoryIds];
```

So a principal granted only `Team QC` sees **every department and every team in that team's factory** through these three endpoints. That is a cross-scope read inside the same factory, which invariant 1 forbids ("must NOT read units outside its granted subtree, through ANY endpoint"). Single-resource `getDepartment`/`getTeam` are safe because they call `assertScope`; only the lists leak.

The fix is to route these lists through `scopeFilter` the way the employee list does, instead of the bespoke factory-id widening. The gap is masked because `organizations.service.spec.ts` only builds factory-scoped and org-scoped principals — at the factory level the two paths happen to agree, so the suite is green.

### Invariant 2 — Containment (HOLDS in code; not DB-enforced — should-fix)

`createTeam` rejects a team whose `factoryId` differs from its department's `factoryId` before writing (`organizations.service.ts`, the `department.factoryId !== dto.factoryId` guard), tested at `organizations.service.spec.ts:` "rejects a team whose factory differs from its department factory". `WorkforceService.resolvePlacement` verifies `team.departmentId === departmentId` and `team.factoryId === factoryId` for both create and move. The import's `resolvePlacementByCode` performs the same two checks on resolved units.

The limitation is that this lives entirely in TypeScript. The schema has independent FKs on `department.factoryId`, `team.factoryId`/`team.departmentId`, and the employee's three FKs, but no composite FK ties them together, so the database alone would accept a team under a department of another factory. For Phase 0 the services are the only writers, so the invariant holds in practice, but a future writer or a raw statement could violate it. Composite foreign keys would move this guarantee into the database.

### Invariant 3 — Audit atomicity (HOLDS)

Every mutation in organizations, workforce, and imports runs through `AuditService.recordWithTransaction` (or `record` on a caller-supplied `tx` for the multi-step import apply), which inserts the audit row on the same `$transaction` client as the change, so no mutation can commit without its audit row and a thrown mutation leaves no orphan. The one caveat is fidelity: this is proven against an in-memory double, not a real transaction — see the test-double section.

### Invariant 4 — Import safety (HOLDS, with one gap — should-fix)

`uploadAndValidate` validates the whole file first and persists the job as `VALIDATED` only when `errorCount === 0`. `apply` refuses any job that is not `VALIDATED`, then **re-validates** the stored rows against the current tenant tree and scope before touching the employee table, so a tree change between upload and apply cannot slip an invalid placement through. The upsert keys on `(organizationId, employeeCode)` — backed by the real unique index `employee_organizationId_employeeCode_key` — inside a single `$transaction`, so a valid re-apply updates in place and never duplicates. These are the two behaviors invariant 4 demands.

The gap is duplicate `employeeCode`s *within one file*. Validation never checks for repeated codes, so two rows sharing a code both pass; the apply loop then upserts them in sequence and the second overwrites the first. No duplicate row is created (the unique index guarantees that), but one of the two input rows is silently discarded with no error surfaced to the user. Whole-file validation should flag a repeated code as an invalid row.

### Invariant 5 — Auth (HOLDS, with a concurrency soft spot — should-fix)

Passwords are Argon2id only: `WorkforceService.hashPassword` uses `argon2id`, `LocalIdentityProvider.authenticate` verifies against the stored hash, the seed hashes `SEED_PASSWORD` from the environment and hard-codes nothing, and no view model carries `passwordHash` (`toUserAccountView` returns `id`/`email`/`isActive`). Login returns a uniform `UNAUTHORIZED` "Invalid email or password" for unknown email, inactive account, missing hash, and wrong password, so the API does not reveal whether an email exists. Permissions, roles, and scope grants are resolved from the DB on every request via `PrincipalAuthorizationService.resolve`; the access token carries only `sub`/`org`/`jti` and the guard comment is explicit that roles are not trusted from the token.

Refresh rotation revokes the presented session and issues a new pair, so the old refresh token is useless afterwards. The soft spot: `refresh` does a `findUnique` then a separate `update` to set `revokedAt`, outside a transaction and without a `revokedAt IS NULL` guard on the update. Two concurrent requests presenting the same still-live token can both pass the liveness check before either revokes, and both receive fresh token pairs — a refresh-token double-spend. Revoking conditionally (`updateMany where revokedAt null` and treating a zero-count result as already-used) inside one transaction closes it.

### Invariant 6 — Role grants (HOLDS, with a cross-org gap — blocker)

The Employee role is correctly self-scoped: `assertEmployeeSelfScope` requires the target account to be linked to an employee and the grant to match exactly that employee's factory/department/team, rejecting anything broader (tested at "rejects an Employee-role grant broader than self scope"). A principal cannot grant outside its own authority because `grantRole` calls `assertScope` on the target scope against the principal's grants (tested at "forbids granting a role outside the principal own scope").

The gap is tenant isolation on the *account*. `loadAccount(dto.userAccountId)` is a bare `findUnique` with no organization filter, while the role and the resulting grant are pinned to `principal.organizationId`. A principal can therefore attach a role scoped to its own org to an account that belongs to a different organization — a cross-tenant write that no test covers. The account should be resolved and validated within the principal's organization (e.g. via its linked employee or an explicit org check) before the grant is created.

A secondary, lower-severity point: with `role:assign`, a principal can grant any role at its own scope, including roles that themselves carry `role:assign` or broader management permissions. Because the grant is scope-bounded this is not a cross-tenant escalation, but whether a factory admin may mint more factory admins is a policy decision worth making explicit rather than leaving implicit.

### Invariant 7 — Conventions (HOLDS)

The `api/ → mappers/ → hooks/ → components/ → app/` layering holds (e.g. `organization/page.tsx` delegates to `useScopeTree`/`useOrganizationForm`/`useOrganizationMutations` with no `fetch` or DTO transforms in JSX), and backend controllers only declare `@RequirePermission` and delegate. The one load-bearing observation: the client does **not** re-filter server data by scope — it renders whatever the endpoint returns — which is the correct division, and is why the invariant-1 leak bites directly: the UI faithfully displays the over-broad list.

### Out-of-scope check

No supplier, menu, session, registration, reserve, event-sourcing, or CQRS code crept in. The schema carries only Phase 0 tables plus the `HealthCheck` probe and the two import enums; `ExternalIdentity` exists but is unused, which the schema comment justifies as the documented Enterprise-SSO seam (an allowed Phase 0 affordance, not scope creep).

### Test-double fidelity

The in-memory Prisma doubles model `findFirst`/`findUnique`/`findMany` row filtering and stage transactional writes until the callback resolves, which is enough to prove the audit-rollback and scope-filter *logic*. What they cannot exercise: the `user_role_single_scope` CHECK (invariant 6's single-level rule is only enforced in `toGrantScope` under test), the `(organizationId, employeeCode)` unique index (invariant 4's no-duplicate guarantee is a real-DB property the double simulates), and real transactional isolation (so the refresh race in invariant 5 and any concurrent-write ordering are invisible to the suite). At least one integration test against a real Postgres would convert these from "enforced by code the test happens to run" to "enforced by the database."

</details>

<details>
<summary>File map</summary>

- `common/authorization/scope-authorizer.service.ts` — correct scope path (`assertScope`, `scopeFilter`); the model all lists should use.
- `common/authorization/principal-authorization.service.ts` — resolves roles/permissions/scope grants from the DB (invariant 5).
- `common/authorization/permission.guard.ts`, `common/auth/jwt-auth.guard.ts` — coarse permission gate + token-only principal; roles not trusted from JWT.
- `modules/organizations/organizations.service.ts` — **scope leak** in `visibleFactoryIds` feeding `listDepartments`/`listTeams`/`getScopeTree`; containment guard in `createTeam`.
- `modules/workforce/workforce.service.ts` — employee CRUD + placement containment; `grantRole` self-scope correct but **account loaded without org filter**; Argon2id hashing.
- `modules/auth/auth.service.ts` — login/refresh/logout/me; **non-transactional refresh rotation**.
- `modules/auth/local-identity-provider.ts` — uniform null on every failure (no user enumeration).
- `modules/employee-imports/employee-import.service.ts` — whole-file validate, re-validate on apply, atomic upsert; **no intra-file duplicate-code check**.
- `common/audit/audit.service.ts` — audit insert on the mutation's transaction client (invariant 3).
- `prisma/schema.prisma`, `prisma/migrations/20250101000001_phase0_schema/migration.sql` — `(organizationId, employeeCode)` unique + `user_role_single_scope` CHECK; no composite containment FKs.
- `meal-platform-web/lib/http-client.ts` — single-flight 401 refresh+retry; no client-side scope filtering.
- `meal-platform-web/app/(protected)/organization/page.tsx` — representative presentational page delegating to hooks/mappers.

Reviewed the working tree directly (neither repo is a git repository). Backend `npm test` → 68 passing.

</details>
