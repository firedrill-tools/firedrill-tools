// The invoice record page: totals, the Items sublist, applied payments and the Accept Payment action,
// which runs the !transform to a customer payment.
import { app, can, go, listIds, expand, register, remember, isOverdue } from "../store.js";
import { call, el, errorBanner, money, qty, mdy, newKey, toast, describe } from "../ui.js";
import { dialog, openMenu } from "../overlay.js";
import {
  recordShell, recordButtons, subtabStrip, fieldGroup, kvColumns, kv, totalsBlock,
  setPageTitle, toolbarButton, pill, currencyOf,
} from "./common.js";

const TABS = ["Items", "Payments", "System Information"];

function openPaymentDialog(record, currency, refresh) {
  const remaining = Number(record.amountRemaining) || 0;
  const amountInput = el("input", { type: "number", id: "pay-amount", min: "0", step: "0.01", max: String(remaining), value: remaining.toFixed(2) });
  const dateInput = el("input", { type: "date", id: "pay-date", value: app.today });
  const memoInput = el("input", { type: "text", id: "pay-memo", maxlength: "999" });
  const errorHost = el("div", {});
  let key = newKey();
  let busy = false;
  dialog({
    title: `Accept Customer Payment — ${record.tranId}`,
    body: [
      errorHost,
      el("p", { text: `${record.entity?.refName ?? "This customer"} owes ${money(remaining, currency)} on this invoice.` }),
      el("div", { class: "formgrid" }, [
        el("div", { class: "field" }, [el("label", { class: "fl", for: "pay-amount", text: "Payment Amount" }), amountInput]),
        el("div", { class: "field" }, [el("label", { class: "fl", for: "pay-date", text: "Date" }), dateInput]),
        el("div", { class: "field" }, [el("label", { class: "fl", for: "pay-memo", text: "Memo" }), memoInput]),
      ]),
    ],
    actions: [
      { label: "Cancel", run: (close) => close() },
      {
        label: "Save Payment",
        kind: "primary",
        run: async (close) => {
          if (busy) return;
          busy = true;
          errorHost.replaceChildren();
          const amount = Number(amountInput.value);
          if (!Number.isFinite(amount) || amount <= 0) {
            errorHost.replaceChildren(errorBanner(new Error("The payment amount must be greater than zero."), "Invalid amount"));
            busy = false;
            return;
          }
          if (amount > remaining + 0.005) {
            errorHost.replaceChildren(errorBanner(new Error(`The applied amount cannot exceed the invoice balance of ${remaining}.`), "Amount too large"));
            busy = false;
            return;
          }
          try {
            const body = { payment: amount, tranDate: dateInput.value };
            if (memoInput.value.trim() !== "") body.memo = memoInput.value.trim();
            const result = await call("invoice.transform", {
              recordId: record.id, target: "customerPayment", transformMarker: "!transform", body,
            }, key);
            toast(`Customer payment recorded (internal id ${result.id}).`);
            close();
            refresh();
          } catch (error) {
            key = newKey();
            errorHost.replaceChildren(errorBanner(error, "This payment could not be recorded"));
          } finally {
            busy = false;
          }
        },
      },
    ],
  });
}

async function paymentsPanel(node, record, currency) {
  node.replaceChildren(el("p", { class: "muted", text: "Loading payments…" }));
  try {
    const page = await listIds("customer-payment.list", { q: `customer ANY_OF [${record.entity?.id ?? 0}]`, limit: 25, offset: 0 });
    const rows = await expand("customer-payment.get", page.ids, { expandSubResources: true });
    const applied = rows.filter((payment) => (payment.apply?.items ?? []).some((entry) => String(entry.doc) === String(record.id)));
    node.replaceChildren(el("section", { class: "sublist" }, [
      el("header", {}, [el("h3", { text: "Payments Applied" })]),
      el("div", { class: "tablewrap" }, el("table", { class: "grid" }, [
        el("thead", {}, el("tr", {}, ["Payment", "Date", "Applied", "Payment Total", "Status"].map((label, index) =>
          el("th", { scope: "col", class: index === 2 || index === 3 ? "num" : "", text: label })))),
        el("tbody", {}, applied.length === 0
          ? [el("tr", {}, el("td", { colspan: "5", class: "muted", text: "No payments have been applied to this invoice." }))]
          : applied.map((payment) => {
              const entry = (payment.apply?.items ?? []).find((item) => String(item.doc) === String(record.id));
              return el("tr", {}, [
                el("td", { text: payment.tranId }),
                el("td", { class: "tight", text: mdy(payment.tranDate) }),
                el("td", { class: "num", text: money(entry?.amount ?? 0, currency) }),
                el("td", { class: "num", text: money(payment.payment, currency) }),
                el("td", {}, pill(payment.status)),
              ]);
            })),
      ])),
    ]));
  } catch (error) {
    node.replaceChildren(errorBanner(error, "Payments could not be loaded"));
  }
}

