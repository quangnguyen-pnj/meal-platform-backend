import { IsOptional, IsString } from 'class-validator';

/**
 * Cancel or mark-absent an existing registration (P2-08). Both act on the
 * registration named in the path, never on an employee id from the body, so
 * the only field is an optional reason. The service decides whether that
 * reason is required: a reason is mandatory for any change made AFTER cutoff,
 * and that rule lives in the service with the single cutoff authority, not in
 * the DTO (so a missing reason is a VALIDATION_ERROR with the real cause).
 */
export class RegistrationActionDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

/**
 * Post-cutoff adjustment of an existing registration by a Meal Admin (P2-08):
 * change the chosen dish and/or set the status to REGISTERED/CANCELLED/ABSENT.
 * `reason` is required for a post-cutoff change; the service enforces that
 * against the live window rather than trusting the client. `mealSessionDishId`
 * and `status` are optional so the caller can change one, the other, or both.
 */
export class AdjustRegistrationDto {
  @IsOptional()
  @IsString()
  mealSessionDishId?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  reason?: string;
}
