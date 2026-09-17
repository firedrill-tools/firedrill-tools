// DOM, Firedrill-client, formatting and dialog helpers for the Discord Tool app.
// Record text only ever reaches the page through textContent; nothing is injected as HTML.
import { getContext, invoke } from "/_firedrill/client.js";
import { icon } from "./icons.js";

export const $ = (selector, root = document) => root.querySelector(selector);

/** Create an element. options: { class, text, title, attrs, on: { event: handler } }. */
export function el(tag, options = {}, children = []) {
  const element = document.createElement(tag);
  if (options.class) element.className = options.class;
  if (options.text !== undefined && options.text !== null) element.textContent = String(options.text);
  if (options.title) element.title = options.title;
  if (options.attrs) {
    for (const [name, value] of Object.entries(options.attrs)) {
      if (value !== undefined && value !== null && value !== false) element.setAttribute(name, value === true ? "" : String(value));
    }
  }
  if (options.on) for (const [event, handler] of Object.entries(options.on)) element.addEventListener(event, handler);
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child !== undefined && child !== null && child !== false) element.append(child);
  }
  return element;
}

export function iconButton(name, label, onClick, options = {}) {
  return el(
    "button",
    { class: `icon-btn ${options.class ?? ""}`.trim(), attrs: { type: "button", "aria-label": label, "data-tooltip": label, ...(options.attrs ?? {}) }, on: onClick ? { click: onClick } : {} },
    icon(name, options.size ?? 24),
  );
}

// ---------------------------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------------------------

export class ToolError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = String(code ?? status);
  }
  get denied() {
    return this.status === "denied";
  }
  is(code) {
    return this.code === code || this.code.endsWith(`.${code}`);
  }
}

let pending = 0;
export const isPending = () => pending > 0;

/** Invoke one operation; throws ToolError for any non-ok outcome. Mutations pass `mutation: true` to get an idempotency key. */
export async function call(operationId, args = {}, { mutation = false, idempotencyKey } = {}) {
  pending += 1;
  try {
    const key = idempotencyKey ?? (mutation ? crypto.randomUUID() : undefined);
    const result = await invoke(operationId, args, key ? { idempotencyKey: key } : {});
    const outcome = result.outcome ?? {};
    if (outcome.status !== "ok") {
      const error = outcome.error ?? {};
      throw new ToolError(outcome.status, error.code ?? outcome.status, error.message ?? `The request was ${outcome.status}.`);
    }
    return outcome.value;
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError("error", "NETWORK", error?.message ?? "The local environment is unavailable.");
  } finally {
    pending -= 1;
  }
}

/** Discord nonce: at most 25 characters; a random 19-digit decimal string like the client's own snowflake-shaped nonces. */
export function nonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return (value % 9000000000000000000n + 1000000000000000000n).toString();
}

/** Poll the world revision; call refresh when it moves (skipped while a write is in flight). */
export function watchWorld(refresh, mayRefresh = () => true) {
  let revision;
  let checking = false;
  const check = async () => {
    if (checking || pending > 0 || document.visibilityState !== "visible") return;
    checking = true;
    try {
      const context = await getContext();
      const stamp = JSON.stringify(context.revision ?? null);
      if (revision === undefined) revision = stamp;
      else if (stamp !== revision && mayRefresh()) {
        revision = stamp;
        await refresh();
      }
    } catch {
      // A transient failure is retried on the next tick.
    } finally {
      checking = false;
    }
  };
  const timer = setInterval(() => void check(), 2000);
  window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
  void check();
}

// ---------------------------------------------------------------------------------------------
// Time (always UTC, relative to the world's virtual clock)
// ---------------------------------------------------------------------------------------------

const EPOCH = 1420070400000n;

export function snowflakeMs(id) {
  try {
    return Number((BigInt(id) >> 22n) + EPOCH);
  } catch {
    return 0;
  }
}

