// Route decoders: LinkedIn path keys, query parameters, headers and bodies into operation arguments.
import { parseComplexKey } from "./urn.mjs";
import { begin, copyFields, finish, isObject, jsonBody, pathValue, queryInt, queryValue } from "./wire.mjs";

const SYNTAX = "Syntax exception in path variables";
const set = (state, name, value) => {
  if (value !== undefined) state.args[name] = value;
};
const defined = (object) => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
const paging = (state) => {
  set(state, "start", queryInt(state, "start"));
  set(state, "count", queryInt(state, "count"));
};

/** Builds a decoder: `rest` routes carry the version/method checks; `fill(state, request)` adds route arguments. */
export const route = (options, fill) => (request) => {
  const state = begin(request, options);
  fill(state, request);
  return finish(state);
};

export const plain = () => ({ arguments: {} });

export const getPerson = route({ rest: false }, (state, request) => {
  const key = parseComplexKey(pathValue(request, "personKey"));
  if (key === null || key.size !== 1 || !key.has("id")) state.wire.error = SYNTAX;
  else state.args.personId = key.get("id");
});

export const createPost = route({ rest: true }, (state, request) => {
  copyFields(state, jsonBody(state, request), ["author", "commentary", "visibility", "distribution", "lifecycleState", "isReshareDisabledByAuthor",
    "content", "reshareContext"]);
});

export const createUgcPost = route({ rest: false }, (state, request) => {
  const body = jsonBody(state, request);
  if (body === null) return;
  const args = state.args;
  args.kind = "ugcPost";
  args.distribution = { feedDistribution: "MAIN_FEED" };
  if (body.author !== undefined) args.author = body.author;
  if (body.lifecycleState !== undefined) args.lifecycleState = body.lifecycleState;
  if (isObject(body.visibility)) set(state, "visibility", body.visibility["com.linkedin.ugc.MemberNetworkVisibility"]);
  const share = isObject(body.specificContent) ? body.specificContent["com.linkedin.ugc.ShareContent"] : undefined;
  if (!isObject(share)) return;
  if (isObject(share.shareCommentary)) set(state, "commentary", share.shareCommentary.text);
  const category = share.shareMediaCategory ?? "NONE";
  if (category === "ARTICLE") {
    const media = Array.isArray(share.media) && isObject(share.media[0]) ? share.media[0] : {};
    const text = (value) => (isObject(value) ? value.text : undefined);
    args.content = { article: defined({ source: media.originalUrl, title: text(media.title), description: text(media.description) }) };
  } else if (category !== "NONE") {
    args.content = { media: { category: String(category).slice(0, 64) } };
  }
});

export const getPost = route({ rest: true }, (state, request) => {
  state.args.postUrn = pathValue(request, "postUrn");
  set(state, "viewContext", queryValue(state, "viewContext"));
});

export const findPosts = route({ rest: true }, (state) => {
  if (queryValue(state, "q") !== "author") state.wire.error = "Invalid query parameters passed to request: q";
  set(state, "author", queryValue(state, "author"));
  set(state, "viewContext", queryValue(state, "viewContext"));
  set(state, "sortBy", queryValue(state, "sortBy"));
  paging(state);
});

const POST_PATCH = ["commentary", "lifecycleState", "contentCallToActionLabel", "contentLandingPage"];

export const updatePost = route({ rest: true, requireMethod: true }, (state, request) => {
  state.args.postUrn = pathValue(request, "postUrn");
  const body = jsonBody(state, request);
  if (body === null) return;
  for (const key of Object.keys(body)) if (key !== "patch") state.wire.fieldError = key;
  const patch = body.patch;
  if (!isObject(patch)) {
    state.wire.fieldError ??= "patch";
    return;
  }
  for (const key of Object.keys(patch)) if (key !== "$set") state.wire.fieldError = `patch/${key}`;
  const changes = patch.$set ?? {};
  if (!isObject(changes)) {
    state.wire.fieldError ??= "patch/$set";
    return;
  }
  for (const key of Object.keys(changes)) {
    if (POST_PATCH.includes(key)) state.args[key] = changes[key];
    else state.wire.fieldError = `patch/$set/${key}`;
  }
});

export const deletePost = (name, rest) => route({ rest }, (state, request) => {
  state.args.postUrn = pathValue(request, name);
});

const target = (state, request) => {
  state.args.target = pathValue(request, "target");
};
const commentKey = (state, request) => {
  target(state, request);
  state.args.commentId = pathValue(request, "commentId");
};

