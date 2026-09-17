// Fault flows: rate limiting, payout partner outage, lost processing response, and the scan bound.
import { A, B, P, R, api, assert, fails, flow } from "./harness.mjs";

flow("rate-limited", async () => {
  await fails("GET", "/v1/recipients", 429, "rate_limit_exceeded");
  await fails("GET", "/v1/batches?status=open", 429, "rate_limit_exceeded");
  await fails("GET", `/v1/batches/${B(1)}/payments`, 429, "rate_limit_exceeded");
  assert.equal((await api("GET", `/v1/recipients/${R(1)}`)).recipient.id, R(1), "retrieves are not rate limited");
});

flow("partner-outage", async () => {
  await fails("POST", `/v1/recipients/${R(10)}/accounts`, 500, "partner_integration_error", { body: { type: "paypal", emailAddress: "harper.lin.payouts@example.com" } });
  assert.equal((await api("GET", `/v1/recipients/${R(10)}`)).recipient.accounts.length, 0, "no account was created");
  await fails("POST", `/v1/batches/${B(2)}/generate-quote`, 500, "partner_integration_error");
  assert.equal((await api("GET", `/v1/batches/${B(2)}`)).batch.quoteExpiredAt, "2026-09-15T12:30:00.000Z");
});

flow("response-lost", async () => {
  await fails("POST", `/v1/batches/${B(1)}/start-processing`, 500, "internal_server_error");
  // The response was lost, but the payout happened: check before retrying.
  const batch = (await api("GET", `/v1/batches/${B(1)}`)).batch;
  assert.equal(batch.status, "complete");
  const balances = await api("GET", "/v1/balances");
  assert.equal(balances.balances[0].amount, "17179.55");
  // A careless retry is refused because the batch is no longer open; nothing is paid twice.
  const retry = await api("POST", `/v1/batches/${B(1)}/start-processing`, { status: RETRY_STATUS });
  assert.equal(retry.ok, false);
  assert.equal((await api("GET", "/v1/balances")).balances[0].amount, "17179.55");
});

const RETRY_STATUS = 409;

flow("tight-limits", async () => {
  const bound = (method, path, body) => fails(method, path, 500, "internal_server_error", { body });
  await bound("POST", "/v1/recipients", { type: "individual", email: "bound.probe@example.com", firstName: "Bound", lastName: "Probe" });
  await bound("GET", `/v1/recipients/${R(3)}`);
  await bound("PATCH", `/v1/recipients/${R(1)}`, { email: "maya.c@example.com" });
  await bound("DELETE", `/v1/recipients/${R(2)}`);
  await bound("GET", "/v1/recipients");
  await bound("POST", `/v1/recipients/${R(3)}/accounts`, { type: "paypal", emailAddress: "etienne.second@example.com" });
  await bound("GET", `/v1/recipients/${R(3)}/accounts`);
  await bound("PATCH", `/v1/recipients/${R(3)}/accounts/${A(4)}`, { primary: true });
  await bound("DELETE", `/v1/recipients/${R(3)}/accounts/${A(4)}`);
  await bound("POST", "/v1/batches", { payments: [{ recipient: { email: "maya.castellanos@example.com" }, amount: "10.00", currency: "USD" }] });
  await bound("GET", `/v1/batches/${B(1)}`);
  await bound("PATCH", `/v1/batches/${B(1)}`, { description: "bound" });
  await bound("DELETE", `/v1/batches/${B(1)}`);
  await bound("GET", "/v1/batches");
  await bound("POST", `/v1/batches/${B(1)}/generate-quote`);
  await bound("POST", `/v1/batches/${B(1)}/start-processing`);
  await bound("GET", `/v1/batches/${B(1)}/summary`);
  await bound("POST", `/v1/batches/${B(1)}/payments`, { recipient: { id: R(6) }, amount: "5.00", currency: "USD" });
  await bound("GET", `/v1/batches/${B(1)}/payments`);
  await bound("PATCH", `/v1/batches/${B(1)}/payments/${P(1)}`, { externalId: "BOUND-1" });
  await bound("GET", "/v1/balances");
  // Reads that need no scan still work.
  assert.equal((await api("GET", `/v1/recipients/${R(1)}/accounts/${A(1)}`)).account.id, A(1));
});
