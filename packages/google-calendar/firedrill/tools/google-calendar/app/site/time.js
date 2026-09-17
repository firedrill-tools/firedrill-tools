// Date and time helpers for the Google Calendar Tool app. Everything the grid shows is a wall-clock value in the
// user's calendar time zone: the Tool renders `dateTime` strings in that zone when the app passes `timeZone`, and the
// app converts wall-clock input back to RFC 3339 with the zone's offset (Intl supplies the offset; the Tool accepts
// the zones listed in SUPPORTED_ZONES, the same table its behavior implements).

export const SUPPORTED_ZONES = [
  "UTC", "Etc/UTC", "Europe/London", "Europe/Dublin", "Europe/Lisbon", "Europe/Berlin", "Europe/Paris", "Europe/Madrid", "Europe/Rome",
  "Europe/Amsterdam", "Europe/Zurich", "Europe/Stockholm", "Europe/Warsaw", "Europe/Athens", "Europe/Helsinki", "America/New_York",
  "America/Toronto", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Vancouver", "America/Sao_Paulo",
  "America/Mexico_City", "Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Asia/Tokyo", "Asia/Shanghai", "Asia/Hong_Kong", "Australia/Sydney",
  "Australia/Melbourne", "Pacific/Auckland", "Africa/Johannesburg", "Africa/Lagos", "Africa/Nairobi",
];

export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const MONTHS_SHORT = MONTHS.map((name) => name.slice(0, 3));
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const WEEKDAYS_SHORT = WEEKDAYS.map((name) => name.slice(0, 3));
export const DAY_MS = 86_400_000;

const pad = (value) => String(value).padStart(2, "0");

// ---------------------------------------------------------------------------------------------
// Calendar dates ("YYYY-MM-DD" keys)
// ---------------------------------------------------------------------------------------------

export const keyOf = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

export function parseKey(key) {
  const [y, m, d] = String(key).split("-").map(Number);
  return { y, m, d };
}

/** Days since the epoch for a date key (UTC arithmetic on the naive date). */
export const dayNumber = (key) => {
  const { y, m, d } = parseKey(key);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
};

export function addDays(key, days) {
  const date = new Date((dayNumber(key) + days) * DAY_MS);
  return keyOf(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

export const diffDays = (from, to) => dayNumber(to) - dayNumber(from);

/** 0 = Sunday … 6 = Saturday. */
export const weekday = (key) => new Date(dayNumber(key) * DAY_MS).getUTCDay();

export function startOfWeek(key, weekStart) {
  const offset = (weekday(key) - weekStart + 7) % 7;
  return addDays(key, -offset);
}

export function addMonths(key, months) {
  const { y, m, d } = parseKey(key);
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  return keyOf(year, month, Math.min(d, daysInMonth(year, month)));
}

export function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export const firstOfMonth = (key) => {
  const { y, m } = parseKey(key);
  return keyOf(y, m, 1);
};

/** Six rows of seven date keys covering the month of `key`. */
export function monthGrid(key, weekStart) {
  const first = firstOfMonth(key);
  const start = startOfWeek(first, weekStart);
  const rows = [];
  for (let row = 0; row < 6; row += 1) rows.push(Array.from({ length: 7 }, (_, column) => addDays(start, row * 7 + column)));
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Wall-clock parts <-> Tool strings
// ---------------------------------------------------------------------------------------------

const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/;

/** Parse the wall-clock digits of an RFC 3339 string (the offset is ignored: the Tool already rendered the user's zone). */
export function parseWall(text) {
  const match = DATE_TIME.exec(String(text));
  if (match === null) return null;
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]), h: Number(match[4]), mi: Number(match[5]) };
}

export const partsKey = (parts) => keyOf(parts.y, parts.m, parts.d);
export const minutesOf = (parts) => parts.h * 60 + parts.mi;

/** Offset (minutes east of UTC) of `zone` at the given instant, from the browser's IANA data. */
export function offsetMinutes(zone, utcMs) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(new Date(utcMs));
    const get = (type) => Number(parts.find((part) => part.type === type)?.value);
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
    return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60_000);
  } catch {
    return 0;
  }
}

/** Wall-clock parts of an instant in `zone` (from the browser's IANA data). */
export function wallOf(zone, utcMs) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }).formatToParts(new Date(utcMs));
    const get = (type) => Number(parts.find((part) => part.type === type)?.value);
    return { y: get("year"), m: get("month"), d: get("day"), h: get("hour") % 24, mi: get("minute") };
  } catch {
    const date = new Date(utcMs);
    return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate(), h: date.getUTCHours(), mi: date.getUTCMinutes() };
  }
}

