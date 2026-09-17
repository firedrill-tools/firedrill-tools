// Directory reads: companies, workplaces, employees (paged forward and back), earning rates, pay schedules, paydays,
// payroll items. Nothing is written; the drill asserts the employee and payroll counts are unchanged.
import { IDS, api, assert, fails, follow, flow, operation } from "./harness.mjs";

const ids = (page) => page.results.map((row) => row.id);

flow("directory", async () => {
  const companies = await api("GET", "/companies");
  assert.deepEqual(ids(companies), [IDS.C_H, IDS.C_J], "active companies sorted by legal_name");
  assert.equal(companies.next, null);
  assert.equal(companies.previous, null);
  assert.equal(companies.server_time, "2026-09-15T14:00:00Z", "server_time is the world's virtual time");
  assert.equal(companies.results[1].trade_name, "Juniper Street Bakery");
  assert.equal(companies.results[1].principal_place_of_business, IDS.W1);
  assert.ok(!Object.hasOwn(companies.results[0], "seq"), "stored sort keys never reach the wire");

  const inactive = await api("GET", "/companies?active=false");
  assert.deepEqual(ids(inactive), [IDS.C_Q], "Quillmark is the only inactive company");

  const juniper = await api("GET", `/companies/${IDS.C_J}`);
  assert.equal(juniper.legal_name, "Juniper Street Bakery LLC");
  assert.equal(juniper.pay_frequency, "biweekly");
  assert.equal(juniper.processing_period, "two_day");

  const workplaces = await api("GET", `/workplaces?company=${IDS.C_J}`);
  assert.deepEqual(ids(workplaces), [IDS.W3, IDS.W1, IDS.W2], "workplaces sorted by name");
  assert.equal(workplaces.results[0].active, false, "Emeryville Kitchen is closed");
  assert.equal(workplaces.results[1].address.state, "CA");

  // Three pages of Juniper employees, sorted by last name then first name, then back with `previous`.
  const ordered = [IDS.E2, IDS.E3, IDS.E7, IDS.E6, IDS.E5, IDS.E8, IDS.E1, IDS.E4];
  const first = await api("GET", `/employees?company=${IDS.C_J}&limit=3`);
  assert.deepEqual(ids(first), ordered.slice(0, 3));
  assert.equal(first.previous, null, "the first page has no previous link");
  const second = await api("GET", follow(first.next));
  assert.deepEqual(ids(second), ordered.slice(3, 6));
  const third = await api("GET", follow(second.next));
  assert.deepEqual(ids(third), ordered.slice(6));
  assert.equal(third.next, null, "the last page has no next link");
  const back = await api("GET", follow(third.previous));
  assert.deepEqual(ids(back), ids(second), "`previous` returns the page before the last one");

  const atPortland = await api("GET", `/employees?workplace=${IDS.W2}`);
  assert.deepEqual(ids(atPortland), [IDS.E3, IDS.E6, IDS.E4], "employees assigned to the Portland Café");
  const terminated = await api("GET", `/employees?company=${IDS.C_J}&active=false`);
  assert.deepEqual(ids(terminated), [IDS.E7], "only Łucja Nowak is terminated before today");
  assert.equal(terminated.results[0].termination_date, "2026-08-31");
  assert.equal(terminated.results[0].active, false);
  assert.equal(terminated.results[0].last_name, "Nowak", "non-ASCII names survive the wire");

  // Cursors are bound to their resource and filters, and limits are checked.
  await fails("GET", `/employees?company=${IDS.C_J}&limit=3&cursor=not-a-cursor`, 400, "validation_error", { fieldPath: "cursor" });
  const reused = follow(first.next).replace(`company=${IDS.C_J}`, `company=${IDS.C_H}`);
  await fails("GET", reused, 400, "validation_error", { fieldPath: "cursor", message: "Invalid cursor." });
  await fails("GET", "/employees?limit=0", 400, "validation_error", { fieldPath: "limit" });
  await fails("GET", "/employees?limit=101", 400, "validation_error", { fieldPath: "limit", message: "between 1 and 100" });

  const raman = await api("GET", `/employees/${IDS.E8}`);
  assert.equal(raman.last_name, "Raman");
  assert.equal(raman.ssn_last_four, null);
  assert.deepEqual(raman.onboard, { status: "blocking", blocking_steps: ["residence"], remaining_steps: ["ssn", "payment_method"] });
  assert.deepEqual(raman.bank_accounts, [], "no bank account is recorded for Priya Raman");
  const vega = await api("GET", `/employees/${IDS.E1}`);
  assert.equal(vega.ssn_last_four, "4821", "only the last four SSN digits are ever stored");
  assert.equal(vega.onboard.status, "completed");
  assert.deepEqual(vega.bank_accounts, [`bnk_${IDS.E1.slice(4, 24)}`]);
  await fails("GET", "/employees/emp_notreal", 404, "not_found", { fieldPath: "employee", message: "Employee not found." });

  const rates = await api("GET", `/earning_rates?employee=${IDS.E1}`);
  assert.deepEqual(ids(rates), [IDS.R12, IDS.R1], "both of Marisol Vega's rates, oldest first");
  assert.equal(rates.results[0].active, false);
  assert.equal(rates.results[1].amount, "24.50");
  assert.equal(rates.results[1].period, "hourly");
  const retired = await api("GET", `/earning_rates?company=${IDS.C_J}&active=false`);
  assert.deepEqual(ids(retired), [IDS.R12], "the 2025 baker rate is the only inactive one");

  const schedules = await api("GET", "/pay_schedules");
  assert.deepEqual(ids(schedules), [IDS.S1, IDS.S2]);
  assert.equal(schedules.results[0].pay_frequency, "biweekly");
  assert.equal(schedules.results[1].second_payday, 31);

  const biweekly = await api("GET", `/pay_schedules/${IDS.S1}/paydays?start=2026-09-01&end=2026-12-31`);
  assert.equal(biweekly.next, null, "paydays are not a cursor page");
  assert.deepEqual(biweekly.results.map((entry) => entry.payday).slice(0, 3), ["2026-09-11", "2026-09-25", "2026-10-09"]);
  const period = biweekly.results[1];
  assert.equal(period.period_start, "2026-09-07");
  assert.equal(period.period_end, "2026-09-20");
  assert.equal(period.approval_deadline_datetime, "2026-09-23T21:00:00Z");
  assert.equal(period.impacted_by_weekend_or_holiday, false, "every other Friday never moves");
  const semimonthly = await api("GET", `/pay_schedules/${IDS.S2}/paydays?start=2026-10-01&end=2026-11-30`);
  assert.deepEqual(semimonthly.results.map((entry) => entry.payday), ["2026-10-15", "2026-10-30", "2026-11-13", "2026-11-30"]);
  assert.equal(semimonthly.results[1].impacted_by_weekend_or_holiday, true, "Saturday 2026-10-31 moves to Friday");
  await fails("GET", `/pay_schedules/${IDS.S1}/paydays?start=2026-01-01&end=2027-06-01`, 400, "validation_error", { fieldPath: "end", message: "366 days" });

  const items = await api("GET", `/payroll_items?payroll=${IDS.J3}`);
  assert.deepEqual(ids(items), [IDS.I11, IDS.I12, IDS.I13, IDS.I14, IDS.I15, IDS.I16], "the six items of the open Juniper payroll");
  assert.equal(items.results[0].employee, IDS.E1);
  assert.equal(items.results[0].status, "draft");
  assert.deepEqual(items.results[0].benefits, [], "benefits are out of scope for this Tool");

  // Every listing rejects an out-of-range limit or an unparsable cursor rather than silently clamping it.
  await fails("GET", "/companies?limit=26", 400, "validation_error", { fieldPath: "limit", message: "between 1 and 25" });
  await fails("GET", "/workplaces?limit=501", 400, "validation_error", { fieldPath: "limit", message: "between 1 and 500" });
  await fails("GET", "/earning_rates?cursor=not-a-cursor", 400, "validation_error", { fieldPath: "cursor", message: "Invalid cursor." });
  await fails("GET", "/pay_schedules?limit=26", 400, "validation_error", { fieldPath: "limit", message: "between 1 and 25" });
  await fails("GET", "/payroll_items?limit=501", 400, "validation_error", { fieldPath: "limit", message: "between 1 and 500" });
  await fails("GET", "/pay_schedules/psc_notreal/paydays", 404, "not_found", { fieldPath: "pay_schedule" });

  // The same read through the canonical Firedrill operation endpoint answers with the same values.
  const canonical = await operation("employees.get", { employee: IDS.E1 });
  assert.equal(canonical.status, "ok", JSON.stringify(canonical));
  assert.equal(canonical.value.ssn_last_four, "4821");

  // The canonical endpoint accepts any JSON for the flag fields the HTTP codec would have typed, so the handler
  // is the one that rejects them.
  const typed = await operation("payrolls.get", { payroll: IDS.J3, include_items: "yes" });
  assert.equal(typed.status, "tool_error", JSON.stringify(typed));
  assert.equal(typed.error.code, "tool.VALIDATION_ERROR");
  assert.match(typed.error.message, /include_items/);
});
