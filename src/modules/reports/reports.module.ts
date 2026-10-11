import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

/**
 * Phase 1 reporting module (P1-06). It exposes read-only summaries over data
 * other modules already own; it adds no tables. `AuthModule` provides
 * `JwtAuthGuard`; `PermissionGuard`, `ScopeAuthorizer`, and `PrismaService`
 * come from the global common modules. No `AuditService`: reports do not write.
 */
@Module({
  imports: [AuthModule],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
