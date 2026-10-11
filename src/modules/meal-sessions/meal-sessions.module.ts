import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MealSessionAccess } from './meal-session-access.service';
import { MealSessionsController } from './meal-sessions.controller';
import { MealSessionsService } from './meal-sessions.service';

/**
 * Phase 1 meal-session module (P1-03). Sessions are derived from published
 * weekly menus and run through a DRAFT -> PUBLISHED -> OPEN -> CLOSED lifecycle
 * (CANCELLED from any non-terminal state). `MealSessionAccess` is the single
 * cutoff evaluator, exported so Phase 2 registration can reuse the one
 * implementation of "is this session open". `AuthModule` provides
 * `JwtAuthGuard`; `PermissionGuard`, `ScopeAuthorizer`, `PrismaService`, and
 * `AuditService` come from the global common modules.
 */
@Module({
  imports: [AuthModule],
  controllers: [MealSessionsController],
  providers: [MealSessionsService, MealSessionAccess],
  exports: [MealSessionAccess],
})
export class MealSessionsModule {}
