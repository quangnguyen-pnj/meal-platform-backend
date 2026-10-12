# Phase 1 + Phase 2 review — meal-platform-api + meal-platform-web

Phase 1 adds the dish catalog, weekly menu (DRAFT/PUBLISHED/ARCHIVED, one per factory/week, DRAFT-only edits, ACTIVE-dish-only adds), meal sessions derived from a published menu, the `MealSessionAccess` cutoff authority, session lifecycle, and a read-only session summary. Phase 2 adds self/bulk/paper-form registration, post-cutoff adjustment, and a reserve pool, all routing their cutoff decision through `MealSessionAccess` with an injected clock. The build, lint, and 205 backend tests pass; the web typecheck/lint/build/prettier pass. The core invariants — one cutoff authority, no automatic meal, admin-only reasoned post-cutoff, reserve separated from registration, factory scope — hold with real file-level evidence, and the client never re-decides cutoff or scope. Two gaps keep this from a clean ship: the P1-06 session summary still hard-codes every registration count to `0` even though Phase 2 registrations now exist, so the admin summary is wrong against real data; and the single invariant the whole reserve design rests on — that `SELECT … FOR UPDATE` serializes concurrent allocations so the pool can't be over-allocated — is proven only by a sequential in-memory test that cannot exercise a lock, leaving a real-DB-only guarantee unverified.

Watch for: (1) **confirmed** the session summary (`reports.service.ts`) reports `registeredCount`/`absentCount`/`reserveCount`/`totalRegistered` as `0` unconditionally — the P1-06 "total existing registrations" read is a Phase-1 stub never wired to Phase 2 data; (2) **confirmed** the reserve over-allocation guarantee depends on `FOR UPDATE` serialization that no test exercises concurrently (the "sequential" test runs two awaited calls, and the in-memory `$transaction` double has no locking), so the one hard invariant of P2-10 is asserted in prose but unproven; (3) **confirmed** the adjustments controller guards every route with `registration:adjust`, so the service's documented "before cutoff a `registration:bulk` representative may also cancel/mark-absent" branch is dead code unreachable over HTTP — stricter than documented, but a real code/intent mismatch; (4) **likely** `createSessionsFromMenu` creates each derived session in its own transaction inside a loop, so a mid-loop failure leaves some sessions committed and others not (idempotent on re-run, but not atomic).

**Verdict**: NEEDS_CHANGES

## High-level view

Cutoff is genuinely centralized. `evaluateRegistrationWindow` is the one function that turns `status` + `opensAt`/`cutoffAt` + an injected `now` into OPEN/BEFORE_OPEN/CUTOFF_PASSED/CLOSED/CANCELLED, and every writer (self, bulk, paper, adjustment, reserve) calls it rather than comparing timestamps itself. Past `cutoffAt` reports closed regardless of stored status, so correctness survives the absence of a close worker. This invariant holds cleanly.

No code path auto-creates a meal. Self-registration only ever touches the principal's own `[mealSessionId, employeeId]` row; adjustment loads an existing registration and 404s if absent; reserve allocation writes a `ReserveAllocation` and never a `MealRegistration`. The reserve/registration boundary is real and type-enforced by the double having no `mealRegistration.create`.

Post-cutoff is admin-only and reasoned: the guard requires `registration:adjust`, and after cutoff the service additionally refuses any actor without that permission and any empty reason, writing a `RegistrationChange` + `AuditLog` in one transaction. The reserve pool is admin-only, scope-bounded, pool-off-rejected, and bounded by a check-and-insert under a row lock — but the lock's serializing effect is the one claim the tests cannot reach.

Scope and tenant isolation hold on the new surfaces: menus/sessions/reports/reserve all assert `assertScope` over the session's factory; bulk registers only employees returned by the actor's `scopeFilter` AND in the session's factory, and a one-invalid-row batch writes nothing and persists a REJECTED batch; `/my-meals` resolves the employee from the principal and never takes a factory input. Menu/session integrity holds: one menu per factory/week, DRAFT-only edits, ACTIVE-only adds, a disabled dish stays referenced, one session per factory/date/meal, and re-derivation skips existing slots.

