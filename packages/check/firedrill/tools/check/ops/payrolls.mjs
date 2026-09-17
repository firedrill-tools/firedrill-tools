// Payrolls: list, create (optionally with inline items), retrieve, delete.
import { inScope, requireKey } from "../lib/access.mjs";
import { formatDate, formatStamp, nowMs, nowStamp, parseDate, today } from "../lib/dates.mjs";
import { nextId } from "../lib/ids.mjs";
import { keyComparator, limitArg, pageOf } from "../lib/paging.mjs";
import { FREQUENCIES, PROCESSING_DAYS, approvalDeadlineMs, isSchedulePayday } from "../lib/paydays.mjs";
import { findScoped, mustFind, payrollStatus } from "../lib/records.mjs";
import { itemsOf, payrollContext, payrollOut } from "../lib/serialize.mjs";
import { scanAll } from "../lib/store.mjs";
import { bad, bool, choice, date, hasOwn, metadata, notFound, requireField, rule } from "../lib/validate.mjs";
import { boolFilter, cursorArg, idFilter, refFilter } from "./common.mjs";
import { MAX_ITEMS } from "./items.mjs";
import { itemFields } from "./item-rules.mjs";

const TYPES = ["regular", "off_cycle"];
const STATUSES = ["draft", "pending", "processing", "paid", "partially_paid", "failed"];
const byPaydayDesc = keyComparator([0]);

function listFilter(context, input, filters, name, allowed) {
  if (!hasOwn(input, name)) return undefined;
  const list = input[name];
  if (!Array.isArray(list) || list.length === 0 || list.length > 100) bad(context, name, "Provide at least one value.");
  list.forEach((value) => choice(context, value, allowed, name));
  filters[name] = [...new Set(list)];
  return new Set(list);
}

export function payrollsList(input, context) {
  const key = requireKey(context, false);
  const filters = {};
  const company = refFilter(context, input, filters, "company", "com");
  const types = listFilter(context, input, filters, "type", TYPES);
  const statuses = listFilter(context, input, filters, "status", STATUSES);
  const approved = boolFilter(context, input, filters, "approved", undefined);
  const schedule = refFilter(context, input, filters, "pay_schedule", "psc");
  const after = hasOwn(input, "payday_after") ? date(context, input.payday_after, "payday_after") : undefined;
  const before = hasOwn(input, "payday_before") ? date(context, input.payday_before, "payday_before") : undefined;
  if (after !== undefined) filters.payday_after = formatDate(after);
  if (before !== undefined) filters.payday_before = formatDate(before);
  const isVoid = boolFilter(context, input, filters, "is_void", undefined);
  const includeItems = boolFilter(context, input, filters, "include_items", undefined) === true;
  const ids = idFilter(context, input, filters);
  const limit = limitArg(context, input, 25);
  const cursor = cursorArg(context, input);
  const env = payrollContext(context);
  const keyOf = (row) => [row.payday, row.seq];
  const rows = scanAll(context, "payrolls")
    .filter((row) => {
      const day = parseDate(row.payday);
      return inScope(key, row.company) && (company === undefined || row.company === company) && (types === undefined || types.has(row.type))
        && (statuses === undefined || statuses.has(payrollStatus(context, row))) && (approved === undefined || (row.approved_at !== null) === approved)
        && (schedule === undefined || row.pay_schedule === schedule) && (after === undefined || day >= after) && (before === undefined || day <= before)
        && isVoid !== true && (ids === undefined || ids.has(row.id));
    })
    .sort((a, b) => byPaydayDesc(keyOf(a), keyOf(b)));
  return pageOf(context, { resource: "payrolls", path: "/payrolls", rows, filters, limit, cursor, keyTypes: ["s", "i"], keyOf, compare: byPaydayDesc, map: (row) => payrollOut(context, env, row, includeItems) });
}