export function compareIds(left, right) {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function parseTime(value) {
  const ms = Date.parse(typeof value === "string" ? value.replace(/(\.\d{3})\d+/, "$1") : "");
  return Number.isFinite(ms) ? ms : 0;
}

function parts(ms) {
  const date = new Date(ms);
  return { y: date.getUTCFullYear(), mo: date.getUTCMonth(), d: date.getUTCDate(), h: date.getUTCHours(), mi: date.getUTCMinutes(), wd: date.getUTCDay() };
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SHORT_MONTHS = MONTHS.map((month) => month.slice(0, 3));
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function clock(ms) {
  const { h, mi } = parts(ms);
  return `${((h + 11) % 12) + 1}:${String(mi).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

function dayNumber(ms) {
  return Math.floor(ms / 86400000);
}

/** "Today at 4:02 PM" / "Yesterday at 4:02 PM" / "9/12/26, 4:02 PM" like the desktop client. */
export function messageStamp(ms, nowMs) {
  const diff = dayNumber(nowMs) - dayNumber(ms);
  if (diff === 0) return `Today at ${clock(ms)}`;
  if (diff === 1) return `Yesterday at ${clock(ms)}`;
  const { y, mo, d } = parts(ms);
  return `${mo + 1}/${d}/${String(y).slice(2)}, ${clock(ms)}`;
}

/** Tooltip form: "Monday, September 14, 2026 at 4:02 PM UTC". */
export function fullStamp(ms) {
  const { y, mo, d, wd } = parts(ms);
  return `${DAYS[wd]}, ${MONTHS[mo]} ${d}, ${y} at ${clock(ms)} UTC`;
}

export function dividerDate(ms) {
  const { y, mo, d } = parts(ms);
  return `${MONTHS[mo]} ${d}, ${y}`;
}

export function shortDate(ms) {
  const { y, mo, d } = parts(ms);
  return `${SHORT_MONTHS[mo]} ${d}, ${y}`;
}

export function sameDay(a, b) {
  return dayNumber(a) === dayNumber(b);
}

// ---------------------------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------------------------

export const displayName = (user) => user?.global_name || user?.username || "Unknown User";

export const AVATAR_COLOURS = ["#5865f2", "#757e8a", "#3ba55c", "#faa61a", "#ed4245", "#eb459f"];

/** Default-avatar slot. The client uses (id >> 22) % 6; seeded ids share their timestamp bits, so the low id bits are used. */
export function avatarIndex(id) {
  try {
    return Number(BigInt(id ?? "0") % 6n);
  } catch {
    return 0;
  }
}

/** Default avatar: the Discord mark on one of the six default colours, chosen from the user id as the client does. */
export function avatar(user, size = 40) {
  const wrap = el("span", { class: "avatar" });
  wrap.style.width = `${size}px`;
  wrap.style.height = `${size}px`;
  wrap.style.background = AVATAR_COLOURS[avatarIndex(user?.id)];
  const mark = el("img", { class: "avatar-mark", attrs: { src: "./assets/discord.svg", alt: "" } });
  wrap.append(mark);
  return wrap;
}

export function roleColour(value) {
  return typeof value === "number" && value > 0 ? `#${value.toString(16).padStart(6, "0")}` : "";
}

// ---------------------------------------------------------------------------------------------
// Toasts, dialogs and popouts
// ---------------------------------------------------------------------------------------------

export function toast(message, { error = false } = {}) {
  const host = $("#toasts");
  if (!host) return;
  const node = el("div", { class: `toast ${error ? "toast-error" : ""}`, attrs: { role: error ? "alert" : "status" } }, [
    icon(error ? "warning" : "emoji", 20),
    el("span", { text: message }),
  ]);
  host.append(node);
  setTimeout(() => node.remove(), 5000);
}

let openLayer;

export function closeLayer() {
  if (openLayer) {
    const { node, onClose, restoreFocus } = openLayer;
    openLayer = undefined;
    node.remove();
    onClose?.();
    restoreFocus?.focus?.();
  }
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && openLayer) {
    event.preventDefault();
    closeLayer();
  }
});
document.addEventListener("mousedown", (event) => {
  if (openLayer && openLayer.kind === "popout" && !openLayer.node.contains(event.target) && !openLayer.anchor?.contains(event.target)) closeLayer();
});

