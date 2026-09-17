// Xero Tool app: header wiring, router, top menus, Create menu and search. Every screen calls this Tool's own
// operations through /_firedrill/client.js; records are re-read after writes and when the world revision moves.
import { hydrateIcons } from "./icons.js";
import { app, go, loadOrg, parseRoute } from "./store.js";
import { $, el, errorBanner } from "./ui.js";
import { closeMenu, notSimulated, openMenu, watchWorld } from "./overlay.js";
import { initSearch } from "./search.js";
import "./views/home.js";
import "./views/invoices.js";
import "./views/invoice-view.js";
import "./views/invoice-editor.js";
import "./views/contacts.js";
import "./views/contact-detail.js";
import "./views/accounts.js";
import "./views/settings.js";
import { openContactForm } from "./views/contact-form.js";

const SECTION = { home: "home", invoices: "sales", bills: "purchases", contacts: "contacts", accounts: "accounting", bank: "accounting", settings: "" };
const MENUS = {
  sales: [{ label: "Sales overview" }, { label: "Invoices", run: () => go("#/invoices") }, { label: "Online payments" }, { label: "Quotes" }, { label: "Products and services" }, { label: "Customers", run: () => go("#/contacts?group=customers") }, { divider: true }, { label: "Sales settings" }],
  purchases: [{ label: "Purchases overview" }, { label: "Bills to pay", run: () => go("#/bills") }, { label: "Purchase orders" }, { label: "Expense claims" }, { label: "Products and services" }, { label: "Suppliers", run: () => go("#/contacts?group=suppliers") }],
  reporting: [{ label: "All reports" }, { label: "Aged receivables summary" }, { label: "Aged payables summary" }, { label: "Balance sheet" }, { label: "Profit and loss" }, { label: "Short-term cash flow" }],
  payroll: [{ label: "Payroll overview" }, { label: "Pay employees" }, { label: "Employees" }, { label: "Timesheets" }, { label: "Leave" }],
  accounting: [{ label: "Bank accounts", run: () => go("#/bank") }, { label: "Bank rules" }, { divider: true }, { label: "Chart of accounts", run: () => go("#/accounts") }, { label: "Fixed assets" }, { label: "Manual journals" }, { label: "Find and recode" }, { divider: true }, { label: "Advanced settings", run: () => go("#/settings") }],
  tax: [{ label: "GST returns" }, { label: "Tax rates" }],
  contacts: [{ label: "All contacts", run: () => go("#/contacts") }, { label: "Customers", run: () => go("#/contacts?group=customers") }, { label: "Suppliers", run: () => go("#/contacts?group=suppliers") }, { label: "Archived", run: () => go("#/contacts?group=archived") }, { divider: true }, { label: "Smart lists" }, { label: "Contact groups" }],
  projects: [{ label: "All projects" }, { label: "Staff time overview" }, { label: "Projects settings" }],
};
const CREATE = [
  { label: "Invoice", run: () => go("#/invoices/new") }, { label: "Bill", run: () => go("#/bills/new") }, { label: "Contact", run: () => openContactForm() },
  { label: "Quote" }, { label: "Purchase order" }, { label: "Manual journal" }, { label: "Spend money" }, { label: "Receive money" }, { label: "Transfer money" },
];

let token = 0;
async function render() {
  const route = parseRoute();
  const host = $("#page");
  let name = route.page;
  if ((name === "invoices" || name === "bills") && route.id) name = route.id === "new" || route.sub === "edit" ? "editor" : "document";
  if (name === "contacts" && route.id) name = "contact";
  const page = app.pages[name];
  const mine = (token += 1);
  app.dirty = false;
  markNav(SECTION[route.page] ?? "");
  closeMenu();
  $("#xsearch").hidden = true;
  $("#overlay-root").replaceChildren();
  $("#xhdr").classList.remove("nav-open");
  window.scrollTo(0, 0);
  if (!page) {
    host.replaceChildren(el("div", { class: "page-inner" }, errorBanner(new Error(`There is no page at ${location.hash}.`), "Page not found")));
    return;
  }
  try {
    await page(host, route);
  } catch (error) {
    if (mine === token) host.replaceChildren(el("div", { class: "page-inner" }, errorBanner(error, "We couldn't load this page")));
  }
}
export function rerender() { return render(); }

function markNav(section) {
  for (const item of document.querySelectorAll("#xnav .xnav-item")) {
    const key = item.getAttribute("data-nav") ?? item.getAttribute("data-menu");
    item.classList.toggle("active", key === section);
  }
}

async function boot() {
  hydrateIcons();
  for (const b of document.querySelectorAll("#xnav [data-menu]")) {
    b.addEventListener("click", (e) => { e.stopPropagation(); openMenu(b, MENUS[b.getAttribute("data-menu")]); });
  }
  $("#create-btn").addEventListener("click", (e) => { e.stopPropagation(); openMenu(e.currentTarget, [{ heading: "Create new" }, ...CREATE], { align: "right" }); });
  $("#org-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    openMenu(e.currentTarget, [{ heading: app.org?.Name ?? "Organisation" }, { label: "Settings", run: () => go("#/settings") }, { label: "Files" }, { label: "Subscription and billing" }, { divider: true }, { label: "My Xero" }]);
  });
  $("#avatar-btn").addEventListener("click", (e) => { e.stopPropagation(); openMenu(e.currentTarget, [{ heading: "Firedrill test user" }, { label: "Profile" }, { label: "Account" }, { label: "Log out", disabled: true, hint: "There is no login in a Firedrill world" }], { align: "right" }); });
  $("#menu-toggle").addEventListener("click", () => { const h = $("#xhdr"); h.classList.toggle("nav-open"); $("#menu-toggle").setAttribute("aria-expanded", String(h.classList.contains("nav-open"))); });
  for (const b of document.querySelectorAll("[data-not-simulated]")) b.addEventListener("click", () => notSimulated(b.getAttribute("data-not-simulated")));
  initSearch();
  await loadOrg();
  $("#org-name").textContent = app.org?.Name ?? "Xero";
  if (app.org) document.title = `${app.org.Name} | Xero (synthetic)`;
  if (!location.hash) location.replace("#/home");
  window.addEventListener("hashchange", render);
  await render();
  watchWorld(async () => { await loadOrg(); await render(); }, () => !app.dirty && !document.querySelector(".scrim"));
}
boot();
