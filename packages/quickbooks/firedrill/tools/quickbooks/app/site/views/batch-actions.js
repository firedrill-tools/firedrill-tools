// Batch action menus for the invoice, customer and product lists. Every simulated action runs one call per selected row.
import { call, confirmDialog, describe, dialog, el, newKey, notSimulated, toast } from "../ui.js";
import { runBatch } from "./batch.js";

function resultDialog(title, rows) {
  const holder = el("div");
  const { close } = dialog({ title, wide: true, body: holder, actions: [{ label: "Close", kind: "primary", run: (c) => c() }] });
  void rows;
  return { holder, close };
}

const invLabel = (inv) => `Invoice ${inv.DocNumber ?? inv.Id} · ${inv.CustomerRef?.name ?? ""}`;

async function batchPrint(rows) {
  const { holder } = resultDialog(`Print or download ${rows.length} transaction${rows.length > 1 ? "s" : ""}`, rows);
  await runBatch({
    box: holder, rows, label: invLabel, describeError: describe,
    run: async (inv) => {
      const out = await call("invoices.pdf", { invoice_id: inv.Id });
      const bytes = Uint8Array.from(atob(out.base64), (ch) => ch.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      return el("a", { href: url, download: `Invoice_${inv.DocNumber ?? inv.Id}.pdf`, text: `Download PDF (${Math.ceil(out.size_bytes / 1024)} KB)` });
    },
  });
}

async function batchSend(rows, refresh) {
  const ok = await confirmDialog(
    `Send ${rows.length} transaction${rows.length > 1 ? "s" : ""}?`,
    `QuickBooks will email ${rows.length} invoice${rows.length > 1 ? "s" : ""} to the address on each one. Firedrill records a synthetic send; no e-mail is delivered.`,
    "Send", "primary",
  );
  if (!ok) return;
  const { holder } = resultDialog(`Send ${rows.length} transaction${rows.length > 1 ? "s" : ""}`, rows);
  const sent = await runBatch({
    box: holder, rows, label: invLabel, describeError: describe,
    run: async (inv) => { await call("invoices.send", { invoice_id: inv.Id }, newKey()); return `Sent to ${inv.BillEmail?.Address ?? "the customer"}`; },
  });
  if (sent) toast(`${sent} of ${rows.length} invoice${rows.length > 1 ? "s" : ""} sent`);
  refresh?.();
}

async function batchDelete(rows, refresh) {
  const ok = await confirmDialog(
    `Delete ${rows.length} transaction${rows.length > 1 ? "s" : ""}?`,
    `Are you sure you want to delete ${rows.length} invoice${rows.length > 1 ? "s" : ""}? This can't be undone. Any payments applied to them are left unapplied.`,
    "Yes, delete", "danger",
  );
  if (!ok) return;
  const { holder } = resultDialog(`Delete ${rows.length} transaction${rows.length > 1 ? "s" : ""}`, rows);
  const gone = await runBatch({
    box: holder, rows, label: invLabel, describeError: describe,
    run: async (inv) => { await call("invoices.post", { operation: "delete", body: { Id: inv.Id, SyncToken: inv.SyncToken } }, newKey()); return "Deleted"; },
  });
  if (gone) toast(`${gone} of ${rows.length} invoice${rows.length > 1 ? "s" : ""} deleted`);
  refresh?.();
}

export function invoiceBatchActions(rows, refresh) {
  return [
    { label: `Print transactions (${rows.length})`, run: () => batchPrint(rows) },
    { label: `Send transactions (${rows.length})`, run: () => batchSend(rows, refresh) },
    { label: `Delete (${rows.length})`, run: () => batchDelete(rows, refresh) },
    { label: "Print packing slip", title: "Not simulated by this Tool", run: () => notSimulated("Packing slips") },
  ];
}

async function batchInactive(rows, refresh) {
  const ok = await confirmDialog(
    `Make ${rows.length} customer${rows.length > 1 ? "s" : ""} inactive?`,
    "Inactive customers are hidden from lists but their past transactions stay in your books. A customer with an open balance can't be made inactive.",
    "Yes, make inactive", "primary",
  );
  if (!ok) return;
  const { holder } = resultDialog(`Make ${rows.length} customer${rows.length > 1 ? "s" : ""} inactive`, rows);
  const done = await runBatch({
    box: holder, rows, label: (c) => c.DisplayName, describeError: describe,
    run: async (c) => { await call("customers.post", { body: { Id: c.Id, SyncToken: c.SyncToken, sparse: true, Active: false } }, newKey()); return "Made inactive"; },
  });
  if (done) toast(`${done} of ${rows.length} customer${rows.length > 1 ? "s" : ""} made inactive`);
  refresh?.();
}

export function customerBatchActions(rows, refresh) {
  return [
    { label: `Make inactive (${rows.length})`, run: () => batchInactive(rows, refresh) },
    { label: "Email", title: "Not simulated by this Tool", run: () => notSimulated("Batch email") },
    { label: "Create statements", title: "Not simulated by this Tool", run: () => notSimulated("Statements") },
  ];
}

async function setItemsActive(rows, active, refresh) {
  const verb = active ? "active" : "inactive";
  const ok = await confirmDialog(
    `Make ${rows.length} product${rows.length > 1 ? "s" : ""} or service${rows.length > 1 ? "s" : ""} ${verb}?`,
    active ? "They will appear again on invoices and in lists." : "Inactive products and services stay on past transactions but can't be added to new ones.",
    `Yes, make ${verb}`, "primary",
  );
  if (!ok) return;
  const { holder } = resultDialog(`Make ${rows.length} item${rows.length > 1 ? "s" : ""} ${verb}`, rows);
  const done = await runBatch({
    box: holder, rows, label: (it) => it.Name, describeError: describe,
    run: async (it) => { await call("items.post", { body: { Id: it.Id, SyncToken: it.SyncToken, sparse: true, Name: it.Name, Type: it.Type, Active: active } }, newKey()); return `Now ${verb}`; },
  });
  if (done) toast(`${done} of ${rows.length} now ${verb}`);
  refresh?.();
}

export function itemBatchActions(rows, refresh) {
  return [
    { label: `Make active (${rows.length})`, run: () => setItemsActive(rows, true, refresh) },
    { label: `Make inactive (${rows.length})`, run: () => setItemsActive(rows, false, refresh) },
    { label: "Reclassify", title: "Not simulated by this Tool", run: () => notSimulated("Reclassify") },
    { label: "Assign category", title: "Not simulated by this Tool", run: () => notSimulated("Categories") },
  ];
}
