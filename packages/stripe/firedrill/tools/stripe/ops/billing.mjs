// Invoice items, invoices and subscriptions. Invoices follow draft → open → paid | void; subscriptions create
// their first invoice and attempt the first payment in the same transaction. No renewal cycling, dunning or
// proration runs in this Tool (documented in the README).

import { nextId } from "../lib/ids.mjs";
import { decimalString, formatAmount } from "../lib/money.mjs";
import { applyExpand, makeView, renderInvoice, renderInvoiceItem, renderSubscription, validateExpand } from "../lib/objects.mjs";
import { DAY, addInterval } from "../lib/periods.mjs";
import { requireFits } from "../lib/size.mjs";
import { allRows, getRow, invalid, invalidState, matchesRange, paginate, parameterMissing, parameterUnknown, requirePermission, requirePermissions, requireRow, resourceMissing } from "../lib/state.mjs";
import { isPlainObject, mergeMetadata, optionalBoolean, optionalEnum, optionalInteger, optionalString, rejectMangled, requireCurrency, requireInteger, requireString } from "../lib/validate.mjs";
import { requireAttachedMethod, resolvePaymentMethod } from "./customers.mjs";
import { accountInfo, confirmAttempt, declinedFailure, newIntentRow } from "./payments.mjs";

const COLLECTION_METHODS = ["charge_automatically", "send_invoice"];
const INVOICE_STATUSES = ["draft", "open", "paid", "uncollectible", "void"];
const SUBSCRIPTION_STATUSES = ["incomplete", "incomplete_expired", "trialing", "active", "past_due", "canceled", "unpaid", "paused"];
const PAYMENT_BEHAVIORS = ["default_incomplete", "allow_incomplete", "error_if_incomplete"];
const PRORATION_BEHAVIORS = ["create_prorations", "none", "always_invoice", "none_implicit"];
const PENDING_BEHAVIORS = ["include", "exclude"];
const MAX_ITEMS = 20;

// ---------------------------------------------------------------------------------------------
// Shared builders
// ---------------------------------------------------------------------------------------------

function customerSnapshot(customer) {
  return {
    customer_address: customer.address === null ? null : { ...customer.address },
    customer_email: customer.email,
    customer_name: customer.name,
    customer_phone: customer.phone,
    customer_shipping: customer.shipping === null ? null : { ...customer.shipping, address: { ...customer.shipping.address } },
    customer_tax_exempt: customer.tax_exempt,
  };
}

function pricingFor(price) {
  return { price_details: { price: price.id, product: price.product }, type: "price_details", unit_amount_decimal: price.unit_amount_decimal };
}

function lineBase(context, view, invoiceId, fields) {
  return {
    id: nextId(context, "il"),
    object: "line_item",
    amount: fields.amount,
    currency: fields.currency,
    description: fields.description,
    discount_amounts: [],
    discountable: true,
    discounts: [],
    invoice: invoiceId,
    livemode: view.livemode,
    metadata: fields.metadata,
    parent: fields.parent,
    period: fields.period,
    pretax_credit_amounts: [],
    pricing: fields.pricing,
    quantity: fields.quantity,
    quantity_decimal: decimalString(fields.quantity),
    subtotal: fields.amount,
    taxes: [],
  };
}

function lineFromInvoiceItem(context, view, invoiceId, item) {
  return lineBase(context, view, invoiceId, {
    amount: item.amount,
    currency: item.currency,
    description: item.description,
    metadata: { ...item.metadata },
    parent: { type: "invoice_item_details", invoice_item_details: { invoice_item: item.id, proration: false, proration_details: { credited_items: null }, subscription: null } },
    period: { ...item.period },
    pricing: item.pricing === null ? null : { ...item.pricing, price_details: { ...item.pricing.price_details } },
    quantity: item.quantity,
  });
}

function lineFromSubscriptionItem(context, view, invoiceId, subscription, item, product, trial) {
  const price = item.price;
  const description = trial
    ? `Trial period for ${product === null ? price.product : product.name}`
    : `${item.quantity} × ${product === null ? price.product : product.name} (at ${formatAmount(price.unit_amount, price.currency)} / ${price.recurring.interval_count === 1 ? price.recurring.interval : `${price.recurring.interval_count} ${price.recurring.interval}s`})`;
  return lineBase(context, view, invoiceId, {
    amount: trial ? 0 : price.unit_amount * item.quantity,
    currency: price.currency,
    description,
    metadata: {},
    parent: { type: "subscription_item_details", subscription_item_details: { invoice_item: null, proration: false, proration_details: { credited_items: null }, subscription: subscription.id, subscription_item: item.id } },
    period: { start: item.current_period_start, end: item.current_period_end },
    pricing: pricingFor(price),
    quantity: item.quantity,
  });
}

function withTotals(invoice) {
  const subtotal = invoice.lines.data.reduce((sum, line) => sum + line.amount, 0);
  // Customer balance credit is never applied (README Limitations), so the amount due is the subtotal.
  const amountDue = Math.max(0, subtotal);
  return {
    ...invoice,
    lines: { ...invoice.lines, total_count: invoice.lines.data.length },
    subtotal,
    subtotal_excluding_tax: subtotal,
    total: subtotal,
    total_excluding_tax: subtotal,
    amount_due: amountDue,
    amount_remaining: Math.max(0, amountDue - invoice.amount_paid),
  };
}

