// QuickBooks Online Tool app: shell wiring, router, Create menu and global search. Every screen calls this Tool's
// own operations through /_firedrill/client.js; records are re-read after writes and when the world revision moves.
import { hydrateIcons } from "./icons.js";
import { app, go, loadCompany, parseRoute, query } from "./store.js";
import { $, closeMenu, el, errorBanner, isPending, notSimulated, openMenu, quote, watchWorld } from "./ui.js";
import "./views/home.js";
import "./views/invoices.js";
import "./views/customers.js";
import "./views/customer-detail.js";
import "./views/items.js";
import "./views/accounts.js";
import "./views/payments.js";
import { openInvoiceEditor } from "./views/invoice-editor.js";
import { openReceivePayment } from "./views/receive-payment.js";
import { openCustomerDrawer } from "./views/customer-drawer.js";
import { openItemDrawer } from "./views/items.js";

const NAV_FOR = { home: "home", invoices: "invoices", payments: "payments", customers: "customers", customer: "customers", items: "items", accounts: "accounts" };

let token = 0;
async function render() {
  const route = parseRoute();
  const host = $("#page");
  const name = route.page === "customers" && route.id ? "customer" : route.page;
  const page = app.pages[name];
  const mine = (token += 1);
  markNav(NAV_FOR[name]);
  $("#shell").classList.remove("nav-open");
  closeMenu();
  host.scrollTop = 0;
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
  const sales = ["invoices", "payments", "customers", "items"].includes(section);
  for (const a of document.querySelectorAll("#leftnav [data-route]")) {
    const r = a.getAttribute("data-route");
    const on = r === section;
    a.classList.toggle("active", on);
    if (a.classList.contains("nav-subitem")) a.classList.toggle("active", r === section);
  }
  $("#group-sales").classList.toggle("open", sales);
  $('#leftnav [data-route="sales"]').classList.toggle("active", sales);
}

// The left menu collapses to an icon rail, as it does in the real client. Each rail item keeps its label as a tooltip.
function setUpCollapse() {
  const shell = $("#shell");
  const button = $("#nav-collapse");
  for (const item of document.querySelectorAll("#leftnav .nav-item, #leftnav .create-btn")) {
    if (item === button) continue;
    const label = item.textContent.trim();
    if (label && !item.getAttribute("title")) item.setAttribute("title", label);
    if (label && !item.getAttribute("aria-label")) item.setAttribute("aria-label", label);
  }
  const apply = (collapsed) => {
    shell.classList.toggle("nav-collapsed", collapsed);
    button.setAttribute("aria-expanded", collapsed ? "false" : "true");
    const label = collapsed ? "Expand the menu" : "Collapse the menu";
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
    button.querySelector(".nav-collapse-label").textContent = label;
  };
  let stored = null;
  try { stored = sessionStorage.getItem("qbo-nav-collapsed"); } catch { /* storage unavailable */ }
  apply(stored === "1");
  button.addEventListener("click", () => {
    const collapsed = !shell.classList.contains("nav-collapsed");
    apply(collapsed);
    try { sessionStorage.setItem("qbo-nav-collapsed", collapsed ? "1" : "0"); } catch { /* storage unavailable */ }
  });
}

const CREATE = [
  ["Customers", [["Invoice", () => openInvoiceEditor()], ["Receive payment", () => openReceivePayment()], ["Statement"], ["Estimate"], ["Credit memo"], ["Sales receipt"], ["Refund receipt"], ["Delayed credit"], ["Delayed charge"], ["Add customer", () => openCustomerDrawer()]]],
  ["Vendors", [["Expense"], ["Check"], ["Bill"], ["Pay bills"], ["Purchase order"], ["Vendor credit"], ["Credit card credit"], ["Print checks"]]],
  ["Team", [["Single time activity"], ["Weekly timesheet"]]],
  ["Other", [["Bank deposit"], ["Transfer"], ["Journal entry"], ["Inventory qty adjustment"], ["Pay down credit card"], ["Add product/service", () => openItemDrawer()]]],
];
function openCreate(anchor) {
  const pop = openMenu(anchor, [], { className: "create-grid" });
  for (const [heading, entries] of CREATE) {
    const col = el("div", { class: "create-col" }, el("h3", { text: heading }));
    for (const [label, run] of entries) {
      col.append(el("button", { type: "button", class: "mi", role: "menuitem", text: label, title: run ? undefined : "Not simulated by this Tool", onclick: () => { closeMenu(); run ? run() : notSimulated(label); } }));
    }
    pop.append(col);
  }
  const r = anchor.getBoundingClientRect();
  pop.style.left = `${r.left}px`;
  pop.style.top = `${r.bottom + 4}px`;
  pop.querySelector(".mi")?.focus();
}

