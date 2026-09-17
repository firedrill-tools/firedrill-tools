// Dialogs, confirmations, dropdown menus, the "not simulated" panel and world-revision refresh.
import { getContext } from "/_firedrill/client.js";
import { $, el, icon, isPending } from "./ui.js";

let dialogSeq = 0;
export function dialog({ title, body, actions = [], wide = false, onClose }) {
  const root = $("#overlay-root");
  const previous = document.activeElement;
  const close = () => { wrap.remove(); document.removeEventListener("keydown", onKey); onClose?.(); previous?.focus?.(); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  const titleId = `dlg-${(dialogSeq += 1)}`;
  const box = el("div", { class: `dialog${wide ? " wide" : ""}`, role: "dialog", "aria-modal": "true", "aria-labelledby": titleId }, [
    el("div", { class: "dialog-head" }, [el("h2", { id: titleId, text: title }), el("button", { type: "button", class: "icon-btn", "aria-label": "Close", onclick: close }, icon("close"))]),
    el("div", { class: "dialog-body" }, body),
    actions.length ? el("div", { class: "dialog-foot" }, actions.map((a) => el("button", { type: "button", class: `btn ${a.kind ?? ""}`, text: a.label, onclick: () => a.run(close) }))) : null,
  ]);
  const wrap = el("div", { class: "scrim", onclick: (e) => { if (e.target === wrap) close(); } }, box);
  root.append(wrap);
  document.addEventListener("keydown", onKey);
  (box.querySelector("input, select, textarea") ?? box.querySelector(".dialog-foot .btn") ?? box.querySelector("button"))?.focus();
  return { close, box };
}
export function confirmDialog(title, message, confirmLabel, kind = "main") {
  return new Promise((resolve) => {
    let answered = false;
    dialog({
      title, body: el("p", { text: message }),
      onClose: () => { if (!answered) resolve(false); },
      actions: [
        { label: "Cancel", kind: "standard", run: (close) => { answered = true; resolve(false); close(); } },
        { label: confirmLabel, kind, run: (close) => { answered = true; resolve(true); close(); } },
      ],
    });
  });
}
export function notSimulated(feature) {
  dialog({
    title: feature,
    body: [el("p", { text: `${feature} is part of Xero but is not simulated by this Firedrill Tool.` }),
      el("p", { class: "muted", text: "This Tool models the organisation, chart of accounts, tax rates, contacts, sales invoices, bills and payments." })],
    actions: [{ label: "OK", kind: "main", run: (close) => close() }],
  });
}

let closeCurrent;
export function closeMenu() { closeCurrent?.(); closeCurrent = undefined; }
/** items: [{ label, run?, disabled?, hint?, heading? }] — entries without run open the not-simulated panel. */
export function openMenu(anchor, items, { align = "left", className = "" } = {}) {
  closeMenu();
  const pop = el("div", { class: `menu-pop ${className}`, role: "menu" });
  for (const it of items) {
    if (it.heading) { pop.append(el("div", { class: "menu-head", text: it.heading })); continue; }
    if (it.divider) { pop.append(el("div", { class: "menu-divider", role: "separator" })); continue; }
    const btn = el("button", { type: "button", class: `mi${it.run ? "" : " mi-ns"}`, role: "menuitem", disabled: it.disabled, title: it.run ? it.hint : "Not simulated by this Tool" },
      [el("span", { text: it.label }), it.shortcut ? el("span", { class: "mi-hint", text: it.shortcut }) : null]);
    btn.addEventListener("click", () => { closeMenu(); if (it.run) it.run(); else notSimulated(it.label); });
    pop.append(btn);
  }
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.top = `${Math.min(r.bottom + 4, window.innerHeight - pop.offsetHeight - 8)}px`;
  const left = align === "right" ? r.right - pop.offsetWidth : r.left;
  pop.style.left = `${Math.max(8, Math.min(left, window.innerWidth - pop.offsetWidth - 8))}px`;
  anchor.setAttribute("aria-expanded", "true");
  anchor.classList.add("open");
  const away = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) closeMenu(); };
  const key = (e) => {
    if (e.key === "Escape") { closeMenu(); anchor.focus(); return; }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const all = [...pop.querySelectorAll(".mi:not(:disabled)")];
    const i = all.indexOf(document.activeElement);
    all[(i + (e.key === "ArrowDown" ? 1 : all.length - 1)) % all.length]?.focus();
    e.preventDefault();
  };
  setTimeout(() => document.addEventListener("click", away), 0);
  document.addEventListener("keydown", key);
  closeCurrent = () => { pop.remove(); anchor.setAttribute("aria-expanded", "false"); anchor.classList.remove("open"); document.removeEventListener("click", away); document.removeEventListener("keydown", key); };
  pop.querySelector(".mi:not(:disabled)")?.focus();
  return pop;
}

/** Poll getContext().revision; call refresh when the world changed and the page has no unsaved input. */
export function watchWorld(refresh, mayRefresh = () => true) {
  let revision;
  const check = async () => {
    if (isPending() || document.visibilityState !== "visible") return;
    try {
      const context = await getContext();
      const stamp = JSON.stringify(context.revision);
      if (revision === undefined) { revision = stamp; return; }
      if (stamp !== revision && mayRefresh()) { revision = stamp; await refresh(); }
    } catch { /* environment closed; keep the page as it is */ }
  };
  setInterval(check, 2000);
  return check;
}
