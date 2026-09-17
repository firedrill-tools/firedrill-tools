// RRULE / EXDATE / RDATE subset (RFC 5545) with bounded, chronological expansion.
import {
  DAY_MS,
  addDays,
  addMonths,
  compareDates,
  dateKey,
  dateStamp,
  dateToMs,
  daysInMonth,
  msToDate,
  instanceStamp,
  isZone,
  nthWeekdayOfMonth,
  parseStamp,
  weekdayOf,
  zonedParts,
  zonedToMs,
  utcMs,
} from "./time.mjs";

export class RecurrenceError extends Error {}

// Null-prototype table looked up only with Object.hasOwn: caller text such as WKST=__proto__ or WKST=constructor must miss.
const WEEKDAYS = Object.freeze(Object.assign(Object.create(null), { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 }));
const FREQUENCIES = new Set(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]);
const MAX_STEPS = 200_000;
const TWO_YEARS_MS = 731 * DAY_MS;
// A rule whose periods produce no day this many times in a row never will (e.g. BYMONTHDAY=31 every 12 months from April).
const MAX_EMPTY_PERIODS = 600;

function parseByDay(text, frequency) {
  const entries = text.split(",").map((item) => {
    const match = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(item);
    if (match === null) throw new RecurrenceError(`Unsupported recurrence rule: BYDAY value ${item}`);
    return { ordinal: match[1] === undefined ? 0 : Number(match[1]), weekday: WEEKDAYS[match[2]] };
  }).filter((entry, index, all) => all.findIndex((other) => other.ordinal === entry.ordinal && other.weekday === entry.weekday) === index);
  if (frequency === "WEEKLY" || frequency === "DAILY") {
    if (entries.some((entry) => entry.ordinal !== 0)) throw new RecurrenceError("Unsupported recurrence rule: ordinal BYDAY needs FREQ=MONTHLY");
    return entries;
  }
  if (frequency === "MONTHLY") {
    if (entries.length !== 1 || entries[0].ordinal === 0 || Math.abs(entries[0].ordinal) > 5) {
      throw new RecurrenceError("Unsupported recurrence rule: monthly BYDAY needs exactly one ordinal weekday such as 2TU or -1FR");
    }
    return entries;
  }
  throw new RecurrenceError("Unsupported recurrence rule: BYDAY is not supported with FREQ=YEARLY");
}

function parseRule(text) {
  const rule = { freq: null, interval: 1, count: null, until: null, byDay: null, byMonthDay: null, byMonth: null, wkst: 1 };
  for (const part of text.split(";")) {
    if (part.length === 0) continue;
    const separator = part.indexOf("=");
    if (separator < 1) throw new RecurrenceError(`Unsupported recurrence rule: ${part}`);
    const key = part.slice(0, separator).toUpperCase();
    const value = part.slice(separator + 1);
    switch (key) {
      case "FREQ":
        if (!FREQUENCIES.has(value)) throw new RecurrenceError(`Unsupported recurrence rule: FREQ=${value}`);
        rule.freq = value;
        break;
      case "INTERVAL":
        if (!/^[1-9]\d{0,3}$/.test(value)) throw new RecurrenceError("Unsupported recurrence rule: INTERVAL must be a positive integer");
        rule.interval = Number(value);
        break;
      case "COUNT":
        if (!/^[1-9]\d{0,5}$/.test(value)) throw new RecurrenceError("Unsupported recurrence rule: COUNT must be a positive integer");
        rule.count = Number(value);
        break;
      case "UNTIL": {
        const stamp = parseStamp(value);
        if (stamp === null) throw new RecurrenceError("Unsupported recurrence rule: UNTIL must be YYYYMMDD or YYYYMMDDTHHMMSSZ");
        rule.until = stamp;
        break;
      }
      case "BYDAY":
        rule.byDay = value;
        break;
      case "BYMONTHDAY":
        if (!/^(-?[1-9]|-?[12]\d|-?3[01])$/.test(value) || Number(value) < 0) {
          throw new RecurrenceError("Unsupported recurrence rule: BYMONTHDAY needs a single day 1-31");
        }
        rule.byMonthDay = Number(value);
        break;
      case "BYMONTH":
        if (!/^([1-9]|1[0-2])$/.test(value)) throw new RecurrenceError("Unsupported recurrence rule: BYMONTH needs a single month 1-12");
        rule.byMonth = Number(value);
        break;
      case "WKST":
        if (!Object.hasOwn(WEEKDAYS, value)) throw new RecurrenceError(`Unsupported recurrence rule: WKST=${value.slice(0, 40)}`);
        rule.wkst = WEEKDAYS[value];
        break;
      default:
        throw new RecurrenceError(`Unsupported recurrence rule: ${key}`);
    }
  }
  if (rule.freq === null) throw new RecurrenceError("Unsupported recurrence rule: FREQ is required");
  if (rule.count !== null && rule.until !== null) throw new RecurrenceError("Unsupported recurrence rule: COUNT and UNTIL are exclusive");
  if (rule.byDay !== null) rule.byDay = parseByDay(rule.byDay, rule.freq);
  if (rule.byMonthDay !== null && rule.freq !== "MONTHLY" && rule.freq !== "YEARLY") {
    throw new RecurrenceError("Unsupported recurrence rule: BYMONTHDAY needs FREQ=MONTHLY or YEARLY");
  }
  if (rule.byMonth !== null && rule.freq !== "YEARLY") throw new RecurrenceError("Unsupported recurrence rule: BYMONTH needs FREQ=YEARLY");
  if (rule.byMonthDay !== null && rule.byDay !== null) throw new RecurrenceError("Unsupported recurrence rule: BYDAY and BYMONTHDAY are exclusive");
  return rule;
}

