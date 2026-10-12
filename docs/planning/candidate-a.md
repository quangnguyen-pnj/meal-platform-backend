# Candidate A: thiet ke platform quan ly suat an nha may

## Muc tieu va pham vi

Xay dung hai repository doc lap cho platform da tenant quan ly dang ky suat an. Moi request du lieu nghiep vu phai duoc gioi han theo cay `Organization -> Factory -> Department -> Team`. Thoi gian nghiep vu dung `Asia/Ho_Chi_Minh`; API gui va luu timestamp UTC, nhung backend tinh ngay, tuan, gio mo va gio chot theo timezone nay.

Phat hanh theo ba phase.

- Phase 0: cau truc to chuc, nhan vien, import Excel, dang nhap JWT, RBAC theo pham vi, audit.
- Phase 1: thuc don tuan, mon co cau hinh, phien an, mo dang ky, chot dang ky, phat hanh va trang thai.
- Phase 2: nhan vien tu dang ky; dai dien va admin dang ky hang loat; lo batch phieu giay; vang mat, huy, dieu chinh sau gio chot co ly do va audit; tuy chon pool du co dinh theo mon va phan bo sau gio chot cho admin.

Khong dua Supplier SSO vao Phase 0-2. Khong dung event sourcing, CQRS, message broker, hay gia dinh ha tang production.

## Hai phuong an da can nhac

### Phuong an 1: hai repository, REST backend theo module domain

Frontend Next.js goi NestJS REST qua client nhe. Backend dat quy tac va giao dich trong cac service theo domain. Prisma la lop truy cap PostgreSQL. Day la phuong an duoc chon.

Ly do: hai repository khop yeu cau, REST de debug, cach va phan quyen bang cach them `scope` vao request context, va mot giao dich PostgreSQL du cho cac thao tac can giu tinh nhat quan. Quy tac dang ky, cutoff va audit nam cung mot noi, nen frontend khong the vo tinh bo qua.

### Phuong an 2: BFF trong Next.js hoac GraphQL

BFF co the giam so request tren cac trang tong hop. GraphQL co the linh hoat cho man hinh menu va dashboard.

Khong chon: BFF tao them mot noi de thuc thi auth va authorization, trong khi backend phai la noi kiem tra cuoi cung. GraphQL tang them schema, resolver, cache, va cach kiem soat do phuc tap ma Phase 0-2 chua can. REST grouping theo module giu duong di don gian hon.

### Phuong an 3: luu dang ky duoi dang su kien va dung projection

Su kien co the phuc vu lich su dang ky rat chi tiet.

Khong chon: audit append-only cung cấp lich su can thiet. Event sourcing tao them aggregate, projection, replay, va xu ly idempotency ma chua co yeu cau ve dong bo hay tich hop phuc tap.

## Cau truc repository

### `meal-platform-api`

```text
meal-platform-api/
  prisma/
    schema.prisma
    migrations/
    seed.ts
  src/
    main.ts
    app.module.ts
    common/
      auth/                 # decorator, guard, request principal
      authorization/        # scope evaluator va policy helpers
      audit/                # AuditService va interceptor
      database/             # PrismaService va transaction helper
      date-time/            # quy tac Asia/Ho_Chi_Minh
      errors/
      validation/
    modules/
      identity/
      organization/
      people/
      imports/
      menu/
      meal-sessions/
      registrations/
      reserve-pools/
      reporting/
    test/
  docker-compose.yml
  .env.example
  package.json
```

Moi module co `*.module.ts`, controller, service, DTO, policy, va test. Controller chi parse DTO, lay principal, goi service, va tra JSON. Service chua quy tac nghiep vu. Prisma query nam trong service cua module hoac repository cuc bo cua module neu query dai va duoc tai su dung. Khong tao lop repository chung chi de boc Prisma.

`docker-compose.yml` chi chay PostgreSQL local. API va frontend chay bang lenh local de giu Compose nhe.

```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_DB: meal_platform
      POSTGRES_USER: meal_platform
      POSTGRES_PASSWORD: meal_platform
    ports: ["5432:5432"]
    volumes: [postgres_data:/var/lib/postgresql/data]
volumes:
  postgres_data:
```

