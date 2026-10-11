import { Injectable } from '@nestjs/common';
import { RequestPrincipal } from '../../common/auth/request-principal';
import { ScopeAuthorizer } from '../../common/authorization/scope-authorizer.service';
import { PrismaService } from '../../common/database/prisma.service';
import { AppError } from '../../common/errors/app-error';
import { formatHcmDate } from '../../common/time/hcm-week';
import {
  RegistrationStatus,
  ReserveAllocationStatus,
} from '../../generated/prisma/enums';
import { SessionSummaryDishView, SessionSummaryView } from './reports.types';

/**
 * Owns the read-only session summary (P1-06). The report lists the dishes a
 * session offers (resolved to catalog code/name) with their registration
 * counts: per dish, how many REGISTERED and ABSENT `MealRegistration` rows it
 * has and the ALLOCATED reserve quantity against it, plus a `totalRegistered`
 * that sums the per-dish REGISTERED counts across the session.
 *
 * This service never writes: no mutation and no audit row, because a report is
 * a pure read. Every call still goes through the full authorization decision
 * point first: the principal must hold `report:read` AND a scope grant that
 * covers the session's factory. A factory- or team-scoped principal therefore
 * cannot summarize another factory's session, matching how `MealSessionsService`
 * guards its own reads and writes.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scopeAuthorizer: ScopeAuthorizer,
  ) {}

  async getSessionSummary(
    principal: RequestPrincipal,
    sessionId: string,
  ): Promise<SessionSummaryView> {
    const session = await this.prisma.mealSession.findFirst({
      where: { id: sessionId, organizationId: principal.organizationId },
      include: { dishes: true },
    });
    if (!session) {
      throw new AppError('NOT_FOUND', 'Meal session not found.', {
        sessionId,
      });
    }

    await this.scopeAuthorizer.assertPermission({
      principal,
      permission: 'report:read',
    });
    await this.scopeAuthorizer.assertScope({
      principal,
      scope: {
        organizationId: principal.organizationId,
        factoryId: session.factoryId,
      },
    });

    const dishIds = session.dishes.map((dish) => dish.dishId);
    const catalog = await this.prisma.dish.findMany({
      where: {
        organizationId: principal.organizationId,
        id: { in: dishIds },
      },
      select: { id: true, code: true, name: true },
    });
    const byId = new Map(catalog.map((dish) => [dish.id, dish]));

    const registrationCounts = await this.registrationCounts(session.id);
    const reserveCounts = await this.reserveCounts(session.id);

    const dishes: SessionSummaryDishView[] = [...session.dishes]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((dish) => {
        const resolved = byId.get(dish.dishId);
        const counts = registrationCounts.get(dish.id);
        return {
          dishId: dish.dishId,
          code: resolved?.code ?? dish.dishId,
          name: resolved?.name ?? dish.dishId,
          sortOrder: dish.sortOrder,
          registeredCount: counts?.registered ?? 0,
          absentCount: counts?.absent ?? 0,
          reserveCount: reserveCounts.get(dish.id) ?? 0,
        };
      });

    return {
      mealSessionId: session.id,
      factoryId: session.factoryId,
      serviceDate: formatHcmDate(session.serviceDate),
      mealType: session.mealType,
      status: session.status,
      offeredDishCount: dishes.length,
      totalRegistered: dishes.reduce(
        (sum, dish) => sum + dish.registeredCount,
        0,
      ),
      dishes,
    };
  }

  /**
   * The REGISTERED and ABSENT `MealRegistration` counts per session dish, read
   * in one `groupBy` over the session's registrations rather than per dish.
   */
  private async registrationCounts(
    mealSessionId: string,
  ): Promise<Map<string, { registered: number; absent: number }>> {
    const grouped = await this.prisma.mealRegistration.groupBy({
      by: ['mealSessionDishId', 'status'],
      where: {
        mealSessionId,
        status: {
          in: [RegistrationStatus.REGISTERED, RegistrationStatus.ABSENT],
        },
      },
      _count: { _all: true },
    });

    const counts = new Map<string, { registered: number; absent: number }>();
    for (const row of grouped) {
      const entry = counts.get(row.mealSessionDishId) ?? {
        registered: 0,
        absent: 0,
      };
      if (row.status === RegistrationStatus.REGISTERED) {
        entry.registered = row._count._all;
      } else if (row.status === RegistrationStatus.ABSENT) {
        entry.absent = row._count._all;
      }
      counts.set(row.mealSessionDishId, entry);
    }
    return counts;
  }

  /**
   * The ALLOCATED reserve quantity per session dish, summed in one `groupBy`
   * over the session's reserve allocations.
   */
  private async reserveCounts(
    mealSessionId: string,
  ): Promise<Map<string, number>> {
    const grouped = await this.prisma.reserveAllocation.groupBy({
      by: ['mealSessionDishId'],
      where: {
        mealSessionId,
        status: ReserveAllocationStatus.ALLOCATED,
      },
      _sum: { quantity: true },
    });
    return new Map(
      grouped.map((row) => [row.mealSessionDishId, row._sum.quantity ?? 0]),
    );
  }
}
