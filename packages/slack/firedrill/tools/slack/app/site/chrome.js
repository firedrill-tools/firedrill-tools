// Slack client chrome that the Tool does not simulate (huddles, clips, saved items, forwarding, scheduling, files,
// apps, slash commands). These controls stay in their real place so the client reads as Slack, and each opens a short
// panel saying it is outside this Tool's scope. Nothing here calls an operation or invents workspace data.
import { el, openMenu } from "./ui.js";

const PANELS = {
  activity: ["Activity", "Mentions, reactions and thread replies", "There is no activity or notification feed in this Tool. Unread conversations are shown in bold in the sidebar."],
  later: ["Later", "Saved messages and reminders", "Saved items and reminders are not part of this Tool."],
  threads: ["Threads", "A feed of threads you follow", "Open a thread from its channel with “N replies”; a cross-channel followed-threads feed is not modelled."],
  huddles: ["Huddles", "Audio and video huddles", "Calls and huddles are not part of this Tool."],
  huddle: ["Start huddle", "Audio and video huddles", "Calls and huddles are not part of this Tool."],
  "huddle-options": ["Huddle options", "Copy huddle link, start with video", "Calls and huddles are not part of this Tool."],
  drafts: ["Drafts & sent", "Unsent drafts, scheduled and sent messages", "Drafts and scheduled messages are not stored by this Tool; composer text stays in this tab only."],
  apps: ["Add apps", "Install and manage apps", "App installation is not part of this Tool. Bot users seeded in the world are listed under Apps."],
  files: ["Files", "Files shared in this conversation", "files.* methods are not part of this Tool, so no files exist in this world."],
  "add-tab": ["Add a tab", "Canvas, list, workflow or bookmark", "canvases.*, lists and bookmarks.* are not part of this Tool."],
  video: ["Record video clip", "Clips", "Recording and uploading clips is not part of this Tool."],
  audio: ["Record audio clip", "Clips", "Recording and uploading clips is not part of this Tool."],
  shortcuts: ["Shortcuts", "Slash commands and workflows", "Slash commands and workflow shortcuts are not part of this Tool."],
  schedule: ["Schedule for later", "Scheduled messages", "chat.scheduleMessage is not part of this Tool. Send posts immediately."],
  forward: ["Forward message", "Share to another conversation", "Message sharing is not part of this Tool. Use “Copy link to message” from the More menu."],
  save: ["Save for later", "Saved items", "Saved items and reminders are not part of this Tool."],
};

/** Open the "not simulated" panel next to `anchor`. */
export function notSimulated(anchor, key) {
  const [title, subtitle, text] = (Object.hasOwn(PANELS, key) ? PANELS[key] : undefined) ?? [anchor.getAttribute("aria-label") ?? "Not available", "", "This feature is not part of this Tool."];
  const panel = el("div", { class: "ns-panel", attrs: { role: "dialog", "aria-label": `${title} is not simulated` } }, [
    el("div", { class: "ns-title", text: title }),
    subtitle ? el("div", { class: "ns-subtitle", text: subtitle }) : undefined,
    el("p", { class: "ns-text", text }),
    el("div", { class: "ns-tag", text: "Not simulated by this Tool" }),
  ]);
  const rect = anchor.getBoundingClientRect();
  const above = rect.top > window.innerHeight * 0.6;
  const align = rect.left > window.innerWidth * 0.6 ? "end" : "start";
  openMenu(anchor, panel, { align, above, className: "ns-menu" });
}

document.addEventListener("click", (event) => {
  const control = event.target instanceof Element ? event.target.closest("[data-ns]") : null;
  if (!control || control.disabled) return;
  event.preventDefault();
  event.stopPropagation();
  notSimulated(control, control.dataset.ns);
}, true);

// Slack-style tooltips: a dark bubble with an arrow instead of the native title box. The title moves to data-tip on
// first hover or focus so the browser's own tooltip never appears; the accessible name stays on aria-label.
const tip = el("div", { class: "fd-tooltip", attrs: { role: "tooltip", id: "fd-tooltip" } });
tip.hidden = true;
document.body.append(tip);
let tipTarget;
function tipSource(node) {
  const target = node instanceof Element ? node.closest("[title], [data-tip]") : null;
  if (!target || target.closest(".menu, dialog:not([open])")) return undefined;
  if (target.hasAttribute("title")) {
    const text = target.getAttribute("title");
    target.removeAttribute("title");
    if (text) target.dataset.tip = text;
  }
  return target.dataset.tip ? target : undefined;
}
function showTip(target) {
  const visible = target.getBoundingClientRect();
  const hit = document.elementFromPoint(visible.left + visible.width / 2, visible.top + visible.height / 2);
  if (visible.width === 0 || !hit || !(target === hit || target.contains(hit))) return hideTip(); // hidden or covered
  tipTarget = target;
  tip.textContent = target.dataset.tip;
  tip.hidden = false;
  const rect = target.getBoundingClientRect();
  const box = tip.getBoundingClientRect();
  const below = rect.top < box.height + 16;
  tip.classList.toggle("below", below);
  const left = Math.max(8, Math.min(window.innerWidth - box.width - 8, rect.left + rect.width / 2 - box.width / 2));
  tip.style.left = `${left}px`;
  tip.style.top = `${below ? rect.bottom + 8 : rect.top - box.height - 8}px`;
  tip.style.setProperty("--arrow-x", `${rect.left + rect.width / 2 - left}px`);
}
function hideTip() {
  tipTarget = undefined;
  tip.hidden = true;
}
document.addEventListener("pointerover", (event) => {
  if (event.pointerType && event.pointerType !== "mouse") return; // touch and pen show no hover tooltip, as in Slack
  const target = tipSource(event.target);
  if (target && target !== tipTarget) showTip(target);
  else if (!target) hideTip();
});
document.addEventListener("focusin", (event) => {
  const target = tipSource(event.target);
  if (target && target.matches(":focus-visible")) showTip(target);
});
for (const type of ["pointerdown", "focusout", "scroll", "keydown"]) document.addEventListener(type, hideTip, true);
window.addEventListener("resize", hideTip);
window.addEventListener("hashchange", hideTip);
