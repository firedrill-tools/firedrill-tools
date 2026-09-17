// PaymentIntents, charges, refunds and the computed balance. `confirmAttempt` is the single place a synthetic
// card outcome is applied. On `payment_intents.create` (confirm=true), `payment_intents.confirm` and
// `invoices.pay` a decline is a declared `CARD_DECLINED` failure (HTTP 402). Stripe answers 402 *and* keeps the
// intent in `requires_payment_method` with `last_payment_error`; Firedrill cannot do both in one operation: an
// expected failure aborts the state transaction (world-kernel `executeOperation` inside `store.transact`) and an
// `ok` outcome is always the route's 2xx `successStatus` (protocol-http `outcomeStatus`), with no status override
// in the codec response. So the attempt is rolled back — including the id counters — and the 402 body names only
// objects that existed before the operation (see `declinedFailure`). The failed attempt is persisted where the
// operation itself succeeds (`subscriptions.create` with an incomplete payment behaviour), which is where
// `payment_intent.declined` is emitted.

import { declineFor } from "../lib/cards.mjs";
import { acquirerReference, clientSecret, nextId, renderId, riskScore, sequenceOf } from "../lib/ids.mjs";
import { formatAmount } from "../lib/money.mjs";
import { applyExpand, makeView, renderCharge, renderPaymentIntent, renderPaymentMethod, renderRefund, validateExpand } from "../lib/objects.mjs";
import { DAY } from "../lib/periods.mjs";
import { allRows, fail, getRow, invalid, invalidState, matchesRange, paginate, parameterMissing, requirePermission, requirePermissions, requireRow } from "../lib/state.mjs";
import { docUrl } from "../lib/wire.mjs";
import { isPlainObject, mergeMetadata, optionalBoolean, optionalEnum, optionalInteger, optionalString, optionalStringArray, rejectMangled, requireChargeAmount, requireCurrency, requireExactlyOne, validateEmail } from "../lib/validate.mjs";
import { materializeCard, resolvePaymentMethod } from "./customers.mjs";

const CAPTURE_METHODS = ["automatic", "automatic_async", "manual"];
const SETUP_FUTURE_USAGE = ["off_session", "on_session"];
const CANCELLATION_REASONS = ["duplicate", "fraudulent", "requested_by_customer", "abandoned"];
const REFUND_REASONS = ["duplicate", "fraudulent", "requested_by_customer"];
const PENDING_WINDOW = 2 * DAY;

const DEFAULT_ACCOUNT = Object.freeze({
  id: "acct_synthetic",
  business_name: "Synthetic account",
  country: "US",
  default_currency: "usd",
  statement_descriptor: "SYNTHETIC",
  support_email: null,
});

/** The simulated account (`meta/account`), or a documented default when the world has no starter rows. */
export function accountInfo(context) {
  const row = context.state.get("meta", "account");
  return row === null ? DEFAULT_ACCOUNT : { ...DEFAULT_ACCOUNT, ...row };
}

function statementDescriptor(account, intent) {
  const base = account.statement_descriptor.toUpperCase();
  return intent.statement_descriptor_suffix === null ? base : `${base}* ${intent.statement_descriptor_suffix.toUpperCase()}`;
}

// ---------------------------------------------------------------------------------------------
// Row builders
// ---------------------------------------------------------------------------------------------

export function newIntentRow(view, id, fields) {
  return {
    id,
    object: "payment_intent",
    amount: fields.amount,
    amount_capturable: 0,
    amount_details: { tip: {} },
    amount_received: 0,
    application: null,
    application_fee_amount: null,
    automatic_payment_methods: fields.automatic_payment_methods ?? null,
    canceled_at: null,
    cancellation_reason: null,
    capture_method: fields.capture_method ?? "automatic",
    client_secret: clientSecret(id),
    confirmation_method: "automatic",
    created: view.now,
    currency: fields.currency,
    customer: fields.customer ?? null,
    description: fields.description ?? null,
    last_payment_error: null,
    latest_charge: null,
    livemode: view.livemode,
    metadata: fields.metadata ?? {},
    next_action: null,
    on_behalf_of: null,
    payment_method: fields.payment_method ?? null,
    payment_method_configuration_details: null,
    payment_method_options: { card: { installments: null, mandate_options: null, network: null, request_three_d_secure: "automatic" } },
    payment_method_types: ["card"],
    processing: null,
    receipt_email: fields.receipt_email ?? null,
    review: null,
    setup_future_usage: fields.setup_future_usage ?? null,
    shipping: null,
    source: null,
    statement_descriptor: fields.statement_descriptor ?? null,
    statement_descriptor_suffix: fields.statement_descriptor_suffix ?? null,
    status: fields.payment_method === undefined || fields.payment_method === null ? "requires_payment_method" : "requires_confirmation",
    transfer_data: null,
    transfer_group: null,
    invoice: fields.invoice ?? null,
  };
}

