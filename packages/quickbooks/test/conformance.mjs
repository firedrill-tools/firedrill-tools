// QuickBooks Online Tool conformance target. A scripted Tool test, not a model-driven agent.
// Node built-ins only: fetch against the QuickBooks-shaped /v3/company/{realmId} routes and raw MCP JSON-RPC
// (Streamable HTTP) for the MCP tool-name aliases. Every flow fails loudly on an unexpected status or body.
import assert from "node:assert/strict";

let task = "";
for await (const chunk of process.stdin) task += chunk;
const instruction = String(JSON.parse(task).instruction ?? "");

const HTTP = process.env.FIREDRILL_HTTP_URL;
const HTTP_TOKEN = process.env.FIREDRILL_HTTP_TOKEN;
const MCP = process.env.FIREDRILL_MCP_URL;
const MCP_TOKEN = process.env.FIREDRILL_MCP_TOKEN;
assert.ok(HTTP && HTTP_TOKEN && MCP && MCP_TOKEN, "HTTP and MCP bindings are required");

const REALM = "9341453172839201";
const B = `/v3/company/${REALM}`;
const q = (text) => `${B}/query?query=${encodeURIComponent(text)}&minorversion=75`;
const NOW_TIME = "2026-09-15T02:00:00.000-07:00";

// ---------------------------------------------------------------------------------------------
// Transport helpers
// ---------------------------------------------------------------------------------------------

/** QuickBooks-shaped request; asserts the status and returns { status, json, bytes, headers }. */
async function api(method, path, { body, text, status = 200, contentType } = {}) {
  const headers = { authorization: `Bearer ${HTTP_TOKEN}`, accept: "application/json" };
  let payload;
  if (body !== undefined) {
    headers["content-type"] = contentType ?? "application/json";
    payload = typeof body === "string" ? body : JSON.stringify(body);
  } else if (text !== undefined) {
    headers["content-type"] = "application/text";
    payload = text;
  }
  const response = await fetch(`${HTTP}${path}`, { method, headers, body: payload });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const type = response.headers.get("content-type") ?? "";
  let json;
  if (type.includes("json") && bytes.length > 0) json = JSON.parse(new TextDecoder().decode(bytes));
  const preview = json === undefined ? `${bytes.length} bytes ${type}` : JSON.stringify(json).slice(0, 600);
  assert.equal(response.status, status, `${method} ${path} ${payload === undefined ? "" : String(payload).slice(0, 200)} -> ${response.status} ${preview}`);
  return { status: response.status, json, bytes, headers: response.headers };
}
const get = (path, options) => api("GET", path, options);
const post = (path, body, options) => api("POST", path, { ...options, body });

/** Expect a QuickBooks Fault envelope with the given HTTP status and QuickBooks error code. */
async function fault(method, path, status, code, { body, text, type, detail } = {}) {
  const result = await api(method, path, { body, text, status });
  const envelope = result.json?.Fault;
  assert.ok(envelope && Array.isArray(envelope.Error) && envelope.Error.length === 1, `${method} ${path}: no Fault envelope: ${JSON.stringify(result.json)}`);
  const error = envelope.Error[0];
  assert.equal(error.code, code, `${method} ${path}: ${JSON.stringify(result.json)}`);
  assert.equal(typeof error.Message, "string");
  assert.equal(typeof error.Detail, "string");
  if (type !== undefined) assert.equal(envelope.type, type, JSON.stringify(result.json));
  if (detail !== undefined) assert.ok(error.Detail.includes(detail), `${method} ${path}: Detail ${JSON.stringify(error.Detail)} lacks ${JSON.stringify(detail)}`);
  return result.json;
}

