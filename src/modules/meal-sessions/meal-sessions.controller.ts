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
import {
  CreateSessionsFromMenuDto,
  ListSessionsQueryDto,
  UpdateSessionTimingDto,
} from './dto/meal-session.dto';
import { MealSessionsService } from './meal-sessions.service';
import { MealSessionView } from './meal-sessions.types';

/**
 * HTTP surface for factory meal sessions (P1-03). The controller only wires
 * requests to the service and declares the `meal-session:manage` permission
 * each route needs; the service owns derivation from a published menu, the
 * one-session-per-factory/date/meal rule, factory-scope checks, lifecycle
 * transitions, and audit. Whether registration is open is decided by the
 * `MealSessionAccess` boundary and surfaced on each view.
 */
@Controller('meal-sessions')
@UseGuards(JwtAuthGuard, PermissionGuard)
export class MealSessionsController {
  constructor(private readonly sessions: MealSessionsService) {}

  @Get()
  @RequirePermission('meal-session:manage')
  listSessions(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Query() query: ListSessionsQueryDto,
  ): Promise<MealSessionView[]> {
    return this.sessions.listSessions(
      principal,
      query.factoryId,
      query.serviceDate,
    );
  }

  @Get(':id')
  @RequirePermission('meal-session:manage')
  getSession(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Param('id') id: string,
  ): Promise<MealSessionView> {
    return this.sessions.getSession(principal, id);
  }

  @Post()
  @RequirePermission('meal-session:manage')
  createSessionsFromMenu(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Body() dto: CreateSessionsFromMenuDto,
  ): Promise<MealSessionView[]> {
    return this.sessions.createSessionsFromMenu(principal, dto);
  }

  @Patch(':id/timing')
  @RequirePermission('meal-session:manage')
  updateTiming(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Param('id') id: string,
    @Body() dto: UpdateSessionTimingDto,
  ): Promise<MealSessionView> {
    return this.sessions.updateTiming(principal, id, dto);
  }

  @Post(':id/publish')
  @RequirePermission('meal-session:manage')
  publishSession(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Param('id') id: string,
  ): Promise<MealSessionView> {
    return this.sessions.publishSession(principal, id);
  }

  @Post(':id/open')
  @RequirePermission('meal-session:manage')
  openSession(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Param('id') id: string,
  ): Promise<MealSessionView> {
    return this.sessions.openSession(principal, id);
  }

  @Post(':id/close')
  @RequirePermission('meal-session:manage')
  closeSession(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Param('id') id: string,
  ): Promise<MealSessionView> {
    return this.sessions.closeSession(principal, id);
  }

  @Post(':id/cancel')
  @RequirePermission('meal-session:manage')
  cancelSession(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Param('id') id: string,
  ): Promise<MealSessionView> {
    return this.sessions.cancelSession(principal, id);
  }
}
