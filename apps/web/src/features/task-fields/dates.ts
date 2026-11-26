import { daysBetween, formatShortDate } from '~/ui';

// Due dates typed in the picker ("nov 4", "tomorrow", "+3d", "fri", "in 2 weeks", "2026-11-04") and the
// quick picks. Dates are YYYY-MM-DD strings, computed in UTC so no time zone shifts the day.

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
] as const;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

function toUtc(date: string): Date {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function fromUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** `date` plus `days` (negative to go back). */
export function addDays(date: string, days: number): string {
  const next = toUtc(date);
  next.setUTCDate(next.getUTCDate() + days);
  return fromUtc(next);
}

/** `date` plus `months`, clamped to the month's last day (Jan 31 + 1 month = Feb 28). */
export function addMonths(date: string, months: number): string {
  const start = toUtc(date);
  const target = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(start.getUTCDate(), last));
  return fromUtc(target);
}

/** 0 for Sunday … 6 for Saturday. */
export const weekdayOf = (date: string) => toUtc(date).getUTCDay();

/** The next given weekday after `today` (a week on when today is that day). */
export function nextWeekday(today: string, weekday: number): string {
  const diff = (weekday - weekdayOf(today) + 7) % 7;
  return addDays(today, diff === 0 ? 7 : diff);
}

/** "Tue, Nov 3", or "Tue, Nov 3, 2027" outside the current year. */
export function formatDayWithWeekday(date: string, today: string): string {
  return `${WEEKDAY_SHORT[weekdayOf(date)]}, ${formatShortDate(date, today)}`;
}

/** "Today", "Tomorrow", "In 3 days", "Yesterday", "3 days ago". */
export function relativeDay(date: string, today: string): string {
  const days = daysBetween(today, date);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  return days > 1 ? `In ${days} days` : `${-days} days ago`;
}

export interface QuickPick {
  id: 'today' | 'tomorrow' | 'next-week';
  label: string;
  date: string;
}

/** Today, Tomorrow and Next week (the coming Monday). */
export function quickPicks(today: string): QuickPick[] {
  return [
    { id: 'today', label: 'Today', date: today },
    { id: 'tomorrow', label: 'Tomorrow', date: addDays(today, 1) },
    { id: 'next-week', label: 'Next week', date: nextWeekday(today, 1) },
  ];
}

export interface CheckAgainPick {
  id: 'week' | 'two-weeks' | 'month';
  label: string;
  date: string;
}

/** M7: the check-again picker's quick picks: in a week, in two weeks, in a month (frame 095). */
export function checkAgainPicks(today: string): CheckAgainPick[] {
  return [
    { id: 'week', label: 'In a week', date: addDays(today, 7) },
    { id: 'two-weeks', label: 'In two weeks', date: addDays(today, 14) },
    { id: 'month', label: 'In a month', date: addMonths(today, 1) },
  ];
}

function validDate(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12 || day < 1 || year < 1000 || year > 9999) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1) return null;
  return fromUtc(date);
}

function monthOf(word: string): number | null {
  if (word.length < 3) return null;
  const index = MONTHS.findIndex((name) => name.startsWith(word));
  return index < 0 ? null : index + 1;
}

/** Weekday from a prefix of its name: "fr", "fri", "thurs", "friday". */
function weekdayFrom(word: string): number | null {
  if (word.length < 2) return null;
  const index = WEEKDAYS.findIndex((name) => name.startsWith(word));
  return index < 0 ? null : index;
}

/** A month and day without a year: this year, or next year when that's more than 2 months ago. */
function nearestYear(month: number, day: number, today: string): string | null {
  const year = Number(today.slice(0, 4));
  const thisYear = validDate(year, month, day);
  if (thisYear && daysBetween(today, thisYear) >= -60) return thisYear;
  return validDate(year + 1, month, day) ?? thisYear;
}

function addUnit(today: string, amount: number, unit: string): string | null {
  if (/^(d|days?)$/.test(unit)) return addDays(today, amount);
  if (/^(w|wks?|weeks?)$/.test(unit)) return addDays(today, amount * 7);
  if (/^(m|mos?|months?)$/.test(unit)) return addMonths(today, amount);
  return null;
}

/**
 * The date typed in the due-date picker, or null when it doesn't read as one. `today` is YYYY-MM-DD.
 * Reads today, tomorrow, yesterday, next week (the coming Monday), weekdays (the next one), +3d, +2w,
 * +1m, in 3 days, nov 4, 4 nov, nov 4 2027, and 2026-11-04.
 */
export function parseDueText(text: string, today: string): string | null {
  const input = text.trim().toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ');
  if (!input) return null;
  if (input === 'today' || input === 'tod' || input === 'now') return today;
  if (/^(tomorrow|tmrw?|tom|tomo)$/.test(input)) return addDays(today, 1);
  if (input === 'yesterday') return addDays(today, -1);
  if (input === 'next week') return nextWeekday(today, 1);
  if (input === 'next month') return addMonths(today, 1);

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(input);
  if (iso) return validDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const relative = /^(?:\+|in )\s*(\d{1,3})\s*([a-z]+)$/.exec(input);
  if (relative) return addUnit(today, Number(relative[1]), relative[2] ?? '');

  const weekday = /^(?:next |this |on )?([a-z]+)$/.exec(input);
  if (weekday) {
    const day = weekdayFrom(weekday[1] ?? '');
    if (day != null) return nextWeekday(today, day);
  }

  const monthFirst = /^([a-z]+) (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/.exec(input);
  if (monthFirst) {
    const month = monthOf(monthFirst[1] ?? '');
    if (month == null) return null;
    const day = Number(monthFirst[2]);
    return monthFirst[3] ? validDate(Number(monthFirst[3]), month, day) : nearestYear(month, day, today);
  }
  const dayFirst = /^(\d{1,2})(?:st|nd|rd|th)? ([a-z]+)(?: (\d{4}))?$/.exec(input);
  if (dayFirst) {
    const month = monthOf(dayFirst[2] ?? '');
    if (month == null) return null;
    const day = Number(dayFirst[1]);
    return dayFirst[3] ? validDate(Number(dayFirst[3]), month, day) : nearestYear(month, day, today);
  }
  return null;
}
