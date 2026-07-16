import {
  addDays,
  format,
  isValid,
  parse,
  startOfDay,
  startOfWeek,
  subWeeks,
} from "date-fns";

import type { DateParts, WeekWindow } from "./types";

const ISO_DATE_FORMAT = "yyyy-MM-dd";
const JOBRIGHT_APPLIED_DATE_FORMAT = "MMM d, yyyy";
const BACKUP_TIMESTAMP_FORMAT = "yyyy-MM-dd'T'HH-mm-ss-SSS";

export const formatLocalDate = (date: Date): string => {
  return format(date, ISO_DATE_FORMAT);
};

export const addLocalDays = (date: Date, days: number): Date => {
  return addDays(date, days);
};

export const subtractLocalWeeks = (date: Date, weeks: number): Date => {
  return subWeeks(date, weeks);
};

const toDateParts = (date: Date): DateParts => {
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
  };
};

// Returns the most recent fully completed Sunday-Saturday claim week.
export const getLastCompletedSundayWeek = (now = new Date()): WeekWindow => {
  // Idaho weekly reporting uses the last complete Sunday-Saturday week.
  const today = startOfDay(now);
  const currentSunday = startOfWeek(today, { weekStartsOn: 0 });
  const previousSunday = subtractLocalWeeks(currentSunday, 1);
  const previousSaturday = addLocalDays(currentSunday, -1);

  return {
    claimWeekStart: formatLocalDate(previousSunday),
    claimWeekEnd: formatLocalDate(previousSaturday),
    queryStart: toDateParts(previousSunday),
    queryEndExclusive: toDateParts(currentSunday),
  };
};

export const parseIsoLocalDate = (value: string): Date => {
  const parsed = parse(value.trim(), ISO_DATE_FORMAT, new Date());
  if (!isValid(parsed) || formatLocalDate(parsed) !== value.trim()) {
    throw new Error(`Expected date as YYYY-MM-DD, got "${value}".`);
  }
  return parsed;
};

export const parseJobrightAppliedDate = (value: string): string => {
  const parsed = parse(value.trim(), JOBRIGHT_APPLIED_DATE_FORMAT, new Date());
  if (!isValid(parsed)) {
    throw new Error(`Unable to parse Jobright date: ${value}`);
  }
  return formatLocalDate(parsed);
};

export const formatBackupTimestamp = (date = new Date()): string => {
  return format(date, BACKUP_TIMESTAMP_FORMAT);
};

// Builds all date fields needed from a Sunday claim-week start date.
export const getWeekFromStart = (startIsoDate: string): WeekWindow => {
  const start = parseIsoLocalDate(startIsoDate);
  const endExclusive = addLocalDays(start, 7);
  const endInclusive = addLocalDays(start, 6);

  // Gmail's before: query is exclusive, while the report label is inclusive.
  return {
    claimWeekStart: formatLocalDate(start),
    claimWeekEnd: formatLocalDate(endInclusive),
    queryStart: toDateParts(start),
    queryEndExclusive: toDateParts(endExclusive),
  };
};

// Returns the Sunday-Saturday week that contains today.
export const getCurrentSundayWeek = (now = new Date()): WeekWindow => {
  const today = startOfDay(now);
  const currentSunday = startOfWeek(today, { weekStartsOn: 0 });
  return getWeekFromStart(formatLocalDate(currentSunday));
};
