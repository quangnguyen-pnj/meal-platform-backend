import { Module } from '@nestjs/common';
import { Clock } from '../../common/time/clock';
import { AuthModule } from '../auth/auth.module';
import { MealSessionsModule } from '../meal-sessions/meal-sessions.module';
import { BulkRegistrationsController } from './bulk-registrations.controller';
import { BulkRegistrationsService } from './bulk-registrations.service';
import { MyMealsController } from './my-meals.controller';
import { MyMealsService } from './my-meals.service';
import { PaperFormRegistrationsController } from './paper-form-registrations.controller';
import { RegistrationAdjustmentsController } from './registration-adjustments.controller';
import { RegistrationAdjustmentsService } from './registration-adjustments.service';
import { RegistrationsController } from './registrations.controller';
import { RegistrationsService } from './registrations.service';
import { ReserveController } from './reserve.controller';
import { ReserveService } from './reserve.service';

/**
 * Phase 2 registration module. Self-registration (P2-02) lets an employee
 * create, change, or cancel THEIR OWN registration before cutoff; the My Meals
 * read (`MyMealsService`) is the employee-facing, read-only companion that
 * lists their eligible sessions with dish names so the screen no longer shows a
 * positional label, without exposing the admin meal-session/dish endpoints;
 * bulk registration (P2-04) lets a representative/admin register many
 * employees in their scope as one atomic batch. Paper-form entry (P2-06) is
 * the same batch commit through `BulkRegistrationsService` with
 * source=PAPER_FORM and a required paper reference, so it reuses the bulk
 * scope/atomicity/cutoff/upsert path rather than forking it. The reserve pool
 * (P2-10) is configured by an admin before cutoff and allocated from after it;
 * a reserve allocation is a record SEPARATE from a `MealRegistration`. All are
 * kept here so they share the cutoff check and the change/audit writing pattern.
 *
 * `MealSessionsModule` provides `MealSessionAccess`, the single cutoff
 * authority both services defer to; `AuthModule` provides `JwtAuthGuard`.
 * `PrincipalAuthorizationService`, `ScopeAuthorizer`, `PermissionGuard`,
 * `PrismaService`, and `AuditService` come from the global common modules.
 * `Clock` is the injectable "now" the cutoff check uses.
 */
@Module({
  imports: [AuthModule, MealSessionsModule],
  controllers: [
    RegistrationsController,
    MyMealsController,
    BulkRegistrationsController,
    PaperFormRegistrationsController,
    RegistrationAdjustmentsController,
    ReserveController,
  ],
  providers: [
    RegistrationsService,
    MyMealsService,
    BulkRegistrationsService,
    RegistrationAdjustmentsService,
    ReserveService,
    Clock,
  ],
})
export class RegistrationsModule {}
