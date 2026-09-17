// NetSuite Tool conformance target. A scripted Tool test, not a model-driven agent: Node built-ins only,
// driving the SuiteTalk-shaped routes under /services/rest and the canonical operation endpoint for the
// MCP-shaped operations that have no provider route. Every flow fails loudly on an unexpected status or body.
import assert from "node:assert/strict";

let task = "";
for await (const chunk of process.stdin) task += chunk;
const instruction = String(JSON.parse(task).instruction ?? "");

const HTTP = process.env.FIREDRILL_HTTP_URL;
const TOKEN = process.env.FIREDRILL_HTTP_TOKEN;
assert.ok(HTTP && TOKEN, "the Firedrill HTTP binding is required");

const REC = "/services/rest/record/v1";
const SUITEQL = "/services/rest/query/v1/suiteql";

/** One provider-shaped request; asserts the HTTP status and returns { status, json, headers }. */
async function api(method, path, { body, status = 200, headers = {} } = {}) {
  const requestHeaders = { authorization: `Bearer ${TOKEN}`, accept: "application/json", ...headers };
  let payload;
  if (body !== undefined) {
    requestHeaders["content-type"] = "application/json";
    payload = typeof body === "string" ? body : JSON.stringify(body);
  }
  const response = await fetch(`${HTTP}${path}`, { method, headers: requestHeaders, body: payload });
  const text = await response.text();
  const json = text.length > 0 && (response.headers.get("content-type") ?? "").includes("json")
    ? JSON.parse(text)
    : undefined;
  assert.equal(
    response.status,
    status,
    `${method} ${path} -> ${response.status} ${JSON.stringify(json ?? text).slice(0, 500)}`,
  );
  return { status: response.status, json, headers: response.headers };
}

const get = (path, options) => api("GET", path, options);
const post = (path, body, options) => api("POST", path, { ...options, body });
const patch = (path, body, options) => api("PATCH", path, { ...options, method: "PATCH", body });

/** Expect the NetSuite problem envelope with a given status and o:errorCode. */
async function problem(method, path, status, code, options = {}) {
  const result = await api(method, path, { ...options, status });
  const value = result.json;
  assert.equal(value?.status, status, `${method} ${path}: ${JSON.stringify(value).slice(0, 400)}`);
  assert.ok(Array.isArray(value?.["o:errorDetails"]) && value["o:errorDetails"].length === 1, JSON.stringify(value));
  const detail = value["o:errorDetails"][0];
  assert.equal(detail["o:errorCode"], code, `${method} ${path}: ${JSON.stringify(value).slice(0, 400)}`);
  assert.equal(typeof detail.detail, "string");
  assert.ok(detail.detail.length > 0);
  assert.equal(typeof value.type, "string");
  assert.equal(typeof value.title, "string");
  return value;
}

