// Sales & Get paid > Products & services, plus the new/edit product drawer (Service and Non-inventory).
import { app, go, query, queryAll, register } from "../store.js";
import { ToolError, amount, call, describe, el, errorBanner, icon, isAccessDenied, loadingRows, newKey, notSimulated, openMenu, toast } from "../ui.js";
import { drawer, emptyRow, field, input, pageShell, pager, salesTabs, select } from "./common.js";
import { createSelection } from "./batch.js";
import { itemBatchActions } from "./batch-actions.js";

const SIZE = 25;
const typeLabel = (t) => (t === "NonInventory" ? "Non-inventory" : t);

export async function openItemDrawer(existing = null, onSaved) {
  let accounts = [];
  try { accounts = await queryAll("select * from Account where AccountType = 'Income'"); } catch (error) { toast(describe(error), { error: true }); return; }
  const it = existing ?? {};
  const type = select([["Service", "Service"], ["NonInventory", "Non-inventory"], ["Inventory", "Inventory (not simulated)", true], ["Bundle", "Bundle (not simulated)", true]], it.Type ?? "Service");
  if (existing) type.disabled = true;
  const f = {
    Type: field("Item type", type),
    Name: field("Name *", input({ value: it.Name ?? "" })),
    Sku: field("SKU", input({ value: it.Sku ?? "" })),
    Description: field("Description", el("textarea", { value: it.Description ?? "" }), { hint: "Description on sales forms" }),
    UnitPrice: field("Sales price/rate", input({ type: "number", step: "0.01", min: "0", value: it.UnitPrice ?? "" })),
    Income: field("Income account *", select([["", "Select an account"], ...accounts.map((a) => [a.Id, a.Name])], it.IncomeAccountRef?.value ?? "")),
  };
  const formError = el("div");
  const key = newKey();
  drawer(existing ? "Product/service information" : "New product/service", [formError, f.Type.wrap, f.Name.wrap, f.Sku.wrap, f.Description.wrap, el("div", { class: "row2" }, [f.UnitPrice.wrap, f.Income.wrap])], (close) => {
    const save = el("button", { type: "button", class: "btn primary", text: "Save and close" });
    save.addEventListener("click", async () => {
      for (const x of Object.values(f)) x.setError("");
      formError.replaceChildren();
      const body = { Name: f.Name.input.value.trim(), Type: type.value };
      if (!body.Name) return f.Name.setError("Enter a name.");
      if (!f.Income.input.value) return f.Income.setError("Select an income account.");
      body.IncomeAccountRef = { value: f.Income.input.value };
      const sku = f.Sku.input.value.trim(); if (sku) body.Sku = sku;
      const d = f.Description.input.value.trim(); if (d) body.Description = d;
      if (f.UnitPrice.input.value !== "") body.UnitPrice = Number(f.UnitPrice.input.value);
      if (existing) Object.assign(body, { Id: existing.Id, SyncToken: existing.SyncToken, sparse: true });
      save.disabled = true;
      try {
        const out = await call("items.post", { body }, key);
        close();
        toast(`${out.Item.Name} saved`);
        onSaved ? onSaved(out.Item) : go("#/items");
      } catch (error) {
        save.disabled = false;
        const target = error instanceof ToolError ? { Name: "Name", Sku: "Sku", UnitPrice: "UnitPrice", IncomeAccountRef: "Income", Type: "Type", Description: "Description" }[error.element] : undefined;
        if (target) f[target].setError(describe(error)); else formError.replaceChildren(errorBanner(error, "We couldn't save this product or service"));
      }
    });
    return [el("button", { type: "button", class: "btn", text: "Cancel", onclick: close }), save];
  });
}

