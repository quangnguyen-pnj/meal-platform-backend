/**
 * DTO-shaped view returned by the dish endpoints. The service maps Prisma rows
 * to this so responses never leak columns the API has not committed to, and so
 * the shape stays stable if the schema grows.
 */
export interface DishView {
  id: string;
  organizationId: string;
  code: string;
  name: string;
  description: string | null;
  category: string | null;
  dietaryTags: string[];
  isActive: boolean;
}

import { MealType, WeeklyMenuStatus } from '../../generated/prisma/enums';

/**
 * One dish slot inside a weekly menu, flattened for the API. Dates are emitted
 * as `YYYY-MM-DD` so clients never deal with timezone-shifted timestamps.
 */
export interface MenuItemView {
  id: string;
  weeklyMenuId: string;
  serviceDate: string;
  mealType: MealType;
  dishId: string;
  sortOrder: number;
}

/**
 * A factory's weekly menu with its items. `weekStartDate` is the Monday of the
 * week in HCM time, emitted as `YYYY-MM-DD`.
 */
export interface WeeklyMenuView {
  id: string;
  organizationId: string;
  factoryId: string;
  weekStartDate: string;
  status: WeeklyMenuStatus;
  publishedAt: string | null;
  publishedByUserId: string | null;
  items: MenuItemView[];
}