function chargeOutcome(id, decline) {
  if (decline === undefined) {
    return { network_status: "approved_by_network", reason: null, risk_level: "normal", risk_score: riskScore(id), seller_message: "Payment complete.", type: "authorized" };
  }
  return {
    network_status: "declined_by_network",
    reason: decline.decline_code,
    risk_level: "normal",
    risk_score: riskScore(id),
    seller_message: "The bank did not return any further details with this decline.",
    type: "issuer_declined",
  };
}

function buildCharge(context, view, id, intent, method, kind, decline) {
  const account = accountInfo(context);
  const failed = kind === "failed";
  const captured = kind === "succeeded";
  const card = method.card;
  return {
    id,
    object: "charge",
    amount: intent.amount,
    amount_captured: captured ? intent.amount : 0,
    amount_refunded: 0,
    application: null,
    application_fee: null,
    application_fee_amount: null,
    balance_transaction: captured ? renderId("txn", sequenceOf(id)) : null,
    billing_details: { ...method.billing_details, address: { ...method.billing_details.address } },
    calculated_statement_descriptor: failed ? null : statementDescriptor(account, intent),
    captured,
    created: view.now,
    currency: intent.currency,
    customer: intent.customer,
    description: intent.description,
    disputed: false,
    failure_balance_transaction: null,
    failure_code: failed ? "card_declined" : null,
    failure_message: failed ? decline.message : null,
    fraud_details: {},
    livemode: view.livemode,
    metadata: { ...intent.metadata },
    on_behalf_of: null,
    outcome: chargeOutcome(id, decline),
    paid: !failed,
    payment_intent: intent.id,
    payment_method: method.id,
    payment_method_details: {
      card: {
        amount_authorized: failed ? null : intent.amount,
        brand: card.brand,
        capture_before: kind === "uncaptured" ? view.now + 7 * DAY : null,
        checks: { ...card.checks },
        country: card.country,
        exp_month: card.exp_month,
        exp_year: card.exp_year,
        extended_authorization: { status: "disabled" },
        fingerprint: card.fingerprint,
        funding: card.funding,
        incremental_authorization: { status: "unavailable" },
        installments: null,
        last4: card.last4,
        mandate: null,
        multicapture: { status: "unavailable" },
        network: card.brand,
        network_token: null,
        overcapture: { status: "unavailable", maximum_amount_capturable: intent.amount },
        three_d_secure: null,
        wallet: null,
      },
      type: "card",
    },
    radar_options: {},
    receipt_email: intent.receipt_email,
    receipt_number: null,
    receipt_url: failed ? null : `https://pay.stripe.test/receipts/${id}`,
    refunded: false,
    review: null,
    shipping: null,
    source: null,
    source_transfer: null,
    statement_descriptor: intent.statement_descriptor,
    statement_descriptor_suffix: intent.statement_descriptor_suffix,
    status: failed ? "failed" : "succeeded",
    transfer_data: null,
    transfer_group: null,
  };
}

function emitSucceeded(context, intent, charge) {
  context.events.emit("payment_intent.succeeded", {
    id: intent.id,
    amount_received: intent.amount_received,
    currency: intent.currency,
    customer: intent.customer,
    latest_charge: charge.id,
    invoice: intent.invoice,
  });
}

// ---------------------------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------------------------

/** Resolve the method used by an attempt: a test card is materialised (attached when the intent has a customer). */
function methodForAttempt(context, view, intent, resolved) {
  if (resolved.card !== undefined) {
    const customer = intent.customer === null ? null : getRow(context, "customers", intent.customer);
    return materializeCard(context, view, resolved.card, customer);
  }
  const row = resolved.row;
  if (row.customer !== null && row.customer !== intent.customer) {
    if (intent.customer === null) {
      return invalidState(context, `The payment method '${row.id}' belongs to the Customer '${row.customer}' but this PaymentIntent doesn't belong to a Customer. Set the PaymentIntent's customer to use it.`, "payment_method_customer_mismatch");
    }
    return invalidState(context, `The payment method '${row.id}' belongs to the Customer '${row.customer}' but this PaymentIntent belongs to the Customer '${intent.customer}'.`, "payment_method_customer_mismatch");
  }
  return row;
}

