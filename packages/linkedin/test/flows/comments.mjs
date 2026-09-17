// Comment flows: create, reply, list, get, edit and delete, with validation and ownership errors.
import assert from "node:assert/strict";
import { del, enc, get, op, orgUrn, partial, personUrn, post } from "../client.mjs";
import { COMMENTS, ORGS, PEOPLE, POSTS } from "../fixtures.mjs";

const maya = personUrn(PEOPLE.maya);
const base = (target) => `/rest/socialActions/${enc(target)}/comments`;
const art = POSTS.mayaArticle;

async function create() {
  const text = "Thanks Zoë Łukasiewicz for the review";
  const mention = { start: text.indexOf("Zoë"), length: 15, value: { person: { person: personUrn(PEOPLE.zoe) } } };
  const top = await post(base(art.urn), { actor: maya, object: art.activity, message: { text, attributes: [mention] } });
  assert.equal(top.headers.get("x-restli-id"), top.body.id);
  assert.equal(top.body.commentUrn, `urn:li:comment:(${art.activity},${top.body.id})`);
  assert.deepEqual(top.body.message.attributes, [mention]);
  assert.equal(top.body.object, art.activity);
  const reply = await post(base(COMMENTS.samOnArticle.urn), { actor: maya, object: art.activity, message: { text: "Replying again" } });
  assert.equal(reply.body.parentComment, COMMENTS.samOnArticle.urn);
  assert.equal(reply.body.commentsSummary, undefined);
  await post(base(art.urn), { actor: maya, message: { text: "A reply by field" }, parentComment: COMMENTS.priyaOnArticle.urn });
  const page = await post(base(POSTS.northwindArticle.urn), { actor: orgUrn(ORGS.northwind), message: { text: "Thanks for reading" } });
  assert.equal(page.body.agent, maya);
  assert.equal(page.body.created.impersonator, maya);
  const bad = (target, body, expect) => post(base(target), body, expect);
  const msg = (text) => ({ actor: maya, message: { text } });
  await bad(COMMENTS.mayaReplySam.urn, msg("reply to a reply"), [422, "UNPROCESSABLE_ENTITY"]);
  await bad(art.urn, { ...msg("x"), message: { text: "x", attributes: [{ start: 0, length: 5, value: { person: { person: maya } } }] } },
    [400, "INVALID_VALUE_FOR_FIELD"]);
  await bad(art.urn, { ...msg("x"), object: POSTS.sam.activity }, [400, "INVALID_VALUE_FOR_FIELD"]);
  await bad(art.urn, msg("c".repeat(1251)), [400, "FIELD_LENGTH_TOO_LONG"]);
  await bad(art.urn, msg("  "), [400, "INVALID_VALUE_BLANK_FIELD"]);
  await bad(art.urn, { actor: maya }, [400, "MISSING_FIELD"]);
  await bad(art.urn, { message: { text: "x" } }, [400, "MISSING_FIELD"]);
  await bad(art.urn, { ...msg("x"), content: [{ entity: { image: "urn:li:image:1" } }] }, [403, "ACCESS_DENIED"]);
  await bad(POSTS.mayaClosed.urn, msg("closed"), [422, "UNPROCESSABLE_ENTITY"]);
  await bad(POSTS.mayaDraft.urn, msg("draft"), [422, "UNPROCESSABLE_ENTITY"]);
  await bad(art.urn, { actor: personUrn(PEOPLE.sam), message: { text: "x" } }, [403, "ACCESS_DENIED"]);
  await bad("urn:li:share:12345", msg("x"), [404, "NOT_FOUND"]);
  await bad(art.urn, { ...msg("x"), parentComment: `urn:li:comment:(${art.activity},12345)` }, [404, "NOT_FOUND"]);
  await bad(POSTS.jordan.urn, msg("hidden"), [403, "ACCESS_DENIED"]);
  await bad("urn:li:share:x", msg("x"), [400, "BAD_REQUEST"]);
  await op("comments.create", { target: maya, ...msg("x") }, "INVALID_URN_TYPE");
  await op("comments.create", { target: "urn:li:share:", ...msg("x") }, "INVALID_URN_ID");
  return { top: top.body, page: page.body };
}

