import { Injectable } from '@nestjs/common';
import { RequestPrincipal } from '../../common/auth/request-principal';
import {
  PrincipalAuthorizationService,
  SelfEmployee,
} from '../../common/authorization/principal-authorization.service';
import { PrismaService } from '../../common/database/prisma.service';
import { AppError } from '../../common/errors/app-error';
import { Clock } from '../../common/time/clock';
import { formatHcmDate, hcmToday } from '../../common/time/hcm-week';
import {
  Dish,
  MealRegistration,
  MealSession,
  MealSessionDish,
} from '../../generated/prisma/client';
import { MealSessionStatus } from '../../generated/prisma/enums';
import { evaluateRegistrationWindow } from '../meal-sessions/meal-session-access.service';
import {
  MealRegistrationView,
  MyMealDishView,
  MyMealSessionView,
} from './registrations.types';

type SessionWithDishesAndCatalog = MealSession & {
  dishes: (MealSessionDish & { dish: Dish })[];
};

/** The two session statuses an employee can act on from the My Meals screen. */
const ELIGIBLE_STATUSES: MealSessionStatus[] = [
  MealSessionStatus.PUBLISHED,
  MealSessionStatus.OPEN,
];

/**
 * Read-only, employee-facing surface for the My Meals screen (Flow B). It
 * closes the self-service gap where an employee holding only
 * `registration:self` could not list their eligible sessions (the admin
 * `GET /meal-sessions` is behind `meal-session:manage`) nor see dish NAMES (the
 * admin `GET /dishes` is behind `menu:manage`).
 *
 * Two invariants keep the surface tight:
 *  - Self only, own factory only. The employee is resolved from the principal
 *    (never from the request), and only sessions for THAT employee's factory
 *    are returned. There is no factoryId input that could cross scope. An
 *    account with no linked employee or without `registration:self` is
 *    forbidden (enforced by `resolveSelfEmployee`).
 *  - Limited payload. Each session carries only what the screen needs to show
 *    Today/Menu, pick a dish, and see status + cutoff: date/meal/status, the
 *    registration window (from the single `MealSessionAccess` evaluator), the
 *    offered dishes WITH catalog code+name, and the employee's OWN current
 *    registration. It never returns other employees' registrations or
 *    admin-only fields, and it writes nothing (no audit, no mutation).
 */
@Injectable()
export class MyMealsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly principalAuthorization: PrincipalAuthorizationService,
    private readonly clock: Clock,
  ) {}

  /**
   * The employee's eligible sessions: PUBLISHED or OPEN sessions for their own
   * factory whose service date is today or later (HCM time), ordered by date
   * then meal. Each is enriched with dish names and the employee's current
   * pick.
   */
  async listEligibleSessions(
    principal: RequestPrincipal,
  ): Promise<MyMealSessionView[]> {
    const employee =
      await this.principalAuthorization.resolveSelfEmployee(principal);

    const sessions = await this.prisma.mealSession.findMany({
      where: {
        organizationId: principal.organizationId,
        factoryId: employee.factoryId,
        status: { in: ELIGIBLE_STATUSES },
        serviceDate: { gte: hcmToday(this.clock.now()) },
      },
      orderBy: [{ serviceDate: 'asc' }, { mealType: 'asc' }],
      include: { dishes: { include: { dish: true } } },
    });

    const registrations = await this.loadRegistrations(
      employee,
      sessions.map((session) => session.id),
    );

    return sessions.map((session) =>
      this.toView(session, registrations.get(session.id) ?? null),
    );
  }

  /**
   * A single eligible session by id, with the same enriched shape as the list.
   * Scoped to the employee's own factory: a session that exists but belongs to
   * another factory is reported as not found so the endpoint never confirms
   * out-of-scope sessions.
   */
  async getEligibleSession(
    principal: RequestPrincipal,
    mealSessionId: string,
  ): Promise<MyMealSessionView> {
    const employee =
      await this.principalAuthorization.resolveSelfEmployee(principal);

    const session = await this.prisma.mealSession.findFirst({
      where: {
        id: mealSessionId,
        organizationId: principal.organizationId,
        factoryId: employee.factoryId,
      },
      include: { dishes: { include: { dish: true } } },
    });
    if (!session) {
      throw new AppError('NOT_FOUND', 'Meal session not found.', {
        mealSessionId,
      });
    }

    const registrations = await this.loadRegistrations(employee, [session.id]);
    return this.toView(session, registrations.get(session.id) ?? null);
  }

  /**
   * The employee's own registrations for the given sessions, keyed by session
   * id. Scoped to the employee, so no other diner's registration is ever read.
   */
  private async loadRegistrations(
    employee: SelfEmployee,
    sessionIds: string[],
  ): Promise<Map<string, MealRegistration>> {
    if (sessionIds.length === 0) {
      return new Map();
    }
    const rows = await this.prisma.mealRegistration.findMany({
      where: {
        employeeId: employee.id,
        mealSessionId: { in: sessionIds },
      },
    });
    return new Map(rows.map((row) => [row.mealSessionId, row]));
  }

  private toView(
    session: SessionWithDishesAndCatalog,
    registration: MealRegistration | null,
  ): MyMealSessionView {
    const dishes: MyMealDishView[] = [...session.dishes]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((sessionDish) => ({
        mealSessionDishId: sessionDish.id,
        dishId: sessionDish.dishId,
        code: sessionDish.dish.code,
        name: sessionDish.dish.name,
        sortOrder: sessionDish.sortOrder,
        isSelected: registration?.mealSessionDishId === sessionDish.id,
      }));

    return {
      id: session.id,
      factoryId: session.factoryId,
      serviceDate: formatHcmDate(session.serviceDate),
      mealType: session.mealType,
      status: session.status,
      registrationWindow: evaluateRegistrationWindow(session, this.clock.now()),
      dishes,
      myRegistration: registration ? toRegistrationView(registration) : null,
    };
  }
}

/**
 * The My Meals view only ever carries the employee's OWN registration, so the
 * same `MealRegistrationView` shape the self-registration commands return is
 * reused here. Instants are ISO-8601 strings.
 */
function toRegistrationView(
  registration: MealRegistration,
): MealRegistrationView {
  return {
    id: registration.id,
    mealSessionId: registration.mealSessionId,
    employeeId: registration.employeeId,
    mealSessionDishId: registration.mealSessionDishId,
    status: registration.status,
    source: registration.source,
    registeredAt: registration.registeredAt.toISOString(),
    cancelledAt: registration.cancelledAt
      ? registration.cancelledAt.toISOString()
      : null,
  };
}
