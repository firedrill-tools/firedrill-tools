// Product catalog: products list, product detail with its prices, add/edit product and add price.
import { canRead, canWrite, indexAll, invalidateCache, navigate, now, registerPage, routeHash, setTitle } from "./store.js";
import { ToolError, action, badge, button, call, confirmDialog, dateTime, el, field, humanize, idChip, input, intervalLabel, key, moneyCell, openMenu, openModal, priceLabel, select, textarea, toast } from "./ui.js";
import { amountInput, chip, dateCell, deniedPanel, empty, kv, listTools, load, metaBar, notSimulated, pageHeader, pageInner, pagedList, section, statTabs, submitModal, table, tabs } from "./widgets.js";

function productRows(products) {
  return table({
    select: { label: "products", rowLabel: (product) => `product ${product.name}` },
    columns: [
      { label: "Name", class: "truncate", render: (product) => el("span", { class: "customer-cell" }, [el("span", { class: "customer-cell-text" }, [el("span", { text: product.name }), product.description ? el("span", { class: "customer-cell-sub", text: product.description }) : null])]) },
      { label: "Pricing", class: "nowrap", render: (product) => (product.default_price && typeof product.default_price === "object" ? priceLabel(product.default_price) : el("span", { class: "muted", text: product.default_price ? product.default_price : "No default price" })) },
      { label: "Status", class: "nowrap", render: (product) => (product.active ? badge("Active", "green", "check-circle") : badge("Archived", "gray", "minus-circle")) },
      { label: "Updated", class: "nowrap", render: (product) => dateCell(product.updated ?? product.created) },
      { label: "Created", class: "nowrap", render: (product) => dateCell(product.created) },
      { label: "", class: "actions", render: (product) => productMenu(product) },
    ],
    rows: products,
    href: (product) => `#/products/${product.id}`,
    onOpen: (product) => navigate(`#/products/${product.id}`),
  });
}

function productMenu(product) {
  const trigger = button(undefined, "ghost", { icon: "more", size: "sm", ariaLabel: `Actions for ${product.name}`, class: "btn-icon-only" });
  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    openMenu(trigger, [
      { label: "View product", icon: "external", onSelect: () => navigate(`#/products/${product.id}`) },
      ...(canWrite("products") ? [{ label: "Edit product", icon: "edit", onSelect: () => openProductForm(product) }, { label: "Add another price", icon: "plus", onSelect: () => openPriceForm(product) }, { label: product.active ? "Archive product" : "Unarchive product", icon: product.active ? "trash" : "check", onSelect: () => toggleActive(product) }] : []),
      { label: "Copy product ID", icon: "copy", onSelect: () => navigator.clipboard?.writeText(product.id).then(() => toast("Copied to clipboard")) },
    ], { align: "end" });
  });
  return trigger;
}

// ---------------------------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------------------------

registerPage("products", async (host, route) => {
  setTitle("Product catalog");
  const tab = route.params.tab ?? "available";
  const actions = [];
  if (canWrite("products")) actions.push(button("Add product", "primary", { icon: "plus", onClick: () => openProductForm() }));
  const header = pageHeader("Product catalog", { actions });
  const sectionTabs = tabs(CATALOG_SECTIONS, "products", () => navigate("#/products"));
  const selectStatus = (next) => navigate(routeHash("products", undefined, { tab: next === "available" ? undefined : next }));
  const tabsHost = el("div");
  const drawStatus = (counts) => tabsHost.replaceChildren(statTabs(PRODUCT_STATUS.map((entry) => ({ ...entry, count: counts?.[entry.key] })), tab, selectStatus));
  drawStatus(undefined);
  const listHost = el("div");
  const filters = el("div", { class: "filters" }, [chip("Created date", { onClick: () => notSimulated("Created date filter") }), chip("Price", { onClick: () => notSimulated("Price filter") }), chip("More filters", { onClick: () => notSimulated("More filters") }), listTools([["Export prices", "download", "Price exports are not produced by this synthetic account."]])]);
  host.replaceChildren(pageInner(header, sectionTabs, tabsHost, filters, listHost));
  if (!canRead("products")) {
    listHost.append(deniedPanel(new ToolError("tool_error", "tool.PERMISSION_DENIED", "", { group: "products" }), "products"));
    return;
  }
  const args = { expand: ["data.default_price"] };
  if (tab === "available") args.active = true;
  if (tab === "archived") args.active = false;
  const list = pagedList({
    operation: "products.list",
    args,
    limit: 20,
    render: productRows,
    emptyNode: () => (tab === "archived" ? empty("No archived products", "Archived products stop appearing in pickers but keep their history.") : empty("Add your first product", "Products describe what you sell; prices say how much and how often.", canWrite("products") ? button("Add product", "primary", { icon: "plus", onClick: () => openProductForm() }) : undefined)),
  });
  listHost.append(list.element);
  try {
    const index = await indexAll("products.list", {});
    const suffix = index.complete ? "" : "+";
    const active = index.items.filter((product) => product.active).length;
    drawStatus({ all: `${index.items.length}${suffix}`, available: `${active}${suffix}`, archived: `${index.items.length - active}${suffix}` });
  } catch {
    drawStatus(undefined);
  }
});

