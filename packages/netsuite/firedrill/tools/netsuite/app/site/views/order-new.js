// Transactions → Sales → Enter Sales Orders: the transaction entry form with the customer picker,
// the Items line grid and live totals. Save calls sales-order.create with an idempotency key.
import { app, can, go, register } from "../store.js";
import { call, el, errorBanner, money, mdy, newKey, toast, describe, ToolError } from "../ui.js";
import { recordShell, setPageTitle, toolbarButton, nsButton, totalsBlock, fieldGroup } from "./common.js";
import { pickCustomer, pickItem } from "./pickers.js";

const TERMS = [["", "— None —"], ["1", "Net 15"], ["2", "Net 30"], ["3", "Due on receipt"]];

register("order-new", async (main, route) => {
  setPageTitle("Sales Order");
  if (!can("TRAN_SALESORD", "create")) {
    main.replaceChildren(errorBanner(new Error("Your role cannot create sales orders."), "Permission Violation"));
    return;
  }
  const currency = app.session?.account?.baseCurrency ?? "";
  const state = { customer: null, lines: [], key: newKey(), saving: false };
  const errorHost = el("div", {});
  const linesBody = el("tbody", {});
  const totalsHost = el("div", {});

  const customerLabel = el("span", { class: "muted", text: "No customer selected" });
  const customerButton = toolbarButton("Select Customer…", async () => {
    const chosen = await pickCustomer();
    if (!chosen) return;
    state.customer = chosen;
    customerLabel.textContent = `${chosen.entityId} · ${chosen.subsidiary?.refName ?? ""}`;
    customerLabel.className = "";
    app.dirty = true;
  });

  const dateInput = el("input", { type: "date", id: "so-date", value: app.today });
  const memoInput = el("input", { type: "text", id: "so-memo", maxlength: "999" });
  const poInput = el("input", { type: "text", id: "so-po", maxlength: "45" });
  const termsSelect = el("select", { id: "so-terms" }, TERMS.map(([value, label]) => el("option", { value, text: label })));
  for (const control of [dateInput, memoInput, poInput, termsSelect]) {
    control.addEventListener("input", () => { app.dirty = true; });
  }

  function recalc() {
    const subtotal = state.lines.reduce((sum, line) => sum + (Number(line.quantity) || 0) * (Number(line.rate) || 0), 0);
    totalsHost.replaceChildren(totalsBlock([
      ["Subtotal", money(subtotal, currency)],
      ["Tax", "calculated on save"],
      ["Estimated Total", money(subtotal, currency), true],
    ]));
  }

  function paintLines() {
    linesBody.replaceChildren(...state.lines.map((line, index) => {
      const quantityId = `so-line-${index}-qty`;
      const rateId = `so-line-${index}-rate`;
      const quantityInput = el("input", { type: "number", id: quantityId, min: "0", step: "1", value: String(line.quantity) });
      const rateInput = el("input", { type: "number", id: rateId, min: "0", step: "0.01", value: String(line.rate) });
      quantityInput.addEventListener("input", () => { line.quantity = Number(quantityInput.value); app.dirty = true; recalc(); });
      rateInput.addEventListener("input", () => { line.rate = Number(rateInput.value); app.dirty = true; recalc(); });
      return el("tr", {}, [
        el("td", { class: "tight num", text: String(index + 1) }),
        el("td", { text: line.label }),
        el("td", { class: "num" }, [el("label", { class: "visually-hidden", for: quantityId, text: `Quantity for line ${index + 1}` }), quantityInput]),
        el("td", { class: "num" }, [el("label", { class: "visually-hidden", for: rateId, text: `Rate for line ${index + 1}` }), rateInput]),
        el("td", { class: "num", text: money((Number(line.quantity) || 0) * (Number(line.rate) || 0), currency) }),
        el("td", {}, el("button", { type: "button", class: "btn", text: "Remove", onclick: () => { state.lines.splice(index, 1); paintLines(); recalc(); } })),
      ]);
    }));
    if (state.lines.length === 0) {
      linesBody.replaceChildren(el("tr", {}, el("td", { colspan: "6", class: "muted", text: "No lines yet. Add an item to this order." })));
    }
  }

  async function addLine() {
    const item = await pickItem();
    if (!item) return;
    state.lines.push({ itemId: item.id, label: `${item.itemId}${item.displayName ? ` — ${item.displayName}` : ""}`, quantity: 1, rate: Number(item.basePrice) || 0 });
    app.dirty = true;
    paintLines();
    recalc();
  }

  async function save() {
    if (state.saving) return;
    errorHost.replaceChildren();
    if (state.customer === null) {
      errorHost.replaceChildren(errorBanner(new Error("Please choose a customer for this sales order."), "Customer is required"));
      return;
    }
    if (state.lines.length === 0) {
      errorHost.replaceChildren(errorBanner(new Error("Please enter at least one line item for this transaction."), "Items are required"));
      return;
    }
    state.saving = true;
    try {
      const body = {
        entity: { id: state.customer.id },
        tranDate: dateInput.value,
        item: { items: state.lines.map((line) => ({ item: { id: line.itemId }, quantity: Number(line.quantity), rate: Number(line.rate) })) },
      };
      if (memoInput.value.trim() !== "") body.memo = memoInput.value.trim();
      if (poInput.value.trim() !== "") body.otherRefNum = poInput.value.trim();
      if (termsSelect.value !== "") body.terms = { id: termsSelect.value };
      const result = await call("sales-order.create", { body }, state.key);
      app.dirty = false;
      toast(`Sales order created (internal id ${result.id}).`);
      go(`#/orders/${encodeURIComponent(result.id)}`);
    } catch (error) {
      state.key = newKey();
      const path = error instanceof ToolError ? error.details?.errorPath : undefined;
      errorHost.replaceChildren(errorBanner(error, "This sales order could not be saved"),
        ...(path ? [el("p", { class: "field-error", text: `Field: ${path}` })] : []));
    } finally {
      state.saving = false;
    }
  }

  main.replaceChildren(recordShell({
    title: "Sales Order",
    subtitle: `New · ${app.session?.account?.companyName ?? ""} · ${mdy(app.today)}`,
    actions: [
      toolbarButton("Save", save, { kind: "primary" }),
      toolbarButton("Cancel", () => { app.dirty = false; go("#/orders"); }),
      nsButton("Save & New"),
      nsButton("Reset"),
    ],
    body: [
      errorHost,
      fieldGroup("Primary Information", el("div", { class: "formgrid" }, [
        el("div", { class: "field" }, [el("span", { class: "fl" }, "Customer"), el("div", { class: "btn-row" }, [customerButton, customerLabel])]),
        el("div", { class: "field" }, [el("label", { class: "fl", for: "so-date", text: "Date" }), dateInput]),
        el("div", { class: "field" }, [el("label", { class: "fl", for: "so-po", text: "PO / Check Number" }), poInput]),
        el("div", { class: "field" }, [el("label", { class: "fl", for: "so-terms", text: "Terms" }), termsSelect]),
        el("div", { class: "field" }, [el("label", { class: "fl", for: "so-memo", text: "Memo" }), memoInput]),
      ])),
      el("section", { class: "sublist" }, [
        el("header", {}, [el("h3", { text: "Items" }), el("span", { class: "grow" }), toolbarButton("Add Item", addLine)]),
        el("div", { class: "tablewrap" }, el("table", { class: "grid linegrid" }, [
          el("thead", {}, el("tr", {}, ["Line", "Item", "Quantity", "Rate", "Amount", ""].map((label, index) =>
            el("th", { scope: "col", class: index >= 2 && index <= 4 ? "num" : "", text: label })))),
          linesBody,
        ])),
      ]),
      totalsHost,
    ],
  }));
  paintLines();
  recalc();
  if (route.params.get("entity")) {
    try {
      const customer = await call("customer.get", { recordId: route.params.get("entity") });
      state.customer = customer;
      customerLabel.textContent = `${customer.entityId} · ${customer.subsidiary?.refName ?? ""}`;
      customerLabel.className = "";
    } catch { /* the picker stays empty */ }
  }
});
