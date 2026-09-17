// Rendering stored rows as Stripe API objects (private fields stripped, `livemode` stamped from the actor,
// derived fields recomputed) and `expand[]` handling from a fixed allow-list. Reads state, never writes it.

import { allRows, getRow, invalid, livemode, nowSeconds } from "./state.mjs";

const PREFIX_NAMESPACES = {
  cus: "customers",
  pm: "payment_methods",
  pi: "payment_intents",
  ch: "charges",
  re: "refunds",
  prod: "products",
  price: "prices",
  ii: "invoice_items",
  in: "invoices",
  sub: "subscriptions",
};

export const TYPES = Object.freeze({
  customers: "customer",
  payment_methods: "payment_method",
  payment_intents: "payment_intent",
  charges: "charge",
  refunds: "refund",
  products: "product",
  prices: "price",
  invoice_items: "invoiceitem",
  invoices: "invoice",
  subscriptions: "subscription",
});

/** Expandable properties per object type (one level; parents are expanded implicitly). */
export const EXPANDABLE = Object.freeze({
  balance: [],
  customer: ["invoice_settings.default_payment_method"],
  payment_method: ["customer"],
  payment_intent: ["customer", "payment_method", "latest_charge"],
  charge: ["customer", "payment_intent", "payment_method", "refunds"],
  refund: ["charge", "payment_intent"],
  product: ["default_price"],
  price: ["product"],
  invoiceitem: ["customer", "invoice"],
  invoice: ["customer", "default_payment_method", "payments.data.payment.payment_intent", "lines.data.pricing.price_details.price", "parent.subscription_details.subscription"],
  subscription: ["customer", "default_payment_method", "latest_invoice", "latest_invoice.payments.data.payment.payment_intent"],
});

/** Per-call view: the actor's mode plus memoised derived data (past-due customers). */
export function makeView(context) {
  const view = { context, now: nowSeconds(context), livemode: livemode(context), memo: {} };
  return view;
}

function pastDueCustomers(view) {
  if (view.memo.pastDue === undefined) {
    const set = new Set();
    for (const invoice of allRows(view.context, "invoices")) {
      if (invoice.status === "open" && typeof invoice.due_date === "number" && invoice.due_date < view.now) set.add(invoice.customer);
    }
    view.memo.pastDue = set;
  }
  return view.memo.pastDue;
}

// ---------------------------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------------------------

export function renderCustomer(view, row) {
  return { ...row, delinquent: row.delinquent === true || pastDueCustomers(view).has(row.id), livemode: view.livemode };
}

export function renderPaymentMethod(view, row) {
  const { outcome, ...rest } = row;
  void outcome;
  return { ...rest, livemode: view.livemode };
}

export function renderPaymentIntent(view, row) {
  const { invoice, ...rest } = row;
  void invoice;
  const value = { ...rest, livemode: view.livemode };
  if (value.last_payment_error !== null && typeof value.last_payment_error.payment_method === "string") {
    const method = getRow(view.context, "payment_methods", value.last_payment_error.payment_method);
    value.last_payment_error = { ...value.last_payment_error, payment_method: method === null ? value.last_payment_error.payment_method : renderPaymentMethod(view, method) };
  }
  return value;
}

export function renderCharge(view, row) {
  return { ...row, livemode: view.livemode };
}

export function renderRefund(view, row) {
  void view;
  return { ...row };
}

export function renderProduct(view, row) {
  return { ...row, livemode: view.livemode };
}

export function renderPrice(view, row) {
  return { ...row, livemode: view.livemode };
}

export function renderInvoiceItem(view, row) {
  return { ...row, livemode: view.livemode };
}

export function renderInvoice(view, row) {
  return {
    ...row,
    livemode: view.livemode,
    lines: { ...row.lines, data: row.lines.data.map((line) => ({ ...line, livemode: view.livemode })) },
    payments: { ...row.payments, data: row.payments.data.map((payment) => ({ ...payment, livemode: view.livemode })) },
  };
}

export function renderSubscription(view, row) {
  return {
    ...row,
    livemode: view.livemode,
    items: {
      ...row.items,
      data: row.items.data.map((item) => ({ ...item, price: { ...item.price, livemode: view.livemode }, plan: { ...item.plan, livemode: view.livemode } })),
    },
  };
}

