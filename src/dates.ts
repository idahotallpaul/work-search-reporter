import type { DateParts, WeekWindow } from "./types";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export const formatLocalDate = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const startOfLocalDay = (date: Date): Date => {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
};

const addDays = (date: Date, days: number): Date => {
  return new Date(date.getTime() + days * ONE_DAY_MS);
};

const toDateParts = (date: Date): DateParts => {
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
  };
};

export const getLastCompletedSundayWeek = (now = new Date()): WeekWindow => {
  const today = startOfLocalDay(now);
  const currentDow = today.getDay();
  const currentSunday = addDays(today, -currentDow);
  const previousSunday = addDays(currentSunday, -7);
  const previousSaturday = addDays(currentSunday, -1);

  return {
    claimWeekStart: formatLocalDate(previousSunday),
    claimWeekEnd: formatLocalDate(previousSaturday),
    queryStart: toDateParts(previousSunday),
    queryEndExclusive: toDateParts(currentSunday),
  };
};

export const parseIsoLocalDate = (value: string): Date => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(`Expected date as YYYY-MM-DD, got "${value}".`);
  }
  const [, year, month, day] = match;
  return new Date(Number(year), Number(month) - 1, Number(day));
};

export const getWeekFromStart = (startIsoDate: string): WeekWindow => {
  const start = parseIsoLocalDate(startIsoDate);
  const endExclusive = addDays(start, 7);
  const endInclusive = addDays(start, 6);

  return {
    claimWeekStart: formatLocalDate(start),
    claimWeekEnd: formatLocalDate(endInclusive),
    queryStart: toDateParts(start),
    queryEndExclusive: toDateParts(endExclusive),
  };
};

export const getCurrentSundayWeek = (now = new Date()): WeekWindow => {
  const today = startOfLocalDay(now);
  const currentSunday = addDays(today, -today.getDay());
  return getWeekFromStart(formatLocalDate(currentSunday));
};
