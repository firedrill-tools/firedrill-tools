// Google Calendar-shaped synthetic calendar service. Every operation computes from context.state;
// invitations are mirrored only onto calendars that exist in the same world and nothing leaves it.
import {
  EVENT_ID,
  MAX_CLIENT_EVENT_ID,
  MEET_URL,
  calendarIdFor,
  calendarIdKey,
  decodeBase64Url,
  encodeBase64Url,
  etagFor,
  eventIdFor,
  eventRowId,
  hashText,
  htmlLinkFor,
  iCalUidFor,
  isEmail,
  isEventIdShape,
  isRowId,
  listRowId,
  meetCodeFor,
  normalizeEmail,
  splitInstanceId,
  stableJson,
} from "./lib/ids.mjs";
import { assertJsonDepth } from "./lib/json-depth.mjs";
import { QuickAddError, parseQuickAdd } from "./lib/quickadd.mjs";
import { RecurrenceError, expandOccurrences, parseRecurrence } from "./lib/rrule.mjs";
import {
  DAY_MS,
  addDays,
  dateKey,
  dateToMs,
  formatInZone,
  formatTimestamp,
  formatWithOffset,
  isZone,
  parseClock,
  parseDate,
  parseDateTime,
  parseStamp,
  zonedParts,
  zonedToMs,
  utcMs,
} from "./lib/time.mjs";
import {
  EVENT_TYPE_ENUM,
  EVENT_TYPE_VALUE,
  SEND_UPDATES_LEVEL,
  calendarError,
  eventBodyToCanonical,
  restCalendar,
  restCalendarList,
  restCalendarListEntry,
  restEvent,
  restEvents,
  restFreeBusy,
  restSetting,
  restSettings,
} from "./lib/wire.mjs";

const SCAN_STEP = 1000;
const SCAN_CAP = 10_000;
const MAX_CALENDARS = 200;
const MAX_LIST_ENTRIES = 50;
const MAX_INSTANCES = 2000;
const DEFAULT_PAGE = 100;
const MAX_PAGE = 250;
const MAX_FREEBUSY_DAYS = 92;
/** Events (stored rows plus expanded instances) one list, search or free/busy call may assemble before sorting. */
const MAX_EXPANDED_EVENTS = 20_000;
/**
 * UTF-8 bytes of items one response may carry. The framework refuses HTTP responses over 1 MiB, so pages stop filling below this
 * budget (with a real next page token) and free/busy fails with a declared error instead of building a larger body.
 */
const RESPONSE_ITEM_BYTES = 900_000;
const ROLE_RANK = { freeBusyReader: 0, reader: 1, writer: 2, owner: 3 };
/** Canonical `events.list` orderBy values (REST `updated` is mapped to `lastModified` by the codec). */
const ORDER_BY_VALUES = { default: true, startTime: true, startTimeDesc: true, lastModified: true };
const RESPONSE_STATUSES = ["needsAction", "declined", "tentative", "accepted"];
const DEFAULT_EVENT_TYPES = ["default", "outOfOffice", "focusTime", "fromGmail"];

const CALENDAR_PALETTE = {
  1: "#ac725e", 2: "#d06b64", 3: "#f83a22", 4: "#fa573c", 5: "#ff7537", 6: "#ffad46", 7: "#42d692", 8: "#16a765",
  9: "#7bd148", 10: "#b3dc6c", 11: "#fbe983", 12: "#fad165", 13: "#92e1c0", 14: "#9fe1e7", 15: "#9fc6e7", 16: "#4986e7",
  17: "#9a9cff", 18: "#b99aff", 19: "#c2c2c2", 20: "#cabdbf", 21: "#cca6ac", 22: "#f691b2", 23: "#cd74e6", 24: "#a47ae2",
};
const EVENT_PALETTE = {
  1: "#a4bdfc", 2: "#7ae7bf", 3: "#dbadff", 4: "#ff887c", 5: "#fbd75b", 6: "#ffb878", 7: "#46d6db", 8: "#e1e1e1",
  9: "#5484ed", 10: "#51b749", 11: "#dc2127",
};
const NEW_CALENDAR_COLOR_ROTATION = [9, 16, 7, 24, 5, 3, 14, 20, 11, 17, 2, 22];

const DEFAULT_SETTINGS = {
  timezone: "UTC",
  weekStart: "0",
  format24HourTime: "false",
  defaultEventLength: "60",
  hideWeekends: "false",
  locale: "en",
  showDeclinedEvents: "true",
  remindOnRespondedEventsOnly: "false",
};
const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);

// ---------------------------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------------------------

const invalid = (context, message) => context.fail({ code: "INVALID_ARGUMENT", message });

const REPLACEMENT_CHAR = "\uFFFD";

/**
 * The framework decodes query strings and form bodies leniently, so malformed percent-encoding (`%E0%A4%A`) reaches a
 * handler as U+FFFD. A search, filter or time-zone value holding U+FFFD is a mangled request: answer Calendar's 400
 * `invalid` instead of running a corrupted search that matches nothing. A correctly encoded U+FFFD (`%EF%BF%BD`) is
 * refused the same way, because the two are indistinguishable once decoded.
 */
function isMangled(value) {
  return typeof value === "string" && value.includes(REPLACEMENT_CHAR);
}

/** Caller value echoed in an error message: clipped by code point, control characters and U+FFFD removed. */
function echoValue(value) {
  const points = Array.from(String(value ?? "").replace(/[\u0000-\u001f\u007f\uFFFD]/gu, "?"));
  if (points.length === 0) return '""';
  return points.length > 64 ? `${points.slice(0, 64).join("")}\u2026` : points.join("");
}

/** Rejects a mangled search/filter value with Calendar's invalid-parameter error. */
function requireDecodable(s, value, field) {
  if (isMangled(value)) {
    invalid(s.context, `Invalid value for ${field}: the value contains an invalid character (U+FFFD); check the percent-encoding`);
  }
  return value;
}
const notFound = (context) => context.fail({ code: "NOT_FOUND", message: "Not Found" });
const gone = (context) => context.fail({ code: "GONE", message: "Resource has been deleted" });
const precondition = (context, message) => context.fail({ code: "FAILED_PRECONDITION", message });
const timeRangeEmpty = (context) => context.fail({ code: "TIME_RANGE_EMPTY", message: "The specified time range is empty." });
const conditionNotMet = (context) => context.fail({ code: "CONDITION_NOT_MET", message: "Precondition Failed" });
const alreadyExists = (context) => context.fail({ code: "ALREADY_EXISTS", message: "The requested identifier already exists." });
const nonOrganizer = (context) =>
  context.fail({ code: "FORBIDDEN_FOR_NON_ORGANIZER", message: "Shared properties can only be changed by the organizer of the event." });
const requiredAccess = (context, role) =>
  context.fail({ code: "REQUIRED_ACCESS_LEVEL", message: `You need to have ${role} access to this calendar.` });

// ---------------------------------------------------------------------------------------------
// Session: actor identity, counters and clock for one operation
// ---------------------------------------------------------------------------------------------

/**
 * The user a caller without an `email` attribute acts as: the world's primary seeded user, i.e. the owner of the first
 * primary (non-resource) calendar in `calendars` row-id order, whose `summary` doubles as the display name. A world
 * without such a calendar falls back to `<actorId>@example.test`, whose virtual primary calendar is materialised on its
 * first write. The scan stops at the first match and is bounded like every other read.
 */
function defaultUser(context) {
  let after;
  for (let scanned = 0; scanned < SCAN_CAP; scanned += SCAN_STEP) {
    const batch = context.state.scan("calendars", { ...(after === undefined ? {} : { afterRowId: after }), limit: SCAN_STEP });
    for (const record of batch) {
      after = record.rowId;
      if (record.value.primary === true && record.value.resource !== true) {
        return { email: record.value.id, displayName: record.value.summary };
      }
    }
    if (batch.length < SCAN_STEP) break;
  }
  return { email: `${context.actor.id}@example.test`, displayName: undefined };
}

function session(context) {
  const attributes = context.actor.attributes;
  const explicit = typeof attributes.email === "string" && attributes.email.includes("@");
  const fallback = explicit ? undefined : defaultUser(context);
  const email = normalizeEmail(explicit ? attributes.email : fallback.email);
  const displayName =
    typeof attributes.displayName === "string" && attributes.displayName.length > 0
      ? attributes.displayName.slice(0, 200)
      : fallback?.displayName !== undefined
        ? String(fallback.displayName).slice(0, 200)
        : undefined;
  const nowMs = Math.floor(context.clock.nowUs() / 1000);
  const state = {
    context,
    user: { email, displayName },
    nowMs,
    now: formatTimestamp(nowMs),
    counters: null,
    dirty: false,
  };
  state.counter = (name) => {
    if (state.counters === null) {
      state.counters = { ...(context.state.get("meta", "counters") ?? { eventSequence: 0, calendarSequence: 0, etagSequence: 0, meetSequence: 0 }) };
    }
    state.counters[name] += 1;
    state.dirty = true;
    return state.counters[name];
  };
  state.etag = () => etagFor(state.counter("etagSequence"));
  state.commit = () => {
    if (state.dirty) context.state.put("meta", "counters", state.counters);
  };
  return state;
}

function settingsOf(s, email = s.user.email) {
  const row = s.context.state.get("settings", email);
  const values = { ...DEFAULT_SETTINGS };
  for (const key of SETTING_KEYS) if (row !== null && typeof row[key] === "string") values[key] = row[key];
  if (!isZone(values.timezone)) values.timezone = "UTC";
  return { values, etag: row?.etag ?? etagFor(0) };
}

// ---------------------------------------------------------------------------------------------
// Bounded state access
// ---------------------------------------------------------------------------------------------

/**
 * Every row of `namespace` whose id starts with `prefix`, in row-id order. Reaching the scan cap never truncates: it fails through
 * `onBound(message)`, which the caller chooses so the error is one its operation declares (FAILED_PRECONDITION by default).
 */
function rowsWithPrefix(s, namespace, prefix, onBound = null) {
  const bound = onBound ?? ((message) => precondition(s.context, message));
  const rows = [];
  let after = prefix;
  for (;;) {
    const batch = s.context.state.scan(namespace, { afterRowId: after, limit: SCAN_STEP });
    for (const record of batch) {
      if (!record.rowId.startsWith(prefix)) return rows;
      rows.push(record.value);
      after = record.rowId;
      if (rows.length >= SCAN_CAP) return bound(`Scan bound of ${SCAN_CAP} rows exceeded in ${namespace}.`);
    }
    if (batch.length < SCAN_STEP) return rows;
  }
}

function allRows(s, namespace) {
  return rowsWithPrefix(s, namespace, "");
}

const eventsOf = (s, calendarId, onBound = null) => rowsWithPrefix(s, "events", `${calendarId}:`, onBound);

/** Point read that answers null for a row id the framework cannot store (empty or over 512 characters) instead of throwing. */
function getRow(s, namespace, rowId) {
  return isRowId(rowId) ? s.context.state.get(namespace, rowId) : null;
}

/** Event lookup; ids that no stored or derived event can have (whitespace, wrong alphabet, too long) are simply absent. */
const getEvent = (s, calendarId, eventId) => (isEventIdShape(eventId) ? getRow(s, "events", eventRowId(calendarId, eventId)) : null);
const getCalendar = (s, calendarId) => getRow(s, "calendars", calendarId);
const getEntry = (s, userEmail, calendarId) => getRow(s, "calendar-list", listRowId(userEmail, calendarId));

function putEvent(s, row) {
  s.context.state.put("events", eventRowId(row.calendarId, row.id), compact(row));
}

function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

// ---------------------------------------------------------------------------------------------
// Calendars, roles and list entries
// ---------------------------------------------------------------------------------------------

function virtualPrimary(s) {
  return {
    id: s.user.email,
    summary: s.user.displayName ?? s.user.email,
    timeZone: settingsOf(s).values.timezone,
    ownerEmail: s.user.email,
    primary: true,
    resource: false,
    etag: etagFor(0),
    version: 1,
  };
}

function virtualEntry(s, calendar) {
  return {
    userEmail: s.user.email,
    calendarId: calendar.id,
    accessRole: "owner",
    colorId: "14",
    backgroundColor: CALENDAR_PALETTE[14],
    foregroundColor: "#000000",
    selected: true,
    hidden: false,
    primary: true,
    defaultReminders: [{ method: "popup", minutes: 10 }],
    etag: etagFor(0),
    version: 1,
  };
}

/**
 * Resolve a calendarId argument to { id, calendar, entry, role, virtual }. An omitted id means `primary`. Every supplied id
 * is validated before any state read (see calendarIdKey): empty, whitespace-only, whitespace-padded, control-character or
 * over-long ids cannot name a calendar and answer NOT_FOUND, exactly like unknown or unshared calendars.
 */
