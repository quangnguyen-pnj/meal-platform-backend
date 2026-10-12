# Candidate B: kế hoạch Phase 0-2 cho nền tảng suất ăn

## Phạm vi và các nguyên tắc

Hệ thống gồm hai repository độc lập: `meal-platform-web` cho Next.js 16 và `meal-platform-api` cho NestJS. Web chỉ gọi REST API. API sở hữu toàn bộ quy tắc nghiệp vụ, xác thực, kiểm tra quyền, và dữ liệu PostgreSQL.

Thiết kế này ưu tiên một ứng dụng NestJS dạng module và một cơ sở dữ liệu PostgreSQL. Không dùng event sourcing, CQRS, message broker, cache phân tán, object storage, hay giả định hạ tầng production. Docker Compose chỉ chạy PostgreSQL ở máy local. Audit là một bảng append-only do ứng dụng ghi trong cùng transaction với thay đổi nghiệp vụ, không phải event store.

Mọi ngày vận hành suất ăn dùng múi giờ `Asia/Ho_Chi_Minh`.

- API nhận và trả ngày vận hành dưới dạng `YYYY-MM-DD`.
- PostgreSQL lưu ngày vận hành bằng kiểu `date` và thời điểm mở, cutoff, publish bằng `timestamptz` ở UTC.
- Backend chuyển đổi ngày và giờ theo `Asia/Ho_Chi_Minh`. Frontend chỉ hiển thị theo múi giờ này.
- Không lưu chuỗi datetime không có offset.

Supplier SSO không thuộc Phase 0, 1, hoặc 2. Không tạo module, endpoint, hay mô hình supplier cho yêu cầu đó trong đợt này.

## Hai phương án đã cân nhắc

### Phương án A: một monorepo với web và API

Một monorepo chia sẻ types, công cụ lint, và quy trình phát hành. Phương án này giảm công việc đồng bộ contract khi đội nhỏ.

Tôi không chọn phương án này vì đề bài yêu cầu hai repository tách biệt. Nó cũng dễ khiến frontend import kiểu nội bộ của backend thay vì coi JSON contract là ranh giới thật. Có thể tạo package OpenAPI client dùng chung sau khi hai repo đã ổn định, nhưng không đưa vào Phase 0.

### Phương án B: hai repository, REST JSON và schema-first trong backend

Backend xuất OpenAPI từ DTO NestJS. Frontend giữ các API client, types, hooks riêng và gọi REST JSON. Hai repo có thể chạy, test, và phát hành độc lập. Contract thay đổi theo phiên bản API và được kiểm tra bằng integration test của backend cùng smoke test của frontend.

Chọn phương án này vì nó đúng với ranh giới yêu cầu, đơn giản cho local development, và không buộc phải dựng registry package hay pipeline phát hành chung.

### Phương án C: event sourcing hoặc CQRS cho đăng ký và audit

Phương án này giữ mọi thay đổi đăng ký dưới dạng event rồi dựng read model. Nó giải quyết tốt các báo cáo lịch sử phức tạp, nhưng tăng số bảng, retry, cách vận hành, và độ khó sửa dữ liệu.

Không chọn phương án này. Các trạng thái hiện tại của đăng ký và một `AuditLog` append-only trong transaction đáp ứng Phase 0-2. Nếu sau này cần ledger hoặc tích hợp bất đồng bộ, có thể thêm outbox ở một phase riêng mà không thay mô hình hiện tại.

## Cấu trúc repository

### `meal-platform-api`

```text
meal-platform-api/
├── docker-compose.yml
├── .env.example
├── prisma/
│   ├── schema.prisma
│   ├── migrations/
│   └── seed.ts
├── src/
│   ├── main.ts
│   ├── app.module.ts
│   ├── config/
│   ├── common/
│   │   ├── database/
│   │   ├── auth/
│   │   ├── authorization/
│   │   ├── audit/
│   │   ├── time/
│   │   ├── errors/
│   │   └── validation/
│   └── modules/
│       ├── organizations/
│       ├── workforce/
│       ├── imports/
│       ├── menus/
│       ├── meal-sessions/
│       ├── registrations/
│       └── reporting/
└── test/
    ├── integration/
    └── helpers/
```

