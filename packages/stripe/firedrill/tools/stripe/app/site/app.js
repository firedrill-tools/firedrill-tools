// Stripe Tool browser app: shell, routing, search and the global Create menu. Every screen calls the Tool's own
// operations through /_firedrill/client.js; nothing rendered here is authoritative — records are re-read after
// each write and whenever the world revision moves.
import { hydrateIcons, icon } from "./icons.js";
import "./pages-payments.js";
import "./pages-customers.js";
import "./pages-catalog.js";
import "./pages-billing.js";
import "./pages-home.js";
import { openCustomerForm } from "./pages-customers.js";
import { openProductForm } from "./pages-catalog.js";
import { PREFIX_PAGES, app, canRead, canWrite, indexAll, invalidateCache, loadContext, navigate, pageHost, parseRoute } from "./store.js";
import { $, $$, ToolError, call, describe, el, isPending, money, openMenu, readPreference, toast, watchWorld, writePreference } from "./ui.js";
import { alert, deniedPanel, notSimulated } from "./widgets.js";

const DETAIL_PAGES = { payments: "payment", customers: "customer", products: "product", invoices: "invoice", subscriptions: "subscription" };
const NEW_PAGES = { payments: "payment-new", invoices: "invoice-new", subscriptions: "subscription-new" };
const NAV_ROUTE_FOR = { payment: "payments", "payment-new": "payments", customer: "customers", product: "products", invoice: "invoices", "invoice-new": "invoices", subscription: "subscriptions", "subscription-new": "subscriptions", settings: undefined };

// ---------------------------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------------------------

function resolve(route) {
  if (route.id === "new" && NEW_PAGES[route.page]) return NEW_PAGES[route.page];
  if (route.id && DETAIL_PAGES[route.page]) return DETAIL_PAGES[route.page];
  return route.page;
}

let renderToken = 0;
async function render() {
  const host = pageHost();
  const route = parseRoute(location.hash);
  const pageName = resolve(route);
  const page = app.pages[pageName];
  const token = (renderToken += 1);
  host.dispatchEvent(new CustomEvent("page-leave"));
  app.route = { ...route, name: pageName };
  const navName = NAV_ROUTE_FOR[pageName] === undefined && pageName in NAV_ROUTE_FOR ? undefined : NAV_ROUTE_FOR[pageName] ?? pageName;
  recordVisit(navName);
  renderShortcuts();
  markNav(navName);
  closeNav();
  host.scrollTop = 0;
  if (!page) {
    host.replaceChildren(el("div", { class: "page-inner" }, [alert(`There is no page at ${location.hash || "#/"}.`, "neutral", { title: "Not found" })]));
    return;
  }
  try {
    await page(host, route);
  } catch (error) {
    if (token !== renderToken) return;
    host.replaceChildren(el("div", { class: "page-inner" }, [error instanceof ToolError && (error.denied || error.is("PERMISSION_DENIED")) ? deniedPanel(error, error.details?.group) : alert(describe(error), "danger", { title: "Could not render this page" })]));
  }
}

