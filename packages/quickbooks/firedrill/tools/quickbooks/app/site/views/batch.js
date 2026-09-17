// Row selection and the "N selected / Batch actions" bar that QuickBooks shows above a list grid.
import { el, icon, openMenu } from "../ui.js";

/**
 * Creates the header checkbox, the per-row checkbox cells and the batch bar.
 * `actionsFor(rows)` returns openMenu items for the currently selected rows.
 */
export function createSelection({ noun, actionsFor, labelFor }) {
  const entries = new Map(); // id -> { row, box }
  const count = el("span", { class: "batch-count" });
  const head = el("input", { type: "checkbox", "aria-label": `Select all ${noun}`, disabled: true });
  const menuBtn = el("button", { type: "button", class: "btn", "aria-haspopup": "menu", "aria-expanded": "false" }, [
    el("span", { text: "Batch actions" }), icon("chevronDown"),
  ]);
  const clearBtn = el("button", { type: "button", class: "link-btn", text: "Clear selection" });
  const bar = el("div", { class: "batch-bar", role: "region", "aria-label": `Selected ${noun}`, hidden: true }, [
    count, menuBtn, el("div", { class: "grow" }), clearBtn,
  ]);

  const chosen = () => [...entries.values()].filter((e) => e.box.checked).map((e) => e.row);
  function sync() {
    const n = chosen().length;
    const total = entries.size;
    count.textContent = `${n} selected`;
    bar.hidden = n === 0;
    head.disabled = total === 0;
    head.checked = total > 0 && n === total;
    head.indeterminate = n > 0 && n < total;
    head.title = total === 0 ? "" : head.checked ? `Clear all ${noun} on this page` : `Select all ${noun} on this page`;
  }
  head.addEventListener("change", () => {
    for (const e of entries.values()) e.box.checked = head.checked;
    sync();
  });
  clearBtn.addEventListener("click", () => {
    for (const e of entries.values()) e.box.checked = false;
    sync();
    head.focus();
  });
  menuBtn.addEventListener("click", () => {
    const rows = chosen();
    if (rows.length === 0) return;
    openMenu(menuBtn, actionsFor(rows));
  });

  return {
    head,
    bar,
    /** Resets the bar for a freshly rendered page of rows. */
    reset() { entries.clear(); sync(); },
    /** Checkbox cell for one row. */
    cell(row) {
      const box = el("input", { type: "checkbox", "aria-label": `Select ${labelFor(row)}` });
      box.addEventListener("click", (e) => e.stopPropagation());
      box.addEventListener("change", sync);
      entries.set(String(row.Id), { row, box });
      sync();
      return el("td", { class: "check" }, box);
    },
  };
}

/**
 * Runs `run(row)` over the selected rows one at a time and shows a per-row result list.
 * Returns the number that succeeded.
 */
export async function runBatch({ box, rows, label, run, describeError }) {
  const items = new Map();
  const list = el("ul", { class: "batch-list" }, rows.map((row) => {
    const note = el("span", { class: "bl-note", text: "Waiting…" });
    items.set(String(row.Id), note);
    return el("li", {}, [el("span", { text: label(row) }), note]);
  }));
  box.replaceChildren(el("p", { text: `${rows.length} ${rows.length === 1 ? "transaction" : "transactions"} selected.` }), list);
  let ok = 0;
  for (const row of rows) {
    const note = items.get(String(row.Id));
    note.textContent = "Working…";
    note.className = "bl-note";
    try {
      const result = (await run(row)) ?? "Done";
      if (result instanceof Node) note.replaceChildren(result); else note.textContent = String(result);
      note.className = "bl-note ok";
      ok += 1;
    } catch (error) {
      note.textContent = describeError(error);
      note.className = "bl-note err";
    }
  }
  return ok;
}
