import { Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { RequestPrincipal } from '../../common/auth/request-principal';
import { ScopeAuthorizer } from '../../common/authorization/scope-authorizer.service';
import { PrismaService } from '../../common/database/prisma.service';
import { AppError } from '../../common/errors/app-error';
import {
  formatHcmDate,
  isWithinWeek,
  parseHcmDate,
  weekStartOf,
} from '../../common/time/hcm-week';
import {
  Dish,
  MenuItem,
  Prisma,
  WeeklyMenu,
} from '../../generated/prisma/client';
import {
  AddMenuItemDto,
  CreateWeeklyMenuDto,
  UpdateMenuItemDto,
} from './dto/weekly-menu.dto';
import { MenuItemView, WeeklyMenuView } from './menus.types';

type WeeklyMenuWithItems = WeeklyMenu & { items: MenuItem[] };

/**
 * Owns the Phase 1 weekly-menu business rules (P1-02). A weekly menu belongs to
 * a factory and holds at most one entry per week (`weekStartDate` is the Monday
 * of the week in Asia/Ho_Chi_Minh time, normalised here so a caller may pass
 * any day in the target week). Every check is at FACTORY scope: the principal
 * must hold `menu:manage` and a grant covering the menu's factory, so a
 * factory-scoped admin manages only its own factory while an org admin manages
 * all. Every mutation writes an audit row in the same transaction.
 *
 * Invariants enforced here:
 * - At most one weekly menu per factory per week (CONFLICT on a duplicate).
 * - Items change only while the menu is DRAFT.
 * - A menu item's dish must be in the same organization and ACTIVE when added.
 *   A dish disabled afterwards stays referenced; only new additions are blocked.
 * - A service date must fall inside the menu's week.
 * - Publishing requires a valid menu (at least one item) and records
 *   `publishedAt` / `publishedByUserId`.
 *
 * This service does not create meal sessions; P1-03 derives those from a
 * published menu.
 */
@Injectable()
export class WeeklyMenuService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scopeAuthorizer: ScopeAuthorizer,
    private readonly audit: AuditService,
  ) {}

  async listWeeklyMenus(
    principal: RequestPrincipal,
    factoryId: string,
  ): Promise<WeeklyMenuView[]> {
    await this.assertFactoryAccess(principal, factoryId);
    const menus = await this.prisma.weeklyMenu.findMany({
      where: { organizationId: principal.organizationId, factoryId },
      orderBy: { weekStartDate: 'desc' },
      include: { items: true },
    });
    return menus.map(toWeeklyMenuView);
  }

  async getWeeklyMenu(
    principal: RequestPrincipal,
    menuId: string,
  ): Promise<WeeklyMenuView> {
    const menu = await this.loadMenu(principal, menuId);
    await this.assertFactoryAccess(principal, menu.factoryId);
    return toWeeklyMenuView(menu);
  }

  async createWeeklyMenu(
    principal: RequestPrincipal,
    dto: CreateWeeklyMenuDto,
  ): Promise<WeeklyMenuView> {
    await this.assertFactoryAccess(principal, dto.factoryId);
    const weekStart = weekStartOf(parseHcmDate(dto.weekStartDate));

    const existing = await this.prisma.weeklyMenu.findUnique({
      where: {
        factoryId_weekStartDate: {
          factoryId: dto.factoryId,
          weekStartDate: weekStart,
        },
      },
    });
    if (existing) {
      throw new AppError(
        'CONFLICT',
        'A weekly menu already exists for this factory and week.',
        { factoryId: dto.factoryId, weekStartDate: formatHcmDate(weekStart) },
      );
    }

    const menu = await this.audit.recordWithTransaction(
      (tx) =>
        tx.weeklyMenu.create({
          data: {
            organizationId: principal.organizationId,
            factoryId: dto.factoryId,
            weekStartDate: weekStart,
          },
          include: { items: true },
        }),
      (created) => ({
        organizationId: principal.organizationId,
        actorId: principal.userAccountId,
        action: 'weekly-menu.create',
        entityType: 'WeeklyMenu',
        entityId: created.id,
        details: {
          factoryId: created.factoryId,
          weekStartDate: formatHcmDate(created.weekStartDate),
        },
      }),
    );
    return toWeeklyMenuView(menu);
  }

  async addMenuItem(
    principal: RequestPrincipal,
    menuId: string,
    dto: AddMenuItemDto,
  ): Promise<WeeklyMenuView> {
    const menu = await this.loadMenu(principal, menuId);
    await this.assertFactoryAccess(principal, menu.factoryId);
    this.assertDraft(menu);

    const serviceDate = parseHcmDate(dto.serviceDate);
    if (!isWithinWeek(menu.weekStartDate, serviceDate)) {
      throw new AppError(
        'VALIDATION_ERROR',
        'serviceDate must fall within the menu week.',
        {
          weekStartDate: formatHcmDate(menu.weekStartDate),
          serviceDate: dto.serviceDate,
        },
      );
    }

    const dish = await this.loadActiveDish(principal, dto.dishId);

    const duplicate = menu.items.find(
      (item) =>
        item.serviceDate.getTime() === serviceDate.getTime() &&
        item.mealType === dto.mealType &&
        item.dishId === dish.id,
    );
    if (duplicate) {
      throw new AppError(
        'CONFLICT',
        'This dish is already on the menu for that date and meal.',
        {
          serviceDate: dto.serviceDate,
          mealType: dto.mealType,
          dishId: dish.id,
        },
      );
    }

    await this.audit.recordWithTransaction(
      (tx) =>
        tx.menuItem.create({
          data: {
            weeklyMenuId: menu.id,
            serviceDate,
            mealType: dto.mealType,
            dishId: dish.id,
            sortOrder: dto.sortOrder ?? 0,
          },
        }),
      (created) => ({
        organizationId: principal.organizationId,
        actorId: principal.userAccountId,
        action: 'menu-item.add',
        entityType: 'MenuItem',
        entityId: created.id,
        details: {
          weeklyMenuId: menu.id,
          serviceDate: dto.serviceDate,
          mealType: dto.mealType,
          dishId: dish.id,
        },
      }),
    );
    return this.getWeeklyMenu(principal, menu.id);
  }

  async updateMenuItem(
    principal: RequestPrincipal,
    menuId: string,
    itemId: string,
    dto: UpdateMenuItemDto,
  ): Promise<WeeklyMenuView> {
    const menu = await this.loadMenu(principal, menuId);
    await this.assertFactoryAccess(principal, menu.factoryId);
    this.assertDraft(menu);

    const item = menu.items.find((candidate) => candidate.id === itemId);
    if (!item) {
      throw new AppError('NOT_FOUND', 'Menu item not found.', { itemId });
    }

    const data: Prisma.MenuItemUpdateInput = {};
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;

    await this.audit.recordWithTransaction(
      (tx) => tx.menuItem.update({ where: { id: item.id }, data }),
      (updated) => ({
        organizationId: principal.organizationId,
        actorId: principal.userAccountId,
        action: 'menu-item.update',
        entityType: 'MenuItem',
        entityId: updated.id,
        details: { weeklyMenuId: menu.id, sortOrder: updated.sortOrder },
      }),
    );
    return this.getWeeklyMenu(principal, menu.id);
  }

  async removeMenuItem(
    principal: RequestPrincipal,
    menuId: string,
    itemId: string,
  ): Promise<WeeklyMenuView> {
    const menu = await this.loadMenu(principal, menuId);
    await this.assertFactoryAccess(principal, menu.factoryId);
    this.assertDraft(menu);

    const item = menu.items.find((candidate) => candidate.id === itemId);
    if (!item) {
      throw new AppError('NOT_FOUND', 'Menu item not found.', { itemId });
    }

    await this.audit.recordWithTransaction(
      (tx) => tx.menuItem.delete({ where: { id: item.id } }),
      (deleted) => ({
        organizationId: principal.organizationId,
        actorId: principal.userAccountId,
        action: 'menu-item.remove',
        entityType: 'MenuItem',
        entityId: deleted.id,
        details: { weeklyMenuId: menu.id, dishId: deleted.dishId },
      }),
    );
    return this.getWeeklyMenu(principal, menu.id);
  }

  async publishWeeklyMenu(
    principal: RequestPrincipal,
    menuId: string,
  ): Promise<WeeklyMenuView> {
    const menu = await this.loadMenu(principal, menuId);
    await this.assertFactoryAccess(principal, menu.factoryId);

    if (menu.status !== 'DRAFT') {
      throw new AppError('CONFLICT', 'Only a draft menu can be published.', {
        menuId: menu.id,
        status: menu.status,
      });
    }
    if (menu.items.length === 0) {
      throw new AppError(
        'VALIDATION_ERROR',
        'A menu must have at least one item before it can be published.',
        { menuId: menu.id },
      );
    }

    const publishedAt = new Date();
    const published = await this.audit.recordWithTransaction(
      (tx) =>
        tx.weeklyMenu.update({
          where: { id: menu.id },
          data: {
            status: 'PUBLISHED',
            publishedAt,
            publishedByUserId: principal.userAccountId,
          },
          include: { items: true },
        }),
      (result) => ({
        organizationId: principal.organizationId,
        actorId: principal.userAccountId,
        action: 'weekly-menu.publish',
        entityType: 'WeeklyMenu',
        entityId: result.id,
        details: {
          factoryId: result.factoryId,
          weekStartDate: formatHcmDate(result.weekStartDate),
          itemCount: result.items.length,
        },
      }),
    );
    return toWeeklyMenuView(published);
  }

  async archiveWeeklyMenu(
    principal: RequestPrincipal,
    menuId: string,
  ): Promise<WeeklyMenuView> {
    const menu = await this.loadMenu(principal, menuId);
    await this.assertFactoryAccess(principal, menu.factoryId);

    if (menu.status === 'ARCHIVED') {
      throw new AppError('CONFLICT', 'Menu is already archived.', {
        menuId: menu.id,
      });
    }

    const archived = await this.audit.recordWithTransaction(
      (tx) =>
        tx.weeklyMenu.update({
          where: { id: menu.id },
          data: { status: 'ARCHIVED' },
          include: { items: true },
        }),
      (result) => ({
        organizationId: principal.organizationId,
        actorId: principal.userAccountId,
        action: 'weekly-menu.archive',
        entityType: 'WeeklyMenu',
        entityId: result.id,
        details: { factoryId: result.factoryId },
      }),
    );
    return toWeeklyMenuView(archived);
  }

  /**
   * Weekly menus are factory-scoped, so every read and write requires
   * `menu:manage` plus a grant covering the target factory. A factory-level
   * grant covers only its own factory; an organization-level grant covers all.
   */
  private async assertFactoryAccess(
    principal: RequestPrincipal,
    factoryId: string,
  ): Promise<void> {
    await this.scopeAuthorizer.assertPermission({
      principal,
      permission: 'menu:manage',
    });
    await this.scopeAuthorizer.assertScope({
      principal,
      scope: { organizationId: principal.organizationId, factoryId },
    });
  }

  private assertDraft(menu: WeeklyMenu): void {
    if (menu.status !== 'DRAFT') {
      throw new AppError(
        'CONFLICT',
        'Menu items can only be changed while the menu is a draft.',
        { menuId: menu.id, status: menu.status },
      );
    }
  }

  private async loadMenu(
    principal: RequestPrincipal,
    menuId: string,
  ): Promise<WeeklyMenuWithItems> {
    const menu = await this.prisma.weeklyMenu.findFirst({
      where: { id: menuId, organizationId: principal.organizationId },
      include: { items: true },
    });
    if (!menu) {
      throw new AppError('NOT_FOUND', 'Weekly menu not found.', { menuId });
    }
    return menu;
  }

  private async loadActiveDish(
    principal: RequestPrincipal,
    dishId: string,
  ): Promise<Dish> {
    const dish = await this.prisma.dish.findFirst({
      where: { id: dishId, organizationId: principal.organizationId },
    });
    if (!dish) {
      throw new AppError('NOT_FOUND', 'Dish not found.', { dishId });
    }
    if (!dish.isActive) {
      throw new AppError(
        'VALIDATION_ERROR',
        'An inactive dish cannot be added to a menu.',
        { dishId },
      );
    }
    return dish;
  }
}

function toMenuItemView(item: MenuItem): MenuItemView {
  return {
    id: item.id,
    weeklyMenuId: item.weeklyMenuId,
    serviceDate: formatHcmDate(item.serviceDate),
    mealType: item.mealType,
    dishId: item.dishId,
    sortOrder: item.sortOrder,
  };
}

function toWeeklyMenuView(menu: WeeklyMenuWithItems): WeeklyMenuView {
  const items = [...menu.items]
    .sort((a, b) => {
      const dateDiff = a.serviceDate.getTime() - b.serviceDate.getTime();
      if (dateDiff !== 0) return dateDiff;
      if (a.mealType !== b.mealType) return a.mealType < b.mealType ? -1 : 1;
      return a.sortOrder - b.sortOrder;
    })
    .map(toMenuItemView);
  return {
    id: menu.id,
    organizationId: menu.organizationId,
    factoryId: menu.factoryId,
    weekStartDate: formatHcmDate(menu.weekStartDate),
    status: menu.status,
    publishedAt: menu.publishedAt ? menu.publishedAt.toISOString() : null,
    publishedByUserId: menu.publishedByUserId,
    items,
  };
}
