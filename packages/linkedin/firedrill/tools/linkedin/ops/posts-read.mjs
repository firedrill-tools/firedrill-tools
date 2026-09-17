// posts.get and posts.list_by_author.
import { loadVisiblePost } from "../lib/access.mjs";
import { READER_ROLES, caller, checkWire, holdsAny, managesAuthor, requireScope, rolesOn, urnField } from "../lib/auth.mjs";
import { fail, invalidValue, notFound } from "../lib/errors.mjs";
import { buildPage, pageArgs } from "../lib/paging.mjs";
import { compareIds } from "../lib/postinput.mjs";
import { renderPost } from "../lib/render.mjs";
import { scanValues } from "../lib/store.mjs";

const VIEW_CONTEXTS = new Set(["READER", "AUTHOR"]);
const SORTS = new Set(["LAST_MODIFIED", "CREATED"]);

export function viewContextArg(context, value) {
  if (value === undefined || value === null) return "READER";
  if (typeof value !== "string" || !VIEW_CONTEXTS.has(value)) return invalidValue(context, "viewContext", value);
  return value;
}

export function getPost(input, context) {
  const who = caller(context);
  checkWire(context, input, "GET");
  const parsed = urnField(context, "postUrn", input.postUrn, ["share", "ugcPost"], { inPath: input.wire !== undefined });
  const viewContext = viewContextArg(context, input.viewContext);
  return renderPost(loadVisiblePost(context, who, parsed, "GET /posts", viewContext));
}

export function listByAuthor(input, context) {
  const who = caller(context);
  checkWire(context, input, "FINDER");
  const author = urnField(context, "author", input.author, ["person", "organization"]);
  const viewContext = viewContextArg(context, input.viewContext);
  const sortBy = input.sortBy ?? "LAST_MODIFIED";
  if (typeof sortBy !== "string" || !SORTS.has(sortBy)) invalidValue(context, "sortBy", sortBy);
  const { start, count } = pageArgs(context, input);
  if (author.type === "person") {
    requireScope(context, who, ["r_member_social"], "GET /posts");
    if (author.id !== who.personId) fail(context, "ACCESS_DENIED", `Not enough permissions to access: GET /posts for ${author.urn}`);
  } else {
    requireScope(context, who, ["r_organization_social"], "GET /posts");
    if (context.state.get("organizations", author.id) === null) notFound(context, `Organization ${author.id} is inactive`);
    if (!holdsAny(rolesOn(context, author.id, who.personId), READER_ROLES)) {
      fail(context, "ACCESS_DENIED", `Not enough permissions to access: GET /posts for ${author.urn}`);
    }
  }
  const withDrafts = viewContext === "AUTHOR" && managesAuthor(context, who, author.urn);
  const key = sortBy === "CREATED" ? "createdAtMs" : "lastModifiedAtMs";
  const posts = scanValues(context, "posts")
    .filter((post) => post.author === author.urn && post.deletedAtMs === null && (post.lifecycleState === "PUBLISHED" || withDrafts))
    .sort((a, b) => b[key] - a[key] || compareIds(b.id, a.id));
  return buildPage(context, posts, renderPost, {
    start, count, path: "/rest/posts",
    query: [["q", "author"], ["author", author.urn], ["viewContext", input.viewContext], ["sortBy", input.sortBy]],
  });
}