register("invoice", async (main, route) => {
  let record;
  try {
    record = await call("invoice.get", { recordId: route.id, expandSubResources: true });
  } catch (error) {
    main.replaceChildren(errorBanner(error, "This invoice could not be opened"));
    return;
  }
  setPageTitle(`Invoice ${record.tranId}`);
  remember({ label: `Invoice: ${record.tranId}`, href: `#/invoices/${encodeURIComponent(record.id)}` });
  const currency = currencyOf(record);
  const refresh = () => go(`#/invoices/${encodeURIComponent(record.id)}`);
  let tab = TABS[0];
  const panel = el("div", {});

  function paint() {
    if (tab === "Items") {
      const lines = record.item?.items ?? [];
      panel.replaceChildren(
        el("section", { class: "sublist" }, [
          el("header", {}, [el("h3", { text: "Items" }), el("span", { class: "grow" }), el("span", { class: "muted", text: `${lines.length} line${lines.length === 1 ? "" : "s"}` })]),
          el("div", { class: "tablewrap" }, el("table", { class: "grid" }, [
            el("thead", {}, el("tr", {}, ["Line", "Item", "Description", "Quantity", "Rate", "Amount"].map((label, index) =>
              el("th", { scope: "col", class: index >= 3 ? "num" : "", text: label })))),
            el("tbody", {}, lines.map((line) => el("tr", {}, [
              el("td", { class: "tight num", text: String(line.line) }),
              el("td", { text: line.item?.refName ?? "" }),
              el("td", { text: line.description ?? "" }),
              el("td", { class: "num", text: qty(line.quantity) }),
              el("td", { class: "num", text: money(line.rate, currency) }),
              el("td", { class: "num", text: money(line.amount, currency) }),
            ]))),
          ])),
        ]),
        totalsBlock([
          ["Subtotal", money(record.subtotal, currency)],
          ["Tax Total", money(record.taxTotal, currency)],
          ["Total", money(record.total, currency), true],
          ["Amount Paid", money(record.amountPaid, currency)],
          ["Amount Remaining", money(record.amountRemaining, currency), true],
        ]),
      );
    } else if (tab === "Payments") {
      paymentsPanel(panel, record, currency);
    } else {
      panel.replaceChildren(fieldGroup("System Information", kvColumns(
        [kv("Internal ID", record.id), kv("Created", mdy(record.createdDate)), kv("Created From", record.createdFrom
          ? el("a", { href: `#/orders/${encodeURIComponent(record.createdFrom.id)}`, text: record.createdFrom.refName })
          : "— None —")],
        [kv("Last Modified", mdy(record.lastModifiedDate)), kv("Record Type", "invoice")],
      )));
    }
  }

  const canPay = can("TRAN_CUSTPYMT", "create") && String(record.status?.refName) === "Open" && Number(record.amountRemaining) > 0;
  const actionsButton = el("button", { type: "button", class: "btn", "aria-haspopup": "true", "aria-expanded": "false", text: "Actions ▾" });
  actionsButton.addEventListener("click", (event) => {
    event.stopPropagation();
    openMenu(actionsButton, [
      { label: "Accept Payment", run: () => openPaymentDialog(record, currency, refresh), disabled: !canPay },
      { label: "Void" },
      { label: "Make Copy" },
      { label: "Credit Memo" },
    ]);
  });

  main.replaceChildren(recordShell({
    title: `Invoice #${record.tranId}`,
    subtitle: `${record.entity?.refName ?? ""} · ${mdy(record.tranDate)} · ${record.subsidiary?.refName ?? ""}`,
    actions: recordButtons({
      onEdit: () => openEdit(record, refresh),
      editDisabled: !can("TRAN_CUSTINVC", "edit"),
      onBack: () => go("#/invoices"),
      actions: [
        toolbarButton("Accept Payment", () => openPaymentDialog(record, currency, refresh), {
          disabled: !canPay,
          title: canPay ? "Record a customer payment against this invoice" : "This invoice has no remaining balance",
        }),
        actionsButton,
      ],
    }),
    subtabs: subtabStrip(TABS, tab, (next) => { tab = next; paint(); }),
    body: [
      isOverdue(record)
        ? el("div", { class: "banner warn", role: "status" }, el("div", {}, el("div", { class: "banner-title", text: `This invoice was due on ${mdy(record.dueDate)} and is overdue.` })))
        : null,
      el("div", { class: "fieldcols" }, [
        el("dl", {}, [kv("Document Number", record.tranId), kv("Date", mdy(record.tranDate)), kv("Due Date", mdy(record.dueDate))]),
        el("dl", {}, [kv("Customer", el("a", { href: `#/customers/${encodeURIComponent(record.entity?.id ?? "")}`, text: record.entity?.refName ?? "" })),
          kv("Status", pill(record.status)), kv("Terms", record.terms?.refName ?? "— None —")]),
      ]),
      panel,
    ],
  }));
  paint();
});

/** NetSuite lets an open invoice's memo, PO number and terms be edited; lines stay as billed. */
function openEdit(record, refresh) {
  const memoInput = el("input", { type: "text", id: "inv-memo", value: record.memo ?? "", maxlength: "999" });
  const poInput = el("input", { type: "text", id: "inv-po", value: record.otherRefNum ?? "", maxlength: "45" });
  const errorHost = el("div", {});
  let key = newKey();
  dialog({
    title: `Edit Invoice — ${record.tranId}`,
    body: [errorHost, el("div", { class: "formgrid" }, [
      el("div", { class: "field" }, [el("label", { class: "fl", for: "inv-memo", text: "Memo" }), memoInput]),
      el("div", { class: "field" }, [el("label", { class: "fl", for: "inv-po", text: "PO / Check Number" }), poInput]),
    ])],
    actions: [
      { label: "Cancel", run: (close) => close() },
      {
        label: "Save",
        kind: "primary",
        run: async (close) => {
          errorHost.replaceChildren();
          try {
            await call("invoice.update", { recordId: record.id, body: { memo: memoInput.value.trim(), otherRefNum: poInput.value.trim() } }, key);
            toast("Invoice saved.");
            close();
            refresh();
          } catch (error) {
            key = newKey();
            errorHost.replaceChildren(errorBanner(error, "This invoice could not be saved"));
          }
        },
      },
    ],
  });
}
