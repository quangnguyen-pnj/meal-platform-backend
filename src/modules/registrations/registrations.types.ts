import {
  MealSessionStatus,
  MealType,
  RegistrationBatchStatus,
  RegistrationBatchEntryStatus,
  RegistrationSource,
  RegistrationStatus,
} from '../../generated/prisma/enums';
import { RegistrationWindow } from '../meal-sessions/meal-sessions.types';

/**
 * DTO-shaped view of one employee's registration for a meal session (P2-02).
 * This is the shape every self-registration command returns, so the My Meals
 * screen (P2-03) can render the current pick without reaching into the API
 * response. Instants are ISO-8601 strings.
 */
export interface MealRegistrationView {
  id: string;
  mealSessionId: string;
  employeeId: string;
  mealSessionDishId: string;
  status: RegistrationStatus;
  source: RegistrationSource;
  registeredAt: string;
  cancelledAt: string | null;
}

/**
 * One dish offered in a meal session, enriched with the catalog dish's `code`
 * and `name` so the My Meals screen can show real dish names instead of a
 * positional label ("Mon 1/2/3"). This is the employee-facing counterpart of
 * the admin `MealSessionDishView`, which carries only `dishId`. `isSelected`
 * marks the employee's current pick for this session.
 */
export interface MyMealDishView {
  mealSessionDishId: string;
  dishId: string;
  code: string;
  name: string;
  sortOrder: number;
  isSelected: boolean;
}

/**
 * One eligible meal session as the authenticated employee sees it on the My
 * Meals screen (the self-service read closing the Flow B gap). It carries only
 * what the employee needs to open Today/Menu, pick a dish, and see their
 * status and cutoff: the session's date/meal/status, the registration window
 * (from `MealSessionAccess`), the offered dishes with names, and the
 * employee's OWN current registration if any. It deliberately omits admin-only
 * fields and never exposes other employees' registrations.
 *
 * `serviceDate` is `YYYY-MM-DD` in HCM time; window instants are ISO-8601.
 */
export interface MyMealSessionView {
  id: string;
  factoryId: string;
  serviceDate: string;
  mealType: MealType;
  status: MealSessionStatus;
  registrationWindow: RegistrationWindow;
  dishes: MyMealDishView[];
  myRegistration: MealRegistrationView | null;
}

/**
 * One row a representative stages into a bulk batch (P2-04): an employee and
 * either the dish they chose (`mealSessionDishId`) or an explicit opt-out
 * (`notEating: true`). The plan distinguishes "not registered" (no entry at
 * all) from "confirmed not eating" (an entry marked `notEating`), so an entry
 * must carry exactly one of the two: a dish OR the not-eating flag.
 */
export interface BulkEntryInput {
  employeeId: string;
  mealSessionDishId?: string | null;
  notEating?: boolean;
  /** Orders paper-form rows (P2-06); ignored for the bulk-grid flow. */
  rowNumber?: number | null;
}

/**
 * The validation verdict for a single staged entry. `VALID` and `INVALID`
 * mirror the import-row pattern; `errors` is populated only for `INVALID`
 * rows so the UI can show per-row problems (P2-05) before any commit.
 */
export interface BulkEntryResult {
  employeeId: string;
  mealSessionDishId: string | null;
  notEating: boolean;
  rowNumber: number | null;
  status: Extract<RegistrationBatchEntryStatus, 'VALID' | 'INVALID'>;
  errors: string[];
}

/**
 * How many diners will eat each dish in the batch, for the totals-by-dish the
 * bulk entry grid shows (P2-05). Counts only VALID, eating entries.
 */
export interface DishTotal {
  mealSessionDishId: string;
  count: number;
}

/**
 * The result of validating (or committing) a bulk batch for a session.
 *
 * `unselected` is the count of in-scope employees of the session's factory who
 * have NO entry in the batch at all - neither a dish nor a not-eating opt-out.
 * The plan requires the UI to surface this and force a confirmation before
 * submit, so both the preview and the commit response carry it. `notEating` is
 * the count of entries explicitly marked as opting out, kept distinct from
 * `unselected` (no response) per the plan.
 *
 * `isValid` is true only when every entry is VALID; a commit refuses to write
 * anything unless this holds (whole-batch atomicity).
 */
export interface BulkValidationResult {
  mealSessionId: string;
  factoryId: string;
  isValid: boolean;
  entries: BulkEntryResult[];
  totalsByDish: DishTotal[];
  eatingCount: number;
  notEatingCount: number;
  /** In-scope factory employees with no entry in the batch. */
  unselected: number;
  inScopeEmployeeCount: number;
}

/**
 * The result of committing a bulk batch (P2-04). Carries the batch id and its
 * final status, the registrations written, and the same unselected/totals the
 * preview reports so the caller can confirm what was and was not registered.
 */
export interface BulkCommitResult {
  batchId: string;
  status: RegistrationBatchStatus;
  source: RegistrationSource;
  paperReference: string | null;
  registrations: MealRegistrationView[];
  totalsByDish: DishTotal[];
  eatingCount: number;
  notEatingCount: number;
  unselected: number;
  inScopeEmployeeCount: number;
}

/**
 * A read view of a registration batch (P2-06), exposing its source, status,
 * and paper reference so the paper-form UI (P2-07) can track which forms are
 * entered (COMMITTED) versus still pending, plus the per-row entries it was
 * built from.
 */
export interface RegistrationBatchView {
  id: string;
  factoryId: string;
  source: RegistrationSource;
  status: RegistrationBatchStatus;
  paperReference: string | null;
  reason: string | null;
  submittedAt: string | null;
  createdAt: string;
  entries: RegistrationBatchEntryView[];
}

/** One stored batch entry (P2-06), with its paper-row order and any errors. */
export interface RegistrationBatchEntryView {
  employeeId: string;
  mealSessionDishId: string | null;
  rowNumber: number | null;
  status: RegistrationBatchEntryStatus;
  errors: string[];
}
