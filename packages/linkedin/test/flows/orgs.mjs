// Organization, page role, network size, connection and feed flows.
import assert from "node:assert/strict";
import { enc, get, op, orgUrn, personUrn } from "../client.mjs";
import { ORGS, PEOPLE, POSTS } from "../fixtures.mjs";

const maya = personUrn(PEOPLE.maya);

async function organizations() {
  const org = (await get(`/rest/organizations/${ORGS.northwind}`)).body;
  assert.equal(org.$URN, orgUrn(ORGS.northwind));
  assert.equal(org.localizedName, "Northwind Analytics");
  assert.equal(org.staffCountRange, "SIZE_51_TO_200");
  assert.equal(org.locations[0].address.postalCode, "94607");
  assert.equal(org.foundedOn.year, 2016);
  assert.match(org.description.localized.en_US, /data platforms/);
  const denied = (await get(`/rest/organizations/${ORGS.lakeview}`, [403, "ACCESS_DENIED"])).body;
  assert.equal(denied.message, `Viewer don't have permission to the ADMIN_ONLY VisibilityReduction for urn:li:organization:${ORGS.lakeview}`);
  await get(`/rest/organizations/${ORGS.brightline}`, [403, "ACCESS_DENIED"]);
  assert.equal((await get("/rest/organizations/99999999", [404, "NOT_FOUND"])).body.message, "Organization 99999999 is inactive");
  await get("/rest/organizations/abc", [400, "BAD_REQUEST"]);

  const byVanity = (await get("/rest/organizations?q=vanityName&vanityName=Northwind-Analytics")).body;
  assert.equal(byVanity.paging.total, 1);
  assert.equal(byVanity.elements[0].id, ORGS.northwind);
  assert.equal(byVanity.elements[0].description, undefined);
  assert.deepEqual((await get("/rest/organizations?q=vanityName&vanityName=nobody-here")).body, {
    paging: { start: 0, count: 10, links: [], total: 0 }, elements: [] });
  await get("/rest/organizations?q=vanityName&vanityName=north%20wind", [400, "INVALID_VALUE_FOR_FIELD"]);
  await get("/rest/organizations?q=vanityName&vanityName=%ZZ", [400]);
  await get("/rest/organizations?q=parentOrganization&vanityName=x", [400, "BAD_REQUEST"]);
}

async function acls() {
  const mine = (await get("/rest/organizationAcls?q=roleAssignee")).body;
  assert.equal(mine.paging.total, 3);
  assert.ok(mine.elements.every((acl) => acl.roleAssignee === maya && acl.organization !== undefined));
  assert.equal((await get("/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED")).body.paging.total, 1);
  const paged = (await get("/rest/organizationAcls?q=roleAssignee&count=1")).body;
  assert.equal(paged.elements.length, 1);
  assert.equal(paged.paging.links[0].rel, "next");
  const target = (await get(`/rest/organizationAcls?q=organization&organization=${enc(orgUrn(ORGS.northwind))}`)).body;
  assert.equal(target.paging.total, 3);
  assert.ok(target.elements.every((acl) => acl.organizationTarget === orgUrn(ORGS.northwind) && acl.organization === undefined));
  assert.ok(target.elements.some((acl) => acl.state === "REVOKED"));
  await get(`/rest/organizationAcls?q=organization&organization=${enc(orgUrn(ORGS.brightline))}`, [403, "ACCESS_DENIED"]);
  await get(`/rest/organizationAcls?q=organization&organization=${enc(orgUrn(99999999))}`, [404, "NOT_FOUND"]);
  await get("/rest/organizationAcls?q=organization", [400, "MISSING_FIELD"]);
  await get("/rest/organizationAcls?q=roleAssignee&role=OWNER", [400, "INVALID_VALUE_FOR_FIELD"]);
  await get(`/rest/organizationAcls?q=organization&organization=${enc(maya)}`, [400, "INVALID_URN_TYPE"]);
  await get("/rest/organizationAcls?q=organization&organization=urn%3Ali%3Aorganization%3A0", [400, "INVALID_URN_ID"]);
}

