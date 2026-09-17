// Trolley Tool app shell: rail navigation, top bar, hash routing and world-revision refresh.
// Every screen reads and writes through the Tool's operations; nothing here is authoritative data.
import { hydrateIcons } from "./icons.js";
import { $, call, el, getContext, openModal, toast, watchWorld } from "./ui.js";
import { renderDashboard } from "./view-dashboard.js";
import { renderRecipients } from "./view-recipients.js";
import { renderRecipient } from "./view-recipient.js";
import { renderBatches } from "./view-batches.js";
import { renderBatch } from "./view-batch.js";
import { renderBalances } from "./view-balances.js";

export const app = { now: undefined, editing: 0, token: 0 };

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [path, query = ""] = raw.split("?");
  const [page = "", id] = path.split("/").filter(Boolean);
  return { page: page || "dashboard", id: id ? decodeSafe(id) : undefined, params: Object.fromEntries(new URLSearchParams(query)) };
}
function decodeSafe(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}
export function go(page, id, params = {}) {
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== "" && v !== null)).toString();
  const hash = `#/${page === "dashboard" ? "" : page}${id ? `/${encodeURIComponent(id)}` : ""}${query ? `?${query}` : ""}`;
  if (location.hash === hash) void render(); else location.hash = hash;
}
/** Replace the query without adding history or re-rendering (list filters). */
export function setParams(page, params) {
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== "" && v !== null)).toString();
  history.replaceState(null, "", `#/${page}${query ? `?${query}` : ""}`);
}
export function setTitle(title) {
  $("#page-title").textContent = title;
  document.title = `${title} | Trolley (synthetic)`;
}

const VIEWS = {
  dashboard: [renderDashboard, "dashboard"],
  recipients: [renderRecipients, "recipients"],
  payments: [renderBatches, "payments"],
  balances: [renderBalances, "balances"],
};

export async function refreshNow() {
  try {
    const value = await call("balances.list", {});
    app.now = value.serverTime;
    return value;
  } catch {
    return undefined;
  }
}

async function render() {
  const route = parseRoute();
  const host = $("#page");
  const token = (app.token += 1);
  app.editing = 0;
  let view;
  let nav = route.page;
  if (route.page === "recipients" && route.id) view = renderRecipient;
  else if (route.page === "payments" && route.id) view = renderBatch;
  else if (Object.hasOwn(VIEWS, route.page)) view = VIEWS[route.page][0];
  for (const item of document.querySelectorAll(".rail-item[data-route]")) item.classList.toggle("active", item.dataset.route === nav);
  closeRail();
  if (!view) {
    setTitle("Not found");
    host.replaceChildren(el("div", { class: "card state" }, [el("h3", { text: "Page not found" }), el("a", { text: "Back to Overview", attrs: { href: "#/" } })]));
    return;
  }
  await view(host, route, { isCurrent: () => token === app.token });
}

export function notSimulated(name) {
  openModal({
    title: name,
    body: [
      el("p", { text: `${name} is part of the Trolley dashboard, but it is not simulated by this Firedrill Tool.` }),
      el("p", { text: "This synthetic merchant covers recipients, payout methods, payment batches, payments and balances. No data is shown here so nothing is invented." }),
    ],
  });
}

function closeRail() {
  if (window.matchMedia("(max-width: 760px)").matches) {
    $("#shell").classList.remove("open");
    $("#menu-toggle").setAttribute("aria-expanded", "false");
  }
}

function accountMenu(anchor, actorId) {
  document.querySelector(".menu")?.remove();
  const rect = anchor.getBoundingClientRect();
  const menu = el("div", { class: "menu", attrs: { role: "menu" } }, [
    el("div", { class: "menu-note", text: `Signed in as synthetic actor ${actorId}. Firedrill sandbox merchant: no money moves.` }),
    el("button", { class: "menu-item", text: "Account settings", attrs: { type: "button", role: "menuitem" }, on: { click: () => { menu.remove(); notSimulated("Account settings"); } } }),
    el("button", { class: "menu-item", text: "Switch to live mode", attrs: { type: "button", role: "menuitem" }, on: { click: () => { menu.remove(); notSimulated("Live mode"); } } }),
  ]);
  menu.style.top = `${rect.bottom + window.scrollY + 6}px`;
  menu.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
  document.body.append(menu);
  anchor.setAttribute("aria-expanded", "true");
  const dismiss = (event) => {
    if (event.type === "keydown" && event.key !== "Escape") return;
    if (event.type === "mousedown" && menu.contains(event.target)) return;
    menu.remove();
    anchor.setAttribute("aria-expanded", "false");
    document.removeEventListener("mousedown", dismiss);
    document.removeEventListener("keydown", dismiss);
  };
  setTimeout(() => { document.addEventListener("mousedown", dismiss); document.addEventListener("keydown", dismiss); });
  menu.querySelector("button")?.focus();
}

async function boot() {
  hydrateIcons();
  $("#menu-toggle").addEventListener("click", () => {
    const open = $("#shell").classList.toggle("open");
    $("#menu-toggle").setAttribute("aria-expanded", String(open));
  });
  for (const node of document.querySelectorAll("[data-not-simulated]")) node.addEventListener("click", () => notSimulated(node.dataset.notSimulated));
  let actorId = "actor";
  try {
    const context = await getContext();
    actorId = context.actorId;
  } catch (error) {
    toast(error.message, { error: true, timeout: 0 });
  }
  $("#whoami-name").textContent = actorId;
  $("#avatar").textContent = actorId.slice(0, 1).toUpperCase();
  $("#avatar").addEventListener("click", (event) => accountMenu(event.currentTarget, actorId));
  await refreshNow();
  window.addEventListener("hashchange", () => void render());
  await render();
  watchWorld(async () => { await refreshNow(); await render(); }, () => app.editing === 0 && !document.querySelector(".overlay"));
}

void boot();
