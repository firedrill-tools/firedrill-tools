// Transactions → Sales → Create Invoices: a standalone invoice entry form (an invoice billed from a sales
// order is created by the Bill action on the order instead). Save calls invoice.create.
import { app, can, go, register } from "../store.js";
import { call, el, errorBanner, money, mdy, newKey, toast, ToolError } from "../ui.js";
import { recordShell, setPageTitle, toolbarButton, nsButton, totalsBlock, fieldGroup } from "./common.js";
import { pickCustomer, pickItem } from "./pickers.js";

register("invoice-new", async (main) => {
  setPageTitle("Invoice");
  if (!can("TRAN_CUSTINVC", "create")) {
    main.replaceChildren(errorBanner(new Error("Your role cannot create invoices."), "Permission Violation"));
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

  const dateInput = el("input", { type: "date", id: "inv-date", value: app.today });
  const dueInput = el("input", { type: "date", id: "inv-due" });
  const memoInput = el("input", { type: "text", id: "inv-memo-new", maxlength: "999" });
  for (const control of [dateInput, dueInput, memoInput]) control.addEventListener("input", () => { app.dirty = true; });

  function recalc() {
    const subtotal = state.lines.reduce((sum, line) => sum + (Number(line.quantity) || 0) * (Number(line.rate) || 0), 0);
    totalsHost.replaceChildren(totalsBlock([
      ["Subtotal", money(subtotal, currency)],
      ["Tax", "calculated on save"],
      ["Estimated Total", money(subtotal, currency), true],
    ]));
  }
  function paintLines() {
    if (state.lines.length === 0) {
      linesBody.replaceChildren(el("tr", {}, el("td", { colspan: "6", class: "muted", text: "No lines yet. Add an item to this invoice." })));
      return;
    }
    linesBody.replaceChildren(...state.lines.map((line, index) => {
      const quantityId = `inv-line-${index}-qty`;
      const rateId = `inv-line-${index}-rate`;
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
  }

  async function save() {
    if (state.saving) return;
    errorHost.replaceChildren();
    if (state.customer === null) { errorHost.replaceChildren(errorBanner(new Error("Please choose a customer for this invoice."), "Customer is required")); return; }
    if (state.lines.length === 0) { errorHost.replaceChildren(errorBanner(new Error("Please enter at least one line item for this transaction."), "Items are required")); return; }
    state.saving = true;
    try {
      const body = {
        entity: { id: state.customer.id },
        tranDate: dateInput.value,
        item: { items: state.lines.map((line) => ({ item: { id: line.itemId }, quantity: Number(line.quantity), rate: Number(line.rate) })) },
      };
      if (dueInput.value !== "") body.dueDate = dueInput.value;
      if (memoInput.value.trim() !== "") body.memo = memoInput.value.trim();
      const result = await call("invoice.create", { body }, state.key);
      app.dirty = false;
      toast(`Invoice created (internal id ${result.id}).`);
      go(`#/invoices/${encodeURIComponent(result.id)}`);
    } catch (error) {
      state.key = newKey();
      const path = error instanceof ToolError ? error.details?.errorPath : undefined;
      errorHost.replaceChildren(errorBanner(error, "This invoice could not be saved"), ...(path ? [el("p", { class: "field-error", text: `Field: ${path}` })] : []));
    } finally {
      state.saving = false;
    }
  }

  main.replaceChildren(recordShell({
    title: "Invoice",
    subtitle: `New · ${app.session?.account?.companyName ?? ""} · ${mdy(app.today)}`,
    actions: [
      toolbarButton("Save", save, { kind: "primary" }),
      toolbarButton("Cancel", () => { app.dirty = false; go("#/invoices"); }),
      nsButton("Save & Print"),
      nsButton("Reset"),
    ],
    body: [
      errorHost,
      fieldGroup("Primary Information", el("div", { class: "formgrid" }, [
        el("div", { class: "field" }, [el("span", { class: "fl" }, "Customer"), el("div", { class: "btn-row" }, [customerButton, customerLabel])]),
        el("div", { class: "field" }, [el("label", { class: "fl", for: "inv-date", text: "Date" }), dateInput]),
        el("div", { class: "field" }, [el("label", { class: "fl", for: "inv-due", text: "Due Date" }), dueInput]),
        el("div", { class: "field" }, [el("label", { class: "fl", for: "inv-memo-new", text: "Memo" }), memoInput]),
      ])),
      el("section", { class: "sublist" }, [
        el("header", {}, [el("h3", { text: "Items" }), el("span", { class: "grow" }),
          toolbarButton("Add Item", async () => {
            const item = await pickItem();
            if (!item) return;
            state.lines.push({ itemId: item.id, label: `${item.itemId}${item.displayName ? ` — ${item.displayName}` : ""}`, quantity: 1, rate: Number(item.basePrice) || 0 });
            app.dirty = true;
            paintLines();
            recalc();
          })]),
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
});
