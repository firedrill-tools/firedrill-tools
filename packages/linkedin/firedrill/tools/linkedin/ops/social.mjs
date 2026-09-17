// social_metadata.get and social_metadata.set_comments_state.
import { loadThread } from "../lib/access.mjs";
import { actingAs, caller, checkWire } from "../lib/auth.mjs";
import { deleteComments, threadComments } from "../lib/cascade.mjs";
import { fail, invalidValue, missing, notFound } from "../lib/errors.mjs";
import { reactionSummaries, summarize } from "../lib/social.mjs";

export function getSocialMetadata(input, context) {
  const who = caller(context);
  checkWire(context, input, "GET");
  const { post, comment, parsed } = loadThread(context, who, "entity", input.entity, "GET /socialMetadata", { inPath: input.wire !== undefined });
  if (post.lifecycleState === "DRAFT") notFound(context, "Not Found");
  const { commentSummary, reactions } = summarize(context, post, comment);
  return { entity: parsed.urn, commentsState: post.commentsState, commentSummary, reactionSummaries: reactionSummaries(reactions) };
}

export function setCommentsState(input, context) {
  const who = caller(context);
  checkWire(context, input, "PARTIAL_UPDATE");
  const { post, parsed } = loadThread(context, who, "entity", input.entity, "POST /socialMetadata",
    { inPath: input.wire !== undefined, types: ["share", "ugcPost", "activity"], write: true });
  if (typeof input.wire?.fieldError === "string") invalidValue(context, input.wire.fieldError, "an unsupported patch");
  if (input.actor === undefined || input.actor === null) missing(context, "actor");
  const actor = actingAs(context, who, "actor", input.actor, "POST /socialMetadata");
  const state = input.commentsState;
  if (state === undefined || state === null) missing(context, "commentsState");
  if (state !== "OPEN" && state !== "CLOSED") invalidValue(context, "commentsState", state);
  if (post.lifecycleState === "DRAFT") notFound(context, "Not Found");
  if (actor.urn !== post.author) fail(context, "ACCESS_DENIED", "Only the author of the post can change its comments state");
  if (post.commentsState === state) return { entity: parsed.urn, commentsState: state, deletedComments: 0 };
  const deletedComments = state === "CLOSED" ? deleteComments(context, threadComments(context, post.activityId)) : 0;
  context.state.put("posts", post.id, { ...post, commentsState: state });
  return { entity: parsed.urn, commentsState: state, deletedComments };
}
