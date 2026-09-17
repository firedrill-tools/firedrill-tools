// Invoice editor line grid: Item, Description, Qty., Price, Disc., Account, Tax rate, Tax amount, Amount; live totals.
import { amount, el, icon } from "../ui.js";

let rowSeq = 0;
/** accounts: Account[]; taxRates: TaxRate[]; onChange(): called on every edit. */
export function lineGrid({ lines, accounts, taxRates, defaultAccount, defaultTax, onChange }) {
  const rate = (taxType) => Number(taxRates.find((t) => t.TaxType === taxType)?.EffectiveRate ?? 0);
  const tbody = el("tbody");
  let amountsAre = "Exclusive";
  const rows = [];

  function compute(r) {
    const qty = Number(r.qty.value || 0);
    const price = Number(String(r.price.value || "0").replace(/,/g, ""));
    const line = Number.isFinite(qty * price) ? Math.round(qty * price * 100) / 100 : 0;
    const pct = amountsAre === "NoTax" ? 0 : rate(r.tax.value);
    const tax = amountsAre === "Inclusive" ? line - line / (1 + pct / 100) : line * pct / 100;
    return { line, tax: Math.round(tax * 100) / 100 };
  }
  function addRow(li = {}) {
    const n = (rowSeq += 1);
    const label = (name) => ({ "aria-label": `${name}, line ${rows.length + 1}` });
    const item = el("input", { class: "cell", ...label("Item"), disabled: true, title: "Products and services are not simulated by this Tool", value: li.ItemCode ?? "" });
    const desc = el("textarea", { class: "cell", rows: "1", ...label("Description") });
    desc.value = li.Description ?? "";
    const qty = el("input", { class: "cell num", inputmode: "decimal", ...label("Quantity"), value: li.Quantity === undefined ? "" : String(li.Quantity) });
    const price = el("input", { class: "cell num", inputmode: "decimal", ...label("Price"), value: li.UnitAmount === undefined ? "" : String(li.UnitAmount) });
    const disc = el("input", { class: "cell num", ...label("Discount"), disabled: true, title: "Discounts are not simulated by this Tool" });
    const acct = el("select", { class: "cell", ...label("Account") }, [el("option", { value: "", text: "" }), ...accounts.map((a) => el("option", { value: a.Code, text: `${a.Code} - ${a.Name}` }))]);
    acct.value = li.AccountCode ?? "";
    const tax = el("select", { class: "cell", ...label("Tax rate") }, [el("option", { value: "", text: "" }), ...taxRates.map((t) => el("option", { value: t.TaxType, text: t.Name }))]);
    tax.value = li.TaxType ?? "";
    const taxOut = el("td", { class: "static" });
    const amtOut = el("td", { class: "static" });
    const r = { n, item, desc, qty, price, acct, tax, taxOut, amtOut };
    const del = el("button", { type: "button", class: "icon-btn", "aria-label": "Remove line", onclick: () => { if (rows.length > 1) { rows.splice(rows.indexOf(r), 1); r.tr.remove(); } else { desc.value = ""; qty.value = ""; price.value = ""; } refresh(); onChange(); } }, icon("trash", 18));
    r.tr = el("tr", {}, [el("td", {}, item), el("td", {}, desc), el("td", {}, qty), el("td", {}, price), el("td", {}, disc), el("td", {}, acct), el("td", {}, tax), taxOut, amtOut, el("td", { class: "row-del" }, del)]);
    for (const input of [desc, qty, price, acct, tax]) input.addEventListener("input", () => {
      if ((input === desc || input === price || input === qty) && !acct.value && defaultAccount) acct.value = defaultAccount;
      if (acct.value && !tax.value) tax.value = accounts.find((a) => a.Code === acct.value)?.TaxType ?? defaultTax ?? "";
      if (input === qty || input === price || input === tax) for (const x of [qty, price]) x.classList.remove("invalid");
      refresh(); onChange();
    });
    rows.push(r);
    tbody.append(r.tr);
    return r;
  }
  const totals = el("div", { class: "totals" });
  function refresh() {
    let sub = 0, taxSum = 0;
    for (const r of rows) {
      const { line, tax } = compute(r);
      r.taxOut.textContent = r.desc.value || r.price.value ? amount(tax) : "";
      r.amtOut.textContent = r.desc.value || r.price.value ? amount(line) : "";
      sub += amountsAre === "Inclusive" ? line - tax : line;
      taxSum += tax;
    }
    const row = (k, v, cls = "") => el("div", { class: `trow ${cls}` }, [el("span", { text: k }), el("span", { class: "num", text: v })]);
    totals.replaceChildren(row("Subtotal", amount(sub)), row(amountsAre === "Inclusive" ? "Includes GST" : "Total GST", amount(taxSum)), row("Total", amount(sub + taxSum), "grand"));
  }
  (lines.length ? lines : [{}, {}, {}]).forEach((li) => addRow(li));
  refresh();

  const heads = ["Item", "Description", "Qty.", "Price", "Disc.", "Account", "Tax rate", "Tax amount", "Amount NZD", ""];
  const table = el("table", { class: "lines" }, [el("thead", {}, el("tr", {}, heads.map((h, i) => el("th", { class: [2, 3, 4, 7, 8].includes(i) ? "num" : "", text: h })))), tbody]);
  return {
    table, totals,
    addRow: () => { addRow({}); refresh(); onChange(); },
    setAmountsAre: (v) => { amountsAre = v; refresh(); },
    /** Non-blank lines as Xero LineItems, or { error } naming the first bad line. */
    collect() {
      const items = [];
      for (const [i, r] of rows.entries()) {
        const blank = !r.desc.value.trim() && !r.qty.value.trim() && !r.price.value.trim();
        if (blank) continue;
        const qty = r.qty.value.trim() === "" ? 1 : Number(r.qty.value);
        const price = Number(String(r.price.value || "0").replace(/,/g, ""));
        if (!Number.isFinite(qty)) { r.qty.classList.add("invalid"); return { error: `Line ${i + 1}: quantity must be a number.` }; }
        if (!Number.isFinite(price)) { r.price.classList.add("invalid"); return { error: `Line ${i + 1}: price must be a number.` }; }
        items.push({ Description: r.desc.value.trim(), Quantity: qty, UnitAmount: price, ...(r.acct.value ? { AccountCode: r.acct.value } : {}), ...(r.tax.value ? { TaxType: r.tax.value } : {}) });
      }
      return { items };
    },
  };
}
