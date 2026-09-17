// One payroll from draft to approved and back: preview, item edits that invalidate the preview, the direct-deposit and
// preview-superseded guards, approve, reopen, and an off-cycle payroll created with inline items and then deleted.
import { IDS, api, assert, cents, fails, flow, money } from "./harness.mjs";

// The synthetic flat rates published in the README, recomputed here so the totals are checked, not echoed.
const EMPLOYEE = [["fed_income", 1000, null], ["social_security", 620, null], ["medicare", 145, null], ["state_income", 400, "CA"], ["state_income", 800, "OR"], ["state_income", 500, "NY"]];
const COMPANY = [["social_security", 620, null], ["medicare", 145, null], ["futa", 60, null], ["sui", 340, "CA"], ["sui", 210, "OR"], ["sui", 410, "NY"]];
const half = (amount, bp) => Math.floor((amount * bp * 2 + 10000) / 20000);

/** Recomputes an item's gross, taxes and net from its earnings and the workplace states. */
function itemMoney(item, states, supplemental = false) {
  let gross = 0;
  let tips = 0;
  const byState = new Map();
  for (const earning of item.earnings) {
    const amount = cents(earning.amount);
    gross += amount;
    if (earning.type === "cash_tips") tips += amount;
    const state = states.get(earning.workplace);
    byState.set(state, (byState.get(state) ?? 0) + amount);
  }
  let reimbursements = 0;
  for (const entry of item.reimbursements) reimbursements += cents(entry.amount);
  const sum = (table, force) => table.reduce((total, [id, bp, state]) => {
    if (state !== null && !byState.has(state)) return total;
    const rate = force && id === "fed_income" ? 2200 : bp;
    return total + half(state === null ? gross : byState.get(state), rate);
  }, 0);
  const employee = sum(EMPLOYEE, supplemental);
  return { gross, employee, company: sum(COMPANY, false), net: gross - tips - employee + reimbursements, reimbursements };
}

