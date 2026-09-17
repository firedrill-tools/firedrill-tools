// Dialogs, dropdown menus, dates, avatars and status chips for the Documenso Tool app.
import { icon } from "./icons.js";
import { $, button, el, tooltip } from "./ui.js";

// ---------------------------------------------------------------------------------------------
// Dialog (centred card on a dimmed backdrop, Escape and backdrop click close it)
// ---------------------------------------------------------------------------------------------

let openDialog;
export function closeDialog() {
  if (!openDialog) return;
  const { backdrop, restore } = openDialog;
  backdrop.remove();
  openDialog = undefined;
  if (restore?.isConnected) restore.focus();
}

/** Opens a dialog; returns { body, footer, close, setError }. */
export function dialog({ title, description, wide = false }) {
  closeDialog();
  closeMenu();
  const titleId = `dlg-${Math.random().toString(36).slice(2)}`;
  const body = el("div", { class: "dialog-body" });
  const footer = el("div", { class: "dialog-footer" });
  const error = el("div", { class: "alert alert-destructive", attrs: { role: "alert" } });
  error.hidden = true;
  const closeBtn = el("button", { class: "dialog-x", attrs: { type: "button", "aria-label": "Close" } }, icon("x"));
  const card = el("div", { class: `dialog ${wide ? "dialog-wide" : ""}`, attrs: { role: "dialog", "aria-modal": "true", "aria-labelledby": titleId } }, [
    el("div", { class: "dialog-header" }, [el("h2", { class: "dialog-title", text: title, attrs: { id: titleId } }), description ? el("p", { class: "dialog-desc", text: description }) : null]),
    error, body, footer, closeBtn,
  ]);
  const backdrop = el("div", { class: "dialog-backdrop" }, card);
  backdrop.addEventListener("mousedown", (event) => { if (event.target === backdrop) closeDialog(); });
  closeBtn.addEventListener("click", closeDialog);
  openDialog = { backdrop, restore: document.activeElement };
  document.body.append(backdrop);
  queueMicrotask(() => (card.querySelector("input, textarea, select") ?? closeBtn).focus());
  return {
    body, footer, card, close: closeDialog,
    setError(message) { error.textContent = message ?? ""; error.hidden = !message; },
  };
}

/** Confirmation dialog; resolves true when confirmed. */
export function confirm({ title, description, confirmLabel = "Confirm", destructive = false }) {
  return new Promise((resolve) => {
    const d = dialog({ title, description });
    const cancel = button("Cancel", { variant: "secondary", onClick: () => { d.close(); resolve(false); } });
    const ok = button(confirmLabel, { variant: destructive ? "destructive" : "default", onClick: () => { d.close(); resolve(true); } });
    d.footer.append(cancel, ok);
    queueMicrotask(() => cancel.focus());
  });
}

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (openMenuNode) closeMenu();
  else if (openDialog) closeDialog();
});

// ---------------------------------------------------------------------------------------------
// Dropdown menu
// ---------------------------------------------------------------------------------------------

let openMenuNode;
export function closeMenu() {
  if (!openMenuNode) return;
  openMenuNode.anchor.setAttribute("aria-expanded", "false");
  openMenuNode.remove();
  openMenuNode = undefined;
}

/** items: [{ label, iconName, onClick, disabled, destructive, hint }] | { separator } | { heading }. */
export function menu(anchor, items, { align = "end", width = 200 } = {}) {
  if (openMenuNode?.anchor === anchor) return closeMenu();
  closeMenu();
  const node = el("div", { class: "menu", attrs: { role: "menu" } });
  node.style.minWidth = `${width}px`;
  for (const item of items) {
    if (item.separator) { node.append(el("div", { class: "menu-sep", attrs: { role: "separator" } })); continue; }
    if (item.heading) { node.append(el("div", { class: "menu-heading", text: item.heading })); continue; }
    const entry = el("button", { class: `menu-item ${item.destructive ? "is-destructive" : ""} ${item.active ? "is-active" : ""}`, attrs: { type: "button", role: "menuitem", disabled: item.disabled, title: item.hint } }, [
      item.iconName ? icon(item.iconName) : null, el("span", { class: "menu-label", text: item.label }), item.trailing ? el("span", { class: "menu-trailing", text: item.trailing }) : null,
    ]);
    entry.addEventListener("click", () => { closeMenu(); item.onClick?.(); });
    node.append(entry);
  }
  node.anchor = anchor;
  document.body.append(node);
  const r = anchor.getBoundingClientRect();
  const w = node.getBoundingClientRect().width;
  node.style.top = `${r.bottom + window.scrollY + 4}px`;
  node.style.left = `${Math.max(8, align === "end" ? r.right - w : r.left)}px`;
  anchor.setAttribute("aria-expanded", "true");
  openMenuNode = node;
  node.querySelector(".menu-item:not([disabled])")?.focus();
}

document.addEventListener("mousedown", (event) => {
  if (openMenuNode && !openMenuNode.contains(event.target) && !openMenuNode.anchor.contains(event.target)) closeMenu();
});

