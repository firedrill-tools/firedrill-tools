// Scope, tenant, grant, fault and bound flows.
import assert from "node:assert/strict";
import { CALLS, acc, api, get, inv, mcp, op, post, probe, put } from "./lib.mjs";

const ALL = [...CALLS.keys()];
const WRITES = ["contacts.save", "contacts.create", "contacts.update", "invoices.save", "invoices.create", "invoices.update", "invoices.email", "payments.create", "payments.record", "payments.delete"];
const READS = ALL.filter((id) => !WRITES.includes(id));
const BOUNDED = ["accounts.list", "tax-rates.list", "contacts.list", "contacts.get", "contacts.save", "contacts.create", "contacts.update", "invoices.list", "invoices.get", "invoices.save", "invoices.create", "invoices.update", "payments.list", "payments.create"];

export async function noScopes() {
  const refused = await api("GET", "/Invoices", { status: 401 });
  assert.deepEqual([refused.json.Title, refused.json.Detail], ["Unauthorized", "AuthorizationUnsuccessful"]);
  await probe(ALL, { http: 401, code: "UNAUTHORIZED" });
}

export async function otherTenant() {
  await probe(ALL, { http: 403, code: "FORBIDDEN" });
}

export async function readOnly() {
  await probe(READS, { http: 200 });
  await probe(WRITES, { http: 401, code: "UNAUTHORIZED" });
}

export async function contactsOnly() {
  assert.equal((await get("/Contacts")).json.Contacts.length, 11);
  await post("/Contacts", { Name: "Scope Check Ltd" });
  await api("GET", "/Invoices", { status: 401 });
  await api("GET", "/Organisation", { status: 401 });
}

export async function fresh() {
  assert.equal((await get("/Contacts")).json.Contacts.length, 11);
  assert.equal((await get("/Organisation")).json.Organisations[0].ShortCode, "!kW7pQ");
  assert.equal((await mcp("create-contact", { name: "Fresh Install Check" })).ContactStatus, "ACTIVE");
}

export async function noGrants() {
  await api("GET", "/Invoices", { status: 403 });
  await api("PUT", "/Payments", { body: { Invoice: { InvoiceID: inv(8) }, Account: { Code: "090" }, Amount: 1 }, status: 403 });
  await op("contacts.create", { name: "Denied" }, { code: "denied" });
}

export async function rateLimited() {
  const limited = await api("GET", "/Invoices", { status: 429 });
  assert.equal(limited.headers.get("retry-after"), "60");
  assert.equal(limited.headers.get("x-rate-limit-problem"), "minute");
  assert.equal(limited.text, "Rate Limit Exceeded");
  await probe(ALL, { http: 429, code: "RATE_LIMITED" });
}

export async function writeOutage() {
  assert.equal((await get("/Contacts")).json.Contacts.length, 11);
  const refused = await api("PUT", "/Invoices", { body: { Type: "ACCREC", Contact: { ContactID: "c0000000-0000-4000-8000-000000000001" } }, status: 503 });
  assert.equal(refused.headers.get("retry-after"), "30");
  await probe(WRITES, { http: 503, code: "SERVICE_UNAVAILABLE" });
  assert.equal((await get("/Invoices")).json.Invoices.length, 16);
}

export async function paymentResponseLost() {
  const body = { Invoice: { InvoiceID: inv(7) }, Account: { Code: "090" }, Amount: 1667.5 };
  await api("PUT", "/Payments", { body, status: 503, headers: { "idempotency-key": "pay-inv-1007" } });
  const committed = (await get(`/Invoices/${inv(7)}`)).json.Invoices[0];
  assert.deepEqual([committed.Status, committed.AmountDue], ["PAID", 0], "the payment committed although the response was lost");
  const replay = await fetch(`${process.env.FIREDRILL_HTTP_URL}/api.xro/2.0/Payments`, {
    method: "PUT",
    headers: { authorization: `Bearer ${process.env.FIREDRILL_HTTP_TOKEN}`, "content-type": "application/json", "xero-tenant-id": "6d1c2f0e-4b8a-4c3e-9a51-2f7e0b9d4c11", "idempotency-key": "pay-inv-1007" },
    body: JSON.stringify(body),
  });
  await replay.text();
  assert.ok(replay.status === 503 || replay.status === 200, `idempotent replay answered ${replay.status}`);
  await api("PUT", "/Payments", { body, status: 400 });
  assert.equal((await get("/Payments")).json.Payments.length, 7, "neither retry created a second payment");
  await op("payments.record", { invoiceId: inv(8), accountId: acc(1), amount: 331.2 }, { code: "SERVICE_UNAVAILABLE" });
  assert.equal((await get(`/Invoices/${inv(8)}`)).json.Invoices[0].Status, "PAID");
}

export async function tightLimits() {
  assert.equal((await get("/Organisation")).json.Status, "OK");
  const bound = await api("GET", "/Invoices", { status: 500 });
  assert.equal(bound.json.Type, "UnknownErrorException");
  await probe(BOUNDED, { http: 500, code: "STATE_BOUND_EXCEEDED" });
  await put("/Contacts", { Name: "x" }, { status: 500 });
}
