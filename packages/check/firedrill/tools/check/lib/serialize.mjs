// Response shapes. Stored rows carry `seq` and internal fields that never reach the wire.
import { itemMoney, payrollTotals } from "./calc.mjs";
import { fromCents } from "./money.mjs";
import { activeOn, payrollStatus } from "./records.mjs";
import { indexById, scanAll } from "./store.mjs";
import { taxTable } from "./tax.mjs";
import { today } from "./dates.mjs";

const strip = ({ seq, ...rest }) => rest;
export const companyOut = strip;
export const workplaceOut = strip;
export const rateOut = strip;
export const scheduleOut = strip;

export function employeeOut(context, row) {
  const { seq, has_bank_account, ...rest } = row;
  const blocking = row.residence === null ? ["residence"] : [];
  const remaining = [];
  if (row.ssn_last_four === null) remaining.push("ssn");
  if (row.payment_method_preference === "direct_deposit" && !has_bank_account) remaining.push("payment_method");
  const status = blocking.length > 0 ? "blocking" : remaining.length > 0 ? "needs_attention" : "completed";
  return {
    ...rest,
    active: activeOn(row, today(context)),
    bank_accounts: has_bank_account ? [`bnk_${row.id.slice(4, 24)}`] : [],
    default_net_pay_split: null,
    onboard: { status, blocking_steps: blocking, remaining_steps: remaining },
  };
}

/** Loads what payroll rendering needs once per request. */
export function payrollContext(context) {
  const byPayroll = new Map();
  for (const item of scanAll(context, "payroll_items")) {
    if (!byPayroll.has(item.payroll)) byPayroll.set(item.payroll, []);
    byPayroll.get(item.payroll).push(item);
  }
  for (const list of byPayroll.values()) list.sort((a, b) => a.seq - b.seq);
  return { table: taxTable(context), workplaces: indexById(scanAll(context, "workplaces")), byPayroll };
}

export function itemsOf(env, payrollId) {
  return env.byPayroll.get(payrollId) ?? [];
}

export function itemOut(context, env, item, payroll) {
  const { seq, ...rest } = item;
  const money = itemMoney(item, payroll, env.table, env.workplaces);
  return {
    ...rest,
    status: payrollStatus(context, payroll),
    net_pay: fromCents(money.net),
    taxes: money.taxes,
    benefits: [],
    post_tax_deductions: [],
    warnings: [],
    void_of: null,
    voided_by: null,
  };
}

export function payrollOut(context, env, payroll, includeItems = false) {
  const { seq, stored_status, last_preview_ms, ...rest } = payroll;
  const items = itemsOf(env, payroll.id);
  const out = {
    ...rest,
    status: payrollStatus(context, payroll),
    managed: false,
    is_void: false,
    funding_payment_method: "ach",
    bank_account: null,
    simulation_mode: "automatic",
    fulfillment: null,
    warnings: [],
    totals: payrollTotals(items.map((item) => itemMoney(item, payroll, env.table, env.workplaces))),
  };
  if (includeItems) out.items = items.map((item) => itemOut(context, env, item, payroll));
  return out;
}
