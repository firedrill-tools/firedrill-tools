// comments.create (on a file or as a reply) and comments.list-for-file.
import { READ, VIEW, can, requireFile } from "../lib/access.mjs";
import { badParam, denied, notFound } from "../lib/errors.mjs";
import { offsetPage } from "../lib/listing.mjs";
import { parseFields, select, userMini } from "../lib/render.mjs";
import { allocateId, appendLog, reserveObjects, saveMeta, scanAll } from "../lib/store.mjs";
import { isId, rfc3339 } from "../lib/util.mjs";
import { begin, putItem } from "./common.mjs";

const MAX_MESSAGE = 10000;

/** Renders `@[userid:name]` mentions as `@name` in one linear pass. */
export function plainMessage(tagged) {
  let out = "";
  let i = 0;
  while (i < tagged.length) {
    const start = tagged.indexOf("@[", i);
    if (start < 0) break;
    const close = tagged.indexOf("]", start + 2);
    const colon = close < 0 ? -1 : tagged.indexOf(":", start + 2);
    if (close < 0 || colon < 0 || colon > close || !/^[0-9]{1,20}$/.test(tagged.slice(start + 2, colon))) {
      out += tagged.slice(i, start + 2);
      i = start + 2;
      continue;
    }
    out += `${tagged.slice(i, start)}@${tagged.slice(colon + 1, close)}`;
    i = close + 1;
  }
  return out + tagged.slice(i);
}

export function renderComment(index, comment, fields = null) {
  return select({
    type: "comment", id: comment.id, is_reply_comment: comment.isReply, message: comment.message, tagged_message: comment.taggedMessage ?? comment.message,
    created_by: userMini(index, comment.createdBy), created_at: rfc3339(comment.createdAtUs), modified_at: rfc3339(comment.modifiedAtUs),
    item: { type: "file", id: comment.fileId },
  }, fields);
}

export function createComment(input, context) {
  const { user, meta, index } = begin(context, input);
  const fields = parseFields(context, input.fields);
  let fileId = input.item.id;
  let replyTo = null;
  if (input.item.type === "comment") {
    replyTo = isId(input.item.id) ? context.state.get("comments", input.item.id) : null;
    if (replyTo === null) notFound(context, "comment");
    fileId = replyTo.fileId;
  }
  const { file, access } = requireFile(context, index, user, fileId);
  if (!can(access, ...READ)) denied(context);
  const hasMessage = input.message !== undefined;
  const hasTagged = input.tagged_message !== undefined;
  if (hasMessage === hasTagged) badParam(context, "message", "Provide exactly one of message and tagged_message");
  const text = hasMessage ? input.message : input.tagged_message;
  if (text.trim().length === 0 || text.length > MAX_MESSAGE) badParam(context, "message", `message must be 1 to ${MAX_MESSAGE} characters`);
  reserveObjects(context, meta, 1);
  const now = context.clock.nowUs();
  const comment = {
    id: allocateId(context, meta, "nextCommentId"), fileId: file.id, message: hasTagged ? plainMessage(text) : text, taggedMessage: hasTagged ? text : null,
    isReply: replyTo !== null, replyToId: replyTo?.id ?? null, createdBy: user.id, createdAtUs: now, modifiedAtUs: now,
  };
  if (comment.message.length === 0) badParam(context, "tagged_message", "message must not be empty");
  context.state.put("comments", comment.id, comment);
  putItem(context, index, "file", { ...file, commentCount: file.commentCount + 1 });
  appendLog(context, meta, { eventType: "COMMENT_CREATE", createdBy: user.id, sourceType: "comment", sourceId: comment.id, itemType: "file", itemId: file.id });
  saveMeta(context, meta);
  return renderComment(index, comment, fields);
}

export function listFileComments(input, context) {
  const { user, index } = begin(context, input);
  const fields = parseFields(context, input.fields);
  const { file, access } = requireFile(context, index, user, input.file_id);
  if (!can(access, ...VIEW)) denied(context);
  const rows = scanAll(context, "comments").map((r) => r.value).filter((c) => c.fileId === file.id)
    .sort((a, b) => a.createdAtUs - b.createdAtUs || (a.id.padStart(20, "0") < b.id.padStart(20, "0") ? -1 : 1));
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 100;
  const entries = offsetPage(context, rows, offset, limit, (c) => renderComment(index, c, fields));
  return { total_count: rows.length, limit, offset, order: [{ by: "created_at", direction: "ASC" }], entries };
}