- `common/database` chứa `PrismaService`, transaction helper, và repository primitives. Chỉ module backend được phép gọi Prisma.
- `common/auth` chuẩn hóa identity từ nhà cung cấp đăng nhập. `LocalIdentityProvider` là implementation duy nhất của Phase 0-2.
- `common/authorization` chuyển role assignment thành scope cho request và kiểm tra phạm vi trước mỗi truy vấn hoặc lệnh ghi.
- `common/audit` nhận actor, action, entity, và before/after snapshot. Service nghiệp vụ gọi nó trong transaction.
- `common/time` cung cấp parser cho operational date, cutoff evaluator, và formatter dùng một timezone duy nhất.
- Mỗi module trong `modules` có controller, service, DTO, mapper trả JSON, repository, và test. Controller chỉ parse HTTP và gọi service. Service sở hữu quy tắc nghiệp vụ. Repository đóng gói truy vấn Prisma có tenant filter.

`docker-compose.yml` chỉ khai báo service `postgres` với volume local, port `5432`, database, user, và password từ `.env`. Lệnh local dự kiến là `docker compose up -d postgres`, rồi `prisma migrate dev` và `prisma db seed`. Không đưa API hay web vào Compose ở Phase 0-2.

### `meal-platform-web`

```text
meal-platform-web/
├── app/
│   ├── (public)/login/page.tsx
│   ├── (protected)/layout.tsx
│   ├── (protected)/dashboard/page.tsx
│   ├── (protected)/organization/page.tsx
│   ├── (protected)/workforce/employees/page.tsx
│   ├── (protected)/workforce/imports/page.tsx
│   ├── (protected)/menus/page.tsx
│   ├── (protected)/meal-sessions/page.tsx
│   ├── (protected)/registrations/page.tsx
│   ├── (protected)/my-meals/page.tsx
│   └── (protected)/admin/reserve-allocations/page.tsx
├── components/
│   ├── ui/
│   ├── layout/
│   ├── organization/
│   ├── workforce/
│   ├── menus/
│   ├── registrations/
│   └── shared/
├── hooks/
├── api/
├── mappers/
├── contexts/
├── services/
├── lib/
└── types/
```

- `app` chỉ ghép page, layout, và component. Page không gọi API trực tiếp hoặc chuyển đổi API response trong JSX.
- `api` có các wrapper mỏng như `getEmployees`, `createMealRegistration`, và `publishMealSession`. Một `apiClient` dùng `credentials: 'include'`, JSON headers, và chuyển lỗi HTTP về lỗi có cấu trúc.
- `mappers` đổi DTO API thành view model. Ví dụ `mapMealSessionDtoToCalendarItem` và `mapImportJobDtoToImportSummary`.
- `hooks` sở hữu TanStack Query v5 query/mutation, invalidation, form state không tầm thường, và điều hướng sau mutation. Ví dụ `useEmployees`, `useEmployeeImport`, `useMealRegistrationActions`.
- `components` nhận props đã được định hình và callbacks. Chúng chỉ render Tailwind, shadcn/ui, và Lucide.
- `services` giữ logic thuần phía client như tạo cột bảng, format ngày, và chọn label status. `lib` chứa utility không phụ thuộc React.
- `contexts` chỉ dành cho state dùng chung thật sự, trước mắt `AuthContext` với user đã chuẩn hóa và scope đã tải. Query cache vẫn là nguồn dữ liệu server state.

Không dùng Zustand hoặc Redux trong phạm vi này. TanStack Query v5 và local UI state trong hook là đủ.

## Ranh giới module và luồng dữ liệu

### Cây dữ liệu tenant

Cây bắt buộc là `Organization -> Factory -> Department -> Team -> Employee`.

Một department thuộc đúng một factory. Một team thuộc đúng một department. Mỗi employee thuộc đúng một team, nên employee suy ra được department, factory, và organization. Dữ liệu vận hành luôn gắn với factory, vì lịch thực đơn và ca ăn là theo nhà máy.

Service xác minh quan hệ cha-con trước khi tạo hoặc cập nhật dữ liệu. Repository truy vấn employee bằng relation filter qua team, department, factory, organization. Query của ca ăn, thực đơn, và đăng ký luôn bắt đầu từ factory đã được authorization cho phép. Không có endpoint nhận một ID rồi gọi `findUnique` mà không kiểm tra scope.

### Module Phase 0

