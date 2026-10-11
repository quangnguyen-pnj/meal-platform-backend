import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { RequestPrincipal } from '../../common/auth/request-principal';
import { PermissionGuard } from '../../common/authorization/permission.guard';
import { RequirePermission } from '../../common/authorization/require-permission.decorator';
import { ReportsService } from './reports.service';
import { SessionSummaryView } from './reports.types';

/**
 * HTTP surface for Phase 1 read-only reports (P1-06). The controller only wires
 * the request to the service and declares the `report:read` permission the
 * route needs; the service owns the read, the dish-code resolution, and the
 * factory-scope check. There are no write routes here: a report is a pure read.
 */
@Controller('reports')
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('meal-sessions/:id/summary')
  @RequirePermission('report:read')
  getSessionSummary(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Param('id') id: string,
  ): Promise<SessionSummaryView> {
    return this.reports.getSessionSummary(principal, id);
  }
}
