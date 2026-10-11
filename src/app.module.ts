import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuditModule } from './common/audit/audit.module';
import { AuthorizationModule } from './common/authorization/authorization.module';
import { DatabaseModule } from './common/database/database.module';
import { RequestIdMiddleware } from './common/request-context/request-id.middleware';
import { validateEnv } from './config/env.validation';
import { AuthModule } from './modules/auth/auth.module';
import { EmployeeImportsModule } from './modules/employee-imports/employee-imports.module';
import { HealthModule } from './modules/health/health.module';
import { MealSessionsModule } from './modules/meal-sessions/meal-sessions.module';
import { MenusModule } from './modules/menus/menus.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { RegistrationsModule } from './modules/registrations/registrations.module';
import { ReportsModule } from './modules/reports/reports.module';
import { WorkforceModule } from './modules/workforce/workforce.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),
    DatabaseModule,
    AuthorizationModule,
    AuditModule,
    AuthModule,
    HealthModule,
    OrganizationsModule,
    WorkforceModule,
    EmployeeImportsModule,
    MenusModule,
    MealSessionsModule,
    RegistrationsModule,
    ReportsModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
