// Reaction and social metadata flows.
import assert from "node:assert/strict";
import { del, enc, get, op, orgUrn, personUrn, post } from "../client.mjs";
import { COMMENTS, ORGS, PEOPLE, POSTS } from "../fixtures.mjs";

const maya = personUrn(PEOPLE.maya);
const plain = POSTS.mayaPlain;
const art = POSTS.mayaArticle;
const react = (actor, body, expect = 201) => post(`/rest/reactions?actor=${enc(actor)}`, body, expect);
const key = (actor, entity) => `/rest/reactions/${enc(`(actor:${actor},entity:${entity})`)}`;
const finder = (entity, query = "") => `/rest/reactions/${enc(`(entity:${entity})`)}?q=entity${query}`;
const meta = (entity) => `/rest/socialMetadata/${enc(entity)}`;

async function reactions() {
  const first = (await react(maya, { root: plain.urn, reactionType: "LIKE" })).body;
  assert.equal(first.id, `urn:li:reaction:(${maya},${plain.activity})`);
  assert.equal(first.root, plain.activity);
  for (const type of ["PRAISE", "APPRECIATION", "EMPATHY", "INTEREST", "ENTERTAINMENT"]) {
    assert.equal((await react(maya, { root: plain.urn, reactionType: type })).body.reactionType, type);
  }
  const replay = (await react(maya, { root: plain.urn, reactionType: "ENTERTAINMENT" })).body;
  assert.equal(replay.created.time, first.created.time);
  await react(maya, { root: plain.urn, reactionType: "MAYBE" }, [400, "INVALID_VALUE_FOR_FIELD"]);
  await react(maya, { root: plain.urn, reactionType: "LOVE" }, [400, "INVALID_VALUE_FOR_FIELD"]);
  await post("/rest/reactions", { root: plain.urn, reactionType: "LIKE" }, [400, "MISSING_FIELD"]);
  await react(maya, { reactionType: "LIKE" }, [400, "MISSING_FIELD"]);
  await react(maya, { root: plain.urn }, [400, "MISSING_FIELD"]);
  assert.equal((await react(maya, { root: COMMENTS.priyaOnArticle.urn, reactionType: "APPRECIATION" })).body.root, COMMENTS.priyaOnArticle.urn);
  const asPage = (await react(orgUrn(ORGS.northwind), { root: POSTS.northwindArticle.urn, reactionType: "LIKE" })).body;
  assert.equal(asPage.created.impersonator, maya);
  await react(orgUrn(ORGS.brightline), { root: plain.urn, reactionType: "LIKE" }, [403, "ACCESS_DENIED"]);
  await react(personUrn(PEOPLE.sam), { root: plain.urn, reactionType: "LIKE" }, [403, "ACCESS_DENIED"]);
  await react(maya, { root: "urn:li:share:12345", reactionType: "LIKE" }, [404, "NOT_FOUND"]);
  await react(maya, { root: POSTS.mayaDraft.urn, reactionType: "LIKE" }, [404, "NOT_FOUND"]);
  await react(maya, { root: POSTS.jordan.urn, reactionType: "LIKE" }, [403, "ACCESS_DENIED"]);
  await op("reactions.create", { actor: "urn:li:share:1", root: plain.urn, reactionType: "LIKE" }, "INVALID_URN_TYPE");
  await op("reactions.create", { actor: maya, root: "urn:li:share:x", reactionType: "LIKE" }, "INVALID_URN_ID");

  const single = (await get(key(maya, plain.activity))).body;
  assert.equal(single.reactionType, "ENTERTAINMENT");
  assert.equal(single.paging, undefined);
  await get(key(personUrn(PEOPLE.sam), plain.activity), [404, "NOT_FOUND"]);
  await get(`/rest/reactions/${enc(`(entity:${art.activity})`)}`, [400, "BAD_REQUEST"]);
  const newest = (await get(finder(art.activity, "&count=2"))).body;
  assert.equal(newest.paging.total, 6);
  assert.deepEqual(newest.elements.map((r) => r.reactionType), ["ENTERTAINMENT", "INTEREST"]);
  assert.equal(newest.paging.links[0].rel, "next");
  const oldest = (await get(finder(art.activity, `&sort=${enc("(value:CHRONOLOGICAL)")}&count=2&start=4`))).body;
  assert.deepEqual(oldest.elements.map((r) => r.reactionType), ["INTEREST", "ENTERTAINMENT"]);
  assert.equal((await get(finder(art.activity, `&sort=${enc("(value:RELEVANCE)")}`))).body.elements.length, 6);
  await get(finder(art.activity, `&sort=${enc("(value:FOO)")}`), [400, "INVALID_VALUE_FOR_FIELD"]);
  await get(finder(art.activity, "&count=0"), [400, "INVALID_VALUE_FOR_FIELD"]);
  await get(finder("urn:li:activity:12345"), [404, "NOT_FOUND"]);
  await get(finder(POSTS.jordan.activity), [403, "ACCESS_DENIED"]);
  await op("reactions.list", { entity: art.activity, single: true }, "MISSING_FIELD");
  await op("reactions.list", { entity: maya }, "INVALID_URN_TYPE");
  await op("reactions.list", { entity: "urn:li:activity:" }, "INVALID_URN_ID");

  await del(key(maya, plain.activity));
  await del(key(maya, plain.activity), [404, "NOT_FOUND"]);
  await del(key(personUrn(PEOPLE.sam), art.activity), [403, "ACCESS_DENIED"]);
  await del(`/rest/reactions/${enc("(actor:x)")}`, [400, "BAD_REQUEST"]);
  await op("reactions.delete", { actor: "urn:li:share:1", entity: plain.activity }, "INVALID_URN_TYPE");
  await op("reactions.delete", { actor: maya, entity: "urn:li:activity:" }, "INVALID_URN_ID");
}