flow("payroll-run", async () => {
  const states = new Map((await api("GET", "/workplaces?limit=500")).results.map((row) => [row.id, row.address.state]));

  await fails("POST", `/payrolls/${IDS.J3}/approve`, 400, "validation_error", { message: "previewed before approval" });

  const previewed = await api("GET", `/payrolls/${IDS.J3}/preview?include_items=true`);
  assert.equal(previewed.preview.status, "succeeded");
  assert.equal(previewed.status, "draft", "a preview does not approve the payroll");
  assert.equal(previewed.items.length, 6);
  const expected = previewed.items.map((item) => itemMoney(item, states));
  previewed.items.forEach((item, index) => {
    assert.equal(item.net_pay, money(expected[index].net), `net pay of item ${item.id}`);
    assert.equal(item.taxes.filter((line) => line.payer === "employee").reduce((total, line) => total + cents(line.amount), 0), expected[index].employee);
  });
  const totals = (list) => ({
    gross: money(list.reduce((t, m) => t + m.gross, 0)), net: money(list.reduce((t, m) => t + m.net, 0)),
    employeeTaxes: money(list.reduce((t, m) => t + m.employee, 0)), companyTaxes: money(list.reduce((t, m) => t + m.company, 0)),
    cash: money(list.reduce((t, m) => t + m.net + m.employee + m.company, 0)),
  });
  const want = totals(expected);
  assert.equal(previewed.totals.employee_gross, want.gross);
  assert.equal(previewed.totals.employee_net, want.net);
  assert.equal(previewed.totals.employee_taxes, want.employeeTaxes);
  assert.equal(previewed.totals.company_taxes, want.companyTaxes);
  assert.equal(previewed.totals.cash_requirement, want.cash);
  assert.equal(previewed.totals.contractor_gross, "0.00", "contractors are out of scope for this Tool");

  // Adding Priya Raman invalidates the preview; she has no bank account, so direct deposit is refused at approval.
  const added = await api("POST", "/payroll_items", {
    status: 201,
    body: { payroll: IDS.J3, employee: IDS.E8, payment_method: "direct_deposit", earnings: [{ type: "regular", workplace: IDS.W1, earning_rate: IDS.R8, hours: 20 }] },
  });
  assert.equal(added.earnings[0].amount, "420.00", "20 hours at the published 21.00 rate");
  assert.equal(added.net_pay, money(itemMoney(added, states).net));
  assert.equal((await api("GET", `/payrolls/${IDS.J3}`)).preview, null, "changing an item clears the preview");

  await api("GET", `/payrolls/${IDS.J3}/preview`);
  await fails("POST", `/payrolls/${IDS.J3}/approve`, 400, "validation_error", { fieldPath: "items.6.payment_method", message: "no bank account" });
  const manual = await api("PATCH", `/payroll_items/${added.id}`, { body: { payment_method: "manual", paper_check_number: "10428" } });
  assert.equal(manual.payment_method, "manual");
  assert.equal(manual.paper_check_number, "10428");

  const earning = { type: "regular", workplace: IDS.W1, amount: "100.00" };
  await fails("POST", "/payroll_items", 400, "validation_error", { body: { payroll: IDS.J3, employee: IDS.E8, earnings: [earning] }, fieldPath: "employee", message: "already has an item" });
  await fails("POST", "/payroll_items", 400, "validation_error", {
    body: { payroll: IDS.J3, employee: IDS.E5, earnings: [{ type: "regular", workplace: IDS.W1, amount: "100.00", earning_rate: IDS.R5 }] },
    fieldPath: "earnings.0.amount", message: "not both",
  });
  await fails("POST", "/payroll_items", 400, "validation_error", {
    body: { payroll: IDS.J3, employee: IDS.E1, earnings: [{ type: "regular", workplace: IDS.W1, earning_rate: IDS.R12, hours: 8 }] },
    fieldPath: "earnings.0.earning_rate", message: "not active",
  });
  await fails("PATCH", `/payroll_items/${added.id}`, 400, "validation_error", { body: { employee: IDS.E5 }, fieldPath: "employee", message: "cannot be changed" });
  await fails("DELETE", "/payroll_items/itm_notreal", 404, "not_found", { fieldPath: "payroll_item" });

  // An item for an employee who is terminated before payday blocks the preview until it is removed.
  const stale = await api("POST", "/payroll_items", { status: 201, body: { payroll: IDS.J3, employee: IDS.E7, earnings: [{ type: "regular", workplace: IDS.W1, amount: "300.00" }] } });
  await fails("GET", `/payrolls/${IDS.J3}/preview`, 400, "validation_error", { fieldPath: "items.7.employee", message: "not active on payday" });
  await api("DELETE", `/payroll_items/${stale.id}`, { status: 204 });

  const first = await api("GET", `/payrolls/${IDS.J3}/preview`);
  const second = await api("GET", `/payrolls/${IDS.J3}/preview`);
  assert.notEqual(second.preview.started_at, first.preview.started_at, "each preview records a distinct start instant");
  await fails("POST", `/payrolls/${IDS.J3}/approve`, 409, "preview_superseded", { body: { preview_started_at: first.preview.started_at }, message: "Preview the payroll again" });

  assert.deepEqual(await api("POST", `/payrolls/${IDS.J3}/approve`, { body: { preview_started_at: second.preview.started_at } }), {}, "approval answers an empty object");
  const approved = await api("GET", `/payrolls/${IDS.J3}?include_items=true`);
  assert.equal(approved.status, "pending");
  assert.equal(approved.approved_at, "2026-09-15T14:00:00Z");
  assert.equal(approved.reopen_deadline, "2026-09-15T15:00:00Z", "one hour, capped at the approval deadline");
  assert.equal(approved.items[6].status, "pending", "items follow the payroll's derived status");
  assert.equal(approved.totals.employee_gross, money(approved.items.reduce((total, item) => total + itemMoney(item, states).gross, 0)));
  await fails("POST", "/payroll_items", 400, "validation_error", { body: { payroll: IDS.J3, employee: IDS.E5, earnings: [earning] }, message: "while the payroll is a draft" });

  const reopened = await api("POST", `/payrolls/${IDS.J3}/reopen`);
  assert.equal(reopened.status, "draft");
  assert.equal(reopened.preview, null, "reopening drops the preview");
  assert.equal(reopened.approved_at, null);
  assert.equal(reopened.reopen_deadline, null);

  // An off-cycle payroll created with inline items, then deleted; its items go with it.
  const offCycle = await api("POST", "/payrolls?include_items=true", {
    body: {
      company: IDS.C_J, type: "off_cycle", period_start: "2026-09-21", period_end: "2026-09-27", payday: "2026-09-30",
      off_cycle_options: { force_supplemental_withholding: true },
      items: [{ employee: IDS.E1, earnings: [{ type: "bonus", workplace: IDS.W1, amount: "500.00" }] }],
    },
  });
  assert.equal(offCycle.status, "draft");
  assert.equal(offCycle.pay_schedule, null);
  assert.equal(offCycle.approval_deadline, "2026-09-28T21:00:00Z", "two business days before payday at 21:00Z");
  assert.equal(offCycle.items.length, 1);
  assert.equal(offCycle.items[0].net_pay, money(itemMoney(offCycle.items[0], states, true).net), "supplemental withholding raises federal income tax");
  await api("DELETE", `/payrolls/${offCycle.id}`, { status: 204 });
  await fails("GET", `/payrolls/${offCycle.id}`, 404, "not_found", { fieldPath: "payroll" });
  assert.deepEqual((await api("GET", `/payroll_items?payroll=${offCycle.id}`)).results, [], "the inline item was deleted with the payroll");
  await fails("DELETE", `/payrolls/${IDS.J1}`, 400, "validation_error", { message: "Only draft payrolls can be deleted." });
});
