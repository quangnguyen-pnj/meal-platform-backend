# Kế hoạch triển khai Factory meal management, Phase 0 đến Phase 2

## Quyết định đã chốt

| Hạng mục | Quyết định |
|---|---|
| Repository | Hai repository độc lập: `meal-platform-api` và `meal-platform-web` |
| Frontend | Next.js 16 App Router, TypeScript, Tailwind CSS, shadcn/ui, Lucide, TanStack Query v5 |
| Backend | NestJS, REST/JSON, PostgreSQL, Prisma 7 |
| Local development | Docker Compose chạy PostgreSQL; API và web chạy bằng lệnh local |
| Xác thực Phase 0-2 | JWT từ local account seed, đặt sau identity-provider interface để thay Enterprise SSO sau này |
| Supplier | Không xây Supplier SSO, supplier portal, order, delivery, hay reconciliation trong Phase 0-2 |
| Time zone | `Asia/Ho_Chi_Minh`; ngày vận hành dùng `YYYY-MM-DD`, timestamp lưu UTC |
| Mock data | PNJP giả lập, không dùng dữ liệu cá nhân thật |
| Client server state | TanStack Query v5, không thêm SWR, Redux, hoặc Zustand |

## Ranh giới kiến trúc

API là nơi duy nhất áp dụng quy tắc cutoff, RBAC, scope, tenant isolation, audit, và transaction. Frontend chỉ hiển thị dữ liệu, quản lý form state, gọi REST API, và làm mới TanStack Query cache.

Mọi dữ liệu nghiệp vụ được giới hạn theo `Organization -> Factory -> Department -> Team`. Mỗi lệnh đọc hoặc ghi phải lấy `RequestPrincipal` từ token, kiểm tra permission, sau đó kiểm tra target có nằm trong scope cấp cho principal hay không. Không lọc dữ liệu ở phía frontend sau khi API đã trả về.

Mô hình quan trọng:

```text
Organization
  Factory
    Department
      Team
        Employee

UserAccount -- UserRole(scope) -- Role -- Permission
Employee -- optional linked UserAccount

WeeklyMenu -- MenuItem -- Dish
MealSession -- MealSessionDish
MealSession -- MealRegistration -- Employee
MealRegistration -- RegistrationChange
MealSessionDish -- ReservePoolSetting -- ReserveAllocation
```

Các trạng thái cần dùng discriminated enum trong API và database:

```text
WeeklyMenuStatus = DRAFT | PUBLISHED | ARCHIVED
MealSessionStatus = DRAFT | PUBLISHED | OPEN | CLOSED | CANCELLED
RegistrationStatus = REGISTERED | CANCELLED | ABSENT
RegistrationSource = SELF | BULK | PAPER_FORM | ADMIN_ADJUSTMENT
RegistrationChangeKind = CREATED | DISH_CHANGED | CANCELLED | ABSENT | POST_CUTOFF_ADJUSTMENT
ImportJobStatus = UPLOADED | VALIDATED | COMMITTED | FAILED
ReserveAllocationStatus = ALLOCATED | CANCELLED
```

Không dùng event sourcing hoặc CQRS. `RegistrationChange` lưu lịch sử riêng của đăng ký, còn `AuditLog` lưu dấu vết cấp hệ thống. Hai bảng không phải event stream.

## Hình dạng repository

### `meal-platform-api`

```text
meal-platform-api/
  prisma/
    schema.prisma
    migrations/
    seed.ts
  src/
    config/
    common/
      database/
      auth/
      authorization/
      audit/
      time/
      errors/
    modules/
      auth/
      organizations/
      workforce/
      employee-imports/
      menus/
      meal-sessions/
      registrations/
      reports/
  docker-compose.yml
  .env.example
  README.md
```

Controller chỉ xử lý HTTP và DTO. Service sở hữu nghiệp vụ và transaction. Không tạo repository wrapper tổng quát. Query Prisma phức tạp, nếu tái sử dụng trong cùng module, có thể ở repository nội bộ của module.

