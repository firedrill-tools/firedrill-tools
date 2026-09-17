// Customers and payment methods. Cards are synthetic: Stripe's published test ids materialise real
// `payment_methods` rows when attached or confirmed, exactly as Stripe's test mode does.

import { cardDetails, testCard } from "../lib/cards.mjs";
import { invoicePrefix, nextId, nextSequence, renderId } from "../lib/ids.mjs";
import { applyExpand, makeView, renderCustomer, renderPaymentMethod, validateExpand } from "../lib/objects.mjs";
import { allRows, getRow, invalidState, matchesRange, paginate, parameterMissing, parameterUnknown, requirePermission, requirePermissions, requireRow, resourceMissing } from "../lib/state.mjs";
import { isPlainObject, mergeMetadata, normalizeAddress, normalizeShipping, optionalEnum, optionalString, optionalStringArray, rejectMangled, validateEmail } from "../lib/validate.mjs";

const TAX_EXEMPT = ["none", "exempt", "reverse"];
const EMPTY_ADDRESS = Object.freeze({ city: null, country: null, line1: null, line2: null, postal_code: null, state: null });

// ---------------------------------------------------------------------------------------------
// Payment method helpers (shared with payments and billing)
// ---------------------------------------------------------------------------------------------

/** A test id (`pm_card_*`) → `{ card }`; a materialised row → `{ row }`; anything else fails `RESOURCE_MISSING`. */
export function resolvePaymentMethod(context, view, id, param = "payment_method") {
  if (typeof id !== "string" || id.length === 0) return parameterMissing(context, param);
  const card = testCard(id);
  if (card !== undefined) {
    if (view.livemode) return resourceMissing(context, "payment_methods", id, param);
    return { card, testId: id };
  }
  const row = getRow(context, "payment_methods", id);
  if (row === null) return resourceMissing(context, "payment_methods", id, param);
  return { row };
}

function billingDetails(customer) {
  if (customer === null) return { address: { ...EMPTY_ADDRESS }, email: null, name: null, phone: null };
  return { address: customer.address === null ? { ...EMPTY_ADDRESS } : { ...customer.address }, email: customer.email, name: customer.name, phone: customer.phone };
}

/** Create a `payment_methods` row for a catalogue card, optionally attached to `customer` (a row or null). */
export function materializeCard(context, view, card, customer) {
  const id = nextId(context, "pm");
  const row = {
    id,
    object: "payment_method",
    allow_redisplay: "unspecified",
    billing_details: billingDetails(customer),
    card: cardDetails(card),
    created: view.now,
    customer: customer === null ? null : customer.id,
    livemode: view.livemode,
    metadata: {},
    type: "card",
    outcome: card.outcome,
  };
  context.state.put("payment_methods", id, row);
  return row;
}

/** Attach a resolved method to a customer, materialising test cards; fails when it belongs to someone. */
export function attachMethod(context, view, resolved, customer) {
  if (resolved.card !== undefined) return materializeCard(context, view, resolved.card, customer);
  if (resolved.row.customer !== null) {
    return invalidState(context, "The payment method you provided has already been attached to a customer.", "payment_method_already_attached");
  }
  const row = { ...resolved.row, customer: customer.id, billing_details: billingDetails(customer) };
  context.state.put("payment_methods", row.id, row);
  return row;
}

/** Resolve an id that must name a method attached to `customer` (for defaults); returns the row. */
export function requireAttachedMethod(context, view, id, customer, param) {
  const resolved = resolvePaymentMethod(context, view, id, param);
  if (resolved.card !== undefined || resolved.row.customer !== customer.id) {
    return invalidState(context, `The payment method '${id}' is not attached to customer '${customer.id}'. Attach it first with /v1/payment_methods/:id/attach.`, "payment_method_unattached");
  }
  return resolved.row;
}

// ---------------------------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------------------------

