// Batch lifecycle flow: batches and payments CRUD, summary, quote, processing, terminal-state refusals, balances.
import { B, P, R, api, assert, fails, flow } from "./harness.mjs";

flow("batch-lifecycle", async () => {
  // Declared errors of refused writes (nothing changes).
  await fails("POST", "/v1/batches", 400, "empty_field", { field: "payments[0].recipient", body: { payments: [{ amount: "5.00", currency: "USD" }] } });
  await fails("POST", "/v1/batches", 404, "not_found", { field: "payments[0].recipient", body: { payments: [{ recipient: { id: R(99) }, amount: "5.00", currency: "USD" }] } });
  await fails("POST", "/v1/batches", 400, "invalid_status", { field: "payments[0].recipient", body: { payments: [{ recipient: { id: R(12) }, amount: "5.00", currency: "USD" }] } });
  await fails("PATCH", `/v1/batches/${B(99)}`, 404, "not_found", { body: { description: "x" } });
  await fails("DELETE", `/v1/batches/${B(99)}`, 404, "not_found");
  await fails("POST", `/v1/batches/${B(99)}/generate-quote`, 404, "not_found");
  await fails("GET", `/v1/batches/${B(1)}/payments?status=bogus`, 400, "invalid_field", { field: "status" });
  await fails("PATCH", `/v1/batches/${B(1)}/payments/${P(1)}`, 400, "empty_field", { field: "body", body: {} });
  await fails("PATCH", `/v1/batches/${B(1)}/payments/${P(99)}`, 404, "not_found", { body: { memo: "x" } });
  await fails("DELETE", `/v1/batches/${B(1)}/payments/${P(99)}`, 404, "not_found");
  assert.equal((await api("GET", "/v1/batches")).meta.records, 11);
  const listed = await api("GET", "/v1/batches");
  assert.equal(listed.batches.length, 10);
  assert.deepEqual(listed.meta, { page: 1, pages: 2, records: 11 });
  assert.equal((await api("GET", "/v1/batches?status=open")).meta.records, 6);
  assert.deepEqual((await api("GET", "/v1/batches?search=editors")).batches.map((batch) => batch.id), [B(2)]);
  const byAmount = await api("GET", "/v1/batches?orderBy=amount&sortBy=desc&pageSize=1");
  assert.equal(byAmount.batches[0].id, B(3));
  await fails("GET", "/v1/batches?status=bogus", 400, "invalid_field", { field: "status" });

  const created = (await api("POST", "/v1/batches", {
    body: {
      description: "Freelance fixes", tags: ["adhoc"],
      payments: [
        { recipient: { email: "priya.raman@example.com" }, amount: "25.00", currency: "USD", memo: "Thumbnail" },
        { recipient: { referenceId: "CR-1004" }, amount: "100.00", currency: "GBP", memo: "Captions" },
      ],
    },
  })).batch;
  assert.equal(created.status, "open");
  assert.equal(created.currency, "USD");
  assert.equal(created.totalPayments, 2);
  assert.equal(created.amount, "154.04", "25.00 + (100.00 GBP / 0.781 + 1.00 fee)");
  const reread = (await api("GET", `/v1/batches/${created.id}`)).batch;
  assert.deepEqual([reread.status, reread.amount, reread.totalPayments, reread.description], ["open", "154.04", 2, "Freelance fixes"]);
  assert.equal((await api("GET", "/v1/batches")).meta.records, 12, "the new batch is listed");
  await fails("POST", "/v1/batches", 400, "invalid_field", { field: "currency", body: { currency: "XYZ" } });
  await fails("GET", `/v1/batches/${B(99)}`, 404, "not_found");

  const payments = await api("GET", `/v1/batches/${created.id}/payments`);
  assert.equal(payments.payments.length, 2);
  const [thumb, captions] = payments.payments;
  assert.equal(captions.targetAmount, "100.00");
  assert.equal(captions.targetCurrency, "GBP");
  assert.equal(captions.exchangeRate, "0.781000");
  await fails("POST", `/v1/batches/${created.id}/payments`, 404, "not_found", { field: "recipient", body: { recipient: { id: R(99) }, amount: "5.00", currency: "USD" } });
  await fails("POST", `/v1/batches/${created.id}/payments`, 400, "invalid_status", { field: "recipient", body: { recipient: { id: R(12) }, amount: "5.00", currency: "USD" } });
  await fails("POST", `/v1/batches/${created.id}/payments`, 400, "invalid_field", { field: "amount", body: { recipient: { id: R(1) }, amount: "10.5", currency: "USD" } });
  await fails("POST", `/v1/batches/${created.id}/payments`, 400, "empty_field", { field: "recipient", body: { amount: "10.00", currency: "USD" } });
  const added = (await api("POST", `/v1/batches/${created.id}/payments`, { body: { recipient: { id: R(7) }, amount: "12.00", currency: "USD", externalId: "FIX-3", category: "services" } })).payment;
  assert.equal(added.payoutMethod, "venmo");
  assert.equal(added.recipientFees, "0.75");
  await fails("POST", `/v1/batches/${created.id}/payments`, 400, "invalid_field", { field: "externalId", body: { recipient: { id: R(1) }, amount: "10.00", currency: "USD", externalId: "FIX-3" } });

  const patched = (await api("PATCH", `/v1/batches/${created.id}/payments/${thumb.id}`, { body: { memo: "Thumbnail set", coverFees: true } })).payment;
  assert.equal(patched.memo, "Thumbnail set");
  assert.equal(patched.merchantFees, "1.00");
  await fails("PATCH", `/v1/batches/${created.id}/payments/${thumb.id}`, 400, "invalid_field", { field: "recipient", body: { recipient: { id: R(1) } } });
  assert.equal((await api("GET", `/v1/batches/${created.id}/payments/${thumb.id}`)).payment.memo, "Thumbnail set");
  const direct = (await api("GET", `/v1/payments/${captions.id}`)).payment;
  assert.equal(direct.batch.id, created.id);
  assert.equal(direct.recipient.id, R(4));
  await fails("GET", `/v1/batches/${B(1)}/payments/${captions.id}`, 404, "not_found");
  await fails("GET", `/v1/batches/${B(99)}/payments`, 404, "not_found");
  assert.equal((await api("GET", `/v1/batches/${created.id}/payments?search=captions`)).meta.records, 1);
  assert.deepEqual(await api("DELETE", `/v1/batches/${created.id}/payments/${captions.id}`), { ok: true });
  await fails("GET", `/v1/payments/${captions.id}`, 404, "not_found");
  const updated = (await api("PATCH", `/v1/batches/${created.id}`, { body: { description: "Freelance fixes (September)" } })).batch;
  assert.equal(updated.totalPayments, 2);
  assert.equal(updated.amount, "37.00");
  await fails("PATCH", `/v1/batches/${created.id}`, 400, "invalid_field", { field: "currency", body: { currency: "CAD" } });

  const summary = (await api("GET", `/v1/batches/${B(1)}/summary`)).batchSummary;
  assert.deepEqual(summary.detail.paypal, { count: 1, totalFees: "1.00", merchantFees: "1.00", debitAmount: "441.00", sendingAmount: "440.00", totalWithheld: "0.00" });
  assert.deepEqual(summary.total, { count: 3, totalFees: "2.75", merchantFees: "1.00", debitAmount: "1241.00", sendingAmount: "1240.00", totalWithheld: "0.00" });
  await fails("GET", `/v1/batches/${B(99)}/summary`, 404, "not_found");

  const quoted = (await api("POST", `/v1/batches/${B(2)}/generate-quote`, { raw: "{}", headers: { "content-type": "application/json" } })).batch;
  assert.equal(quoted.quoteExpiredAt, "2026-09-15T15:30:00.000Z");
  const fx = (await api("GET", `/v1/batches/${B(2)}/payments`)).payments;
  assert.deepEqual(fx.map((payment) => [payment.targetCurrency, payment.targetAmount]), [["GBP", "624.02"], ["EUR", "591.89"]]);

  const processed = (await api("POST", `/v1/batches/${B(1)}/start-processing`)).batch;
  assert.equal(processed.status, "complete");
  assert.equal(processed.sentAt, "2026-09-15T14:00:00.000Z");
  const settled = (await api("GET", `/v1/batches/${B(1)}/payments?status=processed`)).payments;
  assert.equal(settled.length, 3);
  const balances = await api("GET", "/v1/balances");
  assert.equal(balances.balances[0].amount, "17179.55");
  assert.equal(balances.serverTime, "2026-09-15T14:00:00.000Z");
  assert.equal((await api("GET", "/v1/balances/paypal")).balances.length, 1);
  await fails("GET", "/v1/balances/venmo", 400, "invalid_field", { field: "kind" });

  await fails("PATCH", `/v1/batches/${B(1)}/payments/${P(1)}`, 400, "invalid_status", { body: { memo: "late" } });
  await fails("DELETE", `/v1/batches/${B(7)}/payments/${P(11)}`, 400, "invalid_status");
  await fails("PATCH", `/v1/batches/${B(7)}`, 400, "invalid_status", { body: { description: "August" } });
  await fails("DELETE", `/v1/batches/${B(1)}`, 400, "invalid_status");
  await fails("POST", `/v1/batches/${B(1)}/generate-quote`, 406, "invalid_status");
  await fails("POST", `/v1/batches/${B(1)}/start-processing`, 409, "invalid_status");
  assert.deepEqual(await api("DELETE", `/v1/batches/${B(6)}`), { ok: true });
  await fails("GET", `/v1/batches/${B(6)}`, 404, "not_found");
});
