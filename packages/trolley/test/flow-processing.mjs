// Processing rules flow: expired quote, insufficient funds, route minimum, empty batch, per-payment failures.
import { B, api, assert, fails, flow } from "./harness.mjs";

const balance = async () => (await api("GET", "/v1/balances/paymentrails")).balances.find((row) => row.currency === "USD").amount;

flow("processing-rules", async () => {
  await fails("POST", `/v1/batches/${B(2)}/start-processing`, 400, "expired_quote");
  assert.equal((await api("GET", `/v1/batches/${B(2)}`)).batch.status, "open", "a refused call changes nothing");
  await api("POST", `/v1/batches/${B(2)}/generate-quote`);
  assert.equal((await api("POST", `/v1/batches/${B(2)}/start-processing`)).batch.status, "complete");
  assert.equal(await balance(), "16970.55");

  await fails("POST", `/v1/batches/${B(3)}/start-processing`, 400, "non_sufficient_funds");
  assert.equal(await balance(), "16970.55");
  await fails("POST", `/v1/batches/${B(5)}/start-processing`, 400, "invalid_field", { field: "amount" });
  await fails("POST", `/v1/batches/${B(6)}/start-processing`, 409, "invalid_status");
  await fails("POST", `/v1/batches/${B(99)}/start-processing`, 404, "not_found");

  const mixed = (await api("POST", `/v1/batches/${B(4)}/start-processing`)).batch;
  assert.equal(mixed.status, "complete");
  const results = (await api("GET", `/v1/batches/${B(4)}/payments`)).payments;
  assert.deepEqual(results.map((payment) => [payment.status, payment.failureMessage]), [["processed", null], ["failed", "Recipient is not active"]]);
  assert.equal(await balance(), "16820.55");

  // A recipient that becomes incomplete after the payment was added: the payment fails and the batch fails.
  const kai = (await api("POST", "/v1/recipients", {
    body: {
      type: "individual", email: "kai.moreno@example.com", firstName: "Kai", lastName: "Moreno",
      address: { street1: "12 Ocean Ave", city: "San Diego", region: "CA", postalCode: "92101", country: "US" },
      accounts: [{ type: "venmo", phoneNumber: "619-555-0142" }],
    },
  })).recipient;
  assert.equal(kai.status, "active");
  const batch = (await api("POST", "/v1/batches", { body: { description: "Kai one-off", payments: [{ recipient: { id: kai.id }, amount: "40.00", currency: "USD" }] } })).batch;
  const incomplete = (await api("PATCH", `/v1/recipients/${kai.id}`, { body: { address: { street1: "" } } })).recipient;
  assert.equal(incomplete.status, "incomplete");
  const failed = (await api("POST", `/v1/batches/${batch.id}/start-processing`)).batch;
  assert.equal(failed.status, "failed");
  assert.equal(failed.completedAt, "2026-09-15T14:00:00.000Z");
  assert.equal(await balance(), "16820.55", "failed payments debit nothing");
});