function newInvoiceRow(context, view, id, customer, fields) {
  const account = accountInfo(context);
  return withTotals({
    id,
    object: "invoice",
    account_country: account.country,
    account_name: account.business_name,
    account_tax_ids: null,
    amount_due: 0,
    amount_overpaid: 0,
    amount_paid: 0,
    amount_remaining: 0,
    amount_shipping: 0,
    application: null,
    attempt_count: 0,
    attempted: false,
    auto_advance: fields.auto_advance,
    automatic_tax: { disabled_reason: null, enabled: false, liability: null, provider: null, status: null },
    automatically_finalizes_at: null,
    billing_reason: fields.billing_reason,
    collection_method: fields.collection_method,
    created: view.now,
    currency: fields.currency,
    custom_fields: null,
    customer: customer.id,
    ...customerSnapshot(customer),
    customer_tax_ids: [],
    default_payment_method: fields.default_payment_method,
    default_source: null,
    default_tax_rates: [],
    description: fields.description,
    discounts: [],
    due_date: fields.due_date,
    effective_at: null,
    ending_balance: null,
    footer: null,
    from_invoice: null,
    hosted_invoice_url: null,
    invoice_pdf: null,
    issuer: { type: "self" },
    last_finalization_error: null,
    latest_revision: null,
    lines: { object: "list", data: fields.lines, has_more: false, total_count: fields.lines.length, url: `/v1/invoices/${id}/lines` },
    livemode: view.livemode,
    metadata: fields.metadata,
    next_payment_attempt: null,
    number: null,
    on_behalf_of: null,
    paid_out_of_band: false,
    parent: fields.parent,
    payment_settings: { default_mandate: null, payment_method_options: null, payment_method_types: null },
    payments: { object: "list", data: [], has_more: false, total_count: 0, url: `/v1/invoice_payments?invoice=${id}` },
    period_end: fields.period_end,
    period_start: fields.period_start,
    post_payment_credit_notes_amount: 0,
    pre_payment_credit_notes_amount: 0,
    receipt_number: null,
    rendering: null,
    shipping_cost: null,
    shipping_details: null,
    starting_balance: 0,
    statement_descriptor: null,
    status: "draft",
    status_transitions: { finalized_at: null, marked_uncollectible_at: null, paid_at: null, voided_at: null },
    subtotal: 0,
    subtotal_excluding_tax: 0,
    test_clock: null,
    total: 0,
    total_discount_amounts: [],
    total_excluding_tax: 0,
    total_pretax_credit_amounts: [],
    total_taxes: [],
    transfer_data: null,
    webhooks_delivered_at: null,
  });
}

function emitInvoicePaid(context, invoice) {
  context.events.emit("invoice.paid", {
    id: invoice.id,
    number: invoice.number,
    customer: invoice.customer,
    amount_paid: invoice.amount_paid,
    currency: invoice.currency,
    subscription: invoice.parent === null ? null : invoice.parent.subscription_details.subscription,
  });
}

function customerDefaultMethod(context, customer) {
  const id = customer.invoice_settings.default_payment_method;
  if (id === null) return null;
  const row = getRow(context, "payment_methods", id);
  return row !== null && row.customer === customer.id ? row : null;
}

/**
 * Finalize a draft: assign the number, freeze the snapshot and either open it with a PaymentIntent (positive
 * total) or mark it paid (zero total). Writes invoice, customer and (maybe) a PaymentIntent; returns them.
 */
function finalizeInvoice(context, view, draft, customer) {
  const number = `${customer.invoice_prefix}-${String(customer.next_invoice_sequence).padStart(4, "0")}`;
  const nextCustomer = { ...customer, next_invoice_sequence: customer.next_invoice_sequence + 1 };
  context.state.put("customers", nextCustomer.id, nextCustomer);
  let invoice = withTotals({
    ...draft,
    ...customerSnapshot(customer),
    number,
    effective_at: view.now,
    hosted_invoice_url: `https://invoice.stripe.test/i/${draft.id}`,
    invoice_pdf: `https://invoice.stripe.test/i/${draft.id}/pdf`,
    webhooks_delivered_at: view.now,
    status_transitions: { ...draft.status_transitions, finalized_at: view.now },
  });
  let intent = null;
  if (invoice.total > 0) {
    const method = invoice.default_payment_method ?? customer.invoice_settings.default_payment_method;
    const intentId = nextId(context, "pi");
    intent = newIntentRow(view, intentId, {
      amount: invoice.amount_due,
      currency: invoice.currency,
      customer: customer.id,
      payment_method: method,
      description: `Invoice ${number}`,
      metadata: {},
      statement_descriptor: accountInfo(context).statement_descriptor,
      invoice: invoice.id,
    });
    intent = { ...intent, status: "requires_payment_method" };
    context.state.put("payment_intents", intentId, intent);
    const payment = {
      id: nextId(context, "inpay"),
      object: "invoice_payment",
      amount_paid: null,
      amount_requested: invoice.amount_due,
      created: view.now,
      currency: invoice.currency,
      invoice: invoice.id,
      is_default: true,
      livemode: view.livemode,
      payment: { type: "payment_intent", payment_intent: intentId, charge: null },
      status: "open",
      status_transitions: { canceled_at: null, paid_at: null },
    };
    invoice = { ...invoice, status: "open", payments: { ...invoice.payments, data: [payment], total_count: 1 } };
  } else {
    invoice = { ...invoice, status: "paid", amount_paid: 0, amount_remaining: 0, status_transitions: { ...invoice.status_transitions, paid_at: view.now } };
  }
  context.state.put("invoices", invoice.id, invoice);
  if (invoice.status === "paid") emitInvoicePaid(context, invoice);
  return { invoice, customer: nextCustomer, intent };
}

/** Mark an open invoice paid after its PaymentIntent succeeded; returns the stored invoice. */
function settlePaid(context, view, invoice, result, outOfBand) {
  const payment = invoice.payments.data[0];
  const paidPayment = payment === undefined
    ? undefined
    : { ...payment, status: "paid", amount_paid: invoice.amount_due, payment: { ...payment.payment, charge: result === null ? null : result.charge.id }, status_transitions: { ...payment.status_transitions, paid_at: view.now } };
  const paid = withTotals({
    ...invoice,
    status: "paid",
    amount_paid: invoice.amount_due,
    attempt_count: invoice.attempt_count + (outOfBand ? 0 : 1),
    attempted: outOfBand ? invoice.attempted : true,
    paid_out_of_band: outOfBand,
    status_transitions: { ...invoice.status_transitions, paid_at: view.now },
    payments: paidPayment === undefined ? invoice.payments : { ...invoice.payments, data: [paidPayment] },
  });
  context.state.put("invoices", paid.id, paid);
  const customer = getRow(context, "customers", paid.customer);
  if (customer !== null && customer.delinquent) context.state.put("customers", customer.id, { ...customer, delinquent: false });
  emitInvoicePaid(context, paid);
  return paid;
}

