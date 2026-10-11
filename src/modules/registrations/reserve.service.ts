import { Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { RequestPrincipal } from '../../common/auth/request-principal';
import { ScopeAuthorizer } from '../../common/authorization/scope-authorizer.service';
import { PrismaService } from '../../common/database/prisma.service';
import { AppError } from '../../common/errors/app-error';
import { Clock } from '../../common/time/clock';
import { Prisma, ReserveAllocation } from '../../generated/prisma/client';
import { ReserveAllocationStatus } from '../../generated/prisma/enums';
import { MealSessionAccess } from '../meal-sessions/meal-session-access.service';
import { ReserveAllocationView, ReservePoolView } from './reserve.types';

/**
 * A session dish loaded for a reserve command, with the session's factory so
 * the scope check can run against the one factory the whole session lives in.
 */
interface LoadedSessionDish {
  mealSessionId: string;
  mealSessionDishId: string;
  factoryId: string;
}

/**
 * Owns the Phase 2 reserve pool (P2-10): a FIXED, per-session-dish pool an
 * admin configures before cutoff and allocates from after cutoff. A reserve
 * allocation is deliberately SEPARATE from an ordinary registration - this
 * service never creates or touches a `MealRegistration`, so an unregistered
 * employee who receives a reserve meal stays unregistered.
 *
 * Three invariants shape every command:
 *  - Admin-only, scope-bounded. Every route requires `reserve:manage` (the
 *    guard) and the service also asserts the principal's scope over the
 *    session's factory, so an admin cannot configure or allocate for a session
 *    outside their granted subtree.
 *  - Cutoff decides which operation is allowed. `MealSessionAccess` (fed the
 *    injected clock) is the single authority. CONFIGURATION happens while the
 *    window is OPEN (before cutoff); once closed the fixed pool size is locked.
 *    ALLOCATION happens after the window closes - the plan's "allocate from the
 *    pool after cutoff". A disabled or unconfigured pool can never be allocated
 *    from (CONFLICT), which is the completion criterion "pool off => no
 *    allocation".
 *  - The pool is never over-allocated. The sum of ALLOCATED quantities for a
 *    session dish must not exceed its configured `quantity`. The check and the
 *    insert happen inside ONE interactive transaction that first takes a row
 *    lock on the `ReservePoolSetting` row (`SELECT ... FOR UPDATE`), then
 *    re-reads the committed ALLOCATED total and inserts only if it still fits.
 *    Because every concurrent allocation for the same session dish contends on
 *    the same locked setting row, they are serialized: the second waits for the
 *    first to commit, re-reads the now-higher total, and is rejected if it no
 *    longer fits. Two sequential allocations summing to more than `quantity`
 *    therefore fail the second.
 */
@Injectable()
export class ReserveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scopeAuthorizer: ScopeAuthorizer,
    private readonly mealSessionAccess: MealSessionAccess,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /**
   * Read the reserve pool state for every dish of a session (P2-10): per dish
   * the configured quantity, the ALLOCATED total, and the remaining. The read
   * requires `reserve:manage` and scope over the session's factory; a dish with
   * no setting row reports a disabled, zero-quantity pool. This is the state
   * the configuration/allocation screen (P2-11) renders.
   */
  async getPool(
    principal: RequestPrincipal,
    mealSessionId: string,
  ): Promise<ReservePoolView[]> {
    await this.scopeAuthorizer.assertPermission({
      principal,
      permission: 'reserve:manage',
    });
    const session = await this.loadSession(principal, mealSessionId);
    await this.scopeAuthorizer.assertScope({
      principal,
      scope: {
        organizationId: principal.organizationId,
        factoryId: session.factoryId,
      },
    });

    const dishes = await this.prisma.mealSessionDish.findMany({
      where: { mealSessionId },
      select: {
        id: true,
        reservePoolSetting: { select: { isEnabled: true, quantity: true } },
      },
      orderBy: { sortOrder: 'asc' },
    });

    const allocatedByDish = await this.allocatedTotals(mealSessionId);

    return dishes.map((dish) => {
      const isEnabled = dish.reservePoolSetting?.isEnabled ?? false;
      const quantity = dish.reservePoolSetting?.quantity ?? 0;
      const allocated = allocatedByDish.get(dish.id) ?? 0;
      return {
        mealSessionId,
        mealSessionDishId: dish.id,
        isEnabled,
        quantity,
        allocated,
        remaining: Math.max(0, quantity - allocated),
      };
    });
  }

  /**
   * Configure one session dish's reserve pool before cutoff (P2-10): enable or
   * disable it and set the fixed quantity. Requires `reserve:manage` and scope
   * over the session's factory. The window must be OPEN - once cutoff passes
   * the pool size is locked (CONFLICT), so configuration cannot grow or shrink
   * the pool after allocation starts. A reduced quantity may not drop below the
   * already-allocated total. The change is audited.
   */
  async configurePool(
    principal: RequestPrincipal,
    mealSessionId: string,
    input: { mealSessionDishId: string; isEnabled: boolean; quantity: number },
  ): Promise<ReservePoolView> {
    await this.scopeAuthorizer.assertPermission({
      principal,
      permission: 'reserve:manage',
    });
    const dish = await this.loadSessionDish(
      principal,
      mealSessionId,
      input.mealSessionDishId,
    );
    await this.scopeAuthorizer.assertScope({
      principal,
      scope: {
        organizationId: principal.organizationId,
        factoryId: dish.factoryId,
      },
    });

    const window = await this.mealSessionAccess.getRegistrationWindow({
      mealSessionId,
      organizationId: principal.organizationId,
      now: this.clock.now(),
    });
    if (!window.isOpen) {
      throw new AppError(
        'CONFLICT',
        'The reserve pool can only be configured before cutoff.',
        { mealSessionId, state: window.state },
      );
    }

    const allocated = await this.allocatedTotal(input.mealSessionDishId);
    if (input.quantity < allocated) {
      throw new AppError(
        'VALIDATION_ERROR',
        'The reserve quantity cannot be lower than the already-allocated total.',
        { quantity: input.quantity, allocated },
      );
    }

    const setting = await this.audit.recordWithTransaction(
      (tx) =>
        tx.reservePoolSetting.upsert({
          where: { mealSessionDishId: input.mealSessionDishId },
          create: {
            mealSessionDishId: input.mealSessionDishId,
            isEnabled: input.isEnabled,
            quantity: input.quantity,
          },
          update: { isEnabled: input.isEnabled, quantity: input.quantity },
        }),
      (result) => ({
        organizationId: principal.organizationId,
        actorId: principal.userAccountId,
        action: 'reserve.configure',
        entityType: 'ReservePoolSetting',
        entityId: result.id,
        details: {
          mealSessionId,
          mealSessionDishId: input.mealSessionDishId,
          isEnabled: input.isEnabled,
          quantity: input.quantity,
        },
      }),
    );

    return {
      mealSessionId,
      mealSessionDishId: input.mealSessionDishId,
      isEnabled: setting.isEnabled,
      quantity: setting.quantity,
      allocated,
      remaining: Math.max(0, setting.quantity - allocated),
    };
  }

  /**
   * Allocate from a session dish's reserve pool after cutoff (P2-10). Requires
   * `reserve:manage` and scope over the session's factory. The pool must be
   * enabled (a missing or disabled pool is CONFLICT - "pool off => no
   * allocation"), and the allocation must fit the remaining quantity.
   *
   * The check-and-insert is atomic. Inside one interactive transaction it:
   *   1. locks the `ReservePoolSetting` row with `SELECT ... FOR UPDATE`, so
   *      every concurrent allocation for the same dish serializes here;
   *   2. re-reads the committed ALLOCATED total under that lock;
   *   3. inserts the allocation only if `allocated + quantity <= pool.quantity`,
   *      else rejects with CONFLICT.
   * A second allocation that arrives while the first holds the lock waits, then
   * sees the first's committed total and is rejected if it no longer fits.
   *
   * The allocation is its OWN record: no `MealRegistration` is created or
   * changed, so an unregistered recipient stays unregistered.
   */
  async allocate(
    principal: RequestPrincipal,
    mealSessionId: string,
    input: {
      mealSessionDishId: string;
      employeeId?: string;
      quantity?: number;
      reason: string;
    },
  ): Promise<ReserveAllocationView> {
    await this.scopeAuthorizer.assertPermission({
      principal,
      permission: 'reserve:manage',
    });

    const reason = input.reason?.trim();
    if (!reason) {
      throw new AppError(
        'VALIDATION_ERROR',
        'A reserve allocation requires a non-empty reason.',
      );
    }
    const quantity = input.quantity ?? 1;

    const dish = await this.loadSessionDish(
      principal,
      mealSessionId,
      input.mealSessionDishId,
    );
    await this.scopeAuthorizer.assertScope({
      principal,
      scope: {
        organizationId: principal.organizationId,
        factoryId: dish.factoryId,
      },
    });

    if (input.employeeId) {
      await this.assertEmployeeInFactory(
        principal,
        input.employeeId,
        dish.factoryId,
      );
    }

    const actorId = principal.userAccountId;
    const allocation = await this.prisma.$transaction(async (tx) => {
      // Lock the setting row so concurrent allocations for this dish serialize
      // on it. The lock is held until this transaction commits, so the next
      // allocation re-reads the committed total only after this one lands.
      //
      // NOTE: the over-allocation guarantee rests on this `FOR UPDATE`
      // serializing OVERLAPPING transactions on a real Postgres. The in-memory
      // test double has no row lock or isolation, so the unit tests only prove
      // the sequential case; the concurrent case is a real-DB property. See the
      // "Testing and invariant coverage" section of the README.
      const settings = await tx.$queryRaw<
        { id: string; is_enabled: boolean; quantity: number }[]
      >(Prisma.sql`
        SELECT id, is_enabled, quantity
        FROM reserve_pool_setting
        WHERE "mealSessionDishId" = ${input.mealSessionDishId}
        FOR UPDATE
      `);
      const setting = settings[0];

      if (!setting || !setting.is_enabled) {
        throw new AppError(
          'CONFLICT',
          'The reserve pool is not enabled for this session dish.',
          { mealSessionId, mealSessionDishId: input.mealSessionDishId },
        );
      }

      const grouped = await tx.reserveAllocation.aggregate({
        where: {
          mealSessionDishId: input.mealSessionDishId,
          status: ReserveAllocationStatus.ALLOCATED,
        },
        _sum: { quantity: true },
      });
      const allocated = grouped._sum.quantity ?? 0;

      if (allocated + quantity > Number(setting.quantity)) {
        throw new AppError(
          'CONFLICT',
          'The allocation would exceed the reserve pool.',
          {
            mealSessionDishId: input.mealSessionDishId,
            quantity,
            allocated,
            poolQuantity: Number(setting.quantity),
            remaining: Math.max(0, Number(setting.quantity) - allocated),
          },
        );
      }

      const created = await tx.reserveAllocation.create({
        data: {
          organizationId: principal.organizationId,
          mealSessionId,
          mealSessionDishId: input.mealSessionDishId,
          employeeId: input.employeeId ?? null,
          quantity,
          status: ReserveAllocationStatus.ALLOCATED,
          reason,
          allocatedByUserId: actorId,
          allocatedAt: this.clock.now(),
        },
      });

      await this.audit.record(tx, {
        organizationId: principal.organizationId,
        actorId,
        action: 'reserve.allocate',
        entityType: 'ReserveAllocation',
        entityId: created.id,
        details: {
          mealSessionId,
          mealSessionDishId: input.mealSessionDishId,
          employeeId: created.employeeId,
          quantity,
          reason,
        },
      });

      return created;
    });

    return toAllocationView(allocation);
  }

  /**
   * Load the session (tenant-scoped) and its factory. NOT_FOUND when it does
   * not exist in the principal's organization.
   */
  private async loadSession(
    principal: RequestPrincipal,
    mealSessionId: string,
  ): Promise<{ factoryId: string }> {
    const session = await this.prisma.mealSession.findFirst({
      where: { id: mealSessionId, organizationId: principal.organizationId },
      select: { factoryId: true },
    });
    if (!session) {
      throw new AppError('NOT_FOUND', 'Meal session not found.', {
        mealSessionId,
      });
    }
    return session;
  }

  /**
   * Load one session dish and the session's factory (tenant-scoped). NOT_FOUND
   * when the dish does not belong to the session in the principal's org.
   */
  private async loadSessionDish(
    principal: RequestPrincipal,
    mealSessionId: string,
    mealSessionDishId: string,
  ): Promise<LoadedSessionDish> {
    const dish = await this.prisma.mealSessionDish.findFirst({
      where: {
        id: mealSessionDishId,
        mealSessionId,
        mealSession: { organizationId: principal.organizationId },
      },
      select: { id: true, mealSession: { select: { factoryId: true } } },
    });
    if (!dish) {
      throw new AppError(
        'NOT_FOUND',
        'The session dish was not found for this meal session.',
        { mealSessionId, mealSessionDishId },
      );
    }
    return {
      mealSessionId,
      mealSessionDishId: dish.id,
      factoryId: dish.mealSession.factoryId,
    };
  }

  /**
   * A reserve recipient must be an employee of the session's factory and inside
   * the principal's scope, so an admin cannot allocate to someone outside the
   * session or their granted subtree.
   */
  private async assertEmployeeInFactory(
    principal: RequestPrincipal,
    employeeId: string,
    factoryId: string,
  ): Promise<void> {
    const employee = await this.prisma.employee.findFirst({
      where: {
        id: employeeId,
        organizationId: principal.organizationId,
        factoryId,
      },
      select: {
        organizationId: true,
        factoryId: true,
        departmentId: true,
        teamId: true,
      },
    });
    if (!employee) {
      throw new AppError(
        'VALIDATION_ERROR',
        'The reserve recipient is not an employee of this session factory.',
        { employeeId, factoryId },
      );
    }
    await this.scopeAuthorizer.assertScope({ principal, scope: employee });
  }

  /**
   * The committed ALLOCATED total for one session dish, read outside a lock.
   * Used by configuration (to refuse shrinking below what is allocated) and by
   * the pool read; the allocation path re-reads this under the row lock.
   */
  private async allocatedTotal(mealSessionDishId: string): Promise<number> {
    const grouped = await this.prisma.reserveAllocation.aggregate({
      where: {
        mealSessionDishId,
        status: ReserveAllocationStatus.ALLOCATED,
      },
      _sum: { quantity: true },
    });
    return grouped._sum.quantity ?? 0;
  }

  /**
   * The ALLOCATED total per session dish for a whole session, for the pool read.
   */
  private async allocatedTotals(
    mealSessionId: string,
  ): Promise<Map<string, number>> {
    const grouped = await this.prisma.reserveAllocation.groupBy({
      by: ['mealSessionDishId'],
      where: { mealSessionId, status: ReserveAllocationStatus.ALLOCATED },
      _sum: { quantity: true },
    });
    return new Map(
      grouped.map((row) => [row.mealSessionDishId, row._sum.quantity ?? 0]),
    );
  }
}

function toAllocationView(
  allocation: ReserveAllocation,
): ReserveAllocationView {
  return {
    id: allocation.id,
    mealSessionId: allocation.mealSessionId,
    mealSessionDishId: allocation.mealSessionDishId,
    employeeId: allocation.employeeId,
    quantity: allocation.quantity,
    status: allocation.status,
    reason: allocation.reason,
    allocatedByUserId: allocation.allocatedByUserId,
    allocatedAt: allocation.allocatedAt.toISOString(),
  };
}
