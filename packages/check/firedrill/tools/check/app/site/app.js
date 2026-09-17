// Check Console app shell: sidebar, company switcher, hash routing and world-revision refresh.
// Every screen reads and writes through the Tool's own operations; nothing here holds authoritative data.
import { hydrateIcons, icon } from "./icons.js";
import { $, access, call, describe, el, getContext, openModal, toast, watchWorld } from "./ui.js";
import { initials, stamp } from "./fmt.js";
import { refreshCompanies, selectedCompany, state } from "./store.js";
import { renderHome } from "./view-home.js";
import { renderCompanies } from "./view-companies.js";
import { renderEmployees } from "./view-employees.js";
import { renderEmployee } from "./view-employee.js";
import { renderPayrolls } from "./view-payrolls.js";
import { renderPayroll } from "./view-payroll.js";
import { renderWorkplaces } from "./view-workplaces.js";
import { renderSchedules } from "./view-schedules.js";

let renderToken = 0;

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [path, query = ""] = raw.split("?");
  const [page = "", id] = path.split("/").filter(Boolean);
  return { page: page || "home", id: id ? decodeSafe(id) : undefined, params: Object.fromEntries(new URLSearchParams(query)) };
}
function decodeSafe(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}
export function go(page, id, params = {}) {
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== "" && v !== null)).toString();
  const hash = `#/${page === "home" ? "" : page}${id ? `/${encodeURIComponent(id)}` : ""}${query ? `?${query}` : ""}`;
  if (location.hash === hash) void render(); else location.hash = hash;
}
export function setParams(page, id, params) {
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== "" && v !== null)).toString();
  history.replaceState(null, "", `#/${page}${id ? `/${encodeURIComponent(id)}` : ""}${query ? `?${query}` : ""}`);
}
export function setTitle(title, crumbs = []) {
  $("#page-title").textContent = title;
  document.title = `${title} | Check Console (synthetic)`;
  const host = $("#crumbs");
  host.replaceChildren();
  for (const crumb of crumbs) {
    host.append(typeof crumb === "string"
      ? el("span", { text: crumb })
      : el("a", { text: crumb.label, attrs: { href: crumb.href } }));
    host.append(el("span", { text: "/" }));
  }
}

const VIEWS = {
  home: renderHome,
  companies: renderCompanies,
  employees: renderEmployees,
  payrolls: renderPayrolls,
  workplaces: renderWorkplaces,
  schedules: renderSchedules,
};

/** Set when the first read answered authentication_error: the key cannot be used at all. */
let keyRejected;

export async function render() {
  const route = parseRoute();
  const host = $("#page");
  const token = (renderToken += 1);
  state.editing = 0;
  if (keyRejected) {
    setTitle("API key not valid");
    host.replaceChildren(el("div", { class: "card" }, el("div", { class: "state" }, [
      el("h3", { text: "This API key is not valid" }),
      el("p", { text: keyRejected }),
      el("p", { text: "Check answers authentication_error to every request from this key, so no company, employee or payroll can be read. Use a key whose company scope and access level are well formed." }),
    ])));
    return;
  }
  let view;
  if (route.page === "employees" && route.id) view = renderEmployee;
  else if (route.page === "payrolls" && route.id) view = renderPayroll;
  else if (Object.hasOwn(VIEWS, route.page)) view = VIEWS[route.page];
  for (const item of document.querySelectorAll(".nav-item[data-route]")) item.classList.toggle("active", item.dataset.route === route.page);
  closeSide();
  if (!view) {
    setTitle("Not found");
    host.replaceChildren(el("div", { class: "card" }, el("div", { class: "state" }, [
      el("h3", { text: "Page not found" }),
      el("p", { text: "That address is not part of this Console." }),
      el("a", { class: "btn btn-secondary", text: "Back to Home", attrs: { href: "#/" } }),
    ])));
    return;
  }
  await view(host, route, { isCurrent: () => token === renderToken });
}

export function notSimulated(name) {
  openModal({
    title: name,
    subtitle: "Not simulated by this Tool",
    body: [
      el("p", { text: `${name} is part of the Check Console, but this Firedrill Tool does not simulate it.` }),
      el("p", { text: "The simulated surface covers companies, workplaces, employees, earning rates, pay schedules, payrolls and payroll items. Nothing is shown here, so no data is invented." }),
    ],
  });
}

function closeSide() {
  if (window.matchMedia("(max-width: 860px)").matches) {
    $("#shell").classList.remove("open");
    $("#menu-toggle").setAttribute("aria-expanded", "false");
  }
}

export function paintCompany() {
  const company = selectedCompany();
  const name = company ? (company.trade_name || company.legal_name) : "No company";
  $("#switcher-name").textContent = name;
  $("#switcher-avatar").textContent = initials(name);
  $("#switcher-meta").textContent = company
    ? `${company.address?.city ?? ""}${company.address?.state ? `, ${company.address.state}` : ""}`.replace(/^, /, "") || company.id
    : "nothing in scope";
  $("#clock").textContent = state.now ? stamp(state.now) : "";
  $("#clock").hidden = !state.now;
}

