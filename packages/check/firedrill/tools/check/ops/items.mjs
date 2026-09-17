// Payroll items: list, create, update, delete. Any change requires a draft payroll and clears its preview.
import { inScope, requireKey } from "../lib/access.mjs";
import { nextId } from "../lib/ids.mjs";
import { keyComparator, limitArg, pageOf } from "../lib/paging.mjs";
import { findScoped, mustFind } from "../lib/records.mjs";
import { itemOut, itemsOf, payrollContext } from "../lib/serialize.mjs";
import { indexById, scanAll } from "../lib/store.mjs";
import { bad, hasOwn, notFound, requireField, rule } from "../lib/validate.mjs";
import { cursorArg, idFilter, refFilter } from "./common.mjs";
import { itemFields } from "./item-rules.mjs";

export const MAX_ITEMS = 500;
const bySeq = keyComparator();

export function requireDraft(context, payroll) {
  if (payroll.stored_status !== "draft") rule(context, "Payroll items can only be changed while the payroll is a draft.");
}

export function clearPreview(context, payroll) {
  if (payroll.preview !== null) context.state.put("payrolls", payroll.id, { ...payroll, preview: null });
}

export function itemsList(input, context) {
  const key = requireKey(context, false);
  const filters = {};
  const payrollId = refFilter(context, input, filters, "payroll", "pay");
  const employee = refFilter(context, input, filters, "employee", "emp");
  const ids = idFilter(context, input, filters);
  const limit = limitArg(context, input, 500);
  const cursor = cursorArg(context, input);
  const payrolls = indexById(scanAll(context, "payrolls"));
  const env = payrollContext(context);
  const rows = [];
  for (const list of env.byPayroll.values()) {
    for (const item of list) {
      const payroll = payrolls.get(item.payroll);
      if (payroll === undefined || !inScope(key, payroll.company)) continue;
      if ((payrollId === undefined || item.payroll === payrollId) && (employee === undefined || item.employee === employee) && (ids === undefined || ids.has(item.id))) rows.push(item);
    }
  }
  rows.sort((a, b) => a.seq - b.seq);
  return pageOf(context, {
    resource: "payroll_items", path: "/payroll_items", rows, filters, limit, cursor, keyTypes: ["i"], keyOf: (row) => [row.seq], compare: bySeq,
    map: (item) => itemOut(context, env, item, payrolls.get(item.payroll)),
  });
}

export function itemsCreate(input, context) {
  const key = requireKey(context, true);
  for (const field of ["payroll", "employee", "earnings"]) requireField(context, input, field);
  const payroll = mustFind(context, key, "payrolls", input.payroll, "payroll");
  const employee = findScoped(context, key, "employees", input.employee);
  if (employee === null) notFound(context, "employee", "Employee");
  if (employee.company !== payroll.company) bad(context, "employee", "Employee belongs to another company.");
  requireDraft(context, payroll);
  const fields = itemFields(context, input, employee, payroll, undefined);
  const existing = scanAll(context, "payroll_items").filter((item) => item.payroll === payroll.id);
  if (existing.some((item) => item.employee === employee.id)) bad(context, "employee", "This employee already has an item on this payroll.");
  if (existing.length >= MAX_ITEMS) rule(context, `A payroll can have at most ${MAX_ITEMS} items.`);
  const { id, seq } = nextId(context, "itm", "payroll_items");
  const row = { id, seq, payroll: payroll.id, employee: employee.id, ...fields };
  context.state.put("payroll_items", id, row);
  clearPreview(context, payroll);
  return itemOut(context, payrollContext(context), row, context.state.get("payrolls", payroll.id));
}

export function itemsUpdate(input, context) {
  const key = requireKey(context, true);
  for (const field of ["payroll", "employee", "id"]) if (hasOwn(input, field)) bad(context, field, "This field cannot be changed.");
  const current = mustFind(context, key, "payroll_items", input.payroll_item, "payroll_item");
  const payroll = context.state.get("payrolls", current.payroll);
  const employee = context.state.get("employees", current.employee);
  requireDraft(context, payroll);
  const fields = itemFields(context, input, employee, payroll, current);
  const row = { ...current, ...fields };
  context.state.put("payroll_items", row.id, row);
  clearPreview(context, payroll);
  return itemOut(context, payrollContext(context), row, context.state.get("payrolls", payroll.id));
}

export function itemsDelete(input, context) {
  const key = requireKey(context, true);
  const current = mustFind(context, key, "payroll_items", input.payroll_item, "payroll_item");
  const payroll = context.state.get("payrolls", current.payroll);
  requireDraft(context, payroll);
  context.state.delete("payroll_items", current.id);
  clearPreview(context, payroll);
  return null;
}

export { itemsOf };