// Shortcuts: pinned pages first, then recently visited ones (per-viewer preference, never record data).
const SHORTCUT_PAGES = {
  payments: { label: "Payments", icon: "payments", href: "#/payments" },
  invoices: { label: "Invoices", icon: "invoices", href: "#/invoices" },
  subscriptions: { label: "Subscriptions", icon: "subscriptions", href: "#/subscriptions" },
  refunds: { label: "Refunds", icon: "refunds", href: "#/refunds" },
  developers: { label: "Developers", icon: "developers", href: "#/developers" },
  settings: { label: "Settings", icon: "gear", href: "#/settings" },
};
function readList(name, fallback) {
  try {
    const value = JSON.parse(readPreference(name, JSON.stringify(fallback)));
    return Array.isArray(value) ? value.filter((entry) => Object.hasOwn(SHORTCUT_PAGES, entry)) : fallback;
  } catch {
    return fallback;
  }
}
function recordVisit(navName) {
  if (!navName || !Object.hasOwn(SHORTCUT_PAGES, navName)) return;
  const recent = [navName, ...readList("recent", []).filter((entry) => entry !== navName)].slice(0, 4);
  writePreference("recent", JSON.stringify(recent));
}
function renderShortcuts() {
  const pinned = readList("pinned", ["payments", "invoices", "subscriptions"]);
  const recent = readList("recent", []).filter((entry) => !pinned.includes(entry));
  const list = $("#shortcuts-list");
  list.replaceChildren(
    ...[...pinned.map((entry) => [entry, true]), ...recent.map((entry) => [entry, false])].slice(0, 6).map(([entry, isPinned]) => {
      const page = SHORTCUT_PAGES[entry];
      const anchor = el("a", { class: "sidenav-item", attrs: { href: page.href, "data-route": entry } }, [icon(page.icon, "sidenav-icon"), el("span", { text: page.label })]);
      const pin = el("button", { class: `shortcut-pin btn-reset ${isPinned ? "is-pinned" : ""}`.trim(), title: isPinned ? "Unpin" : "Pin", attrs: { type: "button", "aria-label": `${isPinned ? "Unpin" : "Pin"} ${page.label}`, "aria-pressed": String(isPinned) } }, icon("pin"));
      pin.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const current = readList("pinned", ["payments", "invoices", "subscriptions"]);
        writePreference("pinned", JSON.stringify(isPinned ? current.filter((item) => item !== entry) : [...current, entry]));
        renderShortcuts();
        markNav(currentNav);
      });
      anchor.append(pin);
      return el("li", {}, anchor);
    }),
  );
}
let currentNav;

