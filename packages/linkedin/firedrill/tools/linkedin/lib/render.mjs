// Renders stored rows as LinkedIn JSON objects.
import { postUrnOf } from "./urn.mjs";

export function liteProfile(person) {
  const locale = `${person.locale.language}_${person.locale.country}`;
  const localized = (value) => ({ localized: { [locale]: value }, preferredLocale: { country: person.locale.country, language: person.locale.language } });
  return {
    id: person.id,
    localizedFirstName: person.firstName,
    localizedLastName: person.lastName,
    ...(person.headline === null ? {} : { localizedHeadline: person.headline }),
    vanityName: person.vanityName,
    firstName: localized(person.firstName),
    lastName: localized(person.lastName),
    ...(person.pictureUrl === null ? {} : { profilePicture: { displayImage: `urn:li:digitalmediaAsset:${person.id}-profile` } }),
  };
}

export const fullName = (person) => `${person.firstName} ${person.lastName}`;

export function renderPost(post) {
  return {
    id: postUrnOf(post),
    author: post.author,
    commentary: post.commentary,
    visibility: post.visibility,
    distribution: { feedDistribution: post.feedDistribution, targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: post.lifecycleState,
    lifecycleStateInfo: { isEditedByAuthor: post.isEditedByAuthor },
    isReshareDisabledByAuthor: post.isReshareDisabledByAuthor,
    createdAt: post.createdAtMs,
    lastModifiedAt: post.lastModifiedAtMs,
    ...(post.publishedAtMs === null ? {} : { publishedAt: post.publishedAtMs }),
    ...(post.article === null ? {} : {
      content: { article: { source: post.article.source, title: post.article.title,
        ...(post.article.description === null ? {} : { description: post.article.description }) } },
    }),
    ...(post.reshareParent === null ? {} : { reshareContext: { parent: post.reshareParent, root: post.reshareRoot ?? post.reshareParent } }),
  };
}

const auditStamp = (actor, time, impersonator) => ({
  actor, time, ...(impersonator === null || impersonator === undefined ? {} : { impersonator: `urn:li:person:${impersonator}` }),
});

export function renderReaction(reaction) {
  return {
    id: `urn:li:reaction:(${reaction.actor},${reaction.entity})`,
    root: reaction.entity,
    reactionType: reaction.reactionType,
    created: auditStamp(reaction.actor, reaction.createdAtMs, reaction.impersonator),
    lastModified: auditStamp(reaction.actor, reaction.lastModifiedAtMs, reaction.impersonator),
  };
}

/** Comment object; `likes` are the reactions on it and `replies` its reply rows (top-level comments only). */
export function renderComment(comment, likes, replies, viewerUrn) {
  const urn = `urn:li:comment:(urn:li:activity:${comment.activityId},${comment.id})`;
  const stamp = (time) => auditStamp(comment.actor, time, comment.agent);
  return {
    id: comment.id,
    commentUrn: urn,
    actor: comment.actor,
    ...(comment.agent === null ? {} : { agent: `urn:li:person:${comment.agent}` }),
    created: stamp(comment.createdAtMs),
    lastModified: stamp(comment.lastModifiedAtMs),
    message: {
      text: comment.text,
      attributes: comment.attributes.map((attribute) => ({
        start: attribute.start,
        length: attribute.length,
        value: attribute.person !== null
          ? { person: { person: `urn:li:person:${attribute.person}` } }
          : { organization: { organization: `urn:li:organization:${attribute.organization}` } },
      })),
    },
    object: `urn:li:activity:${comment.activityId}`,
    ...(comment.parentCommentId === null ? {} : {
      parentComment: `urn:li:comment:(urn:li:activity:${comment.activityId},${comment.parentCommentId})`,
    }),
    likesSummary: {
      totalLikes: likes.length,
      aggregatedTotalLikes: likes.length,
      likedByCurrentUser: likes.some((like) => like.actor === viewerUrn),
      selectedLikes: likes.slice(0, 10).map((like) => like.actor),
    },
    ...(comment.parentCommentId !== null ? {} : {
      commentsSummary: {
        totalFirstLevelComments: replies.length,
        aggregatedTotalComments: replies.length,
        selectedComments: replies.slice(0, 10).map((reply) => `urn:li:comment:(urn:li:activity:${reply.activityId},${reply.id})`),
      },
    }),
  };
}
