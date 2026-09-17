// Full-screen transaction frame shared by the invoice and receive-payment forms (header, grey canvas, dark footer).
import { app } from "../store.js";
import { el, icon, notSimulated } from "../ui.js";

export function txnFrame(title, { onClose }) {
  const previous = document.activeElement;
  const titleNode = el("span", { text: title });
  const canvas = el("div", { class: "txn-body" });
  const foot = el("div", { class: "txn-foot" });
  const close = () => { frame.remove(); document.removeEventListener("keydown", onKey); app.dirty = false; previous?.focus?.(); };
  const requestClose = () => onClose(close);
  const onKey = (e) => { if (e.key === "Escape" && !document.querySelector(".scrim, .menu-pop")) requestClose(); };
  const head = el("div", { class: "txn-head" }, [
    el("h1", {}, [el("img", { src: "./assets/quickbooks.svg", alt: "" }), titleNode]),
    el("button", { type: "button", class: "icon-btn", "aria-label": "Recent transactions", title: "Recent transactions", onclick: () => notSimulated("Recent transactions") }, icon("history")),
    el("button", { type: "button", class: "icon-btn", "aria-label": "Form settings", title: "Settings", onclick: () => notSimulated("Form settings") }, icon("gear")),
    el("button", { type: "button", class: "icon-btn", "aria-label": "Help", title: "Help", onclick: () => notSimulated("Help") }, icon("help")),
    el("button", { type: "button", class: "icon-btn", "aria-label": "Close", title: "Close", onclick: requestClose }, icon("close")),
  ]);
  const frame = el("div", { class: "txn", role: "dialog", "aria-modal": "true", "aria-label": title }, [head, canvas, foot]);
  document.getElementById("overlay-root").append(frame);
  document.addEventListener("keydown", onKey);
  app.dirty = true;
  return { frame, canvas, foot, close, requestClose, setTitle: (t) => { titleNode.textContent = t; frame.setAttribute("aria-label", t); } };
}