/**
 * Apply a synthetic card outcome to an intent. Writes the intent (and a charge for success/decline) and returns
 * `{ status, intent, method, charge?, decline? }` with `status` one of `succeeded | requires_capture |
 * requires_action | declined`. Callers decide whether a decline is persisted (returned) or raised.
 */
export function confirmAttempt(context, view, intent, resolved) {
  const method = methodForAttempt(context, view, intent, resolved);
  // A catalogue test card is materialised inside this operation; a resolved row existed before it.
  const materialized = resolved.card !== undefined;
  const base = { ...intent, payment_method: method.id, next_action: null, last_payment_error: null };
  if (method.outcome === "requires_action") {
    const next = {
      ...base,
      status: "requires_action",
      next_action: { type: "use_stripe_sdk", use_stripe_sdk: { type: "three_d_secure_redirect", stripe_js: `https://hooks.stripe.test/3d_secure_2/hosted?merchant=${accountInfo(context).id}&intent=${intent.id}` } },
    };
    context.state.put("payment_intents", next.id, next);
    return { status: "requires_action", intent: next, method, materialized };
  }
  const decline = declineFor(method.outcome);
  const chargeId = nextId(context, "ch");
  if (decline !== undefined) {
    const charge = buildCharge(context, view, chargeId, base, method, "failed", decline);
    context.state.put("charges", chargeId, charge);
    const next = {
      ...base,
      status: "requires_payment_method",
      payment_method: null,
      latest_charge: chargeId,
      last_payment_error: {
        charge: chargeId,
        code: "card_declined",
        decline_code: decline.decline_code,
        doc_url: docUrl("card_declined"),
        message: decline.message,
        payment_method: method.id,
        type: "card_error",
      },
    };
    context.state.put("payment_intents", next.id, next);
    context.events.emit("payment_intent.declined", { id: next.id, decline_code: decline.decline_code, invoice: next.invoice });
    return { status: "declined", intent: next, method, charge, decline, materialized };
  }
  if (base.capture_method === "manual") {
    const charge = buildCharge(context, view, chargeId, base, method, "uncaptured");
    context.state.put("charges", chargeId, charge);
    const next = { ...base, status: "requires_capture", amount_capturable: intent.amount, latest_charge: chargeId };
    context.state.put("payment_intents", next.id, next);
    return { status: "requires_capture", intent: next, method, charge, materialized };
  }
  const charge = buildCharge(context, view, chargeId, base, method, "succeeded");
  context.state.put("charges", chargeId, charge);
  const next = { ...base, status: "succeeded", amount_received: intent.amount, latest_charge: chargeId };
  context.state.put("payment_intents", next.id, next);
  emitSucceeded(context, next, charge);
  return { status: "succeeded", intent: next, method, charge, materialized };
}

/**
 * Raise the declared `CARD_DECLINED` failure for a declined attempt (HTTP 402 `card_error`). The framework rolls
 * back every write of the operation, id counters included, so the body may only name objects that existed
 * before the operation started — an id of a rolled-back object answers 404 and is handed to the next object
 * created, and an agent retrying with it would act on an unrelated record.
 *
 * - `intentCreated: true` (`payment_intents.create` with `confirm=true`, `subscriptions.create` with
 *   `error_if_incomplete`): the PaymentIntent (and any PaymentMethod, charge, invoice or subscription) was created
 *   inside the operation, so the body carries only the Stripe error envelope — no `payment_intent`, no
 *   `payment_method`, no ids.
 * - `intentCreated: false` (`payment_intents.confirm`, `invoices.pay`): the PaymentIntent exists and keeps its
 *   previous state; the body names it as the attempt would have left it (`requires_payment_method`,
 *   `last_payment_error`), never the unpersisted charge (`latest_charge: null`, no `last_payment_error.charge`),
 *   and the PaymentMethod only when it existed before the call (a test card materialised by the call is omitted).
 */