The two soft spots are both about Phase 1 code that Phase 2 outgrew: the session summary never got its registration counts wired up, and the derivation loop's per-slot transactions were fine when sessions were the only new table but now bundle several audited writes without a surrounding transaction. Neither is a security hole; both are correctness/finish gaps.

<details>
<summary>Issues (6)</summary>

1. **Session summary counts are a stub (should-fix)** — `reports.service.ts` hard-codes `registeredCount`/`absentCount`/`reserveCount` to `0` and sums `totalRegistered` from them, so the P1-06 admin summary shows zero registrations even when `MealRegistration` rows exist. Aggregate real counts (REGISTERED/ABSENT per dish, ALLOCATED reserve per dish) from the Phase 2 tables.
2. **Reserve FOR UPDATE serialization unproven (should-fix)** — the over-allocation guarantee rests on `SELECT … FOR UPDATE` serializing concurrent allocations, but the "two sequential allocations" test awaits them one at a time and the in-memory `$transaction`/`$queryRaw` double has no lock, so the concurrent case is never exercised. Add a real-Postgres integration test (two overlapping transactions) or explicitly document the gap as the Phase 0 review did for unique indexes/CHECK.
3. **Dead pre-cutoff representative branch in adjustments (should-fix)** — the controller guards cancel/mark-absent/adjust with `registration:adjust`, so the service's `canOperate = canAdjust || registration:bulk` path can never run over HTTP; a `registration:bulk`-only representative is rejected at the guard. Either drop the unreachable branch and its comment, or (if representatives should cancel pre-cutoff) relax the guard and let the service enforce the finer rule.
4. **Non-atomic session derivation (should-fix)** — `createSessionsFromMenu` wraps each slot in its own `recordWithTransaction` inside a loop; a failure on slot N leaves slots `1..N-1` committed. Re-running is safe (existing slots are skipped), but a single derive call is not atomic. Wrap the whole derivation in one transaction.
5. **Reserve configure TOCTOU on shrink (nit)** — `configurePool` reads `allocatedTotal` outside the upsert transaction, so the "quantity cannot drop below allocated" check is a read-then-write race. Harmless in practice because configure requires an OPEN window and allocation only happens after cutoff, so the two never overlap; tighten only if that ordering ever loosens.
6. **Legacy `reservePoolSize` column retained (nit)** — `MealSessionDish.reservePoolSize` is superseded by `ReservePoolSetting` and left null/unused; schema comments mark it as not the source of truth and no service reads it. No double-source-of-truth bug today, but the dead column invites future confusion; drop it in a later migration.

</details>

<details>
<summary>Details</summary>

### Invariant 1 — One cutoff authority (HOLDS)

`evaluateRegistrationWindow` (`meal-session-access.service.ts`) is the sole implementation: given `status`, `opensAt`, `cutoffAt`, and `now`, it returns CANCELLED first, then CUTOFF_PASSED when `now >= cutoffAt` *before* consulting status, then CLOSED, then BEFORE_OPEN, else OPEN. Because the `now >= cutoffAt` check precedes the status checks, a session still stored as OPEN past its cutoff reports CUTOFF_PASSED — correctness does not depend on a close worker, which is exactly the architecture-synthesis "no mandatory close worker" decision.

Every writer defers to it with the injected `clock.now()`: `RegistrationsService.assertWindowOpen`, `BulkRegistrationsService.assertWindowOpen`, `RegistrationAdjustmentsService.authorize`, `ReserveService.configurePool`/`allocate`, and the read surfaces (`MealSessionsService` views, `MyMealsService`, session summary indirectly via the session) all call `getRegistrationWindow`/`evaluateRegistrationWindow`. No service re-derives cutoff by comparing timestamps itself. The one `getTime()` comparisons outside the evaluator are the opens/cutoff ordering validation in `MealSessionsService.updateTiming`/`createSessionsFromMenu` (input validation, not a window decision) — acceptable.