/** A control outside the Tool's scope: opens a short explanation instead of inventing data. */
export function notSimulated(feature, detail) {
  const d = dialog({ title: `${feature} is not simulated`, description: detail ?? "This part of the web app is outside what this Firedrill Tool simulates. Nothing was changed." });
  d.footer.append(button("Close", { variant: "secondary", onClick: d.close }));
}

// ---------------------------------------------------------------------------------------------
// Dates: always formatted in UTC from world time, never the browser clock
// ---------------------------------------------------------------------------------------------

const SHORT = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "numeric", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
const MED = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
export const shortDate = (iso) => (iso ? SHORT.format(new Date(iso)) : "");
export const mediumDate = (iso) => (iso ? MED.format(new Date(iso)) : "");

/** "3 days ago" relative to the world's `now`. */
export function relative(iso, nowIso) {
  if (!iso || !nowIso) return "";
  const seconds = Math.round((Date.parse(nowIso) - Date.parse(iso)) / 1000);
  const steps = [[60, "second"], [3600, "minute"], [86400, "hour"], [2592000, "day"], [31536000, "month"], [Infinity, "year"]];
  let unit = "second";
  let size = 1;
  for (const [limit, name] of steps) { unit = name; if (Math.abs(seconds) < limit) break; size = limit; }
  const value = Math.max(1, Math.floor(Math.abs(seconds) / size));
  return seconds < 45 ? "just now" : `${value} ${unit}${value === 1 ? "" : "s"} ago`;
}

// ---------------------------------------------------------------------------------------------
// Recipients: abbreviation, avatar colour by signing state, stacked avatars with tooltip
// ---------------------------------------------------------------------------------------------

export function initials(nameOrEmail) {
  const text = (nameOrEmail ?? "").trim();
  if (!text) return "?";
  const words = text.includes("@") ? [text] : text.split(/\s+/);
  return (words.length > 1 ? words[0][0] + words[words.length - 1][0] : text.slice(0, 2)).toUpperCase();
}

export function recipientType(r, documentStatus) {
  if (r.signingStatus === "REJECTED") return "rejected";
  if (documentStatus === "COMPLETED" || r.signingStatus === "SIGNED") return "completed";
  if (r.readStatus === "OPENED") return "opened";
  if (documentStatus === "PENDING" && r.sendStatus === "SENT") return "waiting";
  return "unsigned";
}

export const avatar = (text, type = "unsigned", size = "") => el("span", { class: `avatar avatar-${type} ${size}`.trim(), text: initials(text), attrs: { "aria-hidden": "true" } });

const GROUPS = [["completed", "Completed"], ["rejected", "Rejected"], ["waiting", "Waiting"], ["opened", "Opened"], ["unsigned", "Uncompleted"]];

export function stackAvatars(recipients, documentStatus, { label } = {}) {
  const holder = el("button", { class: "stack", attrs: { type: "button", "aria-label": `${recipients.length} recipient${recipients.length === 1 ? "" : "s"}` } });
  const shown = recipients.slice(0, 2);
  for (const r of shown) holder.append(avatar(r.name || r.email, recipientType(r, documentStatus)));
  if (recipients.length > 2) holder.append(el("span", { class: "avatar avatar-more", text: `+${recipients.length - 2}` }));
  if (label) holder.append(el("span", { class: "stack-label", text: label }));
  if (recipients.length === 0) return el("span", { class: "muted", text: "" });
  tooltip(holder, () => GROUPS.map(([type, title]) => {
    const list = recipients.filter((r) => recipientType(r, documentStatus) === type);
    if (list.length === 0) return null;
    return el("div", { class: "tip-group" }, [el("div", { class: "tip-title", text: title }), ...list.map((r) =>
      el("div", { class: "tip-row" }, [avatar(r.name || r.email, type, "avatar-sm"), el("div", {}, [el("div", { class: "tip-email", text: r.email }), r.name ? el("div", { class: "tip-name", text: r.name }) : null])]))]);
  }).filter(Boolean), { side: "bottom" });
  return holder;
}

export const STATUS = {
  DRAFT: { label: "Draft", ext: "Document draft", icon: "file", tone: "yellow" },
  PENDING: { label: "Pending", ext: "Document pending", icon: "clock", tone: "blue" },
  COMPLETED: { label: "Completed", ext: "Document completed", icon: "checkCircle", tone: "green" },
  REJECTED: { label: "Rejected", ext: "Document rejected", icon: "xCircle", tone: "red" },
  CANCELLED: { label: "Cancelled", ext: "Document cancelled", icon: "xCircle", tone: "red" },
  INBOX: { label: "Inbox", ext: "Document inbox", icon: "signature", tone: "muted" },
};

export function statusChip(status, { inherit = false } = {}) {
  const s = STATUS[status] ?? { label: status, icon: "file", tone: "muted" };
  return el("span", { class: `status ${inherit ? "" : `tone-${s.tone}`}` }, [icon(s.icon, "status-ic"), el("span", { text: s.label })]);
}

export const byId = (id) => $(`#${id}`);
