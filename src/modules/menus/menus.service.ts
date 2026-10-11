import { Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { RequestPrincipal } from '../../common/auth/request-principal';
import { ScopeAuthorizer } from '../../common/authorization/scope-authorizer.service';
import { PrismaService } from '../../common/database/prisma.service';
import { AppError } from '../../common/errors/app-error';
import { Dish, Prisma } from '../../generated/prisma/client';
import { CreateDishDto, UpdateDishDto } from './dto/dish.dto';
import { DishView } from './menus.types';

/**
 * Owns the Phase 1 dish catalog business rules. Dishes are an
 * organization-level catalog (unique `[organizationId, code]`), not tied to a
 * factory, so every check is at organization scope: the principal must hold
 * `menu:manage` and a grant inside the organization it is operating in. Code
 * uniqueness is enforced per organization (CONFLICT on a duplicate), and every
 * mutation writes an audit row in the same transaction. Controllers stay thin
 * and never touch Prisma or the authorizer directly.
 *
 * Disabling a dish sets `isActive = false` rather than deleting it: later
 * menus and session history may reference a dish, so the catalog keeps a
 * soft-disable as the primary mechanism. The rule that a disabled dish cannot
 * be added to a new session is enforced where sessions are created (P1-02 and
 * P1-03), not here.
 */
@Injectable()
export class MenusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scopeAuthorizer: ScopeAuthorizer,
    private readonly audit: AuditService,
  ) {}

  async listDishes(
    principal: RequestPrincipal,
    includeInactive = false,
  ): Promise<DishView[]> {
    await this.assertCatalogAccess(principal);
    const where: Prisma.DishWhereInput = {
      organizationId: principal.organizationId,
    };
    if (!includeInactive) {
      where.isActive = true;
    }
    const dishes = await this.prisma.dish.findMany({
      where,
      orderBy: { code: 'asc' },
    });
    return dishes.map(toDishView);
  }

  async getDish(
    principal: RequestPrincipal,
    dishId: string,
  ): Promise<DishView> {
    await this.assertCatalogAccess(principal);
    const dish = await this.loadDish(principal, dishId);
    return toDishView(dish);
  }

  async createDish(
    principal: RequestPrincipal,
    dto: CreateDishDto,
  ): Promise<DishView> {
    await this.assertCatalogAccess(principal);
    await this.assertDishCodeFree(principal.organizationId, dto.code);

    const dish = await this.audit.recordWithTransaction(
      (tx) =>
        tx.dish.create({
          data: {
            organizationId: principal.organizationId,
            code: dto.code,
            name: dto.name,
            description: dto.description ?? null,
            category: dto.category ?? null,
            dietaryTags: dto.dietaryTags ?? [],
          },
        }),
      (created) => ({
        organizationId: principal.organizationId,
        actorId: principal.userAccountId,
        action: 'dish.create',
        entityType: 'Dish',
        entityId: created.id,
        details: { code: created.code, name: created.name },
      }),
    );
    return toDishView(dish);
  }

  async updateDish(
    principal: RequestPrincipal,
    dishId: string,
    dto: UpdateDishDto,
  ): Promise<DishView> {
    await this.assertCatalogAccess(principal);
    const dish = await this.loadDish(principal, dishId);

    const data: Prisma.DishUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.category !== undefined) data.category = dto.category;
    if (dto.dietaryTags !== undefined) data.dietaryTags = dto.dietaryTags;

    const updated = await this.audit.recordWithTransaction(
      (tx) => tx.dish.update({ where: { id: dish.id }, data }),
      (result) => ({
        organizationId: principal.organizationId,
        actorId: principal.userAccountId,
        action: 'dish.update',
        entityType: 'Dish',
        entityId: result.id,
        details: { code: result.code, name: result.name },
      }),
    );
    return toDishView(updated);
  }

  async disableDish(
    principal: RequestPrincipal,
    dishId: string,
  ): Promise<DishView> {
    return this.setDishActive(principal, dishId, false);
  }

  async enableDish(
    principal: RequestPrincipal,
    dishId: string,
  ): Promise<DishView> {
    return this.setDishActive(principal, dishId, true);
  }

  private async setDishActive(
    principal: RequestPrincipal,
    dishId: string,
    isActive: boolean,
  ): Promise<DishView> {
    await this.assertCatalogAccess(principal);
    const dish = await this.loadDish(principal, dishId);

    const updated = await this.audit.recordWithTransaction(
      (tx) => tx.dish.update({ where: { id: dish.id }, data: { isActive } }),
      (result) => ({
        organizationId: principal.organizationId,
        actorId: principal.userAccountId,
        action: isActive ? 'dish.enable' : 'dish.disable',
        entityType: 'Dish',
        entityId: result.id,
        details: { code: result.code, isActive: result.isActive },
      }),
    );
    return toDishView(updated);
  }

  /**
   * The catalog is organization-scoped, so reads and writes alike require
   * `menu:manage` plus a grant inside the current organization. A principal
   * with no in-org grant is forbidden even if it holds the permission.
   */
  private async assertCatalogAccess(
    principal: RequestPrincipal,
  ): Promise<void> {
    await this.scopeAuthorizer.assertPermission({
      principal,
      permission: 'menu:manage',
    });
    await this.scopeAuthorizer.assertScope({
      principal,
      scope: { organizationId: principal.organizationId },
    });
  }

  private async loadDish(
    principal: RequestPrincipal,
    dishId: string,
  ): Promise<Dish> {
    const dish = await this.prisma.dish.findFirst({
      where: { id: dishId, organizationId: principal.organizationId },
    });
    if (!dish) {
      throw new AppError('NOT_FOUND', 'Dish not found.', { dishId });
    }
    return dish;
  }

  private async assertDishCodeFree(
    organizationId: string,
    code: string,
  ): Promise<void> {
    const existing = await this.prisma.dish.findUnique({
      where: { organizationId_code: { organizationId, code } },
    });
    if (existing) {
      throw new AppError('CONFLICT', 'Dish code already exists.', { code });
    }
  }
}

function toDishView(dish: Dish): DishView {
  return {
    id: dish.id,
    organizationId: dish.organizationId,
    code: dish.code,
    name: dish.name,
    description: dish.description,
    category: dish.category,
    dietaryTags: dish.dietaryTags,
    isActive: dish.isActive,
  };
}
