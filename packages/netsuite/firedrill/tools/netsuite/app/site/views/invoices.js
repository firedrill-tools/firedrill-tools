// Transactions → Sales → Invoices List: Open / Paid In Full / Overdue / All views with paging.
import { app, can, go, listIds, expand, register, isOverdue } from "../store.js";
import { el, errorBanner, emptyState, money, mdy, skeletonRows, lit } from "../ui.js";
import { listShell, pagerStrip, setPageTitle, toolbarButton, nsButton, pill, currencyOf } from "./common.js";

const COLUMNS = [
  { label: "Document Number" }, { label: "Date" }, { label: "Due Date" }, { label: "Customer" },
  { label: "Status" }, { label: "Amount", numeric: true }, { label: "Amount Remaining", numeric: true },
];
const TABS = ["Open", "Overdue", "Paid In Full", "All"];

function filterFor(tab, term, today) {
  const parts = [];
  if (tab === "Open") parts.push('status IS "open"');
  if (tab === "Paid In Full") parts.push('status IS "paidInFull"');
  if (tab === "Overdue") parts.push(`status IS "open" AND dueDate BEFORE ${lit(today)}`);
  if (term !== "") parts.push(`(tranId CONTAIN ${lit(term)} OR memo CONTAIN ${lit(term)})`);
  return parts.join(" AND ");
}

register("invoices", async (main, route) => {
  setPageTitle("Invoices");
  const state = {
    tab: TABS.includes(route.params.get("tab")) ? route.params.get("tab") : "Open",
    term: route.params.get("q") ?? "",
    offset: Number(route.params.get("offset") ?? 0) || 0,
    size: Number(route.params.get("size") ?? 25) || 25,
  };
  const body = el("tbody", {}, skeletonRows(COLUMNS.length));
  const pagerHost = el("div", {});

  function apply(patch) {
    const next = { ...state, ...patch };
    const params = new URLSearchParams();
    if (next.tab !== "Open") params.set("tab", next.tab);
    if (next.term) params.set("q", next.term);
    if (next.offset) params.set("offset", String(next.offset));
    if (next.size !== 25) params.set("size", String(next.size));
    const query = params.toString();
    go(`#/invoices${query ? `?${query}` : ""}`);
  }

  const tabs = el("div", { class: "tabstrip", role: "tablist" }, TABS.map((name) =>
    el("button", { type: "button", role: "tab", "aria-selected": String(name === state.tab), text: name, onclick: () => apply({ tab: name, offset: 0 }) })));
  const input = el("input", { type: "search", id: "inv-filter", value: state.term, placeholder: "Document number or memo" });
  const filter = el("form", { class: "filterbar", onsubmit: (event) => { event.preventDefault(); apply({ term: input.value.trim(), offset: 0 }); } }, [
    el("div", { class: "field" }, [el("label", { class: "fl", for: "inv-filter", text: "Quick Filter" }), input]),
    toolbarButton("Search", () => apply({ term: input.value.trim(), offset: 0 })),
    toolbarButton("Reset", () => apply({ term: "", offset: 0 })),
  ]);

  main.replaceChildren(listShell({
    title: "Invoices",
    subtitle: app.session?.subsidiaryScope?.id !== "0" ? `Restricted to ${app.session.subsidiaryScope.refName}` : undefined,
    actions: [
      toolbarButton("New Invoice", () => go("#/invoices/new"), {
        kind: "primary",
        disabled: !can("TRAN_CUSTINVC", "create"),
        title: can("TRAN_CUSTINVC", "create") ? undefined : "Your role cannot create invoices",
      }),
      nsButton("Customize View"),
      nsButton("Export"),
    ],
    tabs,
    filter,
    columns: COLUMNS,
    body,
    pager: pagerHost,
  }));

  try {
    const page = await listIds("invoice.list", { q: filterFor(state.tab, state.term, app.today), limit: state.size, offset: state.offset });
    const rows = await expand("invoice.get", page.ids);
    if (rows.length === 0) {
      body.replaceChildren(el("tr", {}, el("td", { colspan: String(COLUMNS.length) },
        emptyState(`No ${state.tab.toLowerCase()} invoices.`, "Change the view or clear the quick filter."))));
    } else {
      body.replaceChildren(...rows.map((record) => {
        const currency = currencyOf(record);
        const late = isOverdue(record);
        return el("tr", {}, [
          el("td", {}, el("a", { class: "rowlink", href: `#/invoices/${encodeURIComponent(record.id)}`, text: record.tranId })),
          el("td", { class: "tight", text: mdy(record.tranDate) }),
          el("td", { class: `tight${late ? " overdue" : ""}`, text: mdy(record.dueDate) }),
          el("td", {}, el("a", { href: `#/customers/${encodeURIComponent(record.entity?.id ?? "")}`, text: record.entity?.refName ?? "" })),
          el("td", {}, pill(record.status)),
          el("td", { class: "num", text: money(record.total, currency) }),
          el("td", { class: `num${late ? " overdue" : ""}`, text: money(record.amountRemaining, currency) }),
        ]);
      }));
    }
    pagerHost.replaceChildren(pagerStrip({
      offset: page.offset, shown: rows.length, total: page.totalResults, hasMore: page.hasMore, pageSize: state.size,
      onOffset: (offset) => apply({ offset }), onPageSize: (size) => apply({ size, offset: 0 }),
    }));
  } catch (error) {
    body.replaceChildren(el("tr", {}, el("td", { colspan: String(COLUMNS.length) }, errorBanner(error, "The invoice list could not be loaded"))));
  }
});