let rpcId = 0;
async function rpc(method, params) {
  const response = await fetch(MCP, {
    method: "POST",
    headers: { authorization: `Bearer ${MCP_TOKEN}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  assert.equal(response.status, 200, `MCP ${method} -> HTTP ${response.status}`);
  const raw = await response.text();
  const type = response.headers.get("content-type") ?? "";
  const messages = type.includes("text/event-stream")
    ? raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5).trim()))
    : [JSON.parse(raw)];
  const reply = messages.find((message) => message.id === rpcId);
  assert.ok(reply, `MCP ${method}: no JSON-RPC reply`);
  if (reply.error) throw new Error(`MCP ${method} failed: ${JSON.stringify(reply.error)}`);
  return reply.result;
}
async function mcpInit() {
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "quickbooks-conformance", version: "0.1.0" } });
}
async function mcp(name, args) {
  const result = await rpc("tools/call", { name, arguments: args });
  assert.ok(!result.isError, `${name} ${JSON.stringify(args).slice(0, 300)}: ${JSON.stringify(result).slice(0, 600)}`);
  return result.structuredContent;
}
async function mcpError(name, args, code) {
  const result = await rpc("tools/call", { name, arguments: args });
  assert.ok(result.isError, `${name} ${JSON.stringify(args).slice(0, 300)} unexpectedly succeeded`);
  const error = result.structuredContent?.error;
  assert.ok(error, `${name}: ${JSON.stringify(result).slice(0, 400)}`);
  assert.equal(error.code, `tool.${code}`, `${name}: ${JSON.stringify(error).slice(0, 400)}`);
  return error;
}

const INVOICE_BODY = { CustomerRef: { value: "58" }, Line: [{ DetailType: "SalesItemLineDetail", Amount: 150, SalesItemLineDetail: { ItemRef: { value: "20" }, Qty: 1 } }] };

/** One representative, schema-valid call per operation (used by the auth, role, fault and bound drills). */
const CALLS = [
  ["company-info.get", ["GET", `${B}/companyinfo/1`]],
  ["query.run", ["GET", q("select * from Customer maxresults 1")]],
  ["customers.get", ["GET", `${B}/customer/58`]],
  ["customers.search", ["mcp", "search_customers", { criteria: [{ field: "DisplayName", value: "Harbor%", operator: "LIKE" }] }]],
  ["customers.post", ["POST", `${B}/customer`, { DisplayName: "Probe Customer" }]],
  ["customers.create", ["mcp", "create_customer", { customer: { DisplayName: "Probe MCP Customer" } }]],
  ["customers.update", ["mcp", "update_customer", { customer: { Id: "67", SyncToken: "0", sparse: true, Notes: "probe" } }]],
  ["customers.delete", ["mcp", "delete_customer", { idOrEntity: "67" }]],
  ["items.get", ["GET", `${B}/item/20`]],
  ["items.search", ["mcp", "search_items", { criteria: { Type: "Service" } }]],
  ["items.post", ["POST", `${B}/item`, { Name: "Probe item", Type: "Service", IncomeAccountRef: { value: "45" } }]],
  ["invoices.get", ["GET", `${B}/invoice/1036`]],
  ["invoices.search", ["mcp", "search_invoices", { criteria: [{ field: "Balance", value: 0, operator: ">" }] }]],
  ["invoices.pdf", ["GET", `${B}/invoice/1046/pdf`]],
  ["invoices.post", ["POST", `${B}/invoice`, INVOICE_BODY]],
  ["invoices.create", ["mcp", "create_invoice", { customer_ref: "58", line_items: [{ item_ref: "20", qty: 1, unit_price: 150 }] }]],
  ["invoices.update", ["mcp", "update_invoice", { invoice_id: "1046", patch: { PrivateNote: "probe" } }]],
  ["invoices.delete", ["mcp", "delete_invoice", { idOrEntity: "1049" }]],
  ["invoices.send", ["POST", `${B}/invoice/1049/send`]],
  ["payments.get", ["GET", `${B}/payment/190`]],
  ["payments.search", ["mcp", "search_payments", { customer_ref: "63" }]],
  ["payments.post", ["POST", `${B}/payment`, { CustomerRef: { value: "61" }, TotalAmt: 10 }]],
  ["payments.create", ["mcp", "create_payment", { customer_ref: "61", total_amt: 10 }]],
  ["accounts.get", ["GET", `${B}/account/84`]],
  ["accounts.search", ["mcp", "search_accounts", { criteria: [{ field: "AccountType", value: "Income" }] }]],
];
const WRITES = new Set(["customers.post", "customers.create", "customers.update", "customers.delete", "items.post", "invoices.post", "invoices.create", "invoices.update", "invoices.delete", "invoices.send", "payments.post", "payments.create"]);
const QBO_CODE = { THROTTLE_EXCEEDED: "3001", SERVICE_UNAVAILABLE: "10000", AUTHENTICATION_FAILED: "3200", AUTHORIZATION_FAILED: "3100", STATE_BOUND_EXCEEDED: "10000" };
const STATUS = { THROTTLE_EXCEEDED: 429, SERVICE_UNAVAILABLE: 503, AUTHENTICATION_FAILED: 401, AUTHORIZATION_FAILED: 403, STATE_BOUND_EXCEEDED: 500 };

/** Run a CALLS entry expecting the declared error `code`. */
async function callError([, call], code) {
  if (call[0] === "mcp") return mcpError(call[1], call[2], code);
  return fault(call[0], call[1], STATUS[code], QBO_CODE[code], { body: call[2] });
}
async function callOk([, call]) {
  if (call[0] === "mcp") return mcp(call[1], call[2]);
  return api(call[0], call[1], { body: call[2] });
}
const byOp = (id) => CALLS.find(([op]) => op === id);

// ---------------------------------------------------------------------------------------------
// Sweep flows: auth, roles, faults, bounds
// ---------------------------------------------------------------------------------------------

async function invalidAuth() {
  await mcpInit();
  for (const entry of CALLS) await callError(entry, "AUTHENTICATION_FAILED");
  const body = await fault("GET", `${B}/companyinfo/1`, 401, "3200", { type: "AuthenticationFault" });
  assert.equal(body.Fault.Error[0].Message, "message=AuthenticationFailed; errorCode=003200; statusCode=401");
  assert.equal(body.time, NOW_TIME, "declared errors carry the company time");
}

async function reportsOnly() {
  await mcpInit();
  const info = (await get(`${B}/companyinfo/1`)).json;
  assert.equal(info.CompanyInfo.CompanyName, "Brightwater Studio LLC");
  for (const entry of CALLS) if (entry[0] !== "company-info.get") await callError(entry, "AUTHORIZATION_FAILED");
  await fault("POST", `${B}/invoice/1040/send`, 403, "3100", { type: "AuthorizationFault" });
}

async function throttled() {
  await mcpInit();
  for (const entry of CALLS) await callError(entry, "THROTTLE_EXCEEDED");
  const body = await fault("GET", `${B}/invoice/1036`, 429, "3001");
  assert.equal(body.Fault.Error[0].Message, "message=ThrottleExceeded; errorCode=003001; statusCode=429");
  assert.equal(body.Fault.Error[0].Detail, "Throttling limits exceeded.");
  assert.equal(body.time, undefined, "a fault outcome has no handler time");
}

async function writeOutage() {
  await mcpInit();
  for (const entry of CALLS) {
    if (WRITES.has(entry[0])) await callError(entry, "SERVICE_UNAVAILABLE");
    else await callOk(entry);
  }
  const body = await fault("POST", `${B}/customer`, 503, "10000", { body: { DisplayName: "Outage" }, type: "SystemFault" });
  assert.equal(body.Fault.Error[0].Message, "An application error has occurred while processing your request");
  assert.equal((await get(q("select count(*) from Customer"))).json.QueryResponse.totalCount, 13, "nothing was written");
}

async function tightLimits() {
  await mcpInit();
  const unbounded = new Set(["company-info.get", "items.get", "payments.get", "payments.post", "payments.create"]);
  for (const entry of CALLS) {
    if (unbounded.has(entry[0])) {
      if (!WRITES.has(entry[0])) await callOk(entry);
    } else await callError(entry, "STATE_BOUND_EXCEEDED");
  }
  const body = await fault("GET", q("select * from Invoice"), 500, "10000", { type: "SystemFault", detail: "supported bound of 5 rows" });
  assert.equal(body.Fault.Error[0].Message, "An application error has occurred while processing your request");
}

async function denied() {
  await get(`${B}/invoice/1036`, { status: 403 });
  await post(`${B}/payment`, { CustomerRef: { value: "61" }, TotalAmt: 5 }, { status: 403 });
}

async function roles() {
  await mcpInit();
  const created = (await post(`${B}/customer`, { DisplayName: "Clerk Created LLC" })).json.Customer;
  assert.equal(created.Id, "72");
  const invoice = (await post(`${B}/invoice`, { CustomerRef: { value: created.Id }, Line: [{ DetailType: "SalesItemLineDetail", SalesItemLineDetail: { ItemRef: { value: "21" }, Qty: 1 } }] })).json.Invoice;
  assert.equal(invoice.TotalAmt, 1200);
  const payment = (await post(`${B}/payment`, { CustomerRef: { value: created.Id }, TotalAmt: 200, Line: [{ Amount: 200, LinkedTxn: [{ TxnId: invoice.Id, TxnType: "Invoice" }] }] })).json.Payment;
  assert.equal(payment.UnappliedAmt, 0);
  assert.equal((await get(`${B}/invoice/${invoice.Id}`)).json.Invoice.Balance, 1000);
  assert.equal((await get(`${B}/item/20`)).json.Item.Name, "Design consulting");
  await fault("POST", `${B}/item`, 403, "3100", { body: { Name: "Clerk item", Type: "Service", IncomeAccountRef: { value: "45" } }, type: "AuthorizationFault" });
  await fault("GET", `${B}/account/1`, 403, "3100");
  await fault("GET", q("select * from Account"), 403, "3100");
  await mcpError("search_accounts", {}, "AUTHORIZATION_FAILED");
  const embedded = (await get(`${B}/payment/${payment.Id}`)).json.Payment;
  assert.deepEqual(embedded.DepositToAccountRef, { value: "4", name: "Undeposited Funds" }, "embedded account refs stay readable");
}

async function defaultIdentity() {
  const info = (await get(`${B}/companyinfo/1`)).json;
  assert.equal(info.CompanyInfo.CompanyName, "Brightwater Studio LLC");
  assert.equal(info.time, NOW_TIME);
  const created = (await post(`${B}/customer`, { GivenName: "Rae", FamilyName: "Okafor" })).json.Customer;
  assert.equal(created.DisplayName, "Rae Okafor", "DisplayName defaults to the name parts");
  assert.equal(created.MetaData.CreateTime, "2026-09-15T02:00:00-07:00", "fresh worlds use starter virtual time");
}

async function paymentResponseLost() {
  await mcpInit();
  const full = { CustomerRef: { value: "68" }, TotalAmt: 1200, Line: [{ Amount: 1200, LinkedTxn: [{ TxnId: "1043", TxnType: "Invoice" }] }] };
  await fault("POST", `${B}/payment`, 503, "10000", { body: full });
  assert.equal((await get(`${B}/invoice/1043`)).json.Invoice.Balance, 0, "the lost payment committed");
  await fault("POST", `${B}/payment`, 400, "6000", { body: full, detail: "exceeds its open balance" });
  await mcpError("create_payment", { customer_ref: "61", total_amt: 250 }, "SERVICE_UNAVAILABLE");
  await mcpError("create_payment", { customer_ref: "61", total_amt: 250 }, "SERVICE_UNAVAILABLE");
  assert.equal((await get(q("select count(*) from Payment where CustomerRef = '61'"))).json.QueryResponse.totalCount, 3, "the naive retry duplicated the unapplied payment");
}

// ---------------------------------------------------------------------------------------------
// Admin flows: company + query, customers + items
// ---------------------------------------------------------------------------------------------

const rows = async (text, entity) => (await get(q(text))).json.QueryResponse[entity] ?? [];

async function companyQuery() {
  const info = await get(`${B}/companyinfo/1`);
  assert.equal(info.json.CompanyInfo.CompanyName, "Brightwater Studio LLC");
  assert.equal(info.json.time, NOW_TIME, "time is company virtual time");
  assert.ok(info.headers.get("intuit_tid"), "intuit_tid header");
  await fault("GET", `${B}/companyinfo/2`, 400, "610", { type: "ValidationFault" });
  await fault("GET", `/v3/company/123/companyinfo/1`, 403, "3100", { type: "AuthorizationFault" });

  const all = (await get(q("select * from Customer"))).json.QueryResponse;
  assert.equal(all.Customer.length, 13, "inactive customers are hidden by default");
  assert.equal(all.startPosition, 1);
  const pages = [];
  for (const start of [1, 6, 11]) pages.push((await rows(`select * from Customer startposition ${start} maxresults 5`, "Customer")).length);
  assert.deepEqual(pages, [5, 5, 3]);
  assert.deepEqual((await get(q("select * from Customer startposition 16 maxresults 5"))).json.QueryResponse, {});
  assert.equal((await rows("select * from Customer where Active IN (true, false)", "Customer")).length, 14);
  assert.deepEqual((await rows("select * from Customer where DisplayName LIKE 'harbor%'", "Customer")).map((c) => c.Id), ["58", "59"]);
  assert.equal((await rows("select * from Customer where DisplayName = 'O\\'Neill Bakery'", "Customer"))[0].Id, "60");
  assert.equal((await rows("select * from Customer orderby DisplayName desc maxresults 1", "Customer"))[0].DisplayName, "Summit Outfitters");
  const sparse = (await rows("select Id, DisplayName from Customer where Id = '58'", "Customer"))[0];
  assert.equal(sparse.sparse, true);
  assert.equal(sparse.Balance, undefined);
  assert.equal((await get(q("select count(*) from Invoice where Balance > '0'"))).json.QueryResponse.totalCount, 9);
  assert.deepEqual((await rows("select * from Invoice where CustomerRef = '64' and DueDate < '2026-09-15'", "Invoice")).map((i) => i.Id), ["1041", "1044"]);
  assert.equal((await rows("select * from Invoice where Id IN ('1036', '1042')", "Invoice")).length, 2);
  const items = (await api("POST", `${B}/query?minorversion=75`, { text: "select * from Item" })).json.QueryResponse.Item;
  assert.equal(items.length, 7, "POST /query with an application/text body");

  const parse = (text) => fault("GET", q(text), 400, "4000");
  await parse("select * from Customer where Active = true OR Taxable = false");
  await parse("selec * from Invoice");
  await parse("select * from Invoice maxresults 1001");
  await fault("GET", `${B}/query?query=select%20*%20from%20Customer%20where%20DisplayName%20%3D%20'%C3'`, 400, "4000");
  // Malformed percent-encoding arrives as U+FFFD: a correctly encoded U+FFFD (%EF%BF%BD) is rejected too; %ZZ stays literal.
  await fault("GET", `${B}/query?query=select%20*%20from%20Customer%20where%20DisplayName%20like%20'%25Ac%E0%A4%A%25'`, 400, "4000");
  await fault("GET", `${B}/query?query=select%20*%20from%20Customer%20where%20DisplayName%20%3D%20'x%EF%BF%BD'`, 400, "4000");
  await fault("POST", `${B}/query`, 400, "4000", { text: "select * from Customer where DisplayName = 'x\uFFFD'" });
  assert.deepEqual((await get(`${B}/query?query=select%20*%20from%20Customer%20where%20DisplayName%20%3D%20'a%ZZ'`)).json.QueryResponse, {});
  // A malformed escape in a PATH segment never reaches the Tool: the framework refuses the path before routing (documented in
  // README "Compatibility"), so the body is the framework 404 envelope, not a Fault. A well-formed U+FFFD id does reach the handler.
  for (const path of [`${B}/customer/%E0%A4%A`, `${B}/customer/%ZZ`, `${B}/invoice/%E0%A4%A/pdf`, `/v3/company/%E0%A4%A/customer/58`]) {
    const refused = await get(path, { status: 404 });
    assert.equal(refused.json?.code, "framework.HTTP_ROUTE_NOT_FOUND", `${path}: ${JSON.stringify(refused.json)}`);
    assert.equal(refused.json?.Fault, undefined);
  }
  await fault("GET", `${B}/customer/%EF%BF%BD`, 400, "610", { type: "ValidationFault" });
  assert.equal((await rows("select * from Customer where DisplayName like '%café%'", "Customer")).length, 1);
  assert.equal((await rows("select * from Customer where DisplayName like '%漢字🔥%'", "Customer")).length, 0);
  await fault("GET", q("select * from Widget"), 400, "4001");
  await fault("GET", q("select * from Customer where Notes = 'x'"), 400, "4001");
  await fault("GET", q("select * from Customer where Balance LIKE '1%'"), 400, "4001");

  assert.equal((await get(`${B}/account/84`)).json.Account.CurrentBalance, 9805, "A/R equals the open invoice balances");
  assert.equal((await get(`${B}/account/1`)).json.Account.CurrentBalance, 16655);
  assert.equal((await rows("select * from Account", "Account")).length, 9);
  await fault("GET", `${B}/account/999`, 400, "610");
  assert.equal((await get(`${B}/customer/64`)).json.Customer.Balance, 2450);
  await fault("GET", `${B}/customer/abc`, 400, "610");
  await fault("GET", `${B}/customer/99999999999`, 400, "610");
}

async function customersItems() {
  const kelp = { DisplayName: "Kelp Street Bikes", PrimaryEmailAddr: { Address: "ride@kelpstreet.example.com" }, Notes: "Cargo bikes" };
  const created = (await post(`${B}/customer?requestid=kelp-1`, kelp)).json.Customer;
  assert.equal(created.Id, "72");
  assert.equal(created.SyncToken, "0");
  assert.equal((await post(`${B}/customer?requestid=kelp-1`, kelp)).json.Customer.Id, "72", "requestid replay returns the same customer");
  await fault("POST", `${B}/customer`, 400, "6240", { body: { DisplayName: "kelp street bikes" } });
  await fault("POST", `${B}/customer`, 400, "2020", { body: { Notes: "no name" } });
  await fault("POST", `${B}/customer`, 400, "6000", { body: { DisplayName: "Balance Try", Balance: 10 } });
  await fault("POST", `${B}/customer`, 400, "2500", { body: { DisplayName: "Term Try", SalesTermRef: { value: "9" } } });
  const phone = { FreeFormNumber: "(619) 555-0199" };
  assert.equal((await post(`${B}/customer`, { Id: "72", SyncToken: "0", sparse: true, PrimaryPhone: phone })).json.Customer.SyncToken, "1");
  await fault("POST", `${B}/customer`, 400, "5010", { body: { Id: "72", SyncToken: "0", sparse: true, Notes: "stale" } });
  const full = (await post(`${B}/customer`, { Id: "72", SyncToken: "1", DisplayName: "Kelp Street Bikes" })).json.Customer;
  assert.equal(full.Notes, undefined, "a full update clears omitted fields");
  assert.equal(full.PrimaryPhone, undefined);
  assert.equal((await post(`${B}/customer?operation=update`, { Id: "72", SyncToken: "2", sparse: true, Notes: "Back" })).json.Customer.SyncToken, "3");
  await fault("POST", `${B}/customer`, 400, "610", { body: { Id: "999", SyncToken: "0", DisplayName: "Ghost" } });
  await fault("POST", `${B}/customer?operation=update`, 400, "2020", { body: { DisplayName: "No Id" } });
  assert.equal((await post(`${B}/customer`, { Id: "67", SyncToken: "0", sparse: true, Active: false })).json.Customer.Active, false);
  await fault("POST", `${B}/customer`, 400, "6000", { body: { Id: "68", SyncToken: "0", sparse: true, Active: false }, detail: "open balance" });
  assert.equal((await get(`${B}/customer/72`)).json.Customer.Notes, "Back");

  assert.equal((await get(`${B}/item/20`)).json.Item.UnitPrice, 150);
  await fault("GET", `${B}/item/999`, 400, "610");
  const item = { Name: "Color grading", Type: "Service", UnitPrice: 95, IncomeAccountRef: { value: "46" } };
  const grading = (await post(`${B}/item`, item)).json.Item;
  assert.equal(grading.Id, "28");
  assert.equal(grading.IncomeAccountRef.name, "Photography Income");
  await fault("POST", `${B}/item`, 400, "6240", { body: { ...item, Name: "color grading" } });
  await fault("POST", `${B}/item`, 400, "6000", { body: { ...item, Name: "Stock", Type: "Inventory" } });
  await fault("POST", `${B}/item`, 400, "2500", { body: { ...item, Name: "Expense income", IncomeAccountRef: { value: "61" } } });
  await fault("POST", `${B}/item`, 400, "2500", { body: { ...item, Name: "Inactive income", IncomeAccountRef: { value: "48" } } });
  await fault("POST", `${B}/item`, 400, "2020", { body: { Name: "No account", Type: "Service" } });
  assert.equal((await post(`${B}/item`, { Id: "27", SyncToken: "0", sparse: true, Active: false })).json.Item.Active, false);
  await fault("POST", `${B}/item`, 400, "5010", { body: { Id: "27", SyncToken: "0", sparse: true, Active: true } });
  await fault("POST", `${B}/item`, 400, "610", { body: { Id: "999", SyncToken: "0", sparse: true, Active: true } });
  assert.equal((await rows("select * from Item", "Item")).length, 7);
}

// ---------------------------------------------------------------------------------------------
// Admin flows: invoice lifecycle, payments
// ---------------------------------------------------------------------------------------------

const salesLine = (itemId, Qty, extra = {}) => ({ DetailType: "SalesItemLineDetail", ...extra, SalesItemLineDetail: { ItemRef: { value: itemId }, Qty, ...(extra.UnitPrice === undefined ? {} : { UnitPrice: extra.UnitPrice }) } });

async function invoiceLifecycle() {
  const body = { CustomerRef: { value: "58" }, Line: [salesLine("20", 3, { Amount: 450 }), salesLine("25", 2)] };
  const created = (await post(`${B}/invoice`, body)).json.Invoice;
  assert.equal(created.Id, "1050");
  assert.equal(created.DocNumber, "1050");
  assert.equal(created.TxnDate, "2026-09-15");
  assert.equal(created.DueDate, "2026-10-15", "Net 30 from the customer's terms");
  assert.equal(created.TotalAmt, 486);
  assert.equal(created.Balance, 486);
  assert.equal(created.BillEmail.Address, "ap@harborcoffee.example.com");
  assert.equal(created.Line.at(-1).DetailType, "SubTotalLineDetail");
  await fault("POST", `${B}/invoice`, 400, "6140", { body: { ...body, DocNumber: "1042" }, detail: "TxnId=1042" });
  assert.equal((await post(`${B}/invoice?include=allowduplicatedocnum`, { ...body, DocNumber: "1042" })).json.Invoice.Id, "1051");
  await fault("POST", `${B}/invoice`, 400, "2500", { body: { ...body, Line: [salesLine("26", 1)] }, detail: "made inactive" });
  await fault("POST", `${B}/invoice`, 400, "2500", { body: { ...body, CustomerRef: { value: "999" } } });
  await fault("POST", `${B}/invoice`, 400, "6000", { body: { ...body, Line: [] } });
  await fault("POST", `${B}/invoice`, 400, "6000", { body: { ...body, Line: [salesLine("20", 0)] } });
  await fault("POST", `${B}/invoice`, 400, "6000", { body: { ...body, Line: [salesLine("20", 2, { Amount: 100 })] } });
  await fault("POST", `${B}/invoice`, 400, "2020", { body: { Line: body.Line } });
  const updated = (await post(`${B}/invoice`, { Id: "1050", SyncToken: "0", sparse: true, Line: [...body.Line, salesLine("27", 1)] })).json.Invoice;
  assert.equal(updated.SyncToken, "1");
  assert.equal(updated.TotalAmt, 561);
  await fault("POST", `${B}/invoice`, 400, "5010", { body: { Id: "1050", SyncToken: "0", sparse: true, PrivateNote: "stale" } });
  await fault("POST", `${B}/invoice?operation=update`, 400, "610", { body: { Id: "9999", SyncToken: "0", sparse: true } });

  const sent = (await api("POST", `${B}/invoice/1050/send?sendTo=${encodeURIComponent("ap@harbor-coffee.example.com")}`)).json.Invoice;
  assert.equal(sent.EmailStatus, "EmailSent");
  assert.equal(sent.DeliveryInfo.DeliveryTime, "2026-09-15T02:00:00-07:00");
  assert.equal(sent.BillEmail.Address, "ap@harbor-coffee.example.com");
  await fault("POST", `${B}/invoice/1048/send`, 400, "6000", { detail: "Email address is missing" });
  await fault("POST", `${B}/invoice/1048/send?sendTo=a@example.com,b@example.com`, 400, "6000");
  await fault("POST", `${B}/invoice/1048/send?sendTo=a%E0%A4%A@example.com`, 400, "6000");
  await fault("POST", `${B}/invoice/9999/send`, 400, "610");

  const pdf = await get(`${B}/invoice/1046/pdf`);
  assert.equal(pdf.headers.get("content-type"), "application/pdf");
  const text = new TextDecoder("latin1").decode(pdf.bytes);
  assert.ok(text.startsWith("%PDF-1.4"), "a PDF document");
  assert.ok(text.includes("1046"), "the PDF names the invoice");
  await fault("GET", `${B}/invoice/9999/pdf`, 400, "610");

  const partial = (await get(`${B}/invoice/1042`)).json.Invoice;
  assert.deepEqual(partial.LinkedTxn, [{ TxnId: "192", TxnType: "Payment" }]);
  const voided = (await post(`${B}/invoice?operation=void`, { Id: "1042", SyncToken: partial.SyncToken })).json.Invoice;
  assert.equal(voided.TotalAmt, 0);
  assert.equal(voided.Balance, 0);
  assert.equal(voided.PrivateNote, "Voided");
  const unapplied = (await get(`${B}/payment/192`)).json.Payment;
  assert.equal(unapplied.UnappliedAmt, 1500, "the payment stays with its amount, now unapplied");
  await fault("POST", `${B}/invoice?operation=void`, 400, "6000", { body: { Id: "1042", SyncToken: voided.SyncToken } });
  await fault("POST", `${B}/invoice`, 400, "6000", { body: { Id: "1042", SyncToken: voided.SyncToken, sparse: true, PrivateNote: "x" } });
  const gone = (await post(`${B}/invoice?operation=delete`, { Id: "1049", SyncToken: "0" })).json.Invoice;
  assert.deepEqual(gone, { Id: "1049", status: "Deleted", domain: "QBO" });
  await fault("GET", `${B}/invoice/1049`, 400, "610");
}

async function payments() {
  const quartz = { CustomerRef: { value: "64" }, TotalAmt: 1000, Line: [{ Amount: 700, LinkedTxn: [{ TxnId: "1041", TxnType: "Invoice" }] }, { Amount: 300, LinkedTxn: [{ TxnId: "1044", TxnType: "Invoice" }] }] };
  const paid = (await post(`${B}/payment`, quartz)).json.Payment;
  assert.equal(paid.Id, "196");
  assert.equal(paid.UnappliedAmt, 0);
  assert.equal(paid.DepositToAccountRef.name, "Undeposited Funds");
  const i1041 = (await get(`${B}/invoice/1041`)).json.Invoice;
  assert.equal(i1041.Balance, 1100);
  assert.equal(i1041.SyncToken, "1", "a balance change bumps the invoice SyncToken");
  assert.equal((await get(`${B}/invoice/1044`)).json.Invoice.Balance, 350);
  const link = (TxnId, Amount) => ({ Amount, LinkedTxn: [{ TxnId, TxnType: "Invoice" }] });
  await fault("POST", `${B}/payment`, 400, "6000", { body: { CustomerRef: { value: "68" }, TotalAmt: 1500, Line: [link("1043", 1500)] }, detail: "exceeds its open balance" });
  await fault("POST", `${B}/payment`, 400, "6000", { body: { CustomerRef: { value: "64" }, TotalAmt: 100, Line: [link("1043", 100)] }, detail: "another customer" });
  await fault("POST", `${B}/payment`, 400, "6000", { body: { CustomerRef: { value: "64" }, TotalAmt: 100, Line: [link("1041", 200)] } });
  await fault("POST", `${B}/payment`, 400, "2500", { body: { CustomerRef: { value: "64" }, TotalAmt: 10, DepositToAccountRef: { value: "45" } } });
  await fault("POST", `${B}/payment`, 400, "2020", { body: { CustomerRef: { value: "64" } } });
  const loose = (await post(`${B}/payment`, { CustomerRef: { value: "61" }, TotalAmt: 250, PaymentRefNum: "WIRE-2201", DepositToAccountRef: { value: "1" } })).json.Payment;
  assert.equal(loose.Id, "197");
  assert.equal(loose.UnappliedAmt, 250);
  await fault("POST", `${B}/payment`, 400, "5010", { body: { ...quartz, Id: "196", SyncToken: "5" } });
  const moved = (await post(`${B}/payment?operation=update`, { ...quartz, Id: "196", SyncToken: "0", Line: [link("1041", 400), link("1044", 600)] })).json.Payment;
  assert.equal(moved.SyncToken, "1");
  assert.equal((await get(`${B}/invoice/1044`)).json.Invoice.Balance, 50);
  await fault("POST", `${B}/payment`, 400, "610", { body: { ...quartz, Id: "9999", SyncToken: "0" } });
  const voided = (await post(`${B}/payment?operation=void`, { Id: "196", SyncToken: "1" })).json.Payment;
  assert.equal(voided.TotalAmt, 0);
  assert.equal((await get(`${B}/invoice/1041`)).json.Invoice.Balance, 1800, "voiding restores the invoice balance");
  assert.equal((await get(`${B}/invoice/1044`)).json.Invoice.Balance, 650);
  assert.equal((await post(`${B}/payment?operation=delete`, { Id: "197", SyncToken: "0" })).json.Payment.status, "Deleted");
  await fault("GET", `${B}/payment/197`, 400, "610");
  assert.equal((await get(`${B}/payment/192`)).json.Payment.PaymentRefNum, "CHK-4471");
  assert.equal((await get(`${B}/account/4`)).json.Account.CurrentBalance, 2460);
}

// ---------------------------------------------------------------------------------------------
// MCP tool-name aliases
// ---------------------------------------------------------------------------------------------

async function mcpShapes() {
  await mcpInit();
  const listed = new Set((await rpc("tools/list", {})).tools.map((tool) => tool.name));
  for (const name of ["get_company_info", "get_customer", "search_customers", "create_customer", "update_customer", "delete_customer", "read_item", "search_items", "read_invoice", "search_invoices", "create_invoice", "update_invoice", "delete_invoice", "get_invoice_pdf", "get_payment", "search_payments", "create_payment", "get_account", "search_accounts"]) {
    assert.ok(listed.has(name), `tools/list lacks ${name}`);
  }
  assert.equal((await mcp("get_company_info", {})).CompanyInfo.CompanyName, "Brightwater Studio LLC");
  assert.equal((await mcp("get_customer", { id: "64" })).Customer.Balance, 2450);

  const names = (result) => result.results.map((row) => row.DisplayName);
  assert.deepEqual(names(await mcp("search_customers", { criteria: [{ field: "DisplayName", value: "Harbor%", operator: "LIKE" }] })), ["Harbor Coffee Co.", "Harbor Lights Dental"]);
  assert.equal((await mcp("search_customers", { criteria: [{ key: "Active", value: true }] })).results.length, 13);
  assert.equal(names(await mcp("search_customers", { limit: 5, offset: 5, asc: "DisplayName" }))[0], "Juniper Yoga");
  assert.equal((await mcp("search_customers", { count: true })).totalCount, 13);
  await mcpError("search_customers", { criteria: [{ field: "Notes", value: "x" }] }, "QUERY_VALIDATION_ERROR");

  const tide = await mcp("create_customer", { customer: { DisplayName: "Tidepool Apps" } });
  assert.equal(tide.Id, "72");
  await mcpError("create_customer", { customer: { DisplayName: "tidepool apps" } }, "DUPLICATE_NAME");
  await mcpError("create_customer", { customer: {} }, "REQUIRED_PARAM_MISSING");
  await mcpError("create_customer", { customer: { DisplayName: "Term Co", SalesTermRef: { value: "9" } } }, "INVALID_REFERENCE");
  await mcpError("create_customer", { customer: { DisplayName: "Id Co", Id: "5" } }, "BUSINESS_VALIDATION");
  assert.equal((await mcp("update_customer", { customer: { Id: "72", SyncToken: "0", sparse: true, Notes: "MCP" } })).SyncToken, "1");
  await mcpError("update_customer", { customer: { DisplayName: "No Id" } }, "REQUIRED_PARAM_MISSING");
  await mcpError("update_customer", { customer: { Id: "999", SyncToken: "0", sparse: true } }, "OBJECT_NOT_FOUND");
  await mcpError("update_customer", { customer: { Id: "72", SyncToken: "0", sparse: true, Notes: "stale" } }, "STALE_OBJECT");
  await mcpError("update_customer", { customer: { Id: "72", SyncToken: "1", sparse: true, DisplayName: "Harbor Coffee Co." } }, "DUPLICATE_NAME");
  await mcpError("update_customer", { customer: { Id: "72", SyncToken: "1", sparse: true, SalesTermRef: { value: "9" } } }, "INVALID_REFERENCE");
  await mcpError("update_customer", { customer: { Id: "72", SyncToken: "1", sparse: true, Balance: 5 } }, "BUSINESS_VALIDATION");
  assert.equal((await mcp("delete_customer", { idOrEntity: "72" })).Active, false);
  await mcpError("delete_customer", { idOrEntity: "999" }, "OBJECT_NOT_FOUND");
  await mcpError("delete_customer", { idOrEntity: { Id: "67", SyncToken: "9" } }, "STALE_OBJECT");
  await mcpError("delete_customer", { idOrEntity: "68" }, "BUSINESS_VALIDATION");

  assert.equal((await mcp("read_item", { item_id: "21" })).Item.Name, "Brand workshop");
  assert.equal((await mcp("search_items", { criteria: { Type: "Service" } })).results.length, 5);
  await mcpError("search_items", { criteria: [{ field: "Notes", value: "x" }] }, "QUERY_VALIDATION_ERROR");

  const i1039 = (await mcp("read_invoice", { invoice_id: "1039" })).Invoice;
  assert.equal(i1039.Line.length, 7);
  assert.deepEqual(i1039.LinkedTxn, [{ TxnId: "194", TxnType: "Payment" }]);
  const open = await mcp("search_invoices", { criteria: { filters: [{ field: "Balance", value: 0, operator: ">" }], desc: "TxnDate", limit: 3 } });
  assert.deepEqual(open.results.map((row) => row.Id), ["1049", "1048", "1047"]);
  await mcpError("search_invoices", { criteria: [{ field: "Notes", value: "x" }] }, "QUERY_VALIDATION_ERROR");
  const line = [{ item_ref: "20", qty: 3, unit_price: 150 }];
  const made = await mcp("create_invoice", { customer_ref: "58", line_items: line, bill_email: "ap@harborcoffee.example.com" });
  assert.equal(made.Id, "1050");
  assert.equal(made.TotalAmt, 450);
  await mcpError("create_invoice", { customer_ref: "58", line_items: [{ item_ref: "26", qty: 1, unit_price: 500 }] }, "INVALID_REFERENCE");
  await mcpError("create_invoice", { customer_ref: "58", line_items: line, doc_number: "1036" }, "DUPLICATE_DOC_NUMBER");
  await mcpError("create_invoice", { customer_ref: "58", line_items: line, linked_txn: [{ TxnId: "1", TxnType: "Estimate" }] }, "BUSINESS_VALIDATION");
  assert.equal((await mcp("update_invoice", { invoice_id: "1050", patch: { CustomerMemo: { value: "Thanks" } } })).CustomerMemo.value, "Thanks");
  await mcpError("update_invoice", { invoice_id: "9999", patch: {} }, "OBJECT_NOT_FOUND");
  await mcpError("update_invoice", { invoice_id: "1050", patch: { SyncToken: "7" } }, "STALE_OBJECT");
  await mcpError("update_invoice", { invoice_id: "1050", patch: { CustomerRef: { value: "999" } } }, "INVALID_REFERENCE");
  await mcpError("update_invoice", { invoice_id: "1050", patch: { DocNumber: "1036" } }, "DUPLICATE_DOC_NUMBER");
  await mcpError("update_invoice", { invoice_id: "1050", patch: { DueDate: "2020-01-01" } }, "BUSINESS_VALIDATION");
  assert.equal((await mcp("delete_invoice", { idOrEntity: { Id: "1050", SyncToken: "1" } })).status, "Deleted");
  await mcpError("delete_invoice", { idOrEntity: "9999" }, "OBJECT_NOT_FOUND");
  await mcpError("delete_invoice", { idOrEntity: { Id: "1049", SyncToken: "5" } }, "STALE_OBJECT");
  const pdf = await mcp("get_invoice_pdf", { invoice_id: "1046" });
  assert.equal(pdf.content_type, "application/pdf");
  assert.ok(atob(pdf.base64).startsWith("%PDF-1.4"));
  assert.equal(atob(pdf.base64).length, pdf.size_bytes);
  await mcpError("get_invoice_pdf", { invoice_id: "1046", output_path: "/tmp/invoice.pdf" }, "BUSINESS_VALIDATION");
  await mcpError("get_invoice_pdf", { invoice_id: "9999" }, "OBJECT_NOT_FOUND");

  assert.equal((await mcp("get_payment", { id: "192" })).Payment.TotalAmt, 1500);
  assert.deepEqual((await mcp("search_payments", { customer_ref: "63", txn_date_from: "2026-08-01", limit: 10 })).results.map((row) => row.Id), ["191"]);
  await mcpError("search_payments", { txn_date_from: "2026-13-45" }, "QUERY_VALIDATION_ERROR");
  const received = await mcp("create_payment", { customer_ref: "64", total_amt: 100, line: [{ amount: 100, linked_txn: [{ txn_id: "1041", txn_type: "Invoice" }] }] });
  assert.equal(received.UnappliedAmt, 0);
  await mcpError("create_payment", { customer_ref: "64", total_amt: 100, currency_ref: "EUR" }, "BUSINESS_VALIDATION");
  await mcpError("create_payment", { customer_ref: "999", total_amt: 100 }, "INVALID_REFERENCE");
  assert.equal((await mcp("get_account", { id: "1" })).Account.Name, "Checking");
  assert.equal((await mcp("search_accounts", { criteria: [{ field: "AccountType", value: "Income" }] })).results.length, 3);
  await mcpError("search_accounts", { criteria: [{ field: "Notes", value: "x" }] }, "QUERY_VALIDATION_ERROR");
  assert.equal((await get(`${B}/invoice/1041`)).json.Invoice.Balance, 1700, "an MCP payment is visible over REST");
}

/** A maximal invoice (250 lines, 600,000 bytes of CJK descriptions) is readable by GET, PDF and its own query; pages split by bytes. */
async function largeInvoice() {
  await mcpInit();
  const CJK = "\u754c"; // 界, 3 bytes in UTF-8
  const maximal = (chars) => ({
    CustomerRef: { value: "58" },
    PrivateNote: CJK.repeat(4000),
    CustomerMemo: { value: CJK.repeat(1000) },
    Line: Array.from({ length: 250 }, () => salesLine("20", 1, { Description: CJK.repeat(chars) })),
  });
  const first = (await post(`${B}/invoice`, maximal(800))).json.Invoice; // 250 x 2,400 bytes = exactly 600,000
  assert.equal(first.Id, "1050");
  assert.equal(first.Line.length, 251, "250 sales lines plus the subtotal");
  assert.equal((await post(`${B}/invoice`, maximal(800))).json.Invoice.Id, "1051");
  await fault("POST", `${B}/invoice`, 400, "6000", { body: maximal(801), type: "ValidationFault", detail: "600,000 bytes" });
  await fault("POST", `${B}/invoice`, 400, "6000", { body: { Id: "1050", SyncToken: "0", sparse: true, Line: maximal(801).Line }, detail: "600,000 bytes" });
  const items = (chars) => Array.from({ length: 250 }, () => ({ item_ref: "20", qty: 1, unit_price: 1, description: CJK.repeat(chars) }));
  assert.equal((await mcp("create_invoice", { customer_ref: "58", line_items: items(800) })).Id, "1052");
  await mcpError("create_invoice", { customer_ref: "58", line_items: items(801) }, "BUSINESS_VALIDATION");

  const read = await get(`${B}/invoice/1050`);
  assert.ok(read.bytes.length > 600_000 && read.bytes.length < 900_000, `GET is ${read.bytes.length} bytes`);
  assert.equal(read.json.Invoice.Line[249].Description, CJK.repeat(800));
  const pdf = await get(`${B}/invoice/1050/pdf`);
  assert.equal(pdf.headers.get("content-type"), "application/pdf");
  for (const text of ["select * from Invoice where Id = '1050'", "select * from Invoice where Id = '1050' maxresults 1", "select * from Invoice where Id = '1050' startposition 1 maxresults 1000"]) {
    const single = await get(q(text));
    assert.ok(single.bytes.length > 600_000 && single.bytes.length < 900_000, `${text}: ${single.bytes.length} bytes`);
    assert.equal(single.json.QueryResponse.maxResults, 1);
    assert.equal(single.json.QueryResponse.startPosition, 1);
    assert.deepEqual(single.json.QueryResponse.Invoice.map((row) => row.Id), ["1050"]);
  }
  assert.equal((await mcp("read_invoice", { invoice_id: "1050" })).Invoice.Id, "1050");
  assert.deepEqual((await mcp("search_invoices", { criteria: [{ field: "Id", value: "1050" }] })).results.map((row) => row.Id), ["1050"]);

  // Multi-row pages stop by bytes: two maximal invoices never share a page; the small ones fit after the third.
  const total = (await get(q("select count(*) from Invoice"))).json.QueryResponse.totalCount;
  const seen = [];
  let position = 1;
  const pageSizes = [];
  while (true) {
    const page = (await get(q(`select * from Invoice orderby Id desc startposition ${position} maxresults 10`))).json.QueryResponse;
    if (page.Invoice === undefined) break;
    assert.equal(page.startPosition, position);
    assert.equal(page.maxResults, page.Invoice.length, "maxResults counts the rows actually returned");
    pageSizes.push(page.Invoice.length);
    seen.push(...page.Invoice.map((row) => row.Id));
    position += page.maxResults;
  }
  assert.deepEqual(pageSizes.slice(0, 2), [1, 1], `a second maximal invoice never fits the same page: ${JSON.stringify(pageSizes)}`);
  assert.ok(pageSizes[2] > 1, `the third maximal invoice shares its page with the small ones: ${JSON.stringify(pageSizes)}`);
  assert.deepEqual(seen.slice(0, 3), ["1052", "1051", "1050"]);
  assert.equal(new Set(seen).size, seen.length, "every row appears exactly once");
  assert.equal(seen.length, total, "paging by bytes loses nothing");
  const paged = await mcp("search_invoices", { criteria: [{ field: "Id", value: "1049", operator: ">" }, { field: "limit", value: 10 }] });
  assert.equal(paged.results.length, 1, "an MCP search page stops by bytes too");
  await mcpError("search_invoices", { criteria: [{ field: "Id", value: "1049", operator: ">" }, { field: "fetchAll", value: true }] }, "STATE_BOUND_EXCEEDED");
}

/**
 * The description bound counts bytes as returned (JSON-encoded): a newline, quote or backslash is 2 bytes and a control
 * character 6, so escape-heavy text of the same character count must hit the bound sooner — directly and through a
 * description inherited from the item. Every committed row stays readable alone and inside every list page, and the loop
 * the bundled app runs (1,000-row pages until an empty page) loses nothing although every page is cut by bytes.
 * Its own drill (fresh baseline, Ids from 1050): the drill report embeds every body it sees, and these are 600-900 KB each.
 */
async function escapeHeavyInvoices() {
  await mcpInit();
  const before = (await get(q("select count(*) from Invoice"))).json.QueryResponse.totalCount;
  const body = (Line) => ({ CustomerRef: { value: "58" }, Line });
  const direct = (text, lines = 250) => body(Array.from({ length: lines }, () => salesLine("20", 1, { Description: text })));
  // 250 x 1,200 newlines = 300,000 characters but exactly 600,000 encoded bytes; one more newline per line is over.
  const newline = (await post(`${B}/invoice`, direct("\n".repeat(1200)))).json.Invoice;
  assert.equal(newline.Id, "1050");
  assert.equal(newline.Line[249].Description, "\n".repeat(1200));
  await fault("POST", `${B}/invoice`, 400, "6000", { body: direct("\n".repeat(1201)), type: "ValidationFault", detail: "600,000 bytes" });
  // Quotes and backslashes escape to 2 bytes, a control character to 6: 300 x (`"\\` + U+0001) = 300 x 10 = 3,000 bytes; 200 lines = 600,000.
  const mixed = "\"\\".repeat(300);
  assert.equal((await post(`${B}/invoice`, direct(mixed, 200))).json.Invoice.Id, "1051");
  const overMixed = await fault("POST", `${B}/invoice`, 400, "6000", { body: direct(mixed, 201), detail: "600,000 bytes" });
  assert.equal(overMixed.Fault.Error[0].element, "Line[200].Description");
  // Item-inherited descriptions: an item whose Description is 4,000 newlines (8,000 encoded bytes) inherited by 75 lines
  // with no Description of their own is exactly 600,000 bytes; 76 lines is over, named at the line that inherits it.
  const item = (await post(`${B}/item`, { Name: "Newline item", Type: "Service", IncomeAccountRef: { value: "45" }, Description: "\n".repeat(4000) })).json.Item;
  assert.equal(item.Description, "\n".repeat(4000));
  const inherited = (lines) => body(Array.from({ length: lines }, () => salesLine(item.Id, 1)));
  const fromItem = (await post(`${B}/invoice`, inherited(75))).json.Invoice;
  assert.equal(fromItem.Id, "1052");
  assert.equal(fromItem.Line[74].Description, "\n".repeat(4000), "the item description is inherited");
  const over = await fault("POST", `${B}/invoice`, 400, "6000", { body: inherited(76), detail: "inherited from items" });
  assert.equal(over.Fault.Error[0].element, "Line[75].Description");
  await fault("POST", `${B}/invoice`, 400, "6000", { body: inherited(150), detail: "600,000 bytes" });
  await fault("POST", `${B}/invoice`, 400, "6000", { body: { Id: "1050", SyncToken: "0", sparse: true, Line: inherited(76).Line }, detail: "inherited from items" });
  await mcpError("create_invoice", { customer_ref: "58", line_items: Array.from({ length: 76 }, () => ({ item_ref: item.Id, qty: 1, unit_price: 1 })) }, "BUSINESS_VALIDATION");

  // Every committed row is readable — one full read per shape (GET, single-row query, MCP read) and the PDF of each.
  const read = await get(`${B}/invoice/1050`);
  assert.ok(read.bytes.length > 600_000 && read.bytes.length < 900_000, `GET 1050 is ${read.bytes.length} bytes`);
  assert.equal(read.json.Invoice.Line[0].Description, "\n".repeat(1200));
  for (const id of ["1050", "1051", "1052"]) assert.equal((await get(`${B}/invoice/${id}/pdf`)).headers.get("content-type"), "application/pdf");
  const single = (await get(q("select * from Invoice where Id = '1051'"))).json.QueryResponse;
  assert.deepEqual([single.maxResults, single.Invoice.map((row) => row.Id)], [1, ["1051"]]);
  assert.equal(single.Invoice[0].Line[199].Description, mixed);
  assert.equal((await mcp("read_invoice", { invoice_id: "1052" })).Invoice.Line[74].Description, "\n".repeat(4000));
  assert.equal((await get(q("select count(*) from Invoice"))).json.QueryResponse.totalCount, before + 3);
  // Every list page that contains one of them is readable, and paging until an empty page loses nothing even though every
  // page is cut by bytes, not by count: a short page is NOT the last page (the app's old loop stopped at the first one).
  const text = "select * from Invoice where CustomerRef = '58'";
  const expected = (await get(q("select count(*) from Invoice where CustomerRef = '58'"))).json.QueryResponse.totalCount;
  const seen = [];
  const pageSizes = [];
  let position = 1;
  while (true) {
    const page = (await get(q(`${text} startposition ${position} maxresults 1000`))).json.QueryResponse;
    if (page.Invoice === undefined) break;
    assert.equal(page.startPosition, position);
    assert.equal(page.maxResults, page.Invoice.length, "maxResults counts the rows actually returned");
    pageSizes.push(page.maxResults);
    seen.push(...page.Invoice.map((row) => row.Id));
    position += page.maxResults;
  }
  assert.ok(pageSizes.length >= 3 && pageSizes[0] < 1000, `the first page is short and is not the last: ${JSON.stringify(pageSizes)}`);
  assert.equal(new Set(seen).size, seen.length, "every row appears exactly once");
  assert.equal(seen.length, expected, `paging until an empty page loses nothing (${seen.length} of ${expected})`);
  assert.ok(seen.includes("1050") && seen.includes("1051") && seen.includes("1052"), "the three escape-heavy invoices are all seen");
}

// ---------------------------------------------------------------------------------------------

const flows = {
  "company-query": companyQuery,
  "customers-items": customersItems,
  "invoice-lifecycle": invoiceLifecycle,
  payments,
  "mcp-shapes": mcpShapes,
  roles,
  "reports-only": reportsOnly,
  "default-identity": defaultIdentity,
  "invalid-auth": invalidAuth,
  denied,
  throttled,
  "write-outage": writeOutage,
  "payment-response-lost": paymentResponseLost,
  "tight-limits": tightLimits,
  "large-invoice": largeInvoice,
  "escape-heavy-invoices": escapeHeavyInvoices,
};
const selected = Object.keys(flows).find((name) => instruction.includes(`the ${name} conformance flow`));
if (selected === undefined) throw new Error(`Unknown drill instruction: ${instruction}`);
await flows[selected]();
process.stdout.write(JSON.stringify({ completed: true, flow: selected }));
