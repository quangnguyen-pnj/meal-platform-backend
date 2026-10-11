import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { RequestPrincipal } from '../../common/auth/request-principal';
import { PermissionGuard } from '../../common/authorization/permission.guard';
import { RequirePermission } from '../../common/authorization/require-permission.decorator';
import { CreateDishDto, UpdateDishDto } from './dto/dish.dto';
import { MenusService } from './menus.service';
import { DishView } from './menus.types';

/**
 * HTTP surface for the Phase 1 dish catalog. The controller only wires
 * requests to the service and declares the permission each route needs; the
 * service owns code uniqueness, the organization-scope check, and audit.
 * Dishes are an organization-level catalog, so every route is gated on
 * `menu:manage` (there is no separate dish-read permission in the Phase 1
 * catalog).
 */
@Controller('dishes')
@UseGuards(JwtAuthGuard, PermissionGuard)
export class MenusController {
  constructor(private readonly menus: MenusService) {}

  @Get()
  @RequirePermission('menu:manage')
  listDishes(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Query('includeInactive') includeInactive?: string,
  ): Promise<DishView[]> {
    return this.menus.listDishes(principal, includeInactive === 'true');
  }

  @Get(':id')
  @RequirePermission('menu:manage')
  getDish(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Param('id') id: string,
  ): Promise<DishView> {
    return this.menus.getDish(principal, id);
  }

  @Post()
  @RequirePermission('menu:manage')
  createDish(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Body() dto: CreateDishDto,
  ): Promise<DishView> {
    return this.menus.createDish(principal, dto);
  }

  @Patch(':id')
  @RequirePermission('menu:manage')
  updateDish(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Param('id') id: string,
    @Body() dto: UpdateDishDto,
  ): Promise<DishView> {
    return this.menus.updateDish(principal, id, dto);
  }

  @Post(':id/disable')
  @RequirePermission('menu:manage')
  disableDish(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Param('id') id: string,
  ): Promise<DishView> {
    return this.menus.disableDish(principal, id);
  }

  @Post(':id/enable')
  @RequirePermission('menu:manage')
  enableDish(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Param('id') id: string,
  ): Promise<DishView> {
    return this.menus.enableDish(principal, id);
  }
}
