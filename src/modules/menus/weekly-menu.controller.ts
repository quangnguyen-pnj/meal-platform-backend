import {
  Body,
  Controller,
  Delete,
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
import {
  AddMenuItemDto,
  CreateWeeklyMenuDto,
  UpdateMenuItemDto,
} from './dto/weekly-menu.dto';
import { WeeklyMenuView } from './menus.types';
import { WeeklyMenuService } from './weekly-menu.service';

/**
 * HTTP surface for factory weekly menus (P1-02). The controller only wires
 * requests to the service and declares the `menu:manage` permission each route
 * needs; the service owns the one-menu-per-week rule, the factory-scope check,
 * the DRAFT-only edit rule, dish validation, and audit.
 */
@Controller('weekly-menus')
@UseGuards(JwtAuthGuard, PermissionGuard)
export class WeeklyMenuController {
  constructor(private readonly weeklyMenus: WeeklyMenuService) {}

  @Get()
  @RequirePermission('menu:manage')
  listWeeklyMenus(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Query('factoryId') factoryId: string,
  ): Promise<WeeklyMenuView[]> {
    return this.weeklyMenus.listWeeklyMenus(principal, factoryId);
  }

  @Get(':id')
  @RequirePermission('menu:manage')
  getWeeklyMenu(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Param('id') id: string,
  ): Promise<WeeklyMenuView> {
    return this.weeklyMenus.getWeeklyMenu(principal, id);
  }

  @Post()
  @RequirePermission('menu:manage')
  createWeeklyMenu(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Body() dto: CreateWeeklyMenuDto,
  ): Promise<WeeklyMenuView> {
    return this.weeklyMenus.createWeeklyMenu(principal, dto);
  }

  @Post(':id/items')
  @RequirePermission('menu:manage')
  addMenuItem(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Param('id') id: string,
    @Body() dto: AddMenuItemDto,
  ): Promise<WeeklyMenuView> {
    return this.weeklyMenus.addMenuItem(principal, id, dto);
  }

  @Patch(':id/items/:itemId')
  @RequirePermission('menu:manage')
  updateMenuItem(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() dto: UpdateMenuItemDto,
  ): Promise<WeeklyMenuView> {
    return this.weeklyMenus.updateMenuItem(principal, id, itemId, dto);
  }

  @Delete(':id/items/:itemId')
  @RequirePermission('menu:manage')
  removeMenuItem(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
  ): Promise<WeeklyMenuView> {
    return this.weeklyMenus.removeMenuItem(principal, id, itemId);
  }

  @Post(':id/publish')
  @RequirePermission('menu:manage')
  publishWeeklyMenu(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Param('id') id: string,
  ): Promise<WeeklyMenuView> {
    return this.weeklyMenus.publishWeeklyMenu(principal, id);
  }

  @Post(':id/archive')
  @RequirePermission('menu:manage')
  archiveWeeklyMenu(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Param('id') id: string,
  ): Promise<WeeklyMenuView> {
    return this.weeklyMenus.archiveWeeklyMenu(principal, id);
  }
}
