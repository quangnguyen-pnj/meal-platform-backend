import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkforceController } from './workforce.controller';
import { WorkforceService } from './workforce.service';

/**
 * Workforce CRUD (employees), optional account linking, and role/scope grants.
 * `AuthModule` is imported for `JwtAuthGuard`; `PermissionGuard`,
 * `ScopeAuthorizer`, `PrismaService`, and `AuditService` all come from the
 * global common modules.
 */
@Module({
  imports: [AuthModule],
  controllers: [WorkforceController],
  providers: [WorkforceService],
})
export class WorkforceModule {}
