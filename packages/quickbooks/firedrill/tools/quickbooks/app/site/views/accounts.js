// Accounting > Chart of accounts (read-only in this Tool).
import { app, queryAll, register } from "../store.js";
import { amount, el, errorBanner, icon, isAccessDenied, loadingRows, notSimulated } from "../ui.js";
import { emptyRow, pageShell } from "./common.js";

const TYPES_ORDER = ["Bank", "Accounts Receivable", "Other Current Asset", "Fixed Asset", "Accounts Payable", "Credit Card", "Other Current Liability", "Equity", "Income", "Cost of Goods Sold", "Expense", "Other Expense"];

register("accounts", async (host, route) => {
  const { root, body } = pageShell("Chart of accounts", {
    crumb: "Accounting",
    actions: [
      el("button", { type: "button", class: "btn", text: "Run report", onclick: () => notSimulated("Account QuickReport") }),
      el("button", { type: "button", class: "btn primary", text: "New", title: "Creating accounts is not simulated", onclick: () => notSimulated("New account") }),
    ],
    tabs: el("nav", { class: "tabs", "aria-label": "Accounting" }, [
      el("a", { class: "tab active", href: "#/accounts", "aria-current": "page", text: "Chart of accounts" }),
      el("button", { type: "button", class: "tab", text: "Reconcile", onclick: () => notSimulated("Reconcile") }),
    ]),
  });
  const showInactive = route.params.get("inactive") === "1";
  const toggle = el("input", { type: "checkbox", id: "coa-inactive", checked: showInactive, onchange: () => { location.hash = `#/accounts${toggle.checked ? "?inactive=1" : ""}`; } });
  const tbody = el("tbody", {}, loadingRows(5));
  const search = el("input", { type: "search", placeholder: "Search by name or number", "aria-label": "Search the chart of accounts" });
  const card = el("div", { class: "card" }, [
    el("div", { class: "toolbar" }, [
      el("div", { class: "tsearch" }, [icon("search"), search]),
      el("label", { class: "checkline", for: "coa-inactive" }, [toggle, "Include inactive"]),
      el("div", { class: "grow" }),
      el("button", { type: "button", class: "icon-btn", "aria-label": "Print the chart of accounts", title: "Print", onclick: () => notSimulated("Print") }, icon("print")),
      el("button", { type: "button", class: "icon-btn", "aria-label": "Table settings", title: "Settings", onclick: () => notSimulated("Table settings") }, icon("gear")),
    ]),
    el("div", { class: "table-wrap" }, el("table", { class: "grid" }, [
      el("thead", {}, el("tr", {}, ["Name", "Account type", "Detail type", "QuickBooks balance", "Action"].map((h, i) => el("th", { class: i === 3 ? "num" : i === 4 ? "act" : "", text: h })))),
      tbody,
    ])),
  ]);
  body.append(card);
  host.replaceChildren(root);
  try {
    const all = await queryAll(`select * from Account${showInactive ? " where Active IN (true, false)" : ""}`);
    all.sort((a, b) => (TYPES_ORDER.indexOf(a.AccountType) - TYPES_ORDER.indexOf(b.AccountType)) || a.Name.localeCompare(b.Name));
    const draw = () => {
    const needle = search.value.trim().toLowerCase();
    const rows = needle ? all.filter((a) => `${a.Name} ${a.AcctNum ?? ""} ${a.AccountType}`.toLowerCase().includes(needle)) : all;
    tbody.replaceChildren(...(rows.length ? rows.map((a) => el("tr", {}, [
      el("td", {}, [el("span", { text: a.Name }), a.Active ? null : el("span", { class: "pill inactive", text: " (deleted)" })]),
      el("td", { text: a.AccountType }),
      el("td", { text: (a.AccountSubType ?? "").replace(/([a-z])([A-Z])/g, "$1 $2") }),
      el("td", { class: "num", text: ["Bank", "Accounts Receivable", "Other Current Asset", "Credit Card", "Accounts Payable"].includes(a.AccountType) ? amount(a.CurrentBalance) : "" }),
      el("td", { class: "act" }, el("button", { type: "button", class: "link-btn", text: a.AccountType === "Bank" ? "Account history" : "Run report", onclick: () => notSimulated("Account register") })),
    ])) : [emptyRow(5, needle ? "No matching accounts" : "No accounts", needle ? "Try a different search." : "")]));
    };
    search.addEventListener("input", draw);
    draw();
  } catch (error) {
    card.replaceWith(errorBanner(error, isAccessDenied(error) ? "You don't have access to the chart of accounts" : "We couldn't load your accounts"));
  }
  void app;
});