export function declinedFailure(context, view, result, { intentCreated }) {
  const envelope = { code: "card_declined", decline_code: result.decline.decline_code };
  if (intentCreated) return fail(context, "CARD_DECLINED", result.decline.message, envelope);
  const { charge: _unpersistedCharge, payment_method: _attemptMethod, ...lastPaymentError } = result.intent.last_payment_error;
  void _unpersistedCharge;
  void _attemptMethod;
  const methodExisted = !result.materialized;
  const described = {
    ...result.intent,
    latest_charge: null,
    last_payment_error: methodExisted ? { ...lastPaymentError, payment_method: result.method.id } : lastPaymentError,
  };
  return fail(context, "CARD_DECLINED", result.decline.message, {
    ...envelope,
    payment_intent: renderPaymentIntent(view, described),
    ...(methodExisted ? { payment_method: renderPaymentMethod(view, result.method) } : {}),
  });
}

function unexpectedState(context, intent, verb) {
  const reason =
    intent.status === "succeeded"
      ? "it has already succeeded after being previously confirmed"
      : intent.status === "canceled"
        ? "it has a status of canceled"
        : intent.status === "requires_capture"
          ? "it has a status of requires_capture; capture or cancel it instead"
          : intent.status === "requires_action"
            ? "it has a status of requires_action; the customer must complete authentication"
            : `it has a status of ${intent.status}`;
  return invalidState(context, `You cannot ${verb} this PaymentIntent because ${reason}.`, "payment_intent_unexpected_state");
}

function invoiceGuard(context, intent, verb) {
  if (intent.invoice === null) return;
  const invoice = getRow(context, "invoices", intent.invoice);
  if (invoice !== null && invoice.status === "open") {
    return invalidState(context, `You cannot ${verb} this PaymentIntent because it belongs to invoice ${invoice.id}; use /v1/invoices/${invoice.id}/pay or /v1/invoices/${invoice.id}/void instead.`, "payment_intent_invoice_managed");
  }
}

// ---------------------------------------------------------------------------------------------
// PaymentIntents
// ---------------------------------------------------------------------------------------------

function automaticPaymentMethodsInput(context, value) {
  if (value === undefined) return null;
  if (!isPlainObject(value)) return invalid(context, "Invalid automatic_payment_methods: must be a hash.", "parameter_invalid", "automatic_payment_methods");
  for (const key of Object.keys(value)) if (key !== "enabled") return invalid(context, `Received unknown parameter: automatic_payment_methods[${key}]`, "parameter_unknown", `automatic_payment_methods[${key}]`);
  const enabled = optionalBoolean(context, value, "enabled", undefined);
  if (enabled === undefined) return parameterMissing(context, "automatic_payment_methods[enabled]");
  return { allow_redirects: "always", enabled };
}

export function paymentIntentsCreate(input, context) {
  requirePermission(context, "payment_intents", "write");
  const view = makeView(context);
  const expand = validateExpand(context, input.expand, "payment_intent");
  const currency = requireCurrency(context, input.currency);
  const amount = requireChargeAmount(context, input.amount, currency);
  const customerId = optionalString(context, input, "customer", null, 255);
  const customer = customerId === null ? null : requireRow(context, "customers", customerId, "customer");
  const types = optionalStringArray(context, input, "payment_method_types", undefined);
  if (types !== undefined && (types.length !== 1 || types[0] !== "card")) {
    return invalid(context, `Invalid payment_method_types: only 'card' is supported by this account.`, "parameter_invalid", "payment_method_types");
  }
  const setupFutureUsage = input.setup_future_usage === "" ? null : optionalEnum(context, input, "setup_future_usage", SETUP_FUTURE_USAGE, null);
  optionalBoolean(context, input, "off_session", undefined);
  optionalString(context, input, "return_url", undefined, 2_048);
  const fields = {
    amount,
    currency,
    customer: customer === null ? null : customer.id,
    capture_method: optionalEnum(context, input, "capture_method", CAPTURE_METHODS, "automatic"),
    description: optionalString(context, input, "description", null, 1_000),
    metadata: mergeMetadata(context, input.metadata),
    receipt_email: validateEmail(context, optionalString(context, input, "receipt_email", null, 512), "receipt_email"),
    statement_descriptor_suffix: optionalString(context, input, "statement_descriptor_suffix", null, 22),
    setup_future_usage: setupFutureUsage,
    automatic_payment_methods: automaticPaymentMethodsInput(context, input.automatic_payment_methods),
    statement_descriptor: null,
  };
  const confirm = optionalBoolean(context, input, "confirm", false);
  const resolved = input.payment_method === undefined || input.payment_method === "" ? undefined : resolvePaymentMethod(context, view, input.payment_method);
  const id = nextId(context, "pi");
  let intent = newIntentRow(view, id, fields);
  let method;
  if (resolved !== undefined) {
    method = methodForAttempt(context, view, intent, resolved);
    intent = { ...intent, payment_method: method.id, status: "requires_confirmation" };
  }
  context.state.put("payment_intents", id, intent);
  if (confirm) {
    if (method === undefined) {
      return invalidState(context, "You cannot confirm this PaymentIntent because it's missing a payment method. Create it with payment_method, or confirm it later with one.", "payment_intent_payment_method_missing");
    }
    const result = confirmAttempt(context, view, intent, { row: method });
    if (result.status === "declined") return declinedFailure(context, view, result, { intentCreated: true });
    intent = result.intent;
  }
  return applyExpand(view, renderPaymentIntent(view, intent), expand, "payment_intent");
}