### `meal-platform-web`

```text
meal-platform-web/
  app/
    login/page.tsx
    select-scope/page.tsx
    (workspace)/
      layout.tsx
      page.tsx
      organization/
      people/
      imports/
      menus/
      meal-sessions/
      registrations/
      adjustments/
      reserve-pools/
      audit/
  components/
    ui/                     # shadcn/ui
    layout/
    organization/
    people/
    menus/
    registrations/
  features/
    auth/
    organization/
    people/
    imports/
    menus/
    meal-sessions/
    registrations/
    reserve-pools/
  hooks/
  api/
  mappers/
  lib/
    query-client.ts
    date-time.ts
    http.ts
  types/
```

`app/` va `components/` chi render, layout, va gan event. `features/` chua hook TanStack Query, form state va handler. `api/` chi boc request REST. `mappers/` doi API model sang view model. Khong doi response API trong JSX.

## Module backend va bien gioi trach nhiem

| Module | So huu | Khong so huu |
|---|---|---|
| `identity` | credential local, token, session, account, adapter IdP | role va pham vi nghiep vu |
| `organization` | organization, factory, department, team, scope hierarchy | ho so nhan vien |
| `people` | employee, membership, role assignment | xac thuc dang nhap |
| `imports` | file import, dong import, validation, ap dung employee | Excel parser tong quat cho cac domain khac |
| `menu` | dish, weekly menu, menu item, publish state | slot gio cua phien an |
| `meal-sessions` | phien an, mo/chot dang ky, state transition | y dinh dang ky cua nhan vien |
| `registrations` | dang ky, huy, vang mat, batch giay, adjustment | dinh nghia mon va menu |
| `reserve-pools` | cau hinh pool theo mon, cap phat sau cutoff | dang ky thong thuong |
| `reporting` | read model truy van tong hop | cap nhat dang ky |
| `audit` | ban ghi audit bat bien | quy tac domain cua module goi |

`reporting` ban dau dung SQL/Prisma query doc tu cac bang chinh. Chi tao bang tong hop khi do hieu nang do duoc do can thiet.

## Schema chinh theo Prisma entities

Tat ca bang tenant-scoped co `organizationId`. Bang nam duoi factory, department, hay team van luu `organizationId` de loc va index ro rang. Backend xac minh cac ID cha nam trong cung mot organization truoc khi ghi.

### To chuc va nhan su

```text
Organization(id, code, name, timezone, active, createdAt, updatedAt)
Factory(id, organizationId, code, name, active)
Department(id, organizationId, factoryId, code, name, active)
Team(id, organizationId, factoryId, departmentId, code, name, active)

Employee(id, organizationId, employeeCode, fullName, email?, phone?, active,
         factoryId, departmentId, teamId, createdAt, updatedAt)
EmployeeAssignment(id, organizationId, employeeId, factoryId, departmentId,
                   teamId, effectiveFrom, effectiveTo?)
```

`Employee` giu assignment hien hanh de query nhanh. `EmployeeAssignment` giu lich su chuyen don vi. Service bao dam assignment moi dung cay factory, department, team hop le va cap nhat cac foreign key hien hanh trong cung mot transaction.

### Dang nhap, quyen, va audit

```text
UserAccount(id, organizationId?, username, passwordHash?, employeeId?, active,
            authenticationProvider, createdAt, updatedAt)
ExternalIdentity(id, userAccountId, provider, providerSubject, email?)
Role(id, code, name, systemRole)
Permission(id, code)
RolePermission(roleId, permissionId)
UserRole(id, userAccountId, roleId, organizationId, factoryId?, departmentId?, teamId?)
RefreshSession(id, userAccountId, tokenHash, expiresAt, revokedAt?)
AuditLog(id, organizationId?, actorUserAccountId?, action, entityType, entityId,
         scopeJson, beforeJson?, afterJson?, reason?, requestId, createdAt)
```

`Role` va `Permission` la du lieu system seed. `UserRole` la grant co pham vi. Chi cho phep mot pham vi lien tuc: organization, factory, department, hoac team. Khong cho phep grant `departmentId` ma khong co `factoryId`, hoac team khac department.

