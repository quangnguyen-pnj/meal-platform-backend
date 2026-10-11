import {
  Controller,
  Get,
  Param,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { RequestPrincipal } from '../../common/auth/request-principal';
import { PermissionGuard } from '../../common/authorization/permission.guard';
import { RequirePermission } from '../../common/authorization/require-permission.decorator';
import { AppError } from '../../common/errors/app-error';
import { EmployeeImportService } from './employee-import.service';
import {
  ImportApplyResult,
  ImportJobView,
  ImportRowView,
} from './employee-imports.types';

/**
 * The minimal shape of a Multer upload the controller needs. Declared locally
 * so the module does not depend on the `Express.Multer.File` ambient type.
 */
interface UploadedExcelFile {
  originalname: string;
  buffer: Buffer;
}

const TEMPLATE_FILENAME = 'employee-import-template.xlsx';
const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * HTTP surface for the employee import flow. The controller only wires requests
 * to the service and declares the `employee:import` permission each route
 * needs; the service owns parsing, whole-file validation, scope checks, the
 * atomic upsert, and audit. The template is served from the backend so its
 * columns stay the single source of truth for the uploader.
 */
@Controller('employee-imports')
@UseGuards(JwtAuthGuard, PermissionGuard)
export class EmployeeImportsController {
  constructor(private readonly imports: EmployeeImportService) {}

  @Get('template')
  @RequirePermission('employee:import')
  async downloadTemplate(@Res() res: Response): Promise<void> {
    const buffer = await this.imports.buildTemplate();
    res.setHeader('Content-Type', XLSX_CONTENT_TYPE);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${TEMPLATE_FILENAME}"`,
    );
    res.send(buffer);
  }

  @Post()
  @RequirePermission('employee:import')
  @UseInterceptors(FileInterceptor('file'))
  uploadAndValidate(
    @CurrentPrincipal() principal: RequestPrincipal,
    @UploadedFile() file?: UploadedExcelFile,
  ): Promise<ImportJobView> {
    if (!file) {
      throw new AppError(
        'VALIDATION_ERROR',
        'A workbook file is required in the "file" field.',
      );
    }
    return this.imports.uploadAndValidate(principal, file);
  }

  @Get(':id')
  @RequirePermission('employee:import')
  getJob(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Param('id') id: string,
  ): Promise<ImportJobView> {
    return this.imports.getJob(principal, id);
  }

  @Get(':id/rows')
  @RequirePermission('employee:import')
  getJobRows(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Param('id') id: string,
  ): Promise<ImportRowView[]> {
    return this.imports.getJobRows(principal, id);
  }

  @Post(':id/apply')
  @RequirePermission('employee:import')
  apply(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Param('id') id: string,
  ): Promise<ImportApplyResult> {
    return this.imports.apply(principal, id);
  }
}