async function listAndGet() {
  const first = (await get(`${base(art.urn)}?count=2`)).body;
  assert.equal(first.paging.total, 4);
  assert.deepEqual(first.elements.map((c) => c.id), [COMMENTS.samOnArticle.id, COMMENTS.priyaOnArticle.id]);
  assert.equal(first.elements[0].commentsSummary.totalFirstLevelComments, 2);
  assert.equal(first.elements[0].likesSummary.likedByCurrentUser, true);
  assert.equal(first.paging.links[0].rel, "next");
  const second = (await get(`${base(art.urn)}?count=2&start=2`)).body;
  assert.equal(second.elements.length, 2);
  assert.equal(second.elements[0].id, COMMENTS.zoeOnArticle.id);
  assert.equal((await get(base(COMMENTS.samOnArticle.urn))).body.paging.total, 2);
  assert.deepEqual((await get(base(POSTS.mayaPlain.urn))).body.elements, []);
  assert.equal((await get(base(art.activity))).body.paging.total, 4);
  await get(`${base(art.urn)}?count=101`, [400, "INVALID_VALUE_FOR_FIELD"]);
  await get(base("urn:li:share:12345"), [404, "NOT_FOUND"]);
  await get(base(POSTS.jordan.urn), [403, "ACCESS_DENIED"]);
  await op("comments.list", { target: maya }, "INVALID_URN_TYPE");
  await op("comments.list", { target: "urn:li:activity:x" }, "INVALID_URN_ID");
  const zoe = (await get(`${base(art.urn)}/${COMMENTS.zoeOnArticle.id}`)).body;
  assert.deepEqual(zoe.message.attributes, [{ start: 16, length: 11, value: { person: { person: maya } } }]);
  await get(`${base(POSTS.sam.urn)}/${COMMENTS.zoeOnArticle.id}`, [404, "NOT_FOUND"]);
  await get(`${base(POSTS.jordan.urn)}/1`, [403, "ACCESS_DENIED"]);
  await op("comments.get", { target: art.urn, commentId: "abc" }, "INVALID_URN_ID");
  await op("comments.get", { target: maya, commentId: "1" }, "INVALID_URN_TYPE");
}

async function editAndDelete({ top, page }) {
  const edited = await partial(`${base(art.urn)}/${top.id}`, { patch: { message: { $set: { text: "Edited thanks" } } } }, 200);
  assert.equal(edited.body.message.text, "Edited thanks");
  assert.deepEqual(edited.body.message.attributes, []);
  assert.equal(edited.headers.get("x-resourceidentity-urn"), top.commentUrn);
  const url = `${base(POSTS.northwindArticle.urn)}/${page.id}?actor=${enc(orgUrn(ORGS.northwind))}`;
  assert.equal((await partial(url, { patch: { message: { $set: { text: "Thanks for reading!" } } } }, 200)).body.actor, orgUrn(ORGS.northwind));
  const edit = (id, body, expect) => partial(`${base(art.urn)}/${id}`, body, expect);
  const set = (text) => ({ patch: { message: { $set: { text } } } });
  await edit(COMMENTS.priyaOnArticle.id, set("not mine"), [403, "ACCESS_DENIED"]);
  await edit("12345", set("missing"), [404, "NOT_FOUND"]);
  await edit(top.id, set(" "), [400, "INVALID_VALUE_BLANK_FIELD"]);
  await edit(top.id, set("e".repeat(1251)), [400, "FIELD_LENGTH_TOO_LONG"]);
  await edit(top.id, { patch: { foo: 1 } }, [400, "INVALID_VALUE_FOR_FIELD"]);
  await op("comments.update", { target: art.urn, commentId: top.id }, "MISSING_FIELD");
  await op("comments.update", { target: maya, commentId: top.id, message: { text: "x" } }, "INVALID_URN_TYPE");
  await op("comments.update", { target: art.urn, commentId: "x1", message: { text: "x" } }, "INVALID_URN_ID");

  const removed = await op("comments.delete", { target: art.urn, commentId: COMMENTS.samOnArticle.id });
  assert.deepEqual(removed.value, { commentUrn: COMMENTS.samOnArticle.urn, deleted: true, deletedReplies: 2 });
  await del(`${base(art.urn)}/${top.id}`);
  await get(`${base(art.urn)}/${top.id}`, [404, "NOT_FOUND"]);
  await del(`${base(POSTS.sam.urn)}/${COMMENTS.noorOnSam.id}`, [403, "ACCESS_DENIED"]);
  await del(`${base(art.urn)}/12345`, [404, "NOT_FOUND"]);
  await op("comments.delete", { target: maya, commentId: "1" }, "INVALID_URN_TYPE");
  await op("comments.delete", { target: art.urn, commentId: "" }, "INVALID_URN_ID");
}

async function comments() {
  const created = await create();
  await listAndGet();
  await editAndDelete(created);
}

async function commentsConnection() {
  await del(`${base(POSTS.sam.urn)}/${COMMENTS.mayaOnSam.id}`);
  await partial(`${base(POSTS.sam.urn)}/${COMMENTS.noorOnSam.id}`, { patch: { message: { $set: { text: "edited by Sam" } } } }, [403, "ACCESS_DENIED"]);
  await del(`${base(POSTS.brightline.urn)}/${COMMENTS.graceOnBrightline.id}?actor=${enc(orgUrn(ORGS.brightline))}`);
  await partial(`${base(POSTS.zoe.urn)}/${COMMENTS.mayaOnZoe.id}`, { patch: { message: { $set: { text: "x" } } } }, [403, "ACCESS_DENIED"]);
  assert.equal((await get(base(POSTS.sam.urn))).body.paging.total, 1);
}

export const FLOWS = { comments, "comments-connection": commentsConnection };
