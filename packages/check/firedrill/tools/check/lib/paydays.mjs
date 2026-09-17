// Pay schedule payday generation and approval deadlines. Business days are Monday–Friday; no holidays are modelled.
import { DAY_MS, addMonths, civilFromDays, formatDate, formatStamp, monthLength, parseDate, weekday } from "./dates.mjs";

export const PERIODS_PER_YEAR = { weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12, quarterly: 4, annually: 1 };
export const FREQUENCIES = Object.keys(PERIODS_PER_YEAR);
export const PROCESSING_DAYS = { one_day: 1, two_day: 2, three_day: 3 };
const MONTH_STEP = { monthly: 1, quarterly: 3, annually: 12 };
const MAX_ITERATIONS = 12000;

/** Approval deadline (ms) = `processing` business days before `payday` at 21:00Z. */
export function approvalDeadlineMs(paydayDays, processingPeriod) {
  const count = PROCESSING_DAYS[processingPeriod] ?? 2;
  let day = paydayDays;
  let seen = 0;
  while (seen < count) {
    day -= 1;
    const w = weekday(day);
    if (w !== 0 && w !== 6) seen += 1;
  }
  return day * DAY_MS + 21 * 3600000;
}

/** Semimonthly second payday of a month (clamped to month end). */
const secondDay = (schedule, y, m) => Math.min(schedule.second_payday ?? 31, monthLength(y, m));

/** Unadjusted n-th payday (n ≥ -1) of a schedule, as a day number. */
export function unadjusted(schedule, n) {
  const first = parseDate(schedule.first_payday);
  switch (schedule.pay_frequency) {
    case "weekly": return first + 7 * n;
    case "biweekly": return first + 14 * n;
    case "semimonthly": {
      const base = civilFromDays(first);
      const t = (base.day === 15 ? 0 : 1) + n;
      const months = Math.floor(t / 2);
      const target = addMonths(first, months, 1);
      const c = civilFromDays(target);
      return t - months * 2 === 0 ? target + 14 : target + secondDay(schedule, c.year, c.month) - 1;
    }
    default: {
      const base = civilFromDays(first);
      return addMonths(first, MONTH_STEP[schedule.pay_frequency] * n, base.day);
    }
  }
}

/** Saturday and Sunday paydays move to the Friday before. */
export function adjust(day) {
  const w = weekday(day);
  return w === 6 ? day - 1 : w === 0 ? day - 2 : day;
}

export function paydayEntry(schedule, processingPeriod, n) {
  const offset = parseDate(schedule.first_payday) - parseDate(schedule.first_period_end);
  const raw = unadjusted(schedule, n);
  const payday = adjust(raw);
  const deadline = approvalDeadlineMs(payday, processingPeriod);
  return {
    payday: formatDate(payday),
    period_start: formatDate(unadjusted(schedule, n - 1) - offset + 1),
    period_end: formatDate(raw - offset),
    approval_deadline: formatDate(Math.floor(deadline / DAY_MS)),
    approval_deadline_datetime: formatStamp(deadline),
    impacted_by_weekend_or_holiday: payday !== raw,
    _day: payday,
  };
}

/** Entries whose adjusted payday is within [startDay, endDay], in order. */
export function paydaysBetween(schedule, processingPeriod, startDay, endDay) {
  const out = [];
  for (let n = 0; n < MAX_ITERATIONS; n++) {
    const raw = unadjusted(schedule, n);
    if (raw - 2 > endDay) break;
    const day = adjust(raw);
    if (day < startDay || day > endDay) continue;
    const { _day, ...entry } = paydayEntry(schedule, processingPeriod, n);
    out.push(entry);
  }
  return out;
}

/** True when `paydayDay` is one of the schedule's adjusted paydays. */
export function isSchedulePayday(schedule, paydayDay) {
  for (let n = 0; n < MAX_ITERATIONS; n++) {
    const raw = unadjusted(schedule, n);
    if (adjust(raw) === paydayDay) return true;
    if (raw - 2 > paydayDay) return false;
  }
  return false;
}
