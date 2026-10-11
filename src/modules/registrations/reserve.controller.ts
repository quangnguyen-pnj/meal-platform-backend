import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { RequestPrincipal } from '../../common/auth/request-principal';
import { PermissionGuard } from '../../common/authorization/permission.guard';
import { RequirePermission } from '../../common/authorization/require-permission.decorator';
import { AllocateReserveDto, ConfigureReservePoolDto } from './dto/reserve.dto';
import { ReserveService } from './reserve.service';
import { ReserveAllocationView, ReservePoolView } from './reserve.types';

/**
 * HTTP surface for the reserve pool (P2-10), scoped to one meal session. Every
 * route requires `reserve:manage` so a non-admin can never reach them; the
 * service then enforces scope over the session's factory, the cutoff rules
 * (configure before cutoff, allocate after), the pool-off rejection, and the
 * atomic over-allocation guard. The controller only wires HTTP to the service.
 */
@Controller('meal-sessions/:mealSessionId/reserve-pool')
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ReserveController {
  constructor(private readonly reserve: ReserveService) {}

  @Get()
  @RequirePermission('reserve:manage')
  getPool(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Param('mealSessionId') mealSessionId: string,
  ): Promise<ReservePoolView[]> {
    return this.reserve.getPool(principal, mealSessionId);
  }

  @Post('dishes/:mealSessionDishId')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('reserve:manage')
  configure(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Param('mealSessionId') mealSessionId: string,
    @Param('mealSessionDishId') mealSessionDishId: string,
    @Body() dto: ConfigureReservePoolDto,
  ): Promise<ReservePoolView> {
    return this.reserve.configurePool(principal, mealSessionId, {
      mealSessionDishId,
      isEnabled: dto.isEnabled,
      quantity: dto.quantity,
    });
  }

  @Post('allocations')
  @RequirePermission('reserve:manage')
  allocate(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Param('mealSessionId') mealSessionId: string,
    @Body() dto: AllocateReserveDto,
  ): Promise<ReserveAllocationView> {
    return this.reserve.allocate(principal, mealSessionId, {
      mealSessionDishId: dto.mealSessionDishId,
      employeeId: dto.employeeId,
      quantity: dto.quantity,
      reason: dto.reason,
    });
  }
}