const RENDERERS = {
  customers: renderCustomer,
  payment_methods: renderPaymentMethod,
  payment_intents: renderPaymentIntent,
  charges: renderCharge,
  refunds: renderRefund,
  products: renderProduct,
  prices: renderPrice,
  invoice_items: renderInvoiceItem,
  invoices: renderInvoice,
  subscriptions: renderSubscription,
};

export function renderRow(view, namespace, row) {
  return RENDERERS[namespace](view, row);
}

/** Render the object an id refers to (by prefix), or return the id when it cannot be resolved. */
export function renderById(view, id) {
  if (typeof id !== "string") return id;
  const prefix = id.split("_", 1)[0];
  const namespace = Object.hasOwn(PREFIX_NAMESPACES, prefix) ? PREFIX_NAMESPACES[prefix] : undefined;
  if (namespace === undefined) return id;
  const row = getRow(view.context, namespace, id);
  return row === null ? id : renderRow(view, namespace, row);
}

/** Refunds shown inline in an expanded `charge.refunds` list; Stripe embeds the first page and sets `has_more`. */
export const EMBEDDED_REFUNDS = 10;

/**
 * The expandable `refunds` list of a charge, computed from the `refunds` namespace. Refunds are grouped by charge
 * once per call (a charges list expanding `data.refunds` scans the namespace once, not once per charge), newest
 * first; like Stripe, the embedded list carries the first `EMBEDDED_REFUNDS` with `has_more` and `total_count`, and
 * the rest are listed with `GET /v1/refunds?charge=`.
 */
export function chargeRefunds(view, chargeId) {
  if (view.memo.refundsByCharge === undefined) {
    const groups = new Map();
    for (const refund of allRows(view.context, "refunds")) {
      const group = groups.get(refund.charge);
      if (group === undefined) groups.set(refund.charge, [refund]);
      else group.push(refund);
    }
    for (const group of groups.values()) group.sort((left, right) => (right.created - left.created) || (left.id < right.id ? 1 : -1));
    view.memo.refundsByCharge = groups;
  }
  const all = view.memo.refundsByCharge.get(chargeId) ?? [];
  const data = all.slice(0, EMBEDDED_REFUNDS).map((refund) => renderRefund(view, refund));
  return { object: "list", data, has_more: all.length > data.length, total_count: all.length, url: `/v1/charges/${chargeId}/refunds` };
}

// ---------------------------------------------------------------------------------------------
// expand[]
// ---------------------------------------------------------------------------------------------

/** Validate `expand` against the allow-list of `type` (`data.` prefix for lists); returns the normalised paths. */
export function validateExpand(context, expand, type, isList = false) {
  if (expand === undefined) return [];
  if (!Array.isArray(expand) || expand.some((entry) => typeof entry !== "string")) {
    return invalid(context, "Invalid array: expand must be an array of strings.", "parameter_invalid", "expand");
  }
  const allowed = EXPANDABLE[type] ?? [];
  const paths = [];
  for (const raw of expand) {
    let path = raw;
    if (isList) {
      if (!path.startsWith("data.")) return invalid(context, `This property cannot be expanded (${raw}). Expand list items with the 'data.' prefix.`, "parameter_invalid", "expand");
      path = path.slice("data.".length);
    }
    if (!allowed.includes(path)) return invalid(context, `This property cannot be expanded (${raw}).`, "parameter_invalid", "expand");
    paths.push(path);
  }
  return paths.sort((left, right) => left.split(".").length - right.split(".").length);
}

function expandInto(view, target, segments, special) {
  if (target === null || typeof target !== "object") return target;
  const [head, ...rest] = segments;
  if (target.object === "list" && head === "data" && Array.isArray(target.data)) {
    return { ...target, data: target.data.map((item) => expandInto(view, item, rest, special)) };
  }
  if (rest.length === 0) {
    if (head === "refunds" && special === "charge") return { ...target, refunds: chargeRefunds(view, target.id) };
    return { ...target, [head]: renderById(view, target[head]) };
  }
  let child = target[head];
  if (typeof child === "string") child = renderById(view, child);
  return { ...target, [head]: expandInto(view, child, rest, special) };
}

/** Apply validated expand paths to a rendered object or list. */
export function applyExpand(view, value, paths, type, isList = false) {
  let out = value;
  for (const path of paths) {
    const segments = (isList ? "data." + path : path).split(".");
    out = expandInto(view, out, segments, type);
  }
  return out;
}