### Import Excel

```text
ImportJob(id, organizationId, type, status, sourceFileName, createdByUserAccountId,
          summaryJson?, startedAt?, completedAt?, createdAt)
ImportRow(id, importJobId, rowNumber, rawJson, status, errorsJson?)
```

`ImportJob.type` bat dau voi `EMPLOYEES`. Import validate toan bo file truoc. Nguoi dung co the tai file loi neu co dong khong hop le. Chi khi nguoi dung xac nhan ap dung, service moi upsert nhan vien theo unique `(organizationId, employeeCode)` trong giao dich.

### Menu va phien an

```text
Dish(id, organizationId, code, name, description?, active, defaultPrice?, metadataJson?)
DishOption(id, dishId, code, label, optionType, required, active, sortOrder)
WeeklyMenu(id, organizationId, factoryId, weekStartDate, status, publishedAt?, publishedByUserAccountId?)
MenuItem(id, weeklyMenuId, mealDate, mealType, dishId, sortOrder, availableQuantity?)
MenuItemOption(id, menuItemId, dishOptionId, allowedValueJson?)

MealSession(id, organizationId, factoryId, mealDate, mealType, opensAt, cutoffAt,
            status, weeklyMenuId, createdByUserAccountId, publishedAt?)
MealSessionMenuItem(id, mealSessionId, menuItemId)
```

`weekStartDate` la thu Hai theo `Asia/Ho_Chi_Minh`. `WeeklyMenu.status` dung `DRAFT | PUBLISHED | ARCHIVED`. `MealSession.status` dung `DRAFT | OPEN | CLOSED | CANCELLED`. Service khong suy ra state chi tu thoi gian, vi admin can mo, dong, va huy co chu y. Mot job don gian moi phut dong cac phien `OPEN` co `cutoffAt <= now`; endpoint thao tac cung tu kiem tra cutoff de khong phu thuoc vao job.

### Dang ky, batch giay, va pool du

```text
Registration(id, organizationId, mealSessionId, employeeId, status, source,
             selectedItemsJson, requestedAt, cancelledAt?, absentAt?,
             createdByUserAccountId, updatedByUserAccountId, version)
RegistrationAdjustment(id, organizationId, registrationId, adjustmentType,
                       beforeJson, afterJson, reason, performedByUserAccountId,
                       performedAt)
PaperRegistrationBatch(id, organizationId, factoryId, mealSessionId, status,
                       sourceReference?, createdByUserAccountId, submittedAt?)
PaperRegistrationEntry(id, paperRegistrationBatchId, employeeId, selectionJson,
                       rowNumber, status, errorsJson?)

ReservePoolRule(id, organizationId, factoryId, dishId, active, fixedQuantity,
                effectiveFrom, effectiveTo?)
ReserveAllocation(id, organizationId, mealSessionId, dishId, employeeId,
                  quantity, reason, allocatedByUserAccountId, allocatedAt)
```

`Registration.status` dung `ACTIVE | CANCELLED | ABSENT`. Unique `(mealSessionId, employeeId)` bao dam mot nhan vien co toi da mot dang ky tren mot phien. `selectedItemsJson` la snapshot mon va tuy chon luc dang ky. No tranh viec sua mon lam doi lich su; `RegistrationAdjustment.beforeJson` va `afterJson` ghi ro thay doi.

Pool du la tuy chon. Khi tat, UI va API allocation bi an. Khi bat, `ReservePoolRule` cap so luong co dinh theo `factory + dish`; service snapshot so luong ap dung cho phien khi phien mo. Sau cutoff, chi role admin co permission `reserve-pool.allocate` duoc tao `ReserveAllocation`. Unique `(mealSessionId, dishId, employeeId)` tranh cap phat trung. Service khoa theo `(mealSessionId, dishId)` trong giao dich va tu choi neu tong allocation vuot pool.

### Rang buoc va index

