// Synthetic Stripe account (test mode) for Firedrill. Every operation computes from `context.state`: ids come
// from the `meta/counters` row, timestamps from the virtual clock, card outcomes from a fixed test-card
// catalogue. Nothing here contacts Stripe or any card network; no e-mail, receipt or hosted page is served.
import { FORM_ERROR_KEY, requestArguments } from "./lib/form.mjs";
import { requireFits } from "./lib/size.mjs";
import { formError, formErrorEnvelope, responseHeaders, stripeError } from "./lib/wire.mjs";
import { invoiceItemsCreate, invoicesCreate, invoicesFinalize, invoicesList, invoicesPay, invoicesRetrieve, invoicesVoid, subscriptionsCancel, subscriptionsCreate, subscriptionsList, subscriptionsRetrieve, subscriptionsUpdate } from "./ops/billing.mjs";
import { pricesCreate, pricesList, pricesRetrieve, productsCreate, productsList, productsRetrieve, productsUpdate } from "./ops/catalog.mjs";
import { dashboardContext } from "./ops/dashboard.mjs";
import { customersCreate, customersList, customersRetrieve, customersUpdate, paymentMethodsAttach, paymentMethodsDetach, paymentMethodsList } from "./ops/customers.mjs";
import { balanceRetrieve, chargesList, chargesRetrieve, paymentIntentsCancel, paymentIntentsCapture, paymentIntentsConfirm, paymentIntentsCreate, paymentIntentsList, paymentIntentsRetrieve, refundsCreate, refundsList } from "./ops/payments.mjs";

const handlers = {
  "balance.retrieve": balanceRetrieve,
  "dashboard.context": dashboardContext,
  "customers.create": customersCreate,
  "customers.retrieve": customersRetrieve,
  "customers.update": customersUpdate,
  "customers.list": customersList,
  "payment_methods.list": paymentMethodsList,
  "payment_methods.attach": paymentMethodsAttach,
  "payment_methods.detach": paymentMethodsDetach,
  "payment_intents.create": paymentIntentsCreate,
  "payment_intents.retrieve": paymentIntentsRetrieve,
  "payment_intents.list": paymentIntentsList,
  "payment_intents.confirm": paymentIntentsConfirm,
  "payment_intents.capture": paymentIntentsCapture,
  "payment_intents.cancel": paymentIntentsCancel,
  "charges.retrieve": chargesRetrieve,
  "charges.list": chargesList,
  "refunds.create": refundsCreate,
  "refunds.list": refundsList,
  "products.create": productsCreate,
  "products.retrieve": productsRetrieve,
  "products.update": productsUpdate,
  "products.list": productsList,
  "prices.create": pricesCreate,
  "prices.retrieve": pricesRetrieve,
  "prices.list": pricesList,
  "invoice_items.create": invoiceItemsCreate,
  "invoices.create": invoicesCreate,
  "invoices.retrieve": invoicesRetrieve,
  "invoices.list": invoicesList,
  "invoices.finalize": invoicesFinalize,
  "invoices.pay": invoicesPay,
  "invoices.void": invoicesVoid,
  "subscriptions.create": subscriptionsCreate,
  "subscriptions.retrieve": subscriptionsRetrieve,
  "subscriptions.list": subscriptionsList,
  "subscriptions.update": subscriptionsUpdate,
  "subscriptions.cancel": subscriptionsCancel,
};

/**
 * Every Stripe operation's response must fit one HTTP response (the framework refuses bodies over 1 MiB with an
 * opaque 500 after committing). Lists already fill pages by bytes; this bound covers single objects and their
 * expansions, answering `invalid_request_error` and discarding the operation's writes. `dashboard.context` is a small
 * fixed-shape app read with no declared errors.
 */
function fitResponse(context, value) {
  // List pages are already filled by bytes in `paginate` (up to PAGE_BYTE_BUDGET); every other value is one object.
  return value !== null && typeof value === "object" && value.object === "list" ? value : requireFits(context, value, "This object");
}

const operations = Object.fromEntries(
  Object.entries(handlers).map(([id, handler]) => [id, id === "dashboard.context" ? handler : (input, context) => fitResponse(context, handler(input, context))]),
);

// ---------------------------------------------------------------------------------------------
// HTTP codecs: Stripe REST v1 (form-encoded requests, JSON responses, Stripe error envelope)
// ---------------------------------------------------------------------------------------------

function idempotencyKey(request) {
  const values = request.headers["idempotency-key"];
  const key = values === undefined || values.length === 0 ? undefined : values[values.length - 1];
  return key === undefined || key.length === 0 ? {} : { idempotencyKey: key };
}

/**
 * Path parameters + bracket-encoded query/form arguments; `Idempotency-Key` becomes the framework key.
 * A request the form decoder cannot map (reserved segment, nesting or array index over the cap) must still answer in
 * Stripe's envelope, but a throwing `decode` becomes the framework's `HTTP_REQUEST_MAPPING_FAILED`. The decoder's error
 * therefore travels as the only argument under `FORM_ERROR_KEY`: every route's input schema is closed
 * (`additionalProperties: false`), so the framework rejects the call before any handler runs, and `encode` renders the
 * carried error as Stripe's 400 `invalid_request_error`. No idempotency key is forwarded for such a request.
 */
function decode(request) {
  const decoded = requestArguments(request);
  if (decoded.error !== undefined) return { arguments: { [FORM_ERROR_KEY]: decoded.error } };
  return { arguments: decoded.value, ...idempotencyKey(request) };
}

function route(options = {}) {
  return {
    decode,
    encode({ invocation, outcome }) {
      const headers = responseHeaders(invocation);
      const carried = outcome.status === "invalid" ? formError(invocation.arguments, FORM_ERROR_KEY) : undefined;
      if (carried !== undefined) return { headers, body: { kind: "json", value: formErrorEnvelope(carried, invocation.correlationId) } };
      if (outcome.status !== "ok") return { headers, body: { kind: "json", value: stripeError(outcome, invocation.correlationId) } };
      const value = options.select === undefined ? outcome.value : options.select(outcome.value, invocation);
      return { headers, body: { kind: "json", value } };
    },
  };
}

const http = {
  "retrieve-balance": route(),
  "create-customer": route(),
  "retrieve-customer": route(),
  "update-customer": route(),
  "list-customers": route(),
  "list-payment-methods": route(),
  "list-customer-payment-methods": route({ select: (value, invocation) => ({ ...value, url: `/v1/customers/${invocation.arguments.customer}/payment_methods` }) }),
  "attach-payment-method": route(),
  "detach-payment-method": route(),
  "create-payment-intent": route(),
  "retrieve-payment-intent": route(),
  "list-payment-intents": route(),
  "confirm-payment-intent": route(),
  "capture-payment-intent": route(),
  "cancel-payment-intent": route(),
  "retrieve-charge": route(),
  "list-charges": route(),
  "create-refund": route(),
  "list-refunds": route(),
  "create-product": route(),
  "retrieve-product": route(),
  "update-product": route(),
  "list-products": route(),
  "create-price": route(),
  "retrieve-price": route(),
  "list-prices": route(),
  "create-invoice-item": route(),
  "create-invoice": route(),
  "retrieve-invoice": route(),
  "list-invoices": route(),
  "finalize-invoice": route(),
  "pay-invoice": route(),
  "void-invoice": route(),
  "create-subscription": route(),
  "retrieve-subscription": route(),
  "list-subscriptions": route(),
  "update-subscription": route(),
  "cancel-subscription": route(),
};

export default { operations, http };
