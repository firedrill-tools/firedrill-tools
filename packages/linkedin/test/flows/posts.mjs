// Post flows: lifecycle, validation, paging, legacy ugcPosts and visibility.
import assert from "node:assert/strict";
import { call, del, enc, get, op, orgUrn, partial, personUrn, post, textPost } from "../client.mjs";
import { ORGS, PEOPLE, POSTS } from "../fixtures.mjs";

const maya = personUrn(PEOPLE.maya);
const posts = (query) => `/rest/posts?q=author&${query}`;

async function createChecks() {
  const created = await post("/rest/posts", textPost(maya, "Launching #DataOps week with the team"));
  const urn = created.headers.get("x-restli-id");
  assert.match(urn, /^urn:li:share:[0-9]{19}$/);
  assert.equal(created.headers.get("x-linkedin-id"), urn);
  const read = (await get(`/rest/posts/${enc(urn)}`)).body;
  assert.equal(read.commentary, "Launching {hashtag|\\#|DataOps} week with the team");
  assert.equal(read.author, maya);
  assert.equal(read.lifecycleState, "PUBLISHED");
  assert.equal(read.publishedAt, read.createdAt);
  assert.equal(BigInt(urn.split(":").pop()) >> 22n, BigInt(read.createdAt), "id carries the creation time");
  const article = await post("/rest/posts", textPost(maya, "Worth a read", {
    content: { article: { source: "https://example.com/articles/lineage", title: "Lineage at scale", description: "Notes" } } }));
  const reshare = await post("/rest/posts", textPost(maya, "", { reshareContext: { parent: POSTS.sam.urn } }));
  const reshared = (await get(`/rest/posts/${enc(reshare.headers.get("x-restli-id"))}`)).body;
  assert.deepEqual(reshared.reshareContext, { parent: POSTS.sam.urn, root: POSTS.sam.urn });
  await post("/rest/posts", textPost(orgUrn(ORGS.northwind), "From the Northwind page"));
  const bad = (body, expect) => post("/rest/posts", body, expect);
  await bad(textPost(maya, "x", { reshareContext: { parent: POSTS.brightline.urn } }), [422, "UNPROCESSABLE_ENTITY"]);
  await bad(textPost(maya, "x", { reshareContext: { parent: POSTS.mayaDraft.urn } }), [422, "UNPROCESSABLE_ENTITY"]);
  await bad(textPost(maya, "x", { reshareContext: { parent: "urn:li:share:12345" } }), [404, "NOT_FOUND"]);
  await bad(textPost(maya, "x", { reshareContext: {} }), [400, "MISSING_FIELD"]);
  await bad(textPost(orgUrn(ORGS.brightline), "requested role only"), [403, "ACCESS_DENIED"]);
  await bad(textPost(orgUrn(ORGS.lakeview), "analyst role only"), [403, "ACCESS_DENIED"]);
  await bad(textPost(personUrn(PEOPLE.sam), "not me"), [403, "ACCESS_DENIED"]);
  await bad(textPost(orgUrn(ORGS.northwind), "x", { visibility: "CONNECTIONS" }), [400, "INVALID_VALUE_FOR_FIELD"]);
  await bad(textPost(maya, "x", { visibility: "FRIENDS" }), [400, "INVALID_VALUE_FOR_FIELD"]);
  await bad(textPost(maya, "x", { lifecycleState: "DRAFT" }), [400, "INVALID_VALUE_FOR_FIELD"]);
  await bad(textPost(maya, "x", { distribution: { feedDistribution: "MAIN_FEED", targetEntities: [{ geoLocations: [] }] } }), 400);
  await bad(textPost(maya, "x", { distribution: { feedDistribution: "MAIN_FEED", thirdPartyDistributionChannels: ["X"] } }),
    [400, "INVALID_VALUE_FOR_FIELD"]);
  await bad(textPost(maya, "x", { content: { media: { category: "IMAGE" } } }), [400, "INVALID_VALUE_FOR_FIELD"]);
  await bad(textPost(maya, "x", { content: { article: { source: "http://example.com", title: "t" } } }), [400, "INVALID_VALUE_FOR_FIELD"]);
  await bad(textPost(maya, "x", { content: { article: { source: "https://example.com", title: "  " } } }), [400, "INVALID_VALUE_BLANK_FIELD"]);
  await bad(textPost(maya, "x", { content: { article: { source: "https://example.com", title: "t".repeat(401) } } }), [400, "FIELD_LENGTH_TOO_LONG"]);
  await bad(textPost(maya, "x".repeat(3001)), [400, "FIELD_LENGTH_TOO_LONG"]);
  await bad(textPost(maya, `${"a".repeat(2990)} #tag`), [400, "FIELD_LENGTH_TOO_LONG"]);
  await bad(textPost(maya, "   "), [400, "INVALID_VALUE_BLANK_FIELD"]);
  for (const field of ["author", "visibility", "distribution", "lifecycleState"]) {
    const body = textPost(maya, "x");
    delete body[field];
    await bad(body, [400, "MISSING_FIELD"]);
  }
  await bad(textPost(maya, "x", { distribution: {} }), [400, "MISSING_FIELD"]);
  await bad(textPost("urn:li:share:1", "x"), [400, "INVALID_URN_TYPE"]);
  await bad(textPost("urn:li:person:short", "x"), [400, "INVALID_URN_ID"]);
  await bad({ ...textPost(maya, "x"), adContext: {} }, [400, "BAD_REQUEST"]);
  return { urn, article: article.headers.get("x-restli-id") };
}