- Unique: `Organization.code`; `(organizationId, code)` cho factory, department, team, dish; `(organizationId, employeeCode)`; `(factoryId, weekStartDate)` cho weekly menu; `(factoryId, mealDate, mealType)` cho meal session.
- Index: `(organizationId, factoryId)`, `(organizationId, factoryId, departmentId, teamId)` tren employee, assignment, va registration; `(mealSessionId, status)` tren registration; `(organizationId, createdAt)` tren audit log.
- Prisma khong tao duoc het rang buoc cay pham vi qua composite foreign key mot cach don gian. Service kiem tra cay, migration them composite unique va foreign key khi no lam rang buoc ro rang, va integration test bao ve cac truong hop cross-tenant.

## Auth va authorization

### Abstraction de thay local auth bang Enterprise SSO

`identity` dung interface noi bo thay vi de module khac biet ve password hay SSO.

```ts
export type AuthenticatedIdentity = {
  provider: 'local' | 'enterprise-sso';
  providerSubject: string;
  username: string;
  email?: string;
};

export interface IdentityProvider {
  authenticate(input: LoginInput): Promise<AuthenticatedIdentity | null>;
}

export interface TokenIssuer {
  issue(user: AuthenticatedUser): Promise<AccessTokenPair>;
  verify(accessToken: string): Promise<AuthenticatedUser>;
}
```

Phase 0 dang ky `LocalIdentityProvider`, dung Argon2id de hash password. `JwtTokenIssuer` phat access token ngan han va refresh token xoay vong. `UserAccount.authenticationProvider` va `ExternalIdentity` cho phep them `EnterpriseSsoIdentityProvider` sau nay ma khong sua controller cua domain module. Supplier SSO la module va provider khac, khong duoc dua vao abstraction nay trong Phase 0-2.

JWT co `sub`, `organizationId`, `roleGrantIds`, `tokenVersion`, `iat`, va `exp`. Guard tai user va active role grants tu database hoac cache sau nay. Khong tin role name trong JWT de thu hoi quyen co hieu luc ngay. Refresh token chi luu hash.

### Authorization theo pham vi

1. `JwtAuthGuard` xac thuc token va tao `RequestPrincipal`.
2. `PermissionGuard` kiem tra permission yeu cau tu decorator, vi du `@RequirePermission('employees.write')`.
3. Service goi `ScopeAuthorizer.assertCanAccess(principal, targetScope)` truoc khi doc hoac ghi.
4. Tat ca query list them scope filter cua principal. Khong chi loc sau khi lay du lieu.
5. `AuditInterceptor` lay actor, request ID, route, va ket qua mutation. Service truyen ly do khi dong nghiep vu bat buoc ly do.

Quyen seed toi thieu: `organization.manage`, `employees.read`, `employees.write`, `imports.run`, `menus.manage`, `sessions.manage`, `registrations.self`, `registrations.manage`, `registrations.adjust-after-cutoff`, `reserve-pool.manage`, `reserve-pool.allocate`, `audit.read`.

Vai tro default: `platform_admin` o organization, `factory_admin` o factory, `department_representative` o department, `team_representative` o team, va `employee` tren chinh employee. Permission `registrations.self` con kiem tra `principal.employeeId === registration.employeeId`; scope role khong du de mo dang ky cua nguoi khac.

## REST API grouping

Tat ca endpoint dung prefix `/api/v1`, JSON, validation DTO, ma loi on dinh `{ code, message, details?, requestId }`. Pagination dung `page`, `pageSize`, `sort`, va filter ro rang. Dat thoi gian ISO 8601 co offset; dat ngay dung `YYYY-MM-DD` theo timezone to chuc.