function parseDateList(line, kind) {
  const separator = line.indexOf(":");
  if (separator < 0) throw new RecurrenceError(`Unsupported recurrence rule: ${kind} needs a value`);
  const parameters = line.slice(kind.length, separator);
  let tzid = null;
  let dateOnly = false;
  for (const parameter of parameters.split(";")) {
    if (parameter.length === 0) continue;
    const [name, value] = parameter.split("=");
    if (name === "TZID") {
      if (!isZone(value)) throw new RecurrenceError(`Invalid time zone in ${kind}: ${value}`);
      tzid = value;
    } else if (name === "VALUE") {
      if (value === "DATE") dateOnly = true;
      else if (value !== "DATE-TIME") throw new RecurrenceError(`Unsupported recurrence rule: ${kind};VALUE=${value}`);
    } else {
      throw new RecurrenceError(`Unsupported recurrence rule: ${kind} parameter ${name}`);
    }
  }
  return line
    .slice(separator + 1)
    .split(",")
    .map((value) => {
      const stamp = parseStamp(value);
      if (stamp === null) throw new RecurrenceError(`Unsupported recurrence rule: ${kind} value ${value}`);
      if (dateOnly && stamp.kind !== "date") throw new RecurrenceError(`Unsupported recurrence rule: ${kind};VALUE=DATE needs YYYYMMDD values`);
      return { ...stamp, tzid };
    });
}

/** Parse Google's `recurrence` string array. */
export function parseRecurrence(lines) {
  const parsed = { rule: null, exdates: [], rdates: [] };
  for (const raw of lines) {
    const line = String(raw).trim();
    if (line.toUpperCase().startsWith("RRULE:")) {
      if (parsed.rule !== null) throw new RecurrenceError("Unsupported recurrence rule: more than one RRULE");
      parsed.rule = parseRule(line.slice(6));
    } else if (line.toUpperCase().startsWith("EXDATE")) {
      parsed.exdates.push(...parseDateList(line, "EXDATE"));
    } else if (line.toUpperCase().startsWith("RDATE")) {
      parsed.rdates.push(...parseDateList(line, "RDATE"));
    } else {
      throw new RecurrenceError(`Unsupported recurrence rule: ${line.slice(0, 40)}`);
    }
  }
  if (parsed.rule === null && parsed.rdates.length === 0) throw new RecurrenceError("Unsupported recurrence rule: RRULE is required");
  return parsed;
}

