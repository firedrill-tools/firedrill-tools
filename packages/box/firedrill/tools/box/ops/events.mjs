// events.list: the caller's user event stream (all / changes), filtered by the caller's current access.
import { accessOf, canSee } from "../lib/access.mjs";
import { badParam } from "../lib/errors.mjs";
import { PAGE_BUDGET } from "../lib/listing.mjs";
import { miniOf, userMini } from "../lib/render.mjs";
import { EVENT_RETENTION } from "../lib/store.mjs";
import { jsonBytes, pad, rfc3339 } from "../lib/util.mjs";
import { renderCollab } from "./collabs.mjs";
import { renderComment } from "./comments.mjs";
import { begin } from "./common.mjs";

const NOT_CHANGES = new Set(["COLLAB_ADD_COLLABORATOR", "COLLAB_INVITE_COLLABORATOR", "COLLAB_REMOVE_COLLABORATOR", "COMMENT_CREATE"]);

function sourceOf(context, index, row) {
  if (row.sourceType === "folder" || row.sourceType === "file") {
    const item = (row.sourceType === "folder" ? index.folders : index.files).get(row.sourceId);
    return item === undefined ? { type: row.sourceType, id: row.sourceId } : miniOf(row.sourceType, item);
  }
  if (row.sourceType === "collaboration") {
    const collab = index.collabs.get(row.sourceId);
    return collab === undefined ? { type: "collaboration", id: row.sourceId } : renderCollab(index, collab);
  }
  const comment = context.state.get("comments", row.sourceId);
  return comment === null ? { type: "comment", id: row.sourceId } : renderComment(index, comment);
}

export function listEvents(input, context) {
  const { user, meta, index } = begin(context, input);
  const streamType = input.stream_type ?? "all";
  if (streamType !== "all" && streamType !== "changes") badParam(context, "stream_type", "stream_type must be all or changes for this synthetic service");
  if (input.event_type !== undefined) badParam(context, "event_type", "event_type filtering is only available for admin_logs streams");
  const raw = input.stream_position ?? "0";
  if (raw !== "now" && !/^[0-9]{1,18}$/.test(raw)) badParam(context, "stream_position", "stream_position must be now or a number");
  const latest = meta.nextStreamPosition - 1;
  const limit = input.limit ?? 100;
  if (raw === "now") return { chunk_size: 0, next_stream_position: String(latest), entries: [] };
  const requested = raw.length > 15 ? Number.MAX_SAFE_INTEGER : Number(raw);
  const after = Math.max(requested, meta.firstStreamPosition - 1);
  const entries = [];
  let next = Math.min(requested, latest);
  let bytes = 0;
  const rows = after >= latest ? [] : context.state.scan("event-log", { afterRowId: pad(after, 12), limit: EVENT_RETENTION + 1 });
  for (const { value: row } of rows) {
    if (entries.length >= limit) break;
    if (streamType === "changes" && NOT_CHANGES.has(row.eventType)) {
      next = row.position;
      continue;
    }
    const item = (row.itemType === "folder" ? index.folders : index.files).get(row.itemId);
    const visible = row.createdBy === user.id || (item !== undefined && canSee(accessOf(index, user.id, row.itemType, item), row.itemType));
    if (visible) {
      const entry = {
        type: "event", event_id: row.eventId, event_type: row.eventType, created_at: rfc3339(row.createdAtUs), recorded_at: rfc3339(row.createdAtUs),
        created_by: userMini(index, row.createdBy), session_id: null, source: sourceOf(context, index, row), additional_details: null,
      };
      const size = jsonBytes(entry) + 1;
      if (bytes + size > PAGE_BUDGET) break;
      bytes += size;
      entries.push(entry);
    }
    next = row.position;
  }
  return { chunk_size: entries.length, next_stream_position: String(Math.max(0, next)), entries };
}
