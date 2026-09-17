// Calls every operation once through the canonical endpoint with arguments that are valid for Maya's seeded network.
import { op, orgUrn, personUrn } from "../client.mjs";
import { COMMENTS, ORGS, PEOPLE, POSTS } from "../fixtures.mjs";

export function everyCall() {
  const maya = personUrn(PEOPLE.maya);
  return [
    ["profile.userinfo", {}],
    ["profile.me", {}],
    ["people.get", { personId: PEOPLE.sam }],
    ["posts.create", { author: maya, commentary: "probe", visibility: "PUBLIC", distribution: { feedDistribution: "MAIN_FEED" }, lifecycleState: "PUBLISHED" }],
    ["posts.get", { postUrn: POSTS.mayaPlain.urn }],
    ["posts.list_by_author", { author: maya }],
    ["posts.update", { postUrn: POSTS.mayaPlain.urn, commentary: "probe edit" }],
    ["posts.delete", { postUrn: POSTS.mayaPlain.urn }],
    ["feed.list", {}],
    ["comments.create", { target: POSTS.mayaPlain.urn, actor: maya, message: { text: "probe" } }],
    ["comments.list", { target: POSTS.mayaArticle.urn }],
    ["comments.get", { target: POSTS.mayaArticle.urn, commentId: COMMENTS.samOnArticle.id }],
    ["comments.update", { target: POSTS.zoe.urn, commentId: COMMENTS.mayaOnZoe.id, message: { text: "probe" } }],
    ["comments.delete", { target: POSTS.zoe.urn, commentId: COMMENTS.mayaOnZoe.id }],
    ["reactions.create", { actor: maya, root: POSTS.mayaPlain.urn, reactionType: "LIKE" }],
    ["reactions.list", { entity: POSTS.mayaArticle.activity }],
    ["reactions.delete", { actor: maya, entity: POSTS.zoe.activity }],
    ["social_metadata.get", { entity: POSTS.mayaArticle.urn }],
    ["social_metadata.set_comments_state", { entity: POSTS.mayaPlain.urn, actor: maya, commentsState: "CLOSED" }],
    ["organizations.get", { organizationId: String(ORGS.northwind) }],
    ["organizations.find_by_vanity_name", { vanityName: "northwind-analytics" }],
    ["organization_acls.list", { q: "roleAssignee" }],
    ["network_sizes.get", { entity: orgUrn(ORGS.northwind), edgeType: "COMPANY_FOLLOWED_BY_MEMBER" }],
    ["connections.list", {}],
  ];
}

/** Every operation must answer `expect` ("denied" or a declared error code). */
export async function everyOperation(expect) {
  for (const [operationId, args] of everyCall()) await op(operationId, args, expect);
}
