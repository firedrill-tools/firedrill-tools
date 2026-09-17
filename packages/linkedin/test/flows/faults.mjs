// Fault scenarios and the scan-bound scenario.
import assert from "node:assert/strict";
import { del, enc, get, op, partial, personUrn, post, textPost } from "../client.mjs";
import { COMMENTS, PEOPLE, POSTS } from "../fixtures.mjs";

const maya = personUrn(PEOPLE.maya);
const social = (target) => `/rest/socialActions/${enc(target)}/comments`;
const reactionKey = (entity) => `/rest/reactions/${enc(`(actor:${maya},entity:${entity})`)}`;

async function commentThrottled() {
  const refused = (await post(social(POSTS.mayaPlain.urn), { actor: maya, message: { text: "First!" } }, [429, "TOO_MANY_REQUESTS"])).body;
  assert.match(refused.message, /Comment create throttled/);
  assert.equal((await get(social(POSTS.mayaPlain.urn))).body.paging.total, 0);
}

async function postLostResponse() {
  const find = `/rest/posts?q=author&author=${enc(maya)}&count=100`;
  assert.equal((await get(find)).body.paging.total, 11);
  await post("/rest/posts", textPost(maya, "Quarterly roadmap is live"), [500, "INTERNAL_SERVER_ERROR"]);
  const after = (await get(find)).body;
  assert.equal(after.paging.total, 12, "the post was committed even though the caller saw 500");
  assert.ok(after.elements.some((p) => p.commentary === "Quarterly roadmap is live"));
  await post("/rest/posts", textPost(maya, "Quarterly roadmap is live"), [500, "INTERNAL_SERVER_ERROR"]);
  const duplicates = (await get(find)).body.elements.filter((p) => p.commentary === "Quarterly roadmap is live");
  assert.equal(duplicates.length, 2, "a blind retry publishes a duplicate");
}

async function reactionsOutage() {
  await post(`/rest/reactions?actor=${enc(maya)}`, { root: POSTS.mayaPlain.urn, reactionType: "LIKE" }, [503, "SERVICE_UNAVAILABLE"]);
  await del(reactionKey(POSTS.zoe.activity), [503, "SERVICE_UNAVAILABLE"]);
  assert.equal((await get(reactionKey(POSTS.zoe.activity))).body.reactionType, "EMPATHY");
}

async function tightLimits() {
  const bound = [500, "INTERNAL_SERVER_ERROR"];
  const checkBound = (response) => assert.equal(response.body.message, "state exceeds the supported bound of 1 rows");
  checkBound(await get(`/rest/posts?q=author&author=${enc(maya)}`, bound));
  await del(`/rest/posts/${enc(POSTS.mayaArticle.urn)}`, bound);
  await op("feed.list", {}, "INTERNAL_SERVER_ERROR");
  await get(social(POSTS.mayaArticle.urn), bound);
  await get(`${social(POSTS.mayaArticle.urn)}/${COMMENTS.samOnArticle.id}`, bound);
  await partial(`${social(POSTS.zoe.urn)}/${COMMENTS.mayaOnZoe.id}`, { patch: { message: { $set: { text: "edited" } } } }, bound);
  await del(`${social(POSTS.zoe.urn)}/${COMMENTS.mayaOnZoe.id}`, bound);
  await get(`/rest/reactions/${enc(`(entity:${POSTS.mayaArticle.activity})`)}?q=entity`, bound);
  await get(`/rest/socialMetadata/${enc(POSTS.mayaArticle.urn)}`, bound);
  await post(`/rest/socialMetadata/${enc(POSTS.mayaArticle.urn)}?actor=${enc(maya)}`, { patch: { $set: { commentsState: "CLOSED" } } }, bound);
  await get("/rest/organizationAcls?q=roleAssignee", bound);
  await get(`/v2/connections/${enc(maya)}`, 500);
  await op("connections.list", {}, "INTERNAL_SERVER_ERROR");
  assert.equal((await get(`/rest/posts/${enc(POSTS.mayaArticle.urn)}`)).body.id, POSTS.mayaArticle.urn);
  assert.equal((await get(`${social(POSTS.zoe.urn)}/${COMMENTS.elenaOnZoe.id}`, bound)).status, 500);
}

export const FLOWS = {
  "comment-throttled": commentThrottled, "post-lost-response": postLostResponse, "reactions-outage": reactionsOutage, "tight-limits": tightLimits,
};