function resolveCalendar(s, calendarIdInput) {
  const id = calendarIdInput === undefined || calendarIdInput === "primary" ? s.user.email : calendarIdKey(calendarIdInput);
  if (id === null) notFound(s.context);
  if (id === s.user.email) {
    const stored = getCalendar(s, id);
    const calendar = stored ?? virtualPrimary(s);
    const entry = getEntry(s, s.user.email, id) ?? virtualEntry(s, calendar);
    return { id, calendar, entry, role: "owner", virtual: stored === null || getEntry(s, s.user.email, id) === null };
  }
  const calendar = getCalendar(s, id);
  const entry = getEntry(s, s.user.email, id);
  if (calendar === null || entry === null) notFound(s.context);
  return { id, calendar, entry, role: entry.accessRole, virtual: false };
}

function requireRole(s, resolved, role) {
  if (ROLE_RANK[resolved.role] < ROLE_RANK[role]) requiredAccess(s.context, role);
}

/** Materialise the actor's primary calendar and list entry when they exist only virtually. */
function ensurePrimary(s, resolved) {
  if (!resolved.virtual) return resolved;
  if (getCalendar(s, resolved.id) === null) {
    s.context.state.put("calendars", resolved.id, { ...resolved.calendar, etag: s.etag() });
  }
  if (getEntry(s, s.user.email, resolved.id) === null) {
    s.context.state.put("calendar-list", listRowId(s.user.email, resolved.id), { ...resolved.entry, etag: s.etag() });
  }
  return { ...resolved, calendar: getCalendar(s, resolved.id), entry: getEntry(s, s.user.email, resolved.id), virtual: false };
}

function calendarView(calendar) {
  return compact({
    id: calendar.id,
    summary: calendar.summary,
    description: calendar.description,
    location: calendar.location,
    timeZone: calendar.timeZone,
    etag: calendar.etag,
  });
}

function entryView(entry, calendar) {
  return compact({
    id: entry.calendarId,
    summary: calendar.summary,
    description: calendar.description,
    location: calendar.location,
    timeZone: calendar.timeZone,
    colorId: entry.colorId,
    backgroundColor: entry.backgroundColor,
    foregroundColor: entry.foregroundColor,
    selected: entry.selected,
    hidden: entry.hidden ? true : undefined,
    primary: entry.primary ? true : undefined,
    accessRole: entry.accessRole,
    defaultReminders: entry.defaultReminders,
    etag: entry.etag,
  });
}

/** The actor's calendar list (with a virtual primary when none is stored), sorted primary first then summary. */
function calendarListOf(s) {
  const entries = rowsWithPrefix(s, "calendar-list", `${s.user.email}:`)
    .map((entry) => ({ entry, calendar: getCalendar(s, entry.calendarId) }))
    .filter((item) => item.calendar !== null);
  if (!entries.some((item) => item.entry.calendarId === s.user.email)) {
    const calendar = getCalendar(s, s.user.email) ?? virtualPrimary(s);
    entries.push({ entry: virtualEntry(s, calendar), calendar });
  }
  return entries.sort((left, right) => {
    const primary = Number(right.entry.primary === true) - Number(left.entry.primary === true);
    if (primary !== 0) return primary;
    const summary = compareText(left.calendar.summary, right.calendar.summary);
    return summary !== 0 ? summary : compareText(left.entry.calendarId, right.entry.calendarId);
  });
}

function compareText(left, right) {
  const a = String(left).toLowerCase();
  const b = String(right).toLowerCase();
  return a < b ? -1 : a > b ? 1 : 0;
}