export function paymentIntentsRetrieve(input, context) {
  requirePermission(context, "payment_intents", "read");
  const view = makeView(context);
  const expand = validateExpand(context, input.expand, "payment_intent");
  optionalString(context, input, "client_secret", undefined, 255);
  const intent = requireRow(context, "payment_intents", input.payment_intent, "payment_intent");
  return applyExpand(view, renderPaymentIntent(view, intent), expand, "payment_intent");
}

export function paymentIntentsList(input, context) {
  requirePermission(context, "payment_intents", "read");
  rejectMangled(context, input, ["customer"]);
  const view = makeView(context);
  const expand = validateExpand(context, input.expand, "payment_intent", true);
  const customer = optionalString(context, input, "customer", undefined, 255);
  const rows = allRows(context, "payment_intents").filter(
    (intent) => (customer === undefined || intent.customer === customer) && matchesRange(intent.created, input.created, context, "created"),
  );
  return paginate(context, "payment_intents", rows, input, "/v1/payment_intents", (row) => applyExpand(view, renderPaymentIntent(view, row), expand, "payment_intent"));
}

export function paymentIntentsConfirm(input, context) {
  requirePermission(context, "payment_intents", "write");
  const view = makeView(context);
  const expand = validateExpand(context, input.expand, "payment_intent");
  const stored = requireRow(context, "payment_intents", input.payment_intent, "payment_intent");
  if (stored.status !== "requires_payment_method" && stored.status !== "requires_confirmation") return unexpectedState(context, stored, "confirm");
  invoiceGuard(context, stored, "confirm");
  optionalBoolean(context, input, "off_session", undefined);
  optionalString(context, input, "return_url", undefined, 2_048);
  const setupFutureUsage = input.setup_future_usage === "" ? null : optionalEnum(context, input, "setup_future_usage", SETUP_FUTURE_USAGE, stored.setup_future_usage);
  const intent = {
    ...stored,
    receipt_email: validateEmail(context, optionalString(context, input, "receipt_email", stored.receipt_email, 512), "receipt_email"),
    setup_future_usage: setupFutureUsage,
  };
  let resolved;
  if (input.payment_method !== undefined && input.payment_method !== "") resolved = resolvePaymentMethod(context, view, input.payment_method);
  else if (intent.payment_method !== null) resolved = resolvePaymentMethod(context, view, intent.payment_method);
  else {
    return invalidState(context, "You cannot confirm this PaymentIntent because it's missing a payment method. You can either update the PaymentIntent with a payment method and then confirm it again, or confirm it again directly with a payment method.", "payment_intent_payment_method_missing");
  }
  const result = confirmAttempt(context, view, intent, resolved);
  if (result.status === "declined") return declinedFailure(context, view, result, { intentCreated: false });
  return applyExpand(view, renderPaymentIntent(view, result.intent), expand, "payment_intent");
}

