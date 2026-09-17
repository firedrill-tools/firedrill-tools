// reactions.create (create or replace), reactions.list (compound-key get and entity finder) and reactions.delete.
import { loadThread } from "../lib/access.mjs";
import { actingAs, caller, checkWire, urnField } from "../lib/auth.mjs";
import { reactionsOn } from "../lib/cascade.mjs";
import { invalidValue, missing, notFound } from "../lib/errors.mjs";
import { buildPage, pageArgs } from "../lib/paging.mjs";
import { renderReaction } from "../lib/render.mjs";
import { nowMs } from "../lib/store.mjs";
import { activityUrn, commentUrn, reactionId } from "../lib/urn.mjs";

export const REACTION_TYPES = new Set(["LIKE", "PRAISE", "APPRECIATION", "EMPATHY", "INTEREST", "ENTERTAINMENT"]);
const SORTS = new Set(["CHRONOLOGICAL", "REVERSE_CHRONOLOGICAL", "RELEVANCE"]);

/** Resolves a reaction entity (post, activity or comment URN) to its stored entity URN; drafts are not reactable. */
function entityOf(context, who, field, value, resource, write) {
  const { post, comment } = loadThread(context, who, field, value, resource, { write });
  if (post.lifecycleState === "DRAFT") notFound(context, "Not Found");
  return comment === null ? activityUrn(post.activityId) : commentUrn(comment.activityId, comment.id);
}

export function createReaction(input, context) {
  const who = caller(context);
  checkWire(context, input, "CREATE");
  if (input.actor === undefined || input.actor === null) missing(context, "actor");
  const actor = actingAs(context, who, "actor", input.actor, "POST /reactions");
  if (input.root === undefined || input.root === null) missing(context, "root");
  const entity = entityOf(context, who, "root", input.root, "POST /reactions", true);
  const type = input.reactionType;
  if (type === undefined || type === null) missing(context, "reactionType");
  if (type === "MAYBE") invalidValue(context, "reactionType", "MAYBE (deprecated)");
  if (typeof type !== "string" || !REACTION_TYPES.has(type)) invalidValue(context, "reactionType", type);
  const rowId = `${entity}|${actor.urn}`;
  const existing = context.state.get("reactions", rowId);
  if (existing !== null && existing.reactionType === type) return renderReaction(existing);
  const now = nowMs(context);
  const row = existing === null
    ? { entity, actor: actor.urn, reactionType: type, impersonator: actor.agent, createdAtMs: now, lastModifiedAtMs: now }
    : { ...existing, reactionType: type, impersonator: actor.agent, lastModifiedAtMs: now };
  context.state.put("reactions", rowId, row);
  context.events.emit("reaction.created", {
    reactionId: reactionId(actor.urn, entity), root: entity, actor: actor.urn, reactionType: type,
    previousReactionType: existing === null ? null : existing.reactionType, created: now,
  });
  return renderReaction(row);
}

export function listReactions(input, context) {
  const who = caller(context);
  const single = input.single === true;
  checkWire(context, input, single ? "GET" : "FINDER");
  const entity = entityOf(context, who, "entity", input.entity, "GET /reactions", false);
  if (single) {
    const actor = urnField(context, "actor", input.actor, ["person", "organization"]);
    const row = context.state.get("reactions", `${entity}|${actor.urn}`);
    if (row === null) notFound(context, "Not Found");
    return { paging: { start: 0, count: 1, links: [], total: 1 }, elements: [renderReaction(row)] };
  }
  const sort = input.sort ?? "REVERSE_CHRONOLOGICAL";
  if (typeof sort !== "string" || !SORTS.has(sort)) invalidValue(context, "sort", sort);
  const { start, count } = pageArgs(context, input);
  const direction = sort === "CHRONOLOGICAL" ? 1 : -1;
  const rows = reactionsOn(context, entity)
    .sort((a, b) => direction * (a.createdAtMs - b.createdAtMs) || (a.actor < b.actor ? -1 : a.actor > b.actor ? 1 : 0));
  return buildPage(context, rows, renderReaction, {
    start, count, path: `/rest/reactions/(entity:${entity})`, query: [["q", "entity"], ["sort", `(value:${sort})`]],
  });
}

export function deleteReaction(input, context) {
  const who = caller(context);
  checkWire(context, input, "DELETE");
  const actor = actingAs(context, who, "actor", input.actor, "DELETE /reactions");
  const entity = entityOf(context, who, "entity", input.entity, "DELETE /reactions", true);
  const rowId = `${entity}|${actor.urn}`;
  if (context.state.get("reactions", rowId) === null) notFound(context, "Not Found");
  context.state.delete("reactions", rowId);
  return { id: reactionId(actor.urn, entity), deleted: true };
}