```text
POST   /auth/login
POST   /auth/refresh
POST   /auth/logout
GET    /auth/me

GET    /organizations/current
GET    /factories
POST   /factories
PATCH  /factories/:factoryId
GET    /factories/:factoryId/departments
GET    /departments/:departmentId/teams

GET    /employees
POST   /employees
GET    /employees/:employeeId
PATCH  /employees/:employeeId
POST   /employees/:employeeId/assignments

POST   /imports/employees/validate
POST   /imports/:importJobId/apply
GET    /imports/:importJobId
GET    /imports/:importJobId/errors

GET    /dishes
POST   /dishes
PATCH  /dishes/:dishId
POST   /dishes/:dishId/options

GET    /weekly-menus?factoryId=&weekStartDate=
POST   /weekly-menus
PATCH  /weekly-menus/:weeklyMenuId
POST   /weekly-menus/:weeklyMenuId/publish
POST   /weekly-menus/:weeklyMenuId/archive

GET    /meal-sessions?factoryId=&from=&to=
POST   /meal-sessions
PATCH  /meal-sessions/:mealSessionId
POST   /meal-sessions/:mealSessionId/open
POST   /meal-sessions/:mealSessionId/close
POST   /meal-sessions/:mealSessionId/cancel

GET    /meal-sessions/:mealSessionId/registrations
POST   /meal-sessions/:mealSessionId/registrations/self
POST   /meal-sessions/:mealSessionId/registrations/bulk
POST   /meal-sessions/:mealSessionId/paper-batches
POST   /registrations/:registrationId/cancel
POST   /registrations/:registrationId/mark-absent
POST   /registrations/:registrationId/adjust

GET    /meal-sessions/:mealSessionId/reserve-pool
PUT    /reserve-pool-rules/:reservePoolRuleId
POST   /meal-sessions/:mealSessionId/reserve-allocations

GET    /audit-logs
GET    /reports/meal-sessions/:mealSessionId/summary
```

`self`, `bulk`, va `paper-batches` la ba command ro rieng, nhung deu dung cung `RegistrationService.createOrReplaceBeforeCutoff`. Command sau cutoff chi di qua `adjust` va yeu cau `reason` khong rong. API tra `409` khi cutoff, state, version, unique, hay dung luong pool xung dot.

## Frontend routes va module boundaries

`(workspace)/layout.tsx` dat auth gate, scope selector, navigation, va `QueryClientProvider`. Route page chi ket noi feature hook voi presentational component.

| Route | Feature hook chinh | Component chinh | Phase |
|---|---|---|---|
| `/login` | `useLoginForm` | `LoginForm` | 0 |
| `/select-scope` | `useAvailableScopes` | `ScopeSelector` | 0 |
| `/organization` | `useOrganizationTree` | `OrganizationTree` | 0 |
| `/people/employees` | `useEmployees`, `useEmployeeForm` | `EmployeeTable`, `EmployeeForm` | 0 |
| `/imports/employees` | `useEmployeeImport` | `EmployeeImportWizard` | 0 |
| `/audit` | `useAuditLogs` | `AuditLogTable` | 0 |
| `/menus` | `useWeeklyMenu`, `useWeeklyMenuEditor` | `WeeklyMenuEditor` | 1 |
| `/meal-sessions` | `useMealSessions`, `useSessionActions` | `MealSessionTable` | 1 |
| `/registrations/me` | `useMyMealRegistrations` | `MyRegistrationList` | 2 |
| `/registrations/manage` | `useRegistrationRoster`, `useBulkRegistration` | `RegistrationRoster`, `BulkRegistrationForm` | 2 |
| `/adjustments` | `useRegistrationAdjustment` | `RegistrationAdjustmentDialog` | 2 |
| `/reserve-pools` | `useReservePoolRules`, `useReserveAllocation` | `ReservePoolRuleForm`, `ReserveAllocationDialog` | 2 |

TanStack Query query key bat dau bang pham vi, vi du `['employees', organizationId, scope, filters]`. Mutation invalidate dung key cu the. Form dung React Hook Form va Zod trong feature hook, co the su dung shadcn/ui cho field va dialog. Lucide chi dung cho icon co label hoac tooltip; icon khong thay the text cua thao tac co anh huong nghiep vu.

## Thu tu task va tieu chi hoan thanh

### Phase 0

1. **Tao hai repository va baseline toolchain.** Tao Next.js 16 App Router TypeScript Tailwind, shadcn/ui, Lucide, TanStack Query v5; tao NestJS TypeScript, ESLint, Prisma 7, Docker Compose PostgreSQL, `.env.example`.
   - Hoan thanh khi `docker compose up -d`, migration, seed, API, va web chay local theo README; frontend goi duoc health endpoint.

