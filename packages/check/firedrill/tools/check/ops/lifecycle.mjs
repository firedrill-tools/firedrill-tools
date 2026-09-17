// Payroll preview, approve and reopen. Preview records that the calculation ran; approve requires the current preview,
// the approval deadline and bank accounts for direct deposit; reopen is allowed until the reopen deadline.
import { requireKey } from "../lib/access.mjs";
import { formatStamp, formatStampMs, nowMs, parseDate, parseStamp } from "../lib/dates.mjs";
import { itemMoney } from "../lib/calc.mjs";
import { activeOn, mustFind, payrollStatus } from "../lib/records.mjs";
import { itemsOf, payrollContext, payrollOut } from "../lib/serialize.mjs";
import { bad, bool, hasOwn, rule, text } from "../lib/validate.mjs";

const HOUR_MS = 3600000;

function emit(context, eventId, payroll) {
  context.events.emit(eventId, { event: eventId, data: payrollOut(context, payrollContext(context), payroll, false) });
}

export function payrollsPreview(input, context) {
  const key = requireKey(context, true);
  const includeItems = hasOwn(input, "include_items") ? bool(context, input.include_items, "include_items") : false;
  if (hasOwn(input, "async") && bool(context, input.async, "async")) bad(context, "async", "Asynchronous preview is not supported by this Tool.");
  const payroll = mustFind(context, key, "payrolls", input.payroll, "payroll");
  if (payroll.stored_status !== "draft") rule(context, "Only draft payrolls can be previewed.");
  const env = payrollContext(context);
  const items = itemsOf(env, payroll.id);
  if (items.length === 0) rule(context, "Payroll must have at least one item.");
  const payday = parseDate(payroll.payday);
  const errors = [];
  items.forEach((item, i) => {
    const employee = context.state.get("employees", item.employee);
    if (employee === null || !activeOn(employee, payday)) errors.push(`field=items.${i}.employee: Employee is not active on payday.`);
    else if (itemMoney(item, payroll, env.table, env.workplaces).net < 0n) errors.push(`field=items.${i}.net_pay: Net pay cannot be negative.`);
  });
  if (errors.length > 0) context.fail({ code: "VALIDATION_ERROR", message: errors.slice(0, 20).join(" | ") });
  const startedMs = Math.max(nowMs(context), (Number.isSafeInteger(payroll.last_preview_ms) ? payroll.last_preview_ms : -1) + 1);
  const stamp = formatStampMs(startedMs);
  const row = { ...payroll, preview: { status: "succeeded", started_at: stamp, completed_at: stamp }, last_preview_ms: startedMs };
  context.state.put("payrolls", row.id, row);
  return payrollOut(context, env, row, includeItems);
}

export function payrollsApprove(input, context) {
  const key = requireKey(context, true);
  const expected = hasOwn(input, "preview_started_at") ? text(context, input.preview_started_at, "preview_started_at", 40) : undefined;
  const payroll = mustFind(context, key, "payrolls", input.payroll, "payroll");
  if (payroll.stored_status !== "draft") rule(context, "Only draft payrolls can be approved.");
  if (payroll.preview === null) rule(context, "Payroll must be previewed before approval.");
  if (expected !== undefined && expected !== payroll.preview.started_at) {
    context.fail({ code: "PREVIEW_SUPERSEDED", message: "The payroll has changed since this preview was started. Preview the payroll again before approving." });
  }
  const now = nowMs(context);
  const deadline = parseStamp(payroll.approval_deadline);
  if (deadline === null || now > deadline) rule(context, "The approval deadline for this payroll has passed.");
  itemsOf(payrollContext(context), payroll.id).forEach((item, i) => {
    if (item.payment_method !== "direct_deposit") return;
    const employee = context.state.get("employees", item.employee);
    if (employee === null || employee.has_bank_account !== true) bad(context, `items.${i}.payment_method`, "Employee has no bank account for direct deposit.");
  });
  const row = { ...payroll, stored_status: "pending", approved_at: formatStamp(now), reopen_deadline: formatStamp(Math.min(now + HOUR_MS, deadline)) };
  context.state.put("payrolls", row.id, row);
  emit(context, "payroll.approved", row);
  return {};
}

export function payrollsReopen(input, context) {
  const key = requireKey(context, true);
  const payroll = mustFind(context, key, "payrolls", input.payroll, "payroll");
  const reopenBy = parseStamp(payroll.reopen_deadline);
  if (payrollStatus(context, payroll) !== "pending" || reopenBy === null || nowMs(context) >= reopenBy) {
    rule(context, "This payroll can no longer be reopened.");
  }
  const row = { ...payroll, stored_status: "draft", approved_at: null, reopen_deadline: null, preview: null };
  context.state.put("payrolls", row.id, row);
  emit(context, "payroll.reopened", row);
  return payrollOut(context, payrollContext(context), row, false);
}