Các public contract chính:

```ts
interface IdentityProvider {
  readonly provider: 'local' | 'enterprise-sso';
  authenticate(input: { email: string; password: string }): Promise<AuthenticatedIdentity | null>;
}

interface ScopeAuthorizer {
  assertPermission(input: { principal: RequestPrincipal; permission: PermissionCode }): void;
  assertScope(input: { principal: RequestPrincipal; scope: ResourceScope }): Promise<void>;
}

interface MealSessionAccess {
  getRegistrationWindow(input: { mealSessionId: string; now: Date }): Promise<RegistrationWindow>;
}
```

`LocalIdentityProvider` là implementation duy nhất ở Phase 0-2. Khi có Enterprise SSO, thêm implementation OIDC/SAML và callback adapter, sau đó tiếp tục dùng account resolver cùng JWT issuer.

### `meal-platform-web`

```text
meal-platform-web/
  app/
    (public)/login/page.tsx
    (protected)/layout.tsx
    (protected)/dashboard/page.tsx
    (protected)/organization/page.tsx
    (protected)/workforce/employees/page.tsx
    (protected)/workforce/imports/page.tsx
    (protected)/menus/page.tsx
    (protected)/meal-sessions/page.tsx
    (protected)/my-meals/page.tsx
    (protected)/registrations/page.tsx
    (protected)/adjustments/page.tsx
    (protected)/reserve-pools/page.tsx
  api/
  components/
  contexts/
  hooks/
  mappers/
  services/
  lib/
  types/
```

`app/` và `components/` nhận props đã định hình, render UI, và nối event. `hooks/` giữ TanStack Query, form state, mutation và redirect. `api/` là REST wrappers mỏng. `mappers/` chuyển DTO thành view model. Components không gọi API, không quyết định cutoff, không chuyển đổi API response trong JSX.

## Dữ liệu Phase 0-2

### Phase 0

- `Organization`, `Factory`, `Department`, `Team`
- `Employee` với `employeeCode`, `fullName`, `email?`, `hasPersonalDevice`, và team hiện tại
- `UserAccount`, `ExternalIdentity`, `Role`, `Permission`, `UserRole`, `RefreshSession`
- `AuditLog`
- `EmployeeImportJob`, `EmployeeImportRow`

`Employee` giữ foreign key hiện tại đến factory, department, team để filter nhanh. Service xác minh cây tổ chức trước khi lưu. Bảng assignment history chưa thuộc MVP Phase 0-2 vì không có user flow cần xem lịch sử điều chuyển. Thêm nó chỉ khi nghiệp vụ yêu cầu.

### Phase 1

- `Dish` với code, tên, category hoặc tags, active state
- `WeeklyMenu`, `MenuItem`
- `MealSession`, `MealSessionDish`

Một `MealSession` là duy nhất theo factory, operational date, và meal type. Danh sách món là cấu hình dữ liệu, không giới hạn năm món. Publish menu tạo session draft. Admin publish hoặc mở session sau khi chốt opening time và cutoff time. Mỗi write API vẫn kiểm tra cutoff trực tiếp, vì không được dựa vào worker để bảo vệ dữ liệu.

### Phase 2

- `MealRegistration`, unique `(mealSessionId, employeeId)`
- `RegistrationBatch` cho BULK hoặc PAPER_FORM
- `RegistrationBatchEntry` để preview row và trạng thái nhập phiếu giấy
- `RegistrationChange`
- `ReservePoolSetting` theo session dish, mặc định tắt
- `ReserveAllocation`

Reserve pool dùng số lượng cố định trên từng món của session. Sau cutoff, chỉ admin có permission phù hợp được cấp reserve. Cấp reserve là allocation độc lập, không biến một nhân viên chưa đăng ký thành registration thường. Transaction khóa session dish hoặc row pool trước khi cộng số đã dùng, và từ chối allocation vượt hạn mức.

## Contract REST dự kiến