2. **Tao Prisma schema, migration, va seed to chuc.** Them Organization, Factory, Department, Team, Employee, UserAccount, role, permission, grant, va AuditLog.
   - Hoan thanh khi seed tao mot organization PNJP, mot factory, department, team, nhan vien, admin, va employee test; unique va foreign key quan trong duoc test.

3. **Them local auth sau abstraction.** Tao `IdentityProvider`, local password, JWT access/refresh, logout, `/auth/me`, va seed credential chi ghi trong README local.
   - Hoan thanh khi login thanh cong, refresh xoay token, logout thu hoi session, password sai tra `401`, va domain module khong import password service.

4. **Them RBAC scope va audit.** Tao decorator permission, guard, scope authorizer, query scope filter, va audit interceptor/service.
   - Hoan thanh khi user team khong doc hoac sua du lieu team khac, admin factory khong vuot organization, va mutation co actor/action/entity/scope trong audit.

5. **Quan ly cay to chuc va nhan vien.** Them CRUD factory, department, team, employee, assignment, API, frontend pages, va scope selector.
   - Hoan thanh khi UI chi hien thi du lieu trong scope duoc cap, employee code trung cung organization bi tu choi, va dieu chuyen team giu assignment history.

6. **Import Excel nhan vien.** Them upload validation, preview loi, apply idempotent, audit, UI wizard, va mau Excel.
   - Hoan thanh khi file hop le preview va upsert dung employee; file co loi khong ghi mot phan; cung file apply lai khong tao duplicate.

7. **Them mock data PNJP.** Seed them danh sach mon va nhan vien mau, giu du lieu khong dinh danh that.
   - Hoan thanh khi mot lenh seed tao du du lieu de demo Phase 0 va khong can ket noi dich vu ngoai.

### Phase 1

8. **Quan ly mon va cau hinh mon.** Them Dish, DishOption, CRUD, validation, va frontend.
   - Hoan thanh khi admin tat mon khong the them vao menu moi, nhung lich su menu va registration van hien thi snapshot dung.

9. **Tao va phat hanh weekly menu.** Them weekly menu, menu item, workflow draft/published/archived, timezone date handling, API, va editor.
   - Hoan thanh khi mot factory co mot menu moi tuan, publish chi duoc khi menu hop le, va user ngoai scope khong truy cap.

10. **Tao va dieu hanh meal session.** Them phien an, lien ket menu, open/close/cancel, cutoff validation, job dong phien, API, UI, va audit.
   - Hoan thanh khi phien chi mo tu menu published, tu dong dong khi den cutoff, endpoint tu choi registration sau cutoff ke ca job chua chay, va moi transition duoc audit.

11. **Bao cao session toi thieu.** Them endpoint va trang tong hop so luong theo mon va team.
   - Hoan thanh khi tong so khop dang ky ACTIVE va co filter scope. Bao cao khong sua du lieu.

### Phase 2

12. **Dang ky tu phuc vu.** Them my registrations, tao/sua truoc cutoff, huy truoc cutoff, optimistic concurrency qua `version`, API, UI.
   - Hoan thanh khi employee chi tao dang ky cho minh, mot employee co toi da mot dang ky moi phien, va xung dot cap nhat tra `409` ro rang.

13. **Dang ky hang loat cho dai dien va admin.** Them input danh sach nhan vien, validate scope va session, ap dung atomically, UI bulk form, audit.
   - Hoan thanh khi mot batch co mot employee khong hop le khong ghi bat ky dang ky nao, va dai dien chi chon employee trong scope cua minh.

14. **Xu ly phieu giay theo batch.** Them batch, entry, preview, validation, apply, export loi, UI wizard, audit.
   - Hoan thanh khi he thong luu file reference va ket qua tung dong; apply lai batch da hoan thanh khong tao duplicate.

15. **Vang mat, huy, va dieu chinh sau cutoff.** Them `ABSENT`, `CANCELLED`, adjustment, ly do bat buoc, permission rieng, dialog UI, va audit truoc/sau.
   - Hoan thanh khi after-cutoff command khong the di qua API dang ky thuong, user khong co permission bi `403`, va audit co ly do va payload truoc/sau.

