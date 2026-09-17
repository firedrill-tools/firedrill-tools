// Stripe Tool conformance target. A scripted Tool test, not a model-driven agent.
// Node built-ins only: fetch against the Stripe-shaped REST routes (form-encoded bodies in Stripe's bracket
// syntax, Bearer secret key, Idempotency-Key) and raw MCP JSON-RPC (Streamable HTTP) for the agent-toolkit tool
// names. Every flow fails loudly on an unexpected status, header or body.
import assert from "node:assert/strict";

let task = "";
for await (const chunk of process.stdin) task += chunk;
const invocation = JSON.parse(task);
const instruction = String(invocation.instruction ?? "");

const HTTP = process.env.FIREDRILL_HTTP_URL;
const HTTP_TOKEN = process.env.FIREDRILL_HTTP_TOKEN;
const MCP = process.env.FIREDRILL_MCP_URL;
const MCP_TOKEN = process.env.FIREDRILL_MCP_TOKEN;
assert.ok(HTTP && HTTP_TOKEN && MCP && MCP_TOKEN, "HTTP and MCP bindings are required");

const T = 1789376400; // 2026-09-14T09:00:00Z, the world's virtual time
const DAY = 86400;
const MONTH_LATER = 1791968400; // 2026-10-14T09:00:00Z

// Starter ids (deterministic: see firedrill/tools/stripe/lib/ids.mjs and starter.json)
const CUS = ["cus_0000010zTsvh0y", "cus_0000021MiE2e1N", "cus_00000323bW7j22", "cus_00000406Cqde07", "cus_0000050TRBkb0S", "cus_0000062cN3SK2d", "cus_0000073JGLXP3I", "cus_0000082mCL1S2n", "cus_0000090pV47N0o", "cus_00000A2c4gHd2a", "cus_00000B2EqLAg2F", "cus_00000C0lEasN0k"];
const cus = (n) => CUS[n - 1];
const PM = { 20: "pm_00000K4XGX0k4Y", 21: "pm_00000L2ZA26f2Y", 22: "pm_00000M2xnbDc2y", 23: "pm_00000N0iJwhP0h", 24: "pm_00000O3Hbhb43I", 25: "pm_00000P3eq2i13d", 26: "pm_00000Q1hRNDw1i", 27: "pm_00000R1nzxIl1m", 28: "pm_00000S0aCzDG0b", 29: "pm_00000T0yqYKD0x", 30: "pm_00000U1SadEZ1R", 31: "pm_00000V3ilgKm3j", 32: "pm_00000W3Kpwdp3J", 33: "pm_00000X2wCNWs2x" };
const PROD = { 40: "prod_0000140ivk6Q0k", 41: "prod_0000153SCJoP3R", 42: "prod_0000163qpsvM3r", 43: "prod_0000171bMEP91a", 44: "prod_0000181yaZW61z", 45: "prod_0000192NE8d32M" };
const PRICE = { 50: "price_00001E2Ddbmb2C", 51: "price_00001F1qPGfe1r", 52: "price_00001G0MnWNL0L", 53: "price_00001H0GEwIW0H", 54: "price_00001I17xbBF16", 55: "price_00001J36465K37", 56: "price_00001K3xmky33w", 57: "price_00001L1WbAIC1X", 58: "price_00001M2NcQav2M", 59: "price_00001N4L16504M" };
const PI = { 100: "pi_00002S34Rgwz33", 101: "pi_00002T2gVxG22h", 102: "pi_00002U48ZK9147", 103: "pi_00002V3Rg23w3S", 104: "pi_00002W2YOzlt2X", 105: "pi_00002X2BAeew2C", 106: "pi_00002Y0hYuMd0g", 107: "pi_00002Z00fcHY01", 108: "pi_0000302uSs8f2t", 109: "pi_0000310AUtqg0B", 110: "pi_0000323n5M883o", 111: "pi_0000331WuJ1v1V", 112: "pi_00003430W3KE31", 113: "pi_0000353P9cRB3O", 114: "pi_0000360C67XQ0D", 115: "pi_0000372dHiDH2c", 116: "pi_0000381krDuY1l", 117: "pi_0000394U7ncX4S", 118: "pi_00003A1b1wLQ1c", 119: "pi_00003B4cYF1X4b", 120: "pi_00003C2R9wz52Q" };
const CH = { 200: "ch_00005K1Evk7c1G", 201: "ch_00005L3g7KnT3e", 202: "ch_00005M2oOfuk2p", 206: "ch_00005Q1YjqV41Z", 208: "ch_00005S1OuYvw1Q", 209: "ch_00005T24Od1123" };
const IN = { 400: "in_0000B42dAyb82e", 401: "in_0000B50gThh30f", 402: "in_0000B63PkHP23Q", 403: "in_0000B73UtdTr3T", 404: "in_0000B81XUxzm1Y", 406: "in_0000BA2JMsDg2K", 409: "in_0000BD0qSWVN0p" };
const SUB = { 601: "sub_0000GP0DIlzs0E", 602: "sub_0000GQ2AhRTx29", 603: "sub_0000GR1nT6N01o", 604: "sub_0000GS3kANH53j", 605: "sub_0000GT3eJBmG3f", 606: "sub_0000GU0vkRUH0u" };
const SI_601 = ["si_0000JH4MuvNX4L", "si_0000JI2urYUY2v"];

const ALL_OPERATIONS = [
  "balance.retrieve", "dashboard.context", "customers.create", "customers.retrieve", "customers.update", "customers.list",
  "payment_methods.list", "payment_methods.attach", "payment_methods.detach",
  "payment_intents.create", "payment_intents.retrieve", "payment_intents.list", "payment_intents.confirm", "payment_intents.capture", "payment_intents.cancel",
  "charges.retrieve", "charges.list", "refunds.create", "refunds.list",
  "products.create", "products.retrieve", "products.update", "products.list", "prices.create", "prices.retrieve", "prices.list",
  "invoice_items.create", "invoices.create", "invoices.retrieve", "invoices.list", "invoices.finalize", "invoices.pay", "invoices.void",
  "subscriptions.create", "subscriptions.retrieve", "subscriptions.list", "subscriptions.update", "subscriptions.cancel",
];
const ALIASES = ["retrieve_balance", "create_customer", "list_customers", "create_product", "list_products", "create_price", "list_prices", "create_invoice", "list_invoices", "create_invoice_item", "finalize_invoice", "create_refund", "list_payment_intents", "list_subscriptions", "cancel_subscription", "update_subscription"];

/** One representative, schema-valid request per operation, in manifest order (37 entries). */
const CALLS = [
  ["GET", "/v1/balance"],
  ["POST", "/v1/customers", { name: "Probe" }],
  ["GET", `/v1/customers/${cus(1)}`],
  ["POST", `/v1/customers/${cus(1)}`, { description: "Probe" }],
  ["GET", "/v1/customers"],
  ["GET", `/v1/customers/${cus(1)}/payment_methods`],
  ["POST", `/v1/payment_methods/${PM[29]}/attach`, { customer: cus(1) }],
  ["POST", `/v1/payment_methods/${PM[21]}/detach`, {}],
  ["POST", "/v1/payment_intents", { amount: 2000, currency: "usd" }],
  ["GET", `/v1/payment_intents/${PI[100]}`],
  ["GET", "/v1/payment_intents"],
  ["POST", `/v1/payment_intents/${PI[112]}/confirm`, {}],
  ["POST", `/v1/payment_intents/${PI[108]}/capture`, {}],
  ["POST", `/v1/payment_intents/${PI[113]}/cancel`, {}],
  ["GET", `/v1/charges/${CH[200]}`],
  ["GET", "/v1/charges"],
  ["POST", "/v1/refunds", { payment_intent: PI[102] }],
  ["GET", "/v1/refunds"],
  ["POST", "/v1/products", { name: "Probe" }],
  ["GET", `/v1/products/${PROD[40]}`],
  ["POST", `/v1/products/${PROD[40]}`, { description: "Probe" }],
  ["GET", "/v1/products"],
  ["POST", "/v1/prices", { product: PROD[40], currency: "usd", unit_amount: 100 }],
  ["GET", `/v1/prices/${PRICE[50]}`],
  ["GET", "/v1/prices"],
  ["POST", "/v1/invoiceitems", { customer: cus(10), amount: 100, currency: "usd" }],
  ["POST", "/v1/invoices", { customer: cus(10) }],
  ["GET", `/v1/invoices/${IN[400]}`],
  ["GET", "/v1/invoices"],
  ["POST", `/v1/invoices/${IN[400]}/finalize`, {}],
  ["POST", `/v1/invoices/${IN[402]}/pay`, {}],
  ["POST", `/v1/invoices/${IN[402]}/void`, {}],
  ["POST", "/v1/subscriptions", { customer: cus(1), items: [{ price: PRICE[54] }] }],
  ["GET", `/v1/subscriptions/${SUB[601]}`],
  ["GET", "/v1/subscriptions"],
  ["POST", `/v1/subscriptions/${SUB[601]}`, { description: "Probe" }],
  ["DELETE", `/v1/subscriptions/${SUB[602]}`],
];
const WRITE_CALLS = CALLS.filter(([method]) => method !== "GET");

// ---------------------------------------------------------------------------------------------
// Transport helpers
// ---------------------------------------------------------------------------------------------

/** Stripe's bracket form encoding: `{ items: [{ price }], metadata: { k }, expand: ["a"] }` → `items[0][price]=…`. */
function encodeForm(value, prefix, params) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => encodeForm(entry, typeof entry === "object" && entry !== null ? `${prefix}[${index}]` : `${prefix}[]`, params));
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) encodeForm(entry, prefix === "" ? key : `${prefix}[${key}]`, params);
    return;
  }
  params.append(prefix, String(value));
}
function form(body) {
  const params = new URLSearchParams();
  encodeForm(body, "", params);
  return params.toString();
}

