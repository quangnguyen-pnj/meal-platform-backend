import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { RequestPrincipal } from '../../common/auth/request-principal';
import { PermissionGuard } from '../../common/authorization/permission.guard';
import { RequirePermission } from '../../common/authorization/require-permission.decorator';
import { BulkRegistrationsService } from './bulk-registrations.service';
import {
  CommitPaperFormDto,
  ValidatePaperFormDto,
} from './dto/paper-form-registration.dto';
import {
  BulkCommitResult,
  BulkValidationResult,
  RegistrationBatchView,
} from './registrations.types';

/**
 * HTTP surface for paper-form batch entry (P2-06). Paper rows are entered
 * through the same bulk-entry grid, so this routes to the SAME
 * `BulkRegistrationsService` commit path with source=PAPER_FORM and a required
 * `paperReference`; it does not fork a parallel implementation. Guarded by
 * `registration:bulk` (same actor and permission as bulk, per the plan). The
 * batch read exposes source/status/paperReference so the paper-form UI (P2-07)
 * can track which forms are entered versus still pending.
 */
@Controller('registration-batches/paper-form')
@UseGuards(JwtAuthGuard, PermissionGuard)
export class PaperFormRegistrationsController {
  constructor(private readonly bulk: BulkRegistrationsService) {}

  @Post('validate')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('registration:bulk')
  validate(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Body() dto: ValidatePaperFormDto,
  ): Promise<BulkValidationResult> {
    return this.bulk.validatePaperForm(
      principal,
      dto.mealSessionId,
      dto.paperReference,
      dto.entries,
    );
  }

  @Post()
  @RequirePermission('registration:bulk')
  commit(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Body() dto: CommitPaperFormDto,
  ): Promise<BulkCommitResult> {
    return this.bulk.commitPaperForm(
      principal,
      dto.mealSessionId,
      dto.paperReference,
      dto.entries,
      dto.reason,
    );
  }

  @Get(':batchId')
  @RequirePermission('registration:bulk')
  getBatch(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Param('batchId') batchId: string,
  ): Promise<RegistrationBatchView> {
    return this.bulk.getBatch(principal, batchId);
  }
}
