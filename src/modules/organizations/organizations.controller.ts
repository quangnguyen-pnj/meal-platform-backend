import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
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
import { CreateDepartmentDto, UpdateDepartmentDto } from './dto/department.dto';
import { CreateFactoryDto, UpdateFactoryDto } from './dto/factory.dto';
import { CreateTeamDto, UpdateTeamDto } from './dto/team.dto';
import { OrganizationsService } from './organizations.service';
import {
  DepartmentView,
  FactoryView,
  ScopeTreeView,
  TeamView,
} from './organizations.types';

/**
 * HTTP surface for the tenant tree. The controller only wires requests to the
 * service and declares the coarse permission each route needs; the service
 * owns containment, per-target scope checks, and audit. `@RequirePermission`
 * is the "may this account do this kind of action at all" gate the
 * `PermissionGuard` enforces, and the service re-checks the exact target scope.
 */
@Controller()
@UseGuards(JwtAuthGuard, PermissionGuard)
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  @Get('scope-tree')
  @RequirePermission('organization:read')
  getScopeTree(
    @CurrentPrincipal() principal: RequestPrincipal,
  ): Promise<ScopeTreeView> {
    return this.organizations.getScopeTree(principal);
  }

  // --- Factories -----------------------------------------------------------

  @Get('factories')
  @RequirePermission('organization:read')
  listFactories(
    @CurrentPrincipal() principal: RequestPrincipal,
  ): Promise<FactoryView[]> {
    return this.organizations.listFactories(principal);
  }

  @Get('factories/:id')
  @RequirePermission('organization:read')
  getFactory(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Param('id') id: string,
  ): Promise<FactoryView> {
    return this.organizations.getFactory(principal, id);
  }

  @Post('factories')
  @RequirePermission('organization:manage')
  createFactory(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Body() dto: CreateFactoryDto,
  ): Promise<FactoryView> {
    return this.organizations.createFactory(principal, dto);
  }

  @Patch('factories/:id')
  @RequirePermission('organization:manage')
  updateFactory(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Param('id') id: string,
    @Body() dto: UpdateFactoryDto,
  ): Promise<FactoryView> {
    return this.organizations.updateFactory(principal, id, dto);
  }

  @Delete('factories/:id')
  @RequirePermission('organization:manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteFactory(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Param('id') id: string,
  ): Promise<void> {
    return this.organizations.deleteFactory(principal, id);
  }

  // --- Departments ---------------------------------------------------------

  @Get('departments')
  @RequirePermission('organization:read')
  listDepartments(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Query('factoryId') factoryId?: string,
  ): Promise<DepartmentView[]> {
    return this.organizations.listDepartments(principal, factoryId);
  }

  @Get('departments/:id')
  @RequirePermission('organization:read')
  getDepartment(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Param('id') id: string,
  ): Promise<DepartmentView> {
    return this.organizations.getDepartment(principal, id);
  }

  @Post('departments')
  @RequirePermission('organization:manage')
  createDepartment(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Body() dto: CreateDepartmentDto,
  ): Promise<DepartmentView> {
    return this.organizations.createDepartment(principal, dto);
  }

  @Patch('departments/:id')
  @RequirePermission('organization:manage')
  updateDepartment(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Param('id') id: string,
    @Body() dto: UpdateDepartmentDto,
  ): Promise<DepartmentView> {
    return this.organizations.updateDepartment(principal, id, dto);
  }

  @Delete('departments/:id')
  @RequirePermission('organization:manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteDepartment(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Param('id') id: string,
  ): Promise<void> {
    return this.organizations.deleteDepartment(principal, id);
  }

  // --- Teams ---------------------------------------------------------------

  @Get('teams')
  @RequirePermission('organization:read')
  listTeams(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Query('departmentId') departmentId?: string,
  ): Promise<TeamView[]> {
    return this.organizations.listTeams(principal, departmentId);
  }

  @Get('teams/:id')
  @RequirePermission('organization:read')
  getTeam(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Param('id') id: string,
  ): Promise<TeamView> {
    return this.organizations.getTeam(principal, id);
  }

  @Post('teams')
  @RequirePermission('organization:manage')
  createTeam(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Body() dto: CreateTeamDto,
  ): Promise<TeamView> {
    return this.organizations.createTeam(principal, dto);
  }

  @Patch('teams/:id')
  @RequirePermission('organization:manage')
  updateTeam(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Param('id') id: string,
    @Body() dto: UpdateTeamDto,
  ): Promise<TeamView> {
    return this.organizations.updateTeam(principal, id, dto);
  }

  @Delete('teams/:id')
  @RequirePermission('organization:manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteTeam(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Param('id') id: string,
  ): Promise<void> {
    return this.organizations.deleteTeam(principal, id);
  }
}
