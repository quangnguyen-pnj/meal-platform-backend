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
import { SelfRegistrationDto } from './dto/self-registration.dto';
import { RegistrationsService } from './registrations.service';
import { MealRegistrationView } from './registrations.types';

/**
 * HTTP surface for self-registration (P2-02). Every route is guarded by
 * `registration:self` and only ever acts on the principal's own employee; the
 * employee id is never read from the request. The controller just wires HTTP
 * to the service, which owns the one-record-per-session rule, the cutoff check
 * via `MealSessionAccess`, change history, and audit.
 */
@Controller('meal-sessions/:mealSessionId/registrations/self')
@UseGuards(JwtAuthGuard, PermissionGuard)
export class RegistrationsController {
  constructor(private readonly registrations: RegistrationsService) {}

  @Get()
  @RequirePermission('registration:self')
  getSelf(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Param('mealSessionId') mealSessionId: string,
  ): Promise<MealRegistrationView | null> {
    return this.registrations.getSelfRegistration(principal, mealSessionId);
  }

  @Post()
  @RequirePermission('registration:self')
  upsertSelf(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Param('mealSessionId') mealSessionId: string,
    @Body() dto: SelfRegistrationDto,
  ): Promise<MealRegistrationView> {
    return this.registrations.upsertSelfRegistration(
      principal,
      mealSessionId,
      dto.mealSessionDishId,
    );
  }

  @Post('cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('registration:self')
  cancelSelf(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Param('mealSessionId') mealSessionId: string,
  ): Promise<MealRegistrationView> {
    return this.registrations.cancelSelfRegistration(principal, mealSessionId);
  }
}