async function findChecks() {
  const all = [];
  for (const sort of ["LAST_MODIFIED", "CREATED"]) {
    const first = (await get(posts(`author=${enc(maya)}&sortBy=${sort}&count=10`))).body;
    assert.equal(first.paging.total, 14);
    assert.equal(first.elements.length, 10);
    assert.deepEqual(first.paging.links.map((l) => l.rel), ["next"]);
    const second = (await get(posts(`author=${enc(maya)}&sortBy=${sort}&count=10&start=10`))).body;
    assert.equal(second.elements.length, 4);
    assert.deepEqual(second.paging.links.map((l) => l.rel), ["prev"]);
    const list = [...first.elements, ...second.elements];
    assert.equal(new Set(list.map((p) => p.id)).size, 14);
    const key = sort === "CREATED" ? "createdAt" : "lastModifiedAt";
    for (let i = 1; i < list.length; i += 1) assert.ok(list[i - 1][key] >= list[i][key], `${sort} order`);
    assert.ok(!list.some((p) => p.id === POSTS.mayaDraft.urn || p.id === POSTS.mayaDeleted.urn));
    all.push(list.findIndex((p) => p.id === POSTS.mayaEdited.urn));
  }
  assert.notEqual(all[0], all[1], "LAST_MODIFIED and CREATED orders differ");
  const author = (await get(posts(`author=${enc(maya)}&viewContext=AUTHOR&count=100`))).body;
  assert.equal(author.paging.total, 15);
  assert.ok(author.elements.some((p) => p.id === POSTS.mayaDraft.urn && p.publishedAt === undefined));
  assert.equal((await get(posts(`author=${enc(orgUrn(ORGS.northwind))}`))).body.paging.total, 3);
  assert.equal((await get(posts(`author=${enc(orgUrn(ORGS.lakeview))}`))).body.paging.total, 0);
  await get(posts(`author=${enc(orgUrn(ORGS.brightline))}`), [403, "ACCESS_DENIED"]);
  await get(posts(`author=${enc(orgUrn(99999999))}`), [404, "NOT_FOUND"]);
  await get(posts(`author=${enc(personUrn(PEOPLE.sam))}`), [403, "ACCESS_DENIED"]);
  await get("/rest/posts?q=author", [400, "MISSING_FIELD"]);
  await get(posts(`author=${enc(POSTS.sam.urn)}`), [400, "INVALID_URN_TYPE"]);
  await get(posts("author=urn%3Ali%3Aperson%3Ax"), [400, "INVALID_URN_ID"]);
  await get(posts(`author=${enc(maya)}&count=0`), [400, "INVALID_VALUE_FOR_FIELD"]);
  await get(posts(`author=${enc(maya)}&sortBy=RELEVANCE`), [400, "INVALID_VALUE_FOR_FIELD"]);
  await get(posts(`author=${enc(maya)}&count=abc`), [400, "BAD_REQUEST"]);
  await get(`/rest/posts?q=dscAdAccount&author=${enc(maya)}`, [400, "BAD_REQUEST"]);
}

