// The sales order record page: header band, Items sublist with its own paging, totals block and the
// Bill action, which runs the !transform to an invoice (whole order or a partial quantity per line).
import { can, go, register, remember } from "../store.js";
import { call, el, errorBanner, money, qty, mdy, newKey, toast, describe } from "../ui.js";
import { dialog, openMenu } from "../overlay.js";
import {
  recordShell, recordButtons, subtabStrip, fieldGroup, kvColumns, kv, totalsBlock,
  setPageTitle, toolbarButton, nsButton, pill, currencyOf,
} from "./common.js";

const TABS = ["Items", "Shipping", "Billing", "System Information"];
const LINES_PER_PAGE = 10;

function lineRows(lines, currency) {
  return lines.map((line) => el("tr", {}, [
    el("td", { class: "tight num", text: String(line.line) }),
    el("td", { text: line.item?.refName ?? "" }),
    el("td", { text: line.description ?? "" }),
    el("td", { class: "num", text: qty(line.quantity) }),
    el("td", { class: "num", text: money(line.rate, currency) }),
    el("td", { class: "num", text: money(line.amount, currency) }),
    el("td", { class: "num", text: qty(line.quantityBilled ?? 0) }),
  ]));
}

async function itemsPanel(node, record, currency) {
  let offset = 0;
  async function paint() {
    node.replaceChildren(el("p", { class: "muted", text: "Loading items…" }));
    try {
      const page = await call("sales-order.items.list", { recordId: record.id, limit: LINES_PER_PAGE, offset });
      const lines = page.items ?? [];
      node.replaceChildren(el("section", { class: "sublist" }, [
        el("header", {}, [el("h3", { text: "Items" }), el("span", { class: "grow" }),
          el("span", { class: "muted", text: `${offset + 1} to ${offset + lines.length} of ${page.totalResults}` }),
          el("button", { type: "button", class: "btn", text: "Previous", disabled: offset === 0, onclick: () => { offset = Math.max(0, offset - LINES_PER_PAGE); paint(); } }),
          el("button", { type: "button", class: "btn", text: "Next", disabled: page.hasMore !== true, onclick: () => { offset += LINES_PER_PAGE; paint(); } }),
        ]),
        el("div", { class: "tablewrap" }, el("table", { class: "grid" }, [
          el("thead", {}, el("tr", {}, ["Line", "Item", "Description", "Quantity", "Rate", "Amount", "Billed"].map((label, index) =>
            el("th", { scope: "col", class: index >= 3 ? "num" : "", text: label })))),
          el("tbody", {}, lineRows(lines, currency)),
        ])),
      ]));
    } catch (error) {
      node.replaceChildren(errorBanner(error, "The item sublist could not be loaded"));
    }
  }
  await paint();
}

/** NetSuite's Bill action: whole order, or a quantity per unbilled line. */
function openBillDialog(record, currency, refresh) {
  const lines = (record.item?.items ?? []).filter((line) => Number(line.quantity) > Number(line.quantityBilled ?? 0));
  if (lines.length === 0) {
    dialog({
      title: "Bill Sales Order",
      body: el("p", { text: "Every line on this sales order has already been billed." }),
      actions: [{ label: "OK", kind: "primary", run: (close) => close() }],
    });
    return;
  }
  const inputs = new Map();
  const errorHost = el("div", {});
  const table = el("table", { class: "grid linegrid" }, [
    el("thead", {}, el("tr", {}, ["Line", "Item", "Remaining", "Quantity to Bill"].map((label, index) =>
      el("th", { scope: "col", class: index >= 2 ? "num" : "", text: label })))),
    el("tbody", {}, lines.map((line) => {
      const remaining = Number(line.quantity) - Number(line.quantityBilled ?? 0);
      const id = `bill-line-${line.line}`;
      const input = el("input", { type: "number", id, min: "0", step: "1", max: String(remaining), value: String(remaining) });
      inputs.set(line.line, input);
      return el("tr", {}, [
        el("td", { class: "tight num", text: String(line.line) }),
        el("td", {}, el("label", { class: "fl", for: id, text: line.item?.refName ?? `Line ${line.line}` })),
        el("td", { class: "num", text: qty(remaining) }),
        el("td", { class: "num" }, input),
      ]);
    })),
  ]);
  let key = newKey();
  let busy = false;
  dialog({
    title: `Bill Sales Order ${record.tranId}`,
    wide: true,
    body: [errorHost, el("p", { text: "Billing transforms this sales order into an invoice. Reduce a quantity to bill part of a line." }), table],
    actions: [
      { label: "Cancel", run: (close) => close() },
      {
        label: "Bill",
        kind: "primary",
        run: async (close) => {
          if (busy) return;
          busy = true;
          errorHost.replaceChildren();
          const items = [];
          for (const line of lines) {
            const value = Number(inputs.get(line.line).value);
            if (!Number.isFinite(value) || value < 0) {
              errorHost.replaceChildren(el("div", { class: "banner error", role: "alert" }, el("div", { class: "banner-title", text: `Line ${line.line} needs a quantity of zero or more.` })));
              busy = false;
              return;
            }
            if (value > 0) items.push({ orderLine: line.line, quantity: value });
          }
          if (items.length === 0) {
            errorHost.replaceChildren(el("div", { class: "banner error", role: "alert" }, el("div", { class: "banner-title", text: "Enter a quantity on at least one line." })));
            busy = false;
            return;
          }
          const whole = items.length === lines.length
            && items.every((entry, index) => entry.quantity === Number(lines[index].quantity) - Number(lines[index].quantityBilled ?? 0));
          try {
            const result = await call("sales-order.transform", {
              recordId: record.id,
              target: "invoice",
              transformMarker: "!transform",
              body: whole ? {} : { item: { items } },
            }, key);
            toast(`Invoice created (internal id ${result.id}).`);
            close();
            go(`#/invoices/${encodeURIComponent(result.id)}`);
          } catch (error) {
            key = newKey();
            errorHost.replaceChildren(el("div", { class: "banner error", role: "alert" }, [
              el("div", {}, [el("div", { class: "banner-title", text: "This order could not be billed" }), el("div", { class: "banner-detail", text: describe(error) })]),
            ]));
          } finally {
            busy = false;
            if (refresh) refresh();
          }
        },
      },
    ],
  });
}

