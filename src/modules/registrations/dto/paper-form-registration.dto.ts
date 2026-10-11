import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

/**
 * One staged row of a paper form (P2-06): the same shape as a bulk entry (an
 * employee plus either a chosen dish or an explicit not-eating opt-out), with
 * an optional `rowNumber` so the stored entries keep the order of the paper
 * sheet. The service enforces the dish-XOR-notEating rule and reports a
 * malformed row as an INVALID entry rather than rejecting the whole request.
 */
export class PaperFormEntryDto {
  @IsString()
  employeeId!: string;

  @IsOptional()
  @IsString()
  mealSessionDishId?: string;

  @IsOptional()
  @IsBoolean()
  notEating?: boolean;

  @IsOptional()
  @IsInt()
  rowNumber?: number;
}

/**
 * Validate (preview) a paper-form batch for a session without writing anything
 * (P2-06). Requires a non-empty `paperReference` up front - a paper batch is
 * meaningless without the form it transcribes - so the UI cannot build a batch
 * that the commit would then reject.
 */
export class ValidatePaperFormDto {
  @IsString()
  mealSessionId!: string;

  @IsString()
  @IsNotEmpty()
  paperReference!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PaperFormEntryDto)
  entries!: PaperFormEntryDto[];
}

/**
 * Commit a paper-form batch for a session as one unit (P2-06). The service
 * reuses the bulk commit path: it validates every entry first and writes
 * nothing if any is invalid, then upserts on `[mealSessionId, employeeId]` so
 * re-entering the same form corrects rather than duplicates. `paperReference`
 * is required and persisted on the batch; `reason` is an optional note.
 */
export class CommitPaperFormDto {
  @IsString()
  mealSessionId!: string;

  @IsString()
  @IsNotEmpty()
  paperReference!: string;

  @IsOptional()
  @IsString()
  reason?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PaperFormEntryDto)
  entries!: PaperFormEntryDto[];
}
