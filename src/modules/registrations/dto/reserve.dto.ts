import { IsBoolean, IsInt, IsOptional, IsString, Min } from 'class-validator';

/**
 * Configure a session dish's reserve pool before cutoff (P2-10): turn the pool
 * on or off and set its fixed quantity. Reserve is OFF by default, so a session
 * dish with no configuration has no pool. `quantity` is a non-negative integer;
 * the service rejects a configuration change once the window is closed, so the
 * fixed pool size is locked at cutoff.
 */
export class ConfigureReservePoolDto {
  @IsBoolean()
  isEnabled!: boolean;

  @IsInt()
  @Min(0)
  quantity!: number;
}

/**
 * Allocate from a session dish's reserve pool after cutoff (P2-10). Only an
 * admin with `reserve:manage` may allocate; the service enforces that the pool
 * is enabled and that the allocation does not exceed the remaining quantity,
 * atomically. `employeeId` is the recipient when known (optional for an
 * unassigned reserve), `quantity` defaults to 1, and `reason` is required so
 * every allocation records why it was made.
 */
export class AllocateReserveDto {
  @IsString()
  mealSessionDishId!: string;

  @IsOptional()
  @IsString()
  employeeId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  quantity?: number;

  @IsString()
  reason!: string;
}