function markNav(routeName) {
  currentNav = routeName;
  for (const link of $$("[data-route]")) {
    const current = link.dataset.route === routeName;
    if (current) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  for (const group of $$(".sidenav-group")) {
    const hasCurrent = group.querySelector(".sidenav-subitem[aria-current]") !== null;
    if (hasCurrent) expandGroup(group, true);
  }
}

function expandGroup(group, open) {
  const toggle = group.querySelector(".sidenav-toggle");
  const list = group.querySelector(".sidenav-sublist");
  toggle.setAttribute("aria-expanded", String(open));
  list.hidden = !open;
}

function closeNav() {
  $("#app").classList.remove("nav-open");
  $("#sidebar-scrim").hidden = true;
  $("#menu-toggle").setAttribute("aria-expanded", "false");
}

// ---------------------------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------------------------

function wireShell() {
  for (const control of $$("[data-not-simulated]")) {
    const feature = control.dataset.notSimulated;
    control.title = `${feature} (not simulated)`;
    control.addEventListener("click", () => notSimulated(feature));
  }
  $("#sandbox-switch").addEventListener("click", () => notSimulated("Live account", "This Tool only simulates a sandbox. There is no live account behind it, and no real card network is ever reached."));
  const apps = $("#topbar-apps");
  apps.addEventListener("click", () => notSimulated("Stripe Apps", "Installed apps and the App Marketplace are not simulated."));
  for (const group of $$(".sidenav-group")) {
    const toggle = group.querySelector(".sidenav-toggle");
    toggle.addEventListener("click", () => expandGroup(group, toggle.getAttribute("aria-expanded") !== "true"));
  }
  $("#menu-toggle").addEventListener("click", () => {
    const open = !$("#app").classList.contains("nav-open");
    $("#app").classList.toggle("nav-open", open);
    $("#sidebar-scrim").hidden = !open;
    $("#menu-toggle").setAttribute("aria-expanded", String(open));
  });
  $("#sidebar-scrim").addEventListener("click", closeNav);

  const collapseButton = $("#sidebar-collapse");
  const applyCollapsed = (collapsed) => {
    $("#app").classList.toggle("sidebar-collapsed", collapsed);
    collapseButton.setAttribute("aria-expanded", String(!collapsed));
    collapseButton.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
    collapseButton.title = collapsed ? "Expand sidebar" : "Collapse sidebar";
    collapseButton.replaceChildren(icon(collapsed ? "expand" : "collapse", "sidenav-icon"), el("span", { class: "sidebar-collapse-label", text: "Collapse" }));
  };
  applyCollapsed(readPreference("sidebar-collapsed", "0") === "1");
  collapseButton.addEventListener("click", () => {
    const collapsed = !$("#app").classList.contains("sidebar-collapsed");
    writePreference("sidebar-collapsed", collapsed ? "1" : "0");
    applyCollapsed(collapsed);
  });

  $("#topbar-search").addEventListener("click", () => {
    $("#app").classList.add("nav-open");
    $("#sidebar-scrim").hidden = false;
    $("#menu-toggle").setAttribute("aria-expanded", "true");
    $("#search").focus();
  });
  $("#search-form").addEventListener("click", () => {
    if ($("#app").classList.contains("sidebar-collapsed")) {
      writePreference("sidebar-collapsed", "0");
      applyCollapsed(false);
      $("#search").focus();
    }
  });

  const switcher = $("#account-switcher");
  switcher.addEventListener("click", () => {
    const account = app.context?.account;
    openMenu(switcher, [
      { header: account?.business_name ?? "Account" },
      { label: "Settings", icon: "gear", onSelect: () => navigate("#/settings") },
      { label: "Developers", icon: "developers", onSelect: () => navigate("#/developers") },
      "divider",
      { label: "Switch to sandbox", icon: "flask", description: "Not simulated", onSelect: () => notSimulated("Switch to sandbox", "This Tool serves exactly one sandbox account; there are no other sandboxes to switch to.") },
      { label: "Manage sandboxes", icon: "apps", description: "Not simulated", onSelect: () => notSimulated("Manage sandboxes") },
      { label: "Create account", icon: "plus", description: "Not simulated", onSelect: () => notSimulated("Create account") },
      "divider",
      { label: `Actor: ${app.connection?.actorId ?? "…"}`, icon: "customers", disabled: true, description: "Change actors from Firedrill, not from the app" },
    ], { width: 260 });
  });

  const create = $("#topbar-create");
  create.addEventListener("click", () => {
    openMenu(create, [
      { label: "Payment", icon: "payments", disabled: !canWrite("payment_intents"), onSelect: () => navigate("#/payments/new") },
      { label: "Customer", icon: "customers", disabled: !canWrite("customers"), onSelect: () => openCustomerForm() },
      { label: "Invoice", icon: "invoices", disabled: !canWrite("invoices"), onSelect: () => navigate("#/invoices/new") },
      { label: "Subscription", icon: "subscriptions", disabled: !canWrite("subscriptions"), onSelect: () => navigate("#/subscriptions/new") },
      { label: "Product", icon: "catalog", disabled: !canWrite("products"), onSelect: () => openProductForm() },
      "divider",
      { label: "Payment link", icon: "external", description: "Not simulated", onSelect: () => notSimulated("Payment Links") },
      { label: "Coupon", icon: "receipt", description: "Not simulated", onSelect: () => notSimulated("Coupons") },
      { label: "Quote", icon: "note", description: "Not simulated", onSelect: () => notSimulated("Quotes") },
    ], { align: "end", width: 240 });
  });

  const help = $("#topbar-help");
  const openHelp = () =>
    openMenu(help, [
      { header: "Keyboard shortcuts" },
      { label: "Search", shortcut: "/", disabled: true },
      { label: "Go to Home", shortcut: "g h", disabled: true },
      { label: "Go to Payments", shortcut: "g p", disabled: true },
      { label: "Go to Customers", shortcut: "g c", disabled: true },
      { label: "Go to Invoices", shortcut: "g i", disabled: true },
      { label: "Go to Subscriptions", shortcut: "g s", disabled: true },
      { label: "Show keyboard shortcuts", shortcut: "?", disabled: true },
      { label: "Close menus and dialogs", shortcut: "Esc", disabled: true },
      "divider",
      { label: "Documentation", icon: "external", description: "Not simulated", onSelect: () => notSimulated("Documentation", "This offline app links nowhere; see the Tool README for what is simulated.") },
      { label: "Contact support", icon: "help", description: "Not simulated", onSelect: () => notSimulated("Support") },
      { label: "Developers", icon: "developers", onSelect: () => navigate("#/developers") },
    ], { align: "end", width: 280 });
  help.addEventListener("click", openHelp);

  const notifications = $("#topbar-notifications");
  notifications.addEventListener("click", () => openMenu(notifications, el("div", { class: "menu-rich" }, [el("div", { class: "menu-header", text: "Notifications" }), el("div", { class: "muted", text: "No notifications. This synthetic account does not generate alerts or e-mail." })]), { align: "end", width: 300 }));

  const settings = $("#topbar-settings");
  settings.addEventListener("click", () =>
    openMenu(settings, [
      { header: "Settings" },
      { label: "Business details", icon: "gear", onSelect: () => navigate("#/settings") },
      { label: "Developers", icon: "developers", onSelect: () => navigate("#/developers") },
      "divider",
      { label: "Personal details", icon: "customers", description: "Not simulated", onSelect: () => notSimulated("Personal details") },
      { label: "Team and security", icon: "customers", description: "Not simulated", onSelect: () => notSimulated("Team and security") },
      { label: "Branding", icon: "sparkle", description: "Not simulated", onSelect: () => notSimulated("Branding") },
      { label: "Billing settings", icon: "invoices", description: "Not simulated", onSelect: () => notSimulated("Billing settings", "Invoice and subscription behaviour of this Tool is fixed; see the README.") },
    ], { align: "end", width: 260 }),
  );

  document.addEventListener("keydown", (event) => {
    const editable = event.target.closest("input, textarea, select, [contenteditable]");
    if (event.key === "/" && !editable && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      $("#search").focus();
      return;
    }
    if (editable) return;
    if (event.key === "?" && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      openHelp();
      return;
    }
    if (event.key === "g") {
      pendingChord = true;
      clearTimeout(chordTimer);
      chordTimer = setTimeout(() => {
        pendingChord = false;
      }, 900);
      return;
    }
    if (pendingChord) {
      pendingChord = false;
      const target = { h: "#/", p: "#/payments", c: "#/customers", i: "#/invoices", s: "#/subscriptions", b: "#/balances", t: "#/transactions", d: "#/developers" }[event.key];
      if (target) navigate(target);
    }
  });
}
let pendingChord = false;
let chordTimer;

// ---------------------------------------------------------------------------------------------
// Search: ids jump straight to the object; text searches customers, payments and products (bounded index)
// ---------------------------------------------------------------------------------------------

function wireSearch() {
  const form = $("#search-form");
  const inputElement = $("#search");
  const results = $("#search-results");
  let timer;
  let activeIndex = -1;
  const hide = () => {
    results.hidden = true;
    inputElement.setAttribute("aria-expanded", "false");
    activeIndex = -1;
  };
  const show = (nodes) => {
    results.replaceChildren(...nodes);
    results.hidden = false;
    inputElement.setAttribute("aria-expanded", "true");
  };
  const hit = (iconName, main, sub, href) => {
    const element = el("button", { class: "search-hit", attrs: { type: "button", role: "option" } }, [icon(iconName), el("span", { class: "search-hit-main", text: main }), sub ? el("span", { class: "search-hit-sub", text: sub }) : null]);
    element.addEventListener("mousedown", (event) => event.preventDefault());
    element.addEventListener("click", () => {
      hide();
      inputElement.value = "";
      navigate(href);
    });
    return element;
  };
  async function search(query) {
    const trimmed = query.trim();
    if (!trimmed) {
      hide();
      return;
    }
    const idMatch = /^([a-z]+)_[0-9A-Za-z]+$/.exec(trimmed);
    if (idMatch && PREFIX_PAGES[idMatch[1]]) {
      const page = PREFIX_PAGES[idMatch[1]];
      const nodes = [el("div", { class: "search-group", text: "Jump to" })];
      if (page === "charges") nodes.push(hit("payments", trimmed, "Open the payment for this charge", `#/charges/${trimmed}`));
      else if (page === "refunds") nodes.push(hit("arrow-return", trimmed, "Refunds are listed with their payment", "#/refunds"));
      else if (page === "prices" || page === "payment_methods" || page === "invoice_items") nodes.push(el("div", { class: "search-note", text: `${trimmed} is a ${page.replace("_", " ").replace(/s$/, "")} — open its product, customer or invoice instead.` }));
      else nodes.push(hit(page === "payments" ? "payments" : page === "customers" ? "customers" : page === "invoices" ? "invoices" : page === "subscriptions" ? "subscriptions" : "catalog", trimmed, `Open ${page.replace(/s$/, "")}`, `#/${page}/${trimmed}`));
      show(nodes);
      return;
    }
    show([el("div", { class: "search-note" }, [icon("spinner", "spin"), el("span", { text: " Searching…" })])]);
    const lower = trimmed.toLowerCase();
    const nodes = [];
    // Each index is bounded (store.indexAll); a group that stopped at its bound is named in a note, never hidden.
    const bounded = [];
    const scan = async (operation, args, noun) => {
      const index = await indexAll(operation, args);
      if (!index.complete) bounded.push(`${index.items.length.toLocaleString("en-US")} ${noun}`);
      return index.items;
    };
    try {
      if (canRead("customers")) {
        const customers = (await scan("customers.list", {}, "customers")).filter((customer) => [customer.name, customer.email, customer.description].some((value) => value && String(value).toLowerCase().includes(lower))).slice(0, 5);
        if (customers.length > 0) nodes.push(el("div", { class: "search-group", text: "Customers" }), ...customers.map((customer) => hit("customers", customer.name || customer.email || customer.id, customer.email, `#/customers/${customer.id}`)));
      }
      if (canRead("payment_intents")) {
        const intents = (await scan("payment_intents.list", { expand: ["data.latest_charge", "data.customer"] }, "payments")).filter((intent) => [intent.description, intent.id, intent.metadata?.order_id].some((value) => value && String(value).toLowerCase().includes(lower))).slice(0, 5);
        if (intents.length > 0) nodes.push(el("div", { class: "search-group", text: "Payments" }), ...intents.map((intent) => hit("payments", `${money(intent.amount, intent.currency)} ${intent.description ?? ""}`.trim(), intent.id, `#/payments/${intent.id}`)));
      }
      if (canRead("products")) {
        const products = (await scan("products.list", {}, "products")).filter((product) => [product.name, product.description].some((value) => value && String(value).toLowerCase().includes(lower))).slice(0, 5);
        if (products.length > 0) nodes.push(el("div", { class: "search-group", text: "Products" }), ...products.map((product) => hit("catalog", product.name, product.active ? undefined : "Archived", `#/products/${product.id}`)));
      }
      if (canRead("invoices")) {
        const invoices = (await scan("invoices.list", {}, "invoices")).filter((invoice) => [invoice.number, invoice.customer_name, invoice.customer_email].some((value) => value && String(value).toLowerCase().includes(lower))).slice(0, 5);
        if (invoices.length > 0) nodes.push(el("div", { class: "search-group", text: "Invoices" }), ...invoices.map((invoice) => hit("invoices", `${invoice.number ?? "Draft"} · ${money(invoice.total, invoice.currency)}`, invoice.customer_name ?? undefined, `#/invoices/${invoice.id}`)));
      }
    } catch (error) {
      nodes.push(el("div", { class: "search-note", text: describe(error) }));
    }
    if (nodes.length === 0) nodes.push(el("div", { class: "search-note", text: `No ${bounded.length > 0 ? "loaded " : ""}customers, payments, products or invoices match “${trimmed}”.` }));
    if (bounded.length > 0) nodes.push(el("div", { class: "search-note", attrs: { "data-bound": "true" }, text: `Searched only the newest ${bounded.join(", ")}; older records are not included. Paste an id to open any record.` }));
    nodes.push(el("div", { class: "search-note", text: "Search matches names, e-mails, descriptions and invoice numbers of this account; paste an id (pi_…, cus_…, in_…) to jump to it." }));
    show(nodes);
  }
  inputElement.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => void search(inputElement.value), 180);
  });
  inputElement.addEventListener("focus", () => {
    if (inputElement.value.trim()) void search(inputElement.value);
  });
  inputElement.addEventListener("blur", () => setTimeout(hide, 120));
  inputElement.addEventListener("keydown", (event) => {
    const hits = $$(".search-hit", results);
    if (event.key === "Escape") {
      inputElement.value = "";
      hide();
      inputElement.blur();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (hits.length === 0) return;
      event.preventDefault();
      activeIndex = event.key === "ArrowDown" ? (activeIndex + 1) % hits.length : (activeIndex - 1 + hits.length) % hits.length;
      hits.forEach((element, index) => element.setAttribute("aria-selected", String(index === activeIndex)));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (activeIndex >= 0 && hits[activeIndex]) hits[activeIndex].click();
      else if (hits.length > 0) hits[0].click();
    }
  });
  form.addEventListener("submit", (event) => event.preventDefault());
}

