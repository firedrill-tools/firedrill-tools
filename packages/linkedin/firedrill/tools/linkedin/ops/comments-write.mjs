// comments.create, comments.update and comments.delete.
import { commentIdArg, loadThread } from "../lib/access.mjs";
import { actingAs, caller, checkWire, managesAuthor, requireScope } from "../lib/auth.mjs";
import { deleteComments, reactionsOn, threadComments } from "../lib/cascade.mjs";
import { fail, invalidValue, missing, notFound, unprocessable } from "../lib/errors.mjs";
import { messageArg } from "../lib/message.mjs";
import { renderComment } from "../lib/render.mjs";
import { nextId, nowMs } from "../lib/store.mjs";
import { activityUrn, commentUrn, parseUrn } from "../lib/urn.mjs";

const RESOURCE = "POST /socialActions/comments";
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The actor a comment edit or delete acts as: `?actor=` when given, otherwise the calling member. */
function effectiveActor(context, who, input, resource) {
  if (input.actor !== undefined && input.actor !== null) return actingAs(context, who, "actor", input.actor, resource);
  requireScope(context, who, ["w_member_social"], resource);
  return { urn: who.urn, kind: "person", id: who.personId, agent: null };
}

function loadComment(context, who, input, resource) {
  const inPath = input.wire !== undefined;
  const thread = loadThread(context, who, "target", input.target, resource, { inPath, write: true });
  const commentId = commentIdArg(context, input.commentId, inPath);
  const comment = context.state.get("comments", `${thread.post.activityId}|${commentId}`);
  if (comment === null) notFound(context, `Comment ${commentId} not found`);
  return { ...thread, row: comment };
}

export function createComment(input, context) {
  const who = caller(context);
  checkWire(context, input, "CREATE");
  const { post, comment: targetComment } = loadThread(context, who, "target", input.target, RESOURCE,
    { inPath: input.wire !== undefined, write: true });
  if (input.actor === undefined || input.actor === null) missing(context, "actor");
  const actor = actingAs(context, who, "actor", input.actor, RESOURCE);
  if (input.content !== undefined) {
    fail(context, "ACCESS_DENIED", "Unpermitted fields present in REQUEST_BODY: Data Processing Exception while processing fields [/content]");
  }
  const message = messageArg(context, input.message);
  const thread = activityUrn(post.activityId);
  if (input.object !== undefined && input.object !== null) {
    const object = parseUrn(input.object);
    const sameThread = object !== null && (input.object === thread || (object.type !== "comment" && object.type !== "activity"
      && object.id === post.id && object.type === post.kind));
    if (!sameThread) invalidValue(context, "object", input.object);
  }
  let parent = targetComment;
  if (input.parentComment !== undefined && input.parentComment !== null) {
    const parsed = parseUrn(input.parentComment);
    if (parsed === null || parsed.type !== "comment" || parsed.activityId !== post.activityId
      || (targetComment !== null && parsed.commentId !== targetComment.id)) invalidValue(context, "parentComment", input.parentComment);
    parent = context.state.get("comments", `${parsed.activityId}|${parsed.commentId}`);
    if (parent === null) notFound(context, `Comment ${parsed.urn} not found`);
  }
  if (parent !== null && parent.parentCommentId !== null) unprocessable(context, "Replies to a nested comment are not supported");
  if (post.lifecycleState === "DRAFT") unprocessable(context, "Cannot comment on a draft post");
  if (post.commentsState === "CLOSED") unprocessable(context, "Thread is closed to comments");
  const now = nowMs(context);
  const id = nextId(context);
  const row = {
    id, activityId: post.activityId, actor: actor.urn, agent: actor.agent, text: message.text, attributes: message.attributes,
    parentCommentId: parent === null ? null : parent.id, createdAtMs: now, lastModifiedAtMs: now,
  };
  context.state.put("comments", `${post.activityId}|${id}`, row);
  context.events.emit("comment.created", {
    commentUrn: commentUrn(post.activityId, id), object: thread, postUrn: `urn:li:${post.kind}:${post.id}`, actor: actor.urn,
    agent: actor.agent === null ? null : `urn:li:person:${actor.agent}`, parentComment: parent === null ? null : commentUrn(post.activityId, parent.id),
    created: now,
  });
  return renderComment(row, [], [], who.urn);
}

export function updateComment(input, context) {
  const who = caller(context);
  checkWire(context, input, "PARTIAL_UPDATE");
  const { row } = loadComment(context, who, input, "POST /socialActions/comments");
  if (typeof input.wire?.fieldError === "string") invalidValue(context, input.wire.fieldError, "an unsupported patch");
  const actor = effectiveActor(context, who, input, "POST /socialActions/comments");
  if (actor.urn !== row.actor) fail(context, "ACCESS_DENIED", "Not enough permissions to edit this comment");
  const message = messageArg(context, input.message);
  const urn = commentUrn(row.activityId, row.id);
  const replies = row.parentCommentId === null ? threadComments(context, row.activityId).filter((c) => c.parentCommentId === row.id) : [];
  if (message.text === row.text && sameJson(message.attributes, row.attributes)) {
    return renderComment(row, reactionsOn(context, urn), replies, who.urn);
  }
  const next = { ...row, text: message.text, attributes: message.attributes, lastModifiedAtMs: nowMs(context) };
  context.state.put("comments", `${row.activityId}|${row.id}`, next);
  return renderComment(next, reactionsOn(context, urn), replies, who.urn);
}

export function deleteComment(input, context) {
  const who = caller(context);
  checkWire(context, input, "DELETE");
  const { post, row } = loadComment(context, who, input, "DELETE /socialActions/comments");
  const actor = effectiveActor(context, who, input, "DELETE /socialActions/comments");
  if (actor.urn !== row.actor && !managesAuthor(context, who, post.author)) {
    fail(context, "ACCESS_DENIED", "Not enough permissions to delete this comment");
  }
  const replies = row.parentCommentId === null ? threadComments(context, row.activityId).filter((c) => c.parentCommentId === row.id) : [];
  const deletedReplies = deleteComments(context, replies);
  deleteComments(context, [row]);
  return { commentUrn: commentUrn(row.activityId, row.id), deleted: true, deletedReplies };
}