export function payrollsCreate(input, context) {
  const key = requireKey(context, true);
  for (const field of ["company", "period_start", "period_end", "payday"]) requireField(context, input, field);
  const start = date(context, input.period_start, "period_start");
  const end = date(context, input.period_end, "period_end");
  const payday = date(context, input.payday, "payday");
  const type = hasOwn(input, "type") ? choice(context, input.type, TYPES, "type") : "regular";
  const includeItems = hasOwn(input, "include_items") ? bool(context, input.include_items, "include_items") : false;
  const meta = hasOwn(input, "metadata") ? metadata(context, input.metadata) : {};
  let offCycle = null;
  if (hasOwn(input, "off_cycle_options") && input.off_cycle_options !== null) {
    const o = input.off_cycle_options;
    if (type !== "off_cycle") bad(context, "off_cycle_options", "Off-cycle options apply only to off-cycle payrolls.");
    if (o === null || typeof o !== "object" || Array.isArray(o) || Object.keys(o).some((k) => k !== "force_supplemental_withholding")) bad(context, "off_cycle_options", "Only force_supplemental_withholding is supported.");
    offCycle = { force_supplemental_withholding: hasOwn(o, "force_supplemental_withholding") ? bool(context, o.force_supplemental_withholding, "off_cycle_options.force_supplemental_withholding") : false };
  } else if (type === "off_cycle") offCycle = { force_supplemental_withholding: false };
  const company = mustFind(context, key, "companies", input.company, "company");
  const frequency = hasOwn(input, "pay_frequency") ? choice(context, input.pay_frequency, FREQUENCIES, "pay_frequency") : company.pay_frequency;
  const processing = hasOwn(input, "processing_period") ? choice(context, input.processing_period, Object.keys(PROCESSING_DAYS), "processing_period") : company.processing_period;
  let scheduleId = null;
  if (hasOwn(input, "pay_schedule") && input.pay_schedule !== null) {
    const schedule = findScoped(context, key, "pay_schedules", input.pay_schedule);
    if (schedule === null) notFound(context, "pay_schedule", "Pay schedule");
    if (schedule.company !== company.id) bad(context, "pay_schedule", "Pay schedule belongs to another company.");
    if (type === "regular" && !isSchedulePayday(schedule, payday)) bad(context, "payday", "Payday is not on this pay schedule.");
    scheduleId = schedule.id;
  }
  if (!company.active) rule(context, "Company is not active.");
  if (start > end) bad(context, "period_end", "Period end must be on or after period start.");
  if (payday < start) bad(context, "payday", "Payday must be on or after period start.");
  if (payday < today(context)) bad(context, "payday", "Payday must not be in the past.");
  if (parseDate(company.start_date) > payday) bad(context, "payday", "Payday is before the company's start date.");
  const deadline = approvalDeadlineMs(payday, processing);
  if (deadline <= nowMs(context)) bad(context, "payday", "Payday is too soon for this processing period.");
  const all = scanAll(context, "payrolls");
  if (type === "regular" && all.some((p) => p.company === company.id && p.type === "regular" && p.period_start === formatDate(start) && p.period_end === formatDate(end))) {
    rule(context, "A regular payroll already exists for this pay period.");
  }
  const { id, seq } = nextId(context, "pay", "payrolls");
  const row = {
    id, seq, company: company.id, pay_schedule: scheduleId, type, pay_frequency: frequency, processing_period: processing,
    period_start: formatDate(start), period_end: formatDate(end), payday: formatDate(payday), approval_deadline: formatStamp(deadline),
    approved_at: null, reopen_deadline: null, stored_status: "draft", preview: null, last_preview_ms: null, off_cycle_options: offCycle, metadata: meta, created_at: nowStamp(context),
  };
  context.state.put("payrolls", id, row);
  if (hasOwn(input, "items") && input.items !== null) {
    if (!includeItems) bad(context, "include_items", "include_items=true is required when items are sent.");
    const list = input.items;
    if (!Array.isArray(list) || list.length > MAX_ITEMS) bad(context, "items", `Provide at most ${MAX_ITEMS} items.`);
    const seen = new Set();
    list.forEach((entry, i) => {
      const prefix = `items.${i}.`;
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) bad(context, `items.${i}`, "Must be a payroll item object.");
      for (const k of Object.keys(entry)) if (k !== "employee" && k !== "payroll" && !["payment_method", "earnings", "reimbursements", "pto_balance_hours", "sick_balance_hours", "paper_check_number", "metadata"].includes(k)) bad(context, `${prefix}${k.slice(0, 200)}`, "This field is not supported.");
      if (hasOwn(entry, "payroll")) bad(context, `${prefix}payroll`, "This field is set from the payroll.");
      const employee = findScoped(context, key, "employees", entry.employee);
      if (employee === null || employee.company !== company.id) bad(context, `${prefix}employee`, "Employee not found in this company.");
      if (seen.has(employee.id)) bad(context, `${prefix}employee`, "This employee already has an item on this payroll.");
      seen.add(employee.id);
      const fields = itemFields(context, entry, employee, row, undefined, prefix);
      const item = nextId(context, "itm", "payroll_items");
      context.state.put("payroll_items", item.id, { id: item.id, seq: item.seq, payroll: id, employee: employee.id, ...fields });
    });
  }
  return payrollOut(context, payrollContext(context), row, includeItems);
}

export function payrollsGet(input, context) {
  const key = requireKey(context, false);
  const includeItems = hasOwn(input, "include_items") ? bool(context, input.include_items, "include_items") : false;
  const payroll = mustFind(context, key, "payrolls", input.payroll, "payroll");
  return payrollOut(context, payrollContext(context), payroll, includeItems);
}

export function payrollsDelete(input, context) {
  const key = requireKey(context, true);
  const payroll = mustFind(context, key, "payrolls", input.payroll, "payroll");
  if (payroll.stored_status !== "draft") rule(context, "Only draft payrolls can be deleted.");
  for (const item of itemsOf(payrollContext(context), payroll.id)) context.state.delete("payroll_items", item.id);
  context.state.delete("payrolls", payroll.id);
  return null;
}
