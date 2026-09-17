// Post and thread resolution with LinkedIn visibility rules (drafts, CONNECTIONS posts, tombstones).
import { connected, managesAuthor, requireScope, urnField } from "./auth.mjs";
import { fail, notFound } from "./errors.mjs";
import { parseUrn } from "./urn.mjs";

const COMMENT_ID = /^[0-9]{1,19}$/;

/** Post row for a share, ugcPost or activity URN (already parsed), or null. */
export function findPost(context, parsed) {
  if (parsed.type === "activity") {
    const activity = context.state.get("activities", parsed.id);
    return activity === null ? null : context.state.get("posts", activity.postId);
  }
  const post = context.state.get("posts", parsed.id);
  return post !== null && post.kind === parsed.type ? post : null;
}

/** Read scope for a thread: member-authored threads need r_member_social, organization threads r_organization_social. */
export function requireReadScope(context, who, authorUrn, resource) {
  const organization = parseUrn(authorUrn)?.type === "organization";
  requireScope(context, who, [organization ? "r_organization_social" : "r_member_social"], resource);
}

/** "ok", "missing" (deleted, or a draft outside the author view) or "hidden" (a CONNECTIONS post of a non-connection). */
export function visibility(context, who, post, viewContext = "READER") {
  if (post.deletedAtMs !== null) return "missing";
  if (post.lifecycleState === "DRAFT" && (viewContext !== "AUTHOR" || !managesAuthor(context, who, post.author))) return "missing";
  if (post.visibility === "CONNECTIONS" && post.author !== who.urn) {
    const author = parseUrn(post.author);
    if (author === null || author.type !== "person" || !connected(context, who.personId, author.id)) return "hidden";
  }
  return "ok";
}

/** Loads a post the caller may read, failing NOT_FOUND / ACCESS_DENIED as LinkedIn does. */
export function loadVisiblePost(context, who, parsed, resource, viewContext = "READER", write = false) {
  const post = findPost(context, parsed);
  if (post === null) notFound(context, `Post ${parsed.urn} not found`);
  if (!write) requireReadScope(context, who, post.author, resource);
  const seen = visibility(context, who, post, viewContext);
  if (seen === "missing") notFound(context, `Post ${parsed.urn} not found`);
  if (seen === "hidden") fail(context, "ACCESS_DENIED", `Not enough permissions to access: ${parsed.urn}`);
  return post;
}

/**
 * Resolves a social-action target (share, ugcPost, activity or comment URN) to `{ post, comment }`; `comment` is the
 * stored comment row when the target is a comment URN. Drafts resolve for their author so writes can refuse them.
 */
export function loadThread(context, who, field, value, resource, { inPath = false, types, write = false } = {}) {
  const parsed = urnField(context, field, value, types ?? ["share", "ugcPost", "activity", "comment"], { inPath });
  if (parsed.type === "comment") {
    const activity = context.state.get("activities", parsed.activityId);
    if (activity === null) notFound(context, `Comment ${parsed.urn} not found`);
    const post = loadVisiblePost(context, who, { type: "activity", id: parsed.activityId, urn: `urn:li:activity:${parsed.activityId}` },
      resource, "AUTHOR", write);
    const comment = context.state.get("comments", `${parsed.activityId}|${parsed.commentId}`);
    if (comment === null) notFound(context, `Comment ${parsed.urn} not found`);
    return { post, comment, parsed };
  }
  return { post: loadVisiblePost(context, who, parsed, resource, "AUTHOR", write), comment: null, parsed };
}

/** Validates a comment id path key (digits only). */
export function commentIdArg(context, value, inPath) {
  if (typeof value === "string" && COMMENT_ID.test(value)) return value;
  if (inPath) return fail(context, "BAD_REQUEST", "Syntax exception in path variables");
  return fail(context, "INVALID_URN_ID", "The URN ID provided is invalid");
}
