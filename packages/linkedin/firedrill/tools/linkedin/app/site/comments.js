// Comments section under a post: comment box with @mentions and "comment as", paged list, replies, likes, edit and delete.
import { el, call, newKey, describe, toast, avatar, relativeTime, busy } from "./ui.js";
import { icon } from "./icons.js";
import { session, actingPages, resolveEntity, hrefForUrn, isViewer } from "./store.js";
import { renderAttributedText } from "./text.js";
import { confirmDialog, showMenu, notSimulated } from "./overlay.js";
import { commentBox } from "./comment-box.js";
import { canManage } from "./post.js";

const PAGE = 10;

/** Expand (or collapse) the comments section of a post card. */
export function toggleComments(host, entry, { focus = false, onChanged } = {}) {
  if (host.dataset.open === "true") {
    if (focus) host.querySelector(".comment-box__input")?.focus();
    else { host.dataset.open = "false"; host.replaceChildren(); }
    return;
  }
  host.dataset.open = "true";
  const ctx = { entry, onChanged: async () => { await onChanged?.(); } };
  const section = el("section", { class: "comments", attrs: { "aria-label": "Comments" } });
  host.replaceChildren(section);
  if (entry.social.commentsState === "CLOSED") {
    section.append(el("p", { class: "comments__closed" }, [icon("comment-off"), el("span", { text: "Comments are turned off for this post." })]));
    return;
  }
  const list = el("div", { class: "comments__list" });
  const box = commentBox({
    placeholder: "Add a comment…",
    submitLabel: "Comment",
    asPages: true,
    autofocus: focus,
    onSubmit: async ({ text, attributes, actor }) => {
      await call("comments.create", { target: entry.post.id, actor, message: { text, attributes } }, newKey());
      await loadInto(list, ctx, { reset: true });
      await ctx.onChanged();
    },
  });
  section.append(box, el("div", { class: "comments__sort" }, [el("span", { text: "Oldest" }), icon("caret-down")]), list);
  void loadInto(list, ctx, { reset: true });
}

async function loadInto(list, ctx, { reset = false, parent = null } = {}) {
  const target = parent ? parent.commentUrn : ctx.entry.post.id;
  const start = reset ? 0 : Number(list.dataset.loaded ?? 0);
  if (reset) { list.replaceChildren(el("div", { class: "comments__loading", attrs: { role: "status" } }, el("span", { class: "spinner", attrs: { "aria-label": "Loading comments" } }))); }
  list.querySelector(".comments__more")?.remove();
  try {
    const page = await call("comments.list", { target, start, count: PAGE });
    if (reset) list.replaceChildren();
    for (const comment of page.elements) list.append(await renderComment(comment, ctx, parent));
    const loaded = start + page.elements.length;
    list.dataset.loaded = String(loaded);
    if (reset && page.elements.length === 0 && !parent) list.append(el("p", { class: "comments__empty", text: "No comments yet. Be the first to comment." }));
    const total = page.paging.total ?? loaded;
    if (loaded < total) {
      list.append(el("button", { class: "comments__more", text: parent ? `Load more replies` : "Load more comments", attrs: { type: "button" }, on: { click: (event) => busy(event.currentTarget, () => loadInto(list, ctx, { parent })) } }));
    }
  } catch (error) {
    if (reset) list.replaceChildren();
    list.append(el("p", { class: "comments__error", attrs: { role: "alert" } }, [el("span", { text: describe(error) }), el("button", { class: "btn btn--tertiary btn--sm", text: "Retry", attrs: { type: "button" }, on: { click: () => loadInto(list, ctx, { reset: true, parent }) } })]));
  }
}