The in-memory `meal-session-access.service.spec.ts` exercises each branch with a fixed clock, including OPEN-status-past-cutoff → CUTOFF_PASSED, so the worker-independence is proven at the unit level and does not need a real DB.

### Invariant 2 — No automatic meal (HOLDS)

Three distinct writers, none of which can conjure a registration:

- Self (`registrations.service.ts`): the employee id comes from `resolveSelfEmployee(principal)`, never the request; the single `[mealSessionId, employeeId]` row is upserted; re-choosing the current dish on a REGISTERED row returns early (no write). Not registering leaves no row.
- Adjustment (`registration-adjustments.service.ts`): `loadRegistration` 404s when the row is absent, and every branch (`cancel`/`markAbsent`/`adjust`) acts on that loaded row via `update`. There is no `create` anywhere in the service, so an unregistered employee can never become a meal through adjustment.
- Reserve (`reserve.service.ts`): `allocate` writes only `tx.reserveAllocation.create`; the reserve spec's "does not create a MealRegistration" test leans on the double having no `mealRegistration.create` (any attempt would throw). An allocated-to employee stays unregistered.

The schema reinforces this: `ReserveAllocation` is its own table with a nullable `employeeId`, unrelated to `MealRegistration`.

### Invariant 3 — Post-cutoff is admin-only + reasoned (HOLDS, with a dead branch)

`RegistrationAdjustmentsController` guards all three routes with `@RequirePermission('registration:adjust')`, so a non-admin cannot reach them. `authorize` then re-resolves permissions from the DB (`principalAuthorization.resolve`), and for a closed window: rejects anyone without `registration:adjust` as FORBIDDEN (order matters — the FORBIDDEN check precedes the reason check, so a non-admin with a reason is still FORBIDDEN), then rejects an empty/whitespace reason as VALIDATION_ERROR. `applyChange` writes the `MealRegistration` update, a `RegistrationChange` (before/after JSON, kind, reason, actor), and an `AuditLog` (before/after, reason, actor, `postCutoff` flag) in one `$transaction`, stamping `source = ADMIN_ADJUSTMENT` and `adjustmentReason` on the row. This is the full P2-08 requirement.

The dead branch: the service comments and `canOperate = canAdjust || permissions.includes('registration:bulk')` imply a `registration:bulk` representative may cancel/mark-absent *before* cutoff through this service. The controller's blanket `registration:adjust` guard makes that unreachable — a bulk-only representative is rejected at the guard. The behavior is safe (stricter than documented) but the code claims a capability the HTTP surface forecloses; a reader auditing "who can cancel pre-cutoff" is misled. Resolve by removing the branch or relaxing the guard intentionally.

The adjustment specs exercise the admin-after-cutoff, non-admin-after-cutoff (FORBIDDEN), and missing-reason (VALIDATION_ERROR) cases against the double, which models the permission resolution and transaction staging — adequate for this logic.

### Invariant 4 — Reserve is separate and bounded (PARTIALLY HOLDS — serialization unproven)

The separation, admin-only, scope, and pool-off rules all hold with evidence: `allocate` requires `reserve:manage`, asserts scope over the dish's factory, requires a non-empty reason, and rejects a missing or `is_enabled = false` setting as CONFLICT ("pool off => no allocation"). The allocation is a `ReserveAllocation`, never a `MealRegistration`.

The bound itself is the concern. The check-and-insert is structured correctly for a real DB: inside one interactive `$transaction` it runs `SELECT id, is_enabled, quantity FROM reserve_pool_setting WHERE "mealSessionDishId" = $1 FOR UPDATE`, then aggregates committed ALLOCATED quantity, then inserts only if `allocated + quantity <= pool.quantity`. The table/column names match the migration (`reserve_pool_setting`, quoted `"mealSessionDishId"`), and the setting row is guaranteed to exist for an enabled pool, so `FOR UPDATE` has a row to lock. On real Postgres this does serialize concurrent allocations for the same dish.

