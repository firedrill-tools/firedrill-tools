// Synthetic flat-rate taxes from the `meta/tax_table` row. Not real tax law: basis points of taxable gross, state lines
// grouped by the earning's workplace state. `force_supplemental_withholding` raises federal income tax to 2200 bp.
import { divRound, fromCents } from "./money.mjs";

export const DEFAULT_TABLE = {
  employee: [
    { id: "fed_income", description: "Federal income tax (synthetic flat rate)", basis_points: 1000, state: null },
    { id: "social_security", description: "Social Security (synthetic flat rate)", basis_points: 620, state: null },
    { id: "medicare", description: "Medicare (synthetic flat rate)", basis_points: 145, state: null },
    { id: "state_income", description: "California income tax (synthetic flat rate)", basis_points: 400, state: "CA" },
    { id: "state_income", description: "Oregon income tax (synthetic flat rate)", basis_points: 800, state: "OR" },
    { id: "state_income", description: "New York income tax (synthetic flat rate)", basis_points: 500, state: "NY" },
  ],
  company: [
    { id: "social_security", description: "Social Security, employer (synthetic flat rate)", basis_points: 620, state: null },
    { id: "medicare", description: "Medicare, employer (synthetic flat rate)", basis_points: 145, state: null },
    { id: "futa", description: "Federal unemployment (synthetic flat rate)", basis_points: 60, state: null },
    { id: "sui", description: "California unemployment insurance (synthetic flat rate)", basis_points: 340, state: "CA" },
    { id: "sui", description: "Oregon unemployment insurance (synthetic flat rate)", basis_points: 210, state: "OR" },
    { id: "sui", description: "New York unemployment insurance (synthetic flat rate)", basis_points: 410, state: "NY" },
  ],
  supported_states: ["CA", "OR", "NY"],
};

export function taxTable(context) {
  const row = context.state.get("meta", "tax_table");
  return row === null ? DEFAULT_TABLE : row;
}

/**
 * Tax lines for one item. `grossByState` is a Map state → cents, `gross` the taxable total in cents.
 * Returns `{ lines: [{ tax, description, amount, payer }], employeeCents, companyCents }`.
 */
export function taxLines(table, gross, grossByState, forceSupplemental) {
  const lines = [];
  let employeeCents = 0n;
  let companyCents = 0n;
  for (const [payer, entries] of [["employee", table.employee], ["company", table.company]]) {
    for (const entry of entries) {
      const bp = payer === "employee" && entry.id === "fed_income" && forceSupplemental ? 2200 : entry.basis_points;
      let base = gross;
      if (entry.state !== null) {
        if (!grossByState.has(entry.state)) continue;
        base = grossByState.get(entry.state);
      }
      const cents = divRound(base * BigInt(bp), 10000n);
      if (payer === "employee") employeeCents += cents;
      else companyCents += cents;
      const tax = entry.state === null ? entry.id : `${entry.state.toLowerCase()}_${entry.id}`;
      lines.push({ tax, description: entry.description, amount: fromCents(cents), payer });
    }
  }
  return { lines, employeeCents, companyCents };
}