async function network() {
  const followers = `/rest/networkSizes/${enc(orgUrn(ORGS.northwind))}`;
  assert.deepEqual((await get(`${followers}?edgeType=COMPANY_FOLLOWED_BY_MEMBER`)).body, { firstDegreeSize: 4821 });
  await get(`${followers}?edgeType=CompanyFollowedByMember`, [400, "INVALID_VALUE_FOR_FIELD"]);
  await get(followers, [400, "MISSING_FIELD"]);
  await get(`/rest/networkSizes/${enc(orgUrn(99999999))}?edgeType=COMPANY_FOLLOWED_BY_MEMBER`, [404, "NOT_FOUND"]);
  await get(`/rest/networkSizes/${enc("urn:li:share:1")}`, [400, "BAD_REQUEST"]);
  assert.deepEqual((await get(`/v2/connections/${enc(maya)}`)).body, { firstDegreeSize: 7 });
  await get(`/v2/connections/${enc(personUrn(PEOPLE.sam))}`, 403);
  await op("network_sizes.get", { entity: "urn:li:share:1" }, "INVALID_URN_TYPE");
  await op("network_sizes.get", { entity: "urn:li:person:x" }, "INVALID_URN_ID");

  const page = async (start) => (await op("connections.list", { start, count: 3 })).value;
  const pages = [await page(0), await page(3), await page(6)];
  assert.equal(pages[0].paging.total, 7);
  const names = pages.flatMap((p) => p.elements.map((e) => e.person.localizedFirstName));
  assert.deepEqual(names, ["Grace", "Aiko", "Daniel", "Zoë", "Luis", "Priya", "Sam"]);
  assert.deepEqual((await op("connections.list", { query: "ZOË" })).value.elements.map((e) => e.person.id), [PEOPLE.zoe]);
  assert.deepEqual((await op("connections.list", { query: "data engineer" })).value.elements.map((e) => e.person.id), [PEOPLE.daniel]);
  await op("connections.list", { query: "�" }, "INVALID_VALUE_FOR_FIELD");
  await op("connections.list", { count: 101 }, "INVALID_VALUE_FOR_FIELD");
}

async function feed() {
  const all = (await op("feed.list", { count: 50 })).value;
  assert.equal(all.paging.total, 16);
  assert.equal(all.viewer.connectionCount, 7);
  assert.deepEqual(all.viewer.pages.map((p) => [p.name, p.roles]), [["Northwind Analytics", ["ADMINISTRATOR"]],
    ["Lakeview Institute of Technology", ["ANALYST"]]]);
  const ids = all.elements.map((item) => item.post.id);
  for (const key of ["zoe", "sam", "brightline", "northwindArticle", "northwindPriya", "mayaConnections"]) assert.ok(ids.includes(POSTS[key].urn), key);
  for (const key of ["jordan", "mayaDraft", "mayaDeleted"]) assert.ok(!ids.includes(POSTS[key].urn), key);
  for (let i = 1; i < all.elements.length; i += 1) assert.ok(all.elements[i - 1].post.publishedAt >= all.elements[i].post.publishedAt);
  const byId = new Map(all.elements.map((item) => [item.post.id, item]));
  assert.equal(byId.get(POSTS.mayaReshare.urn).reshareOf.post.id, POSTS.sam.urn);
  assert.equal(byId.get(POSTS.sam.urn).viewerReaction, "LIKE");
  assert.equal(byId.get(POSTS.sam.urn).social.repostCount, 1);
  assert.deepEqual(byId.get(POSTS.mayaArticle.urn).social.commentSummary, { count: 5, topLevelCount: 3 });
  assert.deepEqual(byId.get(POSTS.northwindArticle.urn).actor, { urn: orgUrn(ORGS.northwind), kind: "organization", name: "Northwind Analytics",
    headline: null, vanityName: "northwind-analytics" });
  const first = (await op("feed.list", { count: 5 })).value;
  assert.equal(first.elements.length, 5);
  assert.equal(first.paging.links[0].rel, "next");
  await op("feed.list", { count: 51 }, "INVALID_VALUE_FOR_FIELD");
}

async function orgsConnection() {
  const target = (await get(`/rest/organizationAcls?q=organization&organization=${enc(orgUrn(ORGS.brightline))}`)).body;
  assert.equal(target.paging.total, 2);
}

export const FLOWS = {
  "orgs-network": async () => { await organizations(); await acls(); await network(); await feed(); },
  "orgs-connection": orgsConnection,
};
