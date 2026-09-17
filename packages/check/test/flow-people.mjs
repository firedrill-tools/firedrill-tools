// Directory writes: a workplace, an employee (SSN reduced to its last four digits), residence and termination updates,
// an earning rate and a pay schedule. Ids are allocated from the shared counter, so the order of successful creates matters.
import { IDS, api, assert, fails, flow } from "./harness.mjs";

const OAKLAND = { line1: "1840 Telegraph Ave", city: "Oakland", state: "CA", postal_code: "94612" };
const BERKELEY = { line1: "2120 Shattuck Ave", line2: "Suite 3", city: "Berkeley", state: "CA", postal_code: "94704", country: "US" };

flow("people-writes", async () => {
  // Workplaces are restricted to the states the synthetic tax table knows.
  await fails("POST", "/workplaces", 400, "validation_error", {
    body: { company: IDS.C_J, name: "Austin Annex", address: { line1: "500 W 2nd St", city: "Austin", state: "TX", postal_code: "78701" } },
    fieldPath: "address.state", message: "State is not supported",
  });
  await fails("POST", "/workplaces", 404, "not_found", { body: { company: "com_notreal", address: OAKLAND }, fieldPath: "company" });

  const workplace = await api("POST", "/workplaces", { status: 201, body: { company: IDS.C_J, name: "Berkeley Annex", address: BERKELEY, metadata: { opened: "2026-09" } } });
  assert.match(workplace.id, /^wrk_[A-Za-z0-9]{20}$/);
  assert.equal(workplace.company, IDS.C_J);
  assert.equal(workplace.active, true, "new workplaces are active");
  assert.equal(workplace.address.line2, "Suite 3");
  assert.equal(workplace.address.country, "US");
  assert.deepEqual(workplace.metadata, { opened: "2026-09" });
  assert.equal(workplace.created_at, "2026-09-15T14:00:00Z", "created_at comes from virtual time");

  // An employee may only be placed in workplaces of their own company.
  await fails("POST", "/employees", 400, "validation_error", {
    body: { company: IDS.C_J, first_name: "Wrong", last_name: "Company", workplaces: [IDS.W4] },
    fieldPath: "workplaces.0", message: "another company",
  });
  await fails("POST", "/employees", 400, "validation_error", {
    body: { company: IDS.C_J, first_name: "Closed", last_name: "Site", workplaces: [IDS.W3] },
    fieldPath: "workplaces.0", message: "not active",
  });
  await fails("POST", "/employees", 400, "validation_error", {
    body: { company: IDS.C_J, first_name: "Too", last_name: "Early", workplaces: [workplace.id], ssn: "000112222" },
    fieldPath: "ssn", message: "nine-digit SSN",
  });
  await fails("POST", "/employees", 400, "validation_error", {
    body: { company: IDS.C_J, first_name: "Ends", last_name: "Later", workplaces: [workplace.id], termination_date: "2026-12-01" },
    fieldPath: "termination_date", message: "updating the employee",
  });

  const created = await api("POST", "/employees", {
    status: 201,
    body: {
      company: IDS.C_J, first_name: "Devon", middle_name: "R.", last_name: "Ashworth", email: "Devon.Ashworth@juniperstreet.example.com",
      dob: "1994-04-18", workplaces: [workplace.id, IDS.W1], primary_workplace: workplace.id, start_date: "2026-09-21",
      payment_method_preference: "manual", ssn: "123456789", w2_electronic_consent_provided: true, metadata: { role: "baker" },
    },
  });
  assert.match(created.id, /^emp_[A-Za-z0-9]{20}$/);
  assert.equal(created.ssn_last_four, "6789", "only the last four SSN digits are stored");
  assert.equal(created.ssn_validation_status, "pending");
  assert.ok(!Object.hasOwn(created, "ssn"), "the SSN itself is never echoed back");
  assert.equal(created.email, "devon.ashworth@juniperstreet.example.com", "e-mail is normalized to lower case");
  assert.equal(created.primary_workplace, workplace.id);
  assert.equal(created.start_date, "2026-09-21");
  assert.equal(created.termination_date, null);
  assert.equal(created.active, true);
  assert.deepEqual(created.onboard, { status: "blocking", blocking_steps: ["residence"], remaining_steps: [] });
  assert.deepEqual(created.bank_accounts, []);
  assert.equal(created.default_net_pay_split, null);

  const withResidence = await api("PATCH", `/employees/${created.id}`, { body: { residence: { line1: "915 Ashby Ave", city: "Berkeley", state: "CA", postal_code: "94710" } } });
  assert.equal(withResidence.residence.city, "Berkeley");
  assert.deepEqual(withResidence.onboard, { status: "completed", blocking_steps: [], remaining_steps: [] });

  await fails("PATCH", `/employees/${created.id}`, 400, "validation_error", { body: { company: IDS.C_H }, fieldPath: "company", message: "cannot be changed" });
  await fails("PATCH", `/employees/${created.id}`, 400, "validation_error", { body: { termination_date: "2026-09-01" }, fieldPath: "termination_date", message: "on or after the start date" });
  await fails("PATCH", "/employees/emp_notreal", 404, "not_found", { body: { first_name: "Nobody" }, fieldPath: "employee" });

  const terminated = await api("PATCH", `/employees/${created.id}`, { body: { termination_date: "2026-10-02", metadata: { role: "baker", exit: "seasonal" } } });
  assert.equal(terminated.termination_date, "2026-10-02");
  assert.equal(terminated.active, true, "still active today, 2026-09-15");
  assert.deepEqual(terminated.metadata, { role: "baker", exit: "seasonal" });

  // Reserved metadata keys. `constructor` and `prototype` reach the handler and fail validation; `__proto__` never does:
  // the framework strips own `__proto__` keys while decoding the JSON body, so the call succeeds with that key absent.
  for (const key of ["constructor", "prototype"]) {
    await fails("PATCH", `/employees/${created.id}`, 400, "validation_error", { body: { metadata: { [key]: "x" } }, fieldPath: "metadata", message: `Invalid key "${key}"` });
  }
  const stripped = await api("PATCH", `/employees/${created.id}`, { raw: '{"metadata":{"__proto__":"x","role":"baker"}}' });
  assert.deepEqual(stripped.metadata, { role: "baker" }, "the framework removed the __proto__ key before the Tool ran");
  assert.equal(Object.hasOwn(Object.prototype, "x"), false, "the shared realm is not poisoned");

  await fails("POST", "/earning_rates", 400, "validation_error", { body: { employee: created.id, amount: "0.00", period: "hourly" }, fieldPath: "amount", message: "greater than 0" });
  await fails("POST", "/earning_rates", 400, "validation_error", { body: { employee: created.id, amount: "27.50", period: "fortnightly" }, fieldPath: "period" });
  const rate = await api("POST", "/earning_rates", { status: 201, body: { employee: created.id, amount: "27.50", period: "hourly", name: "Baker", workweek_hours: 32 } });
  assert.equal(rate.company, IDS.C_J, "the rate inherits the employee's company");
  assert.equal(rate.employee, created.id);
  assert.equal(rate.amount, "27.50");
  assert.equal(rate.workweek_hours, 32);
  assert.equal(rate.active, true);

  const renamed = await api("PATCH", `/earning_rates/${rate.id}`, { body: { name: "Lead baker", active: false } });
  assert.equal(renamed.name, "Lead baker");
  assert.equal(renamed.active, false);
  assert.equal(renamed.amount, "27.50", "the amount is unchanged");
  await fails("PATCH", `/earning_rates/${rate.id}`, 400, "validation_error", { body: { amount: "31.00" }, fieldPath: "amount", message: "cannot be changed" });
  await fails("PATCH", "/earning_rates/rte_notreal", 404, "not_found", { body: { name: "Nobody" }, fieldPath: "earning_rate" });

  await fails("POST", "/pay_schedules", 400, "validation_error", {
    body: { company: IDS.C_H, pay_frequency: "semimonthly", first_payday: "2026-10-20", first_period_end: "2026-10-20", second_payday: 31 },
    fieldPath: "first_payday", message: "semimonthly first payday",
  });
  await fails("POST", "/pay_schedules", 400, "validation_error", {
    body: { company: IDS.C_J, pay_frequency: "weekly", first_payday: "2026-10-02", first_period_end: "2026-10-09" },
    fieldPath: "first_period_end", message: "on or before the first payday",
  });
  const schedule = await api("POST", "/pay_schedules", { body: { company: IDS.C_J, pay_frequency: "weekly", first_payday: "2026-10-02", first_period_end: "2026-09-27", name: "Weekly Fridays" } });
  assert.equal(schedule.company, IDS.C_J);
  assert.equal(schedule.pay_frequency, "weekly");
  assert.equal(schedule.second_payday, null);

  const paydays = await api("GET", `/pay_schedules/${schedule.id}/paydays?start=2026-10-01&end=2026-10-31`);
  assert.deepEqual(paydays.results.map((entry) => entry.payday), ["2026-10-02", "2026-10-09", "2026-10-16", "2026-10-23", "2026-10-30"]);
  assert.equal(paydays.results[0].period_end, "2026-09-27", "the first period ends where the schedule says it does");

  // A create that names a record this key cannot reach is a 404 on the field that named it.
  await fails("POST", "/employees", 404, "not_found", { body: { company: "com_notreal", first_name: "Odalys", last_name: "Serrano", workplaces: [IDS.W1] }, fieldPath: "company" });
  await fails("POST", "/earning_rates", 404, "not_found", { body: { employee: "emp_notreal", amount: "25.00", period: "hourly" }, fieldPath: "employee" });
  await fails("POST", "/pay_schedules", 404, "not_found", { body: { company: "com_notreal", pay_frequency: "weekly", first_payday: "2026-10-02", first_period_end: "2026-09-27" }, fieldPath: "company" });

  const employees = await api("GET", `/employees?company=${IDS.C_J}&limit=100`);
  assert.equal(employees.results.length, 9, "the new employee joins the eight seeded Juniper employees");
  assert.equal(employees.results.filter((row) => row.id === created.id).length, 1);
});
