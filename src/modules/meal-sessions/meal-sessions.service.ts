import { Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { RequestPrincipal } from '../../common/auth/request-principal';
import { ScopeAuthorizer } from '../../common/authorization/scope-authorizer.service';
import { PrismaService } from '../../common/database/prisma.service';
import { AppError } from '../../common/errors/app-error';
import { formatHcmDate, parseHcmDate } from '../../common/time/hcm-week';
import {
  MealSession,
  MealSessionDish,
  MenuItem,
} from '../../generated/prisma/client';
import { MealSessionStatus } from '../../generated/prisma/enums';
import {
  CreateSessionsFromMenuDto,
  UpdateSessionTimingDto,
} from './dto/meal-session.dto';
import { evaluateRegistrationWindow } from './meal-session-access.service';
import { MealSessionView } from './meal-sessions.types';

type MealSessionWithDishes = MealSession & { dishes: MealSessionDish[] };

/**
 * The lifecycle transitions a status change command may apply. A session moves
 * DRAFT -> PUBLISHED -> OPEN -> CLOSED forward, and may be CANCELLED from any
 * non-terminal state. CLOSED and CANCELLED are terminal. This map is the single
 * source of truth for "is this transition legal"; the window (whether
 * registration is actually open right now) is a separate, time-derived concern
 * owned by `MealSessionAccess`.
 */
const ALLOWED_TRANSITIONS: Record<MealSessionStatus, MealSessionStatus[]> = {
  DRAFT: ['PUBLISHED', 'CANCELLED'],
  PUBLISHED: ['OPEN', 'CANCELLED'],
  OPEN: ['CLOSED', 'CANCELLED'],
  CLOSED: [],
  CANCELLED: [],
};

/**
 * Owns the Phase 1 meal-session business rules (P1-03). A session is unique per
 * `[factoryId, serviceDate, mealType]` and is derived from a PUBLISHED weekly
 * menu: `createSessionsFromMenu` turns each `serviceDate` + `mealType` slot of
 * the menu into one DRAFT session carrying that slot's dishes.
 *
 * Every read and write is at FACTORY scope: the principal must hold
 * `meal-session:manage` and a grant covering the session's factory. Every
 * mutation writes an audit row in the same transaction.
 *
 * This service never decides whether registration is open; that is the
 * `MealSessionAccess` boundary. The views it returns include the live window so
 * the one evaluator is the only place cutoff is judged.
 */
@Injectable()
export class MealSessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scopeAuthorizer: ScopeAuthorizer,
    private readonly audit: AuditService,
  ) {}

  async listSessions(
    principal: RequestPrincipal,
    factoryId: string,
    serviceDate?: string,
  ): Promise<MealSessionView[]> {
    await this.assertFactoryAccess(principal, factoryId);
    const sessions = await this.prisma.mealSession.findMany({
      where: {
        organizationId: principal.organizationId,
        factoryId,
        ...(serviceDate ? { serviceDate: parseHcmDate(serviceDate) } : {}),
      },
      orderBy: [{ serviceDate: 'asc' }, { mealType: 'asc' }],
      include: { dishes: true },
    });
    const now = new Date();
    return sessions.map((session) => toMealSessionView(session, now));
  }

  async getSession(
    principal: RequestPrincipal,
    sessionId: string,
  ): Promise<MealSessionView> {
    const session = await this.loadSession(principal, sessionId);
    await this.assertFactoryAccess(principal, session.factoryId);
    return toMealSessionView(session, new Date());
  }

  /**
   * Derive sessions from a PUBLISHED weekly menu. Each distinct
   * `serviceDate` + `mealType` slot becomes one session whose offered dishes
   * are that slot's menu items. A slot that already has a session for the
   * factory/date/meal is skipped (create is guarded, never overwriting an
   * existing session), so re-running is safe and never duplicates.
   *
   * All new sessions (and their audit rows) are created in ONE transaction, so
   * a derive call is atomic: a failure partway through writes none of them.
   */
  async createSessionsFromMenu(
    principal: RequestPrincipal,
    dto: CreateSessionsFromMenuDto,
  ): Promise<MealSessionView[]> {
    const opensAt = new Date(dto.opensAt);
    const cutoffAt = new Date(dto.cutoffAt);
    if (cutoffAt.getTime() <= opensAt.getTime()) {
      throw new AppError(
        'VALIDATION_ERROR',
        'cutoffAt must be after opensAt.',
        { opensAt: dto.opensAt, cutoffAt: dto.cutoffAt },
      );
    }

    const menu = await this.prisma.weeklyMenu.findFirst({
      where: {
        id: dto.weeklyMenuId,
        organizationId: principal.organizationId,
      },
      include: { items: true },
    });
    if (!menu) {
      throw new AppError('NOT_FOUND', 'Weekly menu not found.', {
        weeklyMenuId: dto.weeklyMenuId,
      });
    }
    await this.assertFactoryAccess(principal, menu.factoryId);

    if (menu.status !== 'PUBLISHED') {
      throw new AppError(
        'VALIDATION_ERROR',
        'Meal sessions can only be derived from a published menu.',
        { weeklyMenuId: menu.id, status: menu.status },
      );
    }

    const slots = groupItemsIntoSlots(menu.items);

    const existing = await this.prisma.mealSession.findMany({
      where: {
        organizationId: principal.organizationId,
        factoryId: menu.factoryId,
      },
      select: { serviceDate: true, mealType: true },
    });
    const existingKeys = new Set(
      existing.map((row) => slotKey(row.serviceDate, row.mealType)),
    );

    const slotsToCreate = slots.filter(
      (slot) => !existingKeys.has(slotKey(slot.serviceDate, slot.mealType)),
    );

    // Derive the whole menu in ONE transaction: every new session and its audit
    // row commit together, or none do. A failure on a later slot rolls back the
    // earlier ones, so a single derive call is all-or-nothing (re-running stays
    // safe because existing slots are skipped before the transaction opens).
    await this.prisma.$transaction(async (tx) => {
      for (const slot of slotsToCreate) {
        const session = await tx.mealSession.create({
          data: {
            organizationId: principal.organizationId,
            factoryId: menu.factoryId,
            weeklyMenuId: menu.id,
            serviceDate: slot.serviceDate,
            mealType: slot.mealType,
            opensAt,
            cutoffAt,
            dishes: {
              create: slot.dishes.map((dish) => ({
                dishId: dish.dishId,
                sortOrder: dish.sortOrder,
              })),
            },
          },
          include: { dishes: true },
        });
        await this.audit.record(tx, {
          organizationId: principal.organizationId,
          actorId: principal.userAccountId,
          action: 'meal-session.create',
          entityType: 'MealSession',
          entityId: session.id,
          details: {
            factoryId: session.factoryId,
            weeklyMenuId: menu.id,
            serviceDate: formatHcmDate(session.serviceDate),
            mealType: session.mealType,
            dishCount: session.dishes.length,
          },
        });
      }
    });

    return this.listSessionsForMenu(principal, menu.factoryId, menu.id);
  }

  async updateTiming(
    principal: RequestPrincipal,
    sessionId: string,
    dto: UpdateSessionTimingDto,
  ): Promise<MealSessionView> {
    const session = await this.loadSession(principal, sessionId);
    await this.assertFactoryAccess(principal, session.factoryId);

    if (session.status !== MealSessionStatus.DRAFT) {
      throw new AppError(
        'CONFLICT',
        'Session timing can only be changed while the session is a draft.',
        { sessionId: session.id, status: session.status },
      );
    }

    const opensAt = dto.opensAt ? new Date(dto.opensAt) : session.opensAt;
    const cutoffAt = dto.cutoffAt ? new Date(dto.cutoffAt) : session.cutoffAt;
    if (cutoffAt.getTime() <= opensAt.getTime()) {
      throw new AppError(
        'VALIDATION_ERROR',
        'cutoffAt must be after opensAt.',
        {
          opensAt: opensAt.toISOString(),
          cutoffAt: cutoffAt.toISOString(),
        },
      );
    }

    const updated = await this.audit.recordWithTransaction(
      (tx) =>
        tx.mealSession.update({
          where: { id: session.id },
          data: { opensAt, cutoffAt },
          include: { dishes: true },
        }),
      (result) => ({
        organizationId: principal.organizationId,
        actorId: principal.userAccountId,
        action: 'meal-session.update-timing',
        entityType: 'MealSession',
        entityId: result.id,
        details: {
          opensAt: result.opensAt.toISOString(),
          cutoffAt: result.cutoffAt.toISOString(),
        },
      }),
    );
    return toMealSessionView(updated, new Date());
  }

  publishSession(
    principal: RequestPrincipal,
    sessionId: string,
  ): Promise<MealSessionView> {
    return this.transition(principal, sessionId, MealSessionStatus.PUBLISHED, {
      action: 'meal-session.publish',
      extraData: {
        publishedAt: new Date(),
        publishedByUserId: principal.userAccountId,
      },
    });
  }

  openSession(
    principal: RequestPrincipal,
    sessionId: string,
  ): Promise<MealSessionView> {
    return this.transition(principal, sessionId, MealSessionStatus.OPEN, {
      action: 'meal-session.open',
    });
  }

  closeSession(
    principal: RequestPrincipal,
    sessionId: string,
  ): Promise<MealSessionView> {
    return this.transition(principal, sessionId, MealSessionStatus.CLOSED, {
      action: 'meal-session.close',
    });
  }

  cancelSession(
    principal: RequestPrincipal,
    sessionId: string,
  ): Promise<MealSessionView> {
    return this.transition(principal, sessionId, MealSessionStatus.CANCELLED, {
      action: 'meal-session.cancel',
    });
  }

  /**
   * Apply a lifecycle status change, rejecting any transition not permitted by
   * `ALLOWED_TRANSITIONS`, and audit it in the same transaction.
   */
  private async transition(
    principal: RequestPrincipal,
    sessionId: string,
    target: MealSessionStatus,
    options: {
      action: string;
      extraData?: { publishedAt?: Date; publishedByUserId?: string };
    },
  ): Promise<MealSessionView> {
    const session = await this.loadSession(principal, sessionId);
    await this.assertFactoryAccess(principal, session.factoryId);

    if (!ALLOWED_TRANSITIONS[session.status].includes(target)) {
      throw new AppError(
        'CONFLICT',
        `Cannot change a ${session.status} session to ${target}.`,
        { sessionId: session.id, from: session.status, to: target },
      );
    }

    const updated = await this.audit.recordWithTransaction(
      (tx) =>
        tx.mealSession.update({
          where: { id: session.id },
          data: { status: target, ...(options.extraData ?? {}) },
          include: { dishes: true },
        }),
      (result) => ({
        organizationId: principal.organizationId,
        actorId: principal.userAccountId,
        action: options.action,
        entityType: 'MealSession',
        entityId: result.id,
        details: { from: session.status, to: target },
      }),
    );
    return toMealSessionView(updated, new Date());
  }

  private async listSessionsForMenu(
    principal: RequestPrincipal,
    factoryId: string,
    weeklyMenuId: string,
  ): Promise<MealSessionView[]> {
    const sessions = await this.prisma.mealSession.findMany({
      where: {
        organizationId: principal.organizationId,
        factoryId,
        weeklyMenuId,
      },
      orderBy: [{ serviceDate: 'asc' }, { mealType: 'asc' }],
      include: { dishes: true },
    });
    const now = new Date();
    return sessions.map((session) => toMealSessionView(session, now));
  }

  /**
   * Meal sessions are factory-scoped, so every read and write requires
   * `meal-session:manage` plus a grant covering the target factory. A
   * factory-level grant covers only its own factory; an org-level grant covers
   * all.
   */
  private async assertFactoryAccess(
    principal: RequestPrincipal,
    factoryId: string,
  ): Promise<void> {
    await this.scopeAuthorizer.assertPermission({
      principal,
      permission: 'meal-session:manage',
    });
    await this.scopeAuthorizer.assertScope({
      principal,
      scope: { organizationId: principal.organizationId, factoryId },
    });
  }

  private async loadSession(
    principal: RequestPrincipal,
    sessionId: string,
  ): Promise<MealSessionWithDishes> {
    const session = await this.prisma.mealSession.findFirst({
      where: { id: sessionId, organizationId: principal.organizationId },
      include: { dishes: true },
    });
    if (!session) {
      throw new AppError('NOT_FOUND', 'Meal session not found.', {
        sessionId,
      });
    }
    return session;
  }
}

