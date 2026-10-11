import { IsString } from 'class-validator';

/**
 * Create or change the current employee's pick for a meal session (P2-02).
 * The acting employee is always the principal's own linked employee; the body
 * only names the dish being chosen. `mealSessionDishId` must be one of the
 * session's offered dishes.
 */
export class SelfRegistrationDto {
  @IsString()
  mealSessionDishId!: string;
}
