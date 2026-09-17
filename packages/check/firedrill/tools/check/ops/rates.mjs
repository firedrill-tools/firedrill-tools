// Earning rates and pay schedules (with generated paydays).
import { inScope, requireKey } from "../lib/access.mjs";
import { civilFromDays, formatDate, monthLength, parseDate, today } from "../lib/dates.mjs";
import { nextId } from "../lib/ids.mjs";
import { fromCents } from "../lib/money.mjs";
import { keyComparator, limitArg, pageOf } from "../lib/paging.mjs";
import { FREQUENCIES, paydaysBetween } from "../lib/paydays.mjs";
import { mustFind } from "../lib/records.mjs";
import { rateOut, scheduleOut } from "../lib/serialize.mjs";
import { scanAll } from "../lib/store.mjs";
import { bad, bool, choice, date, hasOwn, integer, metadata, positiveMoney, requireField, text } from "../lib/validate.mjs";
import { boolFilter, cursorArg, idFilter, refFilter } from "./common.mjs";

const PERIODS = ["hourly", "annually", "piece"];
const IMMUTABLE = "This value cannot be changed after the Earning Rate is created.";
const bySeq = keyComparator();

export function ratesList(input, context) {
  const key = requireKey(context, false);
  const filters = {};
  const company = refFilter(context, input, filters, "company", "com");
  const employee = refFilter(context, input, filters, "employee", "emp");
  const active = boolFilter(context, input, filters, "active", undefined);
  const ids = idFilter(context, input, filters);
  const limit = limitArg(context, input, 500);
  const cursor = cursorArg(context, input);
  const rows = scanAll(context, "earning_rates")
    .filter((row) => inScope(key, row.company) && (company === undefined || row.company === company) && (employee === undefined || row.employee === employee)
      && (active === undefined || row.active === active) && (ids === undefined || ids.has(row.id)))
    .sort((a, b) => a.seq - b.seq);
  return pageOf(context, { resource: "earning_rates", path: "/earning_rates", rows, filters, limit, cursor, keyTypes: ["i"], keyOf: (row) => [row.seq], compare: bySeq, map: rateOut });
}

export function ratesCreate(input, context) {
  const key = requireKey(context, true);
  for (const field of ["employee", "amount", "period"]) requireField(context, input, field);
  const cents = positiveMoney(context, input.amount, "amount");
  const period = choice(context, input.period, PERIODS, "period");
  const name = hasOwn(input, "name") ? text(context, input.name, "name", 200, { nullable: true }) : null;
  const workweek = hasOwn(input, "workweek_hours") ? integer(context, input.workweek_hours, "workweek_hours", 1, 168) : 40;
  const active = hasOwn(input, "active") ? bool(context, input.active, "active") : true;
  const meta = hasOwn(input, "metadata") ? metadata(context, input.metadata) : {};
  const employee = mustFind(context, key, "employees", input.employee, "employee");
  const { id, seq } = nextId(context, "rte", "earning_rates");
  const row = { id, seq, employee: employee.id, company: employee.company, name, amount: fromCents(cents), period, workweek_hours: workweek, active, metadata: meta };
  context.state.put("earning_rates", id, row);
  return rateOut(row);
}

export function ratesUpdate(input, context) {
  const key = requireKey(context, true);
  for (const field of ["amount", "period", "employee", "workweek_hours", "company"]) if (hasOwn(input, field)) bad(context, field, IMMUTABLE);
  if (hasOwn(input, "id")) bad(context, "id", "This field is read-only.");
  const current = mustFind(context, key, "earning_rates", input.earning_rate, "earning_rate");
  const row = { ...current };
  if (hasOwn(input, "name")) row.name = text(context, input.name, "name", 200, { nullable: true });
  if (hasOwn(input, "active")) row.active = bool(context, input.active, "active");
  if (hasOwn(input, "metadata")) row.metadata = metadata(context, input.metadata);
  context.state.put("earning_rates", row.id, row);
  return rateOut(row);
}

export function schedulesList(input, context) {
  const key = requireKey(context, false);
  const filters = {};
  const company = refFilter(context, input, filters, "company", "com");
  const ids = idFilter(context, input, filters);
  const limit = limitArg(context, input, 25);
  const cursor = cursorArg(context, input);
  const rows = scanAll(context, "pay_schedules")
    .filter((row) => inScope(key, row.company) && (company === undefined || row.company === company) && (ids === undefined || ids.has(row.id)))
    .sort((a, b) => a.seq - b.seq);
  return pageOf(context, { resource: "pay_schedules", path: "/pay_schedules", rows, filters, limit, cursor, keyTypes: ["i"], keyOf: (row) => [row.seq], compare: bySeq, map: scheduleOut });
}

export function schedulesCreate(input, context) {
  const key = requireKey(context, true);
  for (const field of ["company", "pay_frequency", "first_payday", "first_period_end"]) requireField(context, input, field);
  const frequency = choice(context, input.pay_frequency, FREQUENCIES, "pay_frequency");
  const payday = date(context, input.first_payday, "first_payday");
  const periodEnd = date(context, input.first_period_end, "first_period_end");
  if (periodEnd > payday) bad(context, "first_period_end", "First period end must be on or before the first payday.");
  const name = hasOwn(input, "name") ? text(context, input.name, "name", 200, { nullable: true }) : null;
  const meta = hasOwn(input, "metadata") ? metadata(context, input.metadata) : {};
  let second = null;
  if (hasOwn(input, "second_payday") && input.second_payday !== null) {
    if (frequency !== "semimonthly") bad(context, "second_payday", "Only semimonthly schedules have a second payday.");
    second = integer(context, input.second_payday, "second_payday", 16, 31);
  }
  if (frequency === "semimonthly") {
    const { year, month, day } = civilFromDays(payday);
    if (day !== 15 && day !== Math.min(second ?? 31, monthLength(year, month))) bad(context, "first_payday", "A semimonthly first payday must fall on the 15th or the second payday.");
  }
  const company = mustFind(context, key, "companies", input.company, "company");
  const { id, seq } = nextId(context, "psc", "pay_schedules");
  const row = { id, seq, company: company.id, name, pay_frequency: frequency, first_payday: formatDate(payday), first_period_end: formatDate(periodEnd), second_payday: second, metadata: meta };
  context.state.put("pay_schedules", id, row);
  return scheduleOut(row);
}

export function schedulesPaydays(input, context) {
  const key = requireKey(context, false);
  const start = hasOwn(input, "start") ? date(context, input.start, "start") : today(context);
  const end = hasOwn(input, "end") ? date(context, input.end, "end") : start + 365;
  if (end < start) bad(context, "end", "End must be on or after start.");
  if (end - start > 366) bad(context, "end", "The date range may not exceed 366 days.");
  const schedule = mustFind(context, key, "pay_schedules", input.pay_schedule, "pay_schedule");
  const company = context.state.get("companies", schedule.company);
  const results = paydaysBetween(schedule, company?.processing_period ?? "two_day", start, end);
  return { next: null, previous: null, results };
}