// ---- global search: customers by name, invoices by number, products by name ----
let searchSeq = 0;
async function runSearch(text) {
  const box = $("#gsearch-results");
  const q = text.trim();
  const seq = (searchSeq += 1);
  if (!q) { box.hidden = true; return; }
  const like = quote(`%${q}%`);
  const tasks = [
    query(`select * from Customer where DisplayName LIKE ${like} MAXRESULTS 5`).catch(() => []),
    query(`select * from Item where Name LIKE ${like} MAXRESULTS 5`).catch(() => []),
    /^\w[\w-]*$/.test(q) ? query(`select * from Invoice where DocNumber LIKE ${quote(`${q}%`)} MAXRESULTS 5`).catch(() => []) : Promise.resolve([]),
  ];
  const [customers, items, invoices] = await Promise.all(tasks);
  if (seq !== searchSeq) return;
  const rows = [];
  const add = (head, list, map) => { if (list.length) { rows.push(el("div", { class: "res-head", text: head })); for (const r of list) rows.push(map(r)); } };
  const res = (label, kind, run) => el("a", { class: "res", href: "#", role: "option", onclick: (e) => { e.preventDefault(); box.hidden = true; $("#gsearch-input").value = ""; run(); } }, [el("span", { text: label }), el("span", { class: "res-kind", text: kind })]);
  add("Customers", customers, (c) => res(c.DisplayName, "Customer", () => go(`#/customers/${encodeURIComponent(c.Id)}`)));
  add("Transactions", invoices, (i) => res(`Invoice ${i.DocNumber ?? i.Id}`, i.CustomerRef?.name ?? "", () => openInvoiceEditor(i.Id)));
  add("Products and services", items, (i) => res(i.Name, i.Type === "NonInventory" ? "Non-inventory" : i.Type, () => go(`#/items?q=${encodeURIComponent(i.Name)}`)));
  if (!rows.length) rows.push(el("div", { class: "res-head", text: "No results" }));
  box.replaceChildren(...rows);
  box.hidden = false;
}

async function boot() {
  hydrateIcons();
  $("#create-btn").addEventListener("click", (e) => { e.stopPropagation(); openCreate(e.currentTarget); });
  $("#menu-toggle").addEventListener("click", () => $("#shell").classList.toggle("nav-open"));
  setUpCollapse();
  for (const b of document.querySelectorAll("[data-not-simulated]")) b.addEventListener("click", () => notSimulated(b.getAttribute("data-not-simulated")));
  let timer;
  const input = $("#gsearch-input");
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => runSearch(input.value), 250); });
  input.addEventListener("keydown", (e) => { if (e.key === "Escape") { $("#gsearch-results").hidden = true; } });
  $("#gsearch").addEventListener("submit", (e) => { e.preventDefault(); runSearch(input.value); });
  document.addEventListener("click", (e) => { if (!$("#gsearch").contains(e.target)) $("#gsearch-results").hidden = true; });
  try {
    await loadCompany();
    $("#company-name").textContent = app.company.CompanyName;
    const initials = app.company.CompanyName.split(/\s+/).map((w) => w[0]).join("").slice(0, 1).toUpperCase();
    $("#avatar").textContent = initials || "Q";
    document.title = `${app.company.CompanyName} - QuickBooks (synthetic)`;
  } catch (error) {
    $("#company-name").textContent = "QuickBooks";
    app.companyError = error;
  }
  if (!location.hash) location.replace("#/home");
  window.addEventListener("hashchange", render);
  await render();
  watchWorld(async () => { await loadCompany().catch(() => {}); await render(); }, () => !isPending() && !app.dirty && !document.querySelector(".txn, .drawer, .scrim"));
}
boot();
