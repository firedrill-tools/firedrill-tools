// Item and payroll money. Earning amounts are stored when an item is written; taxes, net pay and totals are computed on
// every read from the stored items and the synthetic tax table.
import { fromCents, toCents } from "./money.mjs";
import { taxLines } from "./tax.mjs";

/** `workplaces`: Map id → workplace row. Returns cents values and rendered tax lines. */
export function itemMoney(item, payroll, table, workplaces) {
  let gross = 0n;
  let cashTips = 0n;
  const byState = new Map();
  for (const earning of item.earnings) {
    const cents = toCents(earning.amount);
    gross += cents;
    if (earning.type === "cash_tips") cashTips += cents;
    const state = workplaces.get(earning.workplace)?.address?.state;
    if (typeof state === "string") byState.set(state, (byState.get(state) ?? 0n) + cents);
  }
  let reimbursements = 0n;
  for (const entry of item.reimbursements) reimbursements += toCents(entry.amount);
  const force = payroll.off_cycle_options?.force_supplemental_withholding === true;
  const taxes = taxLines(table, gross, byState, force);
  const net = gross - cashTips - taxes.employeeCents + reimbursements;
  return { gross, cashTips, reimbursements, taxes: taxes.lines, employeeTaxes: taxes.employeeCents, companyTaxes: taxes.companyCents, net };
}

export function payrollTotals(moneys) {
  let gross = 0n;
  let employeeTaxes = 0n;
  let reimbursements = 0n;
  let net = 0n;
  let companyTaxes = 0n;
  for (const m of moneys) {
    gross += m.gross;
    employeeTaxes += m.employeeTaxes;
    reimbursements += m.reimbursements;
    net += m.net;
    companyTaxes += m.companyTaxes;
  }
  const liability = employeeTaxes + companyTaxes;
  return {
    employee_gross: fromCents(gross),
    employee_taxes: fromCents(employeeTaxes),
    employee_benefits: "0.00",
    employee_reimbursements: fromCents(reimbursements),
    employee_net: fromCents(net),
    contractor_gross: "0.00",
    contractor_net: "0.00",
    contractor_reimbursements: "0.00",
    company_taxes: fromCents(companyTaxes),
    company_benefits: "0.00",
    liability: fromCents(liability),
    cash_requirement: fromCents(net + liability),
  };
}
