/**
 * Operational date helpers for the Asia/Ho_Chi_Minh timezone.
 *
 * Operational dates (a menu's week, a service date) are calendar days in HCM
 * local time, stored as date-only values. HCM is a fixed UTC+7 offset with no
 * daylight saving, so a day in HCM maps to a stable UTC instant and we can
 * compute week boundaries by offsetting rather than pulling in a timezone
 * library. All week-start / service-date logic lives here so the services do
 * not scatter `new Date()` or offset arithmetic. P1-03 adds the full cutoff
 * evaluator on top of these primitives.
 */

/** Fixed UTC offset for Asia/Ho_Chi_Minh (UTC+7, no DST). */
const HCM_OFFSET_MINUTES = 7 * 60;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * A date-only value `YYYY-MM-DD` as interpreted in HCM time. We store it as a
 * `Date` pinned to UTC midnight of that calendar day, which is how Prisma
 * reads back a `@db.Date` column, so comparisons stay exact.
 */
export function hcmDateOnly(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

/**
 * Parse a `YYYY-MM-DD` string into a UTC-midnight `Date`. Throws for anything
 * that is not a real calendar day in that exact format, so a bad input never
 * silently becomes a shifted date.
 */
export function parseHcmDate(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(`Invalid date, expected YYYY-MM-DD: ${value}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = hcmDateOnly(year, month, day);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`Invalid calendar date: ${value}`);
  }
  return date;
}

/** Format a UTC-midnight `Date` back to `YYYY-MM-DD`. */
export function formatHcmDate(date: Date): string {
  const year = date.getUTCFullYear().toString().padStart(4, '0');
  const month = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = date.getUTCDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * The HCM calendar day containing `instant`, as a UTC-midnight date-only value
 * (the same shape Prisma reads back from a `@db.Date` column). `instant`
 * defaults to now. Used to filter "current and upcoming" service dates without
 * scattering offset arithmetic.
 */
export function hcmToday(instant: Date = new Date()): Date {
  const hcm = new Date(instant.getTime() + HCM_OFFSET_MINUTES * 60 * 1000);
  return hcmDateOnly(
    hcm.getUTCFullYear(),
    hcm.getUTCMonth() + 1,
    hcm.getUTCDate(),
  );
}

/**
 * The Monday (in HCM time) of the week containing `instant`, as a UTC-midnight
 * date. `instant` defaults to now. Converting the instant to HCM wall-clock
 * first means a late-Sunday-UTC time that is already Monday in HCM lands on the
 * correct week.
 */
export function hcmWeekStart(instant: Date = new Date()): Date {
  const hcm = new Date(instant.getTime() + HCM_OFFSET_MINUTES * 60 * 1000);
  const dayOfWeek = hcm.getUTCDay(); // 0 = Sunday ... 6 = Saturday
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  return hcmDateOnly(
    hcm.getUTCFullYear(),
    hcm.getUTCMonth() + 1,
    hcm.getUTCDate() - daysSinceMonday,
  );
}

/**
 * The Monday of the week containing a date-only value. Unlike `hcmWeekStart`,
 * the input is already a calendar day (UTC-midnight), so no offset is applied.
 */
export function weekStartOf(date: Date): Date {
  const dayOfWeek = date.getUTCDay();
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  return new Date(date.getTime() - daysSinceMonday * MS_PER_DAY);
}

/** The seven calendar days starting at `weekStart`, as UTC-midnight dates. */
export function weekDays(weekStart: Date): Date[] {
  return Array.from(
    { length: 7 },
    (_unused, index) => new Date(weekStart.getTime() + index * MS_PER_DAY),
  );
}

/**
 * True when `serviceDate` is one of the seven days of the week beginning at
 * `weekStart` (both UTC-midnight date-only values).
 */
export function isWithinWeek(weekStart: Date, serviceDate: Date): boolean {
  const diff = serviceDate.getTime() - weekStart.getTime();
  return diff >= 0 && diff < 7 * MS_PER_DAY;
}
