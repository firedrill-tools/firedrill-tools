// Transactions → Sales → Sales Orders List: the transaction list view with a status filter and paging.
import { app, can, go, listIds, expand, register } from "../store.js";
import { el, errorBanner, emptyState, money, mdy, skeletonRows, lit } from "../ui.js";
import { listShell, pagerStrip, setPageTitle, toolbarButton, nsButton, pill, currencyOf } from "./common.js";

const COLUMNS = [
  { label: "Document Number" }, { label: "Date" }, { label: "Customer" }, { label: "Status" },
  { label: "Memo" }, { label: "Amount", numeric: true },
];
const STATUSES = [
  ["", "— All —"],
  ["pendingApproval", "Pending Approval"],
  ["pendingFulfillment", "Pending Fulfillment"],
  ["partiallyFulfilled", "Partially Fulfilled"],
  ["pendingBilling", "Pending Billing"],
  ["pendingBillingPartFulfilled", "Pending Billing/Partially Fulfilled"],
  ["billed", "Billed"],
  ["closed", "Closed"],
];

register("orders", async (main, route) => {
  setPageTitle("Sales Orders");
  const state = {
    status: route.params.get("status") ?? "",
    term: route.params.get("q") ?? "",
    offset: Number(route.params.get("offset") ?? 0) || 0,
    size: Number(route.params.get("size") ?? 25) || 25,
  };
  const body = el("tbody", {}, skeletonRows(COLUMNS.length));
  const pagerHost = el("div", {});

  function apply(patch) {
    const next = { ...state, ...patch };
    const params = new URLSearchParams();
    if (next.status) params.set("status", next.status);
    if (next.term) params.set("q", next.term);
    if (next.offset) params.set("offset", String(next.offset));
    if (next.size !== 25) params.set("size", String(next.size));
    const query = params.toString();
    go(`#/orders${query ? `?${query}` : ""}`);
  }

  const statusSelect = el("select", { id: "so-status", onchange: (event) => apply({ status: event.currentTarget.value, offset: 0 }) },
    STATUSES.map(([value, label]) => el("option", { value, text: label, selected: value === state.status })));
  const input = el("input", { type: "search", id: "so-filter", value: state.term, placeholder: "Document number or memo" });
  const filter = el("form", { class: "filterbar", onsubmit: (event) => { event.preventDefault(); apply({ term: input.value.trim(), offset: 0 }); } }, [
    el("div", { class: "field" }, [el("label", { class: "fl", for: "so-status", text: "Status" }), statusSelect]),
    el("div", { class: "field" }, [el("label", { class: "fl", for: "so-filter", text: "Quick Filter" }), input]),
    toolbarButton("Search", () => apply({ term: input.value.trim(), offset: 0 })),
    toolbarButton("Reset", () => apply({ term: "", status: "", offset: 0 })),
  ]);

  main.replaceChildren(listShell({
    title: "Sales Orders",
    subtitle: app.session?.subsidiaryScope?.id !== "0" ? `Restricted to ${app.session.subsidiaryScope.refName}` : undefined,
    actions: [
      toolbarButton("New Sales Order", () => go("#/orders/new"), { kind: "primary", disabled: !can("TRAN_SALESORD", "create"), title: can("TRAN_SALESORD", "create") ? undefined : "Your role cannot create sales orders" }),
      nsButton("Customize View"),
      nsButton("Export"),
    ],
    filter,
    columns: COLUMNS,
    body,
    pager: pagerHost,
  }));

  try {
    const parts = [];
    if (state.status !== "") parts.push(`status IS ${lit(state.status)}`);
    if (state.term !== "") parts.push(`(tranId CONTAIN ${lit(state.term)} OR memo CONTAIN ${lit(state.term)})`);
    const page = await listIds("sales-order.list", { q: parts.join(" AND "), limit: state.size, offset: state.offset });
    const rows = await expand("sales-order.get", page.ids);
    if (rows.length === 0) {
      body.replaceChildren(el("tr", {}, el("td", { colspan: String(COLUMNS.length) },
        emptyState("No sales orders match this filter.", "Change the status filter or enter a different search."))));
    } else {
      body.replaceChildren(...rows.map((record) => el("tr", {}, [
        el("td", {}, el("a", { class: "rowlink", href: `#/orders/${encodeURIComponent(record.id)}`, text: record.tranId })),
        el("td", { class: "tight", text: mdy(record.tranDate) }),
        el("td", {}, el("a", { href: `#/customers/${encodeURIComponent(record.entity?.id ?? "")}`, text: record.entity?.refName ?? "" })),
        el("td", {}, pill(record.status)),
        el("td", { text: record.memo ?? "" }),
        el("td", { class: "num", text: money(record.total, currencyOf(record)) }),
      ])));
    }
    pagerHost.replaceChildren(pagerStrip({
      offset: page.offset, shown: rows.length, total: page.totalResults, hasMore: page.hasMore, pageSize: state.size,
      onOffset: (offset) => apply({ offset }), onPageSize: (size) => apply({ size, offset: 0 }),
    }));
  } catch (error) {
    body.replaceChildren(el("tr", {}, el("td", { colspan: String(COLUMNS.length) }, errorBanner(error, "The sales order list could not be loaded"))));
  }
});