function cancelInvoiceIntent(context, view, invoice, reason) {
  const payment = invoice.payments.data[0];
  if (payment === undefined) return invoice;
  const intent = getRow(context, "payment_intents", payment.payment.payment_intent);
  if (intent !== null && !["succeeded", "canceled"].includes(intent.status)) {
    context.state.put("payment_intents", intent.id, { ...intent, status: "canceled", canceled_at: view.now, cancellation_reason: reason, next_action: null, amount_capturable: 0 });
  }
  const canceled = { ...payment, status: "canceled", status_transitions: { ...payment.status_transitions, canceled_at: view.now } };
  return { ...invoice, payments: { ...invoice.payments, data: [canceled] } };
}

function voidInvoice(context, view, invoice) {
  const voided = { ...cancelInvoiceIntent(context, view, invoice, "void_invoice"), status: "void", status_transitions: { ...invoice.status_transitions, voided_at: view.now } };
  context.state.put("invoices", voided.id, voided);
  return voided;
}

function dueDateInput(context, input, collection) {
  const days = optionalInteger(context, input, "days_until_due", undefined, { min: 1, max: 730 });
  const dueDate = optionalInteger(context, input, "due_date", undefined, { min: 0 });
  if (collection === "charge_automatically") {
    if (days !== undefined) return invalid(context, "days_until_due may only be set for invoices with collection_method=send_invoice.", "parameter_invalid", "days_until_due");
    if (dueDate !== undefined) return invalid(context, "due_date may only be set for invoices with collection_method=send_invoice.", "parameter_invalid", "due_date");
    return null;
  }
  if (days !== undefined && dueDate !== undefined) return invalid(context, "You may only specify one of these parameters: days_until_due, due_date.", "parameter_invalid", "due_date");
  if (days === undefined && dueDate === undefined) return parameterMissing(context, "days_until_due");
  return { days, dueDate };
}

// ---------------------------------------------------------------------------------------------
// Invoice items
// ---------------------------------------------------------------------------------------------

function priceIdInput(context, input) {
  if (input.pricing !== undefined) {
    if (input.price !== undefined) return invalid(context, "You may only specify one of these parameters: price, pricing.", "parameter_invalid", "pricing");
    if (!isPlainObject(input.pricing)) return invalid(context, "Invalid pricing: must be a hash.", "parameter_invalid", "pricing");
    for (const key of Object.keys(input.pricing)) if (key !== "price") return parameterUnknown(context, `pricing[${key}]`);
    if (typeof input.pricing.price !== "string" || input.pricing.price.length === 0) return parameterMissing(context, "pricing[price]");
    return { id: input.pricing.price, param: "pricing[price]" };
  }
  if (input.price !== undefined) return { id: requireString(context, input, "price", 255), param: "price" };
  return undefined;
}

export function invoiceItemsCreate(input, context) {
  requirePermissions(context, [["invoices", "write"], ["customers", "read"], ["products", "read"]]);
  const view = makeView(context);
  const expand = validateExpand(context, input.expand, "invoiceitem");
  const customer = requireRow(context, "customers", input.customer, "customer");
  const priceRef = priceIdInput(context, input);
  const quantity = optionalInteger(context, input, "quantity", 1, { min: 1 });
  let amount;
  let currency;
  let pricing = null;
  if (priceRef !== undefined) {
    if (input.amount !== undefined) return invalid(context, "You may only specify one of these parameters: amount, price.", "parameter_invalid", "amount");
    const price = getRow(context, "prices", priceRef.id);
    if (price === null) return resourceMissing(context, "prices", priceRef.id, priceRef.param);
    if (price.type !== "one_time") return invalid(context, `The price ${price.id} is a recurring price; invoice items require a one-time price.`, "parameter_invalid", priceRef.param);
    if (!price.active) return invalid(context, `The price ${price.id} is not active.`, "parameter_invalid", priceRef.param);
    if (input.currency !== undefined && requireCurrency(context, input.currency) !== price.currency) {
      return invalid(context, `The currency ${input.currency} does not match the price's currency ${price.currency}.`, "parameter_invalid", "currency");
    }
    amount = price.unit_amount * quantity;
    currency = price.currency;
    pricing = pricingFor(price);
  } else {
    amount = requireInteger(context, input, "amount", { min: -99_999_999, max: 99_999_999 });
    currency = requireCurrency(context, input.currency);
  }
  const description = optionalString(context, input, "description", null, 5_000);
  const metadata = mergeMetadata(context, input.metadata);
  let period = { start: view.now, end: view.now };
  if (input.period !== undefined) {
    if (!isPlainObject(input.period)) return invalid(context, "Invalid period: must be a hash with start and end.", "parameter_invalid", "period");
    for (const key of Object.keys(input.period)) if (key !== "start" && key !== "end") return parameterUnknown(context, `period[${key}]`);
    period = { start: requireInteger(context, input.period, "start", { min: 0 }), end: requireInteger(context, input.period, "end", { min: 0 }) };
    if (period.end < period.start) return invalid(context, "period[end] must not be before period[start].", "parameter_invalid", "period[end]");
  }
  let invoice = null;
  if (input.invoice !== undefined && input.invoice !== "") {
    invoice = requireRow(context, "invoices", input.invoice, "invoice");
    if (invoice.status !== "draft") return invalidState(context, `Invoice ${invoice.id} is no longer editable; only draft invoices accept new items.`, "invoice_not_editable");
    if (invoice.customer !== customer.id) return invalid(context, `Invoice ${invoice.id} belongs to customer ${invoice.customer}, not ${customer.id}.`, "parameter_invalid", "invoice");
    if (invoice.currency !== currency) return invalid(context, `Invoice ${invoice.id} is denominated in ${invoice.currency}; items must use the same currency.`, "parameter_invalid", "currency");
  }
  const id = nextId(context, "ii");
  const item = {
    id,
    object: "invoiceitem",
    amount,
    currency,
    customer: customer.id,
    date: view.now,
    description: description ?? (pricing === null ? null : (getRow(context, "products", pricing.price_details.product)?.name ?? null)),
    discountable: true,
    discounts: [],
    invoice: invoice === null ? null : invoice.id,
    livemode: view.livemode,
    metadata,
    parent: null,
    period,
    pricing,
    proration: false,
    quantity,
    test_clock: null,
  };
  context.state.put("invoice_items", id, item);
  if (invoice !== null) {
    const line = lineFromInvoiceItem(context, view, invoice.id, item);
    const next = withTotals({ ...invoice, lines: { ...invoice.lines, data: [...invoice.lines.data, line] } });
    // The invoice must stay retrievable in one response once this line is added (with its largest expansions).
    requireFits(context, renderInvoice(view, next), `The invoice ${invoice.id}`);
    context.state.put("invoices", next.id, next);
  }
  return applyExpand(view, renderInvoiceItem(view, item), expand, "invoiceitem");
}