But nothing proves it. The `reserve.service.spec.ts` "fails the second of two sequential allocations" test awaits the first `allocate` fully before calling the second, so it only proves the aggregate re-reads committed rows — not that a lock serializes *overlapping* transactions. The in-memory `$transaction` double runs the callback synchronously with no locking and no isolation, and `$queryRaw` just returns the matching row; it is structurally incapable of exercising `FOR UPDATE`. So the single hard invariant of P2-10 ("concurrent requests must not exceed quantity") is asserted in the service doc comment and the migration but verified only to the extent a sequential test can. This mirrors the Phase 0 review's documented "no DB coverage for unique index / CHECK" gap and should be handled the same way: a real-Postgres integration test with two overlapping transactions, or an explicit documented caveat.

### Invariant 5 — Scope + tenant isolation (HOLDS)

- Menus/sessions/reports/reserve: each asserts `menu:manage`/`meal-session:manage`/`report:read`/`reserve:manage` and then `assertScope` over the resource's factory (`WeeklyMenuService.assertFactoryAccess`, `MealSessionsService.assertFactoryAccess`, `ReportsService.getSessionSummary`, `ReserveService` load+assert). A factory/team-scoped principal cannot touch another factory's session.
- Bulk (`bulk-registrations.service.ts`): `loadScopedFactoryEmployees` ANDs the actor's `scopeFilter` with `{ factoryId }`, so the in-scope set is exactly the session-factory employees the actor may act on; an entry for anyone outside that set is marked INVALID ("outside your scope or not in this session factory"). Whole-batch atomicity holds: `evaluate` validates all entries, and on any invalid row `commitBatch` records a REJECTED batch and throws before the write transaction, so no registration is written. The valid path writes every registration + per-row change + one audit row in a single `$transaction`.
- Self: `loadSessionForEmployee` rejects a session whose factory differs from the employee's with FORBIDDEN; the employee is always the principal's own.
- `/my-meals` (`my-meals.service.ts`): the employee is resolved from the principal, sessions are filtered to that employee's factory, and `loadRegistrations` keys on `employeeId = employee.id`, so no other diner's registration is returned. There is no `factoryId` input to abuse. A session in another factory is reported NOT_FOUND rather than confirmed.

The real-DB-only caveat here is the same as Phase 0: the `scopeFilter` logic is proven against the double, which models row filtering faithfully but is not the database.

### Invariant 6 — Menu/session integrity (HOLDS)

