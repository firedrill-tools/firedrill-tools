// Payments → Customers → Customer Payments: the payment list, plus the open invoices a payment can be
// accepted against (the payment itself is recorded from the invoice, as NetSuite's transform does).
import { app, can, go, listIds, expand, register } from "../store.js";
import { el, errorBanner, emptyState, money, mdy, skeletonRows } from "../ui.js";
import { listShell, pagerStrip, setPageTitle, nsButton, pill, currencyOf } from "./common.js";

const COLUMNS = [
  { label: "Document Number" }, { label: "Date" }, { label: "Customer" }, { label: "Applied To" },
  { label: "Status" }, { label: "Amount", numeric: true }, { label: "Unapplied", numeric: true },
];

register("payments", async (main, route) => {
  setPageTitle("Customer Payments");
  const size = Number(route.params.get("size") ?? 25) || 25;
  const offset = Number(route.params.get("offset") ?? 0) || 0;
  const body = el("tbody", {}, skeletonRows(COLUMNS.length));
  const pagerHost = el("div", {});

  const apply = (patch) => {
    const params = new URLSearchParams();
    const next = { size, offset, ...patch };
    if (next.offset) params.set("offset", String(next.offset));
    if (next.size !== 25) params.set("size", String(next.size));
    const query = params.toString();
    go(`#/payments${query ? `?${query}` : ""}`);
  };

  main.replaceChildren(listShell({
    title: "Customer Payments",
    subtitle: can("TRAN_CUSTPYMT", "create") ? "Open an invoice and choose Accept Payment to record a new payment." : undefined,
    actions: [nsButton("Customize View"), nsButton("Export")],
    columns: COLUMNS,
    body,
    pager: pagerHost,
  }));

  try {
    const page = await listIds("customer-payment.list", { limit: size, offset });
    const rows = await expand("customer-payment.get", page.ids, { expandSubResources: true });
    if (rows.length === 0) {
      body.replaceChildren(el("tr", {}, el("td", { colspan: String(COLUMNS.length) },
        emptyState("No customer payments yet.", "Accept a payment from an open invoice to create one."))));
    } else {
      body.replaceChildren(...rows.map((record) => {
        const currency = currencyOf(record);
        const applied = (record.apply?.items ?? []).map((entry) => entry.refName ?? entry.doc).join(", ");
        return el("tr", {}, [
          el("td", { text: record.tranId }),
          el("td", { class: "tight", text: mdy(record.tranDate) }),
          el("td", {}, el("a", { href: `#/customers/${encodeURIComponent(record.customer?.id ?? "")}`, text: record.customer?.refName ?? "" })),
          el("td", { text: applied }),
          el("td", {}, pill(record.status)),
          el("td", { class: "num", text: money(record.payment, currency) }),
          el("td", { class: "num", text: money(record.unapplied, currency) }),
        ]);
      }));
    }
    pagerHost.replaceChildren(pagerStrip({
      offset: page.offset, shown: rows.length, total: page.totalResults, hasMore: page.hasMore, pageSize: size,
      onOffset: (next) => apply({ offset: next }), onPageSize: (next) => apply({ size: next, offset: 0 }),
    }));
  } catch (error) {
    body.replaceChildren(el("tr", {}, el("td", { colspan: String(COLUMNS.length) }, errorBanner(error, "The payment list could not be loaded"))));
  }
});
