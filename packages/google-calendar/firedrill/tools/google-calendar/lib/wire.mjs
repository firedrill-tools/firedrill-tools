// Calendar API v3 wire shapes: error envelope, REST resources from canonical values, REST bodies to canonical arguments.
// Pure functions only (no state), so the HTTP codecs can use them.
import { hashText } from "./ids.mjs";

export const EVENT_TYPE_ENUM = {
  default: "DEFAULT",
  outOfOffice: "OUT_OF_OFFICE",
  focusTime: "FOCUS_TIME",
  workingLocation: "WORKING_LOCATION",
  birthday: "BIRTHDAY",
  fromGmail: "FROM_GMAIL",
};
export const EVENT_TYPE_VALUE = Object.fromEntries(Object.entries(EVENT_TYPE_ENUM).map(([value, name]) => [name, value]));

export const SEND_UPDATES_LEVEL = { all: "ALL", externalOnly: "EXTERNAL_ONLY", none: "NONE" };

const ERROR_MAP = {
  INVALID_ARGUMENT: { status: 400, domain: "global", reason: "invalid" },
  INVALID_PAGE_TOKEN: { status: 400, domain: "global", reason: "invalid", locationType: "parameter", location: "pageToken" },
  TIME_RANGE_EMPTY: { status: 400, domain: "calendar", reason: "timeRangeEmpty", locationType: "parameter", location: "timeMax" },
  FAILED_PRECONDITION: { status: 400, domain: "global", reason: "failedPrecondition" },
  FORBIDDEN: { status: 403, domain: "global", reason: "forbidden" },
  REQUIRED_ACCESS_LEVEL: { status: 403, domain: "calendar", reason: "requiredAccessLevel" },
  FORBIDDEN_FOR_NON_ORGANIZER: { status: 403, domain: "calendar", reason: "forbiddenForNonOrganizer" },
  RATE_LIMITED: { status: 403, domain: "usageLimits", reason: "rateLimitExceeded" },
  NOT_FOUND: { status: 404, domain: "global", reason: "notFound" },
  ALREADY_EXISTS: { status: 409, domain: "global", reason: "duplicate" },
  GONE: { status: 410, domain: "global", reason: "deleted" },
  CONDITION_NOT_MET: { status: 412, domain: "global", reason: "conditionNotMet", locationType: "header", location: "If-Match" },
  BACKEND_ERROR: { status: 500, domain: "global", reason: "backendError" },
};

/** Calendar-shaped error envelope for any non-ok outcome (framework outcomes included). */
export function calendarError(outcome) {
  const error = outcome.error ?? {};
  let mapping;
  let message = typeof error.message === "string" && error.message.length > 0 ? error.message : "Request failed";
  if (outcome.status === "tool_error") {
    const code = String(error.code ?? "").replace(/^tool\./, "");
    mapping = Object.hasOwn(ERROR_MAP, code) ? ERROR_MAP[code] : { status: 500, domain: "global", reason: "backendError" };
    if (code === "INVALID_ARGUMENT" && /^Missing /.test(message)) mapping = { ...mapping, reason: "required" };
  } else if (outcome.status === "denied") {
    mapping = { status: 403, domain: "global", reason: "forbidden" };
    message = "Insufficient Permission";
  } else if (outcome.status === "unsupported") {
    mapping = { status: 404, domain: "global", reason: "notFound" };
    message = "Not Found";
  } else {
    mapping = { status: 400, domain: "global", reason: "badRequest" };
  }
  const detail = { domain: mapping.domain, reason: mapping.reason, message };
  if (mapping.locationType !== undefined) {
    detail.locationType = mapping.locationType;
    detail.location = mapping.location;
  }
  return {
    headers: mapping.reason === "rateLimitExceeded" ? { "retry-after": "30" } : {},
    body: { kind: "json", value: { error: { errors: [detail], code: mapping.status, message } } },
  };
}

function withoutUndefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

/** Canonical Event → REST `Event` resource: drops the MCP conveniences and the row's calendarId, adds `kind`. */
export function restEvent(event) {
  const { calendarId, conferenceUrl, availability, ...rest } = event;
  return { kind: "calendar#event", ...rest };
}

export function restCalendarListEntry(entry) {
  return { kind: "calendar#calendarListEntry", ...entry };
}

export function restCalendar(calendar) {
  return { kind: "calendar#calendar", ...calendar };
}

function listEtag(items, extra) {
  return `"p${hashText(`${extra}|${items.map((item) => item.etag ?? "").join("|")}`)}"`;
}

export function restCalendarList(value) {
  const items = value.calendars.map(restCalendarListEntry);
  return withoutUndefined({ kind: "calendar#calendarList", etag: listEtag(items, "calendarList"), items, nextPageToken: value.nextPageToken });
}