/** Stripe-shaped request. `status` is asserted; the JSON body and headers are returned. */
async function api(method, path, { body, status = 200, headers = {}, rawBody, contentType } = {}) {
  const hasBody = method === "POST" || rawBody !== undefined;
  const response = await fetch(`${HTTP}${path}`, {
    method,
    headers: { authorization: `Bearer ${HTTP_TOKEN}`, ...(hasBody ? { "content-type": contentType ?? "application/x-www-form-urlencoded" } : {}), ...headers },
    ...(hasBody ? { body: rawBody ?? form(body ?? {}) } : {}),
  });
  const text = await response.text();
  let json;
  try {
    json = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  assert.equal(response.status, status, `${method} ${path} ${body === undefined ? "" : JSON.stringify(body).slice(0, 200)} -> ${response.status} ${text.slice(0, 500)}`);
  if (json !== undefined && (json.object !== undefined || json.error !== undefined)) {
    assert.ok((response.headers.get("request-id") ?? "").startsWith("req_"), `${method} ${path}: missing Request-Id`);
    assert.equal(response.headers.get("stripe-version"), "2026-08-26.dahlia", `${method} ${path}: missing Stripe-Version`);
  }
  return { json, headers: response.headers, status: response.status };
}
const get = (path, options) => api("GET", path, options);
const post = (path, body, options) => api("POST", path, { ...options, body });
const del = (path, options) => api("DELETE", path, options);

/** Expect Stripe's error envelope: status, `type`, optional `code` and a message fragment. */
// Ids of Stripe objects named anywhere in an error body (the request log URL is excluded: it names the request).
function stripeIdsIn(body) {
  const { request_log_url: _log, ...rest } = body;
  void _log;
  return [...new Set(JSON.stringify(rest).match(/\b(?:pi|pm|ch|re|cus|in|inpay|il|ii|sub|si|prod|price|txn)_[A-Za-z0-9]+/g) ?? [])];
}

/** A creation-time decline: Stripe's envelope only — no PaymentIntent, PaymentMethod, charge or any other id. */
function assertCreationDeclineBody(body) {
  assert.equal(body.type, "card_error");
  assert.equal(body.code, "card_declined");
  assert.equal(typeof body.decline_code, "string");
  assert.equal(typeof body.message, "string");
  assert.equal(body.doc_url, "https://stripe.com/docs/error-codes/card-declined");
  assert.match(body.request_log_url, /\/logs\/req_/);
  assert.equal("payment_intent" in body, false, "the PaymentIntent was never stored, so it is not named");
  assert.equal("payment_method" in body, false, "no PaymentMethod is named");
  assert.equal("charge" in body, false, "no charge is named");
  assert.deepEqual(stripeIdsIn(body), [], "a creation-time decline names no object id");
}

/** A decline on an existing object names only ids that existed before the call. */
function assertIdsOnly(body, allowed, label) {
  for (const id of stripeIdsIn(body)) assert.ok(allowed.includes(id), `${label} names ${id}, which did not exist before the call`);
}

async function apiError(method, path, status, type, code, text, options = {}) {
  const result = await api(method, path, { ...options, status });
  const error = result.json?.error;
  assert.ok(error && typeof error.message === "string", `${method} ${path}: no Stripe error envelope: ${JSON.stringify(result.json)}`);
  assert.equal(error.type, type, `${method} ${path}: ${JSON.stringify(error)}`);
  if (code !== undefined) assert.equal(error.code, code, `${method} ${path}: ${JSON.stringify(error)}`);
  if (text !== undefined) assert.ok(error.message.includes(text), `${method} ${path}: expected ${JSON.stringify(text)} in ${JSON.stringify(error)}`);
  assert.ok(typeof error.request_log_url === "string", `${method} ${path}: no request_log_url`);
  return error;
}
const postError = (path, body, status, type, code, text, options) => apiError("POST", path, status, type, code, text, { ...options, body });
const getError = (path, status, type, code, text) => apiError("GET", path, status, type, code, text);
const invalidRequest = (method, path, code, text, body) => apiError(method, path, 400, "invalid_request_error", code, text, body === undefined ? {} : { body });
const notFound = (method, path, text, body) => apiError(method, path, 404, "invalid_request_error", "resource_missing", text, body === undefined ? {} : { body });
const call = ([method, path, body], options) => api(method, path, { ...options, ...(body === undefined ? {} : { body }) });
const callError = ([method, path, body], status, type, code, text) => apiError(method, path, status, type, code, text, body === undefined ? {} : { body });

let rpcId = 0;
async function rpc(method, params) {
  const response = await fetch(MCP, {
    method: "POST",
    headers: { authorization: `Bearer ${MCP_TOKEN}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  assert.equal(response.status, 200, `MCP ${method} -> HTTP ${response.status}`);
  const text = await response.text();
  const messages = (response.headers.get("content-type") ?? "").includes("text/event-stream")
    ? text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5).trim()))
    : [JSON.parse(text)];
  const reply = messages.find((message) => message.id === rpcId);
  assert.ok(reply, `MCP ${method}: no JSON-RPC reply`);
  if (reply.error) throw new Error(`MCP ${method} failed: ${JSON.stringify(reply.error)}`);
  return reply.result;
}
async function mcpInit() {
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "stripe-conformance", version: "0.1.0" } });
}
async function mcp(name, args) {
  const result = await rpc("tools/call", { name, arguments: args });
  assert.ok(!result.isError, `${name} ${JSON.stringify(args)}: ${JSON.stringify(result).slice(0, 500)}`);
  return result.structuredContent;
}
async function mcpError(name, args, code) {
  const result = await rpc("tools/call", { name, arguments: args });
  assert.ok(result.isError, `${name} ${JSON.stringify(args)} unexpectedly succeeded`);
  if (code !== undefined) {
    const error = result.structuredContent?.error;
    assert.ok(error, `${name}: ${JSON.stringify(result).slice(0, 400)}`);
    assert.equal(error.code, code, JSON.stringify(error));
  }
  return result.structuredContent;
}

const ids = (list) => list.data.map((item) => item.id);

/**
 * The shared form/query decoder: reserved segments cannot reach a prototype, oversized array indices and caller-chosen
 * nesting depth answer Stripe's 400 quickly, and legitimate bracket forms still decode. Every rejection is followed by a
 * balance read, which would answer 500 if `Object.prototype` had been written.
 */
async function formDecoderGuards() {
  const raw = async (method, path, rawBody, code, text) => {
    const started = Date.now();
    const error = await apiError(method, path, 400, "invalid_request_error", code, text, rawBody === undefined ? {} : { rawBody });
    assert.ok(Date.now() - started < 1000, `${method} ${path} took ${Date.now() - started} ms`);
    assert.ok(!/Maximum call stack|Cannot read|is not a function|undefined/.test(error.message), `runtime text leaked: ${error.message}`);
    assert.equal((await get("/v1/balance")).json.object, "balance", "every route keeps answering after a rejected form");
    return error;
  };
  for (const key of ["__proto__[polluted]", "constructor[prototype][polluted]", "prototype[polluted]"]) {
    const body = await raw("POST", "/v1/customers", `${key}=1`, "parameter_unknown", `Received unknown parameter: ${key}`);
    assert.equal(body.param, key);
    await raw("GET", `/v1/customers?${key}=1`, undefined, "parameter_unknown", `Received unknown parameter: ${key}`);
  }
  await raw("POST", "/v1/customers", "metadata[__proto__]=1", "parameter_unknown", "metadata[__proto__]");
  for (const key of ["items[4294967294][price]", "expand[100000000]", "items[999999][price]"]) {
    await raw("POST", "/v1/subscriptions", `customer=${cus(1)}&${key}=x`, "parameter_invalid", "Invalid array");
  }
  await raw("GET", "/v1/customers?expand[100000000]=x", undefined, "parameter_invalid", "Invalid array");
  await raw("POST", "/v1/customers", `a${"[b]".repeat(10000)}=1`, "parameter_invalid", "nested more than 20 levels");
  await raw("POST", "/v1/customers", `a${"[b]".repeat(30000)}=1`, "parameter_invalid", "nested more than 20 levels");
  await raw("POST", "/v1/products", `metadata[a]=1&items${"[0]".repeat(12000)}=1`, "parameter_invalid", "nested more than 20 levels");
  await raw("POST", "/v1/customers", Array.from({ length: 1001 }, () => "expand[]=x").join("&"), "parameter_invalid", "Invalid array");
  // The decoder's error channel cannot be forged by a caller.
  await raw("POST", "/v1/customers", "firedrill:form_error[code]=x&firedrill:form_error[message]=y", "parameter_unknown", "Received unknown parameter");

  // Canonical JSON input: the framework drops a `__proto__` member from JSON arguments before the handler runs (the
  // handler's own guard in mergeMetadata is defence in depth); nothing is stored and no prototype is written.
  const canonical = await fetch(`${HTTP}/v1/operations/stripe/customers.update`, { method: "POST", headers: { authorization: `Bearer ${HTTP_TOKEN}`, "content-type": "application/json" }, body: `{"arguments":{"customer":"${cus(12)}","metadata":{"__proto__":{"polluted":"1"}}}}` });
  const outcome = (await canonical.json()).outcome;
  assert.ok(outcome.status === "ok" || outcome.status === "tool_error" || outcome.status === "invalid", JSON.stringify(outcome));
  if (outcome.status === "ok") assert.equal(Object.prototype.hasOwnProperty.call(outcome.value.metadata, "__proto__"), false, JSON.stringify(outcome.value.metadata));
  assert.equal((await get("/v1/balance")).json.object, "balance", "a JSON __proto__ member leaves every route answering");

  // Legitimate bracket forms keep decoding.
  const created = (await api("POST", `/v1/customers/${cus(12)}`, { rawBody: "metadata[a]=1&metadata[constructor_note]=ok&address[line1]=1%20Main%20St&address[country]=us&shipping[name]=Dock&shipping[address][line1]=2%20Pier%20Rd&shipping[address][country]=us&expand[]=invoice_settings.default_payment_method" })).json;
  assert.equal(created.shipping.address.country, "US", "three-level nesting decodes");
  assert.equal(created.metadata.a, "1");
  assert.equal(created.metadata.constructor_note, "ok");
  assert.equal(created.address.country, "US");
  assert.equal(typeof created.invoice_settings.default_payment_method, "object", "expand[] decoded into an array");
  const intent = (await api("POST", "/v1/payment_intents", { rawBody: `amount=2000&currency=usd&customer=${created.id}&automatic_payment_methods[enabled]=true&metadata[order_id]=7&expand[]=customer` })).json;
  assert.equal(intent.object, "payment_intent", JSON.stringify(intent).slice(0, 300));
  assert.equal(intent.customer.id, created.id);
  assert.equal(intent.metadata.order_id, "7");
  // items[0] and items[1] reach the handler as a two-entry array (its interval check names both prices).
  await raw("POST", "/v1/subscriptions", `customer=${cus(1)}&items[0][price]=${PRICE[52]}&items[1][price]=${PRICE[55]}`, undefined, "must share one");
}

// ---------------------------------------------------------------------------------------------
// Drill: rest-flow (owner, baseline)
// ---------------------------------------------------------------------------------------------

async function restFlow() {
  // Balance ----------------------------------------------------------------------------------
  const balance = (await get("/v1/balance")).json;
  assert.equal(balance.object, "balance");
  assert.equal(balance.livemode, false);
  const row = (rows, currency) => rows.find((entry) => entry.currency === currency);
  assert.equal(row(balance.available, "usd").amount, 51600, "usd available = captured charges older than two days minus their refunds");
  assert.equal(row(balance.pending, "usd").amount, 195550, "usd pending = the three charges of the last two virtual days");
  assert.equal(row(balance.available, "eur").amount, 10000);
  assert.equal(row(balance.available, "gbp").amount, 1500);
  await invalidRequest("GET", "/v1/balance?expand[]=nope", "parameter_invalid", "cannot be expanded");

  // Dashboard context (canonical operation only; the browser app reads the account, virtual time and permissions from it)
  const contextResponse = await fetch(`${HTTP}/v1/operations/stripe/dashboard.context`, { method: "POST", headers: { authorization: `Bearer ${HTTP_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ arguments: {} }) });
  assert.equal(contextResponse.status, 200);
  const context = (await contextResponse.json()).outcome;
  assert.equal(context.status, "ok");
  assert.equal(context.value.object, "dashboard.context");
  assert.equal(context.value.account.id, "acct_1S00Q1HxKLumenTr");
  assert.equal(context.value.account.business_name, "Lumen Trail Supply Co.");
  assert.equal(context.value.now, T, "now is the world's virtual time in seconds");
  assert.equal(context.value.livemode, false);
  assert.equal(context.value.permissions.refunds, "write", "a full secret key has write on every group");
  assert.equal(context.value.api_version, "2026-08-26.dahlia");
  const missingRoute = await fetch(`${HTTP}/v1/dashboard/context`, { headers: { authorization: `Bearer ${HTTP_TOKEN}` } });
  assert.equal(missingRoute.status, 404, "no Stripe-shaped route exists for the dashboard context");

  // Customers: listing ---------------------------------------------------------------------
  const first = (await get("/v1/customers")).json;
  assert.equal(first.object, "list");
  assert.equal(first.data.length, 10);
  assert.equal(first.has_more, true);
  assert.equal(first.url, "/v1/customers");
  assert.equal(first.data[0].id, cus(5), "newest first");
  const pages = [];
  let after;
  for (;;) {
    const page = (await get(`/v1/customers?limit=5${after === undefined ? "" : `&starting_after=${after}`}`)).json;
    pages.push(page.data.length);
    if (!page.has_more) break;
    after = page.data[page.data.length - 1].id;
  }
  assert.deepEqual(pages, [5, 5, 2], "limit=5 walks three pages with starting_after");
  const back = (await get(`/v1/customers?limit=5&ending_before=${after}`)).json;
  assert.equal(back.data.length, 5);
  assert.equal(back.has_more, true);
  assert.equal(back.data[back.data.length - 1].id, cus(6), "ending_before returns the five customers right before the cursor (cus3)");
  await invalidRequest("GET", "/v1/customers?limit=0", "parameter_invalid_integer", "limit");
  await notFound("GET", "/v1/customers?starting_after=cus_nope", "No such customer: 'cus_nope'");
  assert.deepEqual(ids((await get("/v1/customers?email=Zoe.Mueller@example.org")).json), [cus(2)], "exact, case-sensitive e-mail filter");
  assert.deepEqual(ids((await get("/v1/customers?email=zoe.mueller@example.org")).json), []);
  assert.equal((await get("/v1/customers?email=priya.raman@example.com")).json.data.length, 2, "duplicate e-mails are legal");
  assert.deepEqual(ids((await get(`/v1/customers?created[gte]=${T - 3 * DAY}`)).json), [cus(5)]);
  await invalidRequest("GET", "/v1/customers?foo=1", "parameter_invalid", "arguments do not match");

  // Mangled percent-encoding: the framework decodes `%E0%A4%A` to U+FFFD, so every list filter rejects it instead of
  // running a corrupted filter that silently matches nothing. `%ZZ` stays literal and correct UTF-8 keeps working.
  const MANGLED = "%E0%A4%A";
  for (const [path, param] of [
    [`/v1/customers?email=ana${MANGLED}`, "email"],
    ["/v1/customers?email=ana%EF%BF%BD", "email"],
    [`/v1/products?ids[]=prod${MANGLED}`, "ids"],
    [`/v1/prices?lookup_keys[]=trail${MANGLED}`, "lookup_keys"],
    [`/v1/prices?product=prod${MANGLED}`, "product"],
    [`/v1/charges?customer=cus${MANGLED}`, "customer"],
    [`/v1/refunds?charge=ch${MANGLED}`, "charge"],
    [`/v1/payment_intents?customer=cus${MANGLED}`, "customer"],
    [`/v1/invoices?subscription=sub${MANGLED}`, "subscription"],
    [`/v1/subscriptions?price=price${MANGLED}`, "price"],
    [`/v1/payment_methods?customer=${cus(1)}&type=car${MANGLED}`, "type"],
    [`/v1/prices?currency=us${MANGLED}`, "currency"],
    [`/v1/charges?payment_intent=pi${MANGLED}`, "payment_intent"],
    [`/v1/refunds?payment_intent=pi${MANGLED}`, "payment_intent"],
    [`/v1/invoices?customer=cus${MANGLED}`, "customer"],
    [`/v1/subscriptions?customer=cus${MANGLED}`, "customer"],
  ]) {
    const error = await invalidRequest("GET", path, "parameter_invalid", "U+FFFD");
    assert.equal(error.param, param, `${path}: the mangled parameter is named`);
  }
  assert.equal((await get(`/v1/customers?email=ana%ZZ`)).json.data.length, 0, "%ZZ stays literal and runs as an ordinary filter");
  // The five closed-enum filters never reach the guard: the declared enum schema rejects the mangled value first, so the
  // response is the generic framework message with no `param`. README documents exactly this split.
  for (const path of [
    `/v1/prices?type=recur${MANGLED}`,
    `/v1/invoices?status=op${MANGLED}`,
    `/v1/invoices?collection_method=charge${MANGLED}`,
    `/v1/subscriptions?status=activ${MANGLED}`,
    `/v1/subscriptions?collection_method=charge${MANGLED}`,
  ]) {
    const error = await invalidRequest("GET", path, "parameter_invalid", "arguments do not match");
    assert.equal(error.param, undefined, `${path}: the enum schema rejection names no parameter`);
  }
  const mangledCanonical = await fetch(`${HTTP}/v1/operations/stripe/customers.list`, { method: "POST", headers: { authorization: `Bearer ${HTTP_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ arguments: { email: "ana\uFFFD" } }) });
  const mangledOutcome = (await mangledCanonical.json()).outcome;
  assert.equal(mangledOutcome.status, "tool_error", "the canonical operation rejects U+FFFD too");
  assert.equal(mangledOutcome.error.code, "tool.INVALID_REQUEST");
  assert.match(mangledOutcome.error.message, /U\+FFFD/);
  assert.equal((await get("/v1/customers?email=caf%C3%A9.%E6%BC%A2@example.com")).json.data.length, 0, "correctly encoded non-ASCII filters still run (no match here)");
  assert.equal((await get("/v1/prices?lookup_keys[]=sommet_%C3%A9t%C3%A9&lookup_keys[]=%F0%9F%94%A5")).json.data.length, 0, "accented and emoji lookup keys are ordinary values");
  const jsonBody = await fetch(`${HTTP}/v1/customers`, { method: "POST", headers: { authorization: `Bearer ${HTTP_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ name: "x" }) });
  assert.equal(jsonBody.status, 415, "a JSON body on a form route is rejected by the framework");
  await jsonBody.text();

  // Customers: create / update / retrieve -----------------------------------------------------
  const kai = (await post("/v1/customers", { name: "Kai Nakamura", email: "kai.nakamura@example.com", address: { line1: "1180 NW Glisan St", city: "Portland", state: "OR", postal_code: "97209", country: "us" }, metadata: { tier: "gold", crm_id: "C-2001" }, payment_method: "pm_card_visa" })).json;
  assert.equal(kai.object, "customer");
  assert.ok(kai.id.startsWith("cus_"));
  assert.equal(kai.invoice_prefix.length, 8);
  assert.equal(kai.address.country, "US");
  assert.equal(kai.created, T);
  const kaiDefault = kai.invoice_settings.default_payment_method;
  assert.ok(kaiDefault.startsWith("pm_") && kaiDefault !== "pm_card_visa", "a test card id materialises a real payment method");
  await invalidRequest("POST", "/v1/customers", "email_invalid", "Invalid email address", { email: "not-an-email" });
  await invalidRequest("POST", "/v1/customers", "parameter_invalid", "up to 50 keys", { metadata: Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`k${index}`, "v"])) });
  await notFound("POST", "/v1/customers", "No such PaymentMethod: 'pm_nope'", { name: "x", payment_method: "pm_nope" });
  await invalidRequest("POST", "/v1/customers", "payment_method_already_attached", "already been attached", { name: "x", payment_method: PM[20] });
  const updated = (await post(`/v1/customers/${kai.id}`, { metadata: { tier: "" }, description: "Wholesale account" })).json;
  assert.deepEqual(updated.metadata, { crm_id: "C-2001" }, "an empty metadata value deletes the key");
  assert.equal(updated.description, "Wholesale account");
  await invalidRequest("POST", `/v1/customers/${kai.id}`, "payment_method_unattached", "not attached", { invoice_settings: { default_payment_method: PM[20] } });
  await invalidRequest("POST", `/v1/customers/${kai.id}`, "email_invalid", "Invalid email address", { email: "still-not-an-email" });
  await notFound("POST", "/v1/customers/cus_nope", "No such customer", { description: "x" });
  const expanded = (await get(`/v1/customers/${kai.id}?expand[]=invoice_settings.default_payment_method`)).json;
  assert.equal(expanded.invoice_settings.default_payment_method.object, "payment_method");
  assert.equal(expanded.invoice_settings.default_payment_method.card.last4, "4242");
  await invalidRequest("GET", `/v1/customers/${kai.id}?expand[]=nope`, "parameter_invalid", "cannot be expanded");
  await notFound("GET", "/v1/customers/cus_nope", "No such customer: 'cus_nope'");

  // Payment methods ------------------------------------------------------------------------
  const methods = (await get(`/v1/customers/${cus(1)}/payment_methods?limit=2`)).json;
  assert.equal(methods.data.length, 2);
  assert.equal(methods.has_more, true);
  assert.equal(methods.url, `/v1/customers/${cus(1)}/payment_methods`, "the customer path echoes its url");
  assert.ok(methods.data.every((method) => method.outcome === undefined), "the private card outcome is never returned");
  assert.equal((await get(`/v1/payment_methods?customer=${cus(1)}&type=sepa_debit`)).json.data.length, 0);
  assert.equal((await get(`/v1/payment_methods?customer=${cus(1)}`)).json.url, "/v1/payment_methods");
  await notFound("GET", "/v1/payment_methods?customer=cus_nope", "No such customer");
  await invalidRequest("GET", `/v1/payment_methods?customer=${cus(1)}&limit=0`, "parameter_invalid_integer");
  const master = (await post("/v1/payment_methods/pm_card_mastercard/attach", { customer: kai.id })).json;
  assert.ok(master.id.startsWith("pm_") && master.id !== "pm_card_mastercard");
  assert.equal(master.card.last4, "4444");
  assert.equal(master.customer, kai.id);
  assert.equal(master.billing_details.name, "Kai Nakamura");
  await invalidRequest("POST", `/v1/payment_methods/${master.id}/attach`, "payment_method_already_attached", "already been attached", { customer: cus(1) });
  await notFound("POST", "/v1/payment_methods/pm_nope/attach", "No such PaymentMethod", { customer: kai.id });
  await invalidRequest("POST", `/v1/payment_methods/${PM[29]}/attach`, "parameter_invalid", "cannot be expanded", { customer: kai.id, expand: ["nope"] });
  const detached = (await post(`/v1/payment_methods/${master.id}/detach`, {})).json;
  assert.equal(detached.customer, null);
  await invalidRequest("POST", `/v1/payment_methods/${master.id}/detach`, "payment_method_unattached", "not attached", {});
  await notFound("POST", "/v1/payment_methods/pm_nope/detach", "No such PaymentMethod", {});
  await invalidRequest("POST", `/v1/payment_methods/${PM[21]}/detach`, "parameter_invalid", "cannot be expanded", { expand: ["nope"] });

  // PaymentIntents ---------------------------------------------------------------------------
  const intent = (await post("/v1/payment_intents", { amount: 2000, currency: "usd", customer: kai.id, payment_method: kaiDefault, description: "Order #LT-5001", metadata: { order_id: "LT-5001" } })).json;
  assert.equal(intent.object, "payment_intent");
  assert.equal(intent.status, "requires_confirmation");
  assert.ok(intent.client_secret.startsWith(`${intent.id}_secret_`));
  await invalidRequest("POST", "/v1/payment_intents", "amount_too_small", "at least", { amount: 10, currency: "usd" });
  await invalidRequest("POST", "/v1/payment_intents", "parameter_invalid", "arguments do not match", { amount: 1.5, currency: "usd" });
  await invalidRequest("POST", "/v1/payment_intents", "parameter_invalid", "Invalid currency", { amount: 2000, currency: "xyz" });
  await invalidRequest("POST", "/v1/payment_intents", "parameter_invalid", "only 'card'", { amount: 2000, currency: "usd", payment_method_types: ["sepa_debit"] });
  await notFound("POST", "/v1/payment_intents", "No such customer", { amount: 2000, currency: "usd", customer: "cus_nope" });
  await invalidRequest("POST", "/v1/payment_intents", "payment_method_customer_mismatch", "belongs to the Customer", { amount: 2000, currency: "usd", customer: kai.id, payment_method: PM[20] });
  const confirmed = (await post(`/v1/payment_intents/${intent.id}/confirm`, {})).json;
  assert.equal(confirmed.status, "succeeded");
  assert.equal(confirmed.amount_received, 2000);
  assert.ok(confirmed.latest_charge.startsWith("ch_"));
  const charge = (await get(`/v1/charges/${confirmed.latest_charge}`)).json;
  assert.equal(charge.object, "charge");
  assert.equal(charge.captured, true);
  assert.equal(charge.paid, true);
  assert.equal(charge.payment_method_details.card.brand, "visa");
  assert.equal(charge.calculated_statement_descriptor, "LUMEN TRAIL");
  assert.ok(charge.balance_transaction.startsWith("txn_"));
  await invalidRequest("POST", `/v1/payment_intents/${intent.id}/confirm`, "payment_intent_unexpected_state", "already succeeded", {});
  await notFound("POST", "/v1/payment_intents/pi_nope/confirm", "No such PaymentIntent", {});
  await invalidRequest("POST", `/v1/payment_intents/${PI[112]}/confirm`, "parameter_invalid", "cannot be expanded", { expand: ["nope"] });
  const manual = (await post("/v1/payment_intents", { amount: 3000, currency: "usd", capture_method: "manual", confirm: true, payment_method: "pm_card_visa" })).json;
  assert.equal(manual.status, "requires_capture");
  assert.equal(manual.amount_capturable, 3000);
  assert.equal((await get(`/v1/charges/${manual.latest_charge}`)).json.captured, false);
  const captured = (await post(`/v1/payment_intents/${manual.id}/capture`, { amount_to_capture: 1500 })).json;
  assert.equal(captured.status, "succeeded");
  assert.equal(captured.amount_received, 1500);
  assert.equal(captured.amount_capturable, 0);
  const capturedCharge = (await get(`/v1/charges/${manual.latest_charge}`)).json;
  assert.equal(capturedCharge.captured, true);
  assert.equal(capturedCharge.amount_captured, 1500);
  await invalidRequest("POST", `/v1/payment_intents/${manual.id}/capture`, "payment_intent_unexpected_state", "cannot capture", {});
  const manual2 = (await post("/v1/payment_intents", { amount: 4000, currency: "usd", capture_method: "manual", confirm: true, payment_method: "pm_card_visa" })).json;
  await invalidRequest("POST", `/v1/payment_intents/${manual2.id}/capture`, "amount_too_large", "greater than the amount capturable", { amount_to_capture: 99999 });
  await notFound("POST", "/v1/payment_intents/pi_nope/capture", "No such PaymentIntent", {});
  const canceled = (await post(`/v1/payment_intents/${manual2.id}/cancel`, { cancellation_reason: "requested_by_customer" })).json;
  assert.equal(canceled.status, "canceled");
  assert.equal(canceled.cancellation_reason, "requested_by_customer");
  assert.equal(canceled.canceled_at, T);
  const released = (await get(`/v1/charges/${manual2.latest_charge}`)).json;
  assert.equal(released.captured, false);
  assert.equal(released.refunded, true, "cancelling an authorisation releases it");
  await invalidRequest("POST", `/v1/payment_intents/${intent.id}/cancel`, "payment_intent_unexpected_state", "already succeeded", {});
  await notFound("POST", "/v1/payment_intents/pi_nope/cancel", "No such PaymentIntent", {});
  await invalidRequest("POST", `/v1/payment_intents/${PI[113]}/cancel`, "parameter_invalid", "cannot be expanded", { expand: ["nope"] });

  // Declines: a real 402 card_error carrying the intent; the failed attempt is not persisted ---
  // Framework constraint (README Limitations): the declared failure rolls back every write, id counters included.
  // A creation-time decline therefore names no PaymentIntent, PaymentMethod or charge: none was stored, and any id
  // would 404 and then be handed to the next object created.
  const intentCountBefore = (await get("/v1/payment_intents?limit=100")).json.data.length;
  const declined = await postError("/v1/payment_intents", { amount: 2000, currency: "usd", confirm: true, payment_method: "pm_card_chargeDeclined" }, 402, "card_error", "card_declined", "Your card was declined.");
  assert.equal(declined.decline_code, "generic_decline");
  assertCreationDeclineBody(declined);
  assert.equal((await get("/v1/payment_intents?limit=100")).json.data.length, intentCountBefore, "no PaymentIntent was stored");
  const insufficient = await postError("/v1/payment_intents", { amount: 2000, currency: "usd", confirm: true, payment_method: "pm_card_chargeDeclinedInsufficientFunds" }, 402, "card_error", "card_declined", "insufficient funds");
  assert.equal(insufficient.decline_code, "insufficient_funds");
  assertCreationDeclineBody(insufficient);
  // Even a PaymentMethod that already existed is not named on a creation-time decline: the body names no object.
  const existingMethodDecline = await postError("/v1/payment_intents", { amount: 2000, currency: "usd", confirm: true, customer: cus(7), payment_method: PM[26] }, 402, "card_error", "card_declined");
  assertCreationDeclineBody(existingMethodDecline);
  const threeDs = (await post("/v1/payment_intents", { amount: 5000, currency: "usd", confirm: true, payment_method: "pm_card_authenticationRequired" })).json;
  assert.equal(threeDs.status, "requires_action");
  assert.equal(threeDs.next_action.type, "use_stripe_sdk");
  assert.equal(threeDs.latest_charge, null);
  assert.equal(stripeIdsIn(declined).includes(threeDs.id), false, "the next PaymentIntent's id never appeared in a decline body");
  const pendingDecline = (await post("/v1/payment_intents", { amount: 2500, currency: "usd", payment_method: "pm_card_chargeDeclined" })).json;
  assert.equal(pendingDecline.status, "requires_confirmation");
  const confirmDecline = await postError(`/v1/payment_intents/${pendingDecline.id}/confirm`, {}, 402, "card_error", "card_declined");
  assert.equal(confirmDecline.payment_intent.id, pendingDecline.id);
  assert.equal(confirmDecline.payment_intent.status, "requires_payment_method", "the 402 body describes the attempt as Stripe would store it");
  assert.equal(confirmDecline.payment_intent.latest_charge, null);
  assert.equal("charge" in confirmDecline.payment_intent.last_payment_error, false, "the declined charge is not persisted, so none is named");
  assert.equal(confirmDecline.payment_method.id, pendingDecline.payment_method, "the method stored on the intent before the call is named");
  assertIdsOnly(confirmDecline, [pendingDecline.id, pendingDecline.payment_method], "confirm decline");
  // Confirming with a catalogue test card materialises a PaymentMethod inside the rolled-back call: it is not named.
  const confirmCardDecline = await postError(`/v1/payment_intents/${pendingDecline.id}/confirm`, { payment_method: "pm_card_chargeDeclined" }, 402, "card_error", "card_declined");
  assert.equal(confirmCardDecline.payment_intent.id, pendingDecline.id);
  assert.equal("payment_method" in confirmCardDecline, false, "a PaymentMethod created by the rolled-back call is not named");
  assert.equal("payment_method" in confirmCardDecline.payment_intent.last_payment_error, false);
  assertIdsOnly(confirmCardDecline, [pendingDecline.id], "confirm decline with a test card");
  const afterDecline = (await get(`/v1/payment_intents/${pendingDecline.id}`)).json;
  assert.equal(afterDecline.status, "requires_confirmation", "a failed attempt rolls back (framework constraint, documented)");
  assert.equal(afterDecline.last_payment_error, null);
  assert.equal(afterDecline.payment_method, pendingDecline.payment_method);
  assert.equal(afterDecline.latest_charge, null);
  assert.equal((await get(`/v1/charges?payment_intent=${pendingDecline.id}`)).json.data.length, 0, "no failed charge is stored");
  const retried = (await post(`/v1/payment_intents/${pendingDecline.id}/confirm`, { payment_method: "pm_card_visa" })).json;
  assert.equal(retried.status, "succeeded", "retrying the same intent with another card works");
  assert.equal(retried.last_payment_error, null);

  // PaymentIntent reads --------------------------------------------------------------------
  assert.ok(ids((await get(`/v1/payment_intents?customer=${kai.id}`)).json).includes(intent.id));
  await invalidRequest("GET", "/v1/payment_intents?limit=0", "parameter_invalid_integer");
  await notFound("GET", "/v1/payment_intents?starting_after=pi_nope", "No such PaymentIntent");
  await notFound("GET", "/v1/payment_intents/pi_nope", "No such PaymentIntent: 'pi_nope'");
  await invalidRequest("GET", `/v1/payment_intents/${intent.id}?expand[]=nope`, "parameter_invalid", "cannot be expanded");
  const intentExpanded = (await get(`/v1/payment_intents/${intent.id}?expand[]=latest_charge&expand[]=customer&expand[]=payment_method`)).json;
  assert.equal(intentExpanded.latest_charge.object, "charge");
  assert.equal(intentExpanded.customer.object, "customer");
  assert.equal(intentExpanded.payment_method.object, "payment_method");
  const starterDeclined = (await get(`/v1/payment_intents/${PI[109]}`)).json;
  assert.equal(starterDeclined.last_payment_error.payment_method.object, "payment_method", "last_payment_error embeds the payment method");

  // Charges ----------------------------------------------------------------------------------
  assert.deepEqual(ids((await get(`/v1/charges?payment_intent=${intent.id}`)).json), [confirmed.latest_charge]);
  assert.equal((await get(`/v1/charges?customer=${cus(1)}`)).json.data.length, 3);
  await notFound("GET", "/v1/charges/ch_nope", "No such charge");
  await invalidRequest("GET", `/v1/charges/${CH[200]}?expand[]=nope`, "parameter_invalid", "cannot be expanded");
  await invalidRequest("GET", "/v1/charges?limit=0", "parameter_invalid_integer");
  await notFound("GET", "/v1/charges?starting_after=ch_nope", "No such charge");
  const withRefunds = (await get(`/v1/charges/${CH[200]}?expand[]=refunds`)).json;
  assert.equal(withRefunds.refunds.object, "list");
  assert.equal(withRefunds.refunds.total_count, 2);
  assert.equal(withRefunds.amount_refunded, 2000);

  // Refunds ----------------------------------------------------------------------------------
  const refund = (await post("/v1/refunds", { payment_intent: intent.id, amount: 500, reason: "requested_by_customer", metadata: { ticket: "SUP-300" } })).json;
  assert.equal(refund.object, "refund");
  assert.equal(refund.status, "succeeded");
  assert.equal(refund.charge, confirmed.latest_charge);
  assert.equal((await get(`/v1/charges/${confirmed.latest_charge}`)).json.amount_refunded, 500);
  await invalidRequest("POST", "/v1/refunds", "amount_too_large", "greater than unrefunded amount", { payment_intent: intent.id, amount: 99999 });
  const rest = (await post("/v1/refunds", { charge: confirmed.latest_charge })).json;
  assert.equal(rest.amount, 1500);
  assert.equal((await get(`/v1/charges/${confirmed.latest_charge}`)).json.refunded, true);
  await invalidRequest("POST", "/v1/refunds", "charge_already_refunded", "already been refunded", { payment_intent: intent.id });
  await invalidRequest("POST", "/v1/refunds", "charge_not_captured", "not been captured", { charge: CH[208] });
  await invalidRequest("POST", "/v1/refunds", "charge_not_refundable", "declined", { payment_intent: PI[109] });
  await invalidRequest("POST", "/v1/refunds", "parameter_invalid", "only specify one", { payment_intent: intent.id, charge: confirmed.latest_charge });
  await notFound("POST", "/v1/refunds", "No such PaymentIntent", { payment_intent: "pi_nope" });
  assert.equal((await get(`/v1/refunds?charge=${confirmed.latest_charge}`)).json.data.length, 2);
  assert.equal((await get(`/v1/refunds?payment_intent=${PI[100]}`)).json.data.length, 2);
  await invalidRequest("GET", "/v1/refunds?limit=0", "parameter_invalid_integer");
  await notFound("GET", "/v1/refunds?starting_after=re_nope", "No such refund");

  // Products and prices ----------------------------------------------------------------------
  const headlamp = (await post("/v1/products", { name: "Headlamp 400", description: "USB-C rechargeable, 400 lm", unit_label: "unit", metadata: { sku: "LT-HL-400" } })).json;
  assert.equal(headlamp.object, "product");
  assert.equal(headlamp.active, true);
  assert.equal(headlamp.default_price, null);
  await invalidRequest("POST", "/v1/products", "parameter_invalid_empty", "empty string", { name: "" });
  await invalidRequest("POST", "/v1/products", "parameter_invalid", "default_price", { name: "x", default_price: PRICE[50] });
  const oneTime = (await post("/v1/prices", { product: headlamp.id, unit_amount: 3500, currency: "usd", nickname: "Headlamp retail" })).json;
  assert.equal(oneTime.object, "price");
  assert.equal(oneTime.type, "one_time");
  assert.equal(oneTime.unit_amount_decimal, "3500");
  await invalidRequest("POST", "/v1/prices", "parameter_invalid", "one year", { product: headlamp.id, unit_amount: 100, currency: "usd", recurring: { interval: "month", interval_count: 13 } });
  await invalidRequest("POST", "/v1/prices", "resource_already_exists", "summit_monthly", { product: headlamp.id, unit_amount: 100, currency: "usd", recurring: { interval: "month" }, lookup_key: "summit_monthly" });
  await notFound("POST", "/v1/prices", "No such product: 'prod_nope'", { product: "prod_nope", unit_amount: 100, currency: "usd" });
  const monthly = (await post("/v1/prices", { product: headlamp.id, unit_amount: 900, currency: "usd", recurring: { interval: "month" }, nickname: "Headlamp rental" })).json;
  assert.equal(monthly.type, "recurring");
  assert.equal(monthly.recurring.interval_count, 1);
  const headlampUpdated = (await post(`/v1/products/${headlamp.id}`, { default_price: oneTime.id, active: false })).json;
  assert.equal(headlampUpdated.default_price, oneTime.id);
  assert.equal(headlampUpdated.active, false);
  await invalidRequest("POST", `/v1/products/${headlamp.id}`, "parameter_invalid", "does not belong", { default_price: PRICE[50] });
  await notFound("POST", "/v1/products/prod_nope", "No such product", { name: "x" });
  assert.equal((await get(`/v1/products/${headlamp.id}?expand[]=default_price`)).json.default_price.object, "price");
  await notFound("GET", "/v1/products/prod_nope", "No such product");
  await invalidRequest("GET", `/v1/products/${PROD[40]}?expand[]=nope`, "parameter_invalid", "cannot be expanded");
  assert.equal((await get(`/v1/prices?product=${headlamp.id}&active=true`)).json.data.length, 2);
  assert.deepEqual(ids((await get("/v1/prices?lookup_keys[]=summit_monthly")).json), [PRICE[52]]);
  assert.equal((await get("/v1/prices?type=recurring&limit=100")).json.data.length, 6, "starter recurring prices (inactive included) plus the new one");
  assert.equal((await get("/v1/prices?currency=gbp")).json.data.length, 1);
  await invalidRequest("GET", "/v1/prices?limit=0", "parameter_invalid_integer");
  await notFound("GET", "/v1/prices?starting_after=price_nope", "No such price");
  assert.equal((await get(`/v1/prices/${PRICE[52]}?expand[]=product`)).json.product.name, "Summit Membership");
  await notFound("GET", "/v1/prices/price_nope", "No such price");
  await invalidRequest("GET", `/v1/prices/${PRICE[50]}?expand[]=nope`, "parameter_invalid", "cannot be expanded");
  assert.deepEqual(ids((await get(`/v1/products?ids[]=${headlamp.id}&ids[]=prod_nope`)).json), [headlamp.id]);
  assert.equal((await get("/v1/products?active=false")).json.data.length, 2);
  await invalidRequest("GET", "/v1/products?limit=0", "parameter_invalid_integer");
  await notFound("GET", "/v1/products?starting_after=prod_nope", "No such product");

  // Invoice items and invoices ---------------------------------------------------------------
  const item = (await post("/v1/invoiceitems", { customer: cus(10), price: PRICE[51], quantity: 2 })).json;
  assert.equal(item.object, "invoiceitem");
  assert.equal(item.invoice, null, "pending until the next invoice");
  assert.equal(item.amount, 15800);
  assert.equal(item.description, "Merino Base Layer");
  const viaPricing = (await post("/v1/invoiceitems", { customer: cus(10), pricing: { price: PRICE[51] } })).json;
  assert.equal(viaPricing.pricing.price_details.price, PRICE[51]);
  await invalidRequest("POST", "/v1/invoiceitems", "parameter_invalid", "recurring price", { customer: cus(10), price: PRICE[52] });
  const adHoc = (await post("/v1/invoiceitems", { customer: cus(10), amount: 1200, currency: "usd", description: "Setup fee" })).json;
  assert.equal(adHoc.pricing, null);
  await notFound("POST", "/v1/invoiceitems", "No such customer", { customer: "cus_nope", amount: 100, currency: "usd" });
  await notFound("POST", "/v1/invoiceitems", "No such price: 'price_nope'", { customer: cus(10), price: "price_nope" });
  const draft = (await post("/v1/invoices", { customer: cus(10), description: "September order" })).json;
  assert.equal(draft.object, "invoice");
  assert.equal(draft.status, "draft");
  assert.equal(draft.billing_reason, "manual");
  assert.equal(draft.number, null);
  assert.equal(draft.currency, "usd");
  assert.equal(draft.lines.data.length, 5, "the two starter usd pending items plus the three new ones; the eur item stays pending");
  assert.equal(draft.total, 7900 + 1500 + 15800 + 7900 + 1200);
  assert.equal(draft.amount_due, draft.total);
  assert.equal(draft.lines.data[0].parent.type, "invoice_item_details");
  await invalidRequest("POST", "/v1/invoices", "parameter_missing", "days_until_due", { customer: cus(10), collection_method: "send_invoice" });
  await invalidRequest("POST", "/v1/invoices", "payment_method_unattached", "not attached", { customer: cus(10), default_payment_method: PM[20] });
  await notFound("POST", "/v1/invoices", "No such customer", { customer: "cus_nope" });
  const appended = (await post("/v1/invoiceitems", { customer: cus(10), amount: 500, currency: "usd", description: "Gift wrap", invoice: draft.id })).json;
  assert.equal(appended.invoice, draft.id);
  const draftAfter = (await get(`/v1/invoices/${draft.id}`)).json;
  assert.equal(draftAfter.lines.data.length, 6);
  assert.equal(draftAfter.total, draft.total + 500);
  await invalidRequest("POST", "/v1/invoiceitems", "invoice_not_editable", "no longer editable", { customer: cus(2), amount: 100, currency: "usd", invoice: IN[406] });
  await invalidRequest("POST", `/v1/invoices/${IN[401]}/finalize`, "invoice_no_customer_line_items", "no line items", {});
  const open = (await post(`/v1/invoices/${draft.id}/finalize`, {})).json;
  assert.equal(open.status, "open");
  assert.ok(/^[A-Z0-9]{8}-0001$/.test(open.number), open.number);
  assert.equal(open.hosted_invoice_url, `https://invoice.stripe.test/i/${draft.id}`);
  assert.equal(open.status_transitions.finalized_at, T);
  assert.equal(open.payments.data.length, 1);
  assert.equal(open.payments.data[0].status, "open");
  const invoiceIntentId = open.payments.data[0].payment.payment_intent;
  assert.equal((await get(`/v1/payment_intents/${invoiceIntentId}`)).json.status, "requires_payment_method");
  await invalidRequest("POST", `/v1/invoices/${draft.id}/finalize`, "invoice_not_editable", "already finalized", {});
  await notFound("POST", "/v1/invoices/in_nope/finalize", "No such invoice", {});
  await invalidRequest("POST", `/v1/invoices/${IN[400]}/finalize`, "parameter_invalid", "cannot be expanded", { expand: ["nope"] });
  await invalidRequest("POST", `/v1/payment_intents/${invoiceIntentId}/cancel`, "payment_intent_invoice_managed", "belongs to invoice", {});
  const paid = (await post(`/v1/invoices/${draft.id}/pay`, {})).json;
  assert.equal(paid.status, "paid");
  assert.equal(paid.amount_paid, draftAfter.total);
  assert.equal(paid.amount_remaining, 0);
  assert.equal(paid.attempt_count, 1);
  assert.equal(paid.attempted, true);
  assert.equal(paid.status_transitions.paid_at, T);
  assert.equal(paid.payments.data[0].status, "paid");
  assert.ok(paid.payments.data[0].payment.charge.startsWith("ch_"));
  const invoiceIntent = (await get(`/v1/payment_intents/${invoiceIntentId}`)).json;
  assert.equal(invoiceIntent.status, "succeeded");
  assert.equal(invoiceIntent.description, `Invoice ${open.number}`);
  await invalidRequest("POST", `/v1/invoices/${draft.id}/pay`, "invoice_already_paid", "already paid", {});
  await invalidRequest("POST", `/v1/invoices/${IN[400]}/pay`, "invoice_not_finalized", "finalized", {});
  await notFound("POST", "/v1/invoices/in_nope/pay", "No such invoice", {});
  await invalidRequest("POST", `/v1/invoices/${IN[402]}/pay`, "parameter_invalid", "out of band", { paid_out_of_band: true, payment_method: "pm_card_visa" });
  // A declining default card: 402 and the invoice stays open (the attempt is rolled back)
  await post("/v1/invoiceitems", { customer: cus(7), amount: 2000, currency: "usd", description: "Trail map bundle" });
  const declineDraft = (await post("/v1/invoices", { customer: cus(7) })).json;
  const declineOpen = (await post(`/v1/invoices/${declineDraft.id}/finalize`, {})).json;
  assert.equal(declineOpen.status, "open");
  const invoiceDecline = await postError(`/v1/invoices/${declineDraft.id}/pay`, {}, 402, "card_error", "card_declined");
  assert.equal(invoiceDecline.decline_code, "generic_decline");
  assert.equal(invoiceDecline.payment_method.id, PM[26], "the customer's existing default card is named");
  assert.equal(invoiceDecline.payment_intent.latest_charge, null);
  assertIdsOnly(invoiceDecline, [invoiceDecline.payment_intent.id, cus(7), declineDraft.id, PM[26]], "invoice pay decline");
  const invoiceCardDecline = await postError(`/v1/invoices/${declineDraft.id}/pay`, { payment_method: "pm_card_chargeDeclined" }, 402, "card_error", "card_declined");
  assert.equal(invoiceCardDecline.payment_intent.id, invoiceDecline.payment_intent.id);
  assert.equal("payment_method" in invoiceCardDecline, false, "a PaymentMethod created by the rolled-back call is not named");
  assertIdsOnly(invoiceCardDecline, [invoiceDecline.payment_intent.id, cus(7), declineDraft.id], "invoice pay decline with a test card");
  const stillOpen = (await get(`/v1/invoices/${declineDraft.id}?expand[]=payments.data.payment.payment_intent`)).json;
  assert.equal(stillOpen.status, "open");
  assert.equal(stillOpen.attempt_count, 0, "the declined attempt is not persisted (framework constraint, documented)");
  const stillOpenIntent = stillOpen.payments.data[0].payment.payment_intent;
  assert.equal(invoiceDecline.payment_intent.id, stillOpenIntent.id);
  assert.equal(invoiceDecline.payment_intent.last_payment_error.decline_code, "generic_decline");
  assert.equal(stillOpenIntent.status, "requires_payment_method");
  assert.equal(stillOpenIntent.last_payment_error, null, "unlike Stripe, last_payment_error is not stored");
  const paidWithVisa = (await post(`/v1/invoices/${declineDraft.id}/pay`, { payment_method: "pm_card_visa" })).json;
  assert.equal(paidWithVisa.status, "paid");
  await invalidRequest("POST", `/v1/invoices/${IN[409]}/pay`, "invoice_no_payment_method", "no attached payment source", {});
  // Void
  const voided = (await post(`/v1/invoices/${IN[402]}/void`, {})).json;
  assert.equal(voided.status, "void");
  assert.equal(voided.status_transitions.voided_at, T);
  assert.equal(voided.payments.data[0].status, "canceled");
  const voidedIntent = (await get(`/v1/payment_intents/${PI[114]}`)).json;
  assert.equal(voidedIntent.status, "canceled");
  assert.equal(voidedIntent.cancellation_reason, "void_invoice");
  await invalidRequest("POST", `/v1/invoices/${IN[400]}/void`, "invoice_not_finalized", "Draft invoices", {});
  await invalidRequest("POST", `/v1/invoices/${IN[406]}/void`, "invoice_already_paid", "already paid", {});
  await notFound("POST", "/v1/invoices/in_nope/void", "No such invoice", {});
  await invalidRequest("POST", `/v1/invoices/${IN[403]}/void`, "parameter_invalid", "cannot be expanded", { expand: ["nope"] });
  // Invoice reads
  assert.ok(ids((await get("/v1/invoices?status=open")).json).includes(IN[403]));
  assert.ok(!ids((await get("/v1/invoices?status=open")).json).includes(IN[402]));
  assert.equal((await get(`/v1/invoices?customer=${cus(10)}`)).json.data.length, 1);
  assert.deepEqual(ids((await get(`/v1/invoices?subscription=${SUB[601]}`)).json), [IN[404]]);
  assert.deepEqual(ids((await get(`/v1/invoices?due_date[lt]=${T}&status=open`)).json), [IN[403]], "the past-due open invoice");
  assert.equal((await get(`/v1/invoices?due_date[lt]=${T}`)).json.data.length, 2, "past due: the open one and the uncollectible one");
  assert.equal((await get("/v1/invoices?collection_method=send_invoice&limit=100")).json.data.length, 3);
  await notFound("GET", "/v1/invoices/in_nope", "No such invoice");
  await notFound("GET", "/v1/invoices/upcoming", "No such invoice: 'upcoming'");
  await invalidRequest("GET", `/v1/invoices/${IN[400]}?expand[]=nope`, "parameter_invalid", "cannot be expanded");
  await invalidRequest("GET", "/v1/invoices?limit=0", "parameter_invalid_integer");
  await notFound("GET", "/v1/invoices?starting_after=in_nope", "No such invoice");
  const invoiceExpanded = (await get(`/v1/invoices/${IN[404]}?expand[]=customer&expand[]=payments.data.payment.payment_intent&expand[]=parent.subscription_details.subscription`)).json;
  assert.equal(invoiceExpanded.customer.object, "customer");
  assert.equal(invoiceExpanded.payments.data[0].payment.payment_intent.object, "payment_intent");
  assert.equal(invoiceExpanded.parent.subscription_details.subscription.object, "subscription");
  const delinquent = (await get(`/v1/customers/${cus(8)}`)).json;
  assert.equal(delinquent.delinquent, true, "an open invoice past its due date makes the customer delinquent");

  // Subscriptions -----------------------------------------------------------------------------
  const active = (await post("/v1/subscriptions", { customer: cus(1), items: [{ price: PRICE[54], quantity: 2 }], expand: ["latest_invoice.payments.data.payment.payment_intent"], metadata: { source: "conformance" } })).json;
  assert.equal(active.object, "subscription");
  assert.equal(active.status, "active");
  assert.equal(active.currency, "usd");
  assert.equal(active.items.data[0].current_period_start, T);
  assert.equal(active.items.data[0].current_period_end, MONTH_LATER, "one month later, calendar arithmetic");
  assert.equal(active.items.data[0].plan.amount, 1200);
  assert.equal(active.items.data[0].price.id, PRICE[54]);
  assert.equal(active.latest_invoice.status, "paid");
  assert.equal(active.latest_invoice.billing_reason, "subscription_create");
  assert.equal(active.latest_invoice.total, 2400);
  assert.equal(active.latest_invoice.lines.data[0].parent.type, "subscription_item_details");
  assert.equal(active.latest_invoice.lines.data[0].description, "2 × Basecamp Membership (at $12.00 / month)");
  assert.equal(active.latest_invoice.payments.data[0].payment.payment_intent.status, "succeeded");
  await invalidRequest("POST", "/v1/subscriptions", "parameter_invalid", "one-time price", { customer: cus(1), items: [{ price: PRICE[50] }] });
  await invalidRequest("POST", "/v1/subscriptions", "parameter_invalid", "inactive", { customer: cus(1), items: [{ price: PRICE[58] }] });
  await invalidRequest("POST", "/v1/subscriptions", "parameter_invalid", "billing interval", { customer: cus(1), items: [{ price: PRICE[52] }, { price: PRICE[53] }] });
  await notFound("POST", "/v1/subscriptions", "No such customer", { customer: "cus_nope", items: [{ price: PRICE[54] }] });
  await notFound("POST", "/v1/subscriptions", "No such price: 'price_nope'", { customer: cus(1), items: [{ price: "price_nope" }] });
  const incomplete = (await post("/v1/subscriptions", { customer: cus(5), items: [{ price: PRICE[52] }], expand: ["latest_invoice.payments.data.payment.payment_intent"] })).json;
  assert.equal(incomplete.status, "incomplete", "no payment method: incomplete with an open first invoice");
  assert.equal(incomplete.latest_invoice.status, "open");
  assert.equal(incomplete.latest_invoice.payments.data[0].payment.payment_intent.status, "requires_payment_method");
  const declinedSub = (await post("/v1/subscriptions", { customer: cus(7), items: [{ price: PRICE[52] }], expand: ["latest_invoice.payments.data.payment.payment_intent"] })).json;
  assert.equal(declinedSub.status, "incomplete", "a declining default card: incomplete, the failed attempt persisted");
  const declinedSubIntent = declinedSub.latest_invoice.payments.data[0].payment.payment_intent;
  assert.equal(declinedSubIntent.status, "requires_payment_method");
  assert.equal(declinedSubIntent.last_payment_error.decline_code, "generic_decline");
  assert.equal(declinedSub.latest_invoice.attempt_count, 1);
  assert.equal((await get(`/v1/charges?payment_intent=${declinedSubIntent.id}`)).json.data[0].status, "failed");
  const subDecline = await postError("/v1/subscriptions", { customer: cus(7), items: [{ price: PRICE[52] }], payment_behavior: "error_if_incomplete" }, 402, "card_error", "card_declined");
  assert.equal(subDecline.decline_code, "generic_decline");
  assertCreationDeclineBody(subDecline);
  await invalidRequest("POST", "/v1/subscriptions", "customer_missing_payment_method", "no attached payment source", { customer: cus(5), items: [{ price: PRICE[52] }], payment_behavior: "error_if_incomplete" });
  const trialing = (await post("/v1/subscriptions", { customer: cus(2), items: [{ price: PRICE[52] }], trial_period_days: 14, expand: ["latest_invoice"] })).json;
  assert.equal(trialing.status, "trialing");
  assert.equal(trialing.trial_start, T);
  assert.equal(trialing.trial_end, T + 14 * DAY);
  assert.equal(trialing.latest_invoice.status, "paid");
  assert.equal(trialing.latest_invoice.total, 0);
  assert.equal(trialing.latest_invoice.payments.data.length, 0, "a zero-total invoice needs no PaymentIntent");
  const sendInvoice = (await post("/v1/subscriptions", { customer: cus(3), items: [{ price: PRICE[54] }], collection_method: "send_invoice", days_until_due: 30, expand: ["latest_invoice"] })).json;
  assert.equal(sendInvoice.status, "active");
  assert.equal(sendInvoice.days_until_due, 30);
  assert.equal(sendInvoice.latest_invoice.status, "open");
  assert.equal(sendInvoice.latest_invoice.due_date, T + 30 * DAY);
  // Listing
  assert.equal((await get("/v1/subscriptions?limit=100")).json.data.length, 10, "canceled subscriptions are hidden by default");
  assert.equal((await get("/v1/subscriptions?limit=100&status=all")).json.data.length, 11);
  assert.deepEqual(ids((await get("/v1/subscriptions?status=canceled")).json), [SUB[605]]);
  assert.deepEqual(ids((await get("/v1/subscriptions?status=ended")).json), [SUB[605]]);
  assert.equal((await get(`/v1/subscriptions?customer=${cus(1)}`)).json.data.length, 2);
  assert.equal((await get(`/v1/subscriptions?price=${PRICE[54]}&limit=100`)).json.data.length, 5);
  assert.equal((await get(`/v1/subscriptions?created[gte]=${T}&limit=100`)).json.data.length, 5);
  await invalidRequest("GET", "/v1/subscriptions?limit=0", "parameter_invalid_integer");
  await notFound("GET", "/v1/subscriptions?starting_after=sub_nope", "No such subscription");
  await notFound("GET", "/v1/subscriptions/sub_nope", "No such subscription");
  await invalidRequest("GET", `/v1/subscriptions/${SUB[601]}?expand[]=nope`, "parameter_invalid", "cannot be expanded");
  assert.equal((await get(`/v1/subscriptions/${SUB[604]}?expand[]=latest_invoice&expand[]=customer`)).json.latest_invoice.status, "paid");
  // Updates
  const cancelLater = (await post(`/v1/subscriptions/${SUB[601]}`, { cancel_at_period_end: true })).json;
  assert.equal(cancelLater.status, "active");
  assert.equal(cancelLater.cancel_at_period_end, true);
  assert.equal(cancelLater.cancel_at, cancelLater.items.data[0].current_period_end);
  assert.equal(cancelLater.canceled_at, T);
  assert.equal(cancelLater.cancellation_details.reason, "cancellation_requested");
  const resumed = (await post(`/v1/subscriptions/${SUB[601]}`, { cancel_at_period_end: false })).json;
  assert.equal(resumed.cancel_at, null);
  assert.equal(resumed.canceled_at, null);
  const quantity = (await post(`/v1/subscriptions/${SUB[601]}`, { items: [{ id: SI_601[0], quantity: 3 }], proration_behavior: "none" })).json;
  assert.equal(quantity.items.data.find((entry) => entry.id === SI_601[0]).quantity, 3);
  await invalidRequest("POST", `/v1/subscriptions/${SUB[601]}`, "parameter_invalid", "billing interval", { items: [{ price: PRICE[53] }] });
  const added = (await post(`/v1/subscriptions/${SUB[601]}`, { items: [{ price: monthly.id }] })).json;
  assert.equal(added.items.data.length, 3);
  const removed = (await post(`/v1/subscriptions/${SUB[601]}`, { items: [{ id: SI_601[1], deleted: true }] })).json;
  assert.equal(removed.items.data.length, 2);
  await invalidRequest("POST", `/v1/subscriptions/${trialing.id}`, "parameter_invalid", "at least one item", { items: [{ id: trialing.items.data[0].id, deleted: true }] });
  await notFound("POST", `/v1/subscriptions/${SUB[601]}`, "No such subscription_item: 'si_nope'", { items: [{ id: "si_nope", quantity: 1 }] });
  await invalidRequest("POST", `/v1/subscriptions/${SUB[601]}`, "payment_method_unattached", "not attached", { default_payment_method: PM[20] });
  await invalidRequest("POST", `/v1/subscriptions/${SUB[605]}`, "subscription_canceled", "canceled subscription", { description: "x" });
  await notFound("POST", "/v1/subscriptions/sub_nope", "No such subscription", { description: "x" });
  const endedTrial = (await post(`/v1/subscriptions/${trialing.id}`, { trial_end: "now" })).json;
  assert.equal(endedTrial.status, "active");
  assert.equal(endedTrial.trial_end, T);
  const described = (await post(`/v1/subscriptions/${SUB[604]}`, { description: "Summer only", metadata: { note: "keep" }, cancellation_details: { comment: "Season over", feedback: "unused" } })).json;
  assert.equal(described.description, "Summer only");
  assert.equal(described.cancellation_details.comment, "Season over");
  // Cancel
  const canceledSub = (await del(`/v1/subscriptions/${incomplete.id}`)).json;
  assert.equal(canceledSub.status, "canceled");
  assert.equal(canceledSub.canceled_at, T);
  assert.equal(canceledSub.ended_at, T);
  assert.equal((await get(`/v1/invoices/${incomplete.latest_invoice.id}`)).json.status, "void", "cancelling an incomplete subscription voids its first invoice");
  await notFound("DELETE", `/v1/subscriptions/${incomplete.id}`, "No such subscription");
  await notFound("DELETE", "/v1/subscriptions/sub_nope", "No such subscription");
  await invalidRequest("DELETE", `/v1/subscriptions/${SUB[604]}?expand[]=nope`, "parameter_invalid", "cannot be expanded");
  const withBody = await fetch(`${HTTP}/v1/subscriptions/${SUB[604]}`, { method: "DELETE", headers: { authorization: `Bearer ${HTTP_TOKEN}`, "content-type": "application/x-www-form-urlencoded" }, body: "invoice_now=true" });
  assert.equal(withBody.status, 400, "DELETE accepts no body (framework HTTP_BODY_NOT_ALLOWED)");
  assert.equal((await withBody.json()).code, "framework.HTTP_BODY_NOT_ALLOWED");

  // Idempotency, unknown routes, auth ------------------------------------------------------
  const idem1 = (await post("/v1/customers", { name: "Idem Potent", email: "idem@example.org" }, { headers: { "idempotency-key": "conformance-key-1" } }));
  const idem2 = (await post("/v1/customers", { name: "Idem Potent", email: "idem@example.org" }, { headers: { "idempotency-key": "conformance-key-1" } }));
  assert.deepEqual(idem2.json, idem1.json, "the same Idempotency-Key replays the original response");
  assert.equal(idem1.headers.get("idempotency-key"), "conformance-key-1");
  assert.equal((await get("/v1/customers?email=idem@example.org")).json.data.length, 1);
  const unknown = await fetch(`${HTTP}/v1/checkout/sessions`, { headers: { authorization: `Bearer ${HTTP_TOKEN}` } });
  assert.equal(unknown.status, 404);
  await unknown.text();
  const basic = await fetch(`${HTTP}/v1/customers`, { headers: { authorization: `Basic ${Buffer.from(`${HTTP_TOKEN}:`).toString("base64")}` } });
  assert.equal(basic.status, 401, "HTTP Basic (curl -u sk_test_x:) is not accepted");
  await basic.text();
  assert.equal((await get("/v1/customers?limit=100")).json.data.length, 14);
  await formDecoderGuards();
  assert.equal((await get("/v1/customers?limit=100")).json.data.length, 14, "rejected forms created no customer");
}

