import { MealSessionStatus, MealType } from '../../generated/prisma/enums';

/**
 * One offered dish in a session summary, resolved to its catalog `code`/`name`
 * so a report never shows a bare `dishId`.
 *
 * The registration counters come from the Phase 2 tables, scoped to this
 * session dish: `registeredCount` and `absentCount` are the number of
 * `MealRegistration` rows with status REGISTERED and ABSENT; `reserveCount` is
 * the ALLOCATED reserve quantity. A dish with no registrations reports `0`.
 */
export interface SessionSummaryDishView {
  dishId: string;
  code: string;
  name: string;
  sortOrder: number;
  registeredCount: number;
  absentCount: number;
  reserveCount: number;
}

/**
 * Read-only summary of one meal session (P1-06). It reports the session's
 * identity and lifecycle plus the dishes it offers, resolved to catalog
 * code/name and ordered by `sortOrder`.
 *
 * `serviceDate` is emitted as `YYYY-MM-DD` in HCM time. `offeredDishCount` is
 * the number of dishes the session offers. `totalRegistered` is the sum of the
 * per-dish `registeredCount` across the session (REGISTERED registrations
 * only, not ABSENT or reserve).
 *
 * This view is produced by a read-only path: no mutation, no audit row. It is
 * always scope-filtered to the session's factory, so a factory- or team-scoped
 * principal can only summarize sessions inside its own scope.
 */
export interface SessionSummaryView {
  mealSessionId: string;
  factoryId: string;
  serviceDate: string;
  mealType: MealType;
  status: MealSessionStatus;
  offeredDishCount: number;
  totalRegistered: number;
  dishes: SessionSummaryDishView[];
}