- `organizations`: tổ chức, factory, department, team, và cấu hình đơn vị cơ bản.
- `workforce`: employee, user account, vai trò có scope, danh sách employee.
- `imports`: upload, parse, validate, preview, commit Excel employee.
- `auth`: local login/logout/me, phát và xác thực JWT qua abstraction identity provider.
- `authorization`: guard, decorator yêu cầu permission, scope resolver, và service containment check.
- `audit`: ghi audit log cho CRUD, import, role assignment, và xác thực có ý nghĩa nghiệp vụ.

### Module Phase 1

- `menus`: dish catalog của organization và weekly menu của factory.
- `meal-sessions`: session theo ngày, loại bữa ăn, giờ mở, cutoff, publish, và lifecycle status. Session dish là danh sách món nhân viên có thể chọn.

### Module Phase 2

- `registrations`: đăng ký cá nhân, bulk của representative hoặc admin, batch phiếu giấy, hủy, absence, adjustment sau cutoff, và reserve allocation.
- `reporting`: các read-only count đơn giản cho session và batch. Không tách read model.

## Prisma entities chính

Tên dưới đây là Prisma models cấp thiết kế. Các field timestamp tiêu chuẩn gồm `createdAt`, `updatedAt`; các entity lịch sử cũng có `createdByUserId` khi cần. UUID dùng cho khóa chính.

### Tenant và nhân sự

| Model | Field và ràng buộc chính |
|---|---|
| `Organization` | `id`, `code` unique, `name`, `isActive`. Có nhiều factories, dishes, users. |
| `Factory` | `id`, `organizationId`, `code`, `name`, `timezone` mặc định `Asia/Ho_Chi_Minh`, `isActive`. Unique `(organizationId, code)`. |
| `Department` | `id`, `factoryId`, `code`, `name`, `isActive`. Unique `(factoryId, code)`. |
| `Team` | `id`, `departmentId`, `code`, `name`, `isActive`. Unique `(departmentId, code)`. |
| `Employee` | `id`, `employeeCode`, `fullName`, `email?`, `phone?`, `teamId`, `employmentStatus`, `isActive`. Unique `(organizationId, employeeCode)` through an explicit `organizationId` retained for uniqueness and import lookup; service kiểm tra organization này khớp organization suy ra từ team. |
| `User` | `id`, `organizationId?`, `email` unique, `displayName`, `passwordHash?`, `identityProvider`, `externalSubject?`, `employeeId?`, `isActive`, `lastLoginAt?`. Local account bắt buộc `passwordHash`; account SSO tương lai không cần password. Unique `(identityProvider, externalSubject)` khi `externalSubject` có giá trị. |
| `Role` | `id`, `code` unique, `name`, `permissions Json`. Seed các role cố định, không cần giao diện chỉnh role trong phase này. |
| `UserRole` | `id`, `userId`, `roleId`, `scopeType`, `organizationId?`, `factoryId?`, `departmentId?`, `teamId?`. Check constraint bảo đảm đúng một scope id tương ứng với `scopeType`; unique `(userId, roleId, scopeType, scope-id)` theo index phù hợp. |
| `AuditLog` | `id`, `organizationId?`, `actorUserId?`, `action`, `entityType`, `entityId`, `scopeType?`, `scopeId?`, `before Json?`, `after Json?`, `metadata Json?`, `occurredAt`. Không có update/delete endpoint cho entity này. |

Prisma không tự biểu đạt hết check constraint và partial unique index. Migration SQL bổ sung các constraint đó. Service vẫn kiểm tra rõ ràng để trả lỗi 400 dễ hiểu thay vì chỉ dựa vào lỗi database.

### Import Excel

| Model | Field và ràng buộc chính |
|---|---|
| `EmployeeImportJob` | `id`, `organizationId`, `targetFactoryId`, `status` gồm `UPLOADED`, `VALIDATED`, `COMMITTED`, `FAILED`, `createdByUserId`, `originalFileName`, `summary Json`, `committedAt?`. |
| `EmployeeImportRow` | `id`, `jobId`, `rowNumber`, `raw Json`, `normalized Json?`, `validationErrors Json`, `outcome` gồm `VALID`, `INVALID`, `CREATED`, `UPDATED`, `SKIPPED`. Unique `(jobId, rowNumber)`. |