// ---------------------------------------------------------------------------------------------
// Drill: mcp-aliases (owner, baseline)
// ---------------------------------------------------------------------------------------------

async function mcpAliases() {
  await mcpInit();
  const tools = (await rpc("tools/list", {})).tools.map((tool) => tool.name);
  for (const alias of ALIASES) assert.ok(tools.includes(alias), `alias ${alias} missing`);
  for (const operationId of ALL_OPERATIONS) assert.ok(tools.includes(`stripe.${operationId}`), `canonical stripe.${operationId} missing`);

  const balance = await mcp("retrieve_balance", {});
  assert.equal(balance.object, "balance");
  const customer = await mcp("create_customer", { name: "Alias Co", email: "alias@example.org" });
  assert.equal(customer.object, "customer");
  assert.equal(customer.email, "alias@example.org");
  assert.deepEqual(ids(await mcp("list_customers", { limit: 3, email: "alias@example.org" })), [customer.id]);
  const product = await mcp("create_product", { name: "Alias Widget", description: "Created over MCP" });
  assert.equal(product.object, "product");
  const products = await mcp("list_products", { limit: 2 });
  assert.equal(products.data.length, 2);
  assert.equal(products.has_more, true);
  const price = await mcp("create_price", { product: product.id, unit_amount: 1200, currency: "usd" });
  assert.equal(price.type, "one_time");
  assert.deepEqual(ids(await mcp("list_prices", { product: product.id })), [price.id]);
  const invoice = await mcp("create_invoice", { customer: customer.id, days_until_due: 7 });
  assert.equal(invoice.status, "draft");
  assert.equal(invoice.collection_method, "send_invoice", "days_until_due implies send_invoice");
  assert.equal(invoice.due_date, T + 7 * DAY);
  const item = await mcp("create_invoice_item", { customer: customer.id, price: price.id, invoice: invoice.id });
  assert.equal(item.invoice, invoice.id);
  const finalized = await mcp("finalize_invoice", { invoice: invoice.id });
  assert.equal(finalized.status, "open");
  assert.equal(finalized.total, 1200);
  assert.deepEqual(ids(await mcp("list_invoices", { customer: customer.id })), [invoice.id]);
  const intents = await mcp("list_payment_intents", { customer: cus(1), limit: 2 });
  assert.equal(intents.data.length, 2);
  assert.equal(intents.has_more, true);
  const refund = await mcp("create_refund", { payment_intent: PI[102], amount: 100 });
  assert.equal(refund.status, "succeeded");
  assert.equal(refund.charge, CH[202]);
  const subscriptions = await mcp("list_subscriptions", { status: "all", limit: 3 });
  assert.equal(subscriptions.data.length, 3);
  assert.equal(subscriptions.has_more, true);
  const updated = await mcp("update_subscription", { subscription: SUB[601], proration_behavior: "none", items: [{ id: SI_601[0], quantity: 4 }] });
  assert.equal(updated.items.data.find((entry) => entry.id === SI_601[0]).quantity, 4);
  const canceled = await mcp("cancel_subscription", { subscription: SUB[602] });
  assert.equal(canceled.status, "canceled");

  await mcpError("create_refund", { payment_intent: "pi_nope" }, "tool.RESOURCE_MISSING");
  await mcpError("list_prices", { limit: 500 }, "tool.INVALID_REQUEST");
  await mcpError("finalize_invoice", { invoice: invoice.id }, "tool.INVALID_STATE");
  await mcpError("create_customer", { name: "x", bogus: 1 });

  assert.equal((await get(`/v1/customers/${customer.id}`)).json.name, "Alias Co", "the MCP-created customer is visible over REST");
}

