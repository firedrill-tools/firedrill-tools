// Products and prices. Prices are immutable in this Tool (no `prices.update`); `lookup_key` is unique among
// active prices as in Stripe.

import { nextId } from "../lib/ids.mjs";
import { decimalString } from "../lib/money.mjs";
import { applyExpand, makeView, renderPrice, renderProduct, validateExpand } from "../lib/objects.mjs";
import { INTERVALS, MAX_INTERVAL_COUNT } from "../lib/periods.mjs";
import { allRows, getRow, invalid, matchesRange, paginate, parameterMissing, parameterUnknown, requirePermission, requireRow, resourceMissing } from "../lib/state.mjs";
import { isPlainObject, mergeMetadata, optionalBoolean, optionalEnum, optionalInteger, optionalString, optionalStringArray, rejectMangled, requireCurrency, requireInteger, requireString } from "../lib/validate.mjs";

const TAX_BEHAVIOR = ["unspecified", "inclusive", "exclusive"];

// ---------------------------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------------------------

function productFields(context, input, current) {
  return {
    name: current === null ? requireString(context, input, "name", 250) : input.name === undefined ? current.name : requireString(context, input, "name", 250),
    description: optionalString(context, input, "description", current === null ? null : current.description, 40_000),
    active: optionalBoolean(context, input, "active", current === null ? true : current.active),
    metadata: mergeMetadata(context, input.metadata, current === null ? {} : current.metadata),
    unit_label: optionalString(context, input, "unit_label", current === null ? null : current.unit_label, 12),
    images: optionalStringArray(context, input, "images", current === null ? [] : current.images),
  };
}

export function productsCreate(input, context) {
  requirePermission(context, "products", "write");
  const view = makeView(context);
  const expand = validateExpand(context, input.expand, "product");
  const fields = productFields(context, input, null);
  if (fields.images.length > 8) return invalid(context, "You can specify up to 8 images.", "parameter_invalid", "images");
  if (input.default_price !== undefined) {
    return invalid(context, "default_price cannot be set when creating a product because no price of the product exists yet; create the price, then update the product.", "parameter_invalid", "default_price");
  }
  const id = nextId(context, "prod");
  const product = {
    id,
    object: "product",
    active: fields.active,
    created: view.now,
    default_price: null,
    description: fields.description,
    images: fields.images,
    livemode: view.livemode,
    marketing_features: [],
    metadata: fields.metadata,
    name: fields.name,
    package_dimensions: null,
    shippable: null,
    statement_descriptor: null,
    tax_code: null,
    type: "service",
    unit_label: fields.unit_label,
    updated: view.now,
    url: null,
  };
  context.state.put("products", id, product);
  return applyExpand(view, renderProduct(view, product), expand, "product");
}

export function productsRetrieve(input, context) {
  requirePermission(context, "products", "read");
  const view = makeView(context);
  const expand = validateExpand(context, input.expand, "product");
  const product = requireRow(context, "products", input.product, "product");
  return applyExpand(view, renderProduct(view, product), expand, "product");
}

export function productsUpdate(input, context) {
  requirePermission(context, "products", "write");
  const view = makeView(context);
  const expand = validateExpand(context, input.expand, "product");
  const current = requireRow(context, "products", input.product, "product");
  const fields = productFields(context, input, current);
  if (fields.images.length > 8) return invalid(context, "You can specify up to 8 images.", "parameter_invalid", "images");
  let defaultPrice = current.default_price;
  if (input.default_price !== undefined) {
    if (input.default_price === "" || input.default_price === null) defaultPrice = null;
    else {
      const price = getRow(context, "prices", input.default_price);
      if (price === null || price.product !== current.id) {
        return invalid(context, `The price '${String(input.default_price)}' does not belong to product '${current.id}'.`, "parameter_invalid", "default_price");
      }
      if (!price.active) return invalid(context, `The price '${price.id}' is not active and cannot be the default price.`, "parameter_invalid", "default_price");
      defaultPrice = price.id;
    }
  }
  const product = { ...current, ...fields, default_price: defaultPrice, updated: view.now };
  context.state.put("products", product.id, product);
  return applyExpand(view, renderProduct(view, product), expand, "product");
}

export function productsList(input, context) {
  requirePermission(context, "products", "read");
  rejectMangled(context, input, ["ids"]);
  const view = makeView(context);
  const expand = validateExpand(context, input.expand, "product", true);
  const active = optionalBoolean(context, input, "active", undefined);
  const ids = optionalStringArray(context, input, "ids", undefined);
  const rows = allRows(context, "products").filter(
    (product) => (active === undefined || product.active === active) && (ids === undefined || ids.includes(product.id)) && matchesRange(product.created, input.created, context, "created"),
  );
  return paginate(context, "products", rows, input, "/v1/products", (row) => applyExpand(view, renderProduct(view, row), expand, "product"));
}