16. **Them reserve pool tuy chon.** Them feature flag theo organization, rule co dinh theo mon, snapshot theo session, allocation sau cutoff, locking transaction, API, va UI admin.
   - Hoan thanh khi tat feature thi khong co endpoint thao tac duoc; allocation truoc cutoff bi tu choi; tong allocation khong vuot pool khi co request dong thoi.

17. **Kiem thu luong end-to-end.** Viet integration test API cho tenant isolation, scope, cutoff, idempotency import/batch, adjustment, va pool. Viet Playwright cho login, menu, self-register, bulk, adjustment, va allocation.
   - Hoan thanh khi toan bo test chay voi PostgreSQL Compose sach, seed PNJP, va khong co test nao phu thuoc vao supplier SSO.

## Du lieu mock PNJP

Seed dung `PNJP` la organization code, `Nha may A` la factory, `San xuat`, `Van hanh`, va `Bao tri` la department, va cac team mau `Cat`, `Lap rap`, `QC`. Tao employee code mau `PNJP-0001` den `PNJP-0030`; ten dung gia tri gia, khong dung PII that. Tao mon `Com ga xoi mo`, `Ca kho to`, `Dau hu sot nam`, `Canh chua`, va tuy chon `com: it | vua | nhieu`. Tao menu cho tuan hien tai va tuan sau, session trua, va mot vai registration demo.

Tai khoan seed local mac dinh: `admin@pnjp.local` va `employee001@pnjp.local`. Password chi dung cho local development, dat qua bien moi truong `SEED_PASSWORD`, va khong hard-code trong repository.

## Cac quyet dinh con mo va default de khong chan tien do

| Quyet dinh | Default de trien khai | Cach thay doi sau nay |
|---|---|---|
| Meal type | `BREAKFAST`, `LUNCH`, `DINNER` enum | Chuyen sang bang cau hinh neu moi organization can type rieng |
| Don vi meal session | Mot session cho mot factory, ngay, meal type | Them ca hoac khu vuc sau khi co yeu cau that |
| Don gia va thanh toan | Luu `defaultPrice?`, khong tinh tien, khong tich hop payroll | Them billing module doc registration snapshot |
| Cap do role | Role system seed, grant scope luu o `UserRole` | Them custom role UI neu can, khong doi permission guard |
| Excel format | `.xlsx`, sheet dau tien, header bat buoc bang tieng Anh co template | Them column mapping sau khi co file thuc te |
| Refresh token | Cookie `httpOnly`, `Secure` o production, `SameSite=Lax` | Dieu chinh cho cross-site SSO khi SSO duoc thong qua |
| Reserve pool | Tat mac dinh tren moi organization | Bat bang setting organization, khong can migration dang ky |
| Audit retention | Luu vo thoi han trong local scope | Dat retention va archive khi co yeu cau van hanh |
| Multi-timezone | Toan he thong dung `Asia/Ho_Chi_Minh` | Tach `Organization.timezone` thanh cau hinh hoat dong khi co tenant ngoai Viet Nam |

## Rủi ro can kiem soat

Cutoff va timezone la diem de sai nhat. Tat ca logic phai dung `DateTime` service, co test tai moc mo/cutoff va dau tuan. Khong dung `new Date()` truc tiep trong domain service.

Data isolation khong duoc dua vao UI. Moi service lay scope tu `RequestPrincipal`, kiem tra cay ID, va dat filter vao query. Test cross-tenant la dieu kien merge cho moi module moi.

Excel va phieu giay de sinh duplicate. Moi workflow can co preview, apply ro rieng, unique constraint, idempotency key theo import/batch, va audit.

Reserve allocation co tranh chap so luong. Su dung PostgreSQL transaction va khoa dong pool cua session/mon, khong dem roi ghi ben ngoai giao dich.

## Ket luan

Thiet ke nay dat quy tac nghiep vu, tenant isolation, cutoff, va audit o NestJS, con Next.js tap trung vao man hinh va tuong tac. Pham vi Phase 0-2 du de dua mot nha may vao van hanh local ma khong keo theo phuc tap cua SSO nha cung cap, event sourcing, CQRS, hay ha tang production.
