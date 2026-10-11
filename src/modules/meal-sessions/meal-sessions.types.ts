import { MealSessionStatus, MealType } from '../../generated/prisma/enums';

/**
 * Why registration is or is not open for a session right now. This is the
 * single vocabulary the whole backend uses to describe a session's live state,
 * produced only by `MealSessionAccess`.
 *
 * - `OPEN`: the session is OPEN and `now` is within `[opensAt, cutoffAt)`.
 * - `BEFORE_OPEN`: the session's opening instant has not arrived yet, or it is
 *   not yet OPEN (still DRAFT/PUBLISHED).
 * - `CUTOFF_PASSED`: `now` is at or after `cutoffAt` (closed by time, with or
 *   without a status change having been applied).
 * - `CLOSED`: the session was explicitly CLOSED.
 * - `CANCELLED`: the session was CANCELLED.
 */
export type RegistrationWindowState =
  'OPEN' | 'BEFORE_OPEN' | 'CUTOFF_PASSED' | 'CLOSED' | 'CANCELLED';

/**
 * The decision `MealSessionAccess.getRegistrationWindow` returns. `isOpen` is
 * the one boolean a registration command checks; `state` and `reason` explain
 * it for display and error messages. `opensAt`/`cutoffAt` are echoed as ISO
 * instants so a caller never recomputes the window itself.
 */
export interface RegistrationWindow {
  mealSessionId: string;
  state: RegistrationWindowState;
  isOpen: boolean;
  reason: string;
  opensAt: string;
  cutoffAt: string;
}

/**
 * DTO-shaped view of one dish offered in a session, flattened for the API.
 */
export interface MealSessionDishView {
  id: string;
  mealSessionId: string;
  dishId: string;
  sortOrder: number;
}

/**
 * A meal session with its offered dishes and live registration window.
 * `serviceDate` is emitted as `YYYY-MM-DD` in HCM time; `opensAt`/`cutoffAt`/
 * `publishedAt` are ISO instants.
 */
export interface MealSessionView {
  id: string;
  organizationId: string;
  factoryId: string;
  weeklyMenuId: string | null;
  serviceDate: string;
  mealType: MealType;
  status: MealSessionStatus;
  opensAt: string;
  cutoffAt: string;
  publishedAt: string | null;
  publishedByUserId: string | null;
  dishes: MealSessionDishView[];
  registrationWindow: RegistrationWindow;
}