/** Call an operation through the canonical endpoint; returns the outcome envelope unchecked. */
async function call(operationId, args) {
  const response = await fetch(`${HTTP}/v1/operations/netsuite/${operationId}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ arguments: args }),
  });
  const result = await response.json();
  assert.ok(result?.outcome, `${operationId}: unexpected response ${JSON.stringify(result).slice(0, 400)}`);
  return result.outcome;
}

async function ok(operationId, args) {
  const outcome = await call(operationId, args);
  assert.equal(outcome.status, "ok", `${operationId}: ${JSON.stringify(outcome).slice(0, 400)}`);
  return outcome.value;
}

async function failsWith(operationId, args, code) {
  const outcome = await call(operationId, args);
  assert.equal(outcome.status, "tool_error", `${operationId}: expected ${code}, got ${JSON.stringify(outcome).slice(0, 300)}`);
  assert.equal(outcome.error.code, `tool.${code}`, `${operationId}: ${JSON.stringify(outcome.error).slice(0, 300)}`);
  return outcome.error;
}

/** Every operation with the smallest set of arguments that reaches its handler. */
const ALL_OPERATIONS = [
  ["customer.list", {}],
  ["customer.get", { recordId: "1001" }],
  ["sales-order.list", {}],
  ["sales-order.get", { recordId: "5001" }],
  ["invoice.list", {}],
  ["invoice.get", { recordId: "5031" }],
  ["customer-payment.list", {}],
  ["customer-payment.get", { recordId: "5051" }],
  ["inventory-item.list", {}],
  ["inventory-item.get", { recordId: "2001" }],
  ["customer.create", { body: { companyName: "Probe Metrology" } }],
  ["customer.update", { recordId: "1001", body: { phone: "+1 206-555-0199" } }],
  ["customer.delete", { recordId: "1010" }],
  ["sales-order.create", { body: { entity: { id: "1001" }, item: { items: [{ item: { id: "2001" }, quantity: 1 }] } } }],
  ["sales-order.update", { recordId: "5003", body: { memo: "probe" } }],
  ["sales-order.items.list", { recordId: "5001" }],
  ["sales-order.transform", { recordId: "5004", target: "invoice", transformMarker: "!transform", body: {} }],
  ["invoice.create", { body: { entity: { id: "1001" }, item: { items: [{ item: { id: "2001" }, quantity: 1 }] } } }],
  ["invoice.update", { recordId: "5033", body: { memo: "probe" } }],
  ["invoice.transform", { recordId: "5033", target: "customerPayment", transformMarker: "!transform", body: {} }],
  ["subsidiary.list", {}],
  ["suiteql.query", { q: "SELECT id FROM customer", prefer: "transient" }],
  ["suiteql.run", { query: "SELECT id FROM customer" }],
  ["record.get", { recordType: "customer", recordId: "1001" }],
  ["record.metadata", {}],
  ["session.get", {}],
];

const WRITE_OPERATIONS = new Set([
  "customer.create", "customer.update", "customer.delete",
  "sales-order.create", "sales-order.update", "sales-order.transform",
  "invoice.create", "invoice.update", "invoice.transform",
]);

const LOCKABLE_OPERATIONS = new Set([
  "customer.update", "sales-order.update", "invoice.update",
  "sales-order.transform", "invoice.transform",
]);

/** Every operation that performs a bounded scan, so `tight-limits` makes it fail. */
const SCANNING_OPERATIONS = new Set(
  ALL_OPERATIONS.map(([id]) => id).filter((id) => id !== "inventory-item.get" && id !== "record.metadata" && id !== "session.get"),
);

// ---------------------------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------------------------

/** Read every collection and record, and every read error each operation declares. */
async function records() {
  const customers = (await get(`${REC}/customer?limit=5`)).json;
  assert.equal(customers.totalResults, 12);
  assert.equal(customers.count, 5);
  assert.equal(customers.hasMore, true);
  assert.deepEqual(customers.items.map((row) => row.id), ["1001", "1002", "1003", "1004", "1005"]);
  assert.equal(customers.links[0].href, `${REC}/customer?limit=5&offset=0`);
  const second = (await get(`${REC}/customer?limit=5&offset=5`)).json;
  assert.equal(second.offset, 5);
  assert.deepEqual(second.items.map((row) => row.id), ["1006", "1007", "1008", "1009", "1010"]);
  const filtered = (await get(`${REC}/customer?q=${encodeURIComponent('email START_WITH "ap@"')}`)).json;
  assert.deepEqual(filtered.items.map((row) => row.id), ["1002", "1012"]);
  const inactive = (await get(`${REC}/customer?q=${encodeURIComponent("isInactive IS true")}`)).json;
  assert.deepEqual(inactive.items.map((row) => row.id), ["1004"]);
  const noEmail = (await get(`${REC}/customer?q=${encodeURIComponent("email EMPTY")}`)).json;
  assert.deepEqual(noEmail.items.map((row) => row.id), ["1003"]);
  const canada = (await get(`${REC}/customer?q=${encodeURIComponent("subsidiary ANY_OF [2]")}`)).json;
  assert.deepEqual(canada.items.map((row) => row.id), ["1006", "1007"]);

  const customer = (await get(`${REC}/customer/1001`)).json;
  assert.equal(customer.entityId, "C1001 Harbourgate Labs");
  assert.equal(customer.subsidiary.refName, "Whitlock Instruments Inc");
  assert.equal(customer.currency.refName, "USD");
  assert.equal(customer.terms.refName, "Net 30");
  assert.equal(typeof customer.balance, "number");
  assert.equal(customer.addressBook.items, undefined, "sublists are stubs unless expanded");
  const expanded = (await get(`${REC}/customer/1001?expandSubResources=true`)).json;
  assert.equal(expanded.addressBook.totalResults, 2);
  assert.equal(expanded.addressBook.items[0].addressBookAddress.city, "Seattle");
  const picked = (await get(`${REC}/customer/1001?fields=entityId,balance`)).json;
  assert.deepEqual(Object.keys(picked).sort(), ["balance", "entityId", "id", "links"]);
  const person = (await get(`${REC}/customer/1008`)).json;
  assert.equal(person.isPerson, true);
  assert.equal(person.lastName, "Renn");
  const noEmailCustomer = (await get(`${REC}/customer/1003`)).json;
  assert.equal(noEmailCustomer.email, undefined, "a null field is omitted from the wire");

  await problem("GET", `${REC}/customer?limit=abc`, 400, "INVALID_PARAMETER");
  await problem("GET", `${REC}/customer?limit=10&offset=5`, 400, "INVALID_PARAMETER");
  await problem("GET", `${REC}/customer?q=${encodeURIComponent("bogus IS x")}`, 400, "INVALID_REQUEST");
  await problem("GET", `${REC}/customer?q=${encodeURIComponent('entityId BETWEEN "a"')}`, 400, "INVALID_REQUEST");
  await problem("GET", `${REC}/customer/abc`, 400, "INVALID_ID");
  await problem("GET", `${REC}/customer/999999`, 404, "NONEXISTENT_ID");
  await problem("GET", `${REC}/customer/1001?fields=nope`, 400, "INVALID_PARAMETER");

  // Regression (round 3): values the operation input schema itself rejects never reach a handler. The route must still
  // answer a coherent NetSuite envelope whose body `status` matches the HTTP status line, and the bounds this package
  // documents must be raised by the handlers with their specific detail.
  await problem("GET", `${REC}/customer/${"9".repeat(600)}`, 400, "INVALID_PARAMETER");
  const manyFields = Array.from({ length: 41 }, (_, index) => `field${index}`).join(",");
  const fieldsBound = await problem("GET", `${REC}/customer/1001?fields=${manyFields}`, 400, "INVALID_PARAMETER");
  assert.ok(fieldsBound["o:errorDetails"][0].detail.includes("40"), "the fields bound is named in the detail");
  const qBound = await problem("GET", `${REC}/customer?q=${encodeURIComponent("a".repeat(4001))}`, 400, "INVALID_REQUEST");
  assert.ok(qBound["o:errorDetails"][0]["o:errorQueryParam"] === "q", "the q bound names the query parameter");

  const orders = (await get(`${REC}/salesOrder`)).json;
  assert.equal(orders.totalResults, 9);
  const order = (await get(`${REC}/salesOrder/5001?expandSubResources=true`)).json;
  assert.equal(order.status.refName, "Billed");
  assert.equal(order.item.totalResults, 3);
  assert.equal(order.item.items[0].item.refName, "HX-2");
  assert.equal(order.total, Math.round((order.subtotal + order.taxTotal) * 100) / 100);
  await problem("GET", `${REC}/salesOrder?limit=0`, 400, "INVALID_PARAMETER");
  await problem("GET", `${REC}/salesOrder?q=${encodeURIComponent("bogus IS x")}`, 400, "INVALID_REQUEST");
  await problem("GET", `${REC}/salesOrder/abc`, 400, "INVALID_ID");
  await problem("GET", `${REC}/salesOrder/999999`, 404, "NONEXISTENT_ID");
  await problem("GET", `${REC}/salesOrder/5001?fields=nope`, 400, "INVALID_PARAMETER");

  const invoices = (await get(`${REC}/invoice`)).json;
  assert.equal(invoices.totalResults, 11);
  const invoice = (await get(`${REC}/invoice/5031?expandSubResources=true`)).json;
  assert.equal(invoice.createdFrom.refName, "SO1001");
  assert.equal(invoice.status.refName, "Paid In Full");
  assert.equal(invoice.amountRemaining, 0);
  const zero = (await get(`${REC}/invoice/5039`)).json;
  assert.equal(zero.total, 0, "the deliberate zero-total invoice");
  await problem("GET", `${REC}/invoice?limit=abc`, 400, "INVALID_PARAMETER");
  await problem("GET", `${REC}/invoice?q=${encodeURIComponent("bogus IS x")}`, 400, "INVALID_REQUEST");
  await problem("GET", `${REC}/invoice/abc`, 400, "INVALID_ID");
  await problem("GET", `${REC}/invoice/999999`, 404, "NONEXISTENT_ID");
  await problem("GET", `${REC}/invoice/5031?fields=nope`, 400, "INVALID_PARAMETER");

  const payments = (await get(`${REC}/customerPayment`)).json;
  assert.equal(payments.totalResults, 5);
  const payment = (await get(`${REC}/customerPayment/5054?expandSubResources=true`)).json;
  assert.equal(payment.unapplied, 1500);
  assert.equal(payment.apply.items[0].doc, "5034");
  await problem("GET", `${REC}/customerPayment?limit=abc`, 400, "INVALID_PARAMETER");
  await problem("GET", `${REC}/customerPayment?q=${encodeURIComponent("bogus IS x")}`, 400, "INVALID_REQUEST");
  await problem("GET", `${REC}/customerPayment/abc`, 400, "INVALID_ID");
  await problem("GET", `${REC}/customerPayment/999999`, 404, "NONEXISTENT_ID");
  await problem("GET", `${REC}/customerPayment/5051?fields=nope`, 400, "INVALID_PARAMETER");

  const items = (await get(`${REC}/inventoryItem`)).json;
  assert.equal(items.totalResults, 7, "service items are not part of the inventoryItem collection");
  const item = (await get(`${REC}/inventoryItem/2001`)).json;
  assert.equal(item.itemId, "HX-2");
  assert.equal(item.subsidiary.totalResults, 2);
  await problem("GET", `${REC}/inventoryItem?limit=abc`, 400, "INVALID_PARAMETER");
  await problem("GET", `${REC}/inventoryItem?q=${encodeURIComponent("bogus IS x")}`, 400, "INVALID_REQUEST");
  await problem("GET", `${REC}/inventoryItem/abc`, 400, "INVALID_ID");
  await problem("GET", `${REC}/inventoryItem/2008`, 404, "NONEXISTENT_ID");
  await problem("GET", `${REC}/inventoryItem/2001?fields=nope`, 400, "INVALID_PARAMETER");

  const sublist = (await get(`${REC}/salesOrder/5009/item?limit=2&offset=2`)).json;
  assert.equal(sublist.totalResults, 200, "the deliberate 200-line order");
  assert.equal(sublist.count, 2);
  assert.equal(sublist.items[0].line, 3);
  await problem("GET", `${REC}/salesOrder/5001/item?limit=abc`, 400, "INVALID_PARAMETER");
  await problem("GET", `${REC}/salesOrder/abc/item`, 400, "INVALID_ID");
  await problem("GET", `${REC}/salesOrder/999999/item`, 404, "NONEXISTENT_ID");

  const subsidiaries = (await get(`${REC}/subsidiary`)).json;
  assert.deepEqual(subsidiaries.items.map((row) => row.id), ["1", "2"]);
  assert.equal(subsidiaries.items[0].name, undefined, "the REST route answers the record-collection shape");
  await problem("GET", `${REC}/subsidiary?limit=abc`, 400, "INVALID_PARAMETER");
  const canonical = await ok("subsidiary.list", {});
  assert.equal(canonical.items[1].name, "Whitlock Instruments Canada");
  assert.equal(canonical.items[1].parent.refName, "Whitlock Instruments Inc");
}

const UUID_KEY = "3f2b6c1e-8d4a-4f07-9b21-5c7d0a1e4b66";

/** Create, edit, bill and collect: every write operation and every write error it declares. */
async function orderToCash() {
  const created = await api("POST", `${REC}/customer`, {
    status: 204,
    body: { companyName: "Cobalt Reef Survey", email: "ap@cobaltreef.example.com", subsidiary: { id: "1" }, terms: { id: "2" }, creditLimit: 40000 },
    headers: { "x-netsuite-idempotency-key": UUID_KEY },
  });
  const customerId = created.headers.get("location").split("/").pop();
  assert.equal(customerId, "1041");
  const customer = (await get(`${REC}/customer/${customerId}`)).json;
  assert.equal(customer.entityId, "C1041 Cobalt Reef Survey");
  assert.equal(customer.balance, 0);

  await api("PATCH", `${REC}/customer/${customerId}`, { status: 204, body: { phone: "+1 206-555-0150", comments: "Net 30, PO required" } });
  assert.equal((await get(`${REC}/customer/${customerId}`)).json.phone, "+1 206-555-0150");
  await api("PATCH", `${REC}/customer/${customerId}?replace=comments`, { status: 204, body: {} });
  assert.equal((await get(`${REC}/customer/${customerId}`)).json.comments, undefined);

  await problem("POST", `${REC}/customer`, 400, "INVALID_CONTENT", { body: { companyName: 123 } });
  await problem("POST", `${REC}/customer`, 400, "INVALID_KEY_OR_REF", { body: { companyName: "X", subsidiary: { id: "999" } } });
  await problem("POST", `${REC}/customer`, 400, "INVALID_REQUEST", { body: [1, 2] });
  await problem("POST", `${REC}/customer`, 400, "USER_ERROR", { body: {} });
  await problem("POST", `${REC}/customer`, 400, "INVALID_PARAMETER", {
    body: { companyName: "X" },
    headers: { "x-netsuite-idempotency-key": "not-a-uuid" },
  });
  await problem("PATCH", `${REC}/customer/abc`, 400, "INVALID_ID", { body: {} });
  await problem("PATCH", `${REC}/customer/999999`, 404, "NONEXISTENT_ID", { body: {} });
  await problem("PATCH", `${REC}/customer/${customerId}`, 400, "INVALID_CONTENT", { body: { email: 5 } });
  await problem("PATCH", `${REC}/customer/${customerId}`, 400, "INVALID_KEY_OR_REF", { body: { terms: { id: "99" } } });
  await problem("PATCH", `${REC}/customer/${customerId}?replace=bogus`, 400, "INVALID_PARAMETER", { body: {} });
  await problem("PATCH", `${REC}/customer/${customerId}`, 400, "INVALID_REQUEST", { body: { constructor: {} } });
  await problem("PATCH", `${REC}/customer/${customerId}`, 400, "USER_ERROR", { body: { entityId: "C1001 Harbourgate Labs" } });
  await problem("PATCH", `${REC}/customer/${customerId}`, 409, "RCRD_HAS_BEEN_CHANGED", { body: {}, headers: { "if-match": "99" } });

  const order = await api("POST", `${REC}/salesOrder`, {
    status: 204,
    body: {
      entity: { id: customerId },
      memo: "Reef array build",
      otherRefNum: "PO-4410",
      item: { items: [{ item: { id: "2001" }, quantity: 2 }, { item: { id: "2004" }, quantity: 5, rate: 60 }] },
    },
  });
  const orderId = order.headers.get("location").split("/").pop();
  const orderRecord = (await get(`${REC}/salesOrder/${orderId}?expandSubResources=true`)).json;
  assert.equal(orderRecord.status.refName, "Pending Fulfillment");
  assert.equal(orderRecord.subtotal, 3200);
  assert.equal(orderRecord.taxTotal, 275.2);
  assert.equal(orderRecord.total, 3475.2);
  assert.equal(orderRecord.item.items[1].rate, 60);

  await api("PATCH", `${REC}/salesOrder/${orderId}`, {
    status: 204,
    body: { memo: "Reef array build, phase 1", item: { items: [{ line: 1, quantity: 3 }, { item: { id: "2007" }, quantity: 4 }] } },
  });
  const patched = (await get(`${REC}/salesOrder/${orderId}?expandSubResources=true`)).json;
  assert.equal(patched.item.totalResults, 3);
  assert.equal(patched.item.items[0].quantity, 3);
  assert.equal(patched.item.items[2].line, 3);
  assert.equal(patched.subtotal, 4679.6);

  await problem("POST", `${REC}/salesOrder`, 400, "INVALID_CONTENT", {
    body: { entity: { id: customerId }, item: { items: [{ item: { id: "2001" }, quantity: "two" }] } },
  });
  await problem("POST", `${REC}/salesOrder`, 400, "INVALID_KEY_OR_REF", { body: { entity: { id: "999999" }, item: { items: [] } } });
  await problem("POST", `${REC}/salesOrder`, 400, "INVALID_REQUEST", { body: [1, 2] });
  await problem("POST", `${REC}/salesOrder`, 400, "USER_ERROR", { body: { entity: { id: customerId }, item: { items: [] } } });
  await problem("POST", `${REC}/salesOrder`, 400, "INVALID_PARAMETER", {
    body: { entity: { id: customerId }, item: { items: [{ item: { id: "2001" }, quantity: 1 }] } },
    headers: { "x-netsuite-idempotency-key": "nope" },
  });
  await problem("POST", `${REC}/salesOrder`, 400, "USER_ERROR", {
    body: { entity: { id: "1004" }, item: { items: [{ item: { id: "2001" }, quantity: 1 }] } },
  }); // the seeded inactive customer
  await problem("POST", `${REC}/salesOrder`, 400, "INVALID_KEY_OR_REF", {
    body: { entity: { id: customerId }, item: { items: [{ item: { id: "2005" }, quantity: 1 }] } },
  }); // stocked only in subsidiary 2
  await problem("PATCH", `${REC}/salesOrder/abc`, 400, "INVALID_ID", { body: {} });
  await problem("PATCH", `${REC}/salesOrder/999999`, 404, "NONEXISTENT_ID", { body: {} });
  await problem("PATCH", `${REC}/salesOrder/${orderId}`, 400, "INVALID_CONTENT", { body: { memo: 7 } });
  await problem("PATCH", `${REC}/salesOrder/${orderId}`, 400, "INVALID_KEY_OR_REF", { body: { item: { items: [{ line: 99, quantity: 1 }] } } });
  await problem("PATCH", `${REC}/salesOrder/${orderId}?replace=bogus`, 400, "INVALID_PARAMETER", { body: {} });
  await problem("PATCH", `${REC}/salesOrder/${orderId}`, 400, "INVALID_REQUEST", { body: { constructor: {} } });
  await problem("PATCH", `${REC}/salesOrder/5006`, 400, "USER_ERROR", { body: { memo: "x" } }); // the seeded closed order
  await problem("PATCH", `${REC}/salesOrder/${orderId}`, 409, "RCRD_HAS_BEEN_CHANGED", { body: {}, headers: { "if-match": "42" } });
  await orderToCashBilling(customerId, orderId);
}

/** Second half of the order-to-cash flow: transforms, invoices, payments and the customer delete. */
async function orderToCashBilling(customerId, orderId) {
  const billed = await api("POST", `${REC}/salesOrder/${orderId}/${encodeURIComponent("!transform")}/invoice`, {
    status: 204,
    body: { item: { items: [{ orderLine: 1, quantity: 1 }] } },
  });
  const partialInvoiceId = billed.headers.get("location").split("/").pop();
  const partial = (await get(`${REC}/invoice/${partialInvoiceId}?expandSubResources=true`)).json;
  assert.equal(partial.createdFrom.id, orderId);
  assert.equal(partial.item.totalResults, 1);
  assert.equal(partial.item.items[0].orderLine, 1);
  assert.equal(partial.total, 1574.7);
  const afterPartial = (await get(`${REC}/salesOrder/${orderId}?expandSubResources=true`)).json;
  assert.equal(afterPartial.status.refName, "Pending Billing/Partially Fulfilled");
  assert.equal(afterPartial.item.items[0].quantityBilled, 1);

  const rest = await api("POST", `${REC}/salesOrder/${orderId}/${encodeURIComponent("!transform")}/invoice`, { status: 204, body: {} });
  const restInvoiceId = rest.headers.get("location").split("/").pop();
  assert.equal((await get(`${REC}/salesOrder/${orderId}`)).json.status.refName, "Billed");
  await problem("POST", `${REC}/salesOrder/${orderId}/${encodeURIComponent("!transform")}/invoice`, 400, "USER_ERROR", { body: {} });
  await problem("POST", `${REC}/salesOrder/${orderId}/nottransform/invoice`, 400, "INVALID_REQUEST", { body: {} });
  await problem("POST", `${REC}/salesOrder/abc/${encodeURIComponent("!transform")}/invoice`, 400, "INVALID_ID", { body: {} });
  await problem("POST", `${REC}/salesOrder/999999/${encodeURIComponent("!transform")}/invoice`, 404, "NONEXISTENT_ID", { body: {} });
  await problem("POST", `${REC}/salesOrder/5004/${encodeURIComponent("!transform")}/invoice`, 400, "INVALID_CONTENT", { body: { memo: 9 } });
  await problem("POST", `${REC}/salesOrder/5004/${encodeURIComponent("!transform")}/invoice`, 400, "INVALID_PARAMETER", {
    body: {},
    headers: { "x-netsuite-idempotency-key": "nope" },
  });
  await problem("POST", `${REC}/salesOrder/5004/${encodeURIComponent("!transform")}/invoice`, 409, "RCRD_HAS_BEEN_CHANGED", {
    body: {},
    headers: { "if-match": "77" },
  });

  const standalone = await api("POST", `${REC}/invoice`, {
    status: 204,
    body: {
      entity: { id: customerId },
      memo: "Annual calibration",
      item: { items: [{ item: { id: "2003" }, quantity: 2 }] },
    },
  });
  const standaloneId = standalone.headers.get("location").split("/").pop();
  const standaloneRecord = (await get(`${REC}/invoice/${standaloneId}`)).json;
  assert.equal(standaloneRecord.status.refName, "Open");
  assert.equal(standaloneRecord.amountRemaining, standaloneRecord.total);
  assert.equal(standaloneRecord.dueDate, "2026-10-16");

  await api("PATCH", `${REC}/invoice/${standaloneId}`, { status: 204, body: { memo: "Annual calibration, revised", item: { items: [{ line: 1, quantity: 3 }] } } });
  const revised = (await get(`${REC}/invoice/${standaloneId}?expandSubResources=true`)).json;
  assert.equal(revised.item.items[0].quantity, 3);
  assert.equal(revised.memo, "Annual calibration, revised");

  await problem("POST", `${REC}/invoice`, 400, "INVALID_CONTENT", {
    body: { entity: { id: customerId }, item: { items: [{ item: { id: "2003" }, quantity: "two" }] } },
  });
  await problem("POST", `${REC}/invoice`, 400, "INVALID_KEY_OR_REF", { body: { entity: { id: "999999" }, item: { items: [] } } });
  await problem("POST", `${REC}/invoice`, 400, "INVALID_REQUEST", { body: [1] });
  await problem("POST", `${REC}/invoice`, 400, "USER_ERROR", { body: { entity: { id: customerId }, item: { items: [] } } });
  await problem("POST", `${REC}/invoice`, 400, "INVALID_PARAMETER", {
    body: { entity: { id: customerId }, item: { items: [{ item: { id: "2003" }, quantity: 1 }] } },
    headers: { "x-netsuite-idempotency-key": "nope" },
  });
  await problem("POST", `${REC}/invoice`, 400, "USER_ERROR", {
    body: { entity: { id: customerId }, createdFrom: { id: "5002" }, item: { items: [] } },
  }); // that order belongs to another customer
  await problem("PATCH", `${REC}/invoice/abc`, 400, "INVALID_ID", { body: {} });
  await problem("PATCH", `${REC}/invoice/999999`, 404, "NONEXISTENT_ID", { body: {} });
  await problem("PATCH", `${REC}/invoice/${standaloneId}`, 400, "INVALID_CONTENT", { body: { memo: 7 } });
  await problem("PATCH", `${REC}/invoice/${standaloneId}`, 400, "INVALID_KEY_OR_REF", { body: { terms: { id: "99" } } });
  await problem("PATCH", `${REC}/invoice/${standaloneId}?replace=bogus`, 400, "INVALID_PARAMETER", { body: {} });
  await problem("PATCH", `${REC}/invoice/${standaloneId}`, 400, "INVALID_REQUEST", { body: { constructor: {} } });
  await problem("PATCH", `${REC}/invoice/5031`, 400, "USER_ERROR", { body: { memo: "x" } }); // paid in full
  await problem("PATCH", `${REC}/invoice/${standaloneId}`, 409, "RCRD_HAS_BEEN_CHANGED", { body: {}, headers: { "if-match": "42" } });

  const paid = await api("POST", `${REC}/invoice/${standaloneId}/${encodeURIComponent("!transform")}/customerPayment`, {
    status: 204,
    body: { payment: 200, memo: "Wire 9001" },
  });
  const paymentId = paid.headers.get("location").split("/").pop();
  const paymentRecord = (await get(`${REC}/customerPayment/${paymentId}?expandSubResources=true`)).json;
  assert.equal(paymentRecord.payment, 200);
  assert.equal(paymentRecord.unapplied, 0);
  assert.equal(paymentRecord.apply.items[0].doc, standaloneId);
  const afterPayment = (await get(`${REC}/invoice/${standaloneId}`)).json;
  assert.equal(afterPayment.amountPaid, 200);
  assert.equal(afterPayment.status.refName, "Open");

  await api("POST", `${REC}/invoice/${standaloneId}/${encodeURIComponent("!transform")}/customerPayment`, { status: 204, body: {} });
  const settled = (await get(`${REC}/invoice/${standaloneId}`)).json;
  assert.equal(settled.amountRemaining, 0);
  assert.equal(settled.status.refName, "Paid In Full");

  await problem("POST", `${REC}/invoice/${standaloneId}/${encodeURIComponent("!transform")}/customerPayment`, 400, "USER_ERROR", { body: {} });
  await problem("POST", `${REC}/invoice/${restInvoiceId}/nottransform/customerPayment`, 400, "INVALID_REQUEST", { body: {} });
  await problem("POST", `${REC}/invoice/abc/${encodeURIComponent("!transform")}/customerPayment`, 400, "INVALID_ID", { body: {} });
  await problem("POST", `${REC}/invoice/999999/${encodeURIComponent("!transform")}/customerPayment`, 404, "NONEXISTENT_ID", { body: {} });
  await problem("POST", `${REC}/invoice/${restInvoiceId}/${encodeURIComponent("!transform")}/customerPayment`, 400, "INVALID_CONTENT", { body: { memo: 9 } });
  await problem("POST", `${REC}/invoice/${restInvoiceId}/${encodeURIComponent("!transform")}/customerPayment`, 400, "INVALID_PARAMETER", {
    body: {},
    headers: { "x-netsuite-idempotency-key": "nope" },
  });
  await problem("POST", `${REC}/invoice/${restInvoiceId}/${encodeURIComponent("!transform")}/customerPayment`, 409, "RCRD_HAS_BEEN_CHANGED", {
    body: {},
    headers: { "if-match": "77" },
  });

  await api("DELETE", `${REC}/customer/1010`, { status: 204 });
  await problem("GET", `${REC}/customer/1010`, 404, "NONEXISTENT_ID");
  await problem("DELETE", `${REC}/customer/abc`, 400, "INVALID_ID");
  await problem("DELETE", `${REC}/customer/999999`, 404, "NONEXISTENT_ID");
  await problem("DELETE", `${REC}/customer/1001`, 400, "USER_ERROR");
  await problem("DELETE", `${REC}/customer/1012`, 400, "INVALID_PARAMETER", { headers: { "x-netsuite-idempotency-key": "nope" } });
}

const PREFER = { prefer: "transient" };
const sql = (q, params) => post(SUITEQL, params === undefined ? { q } : { q, params }, { headers: PREFER });

/** SuiteQL, the MCP-shaped record read and the metadata catalog. */
async function analytics() {
  const simple = (await sql("SELECT id, entityid FROM customer ORDER BY id FETCH FIRST 3 ROWS ONLY")).json;
  assert.deepEqual(simple.items.map((row) => row.id), ["1001", "1002", "1003"]);
  assert.equal(simple.items[0].entityid, "C1001 Harbourgate Labs");
  assert.equal(typeof simple.items[0].id, "string", "SuiteQL renders every scalar as a string");

  const joined = (await sql(
    "SELECT t.tranid, BUILTIN.DF(t.entity) AS customer, t.foreigntotal FROM transaction t WHERE t.type = 'CustInvc' ORDER BY t.id FETCH FIRST 2 ROWS ONLY",
  )).json;
  assert.equal(joined.items[0].customer, "C1001 Harbourgate Labs");
  assert.equal(joined.items[0].tranid, "INV1001");

  const grouped = (await sql(
    "SELECT c.entityid, COUNT(*) AS n, SUM(t.foreigntotal) AS total FROM customer c JOIN transaction t ON t.entity = c.id GROUP BY c.entityid ORDER BY total DESC FETCH FIRST 3 ROWS ONLY",
  )).json;
  assert.equal(grouped.items[0].entityid, "C1009 Kestrel Field Systems");
  assert.equal(grouped.items[0].n, "2");

  const bound = (await sql("SELECT id, NVL(email, 'none') AS mail FROM customer WHERE entityid LIKE ? ORDER BY id", ["%Brightwater%"])).json;
  assert.deepEqual(bound.items.map((row) => row.mail), ["none"]);

  const distinct = (await sql("SELECT DISTINCT type FROM transaction ORDER BY type")).json;
  assert.deepEqual(distinct.items.map((row) => row.type), ["CustInvc", "CustPymt", "SalesOrd"]);

  const having = (await sql(
    "SELECT tl.item, SUM(tl.quantity) AS qty FROM transactionLine tl GROUP BY tl.item HAVING SUM(tl.quantity) > 100 ORDER BY qty DESC",
  )).json;
  assert.ok(having.items.length >= 1);

  const left = (await sql(
    "SELECT s.name, e.entityid FROM subsidiary s LEFT JOIN employee e ON e.subsidiary = s.id ORDER BY s.id, e.id",
  )).json;
  assert.equal(left.items.length, 3);

  const paged = (await sql("SELECT id FROM customer ORDER BY id", undefined)).json;
  assert.equal(paged.count, 10, "the SuiteQL default limit is 10");
  assert.equal(paged.hasMore, true);

  await problem("POST", SUITEQL, 400, "INVALID_REQUEST", { body: { q: "SELECT id FROM customer" } }); // no Prefer header
  await problem("POST", SUITEQL, 400, "INVALID_REQUEST", { body: { q: "DELETE FROM customer" }, headers: PREFER });
  await problem("POST", SUITEQL, 400, "INVALID_REQUEST", { body: { q: "SELECT id FROM nosuchtable" }, headers: PREFER });
  await problem("POST", SUITEQL, 400, "INVALID_REQUEST", { body: { q: "SELECT nosuchcolumn FROM customer" }, headers: PREFER });
  await problem("POST", SUITEQL, 400, "INVALID_REQUEST", { body: { q: "SELECT id FROM customer UNION SELECT id FROM item" }, headers: PREFER });
  await problem("POST", SUITEQL, 400, "INVALID_REQUEST", { body: { q: "" }, headers: PREFER });
  await problem("POST", `${SUITEQL}?limit=abc`, 400, "INVALID_PARAMETER", { body: { q: "SELECT id FROM customer" }, headers: PREFER });

  const run = await ok("suiteql.run", { query: "SELECT COUNT(*) AS n FROM customer" });
  assert.equal(run.items[0].n, "12");
  assert.equal(run.hasMore, false);
  await failsWith("suiteql.run", { query: "UPDATE customer SET email = 'x'" }, "INVALID_REQUEST");

  const record = await ok("record.get", { recordType: "salesOrder", recordId: "5001" });
  assert.equal(record.tranId, "SO1001");
  assert.equal(record.item.totalResults, 3, "the MCP-shaped read expands sublists");
  const subsidiary = await ok("record.get", { recordType: "subsidiary", recordId: "2" });
  assert.equal(subsidiary.name, "Whitlock Instruments Canada");
  await failsWith("record.get", { recordType: "nosuch", recordId: "1" }, "INVALID_CONTENT");
  await failsWith("record.get", { recordType: "customer", recordId: "abc" }, "INVALID_ID");
  await failsWith("record.get", { recordType: "customer", recordId: "999999" }, "NONEXISTENT_ID");

  const catalog = (await get(`${REC}/metadata-catalog`)).json;
  assert.equal(catalog.totalResults, 6);
  assert.deepEqual(catalog.items.map((row) => row.name), ["customer", "salesOrder", "invoice", "customerPayment", "inventoryItem", "subsidiary"]);
  const schema = (await get(`${REC}/metadata-catalog/invoice`)).json;
  assert.equal(schema["x-ns-type"], "invoice");
  assert.equal(schema.properties.amountRemaining["x-ns-filterable"], true);
  assert.ok(schema.required.includes("tranId"));
  assert.equal(typeof schema["x-ns-serverTime"], "string");
  await problem("GET", `${REC}/metadata-catalog/bogus`, 400, "INVALID_CONTENT");
}

/** The A/R clerk may bill and collect but may not sell or delete. */
async function roleArClerk() {
  await problem("POST", `${REC}/salesOrder`, 403, "INSUFFICIENT_PERMISSION", {
    body: { entity: { id: "1001" }, item: { items: [{ item: { id: "2001" }, quantity: 1 }] } },
  });
  await problem("DELETE", `${REC}/customer/1012`, 403, "INSUFFICIENT_PERMISSION");
  assert.equal((await get(`${REC}/salesOrder/5001`)).json.tranId, "SO1001", "view level is enough to read orders");
  await api("PATCH", `${REC}/customer/1012`, { status: 204, body: { phone: "+1 206-555-0190" } });
  await api("POST", `${REC}/invoice/5033/${encodeURIComponent("!transform")}/customerPayment`, { status: 204, body: { payment: 100 } });
  assert.equal((await get(`${REC}/invoice/5033`)).json.amountPaid, 100);
}

/** The sales rep may sell, but invoices, payments and SuiteQL are closed to that role. */
async function roleSalesRep() {
  await problem("GET", `${REC}/invoice`, 403, "INSUFFICIENT_PERMISSION");
  await problem("GET", `${REC}/customerPayment`, 403, "INSUFFICIENT_PERMISSION");
  await problem("POST", SUITEQL, 403, "INSUFFICIENT_PERMISSION", { body: { q: "SELECT id FROM customer" }, headers: PREFER });
  const created = await api("POST", `${REC}/salesOrder`, {
    status: 204,
    body: { entity: { id: "1001" }, item: { items: [{ item: { id: "2001" }, quantity: 1 }] } },
  });
  assert.ok(created.headers.get("location").startsWith(`${REC}/salesOrder/`));
  await problem("POST", `${REC}/salesOrder/5004/${encodeURIComponent("!transform")}/invoice`, 403, "INSUFFICIENT_PERMISSION", { body: {} });
}

/** A role restricted to subsidiary 2 sees only subsidiary-2 records. */
async function subsidiaryScope() {
  await problem("GET", `${REC}/customer/1001`, 404, "NONEXISTENT_ID", {});
  assert.equal((await get(`${REC}/customer/1006`)).json.entityId, "C1006 Émile Thibault Instruments");
  const customers = (await get(`${REC}/customer`)).json;
  assert.deepEqual(customers.items.map((row) => row.id), ["1006", "1007"]);
  const orders = (await get(`${REC}/salesOrder`)).json;
  assert.deepEqual(orders.items.map((row) => row.id), ["5005"]);
  const items = (await get(`${REC}/inventoryItem`)).json;
  assert.ok(items.items.some((row) => row.id === "2005"), "the subsidiary-2-only item is visible here");
  assert.ok(!items.items.some((row) => row.id === "2003"), "a subsidiary-1-only item is not");
  const rows = (await sql("SELECT id FROM customer ORDER BY id")).json;
  assert.deepEqual(rows.items.map((row) => row.id), ["1006", "1007"], "SuiteQL is filtered by the same scope");
  const subsidiaries = (await get(`${REC}/subsidiary`)).json;
  assert.deepEqual(subsidiaries.items.map((row) => row.id), ["2"]);
  await problem("POST", `${REC}/invoice`, 400, "INVALID_KEY_OR_REF", {
    body: { entity: { id: "1001" }, item: { items: [{ item: { id: "2005" }, quantity: 1 }] } },
  });
}

/** An actor with no NetSuite attributes acts as the seeded account's administrator. */
async function defaultIdentity() {
  assert.equal((await get(`${REC}/customer?limit=1`)).json.totalResults, 12);
  const created = await api("POST", `${REC}/customer`, { status: 204, body: { companyName: "Quiet Harbour Metrology" } });
  const id = created.headers.get("location").split("/").pop();
  const row = (await get(`${REC}/customer/${id}`)).json;
  assert.equal(row.subsidiary.id, "1", "the account's default subsidiary is used");
  assert.equal(row.currency.refName, "USD");
}

/** Without operation grants the framework denies the call before the handler runs. */
async function denied() {
  const outcome = await call("customer.list", {});
  assert.equal(outcome.status, "denied", JSON.stringify(outcome).slice(0, 300));
  assert.equal(outcome.error.code, "world.OPERATION_DENIED");
  const write = await call("customer.create", { body: { companyName: "Never Created" } });
  assert.equal(write.status, "denied");
  // The provider-shaped route must answer a world denial with a coherent 403 envelope that quotes no
  // framework wording and no internal operation identifier.
  const body = await problem("GET", `${REC}/customer`, 403, "INSUFFICIENT_PERMISSION");
  const detail = body["o:errorDetails"][0].detail;
  assert.ok(detail.startsWith("Permission Violation:"), detail);
  assert.ok(!detail.includes("netsuite."), detail);
  assert.ok(!detail.includes("actor"), detail);
  await problem("POST", `${REC}/customer`, 403, "INSUFFICIENT_PERMISSION", {
    body: { companyName: "Never Created" },
    headers: { "x-netsuite-idempotency-key": "6f0c0d2e-4a3b-4c1d-9e2f-8a7b6c5d4e3f" },
  });
}

/** A token issued for another account fails every operation with 401 INVALID_LOGIN. */
async function invalidLogin() {
  for (const [operationId, args] of ALL_OPERATIONS) {
    const error = await failsWith(operationId, args, "INVALID_LOGIN");
    assert.ok(error.message.startsWith("Invalid login attempt."), error.message);
  }
  await problem("GET", `${REC}/customer`, 401, "INVALID_LOGIN");
}

/** A role with no permissions fails every operation with 403 INSUFFICIENT_PERMISSION. */
async function insufficientPermission() {
  for (const [operationId, args] of ALL_OPERATIONS) {
    await failsWith(operationId, args, "INSUFFICIENT_PERMISSION");
  }
  await problem("GET", `${REC}/customer`, 403, "INSUFFICIENT_PERMISSION");
}

/** The concurrency-limit fault blocks every operation with 429 before the handler runs. */
async function concurrency() {
  for (const [operationId, args] of ALL_OPERATIONS) {
    await failsWith(operationId, args, "CONCURRENCY_LIMIT_EXCEEDED");
  }
  const response = await api("GET", `${REC}/customer`, { status: 429 });
  assert.equal(response.headers.get("retry-after"), "5");
  assert.equal(response.json.title, "Bad Request", "NetSuite really does send this title with 429");
  assert.equal(response.json["o:errorCode"], "USER_ERROR");
}

/** A write outage fails every write and moves no state; reads keep working. */
async function writeOutage() {
  for (const [operationId, args] of ALL_OPERATIONS) {
    if (!WRITE_OPERATIONS.has(operationId)) continue;
    await failsWith(operationId, args, "UNEXPECTED_ERROR");
  }
  assert.equal((await get(`${REC}/customer`)).json.totalResults, 12, "reads keep working");
  assert.equal((await get(`${REC}/invoice`)).json.totalResults, 11, "no invoice was written");
  await problem("POST", `${REC}/customer`, 500, "UNEXPECTED_ERROR", { body: { companyName: "Never Created" } });
}

/** A concurrent change blocks every edit and transform with 409. */
async function recordLocked() {
  for (const [operationId, args] of ALL_OPERATIONS) {
    if (!LOCKABLE_OPERATIONS.has(operationId)) continue;
    await failsWith(operationId, args, "RCRD_HAS_BEEN_CHANGED");
  }
  assert.equal((await get(`${REC}/invoice`)).json.totalResults, 11, "no invoice was written");
  await problem("PATCH", `${REC}/customer/1001`, 409, "RCRD_HAS_BEEN_CHANGED", { body: { phone: "x" } });
  await api("POST", `${REC}/customer`, { status: 204, body: { companyName: "Still Writable" } });
}

/** The transform commits but its response is lost: the caller sees 500 while the record exists. */
async function transformLost() {
  await failsWith("sales-order.transform", { recordId: "5004", target: "invoice", transformMarker: "!transform", body: {} }, "UNEXPECTED_ERROR");
  assert.equal((await get(`${REC}/invoice`)).json.totalResults, 12, "the invoice was committed anyway");
  assert.equal((await get(`${REC}/salesOrder/5004`)).json.status.refName, "Billed");
  await failsWith("invoice.transform", { recordId: "5033", target: "customerPayment", transformMarker: "!transform", body: {} }, "UNEXPECTED_ERROR");
  assert.equal((await get(`${REC}/customerPayment`)).json.totalResults, 6, "the payment was committed anyway");
  await problem("POST", `${REC}/salesOrder/5004/${encodeURIComponent("!transform")}/invoice`, 400, "USER_ERROR", { body: {} });
}

/** Tight scan and page limits fail every scanning operation rather than truncating a result. */
async function tightLimits() {
  for (const [operationId, args] of ALL_OPERATIONS) {
    if (SCANNING_OPERATIONS.has(operationId)) await failsWith(operationId, args, "RESULT_SET_TOO_LARGE");
    else await ok(operationId, args);
  }
  await problem("GET", `${REC}/customer`, 400, "RESULT_SET_TOO_LARGE");
  assert.equal((await get(`${REC}/inventoryItem/2001`)).json.itemId, "HX-2", "a read that never scans still works");
}

// ---------------------------------------------------------------------------------------------

const flows = {
  records,
  "order-to-cash": orderToCash,
  analytics,
  "role-ar-clerk": roleArClerk,
  "role-sales-rep": roleSalesRep,
  "subsidiary-scope": subsidiaryScope,
  "default-identity": defaultIdentity,
  denied,
  "invalid-login": invalidLogin,
  "insufficient-permission": insufficientPermission,
  concurrency,
  "write-outage": writeOutage,
  "record-locked": recordLocked,
  "transform-lost": transformLost,
  "tight-limits": tightLimits,
};
const selected = Object.keys(flows).find((name) => instruction.includes(`the ${name} conformance flow`));
if (selected === undefined) throw new Error(`Unknown drill instruction: ${instruction}`);
await flows[selected]();
process.stdout.write(JSON.stringify({ completed: true, flow: selected }));