function stampToInstant(stamp, zone, allDay) {
  if (allDay) return { key: dateKey(stamp) };
  if (stamp.kind === "date") return { key: dateKey(stamp) };
  if (stamp.utc) return { ms: utcMs(stamp.year, stamp.month - 1, stamp.day, stamp.hour, stamp.minute, stamp.second) };
  return { ms: zonedToMs(stamp.tzid ?? zone, stamp) };
}

/**
 * Chronological occurrences of a recurring event overlapping [windowMin, windowMax).
 * spec: { allDay, start: {year,month,day} | { ms, zone }, durationMs | durationDays, recurrence, windowMin?, windowMax?, cap }
 * Returns { occurrences, overflow }. Timed occurrences: { startMs, endMs, stamp }; all-day: { startDate, endDate, stamp }.
 */
export function expandOccurrences(spec) {
  const { allDay, recurrence, cap } = spec;
  const zone = allDay ? "UTC" : spec.start.zone;
  const wall = allDay ? { ...spec.start, hour: 0, minute: 0, second: 0 } : zonedParts(spec.start.ms, zone);
  const startDate = { year: wall.year, month: wall.month, day: wall.day };
  const masterStartMs = allDay ? dateToMs(startDate) : spec.start.ms;
  const windowMin = spec.windowMin ?? null;
  const windowMax = spec.windowMax ?? masterStartMs + TWO_YEARS_MS;
  const rule = recurrence.rule;
  const untilMs =
    rule?.until === null || rule?.until === undefined
      ? null
      : rule.until.kind === "date"
        ? dateToMs(rule.until) + (allDay ? 0 : DAY_MS - 1)
        : rule.until.utc
          ? utcMs(rule.until.year, rule.until.month - 1, rule.until.day, rule.until.hour, rule.until.minute, rule.until.second)
          : zonedToMs(zone, rule.until);

  const toOccurrence = (date) => {
    if (allDay) {
      const endDate = addDays(date, spec.durationDays);
      return { startDate: date, endDate, startMs: dateToMs(date), endMs: dateToMs(endDate), stamp: dateStamp(date) };
    }
    const startMs = zonedToMs(zone, { ...date, hour: wall.hour, minute: wall.minute, second: wall.second });
    return { startMs, endMs: startMs + spec.durationMs, stamp: instanceStamp(startMs) };
  };

  const excluded = new Set();
  for (const exdate of recurrence.exdates) {
    const instant = stampToInstant(exdate, zone, allDay);
    excluded.add(instant.key ?? instant.ms);
  }
  const isExcluded = (occurrence) => (allDay ? excluded.has(dateKey(occurrence.startDate)) : excluded.has(occurrence.startMs));

  const collected = [];
  let overflow = false;
  const push = (occurrence) => {
    if (collected.length >= cap) {
      overflow = true;
      return false;
    }
    collected.push(occurrence);
    return true;
  };

  if (rule !== null) {
    let generated = 0;
    let steps = 0;
    let index = 0;
    let finished = false;
    const candidatesFor = (step) => {
      if (rule.freq === "DAILY") return [addDays(startDate, step * rule.interval)];
      if (rule.freq === "WEEKLY") {
        const days = rule.byDay ?? [{ ordinal: 0, weekday: weekdayOf(startDate) }];
        const weekStart = addDays(startDate, -((weekdayOf(startDate) - rule.wkst + 7) % 7) + step * rule.interval * 7);
        return days.map((entry) => addDays(weekStart, (entry.weekday - rule.wkst + 7) % 7)).sort(compareDates);
      }
      if (rule.freq === "MONTHLY") {
        const month = addMonths(startDate, step * rule.interval);
        let day;
        if (rule.byDay !== null) day = nthWeekdayOfMonth(month.year, month.month, rule.byDay[0].weekday, rule.byDay[0].ordinal);
        else day = rule.byMonthDay ?? startDate.day;
        if (day === null || day > daysInMonth(month.year, month.month)) return [];
        return [{ year: month.year, month: month.month, day }];
      }
      const year = startDate.year + step * rule.interval;
      const month = rule.byMonth ?? startDate.month;
      const day = rule.byMonthDay ?? startDate.day;
      if (day > daysInMonth(year, month)) return [];
      return [{ year, month, day }];
    };
    // Fast-forward over whole periods that end before the window: their occurrences cannot overlap it, so expansion
    // work is proportional to the window, not to the distance between the series start and the window.
    if (windowMin !== null) {
      const spanMs = allDay ? spec.durationDays * DAY_MS : Math.max(0, spec.durationMs);
      const horizonMs = windowMin - spanMs - 3 * DAY_MS;
      if (horizonMs > masterStartMs) {
        const horizon = msToDate(horizonMs);
        const horizonDays = Math.floor((dateToMs(horizon) - dateToMs(startDate)) / DAY_MS);
        let skip = 0;
        if (rule.freq === "DAILY") {
          skip = Math.floor(horizonDays / rule.interval);
          generated = skip;
        } else if (rule.freq === "WEEKLY") {
          const first = candidatesFor(0);
          const days = horizonDays + ((weekdayOf(startDate) - rule.wkst + 7) % 7); // days from the first period's week start to the horizon
          skip = days >= 6 ? Math.floor((days - 6) / (7 * rule.interval)) + 1 : 0;
          if (skip > 0) generated = first.filter((date) => compareDates(date, startDate) >= 0).length + (skip - 1) * first.length;
        } else {
          const periodsBefore =
            rule.freq === "MONTHLY"
              ? horizon.year * 12 + (horizon.month - 1) - (startDate.year * 12 + (startDate.month - 1))
              : horizon.year - startDate.year;
          skip = periodsBefore >= 1 ? Math.floor((periodsBefore - 1) / rule.interval) + 1 : 0;
          if (rule.count !== null) {
            // Periods of these frequencies may produce no day, so COUNT is honoured by counting the skipped days cheaply
            // (bounded: at most 12 x 10,000 monthly periods between year 0 and 9999).
            for (let step = 0; step < skip && generated < rule.count; step += 1) {
              for (const date of candidatesFor(step)) if (compareDates(date, startDate) >= 0) generated += 1;
            }
          }
        }
        index = skip;
        if (rule.count !== null && generated >= rule.count) finished = true;
      }
    }
    let emptyPeriods = 0;
    while (!finished) {
      steps += 1;
      if (steps > MAX_STEPS) throw new RecurrenceError("Recurrence expansion exceeded its step budget");
      const candidates = candidatesFor(index);
      index += 1;
      if (candidates.length === 0) {
        emptyPeriods += 1;
        if (emptyPeriods >= MAX_EMPTY_PERIODS) finished = true;
        continue;
      }
      emptyPeriods = 0;
      for (const date of candidates) {
        if (compareDates(date, startDate) < 0) continue;
        const occurrence = toOccurrence(date);
        if (untilMs !== null && occurrence.startMs > untilMs) {
          finished = true;
          break;
        }
        if (occurrence.startMs >= windowMax) {
          finished = true;
          break;
        }
        generated += 1;
        if (!isExcluded(occurrence) && (windowMin === null || occurrence.endMs > windowMin) && !push(occurrence)) {
          finished = true;
          break;
        }
        if (rule.count !== null && generated >= rule.count) {
          finished = true;
          break;
        }
      }
    }
  }

  for (const rdate of recurrence.rdates) {
    const instant = stampToInstant(rdate, zone, allDay);
    let occurrence;
    if (allDay || instant.key !== undefined) {
      const parts = { year: Number(instant.key.slice(0, 4)), month: Number(instant.key.slice(5, 7)), day: Number(instant.key.slice(8, 10)) };
      occurrence = allDay ? toOccurrence(parts) : { startMs: dateToMs(parts), endMs: dateToMs(parts) + spec.durationMs, stamp: instanceStamp(dateToMs(parts)) };
    } else {
      occurrence = { startMs: instant.ms, endMs: instant.ms + spec.durationMs, stamp: instanceStamp(instant.ms) };
    }
    if (occurrence.startMs >= windowMax || (windowMin !== null && occurrence.endMs <= windowMin)) continue;
    if (isExcluded(occurrence) || collected.some((item) => item.stamp === occurrence.stamp)) continue;
    if (!push(occurrence)) break;
  }

  collected.sort((left, right) => left.startMs - right.startMs);
  return { occurrences: collected, overflow };
}