export const createComment = route({ rest: true }, (state, request) => {
  target(state, request);
  copyFields(state, jsonBody(state, request), ["actor", "object", "message", "parentComment", "content"]);
});

export const listComments = route({ rest: true }, (state, request) => {
  target(state, request);
  paging(state);
});

export const getComment = route({ rest: true }, commentKey);

export const updateComment = route({ rest: true, requireMethod: true }, (state, request) => {
  commentKey(state, request);
  set(state, "actor", queryValue(state, "actor"));
  const body = jsonBody(state, request);
  if (body === null) return;
  const changes = isObject(body.patch) && isObject(body.patch.message) ? body.patch.message.$set : undefined;
  if (!isObject(changes) || Object.keys(body).length !== 1 || Object.keys(body.patch).length !== 1
    || Object.keys(body.patch.message).length !== 1) {
    state.wire.fieldError = "patch";
    return;
  }
  for (const key of Object.keys(changes)) if (key !== "text" && key !== "attributes") state.wire.fieldError = `patch/message/$set/${key}`;
  state.args.message = defined({ text: changes.text, attributes: changes.attributes });
});

export const deleteComment = route({ rest: true }, (state, request) => {
  commentKey(state, request);
  set(state, "actor", queryValue(state, "actor"));
});

export const createReaction = route({ rest: true }, (state, request) => {
  set(state, "actor", queryValue(state, "actor"));
  copyFields(state, jsonBody(state, request), ["root", "reactionType"]);
});

export const getReactions = route({ rest: true }, (state, request) => {
  const key = parseComplexKey(pathValue(request, "reactionKey"));
  if (key === null || !key.has("entity") || key.size > 2 || (key.size === 2 && !key.has("actor"))) {
    state.wire.error = SYNTAX;
    state.args.entity = "";
    return;
  }
  state.args.entity = key.get("entity");
  if (key.has("actor")) {
    state.args.single = true;
    state.args.actor = key.get("actor");
    return;
  }
  if (queryValue(state, "q") !== "entity") state.wire.error = "Invalid query parameters passed to request: q";
  const sort = queryValue(state, "sort");
  if (sort !== undefined) {
    const parsed = parseComplexKey(sort);
    if (parsed === null || parsed.size !== 1 || !parsed.has("value")) state.wire.error = "Invalid query parameters passed to request: sort";
    else state.args.sort = parsed.get("value");
  }
  paging(state);
});

export const deleteReaction = route({ rest: true }, (state, request) => {
  const key = parseComplexKey(pathValue(request, "reactionKey"));
  if (key === null || key.size !== 2 || !key.has("actor") || !key.has("entity")) {
    state.wire.error = SYNTAX;
    state.args.actor = "";
    state.args.entity = "";
    return;
  }
  state.args.actor = key.get("actor");
  state.args.entity = key.get("entity");
});

export const getSocialMetadata = route({ rest: true }, (state, request) => {
  state.args.entity = pathValue(request, "entity");
});

export const updateSocialMetadata = route({ rest: true }, (state, request) => {
  state.args.entity = pathValue(request, "entity");
  set(state, "actor", queryValue(state, "actor"));
  const body = jsonBody(state, request);
  if (body === null) return;
  const changes = isObject(body.patch) ? body.patch.$set : undefined;
  if (!isObject(changes) || Object.keys(body).length !== 1 || Object.keys(body.patch).length !== 1) {
    state.wire.fieldError = "patch";
    return;
  }
  for (const key of Object.keys(changes)) {
    if (key === "commentsState") state.args.commentsState = changes.commentsState;
    else state.wire.fieldError = `patch/$set/${key}`;
  }
});

export const getOrganization = route({ rest: true }, (state, request) => {
  state.args.organizationId = pathValue(request, "organizationId");
});

export const findOrganizations = route({ rest: true }, (state) => {
  if (queryValue(state, "q") !== "vanityName") state.wire.error = "Invalid query parameters passed to request: q";
  state.args.vanityName = queryValue(state, "vanityName") ?? "";
});

export const findAcls = route({ rest: true }, (state) => {
  for (const name of ["q", "organization", "role", "state"]) set(state, name, queryValue(state, name));
  paging(state);
});

export const getNetworkSize = route({ rest: true }, (state, request) => {
  state.args.entity = pathValue(request, "entity");
  set(state, "edgeType", queryValue(state, "edgeType"));
});

export const getConnectionSize = route({ rest: false }, (state, request) => {
  state.args.entity = pathValue(request, "personUrn");
});