Tất cả endpoint dùng prefix `/v1`, DTO camelCase, lỗi `{ code, message, details?, requestId }`.

| Nhóm | Endpoint chính |
|---|---|
| Auth | `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me` |
| Organization | CRUD factory, department, team; `GET /scope-tree` |
| Workforce | CRUD employee, user account, role assignment |
| Import | validate upload, xem rows, apply import employee |
| Audit | list audit logs trong scope được cấp |
| Menus | CRUD dishes, weekly menu draft/edit/publish/archive |
| Sessions | list/create/update/publish/open/close/cancel meal session |
| Registrations | self upsert, bulk batch, paper-form batch, cancel, absent, adjustment |
| Reserve | get pool, configure session-dish limit, allocate after cutoff |
| Reports | session summary theo món, department, team và status |

`POST /meal-sessions/:id/registrations/self` chỉ thay đổi registration của `principal.employeeId`. `POST /meal-sessions/:id/registrations/bulk` luôn validate toàn bộ input trước khi commit. Một row không hợp lệ khiến batch không ghi bất cứ registration nào.

## Các task có thể thực hiện

Các task dưới đây đủ nhỏ để giao cho agent thực hiện độc lập. Thứ tự là dependency bắt buộc. Không có task nào được coi là hoàn tất chỉ vì build qua. Task phải kiểm chứng bằng thao tác local thực tế theo tiêu chí ghi kèm.

### Nền tảng

| ID | Repository | Task | Phụ thuộc | Tiêu chí hoàn thành |
|---|---|---|---|---|
| F0-01 | API | Khởi tạo NestJS TypeScript, Prisma 7, ESLint, `.env.example`, Docker Compose PostgreSQL, health endpoint, chuẩn lỗi và validation DTO. | Không có | PostgreSQL chạy bằng Compose, migration kết nối được, health endpoint trả JSON, DTO lỗi trả format chuẩn. |
| F0-02 | Web | Khởi tạo Next.js 16 TypeScript, Tailwind, shadcn/ui, Lucide, TanStack Query v5, query provider, HTTP client. | Không có | Trang shell render, HTTP client gọi health endpoint và hiển thị lỗi có cấu trúc. |
| F0-03 | API | Tạo schema và seed Phase 0: tenant tree, employee, user, role, permission, grant, audit. | F0-01 | Seed có PNJP giả lập, factory, departments, teams, admin, representative, office employee, worker không account. |
| F0-04 | API | Xây auth abstraction, LocalIdentityProvider, JWT access/refresh, `/auth/me`, logout. | F0-03 | Login local thành công, refresh đổi token, logout vô hiệu refresh session, password không nằm trong source code. |
| F0-05 | API | Xây permission guard, principal, scope authorization và audit transaction helper. | F0-03, F0-04 | User scope team không đọc/sửa team khác; mutation tạo audit có actor, action, entity, timestamp. |

### Phase 0

| ID | Repository | Task | Phụ thuộc | Tiêu chí hoàn thành |
|---|---|---|---|---|
| P0-01 | API | CRUD factory, department, team kèm containment validation và audit. | F0-05 | Không thể tạo team dưới department khác factory hoặc truy cập đơn vị ngoài scope. |
| P0-02 | API | CRUD employee, link account optional, role/scope grant API. | P0-01 | `employeeCode` unique trong organization; employee account chỉ có self scope; changes được audit. |
| P0-03 | Web | Login, protected shell, navigation theo permission, organization tree và employee screens. | F0-02, P0-01, P0-02 | Admin local đăng nhập, quản lý organizational tree và nhân viên trong scope; UI không hiển thị action trái quyền. |
| P0-04 | API | Employee Excel template, multipart validation, preview rows, atomic apply/upsert và audit import. | P0-02 | File lỗi không ghi dữ liệu một phần; import hợp lệ create/update theo employee code; apply lại không tạo duplicate. |
| P0-05 | Web | Import wizard: download template, upload, xem lỗi theo row, xác nhận apply. | F0-02, P0-04 | Người dùng thực hiện được toàn bộ import local trên browser. |
| P0-06 | API + Web | Hoàn thiện mock data PNJP và README chạy local. | P0-03, P0-05 | Repository mới có thể chạy theo README và demo auth, scope, employee import mà không cần dịch vụ ngoài. |

