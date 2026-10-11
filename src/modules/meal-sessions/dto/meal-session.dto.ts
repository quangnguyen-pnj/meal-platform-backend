import { IsISO8601, IsOptional, IsString, Matches } from 'class-validator';

/**
 * A `YYYY-MM-DD` calendar day in Asia/Ho_Chi_Minh time. `opensAt`/`cutoffAt`
 * are ISO-8601 instants (the time the window opens/closes), stored UTC.
 */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Create meal sessions by deriving them from a PUBLISHED weekly menu. The menu
 * is grouped by `serviceDate` + `mealType` into one session per slot, carrying
 * that slot's dishes into the session. `opensAt`/`cutoffAt` apply to every
 * session created from the menu; per-session timing can be adjusted afterwards
 * while the session is DRAFT.
 */
export class CreateSessionsFromMenuDto {
  @IsString()
  weeklyMenuId!: string;

  @IsISO8601()
  opensAt!: string;

  @IsISO8601()
  cutoffAt!: string;
}

/**
 * Adjust a DRAFT session's opening and/or cutoff instants.
 */
export class UpdateSessionTimingDto {
  @IsOptional()
  @IsISO8601()
  opensAt?: string;

  @IsOptional()
  @IsISO8601()
  cutoffAt?: string;
}

/**
 * Query filter for listing sessions. `factoryId` scopes the list to one
 * factory; `serviceDate` optionally narrows to a single HCM day.
 */
export class ListSessionsQueryDto {
  @IsString()
  factoryId!: string;

  @IsOptional()
  @Matches(DATE_PATTERN, {
    message: 'serviceDate must be a date in YYYY-MM-DD format',
  })
  serviceDate?: string;
}