// ---------------------------------------------------------------------------------------------
// Drill: restricted-key (readonly-key, baseline)
// ---------------------------------------------------------------------------------------------

async function restrictedKey() {
  assert.equal((await get("/v1/balance")).json.object, "balance");
  assert.equal((await get("/v1/customers")).json.data.length, 10);
  const denied = await postError("/v1/customers", { name: "x" }, 403, "invalid_request_error", undefined, "'customers: write'");
  assert.ok(denied.message.includes("acct_1S00Q1HxKLumenTr"));
  await postError("/v1/refunds", { payment_intent: PI[102] }, 403, "invalid_request_error", undefined, "'refunds: write'");
  await postError(`/v1/payment_intents/${PI[112]}/confirm`, {}, 403, "invalid_request_error", undefined, "'payment_intents: write'");
  await postError(`/v1/invoices/${IN[400]}/finalize`, {}, 403, "invalid_request_error", undefined, "'invoices: write'");
  await postError("/v1/subscriptions", { customer: cus(1), items: [{ price: PRICE[54] }] }, 403, "invalid_request_error", undefined, "'subscriptions: write'");
  await postError("/v1/products", { name: "x" }, 403, "invalid_request_error", undefined, "'products: write'");
  await mcpInit();
  await mcpError("create_customer", { name: "x" }, "tool.PERMISSION_DENIED");
  const context = await mcp("stripe.dashboard.context", {});
  assert.equal(context.permissions.customers, "read", "the dashboard context reports the restricted key's levels");
  assert.equal(context.permissions.refunds, "read");
  assert.equal((await get("/v1/customers?limit=100")).json.data.length, 12, "nothing was written");
}

