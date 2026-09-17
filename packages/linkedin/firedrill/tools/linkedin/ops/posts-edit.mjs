// posts.update (partial update) and posts.delete (idempotent tombstone with cascade).
import { findPost, visibility } from "../lib/access.mjs";
import { caller, checkWire, managesAuthor, requireScope, urnField } from "../lib/auth.mjs";
import { deleteThread } from "../lib/cascade.mjs";
import { blank, fail, invalidValue, missing, notFound } from "../lib/errors.mjs";
import { commentaryArg } from "../lib/postinput.mjs";
import { renderPost } from "../lib/render.mjs";
import { nowMs } from "../lib/store.mjs";
import { activityUrn, parseUrn, personUrn, postUrnOf } from "../lib/urn.mjs";

/** Loads a post the caller may manage (author, or a poster of the authoring page) and checks the write scope. */
function managedPost(context, who, input, resource) {
  const parsed = urnField(context, "postUrn", input.postUrn, ["share", "ugcPost"], { inPath: input.wire !== undefined });
  const post = findPost(context, parsed);
  if (post === null) notFound(context, `Post ${parsed.urn} not found`);
  const organization = parseUrn(post.author)?.type === "organization";
  requireScope(context, who, [organization ? "w_organization_social" : "w_member_social"], resource);
  const seen = post.deletedAtMs === null ? visibility(context, who, post, "AUTHOR") : "ok";
  if (seen === "missing") notFound(context, `Post ${parsed.urn} not found`);
  if (seen === "hidden" || !managesAuthor(context, who, post.author)) {
    fail(context, "ACCESS_DENIED", `Not enough permissions to access: ${resource} ${parsed.urn}`);
  }
  return { post, parsed };
}

export function updatePost(input, context) {
  const who = caller(context);
  checkWire(context, input, "PARTIAL_UPDATE");
  const { post, parsed } = managedPost(context, who, input, "POST /posts");
  if (typeof input.wire?.fieldError === "string") invalidValue(context, input.wire.fieldError, "an unsupported patch");
  if (post.deletedAtMs !== null) notFound(context, `Post ${parsed.urn} not found`);
  const fields = ["commentary", "lifecycleState", "contentCallToActionLabel", "contentLandingPage"].filter((f) => input[f] !== undefined);
  if (fields.length === 0) missing(context, "patch/$set");
  if (input.contentCallToActionLabel !== undefined) invalidValue(context, "contentCallToActionLabel", input.contentCallToActionLabel);
  if (input.contentLandingPage !== undefined) invalidValue(context, "contentLandingPage", input.contentLandingPage);
  const next = { ...post };
  if (input.lifecycleState !== undefined) {
    if (input.lifecycleState !== "PUBLISHED") invalidValue(context, "lifecycleState", input.lifecycleState);
    next.lifecycleState = "PUBLISHED";
  }
  if (input.commentary !== undefined) {
    const commentary = commentaryArg(context, input.commentary);
    if (commentary === "" && post.article === null && post.reshareParent === null) blank(context, "commentary");
    next.commentary = commentary;
    if (commentary !== post.commentary && post.lifecycleState === "PUBLISHED") next.isEditedByAuthor = true;
  }
  const publishing = post.lifecycleState === "DRAFT" && next.lifecycleState === "PUBLISHED";
  if (!publishing && next.commentary === post.commentary && next.isEditedByAuthor === post.isEditedByAuthor) return renderPost(post);
  const now = nowMs(context);
  next.lastModifiedAtMs = now;
  if (publishing) next.publishedAtMs = now;
  context.state.put("posts", post.id, next);
  if (publishing) {
    context.events.emit("post.published", {
      postUrn: postUrnOf(next), activityUrn: activityUrn(next.activityId), author: next.author, visibility: next.visibility,
      reshareParent: next.reshareParent, publishedAt: now, createdBy: personUrn(who.personId),
    });
  }
  return renderPost(next);
}

export function deletePost(input, context) {
  const who = caller(context);
  checkWire(context, input, "DELETE");
  const { post, parsed } = managedPost(context, who, input, "DELETE /posts");
  if (post.deletedAtMs !== null) return { id: parsed.urn, deleted: true };
  deleteThread(context, post.activityId);
  const now = nowMs(context);
  context.state.put("posts", post.id, { ...post, commentary: "", article: null, deletedAtMs: now, lastModifiedAtMs: now });
  return { id: parsed.urn, deleted: true };
}
