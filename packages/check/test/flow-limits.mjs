// The resource-limit flow: in the `resource-limits` scenario the scan bound is one row and the next eight generated ids
// are already taken, so every operation that scans state or allocates an id answers HTTP 500 `internal_error` instead of
// truncating a page or reusing an id — and none of them commits anything.
import { IDS, api, assert, fails, flow } from "./harness.mjs";

const ADDRESS = { line1: "1840 Telegraph Ave", city: "Oakland", state: "CA", postal_code: "94612" };
const EARNING = { type: "bonus", workplace: IDS.W1, amount: "150.00" };

/** Operations that read more rows than the bound allows. */
const SCANS = [
  ["GET", "/companies", undefined],
  ["GET", "/workplaces", undefined],
  ["GET", "/employees?limit=100", undefined],
  ["GET", "/earning_rates", undefined],
  ["GET", "/pay_schedules", undefined],
  ["GET", "/payrolls", undefined],
  ["GET", `/payrolls/${IDS.J3}`, undefined],
  ["GET", `/payrolls/${IDS.J3}/preview`, undefined],
  ["POST", `/payrolls/${IDS.H1}/reopen`, {}],
  ["DELETE", `/payrolls/${IDS.J4}`, undefined],
  ["GET", "/payroll_items", undefined],
  ["PATCH", `/payroll_items/${IDS.I11}`, { pto_balance_hours: 12 }],
];

/** Operations whose only large read is the id allocation: the next eight candidates are seeded rows, so it gives up. */
const ALLOCATES = [
  ["POST", "/workplaces", { company: IDS.C_J, name: "Temescal kiosk", address: ADDRESS }],
  ["POST", "/employees", { company: IDS.C_J, first_name: "Odalys", last_name: "Serrano", workplaces: [IDS.W1] }],
  ["POST", "/earning_rates", { employee: IDS.E1, amount: "25.00", period: "hourly", name: "Head baker" }],
  ["POST", "/pay_schedules", { company: IDS.C_J, name: "Weekly kiosk", pay_frequency: "weekly", first_payday: "2026-01-16", first_period_end: "2026-01-11" }],
];

/** Creates that scan before they allocate, so they stop at the bound. */
const CREATES_THAT_SCAN = [
  ["POST", "/payrolls", { company: IDS.C_J, type: "off_cycle", period_start: "2026-09-21", period_end: "2026-09-27", payday: "2026-09-30" }],
  ["POST", "/payroll_items", { payroll: IDS.J3, employee: IDS.E8, earnings: [EARNING] }],
];

flow("resource-limits", async () => {
  for (const [method, path, body] of SCANS) {
    const error = await fails(method, path, 500, "internal_error", { body, message: "bound" });
    assert.match(error.message, /supported bound of 1 rows/, `${method} ${path} names the bound it hit`);
    assert.equal(error.input_errors, undefined, "a bound breach is not a field error");
  }
  for (const [method, path, body] of ALLOCATES) {
    await fails(method, path, 500, "internal_error", { body, message: "Could not allocate an id." });
  }
  for (const [method, path, body] of CREATES_THAT_SCAN) {
    await fails(method, path, 500, "internal_error", { body, message: "supported bound of 1 rows" });
  }

  // Single-record reads never scan, so they still answer from state.
  assert.equal((await api("GET", `/companies/${IDS.C_J}`)).id, IDS.C_J);
  assert.equal((await api("GET", `/employees/${IDS.E1}`)).id, IDS.E1);

  // Nothing was written: the refused reopen left the payroll pending and emitted no event, and the refused item
  // create and update left the payroll's items untouched.
  assert.equal((await api("GET", `/employees/${IDS.E8}`)).company, IDS.C_J);
  await fails("GET", `/payrolls/${IDS.H1}`, 500, "internal_error", { message: "bound" });
});