export function restEvents(value) {
  const items = value.events.map(restEvent);
  return withoutUndefined({
    kind: "calendar#events",
    etag: listEtag(items, value.updated ?? ""),
    summary: value.summary,
    description: value.description,
    updated: value.updated,
    timeZone: value.timeZone,
    accessRole: value.accessRole,
    defaultReminders: value.defaultReminders ?? [],
    items,
    nextPageToken: value.nextPageToken,
  });
}

export function restFreeBusy(value) {
  return { kind: "calendar#freeBusy", timeMin: value.timeMin, timeMax: value.timeMax, calendars: value.calendars };
}

export function restSettings(value) {
  const items = value.items.map((item) => ({ kind: "calendar#setting", ...item }));
  return { kind: "calendar#settings", etag: listEtag(items, "settings"), items };
}

export function restSetting(value) {
  return { kind: "calendar#setting", ...value };
}

// ---------------------------------------------------------------------------------------------
// REST request bodies → canonical arguments
// ---------------------------------------------------------------------------------------------

function objectOrThrow(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be a JSON object`);
  return value;
}

function attendeeToCanonical(attendee, index) {
  const record = objectOrThrow(attendee, `attendees[${index}]`);
  return withoutUndefined({
    email: record.email,
    displayName: record.displayName,
    optionalAttendee: record.optional,
    responseStatus: record.responseStatus,
    resource: record.resource,
    additionalGuests: record.additionalGuests,
    comment: record.comment,
  });
}

function timeSide(side, name) {
  if (side === undefined) return { time: undefined, allDay: undefined, timeZone: undefined };
  const record = objectOrThrow(side, name);
  if (record.date !== undefined && record.dateTime !== undefined) throw new TypeError(`${name} must carry either date or dateTime`);
  return {
    time: record.dateTime ?? record.date,
    allDay: record.date !== undefined ? true : record.dateTime !== undefined ? false : undefined,
    timeZone: record.timeZone,
  };
}

/**
 * REST `Event` body (+ query) → canonical insert/patch arguments.
 * `conferenceDataVersion` must be 1 for conference changes to take effect, as in Google's API.
 */
export function eventBodyToCanonical(body, { sendUpdates, conferenceDataVersion, replace = false } = {}) {
  const record = objectOrThrow(body, "body");
  const start = timeSide(record.start, "start");
  const end = timeSide(record.end, "end");
  const allDay = start.allDay ?? end.allDay;
  const guest = {};
  if (record.guestsCanInviteOthers !== undefined) guest.guestsCanInviteOthers = record.guestsCanInviteOthers;
  if (record.guestsCanModify !== undefined) guest.guestsCanModify = record.guestsCanModify;
  if (record.guestsCanSeeOtherGuests !== undefined) guest.guestsCanSeeGuests = record.guestsCanSeeOtherGuests;
  const conference = conferenceDataVersion === 1 ? record.conferenceData : undefined;
  let addGoogleMeetUrl;
  let googleMeetUrl;
  let removeConference;
  if (conference === null) removeConference = true;
  else if (conference !== undefined) {
    const data = objectOrThrow(conference, "conferenceData");
    if (data.createRequest !== undefined) addGoogleMeetUrl = true;
    const video = Array.isArray(data.entryPoints) ? data.entryPoints.find((point) => point?.entryPointType === "video") : undefined;
    if (video?.uri !== undefined) googleMeetUrl = video.uri;
  }
  const reminders = record.reminders === undefined ? undefined : objectOrThrow(record.reminders, "reminders");
  const canonical = withoutUndefined({
    id: record.id,
    summary: record.summary ?? (replace ? "" : undefined),
    description: record.description,
    location: record.location,
    colorId: record.colorId,
    visibility: record.visibility,
    status: record.status,
    sequence: record.sequence,
    eventType: record.eventType === undefined ? undefined : (Object.hasOwn(EVENT_TYPE_ENUM, record.eventType) ? EVENT_TYPE_ENUM[record.eventType] : String(record.eventType)),
    availability:
      record.transparency === undefined
        ? undefined
        : record.transparency === "transparent"
          ? "AVAILABILITY_FREE"
          : record.transparency === "opaque"
            ? "AVAILABILITY_BUSY"
            : String(record.transparency),
    startTime: start.time,
    endTime: end.time,
    allDay,
    timeZone: start.timeZone ?? end.timeZone,
    attendees: Array.isArray(record.attendees) ? record.attendees.map(attendeeToCanonical) : record.attendees,
    recurrenceData: record.recurrence,
    overrideReminders: reminders?.overrides,
    useDefaultReminders: reminders?.useDefault,
    addGoogleMeetUrl,
    googleMeetUrl,
    removeConference,
    guestPermissions: Object.keys(guest).length > 0 ? guest : undefined,
    anyoneCanAddSelf: record.anyoneCanAddSelf,
    notificationLevel: sendUpdates === undefined ? undefined : (Object.hasOwn(SEND_UPDATES_LEVEL, sendUpdates) ? SEND_UPDATES_LEVEL[sendUpdates] : String(sendUpdates)),
  });
  if (replace) canonical.replace = true;
  return canonical;
}