`WeeklyMenuService`: one menu per factory/week via a `findUnique` on `factoryId_weekStartDate` (week normalized through `weekStartOf`) → CONFLICT on duplicate; `assertDraft` gates add/update/remove to DRAFT; `loadActiveDish` rejects an inactive dish on *add* only, so a dish disabled after being added stays referenced (confirmed by the schema's `onDelete: Restrict` on `MenuItem.dish` and the explicit comment); `serviceDate` must be `isWithinWeek`; publish requires DRAFT + ≥1 item. `MealSessionsService.createSessionsFromMenu` requires the menu be PUBLISHED, groups items into one slot per `serviceDate`+`mealType`, and skips any slot already having a session for the factory/date/meal — so re-derivation never duplicates and the unique `[factoryId, serviceDate, mealType]` is respected. The derived session carries that slot's dishes via nested `create`.

One structural caveat on derivation atomicity — see invariant 7 / issue #4: the skip-existing check makes re-running safe, but a single derive call that fails partway commits some sessions.

### Invariant 7 — Idempotency / retry (HOLDS, derivation non-atomic)

Self re-pick of the current dish is an early-return no-op; cancel of an already-cancelled row returns current state. Bulk/paper re-submit upserts on `[mealSessionId, employeeId]` (find-then-create-or-update inside the batch transaction), so re-applying the same batch corrects rather than duplicates, backed by the real unique index `meal_registration_mealSessionId_employeeId_key`. Session derivation skips existing slots.

The non-idempotent-looking edge is derivation atomicity, not duplication: because each slot is its own `recordWithTransaction`, a partial failure is possible, though a retry converges (existing slots skipped). Wrapping the loop in a single transaction would make one derive call all-or-nothing. The upsert idempotency and unique-index backing are real-DB properties the double only simulates — acceptable given the documented environment, same as Phase 0.

### Invariant 8 — Web conventions (HOLDS)

The client never re-decides cutoff or scope. `mappers/my-meals.ts` sets `canRegister = session.registrationWindow.isOpen` straight from the server window; `mappers/meal-session.ts` maps the server `registrationWindow.state` to a `{ text, icon, tone }` label via `WINDOW_LABELS` (all five states incl. CANCELLED), so status is text+icon, never color alone. `AdjustmentForm` disables submit on empty reason as a UX mirror of the backend rule, but the backend still enforces it — the client guard is not the authority. The only `isOpen` state in a hook (`useReserveAllocationForm`) is a modal flag, not a window decision. Data fetching/transform lives in `api/` → `mappers/` → `hooks/`, and pages are presentational, matching the steering `code-conventions.md`.

### Out-of-scope check

No supplier, event-sourcing, CQRS, order/delivery/reconciliation, or OCR code. The only `projection` hit is a doc comment on the safe user-account view; `aggregate`/`groupBy` are ordinary Prisma reads. The legacy `MealSessionDish.reservePoolSize` column is retained but unused and explicitly documented as superseded by `ReservePoolSetting` — not a double source of truth today, but dead weight (issue #6).

### Test-double fidelity

The doubles faithfully model row filtering, upsert-on-unique, and transaction staging, which is enough to prove the cutoff logic, scope filtering, whole-batch atomicity (REJECTED path writes nothing), adjustment permission/reason gating, and the reserve separation. What they cannot exercise — and what therefore remains real-DB-only: the `meal_registration` unique index (self/bulk one-row guarantee), `$transaction` rollback isolation (bulk atomicity, adjustment multi-write), and most importantly the reserve `FOR UPDATE` serialization (invariant 4). The Phase 0 review documented the first two as accepted gaps; the reserve serialization is new to Phase 2 and is the one that most deserves either an integration test or an explicit documented caveat, because the entire over-allocation guarantee hangs on it.

</details>

<details>
<summary>File map</summary>

- `meal-sessions/meal-session-access.service.ts` — the one cutoff evaluator; worker-independent, injected clock (invariant 1).
- `meal-sessions/meal-sessions.service.ts` — lifecycle transitions, menu-derived sessions; **per-slot transactions, non-atomic derivation** (issue #4).
- `menus/weekly-menu.service.ts` — one-per-week, DRAFT-only edits, ACTIVE-only adds, publish rules (invariant 6).
- `registrations/registrations.service.ts` — self upsert, one row per session, cutoff-gated (invariants 2, 7).
- `registrations/bulk-registrations.service.ts` — scope-bounded, whole-batch atomic, upsert, unselected count; shared bulk/paper path (invariants 5, 7).
- `registrations/registration-adjustments.service.ts` — admin-only + reasoned post-cutoff; **dead `registration:bulk` pre-cutoff branch** (invariant 3, issue #3).
- `registrations/registration-adjustments.controller.ts` — blanket `registration:adjust` guard that forecloses the service's bulk branch (issue #3).
- `registrations/reserve.service.ts` — separate allocation, pool-off reject, `FOR UPDATE` check-and-insert; **serialization unproven by tests** (invariant 4, issue #2).
- `registrations/reserve.service.spec.ts` — sequential-only over-allocation test; cannot exercise the lock.
- `registrations/my-meals.service.ts` — self-only, own-factory, limited payload read (invariant 5).
- `reports/reports.service.ts` — session summary; **registration counts hard-coded to 0** (issue #1).
- `prisma/schema.prisma`, `prisma/migrations/20250101000005_phase2_registration/migration.sql` — Phase 2 tables, `meal_registration` + `reserve_pool_setting` unique indexes; legacy `reservePoolSize` retained unused (issue #6).
- `meal-platform-web/mappers/{my-meals,meal-session}.ts` — consume server `registrationWindow`; status text+icon+tone, no client cutoff/scope decision (invariant 8).

Reviewed the working tree directly (neither repo is a git repository). Backend `npm test` → 205 passing; web typecheck/lint/build/prettier pass per the briefing.

</details>
