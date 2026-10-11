import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OrganizationsController } from './organizations.controller';
import { OrganizationsService } from './organizations.service';

/**
 * Tenant-tree CRUD (factories, departments, teams) plus the scope tree read.
 * `AuthModule` is imported for `JwtAuthGuard`; `PermissionGuard`,
 * `ScopeAuthorizer`, `PrismaService`, and `AuditService` all come from the
 * global common modules.
 */
@Module({
  imports: [AuthModule],
  controllers: [OrganizationsController],
  providers: [OrganizationsService],
})
export class OrganizationsModule {}