register("order", async (main, route) => {
  let record;
  try {
    record = await call("sales-order.get", { recordId: route.id, expandSubResources: true });
  } catch (error) {
    main.replaceChildren(errorBanner(error, "This sales order could not be opened"));
    return;
  }
  setPageTitle(`Sales Order ${record.tranId}`);
  remember({ label: `Sales Order: ${record.tranId}`, href: `#/orders/${encodeURIComponent(record.id)}` });
  const currency = currencyOf(record);
  let tab = TABS[0];
  const panel = el("div", {});

  function paint() {
    if (tab === "Items") {
      const host = el("div", {});
      itemsPanel(host, record, currency);
      panel.replaceChildren(host, totalsBlock([
        ["Subtotal", money(record.subtotal, currency)],
        ["Tax Total", money(record.taxTotal, currency)],
        ["Total", money(record.total, currency), true],
      ]));
    } else if (tab === "Shipping") {
      panel.replaceChildren(fieldGroup("Shipping", el("p", { class: "muted", text: "Fulfilment and shipping are not simulated by this Tool; this order's lines are billed directly." })));
    } else if (tab === "Billing") {
      panel.replaceChildren(fieldGroup("Billing", kvColumns(
        [kv("Customer", el("a", { href: `#/customers/${encodeURIComponent(record.entity?.id ?? "")}`, text: record.entity?.refName ?? "" })),
          kv("Terms", record.terms?.refName ?? "— None —")],
        [kv("Currency", currency), kv("Subsidiary", record.subsidiary?.refName ?? "")],
      )));
    } else {
      panel.replaceChildren(fieldGroup("System Information", kvColumns(
        [kv("Internal ID", record.id), kv("Created", mdy(record.createdDate))],
        [kv("Last Modified", mdy(record.lastModifiedDate)), kv("Record Type", "salesOrder")],
      )));
    }
  }

  const actionsButton = el("button", { type: "button", class: "btn", "aria-haspopup": "true", "aria-expanded": "false", text: "Actions ▾" });
  actionsButton.addEventListener("click", (event) => {
    event.stopPropagation();
    openMenu(actionsButton, [
      { label: "Bill", run: () => openBillDialog(record, currency, () => go(`#/orders/${encodeURIComponent(record.id)}`)), disabled: !can("TRAN_SALESORD", "edit") },
      { label: "Fulfill" },
      { label: "Close Order" },
      { label: "Make Copy" },
    ]);
  });

  main.replaceChildren(recordShell({
    title: `Sales Order #${record.tranId}`,
    subtitle: `${record.entity?.refName ?? ""} · ${mdy(record.tranDate)} · ${record.subsidiary?.refName ?? ""}`,
    actions: recordButtons({
      onEdit: () => go(`#/orders/new?copy=${encodeURIComponent(record.id)}`),
      editLabel: "Edit",
      editDisabled: !can("TRAN_SALESORD", "edit"),
      onBack: () => go("#/orders"),
      actions: [
        toolbarButton("Bill", () => openBillDialog(record, currency, () => go(`#/orders/${encodeURIComponent(record.id)}`)), {
          disabled: !can("TRAN_SALESORD", "edit") || !can("TRAN_CUSTINVC", "create"),
          title: "Transform this order into an invoice",
        }),
        actionsButton,
      ],
    }),
    subtabs: subtabStrip(TABS, tab, (next) => { tab = next; paint(); }),
    body: [
      el("div", { class: "fieldcols" }, [
        el("dl", {}, [kv("Document Number", record.tranId), kv("Date", mdy(record.tranDate)), kv("Status", pill(record.status))]),
        el("dl", {}, [kv("Customer", record.entity?.refName ?? ""), kv("Memo", record.memo ?? ""), kv("PO / Check Number", record.otherRefNum ?? "")]),
      ]),
      panel,
    ],
  }));
  paint();
});
