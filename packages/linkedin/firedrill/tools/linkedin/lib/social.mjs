// Reaction and comment summaries shared by social metadata and the home feed.
import { reactionsOn, threadComments } from "./cascade.mjs";
import { activityUrn, commentUrn } from "./urn.mjs";

const TYPES = ["LIKE", "PRAISE", "APPRECIATION", "EMPATHY", "INTEREST", "ENTERTAINMENT"];

export function reactionSummaries(reactions) {
  const counts = new Map();
  for (const reaction of reactions) counts.set(reaction.reactionType, (counts.get(reaction.reactionType) ?? 0) + 1);
  const summaries = {};
  for (const type of TYPES) if (counts.has(type)) summaries[type] = { reactionType: type, count: counts.get(type) };
  return summaries;
}

/** Summaries of a post (comment null) or of one comment (its replies and reactions). */
export function summarize(context, post, comment) {
  const rows = threadComments(context, post.activityId);
  if (comment !== null) {
    const replies = rows.filter((row) => row.parentCommentId === comment.id).length;
    const reactions = reactionsOn(context, commentUrn(comment.activityId, comment.id));
    return { commentSummary: { count: replies, topLevelCount: replies }, reactions };
  }
  const topLevel = rows.filter((row) => row.parentCommentId === null).length;
  return { commentSummary: { count: rows.length, topLevelCount: topLevel }, reactions: reactionsOn(context, activityUrn(post.activityId)) };
}