// ---------------------------------------------------------------------------------------------
// Charges / refunds by id: resolve to the owning payment
// ---------------------------------------------------------------------------------------------

app.pages.charges = async (host, route) => {
  const charge = await call("charges.retrieve", { charge: route.id });
  if (charge.payment_intent) navigate(`#/payments/${charge.payment_intent}`);
  else host.replaceChildren(el("div", { class: "page-inner" }, [alert(`Charge ${charge.id} is not linked to a PaymentIntent.`, "neutral")]));
};

// ---------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------

async function boot() {
  hydrateIcons();
  wireShell();
  wireSearch();
  const initial = $("#page");
  try {
    await loadContext();
  } catch (error) {
    initial.replaceChildren(el("div", { class: "page-inner" }, [error instanceof ToolError && error.denied ? deniedPanel(error) : alert(describe(error), "danger", { title: "Could not connect to the synthetic account", actions: [el("button", { class: "btn btn-secondary", text: "Retry", attrs: { type: "button" }, on: { click: () => location.reload() } })] })]));
    $("#account-name").textContent = "Stripe";
    return;
  }
  renderAccount();
  window.addEventListener("hashchange", () => void render());
  await render();
  watchWorld(
    async (first) => {
      if (first) return;
      invalidateCache();
      try {
        await loadContext();
        renderAccount();
      } catch {
        /* the page render reports it */
      }
      await render();
    },
    () => app.editing === 0 && !isPending() && document.querySelector("dialog[open]") === null,
    (context) => {
      app.connection = context;
      const label = context.title ? `${context.title}` : "Stripe";
      if (!app.context) $("#account-name").textContent = label;
    },
  );
}

function renderAccount() {
  const account = app.context?.account;
  const name = account?.business_name ?? "Stripe";
  $("#account-name").textContent = name;
  $("#account-avatar").textContent = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");
  $("#sandbox-banner").hidden = Boolean(app.context?.livemode);
  $("#sandbox-label").textContent = ` · ${name}`;
}

void boot().catch((error) => toast(describe(error), { error: true }));

