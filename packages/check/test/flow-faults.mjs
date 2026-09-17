// The three declared faults, one flow each: `throttled` (429 on the three collection listings), `funding-outage`
// (503 before preview and approve, so nothing commits) and `approval-response-lost` (approve commits, then answers
// 500 — the retry a careless caller makes is refused, and the payroll is already pending).
import { HTTP, IDS, TOKEN, api, assert, fails, flow } from "./harness.mjs";

const J3 = `/payrolls/${IDS.J3}`;

flow("throttled", async () => {
  // Each throttled listing answers Check's error envelope with `type: "throttled"` and a Retry-After header.
  const response = await fetch(`${HTTP}/companies`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(response.status, 429, "the companies listing is throttled");
  assert.equal(response.headers.get("retry-after"), "1", "a throttled answer tells the caller when to retry");
  const body = await response.json();
  assert.equal(body.error.type, "throttled");
  assert.match(body.error.message, /throttled/i);
  assert.equal(body.error.input_errors, undefined, "a throttled answer carries no field errors");

  await fails("GET", "/companies?limit=5", 429, "throttled", { message: "throttled" });
  await fails("GET", "/employees?limit=5", 429, "throttled", { message: "throttled" });
  await fails("GET", `/employees?company=${IDS.C_J}`, 429, "throttled");
  await fails("GET", "/payrolls?limit=5", 429, "throttled");
  await fails("GET", `/payrolls?status=draft&company=${IDS.C_J}`, 429, "throttled");

  // Single-record reads and the other listings are untouched: the fault names three operations, not the whole Tool.
  const payroll = await api("GET", `${J3}?include_items=true`);
  assert.equal(payroll.id, IDS.J3);
  assert.equal(payroll.status, "draft", "a throttled listing changes nothing");
  assert.equal(payroll.preview, null);
  assert.equal(payroll.items.length, 6);
  assert.equal((await api("GET", `/companies/${IDS.C_J}`)).id, IDS.C_J, "companies.get is not throttled");
  assert.equal((await api("GET", `/employees/${IDS.E1}`)).id, IDS.E1, "employees.get is not throttled");
  assert.equal((await api("GET", `/payroll_items?payroll=${IDS.J3}`)).results.length, 6, "payroll_items.list is not throttled");
  assert.equal((await api("GET", "/workplaces")).results.length, 4, "workplaces.list is not throttled");
  assert.ok((await api("GET", "/earning_rates?limit=100")).results.length > 0, "earning_rates.list is not throttled");
  assert.ok((await api("GET", "/pay_schedules")).results.length > 0, "pay_schedules.list is not throttled");
  assert.equal((await api("GET", `${J3}`)).status, "draft", "a second read still answers from the unchanged state");
});

flow("funding-outage", async () => {
  const before = await api("GET", `${J3}?include_items=true`);
  assert.equal(before.status, "draft");
  assert.equal(before.preview, null, "the payroll starts without a preview");
  assert.equal(before.approved_at, null);

  const outage = await fails("GET", `${J3}/preview`, 503, "service_unavailable", { message: "temporarily unavailable" });
  assert.match(outage.message, /funding verification/i, "the outage names what is unavailable");
  assert.equal(outage.input_errors, undefined, "an outage is not a field error");
  await fails("GET", `${J3}/preview?include_items=true`, 503, "service_unavailable");
  await fails("POST", `${J3}/approve`, 503, "service_unavailable", { body: {} });
  await fails("POST", `${J3}/approve`, 503, "service_unavailable", { body: { preview_started_at: "2026-09-15T14:00:00Z" } });

  // The fault runs before the handler, so neither the preview nor the approval left a trace.
  const after = await api("GET", `${J3}?include_items=true`);
  assert.equal(after.preview, null, "the refused preview did not record a calculation");
  assert.equal(after.status, "draft", "the refused approval did not move the payroll");
  assert.equal(after.approved_at, null);
  assert.equal(after.reopen_deadline, null);
  assert.deepEqual(after.items.map((item) => item.status), Array(6).fill("draft"), "items follow the payroll's status");
  assert.deepEqual(after.totals, before.totals, "totals are recomputed from unchanged items");

  // Operations the fault does not name keep working, including the write path around the payroll.
  const item = await api("POST", "/payroll_items", {
    status: 201,
    body: { payroll: IDS.J3, employee: IDS.E8, earnings: [{ type: "bonus", workplace: IDS.W1, amount: "150.00" }] },
  });
  assert.equal(item.payroll, IDS.J3);
  await api("DELETE", `/payroll_items/${item.id}`, { status: 204 });
  assert.equal((await api("GET", "/payrolls?limit=25")).results.length, 7, "payrolls.list is not part of this outage");
  assert.equal((await api("GET", `${J3}`)).status, "draft");
});

flow("approval-lost", async () => {
  const previewed = await api("GET", `${J3}/preview?include_items=true`);
  assert.equal(previewed.preview.status, "succeeded");
  assert.equal(previewed.status, "draft", "a preview does not approve the payroll");
  assert.equal(previewed.items.length, 6);
  const startedAt = previewed.preview.started_at;

  // The approval commits and emits `payroll.approved`, and only then is the response lost.
  const lost = await fails("POST", `${J3}/approve`, 500, "internal_error", { body: { preview_started_at: startedAt } });
  assert.match(lost.message, /internal error/i);
  assert.equal(lost.input_errors, undefined, "a lost response carries no field errors");

  // Reading the payroll is how a careful caller discovers the write landed.
  const committed = await api("GET", `${J3}?include_items=true`);
  assert.equal(committed.status, "pending", "the approval committed before the response was lost");
  assert.equal(committed.approved_at, "2026-09-15T14:00:00Z");
  assert.equal(committed.reopen_deadline, "2026-09-15T15:00:00Z");
  assert.equal(committed.preview.started_at, startedAt, "the preview that was approved is still recorded");
  assert.deepEqual(committed.items.map((item) => item.status), Array(6).fill("pending"));

  // A careless retry is refused by the state machine, not by the fault, and emits no second approval.
  await fails("POST", `${J3}/approve`, 400, "validation_error", { body: { preview_started_at: startedAt }, message: "Only draft payrolls can be approved." });
  await fails("POST", `${J3}/approve`, 400, "validation_error", { body: {}, message: "Only draft payrolls can be approved." });

  const settled = await api("GET", `${J3}`);
  assert.equal(settled.status, "pending", "the retries changed nothing");
  assert.equal(settled.approved_at, "2026-09-15T14:00:00Z");
  assert.equal(settled.totals.cash_requirement, committed.totals.cash_requirement);
  await fails("POST", "/payroll_items", 400, "validation_error", {
    body: { payroll: IDS.J3, employee: IDS.E8, earnings: [{ type: "bonus", workplace: IDS.W1, amount: "150.00" }] },
    message: "while the payroll is a draft",
  });
});