/** Centered modal in Discord's style. `build(body, close)` fills the body; returns the close function. */
export function modal({ title, subtitle, className = "", build, footer, onClose }) {
  closeLayer();
  const backdrop = el("div", { class: "modal-backdrop" });
  const dialog = el("div", { class: `modal ${className}`, attrs: { role: "dialog", "aria-modal": "true", "aria-label": title } });
  const header = el("div", { class: "modal-header" }, [el("h2", { class: "modal-title", text: title }), subtitle ? el("p", { class: "modal-subtitle", text: subtitle }) : null]);
  const close = () => closeLayer();
  header.append(iconButton("close", "Close", close, { class: "modal-close" }));
  const body = el("div", { class: "modal-body" });
  dialog.append(header, body);
  if (footer) dialog.append(el("div", { class: "modal-footer" }, footer(close)));
  backdrop.append(dialog);
  backdrop.addEventListener("mousedown", (event) => {
    if (event.target === backdrop) close();
  });
  build?.(body, close, dialog);
  document.body.append(backdrop);
  openLayer = { node: backdrop, onClose, kind: "modal", restoreFocus: document.activeElement };
  (dialog.querySelector("[autofocus]") ?? dialog.querySelector("input, textarea, select, button.btn"))?.focus();
  return close;
}

/** Confirmation modal; resolves true when confirmed. */
export function confirmModal({ title, text, confirm = "Delete", danger = true, preview }) {
  return new Promise((resolve) => {
    let answered = false;
    modal({
      title,
      className: "modal-confirm",
      onClose: () => {
        if (!answered) resolve(false);
      },
      build: (body) => {
        body.append(el("p", { class: "modal-text", text }));
        if (preview) body.append(preview);
      },
      footer: (close) => [
        el("button", { class: "btn btn-link", text: "Cancel", attrs: { type: "button" }, on: { click: close } }),
        el("button", {
          class: `btn ${danger ? "btn-danger" : "btn-primary"}`,
          text: confirm,
          attrs: { type: "button", autofocus: true },
          on: {
            click: () => {
              answered = true;
              resolve(true);
              closeLayer();
            },
          },
        }),
      ],
    });
  });
}

/** Floating popout anchored to an element. */
export function popout(anchor, content, { placement = "bottom-start", className = "", onClose, toggle = false } = {}) {
  if (toggle && openLayer?.kind === "popout" && openLayer.anchor === anchor) {
    closeLayer();
    return undefined;
  }
  closeLayer();
  const node = el("div", { class: `popout ${className}`, attrs: { role: "dialog" } }, content);
  document.body.append(node);
  const rect = anchor.getBoundingClientRect();
  const box = node.getBoundingClientRect();
  let top = placement.startsWith("bottom") ? rect.bottom + 8 : placement.startsWith("left") || placement.startsWith("right") ? rect.top : rect.top - box.height - 8;
  let left = placement.endsWith("end") ? rect.right - box.width : rect.left;
  if (placement.startsWith("left")) left = rect.left - box.width - 12;
  if (placement.startsWith("right")) left = rect.right + 12;
  top = Math.max(8, Math.min(top, window.innerHeight - box.height - 8));
  left = Math.max(8, Math.min(left, window.innerWidth - box.width - 8));
  node.style.top = `${top}px`;
  node.style.left = `${left}px`;
  openLayer = { node, anchor, onClose, kind: "popout", restoreFocus: anchor };
  node.querySelector("input, button")?.focus();
  return node;
}

/** The element the open popout is anchored to, if any. */
export const layerAnchor = () => openLayer?.anchor;

/** Full-window layer (User Settings). `build(node, close)` fills it; Escape closes it like any other layer. */
export function overlay({ label, className = "", build, onClose }) {
  closeLayer();
  hideTip();
  const restoreFocus = document.activeElement;
  const node = el("div", { class: `overlay ${className}`.trim(), attrs: { role: "dialog", "aria-modal": "true", "aria-label": label } });
  build(node, () => closeLayer());
  document.body.append(node);
  openLayer = { node, onClose, kind: "overlay", restoreFocus };
  (node.querySelector("[autofocus]") ?? node.querySelector("button"))?.focus();
  return node;
}

/**
 * Context menu (Discord's dark floating menu). items: { label, icon?, radio?: boolean, danger?, disabled?, onSelect },
 * { note } for a short muted line, or "separator".
 */
