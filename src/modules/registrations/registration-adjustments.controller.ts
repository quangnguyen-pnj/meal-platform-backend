import {
  Body,
  Controller,
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
import {
  AdjustRegistrationDto,
  RegistrationActionDto,
} from './dto/adjust-registration.dto';
import { RegistrationAdjustmentsService } from './registration-adjustments.service';
import { MealRegistrationView } from './registrations.types';

/**
 * HTTP surface for operator-side registration changes (P2-08): cancelling,
 * marking absent, and the post-cutoff adjustment of an EXISTING registration
 * named by its id. The guard requires `registration:adjust` so a non-admin can
 * never reach these routes; the service then enforces the finer rule - a Meal
 * Admin may act in either window, but after cutoff only with a reason - plus
 * scope over the registration's employee. The controller only wires HTTP to the
 * service.
 */
@Controller('meal-registrations/:id')
@UseGuards(JwtAuthGuard, PermissionGuard)
export class RegistrationAdjustmentsController {
  constructor(private readonly adjustments: RegistrationAdjustmentsService) {}

  @Post('cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('registration:adjust')
  cancel(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Param('id') id: string,
    @Body() dto: RegistrationActionDto,
  ): Promise<MealRegistrationView> {
    return this.adjustments.cancel(principal, id, dto.reason);
  }

  @Post('mark-absent')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('registration:adjust')
  markAbsent(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Param('id') id: string,
    @Body() dto: RegistrationActionDto,
  ): Promise<MealRegistrationView> {
    return this.adjustments.markAbsent(principal, id, dto.reason);
  }

  @Post('adjust')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('registration:adjust')
  adjust(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Param('id') id: string,
    @Body() dto: AdjustRegistrationDto,
  ): Promise<MealRegistrationView> {
    return this.adjustments.adjust(principal, id, {
      mealSessionDishId: dto.mealSessionDishId,
      status: dto.status,
      reason: dto.reason,
    });
  }
}
