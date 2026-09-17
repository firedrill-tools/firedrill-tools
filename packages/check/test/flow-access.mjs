// The five access flows, one per key shape: read-only, company-scoped, malformed, fresh install, and no grants at all.
import { IDS, api, assert, fails, flow } from "./harness.mjs";

/** One schema-valid request per write operation (13). */
const WRITES = [
  ["POST", "/workplaces", {}],
  ["POST", "/employees", {}],
  ["PATCH", `/employees/${IDS.E1}`, {}],
  ["POST", "/earning_rates", {}],
  ["PATCH", `/earning_rates/${IDS.R1}`, {}],
  ["POST", "/pay_schedules", {}],
  ["POST", "/payrolls", {}],
  ["GET", `/payrolls/${IDS.J3}/preview`, undefined],
  ["POST", `/payrolls/${IDS.J3}/approve`, {}],
  ["POST", `/payrolls/${IDS.H1}/reopen`, {}],
  ["DELETE", `/payrolls/${IDS.J3}`, undefined],
  ["POST", "/payroll_items", {}],
  ["PATCH", `/payroll_items/${IDS.I11}`, {}],
  ["DELETE", `/payroll_items/${IDS.I11}`, undefined],
];
/** One request per read operation (11). */
const READS = [
  "/companies", `/companies/${IDS.C_J}`, "/workplaces", "/employees", `/employees/${IDS.E1}`, "/earning_rates",
  "/pay_schedules", `/pay_schedules/${IDS.S1}/paydays`, "/payrolls", `/payrolls/${IDS.J3}`, "/payroll_items",
];

flow("read-only", async () => {
  for (const path of READS) await api("GET", path);
  for (const [method, path, body] of WRITES) await fails(method, path, 403, "permission_denied", { body, message: "does not have permission" });
  const payrolls = await api("GET", "/payrolls?limit=25");
  assert.equal(payrolls.results.length, 7, "a read-only key still sees every payroll");
  assert.equal((await api("GET", `/payrolls/${IDS.J3}`)).preview, null, "the refused preview left no trace");
  assert.equal((await api("GET", `/payroll_items?payroll=${IDS.J3}`)).results.length, 6);
});

flow("company-scope", async () => {
  const companies = await api("GET", "/companies?active=false&limit=25");
  assert.deepEqual(companies.results, [], "the inactive company belongs to another account");
  const visible = await api("GET", "/companies");
  assert.deepEqual(visible.results.map((row) => row.id), [IDS.C_J], "only Juniper Street Bakery is in scope");
  assert.equal((await api("GET", "/employees?limit=100")).results.length, 8);
  assert.equal((await api("GET", "/workplaces")).results.length, 3);
  assert.equal((await api("GET", "/payrolls")).results.length, 4);
  assert.equal((await api("GET", "/payroll_items?limit=500")).results.length, 16, "items of Harborview payrolls are invisible");
  assert.equal((await api("GET", "/earning_rates?limit=500")).results.length, 9);

  // Out-of-scope records behave exactly as if they did not exist.
  await fails("GET", `/payrolls/${IDS.H1}`, 404, "not_found", { fieldPath: "payroll", message: "Payroll not found." });
  await fails("GET", `/companies/${IDS.C_H}`, 404, "not_found", { fieldPath: "company" });
  await fails("GET", `/employees/${IDS.E9}`, 404, "not_found", { fieldPath: "employee" });
  await fails("POST", "/payroll_items", 404, "not_found", {
    body: { payroll: IDS.H3, employee: IDS.E9, earnings: [{ type: "bonus", workplace: IDS.W4, amount: "100.00" }] },
    fieldPath: "payroll",
  });
  await fails("POST", "/workplaces", 404, "not_found", { body: { company: IDS.C_H, address: { line1: "210 Joralemon St", city: "Brooklyn", state: "NY", postal_code: "11201" } }, fieldPath: "company" });
});

flow("bad-key", async () => {
  for (const path of READS) await fails("GET", path, 401, "authentication_error", { message: "Invalid API key." });
  for (const [method, path, body] of WRITES) await fails(method, path, 401, "authentication_error", { body, message: "Invalid API key." });
});

flow("fresh-install", async () => {
  const employees = await api("GET", "/employees?limit=100");
  assert.equal(employees.results.length, 11, "a key with no attributes reaches every seeded company");
  assert.equal((await api("GET", "/companies")).results.length, 2);
  assert.equal((await api("GET", "/payrolls")).results.length, 7);
  const preview = await api("GET", `/payrolls/${IDS.J3}/preview`);
  assert.equal(preview.preview.status, "succeeded");
  assert.equal(preview.preview.started_at, preview.preview.completed_at, "this Tool previews synchronously");
  assert.equal(preview.status, "draft");
});

flow("denied", async () => {
  const error = await fails("GET", "/companies", 403, "permission_denied", { message: "not granted this operation" });
  assert.equal(error.input_errors, undefined, "a framework denial carries no field errors");
});