// ---------------------------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------------------------

export function invoicesCreate(input, context) {
  requirePermissions(context, [["invoices", "write"], ["customers", "read"]]);
  const view = makeView(context);
  const expand = validateExpand(context, input.expand, "invoice");
  const customer = requireRow(context, "customers", input.customer, "customer");
  const inferred = input.days_until_due !== undefined || input.due_date !== undefined ? "send_invoice" : "charge_automatically";
  const collection = optionalEnum(context, input, "collection_method", COLLECTION_METHODS, inferred);
  const due = dueDateInput(context, input, collection);
  const pendingBehavior = optionalEnum(context, input, "pending_invoice_items_behavior", PENDING_BEHAVIORS, "include");
  const defaultMethod = input.default_payment_method === undefined || input.default_payment_method === "" ? null : requireAttachedMethod(context, view, input.default_payment_method, customer, "default_payment_method").id;
  const pending = allRows(context, "invoice_items")
    .filter((item) => item.customer === customer.id && item.invoice === null)
    .sort((left, right) => left.date - right.date || (left.id < right.id ? -1 : 1));
  const currency = input.currency !== undefined ? requireCurrency(context, input.currency) : pending.length > 0 ? pending[0].currency : accountInfo(context).default_currency;
  optionalEnum(context, input, "proration_behavior", PRORATION_BEHAVIORS, undefined);
  const id = nextId(context, "in");
  const lines = [];
  if (pendingBehavior === "include") {
    for (const item of pending) {
      if (item.currency !== currency) continue;
      lines.push(lineFromInvoiceItem(context, view, id, item));
      context.state.put("invoice_items", item.id, { ...item, invoice: id });
    }
  }
  const invoice = newInvoiceRow(context, view, id, customer, {
    auto_advance: optionalBoolean(context, input, "auto_advance", false),
    billing_reason: "manual",
    collection_method: collection,
    currency,
    default_payment_method: defaultMethod,
    description: optionalString(context, input, "description", null, 1_500),
    due_date: due === null ? null : due.dueDate ?? view.now + due.days * DAY,
    lines,
    metadata: mergeMetadata(context, input.metadata),
    parent: null,
    period_start: view.now,
    period_end: view.now,
  });
  context.state.put("invoices", id, invoice);
  return applyExpand(view, renderInvoice(view, invoice), expand, "invoice");
}

export function invoicesRetrieve(input, context) {
  requirePermission(context, "invoices", "read");
  const view = makeView(context);
  const expand = validateExpand(context, input.expand, "invoice");
  const invoice = requireRow(context, "invoices", input.invoice, "invoice");
  return applyExpand(view, renderInvoice(view, invoice), expand, "invoice");
}

export function invoicesList(input, context) {
  requirePermission(context, "invoices", "read");
  rejectMangled(context, input, ["customer", "subscription", "status", "collection_method"]);
  const view = makeView(context);
  const expand = validateExpand(context, input.expand, "invoice", true);
  const customer = optionalString(context, input, "customer", undefined, 255);
  const status = optionalEnum(context, input, "status", INVOICE_STATUSES, undefined);
  const subscription = optionalString(context, input, "subscription", undefined, 255);
  const collection = optionalEnum(context, input, "collection_method", COLLECTION_METHODS, undefined);
  const rows = allRows(context, "invoices").filter(
    (invoice) =>
      (customer === undefined || invoice.customer === customer) &&
      (status === undefined || invoice.status === status) &&
      (subscription === undefined || (invoice.parent !== null && invoice.parent.subscription_details.subscription === subscription)) &&
      (collection === undefined || invoice.collection_method === collection) &&
      matchesRange(invoice.created, input.created, context, "created") &&
      matchesRange(invoice.due_date, input.due_date, context, "due_date"),
  );
  return paginate(context, "invoices", rows, input, "/v1/invoices", (row) => applyExpand(view, renderInvoice(view, row), expand, "invoice"));
}

export function invoicesFinalize(input, context) {
  requirePermission(context, "invoices", "write");
  const view = makeView(context);
  const expand = validateExpand(context, input.expand, "invoice");
  const draft = requireRow(context, "invoices", input.invoice, "invoice");
  if (draft.status !== "draft") return invalidState(context, `This invoice is already finalized (status: ${draft.status}); only draft invoices can be finalized.`, "invoice_not_editable");
  if (draft.lines.data.length === 0) return invalidState(context, `Nothing to invoice for customer ${draft.customer}: the invoice has no line items.`, "invoice_no_customer_line_items");
  const autoAdvance = optionalBoolean(context, input, "auto_advance", draft.auto_advance);
  const customer = requireRow(context, "customers", draft.customer, "customer");
  const { invoice } = finalizeInvoice(context, view, { ...draft, auto_advance: autoAdvance }, customer);
  return applyExpand(view, renderInvoice(view, invoice), expand, "invoice");
}

