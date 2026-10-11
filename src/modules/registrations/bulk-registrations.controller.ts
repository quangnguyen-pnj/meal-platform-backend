import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
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
  CommitBulkRegistrationsDto,
  ValidateBulkRegistrationsDto,
} from './dto/bulk-registration.dto';
import { BulkCommitResult, BulkValidationResult } from './registrations.types';

/**
 * HTTP surface for representative/admin bulk registration (P2-04). Every route
 * is guarded by `registration:bulk`; the service bounds every entry to the
 * acting principal's granted scope, so a representative can only register
 * their own team's employees. The controller just wires HTTP to the service,
 * which owns scope checks, whole-batch atomicity, the cutoff check via
 * `MealSessionAccess`, change history, and audit.
 */
@Controller('registration-batches')
@UseGuards(JwtAuthGuard, PermissionGuard)
export class BulkRegistrationsController {
  constructor(private readonly bulk: BulkRegistrationsService) {}

  @Post('validate')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('registration:bulk')
  validate(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Body() dto: ValidateBulkRegistrationsDto,
  ): Promise<BulkValidationResult> {
    return this.bulk.validate(principal, dto.mealSessionId, dto.entries);
  }

  @Post()
  @RequirePermission('registration:bulk')
  commit(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Body() dto: CommitBulkRegistrationsDto,
  ): Promise<BulkCommitResult> {
    return this.bulk.commit(
      principal,
      dto.mealSessionId,
      dto.entries,
      dto.reason,
    );
  }
}
