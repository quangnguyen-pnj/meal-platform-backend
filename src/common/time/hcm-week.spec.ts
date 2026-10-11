import {
  formatHcmDate,
  hcmWeekStart,
  isWithinWeek,
  parseHcmDate,
  weekDays,
  weekStartOf,
} from './hcm-week';

describe('hcm-week helpers', () => {
  it('parses and formats a date round-trip', () => {
    const date = parseHcmDate('2025-03-12');
    expect(formatHcmDate(date)).toBe('2025-03-12');
  });

  it('rejects a malformed or impossible date', () => {
    expect(() => parseHcmDate('2025-3-12')).toThrow();
    expect(() => parseHcmDate('2025-02-30')).toThrow();
    expect(() => parseHcmDate('not-a-date')).toThrow();
  });

  it('finds the Monday of a mid-week date', () => {
    // 2025-03-12 is a Wednesday; its week starts Monday 2025-03-10.
    expect(formatHcmDate(weekStartOf(parseHcmDate('2025-03-12')))).toBe(
      '2025-03-10',
    );
    // A Monday maps to itself.
    expect(formatHcmDate(weekStartOf(parseHcmDate('2025-03-10')))).toBe(
      '2025-03-10',
    );
    // A Sunday belongs to the week that started the previous Monday.
    expect(formatHcmDate(weekStartOf(parseHcmDate('2025-03-16')))).toBe(
      '2025-03-10',
    );
  });

  it('computes the HCM week start of an instant, honouring the +7 offset', () => {
    // 2025-03-09 is a Sunday. 18:00Z is already Monday 01:00 in HCM, so the
    // week start is Monday 2025-03-10, not the previous Monday.
    const instant = new Date('2025-03-09T18:00:00.000Z');
    expect(formatHcmDate(hcmWeekStart(instant))).toBe('2025-03-10');
  });

  it('lists the seven days of a week', () => {
    const start = parseHcmDate('2025-03-10');
    expect(weekDays(start).map(formatHcmDate)).toEqual([
      '2025-03-10',
      '2025-03-11',
      '2025-03-12',
      '2025-03-13',
      '2025-03-14',
      '2025-03-15',
      '2025-03-16',
    ]);
  });

  it('tells whether a service date is inside a week', () => {
    const start = parseHcmDate('2025-03-10');
    expect(isWithinWeek(start, parseHcmDate('2025-03-10'))).toBe(true);
    expect(isWithinWeek(start, parseHcmDate('2025-03-16'))).toBe(true);
    expect(isWithinWeek(start, parseHcmDate('2025-03-17'))).toBe(false);
    expect(isWithinWeek(start, parseHcmDate('2025-03-09'))).toBe(false);
  });
});