function newCustomerRow(view, sequence, fields) {
  return {
    id: renderId("cus", sequence),
    object: "customer",
    address: fields.address,
    balance: 0,
    created: view.now,
    currency: null,
    default_source: null,
    delinquent: false,
    description: fields.description,
    email: fields.email,
    invoice_prefix: invoicePrefix(sequence),
    invoice_settings: { custom_fields: null, default_payment_method: null, footer: null, rendering_options: null },
    livemode: view.livemode,
    metadata: fields.metadata,
    name: fields.name,
    next_invoice_sequence: 1,
    phone: fields.phone,
    preferred_locales: fields.preferred_locales,
    shipping: fields.shipping,
    tax_exempt: fields.tax_exempt,
    test_clock: null,
  };
}

function invoiceSettingsInput(context, input) {
  const settings = input.invoice_settings;
  if (settings === undefined) return undefined;
  if (!isPlainObject(settings)) return parameterUnknown(context, "invoice_settings");
  for (const key of Object.keys(settings)) if (key !== "default_payment_method") return parameterUnknown(context, `invoice_settings[${key}]`);
  return settings.default_payment_method;
}

export function customersCreate(input, context) {
  requirePermission(context, "customers", "write");
  const view = makeView(context);
  const expand = validateExpand(context, input.expand, "customer");
  const fields = {
    name: optionalString(context, input, "name", null, 256),
    email: validateEmail(context, optionalString(context, input, "email", null, 512)),
    description: optionalString(context, input, "description", null),
    phone: optionalString(context, input, "phone", null, 20),
    address: normalizeAddress(context, input.address),
    shipping: normalizeShipping(context, input.shipping),
    metadata: mergeMetadata(context, input.metadata),
    preferred_locales: optionalStringArray(context, input, "preferred_locales", []),
    tax_exempt: optionalEnum(context, input, "tax_exempt", TAX_EXEMPT, "none"),
  };
  const defaultMethod = invoiceSettingsInput(context, input);
  const sequence = nextSequence(context);
  const customer = newCustomerRow(view, sequence, fields);
  if (input.payment_method !== undefined) {
    const resolved = resolvePaymentMethod(context, view, input.payment_method);
    if (defaultMethod !== undefined && defaultMethod !== "" && defaultMethod !== input.payment_method) {
      return invalidState(context, `The payment method '${defaultMethod}' is not attached to this customer.`, "payment_method_unattached");
    }
    const method = attachMethod(context, view, resolved, customer);
    customer.invoice_settings.default_payment_method = method.id;
    if (method.billing_details.name === null && method.billing_details.email === null) {
      context.state.put("payment_methods", method.id, { ...method, billing_details: billingDetails(customer) });
    }
  } else if (defaultMethod !== undefined && defaultMethod !== "") {
    return invalidState(context, `The payment method '${defaultMethod}' is not attached to this customer.`, "payment_method_unattached");
  }
  context.state.put("customers", customer.id, customer);
  return applyExpand(view, renderCustomer(view, customer), expand, "customer");
}

export function customersRetrieve(input, context) {
  requirePermission(context, "customers", "read");
  const view = makeView(context);
  const expand = validateExpand(context, input.expand, "customer");
  const customer = requireRow(context, "customers", input.customer, "customer");
  return applyExpand(view, renderCustomer(view, customer), expand, "customer");
}

