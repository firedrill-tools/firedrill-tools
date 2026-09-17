// NetSuite Tool app: the application shell (bar, global menu bar, account strip), the hash router and boot.
// Every screen calls this Tool's own operations through /_firedrill/client.js.
import { hydrateIcons, icon } from "./icons.js";
import { app, go, loadSession, parseRoute } from "./store.js";
import { $, el, errorBanner } from "./ui.js";
import { closeMenu, notSimulated, openMenu, watchWorld } from "./overlay.js";
import { MENUS, CREATE_NEW } from "./menus.js";
import "./views/home.js";
import "./views/customers.js";
import "./views/customer.js";
import "./views/orders.js";
import "./views/order.js";
import "./views/order-new.js";
import "./views/invoices.js";
import "./views/invoice.js";
import "./views/invoice-new.js";
import "./views/payments.js";
import "./views/items.js";
import "./views/subsidiaries.js";
import "./views/suiteql.js";

const TABS = ["Activities", "Payments", "Transactions", "Lists", "Reports", "Analytics", "Documents", "Setup", "Customization", "Commerce", "Support"];
const TAB_FOR = {
  home: "", customers: "Lists", customer: "Lists", items: "Lists",
  orders: "Transactions", order: "Transactions", invoices: "Transactions", invoice: "Transactions",
  payments: "Payments", suiteql: "Analytics", subsidiaries: "Setup",
};

let token = 0;
async function render() {
  const route = parseRoute();
  let name = route.page;
  if (name === "orders" && route.id) name = route.id === "new" ? "order-new" : "order";
  if (name === "invoices" && route.id) name = route.id === "new" ? "invoice-new" : "invoice";
  if (name === "customers" && route.id) name = "customer";
  const page = app.pages[name];
  const mine = (token += 1);
  app.dirty = false;
  closeMenu();
  $("#overlay-root").replaceChildren();
  $("#appbar").classList.remove("nav-open");
  markTab(TAB_FOR[route.page] ?? "");
  window.scrollTo(0, 0);
  const main = $("#main");
  if (app.sessionError) {
    main.replaceChildren(errorBanner(app.sessionError, "This role cannot open the NetSuite interface"));
    return;
  }
  if (!page) {
    main.replaceChildren(errorBanner(new Error(`There is no page at ${location.hash}.`), "Page not found"));
    return;
  }
  try {
    await page(main, route);
  } catch (error) {
    if (mine === token) main.replaceChildren(errorBanner(error, "This page could not be loaded"));
  }
}
export function rerender() { return render(); }

function markTab(current) {
  for (const tab of document.querySelectorAll("#menubar .tab")) {
    tab.classList.toggle("active", tab.dataset.tab === current);
  }
}

function buildMenubar() {
  const bar = $("#menubar");
  bar.replaceChildren(...TABS.map((name) => {
    const button = el("button", { type: "button", class: "tab", "aria-haspopup": "true", "aria-expanded": "false", text: name });
    button.dataset.tab = name;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      openMenu(button, MENUS[name] ?? [{ label: name }]);
    });
    return button;
  }));
}

function recentMenu() {
  if (app.recent.length === 0) return [{ heading: "Recent Records" }, { label: "No records opened yet", disabled: true }];
  return [{ heading: "Recent Records" }, ...app.recent.map((entry) => ({ label: entry.label, run: () => go(entry.href) }))];
}

