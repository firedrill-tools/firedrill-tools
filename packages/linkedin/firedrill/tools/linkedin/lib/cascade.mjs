// Cascading deletes: comments of a thread and the reactions on posts and comments.
import { scanPrefix, scanValues } from "./store.mjs";
import { activityUrn, commentUrn } from "./urn.mjs";

export const reactionsOn = (context, entityUrn) => scanValues(context, "reactions", `${entityUrn}|`);
export const threadComments = (context, activityId) => scanValues(context, "comments", `${activityId}|`);

export function deleteReactionsOn(context, entityUrn) {
  const rows = scanPrefix(context, "reactions", `${entityUrn}|`);
  for (const row of rows) context.state.delete("reactions", row.rowId);
  return rows.length;
}

/** Deletes comment rows and the reactions on each; returns the number of comments deleted. */
export function deleteComments(context, comments) {
  for (const comment of comments) {
    deleteReactionsOn(context, commentUrn(comment.activityId, comment.id));
    context.state.delete("comments", `${comment.activityId}|${comment.id}`);
  }
  return comments.length;
}

/** Deletes every comment of a thread, their reactions and the reactions on the post itself. */
export function deleteThread(context, activityId) {
  const deleted = deleteComments(context, threadComments(context, activityId));
  deleteReactionsOn(context, activityUrn(activityId));
  return deleted;
}
