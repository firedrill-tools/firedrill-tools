// Like (with the six-reaction picker), Comment, Repost and Send buttons of a post card.
import { el, call, newKey, describe, toast } from "./ui.js";
import { icon } from "./icons.js";
import { REACTIONS, REACTION_BY_TYPE, reactionBadge } from "./reactions.js";
import { session } from "./store.js";
import { toggleComments } from "./comments.js";
import { openComposer } from "./composer.js";
import { notSimulated } from "./overlay.js";

export function renderActions(host, entry, state, { paint, commentsHost, ctx }) {
  const { post } = entry;
  const likeWrap = el("div", { class: "social-actions__like" });
  const likeButton = el("button", { class: "social-action", attrs: { type: "button", "aria-pressed": "false" } });
  let picker = null;
  let hoverTimer;
  let pendingReaction = false;

  const paintLike = () => {
    const reaction = state.viewerReaction ? REACTION_BY_TYPE.get(state.viewerReaction) : null;
    likeButton.replaceChildren(reaction && reaction.type !== "LIKE" ? reactionBadge(reaction.type, 20) : icon("like"), el("span", { text: reaction ? reaction.label : "Like" }));
    likeButton.setAttribute("aria-pressed", String(Boolean(reaction)));
    likeButton.setAttribute("aria-label", reaction ? `Undo ${reaction.label} reaction` : "React Like");
    if (reaction) likeButton.dataset.reaction = reaction.type; else delete likeButton.dataset.reaction;
  };

  const react = async (type) => {
    if (pendingReaction) return;
    pendingReaction = true;
    closePicker();
    const actor = session.viewer.personUrn;
    const previous = state.viewerReaction;
    try {
      if (type === null) await call("reactions.delete", { actor, entity: post.id }, newKey());
      else await call("reactions.create", { actor, root: post.id, reactionType: type }, newKey());
      state.viewerReaction = type;
      paintLike();
      await host.closest(".feed-post")?.refreshSocial?.();
    } catch (error) {
      state.viewerReaction = previous;
      paintLike();
      toast(describe(error), { error: true });
    } finally {
      pendingReaction = false;
    }
  };

  const openPicker = () => {
    if (picker) return;
    picker = el("div", { class: "reaction-picker", attrs: { role: "toolbar", "aria-label": "Reactions" } }, REACTIONS.map((reaction) =>
      el("button", { class: "reaction-picker__item", attrs: { type: "button", "aria-label": reaction.label }, on: { click: () => react(reaction.type) } }, [
        reactionBadge(reaction.type, 36), el("span", { class: "reaction-picker__tip", text: reaction.label, attrs: { "aria-hidden": "true" } }),
      ])));
    picker.addEventListener("mouseenter", () => clearTimeout(hoverTimer));
    picker.addEventListener("mouseleave", () => { hoverTimer = setTimeout(closePicker, 300); });
    picker.addEventListener("keydown", (event) => { if (event.key === "Escape") { closePicker(); likeButton.focus(); } });
    likeWrap.append(picker);
  };
  const closePicker = () => { picker?.remove(); picker = null; };

  likeButton.addEventListener("click", () => react(state.viewerReaction ? null : "LIKE"));
  likeButton.addEventListener("mouseenter", () => { clearTimeout(hoverTimer); hoverTimer = setTimeout(openPicker, 500); });
  likeButton.addEventListener("mouseleave", () => { clearTimeout(hoverTimer); hoverTimer = setTimeout(closePicker, 400); });
  likeButton.addEventListener("keydown", (event) => {
    if (event.key === "ArrowUp" || (event.key === "Enter" && event.shiftKey)) { event.preventDefault(); openPicker(); picker.querySelector("button").focus(); }
  });
  paintLike();
  likeWrap.append(likeButton);

  const commentButton = el("button", { class: "social-action", attrs: { type: "button", "aria-label": "Comment" }, on: {
    click: () => toggleComments(commentsHost, entry, { focus: true, onChanged: () => host.closest(".feed-post")?.refreshSocial?.() }),
  } }, [icon("comment"), el("span", { text: "Comment" })]);

  const reshareDisabled = post.isReshareDisabledByAuthor || post.visibility !== "PUBLIC";
  const repostTarget = entry.reshareOf && !post.commentary ? entry.reshareOf : entry;
  const repostButton = el("button", { class: "social-action", title: reshareDisabled ? "The author has disabled reposting for this post" : "Repost", attrs: { type: "button", "aria-label": "Repost", disabled: reshareDisabled ? true : undefined }, on: {
    click: () => openComposer({ repostOf: repostTarget, onDone: ctx.onReload }),
  } }, [icon("repost"), el("span", { text: "Repost" })]);

  const sendButton = el("button", { class: "social-action", attrs: { type: "button", "aria-label": "Send in a private message" }, on: { click: () => notSimulated("Sending posts in messages") } }, [icon("send"), el("span", { text: "Send" })]);

  host.append(likeWrap, el("div", {}, commentButton), el("div", {}, repostButton), el("div", {}, sendButton));
  void paint;
}
