// Invoice line table: Product or service / Description / Qty / Rate / Amount, with add and clear lines.
import { amount, el, icon } from "../ui.js";

const cents = (n) => Math.round(Number(n) * 100);

export function linesTable(items, initial, onChange) {
  const byId = new Map(items.map((i) => [i.Id, i]));
  const tbody = el("tbody");
  let seq = 0;
  const rows = [];
  const renumber = () => rows.forEach((r, i) => { r.num.textContent = String(i + 1); });
  function addRow(line = {}) {
    seq += 1;
    const d = line.SalesItemLineDetail ?? {};
    const item = el("select", { class: "cell-input", "aria-label": `Product or service, line ${seq}` }, [el("option", { value: "", text: "" })]);
    for (const it of items) item.append(el("option", { value: it.Id, text: it.Name }));
    if (d.ItemRef?.value && !byId.has(d.ItemRef.value)) item.append(el("option", { value: d.ItemRef.value, text: `${d.ItemRef.name ?? d.ItemRef.value} (inactive)` }));
    item.value = d.ItemRef?.value ?? "";
    const desc = el("input", { class: "cell-input", type: "text", "aria-label": `Description, line ${seq}`, value: line.Description ?? "" });
    const qty = el("input", { class: "cell-input num", type: "number", step: "any", min: "0", "aria-label": `Quantity, line ${seq}`, value: d.Qty ?? "" });
    const rate = el("input", { class: "cell-input num", type: "number", step: "0.01", "aria-label": `Rate, line ${seq}`, value: d.UnitPrice ?? "" });
    const amt = el("td", { class: "amt" });
    const num = el("td", { class: "n" });
    const r = { item, desc, qty, rate, amt, num };
    const recalc = () => {
      const q = Number(qty.value || 0);
      const p = Number(rate.value || 0);
      r.amount = qty.value === "" && rate.value === "" ? 0 : Math.round(q * p * 100) / 100;
      amt.textContent = item.value ? amount(r.amount) : "";
      onChange?.();
    };
    item.addEventListener("change", () => {
      const it = byId.get(item.value);
      if (it) {
        if (!desc.value) desc.value = it.Description ?? "";
        if (qty.value === "") qty.value = "1";
        if (rate.value === "" && it.UnitPrice !== undefined && it.UnitPrice !== null) rate.value = String(it.UnitPrice);
      }
      recalc();
      if (rows[rows.length - 1] === r && item.value) addRow();
    });
    for (const x of [qty, rate]) x.addEventListener("input", recalc);
    const del = el("button", { type: "button", class: "icon-btn", "aria-label": `Delete line ${seq}`, title: "Delete line", onclick: () => {
      if (rows.length === 1) { item.value = ""; desc.value = ""; qty.value = ""; rate.value = ""; recalc(); return; }
      rows.splice(rows.indexOf(r), 1); tr.remove(); renumber(); onChange?.();
    } }, icon("trash"));
    const tr = el("tr", {}, [num, el("td", {}, item), el("td", {}, desc), el("td", { style: undefined }, qty), el("td", {}, rate), amt, el("td", { class: "del" }, del)]);
    rows.push(r);
    tbody.append(tr);
    renumber();
    recalc();
    return r;
  }
  for (const line of initial) addRow(line);
  while (rows.length < 2) addRow();

  const node = el("div", {}, [
    el("div", { class: "table-wrap" }, el("table", { class: "lines" }, [
      el("thead", {}, el("tr", {}, [el("th", { text: "#" }), el("th", { text: "Product or service" }), el("th", { text: "Description" }), el("th", { class: "amt", text: "Qty" }), el("th", { class: "amt", text: "Rate" }), el("th", { class: "amt", text: "Amount" }), el("th", {}, el("span", { class: "visually-hidden", text: "Delete" }))])),
      tbody,
    ])),
    el("div", { class: "line-actions" }, [
      el("button", { type: "button", class: "btn small", text: "Add lines", onclick: () => { addRow(); addRow(); } }),
      el("button", { type: "button", class: "btn small", text: "Clear all lines", onclick: () => { for (const r of rows.splice(0)) r.num.parentElement.remove(); addRow(); addRow(); onChange?.(); } }),
    ]),
  ]);

  return {
    node,
    totalCents: () => rows.reduce((s, r) => s + (r.item.value ? cents(r.amount) : 0), 0),
    /** Lines for the API body, or an error message pointing at the first bad row. */
    collect() {
      const out = [];
      for (const [i, r] of rows.entries()) {
        for (const x of [r.item, r.qty, r.rate]) x.classList.remove("invalid");
        if (!r.item.value) {
          if (r.qty.value || r.rate.value || r.desc.value) { r.item.classList.add("invalid"); return { error: `Line ${i + 1}: select a product or service.`, focus: r.item }; }
          continue;
        }
        const qty = Number(r.qty.value || 0);
        if (!(qty > 0)) { r.qty.classList.add("invalid"); return { error: `Line ${i + 1}: enter a quantity greater than 0.`, focus: r.qty }; }
        const rate = Number(r.rate.value || 0);
        const line = { DetailType: "SalesItemLineDetail", Amount: Math.round(qty * rate * 100) / 100, SalesItemLineDetail: { ItemRef: { value: r.item.value }, Qty: qty, UnitPrice: rate } };
        if (r.desc.value.trim()) line.Description = r.desc.value.trim();
        out.push(line);
      }
      if (!out.length) { rows[0].item.classList.add("invalid"); return { error: "Add at least one product or service line.", focus: rows[0].item }; }
      return { lines: out };
    },
    markLine(index) { const r = rows.filter((x) => x.item.value)[index]; if (r) { r.item.classList.add("invalid"); r.item.focus(); } },
  };
}
