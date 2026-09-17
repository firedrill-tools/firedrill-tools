// Payroll lifecycle rules that do not need a full run: preview and approval preconditions, the reopen window, derived
// statuses in list filters, and the payday and duplicate-period checks on create.
import { IDS, api, assert, fails, flow } from "./harness.mjs";

const ids = (page) => page.results.map((row) => row.id);
const JUNIPER_SEPTEMBER = { company: IDS.C_J, period_start: "2026-09-07", period_end: "2026-09-20", payday: "2026-09-25" };

flow("payroll-rules", async () => {
  // The empty off-cycle draft can be neither approved nor previewed.
  await fails("POST", `/payrolls/${IDS.J4}/approve`, 400, "validation_error", { message: "previewed before approval" });
  await fails("GET", `/payrolls/${IDS.J4}/preview`, 400, "validation_error", { message: "at least one item" });
  await fails("GET", `/payrolls/${IDS.J4}/preview?async=true`, 400, "validation_error", { fieldPath: "async", message: "not supported by this Tool" });

  // Harborview's second off-cycle draft was previewed, but its approval deadline passed yesterday.
  const late = await api("GET", `/payrolls/${IDS.H3}`);
  assert.equal(late.status, "draft");
  assert.equal(late.preview.status, "succeeded");
  assert.equal(late.approval_deadline, "2026-09-14T21:00:00Z");
  await fails("POST", `/payrolls/${IDS.H3}/approve`, 400, "validation_error", { message: "approval deadline for this payroll has passed" });

  // H2 was approved and its payday has arrived, so it reads as paid and can no longer be reopened.
  const paid = await api("GET", `/payrolls/${IDS.H2}`);
  assert.equal(paid.status, "paid", "payrolls read as paid from 12:00Z on payday");
  assert.equal(paid.payday, "2026-09-15");
  await fails("POST", `/payrolls/${IDS.H2}/reopen`, 400, "validation_error", { message: "no longer be reopened" });
  await fails("POST", "/payrolls/pay_notreal/reopen", 404, "not_found", { fieldPath: "payroll" });

  // H1 is pending with half an hour left in its reopen window.
  const pending = await api("GET", `/payrolls/${IDS.H1}`);
  assert.equal(pending.status, "pending");
  assert.equal(pending.reopen_deadline, "2026-09-15T14:30:00Z");
  const reopened = await api("POST", `/payrolls/${IDS.H1}/reopen`);
  assert.equal(reopened.status, "draft");
  assert.equal(reopened.approved_at, null);
  assert.equal(reopened.preview, null);
  await fails("POST", `/payrolls/${IDS.H1}/reopen`, 400, "validation_error", { message: "no longer be reopened" });

  const paidPayrolls = await api("GET", "/payrolls?status=paid&limit=25");
  assert.deepEqual(ids(paidPayrolls), [IDS.H2, IDS.J2, IDS.J1], "paid payrolls, newest payday first");
  const drafts = await api("GET", `/payrolls?status=draft&company=${IDS.C_J}`);
  assert.deepEqual(ids(drafts), [IDS.J3, IDS.J4]);
  const september = await api("GET", "/payrolls?payday_after=2026-09-16&payday_before=2026-09-30");
  assert.deepEqual(ids(september), [IDS.H1, IDS.J3, IDS.J4], "payday window, descending");
  const offCycle = await api("GET", "/payrolls?type=off_cycle&approved=true");
  assert.deepEqual(ids(offCycle), [IDS.H2], "the only approved off-cycle payroll");
  const scheduled = await api("GET", `/payrolls?pay_schedule=${IDS.S1}`);
  assert.deepEqual(ids(scheduled), [IDS.J3, IDS.J2, IDS.J1]);
  await fails("GET", "/payrolls?limit=0", 400, "validation_error", { fieldPath: "limit", message: "between 1 and 25" });
  await fails("GET", "/payrolls?status=archived", 400, "validation_error", { fieldPath: "status", message: "not a valid choice" });

  await fails("POST", "/payrolls", 400, "validation_error", {
    body: { company: IDS.C_J, period_start: "2026-08-01", period_end: "2026-08-14", payday: "2026-08-21" },
    fieldPath: "payday", message: "must not be in the past",
  });
  await fails("POST", "/payrolls", 400, "validation_error", {
    body: { company: IDS.C_J, period_start: "2026-09-01", period_end: "2026-09-15", payday: "2026-09-16" },
    fieldPath: "payday", message: "too soon for this processing period",
  });
  await fails("POST", "/payrolls", 400, "validation_error", { body: { ...JUNIPER_SEPTEMBER, period_start: "2026-09-21", period_end: "2026-09-14" }, fieldPath: "period_end", message: "on or after period start" });
  await fails("POST", "/payrolls", 400, "validation_error", { body: JUNIPER_SEPTEMBER, fieldPath: "non_field_errors", message: "already exists for this pay period" });
  await fails("POST", "/payrolls", 400, "validation_error", {
    body: { ...JUNIPER_SEPTEMBER, period_start: "2026-09-21", period_end: "2026-10-04", payday: "2026-10-08", pay_schedule: IDS.S1 },
    fieldPath: "payday", message: "not on this pay schedule",
  });
  await fails("POST", "/payrolls", 400, "validation_error", { body: { ...JUNIPER_SEPTEMBER, company: IDS.C_Q, period_start: "2026-10-01", period_end: "2026-10-31", payday: "2026-10-30" }, message: "Company is not active." });

  // Unknown ids on the payroll routes, and an item of a payroll that is no longer a draft.
  await fails("POST", "/payrolls", 404, "not_found", { body: { ...JUNIPER_SEPTEMBER, company: "com_notreal", period_start: "2026-10-01", period_end: "2026-10-14", payday: "2026-10-16" }, fieldPath: "company" });
  await fails("GET", "/payrolls/pay_notreal/preview", 404, "not_found", { fieldPath: "payroll" });
  await fails("POST", "/payrolls/pay_notreal/approve", 404, "not_found", { body: {}, fieldPath: "payroll" });
  await fails("DELETE", "/payrolls/pay_notreal", 404, "not_found", { fieldPath: "payroll" });
  await fails("PATCH", "/payroll_items/itm_notreal", 404, "not_found", { body: { pto_balance_hours: 4 }, fieldPath: "payroll_item" });
  await fails("DELETE", `/payroll_items/${IDS.I1}`, 400, "validation_error", { message: "while the payroll is a draft" });

  const created = await api("POST", "/payrolls", { body: { company: IDS.C_J, period_start: "2026-09-21", period_end: "2026-10-04", payday: "2026-10-09", pay_schedule: IDS.S1, metadata: { note: "next period" } } });
  assert.equal(created.status, "draft");
  assert.equal(created.type, "regular");
  assert.equal(created.pay_schedule, IDS.S1);
  assert.equal(created.pay_frequency, "biweekly", "inherited from the company");
  assert.equal(created.approval_deadline, "2026-10-07T21:00:00Z");
  assert.equal(created.preview, null);
  assert.equal(created.is_void, false);
  assert.deepEqual(created.totals.employee_gross, "0.00", "a payroll without items has zero totals");
  assert.deepEqual(created.metadata, { note: "next period" });
});
