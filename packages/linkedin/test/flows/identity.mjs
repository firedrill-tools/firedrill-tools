// Identity, token and grant flows.
import assert from "node:assert/strict";
import { enc, get, op, personUrn } from "../client.mjs";
import { COMMENTS, PEOPLE, POSTS } from "../fixtures.mjs";
import { everyOperation } from "./every.mjs";

async function identity() {
  const info = (await get("/v2/userinfo")).body;
  assert.deepEqual(info, {
    sub: PEOPLE.maya, name: "Maya Okafor", given_name: "Maya", family_name: "Okafor", picture: `https://media.example.com/profiles/${PEOPLE.maya}.jpg`,
    locale: "en-US", email: "maya.okafor@example.com", email_verified: true,
  });
  const me = (await get("/v2/me")).body;
  assert.equal(me.id, PEOPLE.maya);
  assert.equal(me.localizedHeadline, "Head of Data Platform at Northwind Analytics");
  assert.deepEqual(me.firstName, { localized: { en_US: "Maya" }, preferredLocale: { country: "US", language: "en" } });
  const zoe = (await get(`/v2/people/${enc(`(id:${PEOPLE.zoe})`)}`)).body;
  assert.equal(zoe.localizedLastName, "Łukasiewicz");
  assert.equal(zoe.localizedHeadline, undefined);
  assert.deepEqual(Object.keys(zoe.firstName.localized), ["pl_PL"]);
  await get(`/v2/people/${enc(`(name:${PEOPLE.zoe})`)}`, 400);
  await get(`/v2/people/${enc("(id:zzzzzzzzzz)")}`, 404);
  await op("people.get", { personId: "bad id" }, "BAD_REQUEST");
}

async function freshInstall() {
  const feed = (await op("feed.list", {})).value;
  assert.equal(feed.viewer.personUrn, personUrn(PEOPLE.maya));
  assert.equal(feed.serverTime, "2026-09-15T14:00:00.000Z");
  assert.ok(feed.elements.some((item) => item.post.id === POSTS.mayaArticle.urn));
  assert.equal((await op("profile.me", {})).value.id, PEOPLE.maya);
}

async function invalidToken() {
  await everyOperation("INVALID_ACCESS_TOKEN");
}

async function denied() {
  await everyOperation("denied");
}

async function openidOnly() {
  await get("/v2/userinfo", 403);
  await get("/v2/me", 403);
  await everyOperation("ACCESS_DENIED");
}

async function limitedScopes() {
  const info = (await get("/v2/userinfo")).body;
  assert.equal(info.email, undefined);
  assert.equal(info.email_verified, undefined);
  await get(`/rest/posts?q=author&author=${enc(personUrn(PEOPLE.maya))}`, [403, "ACCESS_DENIED"]);
  await op("feed.list", {}, "ACCESS_DENIED");
  await op("connections.list", {}, "ACCESS_DENIED");
  const created = await op("posts.create", {
    author: personUrn(PEOPLE.maya), commentary: "Posting works with w_member_social alone.", visibility: "PUBLIC",
    distribution: { feedDistribution: "MAIN_FEED" }, lifecycleState: "PUBLISHED",
  });
  assert.match(created.value.id, /^urn:li:share:[0-9]+$/);
  await op("posts.create", {
    author: "urn:li:organization:81234567", commentary: "Needs w_organization_social.", visibility: "PUBLIC",
    distribution: { feedDistribution: "MAIN_FEED" }, lifecycleState: "PUBLISHED",
  }, "ACCESS_DENIED");
  await op("comments.list", { target: POSTS.mayaArticle.urn }, "ACCESS_DENIED");
  void COMMENTS;
}

export const FLOWS = {
  identity, "fresh-install": freshInstall, "invalid-token": invalidToken, denied, "openid-only": openidOnly, "limited-scopes": limitedScopes,
};
