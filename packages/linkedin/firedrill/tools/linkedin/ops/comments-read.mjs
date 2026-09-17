// comments.list and comments.get.
import { commentIdArg, loadThread } from "../lib/access.mjs";
import { caller, checkWire } from "../lib/auth.mjs";
import { reactionsOn, threadComments } from "../lib/cascade.mjs";
import { notFound } from "../lib/errors.mjs";
import { buildPage, pageArgs } from "../lib/paging.mjs";
import { compareIds } from "../lib/postinput.mjs";
import { renderComment } from "../lib/render.mjs";
import { commentUrn } from "../lib/urn.mjs";

const oldestFirst = (a, b) => a.createdAtMs - b.createdAtMs || compareIds(a.id, b.id);

/** Groups a thread's replies by parent id once per request. */
function repliesByParent(rows) {
  const map = new Map();
  for (const row of rows) {
    if (row.parentCommentId === null) continue;
    if (!map.has(row.parentCommentId)) map.set(row.parentCommentId, []);
    map.get(row.parentCommentId).push(row);
  }
  for (const list of map.values()) list.sort(oldestFirst);
  return map;
}

function encodePath(value) {
  try {
    return encodeURIComponent(value);
  } catch {
    return "";
  }
}

export function listComments(input, context) {
  const who = caller(context);
  checkWire(context, input, "GET_ALL");
  const { post, comment, parsed } = loadThread(context, who, "target", input.target, "GET /socialActions/comments",
    { inPath: input.wire !== undefined });
  const { start, count } = pageArgs(context, input);
  const rows = threadComments(context, post.activityId);
  const replies = repliesByParent(rows);
  const items = rows.filter((row) => (comment === null ? row.parentCommentId === null : row.parentCommentId === comment.id)).sort(oldestFirst);
  const render = (row) => renderComment(row, reactionsOn(context, commentUrn(row.activityId, row.id)), replies.get(row.id) ?? [], who.urn);
  return buildPage(context, items, render, { start, count, path: `/rest/socialActions/${encodePath(parsed.urn)}/comments` });
}

export function getComment(input, context) {
  const who = caller(context);
  checkWire(context, input, "GET");
  const inPath = input.wire !== undefined;
  const { post } = loadThread(context, who, "target", input.target, "GET /socialActions/comments", { inPath });
  const commentId = commentIdArg(context, input.commentId, inPath);
  const row = context.state.get("comments", `${post.activityId}|${commentId}`);
  if (row === null) notFound(context, `Comment ${commentId} not found`);
  const replies = row.parentCommentId === null
    ? threadComments(context, post.activityId).filter((reply) => reply.parentCommentId === row.id).sort(oldestFirst) : [];
  return renderComment(row, reactionsOn(context, commentUrn(row.activityId, row.id)), replies, who.urn);
}