const path = (urn) => `/rest/posts/${enc(urn)}`;

async function readUpdateDelete(created) {
  await get(path(POSTS.mayaDraft.urn), [404, "NOT_FOUND"]);
  assert.equal((await get(`${path(POSTS.mayaDraft.urn)}?viewContext=AUTHOR`)).body.lifecycleState, "DRAFT");
  await get(`${path(POSTS.mayaDraft.urn)}?viewContext=OWNER`, [400, "INVALID_VALUE_FOR_FIELD"]);
  await get(path(POSTS.jordan.urn), [403, "ACCESS_DENIED"]);
  await get(path(POSTS.mayaDeleted.urn), [404, "NOT_FOUND"]);
  await get(path("urn:li:share:abc"), [400, "BAD_REQUEST"]);
  assert.equal((await get(path(POSTS.mayaLong.urn))).body.commentary.length, 3000);
  await op("posts.get", { postUrn: maya }, "INVALID_URN_TYPE");
  await op("posts.get", { postUrn: "urn:li:share:" }, "INVALID_URN_ID");

  await partial(path(created.urn), { patch: { $set: { commentary: "Edited #DataOps" } } });
  const edited = (await get(path(created.urn))).body;
  assert.equal(edited.commentary, "Edited {hashtag|\\#|DataOps}");
  assert.equal(edited.lifecycleStateInfo.isEditedByAuthor, true);
  await partial(path(POSTS.mayaDraft.urn), { patch: { $set: { lifecycleState: "PUBLISHED" } } });
  const published = (await get(path(POSTS.mayaDraft.urn))).body;
  assert.equal(published.lifecycleState, "PUBLISHED");
  assert.equal(typeof published.publishedAt, "number");
  assert.equal(published.lifecycleStateInfo.isEditedByAuthor, false);
  await partial(path(created.urn), { patch: { $set: { lifecycleState: "DRAFT" } } }, [400, "INVALID_VALUE_FOR_FIELD"]);
  await partial(path(created.urn), { patch: { $set: { foo: 1 } } }, [400, "INVALID_VALUE_FOR_FIELD"]);
  await partial(path(created.urn), { patch: { $delete: ["commentary"] } }, [400, "INVALID_VALUE_FOR_FIELD"]);
  await partial(path(created.urn), { patch: { $set: { contentCallToActionLabel: "LEARN_MORE" } } }, [400, "INVALID_VALUE_FOR_FIELD"]);
  await partial(path(created.urn), { patch: { $set: {} } }, [400, "MISSING_FIELD"]);
  await partial(path(created.urn), { patch: { $set: { commentary: "y".repeat(3001) } } }, [400, "FIELD_LENGTH_TOO_LONG"]);
  await partial(path(created.urn), { patch: { $set: { commentary: " " } } }, [400, "INVALID_VALUE_BLANK_FIELD"]);
  await call("POST", path(created.urn), [400, "BAD_REQUEST"], { json: { patch: { $set: { commentary: "no method header" } } } });
  await partial(path(POSTS.sam.urn), { patch: { $set: { commentary: "not mine" } } }, [403, "ACCESS_DENIED"]);
  await partial(path(POSTS.mayaDeleted.urn), { patch: { $set: { commentary: "gone" } } }, [404, "NOT_FOUND"]);
  await op("posts.update", { postUrn: "urn:li:comment:1", commentary: "x" }, "INVALID_URN_TYPE");
  await op("posts.update", { postUrn: "urn:li:ugcPost:x", commentary: "x" }, "INVALID_URN_ID");

  await del(path(created.article));
  await del(path(POSTS.mayaArticle.urn));
  await del(path(POSTS.mayaArticle.urn));
  await get(path(POSTS.mayaArticle.urn), [404, "NOT_FOUND"]);
  await op("comments.list", { target: POSTS.mayaArticle.urn }, "NOT_FOUND");
  await del(path("urn:li:share:12345"), [404, "NOT_FOUND"]);
  await del(path(POSTS.sam.urn), [403, "ACCESS_DENIED"]);
  await op("posts.delete", { postUrn: maya }, "INVALID_URN_TYPE");
  await op("posts.delete", { postUrn: "urn:li:share:1x" }, "INVALID_URN_ID");
}

