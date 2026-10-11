import { Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { RequestPrincipal } from '../../common/auth/request-principal';
import { PrincipalAuthorizationService } from '../../common/authorization/principal-authorization.service';
import { ScopeAuthorizer } from '../../common/authorization/scope-authorizer.service';
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
 * An existing registration loaded for an operator action, with the employee's
 * tenant-tree ids the scope check compares against. Every adjustment acts on
 * one of these rows; a missing row is a NOT_FOUND, never a silent create.
 */
interface LoadedRegistration {
  registration: MealRegistration;
  employeeScope: {
    organizationId: string;
    factoryId: string;
    departmentId: string;
    teamId: string;
  };
}

/**
 * Whether the acting principal is operating before or after cutoff, resolved
 * once per command from the single cutoff authority. The whole pre/post branch
 * hangs off `isOpen`: before cutoff a Meal Admin may act without a reason;
 * after cutoff a Meal Admin must additionally supply a non-empty reason. These
 * routes are admin-only either way (the controller guards every one with
 * `registration:adjust`).
 */
interface Authority {
  isOpen: boolean;
  canAdjust: boolean;
}

/**
 * Owns the Phase 2 operator-side registration changes (P2-08): cancelling,
 * marking absent, and the general post-cutoff adjustment of an EXISTING
 * registration by a representative or Meal Admin. Self-service create/change/
 * cancel stays in `RegistrationsService` (P2-02); this service is the path for
 * acting on someone else's registration.
 *
 * Two invariants shape every command, and both defer to code that already
 * exists rather than re-deriving anything:
 *  - Cutoff decides authority. `MealSessionAccess` (fed the injected clock) is
 *    the single source of "is the window open". These routes are admin-only in
 *    both windows: cancel/mark-absent/adjust all require `registration:adjust`
 *    (the controller guards every route with it). Before cutoff a Meal Admin
 *    may act without a reason; after cutoff a Meal Admin may act ONLY with a
 *    non-empty reason (missing reason -> VALIDATION_ERROR). An account without
 *    `registration:adjust` is FORBIDDEN in both windows. Representatives change
 *    pre-cutoff registrations through the bulk/self flows, not these routes.
 *  - Scope is enforced. The operator must hold a scope grant covering the
 *    registration's employee (`ScopeAuthorizer.assertScope`), and the lookup
 *    is tenant-scoped to the principal's organization. An operator cannot
 *    touch a registration outside their granted subtree.
 *
 * Adjustment acts on an existing registration only: it never creates a meal
 * for an employee who never registered (that after-cutoff path is the reserve
 * pool, P2-10). Each write records a `RegistrationChange` (with before/after
 * JSON) and an `AuditLog` row - both carrying actor, time, and the reason - in
 * the SAME transaction as the registration write.
 */
@Injectable()
export class RegistrationAdjustmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly principalAuthorization: PrincipalAuthorizationService,
    private readonly scopeAuthorizer: ScopeAuthorizer,
    private readonly mealSessionAccess: MealSessionAccess,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /**
   * Cancel an existing registration. Before cutoff an authorized operator may
   * cancel with no reason; after cutoff only a Meal Admin may, and a non-empty
   * reason is required. Cancelling an already-cancelled registration is a
   * no-op that returns the current state.
   */
  async cancel(
    principal: RequestPrincipal,
    registrationId: string,
    reason?: string,
  ): Promise<MealRegistrationView> {
    const loaded = await this.loadRegistration(principal, registrationId);
    const authority = await this.authorize(principal, loaded, reason);

    if (loaded.registration.status === RegistrationStatus.CANCELLED) {
      return toView(loaded.registration);
    }

    return this.applyChange(principal, loaded, {
      kind: RegistrationChangeKind.CANCELLED,
      action: 'registration.cancel',
      reason,
      isPostCutoff: !authority.isOpen,
      data: {
        status: RegistrationStatus.CANCELLED,
        cancelledAt: this.clock.now(),
      },
    });
  }

  /**
   * Mark an existing registration as ABSENT (the diner did not show). Before
   * cutoff an authorized operator may mark absent with no reason; after cutoff
   * only a Meal Admin may, and a non-empty reason is required. Marking an
   * already-absent registration is a no-op.
   */
  async markAbsent(
    principal: RequestPrincipal,
    registrationId: string,
    reason?: string,
  ): Promise<MealRegistrationView> {
    const loaded = await this.loadRegistration(principal, registrationId);
    const authority = await this.authorize(principal, loaded, reason);

    if (loaded.registration.status === RegistrationStatus.ABSENT) {
      return toView(loaded.registration);
    }

    return this.applyChange(principal, loaded, {
      kind: RegistrationChangeKind.ABSENT,
      action: 'registration.mark-absent',
      reason,
      isPostCutoff: !authority.isOpen,
      data: {
        status: RegistrationStatus.ABSENT,
        absentAt: this.clock.now(),
      },
    });
  }

  /**
   * Post-cutoff adjustment of an existing registration by a Meal Admin: change
   * the chosen dish and/or the status. This is the general correction path the
   * plan gates to admins after cutoff; a reason is required whenever the window
   * is closed. The adjustment acts on the existing row only - it never creates
   * a registration for an employee who had none.
   */
  async adjust(
    principal: RequestPrincipal,
    registrationId: string,
    input: { mealSessionDishId?: string; status?: string; reason?: string },
  ): Promise<MealRegistrationView> {
    const loaded = await this.loadRegistration(principal, registrationId);
    const authority = await this.authorize(principal, loaded, input.reason);

    const data: Prisma.MealRegistrationUncheckedUpdateInput = {};

    if (input.mealSessionDishId !== undefined) {
      await this.assertDishInSession(
        loaded.registration.mealSessionId,
        input.mealSessionDishId,
      );
      data.mealSessionDishId = input.mealSessionDishId;
    }

    if (input.status !== undefined) {
      const status = parseStatus(input.status);
      data.status = status;
      // Keep the status timestamps consistent with the new state so the row
      // is a faithful record of when it took effect.
      if (status === RegistrationStatus.CANCELLED) {
        data.cancelledAt = this.clock.now();
      } else if (status === RegistrationStatus.ABSENT) {
        data.absentAt = this.clock.now();
      } else {
        data.cancelledAt = null;
      }
    }

    if (data.mealSessionDishId === undefined && data.status === undefined) {
      throw new AppError(
        'VALIDATION_ERROR',
        'An adjustment must change the dish, the status, or both.',
      );
    }

    return this.applyChange(principal, loaded, {
      kind: RegistrationChangeKind.POST_CUTOFF_ADJUSTMENT,
      action: 'registration.adjust',
      reason: input.reason,
      isPostCutoff: !authority.isOpen,
      data,
    });
  }

  /**
   * Load the registration (tenant-scoped) and the employee scope the operator
   * action is checked against. A missing registration is NOT_FOUND - there is
   * no auto-create path here.
   */
  private async loadRegistration(
    principal: RequestPrincipal,
    registrationId: string,
  ): Promise<LoadedRegistration> {
    const registration = await this.prisma.mealRegistration.findFirst({
      where: { id: registrationId, organizationId: principal.organizationId },
      include: {
        employee: {
          select: {
            organizationId: true,
            factoryId: true,
            departmentId: true,
            teamId: true,
          },
        },
      },
    });
    if (!registration) {
      throw new AppError('NOT_FOUND', 'Registration not found.', {
        registrationId,
      });
    }
    const { employee, ...rest } = registration;
    return {
      registration: rest as MealRegistration,
      employeeScope: {
        organizationId: employee.organizationId,
        factoryId: employee.factoryId,
        departmentId: employee.departmentId,
        teamId: employee.teamId,
      },
    };
  }

  /**
   * Decide whether this principal may change this registration now, and in
   * which mode. Scope over the employee is required in all cases. These routes
   * are admin-only (`registration:adjust`) in both windows; the cutoff
   * authority only decides whether a reason is required: an open window allows
   * a Meal Admin to act without one, a closed window requires a non-empty
   * reason.
   */
  private async authorize(
    principal: RequestPrincipal,
    loaded: LoadedRegistration,
    reason?: string,
  ): Promise<Authority> {
    await this.scopeAuthorizer.assertScope({
      principal,
      scope: loaded.employeeScope,
    });

    const { permissions } =
      await this.principalAuthorization.resolve(principal);
    const canAdjust = permissions.includes('registration:adjust');

    const window = await this.mealSessionAccess.getRegistrationWindow({
      mealSessionId: loaded.registration.mealSessionId,
      organizationId: principal.organizationId,
      now: this.clock.now(),
    });

    if (window.isOpen) {
      if (!canAdjust) {
        throw new AppError(
          'FORBIDDEN',
          'Missing required permission: registration:adjust.',
          { requiredPermission: 'registration:adjust' },
        );
      }
      return { isOpen: true, canAdjust };
    }

    // After cutoff only a Meal Admin may change anything, and only with a
    // reason. Order matters: a non-admin is FORBIDDEN regardless of reason.
    if (!canAdjust) {
      throw new AppError(
        'FORBIDDEN',
        'After cutoff only a Meal Admin can adjust a registration.',
        { requiredPermission: 'registration:adjust' },
      );
    }
    if (!reason || reason.trim().length === 0) {
      throw new AppError(
        'VALIDATION_ERROR',
        'A post-cutoff adjustment requires a non-empty reason.',
      );
    }
    return { isOpen: false, canAdjust };
  }

  /**
   * Apply one registration change in a single transaction: update the row, and
   * write both a `RegistrationChange` (before/after JSON, kind, reason, actor,
   * time) and an `AuditLog` row (before/after, reason, actor, time). A
   * post-cutoff change stamps the required reason onto the row's
   * `adjustmentReason` and marks the source as ADMIN_ADJUSTMENT.
   */
  private async applyChange(
    principal: RequestPrincipal,
    loaded: LoadedRegistration,
    change: {
      kind: RegistrationChangeKind;
      action: string;
      reason?: string;
      isPostCutoff: boolean;
      data: Prisma.MealRegistrationUncheckedUpdateInput;
    },
  ): Promise<MealRegistrationView> {
    const actorId = principal.userAccountId;
    const before = snapshot(loaded.registration);
    const reason = change.reason?.trim() ? change.reason.trim() : null;

    const saved = await this.prisma.$transaction(async (tx) => {
      const registration = await tx.mealRegistration.update({
        where: { id: loaded.registration.id },
        data: {
          ...change.data,
          updatedByUserId: actorId,
          ...(change.isPostCutoff
            ? {
                source: RegistrationSource.ADMIN_ADJUSTMENT,
                adjustmentReason: reason,
              }
            : {}),
        },
      });

      const after = snapshot(registration);

      await tx.registrationChange.create({
        data: {
          mealRegistrationId: registration.id,
          kind: change.kind,
          before,
          after,
          reason,
          actorUserId: actorId,
        },
      });

      await this.audit.record(tx, {
        organizationId: principal.organizationId,
        actorId,
        action: change.action,
        entityType: 'MealRegistration',
        entityId: registration.id,
        details: {
          mealSessionId: registration.mealSessionId,
          employeeId: registration.employeeId,
          before,
          after,
          reason,
          postCutoff: change.isPostCutoff,
        },
      });

      return registration;
    });

    return toView(saved);
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
 * Parse a client-supplied status into the enum, rejecting anything else as a
 * validation error at the boundary.
 */
function parseStatus(value: string): RegistrationStatus {
  if (
    value === RegistrationStatus.REGISTERED ||
    value === RegistrationStatus.CANCELLED ||
    value === RegistrationStatus.ABSENT
  ) {
    return value;
  }
  throw new AppError('VALIDATION_ERROR', 'Unknown registration status.', {
    status: value,
  });
}

/**
 * A `RegistrationChange.before`/`after` JSON snapshot of a registration, the
 * same shape the self and bulk writers use so the change history is uniform.
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
