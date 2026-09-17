// The customer record page: NetSuite's subtab layout (Primary Information, Address, Financial,
// Transactions, System Information) with Edit, Delete and the related-transaction sublists.
import { app, can, go, listIds, expand, register, remember } from "../store.js";
import { call, el, errorBanner, money, mdy, describe, newKey, toast, lit } from "../ui.js";
import { confirmDialog, openMenu } from "../overlay.js";
import {
  recordShell, recordButtons, subtabStrip, fieldGroup, kvColumns, kv, setPageTitle,
  toolbarButton, nsButton, pill, currencyOf,
} from "./common.js";
import { openCustomerForm } from "./customer-form.js";

const TABS = ["Primary Information", "Address", "Financial", "Transactions", "System Information"];

function addressCard(entry) {
  const address = entry.addressBookAddress ?? {};
  const lines = [address.addressee, address.addr1, address.addr2,
    [address.city, address.state, address.zip].filter(Boolean).join(" "), address.country?.refName]
    .filter((line) => line !== undefined && line !== null && line !== "");
  return el("div", { class: "fieldgroup" }, [
    el("h3", { text: `${entry.label ?? "Address"}${entry.defaultBilling ? " · Default Billing" : ""}${entry.defaultShipping ? " · Default Shipping" : ""}` }),
    el("div", { class: "fg-body" }, lines.map((line) => el("div", { text: line }))),
  ]);
}

async function transactionsTab(node, customer) {
  const blocks = [];
  if (can("TRAN_SALESORD")) blocks.push(["Sales Orders", "sales-order.list", "sales-order.get", "#/orders/"]);
  if (can("TRAN_CUSTINVC")) blocks.push(["Invoices", "invoice.list", "invoice.get", "#/invoices/"]);
  if (blocks.length === 0) {
    node.replaceChildren(el("p", { class: "muted", text: "This role cannot view transactions." }));
    return;
  }
  node.replaceChildren(el("p", { class: "muted", text: "Loading transactions…" }));
  const sections = [];
  for (const [title, listOperation, getOperation, base] of blocks) {
    try {
      const page = await listIds(listOperation, { q: `entity ANY_OF [${customer.id}]`, limit: 10, offset: 0 });
      const rows = await expand(getOperation, page.ids);
      const currency = currencyOf(customer);
      sections.push(el("section", { class: "sublist" }, [
        el("header", {}, [el("h3", { text: title }), el("span", { class: "grow" }),
          el("span", { class: "muted", text: `${rows.length} of ${page.totalResults}` })]),
        el("div", { class: "tablewrap" }, el("table", { class: "grid" }, [
          el("thead", {}, el("tr", {}, ["Document Number", "Date", "Status", "Amount"].map((label, index) =>
            el("th", { scope: "col", class: index === 3 ? "num" : "", text: label })))),
          el("tbody", {}, rows.length === 0
            ? [el("tr", {}, el("td", { colspan: "4", class: "muted", text: `No ${title.toLowerCase()} for this customer.` }))]
            : rows.map((row) => el("tr", {}, [
                el("td", {}, el("a", { href: `${base}${encodeURIComponent(row.id)}`, text: row.tranId })),
                el("td", { class: "tight", text: mdy(row.tranDate) }),
                el("td", {}, pill(row.status)),
                el("td", { class: "num", text: money(row.total, currency) }),
              ]))),
        ])),
      ]));
    } catch (error) {
      sections.push(errorBanner(error, `${title} could not be loaded`));
    }
  }
  node.replaceChildren(...sections);
}