API nhận workbook multipart, giới hạn kích thước cấu hình local, parse bằng thư viện Excel ở backend, rồi lưu các row đã chuẩn hóa và lỗi. Phase 0 không giữ file gốc sau request. Người dùng tải template từ frontend dưới dạng file tĩnh. Commit chỉ chấp nhận job `VALIDATED`; transaction tạo hoặc cập nhật employee theo `employeeCode` trong organization đã chọn.

### Thực đơn và session

| Model | Field và ràng buộc chính |
|---|---|
| `Dish` | `id`, `organizationId`, `code`, `name`, `description?`, `dietaryTags Json`, `isActive`. Unique `(organizationId, code)`. |
| `WeeklyMenu` | `id`, `factoryId`, `weekStartDate`, `status` gồm `DRAFT`, `PUBLISHED`, `ARCHIVED`, `publishedAt?`, `publishedByUserId?`. Unique `(factoryId, weekStartDate)`. `weekStartDate` luôn là thứ Hai tại Ho Chi Minh. |
| `WeeklyMenuItem` | `id`, `weeklyMenuId`, `serviceDate`, `mealType`, `dishId`, `sortOrder`. Unique `(weeklyMenuId, serviceDate, mealType, dishId)`. |
| `MealSession` | `id`, `factoryId`, `weeklyMenuId?`, `serviceDate`, `mealType`, `status` gồm `DRAFT`, `PUBLISHED`, `OPEN`, `CUTOFF_REACHED`, `CLOSED`, `CANCELLED`, `opensAt`, `cutoffAt`, `publishedAt?`, `publishedByUserId?`. Unique `(factoryId, serviceDate, mealType)`. |
| `MealSessionDish` | `id`, `mealSessionId`, `dishId`, `sortOrder`, `reservePoolSize?`. Unique `(mealSessionId, dishId)`. `reservePoolSize` null nghĩa là tắt reserve cho món đó. |

`WeeklyMenu` là lịch biên soạn. Publish weekly menu tạo hoặc cập nhật các `MealSession` draft tương ứng trong cùng transaction, nhưng không ghi đè session đã có đăng ký. Sau đó admin chỉnh thời gian mở và cutoff theo session nếu cần. Publish session mới cho phép đăng ký. Worker không cần thiết: mọi command và query gọi `SessionStatusService` để đánh giá thời điểm hiện tại theo cutoff; một lệnh admin có thể đồng bộ status để hiển thị nhất quán.

### Đăng ký và điều chỉnh

| Model | Field và ràng buộc chính |
|---|---|
| `RegistrationBatch` | `id`, `factoryId`, `source` gồm `REPRESENTATIVE`, `ADMIN`, `PAPER_FORM`, `createdByUserId`, `reason?`, `paperReference?`, `status` gồm `DRAFT`, `COMMITTED`, `REJECTED`, `submittedAt?`. |
| `MealRegistration` | `id`, `mealSessionId`, `employeeId`, `mealSessionDishId`, `status` gồm `REGISTERED`, `CANCELLED`, `ABSENT`, `RESERVE_ALLOCATED`, `adjustmentReason?`, `source`, `registrationBatchId?`, `createdByUserId`, `updatedByUserId`, `registeredAt`, `cancelledAt?`, `absentAt?`. Unique `(mealSessionId, employeeId)`. |
| `RegistrationChange` | `id`, `mealRegistrationId`, `kind` gồm `CREATE`, `CANCEL`, `MARK_ABSENT`, `CHANGE_DISH`, `POST_CUTOFF_ADJUSTMENT`, `RESERVE_ALLOCATION`, `before Json?`, `after Json?`, `reason?`, `actorUserId`, `occurredAt`. |

`RegistrationChange` bổ sung lịch sử dễ đọc cho một đăng ký. `AuditLog` vẫn ghi sự kiện quyền và thay đổi dữ liệu tổng quát. Không dùng cả hai bảng làm event stream.

Khi reserve được bật, `reservePoolSize` là số suất reserve cố định của đúng `MealSessionDish`. Sau cutoff, chỉ `OrganizationAdmin` hoặc `FactoryAdmin` có permission `reserve:allocate` mới tạo `RESERVE_ALLOCATED`. Service khóa session dish trong transaction PostgreSQL và đếm allocation hiện tại trước khi tạo record. Nếu số lượng đã bằng pool size, API trả `409 RESERVE_POOL_EXHAUSTED`. Chỉ allocation reserve có thể tăng đăng ký sau cutoff. Mọi thay đổi khác sau cutoff cần permission `registration:adjust-after-cutoff`, lý do không rỗng, và `RegistrationChange` lẫn `AuditLog`.

