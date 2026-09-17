// Lists → Relationships → Customers: the customer list view with the NetSuite quick filter, paging and New.
import { app, can, go, listIds, expand, register } from "../store.js";
import { el, errorBanner, emptyState, lit, money, skeletonRows } from "../ui.js";
import { listShell, pagerStrip, setPageTitle, toolbarButton, nsButton, currencyOf } from "./common.js";
import { openCustomerForm } from "./customer-form.js";

const COLUMNS = [
  { label: "Name" }, { label: "Internal ID" }, { label: "Email" }, { label: "Phone" },
  { label: "Subsidiary" }, { label: "Balance", numeric: true }, { label: "Overdue", numeric: true },
];

function filterExpression(term, showInactive) {
  const parts = [];
  if (term !== "") {
    const value = lit(term);
    parts.push(`(entityId CONTAIN ${value} OR companyName CONTAIN ${value} OR email CONTAIN ${value} OR lastName CONTAIN ${value})`);
  }
  if (!showInactive) parts.push("isInactive IS false");
  return parts.join(" AND ");
}

function row(record) {
  const currency = currencyOf(record);
  return el("tr", {}, [
    el("td", {}, el("a", { class: "rowlink", href: `#/customers/${encodeURIComponent(record.id)}`, text: record.entityId ?? record.id })),
    el("td", { class: "tight mono", text: record.id }),
    el("td", { text: record.email ?? "" }),
    el("td", { class: "tight", text: record.phone ?? "" }),
    el("td", { text: record.subsidiary?.refName ?? "" }),
    el("td", { class: "num", text: money(record.balance, currency) }),
    el("td", { class: `num${Number(record.overdueBalance) > 0 ? " overdue" : ""}`, text: money(record.overdueBalance, currency) }),
  ]);
}

register("customers", async (main, route) => {
  setPageTitle("Customers");
  const state = {
    term: route.params.get("q") ?? "",
    inactive: route.params.get("inactive") === "1",
    offset: Number(route.params.get("offset") ?? 0) || 0,
    size: Number(route.params.get("size") ?? 25) || 25,
  };
  const body = el("tbody", {}, skeletonRows(COLUMNS.length));
  const pagerHost = el("div", {});

  const searchId = "cust-quick-filter";
  const inactiveId = "cust-show-inactive";
  const input = el("input", { type: "search", id: searchId, value: state.term, placeholder: "Name, e-mail or company" });
  const inactiveBox = el("input", { type: "checkbox", id: inactiveId, checked: state.inactive });
  const form = el("form", { class: "filterbar", onsubmit: (event) => { event.preventDefault(); apply({ term: input.value.trim(), offset: 0 }); } }, [
    el("div", { class: "field" }, [el("label", { class: "fl", for: searchId, text: "Quick Filter" }), input]),
    el("div", { class: "field inline" }, [inactiveBox, el("label", { class: "fl", for: inactiveId, text: "Show Inactives" })]),
    toolbarButton("Search", () => apply({ term: input.value.trim(), offset: 0 })),
    toolbarButton("Reset", () => apply({ term: "", inactive: false, offset: 0 })),
  ]);
  inactiveBox.addEventListener("change", () => apply({ inactive: inactiveBox.checked, offset: 0 }));

  function apply(patch) {
    const next = { ...state, ...patch };
    const params = new URLSearchParams();
    if (next.term) params.set("q", next.term);
    if (next.inactive) params.set("inactive", "1");
    if (next.offset) params.set("offset", String(next.offset));
    if (next.size !== 25) params.set("size", String(next.size));
    const query = params.toString();
    go(`#/customers${query ? `?${query}` : ""}`);
  }

  main.replaceChildren(listShell({
    title: "Customers",
    subtitle: app.session?.subsidiaryScope?.id !== "0" ? `Restricted to ${app.session.subsidiaryScope.refName}` : undefined,
    actions: [
      can("LIST_CUSTJOB", "create")
        ? toolbarButton("New Customer", () => openCustomerForm(null), { kind: "primary" })
        : toolbarButton("New Customer", () => {}, { disabled: true, title: "Your role cannot create customers" }),
      nsButton("Customize View"),
      nsButton("Export"),
    ],
    filter: form,
    columns: COLUMNS,
    body,
    pager: pagerHost,
  }));

  if (route.params.get("new") === "1" && can("LIST_CUSTJOB", "create")) openCustomerForm(null);

  try {
    const q = filterExpression(state.term, state.inactive);
    const page = await listIds("customer.list", { q, limit: state.size, offset: state.offset });
    const rows = await expand("customer.get", page.ids);
    if (rows.length === 0) {
      body.replaceChildren(el("tr", {}, el("td", { colspan: String(COLUMNS.length) }, emptyState(
        "No customers match this filter.",
        state.term ? `Nothing found for "${state.term}".` : "Create a customer to get started.",
      ))));
    } else {
      body.replaceChildren(...rows.map(row));
    }
    pagerHost.replaceChildren(pagerStrip({
      offset: page.offset,
      shown: rows.length,
      total: page.totalResults,
      hasMore: page.hasMore,
      pageSize: state.size,
      onOffset: (offset) => apply({ offset }),
      onPageSize: (size) => apply({ size, offset: 0 }),
    }));
  } catch (error) {
    body.replaceChildren(el("tr", {}, el("td", { colspan: String(COLUMNS.length) }, errorBanner(error, "The customer list could not be loaded"))));
  }
});