async function renderComment(comment, ctx, parent) {
  const who = await resolveEntity(comment.actor);
  const isOrg = who.kind === "organization";
  const row = el("article", { class: `comment${parent ? " comment--reply" : ""}`, attrs: { "data-comment": comment.id } });
  const href = hrefForUrn(comment.actor);
  const edited = comment.lastModified.time > comment.created.time;
  const mine = isViewer(comment.actor) || actingPages().some((p) => p.organizationUrn === comment.actor);
  const canDelete = mine || canManage(ctx.entry.post.author);

  const bubble = el("div", { class: "comment__bubble" });
  const menuButton = el("button", { class: "icon-btn icon-btn--sm comment__menu", title: "Open options", attrs: { type: "button", "aria-label": `Open options for ${who.name}'s comment`, "aria-haspopup": "menu" } }, icon("ellipsis"));
  menuButton.addEventListener("click", () => showMenu(menuButton, [
    ...(isViewer(comment.actor) ? [{ icon: "pencil", label: "Edit", onSelect: () => startEdit(bubble, textNode, comment, ctx) }] : []),
    ...(canDelete ? [{ icon: "trash", label: "Delete", onSelect: () => removeComment(comment, ctx, row) }] : []),
    { icon: "alert", label: "Report", onSelect: () => notSimulated("Reporting comments") },
  ]));
  const textNode = renderAttributedText(el("div", { class: "comment__text", attrs: { dir: "ltr" } }), comment.message.text, comment.message.attributes);
  bubble.append(
    el("div", { class: "comment__head" }, [
      el("div", { class: "comment__who" }, [
        el("span", { class: "comment__name-line" }, [
          el("a", { class: "comment__name", text: who.name, attrs: { href } }),
          comment.actor === ctx.entry.post.author ? el("span", { class: "comment__author-badge", text: "Author" }) : isViewer(comment.actor) ? el("span", { class: "comment__degree", text: "• You" }) : null,
        ]),
        who.headline ? el("span", { class: "comment__headline", text: who.headline }) : null,
      ]),
      el("div", { class: "comment__aside" }, [el("span", { class: "comment__time", text: `${relativeTime(comment.created.time)}${edited ? " (edited)" : ""}` }), menuButton]),
    ]),
    textNode,
  );

  const likes = comment.likesSummary ?? { totalLikes: 0, likedByCurrentUser: false };
  const likeState = { liked: Boolean(likes.likedByCurrentUser), count: likes.totalLikes ?? 0 };
  const likeButton = el("button", { class: "comment__action", attrs: { type: "button" } });
  const likeCount = el("span", { class: "comment__count" });
  const paintLike = () => {
    likeButton.textContent = "Like";
    likeButton.setAttribute("aria-pressed", String(likeState.liked));
    likeButton.setAttribute("aria-label", likeState.liked ? `Unlike ${who.name}'s comment` : `Like ${who.name}'s comment`);
    likeButton.classList.toggle("comment__action--active", likeState.liked);
    likeCount.replaceChildren();
    if (likeState.count > 0) likeCount.append(el("span", { class: "comment__dot", text: "•" }), el("span", { class: "comment__count-badge" }, [icon("like"), el("span", { text: String(likeState.count) })]));
  };
  paintLike();
  likeButton.addEventListener("click", () => busy(likeButton, async () => {
    const actor = session.viewer.personUrn;
    try {
      if (likeState.liked) await call("reactions.delete", { actor, entity: comment.commentUrn }, newKey());
      else await call("reactions.create", { actor, root: comment.commentUrn, reactionType: "LIKE" }, newKey());
      likeState.count += likeState.liked ? -1 : 1;
      likeState.liked = !likeState.liked;
      paintLike();
    } catch (error) { toast(describe(error), { error: true }); }
  }));

  const actions = el("div", { class: "comment__actions" }, [likeButton, likeCount]);
  const body = el("div", { class: "comment__body" }, [bubble, actions]);
  row.append(el("a", { class: "comment__avatar", attrs: { href, tabindex: "-1", "aria-hidden": "true" } }, avatar(who.name, comment.actor, parent ? 32 : 40, isOrg)), body);

  if (!parent) {
    const replyCount = comment.commentsSummary?.aggregatedTotalComments ?? 0;
    const replies = el("div", { class: "comment__replies" });
    const replyButton = el("button", { class: "comment__action", text: "Reply", attrs: { type: "button", "aria-label": `Reply to ${who.name}'s comment` } });
    actions.append(el("span", { class: "comment__sep", text: "|", attrs: { "aria-hidden": "true" } }), replyButton);
    if (replyCount > 0) actions.append(el("span", { class: "comment__dot", text: "•" }), el("span", { class: "comment__count", text: `${replyCount} ${replyCount === 1 ? "reply" : "replies"}` }));
    body.append(replies);
    const openReplies = async (withBox) => {
      if (replies.dataset.open !== "true") {
        replies.dataset.open = "true";
        const list = el("div", { class: "comments__list" });
        replies.append(list);
        await loadInto(list, ctx, { reset: true, parent: comment });
      }
      if (withBox && !replies.querySelector(".comment-box")) {
        const box = commentBox({
          placeholder: "Add a reply…", submitLabel: "Reply", asPages: true, autofocus: true, compact: true,
          onSubmit: async ({ text, attributes, actor }) => {
            await call("comments.create", { target: comment.commentUrn, actor, parentComment: comment.commentUrn, message: { text, attributes } }, newKey());
            replies.replaceChildren();
            replies.dataset.open = "false";
            await openReplies(false);
            await ctx.onChanged();
          },
        });
        replies.prepend(box);
      }
    };
    replyButton.addEventListener("click", () => openReplies(true));
    if (replyCount > 0) void openReplies(false);
  }
  return row;
}

function startEdit(bubble, textNode, comment, ctx) {
  if (bubble.querySelector(".comment-box")) return;
  textNode.hidden = true;
  const box = commentBox({
    initialText: comment.message.text, initialAttributes: comment.message.attributes, submitLabel: "Save changes", autofocus: true, compact: true,
    onCancel: () => { box.remove(); textNode.hidden = false; },
    onSubmit: async ({ text, attributes }) => {
      await call("comments.update", { target: ctx.entry.post.id, commentId: comment.id, message: { text, attributes } }, newKey());
      comment.message = { text, attributes };
      textNode.replaceChildren();
      renderAttributedText(textNode, text, attributes);
      box.remove();
      textNode.hidden = false;
      toast("Comment edited.");
    },
  });
  textNode.after(box);
}

async function removeComment(comment, ctx, row) {
  const ok = await confirmDialog({ title: "Delete comment?", message: "Are you sure you want to delete this comment? Replies to it will be deleted too.", confirmLabel: "Delete", danger: true });
  if (!ok) return;
  try {
    await call("comments.delete", { target: ctx.entry.post.id, commentId: comment.id }, newKey());
    row.remove();
    toast("Comment deleted.");
    await ctx.onChanged();
  } catch (error) {
    toast(describe(error), { error: true });
  }
}
