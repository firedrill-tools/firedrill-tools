// feed.list: reverse-chronological home feed of the caller, its connections and followed or managed organizations.
import { visibility } from "../lib/access.mjs";
import { caller, requireScope } from "../lib/auth.mjs";
import { buildPage, pageArgs } from "../lib/paging.mjs";
import { compareIds } from "../lib/postinput.mjs";
import { fullName, renderPost } from "../lib/render.mjs";
import { reactionSummaries, summarize } from "../lib/social.mjs";
import { scanValues } from "../lib/store.mjs";
import { organizationUrn, parseUrn, postUrnOf } from "../lib/urn.mjs";

function actorInfo(context, urn) {
  const parsed = parseUrn(urn);
  if (parsed?.type === "organization") {
    const org = context.state.get("organizations", parsed.id);
    return { urn, kind: "organization", name: org?.name ?? "LinkedIn Member", headline: null, vanityName: org?.vanityName ?? "" };
  }
  const person = parsed === null ? null : context.state.get("people", parsed.id);
  return { urn, kind: "person", name: person === null ? "LinkedIn Member" : fullName(person), headline: person?.headline ?? null,
    vanityName: person?.vanityName ?? "" };
}

export function listFeed(input, context) {
  const who = caller(context);
  requireScope(context, who, ["r_member_social"], "GET /feed");
  const { start, count } = pageArgs(context, input, { defaultCount: 10, maxCount: 50 });
  const connections = new Set(scanValues(context, "connections", `${who.personId}|`).map((edge) => edge.connectedPersonId));
  const pages = new Map();
  for (const acl of scanValues(context, "organization-acls")) {
    if (acl.personId !== who.personId || acl.state !== "APPROVED") continue;
    if (!pages.has(acl.organizationId)) pages.set(acl.organizationId, []);
    pages.get(acl.organizationId).push(acl.role);
  }
  const followed = new Set([...who.person.followingOrganizationIds.map(String), ...[...pages.keys()].map(String)]);
  const all = scanValues(context, "posts");
  const byUrn = new Map(all.map((post) => [postUrnOf(post), post]));
  const reposts = new Map();
  for (const post of all) {
    if (post.reshareParent !== null && post.deletedAtMs === null && post.lifecycleState === "PUBLISHED") {
      reposts.set(post.reshareParent, (reposts.get(post.reshareParent) ?? 0) + 1);
    }
  }
  const inNetwork = (author) => {
    if (author === who.urn) return true;
    const parsed = parseUrn(author);
    return parsed !== null && (parsed.type === "person" ? connections.has(parsed.id) : followed.has(parsed.id));
  };
  const items = all
    .filter((post) => post.lifecycleState === "PUBLISHED" && inNetwork(post.author) && visibility(context, who, post) === "ok")
    .sort((a, b) => b.publishedAtMs - a.publishedAtMs || compareIds(b.id, a.id));
  const render = (post) => {
    const { commentSummary, reactions } = summarize(context, post, null);
    const parent = post.reshareParent === null ? null : byUrn.get(post.reshareParent) ?? null;
    const showParent = parent !== null && parent.lifecycleState === "PUBLISHED" && visibility(context, who, parent) === "ok";
    return {
      post: renderPost(post), actor: actorInfo(context, post.author),
      reshareOf: showParent ? { post: renderPost(parent), actor: actorInfo(context, parent.author) } : null,
      social: { reactionSummaries: reactionSummaries(reactions), commentSummary, commentsState: post.commentsState,
        repostCount: reposts.get(postUrnOf(post)) ?? 0 },
      viewerReaction: reactions.find((reaction) => reaction.actor === who.urn)?.reactionType ?? null,
    };
  };
  const page = buildPage(context, items, render, { start, count, path: "/v1/operations/linkedin/feed.list" });
  const nowMs = Math.floor(context.clock.nowUs() / 1000);
  const viewerPages = [...pages.entries()].map(([organizationId, roles]) => {
    const org = context.state.get("organizations", String(organizationId));
    return { organizationUrn: organizationUrn(organizationId), name: org?.name ?? "", vanityName: org?.vanityName ?? "", roles: roles.sort() };
  });
  return {
    serverTime: new Date(nowMs).toISOString(), serverTimeMs: nowMs,
    viewer: { personUrn: who.urn, name: fullName(who.person), headline: who.person.headline, vanityName: who.person.vanityName,
      connectionCount: connections.size, pages: viewerPages },
    ...page,
  };
}
