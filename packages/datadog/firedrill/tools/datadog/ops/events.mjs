// Events v1: post, list (time window, priority, sources, tags, aggregation, page), get.
import { bad, boolArg, caller, checkBudget, intArg, notFound, nowSec, present, requireInt, scanAll } from "../lib/core.mjs";
import { ALERT_TYPES, eventRowId, renderEvent, writeEvent } from "../lib/events-store.mjs";
import { csv, oneOf, tagList, text } from "../lib/text.mjs";

const PAGE_SIZE = 1000;
const MAX_SPAN = 32 * 86400;

export function eventsCreate(input, context) {
  const user = caller(context, { write: true });
  const title = text(context, input.title, "title", { required: true, max: 10000, trim: true });
  if (title.length === 0 || title.length > 100) bad(context, "Invalid parameter: title must be between 1 and 100 characters");
  const body = text(context, input.text, "text", { required: true, max: 4000 });
  const alertType = oneOf(context, input.alert_type, "alert_type", ALERT_TYPES, "info");
  const priority = oneOf(context, input.priority, "priority", ["normal", "low"], "normal");
  const tags = tagList(context, input.tags, "tags", { maxItems: 100 });
  const host = text(context, input.host, "host", { max: 255, noFffd: true });
  const aggregationKey = text(context, input.aggregation_key, "aggregation_key", { max: 100 });
  const sourceTypeName = text(context, input.source_type_name, "source_type_name", { max: 100 });
  const now = nowSec(context);
  const date = intArg(input.date_happened, 0, 99_999_999_999);
  if (date === undefined) bad(context, "Invalid parameter: date_happened must be an epoch timestamp in seconds");
  const happened = date ?? now;
  if (happened < now - 18 * 3600 || happened > now + 600) {
    bad(context, "Invalid parameter: date_happened must be within the last 18 hours and no more than 10 minutes in the future");
  }
  let related = null;
  if (present(input.related_event_id)) {
    related = intArg(input.related_event_id, 1, Number.MAX_SAFE_INTEGER);
    if (related === undefined || context.state.get("events", eventRowId(related)) === null) {
      bad(context, "Invalid parameter: related_event_id does not match an existing event");
    }
  }
  const row = writeEvent(context, {
    title, text: body, dateHappenedSec: happened, priority, alertType, host, aggregationKey, sourceTypeName, tags,
    relatedEventId: related, handle: user.handle,
  });
  return { status: "ok", event: renderEvent(row) };
}

export function eventsList(input, context) {
  caller(context);
  const start = requireInt(context, input.start, "start", 0, 99_999_999_999);
  const end = requireInt(context, input.end, "end", 0, 99_999_999_999);
  if (end < start) bad(context, "Invalid parameter: end must be greater than or equal to start");
  if (end - start > MAX_SPAN) bad(context, "Invalid parameter: the time range between start and end cannot exceed 32 days");
  const priority = oneOf(context, input.priority, "priority", ["normal", "low"], null);
  const sources = csv(context, input.sources, "sources").map((source) => source.toLowerCase());
  const tags = csv(context, input.tags, "tags");
  const unaggregated = boolArg(input.unaggregated);
  const excludeAggregate = boolArg(input.exclude_aggregate);
  if (unaggregated === undefined || excludeAggregate === undefined) bad(context, "Invalid parameter: unaggregated and exclude_aggregate must be booleans");
  const page = requireInt(context, input.page, "page", 0, 100_000, 0);
  const rows = scanAll(context, "events").map((record) => record.value).filter((row) => row.dateHappenedSec >= start
    && row.dateHappenedSec <= end
    && (priority === null || row.priority === priority)
    && (sources.length === 0 || (row.sourceTypeName !== null && sources.includes(row.sourceTypeName.toLowerCase())))
    && tags.every((tag) => row.tags.includes(tag)));
  rows.sort((a, b) => b.dateHappenedSec - a.dateHappenedSec || b.id - a.id);
  let items;
  if (unaggregated === true) {
    items = rows.map((row) => renderEvent(row));
  } else {
    const groups = new Map();
    const order = [];
    for (const row of rows) {
      const key = row.aggregationKey === null ? `#${row.id}` : `k:${row.aggregationKey}`;
      if (!groups.has(key)) { groups.set(key, []); order.push(key); }
      groups.get(key).push(row);
    }
    items = order.map((key) => {
      const [head, ...rest] = groups.get(key);
      return rest.length === 0 ? renderEvent(head) : renderEvent(head, rest);
    });
    if (excludeAggregate === true) items = items.filter((item) => !item.is_aggregate);
  }
  return checkBudget(context, { events: items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE), status: "ok" });
}

export function eventsGet(input, context) {
  caller(context);
  const raw = input.event_id;
  const id = typeof raw === "string" && /^[1-9][0-9]{0,15}$/.test(raw) ? Number(raw) : typeof raw === "number" ? raw : null;
  const row = id !== null && Number.isSafeInteger(id) && id > 0 ? context.state.get("events", eventRowId(id)) : null;
  if (row === null) notFound(context, "Event not found");
  return { event: renderEvent(row), status: "ok" };
}