/** UTF-8 byte length of a string without allocating an encoder (lone surrogates count as the 3-byte replacement). */
function utf8Length(text) {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length && (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

const jsonBytes = (value) => utf8Length(JSON.stringify(value));

/** Calendar id that mirrors invitations for an address: an in-world primary or resource calendar. */
function hostCalendar(s, email) {
  const id = calendarIdKey(normalizeEmail(email));
  const calendar = id === null ? null : getCalendar(s, id);
  return calendar !== null && (calendar.primary === true || calendar.resource === true) ? calendar : null;
}

// ---------------------------------------------------------------------------------------------
// Time parsing and validation
// ---------------------------------------------------------------------------------------------

function requireZone(s, zone, field = "timeZone") {
  if (zone === undefined) return undefined;
  requireDecodable(s, zone, field);
  if (!isZone(zone)) invalid(s.context, `Invalid time zone: ${echoValue(zone)} (${field})`);
  return zone;
}

function parseInstant(s, value, field) {
  const parsed = parseDateTime(value);
  requireDecodable(s, value, field);
  if (parsed === null) invalid(s.context, `Invalid value for ${field}: ${echoValue(value)}`);
  return parsed;
}

/** [timeMin, timeMax) window from optional RFC 3339 bounds. */
function windowOf(s, startTime, endTime) {
  const min = startTime === undefined ? null : parseInstant(s, startTime, "timeMin").ms;
  const max = endTime === undefined ? null : parseInstant(s, endTime, "timeMax").ms;
  if (min !== null && max !== null && max <= min) timeRangeEmpty(s.context);
  return { min, max };
}

function effectiveZone(event, calendar) {
  const zone = event.start?.timeZone ?? calendar?.timeZone;
  return isZone(zone) ? zone : "UTC";
}

/** Start/end instants of a stored event: { allDay, startMs, endMs, startDate?, endDate? }. */
function timingOf(event) {
  if (event.start.date !== undefined) {
    const startDate = parseDate(event.start.date);
    const endDate = parseDate(event.end.date) ?? addDays(startDate, 1);
    return { allDay: true, startMs: dateToMs(startDate), endMs: dateToMs(endDate), startDate, endDate };
  }
  const start = parseDateTime(event.start.dateTime);
  const end = parseDateTime(event.end.dateTime) ?? start;
  return { allDay: false, startMs: start.ms, endMs: end.ms, startOffset: start.offsetMinutes, endOffset: end.offsetMinutes };
}

const overlaps = (timing, window) => (window.max === null || timing.startMs < window.max) && (window.min === null || timing.endMs > window.min);

const isMaster = (event) => Array.isArray(event.recurrence) && event.recurrence.length > 0 && event.recurringEventId === undefined;

function parsedRecurrence(s, lines) {
  try {
    return parseRecurrence(lines);
  } catch (error) {
    if (error instanceof RecurrenceError) return invalid(s.context, error.message);
    throw error;
  }
}

function originalKey(event) {
  const original = event.originalStartTime;
  if (original === undefined) return null;
  if (original.date !== undefined) return original.date;
  const parsed = parseDateTime(original.dateTime);
  return parsed === null ? null : parsed.ms;
}

/** Concrete instance record derived from a recurring master and one occurrence. */
function instanceOf(master, occurrence, zone) {
  const { recurrence, ...rest } = master;
  const id = `${master.id}_${occurrence.stamp}`;
  let start;
  let end;
  if (occurrence.startDate !== undefined) {
    start = { date: dateKey(occurrence.startDate) };
    end = { date: dateKey(occurrence.endDate) };
  } else {
    start = compact({ dateTime: formatInZone(occurrence.startMs, zone), timeZone: master.start.timeZone });
    end = compact({ dateTime: formatInZone(occurrence.endMs, zone), timeZone: master.end.timeZone ?? master.start.timeZone });
  }
  return { ...rest, id, start, end, recurringEventId: master.id, originalStartTime: { ...start }, htmlLink: htmlLinkFor(id, master.calendarId) };
}

/**
 * Instances of a recurring master overlapping the window, with exception rows merged in.
 * Cancelled exceptions are dropped unless showDeleted.
 */
function expandMaster(s, master, calendar, window, { showDeleted = false, exceptions = null, onBound = null } = {}) {
  const zone = effectiveZone(master, calendar);
  const timing = timingOf(master);
  let recurrence;
  if (onBound === null) recurrence = parsedRecurrence(s, master.recurrence);
  else {
    try {
      recurrence = parseRecurrence(master.recurrence);
    } catch (error) {
      if (!(error instanceof RecurrenceError)) throw error;
      return onBound(error.message);
    }
  }
  // Exceeding the instance cap or the expansion step budget fails with a declared error chosen by the caller
  // (FAILED_PRECONDITION by default), never an uncaught RecurrenceError.
  const bound = onBound ?? ((message) => precondition(s.context, message));
  let expanded;
  try {
    expanded = expandOccurrences({
      allDay: timing.allDay,
      start: timing.allDay ? timing.startDate : { ms: timing.startMs, zone },
      durationMs: timing.endMs - timing.startMs,
      durationDays: timing.allDay ? Math.max(1, Math.round((timing.endMs - timing.startMs) / DAY_MS)) : undefined,
      recurrence,
      windowMin: window.min,
      windowMax: window.max,
      cap: MAX_INSTANCES,
    });
  } catch (error) {
    if (!(error instanceof RecurrenceError)) throw error;
    return bound("Recurrence expansion exceeds the supported bound; narrow the time range.");
  }
  const { occurrences, overflow } = expanded;
  if (overflow) return bound(`Recurrence expansion exceeds ${MAX_INSTANCES} instances; narrow the time range.`);
  const rows = exceptions ?? eventsOf(s, master.calendarId, onBound).filter((row) => row.recurringEventId === master.id);
  const byOriginal = new Map();
  for (const row of rows) {
    const key = originalKey(row);
    if (key !== null) byOriginal.set(key, row);
  }
  const instances = [];
  const used = new Set();
  for (const occurrence of occurrences) {
    const key = timing.allDay ? dateKey(occurrence.startDate) : occurrence.startMs;
    const exception = byOriginal.get(key);
    if (exception !== undefined) {
      used.add(exception.id);
      if (exception.status !== "cancelled" || showDeleted) instances.push(exception);
      continue;
    }
    instances.push(instanceOf(master, occurrence, zone));
  }
  for (const row of rows) {
    if (used.has(row.id) || (row.status === "cancelled" && !showDeleted)) continue;
    if (overlaps(timingOf(row), window)) instances.push(row);
  }
  return instances;
}

/** Locate an event by id, deriving virtual instances of recurring masters. Returns null when unknown. */
function locateEvent(s, calendar, eventId) {
  const stored = getEvent(s, calendar.id, eventId);
  if (stored !== null) return { row: stored, virtual: false };
  const split = splitInstanceId(eventId);
  if (split === null) return null;
  const master = getEvent(s, calendar.id, split.masterId);
  if (master === null || !isMaster(master)) return null;
  const stamp = parseStamp(split.stamp);
  if (stamp === null) return null;
  const zone = effectiveZone(master, calendar);
  const anchor =
    stamp.kind === "date"
      ? dateToMs(stamp)
      : stamp.utc
        ? utcMs(stamp.year, stamp.month - 1, stamp.day, stamp.hour, stamp.minute, stamp.second)
        : zonedToMs(zone, stamp);
  // An exception row for this occurrence is stored under this very instance id and was found by the point read above, so the
  // derivation needs no scan of the calendar (and cannot reach the scan bound).
  const instances = expandMaster(s, master, calendar, { min: anchor - 1, max: anchor + 1 }, { showDeleted: true, exceptions: [], onBound: () => null });
  if (instances === null) return null;
  const match = instances.find((instance) => instance.id === eventId);
  return match === undefined ? null : { row: match, virtual: true, master };
}

// ---------------------------------------------------------------------------------------------
// Event listing, search and free/busy
// ---------------------------------------------------------------------------------------------

function haystackOf(event) {
  const parts = [event.summary, event.description, event.location, event.organizer?.email, event.organizer?.displayName];
  for (const attendee of event.attendees ?? []) parts.push(attendee.email, attendee.displayName);
  return parts
    .filter((part) => typeof part === "string")
    .join("\n")
    .toLowerCase();
}

function queryTerms(query) {
  return String(query ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
}

/**
 * Events of one calendar matching the filters. options: { window, singleEvents, showDeleted, eventTypes, iCalUID, updatedMinMs, terms }.
 */
function visibleEvents(s, calendar, options) {
  const { window, singleEvents = false, showDeleted = false, eventTypes = null, iCalUID, updatedMinMs = null, terms = [], onBound = null } = options;
  const bound = onBound ?? ((message) => precondition(s.context, message));
  const tooMany = () => bound(`The request would assemble more than ${MAX_EXPANDED_EVENTS} events; narrow the time range.`);
  const rows = eventsOf(s, calendar.id, onBound);
  const candidates = [];
  const exceptionsByMaster = new Map();
  for (const row of rows) {
    if (row.recurringEventId !== undefined) {
      const list = exceptionsByMaster.get(row.recurringEventId) ?? [];
      list.push(row);
      exceptionsByMaster.set(row.recurringEventId, list);
    }
  }
  for (const row of rows) {
    if (isMaster(row)) {
      const instances = expandMaster(s, row, calendar, window, { showDeleted, exceptions: exceptionsByMaster.get(row.id) ?? [], onBound });
      if (singleEvents) {
        if (candidates.length + instances.length > MAX_EXPANDED_EVENTS) return tooMany();
        candidates.push(...instances);
      } else if (instances.length > 0 || (window.min === null && window.max === null)) candidates.push(row);
      continue;
    }
    if (singleEvents && row.recurringEventId !== undefined && getEvent(s, calendar.id, row.recurringEventId) !== null) continue; // merged by its master
    if (overlaps(timingOf(row), window)) candidates.push(row);
  }
  return candidates.filter((event) => {
    const updatedMs = parseDateTime(event.updated)?.ms ?? 0;
    if (updatedMinMs !== null && updatedMs < updatedMinMs) return false;
    if (event.status === "cancelled" && !showDeleted && updatedMinMs === null) return false;
    if (eventTypes !== null && !eventTypes.includes(event.eventType)) return false;
    if (iCalUID !== undefined && event.iCalUID !== iCalUID) return false;
    if (terms.length > 0) {
      const haystack = haystackOf(event);
      if (!terms.every((term) => haystack.includes(term))) return false;
    }
    return true;
  });
}

/** Merged busy intervals of one calendar inside [min, max), as { startMs, endMs }. */
function busyIntervals(s, calendar, window) {
  const intervals = [];
  const onBound = (message) => invalid(s.context, message);
  for (const event of visibleEvents(s, calendar, { window, singleEvents: true, onBound })) {
    if (event.status === "cancelled" || event.transparency === "transparent") continue;
    const own = (event.attendees ?? []).find((attendee) => normalizeEmail(attendee.email) === calendar.id);
    if (own !== undefined && own.responseStatus === "declined") continue;
    const timing = timingOf(event);
    const startMs = window.min === null ? timing.startMs : Math.max(timing.startMs, window.min);
    const endMs = window.max === null ? timing.endMs : Math.min(timing.endMs, window.max);
    if (endMs > startMs) intervals.push({ startMs, endMs });
  }
  intervals.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  const merged = [];
  for (const interval of intervals) {
    const last = merged[merged.length - 1];
    if (last !== undefined && interval.startMs <= last.endMs) last.endMs = Math.max(last.endMs, interval.endMs);
    else merged.push({ ...interval });
  }
  return merged;
}

/** Whether the actor may read free/busy of a calendar id: any list entry, or another in-world user's primary calendar. */
function busyReadable(s, id) {
  if (id === s.user.email) return getCalendar(s, id) ?? virtualPrimary(s);
  const calendar = getCalendar(s, id);
  if (calendar === null) return null;
  if (getEntry(s, s.user.email, id) !== null || calendar.primary === true) return calendar;
  return null;
}

// ---------------------------------------------------------------------------------------------
// Presentation and pagination
// ---------------------------------------------------------------------------------------------

function renderInZone(side, zone) {
  if (side === undefined || side.dateTime === undefined) return side;
  const parsed = parseDateTime(side.dateTime);
  return parsed === null ? side : { ...side, dateTime: formatInZone(parsed.ms, zone) };
}

/** Canonical Event output from a stored row: no `version`, plus the MCP conveniences. */
function present(event, { zone, maxAttendees } = {}) {
  const { version, ...rest } = event;
  const out = { ...rest };
  if (zone !== undefined) {
    out.start = renderInZone(out.start, zone);
    out.end = renderInZone(out.end, zone);
    if (out.originalStartTime !== undefined) out.originalStartTime = renderInZone(out.originalStartTime, zone);
  }
  if (maxAttendees !== undefined && Array.isArray(out.attendees) && out.attendees.length > maxAttendees) {
    const self = out.attendees.filter((attendee) => attendee.self === true);
    const others = out.attendees.filter((attendee) => attendee.self !== true);
    out.attendees = [...self, ...others].slice(0, Math.max(maxAttendees, self.length));
  }
  if (out.hangoutLink !== undefined) out.conferenceUrl = out.hangoutLink;
  out.availability = out.transparency === "transparent" ? "AVAILABILITY_FREE" : "AVAILABILITY_BUSY";
  return out;
}

function pageSizeOf(s, value, field = "maxResults") {
  if (value === undefined) return DEFAULT_PAGE;
  requireCount(s, value, field);
  return Math.min(MAX_PAGE, Math.max(1, Math.trunc(value)));
}

/** A numeric parameter that reached the handler as text (bad value, or supplied more than once) is Calendar's 400 `invalid`. */
function requireCount(s, value, field) {
  if (typeof value !== "string") return value;
  requireDecodable(s, value, field);
  invalid(s.context, `Invalid value for parameter ${field}: ${echoValue(value)}`);
  return undefined;
}

function compareKeys(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === b) continue;
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (typeof a === "number" && typeof b === "number") return a - b;
    return String(a) < String(b) ? -1 : 1;
  }
  return 0;
}

/** Cursor pagination over a sorted list. Tokens are bound to `scope` (a hash of the request arguments). */
/**
 * Whether a decoded token position tuple has exactly the endpoint's key shape: `keyShape` is one letter per position,
 * "n" for a finite number and "s" for a string. Anything else (objects, arrays, null, a different length) is a forged token.
 */
function isKeyTuple(value, keyShape) {
  if (!Array.isArray(value) || value.length !== keyShape.length) return false;
  for (let index = 0; index < keyShape.length; index += 1) {
    const item = value[index];
    if (keyShape[index] === "n" ? !(typeof item === "number" && Number.isFinite(item)) : typeof item !== "string") {
      return false;
    }
  }
  return true;
}

/**
 * Cursor pagination over a sorted list. A page holds at most `pageSize` items and stops filling before the items' JSON (as rendered by
 * `sizeOf`) would exceed RESPONSE_ITEM_BYTES; the first item always fits (one event is far below the budget). A short page still
 * carries a next page token whenever items remain.
 */
function paginate(s, items, { pageSize, pageToken, scope, keyOf, keyShape, sizeOf = null }) {
  let start = 0;
  if (pageToken !== undefined && pageToken !== "") {
    let parsed;
    try {
      parsed = JSON.parse(decodeBase64Url(pageToken));
    } catch {
      parsed = null;
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.keys(parsed).length !== 2 ||
      parsed.s !== scope ||
      !isKeyTuple(parsed.a, keyShape)
    ) {
      s.context.fail({ code: "INVALID_PAGE_TOKEN", message: "Invalid page token" });
    }
    while (start < items.length && compareKeys(keyOf(items[start]), parsed.a) <= 0) start += 1;
  }
  let page = items.slice(start, start + pageSize);
  if (sizeOf !== null) {
    let bytes = 0;
    let count = 0;
    for (const item of page) {
      bytes += jsonBytes(sizeOf(item)) + 1;
      if (count > 0 && bytes > RESPONSE_ITEM_BYTES) break;
      count += 1;
    }
    page = page.slice(0, count);
  }
  const more = start + page.length < items.length;
  return {
    items: page,
    ...(more ? { nextPageToken: encodeBase64Url(JSON.stringify({ s: scope, a: keyOf(page[page.length - 1]) })) } : {}),
  };
}

function scopeOf(s, name, args) {
  return hashText(stableJson({ name, user: s.user.email, ...args }));
}

// ---------------------------------------------------------------------------------------------
// Event construction, copies and propagation
// ---------------------------------------------------------------------------------------------

/** Set the `self` flags of creator, organizer and attendees relative to the row's calendar. */
function normalizeSelf(row) {
  const calendarId = row.calendarId;
  const flag = (person) => {
    if (person === undefined) return person;
    const { self, ...rest } = person;
    return normalizeEmail(person.email) === calendarId ? { ...rest, self: true } : rest;
  };
  return compact({
    ...row,
    creator: flag(row.creator),
    organizer: flag(row.organizer),
    attendees: row.attendees === undefined ? undefined : row.attendees.map(flag),
  });
}

/** Calendar ids that hold a copy of an event besides the organizer's calendar. */
function copyCalendarIds(s, event) {
  const organizerId = normalizeEmail(event.organizer.email);
  const ids = [];
  for (const attendee of event.attendees ?? []) {
    const host = hostCalendar(s, attendee.email);
    if (host !== null && host.id !== organizerId && !ids.includes(host.id)) ids.push(host.id);
  }
  return ids;
}

/** Every stored row of one event (organizer row when in-world, then the mirrored copies). */
function rowsOfEvent(s, event) {
  const organizerId = normalizeEmail(event.organizer.email);
  const ids = getCalendar(s, organizerId) !== null ? [organizerId, ...copyCalendarIds(s, event)] : copyCalendarIds(s, event);
  if (!ids.includes(event.calendarId)) ids.push(event.calendarId);
  return ids.map((calendarId) => getEvent(s, calendarId, event.id)).filter((row) => row !== null);
}

const SHARED_FIELDS = [
  "iCalUID", "status", "summary", "description", "location", "start", "end", "endTimeUnspecified", "recurrence", "recurringEventId",
  "originalStartTime", "creator", "organizer", "visibility", "eventType", "guestsCanInviteOthers", "guestsCanModify", "guestsCanSeeOtherGuests",
  "anyoneCanAddSelf", "conferenceData", "hangoutLink", "sequence",
];

/** Derive a mirrored copy of `canonical` for `calendarId`, keeping the copy's private fields when it already exists. */
function deriveCopy(s, canonical, calendarId, existing) {
  const copy = { calendarId, id: canonical.id };
  for (const field of SHARED_FIELDS) if (canonical[field] !== undefined) copy[field] = canonical[field];
  copy.attendees = (canonical.attendees ?? []).map((attendee) => {
    const { self, ...rest } = attendee;
    return rest;
  });
  if (existing !== null && existing !== undefined) {
    if (existing.colorId !== undefined) copy.colorId = existing.colorId;
    copy.reminders = existing.reminders;
    copy.transparency = existing.transparency;
    copy.created = existing.created;
    copy.version = existing.version + 1;
  } else {
    copy.reminders = { useDefault: true };
    copy.transparency = "opaque";
    copy.created = canonical.created;
    copy.version = 1;
  }
  copy.htmlLink = htmlLinkFor(canonical.id, calendarId);
  copy.etag = s.etag();
  copy.updated = s.now;
  return normalizeSelf(copy);
}

/** Write the canonical row and refresh every mirrored copy from it. Returns the calendar ids written. */
function writeEventAndCopies(s, canonical, { previousCopyIds = [] } = {}) {
  const row = normalizeSelf({ ...canonical, etag: s.etag(), updated: s.now, version: (canonical.version ?? 0) + 1 });
  putEvent(s, row);
  const written = [row.calendarId];
  const copyIds = copyCalendarIds(s, row).filter((id) => id !== row.calendarId);
  for (const calendarId of copyIds) {
    putEvent(s, deriveCopy(s, row, calendarId, getEvent(s, calendarId, row.id)));
    written.push(calendarId);
  }
  for (const calendarId of previousCopyIds) {
    if (copyIds.includes(calendarId) || calendarId === row.calendarId) continue;
    const orphan = getEvent(s, calendarId, row.id);
    if (orphan !== null && orphan.status !== "cancelled") {
      putEvent(s, { ...orphan, status: "cancelled", etag: s.etag(), updated: s.now, version: orphan.version + 1 });
      written.push(calendarId);
    }
  }
  return { row, written };
}

function organizerFor(s, resolved) {
  if (resolved.calendar.primary === true && resolved.id === s.user.email) return compact({ email: s.user.email, displayName: s.user.displayName });
  return compact({ email: resolved.id, displayName: resolved.calendar.summary });
}

/** Whether the actor controls the organizer side of an event (organizer is the actor, or a calendar the actor can write). */
function actsAsOrganizer(s, event) {
  const organizerId = normalizeEmail(event.organizer.email);
  if (organizerId === s.user.email) return true;
  const entry = getEntry(s, s.user.email, organizerId);
  return entry !== null && ROLE_RANK[entry.accessRole] >= ROLE_RANK.writer;
}

function validateAttendee(s, attendee) {
  const email = normalizeEmail(attendee.email ?? "");
  if (!isEmail(email)) invalid(s.context, `Invalid attendee email address: ${String(attendee.email)}`);
  if (attendee.responseStatus !== undefined && !RESPONSE_STATUSES.includes(attendee.responseStatus)) {
    invalid(s.context, `Invalid attendee responseStatus: ${String(attendee.responseStatus)}`);
  }
  const host = hostCalendar(s, email);
  const resource = attendee.resource === true || host?.resource === true;
  return compact({
    email,
    displayName: attendee.displayName ?? (host?.resource === true ? host.summary : undefined),
    optional: attendee.optionalAttendee === true || attendee.optional === true ? true : undefined,
    resource: resource ? true : undefined,
    responseStatus: attendee.responseStatus ?? (resource ? "accepted" : "needsAction"),
    comment: attendee.comment,
    additionalGuests: attendee.additionalGuests,
  });
}

function validateReminders(s, overrides) {
  if (!Array.isArray(overrides)) return [];
  if (overrides.length > 5) invalid(s.context, "At most 5 reminder overrides are allowed.");
  return overrides.map((override) => {
    if (override === null || typeof override !== "object" || !["email", "popup"].includes(override.method)) {
      invalid(s.context, "Reminder method must be email or popup.");
    }
    const minutes = override.minutes;
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 40320) invalid(s.context, "Reminder minutes must be an integer from 0 to 40320.");
    return { method: override.method, minutes };
  });
}