// ---------------------------------------------------------------------------------------------
// Drill: no-permissions (noperm-key, baseline)
// ---------------------------------------------------------------------------------------------

async function noPermissions() {
  for (const entry of CALLS) await callError(entry, 403, "invalid_request_error", undefined, "does not have the required permissions");
  await mcpInit();
  await mcpError("list_customers", {}, "tool.PERMISSION_DENIED");
  assert.equal((await mcp("stripe.dashboard.context", {})).permissions.customers, "none", "the dashboard context never fails, it reports 'none'");
}

// ---------------------------------------------------------------------------------------------
// Drill: live-mode (live-key, baseline)
// ---------------------------------------------------------------------------------------------

async function liveMode() {
  await notFound("POST", "/v1/payment_methods/pm_card_visa/attach", "No such PaymentMethod: 'pm_card_visa'", { customer: cus(1) });
  await notFound("POST", "/v1/payment_intents", "No such PaymentMethod: 'pm_card_visa'", { amount: 2000, currency: "usd", payment_method: "pm_card_visa", confirm: true });
  const intent = (await post("/v1/payment_intents", { amount: 2000, currency: "usd" })).json;
  assert.equal(intent.livemode, true);
  assert.equal(intent.status, "requires_payment_method");
  await notFound("POST", `/v1/payment_intents/${intent.id}/confirm`, "No such PaymentMethod: 'pm_card_visa'", { payment_method: "pm_card_visa" });
  assert.equal((await get(`/v1/customers/${cus(1)}`)).json.livemode, true, "objects are stamped with the key's mode");
}