register("items", async (host, route) => {
  const q = route.params.get("q") ?? "";
  const status = route.params.get("status") ?? "active";
  const start = Math.max(1, Number(route.params.get("start")) || 1);
  const nav = (patch) => { const p = new URLSearchParams(route.params); for (const [k, v] of Object.entries(patch)) v ? p.set(k, v) : p.delete(k); go(`#/items?${p}`); };
  const { root, body } = pageShell("Products & services", {
    crumb: "Sales & Get paid",
    actions: [el("button", { type: "button", class: "btn", text: "More", onclick: () => notSimulated("Manage categories") }), el("button", { type: "button", class: "btn primary", text: "New", onclick: () => openItemDrawer(null, () => host.isConnected && app.pages.items(host, route)) })],
    tabs: salesTabs("items"),
  });
  const search = el("input", { type: "search", placeholder: "Search", "aria-label": "Search products and services", value: q });
  search.addEventListener("keydown", (e) => { if (e.key === "Enter") nav({ q: search.value.trim(), start: "" }); });
  const stat = select([["active", "Active"], ["inactive", "Inactive"], ["all", "All"]], status);
  stat.setAttribute("aria-label", "Status");
  stat.addEventListener("change", () => nav({ status: stat.value, start: "" }));
  const refresh = () => { if (host.isConnected) app.pages.items(host, route); };
  const sel = createSelection({ noun: "products and services", labelFor: (it) => it.Name, actionsFor: (rows) => itemBatchActions(rows, refresh) });
  const tbody = el("tbody", {}, loadingRows(8));
  const foot = el("div");
  const card = el("div", { class: "card" }, [
    el("div", { class: "toolbar" }, [el("div", { class: "tsearch" }, [icon("search"), search]), el("label", { class: "filter-label" }, ["Status", stat]), el("div", { class: "grow" })]),
    sel.bar,
    el("div", { class: "table-wrap" }, el("table", { class: "grid" }, [el("thead", {}, el("tr", {}, [el("th", { class: "check" }, sel.head), ...["Name", "SKU", "Type", "Sales description", "Sales price", "Income account", "Action"].map((h, i) => el("th", { class: i === 4 ? "num" : i === 6 ? "act" : "", text: h }))])), tbody])),
    foot,
  ]);
  body.append(card);
  host.replaceChildren(root);
  try {
    const where = [status === "all" ? "Active IN (true, false)" : status === "inactive" ? "Active = false" : "Active = true"];
    if (q) where.push(`Name LIKE '%${q.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}%'`);
    const clause = ` where ${where.join(" AND ")}`;
    const total = (await call("query.run", { query: `select count(*) from Item${clause}` })).QueryResponse.totalCount ?? 0;
    const rows = await query(`select * from Item${clause} orderby Name STARTPOSITION ${start} MAXRESULTS ${SIZE}`);
    sel.reset();
    tbody.replaceChildren(...(rows.length ? rows.map((it) => {
      const edit = el("button", { type: "button", class: "link-btn", text: "Edit", onclick: () => openItemDrawer(it, refresh) });
      const caret = el("button", { type: "button", class: "caret", "aria-label": `More actions for ${it.Name}`, "aria-haspopup": "menu" }, icon("chevronDown"));
      caret.addEventListener("click", () => openMenu(caret, [
        { label: it.Active ? "Make inactive" : "Make active", run: async () => {
          try { await call("items.post", { body: { Id: it.Id, SyncToken: it.SyncToken, sparse: true, Name: it.Name, Type: it.Type, Active: !it.Active } }, newKey()); toast(`${it.Name} is now ${it.Active ? "inactive" : "active"}`); refresh(); } catch (error) { toast(describe(error), { error: true }); }
        } },
        { label: "Duplicate", run: () => notSimulated("Duplicate product") },
      ]));
      return el("tr", {}, [sel.cell(it), el("td", {}, [el("span", { text: it.Name }), it.Active ? null : el("span", { class: "pill inactive", text: "Inactive" })]), el("td", { text: it.Sku ?? "" }), el("td", { text: typeLabel(it.Type) }), el("td", { class: "muted", text: it.Description ?? "" }), el("td", { class: "num", text: it.UnitPrice === undefined || it.UnitPrice === null ? "" : amount(it.UnitPrice) }), el("td", { text: it.IncomeAccountRef?.name ?? "" }), el("td", { class: "act" }, el("div", { class: "row-actions" }, [edit, caret]))]);
    }) : [emptyRow(8, q ? "No products or services match your search" : "No products or services yet", q ? "Try a different name." : "Add the things you sell to use them on invoices.")]));
    foot.replaceChildren(pager({ start, size: SIZE, total, onChange: (s) => nav({ start: String(s) }) }));
  } catch (error) {
    card.replaceWith(errorBanner(error, isAccessDenied(error) ? "You don't have access to products and services" : "We couldn't load products and services"));
  }
});
