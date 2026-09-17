// Batch detail: summary strip, quote expiry (virtual time), payments table with search and paging, batch actions.
import { app, go, setTitle } from "./app.js";
import { deleteBatch, generateQuote, openPaymentForm, processBatch, removePayment, reviewSummary } from "./batch-actions.js";
import { dataTable, errorBlock, pager, searchBox, stateBlock } from "./list.js";
import { btn, call, date, el, human, initials, money, pill } from "./ui.js";

function quoteText(batch) {
  if (!batch.quoteExpiredAt) return "No quote";
  const ms = Date.parse(batch.quoteExpiredAt) - Date.parse(app.now ?? "");
  if (Number.isNaN(ms)) return `Expires ${date(batch.quoteExpiredAt, true)}`;
  if (ms <= 0) return "Quote expired";
  const minutes = Math.floor(ms / 60000);
  return minutes >= 60 ? `Expires in ${Math.floor(minutes / 60)}h ${minutes % 60}m` : `Expires in ${minutes}m`;
}

export async function renderBatch(host, route, view) {
  setTitle("Payments");
  host.replaceChildren(el("div", { class: "card card-body" }, el("div", { class: "skeleton" })));
  let batch;
  try {
    batch = (await call("batches.get", { batchId: route.id })).batch;
  } catch (error) {
    if (!view.isCurrent()) return;
    host.replaceChildren(crumbs(route.id), el("section", { class: "card" }, error.is?.("NOT_FOUND") ? stateBlock("money", "Batch not found", "It may have been deleted.") : errorBlock(error, () => go("payments", route.id))));
    return;
  }
  if (!view.isCurrent()) return;
  const open = batch.status === "open";
  const reload = () => go("payments", batch.id);
  const state = { page: 1, pageSize: 10, search: "" };

  const strip = el("section", { class: "card summary-strip" }, [
    ["Status", pill(batch.status)], ["Total amount", money(batch.amount, batch.currency)], ["Payments", String(batch.totalPayments)], ["Quote", quoteText(batch)],
  ].map(([label, value]) => el("div", {}, [el("div", { class: "label", text: label }), el("div", { class: "value" }, value)])));

  const actions = el("div", { class: "toolbar" }, [
    searchBox("Search recipient, email or memo", "", (value) => { state.search = value; state.page = 1; void load(); }),
    el("span", { class: "spacer" }),
    open ? btn("Add payment", "secondary", { icon: "plus", onClick: () => openPaymentForm(batch, undefined, reload) }) : null,
    open ? btn("Generate quote", "secondary", { onClick: () => generateQuote(batch, reload) }) : null,
    btn("Review", "secondary", { onClick: () => reviewSummary(batch) }),
    open ? btn("Process batch", "primary", { disabled: batch.totalPayments === 0, onClick: () => processBatch(batch, reload) }) : null,
    open ? btn("", "secondary", { icon: "close", label: "Delete batch", title: "Delete batch", onClick: () => deleteBatch(batch) }) : null,
  ]);

  const table = dataTable([
    { label: "Recipient", cell: (p) => el("div", { class: "who" }, [el("span", { class: "face", text: initials(p.recipient?.name), attrs: { "aria-hidden": "true" } }), el("div", {}, [el("a", { text: p.recipient?.name || p.recipient?.id, attrs: { href: `#/recipients/${encodeURIComponent(p.recipient?.id ?? "")}` } }), el("div", { class: "sub", text: p.recipient?.email ?? "" })])]) },
    { label: "Amount", num: true, cell: (p) => money(p.sourceAmount, p.sourceCurrency) },
    { label: "Recipient gets", num: true, cell: (p) => el("div", {}, [el("div", { text: p.targetAmount ? `${money(p.targetAmount, p.targetCurrency)} ${p.targetCurrency}` : "Quote required" }), p.sourceCurrency !== p.targetCurrency ? el("div", { class: "sub", text: `rate ${p.exchangeRate}` }) : null]) },
    { label: "Fees", num: true, cell: (p) => money(p.fees, p.sourceCurrency) },
    { label: "Method", cell: (p) => (p.payoutMethod ? human(p.payoutMethod) : "—") },
    { label: "Status", cell: (p) => el("div", {}, [pill(p.status), p.failureMessage ? el("div", { class: "sub", text: p.failureMessage }) : null]) },
    { label: "", cell: (p) => (open && p.status === "pending" ? el("div", { class: "row-actions" }, [
      btn("Edit", "link", { small: true, onClick: () => openPaymentForm(batch, p, reload) }),
      btn("Remove", "link", { small: true, onClick: () => removePayment(batch, p, reload) }),
    ]) : "") },
  ]);
  const pagerHost = el("div");
  const meta = el("div", { class: "method-sub", text: `${batch.id} · ${batch.currency} · created ${date(batch.createdAt, true)}${batch.sentAt ? ` · sent ${date(batch.sentAt, true)}` : ""}${batch.completedAt ? ` · completed ${date(batch.completedAt, true)}` : ""}` });
  const heading = el("div", { class: "profile-head" }, [el("div", {}, [el("h2", { text: batch.description || "Untitled batch" }), meta])]);
  const banner = batch.status === "failed" ? el("div", { class: "banner banner-error", attrs: { role: "status" } }, el("span", { text: "This batch failed to process. Payment rows show each failure message." }))
    : !open ? el("div", { class: "banner banner-info" }, el("span", { text: "This batch has been sent. Payments can no longer be edited." })) : "";

  host.replaceChildren(crumbs(batch.description || batch.id), heading, banner, strip, el("div", { class: "spacer-16" }), actions, el("section", { class: "card" }, [table.node, pagerHost]));

  async function load() {
    table.setLoading();
    const args = { batchId: batch.id, page: state.page, pageSize: state.pageSize };
    if (state.search) args.search = state.search;
    try {
      const value = await call("payments.list", args);
      if (!view.isCurrent()) return;
      table.setRows(value.payments, state.search ? stateBlock("search", "No payments match", "Try a different search.") : stateBlock("money", "No payments in this batch", open ? "Add a payment to get started." : ""));
      pagerHost.replaceChildren(pager(value.meta, state.pageSize, (next) => { Object.assign(state, next); void load(); }));
    } catch (error) {
      if (!view.isCurrent()) return;
      pagerHost.replaceChildren();
      table.setError(error, () => void load());
    }
  }
  await load();
}

function crumbs(label) {
  return el("nav", { class: "crumbs", attrs: { "aria-label": "Breadcrumb" } }, [el("a", { text: "Payments", attrs: { href: "#/payments" } }), el("span", { text: "›" }), el("span", { text: label })]);
}
