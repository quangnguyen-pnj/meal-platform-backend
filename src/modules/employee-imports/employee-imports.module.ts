import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EmployeeImportWorkbookService } from './employee-import-workbook.service';
import { EmployeeImportService } from './employee-import.service';
import { EmployeeImportsController } from './employee-imports.controller';

/**
 * Employee Excel import: template download, multipart upload with whole-file
 * validation and row preview, and an atomic, idempotent apply. `AuthModule` is
 * imported for `JwtAuthGuard`; `PermissionGuard`, `ScopeAuthorizer`,
 * `PrismaService`, and `AuditService` come from the global common modules.
 */
@Module({
  imports: [AuthModule],
  controllers: [EmployeeImportsController],
  providers: [EmployeeImportService, EmployeeImportWorkbookService],
})
export class EmployeeImportsModule {}
