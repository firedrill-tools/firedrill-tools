// Synthetic LinkedIn member network for Firedrill: the versioned Community Management REST API subset under /rest plus
// the /v2 consumer endpoints. Every operation computes from `context.state`; nothing is sent to LinkedIn.
import * as R from "./lib/routes.mjs";
import { encoder } from "./lib/wire.mjs";
import { createComment, deleteComment, updateComment } from "./ops/comments-write.mjs";
import { getComment, listComments } from "./ops/comments-read.mjs";
import { listFeed } from "./ops/feed.mjs";
import { getNetworkSize, listConnections } from "./ops/network.mjs";
import { findByVanityName, getOrganization, listAcls } from "./ops/orgs.mjs";
import { deletePost, updatePost } from "./ops/posts-edit.mjs";
import { getPost, listByAuthor } from "./ops/posts-read.mjs";
import { createPost } from "./ops/posts-write.mjs";
import { getPerson, me, userinfo } from "./ops/profile.mjs";
import { createReaction, deleteReaction, listReactions } from "./ops/reactions.mjs";
import { getSocialMetadata, setCommentsState } from "./ops/social.mjs";

const body = (value) => ({ body: value });
const empty = () => ({});
const json = encoder(body);
const v2json = encoder(body, true);
// A compound-key GET answers the bare reaction; the entity finder answers the collection.
const reactionsEncoder = (result) =>
  encoder((page) => ({ body: result.invocation?.arguments?.single === true ? page.elements[0] : page }))(result);

// [operation id, handler, [route id, decoder, encoder]...]
const TABLE = [
  ["profile.userinfo", userinfo, ["userinfo", R.plain, v2json]],
  ["profile.me", me, ["me", R.plain, v2json]],
  ["people.get", getPerson, ["get-person", R.getPerson, v2json]],
  ["posts.create", createPost,
    ["create-post", R.createPost, encoder((post) => ({ headers: { "x-restli-id": post.id, "x-linkedin-id": post.id } }))],
    ["create-ugc-post", R.createUgcPost, encoder((post) => ({ headers: { "x-restli-id": post.id }, body: { id: post.id } }), true)]],
  ["posts.get", getPost, ["get-post", R.getPost, json]],
  ["posts.list_by_author", listByAuthor, ["find-posts", R.findPosts, json]],
  ["posts.update", updatePost, ["update-post", R.updatePost, encoder(empty)]],
  ["posts.delete", deletePost, ["delete-post", R.deletePost("postUrn", true), encoder(empty)],
    ["delete-ugc-post", R.deletePost("ugcPostUrn", false), encoder(empty, true)]],
  ["feed.list", listFeed],
  ["comments.create", createComment, ["create-comment", R.createComment, encoder((c) => ({ headers: { "x-restli-id": c.id }, body: c }))]],
  ["comments.list", listComments, ["list-comments", R.listComments, json]],
  ["comments.get", getComment, ["get-comment", R.getComment, json]],
  ["comments.update", updateComment,
    ["update-comment", R.updateComment, encoder((c) => ({ headers: { "x-resourceidentity-urn": c.commentUrn }, body: c }))]],
  ["comments.delete", deleteComment, ["delete-comment", R.deleteComment, encoder(empty)]],
  ["reactions.create", createReaction, ["create-reaction", R.createReaction, json]],
  ["reactions.list", listReactions,
    ["get-reactions", R.getReactions, reactionsEncoder]],
  ["reactions.delete", deleteReaction, ["delete-reaction", R.deleteReaction, encoder(empty)]],
  ["social_metadata.get", getSocialMetadata, ["get-social-metadata", R.getSocialMetadata, json]],
  ["social_metadata.set_comments_state", setCommentsState, ["update-social-metadata", R.updateSocialMetadata, encoder(empty)]],
  ["organizations.get", getOrganization, ["get-organization", R.getOrganization, json]],
  ["organizations.find_by_vanity_name", findByVanityName, ["find-organizations", R.findOrganizations, json]],
  ["organization_acls.list", listAcls, ["find-organization-acls", R.findAcls, json]],
  ["network_sizes.get", getNetworkSize, ["get-network-size", R.getNetworkSize, json],
    ["get-connection-size", R.getConnectionSize, encoder(body, true)]],
  ["connections.list", listConnections],
];

const operations = {};
const http = {};
for (const [operationId, handler, ...routes] of TABLE) {
  operations[operationId] = handler;
  for (const [routeId, decode, encode] of routes) http[routeId] = { decode, encode };
}

export default { operations, http };