export function paymentIntentsCapture(input, context) {
  requirePermission(context, "payment_intents", "write");
  const view = makeView(context);
  const expand = validateExpand(context, input.expand, "payment_intent");
  const intent = requireRow(context, "payment_intents", input.payment_intent, "payment_intent");
  if (intent.status !== "requires_capture") return unexpectedState(context, intent, "capture");
  const amount = optionalInteger(context, input, "amount_to_capture", intent.amount_capturable, { min: 1 });
  if (amount > intent.amount_capturable) {
    return invalid(context, `The amount_to_capture (${formatAmount(amount, intent.currency)}) is greater than the amount capturable (${formatAmount(intent.amount_capturable, intent.currency)}).`, "amount_too_large", "amount_to_capture");
  }
  const charge = getRow(context, "charges", intent.latest_charge);
  const next = { ...intent, status: "succeeded", amount_received: amount, amount_capturable: 0 };
  context.state.put("payment_intents", next.id, next);
  if (charge !== null) {
    const captured = {
      ...charge,
      captured: true,
      amount_captured: amount,
      balance_transaction: renderId("txn", sequenceOf(charge.id)),
      payment_method_details: { ...charge.payment_method_details, card: { ...charge.payment_method_details.card, capture_before: null } },
    };
    context.state.put("charges", captured.id, captured);
    emitSucceeded(context, next, captured);
  }
  return applyExpand(view, renderPaymentIntent(view, next), expand, "payment_intent");
}

export function paymentIntentsCancel(input, context) {
  requirePermission(context, "payment_intents", "write");
  const view = makeView(context);
  const expand = validateExpand(context, input.expand, "payment_intent");
  const intent = requireRow(context, "payment_intents", input.payment_intent, "payment_intent");
  const reason = optionalEnum(context, input, "cancellation_reason", CANCELLATION_REASONS, null);
  if (!["requires_payment_method", "requires_confirmation", "requires_action", "requires_capture"].includes(intent.status)) return unexpectedState(context, intent, "cancel");
  invoiceGuard(context, intent, "cancel");
  const next = { ...intent, status: "canceled", canceled_at: view.now, cancellation_reason: reason, next_action: null, amount_capturable: 0 };
  context.state.put("payment_intents", next.id, next);
  if (intent.status === "requires_capture" && intent.latest_charge !== null) {
    const charge = getRow(context, "charges", intent.latest_charge);
    if (charge !== null) context.state.put("charges", charge.id, { ...charge, refunded: true, amount_refunded: charge.amount });
  }
  return applyExpand(view, renderPaymentIntent(view, next), expand, "payment_intent");
}

// ---------------------------------------------------------------------------------------------
// Charges
// ---------------------------------------------------------------------------------------------

export function chargesRetrieve(input, context) {
  requirePermission(context, "charges", "read");
  const view = makeView(context);
  const expand = validateExpand(context, input.expand, "charge");
  const charge = requireRow(context, "charges", input.charge, "charge");
  return applyExpand(view, renderCharge(view, charge), expand, "charge");
}

export function chargesList(input, context) {
  requirePermission(context, "charges", "read");
  rejectMangled(context, input, ["customer", "payment_intent"]);
  const view = makeView(context);
  const expand = validateExpand(context, input.expand, "charge", true);
  const customer = optionalString(context, input, "customer", undefined, 255);
  const intent = optionalString(context, input, "payment_intent", undefined, 255);
  const rows = allRows(context, "charges").filter(
    (charge) => (customer === undefined || charge.customer === customer) && (intent === undefined || charge.payment_intent === intent) && matchesRange(charge.created, input.created, context, "created"),
  );
  return paginate(context, "charges", rows, input, "/v1/charges", (row) => applyExpand(view, renderCharge(view, row), expand, "charge"));
}

// ---------------------------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------------------------