export function menu(anchor, items, placement = "bottom-end", options = {}) {
  const list = el("div", { class: "menu", attrs: { role: "menu" } });
  for (const item of items) {
    if (item === "separator") {
      list.append(el("div", { class: "menu-sep", attrs: { role: "separator" } }));
      continue;
    }
    if (item.note) {
      list.append(el("div", { class: "menu-note", text: item.note }));
      continue;
    }
    const radio = typeof item.radio === "boolean";
    const trailing = radio ? el("span", { class: `menu-radio ${item.radio ? "checked" : ""}`, attrs: { "aria-hidden": "true" } }) : item.icon ? icon(item.icon, 18) : null;
    const button = el(
      "button",
      {
        class: `menu-item ${item.danger ? "menu-danger" : ""}`,
        attrs: { type: "button", role: radio ? "menuitemradio" : "menuitem", "aria-checked": radio ? String(item.radio) : undefined, disabled: item.disabled },
        on: {
          click: () => {
            closeLayer();
            item.onSelect?.();
          },
        },
      },
      [el("span", { text: item.label }), trailing],
    );
    list.append(button);
  }
  return popout(anchor, list, { placement, className: "popout-menu", toggle: options.toggle === true });
}

// ---------------------------------------------------------------------------------------------
// Tooltips (Discord's black bubble), driven by data-tooltip attributes
// ---------------------------------------------------------------------------------------------

let tip;
function showTip(target) {
  const text = target.getAttribute("data-tooltip");
  if (!text) return;
  hideTip();
  const placement = target.getAttribute("data-tooltip-side") ?? "top";
  tip = el("div", { class: `tooltip tooltip-${placement}`, text, attrs: { role: "tooltip" } });
  document.body.append(tip);
  const rect = target.getBoundingClientRect();
  const box = tip.getBoundingClientRect();
  let top = rect.top - box.height - 8;
  let left = rect.left + rect.width / 2 - box.width / 2;
  if (placement === "right") {
    top = rect.top + rect.height / 2 - box.height / 2;
    left = rect.right + 12;
  } else if (placement === "bottom") {
    top = rect.bottom + 8;
  }
  tip.style.top = `${Math.max(4, top)}px`;
  tip.style.left = `${Math.max(4, Math.min(left, window.innerWidth - box.width - 4))}px`;
}
function hideTip() {
  tip?.remove();
  tip = undefined;
}
document.addEventListener("mouseover", (event) => {
  const target = event.target instanceof Element ? event.target.closest("[data-tooltip]") : null;
  if (target) showTip(target);
  else hideTip();
});
document.addEventListener("focusin", (event) => {
  const target = event.target instanceof Element ? event.target.closest("[data-tooltip]") : null;
  if (target && target.matches(":focus-visible")) showTip(target);
});
document.addEventListener("focusout", hideTip);
document.addEventListener("mousedown", hideTip);

// ---------------------------------------------------------------------------------------------
// Emoji
// ---------------------------------------------------------------------------------------------

export const QUICK_EMOJI = ["👍", "❤️", "😂", "🎉"];
export const PICKER_EMOJI = [
  ["Frequently Used", ["👍", "❤️", "😂", "🎉", "🔥", "👀", "✅", "🙏"]],
  ["People", ["😀", "😃", "😄", "😁", "😆", "😅", "🤣", "😊", "😇", "🙂", "😉", "😍", "🥰", "😘", "😎", "🤔", "😐", "😬", "😴", "😭", "😡", "🤯", "🥳", "👋", "👏", "🙌", "💪", "🤝"]],
  ["Objects", ["💡", "🔧", "🔩", "⚙️", "🔌", "🔋", "💻", "🖥️", "📦", "📌", "📎", "📝", "📷", "🧪", "🛠️", "⏰"]],
  ["Symbols", ["✔️", "❌", "⚠️", "❓", "❗", "💯", "⭐", "✨", "💬", "➕", "➖", "🔁"]],
];

export function emojiText(emoji) {
  return emoji?.id ? `:${emoji.name}:` : emoji?.name ?? "";
}

/** Path form the API expects: unicode as-is, custom as name:id. */
export function emojiArg(emoji) {
  return emoji?.id ? `${emoji.name}:${emoji.id}` : emoji?.name ?? "";
}

export function emojiNode(emoji, className = "emoji") {
  if (emoji?.id) return el("span", { class: `${className} emoji-custom`, text: `:${emoji.name}:`, attrs: { "aria-label": `:${emoji.name}:` } });
  return el("span", { class: className, text: emoji?.name ?? "" });
}