async function metadata() {
  const post1 = (await get(meta(art.urn))).body;
  assert.deepEqual(post1.commentSummary, { count: 5, topLevelCount: 3 });
  assert.equal(post1.commentsState, "OPEN");
  assert.deepEqual(Object.keys(post1.reactionSummaries), ["LIKE", "PRAISE", "APPRECIATION", "EMPATHY", "INTEREST", "ENTERTAINMENT"]);
  const onComment = (await get(meta(COMMENTS.samOnArticle.urn))).body;
  assert.deepEqual(onComment.commentSummary, { count: 1, topLevelCount: 1 });
  assert.deepEqual(onComment.reactionSummaries, { LIKE: { reactionType: "LIKE", count: 1 } });
  await get(meta("urn:li:share:12345"), [404, "NOT_FOUND"]);
  await get(meta(POSTS.jordan.urn), [403, "ACCESS_DENIED"]);
  await get(meta("urn:li:share:x"), [400, "BAD_REQUEST"]);
  await op("social_metadata.get", { entity: maya }, "INVALID_URN_TYPE");
  await op("social_metadata.get", { entity: "urn:li:share:" }, "INVALID_URN_ID");

  const set = (entity, actor, state, expect = 202) => post(`${meta(entity)}?actor=${enc(actor)}`, { patch: { $set: { commentsState: state } } }, expect);
  await set(art.urn, maya, "CLOSED");
  const closed = (await get(meta(art.urn))).body;
  assert.equal(closed.commentsState, "CLOSED");
  assert.deepEqual(closed.commentSummary, { count: 0, topLevelCount: 0 });
  assert.equal(Object.keys(closed.reactionSummaries).length, 6);
  const closedAgain = await op("social_metadata.set_comments_state", { entity: art.urn, actor: maya, commentsState: "CLOSED" });
  assert.equal(closedAgain.value.deletedComments, 0);
  await set(art.urn, maya, "OPEN");
  assert.equal((await get(meta(art.urn))).body.commentsState, "OPEN");
  await set(COMMENTS.zoeOnArticle.urn, maya, "CLOSED", [400, "BAD_REQUEST"]);
  await op("social_metadata.set_comments_state", { entity: COMMENTS.zoeOnArticle.urn, actor: maya, commentsState: "CLOSED" }, "INVALID_URN_TYPE");
  await op("social_metadata.set_comments_state", { entity: "urn:li:activity:", actor: maya, commentsState: "CLOSED" }, "INVALID_URN_ID");
  await set(art.urn, maya, "PROCESSING", [400, "INVALID_VALUE_FOR_FIELD"]);
  await post(meta(art.urn), { patch: { $set: { foo: "bar" } } }, [400, "INVALID_VALUE_FOR_FIELD"]);
  await set(art.urn, orgUrn(ORGS.northwind), "CLOSED", [403, "ACCESS_DENIED"]);
  await post(meta(art.urn), { patch: { $set: { commentsState: "CLOSED" } } }, [400, "MISSING_FIELD"]);
  await set("urn:li:share:12345", maya, "CLOSED", [404, "NOT_FOUND"]);
}

export const FLOWS = { "reactions-metadata": async () => { await reactions(); await metadata(); } };