function buildSides(s, { startTime, endTime, allDay, timeZone }, previous) {
  const zone = requireZone(s, timeZone);
  if (allDay) {
    const startText = String(startTime).slice(0, 10);
    const endText = String(endTime).slice(0, 10);
    const startDate = parseDate(startText);
    const endDate = parseDate(endText);
    if (startDate === null) invalid(s.context, `Invalid all-day start date: ${String(startTime)}`);
    if (endDate === null) invalid(s.context, `Invalid all-day end date: ${String(endTime)}`);
    const delta = dateToMs(endDate) - dateToMs(startDate);
    if (delta < 0) invalid(s.context, "The end date must not be before the start date.");
    if (delta === 0) timeRangeEmpty(s.context);
    return { start: { date: dateKey(startDate) }, end: { date: dateKey(endDate) } };
  }
  const start = parseInstant(s, startTime, "start.dateTime");
  const end = parseInstant(s, endTime, "end.dateTime");
  if (end.ms < start.ms) invalid(s.context, "The end time must be after the start time.");
  if (end.ms === start.ms) timeRangeEmpty(s.context);
  const previousZone = zone ?? previous?.start?.timeZone;
  return {
    start: compact({ dateTime: formatWithOffset(start.ms, start.offsetMinutes), timeZone: previousZone }),
    end: compact({ dateTime: formatWithOffset(end.ms, end.offsetMinutes), timeZone: previousZone }),
  };
}

const TIME_FIELDS = ["startTime", "endTime", "allDay", "timeZone"];

/**
 * Apply canonical insert/patch arguments onto a base row. `mode` is "insert", "patch" or "replace".
 * Returns the new row (without etag/updated/version) and the set of changed field names.
 */
function applyEventInput(s, resolved, base, input, mode) {
  const next = { ...base };
  const changed = new Set();
  const touch = (field, value) => {
    if (stableJson(base[field]) !== stableJson(value)) changed.add(field);
    if (value === undefined) delete next[field];
    else next[field] = value;
  };
  const provided = (field) => input[field] !== undefined;
  const replace = mode === "replace";

  const textField = (field, max) => {
    if (provided(field)) {
      if (input[field].length > max) invalid(s.context, `${field} must be at most ${max} characters.`);
      touch(field, input[field] === "" ? undefined : input[field]);
    } else if (replace) touch(field, undefined);
  };
  textField("summary", 1024);
  textField("description", 8192);
  textField("location", 1024);

  // Times ------------------------------------------------------------------------------------
  if (TIME_FIELDS.some(provided) || (mode === "insert" && (input.startTime !== undefined || input.endTime !== undefined))) {
    const currentTiming = base.start === undefined ? null : timingOf(base);
    const currentAllDay = currentTiming?.allDay ?? false;
    const allDay = input.allDay ?? (mode === "insert" ? false : currentAllDay);
    let startTime = input.startTime;
    let endTime = input.endTime;
    if (mode === "insert") {
      if (startTime === undefined) invalid(s.context, "Missing start.");
      if (endTime === undefined) invalid(s.context, "Missing end.");
    } else {
      if (replace && (startTime === undefined || endTime === undefined)) invalid(s.context, startTime === undefined ? "Missing start." : "Missing end.");
      if (startTime === undefined && endTime === undefined && currentTiming !== null && allDay === currentAllDay && input.timeZone !== undefined) {
        // Only the zone changed: keep the instants, relabel.
        startTime = allDay ? base.start.date : base.start.dateTime;
        endTime = allDay ? base.end.date : base.end.dateTime;
      } else if (startTime === undefined && endTime === undefined) {
        // allDay flipped without new times: convert the existing instants.
        startTime = allDay ? dateKey(zonedParts(currentTiming.startMs, effectiveZone(base, resolved.calendar))) : formatInZone(currentTiming.startMs, effectiveZone(base, resolved.calendar));
        endTime = allDay ? dateKey(addDays(zonedParts(currentTiming.startMs, effectiveZone(base, resolved.calendar)), 1)) : formatInZone(currentTiming.endMs, effectiveZone(base, resolved.calendar));
      } else if (endTime === undefined) {
        // Google's MCP rule: moving the start keeps the duration.
        if (allDay) {
          const startDate = parseDate(String(startTime).slice(0, 10));
          if (startDate === null) invalid(s.context, `Invalid all-day start date: ${String(startTime)}`);
          const days = currentAllDay ? Math.round((currentTiming.endMs - currentTiming.startMs) / DAY_MS) : 1;
          endTime = dateKey(addDays(startDate, Math.max(1, days)));
        } else {
          const start = parseInstant(s, startTime, "start.dateTime");
          const duration = currentTiming === null || currentAllDay ? 3_600_000 : currentTiming.endMs - currentTiming.startMs;
          endTime = formatWithOffset(start.ms + duration, start.offsetMinutes);
        }
      } else if (startTime === undefined) {
        startTime = allDay ? (currentAllDay ? base.start.date : dateKey(zonedParts(currentTiming.startMs, effectiveZone(base, resolved.calendar)))) : base.start.dateTime ?? formatInZone(currentTiming.startMs, effectiveZone(base, resolved.calendar));
      }
    }
    const sides = buildSides(s, { startTime, endTime, allDay, timeZone: input.timeZone }, replace ? undefined : base);
    touch("start", sides.start);
    touch("end", sides.end);
  } else if (mode === "insert") {
    invalid(s.context, "Missing start.");
  }

  // Recurrence ---------------------------------------------------------------------------------
  if (provided("recurrenceData")) {
    if (base.recurringEventId !== undefined) invalid(s.context, "Recurrence cannot be set on an instance of a recurring event.");
    const lines = input.recurrenceData.map((line) => String(line));
    if (lines.length === 0) touch("recurrence", undefined);
    else {
      parsedRecurrence(s, lines);
      touch("recurrence", lines);
    }
  } else if (replace) touch("recurrence", undefined);

  // Attendees ----------------------------------------------------------------------------------
  if (provided("attendees") || provided("addedAttendees") || provided("removedAttendeeEmails") || provided("attendeeEmails") || replace) {
    const existing = new Map((base.attendees ?? []).map((attendee) => [normalizeEmail(attendee.email), attendee]));
    let list;
    if (provided("attendees")) {
      list = [];
      for (const attendee of input.attendees) {
        const validated = validateAttendee(s, attendee);
        const previous = existing.get(validated.email);
        if (previous !== undefined && attendee.responseStatus === undefined) {
          validated.responseStatus = previous.responseStatus;
          if (previous.comment !== undefined && validated.comment === undefined) validated.comment = previous.comment;
        }
        if (previous?.organizer === true) validated.organizer = true;
        if (!list.some((item) => item.email === validated.email)) list.push(validated);
      }
    } else {
      list = replace ? [] : (base.attendees ?? []).map((attendee) => ({ ...attendee }));
      for (const email of input.removedAttendeeEmails ?? []) {
        const target = normalizeEmail(email);
        if (target === normalizeEmail(next.organizer?.email ?? base.organizer?.email ?? "")) invalid(s.context, "The organizer cannot be removed from the event.");
        list = list.filter((attendee) => normalizeEmail(attendee.email) !== target);
      }
      const additions = [...(input.addedAttendees ?? []), ...(input.attendeeEmails ?? []).map((email) => ({ email }))];
      for (const attendee of additions) {
        const validated = validateAttendee(s, attendee);
        if (!list.some((item) => normalizeEmail(item.email) === validated.email)) list.push(validated);
      }
    }
    if (list.length > 100) invalid(s.context, "An event may have at most 100 attendees.");
    if (list.length > 0) {
      const organizer = next.organizer ?? base.organizer;
      const organizerEmail = normalizeEmail(organizer.email);
      const organizerEntry = list.find((attendee) => normalizeEmail(attendee.email) === organizerEmail);
      if (organizerEntry === undefined) {
        list.unshift(compact({ email: organizerEmail, displayName: organizer.displayName, organizer: true, responseStatus: "accepted" }));
      } else {
        organizerEntry.organizer = true;
        if (organizerEntry.responseStatus === "needsAction") organizerEntry.responseStatus = "accepted";
      }
    }
    for (const attendee of list) if (attendee.organizer !== true) delete attendee.organizer;
    touch("attendees", list.length === 0 ? undefined : list.map((attendee) => compact(attendee)));
  }

  // Reminders, colour, visibility, transparency, type, permissions, status -----------------------
  if (provided("overrideReminders")) {
    touch("reminders", { useDefault: false, overrides: validateReminders(s, input.overrideReminders) });
  } else if (input.useDefaultReminders === true) {
    touch("reminders", { useDefault: true });
  } else if (input.useDefaultReminders === false) {
    touch("reminders", { useDefault: false, overrides: base.reminders?.overrides ?? [] });
  } else if (replace) touch("reminders", { useDefault: true });

  if (provided("colorId")) {
    if (input.colorId === "" ) touch("colorId", undefined);
    else {
      if (!Object.hasOwn(EVENT_PALETTE, input.colorId)) invalid(s.context, `Invalid event colorId: ${String(input.colorId)}`);
      touch("colorId", String(input.colorId));
    }
  } else if (replace) touch("colorId", undefined);

  if (provided("visibility")) touch("visibility", input.visibility);
  else if (replace) touch("visibility", "default");

  if (provided("availability") && input.availability !== "AVAILABILITY_UNSPECIFIED") {
    touch("transparency", input.availability === "AVAILABILITY_FREE" ? "transparent" : "opaque");
  } else if (replace) touch("transparency", "opaque");

  if (provided("eventType")) {
    const value = Object.hasOwn(EVENT_TYPE_VALUE, input.eventType) ? EVENT_TYPE_VALUE[input.eventType] : undefined;
    if (value === undefined) invalid(s.context, `Invalid eventType: ${String(input.eventType)}`);
    if (mode !== "insert" && value !== base.eventType) invalid(s.context, "The eventType of an existing event cannot be changed.");
    touch("eventType", value);
  } else if (mode === "insert") touch("eventType", "default");

  if (provided("guestPermissions") || replace) {
    const permissions = input.guestPermissions ?? {};
    const pick = (key, fallback) => (permissions[key] !== undefined ? permissions[key] : replace ? fallback : base[key === "guestsCanSeeGuests" ? "guestsCanSeeOtherGuests" : key] ?? fallback);
    touch("guestsCanInviteOthers", pick("guestsCanInviteOthers", true));
    touch("guestsCanModify", pick("guestsCanModify", false));
    touch("guestsCanSeeOtherGuests", pick("guestsCanSeeGuests", true));
  }
  if (provided("anyoneCanAddSelf")) touch("anyoneCanAddSelf", input.anyoneCanAddSelf ? true : undefined);
  else if (replace) touch("anyoneCanAddSelf", undefined);

  if (provided("status")) {
    if (input.status === "cancelled") invalid(s.context, "Use delete to cancel an event.");
    touch("status", input.status);
  }

  // Conference ---------------------------------------------------------------------------------
  if (input.removeConference === true) {
    touch("conferenceData", undefined);
    touch("hangoutLink", undefined);
  } else if (provided("googleMeetUrl") || input.addGoogleMeetUrl === true) {
    let url = input.googleMeetUrl;
    if (url !== undefined && !MEET_URL.test(url)) invalid(s.context, "googleMeetUrl must be a https://meet.google.com/xxx-xxxx-xxx link.");
    if (url === undefined && base.hangoutLink !== undefined) url = base.hangoutLink;
    if (url === undefined) url = `https://meet.google.com/${meetCodeFor(s.counter("meetSequence"))}`;
    const code = url.slice("https://meet.google.com/".length);
    touch("hangoutLink", url);
    touch("conferenceData", {
      conferenceId: code,
      conferenceSolution: { key: { type: "hangoutsMeet" }, name: "Google Meet" },
      entryPoints: [{ entryPointType: "video", uri: url, label: `meet.google.com/${code}` }],
    });
  } else if (replace) {
    touch("conferenceData", undefined);
    touch("hangoutLink", undefined);
  }

  return { next: compact(next), changed };
}