const CATALOG_SECTIONS = Object.freeze([
  { key: "products", label: "Products" },
  { key: "coupons", label: "Coupons", notSimulated: "Coupons and promotion codes are not modelled; invoices and subscriptions carry no discounts." },
  { key: "shipping_rates", label: "Shipping rates", notSimulated: "Shipping rates are not modelled by this synthetic account." },
  { key: "tax_rates", label: "Tax rates", notSimulated: "Tax rates are not modelled; invoices carry no tax lines." },
  { key: "pricing_tables", label: "Pricing tables", notSimulated: "Pricing tables are hosted embeds and are not simulated." },
]);
const PRODUCT_STATUS = Object.freeze([
  { key: "all", label: "All" },
  { key: "available", label: "Active" },
  { key: "archived", label: "Archived" },
]);

// ---------------------------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------------------------

registerPage("product", async (host, route) => {
  setTitle(route.id);
  const inner = pageInner();
  host.replaceChildren(inner);
  await load(inner, async () => {
    const product = await call("products.retrieve", { product: route.id, expand: ["default_price"] });
    // Every price of the product, paged with starting_after (bounded index; the UI says when it stops early).
    const index = await indexAll("prices.list", { product: product.id });
    return renderProduct(product, index.items, index.complete);
  }, { retry: () => navigate(location.hash) });
});

function renderProduct(product, prices, complete = true) {
  const defaultId = typeof product.default_price === "object" && product.default_price !== null ? product.default_price.id : product.default_price;
  const actions = [];
  if (canWrite("products")) {
    actions.push(button("Add another price", "secondary", { icon: "plus", onClick: () => openPriceForm(product) }));
    actions.push(button("Edit product", "secondary", { icon: "edit", onClick: () => openProductForm(product) }));
  }
  const more = button(undefined, "secondary", { icon: "more", ariaLabel: "More actions", class: "btn-icon-only" });
  more.addEventListener("click", () =>
    openMenu(more, [
      { label: "Copy product ID", icon: "copy", onSelect: () => navigator.clipboard?.writeText(product.id).then(() => toast("Copied to clipboard")) },
      ...(canWrite("products") ? ["divider", { label: product.active ? "Archive product" : "Unarchive product", icon: product.active ? "trash" : "check", danger: product.active, onSelect: () => toggleActive(product) }] : []),
    ], { align: "end" }),
  );
  actions.push(more);
  const title = el("div", { class: "detail-title" }, [el("h1", { class: "page-title", text: product.name }), product.active ? badge("Active", "green", "check-circle") : badge("Archived", "gray", "minus-circle")]);
  const header = pageHeader(title, { kind: "Product", actions, breadcrumbs: [{ label: "Product catalog", href: "#/products" }, { label: product.id }] });
  const meta = metaBar([
    ["Default price", defaultId ? priceLabel(prices.find((price) => price.id === defaultId) ?? product.default_price) : el("span", { class: "muted", text: "None" })],
    ["Prices", `${prices.length}${complete ? "" : "+"} price${prices.length === 1 ? "" : "s"}`],
    ["Updated", dateTime(product.updated ?? product.created, now())],
    ["Created", dateTime(product.created, now())],
  ]);
  const details = section("Details", kv([
    ["Name", product.name],
    ["Description", product.description],
    ["Unit label", product.unit_label],
    ["Type", humanize(product.type)],
    ["Statement descriptor", product.statement_descriptor],
    ["Images", product.images?.length ? product.images.join(", ") : null],
    ["ID", idChip(product.id)],
  ]));
  const pricesTable = prices.length === 0 ? empty("No prices yet", "Add a price so this product can be sold.", canWrite("products") ? button("Add a price", "primary", { icon: "plus", onClick: () => openPriceForm(product) }) : undefined) : table({
    columns: [
      { label: "Price", class: "nowrap", render: (price) => el("span", { class: "amount-status" }, [moneyCell(price.unit_amount, price.currency), price.id === defaultId ? badge("Default", "purple") : null]) },
      { label: "Nickname", class: "truncate", render: (price) => price.nickname },
      { label: "Billing", class: "nowrap", render: (price) => intervalLabel(price.recurring) },
      { label: "Lookup key", render: (price) => (price.lookup_key ? el("code", { class: "id-code", text: price.lookup_key }) : null) },
      { label: "Status", class: "nowrap", render: (price) => (price.active ? badge("Active", "green") : badge("Inactive", "gray")) },
      { label: "ID", render: (price) => idChip(price.id) },
      { label: "Created", class: "nowrap", render: (price) => dateCell(price.created) },
      { label: "", class: "actions", render: (price) => priceMenu(product, price, defaultId) },
    ],
    rows: prices,
  });
  const pricesBody = complete ? pricesTable : el("div", {}, [el("p", { class: "muted", text: `Showing the first ${prices.length.toLocaleString("en-US")} prices of this product.` }), pricesTable]);
  const pricesSection = section("Pricing", pricesBody, { count: `${prices.length}${complete ? "" : "+"}`, actions: canWrite("products") ? [button("Add another price", "secondary", { size: "sm", icon: "plus", onClick: () => openPriceForm(product) })] : [] });
  const metadataRows = Object.entries(product.metadata ?? {});
  const metadataSection = section("Metadata", metadataRows.length > 0 ? kv(metadataRows) : el("p", { class: "muted", text: "No metadata" }));
  return [header, meta, pricesSection, details, metadataSection];
}