function paintIdentity() {
  const session = app.session;
  const user = session?.user;
  const initials = user ? `${user.name.charAt(0)}${user.name.split(" ").pop().charAt(0)}` : "?";
  $("#user-initials").textContent = initials;
  $("#user-name").textContent = user?.name ?? "Not signed in";
  $("#user-role").textContent = session?.role?.name ?? "";
  $("#acct-name").textContent = session?.account?.companyName ?? "NetSuite";
  $("#role-label").textContent = session?.role?.name ?? "Role";
  $("#acct-date").textContent = session ? `Account date ${formatToday(session.accountDate)} · ${session.account.accountId}` : "";
  $("#footer-account").textContent = session
    ? `${session.account.companyName} (${session.account.accountId}) — ${session.role.name}`
    : "NetSuite (synthetic)";
  const scope = session?.subsidiaryScope;
  const chip = $("#acct-chip");
  chip.textContent = scope && scope.id !== "0"
    ? `Firedrill synthetic account · ${scope.refName} only`
    : "Firedrill synthetic account";
}
function formatToday(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date ?? ""));
  return match ? `${Number(match[2])}/${Number(match[3])}/${match[1]}` : "";
}

function wireBar() {
  $("#menu-toggle").append(icon("menu", 20));
  $(".gs-go").append(icon("search", 15));
  $("#recent-btn").prepend(icon("clock", 17));
  $("#create-btn").prepend(icon("plus", 17));
  $("#shortcuts-btn").prepend(icon("star", 17));
  $("#help-btn").prepend(icon("help", 17));

  $("#menu-toggle").addEventListener("click", () => {
    const bar = $("#appbar");
    bar.classList.toggle("nav-open");
    $("#menu-toggle").setAttribute("aria-expanded", String(bar.classList.contains("nav-open")));
  });
  $("#recent-btn").addEventListener("click", (event) => { event.stopPropagation(); openMenu(event.currentTarget, recentMenu(), { align: "right" }); });
  $("#create-btn").addEventListener("click", (event) => { event.stopPropagation(); openMenu(event.currentTarget, CREATE_NEW, { align: "right" }); });
  $("#shortcuts-btn").addEventListener("click", (event) => {
    event.stopPropagation();
    openMenu(event.currentTarget, [
      { heading: "Shortcuts" },
      { label: "Customers", run: () => go("#/customers") },
      { label: "Sales Orders", run: () => go("#/orders") },
      { label: "Invoices", run: () => go("#/invoices") },
      { label: "SuiteQL Query Tool", run: () => go("#/suiteql") },
      { divider: true },
      { label: "Personalize Shortcuts" },
    ], { align: "right" });
  });
  $("#help-btn").addEventListener("click", () => notSimulated("Help Center"));
  $("#user-btn").addEventListener("click", (event) => {
    event.stopPropagation();
    const user = app.session?.user;
    openMenu(event.currentTarget, [
      { heading: user ? `${user.name} — ${user.title}` : "Not signed in" },
      { label: "Set Preferences" },
      { label: "Change Password" },
      { label: "Change Role" },
      { divider: true },
      { label: "Log Out", disabled: true, hint: "No login in a Firedrill world" },
    ], { align: "right" });
  });
  $("#role-btn").addEventListener("click", (event) => {
    event.stopPropagation();
    const role = app.session?.role;
    openMenu(event.currentTarget, [
      { heading: "Role" },
      { label: role ? `${role.name} (current)` : "Role", disabled: true },
      { divider: true },
      { label: "Switch role", hint: "Set by the Firedrill actor" },
    ]);
  });
  $("#global-search").addEventListener("submit", (event) => {
    event.preventDefault();
    const term = $("#global-search-input").value.trim();
    if (term === "") return;
    go(`#/customers?q=${encodeURIComponent(term)}`);
  });
  for (const button of document.querySelectorAll("[data-not-simulated]")) {
    button.addEventListener("click", () => notSimulated(button.getAttribute("data-not-simulated")));
  }
}

async function boot() {
  hydrateIcons();
  wireBar();
  buildMenubar();
  await loadSession();
  paintIdentity();
  if (!location.hash) location.replace("#/home");
  window.addEventListener("hashchange", render);
  await render();
  watchWorld(async () => { await loadSession(); paintIdentity(); await render(); },
    () => !app.dirty && !document.querySelector(".scrim"));
}
boot();
