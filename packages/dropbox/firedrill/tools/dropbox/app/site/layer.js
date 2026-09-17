// Modals, dropdown menus, confirmations and the "not simulated" panel, Dropbox style.
import { $, el, button, iconButton } from "./ui.js";

let lastFocus = null;

/** Open a modal. Returns { root, body, footer, close }. */
export function modal(title, { wide = false, onClose } = {}) {
  closeMenus();
  const layer = $("#layer");
  lastFocus = document.activeElement;
  const backdrop = el("div", { class: "db-backdrop" });
  const titleId = `m-${Math.random().toString(36).slice(2)}`;
  const box = el("div", { class: `db-modal${wide ? " wide" : ""}`, attrs: { role: "dialog", "aria-modal": "true", "aria-labelledby": titleId } });
  const head = el("div", { class: "db-modal-head" }, [el("h2", { text: title, attrs: { id: titleId } })]);
  const body = el("div", { class: "db-modal-body" });
  const footer = el("div", { class: "db-modal-foot" });
  const close = () => {
    openModals.delete(close);
    backdrop.remove();
    document.removeEventListener("keydown", onKey, true);
    onClose?.();
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  };
  head.append(iconButton("close", "Close", { onClick: close }));
  box.append(head, body, footer);
  backdrop.append(box);
  backdrop.addEventListener("mousedown", (event) => {
    if (event.target === backdrop) close();
  });
  const onKey = (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
    }
  };
  document.addEventListener("keydown", onKey, true);
  openModals.add(close);
  layer.append(backdrop);
  queueMicrotask(() => (box.querySelector("input, textarea, select, .db-btn-primary") ?? box.querySelector("button"))?.focus());
  return { root: box, body, footer, close };
}

export const isModalOpen = () => Boolean($("#layer .db-backdrop"));

const openModals = new Set();
/** Close every open dialog (used when the user navigates to another view). */
export function closeAllModals() {
  for (const close of [...openModals]) close();
}

/** Confirmation dialog. Resolves true when confirmed. */
export function confirmDialog(title, message, confirmLabel, { danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal(title, { onClose: () => !done && resolve(false) });
    m.body.append(el("p", { class: "db-modal-text", text: message }));
    m.footer.append(
      button("Cancel", { onClick: () => m.close() }),
      button(confirmLabel, {
        kind: danger ? "danger" : "primary",
        onClick: () => {
          done = true;
          m.close();
          resolve(true);
        },
      }),
    );
  });
}

/** A labelled text field. Returns { wrap, input }. */
export function field(label, { id, value = "", type = "text", placeholder = "", multiline = false } = {}) {
  const input = multiline ? el("textarea", { attrs: { id, rows: 10, placeholder } }) : el("input", { attrs: { id, type, placeholder, autocomplete: "off" } });
  input.value = value;
  const wrap = el("div", { class: "db-field" }, [el("label", { text: label, attrs: { for: id } }), input]);
  return { wrap, input };
}

export function inlineError(host) {
  const node = el("p", { class: "db-inline-error", attrs: { role: "alert" } });
  node.hidden = true;
  host.append(node);
  return {
    show(text) {
      node.textContent = text;
      node.hidden = false;
    },
    clear() {
      node.hidden = true;
    },
  };
}

/** Out-of-scope chrome opens this short panel instead of inventing data. */
export function notSimulated(feature) {
  const m = modal(feature);
  m.body.append(
    el("p", { class: "db-modal-text", text: `${feature} is not simulated by this Tool.` }),
    el("p", { class: "db-modal-sub", text: "This synthetic Dropbox covers files, folders, uploads, version history, search, deleted files and shared links. Nothing here reaches a real account." }),
  );
  m.footer.append(button("Close", { kind: "primary", onClick: () => m.close() }));
}

// ---------------------------------------------------------------------------------------------------------------
// Dropdown menus
// ---------------------------------------------------------------------------------------------------------------

export function closeMenus() {
  for (const menu of document.querySelectorAll(".db-menu")) {
    menu._anchor?.setAttribute("aria-expanded", "false");
    menu.remove();
  }
}

/** items: [{ label, icon, onClick, disabled, danger, hint }] or "sep". */
export function openMenu(anchor, items, { align = "left", header } = {}) {
  const wasOpen = anchor.getAttribute("aria-expanded") === "true";
  closeMenus();
  if (wasOpen) return;
  const menu = el("div", { class: "db-menu", attrs: { role: "menu" } });
  menu._anchor = anchor;
  if (header) menu.append(header);
  for (const item of items) {
    if (item === "sep") {
      menu.append(el("div", { class: "db-menu-sep", attrs: { role: "separator" } }));
      continue;
    }
    const row = el("button", { class: `db-menu-item${item.danger ? " danger" : ""}`, attrs: { type: "button", role: "menuitem", disabled: item.disabled, title: item.hint } });
    if (item.icon) row.append(iconFor(item.icon));
    row.append(el("span", { text: item.label }));
    row.addEventListener("click", () => {
      closeMenus();
      item.onClick?.();
    });
    menu.append(row);
  }
  document.body.append(menu);
  const rect = anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  let left = align === "right" ? rect.right - width : rect.left;
  left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
  let top = rect.bottom + 4;
  if (top + menu.offsetHeight > window.innerHeight - 8) top = Math.max(8, rect.top - menu.offsetHeight - 4);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  anchor.setAttribute("aria-expanded", "true");
  menu.querySelector(".db-menu-item:not([disabled])")?.focus();
  menu.addEventListener("keydown", (event) => {
    const rows = [...menu.querySelectorAll(".db-menu-item:not([disabled])")];
    const index = rows.indexOf(document.activeElement);
    if (event.key === "ArrowDown") rows[(index + 1) % rows.length]?.focus();
    else if (event.key === "ArrowUp") rows[(index - 1 + rows.length) % rows.length]?.focus();
    else if (event.key === "Escape") {
      closeMenus();
      anchor.focus();
    } else return;
    event.preventDefault();
  });
}

import { icon as iconFor } from "./icons.js";

document.addEventListener("mousedown", (event) => {
  if (!event.target.closest?.(".db-menu") && !event.target.closest?.("[aria-expanded='true']")) closeMenus();
});
