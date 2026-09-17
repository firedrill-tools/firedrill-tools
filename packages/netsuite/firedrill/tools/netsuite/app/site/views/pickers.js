// Record pickers used by the transaction entry forms. Each pages through its collection as the user types,
// so nothing past the first page is silently hidden.
import { listIds, expand } from "../store.js";
import { el, errorBanner, lit, money, qty } from "../ui.js";
import { dialog } from "../overlay.js";

const PAGE = 10;

function pickerDialog({ title, label, placeholder, search, columns, renderRow }) {
  return new Promise((resolve) => {
    let answered = false;
    let offset = 0;
    let term = "";
    const body = el("tbody", {});
    const status = el("div", { class: "muted", text: "Loading…" });
    const inputId = `${title.replace(/\W+/g, "-").toLowerCase()}-search`;
    const input = el("input", { type: "search", id: inputId, placeholder });
    const previous = el("button", { type: "button", class: "btn", text: "Previous", disabled: true });
    const next = el("button", { type: "button", class: "btn", text: "Next", disabled: true });

    const choose = (record) => { answered = true; resolve(record); box.close(); };

    async function load() {
      status.textContent = "Loading…";
      try {
        const { rows, page } = await search(term, offset, PAGE);
        body.replaceChildren(...(rows.length === 0
          ? [el("tr", {}, el("td", { colspan: String(columns.length), class: "muted", text: "No matching records." }))]
          : rows.map((record) => {
              const row = renderRow(record);
              row.tabIndex = 0;
              row.addEventListener("click", () => choose(record));
              row.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(record); } });
              return row;
            })));
        status.textContent = page.totalResults === 0
          ? "No records"
          : `${page.offset + 1} to ${page.offset + rows.length} of ${page.totalResults}`;
        previous.disabled = offset === 0;
        next.disabled = page.hasMore !== true;
      } catch (error) {
        body.replaceChildren(el("tr", {}, el("td", { colspan: String(columns.length) }, errorBanner(error, "This list could not be loaded"))));
        status.textContent = "";
      }
    }
    let timer;
    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => { term = input.value.trim(); offset = 0; load(); }, 200);
    });
    previous.addEventListener("click", () => { offset = Math.max(0, offset - PAGE); load(); });
    next.addEventListener("click", () => { offset += PAGE; load(); });

    const box = dialog({
      title,
      wide: true,
      body: [
        el("div", { class: "field" }, [el("label", { class: "fl", for: inputId, text: label }), input]),
        el("div", { class: "tablewrap" }, el("table", { class: "grid" }, [
          el("thead", {}, el("tr", {}, columns.map((column) => el("th", { scope: "col", class: column.numeric ? "num" : "", text: column.label })))),
          body,
        ])),
        el("div", { class: "pager" }, [status, el("span", { class: "grow" }), previous, next]),
      ],
      actions: [{ label: "Cancel", run: (close) => close() }],
      onClose: () => { if (!answered) resolve(null); },
    });
    load();
  });
}

export function pickCustomer() {
  return pickerDialog({
    title: "Choose a Customer",
    label: "Search customers",
    placeholder: "Name, company or e-mail",
    columns: [{ label: "Name" }, { label: "Subsidiary" }, { label: "Balance", numeric: true }],
    search: async (term, offset, limit) => {
      const parts = ["isInactive IS false"];
      if (term !== "") {
        const value = lit(term);
        parts.push(`(entityId CONTAIN ${value} OR companyName CONTAIN ${value} OR email CONTAIN ${value})`);
      }
      const page = await listIds("customer.list", { q: parts.join(" AND "), limit, offset });
      return { rows: await expand("customer.get", page.ids), page };
    },
    renderRow: (record) => el("tr", {}, [
      el("td", { text: record.entityId ?? record.id }),
      el("td", { text: record.subsidiary?.refName ?? "" }),
      el("td", { class: "num", text: money(record.balance, record.currency?.refName ?? "") }),
    ]),
  });
}

export function pickItem() {
  return pickerDialog({
    title: "Choose an Item",
    label: "Search items",
    placeholder: "Item name or display name",
    columns: [{ label: "Item" }, { label: "Display Name" }, { label: "Base Price", numeric: true }, { label: "On Hand", numeric: true }],
    search: async (term, offset, limit) => {
      const parts = ["isInactive IS false"];
      if (term !== "") {
        const value = lit(term);
        parts.push(`(itemId CONTAIN ${value} OR displayName CONTAIN ${value})`);
      }
      const page = await listIds("inventory-item.list", { q: parts.join(" AND "), limit, offset });
      return { rows: await expand("inventory-item.get", page.ids), page };
    },
    renderRow: (record) => el("tr", {}, [
      el("td", { text: record.itemId }),
      el("td", { text: record.displayName ?? "" }),
      el("td", { class: "num", text: money(record.basePrice) }),
      el("td", { class: "num", text: qty(record.quantityOnHand) }),
    ]),
  });
}