## Xác thực và phân quyền

### Local JWT sau abstraction

`AuthService` chỉ biết interface sau:

```ts
export interface AuthenticatedIdentity {
  provider: string;
  subject: string;
  email: string;
  displayName: string;
}

export interface IdentityProvider {
  readonly provider: string;
  authenticate(input: LoginInput): Promise<AuthenticatedIdentity>;
}
```

`LocalIdentityProvider` xác thực email và password hash bằng Argon2id, rồi trả identity chuẩn hóa có `provider = 'local'` và subject ổn định của local account. `AccountResolver` tìm hoặc liên kết `User` từ identity. `JwtIssuer` ký claim tối thiểu gồm `sub`, `org`, `iat`, `exp`, và `jti`.

Phase 0 chỉ đăng ký `LocalIdentityProvider`. Sau này Enterprise SSO thêm implementation như `OidcIdentityProvider` và callback controller, sau đó vẫn đi qua `AccountResolver` cùng `JwtIssuer`. Không thêm nhánh điều kiện SSO vào workforce hoặc authorization module.

`POST /auth/login` đặt JWT trong cookie `access_token` có `HttpOnly`, `SameSite=Lax`, và `Secure` theo environment; API cũng chấp nhận `Authorization: Bearer` cho script hoặc test. Web dùng `credentials: 'include'`. API cấu hình CORS chính xác cho `NEXT_PUBLIC_API_ORIGIN` và không dùng wildcard khi credentials bật. `POST /auth/logout` xóa cookie. `GET /auth/me` trả user, employee, role, permission, và scope đã chuẩn hóa. Thời hạn access token mặc định là 8 giờ, không có refresh token trong Phase 0.

Seed local accounts có password lấy từ biến môi trường `SEED_ADMIN_PASSWORD`, không ghi password thật trong repository. Seed tạo ít nhất một tổ chức demo, một factory, department, team, vài employee, role assignments, và account `admin@example.test` cho mục đích local.

### RBAC có scope

Permission là atom như `organization:manage`, `employee:read`, `employee:write`, `employee:import`, `menu:manage`, `session:publish`, `registration:self`, `registration:bulk`, `registration:adjust-after-cutoff`, `reserve:allocate`, và `audit:read`.

Role seed mặc định:

| Role | Scope hợp lệ | Quyền chính |
|---|---|---|
| `OrganizationAdmin` | organization | quản lý toàn bộ factory con, user roles, menu, session, bulk, reserve, audit |
| `FactoryAdmin` | factory | quản lý workforce và meal data trong factory, không quản lý factory khác |
| `DepartmentRepresentative` | department | đọc employee thuộc department và bulk registration cho employee con |
| `TeamRepresentative` | team | đọc employee thuộc team và bulk registration cho employee con |
| `Employee` | self | đọc profile và self-registration của chính mình |
| `Auditor` | organization hoặc factory | chỉ đọc audit log và report được cấp quyền |

`AuthorizationGuard` xác thực JWT, nạp roles, tạo `RequestPrincipal`, và decorator yêu cầu permission. `ScopeResolver` kiểm tra target có nằm trong cây descendant của bất kỳ assignment phù hợp hay không. Self scope chỉ cho phép `employeeId` được gắn với `User`. Service luôn gọi resolver trước khi repository truy vấn hoặc ghi.

Frontend ẩn nút không có permission để giao diện gọn hơn. Backend là nơi thực thi quyền, nên API vẫn trả `403` nếu client tự gọi URL trái quyền.

## Nhóm REST API

Prefix dùng `/v1`. DTO request và response JSON dùng camelCase. Collection hỗ trợ `page`, `pageSize`, filter scope, và sort giới hạn. Lỗi dùng `{ code, message, details? }`.