function openSwitcher(anchor) {
  document.querySelector(".menu")?.remove();
  const rect = anchor.getBoundingClientRect();
  const menu = el("div", { class: "menu", attrs: { role: "listbox", "aria-label": "Companies" } }, [
    el("div", { class: "menu-note", text: `${state.companies.length} active ${state.companies.length === 1 ? "company" : "companies"} reachable with this API key` }),
    ...state.companies.map((company) => el("button", {
      class: "menu-item",
      attrs: { type: "button", role: "option", "aria-current": String(company.id === state.company) },
      on: { click: () => { menu.remove(); anchor.setAttribute("aria-expanded", "false"); state.company = company.id; paintCompany(); void render(); } },
    }, [
      el("span", { class: "avatar", text: initials(company.trade_name || company.legal_name) }),
      el("span", {}, [
        el("span", { text: company.trade_name || company.legal_name }),
        el("span", { class: "sub", text: company.legal_name }),
      ]),
    ])),
    el("button", { class: "menu-item", attrs: { type: "button" }, on: { click: () => { menu.remove(); anchor.setAttribute("aria-expanded", "false"); go("companies"); } } }, [icon("building"), el("span", { text: "View all companies" })]),
  ]);
  menu.style.top = `${rect.bottom + window.scrollY + 6}px`;
  menu.style.left = `${rect.left}px`;
  menu.style.minWidth = `${rect.width}px`;
  document.body.append(menu);
  anchor.setAttribute("aria-expanded", "true");
  dismissOn(menu, anchor);
}

function accountMenu(anchor) {
  document.querySelector(".menu")?.remove();
  const rect = anchor.getBoundingClientRect();
  const menu = el("div", { class: "menu", attrs: { role: "menu" } }, [
    el("div", { class: "menu-note", text: `Signed in as synthetic actor ${state.actorId}. Sandbox environment: no money moves and no filings are made.` }),
    el("button", { class: "menu-item", text: "Profile", attrs: { type: "button", role: "menuitem" }, on: { click: () => { menu.remove(); notSimulated("Profile"); } } }),
    el("button", { class: "menu-item", text: "API keys", attrs: { type: "button", role: "menuitem" }, on: { click: () => { menu.remove(); notSimulated("API keys"); } } }),
    el("button", { class: "menu-item", text: "Sign out", attrs: { type: "button", role: "menuitem" }, on: { click: () => { menu.remove(); notSimulated("Sign out"); } } }),
  ]);
  menu.style.top = `${rect.bottom + window.scrollY + 6}px`;
  menu.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
  document.body.append(menu);
  anchor.setAttribute("aria-expanded", "true");
  dismissOn(menu, anchor);
}

function dismissOn(menu, anchor) {
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

/** Keep the world clock fresh; `companies.list` carries the Tool's virtual `server_time`. */
export async function refreshClock() {
  try {
    const page = await call("companies.list", { limit: 1, active: true });
    if (typeof page.server_time === "string") state.now = page.server_time;
  } catch { /* the screen already reports its own error */ }
  paintCompany();
}

/** Once a write has answered permission_denied, keep a read-only marker in the top bar. */
function paintReadOnly() {
  if (!access.readOnly || document.getElementById("read-only-pill")) return;
  const pill = el("span", { class: "env-pill read-only", text: "Read-only key", attrs: { id: "read-only-pill", title: "This API key may read but not write. Check answers permission_denied to every change." } });
  $("#env-pill").after(pill);
}

async function boot() {
  hydrateIcons();
  $("#menu-toggle").addEventListener("click", () => {
    const open = $("#shell").classList.toggle("open");
    $("#menu-toggle").setAttribute("aria-expanded", String(open));
  });
  for (const node of document.querySelectorAll("[data-not-simulated]")) node.addEventListener("click", () => notSimulated(node.dataset.notSimulated));
  window.addEventListener("check:read-only", () => paintReadOnly());
  $("#switcher").addEventListener("click", (event) => openSwitcher(event.currentTarget));
  $("#avatar").addEventListener("click", (event) => accountMenu(event.currentTarget));
  try {
    const context = await getContext();
    state.actorId = context.actorId ?? "actor";
  } catch (error) {
    toast(describe(error), { error: true, timeout: 0 });
  }
  $("#avatar").textContent = state.actorId.slice(0, 1).toUpperCase();
  try {
    await refreshCompanies();
  } catch (error) {
    if (error?.is?.("AUTHENTICATION_ERROR")) keyRejected = error.message;
    toast(describe(error), { error: true, timeout: 0 });
  }
  paintCompany();
  window.addEventListener("hashchange", () => void render());
  await render();
  watchWorld(async () => {
    try { await refreshCompanies(); } catch { /* reported by the screen */ }
    paintCompany();
    await render();
  }, () => state.editing === 0 && !document.querySelector(".overlay"));
}

void boot();
