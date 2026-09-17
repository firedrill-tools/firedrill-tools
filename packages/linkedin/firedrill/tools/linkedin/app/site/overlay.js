// Modals, confirmation dialogs, dropdown menus and the "not simulated" panel.
import { $, el, iconButton } from "./ui.js";
import { icon } from "./icons.js";

let openModalState = null;

/** Open a modal dialog. Returns { body, footer, close }. */
export function openModal({ title, className = "", onClose, labelledBy } = {}) {
  closeModal();
  const titleId = `modal-title-${Math.random().toString(36).slice(2)}`;
  const heading = el("h2", { class: "modal__title", text: title, attrs: { id: titleId } });
  const closeButton = iconButton("close", "Dismiss", () => closeModal());
  const body = el("div", { class: "modal__body" });
  const footer = el("div", { class: "modal__footer" });
  const dialog = el("div", { class: `modal ${className}`.trim(), attrs: { role: "dialog", "aria-modal": "true", "aria-labelledby": labelledBy ?? titleId } }, [
    el("div", { class: "modal__header" }, [heading, closeButton]), body, footer,
  ]);
  const scrim = el("div", { class: "modal-scrim", on: { mousedown: (event) => { if (event.target === scrim) closeModal(); } } }, dialog);
  const previous = document.activeElement;
  const onKey = (event) => { if (event.key === "Escape") { event.preventDefault(); closeModal(); } };
  document.addEventListener("keydown", onKey);
  $("#overlay-root").append(scrim);
  openModalState = { scrim, onKey, previous, onClose };
  queueMicrotask(() => (dialog.querySelector("textarea, input, [data-autofocus]") ?? closeButton).focus());
  return { dialog, body, footer, heading, close: closeModal };
}

export function closeModal() {
  if (!openModalState) return;
  const { scrim, onKey, previous, onClose } = openModalState;
  openModalState = null;
  document.removeEventListener("keydown", onKey);
  scrim.remove();
  if (onClose) onClose();
  if (previous && typeof previous.focus === "function" && document.contains(previous)) previous.focus();
}
export const modalOpen = () => openModalState !== null;

/** LinkedIn-style confirmation: resolves true when the primary button is chosen. */
export function confirmDialog({ title, message, confirmLabel, cancelLabel = "Cancel", danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    const modal = openModal({ title, className: "modal--confirm", onClose: () => { if (!answered) resolve(false); } });
    modal.body.append(el("p", { class: "confirm__text", text: message }));
    const cancel = el("button", { class: "btn btn--muted", text: cancelLabel, attrs: { type: "button" }, on: { click: () => closeModal() } });
    const ok = el("button", { class: `btn ${danger ? "btn--primary" : "btn--primary"}`, text: confirmLabel, attrs: { type: "button", "data-autofocus": true }, on: { click: () => { answered = true; closeModal(); resolve(true); } } });
    modal.footer.append(cancel, ok);
  });
}

/** Explain that a visible control belongs to a part of the product this Tool does not simulate. */
export function notSimulated(feature) {
  const modal = openModal({ title: feature, className: "modal--confirm" });
  modal.body.append(
    el("div", { class: "not-sim" }, [
      el("span", { class: "not-sim__icon" }, icon("info")),
      el("div", {}, [
        el("p", { class: "t-bold", text: "Not simulated by this Tool" }),
        el("p", { class: "muted", text: `${feature} is part of the real product but is outside this Firedrill Tool's scope. Nothing was changed and no data is shown for it.` }),
      ]),
    ]),
  );
  modal.footer.append(el("button", { class: "btn btn--primary", text: "Got it", attrs: { type: "button", "data-autofocus": true }, on: { click: () => closeModal() } }));
}

let openMenu = null;
export function closeMenu() {
  if (!openMenu) return;
  openMenu.menu.remove();
  openMenu.trigger.setAttribute("aria-expanded", "false");
  document.removeEventListener("mousedown", openMenu.outside, true);
  document.removeEventListener("keydown", openMenu.onKey, true);
  openMenu = null;
}

/** Dropdown menu anchored under a trigger. items: [{icon, label, sub, onSelect, disabled}] */
export function showMenu(trigger, items, { align = "right" } = {}) {
  const wasOpen = openMenu?.trigger === trigger;
  closeMenu();
  if (wasOpen) return;
  const menu = el("div", { class: `dropdown dropdown--${align}`, attrs: { role: "menu" } });
  for (const item of items) {
    const button = el("button", { class: "dropdown__item", attrs: { type: "button", role: "menuitem", disabled: item.disabled ? true : undefined }, on: { click: () => { closeMenu(); item.onSelect?.(); } } }, [
      item.icon ? icon(item.icon) : null,
      el("span", { class: "dropdown__text" }, [el("span", { class: "dropdown__label", text: item.label }), item.sub ? el("span", { class: "dropdown__sub", text: item.sub }) : null]),
    ]);
    menu.append(button);
  }
  trigger.parentElement.style.position = trigger.parentElement.style.position || "relative";
  trigger.after(menu);
  trigger.setAttribute("aria-expanded", "true");
  const outside = (event) => { if (!menu.contains(event.target) && event.target !== trigger && !trigger.contains(event.target)) closeMenu(); };
  const onKey = (event) => { if (event.key === "Escape") { closeMenu(); trigger.focus(); } };
  document.addEventListener("mousedown", outside, true);
  document.addEventListener("keydown", onKey, true);
  openMenu = { menu, trigger, outside, onKey };
  menu.querySelector("button:not([disabled])")?.focus();
}

/** Delegate every [data-not-simulated] control in the document to the panel. */
export function wireNotSimulated() {
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("[data-not-simulated]") : null;
    if (!target) return;
    event.preventDefault();
    notSimulated(target.getAttribute("data-not-simulated"));
  });
}
