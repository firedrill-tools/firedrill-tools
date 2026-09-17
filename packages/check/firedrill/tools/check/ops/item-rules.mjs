// Payroll item field rules shared by item create/update and inline payroll items. Earning amounts are computed here
// (from an amount or an earning rate) and stored; taxes and net pay are computed on read.
import { divRound, fromCents, hundredths, toCents } from "../lib/money.mjs";
import { isId } from "../lib/ids.mjs";
import { PERIODS_PER_YEAR } from "../lib/paydays.mjs";
import { bad, choice, clip, hasOwn, metadata, positiveMoney, text } from "../lib/validate.mjs";

export const EARNING_TYPES = ["regular", "overtime", "double_overtime", "pto", "sick", "holiday", "bonus", "commission", "cash_tips", "paycheck_tips", "piece", "salaried"];
const EARNING_KEYS = ["type", "workplace", "amount", "hours", "earning_rate", "piece_units", "description"];
const MULTIPLIER_TENTHS = { overtime: 15n, double_overtime: 20n };
const UNSUPPORTED = ["benefit_overrides", "tax_overrides", "post_tax_deduction_overrides", "benefits", "post_tax_deductions", "warnings", "net_pay", "taxes", "status"];
export const ITEM_FIELDS = ["payment_method", "earnings", "reimbursements", "pto_balance_hours", "sick_balance_hours", "paper_check_number", "metadata"];

function earning(context, value, field, employee, payroll) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) bad(context, field, "Must be an earning object.");
  for (const k of Object.keys(value)) if (!EARNING_KEYS.includes(k)) bad(context, `${field}.${clip(k)}`, "This field is not supported.");
  const type = choice(context, hasOwn(value, "type") ? value.type : "regular", EARNING_TYPES, `${field}.type`);
  const workplaceId = value.workplace;
  const workplace = isId("wrk", workplaceId) ? context.state.get("workplaces", workplaceId) : null;
  if (workplace === null || workplace.company !== payroll.company || !employee.workplaces.includes(workplaceId)) bad(context, `${field}.workplace`, "Workplace must be one of the employee's workplaces.");
  if (!workplace.active) bad(context, `${field}.workplace`, "Workplace is not active.");
  const hasAmount = hasOwn(value, "amount") && value.amount !== null;
  const hasRate = hasOwn(value, "earning_rate") && value.earning_rate !== null;
  if (hasAmount && hasRate) bad(context, `${field}.amount`, "Provide either amount or earning_rate, not both.");
  if (!hasAmount && !hasRate) bad(context, `${field}.amount`, "Provide either amount or earning_rate.");
  let hours = null;
  if (hasOwn(value, "hours") && value.hours !== null) {
    if (hundredths(value.hours) === null) bad(context, `${field}.hours`, "Hours must be between 0 and 400 with at most two decimals.");
    hours = value.hours;
  }
  let pieceUnits = null;
  if (hasOwn(value, "piece_units") && value.piece_units !== null) {
    const v = value.piece_units;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 100000 || Math.abs(Math.round(v * 100) - v * 100) > 1e-6) bad(context, `${field}.piece_units`, "Piece units must be a positive number with at most two decimals.");
    pieceUnits = v;
  }
  const description = hasOwn(value, "description") ? text(context, value.description, `${field}.description`, 200, { nullable: true }) : null;
  let cents;
  let rateId = null;
  if (hasAmount) {
    cents = positiveMoney(context, value.amount, `${field}.amount`);
  } else {
    rateId = value.earning_rate;
    const rate = isId("rte", rateId) ? context.state.get("earning_rates", rateId) : null;
    if (rate === null || rate.employee !== employee.id) bad(context, `${field}.earning_rate`, "Earning rate not found for this employee.");
    if (!rate.active) bad(context, `${field}.earning_rate`, "Earning rate is not active.");
    const rateCents = toCents(rate.amount);
    if (rate.period === "hourly") {
      if (hours === null) bad(context, `${field}.hours`, "Hours are required with an hourly earning rate.");
      cents = divRound(rateCents * BigInt(Math.round(hours * 100)) * (MULTIPLIER_TENTHS[type] ?? 10n), 1000n);
    } else if (rate.period === "annually") {
      cents = divRound(rateCents, BigInt(PERIODS_PER_YEAR[payroll.pay_frequency] ?? 26));
    } else {
      if (type !== "piece") bad(context, `${field}.type`, "A piece earning rate requires the piece earning type.");
      if (pieceUnits === null) bad(context, `${field}.piece_units`, "Piece units are required with a piece earning rate.");
      cents = divRound(rateCents * BigInt(Math.round(pieceUnits * 100)), 100n);
    }
    if (cents <= 0n) bad(context, `${field}.earning_rate`, "The computed earning amount must be greater than 0.");
  }
  return { type, workplace: workplaceId, amount: fromCents(cents), hours, earning_rate: rateId, piece_units: pieceUnits, description };
}