export function invoicesPay(input, context) {
  requirePermissions(context, [["invoices", "write"], ["payment_intents", "write"]]);
  const view = makeView(context);
  const expand = validateExpand(context, input.expand, "invoice");
  const invoice = requireRow(context, "invoices", input.invoice, "invoice");
  if (invoice.status === "draft") return invalidState(context, "You can only pay an invoice once it has been finalized. Finalize the draft with /v1/invoices/:id/finalize first.", "invoice_not_finalized");
  if (invoice.status === "paid") return invalidState(context, `Invoice ${invoice.id} is already paid.`, "invoice_already_paid");
  if (invoice.status === "void") return invalidState(context, `Invoice ${invoice.id} is void and cannot be paid.`, "invoice_void");
  const outOfBand = optionalBoolean(context, input, "paid_out_of_band", false);
  const customer = requireRow(context, "customers", invoice.customer, "customer");
  if (outOfBand) {
    if (input.payment_method !== undefined) return invalid(context, "You may not specify a payment_method when marking an invoice as paid out of band.", "parameter_invalid", "payment_method");
    const canceled = cancelInvoiceIntent(context, view, invoice, "automatic");
    const paid = settlePaid(context, view, canceled, null, true);
    return applyExpand(view, renderInvoice(view, paid), expand, "invoice");
  }
  const payment = invoice.payments.data[0];
  const intent = payment === undefined ? null : getRow(context, "payment_intents", payment.payment.payment_intent);
  if (intent === null) return invalidState(context, `Invoice ${invoice.id} has no PaymentIntent to pay; it was not finalized by this Tool.`, "invoice_payment_intent_missing");
  let resolved;
  if (input.payment_method !== undefined && input.payment_method !== "") {
    resolved = resolvePaymentMethod(context, view, input.payment_method);
    if (resolved.row !== undefined && resolved.row.customer !== customer.id) {
      return invalidState(context, `The payment method '${resolved.row.id}' is not attached to customer '${customer.id}'.`, "payment_method_unattached");
    }
  } else {
    const stored = intent.payment_method === null ? null : getRow(context, "payment_methods", intent.payment_method);
    const method = stored !== null && stored.customer === customer.id ? stored : customerDefaultMethod(context, customer);
    if (method === null) {
      return invalidState(context, `This customer has no attached payment source or default payment method. Pass payment_method to /v1/invoices/${invoice.id}/pay or attach one to the customer.`, "invoice_no_payment_method");
    }
    resolved = { row: method };
  }
  const result = confirmAttempt(context, view, { ...intent, customer: customer.id }, resolved);
  if (result.status === "declined") return declinedFailure(context, view, result, { intentCreated: false });
  if (result.status !== "succeeded") {
    return invalidState(context, `The payment for invoice ${invoice.id} requires customer authentication that this synthetic account cannot complete; use a card that does not require 3D Secure.`, "invoice_payment_intent_requires_action");
  }
  const paid = settlePaid(context, view, invoice, result, false);
  return applyExpand(view, renderInvoice(view, paid), expand, "invoice");
}

export function invoicesVoid(input, context) {
  requirePermission(context, "invoices", "write");
  const view = makeView(context);
  const expand = validateExpand(context, input.expand, "invoice");
  const invoice = requireRow(context, "invoices", input.invoice, "invoice");
  if (invoice.status === "draft") return invalidState(context, "Draft invoices cannot be voided; delete the draft instead.", "invoice_not_finalized");
  if (invoice.status === "paid") return invalidState(context, `Invoice ${invoice.id} is already paid and cannot be voided; issue a refund instead.`, "invoice_already_paid");
  if (invoice.status === "void") return invalidState(context, `Invoice ${invoice.id} is already void.`, "invoice_void");
  const voided = voidInvoice(context, view, invoice);
  return applyExpand(view, renderInvoice(view, voided), expand, "invoice");
}

// ---------------------------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------------------------

function planMirror(price) {
  return {
    id: price.id,
    object: "plan",
    active: price.active,
    amount: price.unit_amount,
    amount_decimal: price.unit_amount_decimal,
    billing_scheme: price.billing_scheme,
    created: price.created,
    currency: price.currency,
    interval: price.recurring.interval,
    interval_count: price.recurring.interval_count,
    livemode: price.livemode,
    metadata: { ...price.metadata },
    meter: null,
    nickname: price.nickname,
    product: price.product,
    tiers_mode: null,
    transform_usage: null,
    trial_period_days: price.recurring.trial_period_days,
    usage_type: "licensed",
  };
}

function requireRecurringPrice(context, id, param, reference) {
  if (typeof id !== "string" || id.length === 0) return parameterMissing(context, param);
  const price = getRow(context, "prices", id);
  if (price === null) return resourceMissing(context, "prices", id, param);
  if (!price.active) return invalid(context, `The price specified is inactive. This field only accepts active prices.`, "parameter_invalid", param);
  if (price.type !== "recurring" || price.recurring === null) return invalid(context, `The price ${price.id} is a one-time price; subscriptions require recurring prices.`, "parameter_invalid", param);
  if (reference !== undefined) {
    if (reference.currency !== price.currency) return invalid(context, `All prices of a subscription must share one currency (${reference.currency}); ${price.id} is in ${price.currency}.`, "parameter_invalid", param);
    if (reference.recurring.interval !== price.recurring.interval || reference.recurring.interval_count !== price.recurring.interval_count) {
      return invalid(context, `All prices of a subscription must share one billing interval (${reference.recurring.interval_count} ${reference.recurring.interval}); ${price.id} bills every ${price.recurring.interval_count} ${price.recurring.interval}.`, "parameter_invalid", param);
    }
  }
  return price;
}

