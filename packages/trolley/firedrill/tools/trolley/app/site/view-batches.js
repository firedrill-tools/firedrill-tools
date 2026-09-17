// Payments: batch list with status tabs, search, sorting, paging and Create batch.
import { app, go, setParams, setTitle } from "./app.js";
import { dataTable, pager, searchBox, stateBlock, tabs } from "./list.js";
import { btn, call, date, describe, el, field, input, money, newKey, openModal, pill, select, showFieldError, toast } from "./ui.js";

const STATUS_TABS = [["", "All"], ["open", "Open"], ["processing", "Processing"], ["complete", "Complete"], ["failed", "Failed"]];

export async function renderBatches(host, route, view) {
  setTitle("Payments");
  const state = { page: Number(route.params.page) || 1, pageSize: Number(route.params.pageSize) || 10, status: route.params.status ?? "", search: route.params.search ?? "", orderBy: route.params.orderBy ?? "createdAt", sortBy: route.params.sortBy ?? "desc" };
  const table = dataTable([
    { label: "Batch", cell: (b) => el("div", {}, [el("div", { text: b.description || "Untitled batch" }), el("div", { class: "sub mono", text: b.id })]) },
    { label: "Payments", num: true, cell: (b) => String(b.totalPayments) },
    { label: "Amount", key: "amount", num: true, cell: (b) => money(b.amount, b.currency) },
    { label: "Currency", cell: (b) => b.currency },
    { label: "Status", cell: (b) => pill(b.status) },
    { label: "Created", key: "createdAt", cell: (b) => date(b.createdAt) },
    { label: "Sent", key: "sentAt", cell: (b) => date(b.sentAt) },
  ], { onRowClick: (b) => go("payments", b.id), sort: state, onSort: (key) => { state.sortBy = state.orderBy === key && state.sortBy === "asc" ? "desc" : "asc"; state.orderBy = key; state.page = 1; void load(); } });
  const pagerHost = el("div");
  const tabHost = el("div");
  host.replaceChildren(el("div", {}, [
    tabHost,
    el("div", { class: "toolbar" }, [searchBox("Search batches", state.search, (value) => { state.search = value; state.page = 1; void load(); }), el("span", { class: "spacer" }), btn("Create batch", "primary", { icon: "plus", onClick: openCreateBatch })]),
    el("section", { class: "card" }, [table.node, pagerHost]),
  ]));
  const drawTabs = () => tabHost.replaceChildren(tabs(STATUS_TABS, state.status, (value) => { state.status = value; state.page = 1; drawTabs(); void load(); }));
  drawTabs();

  async function load() {
    setParams("payments", { status: state.status, search: state.search, page: state.page === 1 ? "" : state.page, pageSize: state.pageSize === 10 ? "" : state.pageSize, orderBy: state.orderBy === "createdAt" ? "" : state.orderBy, sortBy: state.sortBy === "desc" ? "" : state.sortBy });
    table.setLoading();
    const args = { page: state.page, pageSize: state.pageSize, orderBy: state.orderBy, sortBy: state.sortBy };
    if (state.status) args.status = state.status;
    if (state.search) args.search = state.search;
    try {
      const value = await call("batches.list", args);
      if (!view.isCurrent()) return;
      table.setRows(value.batches, state.search || state.status ? stateBlock("search", "No batches match", "Try another tab or search.") : stateBlock("money", "No payment batches yet", "Create a batch to pay recipients."));
      pagerHost.replaceChildren(pager(value.meta, state.pageSize, (next) => { Object.assign(state, next); void load(); }));
    } catch (error) {
      if (!view.isCurrent()) return;
      pagerHost.replaceChildren();
      table.setError(error, () => void load());
    }
  }
  await load();
}

function openCreateBatch() {
  const form = el("form", { class: "form-grid", attrs: { novalidate: true } }, [
    field("Description", input("description", "", { autocomplete: "off" }), { full: true }),
    field("Source currency", select("currency", ["USD", "CAD", "EUR", "GBP", "AUD", "MXN"].map((c) => [c, c]), "USD")),
    field("Tags", input("tags"), { hint: "Comma separated (optional)" }),
  ]);
  const formError = el("div", { class: "form-error", attrs: { role: "alert" } });
  const save = btn("Create batch", "primary");
  const key = newKey();
  app.editing += 1;
  const modal = openModal({ title: "Create payment batch", body: [el("p", { text: "A batch groups payments that are quoted and processed together." }), form, formError], actions: [btn("Cancel", "secondary", { onClick: () => modal.close() }), save], onClose: () => { app.editing -= 1; } });
  save.addEventListener("click", async () => {
    const d = Object.fromEntries(new FormData(form).entries());
    const args = { currency: d.currency };
    if (d.description.trim()) args.description = d.description.trim();
    const tags = d.tags.split(",").map((t) => t.trim()).filter(Boolean);
    if (tags.length) args.tags = tags;
    save.disabled = true;
    try {
      const value = await call("batches.create", args, key);
      modal.close();
      toast("Batch created. Add payments to it.");
      go("payments", value.batch.id);
    } catch (error) {
      if (!showFieldError(form, error)) formError.textContent = describe(error);
      save.disabled = false;
    }
  });
}
