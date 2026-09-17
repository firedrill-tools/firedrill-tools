// Recipients list: search, status/payout-method/country filters, sortable columns, paging, Add recipient.
import { app, go, setParams, setTitle } from "./app.js";
import { dataTable, pager, searchBox, stateBlock, tabs } from "./list.js";
import { btn, call, date, describe, el, field, human, initials, input, newKey, openModal, pill, select, showFieldError, toast } from "./ui.js";

const STATUS_TABS = [["", "All"], ["active", "Active"], ["incomplete", "Incomplete"], ["disabled", "Disabled"], ["blocked", "Blocked"], ["archived", "Archived"]];
const METHODS = [["", "Any payout method"], ["bank-transfer", "Bank transfer"], ["paypal", "PayPal"], ["check", "Check"], ["venmo", "Venmo"]];

export function recipientCell(r) {
  return el("div", { class: "who" }, [
    el("span", { class: `face${r.type === "business" ? " biz" : ""}`, text: initials(r.name), attrs: { "aria-hidden": "true" } }),
    el("div", {}, [el("div", { text: r.name || "(no name)" }), el("div", { class: "sub", text: r.email ?? "" })]),
  ]);
}

export async function renderRecipients(host, route, view) {
  setTitle("Recipients");
  const state = {
    page: Number(route.params.page) || 1, pageSize: Number(route.params.pageSize) || 10, search: route.params.search ?? "",
    status: route.params.status ?? "", payoutMethod: route.params.payoutMethod ?? "", country: route.params.country ?? "",
    orderBy: route.params.orderBy ?? "createdAt", sortBy: route.params.sortBy ?? "desc",
  };
  const table = dataTable([
    { label: "Name", key: "name", cell: recipientCell },
    { label: "Reference ID", key: "referenceId", cell: (r) => el("span", { class: "mono", text: r.referenceId ?? "—" }) },
    { label: "Payout method", key: "payoutMethod", cell: (r) => (r.payoutMethod ? human(r.payoutMethod) : "—") },
    { label: "Country", cell: (r) => (r.address?.country ? el("span", { class: "flag", text: r.address.country }) : "—") },
    { label: "Status", cell: (r) => pill(r.status) },
    { label: "Created", key: "createdAt", cell: (r) => date(r.createdAt) },
  ], {
    onRowClick: (r) => go("recipients", r.id),
    sort: state,
    onSort: (key) => { state.sortBy = state.orderBy === key && state.sortBy === "asc" ? "desc" : "asc"; state.orderBy = key; state.page = 1; void load(); },
  });
  const pagerHost = el("div");
  const tabHost = el("div");
  const countryInput = el("input", { class: "input", attrs: { placeholder: "Country (US, CA)", "aria-label": "Country filter", value: state.country, size: 20 } });
  countryInput.addEventListener("change", () => { state.country = countryInput.value.trim().toUpperCase(); state.page = 1; void load(); });
  const methodSelect = select("payoutMethod", METHODS, state.payoutMethod);
  methodSelect.setAttribute("aria-label", "Payout method filter");
  methodSelect.addEventListener("change", () => { state.payoutMethod = methodSelect.value; state.page = 1; void load(); });
  const toolbar = el("div", { class: "toolbar" }, [
    searchBox("Search name, email or reference ID", state.search, (value) => { state.search = value; state.page = 1; void load(); }),
    methodSelect, countryInput, el("span", { class: "spacer" }),
    btn("Add recipient", "primary", { icon: "plus", onClick: () => openCreate() }),
  ]);
  host.replaceChildren(el("div", {}, [tabHost, toolbar, el("section", { class: "card" }, [table.node, pagerHost])]));

  function drawTabs() {
    tabHost.replaceChildren(tabs(STATUS_TABS, state.status, (value) => { state.status = value; state.page = 1; drawTabs(); void load(); }));
  }
  drawTabs();

  async function load() {
    setParams("recipients", { ...state, page: state.page === 1 ? "" : state.page, pageSize: state.pageSize === 10 ? "" : state.pageSize, orderBy: state.orderBy === "createdAt" ? "" : state.orderBy, sortBy: state.sortBy === "desc" ? "" : state.sortBy });
    table.setLoading();
    const args = { page: state.page, pageSize: state.pageSize, orderBy: state.orderBy, sortBy: state.sortBy };
    for (const key of ["search", "status", "payoutMethod", "country"]) if (state[key]) args[key] = state[key];
    try {
      const value = await call("recipients.list", args);
      if (!view.isCurrent()) return;
      const filtered = state.search || state.status || state.payoutMethod || state.country;
      table.setRows(value.recipients, filtered ? stateBlock("search", "No recipients match these filters", "Try a different search or clear the filters.") : stateBlock("user", "No recipients yet", "Add a recipient to start paying them."));
      pagerHost.replaceChildren(pager(value.meta, state.pageSize, (next) => { Object.assign(state, next); void load(); }));
    } catch (error) {
      if (!view.isCurrent()) return;
      pagerHost.replaceChildren();
      table.setError(error, () => void load());
    }
  }
  await load();
}

export function openCreate() {
  let type = "individual";
  const form = el("form", { class: "form-grid", attrs: { novalidate: true } });
  const typeSelect = select("type", [["individual", "Individual"], ["business", "Business"]], type);
  const names = el("div", { class: "field-full form-grid" });
  const drawNames = () => names.replaceChildren(...(type === "individual"
    ? [field("First name", input("firstName", "", { autocomplete: "off" })), field("Last name", input("lastName", "", { autocomplete: "off" }))]
    : [field("Business name", input("name", "", { autocomplete: "off" }), { full: true })]));
  typeSelect.addEventListener("change", () => { type = typeSelect.value; drawNames(); });
  drawNames();
  form.append(
    field("Recipient type", typeSelect, { full: true }), names,
    field("Email", input("email", "", { type: "email", autocomplete: "off" })), field("Reference ID", input("referenceId"), { hint: "Your own identifier (optional)" }),
    field("Street address", input("street1"), { full: true }), field("City", input("city")), field("Region / state", input("region")),
    field("Postal code", input("postalCode")), field("Country code", input("country", "US", { maxlength: 2 })),
  );
  const formError = el("div", { class: "form-error", attrs: { role: "alert" } });
  const submit = btn("Create recipient", "primary");
  const key = newKey();
  app.editing += 1;
  const modal = openModal({ title: "Add recipient", body: [el("p", { text: "Recipients receive payouts. Address and a payout method complete their profile." }), form, formError], actions: [btn("Cancel", "secondary", { onClick: () => modal.close() }), submit], onClose: () => { app.editing -= 1; }, wide: true });
  submit.addEventListener("click", async () => {
    const data = Object.fromEntries(new FormData(form).entries());
    const args = { type, email: data.email.trim() };
    if (type === "individual") { args.firstName = data.firstName.trim(); args.lastName = data.lastName.trim(); } else args.name = data.name.trim();
    if (data.referenceId.trim()) args.referenceId = data.referenceId.trim();
    const address = {};
    for (const k of ["street1", "city", "region", "postalCode", "country"]) if (data[k].trim()) address[k] = k === "country" ? data[k].trim().toUpperCase() : data[k].trim();
    if (Object.keys(address).length) args.address = address;
    submit.disabled = true;
    formError.textContent = "";
    try {
      const value = await call("recipients.create", args, key);
      modal.close();
      toast(`Recipient ${value.recipient.name} was created.`);
      go("recipients", value.recipient.id);
    } catch (error) {
      if (!showFieldError(form, error)) formError.textContent = describe(error);
      submit.disabled = false;
    }
  });
}