### Phase 1

| ID | Repository | Task | Phụ thuộc | Tiêu chí hoàn thành |
|---|---|---|---|---|
| P1-01 | API | Migration và API Dish catalog. | P0-02 | Admin trong scope tạo/sửa/disable món; món disabled không thêm được vào session mới. |
| P1-02 | API | Weekly menu draft/edit/publish và menu item theo date/meal type. | P1-01 | Một factory có tối đa một menu mỗi tuần; publish chỉ chấp nhận menu hợp lệ và ghi audit. |
| P1-03 | API | Meal session và `MealSessionAccess`: opening time, cutoff, lifecycle và timezone handling. | P1-02 | Tại cutoff, API từ chối registration ngay cả khi không có background job; date hiển thị đúng giờ HCM. |
| P1-04 | Web | Dish catalog và weekly menu editor. | F0-02, P1-01, P1-02 | Admin tạo menu tuần có món khác nhau theo ngày/bữa rồi publish. |
| P1-05 | Web | Meal sessions list, status text/icon, cutoff display và open/close/cancel actions. | F0-02, P1-03 | Admin thấy rõ session state và cutoff; mọi status có text, không chỉ màu. |
| P1-06 | API + Web | Session summary read-only theo dish, department và team. | P1-03, P1-05 | Admin xem được tổng đăng ký hiện có, luôn bị filter theo scope. |

### Phase 2

| ID | Repository | Task | Phụ thuộc | Tiêu chí hoàn thành |
|---|---|---|---|---|
| P2-01 | API | Migration registration, batches, change history, reserve pool settings/allocation. | P1-03 | Unique employee/session và dish/session được database bảo vệ. |
| P2-02 | API | Self-registration create/change/cancel trước cutoff. | P2-01 | Employee chỉ thao tác registration của mình, một record mỗi session, API trả lý do rõ khi session chưa mở hoặc đã cutoff. |
| P2-03 | Web | My meals: xem menu, chọn món, xác nhận, thay đổi/hủy và cảnh báo không đăng ký. | F0-02, P2-02 | Office employee hoàn thành full flow trên mobile-width và desktop; consequence sau cutoff hiển thị bằng text rõ ràng. |
| P2-04 | API | Bulk registration theo representative/admin, validate scope, atomic commit, status unselected. | P2-01 | Representative chỉ thao tác employee trong scope; một row không hợp lệ không ghi batch; response có số unselected. |
| P2-05 | Web | Bulk entry grid, apply dish hàng loạt, totals theo dish, confirm số chưa chọn. | F0-02, P2-04 | Representative thao tác được một team, thấy totals theo dish, và phải confirm trước khi submit còn employee chưa chọn. |
| P2-06 | API | Paper-form batch: reference, entry validation, preview và apply. | P2-04 | Batch giấy lưu nguồn và trạng thái; apply không nhân đôi registrations. |
| P2-07 | Web | Paper-form flow trong bulk entry. | F0-02, P2-06 | User tạo và nhập một batch giấy, xem row lỗi hoặc trạng thái hoàn tất. |
| P2-08 | API | Cancel, absence, post-cutoff adjustment với reason bắt buộc, `RegistrationChange` và audit. | P2-02 | Sau cutoff chỉ admin có permission mới điều chỉnh được; audit có before, after, reason, actor, time. |
| P2-09 | Web | Adjustment queue/history và form reason. | F0-02, P2-08 | Admin thấy thay đổi trước/sau và không thể gửi adjustment thiếu reason. |
| P2-10 | API | Reserve pool theo session dish và admin-only allocation sau cutoff, transaction chống over-allocation. | P2-01, P2-08 | Khi pool tắt, allocation không dùng được. Khi bật, request đồng thời không làm vượt quantity. |
| P2-11 | Web | Reserve pool configuration và allocation screen. | F0-02, P2-10 | Admin thấy configured, allocated, remaining theo món và thêm allocation kèm reason. |
| P2-12 | API + Web | Rà lại Phase 2 demo, seed sessions/menus/registrations hiện tại và cập nhật README. | P2-03, P2-05, P2-07, P2-09, P2-11 | Chạy local từ dữ liệu trống rồi demo được employee self registration, representative bulk entry, paper entry, post-cutoff adjustment và reserve allocation. |

