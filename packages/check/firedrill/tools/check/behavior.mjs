// Synthetic Check payroll partner account (sandbox) for Firedrill. Every operation computes from `context.state`:
// ids come from `meta/counters`, timestamps from virtual time, taxes from the synthetic `meta/tax_table` row.
// Nothing here contacts a payroll provider, bank or tax agency; no money moves and no taxes are filed.
import { route } from "./lib/wire.mjs";
import { companiesGet, companiesList, workplacesCreate, workplacesList } from "./ops/companies.mjs";
import { employeesCreate, employeesGet, employeesList, employeesUpdate } from "./ops/employees.mjs";
import { itemsCreate, itemsDelete, itemsList, itemsUpdate } from "./ops/items.mjs";
import { payrollsApprove, payrollsPreview, payrollsReopen } from "./ops/lifecycle.mjs";
import { payrollsCreate, payrollsDelete, payrollsGet, payrollsList } from "./ops/payrolls.mjs";
import { ratesCreate, ratesList, ratesUpdate, schedulesCreate, schedulesList, schedulesPaydays } from "./ops/rates.mjs";

const operations = {
  "companies.list": companiesList,
  "companies.get": companiesGet,
  "workplaces.list": workplacesList,
  "workplaces.create": workplacesCreate,
  "employees.list": employeesList,
  "employees.get": employeesGet,
  "employees.create": employeesCreate,
  "employees.update": employeesUpdate,
  "earning_rates.list": ratesList,
  "earning_rates.create": ratesCreate,
  "earning_rates.update": ratesUpdate,
  "pay_schedules.list": schedulesList,
  "pay_schedules.create": schedulesCreate,
  "pay_schedules.paydays": schedulesPaydays,
  "payrolls.list": payrollsList,
  "payrolls.create": payrollsCreate,
  "payrolls.get": payrollsGet,
  "payrolls.preview": payrollsPreview,
  "payrolls.approve": payrollsApprove,
  "payrolls.reopen": payrollsReopen,
  "payrolls.delete": payrollsDelete,
  "payroll_items.list": itemsList,
  "payroll_items.create": itemsCreate,
  "payroll_items.update": itemsUpdate,
  "payroll_items.delete": itemsDelete,
};

const PAGE = { limit: "int", cursor: "string", id: "list" };
const http = {
  "list-companies": route({ query: { ...PAGE, active: "bool" } }),
  "get-company": route(),
  "list-workplaces": route({ query: { ...PAGE, company: "string" } }),
  "create-workplace": route({ body: "json" }),
  "list-employees": route({ query: { ...PAGE, company: "string", workplace: "string", active: "bool" } }),
  "get-employee": route(),
  "create-employee": route({ body: "json" }),
  "update-employee": route({ body: "json" }),
  "list-earning-rates": route({ query: { ...PAGE, company: "string", employee: "string", active: "bool" } }),
  "create-earning-rate": route({ body: "json" }),
  "update-earning-rate": route({ body: "json" }),
  "list-pay-schedules": route({ query: { ...PAGE, company: "string" } }),
  "create-pay-schedule": route({ body: "json" }),
  "list-paydays": route({ query: { start: "string", end: "string" } }),
  "list-payrolls": route({
    query: { ...PAGE, company: "string", type: "list", status: "list", approved: "bool", pay_schedule: "string", payday_after: "string", payday_before: "string", is_void: "bool", include_items: "bool" },
  }),
  "create-payroll": route({ query: { include_items: "bool" }, body: "json" }),
  "get-payroll": route({ query: { include_items: "bool" } }),
  "preview-payroll": route({ query: { include_items: "bool", async: "bool" } }),
  "approve-payroll": route({ body: "optional" }),
  "reopen-payroll": route({ body: "optional" }),
  "delete-payroll": route(),
  "list-payroll-items": route({ query: { ...PAGE, payroll: "string", employee: "string" } }),
  "create-payroll-item": route({ body: "json" }),
  "update-payroll-item": route({ body: "json" }),
  "delete-payroll-item": route(),
};

export default { operations, http };