function priceMenu(product, price, defaultId) {
  const trigger = button(undefined, "ghost", { icon: "more", size: "sm", ariaLabel: `Actions for ${price.id}`, class: "btn-icon-only" });
  trigger.addEventListener("click", () =>
    openMenu(trigger, [
      ...(canWrite("products") && price.id !== defaultId && price.active ? [{ label: "Set as default price", icon: "check", onSelect: () => action(async () => { await call("products.update", { product: product.id, default_price: price.id }, key()); toast("Default price updated"); invalidateCache(); navigate(location.hash); }) }] : []),
      { label: "Copy price ID", icon: "copy", onSelect: () => navigator.clipboard?.writeText(price.id).then(() => toast("Copied to clipboard")) },
      ...(canWrite("subscriptions") && price.recurring ? [{ label: "Create subscription with this price", icon: "subscriptions", onSelect: () => navigate(routeHash("subscriptions", "new", { price: price.id })) }] : []),
      { label: "Edit price", icon: "edit", disabled: true, description: "Prices are immutable" },
    ], { align: "end" }),
  );
  return trigger;
}

async function toggleActive(product) {
  const archive = product.active;
  const ok = await confirmDialog(archive ? "Archive product?" : "Unarchive product?", archive ? `${product.name} will be hidden from new invoices and subscriptions. Existing subscriptions keep working.` : `${product.name} becomes available again.`, archive ? "Archive" : "Unarchive", { danger: archive });
  if (!ok) return;
  await action(async () => {
    await call("products.update", { product: product.id, active: !archive }, key());
    toast(archive ? "Product archived" : "Product unarchived");
    invalidateCache();
    navigate(location.hash);
  });
}

// ---------------------------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------------------------

