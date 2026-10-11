import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MenusController } from './menus.controller';
import { MenusService } from './menus.service';
import { WeeklyMenuController } from './weekly-menu.controller';
import { WeeklyMenuService } from './weekly-menu.service';

/**
 * Phase 1 menu module: the organization-level dish catalog (P1-01) and the
 * factory weekly menus built from it (P1-02). `AuthModule` is imported for
 * `JwtAuthGuard`; `PermissionGuard`, `ScopeAuthorizer`, `PrismaService`, and
 * `AuditService` all come from the global common modules.
 */
@Module({
  imports: [AuthModule],
  controllers: [MenusController, WeeklyMenuController],
  providers: [MenusService, WeeklyMenuService],
})
export class MenusModule {}
