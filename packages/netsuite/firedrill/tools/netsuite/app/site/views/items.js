// Lists → Accounting → Items: the item list with a detail panel. Items are read-only in this Tool.
import { go, listIds, expand, register } from "../store.js";
import { call, el, errorBanner, emptyState, money, qty, mdy, skeletonRows, lit } from "../ui.js";
import { listShell, pagerStrip, setPageTitle, toolbarButton, nsButton, fieldGroup, kv, kvColumns } from "./common.js";

const COLUMNS = [
  { label: "Item Name/Number" }, { label: "Display Name" }, { label: "Type" },
  { label: "Base Price", numeric: true }, { label: "On Hand", numeric: true }, { label: "Inactive" },
];

register("items", async (main, route) => {
  setPageTitle("Items");
  const state = {
    term: route.params.get("q") ?? "",
    inactive: route.params.get("inactive") === "1",
    offset: Number(route.params.get("offset") ?? 0) || 0,
    size: Number(route.params.get("size") ?? 25) || 25,
  };
  const body = el("tbody", {}, skeletonRows(COLUMNS.length));
  const pagerHost = el("div", {});
  const detail = el("div", {});

  function apply(patch) {
    const next = { ...state, ...patch };
    const params = new URLSearchParams();
    if (next.term) params.set("q", next.term);
    if (next.inactive) params.set("inactive", "1");
    if (next.offset) params.set("offset", String(next.offset));
    if (next.size !== 25) params.set("size", String(next.size));
    const query = params.toString();
    go(`#/items${query ? `?${query}` : ""}`);
  }

  const input = el("input", { type: "search", id: "item-filter", value: state.term, placeholder: "Item name or display name" });
  const inactiveBox = el("input", { type: "checkbox", id: "item-inactive", checked: state.inactive });
  inactiveBox.addEventListener("change", () => apply({ inactive: inactiveBox.checked, offset: 0 }));
  const filter = el("form", { class: "filterbar", onsubmit: (event) => { event.preventDefault(); apply({ term: input.value.trim(), offset: 0 }); } }, [
    el("div", { class: "field" }, [el("label", { class: "fl", for: "item-filter", text: "Quick Filter" }), input]),
    el("div", { class: "field inline" }, [inactiveBox, el("label", { class: "fl", for: "item-inactive", text: "Show Inactives" })]),
    toolbarButton("Search", () => apply({ term: input.value.trim(), offset: 0 })),
  ]);

  async function showDetail(id) {
    detail.replaceChildren(el("p", { class: "muted", text: "Loading item…" }));
    try {
      const item = await call("inventory-item.get", { recordId: id });
      detail.replaceChildren(fieldGroup(`Item — ${item.itemId}`, kvColumns(
        [kv("Display Name", item.displayName ?? ""), kv("Description", item.description ?? ""), kv("Base Price", money(item.basePrice))],
        [kv("Quantity On Hand", qty(item.quantityOnHand)), kv("Income Account", item.incomeAccount?.refName ?? ""),
          kv("Tax Schedule", item.taxSchedule?.refName ?? ""), kv("Subsidiaries", (item.subsidiary?.items ?? []).map((s) => s.refName).join(", "))],
      )));
    } catch (error) {
      detail.replaceChildren(errorBanner(error, "This item could not be opened"));
    }
  }

  main.replaceChildren(listShell({
    title: "Items",
    subtitle: "Items are seeded by the world and are read-only in this Tool.",
    actions: [nsButton("New Item"), nsButton("Customize View")],
    filter,
    columns: COLUMNS,
    body,
    pager: pagerHost,
  }), detail);

  try {
    const parts = [];
    if (!state.inactive) parts.push("isInactive IS false");
    if (state.term !== "") parts.push(`(itemId CONTAIN ${lit(state.term)} OR displayName CONTAIN ${lit(state.term)})`);
    const page = await listIds("inventory-item.list", { q: parts.join(" AND "), limit: state.size, offset: state.offset });
    const rows = await expand("inventory-item.get", page.ids);
    if (rows.length === 0) {
      body.replaceChildren(el("tr", {}, el("td", { colspan: String(COLUMNS.length) }, emptyState("No items match this filter."))));
    } else {
      body.replaceChildren(...rows.map((record) => {
        const row = el("tr", {}, [
          el("td", {}, el("button", { type: "button", class: "btn link", text: record.itemId, onclick: () => showDetail(record.id) })),
          el("td", { text: record.displayName ?? "" }),
          el("td", { text: "Inventory Item" }),
          el("td", { class: "num", text: money(record.basePrice) }),
          el("td", { class: "num", text: qty(record.quantityOnHand) }),
          el("td", { text: record.isInactive ? "Yes" : "No" }),
        ]);
        return row;
      }));
    }
    pagerHost.replaceChildren(pagerStrip({
      offset: page.offset, shown: rows.length, total: page.totalResults, hasMore: page.hasMore, pageSize: state.size,
      onOffset: (offset) => apply({ offset }), onPageSize: (size) => apply({ size, offset: 0 }),
    }));
  } catch (error) {
    body.replaceChildren(el("tr", {}, el("td", { colspan: String(COLUMNS.length) }, errorBanner(error, "The item list could not be loaded"))));
  }
});