## Dữ liệu mock và email

Seed dùng dữ liệu hư cấu. Email employee có thể mô phỏng quy tắc đã cung cấp: tên `Nguyễn Minh Quang` tạo email ví dụ `quang.nm03@pnj.com.vn`. Không tự suy diễn email từ tên trong import, vì quy tắc này không đảm bảo duy nhất khi có trùng tên hoặc tên nhiều phần. Template import nhận `email` là cột tùy chọn và giữ nguyên giá trị người dùng cung cấp.

Seed tối thiểu:

- Organization `PNJP`, factory `PNJP-F1`
- Departments `San xuat`, `Van hanh`, `Bao tri`
- Teams `Cat`, `Lap rap`, `QC`
- Một Organization Admin, Factory Admin, Team Representative, Office Employee, và Production Worker không có account
- Năm món hư cấu có món chay và cháo
- Một weekly menu của tuần hiện tại, lunch sessions, một vài registrations và một session đã cutoff để demo adjustment/reserve pool

Seed passwords lấy từ environment, ví dụ `SEED_PASSWORD`. README chỉ hướng dẫn đặt biến local, không commit secret.

## Default không chặn triển khai

| Chủ đề | Default |
|---|---|
| Meal type | `LUNCH` và `DINNER`; không thêm breakfast nếu chưa có requirement |
| Cutoff demo | 09:00 ngày trước ngày ăn, chỉnh được theo từng session |
| Reserve policy | Tắt mặc định; admin bật fixed quantity theo dish trước cutoff |
| Phiếu giấy | Lưu mã tham chiếu hoặc ghi chú, không upload scan hoặc OCR |
| File Excel | `.xlsx`, sheet đầu, cột `employeeCode`, `fullName`, `email`, `factoryCode`, `departmentCode`, `teamCode`, `hasPersonalDevice` |
| SSO tương lai | OIDC adapter đầu tiên, không làm callback trong scope hiện tại |
| Account lifecycle | Chỉ seed/local login, không reset password hoặc supplier account |
| Hosting | Không đưa vào Phase 0-2 vì chưa có quyết định deployment |

## Kiểm chứng Phase trước khi mở Phase sau

- Phase 0: local admin đăng nhập; authorization chặn đọc chéo factory/team; import hợp lệ chạy được và file lỗi không ghi dở dang; audit hiển thị thay đổi.
- Phase 1: admin biên soạn, publish menu và session; time window hiển thị và API đều dùng `Asia/Ho_Chi_Minh`.
- Phase 2: employee tự đăng ký trước cutoff; representative nhập bulk và paper form trong scope; admin thực hiện adjustment sau cutoff với reason; reserve pool không vượt limit.

## Quyết định tổng hợp

Candidate B là nền cho kế hoạch này vì giới hạn scope Phase 0-2 rõ, tách API contract giữa hai repository, và tránh đưa lịch sử điều chuyển hoặc refresh-token complexity vào dữ liệu trước khi có user flow. Tôi lấy từ Candidate A các chi tiết cần thiết: refresh token rotation, `MealSessionAccess` để gom cutoff logic, reserve allocation độc lập với ordinary registration, và đặc tả màn hình bulk entry. Tôi không chọn các phần làm phạm vi phình ra, như DishOption tổng quát, breakfast mặc định, background close job bắt buộc, hay bộ Playwright riêng ở từng task.