/** Add (no `existing`) or edit a product; a new product gets an inline first price. */
export function openProductForm(existing) {
  const name = input({ placeholder: "Premium plan, sunglasses, etc.", value: existing?.name ?? "" });
  const description = textarea({ placeholder: "Appears at checkout, on the customer portal and in quotes", value: existing?.description ?? "", rows: 2 });
  const unitLabel = input({ placeholder: "e.g. seat, unit, hour", value: existing?.unit_label ?? "" });
  const active = el("input", { attrs: { type: "checkbox" } });
  active.checked = existing ? existing.active : true;
  const fields = { name: field("Name", name), description: field("Description", description, { optional: true }), unit_label: field("Unit label", unitLabel, { optional: true }) };
  const body = [fields.name, fields.description, fields.unit_label];
  let priceFields;
  if (!existing) {
    priceFields = priceFieldset();
    body.push(el("div", { class: "form-section-title", text: "Price information" }), ...priceFields.nodes);
  } else body.push(el("label", { class: "check-field" }, [active, el("span", { class: "check-label", text: "Active" }, [el("span", { class: "check-hint", text: "Inactive (archived) products are hidden from new invoices and subscriptions." })])]));
  const idempotencyKey = key();
  openModal({
    title: existing ? "Edit product" : "Add a product",
    size: "modal-lg",
    body,
    actions: [
      { label: "Cancel" },
      {
        label: existing ? "Save product" : "Add product",
        kind: "primary",
        submit: true,
        onClick: (api) => {
          if (!name.value.trim()) {
            fields.name.setError("Name is required.");
            return;
          }
          const args = { name: name.value.trim(), description: description.value.trim() || undefined, unit_label: unitLabel.value.trim() || undefined };
          if (existing) args.active = active.checked;
          let priceArgs;
          if (priceFields) {
            priceArgs = priceFields.read();
            if (priceArgs === undefined) return;
          }
          return submitModal(api, { ...fields, ...(priceFields?.fields ?? {}) }, async () => {
            if (existing) return call("products.update", { product: existing.id, ...args }, idempotencyKey);
            const product = await call("products.create", args, idempotencyKey);
            if (priceArgs && priceArgs.unit_amount !== undefined) {
              const price = await call("prices.create", { product: product.id, ...priceArgs }, key());
              await call("products.update", { product: product.id, default_price: price.id }, key());
            }
            return product;
          }, (product) => {
            toast(existing ? "Product saved" : "Product added");
            invalidateCache();
            navigate(`#/products/${product.id}`);
          });
        },
      },
    ],
  });
}

function priceFieldset(product) {
  const amount = amountInput({ currency: "usd" });
  const model = select([{ value: "one_time", label: "One-off" }, { value: "recurring", label: "Recurring" }], product ? "recurring" : "one_time");
  const interval = select([{ value: "day", label: "Daily" }, { value: "week", label: "Weekly" }, { value: "month", label: "Monthly" }, { value: "year", label: "Yearly" }], "month");
  const intervalCount = input({ type: "number", value: "1", min: 1, max: 12 });
  const nickname = input({ placeholder: "Shown in lists, not to customers" });
  const lookupKey = input({ placeholder: "e.g. summit_monthly (unique among active prices)" });
  const trialDays = input({ type: "number", placeholder: "0", min: 1, max: 730 });
  const fields = {
    unit_amount: field("Amount", amount),
    recurring: field("Billing period", el("div", { class: "field-row" }, [interval, intervalCount])),
    nickname: field("Price description", nickname, { optional: true }),
    lookup_key: field("Lookup key", lookupKey, { optional: true }),
    trial_period_days: field("Free trial days", trialDays, { optional: true }),
  };
  const modelField = field("Pricing model", model);
  const toggle = () => {
    const recurring = model.value === "recurring";
    fields.recurring.hidden = !recurring;
    fields.trial_period_days.hidden = !recurring;
  };
  model.addEventListener("change", toggle);
  toggle();
  return {
    nodes: [fields.unit_amount, modelField, fields.recurring, fields.trial_period_days, fields.nickname, fields.lookup_key],
    fields,
    read() {
      const minor = amount.amount();
      if (minor === undefined || minor < 0) {
        fields.unit_amount.setError("Enter a valid amount, for example 29.00.");
        return undefined;
      }
      const args = { currency: amount.currency(), unit_amount: minor };
      if (nickname.value.trim()) args.nickname = nickname.value.trim();
      if (lookupKey.value.trim()) args.lookup_key = lookupKey.value.trim();
      if (model.value === "recurring") {
        args.recurring = { interval: interval.value, interval_count: Number(intervalCount.value || 1) };
        if (trialDays.value) args.recurring.trial_period_days = Number(trialDays.value);
      }
      return args;
    },
  };
}

export function openPriceForm(product) {
  const set = priceFieldset(product);
  const idempotencyKey = key();
  openModal({
    title: `Add a price to ${product.name}`,
    body: set.nodes,
    actions: [
      { label: "Cancel" },
      {
        label: "Add price",
        kind: "primary",
        submit: true,
        onClick: (api) => {
          const args = set.read();
          if (!args) return;
          return submitModal(api, set.fields, () => call("prices.create", { product: product.id, ...args }, idempotencyKey), () => {
            toast("Price added");
            invalidateCache();
            navigate(location.hash);
          });
        },
      },
    ],
  });
}