// ---------------------------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------------------------

function recurringInput(context, value) {
  if (value === undefined) return null;
  if (!isPlainObject(value)) return invalid(context, "Invalid recurring: must be a hash.", "parameter_invalid", "recurring");
  for (const key of Object.keys(value)) {
    if (!["interval", "interval_count", "trial_period_days"].includes(key)) return parameterUnknown(context, `recurring[${key}]`);
  }
  if (value.interval === undefined) return parameterMissing(context, "recurring[interval]");
  if (!INTERVALS.includes(value.interval)) return invalid(context, `Invalid recurring[interval]: must be one of ${INTERVALS.join(", ")}`, "parameter_invalid", "recurring[interval]");
  const count = optionalInteger(context, value, "interval_count", 1, { min: 1 });
  if (count > MAX_INTERVAL_COUNT[value.interval]) {
    return invalid(context, `The maximum billing interval is one year; recurring[interval_count] for '${value.interval}' must be at most ${MAX_INTERVAL_COUNT[value.interval]}.`, "parameter_invalid", "recurring[interval_count]");
  }
  const trial = optionalInteger(context, value, "trial_period_days", null, { min: 1, max: 730 });
  return { interval: value.interval, interval_count: count, meter: null, trial_period_days: trial, usage_type: "licensed" };
}

export function pricesCreate(input, context) {
  requirePermission(context, "products", "write");
  const view = makeView(context);
  const expand = validateExpand(context, input.expand, "price");
  const productId = requireString(context, input, "product", 255);
  const product = getRow(context, "products", productId);
  if (product === null) return resourceMissing(context, "products", productId, "product");
  const currency = requireCurrency(context, input.currency);
  const unitAmount = requireInteger(context, input, "unit_amount", { min: 0, max: 99_999_999 });
  const recurring = recurringInput(context, input.recurring);
  const nickname = optionalString(context, input, "nickname", null, 250);
  const lookupKey = optionalString(context, input, "lookup_key", null, 200);
  const active = optionalBoolean(context, input, "active", true);
  const metadata = mergeMetadata(context, input.metadata);
  const taxBehavior = optionalEnum(context, input, "tax_behavior", TAX_BEHAVIOR, "unspecified");
  if (lookupKey !== null && active) {
    const clash = allRows(context, "prices").find((price) => price.active && price.lookup_key === lookupKey);
    if (clash !== undefined) {
      return invalid(context, `An active price with lookup_key '${lookupKey}' already exists (${clash.id}). Pass transfer_lookup_key=true to move it, or choose another key.`, "resource_already_exists", "lookup_key");
    }
  }
  const id = nextId(context, "price");
  const price = {
    id,
    object: "price",
    active,
    billing_scheme: "per_unit",
    created: view.now,
    currency,
    custom_unit_amount: null,
    livemode: view.livemode,
    lookup_key: lookupKey,
    metadata,
    nickname,
    product: product.id,
    recurring,
    tax_behavior: taxBehavior,
    tiers_mode: null,
    transform_quantity: null,
    type: recurring === null ? "one_time" : "recurring",
    unit_amount: unitAmount,
    unit_amount_decimal: decimalString(unitAmount),
  };
  context.state.put("prices", id, price);
  return applyExpand(view, renderPrice(view, price), expand, "price");
}

export function pricesRetrieve(input, context) {
  requirePermission(context, "products", "read");
  const view = makeView(context);
  const expand = validateExpand(context, input.expand, "price");
  const price = requireRow(context, "prices", input.price, "price");
  return applyExpand(view, renderPrice(view, price), expand, "price");
}

export function pricesList(input, context) {
  requirePermission(context, "products", "read");
  rejectMangled(context, input, ["product", "lookup_keys", "currency", "type"]);
  const view = makeView(context);
  const expand = validateExpand(context, input.expand, "price", true);
  const product = optionalString(context, input, "product", undefined, 255);
  const active = optionalBoolean(context, input, "active", undefined);
  const type = optionalEnum(context, input, "type", ["one_time", "recurring"], undefined);
  const currency = input.currency === undefined ? undefined : requireCurrency(context, input.currency);
  const lookupKeys = optionalStringArray(context, input, "lookup_keys", undefined);
  const rows = allRows(context, "prices").filter(
    (price) =>
      (product === undefined || price.product === product) &&
      (active === undefined || price.active === active) &&
      (type === undefined || price.type === type) &&
      (currency === undefined || price.currency === currency) &&
      (lookupKeys === undefined || (price.lookup_key !== null && lookupKeys.includes(price.lookup_key))) &&
      matchesRange(price.created, input.created, context, "created"),
  );
  return paginate(context, "prices", rows, input, "/v1/prices", (row) => applyExpand(view, renderPrice(view, row), expand, "price"));
}