| Nhóm | Endpoint chính |
|---|---|
| Auth | `POST /auth/login`, `POST /auth/logout`, `GET /auth/me` |
| Organizations | `GET, POST /organizations`; `GET, PATCH /organizations/:id`; `GET, POST /organizations/:organizationId/factories`; nested departments và teams; `GET /scope-tree` |
| Workforce | `GET, POST /employees`; `GET, PATCH /employees/:id`; `GET, POST /users`; `PUT /users/:id/roles` |
| Imports | `POST /employee-imports/upload`; `GET /employee-imports/:id`; `GET /employee-imports/:id/rows`; `POST /employee-imports/:id/validate`; `POST /employee-imports/:id/commit` |
| Audit | `GET /audit-logs` theo authorized organization, factory, entity, actor, khoảng ngày |
| Dishes | `GET, POST /dishes`; `GET, PATCH /dishes/:id` |
| Menus | `GET, POST /weekly-menus`; `GET, PATCH /weekly-menus/:id`; `POST /weekly-menus/:id/publish` |
| Sessions | `GET /meal-sessions`; `GET, PATCH /meal-sessions/:id`; `POST /meal-sessions/:id/publish`; `POST /meal-sessions/:id/cancel`; `POST /meal-sessions/:id/sync-status` |
| Registrations | `GET /meal-sessions/:id/registrations`; `PUT /meal-sessions/:id/my-registration`; `POST /registration-batches`; `POST /registration-batches/:id/rows`; `POST /registration-batches/:id/commit`; `POST /meal-registrations/:id/cancel`; `POST /meal-registrations/:id/mark-absent`; `POST /meal-registrations/:id/adjust`; `POST /meal-sessions/:id/reserve-allocations` |
| Reports | `GET /meal-sessions/:id/summary`; `GET /registration-batches/:id/summary` |

`PUT /meal-sessions/:id/my-registration` là upsert cho employee hiện tại. Nó chỉ hoạt động khi session đã publish, đã mở, chưa cutoff, employee thuộc cùng factory, và dish thuộc session. API trả registration hiện tại khi request lặp lại cùng payload, vì client có thể retry.

Bulk request dùng `RegistrationBatch`. Mỗi row chứa `employeeId`, `mealSessionId`, và `mealSessionDishId`. Backend kiểm tra từng row, trả preview lỗi, và chỉ commit toàn bộ batch nếu mọi row hợp lệ. Paper form dùng cùng batch flow với `source = PAPER_FORM`, `paperReference` bắt buộc, và không lưu ảnh file trong phase này.

## Frontend route và module boundaries

| Route | Chủ sở hữu UI | Hook và API |
|---|---|---|
| `/login` | `AuthForm` | `useAuthForm`, `authApi.login` |
| `/dashboard` | session summary cards | `useDashboardSessions`, `mealSessionsApi.list` |
| `/organization` | organization tree, factory/department/team forms | `useOrganizationTree`, `organizationApi` |
| `/workforce/employees` | employee table và form | `useEmployees`, `workforceApi` |
| `/workforce/imports` | upload, validation rows, commit controls | `useEmployeeImport`, `importsApi` |
| `/menus` | week picker, dish catalog, weekly menu editor | `useDishes`, `useWeeklyMenu`, `menusApi` |
| `/meal-sessions` | session list, clock/status controls | `useMealSessions`, `mealSessionsApi` |
| `/my-meals` | employee session cards and selection form | `useMyMealRegistrations`, `useMealRegistrationActions` |
| `/registrations` | representative/admin batch table and paper form entry | `useRegistrationBatch`, `registrationsApi` |
| `/admin/reserve-allocations` | after-cutoff allocation table | `useReserveAllocations`, `registrationsApi` |

`(protected)/layout.tsx` mount `AuthProvider` và `QueryClientProvider`. `AuthProvider` lấy `GET /auth/me` qua `useCurrentUser`; layout hiển thị loading hoặc unauthorized state. Next middleware chỉ hỗ trợ chuyển hướng theo sự có mặt của cookie. Nó không thay thế kiểm tra JWT của API.

Sau mutation, hook invalidates query keys theo factory, session, hoặc batch liên quan. Components không gọi `queryClient`, không đặt business rule về cutoff, và không quyết định role có quyền hay không ngoài việc nhận `canAllocateReserve` hay callback đã chuẩn bị.

## Kế hoạch task theo dependency

Mỗi task kết thúc bằng một trạng thái kiểm chứng được. Thứ tự dưới đây áp dụng cho hai repository độc lập, nhưng các task frontend có thể bắt đầu khi API contract của task backend tương ứng đã ổn định.