function balance(context, value, field) {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 10000) bad(context, field, "Must be a number between 0 and 10000.");
  return value;
}

/** Validated item fields from `input` merged over `current` (arrays replaced whole). `prefix` is `""` or `items.<i>.`. */
export function itemFields(context, input, employee, payroll, current, prefix = "") {
  for (const k of UNSUPPORTED) if (hasOwn(input, k)) bad(context, `${prefix}${k}`, "This field is not supported by this Tool.");
  const out = current === undefined
    ? { payment_method: employee.payment_method_preference, earnings: [], reimbursements: [], pto_balance_hours: null, sick_balance_hours: null, paper_check_number: null, metadata: {} }
    : { payment_method: current.payment_method, earnings: current.earnings, reimbursements: current.reimbursements, pto_balance_hours: current.pto_balance_hours, sick_balance_hours: current.sick_balance_hours, paper_check_number: current.paper_check_number, metadata: current.metadata };
  if (hasOwn(input, "payment_method")) out.payment_method = choice(context, input.payment_method, ["manual", "direct_deposit"], `${prefix}payment_method`);
  if (hasOwn(input, "earnings") || current === undefined) {
    const list = input.earnings;
    if (!Array.isArray(list) || list.length < 1 || list.length > 20) bad(context, `${prefix}earnings`, "Provide between 1 and 20 earnings.");
    out.earnings = list.map((entry, i) => earning(context, entry, `${prefix}earnings.${i}`, employee, payroll));
  }
  if (hasOwn(input, "reimbursements")) {
    const list = input.reimbursements;
    if (!Array.isArray(list) || list.length > 20) bad(context, `${prefix}reimbursements`, "Provide at most 20 reimbursements.");
    out.reimbursements = list.map((entry, i) => {
      const f = `${prefix}reimbursements.${i}`;
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) bad(context, f, "Must be a reimbursement object.");
      for (const k of Object.keys(entry)) if (k !== "amount" && k !== "description") bad(context, `${f}.${clip(k)}`, "This field is not supported.");
      return { amount: fromCents(positiveMoney(context, entry.amount, `${f}.amount`)), description: hasOwn(entry, "description") ? text(context, entry.description, `${f}.description`, 200, { nullable: true }) : null };
    });
  }
  if (hasOwn(input, "pto_balance_hours")) out.pto_balance_hours = balance(context, input.pto_balance_hours, `${prefix}pto_balance_hours`);
  if (hasOwn(input, "sick_balance_hours")) out.sick_balance_hours = balance(context, input.sick_balance_hours, `${prefix}sick_balance_hours`);
  if (hasOwn(input, "paper_check_number")) out.paper_check_number = text(context, input.paper_check_number, `${prefix}paper_check_number`, 20, { nullable: true });
  if (hasOwn(input, "metadata")) out.metadata = metadata(context, input.metadata, `${prefix}metadata`);
  if (out.paper_check_number !== null && out.payment_method !== "manual") bad(context, `${prefix}paper_check_number`, "A paper check number requires the manual payment method.");
  return out;
}
