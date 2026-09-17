// Dialogs, confirmations, dropdown menus, the "not simulated" panel and world-revision refresh.
import { getContext } from "/_firedrill/client.js";
import { $, el, icon, isPending } from "./ui.js";

let dialogSeq = 0;
export function dialog({ title, body, actions = [], wide = false, onClose }) {
  const root = $("#overlay-root");
  const previous = document.activeElement;
  const close = () => { wrap.remove(); document.removeEventListener("keydown", onKey); onClose?.(); previous?.focus?.(); };
  const onKey = (event) => { if (event.key === "Escape") close(); };
  const titleId = `dlg-${(dialogSeq += 1)}`;
  const box = el("div", { class: `dialog${wide ? " wide" : ""}`, role: "dialog", "aria-modal": "true", "aria-labelledby": titleId }, [
    el("div", { class: "dialog-head" }, [
      el("h2", { id: titleId, text: title }),
      el("button", { type: "button", class: "icon-btn", "aria-label": "Close", onclick: close }, icon("close", 16)),
    ]),
    el("div", { class: "dialog-body" }, body),
    actions.length
      ? el("div", { class: "dialog-foot" }, actions.map((a) =>
          el("button", { type: "button", class: `btn ${a.kind ?? ""}`, text: a.label, onclick: () => a.run(close) })))
      : null,
  ]);
  const wrap = el("div", { class: "scrim", onclick: (event) => { if (event.target === wrap) close(); } }, box);
  root.append(wrap);
  document.addEventListener("keydown", onKey);
  (box.querySelector("input, select, textarea") ?? box.querySelector(".dialog-foot .btn") ?? box.querySelector("button"))?.focus();
  return { close, box };
}

export function confirmDialog(title, message, confirmLabel, kind = "primary") {
  return new Promise((resolve) => {
    let answered = false;
    dialog({
      title,
      body: el("p", { text: message }),
      onClose: () => { if (!answered) resolve(false); },
      actions: [
        { label: "Cancel", run: (close) => { answered = true; resolve(false); close(); } },
        { label: confirmLabel, kind, run: (close) => { answered = true; resolve(true); close(); } },
      ],
    });
  });
}

const SCOPE = "This Tool simulates customers, sales orders, invoices, customer payments, items, subsidiaries and SuiteQL queries.";
export function notSimulated(feature) {
  dialog({
    title: feature,
    body: [
      el("p", { text: `${feature} is part of NetSuite but is not simulated by this Firedrill Tool.` }),
      el("p", { class: "muted", text: SCOPE }),
    ],
    actions: [{ label: "OK", kind: "primary", run: (close) => close() }],
  });
}

let closeCurrent;
export function closeMenu() { closeCurrent?.(); closeCurrent = undefined; }
/** items: [{ label, run?, disabled?, hint?, heading?, divider? }] — entries without run open the not-simulated panel. */
export function openMenu(anchor, items, { align = "left" } = {}) {
  const reopening = anchor.classList.contains("open");
  closeMenu();
  if (reopening) return null;
  const pop = el("div", { class: "menu-pop", role: "menu" });
  for (const item of items) {
    if (item.heading) { pop.append(el("div", { class: "menu-head", text: item.heading })); continue; }
    if (item.divider) { pop.append(el("div", { class: "menu-divider", role: "separator" })); continue; }
    const button = el("button", {
      type: "button",
      class: `mi${item.run ? "" : " mi-ns"}`,
      role: "menuitem",
      disabled: item.disabled,
      title: item.run ? item.hint : "Not simulated by this Tool",
    }, [el("span", { text: item.label }), item.hint ? el("span", { class: "mi-hint", text: item.hint }) : null]);
    button.addEventListener("click", () => { closeMenu(); if (item.run) item.run(); else notSimulated(item.label); });
    pop.append(button);
  }
  document.body.append(pop);
  const rect = anchor.getBoundingClientRect();
  pop.style.top = `${Math.max(4, Math.min(rect.bottom + 2, window.innerHeight - pop.offsetHeight - 8))}px`;
  const left = align === "right" ? rect.right - pop.offsetWidth : rect.left;
  pop.style.left = `${Math.max(8, Math.min(left, window.innerWidth - pop.offsetWidth - 8))}px`;
  anchor.setAttribute("aria-expanded", "true");
  anchor.classList.add("open");
  const away = (event) => { if (!pop.contains(event.target) && !anchor.contains(event.target)) closeMenu(); };
  const key = (event) => {
    if (event.key === "Escape") { closeMenu(); anchor.focus(); return; }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const all = [...pop.querySelectorAll(".mi:not(:disabled)")];
    const index = all.indexOf(document.activeElement);
    all[(index + (event.key === "ArrowDown" ? 1 : all.length - 1)) % all.length]?.focus();
    event.preventDefault();
  };
  setTimeout(() => document.addEventListener("click", away), 0);
  document.addEventListener("keydown", key);
  closeCurrent = () => {
    pop.remove();
    anchor.setAttribute("aria-expanded", "false");
    anchor.classList.remove("open");
    document.removeEventListener("click", away);
    document.removeEventListener("keydown", key);
  };
  pop.querySelector(".mi:not(:disabled)")?.focus();
  return pop;
}

/** Poll getContext().revision; refresh when the world moved and the page has no unsaved input or open dialog. */
export function watchWorld(refresh, mayRefresh = () => true) {
  let revision;
  const check = async () => {
    if (isPending() || document.visibilityState !== "visible") return;
    try {
      const context = await getContext();
      const stamp = JSON.stringify(context.revision);
      if (revision === undefined) { revision = stamp; return; }
      if (stamp !== revision && mayRefresh()) { revision = stamp; await refresh(); }
    } catch { /* the environment closed; leave the page as it is */ }
  };
  setInterval(check, 2500);
  return check;
}
