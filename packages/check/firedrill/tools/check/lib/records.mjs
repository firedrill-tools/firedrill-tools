// Scoped lookups and derived payroll status. Records of companies outside the key's scope behave as if absent.
import { inScope } from "./access.mjs";
import { DAY_MS, nowMs, parseDate, parseStamp } from "./dates.mjs";
import { isId } from "./ids.mjs";
import { notFound } from "./validate.mjs";

const WHAT = { companies: "Company", workplaces: "Workplace", employees: "Employee", earning_rates: "Earning rate", pay_schedules: "Pay schedule", payrolls: "Payroll", payroll_items: "Payroll item" };
export const PREFIX = { companies: "com", workplaces: "wrk", employees: "emp", earning_rates: "rte", pay_schedules: "psc", payrolls: "pay", payroll_items: "itm" };

/** Row of `namespace` with `id` inside the key's scope, or null. Never throws on malformed ids. */
export function findScoped(context, key, namespace, id) {
  if (!isId(PREFIX[namespace], id)) return null;
  const row = context.state.get(namespace, id);
  if (row === null) return null;
  const company = namespace === "companies" ? row.id : companyOf(context, namespace, row);
  return company !== null && inScope(key, company) ? row : null;
}

/** Company id owning a row; payroll items resolve through their payroll. */
export function companyOf(context, namespace, row) {
  if (namespace === "companies") return row.id;
  if (namespace === "payroll_items") {
    const payroll = context.state.get("payrolls", row.payroll);
    return payroll === null ? null : payroll.company;
  }
  return row.company ?? null;
}

export function mustFind(context, key, namespace, id, field) {
  const row = findScoped(context, key, namespace, id);
  if (row === null) notFound(context, field, WHAT[namespace]);
  return row;
}

/** `draft`, `pending`, `processing` (after the approval deadline) or `paid` (from payday 12:00Z), derived from virtual time. */
export function payrollStatus(context, payroll) {
  if (payroll.stored_status === "draft") return "draft";
  const now = nowMs(context);
  const payday = parseDate(payroll.payday);
  if (payday !== null && now >= payday * DAY_MS + 12 * 3600000) return "paid";
  const deadline = parseStamp(payroll.approval_deadline);
  return deadline !== null && now > deadline ? "processing" : "pending";
}

/** Employee is active on a day: no termination date, or terminated on/after it. */
export function activeOn(employee, day) {
  const end = employee.termination_date === null ? null : parseDate(employee.termination_date);
  return end === null || end >= day;
}