interface SlotDish {
  dishId: string;
  sortOrder: number;
}

interface Slot {
  serviceDate: Date;
  mealType: MenuItem['mealType'];
  dishes: SlotDish[];
}

function slotKey(serviceDate: Date, mealType: string): string {
  return `${serviceDate.getTime()}|${mealType}`;
}

/**
 * Group a published menu's items into one slot per `serviceDate` + `mealType`,
 * carrying each slot's dishes (de-duplicated by dish, ordered by `sortOrder`).
 */
function groupItemsIntoSlots(items: MenuItem[]): Slot[] {
  const slots = new Map<string, Slot>();
  for (const item of items) {
    const key = slotKey(item.serviceDate, item.mealType);
    let slot = slots.get(key);
    if (!slot) {
      slot = {
        serviceDate: item.serviceDate,
        mealType: item.mealType,
        dishes: [],
      };
      slots.set(key, slot);
    }
    if (!slot.dishes.some((dish) => dish.dishId === item.dishId)) {
      slot.dishes.push({ dishId: item.dishId, sortOrder: item.sortOrder });
    }
  }
  for (const slot of slots.values()) {
    slot.dishes.sort((a, b) => a.sortOrder - b.sortOrder);
  }
  return [...slots.values()];
}

function toMealSessionView(
  session: MealSessionWithDishes,
  now: Date,
): MealSessionView {
  const dishes = [...session.dishes]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((dish) => ({
      id: dish.id,
      mealSessionId: dish.mealSessionId,
      dishId: dish.dishId,
      sortOrder: dish.sortOrder,
    }));
  return {
    id: session.id,
    organizationId: session.organizationId,
    factoryId: session.factoryId,
    weeklyMenuId: session.weeklyMenuId,
    serviceDate: formatHcmDate(session.serviceDate),
    mealType: session.mealType,
    status: session.status,
    opensAt: session.opensAt.toISOString(),
    cutoffAt: session.cutoffAt.toISOString(),
    publishedAt: session.publishedAt ? session.publishedAt.toISOString() : null,
    publishedByUserId: session.publishedByUserId,
    dishes,
    registrationWindow: evaluateRegistrationWindow(session, now),
  };
}
