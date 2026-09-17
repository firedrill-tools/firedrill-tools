// The "…" control menu on a post: edit, delete, comments on/off, copy link, and not-simulated entries.
import { call, newKey, describe, toast } from "./ui.js";
import { confirmDialog, notSimulated } from "./overlay.js";
import { openComposer } from "./composer.js";
import { canManage } from "./post.js";

export function postMenu(entry, ctx) {
  const { post } = entry;
  const items = [
    { icon: "bookmark", label: "Save", sub: "Save for later", onSelect: () => notSimulated("Saved items") },
    { icon: "link", label: "Copy link to post", onSelect: () => copyLink(post.id) },
  ];
  if (canManage(post.author)) {
    items.push(
      { icon: "pencil", label: "Edit post", onSelect: () => openComposer({ edit: entry, onDone: ctx.onReload }) },
      { icon: "trash", label: "Delete post", onSelect: () => deletePost(post, ctx) },
    );
    const closed = entry.social.commentsState === "CLOSED";
    if (post.author === entry.actor.urn) {
      items.push({
        icon: closed ? "comment" : "comment-off",
        label: closed ? "Turn on commenting" : "Turn off commenting",
        sub: closed ? "Let people comment on this post" : "Existing comments will be deleted",
        onSelect: () => setCommentsState(entry, closed ? "OPEN" : "CLOSED", ctx),
      });
    }
  } else {
    items.push({ icon: "close", label: "Not interested", sub: "See fewer posts like this", onSelect: () => notSimulated("Feed preferences") });
  }
  return items;
}

async function copyLink(urn) {
  const text = `https://www.linkedin.com/feed/update/${urn}/`;
  try {
    await navigator.clipboard.writeText(text);
    toast("Link copied to clipboard.");
  } catch {
    toast(`Copy this link: ${text}`);
  }
}

async function deletePost(post, ctx) {
  const ok = await confirmDialog({ title: "Delete post?", message: "Are you sure you want to permanently remove this post from LinkedIn?", confirmLabel: "Delete", danger: true });
  if (!ok) return;
  try {
    await call("posts.delete", { postUrn: post.id }, newKey());
    toast("Post deleted.");
    await ctx.onReload();
  } catch (error) {
    toast(describe(error), { error: true });
  }
}

async function setCommentsState(entry, next, ctx) {
  if (next === "CLOSED") {
    const count = entry.social.commentSummary?.count ?? 0;
    const ok = await confirmDialog({
      title: "Turn off commenting?",
      message: count > 0 ? `This will delete the ${count} existing comment${count === 1 ? "" : "s"} on this post. People won't be able to comment.` : "People won't be able to comment on this post.",
      confirmLabel: "Turn off",
    });
    if (!ok) return;
  }
  try {
    await call("social_metadata.set_comments_state", { entity: entry.post.id, actor: entry.post.author, commentsState: next }, newKey());
    toast(next === "CLOSED" ? "Commenting turned off." : "Commenting turned on.");
    await ctx.onReload();
  } catch (error) {
    toast(describe(error), { error: true });
  }
}