function itemInput(context, entry, index) {
  if (!isPlainObject(entry)) return invalid(context, `Invalid items[${index}]: must be a hash.`, "parameter_invalid", `items[${index}]`);
  for (const key of Object.keys(entry)) {
    if (!["id", "price", "quantity", "deleted", "metadata"].includes(key)) return parameterUnknown(context, `items[${index}][${key}]`);
  }
  return {
    id: entry.id === undefined ? undefined : requireString(context, entry, "id", 255),
    price: entry.price,
    quantity: optionalInteger(context, entry, "quantity", undefined, { min: 1, max: 999_999 }),
    deleted: optionalBoolean(context, entry, "deleted", false),
    metadata: entry.metadata,
  };
}

function newSubscriptionItem(context, view, subscription, price, quantity, metadata, period) {
  return {
    id: nextId(context, "si"),
    object: "subscription_item",
    billing_thresholds: null,
    created: view.now,
    current_period_end: period.end,
    current_period_start: period.start,
    discounts: [],
    metadata,
    plan: planMirror(price),
    price: { ...price, metadata: { ...price.metadata }, recurring: { ...price.recurring } },
    quantity,
    subscription: subscription,
    tax_rates: [],
  };
}

function trialInput(context, input, now) {
  const days = optionalInteger(context, input, "trial_period_days", undefined, { min: 1, max: 730 });
  const end = input.trial_end;
  if (days !== undefined && end !== undefined) return invalid(context, "You may only specify one of these parameters: trial_end, trial_period_days.", "parameter_invalid", "trial_end");
  if (days !== undefined) return now + days * DAY;
  if (end === undefined || end === "now") return null;
  if (!Number.isInteger(end)) return invalid(context, `Invalid integer: ${String(end)}`, "parameter_invalid_integer", "trial_end");
  if (end <= now) return invalid(context, "trial_end must be in the future, or the string 'now'.", "parameter_invalid", "trial_end");
  return end;
}

export function subscriptionsCreate(input, context) {
  requirePermissions(context, [["subscriptions", "write"], ["customers", "read"], ["products", "read"], ["invoices", "write"], ["payment_intents", "write"]]);
  const view = makeView(context);
  const expand = validateExpand(context, input.expand, "subscription");
  const customer = requireRow(context, "customers", input.customer, "customer");
  if (!Array.isArray(input.items) || input.items.length === 0) return parameterMissing(context, "items");
  if (input.items.length > MAX_ITEMS) return invalid(context, `A subscription can have at most ${MAX_ITEMS} items.`, "parameter_invalid", "items");
  const entries = input.items.map((entry, index) => itemInput(context, entry, index));
  const prices = [];
  entries.forEach((entry, index) => {
    if (entry.id !== undefined) return parameterUnknown(context, `items[${index}][id]`);
    prices.push(requireRecurringPrice(context, entry.price, `items[${index}][price]`, prices[0]));
  });
  const collection = optionalEnum(context, input, "collection_method", COLLECTION_METHODS, "charge_automatically");
  const due = dueDateInput(context, input, collection);
  const behavior = optionalEnum(context, input, "payment_behavior", PAYMENT_BEHAVIORS, "default_incomplete");
  optionalEnum(context, input, "proration_behavior", PRORATION_BEHAVIORS, undefined);
  const defaultMethod = input.default_payment_method === undefined || input.default_payment_method === "" ? null : requireAttachedMethod(context, view, input.default_payment_method, customer, "default_payment_method");
  const trialEnd = trialInput(context, input, view.now);
  const anchor = optionalInteger(context, input, "billing_cycle_anchor", view.now, { min: view.now });
  const cancelAtPeriodEnd = optionalBoolean(context, input, "cancel_at_period_end", false);
  const cancelAt = optionalInteger(context, input, "cancel_at", null, { min: view.now });
  const description = optionalString(context, input, "description", null, 500);
  const metadata = mergeMetadata(context, input.metadata);
  const trialing = trialEnd !== null;
  const reference = prices[0];
  const period = trialing ? { start: view.now, end: trialEnd } : { start: anchor, end: addInterval(anchor, reference.recurring.interval, reference.recurring.interval_count) };
  const id = nextId(context, "sub");
  const items = entries.map((entry, index) => newSubscriptionItem(context, view, id, prices[index], entry.quantity ?? 1, mergeMetadata(context, entry.metadata), period));
  const invoiceId = nextId(context, "in");
  const lines = items.map((item) => lineFromSubscriptionItem(context, view, invoiceId, { id }, item, getRow(context, "products", item.price.product), trialing));
  const draft = newInvoiceRow(context, view, invoiceId, customer, {
    auto_advance: collection === "charge_automatically",
    billing_reason: "subscription_create",
    collection_method: collection,
    currency: reference.currency,
    default_payment_method: defaultMethod === null ? null : defaultMethod.id,
    description: null,
    due_date: due === null ? null : due.dueDate ?? view.now + due.days * DAY,
    lines,
    metadata: {},
    parent: { type: "subscription_details", subscription_details: { metadata: { ...metadata }, pause_collection: null, subscription: id } },
    period_start: period.start,
    period_end: period.end,
  });
  let { invoice, intent } = finalizeInvoice(context, view, draft, customer);
  let status = trialing ? "trialing" : "active";
  if (invoice.status === "open" && collection === "charge_automatically") {
    const method = defaultMethod ?? customerDefaultMethod(context, customer);
    if (method === null) {
      if (behavior === "error_if_incomplete") {
        return invalidState(context, "This customer has no attached payment source or default payment method. Please consider adding a default payment method or pass default_payment_method.", "customer_missing_payment_method");
      }
      status = "incomplete";
    } else {
      const result = confirmAttempt(context, view, intent, { row: method });
      if (result.status === "succeeded") {
        invoice = settlePaid(context, view, invoice, result, false);
        intent = result.intent;
      } else if (result.status === "declined") {
        if (behavior === "error_if_incomplete") return declinedFailure(context, view, result, { intentCreated: true });
        status = "incomplete";
        invoice = withTotals({ ...invoice, attempt_count: 1, attempted: true });
        context.state.put("invoices", invoice.id, invoice);
        intent = result.intent;
      } else {
        status = "incomplete";
        intent = result.intent;
      }
    }
  }
  const subscription = {
    id,
    object: "subscription",
    application: null,
    application_fee_percent: null,
    automatic_tax: { disabled_reason: null, enabled: false, liability: null },
    billing_cycle_anchor: period.start,
    billing_cycle_anchor_config: null,
    billing_mode: { type: "flexible", updated_at: view.now },
    billing_schedules: [],
    billing_thresholds: null,
    cancel_at: cancelAtPeriodEnd ? period.end : cancelAt,
    cancel_at_period_end: cancelAtPeriodEnd,
    canceled_at: cancelAtPeriodEnd ? view.now : null,
    cancellation_details: { comment: null, feedback: null, reason: cancelAtPeriodEnd ? "cancellation_requested" : null },
    collection_method: collection,
    created: view.now,
    currency: reference.currency,
    customer: customer.id,
    days_until_due: due === null ? null : due.days ?? null,
    default_payment_method: defaultMethod === null ? null : defaultMethod.id,
    default_source: null,
    default_tax_rates: [],
    description,
    discounts: [],
    ended_at: null,
    invoice_settings: { account_tax_ids: null, issuer: { type: "self" } },
    items: { object: "list", data: items, has_more: false, total_count: items.length, url: `/v1/subscription_items?subscription=${id}` },
    latest_invoice: invoice.id,
    livemode: view.livemode,
    metadata,
    next_pending_invoice_item_invoice: null,
    on_behalf_of: null,
    pause_collection: null,
    payment_settings: { payment_method_options: null, payment_method_types: null, save_default_payment_method: "off" },
    pending_invoice_item_interval: null,
    pending_setup_intent: null,
    pending_update: null,
    schedule: null,
    start_date: view.now,
    status,
    test_clock: null,
    transfer_data: null,
    trial_end: trialEnd,
    trial_settings: { end_behavior: { missing_payment_method: "create_invoice" } },
    trial_start: trialing ? view.now : null,
  };
  context.state.put("subscriptions", id, subscription);
  return applyExpand(view, renderSubscription(view, subscription), expand, "subscription");
}

