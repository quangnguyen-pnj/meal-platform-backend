import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { RequestPrincipal } from '../../common/auth/request-principal';
import { PermissionGuard } from '../../common/authorization/permission.guard';
import { RequirePermission } from '../../common/authorization/require-permission.decorator';
import { MyMealsService } from './my-meals.service';
import { MyMealSessionView } from './registrations.types';

/**
 * Read-only employee surface for the My Meals screen (Flow B). Guarded by
 * `registration:self`, it lets the authenticated employee list THEIR OWN
 * eligible sessions and see the offered dishes WITH names, which the admin
 * meal-session and dish endpoints (behind `meal-session:manage` /
 * `menu:manage`) do not expose to an employee. The controller only wires HTTP;
 * `MyMealsService` resolves the employee from the principal, scopes to their
 * own factory, and shapes the view. Nothing here writes.
 */
@Controller('my-meals')
@UseGuards(JwtAuthGuard, PermissionGuard)
export class MyMealsController {
  constructor(private readonly myMeals: MyMealsService) {}

  @Get('sessions')
  @RequirePermission('registration:self')
  listSessions(
    @CurrentPrincipal() principal: RequestPrincipal,
  ): Promise<MyMealSessionView[]> {
    return this.myMeals.listEligibleSessions(principal);
  }

  @Get('sessions/:mealSessionId')
  @RequirePermission('registration:self')
  getSession(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Param('mealSessionId') mealSessionId: string,
  ): Promise<MyMealSessionView> {
    return this.myMeals.getEligibleSession(principal, mealSessionId);
  }
}