async function lifecycle() {
  const created = await createChecks();
  await findChecks();
  await readUpdateDelete(created);
}

const ugcBody = (extra = {}) => ({
  author: maya, lifecycleState: "PUBLISHED", visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
  specificContent: { "com.linkedin.ugc.ShareContent": { shareCommentary: { text: "Hello from the legacy API" }, shareMediaCategory: "NONE", ...extra } },
});

async function ugcLegacy() {
  const text = await post("/v2/ugcPosts", ugcBody());
  assert.match(text.body.id, /^urn:li:ugcPost:[0-9]{19}$/);
  assert.equal(text.headers.get("x-restli-id"), text.body.id);
  const read = (await get(path(text.body.id))).body;
  assert.equal(read.commentary, "Hello from the legacy API");
  assert.equal(read.visibility, "PUBLIC");
  const article = await post("/v2/ugcPosts", ugcBody({ shareMediaCategory: "ARTICLE",
    media: [{ status: "READY", originalUrl: "https://example.com/legacy", title: { text: "Legacy article" }, description: { text: "Shared" } }] }));
  assert.deepEqual((await get(path(article.body.id))).body.content,
    { article: { source: "https://example.com/legacy", title: "Legacy article", description: "Shared" } });
  await post("/v2/ugcPosts", ugcBody({ shareMediaCategory: "IMAGE" }), 400);
  const { author, ...noAuthor } = ugcBody();
  void author;
  await post("/v2/ugcPosts", noAuthor, 400);
  await del(`/v2/ugcPosts/${enc(text.body.id)}`);
  await del(`/v2/ugcPosts/${enc(text.body.id)}`);
  await get(path(text.body.id), [404, "NOT_FOUND"]);
  await del(`/v2/ugcPosts/${enc("urn:li:ugcPost:12345")}`, 404);
}

async function visibilityStranger() {
  await get(path(POSTS.mayaConnections.urn), [403, "ACCESS_DENIED"]);
  await get(`/rest/socialActions/${enc(POSTS.mayaConnections.urn)}/comments`, [403, "ACCESS_DENIED"]);
  await get(`/rest/reactions/${enc(`(entity:${POSTS.mayaConnections.activity})`)}?q=entity`, [403, "ACCESS_DENIED"]);
  await get(`/rest/socialMetadata/${enc(POSTS.mayaConnections.urn)}`, [403, "ACCESS_DENIED"]);
  assert.equal((await get(path(POSTS.mayaPlain.urn))).body.visibility, "PUBLIC");
  assert.equal((await get(path(POSTS.mayaLoggedIn.urn))).body.visibility, "LOGGED_IN");
  const info = (await get("/v2/userinfo")).body;
  assert.equal(info.email, undefined);
  assert.equal(info.picture, undefined);
  assert.equal(info.locale, "es-ES");
  assert.equal((await get(`/v2/connections/${enc(personUrn(PEOPLE.tomas))}`)).body.firstDegreeSize, 0);
}

async function visibilityConnection() {
  assert.equal((await get(path(POSTS.mayaConnections.urn))).body.visibility, "CONNECTIONS");
  await partial(path(POSTS.mayaConnections.urn), { patch: { $set: { commentary: "hijack" } } }, [403, "ACCESS_DENIED"]);
  await del(path(POSTS.mayaConnections.urn), [403, "ACCESS_DENIED"]);
  await get(posts(`author=${enc(maya)}`), [403, "ACCESS_DENIED"]);
  await get(path(POSTS.mayaDraft.urn), [404, "NOT_FOUND"]);
}

export const FLOWS = {
  "posts-lifecycle": lifecycle, "ugc-legacy": ugcLegacy, "visibility-stranger": visibilityStranger, "visibility-connection": visibilityConnection,
};