function notificationLevelOf(input) {
  const level = input.notificationLevel;
  return level === undefined || level === "NOTIFICATION_LEVEL_UNSPECIFIED" ? "ALL" : level;
}

function eventSidePayload(side) {
  return compact({ dateTime: side.dateTime, date: side.date, timeZone: side.timeZone });
}

/** Insert a brand-new event (insert and quickAdd share this). */
function createEvent(s, resolved, input, source) {
  requireRole(s, resolved, "writer");
  const target = ensurePrimary(s, resolved);
  let id;
  if (input.id !== undefined) {
    if (typeof input.id !== "string" || input.id.length > MAX_CLIENT_EVENT_ID || !EVENT_ID.test(input.id)) invalid(s.context, "Invalid resource id value.");
    id = input.id;
    if (getEvent(s, target.id, id) !== null) alreadyExists(s.context);
  } else {
    do id = eventIdFor(s.counter("eventSequence"));
    while (getEvent(s, target.id, id) !== null);
  }
  const base = {
    calendarId: target.id,
    id,
    iCalUID: iCalUidFor(id),
    status: "confirmed",
    creator: compact({ email: s.user.email, displayName: s.user.displayName }),
    organizer: organizerFor(s, target),
    reminders: { useDefault: true },
    transparency: "opaque",
    visibility: "default",
    guestsCanInviteOthers: true,
    guestsCanModify: false,
    guestsCanSeeOtherGuests: true,
    htmlLink: htmlLinkFor(id, target.id),
    created: s.now,
    sequence: Number.isInteger(input.sequence) && input.sequence >= 0 ? input.sequence : 0,
    version: 0,
  };
  const { next } = applyEventInput(s, target, base, input, "insert");
  const { row } = writeEventAndCopies(s, next);
  s.context.events.emit("event.created", {
    calendarId: row.calendarId,
    eventId: row.id,
    iCalUID: row.iCalUID,
    organizer: row.organizer.email,
    attendees: (row.attendees ?? []).map((attendee) => attendee.email),
    start: eventSidePayload(row.start),
    end: eventSidePayload(row.end),
    notificationLevel: notificationLevelOf(input),
    source,
  });
  s.commit();
  return present(row);
}

/** Locate the actor's view of an event on a resolved calendar; NOT_FOUND when unknown, GONE when cancelled. */
function requireLiveEvent(s, resolved, eventId) {
  const located = locateEvent(s, resolved.calendar, eventId);
  if (located === null) notFound(s.context);
  if (located.row.status === "cancelled") gone(s.context);
  return located;
}

/** Canonical (organizer-side) row of an event as seen from the actor's row; falls back to the actor's row. */
function canonicalRowOf(s, located) {
  const row = located.row;
  const organizerId = normalizeEmail(row.organizer.email);
  if (organizerId === row.calendarId) return { row, virtual: located.virtual };
  const organizerCalendar = getCalendar(s, organizerId);
  if (organizerCalendar === null) return { row, virtual: located.virtual };
  const organizerSide = locateEvent(s, organizerCalendar, row.id);
  if (organizerSide === null || organizerSide.row.status === "cancelled") return { row, virtual: located.virtual };
  return organizerSide;
}

// ---------------------------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------------------------

