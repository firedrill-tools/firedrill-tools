// Wire-level errors: LinkedIn-Version, X-RestLi-Method, batch get, malformed bodies and query strings, on every /rest route.
import assert from "node:assert/strict";
import { call, enc, get, op, orgUrn, personUrn, post, textPost } from "../client.mjs";
import { COMMENTS, ORGS, PEOPLE, POSTS } from "../fixtures.mjs";

const maya = personUrn(PEOPLE.maya);
const social = (target) => `/rest/socialActions/${enc(target)}/comments`;

// [label, method, path, body, Rest.li method]
const ROUTES = [
  ["create-post", "POST", "/rest/posts", textPost(maya, "never stored"), "CREATE"],
  ["get-post", "GET", `/rest/posts/${enc(POSTS.mayaPlain.urn)}`, undefined, "GET"],
  ["find-posts", "GET", `/rest/posts?q=author&author=${enc(maya)}`, undefined, "FINDER"],
  ["update-post", "POST", `/rest/posts/${enc(POSTS.mayaPlain.urn)}`, { patch: { $set: { commentary: "never" } } }, "PARTIAL_UPDATE"],
  ["delete-post", "DELETE", `/rest/posts/${enc(POSTS.mayaPlain.urn)}`, undefined, "DELETE"],
  ["create-comment", "POST", social(POSTS.mayaPlain.urn), { actor: maya, message: { text: "never" } }, "CREATE"],
  ["list-comments", "GET", social(POSTS.mayaArticle.urn), undefined, "GET_ALL"],
  ["get-comment", "GET", `${social(POSTS.mayaArticle.urn)}/${COMMENTS.samOnArticle.id}`, undefined, "GET"],
  ["update-comment", "POST", `${social(POSTS.zoe.urn)}/${COMMENTS.mayaOnZoe.id}`, { patch: { message: { $set: { text: "never" } } } }, "PARTIAL_UPDATE"],
  ["delete-comment", "DELETE", `${social(POSTS.zoe.urn)}/${COMMENTS.mayaOnZoe.id}`, undefined, "DELETE"],
  ["create-reaction", "POST", `/rest/reactions?actor=${enc(maya)}`, { root: POSTS.mayaPlain.urn, reactionType: "LIKE" }, "CREATE"],
  ["get-reactions", "GET", `/rest/reactions/${enc(`(entity:${POSTS.mayaArticle.activity})`)}?q=entity`, undefined, "FINDER"],
  ["delete-reaction", "DELETE", `/rest/reactions/${enc(`(actor:${maya},entity:${POSTS.zoe.activity})`)}`, undefined, "DELETE"],
  ["get-social-metadata", "GET", `/rest/socialMetadata/${enc(POSTS.mayaArticle.urn)}`, undefined, "GET"],
  ["update-social-metadata", "POST", `/rest/socialMetadata/${enc(POSTS.mayaPlain.urn)}?actor=${enc(maya)}`,
    { patch: { $set: { commentsState: "CLOSED" } } }, "PARTIAL_UPDATE"],
  ["get-organization", "GET", `/rest/organizations/${ORGS.northwind}`, undefined, "GET"],
  ["find-organizations", "GET", "/rest/organizations?q=vanityName&vanityName=northwind-analytics", undefined, "FINDER"],
  ["find-organization-acls", "GET", "/rest/organizationAcls?q=roleAssignee", undefined, "FINDER"],
  ["get-network-size", "GET", `/rest/networkSizes/${enc(orgUrn(ORGS.northwind))}?edgeType=COMPANY_FOLLOWED_BY_MEMBER`, undefined, "GET"],
];

async function wireErrors() {
  for (const [label, method, path, json, restli] of ROUTES) {
    const options = (extra) => ({ json, restli, ...extra });
    const missing = (await call(method, path, [400, "VERSION_MISSING"], options({ version: null }))).body;
    assert.match(missing.message, /Linkedin-Version header/, label);
    const inactive = (await call(method, path, [426, "NONEXISTENT_VERSION"], options({ version: "202508" }))).body;
    assert.equal(inactive.message, "Requested version 202508 is not active", label);
    await call(method, path, [426, "NONEXISTENT_VERSION"], options({ version: "abc" }));
    await call(method, path, [400, "BAD_REQUEST"], options({ restli: "BATCH_GET" }));
    await call(method, `${path}${path.includes("?") ? "&" : "?"}ids=List(1,2)`, [400, "BAD_REQUEST"], options({}));
  }
  const deep = `{"author":"${maya}","commentary":"x","visibility":"PUBLIC","distribution":{"feedDistribution":"MAIN_FEED"},"lifecycleState":"PUBLISHED",`
    + `"content":${"[".repeat(600)}${"]".repeat(600)}}`;
  await post("/rest/posts", deep, [400, "BAD_REQUEST"]);
  // The framework drops an own `__proto__` member before the codec runs; the request still fails validation and pollutes nothing.
  await post("/rest/posts", `{"__proto__":{"polluted":1},"author":"${maya}"}`, 400);
  await post("/rest/posts", "[1,2,3]", [400, "BAD_REQUEST"]);
  assert.equal({}.polluted, undefined);
  await get(`/rest/posts?q=author&${Array.from({ length: 21 }, () => `author=${enc(maya)}`).join("&")}`, [400, "BAD_REQUEST"]);
  await get("/rest/posts?q=author&author=%FF", [400, "BAD_REQUEST"]);
  await get("/rest/posts?q=author&author=%ZZ", [400, "INVALID_URN_ID"]);
  await post("/v2/ugcPosts", "[]", 400);
  await call("DELETE", `/v2/ugcPosts/${enc("urn:li:ugcPost:abc")}`, 400);
  await get(`/v2/people/${enc("(id:x")}`, 400);
  await op("feed.list", { count: 0 }, "INVALID_VALUE_FOR_FIELD");
  await op("connections.list", { count: 0 }, "INVALID_VALUE_FOR_FIELD");
  assert.equal((await get(`/rest/posts/${enc(POSTS.mayaPlain.urn)}`)).body.commentary.startsWith("Shipping"), true);
}

export const FLOWS = { "wire-errors": wireErrors };