export function subscriptionsRetrieve(input, context) {
  requirePermission(context, "subscriptions", "read");
  const view = makeView(context);
  const expand = validateExpand(context, input.expand, "subscription");
  const subscription = requireRow(context, "subscriptions", input.subscription, "subscription");
  return applyExpand(view, renderSubscription(view, subscription), expand, "subscription");
}

export function subscriptionsList(input, context) {
  requirePermission(context, "subscriptions", "read");
  rejectMangled(context, input, ["customer", "price", "status", "collection_method"]);
  const view = makeView(context);
  const expand = validateExpand(context, input.expand, "subscription", true);
  const customer = optionalString(context, input, "customer", undefined, 255);
  const price = optionalString(context, input, "price", undefined, 255);
  const status = optionalEnum(context, input, "status", [...SUBSCRIPTION_STATUSES, "all", "ended"], undefined);
  const collection = optionalEnum(context, input, "collection_method", COLLECTION_METHODS, undefined);
  const matchesStatus = (subscription) => {
    if (status === undefined) return subscription.status !== "canceled" && subscription.status !== "incomplete_expired";
    if (status === "all") return true;
    if (status === "ended") return subscription.status === "canceled" || subscription.status === "incomplete_expired";
    return subscription.status === status;
  };
  const rows = allRows(context, "subscriptions").filter(
    (subscription) =>
      (customer === undefined || subscription.customer === customer) &&
      (price === undefined || subscription.items.data.some((item) => item.price.id === price)) &&
      (collection === undefined || subscription.collection_method === collection) &&
      matchesStatus(subscription) &&
      matchesRange(subscription.created, input.created, context, "created") &&
      matchesRange(subscription.items.data[0]?.current_period_start, input.current_period_start, context, "current_period_start") &&
      matchesRange(subscription.items.data[0]?.current_period_end, input.current_period_end, context, "current_period_end"),
  );
  return paginate(context, "subscriptions", rows, input, "/v1/subscriptions", (row) => applyExpand(view, renderSubscription(view, row), expand, "subscription"));
}

