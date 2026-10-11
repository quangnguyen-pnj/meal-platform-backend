import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Min,
} from 'class-validator';
import { MealType } from '../../../generated/prisma/enums';

/**
 * A `YYYY-MM-DD` calendar day in Asia/Ho_Chi_Minh time. The service normalises
 * `weekStartDate` to the Monday of its week, so any day in the target week is
 * accepted here.
 */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class CreateWeeklyMenuDto {
  @IsString()
  factoryId!: string;

  @IsString()
  @Matches(DATE_PATTERN, {
    message: 'weekStartDate must be a date in YYYY-MM-DD format',
  })
  weekStartDate!: string;
}

export class AddMenuItemDto {
  @IsString()
  @Matches(DATE_PATTERN, {
    message: 'serviceDate must be a date in YYYY-MM-DD format',
  })
  serviceDate!: string;

  @IsEnum(MealType)
  mealType!: MealType;

  @IsString()
  dishId!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class UpdateMenuItemDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