const operations = {
  // Calendar list --------------------------------------------------------------------------------
  "calendar-list.list": (input, context) => {
    const s = session(context);
    if (input.minAccessRole !== undefined && !Object.hasOwn(ROLE_RANK, input.minAccessRole)) {
      invalid(s.context, `Invalid value for: ${echoValue(input.minAccessRole)} is not a valid value`);
    }
    const minimum = input.minAccessRole === undefined ? 0 : ROLE_RANK[input.minAccessRole];
    const items = calendarListOf(s).filter(
      (item) => ROLE_RANK[item.entry.accessRole] >= minimum && (input.showHidden === true || item.entry.hidden !== true),
    );
    const page = paginate(s, items, {
      pageSize: pageSizeOf(s, input.pageSize),
      pageToken: input.pageToken,
      scope: scopeOf(s, "calendar-list.list", { minAccessRole: input.minAccessRole, showHidden: input.showHidden === true }),
      keyOf: (item) => [item.entry.primary === true ? 0 : 1, String(item.calendar.summary).toLowerCase(), item.entry.calendarId],
      keyShape: "nss",
      sizeOf: (item) => entryView(item.entry, item.calendar),
    });
    return compact({
      calendars: page.items.map((item) => entryView(item.entry, item.calendar)),
      nextPageToken: page.nextPageToken,
      // The world's virtual now (RFC 3339, UTC): what the browser app treats as "today". Canonical/MCP only; the
      // REST codec builds Google's calendarList resource without it.
      serverTime: formatWithOffset(s.nowMs, 0),
    });
  },

  "calendar-list.get": (input, context) => {
    const s = session(context);
    const resolved = resolveCalendar(s, input.calendarId);
    return entryView(resolved.entry, resolved.calendar);
  },

  "calendar-list.patch": (input, context) => {
    const s = session(context);
    const fields = ["colorId", "backgroundColor", "foregroundColor", "selected", "hidden", "defaultReminders"].filter((field) => input[field] !== undefined);
    if (fields.length === 0) invalid(s.context, "At least one field to patch is required.");
    const resolved = ensurePrimary(s, resolveCalendar(s, input.calendarId));
    if (input.etag !== undefined && input.etag !== resolved.entry.etag) conditionNotMet(s.context);
    const next = { ...resolved.entry };
    if (input.colorId !== undefined) {
      if (!Object.hasOwn(CALENDAR_PALETTE, input.colorId)) invalid(s.context, `Invalid calendar colorId: ${String(input.colorId)}`);
      next.colorId = String(input.colorId);
      next.backgroundColor = CALENDAR_PALETTE[input.colorId];
      next.foregroundColor = "#000000";
    }
    for (const field of ["backgroundColor", "foregroundColor"]) {
      if (input[field] === undefined) continue;
      const value = String(input[field]).toLowerCase();
      if (!/^#[0-9a-f]{6}$/.test(value)) invalid(s.context, `${field} must be a #rrggbb colour.`);
      next[field] = value;
    }
    if (input.selected !== undefined) next.selected = input.selected;
    if (input.hidden !== undefined) next.hidden = input.hidden;
    if (input.defaultReminders !== undefined) next.defaultReminders = validateReminders(s, input.defaultReminders);
    next.etag = s.etag();
    next.version = resolved.entry.version + 1;
    context.state.put("calendar-list", listRowId(s.user.email, resolved.id), next);
    s.commit();
    return entryView(next, resolved.calendar);
  },

  // Calendars ------------------------------------------------------------------------------------
  "calendars.get": (input, context) => {
    const s = session(context);
    return calendarView(resolveCalendar(s, input.calendarId).calendar);
  },

  "calendars.insert": (input, context) => {
    const s = session(context);
    const summary = String(input.summary).trim();
    if (summary.length === 0 || summary.length > 200) invalid(s.context, "summary must be 1 to 200 characters.");
    const timeZone = requireZone(s, input.timeZone) ?? settingsOf(s).values.timezone;
    if (allRows(s, "calendars").length >= MAX_CALENDARS) precondition(s.context, `This world holds at most ${MAX_CALENDARS} calendars.`);
    const entries = rowsWithPrefix(s, "calendar-list", `${s.user.email}:`);
    if (entries.length >= MAX_LIST_ENTRIES) precondition(s.context, `A user may subscribe to at most ${MAX_LIST_ENTRIES} calendars.`);
    let id;
    do id = calendarIdFor(s.counter("calendarSequence"));
    while (getCalendar(s, id) !== null);
    const calendar = compact({
      id,
      summary,
      description: input.description === "" ? undefined : input.description,
      location: input.location === "" ? undefined : input.location,
      timeZone,
      ownerEmail: s.user.email,
      primary: false,
      resource: false,
      etag: s.etag(),
      version: 1,
    });
    const colorId = NEW_CALENDAR_COLOR_ROTATION[entries.length % NEW_CALENDAR_COLOR_ROTATION.length];
    context.state.put("calendars", id, calendar);
    context.state.put("calendar-list", listRowId(s.user.email, id), {
      userEmail: s.user.email,
      calendarId: id,
      accessRole: "owner",
      colorId: String(colorId),
      backgroundColor: CALENDAR_PALETTE[colorId],
      foregroundColor: "#000000",
      selected: true,
      hidden: false,
      primary: false,
      defaultReminders: [],
      etag: s.etag(),
      version: 1,
    });
    s.commit();
    return calendarView(calendar);
  },

  "calendars.patch": (input, context) => {
    const s = session(context);
    const fields = ["summary", "description", "location", "timeZone"].filter((field) => input[field] !== undefined);
    if (fields.length === 0) invalid(s.context, "At least one field to patch is required.");
    const resolved = resolveCalendar(s, input.calendarId);
    requireRole(s, resolved, "owner");
    const target = ensurePrimary(s, resolved);
    if (input.etag !== undefined && input.etag !== target.calendar.etag) conditionNotMet(s.context);
    const next = { ...target.calendar };
    if (input.summary !== undefined) {
      const summary = String(input.summary).trim();
      if (summary.length === 0 || summary.length > 200) invalid(s.context, "summary must be 1 to 200 characters.");
      next.summary = summary;
    }
    if (input.description !== undefined) {
      if (input.description.length > 1000) invalid(s.context, "description must be at most 1000 characters.");
      if (input.description === "") delete next.description;
      else next.description = input.description;
    }
    if (input.location !== undefined) {
      if (input.location.length > 200) invalid(s.context, "location must be at most 200 characters.");
      if (input.location === "") delete next.location;
      else next.location = input.location;
    }
    if (input.timeZone !== undefined) next.timeZone = requireZone(s, input.timeZone);
    next.etag = s.etag();
    next.version = target.calendar.version + 1;
    context.state.put("calendars", target.id, next);
    s.commit();
    return calendarView(next);
  },

  "calendars.delete": (input, context) => {
    const s = session(context);
    const resolved = resolveCalendar(s, input.calendarId);
    requireRole(s, resolved, "owner");
    if (resolved.calendar.primary === true) context.fail({ code: "FORBIDDEN", message: "Cannot delete primary calendar." });
    if (resolved.calendar.resource === true) context.fail({ code: "FORBIDDEN", message: "Cannot delete a resource calendar." });
    const rows = eventsOf(s, resolved.id);
    for (const row of rows) {
      const affected = [];
      if (normalizeEmail(row.organizer.email) === resolved.id) {
        for (const calendarId of copyCalendarIds(s, row)) {
          const copy = getEvent(s, calendarId, row.id);
          if (copy === null || copy.status === "cancelled") continue;
          putEvent(s, { ...copy, status: "cancelled", etag: s.etag(), updated: s.now, version: copy.version + 1 });
          affected.push(calendarId);
        }
      }
      context.state.delete("events", eventRowId(resolved.id, row.id));
      if (affected.length > 0 && row.recurringEventId === undefined) {
        context.events.emit("event.cancelled", {
          calendarId: resolved.id,
          eventId: row.id,
          byOrganizer: true,
          affectedCalendars: [resolved.id, ...affected],
          notificationLevel: "ALL",
        });
      }
    }
    for (const entry of allRows(s, "calendar-list")) {
      if (entry.calendarId === resolved.id) context.state.delete("calendar-list", listRowId(entry.userEmail, entry.calendarId));
    }
    context.state.delete("calendars", resolved.id);
    s.commit();
    return { id: resolved.id, deleted: true, eventsRemoved: rows.length };
  },

  // Events: reads --------------------------------------------------------------------------------
  "events.list": (input, context) => {
    const s = session(context);
    const resolved = resolveCalendar(s, input.calendarId);
    requireRole(s, resolved, "reader");
    if (input.syncToken !== undefined) invalid(s.context, "Incremental sync is not supported; use time bounds instead.");
    requireDecodable(s, input.fullText, "q");
    requireDecodable(s, input.iCalUID, "iCalUID");
    requireCount(s, input.maxAttendees, "maxAttendees");
    const orderBy = input.orderBy ?? "default";
    if (!Object.hasOwn(ORDER_BY_VALUES, orderBy)) invalid(s.context, `Invalid value for: ${echoValue(orderBy)} is not a valid value`);
    if ((orderBy === "startTime" || orderBy === "startTimeDesc") && input.singleEvents !== true) {
      invalid(s.context, "orderBy startTime requires singleEvents to be true.");
    }
    const zone = requireZone(s, input.timeZone);
    const window = windowOf(s, input.startTime, input.endTime);
    const updatedMinMs = input.updatedMin === undefined ? null : parseInstant(s, input.updatedMin, "updatedMin").ms;
    const typeInput = input.eventType ?? input.eventTypeFilter;
    const eventTypes = typeInput === undefined || typeInput.length === 0 ? DEFAULT_EVENT_TYPES : typeInput.map((name) => (Object.hasOwn(EVENT_TYPE_VALUE, name) ? EVENT_TYPE_VALUE[name] : name));
    const events = visibleEvents(s, resolved.calendar, {
      window,
      singleEvents: input.singleEvents === true,
      showDeleted: input.showDeleted === true,
      eventTypes,
      iCalUID: input.iCalUID,
      updatedMinMs,
      terms: queryTerms(input.fullText),
    });
    const keyOf =
      orderBy === "lastModified"
        ? (event) => [parseDateTime(event.updated)?.ms ?? 0, event.id]
        : orderBy === "startTimeDesc"
          ? (event) => [-timingOf(event).startMs, event.id]
          : (event) => [timingOf(event).startMs, event.id];
    events.sort((left, right) => compareKeys(keyOf(left), keyOf(right)));
    const page = paginate(s, events, {
      pageSize: pageSizeOf(s, input.pageSize),
      pageToken: input.pageToken,
      scope: scopeOf(s, "events.list", {
        calendarId: resolved.id,
        startTime: input.startTime,
        endTime: input.endTime,
        orderBy,
        fullText: input.fullText,
        eventTypes,
        singleEvents: input.singleEvents === true,
        showDeleted: input.showDeleted === true,
        updatedMin: input.updatedMin,
        iCalUID: input.iCalUID,
        timeZone: zone,
      }),
      keyOf,
      keyShape: "ns",
      sizeOf: (event) => present(event, { zone, maxAttendees: input.maxAttendees }),
    });
    const allRowsHere = eventsOf(s, resolved.id);
    const updated = allRowsHere.reduce((latest, row) => (row.updated > latest ? row.updated : latest), allRowsHere.length === 0 ? s.now : allRowsHere[0].updated);
    return compact({
      summary: resolved.calendar.summary,
      description: resolved.calendar.description,
      updated,
      timeZone: zone ?? resolved.calendar.timeZone,
      accessRole: resolved.role,
      defaultReminders: resolved.entry.defaultReminders,
      events: page.items.map((event) => present(event, { zone, maxAttendees: input.maxAttendees })),
      nextPageToken: page.nextPageToken,
    });
  },

  "events.get": (input, context) => {
    const s = session(context);
    const resolved = resolveCalendar(s, input.calendarId);
    requireRole(s, resolved, "reader");
    const zone = requireZone(s, input.timeZone);
    requireCount(s, input.maxAttendees, "maxAttendees");
    const located = locateEvent(s, resolved.calendar, input.eventId);
    if (located === null) notFound(s.context);
    return present(located.row, { zone, maxAttendees: input.maxAttendees });
  },

  "events.instances": (input, context) => {
    const s = session(context);
    const resolved = resolveCalendar(s, input.calendarId);
    requireRole(s, resolved, "reader");
    const zone = requireZone(s, input.timeZone);
    const window = windowOf(s, input.startTime, input.endTime);
    const master = getEvent(s, resolved.id, input.eventId);
    if (master === null) notFound(s.context);
    if (!isMaster(master)) invalid(s.context, "The event is not a recurring event.");
    let instances = expandMaster(s, master, resolved.calendar, window, { showDeleted: input.showDeleted === true });
    if (input.originalStart !== undefined) {
      requireDecodable(s, input.originalStart, "originalStart");
      const wanted = parseDateTime(input.originalStart)?.ms ?? input.originalStart;
      instances = instances.filter((instance) => originalKey(instance) === wanted);
    }
    const keyOf = (event) => [timingOf(event).startMs, event.id];
    instances.sort((left, right) => compareKeys(keyOf(left), keyOf(right)));
    const page = paginate(s, instances, {
      pageSize: pageSizeOf(s, input.pageSize),
      pageToken: input.pageToken,
      scope: scopeOf(s, "events.instances", {
        calendarId: resolved.id,
        eventId: input.eventId,
        startTime: input.startTime,
        endTime: input.endTime,
        showDeleted: input.showDeleted === true,
        originalStart: input.originalStart,
        timeZone: zone,
      }),
      keyOf,
      keyShape: "ns",
      sizeOf: (event) => present(event, { zone }),
    });
    return compact({
      summary: resolved.calendar.summary,
      updated: master.updated,
      timeZone: zone ?? resolved.calendar.timeZone,
      accessRole: resolved.role,
      events: page.items.map((event) => present(event, { zone })),
      nextPageToken: page.nextPageToken,
    });
  },

  "events.search": (input, context) => {
    const s = session(context);
    requireDecodable(s, input.query, "q");
    const terms = queryTerms(input.query);
    if (terms.length === 0) invalid(s.context, "query must contain at least one search term.");
    const zone = requireZone(s, input.timeZone);
    const window = windowOf(s, input.startTime, input.endTime);
    if (window.min === null) window.min = s.nowMs - 30 * DAY_MS;
    if (window.max === null) window.max = s.nowMs + 365 * DAY_MS;
    const results = [];
    for (const item of calendarListOf(s)) {
      if (ROLE_RANK[item.entry.accessRole] < ROLE_RANK.reader) continue;
      const found = visibleEvents(s, item.calendar, { window, singleEvents: true, terms });
      if (results.length + found.length > MAX_EXPANDED_EVENTS) {
        precondition(s.context, `The request would assemble more than ${MAX_EXPANDED_EVENTS} events; narrow the time range.`);
      }
      results.push(...found);
    }
    const keyOf = (event) => [timingOf(event).startMs, event.calendarId, event.id];
    results.sort((left, right) => compareKeys(keyOf(left), keyOf(right)));
    const page = paginate(s, results, {
      pageSize: pageSizeOf(s, input.pageSize),
      pageToken: input.pageToken,
      scope: scopeOf(s, "events.search", { query: terms, startTime: input.startTime, endTime: input.endTime, timeZone: zone }),
      keyOf,
      keyShape: "nss",
      sizeOf: (event) => present(event, { zone }),
    });
    return compact({ events: page.items.map((event) => present(event, { zone })), nextPageToken: page.nextPageToken });
  },

  // Events: writes -------------------------------------------------------------------------------
  "events.insert": (input, context) => {
    const s = session(context);
    return createEvent(s, resolveCalendar(s, input.calendarId), input, "insert");
  },

  "events.quick-add": (input, context) => {
    const s = session(context);
    const resolved = resolveCalendar(s, input.calendarId);
    if (typeof input.text !== "string" || input.text.trim().length === 0) invalid(s.context, "Missing text.");
    requireDecodable(s, input.text, "text");
    const settings = settingsOf(s).values;
    const zone = isZone(resolved.calendar.timeZone) ? resolved.calendar.timeZone : settings.timezone;
    let parsed;
    try {
      parsed = parseQuickAdd(input.text, { nowMs: s.nowMs, zone, defaultLengthMinutes: Number(settings.defaultEventLength) || 60 });
    } catch (error) {
      if (error instanceof QuickAddError) return invalid(s.context, error.message);
      throw error;
    }
    const args = parsed.allDay
      ? { summary: parsed.summary, location: parsed.location, startTime: dateKey(parsed.start), endTime: dateKey(parsed.end), allDay: true }
      : { summary: parsed.summary, location: parsed.location, startTime: formatInZone(parsed.start, zone), endTime: formatInZone(parsed.end, zone), timeZone: zone };
    return createEvent(s, resolved, compact({ ...args, notificationLevel: input.notificationLevel }), "quickAdd");
  },

  "events.patch": (input, context) => {
    const s = session(context);
    const resolved = resolveCalendar(s, input.calendarId);
    requireRole(s, resolved, "writer");
    const patchFields = Object.keys(input).filter((key) => !["calendarId", "eventId", "etag", "notificationLevel", "replace", "id", "sequence"].includes(key) && input[key] !== undefined);
    if (patchFields.length === 0) invalid(s.context, "At least one field to patch is required.");
    const located = requireLiveEvent(s, resolved, input.eventId);
    if (input.etag !== undefined && input.etag !== located.row.etag) conditionNotMet(s.context);
    const mode = input.replace === true ? "replace" : "patch";
    const own = applyEventInput(s, resolved, located.row, input, mode);
    if (own.changed.size === 0) return present(located.row);

    const organizer = actsAsOrganizer(s, located.row);
    const privateFields = new Set(["colorId", "reminders", "transparency"]);
    const changedShared = [...own.changed].filter((field) => !privateFields.has(field));
    let responseOnly = false;
    if (changedShared.includes("attendees")) {
      const before = (located.row.attendees ?? []).map((attendee) => compact({ ...attendee, responseStatus: undefined, comment: undefined, self: undefined }));
      const after = (own.next.attendees ?? []).map((attendee) => compact({ ...attendee, responseStatus: undefined, comment: undefined, self: undefined }));
      const othersUnchanged = (own.next.attendees ?? []).every((attendee) => {
        if (normalizeEmail(attendee.email) === s.user.email) return true;
        const previous = (located.row.attendees ?? []).find((item) => normalizeEmail(item.email) === normalizeEmail(attendee.email));
        return previous !== undefined && previous.responseStatus === attendee.responseStatus && previous.comment === attendee.comment;
      });
      responseOnly = stableJson(before) === stableJson(after) && othersUnchanged;
    }
    const sharedBlocked = changedShared.filter((field) => !(field === "attendees" && responseOnly));
    if (!organizer && sharedBlocked.length > 0 && located.row.guestsCanModify !== true) nonOrganizer(s.context);

    // Canonical (organizer-side) row receives the shared changes; the actor's row receives the private ones.
    const canonical = canonicalRowOf(s, located);
    const timeChanged = ["start", "end", "recurrence"].some((field) => own.changed.has(field));
    let canonicalNext;
    if (canonical.row === located.row) canonicalNext = own.next;
    else {
      const sharedInput = compact(Object.fromEntries(Object.entries(input).filter(([key]) => !["colorId", "overrideReminders", "useDefaultReminders", "availability", "calendarId"].includes(key))));
      canonicalNext = Object.keys(sharedInput).some((key) => !["eventId", "etag", "notificationLevel", "replace"].includes(key))
        ? applyEventInput(s, { ...resolved, calendar: getCalendar(s, canonical.row.calendarId) ?? resolved.calendar }, canonical.row, sharedInput, mode).next
        : { ...canonical.row };
      if (responseOnly || own.changed.has("attendees")) {
        // Carry the actor's own response onto the canonical attendee list.
        const mine = (own.next.attendees ?? []).find((attendee) => normalizeEmail(attendee.email) === s.user.email);
        canonicalNext.attendees = (canonicalNext.attendees ?? []).map((attendee) =>
          mine !== undefined && normalizeEmail(attendee.email) === s.user.email
            ? compact({ ...attendee, responseStatus: mine.responseStatus, comment: mine.comment })
            : attendee,
        );
      }
    }
    if (timeChanged) canonicalNext.sequence = (canonical.row.sequence ?? 0) + 1;
    if (timeChanged && isMaster(canonical.row)) {
      // Google-style: changing a series' time or rule discards its exceptions on every copy.
      for (const row of rowsOfEvent(s, canonical.row)) {
        for (const exception of eventsOf(s, row.calendarId)) {
          if (exception.recurringEventId === row.id) context.state.delete("events", eventRowId(row.calendarId, exception.id));
        }
      }
    }
    const previousCopyIds = canonical.virtual ? [] : copyCalendarIds(s, canonical.row);
    const { row: canonicalRow, written } = writeEventAndCopies(s, canonical.virtual ? { ...canonicalNext, version: 0 } : canonicalNext, { previousCopyIds });
    // Private fields on the actor's own copy.
    if (canonicalRow.calendarId !== resolved.id) {
      const mine = getEvent(s, resolved.id, canonicalRow.id);
      if (mine !== null) {
        const next = { ...mine };
        for (const field of privateFields) if (own.changed.has(field)) next[field] = own.next[field];
        putEvent(s, compact({ ...next, etag: s.etag(), updated: s.now }));
      }
    }
    context.events.emit("event.updated", {
      calendarId: resolved.id,
      eventId: canonicalRow.id,
      sequence: canonicalRow.sequence,
      changedFields: [...own.changed].sort(),
      actor: s.user.email,
      notificationLevel: notificationLevelOf(input),
    });
    s.commit();
    const result = getEvent(s, resolved.id, canonicalRow.id) ?? canonicalRow;
    return present(result);
  },

  "events.delete": (input, context) => {
    const s = session(context);
    const resolved = resolveCalendar(s, input.calendarId);
    requireRole(s, resolved, "writer");
    const located = requireLiveEvent(s, resolved, input.eventId);
    const organizer = actsAsOrganizer(s, located.row);
    const canonical = canonicalRowOf(s, located);
    const affected = [];
    if (organizer) {
      const written = canonical.virtual
        ? writeEventAndCopies(s, { ...canonical.row, status: "cancelled", version: 0 }).written
        : rowsOfEvent(s, canonical.row).map((row) => {
            putEvent(s, { ...row, status: "cancelled", etag: s.etag(), updated: s.now, version: row.version + 1 });
            return row.calendarId;
          });
      affected.push(...written);
      if (!affected.includes(resolved.id) && getEvent(s, resolved.id, located.row.id) === null) {
        putEvent(s, normalizeSelf({ ...located.row, status: "cancelled", etag: s.etag(), updated: s.now, version: 1 }));
        affected.push(resolved.id);
      }
    } else {
      // A guest removes the event from their own calendar and declines on the organizer's side.
      const decline = (attendees) =>
        (attendees ?? []).map((attendee) => (normalizeEmail(attendee.email) === s.user.email ? { ...attendee, responseStatus: "declined" } : attendee));
      if (canonical.row !== located.row) {
        const canonicalNext = { ...canonical.row, attendees: decline(canonical.row.attendees) };
        const { written } = writeEventAndCopies(s, canonical.virtual ? { ...canonicalNext, version: 0 } : canonicalNext);
        affected.push(...written.filter((id) => id !== resolved.id));
      }
      const mine = getEvent(s, resolved.id, located.row.id) ?? normalizeSelf({ ...located.row, version: 0 });
      putEvent(s, { ...mine, attendees: decline(mine.attendees), status: "cancelled", etag: s.etag(), updated: s.now, version: mine.version + 1 });
      affected.push(resolved.id);
    }
    context.events.emit("event.cancelled", {
      calendarId: resolved.id,
      eventId: located.row.id,
      byOrganizer: organizer,
      affectedCalendars: [...new Set(affected)],
      notificationLevel: notificationLevelOf(input),
    });
    s.commit();
    return present(getEvent(s, resolved.id, located.row.id));
  },

  "events.respond": (input, context) => {
    const s = session(context);
    const resolved = resolveCalendar(s, input.calendarId);
    requireRole(s, resolved, "writer");
    const located = requireLiveEvent(s, resolved, input.eventId);
    if (!(located.row.attendees ?? []).some((attendee) => normalizeEmail(attendee.email) === s.user.email)) {
      invalid(s.context, "The user is not an attendee of this event.");
    }
    const respond = (attendees) =>
      attendees.map((attendee) =>
        normalizeEmail(attendee.email) === s.user.email
          ? compact({ ...attendee, responseStatus: input.responseStatus, comment: input.responseComment === "" ? undefined : input.responseComment ?? attendee.comment })
          : attendee,
      );
    const canonical = canonicalRowOf(s, located);
    const canonicalNext = { ...canonical.row, attendees: respond(canonical.row.attendees ?? []) };
    const { row } = writeEventAndCopies(s, canonical.virtual ? { ...canonicalNext, version: 0 } : canonicalNext);
    if (getEvent(s, resolved.id, row.id) === null) {
      putEvent(s, normalizeSelf({ ...located.row, attendees: respond(located.row.attendees), etag: s.etag(), updated: s.now, version: 1 }));
    }
    context.events.emit("event.updated", {
      calendarId: resolved.id,
      eventId: row.id,
      sequence: row.sequence,
      changedFields: ["attendees"],
      actor: s.user.email,
      notificationLevel: notificationLevelOf(input),
    });
    s.commit();
    return present(getEvent(s, resolved.id, row.id));
  },

  "events.move": (input, context) => {
    const s = session(context);
    const source = resolveCalendar(s, input.calendarId);
    requireRole(s, source, "writer");
    const destination = resolveCalendar(s, input.destination);
    requireRole(s, destination, "writer");
    if (destination.id === source.id) invalid(s.context, "The destination calendar must differ from the source calendar.");
    if (splitInstanceId(input.eventId) !== null) invalid(s.context, "Cannot move instances of recurring events.");
    const row = getEvent(s, source.id, input.eventId);
    if (row === null) notFound(s.context);
    if (row.status === "cancelled") gone(s.context);
    if (normalizeEmail(row.organizer.email) !== source.id) nonOrganizer(s.context);
    if (getEvent(s, destination.id, row.id) !== null) alreadyExists(s.context);
    const target = ensurePrimary(s, destination);
    const organizer = organizerFor(s, target);
    const attendees = row.attendees?.map((attendee) =>
      attendee.organizer === true ? compact({ ...attendee, email: organizer.email, displayName: organizer.displayName }) : attendee,
    );
    const moved = compact({ ...row, calendarId: target.id, organizer, attendees, htmlLink: htmlLinkFor(row.id, target.id) });
    context.state.delete("events", eventRowId(source.id, row.id));
    const { row: written } = writeEventAndCopies(s, moved);
    for (const exception of eventsOf(s, source.id)) {
      if (exception.recurringEventId !== row.id) continue;
      context.state.delete("events", eventRowId(source.id, exception.id));
      putEvent(s, normalizeSelf({ ...exception, calendarId: target.id, organizer, htmlLink: htmlLinkFor(exception.id, target.id), etag: s.etag(), updated: s.now, version: exception.version + 1 }));
    }
    context.events.emit("event.updated", {
      calendarId: target.id,
      eventId: written.id,
      sequence: written.sequence,
      changedFields: ["calendarId"],
      actor: s.user.email,
      notificationLevel: notificationLevelOf(input),
    });
    s.commit();
    return present(written);
  },

  // Free/busy and suggestions --------------------------------------------------------------------
  "freebusy.query": (input, context) => {
    const s = session(context);
    requireZone(s, input.timeZone);
    const min = parseInstant(s, input.timeMin, "timeMin");
    const max = parseInstant(s, input.timeMax, "timeMax");
    if (max.ms <= min.ms) timeRangeEmpty(s.context);
    if (max.ms - min.ms > MAX_FREEBUSY_DAYS * DAY_MS) invalid(s.context, `The time range must not exceed ${MAX_FREEBUSY_DAYS} days.`);
    const window = { min: min.ms, max: max.ms };
    // A Map keyed by the id exactly as supplied: caller ids such as "__proto__" or "constructor" stay ordinary keys.
    const calendars = new Map();
    let bytes = 0;
    for (const item of input.items) {
      // Keyed by the id exactly as supplied (Google echoes it); ids no calendar can have report notFound for that item.
      const raw = String(item.id);
      const id = raw === "primary" ? s.user.email : calendarIdKey(raw);
      const calendar = id === null ? null : busyReadable(s, id);
      if (calendar === null) {
        calendars.set(raw, { errors: [{ domain: "global", reason: "notFound" }] });
        continue;
      }
      const entry = {
        busy: busyIntervals(s, calendar, window).map((interval) => ({ start: formatWithOffset(interval.startMs, 0), end: formatWithOffset(interval.endMs, 0) })),
      };
      calendars.set(raw, entry);
      bytes += utf8Length(raw) + jsonBytes(entry) + 4;
      if (bytes > RESPONSE_ITEM_BYTES) {
        invalid(s.context, "The free/busy response would exceed the supported size; narrow the time range or request fewer calendars.");
      }
    }
    return { timeMin: formatWithOffset(min.ms, 0), timeMax: formatWithOffset(max.ms, 0), calendars: Object.fromEntries(calendars) };
  },

  "time.suggest": (input, context) => {
    const s = session(context);
    const zone = requireZone(s, input.timeZone) ?? settingsOf(s).values.timezone;
    const min = parseInstant(s, input.startTime, "startTime");
    const max = parseInstant(s, input.endTime, "endTime");
    if (max.ms <= min.ms) timeRangeEmpty(s.context);
    if (max.ms - min.ms > MAX_FREEBUSY_DAYS * DAY_MS) invalid(s.context, `The time range must not exceed ${MAX_FREEBUSY_DAYS} days.`);
    const duration = (input.durationMinutes ?? 30) * 60_000;
    const preferences = input.preferences ?? {};
    const startMinutes = preferences.startHour === undefined ? 9 * 60 : parseClock(preferences.startHour);
    const endMinutes = preferences.endHour === undefined ? 17 * 60 : parseClock(preferences.endHour);
    if (startMinutes === null || endMinutes === null || endMinutes <= startMinutes) invalid(s.context, "preferences.startHour/endHour must be HH:mm with endHour after startHour.");
    requireCount(s, preferences.pageSize, "preferences.pageSize");
    const limit = preferences.pageSize ?? 5;
    const window = { min: min.ms, max: max.ms };
    const busy = [];
    const unresolved = [];
    for (const email of input.attendeeEmails) {
      const address = normalizeEmail(email);
      if (!isEmail(address)) invalid(s.context, `Invalid attendee email address: ${String(email)}`);
      const host = hostCalendar(s, address);
      if (host === null) {
        if (!unresolved.includes(address)) unresolved.push(address);
        continue;
      }
      busy.push(...busyIntervals(s, host, window));
    }
    const slots = [];
    let day = zonedParts(min.ms, zone);
    for (let guard = 0; guard < MAX_FREEBUSY_DAYS + 1 && slots.length < limit; guard += 1) {
      const dayStart = zonedToMs(zone, { ...day, hour: 0, minute: 0, second: 0 });
      if (dayStart >= max.ms) break;
      const weekday = zonedParts(dayStart + 12 * 3_600_000, zone).weekday;
      if (!(preferences.excludeWeekends === true && (weekday === 0 || weekday === 6))) {
        for (let minute = startMinutes; minute + duration / 60_000 <= endMinutes && slots.length < limit; minute += 15) {
          const slotStart = zonedToMs(zone, { ...day, hour: Math.floor(minute / 60), minute: minute % 60, second: 0 });
          const slotEnd = slotStart + duration;
          if (slotStart < min.ms || slotEnd > max.ms) continue;
          if (busy.some((interval) => interval.startMs < slotEnd && interval.endMs > slotStart)) continue;
          slots.push({ start: { dateTime: formatInZone(slotStart, zone), timeZone: zone }, end: { dateTime: formatInZone(slotEnd, zone), timeZone: zone } });
        }
      }
      day = { ...addDays(day, 1), hour: 0, minute: 0, second: 0 };
    }
    return { timeSlots: slots, unresolvedAttendees: unresolved };
  },

  "time.now": (input, context) => {
    const s = session(context);
    const zone = settingsOf(s).values.timezone;
    const parts = zonedParts(s.nowMs, zone);
    return { dateTime: formatInZone(s.nowMs, zone), date: dateKey(parts), timeZone: zone, utc: formatWithOffset(s.nowMs, 0) };
  },

  // Colors and settings --------------------------------------------------------------------------
  "colors.get": () => ({
    kind: "calendar#colors",
    updated: "2012-02-14T00:00:00.000Z",
    calendar: Object.fromEntries(Object.entries(CALENDAR_PALETTE).map(([id, background]) => [id, { background, foreground: "#000000" }])),
    event: Object.fromEntries(Object.entries(EVENT_PALETTE).map(([id, background]) => [id, { background, foreground: "#1d1d1d" }])),
  }),

  "settings.list": (input, context) => {
    const s = session(context);
    requireCount(s, input.pageSize, "maxResults");
    if (input.pageToken !== undefined && input.pageToken !== "") s.context.fail({ code: "INVALID_PAGE_TOKEN", message: "Invalid page token" });
    const { values, etag } = settingsOf(s);
    return { items: SETTING_KEYS.map((id) => ({ id, value: values[id], etag })), serverTime: formatWithOffset(s.nowMs, 0) };
  },

  "settings.get": (input, context) => {
    const s = session(context);
    if (!SETTING_KEYS.includes(input.setting)) notFound(s.context);
    const { values, etag } = settingsOf(s);
    return { id: input.setting, value: values[input.setting], etag };
  },
};

// ---------------------------------------------------------------------------------------------
// HTTP codecs (pure): Calendar API v3 spelling ⇄ canonical arguments
// ---------------------------------------------------------------------------------------------

/**
 * Query parameter or header value. Every Calendar query parameter this codec reads is singular, so a parameter supplied
 * more than once is caller error, not a request the route cannot map: the first value is passed through and the name is
 * reported in `duplicateParameters` (see `duplicates`), which the handler refuses with Calendar's 400 `invalid` envelope
 * before reading anything else. Values are never joined: "a,b" would be searched for or parsed as if the caller sent it.
 */
function one(query, name) {
  const values = query[name];
  if (values === undefined) return undefined;
  return values[0];
}

/**
 * Names of the singular query parameters the caller supplied more than once, from the codec's fixed list of names (never
 * caller-chosen keys), or undefined. Passed to the operation as `duplicateParameters` so the refusal carries Calendar's
 * envelope (a decoder throw would answer the framework's `HTTP_REQUEST_MAPPING_FAILED` instead).
 */
function duplicates(query, names) {
  const found = names.filter((name) => Array.isArray(query[name]) && query[name].length > 1);
  return found.length === 0 ? undefined : found;
}

/** Refuses a request whose codec reported a repeated singular parameter; runs before any other input is read. */
function refuseDuplicates(context, input) {
  const names = input?.duplicateParameters;
  if (!Array.isArray(names) || names.length === 0) return;
  invalid(context, `Invalid value for parameter ${echoValue(names[0])}: the parameter was supplied more than once`);
}

/**
 * Numeric query parameter. Text that is not a positive integer (`0`, `abc`, a repeated parameter) is passed through
 * as a string; the handler refuses it with Calendar's invalid-parameter error.
 */
function integerParam(query, name, maximum) {
  const value = one(query, name);
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]{0,6}$/.test(value)) return value;
  return Math.min(Number(value), maximum);
}