| ID | Task | Phụ thuộc | Tiêu chí hoàn thành |
|---|---|---|---|
| 0.1 | Tạo hai repository, TypeScript strict, formatter, lint, test runner, `.env.example` | Không có | Cả hai repo cài dependency và chạy lint/test rỗng thành công. |
| 0.2 | Dựng PostgreSQL local và Prisma 7 | 0.1 API | `docker compose up -d postgres`, migrate, và Prisma client hoạt động trên database trống. |
| 0.3 | Tạo Nest config, global validation, error response, request logging, OpenAPI | 0.2 | Một endpoint health trả JSON; invalid DTO trả format lỗi chuẩn. |
| 0.4 | Tạo Next App Router, Tailwind, shadcn/ui, Lucide, QueryClient provider, API client | 0.1 web | Trang shell render; API client có base URL, credentials, và error mapping. |
| 0.5 | Viết migration tenant và workforce models | 0.2 | Migration tạo Organization, Factory, Department, Team, Employee, User, Role, UserRole với indexes và checks cần thiết. |
| 0.6 | Seed role, demo hierarchy, employee, và local admin từ environment | 0.5 | `prisma db seed` chạy lại được và tạo account local không hard-code password. |
| 0.7 | Cài auth abstraction, local provider, JWT cookie/bearer guard và `/auth/me` | 0.6, 0.3 | Login đúng tạo JWT; login sai trả 401; `/auth/me` trả principal; logout xóa cookie. |
| 0.8 | Cài permission decorator, scope resolver, và repository tenant filters | 0.5, 0.7 | Test chứng minh factory admin không đọc hoặc ghi employee của factory khác. |
| 0.9 | Cài `AuditLog` transaction helper và audit read API | 0.7, 0.8 | Một update employee tạo audit row cùng transaction; auditor trái scope nhận 403. |
| 0.10 | Tạo organization hierarchy CRUD API | 0.8, 0.9 | API chặn child không thuộc parent và ghi audit cho create/update. |
| 0.11 | Tạo employee, user, role assignment CRUD API | 0.8, 0.9, 0.10 | Employee code unique trong organization; self user chỉ truy cập employee được link. |
| 0.12 | Tạo UI login, protected shell, và organization/workforce screens | 0.4, 0.7, 0.10, 0.11 | Admin local đăng nhập, tạo hierarchy, tạo employee trên browser local. |
| 0.13 | Tạo import job, Excel parser, validator, preview, và atomic commit API | 0.11 | File có row sai không commit row nào; row hợp lệ tạo hoặc update đúng và có audit. |
| 0.14 | Tạo import UI cùng template download | 0.4, 0.13 | Người dùng upload, xem lỗi theo row, rồi commit job hợp lệ. |
| 0.15 | Hoàn tất test Phase 0 | 0.7-0.14 | Integration tests bao phủ auth, RBAC scope, hierarchy containment, import rollback, audit; web smoke test bao phủ login và import preview. |
| 1.1 | Thêm dish, weekly menu, meal session, và session dish migration | 0.2, 0.10 | Database có unique keys cho week/session và foreign keys hợp lệ. |
| 1.2 | Tạo dish catalog API với organization scope | 1.1, 0.8 | Factory admin chỉ quản lý dishes trong organization được cấp. |
| 1.3 | Tạo weekly menu draft/edit/publish service | 1.1, 1.2, 0.9 | Publish tạo session draft cho item hợp lệ và không ghi đè session có registration. |
| 1.4 | Tạo session lifecycle, timezone parser, opening/cutoff evaluator, session API | 1.3 | API trả đúng OPEN hoặc CUTOFF_REACHED cho thời điểm HCM ở các boundary. |
| 1.5 | Tạo menu và session UI | 0.4, 1.2-1.4 | Admin tạo dish, biên soạn tuần, publish, rồi xem session và cutoff. |
| 1.6 | Hoàn tất test Phase 1 | 1.2-1.5 | Test phủ unique session, publish idempotency, timezone boundary, và publish authorization. |
| 2.1 | Thêm registration batch, registration, change history, và reserve fields migration | 1.1 | Unique employee/session và foreign keys ngăn employee/dish sai session. |
| 2.2 | Tạo self-registration service và API | 2.1, 1.4, 0.8 | Employee chỉ đăng ký session factory của mình trước cutoff; retry cùng request không nhân bản record. |
| 2.3 | Tạo representative/admin bulk batch và paper form service/API | 2.1, 2.2, 0.8 | Batch trái scope bị từ chối; batch có một row lỗi không commit; paper batch bắt buộc reference. |
| 2.4 | Tạo cancel, absence, và post-cutoff adjustment service/API | 2.2, 0.9 | Sau cutoff chỉ permission phù hợp kèm reason mới điều chỉnh được; mỗi thay đổi có `RegistrationChange` và `AuditLog`. |
| 2.5 | Tạo reserve allocation transaction và API | 2.1, 2.4 | Chỉ admin cấp quyền allocate được sau cutoff; concurrent allocation không vượt `reservePoolSize`. |
| 2.6 | Tạo my-meals, bulk registration, paper batch, và reserve allocation UI | 0.4, 2.2-2.5 | Employee đăng ký/hủy được; representative commit batch; admin thấy lý do adjustment và phân reserve. |
| 2.7 | Tạo session và batch summary API/UI | 2.2-2.5 | Summary phân biệt registered, cancelled, absent, và reserve allocated theo món. |
| 2.8 | Hoàn tất test Phase 2 và demo local | 2.2-2.7 | Integration tests phủ scope, cutoff, reason, reserve capacity, retry; browser smoke test phủ các luồng employee, representative, và admin. |

