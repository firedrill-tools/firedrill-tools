// Feed post card: actor line, commentary, article/reshare frames, social counts and the action bar.
import { el, call, relativeTime, avatar, iconButton } from "./ui.js";
import { icon } from "./icons.js";
import { reactionBadge } from "./reactions.js";
import { renderLittleText } from "./text.js";
import { session, isViewer, hrefForUrn, parseEntityUrn, rememberActor } from "./store.js";
import { showMenu, notSimulated } from "./overlay.js";
import { toggleComments } from "./comments.js";
import { openReactionsModal } from "./reactors.js";

const VISIBILITY = { PUBLIC: ["globe", "Anyone on or off LinkedIn"], CONNECTIONS: ["people", "Connections only"], LOGGED_IN: ["lock", "Members only"] };

function hostname(source) {
  const match = /^[a-z]+:\/\/([^/?#:]+)/i.exec(String(source ?? ""));
  return match ? match[1] : String(source ?? "");
}

function actorLine(actor, post, { compact = false } = {}) {
  const isOrg = actor.kind === "organization";
  const href = hrefForUrn(actor.urn);
  const nameLine = el("span", { class: "post-actor__name-line" }, [
    el("a", { class: "post-actor__name", text: actor.name, attrs: { href } }),
    isViewer(actor.urn) ? el("span", { class: "post-actor__degree", text: " • You" }) : null,
  ]);
  const [visIcon, visLabel] = VISIBILITY[post.visibility] ?? VISIBILITY.PUBLIC;
  const time = el("span", { class: "post-actor__time" }, [
    el("span", { text: relativeTime(post.publishedAt ?? post.createdAt) }),
    post.lifecycleStateInfo?.isEditedByAuthor ? el("span", { text: " • Edited" }) : null,
    el("span", { text: " • " }),
    el("span", { class: "post-actor__vis", title: visLabel, attrs: { role: "img", "aria-label": visLabel } }, icon(visIcon)),
  ]);
  return el("div", { class: `post-actor${compact ? " post-actor--compact" : ""}` }, [
    el("a", { class: "post-actor__avatar", attrs: { href, "aria-label": actor.name, tabindex: "-1" } }, avatar(actor.name, actor.urn, compact ? 32 : 48, isOrg)),
    el("div", { class: "post-actor__meta" }, [
      nameLine,
      actor.headline ? el("span", { class: "post-actor__headline", text: isOrg ? actor.headline : actor.headline }) : isOrg ? el("span", { class: "post-actor__headline", text: "Company page" }) : null,
      time,
    ]),
  ]);
}

function commentary(text) {
  const box = el("div", { class: "post-text" });
  const inner = renderLittleText(el("span", { class: "post-text__inner", attrs: { dir: "ltr" } }), text);
  box.append(inner);
  const more = el("button", { class: "post-text__more", text: "…more", attrs: { type: "button" }, on: { click: () => { box.classList.add("post-text--expanded"); more.remove(); } } });
  box.append(more);
  requestAnimationFrame(() => { if (inner.scrollHeight <= inner.clientHeight + 2) more.remove(); });
  return box;
}

function articleCard(article) {
  return el("a", { class: "post-article", attrs: { href: "#/feed", "data-not-simulated": "Opening external links" } }, [
    el("div", { class: "post-article__art", attrs: { "aria-hidden": "true" } }, icon("article")),
    el("div", { class: "post-article__meta" }, [
      el("span", { class: "post-article__title", text: article.title }),
      el("span", { class: "post-article__source", text: hostname(article.source) }),
    ]),
  ]);
}

export function canManage(authorUrn) {
  if (isViewer(authorUrn)) return true;
  const parsed = parseEntityUrn(authorUrn);
  return parsed?.kind === "organization" && (session.viewer?.pages ?? []).some((p) => p.organizationUrn === authorUrn && p.roles.some((r) => r === "ADMINISTRATOR" || r === "CONTENT_ADMINISTRATOR"));
}

/** Build a post card. ctx: { onReload(): Promise } */
export function renderPostCard(entry, ctx) {
  const { post, actor } = entry;
  rememberActor(actor);
  if (entry.reshareOf) rememberActor(entry.reshareOf.actor);
  const state = { social: entry.social, viewerReaction: entry.viewerReaction };
  const card = el("article", { class: "card feed-post", attrs: { "data-urn": post.id, "aria-label": `Post by ${actor.name}` } });

  const menuButton = iconButton("ellipsis", `Open control menu for post by ${actor.name}`, () => showMenu(menuButton, postMenu(entry, ctx)), "feed-post__menu");
  menuButton.setAttribute("aria-haspopup", "menu");
  const hide = iconButton("close", `Hide post by ${actor.name}`, () => notSimulated("Hiding posts from your feed"), "feed-post__hide");
  card.append(el("div", { class: "feed-post__controls" }, [menuButton, hide]));
  card.append(actorLine(actor, post));
  if (post.commentary) card.append(commentary(post.commentary));
  if (post.content?.article) card.append(articleCard(post.content.article));
  if (entry.reshareOf) {
    const inner = el("div", { class: "post-reshare" }, [actorLine(entry.reshareOf.actor, entry.reshareOf.post, { compact: true })]);
    if (entry.reshareOf.post.commentary) inner.append(commentary(entry.reshareOf.post.commentary));
    if (entry.reshareOf.post.content?.article) inner.append(articleCard(entry.reshareOf.post.content.article));
    card.append(inner);
  } else if (post.reshareContext) {
    card.append(el("div", { class: "post-reshare post-reshare--gone", text: "This content isn't available" }));
  }

  const counts = el("div", { class: "social-counts" });
  const actions = el("div", { class: "social-actions" });
  card.append(counts, actions);
  const commentsHost = el("div", { class: "comments-host" });
  card.append(commentsHost);

  const paint = () => renderCounts(counts, entry, state, commentsHost);
  paint();
  renderActions(actions, entry, state, { paint, commentsHost, ctx });
  card.refreshSocial = async () => {
    try {
      const meta = await call("social_metadata.get", { entity: post.id });
      state.social = { ...state.social, reactionSummaries: meta.reactionSummaries, commentSummary: meta.commentSummary, commentsState: meta.commentsState };
      paint();
    } catch { /* counts stay as last read */ }
  };
  return card;
}

function renderCounts(host, entry, state, commentsHost) {
  host.replaceChildren();
  const summaries = Object.values(state.social.reactionSummaries ?? {}).sort((a, b) => b.count - a.count);
  const total = summaries.reduce((sum, s) => sum + s.count, 0);
  const comments = state.social.commentSummary?.count ?? 0;
  const reposts = state.social.repostCount ?? 0;
  if (total === 0 && comments === 0 && reposts === 0) { host.hidden = true; return; }
  host.hidden = false;
  if (total > 0) {
    const badges = el("span", { class: "social-counts__badges" }, summaries.slice(0, 3).map((s) => reactionBadge(s.reactionType, 16)));
    host.append(el("button", { class: "social-counts__reactions", attrs: { type: "button", "aria-label": `${total} reactions` }, on: { click: () => openReactionsModal(entry.post, state.social.reactionSummaries) } }, [badges, el("span", { text: String(total) })]));
  }
  const right = el("span", { class: "social-counts__right" });
  if (comments > 0) right.append(el("button", { class: "social-counts__link", text: `${comments} comment${comments === 1 ? "" : "s"}`, attrs: { type: "button" }, on: { click: () => toggleComments(commentsHost, entry, { onChanged: () => commentsHost.closest(".feed-post")?.refreshSocial?.() }) } }));
  if (comments > 0 && reposts > 0) right.append(el("span", { class: "social-counts__dot", text: "•", attrs: { "aria-hidden": "true" } }));
  if (reposts > 0) right.append(el("span", { class: "social-counts__link social-counts__link--static", text: `${reposts} repost${reposts === 1 ? "" : "s"}` }));
  host.append(right);
}

import { renderActions } from "./post-actions.js";
import { postMenu } from "./post-menu.js";