// ---------------------------------------------------------------------------------------------
// Drill: denied (auditor, baseline)
// ---------------------------------------------------------------------------------------------

async function denied() {
  const text = "not granted";
  await getError("/v1/balance", 403, "invalid_request_error", undefined, text);
  await getError("/v1/customers", 403, "invalid_request_error", undefined, text);
  await postError("/v1/customers", { name: "x" }, 403, "invalid_request_error", undefined, text);
  await mcpInit();
  const result = await rpc("tools/call", { name: "list_customers", arguments: {} });
  assert.ok(result.isError);
  assert.equal(result.structuredContent.status, "denied");
}

// ---------------------------------------------------------------------------------------------
// Drill: rate-limited (owner, rate-limited)
// ---------------------------------------------------------------------------------------------

async function rateLimited() {
  for (const entry of CALLS) {
    const error = await callError(entry, 429, "invalid_request_error", "rate_limit", "rate limit");
    assert.equal(error.doc_url, "https://stripe.com/docs/error-codes/rate-limit");
  }
  await mcpInit();
  const error = (await mcpError("retrieve_balance", {}, "tool.RATE_LIMITED")).error;
  assert.ok(error.message.includes("rate limit"));
}

// ---------------------------------------------------------------------------------------------
// Drill: api-unavailable (owner, api-unavailable)
// ---------------------------------------------------------------------------------------------