## Quyết định còn mở và default được đề xuất

| Quyết định | Default để triển khai không chặn | Lý do |
|---|---|---|
| Loại bữa ăn | Enum `BREAKFAST`, `LUNCH`, `DINNER` | Dễ validate. Khi cần ca đặc biệt, thêm migration và UI sau. |
| Một employee có bao nhiêu món mỗi session | Một `MealSessionDish` cho mỗi `MealRegistration` | Phù hợp suất ăn một phần và giữ unique employee/session. Combo hoặc nhiều phần là phase mới. |
| Cutoff mặc định | `09:00` ngày trước service date theo `Asia/Ho_Chi_Minh`, có thể sửa từng session trước publish | Có giá trị cụ thể cho demo, nhưng không đóng cứng chính sách nhà máy. |
| Tạo session từ weekly menu | Publish menu tạo session draft, admin publish session sau khi xác nhận giờ | Tránh mở đăng ký ngoài ý muốn khi menu vừa được soạn. |
| Excel template | Cột `employeeCode`, `fullName`, `email`, `phone`, `departmentCode`, `teamCode` | Đủ cho upsert employee và kiểm tra vị trí trong tree. |
| Xử lý duplicate import | Cùng `employeeCode` trong organization thì update các field được phép khi commit | Hỗ trợ sync nhân sự local. UI phải hiển thị row sẽ update. |
| Retention audit | Giữ vô thời hạn trong local database Phase 0-2 | Chưa có yêu cầu retention hay hạ tầng archive. |
| Lưu phiếu giấy | `paperReference` text, không upload scan | Loại bỏ nhu cầu file storage. |
| Refresh token và reset password | Không làm trong Phase 0-2 | Local seed account và access token 8 giờ đủ cho demo. Bổ sung lifecycle account ở phase riêng. |
| Reserve pool | Tắt mặc định, chỉ bật theo `MealSessionDish.reservePoolSize` trước cutoff | Không ép nhà máy dùng reserve và giữ pool theo từng món. |

## Kiểm chứng trước khi chấp nhận từng phase

Phase 0 chỉ được chấp nhận khi một factory admin không thể đọc dữ liệu factory khác qua mọi endpoint, import không tạo dữ liệu nửa chừng, và thay đổi quan trọng có audit. Phase 1 cần chứng minh lịch tuần, session, và cutoff đều dùng đúng ngày HCM. Phase 2 cần chứng minh employee không tự vượt cutoff, representative không vượt scope, adjustment luôn có lý do và audit, còn transaction reserve không cấp quá số suất cố định.

Tôi chọn cấu trúc này vì các quy tắc khó nhất nằm ở service và authorization backend, còn frontend giữ vai trò hiển thị và điều phối tương tác. Khi Enterprise SSO xuất hiện, thay thế điểm vào identity không làm thay đổi dữ liệu suất ăn hoặc quyền có scope. Khi yêu cầu supplier SSO xuất hiện, nó cần một proposal riêng thay vì âm thầm mở rộng Phase 0-2.