/** Numeric parameter consumed by the codec itself (no handler sees it), so it must be mapped or refused here. */
function strictIntegerParam(query, name, maximum) {
  const value = integerParam(query, name, maximum);
  if (typeof value === "string") throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function booleanParam(query, name) {
  const value = one(query, name);
  if (value === undefined) return undefined;
  if (value !== "true" && value !== "false") throw new TypeError(`${name} must be true or false`);
  return value === "true";
}

function jsonBody(request) {
  if (request.body.kind !== "json") throw new TypeError("JSON object body required");
  const value = assertJsonDepth(request.body.value);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("JSON object body required");
  return value;
}

function pathParam(request, name) {
  const value = request.path[name];
  if (value === undefined || value === "") throw new TypeError(`${name} is required`);
  return value;
}

function mutation(request, args) {
  const key = one(request.headers, "idempotency-key");
  return key ? { arguments: compact(args), idempotencyKey: key } : { arguments: compact(args) };
}

function ifMatch(request) {
  const value = one(request.headers, "if-match");
  return value === undefined || value === "*" ? undefined : value;
}

function rejectUnsupported(query) {
  for (const name of ["privateExtendedProperty", "sharedExtendedProperty"]) {
    if (query[name] !== undefined) throw new TypeError(`Unsupported parameter: ${name}`);
  }
}

function encodeWith(render, emptyOnSuccess = false) {
  return ({ outcome }) => {
    if (outcome.status !== "ok") return calendarError(outcome);
    if (emptyOnSuccess) return { body: { kind: "empty" } };
    return { body: { kind: "json", value: render(outcome.value) } };
  };
}

const passThrough = encodeWith((value) => value);
const eventResponse = encodeWith(restEvent);

/** REST `orderBy`: `startTime` or `updated`. Any other text passes through so the handler answers Calendar's 400 `invalid`. */
function orderByParam(query) {
  const value = one(query, "orderBy");
  if (value === undefined) return undefined;
  if (value === "updated") return "lastModified";
  return value;
}

function eventTypesParam(query) {
  const values = query.eventTypes;
  if (values === undefined) return undefined;
  return values.map((value) => (Object.hasOwn(EVENT_TYPE_ENUM, value) ? EVENT_TYPE_ENUM[value] : value));
}

function sendUpdatesParam(query) {
  const value = one(query, "sendUpdates");
  if (value === undefined) return undefined;
  const level = Object.hasOwn(SEND_UPDATES_LEVEL, value) ? SEND_UPDATES_LEVEL[value] : undefined;
  if (level === undefined) throw new TypeError("sendUpdates must be all, externalOnly or none");
  return level;
}

function eventWriteArguments(request, replace) {
  const version = strictIntegerParam(request.query, "conferenceDataVersion", 1);
  return {
    ...eventBodyToCanonical(jsonBody(request), { sendUpdates: sendUpdatesParam(request.query), conferenceDataVersion: version, replace }),
    duplicateParameters: duplicates(request.query, ["sendUpdates", "conferenceDataVersion"]),
  };
}

const LIST_EVENTS_PARAMETERS = [
  "maxResults",
  "pageToken",
  "timeMin",
  "timeMax",
  "timeZone",
  "orderBy",
  "q",
  "singleEvents",
  "showDeleted",
  "updatedMin",
  "iCalUID",
  "maxAttendees",
  "syncToken",
];

const http = {
  "list-calendar-list": {
    decode: (request) => ({
      arguments: compact({
        pageSize: integerParam(request.query, "maxResults", MAX_PAGE),
        pageToken: one(request.query, "pageToken"),
        minAccessRole: one(request.query, "minAccessRole"),
        showHidden: booleanParam(request.query, "showHidden"),
        showDeleted: booleanParam(request.query, "showDeleted"),
        duplicateParameters: duplicates(request.query, ["maxResults", "pageToken", "minAccessRole", "showHidden", "showDeleted"]),
      }),
    }),
    encode: encodeWith(restCalendarList),
  },
  "get-calendar-list-entry": {
    decode: (request) => ({ arguments: { calendarId: pathParam(request, "calendarId") } }),
    encode: encodeWith(restCalendarListEntry),
  },
  "patch-calendar-list-entry": {
    decode: (request) => {
      const body = jsonBody(request);
      return mutation(request, {
        calendarId: pathParam(request, "calendarId"),
        colorId: body.colorId,
        backgroundColor: body.backgroundColor,
        foregroundColor: body.foregroundColor,
        selected: body.selected,
        hidden: body.hidden,
        defaultReminders: body.defaultReminders,
        etag: ifMatch(request),
      });
    },
    encode: encodeWith(restCalendarListEntry),
  },
  "get-calendar": {
    decode: (request) => ({ arguments: { calendarId: pathParam(request, "calendarId") } }),
    encode: encodeWith(restCalendar),
  },
  "insert-calendar": {
    decode: (request) => {
      const body = jsonBody(request);
      return mutation(request, { summary: body.summary ?? "", description: body.description, location: body.location, timeZone: body.timeZone });
    },
    encode: encodeWith(restCalendar),
  },
  "patch-calendar": {
    decode: (request) => {
      const body = jsonBody(request);
      return mutation(request, {
        calendarId: pathParam(request, "calendarId"),
        summary: body.summary,
        description: body.description,
        location: body.location,
        timeZone: body.timeZone,
        etag: ifMatch(request),
      });
    },
    encode: encodeWith(restCalendar),
  },
  "delete-calendar": {
    decode: (request) => mutation(request, { calendarId: pathParam(request, "calendarId") }),
    encode: encodeWith(() => null, true),
  },
  "list-events": {
    decode: (request) => {
      rejectUnsupported(request.query);
      return {
        arguments: compact({
          calendarId: pathParam(request, "calendarId"),
          pageSize: integerParam(request.query, "maxResults", MAX_PAGE),
          pageToken: one(request.query, "pageToken"),
          startTime: one(request.query, "timeMin"),
          endTime: one(request.query, "timeMax"),
          timeZone: one(request.query, "timeZone"),
          orderBy: orderByParam(request.query),
          fullText: one(request.query, "q"),
          eventType: eventTypesParam(request.query),
          singleEvents: booleanParam(request.query, "singleEvents"),
          showDeleted: booleanParam(request.query, "showDeleted"),
          updatedMin: one(request.query, "updatedMin"),
          iCalUID: one(request.query, "iCalUID"),
          maxAttendees: integerParam(request.query, "maxAttendees", 100),
          syncToken: one(request.query, "syncToken"),
          duplicateParameters: duplicates(request.query, LIST_EVENTS_PARAMETERS),
        }),
      };
    },
    encode: encodeWith(restEvents),
  },
  "insert-event": {
    decode: (request) => mutation(request, { calendarId: pathParam(request, "calendarId"), ...eventWriteArguments(request, false) }),
    encode: eventResponse,
  },
  "quick-add-event": {
    decode: (request) =>
      mutation(request, {
        calendarId: pathParam(request, "calendarId"),
        text: one(request.query, "text") ?? "",
        notificationLevel: sendUpdatesParam(request.query),
        duplicateParameters: duplicates(request.query, ["text", "sendUpdates"]),
      }),
    encode: eventResponse,
  },
  "get-event": {
    decode: (request) => ({
      arguments: compact({
        calendarId: pathParam(request, "calendarId"),
        eventId: pathParam(request, "eventId"),
        timeZone: one(request.query, "timeZone"),
        maxAttendees: integerParam(request.query, "maxAttendees", 100),
        duplicateParameters: duplicates(request.query, ["timeZone", "maxAttendees"]),
      }),
    }),
    encode: eventResponse,
  },
  "patch-event": {
    decode: (request) =>
      mutation(request, {
        calendarId: pathParam(request, "calendarId"),
        eventId: pathParam(request, "eventId"),
        ...eventWriteArguments(request, false),
        etag: ifMatch(request),
      }),
    encode: eventResponse,
  },
  "update-event": {
    decode: (request) =>
      mutation(request, {
        calendarId: pathParam(request, "calendarId"),
        eventId: pathParam(request, "eventId"),
        ...eventWriteArguments(request, true),
        etag: ifMatch(request),
      }),
    encode: eventResponse,
  },
  "delete-event": {
    decode: (request) =>
      mutation(request, {
        calendarId: pathParam(request, "calendarId"),
        eventId: pathParam(request, "eventId"),
        notificationLevel: sendUpdatesParam(request.query),
        duplicateParameters: duplicates(request.query, ["sendUpdates"]),
      }),
    encode: encodeWith(() => null, true),
  },
  "move-event": {
    decode: (request) => {
      const destination = one(request.query, "destination");
      if (destination === undefined || destination === "") throw new TypeError("destination is required");
      return mutation(request, {
        calendarId: pathParam(request, "calendarId"),
        eventId: pathParam(request, "eventId"),
        destination,
        notificationLevel: sendUpdatesParam(request.query),
        duplicateParameters: duplicates(request.query, ["destination", "sendUpdates"]),
      });
    },
    encode: eventResponse,
  },
  "list-instances": {
    decode: (request) => ({
      arguments: compact({
        calendarId: pathParam(request, "calendarId"),
        eventId: pathParam(request, "eventId"),
        pageSize: integerParam(request.query, "maxResults", MAX_PAGE),
        pageToken: one(request.query, "pageToken"),
        startTime: one(request.query, "timeMin"),
        endTime: one(request.query, "timeMax"),
        timeZone: one(request.query, "timeZone"),
        showDeleted: booleanParam(request.query, "showDeleted"),
        originalStart: one(request.query, "originalStart"),
        duplicateParameters: duplicates(request.query, ["maxResults", "pageToken", "timeMin", "timeMax", "timeZone", "showDeleted", "originalStart"]),
      }),
    }),
    encode: encodeWith(restEvents),
  },
  "query-freebusy": {
    decode: (request) => {
      const body = jsonBody(request);
      return {
        arguments: compact({
          timeMin: body.timeMin,
          timeMax: body.timeMax,
          timeZone: body.timeZone,
          items: body.items,
          groupExpansionMax: body.groupExpansionMax,
          calendarExpansionMax: body.calendarExpansionMax,
        }),
      };
    },
    encode: encodeWith(restFreeBusy),
  },
  "get-colors": {
    decode: () => ({ arguments: {} }),
    encode: passThrough,
  },
  "list-settings": {
    decode: (request) => ({
      arguments: compact({
        pageSize: integerParam(request.query, "maxResults", MAX_PAGE),
        pageToken: one(request.query, "pageToken"),
        duplicateParameters: duplicates(request.query, ["maxResults", "pageToken"]),
      }),
    }),
    encode: encodeWith(restSettings),
  },
  "get-setting": {
    decode: (request) => ({ arguments: { setting: pathParam(request, "setting") } }),
    encode: encodeWith(restSetting),
  },
};

for (const [id, handler] of Object.entries(operations)) {
  operations[id] = (input, context) => {
    refuseDuplicates(context, input);
    return handler(input, context);
  };
}

export default { operations, http };