export function refundsCreate(input, context) {
  requirePermissions(context, [["refunds", "write"], ["charges", "read"]]);
  const view = makeView(context);
  const expand = validateExpand(context, input.expand, "refund");
  const selector = requireExactlyOne(context, input, ["payment_intent", "charge"]);
  let charge;
  if (selector === "charge") charge = requireRow(context, "charges", input.charge, "charge");
  else {
    const intent = requireRow(context, "payment_intents", input.payment_intent, "payment_intent");
    if (intent.latest_charge === null) return invalidState(context, `This PaymentIntent (${intent.id}) does not have a successful charge to refund.`, "payment_intent_unexpected_state");
    charge = getRow(context, "charges", intent.latest_charge);
    if (charge === null) return invalidState(context, `This PaymentIntent (${intent.id}) does not have a successful charge to refund.`, "payment_intent_unexpected_state");
  }
  if (charge.status !== "succeeded") return invalidState(context, `Charge ${charge.id} has been declined and cannot be refunded.`, "charge_not_refundable");
  if (!charge.captured) return invalidState(context, `Charge ${charge.id} has not been captured; cancel its PaymentIntent to release the authorization instead of refunding.`, "charge_not_captured");
  const remaining = charge.amount - charge.amount_refunded;
  if (remaining <= 0) return invalidState(context, `Charge ${charge.id} has already been refunded.`, "charge_already_refunded");
  const amount = optionalInteger(context, input, "amount", remaining, { min: 1 });
  if (amount > remaining) {
    return invalid(context, `Refund amount (${formatAmount(amount, charge.currency)}) is greater than unrefunded amount on charge (${formatAmount(remaining, charge.currency)})`, "amount_too_large", "amount");
  }
  const reason = optionalEnum(context, input, "reason", REFUND_REASONS, null);
  const metadata = mergeMetadata(context, input.metadata);
  const id = nextId(context, "re");
  const refund = {
    id,
    object: "refund",
    amount,
    balance_transaction: renderId("txn", sequenceOf(id)),
    charge: charge.id,
    created: view.now,
    currency: charge.currency,
    destination_details: { card: { reference: acquirerReference(id), reference_status: "available", reference_type: "acquirer_reference_number", type: "refund" }, type: "card" },
    metadata,
    payment_intent: charge.payment_intent,
    reason,
    receipt_number: null,
    source_transfer_reversal: null,
    status: "succeeded",
    transfer_reversal: null,
  };
  context.state.put("refunds", id, refund);
  const refunded = charge.amount_refunded + amount;
  context.state.put("charges", charge.id, { ...charge, amount_refunded: refunded, refunded: refunded >= charge.amount });
  context.events.emit("charge.refunded", { charge: charge.id, refund: id, amount, amount_refunded: refunded, fully_refunded: refunded >= charge.amount });
  return applyExpand(view, renderRefund(view, refund), expand, "refund");
}

export function refundsList(input, context) {
  requirePermission(context, "refunds", "read");
  rejectMangled(context, input, ["charge", "payment_intent"]);
  const view = makeView(context);
  const expand = validateExpand(context, input.expand, "refund", true);
  const charge = optionalString(context, input, "charge", undefined, 255);
  const intent = optionalString(context, input, "payment_intent", undefined, 255);
  const rows = allRows(context, "refunds").filter(
    (refund) => (charge === undefined || refund.charge === charge) && (intent === undefined || refund.payment_intent === intent) && matchesRange(refund.created, input.created, context, "created"),
  );
  return paginate(context, "refunds", rows, input, "/v1/refunds", (row) => applyExpand(view, renderRefund(view, row), expand, "refund"));
}

// ---------------------------------------------------------------------------------------------
// Balance
// ---------------------------------------------------------------------------------------------

export function balanceRetrieve(input, context) {
  requirePermission(context, "balance", "read");
  const view = makeView(context);
  validateExpand(context, input.expand, "balance");
  const available = new Map();
  const pending = new Map();
  const bump = (map, currency, amount) => map.set(currency, (map.get(currency) ?? 0) + amount);
  const charges = allRows(context, "charges");
  const refunds = allRows(context, "refunds");
  const chargeById = new Map(charges.map((charge) => [charge.id, charge]));
  const threshold = view.now - PENDING_WINDOW;
  for (const charge of charges) {
    if (charge.status !== "succeeded" || !charge.captured) continue;
    bump(charge.created <= threshold ? available : pending, charge.currency, charge.amount_captured);
  }
  for (const refund of refunds) {
    const charge = chargeById.get(refund.charge);
    if (charge === undefined || charge.status !== "succeeded" || !charge.captured) continue;
    bump(charge.created <= threshold ? available : pending, refund.currency, -refund.amount);
  }
  const currencies = [...new Set([...available.keys(), ...pending.keys()])].sort();
  const rows = (map) => currencies.map((currency) => ({ amount: map.get(currency) ?? 0, currency, source_types: { card: map.get(currency) ?? 0 } }));
  return {
    object: "balance",
    available: rows(available),
    connect_reserved: currencies.map((currency) => ({ amount: 0, currency })),
    livemode: view.livemode,
    pending: rows(pending),
  };
}
