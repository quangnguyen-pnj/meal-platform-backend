import { Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { RequestPrincipal } from '../../common/auth/request-principal';
import {
  PrincipalAuthorizationService,
  SelfEmployee,
} from '../../common/authorization/principal-authorization.service';
import { PrismaService } from '../../common/database/prisma.service';
import { AppError } from '../../common/errors/app-error';
import { Clock } from '../../common/time/clock';
import { MealRegistration, Prisma } from '../../generated/prisma/client';
import {
  RegistrationChangeKind,
  RegistrationSource,
  RegistrationStatus,
} from '../../generated/prisma/enums';
import { MealSessionAccess } from '../meal-sessions/meal-session-access.service';
import { MealRegistrationView } from './registrations.types';

/**
 * Owns the Phase 2 self-registration rules (P2-02): an employee creating,
 * changing, or cancelling THEIR OWN registration for a meal session before
 * cutoff.
 *
 * Three invariants shape every command:
 *  - Self only. The acting employee is the principal's own linked employee,
 *    resolved from the account. An account with no linked employee cannot
 *    self-register, and there is no way to name another employee: the employee
 *    id is never taken from the request.
 *  - One record per session. The unique `[mealSessionId, employeeId]` row is
 *    reused for every change; choosing a different dish updates that one row,
 *    and re-choosing the current dish is a no-op that returns the current
 *    state (retry-safe), never a duplicate.
 *  - Cutoff is not decided here. Every command asks `MealSessionAccess` whether
 *    the window is open for `clock.now()`; a closed window is rejected with the
 *    window's own reason so the API explains why. Not registering yields
 *    nothing: there is no default or automatic meal.
 *
 * Each write records both a `RegistrationChange` (per-registration history) and
 * an `AuditLog` row in the same transaction as the registration write.
 */
@Injectable()
export class RegistrationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly principalAuthorization: PrincipalAuthorizationService,
    private readonly mealSessionAccess: MealSessionAccess,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /**
   * The current employee's registration for a session, or null if they have
   * not registered. A cancelled registration is still returned so the caller
   * can show that the employee opted out.
   */
  async getSelfRegistration(
    principal: RequestPrincipal,
    mealSessionId: string,
  ): Promise<MealRegistrationView | null> {
    const employee = await this.resolveSelfEmployee(principal);
    await this.loadSessionForEmployee(principal, mealSessionId, employee);
    const registration = await this.prisma.mealRegistration.findUnique({
      where: {
        mealSessionId_employeeId: { mealSessionId, employeeId: employee.id },
      },
    });
    return registration ? toView(registration) : null;
  }

  /**
   * Create or change the current employee's pick for a session (an upsert over
   * the single `[mealSessionId, employeeId]` row). Rejects a closed window and
   * a dish that is not offered by the session. Re-choosing the dish already on
   * a REGISTERED row is a no-op.
   */
  async upsertSelfRegistration(
    principal: RequestPrincipal,
    mealSessionId: string,
    mealSessionDishId: string,
  ): Promise<MealRegistrationView> {
    const employee = await this.resolveSelfEmployee(principal);
    await this.loadSessionForEmployee(principal, mealSessionId, employee);
    await this.assertWindowOpen(principal, mealSessionId);
    await this.assertDishInSession(mealSessionId, mealSessionDishId);

    const existing = await this.prisma.mealRegistration.findUnique({
      where: {
        mealSessionId_employeeId: { mealSessionId, employeeId: employee.id },
      },
    });

    if (
      existing &&
      existing.status === RegistrationStatus.REGISTERED &&
      existing.mealSessionDishId === mealSessionDishId
    ) {
      return toView(existing);
    }

    const actorId = principal.userAccountId;
    const saved = await this.prisma.$transaction(async (tx) => {
      let registration: MealRegistration;
      let kind: RegistrationChangeKind;
      let before: Prisma.InputJsonValue | undefined;

      if (!existing) {
        registration = await tx.mealRegistration.create({
          data: {
            organizationId: principal.organizationId,
            mealSessionId,
            employeeId: employee.id,
            mealSessionDishId,
            status: RegistrationStatus.REGISTERED,
            source: RegistrationSource.SELF,
            createdByUserId: actorId,
            registeredAt: this.clock.now(),
          },
        });
        kind = RegistrationChangeKind.CREATED;
        before = undefined;
      } else {
        before = snapshot(existing);
        registration = await tx.mealRegistration.update({
          where: { id: existing.id },
          data: {
            mealSessionDishId,
            status: RegistrationStatus.REGISTERED,
            source: RegistrationSource.SELF,
            updatedByUserId: actorId,
            cancelledAt: null,
            // A re-registration after a cancel re-opens the row; stamp the new
            // registration instant so the record reflects when it took effect.
            registeredAt: this.clock.now(),
          },
        });
        kind =
          existing.status === RegistrationStatus.REGISTERED
            ? RegistrationChangeKind.DISH_CHANGED
            : RegistrationChangeKind.CREATED;
      }

      await tx.registrationChange.create({
        data: {
          mealRegistrationId: registration.id,
          kind,
          before,
          after: snapshot(registration),
          actorUserId: actorId,
        },
      });

      await this.audit.record(tx, {
        organizationId: principal.organizationId,
        actorId,
        action:
          kind === RegistrationChangeKind.CREATED
            ? 'registration.self.create'
            : 'registration.self.change',
        entityType: 'MealRegistration',
        entityId: registration.id,
        details: {
          mealSessionId,
          employeeId: employee.id,
          mealSessionDishId,
        },
      });

      return registration;
    });

    return toView(saved);
  }

  /**
   * Cancel the current employee's registration for a session before cutoff.
   * Sets status CANCELLED and `cancelledAt`, keeping the one row. Cancelling an
   * already-cancelled registration is a no-op that returns the current state.
   */
  async cancelSelfRegistration(
    principal: RequestPrincipal,
    mealSessionId: string,
  ): Promise<MealRegistrationView> {
    const employee = await this.resolveSelfEmployee(principal);
    await this.loadSessionForEmployee(principal, mealSessionId, employee);
    await this.assertWindowOpen(principal, mealSessionId);

    const existing = await this.prisma.mealRegistration.findUnique({
      where: {
        mealSessionId_employeeId: { mealSessionId, employeeId: employee.id },
      },
    });
    if (!existing) {
      throw new AppError('NOT_FOUND', 'You have no registration to cancel.', {
        mealSessionId,
      });
    }
    if (existing.status === RegistrationStatus.CANCELLED) {
      return toView(existing);
    }

    const actorId = principal.userAccountId;
    const saved = await this.prisma.$transaction(async (tx) => {
      const before = snapshot(existing);
      const registration = await tx.mealRegistration.update({
        where: { id: existing.id },
        data: {
          status: RegistrationStatus.CANCELLED,
          updatedByUserId: actorId,
          cancelledAt: this.clock.now(),
        },
      });

      await tx.registrationChange.create({
        data: {
          mealRegistrationId: registration.id,
          kind: RegistrationChangeKind.CANCELLED,
          before,
          after: snapshot(registration),
          actorUserId: actorId,
        },
      });

      await this.audit.record(tx, {
        organizationId: principal.organizationId,
        actorId,
        action: 'registration.self.cancel',
        entityType: 'MealRegistration',
        entityId: registration.id,
        details: { mealSessionId, employeeId: employee.id },
      });

      return registration;
    });

    return toView(saved);
  }

  /**
   * Resolve the principal's own employee. Requires the `registration:self`
   * permission and a linked employee; an account without one cannot act.
   */
  private resolveSelfEmployee(
    principal: RequestPrincipal,
  ): Promise<SelfEmployee> {
    return this.principalAuthorization.resolveSelfEmployee(principal);
  }

  /**
   * Load the session, tenant-scoped, and assert the employee belongs to its
   * factory. An employee self-registers only for their own factory's session.
   */
  private async loadSessionForEmployee(
    principal: RequestPrincipal,
    mealSessionId: string,
    employee: SelfEmployee,
  ): Promise<void> {
    const session = await this.prisma.mealSession.findFirst({
      where: { id: mealSessionId, organizationId: principal.organizationId },
      select: { id: true, factoryId: true },
    });
    if (!session) {
      throw new AppError('NOT_FOUND', 'Meal session not found.', {
        mealSessionId,
      });
    }
    if (session.factoryId !== employee.factoryId) {
      throw new AppError(
        'FORBIDDEN',
        'You can only register for your own factory meal session.',
        { mealSessionId },
      );
    }
  }

  /**
   * Ask the single cutoff authority whether the window is open now. A closed
   * window is rejected with the window's own reason so the API explains why.
   */
  private async assertWindowOpen(
    principal: RequestPrincipal,
    mealSessionId: string,
  ): Promise<void> {
    const window = await this.mealSessionAccess.getRegistrationWindow({
      mealSessionId,
      organizationId: principal.organizationId,
      now: this.clock.now(),
    });
    if (!window.isOpen) {
      throw new AppError('CONFLICT', window.reason, {
        mealSessionId,
        state: window.state,
      });
    }
  }

  /**
   * The chosen dish must be one of the session's offered dishes.
   */
  private async assertDishInSession(
    mealSessionId: string,
    mealSessionDishId: string,
  ): Promise<void> {
    const dish = await this.prisma.mealSessionDish.findFirst({
      where: { id: mealSessionDishId, mealSessionId },
      select: { id: true },
    });
    if (!dish) {
      throw new AppError(
        'VALIDATION_ERROR',
        'The chosen dish is not offered by this meal session.',
        { mealSessionId, mealSessionDishId },
      );
    }
  }
}

/**
 * A `RegistrationChange.before`/`after` JSON snapshot of a registration. It
 * carries the same fields as the view, shaped as a plain JSON object the Json
 * column accepts.
 */
function snapshot(registration: MealRegistration): Prisma.InputJsonValue {
  return {
    mealSessionDishId: registration.mealSessionDishId,
    status: registration.status,
    source: registration.source,
  };
}

function toView(registration: MealRegistration): MealRegistrationView {
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
