// Access flows: read-only key, another merchant's key, fresh-install actor, actor without grants.
import { A, B, P, R, api, assert, fails, flow } from "./harness.mjs";

const payment = { recipient: { id: R(1) }, amount: "10.00", currency: "USD" };
/** One schema-valid request per write operation (14). */
const WRITES = [
  ["POST", "/v1/recipients", { type: "individual", email: "probe@example.com", firstName: "Pro", lastName: "Be" }],
  ["PATCH", `/v1/recipients/${R(1)}`, { phone: "503-555-0199" }],
  ["DELETE", `/v1/recipients/${R(9)}`],
  ["POST", `/v1/recipients/${R(10)}/accounts`, { type: "paypal", emailAddress: "harper.lin.payouts@example.com" }],
  ["PATCH", `/v1/recipients/${R(3)}/accounts/${A(4)}`, { primary: true }],
  ["DELETE", `/v1/recipients/${R(3)}/accounts/${A(4)}`],
  ["POST", "/v1/batches", { description: "Probe" }],
  ["PATCH", `/v1/batches/${B(1)}`, { description: "Probe" }],
  ["DELETE", `/v1/batches/${B(6)}`],
  ["POST", `/v1/batches/${B(2)}/generate-quote`],
  ["POST", `/v1/batches/${B(1)}/start-processing`],
  ["POST", `/v1/batches/${B(1)}/payments`, payment],
  ["PATCH", `/v1/batches/${B(1)}/payments/${P(1)}`, { memo: "Probe" }],
  ["DELETE", `/v1/batches/${B(1)}/payments/${P(1)}`],
];
/** One request per read operation (10, covering both payments.get and balances.list paths). */
const READS = [
  ["GET", `/v1/recipients/${R(1)}`], ["GET", "/v1/recipients"], ["GET", `/v1/recipients/${R(3)}/accounts`],
  ["GET", `/v1/recipients/${R(3)}/accounts/${A(3)}`], ["GET", `/v1/batches/${B(1)}`], ["GET", "/v1/batches"],
  ["GET", `/v1/batches/${B(1)}/summary`], ["GET", `/v1/batches/${B(1)}/payments`], ["GET", `/v1/batches/${B(1)}/payments/${P(1)}`],
  ["GET", `/v1/payments/${P(1)}`], ["GET", "/v1/balances"], ["GET", "/v1/balances/paymentrails"],
];

flow("read-only", async () => {
  for (const [method, path] of READS) await api(method, path);
  for (const [method, path, body] of WRITES) await fails(method, path, 403, "not_authorized", { body });
  assert.equal((await api("GET", "/v1/batches")).meta.records, 11);
  assert.equal((await api("GET", "/v1/recipients?status=archived")).meta.records, 1);
});

flow("invalid-key", async () => {
  for (const [method, path, body] of [...READS, ...WRITES]) await fails(method, path, 401, "invalid_api_key", { body });
});

flow("fresh-install", async () => {
  assert.equal((await api("GET", "/v1/recipients")).meta.records, 13);
  assert.equal((await api("GET", "/v1/balances")).balances.length, 3);
  const batch = (await api("POST", "/v1/batches", { body: { description: "Fresh install check" } })).batch;
  assert.equal(batch.status, "open");
  assert.equal(batch.amount, "0.00");
  assert.match(batch.id, /^B-[0-9A-Za-z]{22}$/);
});

flow("denied", async () => {
  await fails("GET", "/v1/recipients", 403, "not_authorized");
  await fails("POST", "/v1/batches", 403, "not_authorized", { body: { description: "Denied" } });
  await fails("POST", `/v1/batches/${B(1)}/start-processing`, 403, "not_authorized");
});
