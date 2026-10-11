import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

/**
 * One staged row in a bulk batch (P2-04): an employee plus either the dish
 * they chose or an explicit not-eating opt-out. The service enforces that an
 * entry carries exactly one of the two (a dish XOR `notEating`); the DTO only
 * checks shapes so the service can report a malformed row as an INVALID entry
 * rather than rejecting the whole request.
 */
export class BulkEntryDto {
  @IsString()
  employeeId!: string;

  @IsOptional()
  @IsString()
  mealSessionDishId?: string;

  @IsOptional()
  @IsBoolean()
  notEating?: boolean;
}

/**
 * Validate (preview) a set of bulk entries for a session without writing
 * anything. Returns per-row verdicts, totals by dish, and the unselected
 * count so the UI can force a confirmation before commit (P2-05).
 */
export class ValidateBulkRegistrationsDto {
  @IsString()
  mealSessionId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BulkEntryDto)
  entries!: BulkEntryDto[];
}

/**
 * Commit a set of bulk entries for a session as one batch (P2-04). The service
 * validates every entry first; if any is invalid the commit writes nothing.
 * `reason` is an optional note stored on the batch.
 */
export class CommitBulkRegistrationsDto {
  @IsString()
  mealSessionId!: string;

  @IsOptional()
  @IsString()
  reason?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BulkEntryDto)
  entries!: BulkEntryDto[];
}
