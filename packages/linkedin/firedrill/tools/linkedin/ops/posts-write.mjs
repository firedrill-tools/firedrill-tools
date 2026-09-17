// posts.create, posts.update and posts.delete.
import { findPost, visibility } from "../lib/access.mjs";
import { actingAs, caller, checkWire, urnField } from "../lib/auth.mjs";
import { blank, invalidValue, missing, notFound, unprocessable } from "../lib/errors.mjs";
import { FEED_DISTRIBUTIONS, VISIBILITIES, commentaryArg, contentArg } from "../lib/postinput.mjs";
import { renderPost } from "../lib/render.mjs";
import { nextId, nowMs } from "../lib/store.mjs";
import { activityUrn, personUrn, postUrnOf } from "../lib/urn.mjs";

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function emitPublished(context, post, who) {
  context.events.emit("post.published", {
    postUrn: postUrnOf(post), activityUrn: activityUrn(post.activityId), author: post.author, visibility: post.visibility,
    reshareParent: post.reshareParent, publishedAt: post.publishedAtMs, createdBy: personUrn(who.personId),
  });
}

function distributionArg(context, distribution) {
  if (distribution === undefined || distribution === null) return missing(context, "distribution");
  if (!isObject(distribution)) return invalidValue(context, "distribution", distribution);
  const feed = distribution.feedDistribution;
  if (feed === undefined || feed === null) return missing(context, "distribution/feedDistribution");
  if (typeof feed !== "string" || !FEED_DISTRIBUTIONS.has(feed)) return invalidValue(context, "distribution/feedDistribution", feed);
  for (const field of ["targetEntities", "thirdPartyDistributionChannels"]) {
    const value = distribution[field];
    if (value !== undefined && value !== null && (!Array.isArray(value) || value.length > 0)) invalidValue(context, `distribution/${field}`, value);
  }
  return feed;
}

function reshareArg(context, who, reshareContext) {
  if (reshareContext === undefined || reshareContext === null) return null;
  if (!isObject(reshareContext)) return invalidValue(context, "reshareContext", reshareContext);
  const parsed = urnField(context, "reshareContext/parent", reshareContext.parent, ["share", "ugcPost"]);
  const parent = findPost(context, parsed);
  if (parent === null || parent.deletedAtMs !== null) notFound(context, `Post ${parsed.urn} not found`);
  if (parent.lifecycleState === "DRAFT") unprocessable(context, "Cannot reshare a draft post");
  if (visibility(context, who, parent) !== "ok") notFound(context, `Post ${parsed.urn} not found`);
  if (parent.isReshareDisabledByAuthor) unprocessable(context, "Reshare is disabled by the author");
  return { parent: parsed.urn, root: parent.reshareRoot ?? parsed.urn };
}

export function createPost(input, context) {
  const who = caller(context);
  checkWire(context, input, "CREATE");
  if (input.author === undefined || input.author === null) missing(context, "author");
  const actor = actingAs(context, who, "author", input.author, "POST /posts");
  if (input.visibility === undefined || input.visibility === null) missing(context, "visibility");
  if (typeof input.visibility !== "string" || !VISIBILITIES.has(input.visibility)) invalidValue(context, "visibility", input.visibility);
  if (actor.kind === "organization" && input.visibility === "CONNECTIONS") invalidValue(context, "visibility", input.visibility);
  const feedDistribution = distributionArg(context, input.distribution);
  if (input.lifecycleState === undefined || input.lifecycleState === null) missing(context, "lifecycleState");
  if (input.lifecycleState !== "PUBLISHED") invalidValue(context, "lifecycleState", input.lifecycleState);
  const article = contentArg(context, input.content);
  const reshare = reshareArg(context, who, input.reshareContext);
  const commentary = commentaryArg(context, input.commentary);
  if (commentary === "" && article === null && reshare === null) blank(context, "commentary");
  const reshareDisabled = input.isReshareDisabledByAuthor ?? false;
  if (typeof reshareDisabled !== "boolean") invalidValue(context, "isReshareDisabledByAuthor", reshareDisabled);
  const now = nowMs(context);
  const id = nextId(context);
  const activityId = nextId(context);
  const post = {
    id, kind: input.kind === "ugcPost" ? "ugcPost" : "share", activityId, author: actor.urn, commentary, visibility: input.visibility,
    feedDistribution, lifecycleState: "PUBLISHED", isReshareDisabledByAuthor: reshareDisabled, isEditedByAuthor: false, article,
    reshareParent: reshare?.parent ?? null, reshareRoot: reshare?.root ?? null, commentsState: "OPEN", createdBy: who.personId,
    createdAtMs: now, lastModifiedAtMs: now, publishedAtMs: now, deletedAtMs: null,
  };
  context.state.put("posts", id, post);
  context.state.put("activities", activityId, { postId: id });
  emitPublished(context, post, who);
  return renderPost(post);
}