async function apiUnavailable() {
  for (const entry of WRITE_CALLS) await callError(entry, 503, "api_error", undefined, "Please retry");
  assert.equal((await get("/v1/customers")).json.data.length, 10, "reads keep working");
  assert.equal((await get("/v1/balance")).json.object, "balance");
  const draft = (await get(`/v1/invoices/${IN[400]}`)).json;
  assert.equal(draft.status, "draft", "nothing was finalized");
  assert.equal((await get(`/v1/invoices/${IN[402]}`)).json.status, "open", "nothing was voided");
  assert.equal((await get(`/v1/subscriptions/${SUB[602]}`)).json.status, "trialing", "nothing was canceled");
  assert.equal((await get(`/v1/customers/${cus(1)}`)).json.description, "Repeat customer since spring 2026", "nothing was updated");
}

// ---------------------------------------------------------------------------------------------
// Drill: refund-committed-lost (owner, refund-committed-lost)
// ---------------------------------------------------------------------------------------------

async function refundCommittedLost() {
  const body = { payment_intent: PI[106], amount: 10000, reason: "requested_by_customer" };
  await postError("/v1/refunds", body, 503, "api_error", undefined, "Please retry", { headers: { "idempotency-key": "lost-refund-1" } });
  assert.equal((await get(`/v1/refunds?payment_intent=${PI[106]}`)).json.data.length, 1, "the refund committed although the caller saw 503");
  assert.equal((await get(`/v1/charges/${CH[206]}`)).json.amount_refunded, 10000);
  await postError("/v1/refunds", body, 503, "api_error", undefined, "Please retry", { headers: { "idempotency-key": "lost-refund-1" } });
  assert.equal((await get(`/v1/refunds?payment_intent=${PI[106]}`)).json.data.length, 1, "the same Idempotency-Key replays the original 503 without a second refund");
  await postError("/v1/refunds", body, 503, "api_error", undefined, "Please retry", { headers: { "idempotency-key": "lost-refund-2" } });
  assert.equal((await get(`/v1/refunds?payment_intent=${PI[106]}`)).json.data.length, 2, "a new key refunds again: the double-refund trap");
  assert.equal((await get(`/v1/charges/${CH[206]}`)).json.amount_refunded, 20000);
  await postError("/v1/refunds", { payment_intent: PI[106] }, 503, "api_error", undefined, "Please retry", { headers: { "idempotency-key": "lost-refund-3" } });
  const charge = (await get(`/v1/charges/${CH[206]}`)).json;
  assert.equal(charge.refunded, true);
  assert.equal(charge.amount_refunded, 189000);
  await invalidRequest("POST", "/v1/refunds", "charge_already_refunded", "already been refunded", { payment_intent: PI[106], amount: 100 });
  assert.equal((await get(`/v1/refunds?payment_intent=${PI[106]}`)).json.data.length, 3);
  assert.equal((await post("/v1/customers", { name: "Not affected" })).json.object, "customer", "customer creates are not covered by the fault");
}