export function subscriptionsUpdate(input, context) {
  requirePermissions(context, [["subscriptions", "write"], ["customers", "read"], ["products", "read"]]);
  const view = makeView(context);
  const expand = validateExpand(context, input.expand, "subscription");
  const current = requireRow(context, "subscriptions", input.subscription, "subscription");
  if (current.status === "canceled" || current.status === "incomplete_expired") {
    return invalidState(context, "A canceled subscription can only update its cancellation_details.", "subscription_canceled");
  }
  const customer = requireRow(context, "customers", current.customer, "customer");
  optionalEnum(context, input, "proration_behavior", PRORATION_BEHAVIORS, undefined);
  let items = current.items.data.map((item) => ({ ...item }));
  if (input.items !== undefined) {
    if (!Array.isArray(input.items)) return invalid(context, "Invalid items: must be an array.", "parameter_invalid", "items");
    if (input.items.length > MAX_ITEMS) return invalid(context, `A subscription can have at most ${MAX_ITEMS} items.`, "parameter_invalid", "items");
    const period = { start: current.items.data[0].current_period_start, end: current.items.data[0].current_period_end };
    input.items.forEach((raw, index) => {
      const entry = itemInput(context, raw, index);
      if (entry.id !== undefined) {
        const position = items.findIndex((item) => item.id === entry.id);
        if (position === -1) return resourceMissing(context, "subscription_items", entry.id, `items[${index}][id]`);
        if (entry.deleted) {
          items.splice(position, 1);
          return;
        }
        const item = items[position];
        if (entry.price !== undefined && entry.price !== item.price.id) {
          const others = items.filter((candidate) => candidate.id !== item.id);
          const price = requireRecurringPrice(context, entry.price, `items[${index}][price]`, others[0]?.price);
          items[position] = { ...item, price: { ...price, metadata: { ...price.metadata }, recurring: { ...price.recurring } }, plan: planMirror(price) };
        }
        if (entry.quantity !== undefined) items[position] = { ...items[position], quantity: entry.quantity };
        if (entry.metadata !== undefined) items[position] = { ...items[position], metadata: mergeMetadata(context, entry.metadata, item.metadata) };
        return;
      }
      if (entry.deleted) return invalid(context, `items[${index}][deleted] requires items[${index}][id].`, "parameter_invalid", `items[${index}][deleted]`);
      const price = requireRecurringPrice(context, entry.price, `items[${index}][price]`, items[0]?.price);
      items.push(newSubscriptionItem(context, view, current.id, price, entry.quantity ?? 1, mergeMetadata(context, entry.metadata), period));
    });
    if (items.length === 0) return invalid(context, "A subscription must have at least one item; you cannot delete every item.", "parameter_invalid", "items");
  }
  const next = { ...current, items: { ...current.items, data: items, total_count: items.length } };
  if (items[0] !== undefined) next.currency = items[0].price.currency;
  const periodEnd = items[0]?.current_period_end ?? current.items.data[0].current_period_end;
  const cancelAtPeriodEnd = optionalBoolean(context, input, "cancel_at_period_end", undefined);
  if (cancelAtPeriodEnd === true) {
    next.cancel_at_period_end = true;
    next.cancel_at = periodEnd;
    next.canceled_at = view.now;
    next.cancellation_details = { ...next.cancellation_details, reason: "cancellation_requested" };
  } else if (cancelAtPeriodEnd === false) {
    next.cancel_at_period_end = false;
    next.cancel_at = null;
    next.canceled_at = null;
    next.cancellation_details = { ...next.cancellation_details, reason: null };
  }
  if (input.cancel_at !== undefined) {
    if (input.cancel_at === "" || input.cancel_at === null) {
      next.cancel_at = null;
      next.cancel_at_period_end = false;
    } else {
      next.cancel_at = optionalInteger(context, input, "cancel_at", null, { min: view.now });
      next.cancel_at_period_end = false;
    }
  }
  if (input.default_payment_method !== undefined) {
    next.default_payment_method = input.default_payment_method === "" || input.default_payment_method === null ? null : requireAttachedMethod(context, view, input.default_payment_method, customer, "default_payment_method").id;
  }
  next.description = optionalString(context, input, "description", current.description, 500);
  next.metadata = mergeMetadata(context, input.metadata, current.metadata);
  if (input.collection_method !== undefined || input.days_until_due !== undefined) {
    const collection = optionalEnum(context, input, "collection_method", COLLECTION_METHODS, current.collection_method);
    const due = dueDateInput(context, { days_until_due: input.days_until_due ?? (collection === "send_invoice" ? current.days_until_due ?? undefined : undefined) }, collection);
    next.collection_method = collection;
    next.days_until_due = due === null ? null : due.days ?? null;
  }
  if (input.trial_end !== undefined) {
    if (input.trial_end === "now") {
      next.trial_end = current.trial_end === null ? null : view.now;
      if (current.status === "trialing") next.status = "active";
    } else {
      const end = trialInput(context, { trial_end: input.trial_end }, view.now);
      next.trial_end = end;
      next.trial_start = current.trial_start ?? view.now;
      if (current.status === "active") next.status = "trialing";
    }
  }
  if (input.cancellation_details !== undefined) {
    if (!isPlainObject(input.cancellation_details)) return invalid(context, "Invalid cancellation_details: must be a hash.", "parameter_invalid", "cancellation_details");
    for (const key of Object.keys(input.cancellation_details)) if (key !== "comment" && key !== "feedback") return parameterUnknown(context, `cancellation_details[${key}]`);
    next.cancellation_details = {
      ...next.cancellation_details,
      comment: optionalString(context, input.cancellation_details, "comment", next.cancellation_details.comment, 1_000),
      feedback: optionalEnum(context, input.cancellation_details, "feedback", ["customer_service", "low_quality", "missing_features", "other", "switched_service", "too_complex", "too_expensive", "unused"], next.cancellation_details.feedback),
    };
  }
  context.state.put("subscriptions", next.id, next);
  return applyExpand(view, renderSubscription(view, next), expand, "subscription");
}

export function subscriptionsCancel(input, context) {
  requirePermission(context, "subscriptions", "write");
  const view = makeView(context);
  const expand = validateExpand(context, input.expand, "subscription");
  const current = requireRow(context, "subscriptions", input.subscription, "subscription");
  if (current.status === "canceled") return resourceMissing(context, "subscriptions", current.id, "subscription");
  if (current.status === "incomplete" && current.latest_invoice !== null) {
    const invoice = getRow(context, "invoices", current.latest_invoice);
    if (invoice !== null && invoice.status === "open") voidInvoice(context, view, invoice);
  }
  const next = {
    ...current,
    status: "canceled",
    canceled_at: view.now,
    ended_at: view.now,
    cancel_at: null,
    cancel_at_period_end: false,
    cancellation_details: { ...current.cancellation_details, reason: "cancellation_requested" },
  };
  context.state.put("subscriptions", next.id, next);
  context.events.emit("customer.subscription.deleted", { id: next.id, customer: next.customer, canceled_at: view.now });
  return applyExpand(view, renderSubscription(view, next), expand, "subscription");
}