register("customer", async (main, route) => {
  const id = route.id;
  let record;
  try {
    record = await call("customer.get", { recordId: id, expandSubResources: true });
  } catch (error) {
    main.replaceChildren(errorBanner(error, "This customer could not be opened"));
    return;
  }
  const name = record.entityId ?? record.companyName ?? record.id;
  setPageTitle(name);
  remember({ label: `Customer: ${name}`, href: `#/customers/${encodeURIComponent(record.id)}` });
  const currency = currencyOf(record);
  let tab = TABS.includes(route.params.get("tab")) ? route.params.get("tab") : TABS[0];
  const panel = el("div", {});

  function paint() {
    if (tab === "Primary Information") {
      panel.replaceChildren(fieldGroup("Primary Information", kvColumns(
        [kv("Customer ID", record.entityId), kv("Company Name", record.companyName ?? ""), kv("Individual", record.isPerson ? "Yes" : "No"),
          kv("Email", record.email ? el("a", { href: `mailto:${record.email}`, text: record.email }) : "")],
        [kv("Phone", record.phone ?? ""), kv("Subsidiary", record.subsidiary?.refName ?? ""), kv("Primary Currency", currency),
          kv("Status", record.isInactive ? "Inactive" : "Active")],
      )), ...(record.comments ? [fieldGroup("Comments", el("div", { text: record.comments }))] : []));
    } else if (tab === "Address") {
      const entries = record.addressBook?.items ?? [];
      panel.replaceChildren(...(entries.length ? entries.map(addressCard) : [el("p", { class: "muted", text: "No addresses on this customer." })]));
    } else if (tab === "Financial") {
      panel.replaceChildren(fieldGroup("Financial", kvColumns(
        [kv("Terms", record.terms?.refName ?? "— None —"), kv("Credit Limit", record.creditLimit === undefined ? "" : money(record.creditLimit, currency))],
        [kv("Balance", money(record.balance, currency)), kv("Unbilled Orders", money(record.unbilledOrders, currency)),
          kv("Overdue Balance", el("span", { class: Number(record.overdueBalance) > 0 ? "overdue" : "", text: money(record.overdueBalance, currency) }))],
      )));
    } else if (tab === "Transactions") {
      transactionsTab(panel, record);
    } else {
      panel.replaceChildren(fieldGroup("System Information", kvColumns(
        [kv("Internal ID", record.id), kv("Date Created", mdy(record.dateCreated))],
        [kv("Last Modified", mdy(record.lastModifiedDate)), kv("Record Type", "customer")],
      )));
    }
  }

  async function remove() {
    const confirmed = await confirmDialog(
      "Delete Customer",
      `Delete ${name}? NetSuite refuses to delete a customer that has transactions.`,
      "Delete",
      "danger",
    );
    if (!confirmed) return;
    try {
      await call("customer.delete", { recordId: record.id }, newKey());
      toast(`${name} was deleted.`);
      go("#/customers");
    } catch (error) {
      main.prepend(errorBanner(error, "This customer could not be deleted"));
    }
  }

  const actionsButton = el("button", { type: "button", class: "btn", "aria-haspopup": "true", "aria-expanded": "false", text: "Actions ▾" });
  actionsButton.addEventListener("click", (event) => {
    event.stopPropagation();
    openMenu(actionsButton, [
      { label: "Delete", run: remove, disabled: !can("LIST_CUSTJOB", "full") },
      { label: "Make Inactive" },
      { label: "Merge" },
      { label: "New Sales Order", run: () => go(`#/orders/new?entity=${encodeURIComponent(record.id)}`) },
    ]);
  });

  main.replaceChildren(recordShell({
    title: name,
    subtitle: `Customer · internal id ${record.id} · ${record.subsidiary?.refName ?? ""}`,
    actions: recordButtons({
      onEdit: () => openCustomerForm(record, { onSaved: () => go(`#/customers/${encodeURIComponent(record.id)}`) }),
      editDisabled: !can("LIST_CUSTJOB", "edit"),
      onBack: () => go("#/customers"),
      actions: [actionsButton],
    }),
    subtabs: subtabStrip(TABS, tab, (next) => { tab = next; paint(); }),
    body: panel,
  }));
  paint();
});
