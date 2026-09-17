// Read-only entities: CompanyInfo and Account (with CurrentBalance computed from the ledger on read).
import { USD, fromCents, toCents } from "./common.mjs";

export function renderCompany(company) {
  const out = {
    CompanyName: company.CompanyName,
    LegalName: company.LegalName,
    CompanyAddr: compactAddr(company.CompanyAddr),
    Email: company.Email,
    PrimaryPhone: company.PrimaryPhone,
    WebAddr: company.WebAddr,
    Country: company.Country,
    FiscalYearStartMonth: company.FiscalYearStartMonth,
    CompanyStartDate: company.CompanyStartDate,
    SupportedLanguages: company.SupportedLanguages,
    DefaultTimeZone: company.DefaultTimeZone,
    domain: "QBO",
    sparse: false,
    Id: company.Id,
    SyncToken: company.SyncToken,
    MetaData: company.MetaData,
  };
  return out;
}

export function compactAddr(addr) {
  if (addr === null) return null;
  const out = {};
  for (const key of ["Id", "Line1", "Line2", "City", "CountrySubDivisionCode", "PostalCode", "Country"]) if (addr[key] !== null) out[key] = addr[key];
  return out;
}

/** Per-request ledger totals for account balances (one pass over invoices, payments and items). */
function accountTotals(s) {
  const key = "#accountTotals";
  if (s.memo.has(key)) return s.memo.get(key);
  const totals = { receivable: 0, deposits: new Map(), income: new Map() };
  const items = new Map();
  for (const item of s.rows("items")) items.set(item.Id, item);
  for (const invoice of s.rows("invoices")) {
    totals.receivable += toCents(invoice.Balance) ?? 0;
    if (invoice.voided) continue;
    for (const line of invoice.Line) {
      const item = items.get(line.SalesItemLineDetail.ItemRef.value);
      if (item === undefined) continue;
      const account = item.IncomeAccountRef.value;
      totals.income.set(account, (totals.income.get(account) ?? 0) + (toCents(line.Amount) ?? 0));
    }
  }
  for (const payment of s.rows("payments")) {
    const account = payment.DepositToAccountRef.value;
    totals.deposits.set(account, (totals.deposits.get(account) ?? 0) + (toCents(payment.TotalAmt) ?? 0));
  }
  s.memo.set(key, totals);
  return totals;
}

export function accountBalanceCents(s, row) {
  const opening = toCents(row.openingBalance, { allowNegative: true }) ?? 0;
  if (row.AccountType === "Accounts Receivable") return opening + accountTotals(s).receivable;
  if (row.AccountType === "Bank" || row.AccountSubType === "UndepositedFunds") return opening + (accountTotals(s).deposits.get(row.Id) ?? 0);
  if (row.AccountType === "Income") return opening + (accountTotals(s).income.get(row.Id) ?? 0);
  return opening;
}

export function renderAccount(s, row) {
  const balance = fromCents(accountBalanceCents(s, row));
  const out = {
    Name: row.Name,
    SubAccount: false,
    FullyQualifiedName: row.FullyQualifiedName,
    Active: row.Active,
    Classification: row.Classification,
    AccountType: row.AccountType,
    AccountSubType: row.AccountSubType,
    CurrentBalance: balance,
    CurrentBalanceWithSubAccounts: balance,
    CurrencyRef: USD,
    domain: "QBO",
    sparse: false,
    Id: row.Id,
    SyncToken: row.SyncToken,
    MetaData: row.MetaData,
  };
  if (row.AcctNum !== null) out.AcctNum = row.AcctNum;
  if (row.Description !== null) out.Description = row.Description;
  return out;
}