/** Instant (ms) of a wall-clock time in `zone`. */
export function wallToUtc(zone, key, minutes) {
  const { y, m, d } = parseKey(key);
  const guess = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  let offset = offsetMinutes(zone, guess);
  let utc = guess - offset * 60_000;
  const check = offsetMinutes(zone, utc);
  if (check !== offset) {
    offset = check;
    utc = guess - offset * 60_000;
  }
  return utc;
}

export function formatOffset(minutes) {
  const sign = minutes < 0 ? "-" : "+";
  const absolute = Math.abs(minutes);
  return `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

/** RFC 3339 for a wall-clock time in `zone` (what the Tool expects for `startTime`/`endTime`). */
export function rfc3339(zone, key, minutes) {
  const utc = wallToUtc(zone, key, minutes);
  const offset = offsetMinutes(zone, utc);
  const { y, m, d } = parseKey(key);
  return `${keyOf(y, m, d)}T${pad(Math.floor(minutes / 60) % 24)}:${pad(minutes % 60)}:00${formatOffset(offset)}`;
}

/** "GMT+01" style gutter label for the zone at a date. */
export function gutterLabel(zone, key) {
  const offset = offsetMinutes(zone, wallToUtc(zone, key, 12 * 60));
  if (offset === 0) return "GMT";
  const hours = Math.trunc(offset / 60);
  const rest = Math.abs(offset % 60);
  return `GMT${offset < 0 ? "-" : "+"}${pad(Math.abs(hours))}${rest === 0 ? "" : `:${pad(rest)}`}`;
}

// ---------------------------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------------------------

/** Clock label: "09:30" (24 h) or "9:30am" (12 h); whole hours in 12 h drop the minutes ("9am"). */
export function fmtTime(minutes, h24, { compact = false } = {}) {
  const hour = Math.floor(minutes / 60) % 24;
  const minute = minutes % 60;
  if (h24) return `${pad(hour)}:${pad(minute)}`;
  const suffix = hour < 12 ? "am" : "pm";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return minute === 0 && compact ? `${twelve}${suffix}` : `${twelve}:${pad(minute)}${suffix}`;
}

/** Gutter hour label the way the grid prints it: "01:00" / "1 AM". */
export function fmtHourLabel(hour, h24) {
  if (h24) return `${pad(hour)}:00`;
  if (hour === 0 || hour === 24) return "";
  return `${hour % 12 === 0 ? 12 : hour % 12} ${hour < 12 ? "AM" : "PM"}`;
}

/** "9:30 – 10:15am" / "09:30 – 10:15" for a chip or popover. */
export function fmtRange(startMinutes, endMinutes, h24) {
  if (h24) return `${fmtTime(startMinutes, true)} – ${fmtTime(endMinutes, true)}`;
  const sameHalf = Math.floor(startMinutes / 60) < 12 === Math.floor(endMinutes / 60) < 12;
  const start = fmtTime(startMinutes, false, { compact: true });
  const end = fmtTime(endMinutes, false, { compact: true });
  return sameHalf ? `${start.replace(/[ap]m$/, "")} – ${end}` : `${start} – ${end}`;
}

const dateOrder = (locale) => (String(locale).toLowerCase().startsWith("en_us") || String(locale).toLowerCase().startsWith("en-us") ? "mdy" : "dmy");

/** "Monday, 14 September" (en_GB) or "Monday, September 14" (en_US); year appended when it differs from `yearOf`. */
export function fmtLongDate(key, locale, yearOf) {
  const { y, m, d } = parseKey(key);
  const day = `${WEEKDAYS[weekday(key)]}, ${dateOrder(locale) === "mdy" ? `${MONTHS[m - 1]} ${d}` : `${d} ${MONTHS[m - 1]}`}`;
  return yearOf !== undefined && yearOf !== y ? `${day}, ${y}` : day;
}

/** "14 Sep 2026" / "Sep 14, 2026". */
export function fmtShortDate(key, locale) {
  const { y, m, d } = parseKey(key);
  return dateOrder(locale) === "mdy" ? `${MONTHS_SHORT[m - 1]} ${d}, ${y}` : `${d} ${MONTHS_SHORT[m - 1]} ${y}`;
}

/** Title of the header for a range: "September 2026", "14 – 20 Sep 2026", "Sep 28 – Oct 4, 2026". */
export function fmtRangeTitle(startKey, endKey, locale) {
  const a = parseKey(startKey);
  const b = parseKey(endKey);
  if (a.y === b.y && a.m === b.m) return `${MONTHS[a.m - 1]} ${a.y}`;
  if (a.y === b.y) return dateOrder(locale) === "mdy" ? `${MONTHS_SHORT[a.m - 1]} ${a.d} – ${MONTHS_SHORT[b.m - 1]} ${b.d}, ${a.y}` : `${a.d} ${MONTHS_SHORT[a.m - 1]} – ${b.d} ${MONTHS_SHORT[b.m - 1]} ${a.y}`;
  return dateOrder(locale) === "mdy" ? `${MONTHS_SHORT[a.m - 1]} ${a.y} – ${MONTHS_SHORT[b.m - 1]} ${b.y}` : `${MONTHS_SHORT[a.m - 1]} ${a.y} – ${MONTHS_SHORT[b.m - 1]} ${b.y}`;
}

const ORDINALS = ["first", "second", "third", "fourth", "last"];

/** Human sentence for the recurrence subset the Tool supports ("Weekly on Monday, Wednesday, Friday"). */
export function describeRecurrence(lines, startKey) {
  const rrule = (lines ?? []).find((line) => line.toUpperCase().startsWith("RRULE:"));
  if (rrule === undefined) return null;
  const rules = Object.fromEntries(rrule.slice(6).split(";").map((part) => part.split("=")).map(([k, v]) => [k.toUpperCase(), v ?? ""]));
  const interval = Number(rules.INTERVAL ?? 1);
  const every = (unit) => (interval > 1 ? `Every ${interval} ${unit}s` : `${unit === "day" ? "Daily" : unit === "week" ? "Weekly" : unit === "month" ? "Monthly" : "Annually"}`);
  const DAYS = { SU: "Sunday", MO: "Monday", TU: "Tuesday", WE: "Wednesday", TH: "Thursday", FR: "Friday", SA: "Saturday" };
  let text;
  switch (rules.FREQ) {
    case "DAILY":
      text = every("day");
      break;
    case "WEEKLY": {
      const days = (rules.BYDAY ?? "").split(",").filter(Boolean).map((code) => DAYS[code.slice(-2)]).filter(Boolean);
      if (days.length === 5 && !days.includes("Saturday") && !days.includes("Sunday")) text = "Every weekday (Monday to Friday)";
      else text = `${every("week")} on ${days.length > 0 ? days.join(", ") : WEEKDAYS[weekday(startKey)]}`;
      break;
    }
    case "MONTHLY": {
      if (rules.BYDAY) {
        const match = /^(-?\d)?([A-Z]{2})$/.exec(rules.BYDAY);
        const position = match?.[1] === "-1" ? "last" : ORDINALS[Number(match?.[1] ?? 1) - 1] ?? "first";
        text = `${every("month")} on the ${position} ${DAYS[match?.[2]] ?? ""}`.trim();
      } else text = `${every("month")} on day ${rules.BYMONTHDAY ?? parseKey(startKey).d}`;
      break;
    }
    case "YEARLY": {
      const { m, d } = parseKey(startKey);
      text = `${every("year")} on ${d} ${MONTHS[m - 1]}`;
      break;
    }
    default:
      return rrule;
  }
  if (rules.COUNT) text += `, ${rules.COUNT} times`;
  else if (rules.UNTIL) {
    const until = rules.UNTIL.slice(0, 8);
    text += `, until ${Number(until.slice(6, 8))} ${MONTHS_SHORT[Number(until.slice(4, 6)) - 1]} ${until.slice(0, 4)}`;
  }
  return text;
}

/** RRULE presets the editor offers for a start date (label → recurrence lines). */
export function recurrencePresets(startKey) {
  const day = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][weekday(startKey)];
  const { d } = parseKey(startKey);
  const ordinal = Math.min(Math.ceil(d / 7), 4);
  return [
    { id: "none", label: "Does not repeat", lines: [] },
    { id: "daily", label: "Daily", lines: ["RRULE:FREQ=DAILY"] },
    { id: "weekly", label: `Weekly on ${WEEKDAYS[weekday(startKey)]}`, lines: [`RRULE:FREQ=WEEKLY;BYDAY=${day}`] },
    { id: "monthly", label: `Monthly on the ${ORDINALS[ordinal - 1]} ${WEEKDAYS[weekday(startKey)]}`, lines: [`RRULE:FREQ=MONTHLY;BYDAY=${ordinal}${day}`] },
    { id: "yearly", label: `Annually on ${d} ${MONTHS[parseKey(startKey).m - 1]}`, lines: ["RRULE:FREQ=YEARLY"] },
    { id: "weekdays", label: "Every weekday (Monday to Friday)", lines: ["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"] },
  ];
}

/** Relative luminance to pick dark or light text on a calendar colour. */
export function isLight(hex) {
  const value = /^#?([0-9a-f]{6})$/i.exec(String(hex))?.[1];
  if (!value) return true;
  const [r, g, b] = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16) / 255);
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b) > 0.45;
}

/** Slightly darker variant of a colour (borders of needsAction chips). */
export function darken(hex, amount = 0.25) {
  const value = /^#?([0-9a-f]{6})$/i.exec(String(hex))?.[1];
  if (!value) return hex;
  const channel = (offset) => Math.round(parseInt(value.slice(offset, offset + 2), 16) * (1 - amount));
  return `#${[0, 2, 4].map((offset) => pad(channel(offset).toString(16))).join("")}`;
}