// ---------------------------------------------------------------------------------------------
// Drill: large-pages (owner, baseline) — pages filled by encoded bytes, never over the 1 MiB response cap
// ---------------------------------------------------------------------------------------------

const MIB = 1048576;

/** GET that measures the encoded body in bytes and asserts 200 below the framework's 1 MiB response cap. */
async function sized(path) {
  const response = await fetch(`${HTTP}${path}`, { headers: { authorization: `Bearer ${HTTP_TOKEN}` } });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  assert.equal(response.status, 200, `GET ${path} -> ${response.status} ${text.slice(0, 300)}`);
  assert.ok(bytes.length < MIB, `GET ${path} answered ${bytes.length} bytes`);
  return { json: JSON.parse(text), bytes: bytes.length };
}

/** Walk a list forward with starting_after and back with ending_before; every object exactly once, same order. */
async function walkBothWays(path) {
  const sep = path.includes("?") ? "&" : "?";
  const forward = [];
  let pages = 0;
  for (let after; ; pages += 1) {
    const page = (await sized(`${path}${after === undefined ? "" : `${sep}starting_after=${after}`}`)).json;
    forward.push(...page.data.map((item) => item.id));
    if (!page.has_more) break;
    assert.ok(page.data.length > 0, `${path}: has_more with an empty page`);
    after = page.data.at(-1).id;
  }
  assert.equal(new Set(forward).size, forward.length, `${path}: an object appeared twice going forward`);
  const backward = [forward.at(-1)];
  for (let before = forward.at(-1); ; ) {
    const page = (await sized(`${path}${sep}ending_before=${before}`)).json;
    backward.unshift(...page.data.map((item) => item.id));
    if (!page.has_more) break;
    before = page.data[0].id;
  }
  assert.deepEqual(backward, forward, `${path}: backward pages must return exactly the forward objects`);
  return { ids: forward, pages: pages + 1 };
}

async function largePages() {
  // Small lists behave as before: count-sized pages.
  const small = (await sized("/v1/customers?limit=5")).json;
  assert.equal(small.data.length, 5);
  assert.equal(small.has_more, true);

  // Twelve customers of about 92 KB of UTF-8 each (CJK name, description and 50 metadata values).
  const created = [];
  for (let index = 0; index < 12; index += 1) {
    const metadata = {};
    for (let key = 0; key < 50; key += 1) metadata[`k${key}`] = "界".repeat(500);
    created.push((await post("/v1/customers", { name: "界".repeat(256), description: "界".repeat(5000), metadata })).json.id);
  }
  const first = await sized("/v1/customers?limit=100");
  assert.equal(first.json.has_more, true, "the byte budget ends the page before 24 customers");
  assert.ok(first.json.data.length < 24 && first.json.data.length > 0);
  for (const path of ["/v1/customers?limit=100", "/v1/customers?limit=11", "/v1/customers?limit=100&expand[]=data.invoice_settings.default_payment_method"]) {
    const { ids, pages } = await walkBothWays(path);
    assert.equal(ids.length, 24, `${path}: every customer once`);
    assert.ok(pages >= 2, `${path}: more than one page`);
    for (const id of created) assert.ok(ids.includes(id));
  }

  // An expanded list: PaymentIntents embedding the large customers.
  for (const customer of created.slice(0, 12)) await post("/v1/payment_intents", { amount: 2000, currency: "usd", customer, payment_method: "pm_card_visa", confirm: true });
  const intents = await walkBothWays("/v1/payment_intents?limit=100&expand[]=data.customer");
  assert.ok(intents.pages >= 2 && intents.ids.length >= 12);

  // Embedded charge.refunds holds the first 10 with has_more and total_count; the rest list through /v1/refunds.
  const intent = (await post("/v1/payment_intents", { amount: 2000, currency: "usd", payment_method: "pm_card_visa", confirm: true })).json;
  for (let index = 0; index < 11; index += 1) await post("/v1/refunds", { payment_intent: intent.id, amount: 100 });
  const charge = (await sized(`/v1/charges/${intent.latest_charge}?expand[]=refunds`)).json;
  assert.equal(charge.refunds.data.length, 10);
  assert.equal(charge.refunds.has_more, true);
  assert.equal(charge.refunds.total_count, 11);
  assert.equal((await walkBothWays(`/v1/refunds?charge=${intent.latest_charge}&limit=4`)).ids.length, 11);

  // 101 prices on one product list completely.
  const product = (await post("/v1/products", { name: "Hundred and one prices" })).json;
  for (let index = 0; index < 101; index += 1) await post("/v1/prices", { product: product.id, unit_amount: 100 + index, currency: "usd" });
  assert.equal((await walkBothWays(`/v1/prices?product=${product.id}&limit=100`)).ids.length, 101);

  // One object that cannot fit a response answers invalid_request_error, and the failed write is discarded.
  const invoice = (await post("/v1/invoices", { customer: created[0], pending_invoice_items_behavior: "exclude" })).json;
  let accepted = 0;
  for (; accepted < 20; accepted += 1) {
    const metadata = {};
    for (let key = 0; key < 50; key += 1) metadata[`k${key}`] = "界".repeat(500);
    const body = { customer: created[0], invoice: invoice.id, amount: 100, currency: "usd", description: "界".repeat(5000), metadata };
    const response = await api("POST", "/v1/invoiceitems", { body, status: accepted < 9 ? 200 : 400 });
    if (response.status === 400) {
      assert.equal(response.json.error.type, "invalid_request_error");
      assert.ok(response.json.error.message.includes("too large to return in one response"), JSON.stringify(response.json));
      break;
    }
  }
  assert.equal(accepted, 9, "the tenth 92 KB line would push the invoice past the object budget");
  assert.equal((await sized(`/v1/invoices/${invoice.id}`)).json.lines.data.length, 9, "the rejected line was not added");
  await invalidRequest("GET", `/v1/invoices/${invoice.id}?expand[]=customer`, "parameter_invalid", "too large to return in one response");
  await invalidRequest("GET", "/v1/invoices?limit=100&expand[]=data.customer", "parameter_invalid", "too large to return in one response");
}

// ---------------------------------------------------------------------------------------------

const flows = {
  "rest-flow": restFlow,
  "mcp-aliases": mcpAliases,
  "restricted-key": restrictedKey,
  "no-permissions": noPermissions,
  "live-mode": liveMode,
  denied,
  "rate-limited": rateLimited,
  "api-unavailable": apiUnavailable,
  "refund-committed-lost": refundCommittedLost,
  "large-pages": largePages,
};
const selected = Object.keys(flows).find((name) => instruction.includes(`the ${name} conformance flow`));
if (selected === undefined) throw new Error(`Unknown drill instruction: ${instruction}`);
await flows[selected]();
process.stdout.write(JSON.stringify({ completed: true, flow: selected }));
