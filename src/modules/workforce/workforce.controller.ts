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
import {
  CreateEmployeeDto,
  EmployeeAccountDto,
  UpdateEmployeeDto,
} from './dto/employee.dto';
import { GrantRoleDto } from './dto/role-grant.dto';
import { WorkforceService } from './workforce.service';
import {
  EmployeeView,
  RoleGrantView,
  UserAccountView,
} from './workforce.types';

/**
 * HTTP surface for the workforce domain. The controller only wires requests to
 * the service and declares the coarse permission each route needs; the service
 * owns containment, the per-target scope check, the self-scope rule for the
 * Employee role, and audit. `@RequirePermission` is the "may this account do
 * this kind of action at all" gate; the service re-checks the exact target.
 */
@Controller()
@UseGuards(JwtAuthGuard, PermissionGuard)
export class WorkforceController {
  constructor(private readonly workforce: WorkforceService) {}

  // --- Employees -----------------------------------------------------------

  @Get('employees')
  @RequirePermission('employee:read')
  listEmployees(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Query('teamId') teamId?: string,
  ): Promise<EmployeeView[]> {
    return this.workforce.listEmployees(principal, teamId);
  }

  @Get('employees/:id')
  @RequirePermission('employee:read')
  getEmployee(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Param('id') id: string,
  ): Promise<EmployeeView> {
    return this.workforce.getEmployee(principal, id);
  }

  @Post('employees')
  @RequirePermission('employee:manage')
  createEmployee(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Body() dto: CreateEmployeeDto,
  ): Promise<EmployeeView> {
    return this.workforce.createEmployee(principal, dto);
  }

  @Patch('employees/:id')
  @RequirePermission('employee:manage')
  updateEmployee(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Param('id') id: string,
    @Body() dto: UpdateEmployeeDto,
  ): Promise<EmployeeView> {
    return this.workforce.updateEmployee(principal, id, dto);
  }

  @Delete('employees/:id')
  @RequirePermission('employee:manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteEmployee(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Param('id') id: string,
  ): Promise<void> {
    return this.workforce.deleteEmployee(principal, id);
  }

  // --- Account linking -----------------------------------------------------

  @Post('employees/:id/account')
  @RequirePermission('employee:manage')
  createEmployeeAccount(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Param('id') id: string,
    @Body() dto: EmployeeAccountDto,
  ): Promise<UserAccountView> {
    return this.workforce.createEmployeeAccount(principal, id, dto);
  }

  // --- Role / scope grants -------------------------------------------------

  @Post('role-grants')
  @RequirePermission('role:assign')
  grantRole(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Body() dto: GrantRoleDto,
  ): Promise<RoleGrantView> {
    return this.workforce.grantRole(principal, dto);
  }

  @Delete('role-grants/:id')
  @RequirePermission('role:assign')
  @HttpCode(HttpStatus.NO_CONTENT)
  revokeRole(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Param('id') id: string,
  ): Promise<void> {
    return this.workforce.revokeRole(principal, id);
  }
}
