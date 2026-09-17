// Toasts, modals, confirmation dialogs and the loading / empty / error / denied blocks.
import { $, clear, describeError, el } from "./ui.js";
import { icon } from "./icons.js";

export function toast(message, kind = "success") {
  const host = $("#toasts");
  const node = el(`div.dd-toast.dd-toast--${kind}`, { role: kind === "error" ? "alert" : "status" }, icon(kind === "error" ? "incidents" : "check"), el("span", { text: message }));
  host.append(node);
  setTimeout(() => node.remove(), 5000);
}

let lastFocus = null;
export function closeModal() {
  const root = $("#modal-root");
  clear(root);
  root.hidden = true;
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
}

let modalSeq = 0;
/** Open a modal; body is a node; footer buttons are nodes. Returns the dialog element. */
export function openModal({ title, body, footer = [], width = 560, side = false }) {
  const root = $("#modal-root");
  lastFocus = document.activeElement;
  clear(root);
  const titleId = `modal-title-${++modalSeq}`;
  const dialog = el(`div.dd-modal${side ? ".dd-modal--side" : ""}`, { role: "dialog", "aria-modal": "true", "aria-labelledby": titleId },
    el("div.dd-modal__header", {}, el("h2", { id: titleId, text: title }),
      el("button.dd-btn.dd-btn--ghost.dd-btn--icon", { type: "button", "aria-label": "Close", on: { click: closeModal } }, icon("close"))),
    el("div.dd-modal__body", {}, body),
    footer.length ? el("div.dd-modal__footer", {}, footer) : null);
  if (!side) dialog.style.width = `min(${width}px, calc(100vw - 32px))`;
  const backdrop = el(`div.dd-backdrop${side ? ".dd-backdrop--side" : ""}`, { on: { mousedown: (e) => { if (e.target === backdrop) closeModal(); } } }, dialog);
  root.append(backdrop);
  root.hidden = false;
  backdrop.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });
  const focusable = dialog.querySelector("input, select, textarea, button:not([aria-label='Close'])") ?? dialog.querySelector("button");
  focusable?.focus();
  return dialog;
}

/** Confirmation modal; resolves true/false. */
export function confirmDialog({ title, message, confirmLabel = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; closeModal(); resolve(v); } };
    openModal({
      title,
      width: 460,
      body: el("p.dd-modal__text", { text: message }),
      footer: [
        el("button.dd-btn", { type: "button", on: { click: () => done(false) } }, "Cancel"),
        el(`button.dd-btn.${danger ? "dd-btn--danger" : "dd-btn--primary"}`, { type: "button", on: { click: () => done(true) } }, confirmLabel),
      ],
    });
    const observer = new MutationObserver(() => { if ($("#modal-root").hidden) { observer.disconnect(); done(false); } });
    observer.observe($("#modal-root"), { attributes: true });
  });
}

export const loadingBlock = (label = "Loading…") => el("div.dd-state.dd-state--loading", { role: "status" }, el("span.dd-spinner", { "aria-hidden": "true" }), el("span", { text: label }));
export const emptyBlock = (title, text, action) => el("div.dd-state.dd-state--empty", {}, el("div.dd-state__art", { "aria-hidden": "true" }, icon("search", { size: 28 })), el("h3", { text: title }), text ? el("p", { text }) : null, action ?? null);
export function errorBlock(error, retry) {
  const denied = error?.denied;
  return el(`div.dd-state.dd-state--${denied ? "denied" : "error"}`, { role: "alert" },
    el("div.dd-state__art", { "aria-hidden": "true" }, icon(denied ? "lock" : "incidents", { size: 28 })),
    el("h3", { text: denied ? "Access denied" : "Something went wrong" }),
    el("p", { text: describeError(error) }),
    retry ? el("button.dd-btn", { type: "button", on: { click: retry } }, "Try again") : null);
}
export const banner = (kind, text) => el(`div.dd-banner.dd-banner--${kind}`, { role: kind === "error" ? "alert" : "note" }, icon(kind === "error" ? "incidents" : "info"), el("span", { text }));
