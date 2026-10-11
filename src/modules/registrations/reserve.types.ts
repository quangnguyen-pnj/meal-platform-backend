import { ReserveAllocationStatus } from '../../generated/prisma/enums';

/**
 * The reserve pool state for one session dish (P2-10), the shape both the pool
 * read and a configuration write return. `quantity` is the fixed configured
 * pool size (source of truth: `ReservePoolSetting`, not the legacy
 * `MealSessionDish.reservePoolSize`), `allocated` is the sum of ALLOCATED
 * allocation quantities, and `remaining` is `quantity - allocated` (never
 * negative). When the pool has no setting row it reports `isEnabled: false`,
 * `quantity: 0`, so the UI (P2-11) can render configured/allocated/remaining
 * per dish without reaching into the API response.
 */
export interface ReservePoolView {
  mealSessionId: string;
  mealSessionDishId: string;
  isEnabled: boolean;
  quantity: number;
  allocated: number;
  remaining: number;
}

/**
 * One reserve allocation (P2-10). A reserve allocation is a record SEPARATE
 * from an ordinary `MealRegistration`: it never turns an unregistered employee
 * into a registered diner. `employeeId` is the recipient when known, null for
 * an unassigned reserve. Instants are ISO-8601 strings.
 */
export interface ReserveAllocationView {
  id: string;
  mealSessionId: string;
  mealSessionDishId: string;
  employeeId: string | null;
  quantity: number;
  status: ReserveAllocationStatus;
  reason: string | null;
  allocatedByUserId: string;
  allocatedAt: string;
}