export function customersUpdate(input, context) {
  requirePermission(context, "customers", "write");
  const view = makeView(context);
  const expand = validateExpand(context, input.expand, "customer");
  const current = requireRow(context, "customers", input.customer, "customer");
  const next = {
    ...current,
    name: optionalString(context, input, "name", current.name, 256),
    email: validateEmail(context, optionalString(context, input, "email", current.email, 512)),
    description: optionalString(context, input, "description", current.description),
    phone: optionalString(context, input, "phone", current.phone, 20),
    address: normalizeAddress(context, input.address, "address", current.address),
    shipping: normalizeShipping(context, input.shipping, current.shipping),
    metadata: mergeMetadata(context, input.metadata, current.metadata),
    preferred_locales: optionalStringArray(context, input, "preferred_locales", current.preferred_locales),
    tax_exempt: optionalEnum(context, input, "tax_exempt", TAX_EXEMPT, current.tax_exempt),
    invoice_settings: { ...current.invoice_settings },
  };
  const defaultMethod = invoiceSettingsInput(context, input);
  if (defaultMethod !== undefined) {
    if (defaultMethod === "" || defaultMethod === null) next.invoice_settings.default_payment_method = null;
    else next.invoice_settings.default_payment_method = requireAttachedMethod(context, view, defaultMethod, current, "invoice_settings[default_payment_method]").id;
  }
  next.delinquent = renderCustomer(view, current).delinquent;
  context.state.put("customers", next.id, next);
  return applyExpand(view, renderCustomer(view, next), expand, "customer");
}

export function customersList(input, context) {
  requirePermission(context, "customers", "read");
  rejectMangled(context, input, ["email"]);
  const view = makeView(context);
  const expand = validateExpand(context, input.expand, "customer", true);
  const email = optionalString(context, input, "email", undefined, 512);
  const rows = allRows(context, "customers").filter(
    (customer) => (email === undefined || email === null || customer.email === email) && matchesRange(customer.created, input.created, context, "created"),
  );
  return paginate(context, "customers", rows, input, "/v1/customers", (row) => applyExpand(view, renderCustomer(view, row), expand, "customer"));
}

// ---------------------------------------------------------------------------------------------
// Payment methods
// ---------------------------------------------------------------------------------------------

export function paymentMethodsList(input, context) {
  requirePermission(context, "payment_methods", "read");
  rejectMangled(context, input, ["customer", "type"]);
  const view = makeView(context);
  const expand = validateExpand(context, input.expand, "payment_method", true);
  const customer = requireRow(context, "customers", input.customer, "customer");
  const type = optionalString(context, input, "type", undefined, 64);
  const rows = type !== undefined && type !== "card" ? [] : allRows(context, "payment_methods").filter((method) => method.customer === customer.id);
  return paginate(context, "payment_methods", rows, input, "/v1/payment_methods", (row) => applyExpand(view, renderPaymentMethod(view, row), expand, "payment_method"));
}

export function paymentMethodsAttach(input, context) {
  requirePermissions(context, [["payment_methods", "write"], ["customers", "read"]]);
  const view = makeView(context);
  const expand = validateExpand(context, input.expand, "payment_method");
  const customer = requireRow(context, "customers", input.customer, "customer");
  const resolved = resolvePaymentMethod(context, view, input.payment_method);
  const method = attachMethod(context, view, resolved, customer);
  return applyExpand(view, renderPaymentMethod(view, method), expand, "payment_method");
}

export function paymentMethodsDetach(input, context) {
  requirePermission(context, "payment_methods", "write");
  const view = makeView(context);
  const expand = validateExpand(context, input.expand, "payment_method");
  const method = requireRow(context, "payment_methods", input.payment_method, "payment_method");
  if (method.customer === null) {
    return invalidState(context, "A payment method cannot be detached because it is not attached to a customer.", "payment_method_unattached");
  }
  const customer = getRow(context, "customers", method.customer);
  if (customer !== null && customer.invoice_settings.default_payment_method === method.id) {
    context.state.put("customers", customer.id, { ...customer, invoice_settings: { ...customer.invoice_settings, default_payment_method: null } });
  }
  for (const subscription of allRows(context, "subscriptions")) {
    if (subscription.default_payment_method === method.id && subscription.status !== "canceled") {
      context.state.put("subscriptions", subscription.id, { ...subscription, default_payment_method: null });
    }
  }
  const detached = { ...method, customer: null, billing_details: billingDetails(null) };
  context.state.put("payment_methods", detached.id, detached);
  return applyExpand(view, renderPaymentMethod(view, detached), expand, "payment_method");
}
