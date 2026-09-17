// GET /v1/recipients: search, filters, ordering and page-number paging over one bounded scan per namespace.
import { requireKey } from "../lib/access.mjs";
import { filterList, filterText, pageArgs, pageOf, sortArgs, sortItems } from "../lib/paging.mjs";
import { primaryAccount, recipientOut } from "../lib/serialize.mjs";
import { scanAll } from "../lib/store.mjs";
import { CURRENCIES, PAYOUT_METHODS, checkEnum, hasOwn, invalid } from "../lib/validate.mjs";

const STATUSES = ["active", "incomplete", "disabled", "archived", "suspended", "blocked"];
const COMPLIANCE = ["pending", "review", "verified", "blocked"];
const ORDER = ["name", "email", "referenceId", "payoutMethod", "createdAt", "updatedAt"];

const lower = (value) => (typeof value === "string" ? value.toLowerCase() : "");

export function recipientsList(input, context) {
  requireKey(context, false);
  const paging = pageArgs(context, input);
  const search = filterText(context, input, "search");
  const name = filterText(context, input, "name");
  const email = filterText(context, input, "email", 254);
  const referenceId = filterText(context, input, "referenceId", 100);
  const status = hasOwn(input, "status") ? checkEnum(context, input.status, STATUSES, "status") : undefined;
  const compliance = hasOwn(input, "complianceStatus") ? checkEnum(context, input.complianceStatus, COMPLIANCE, "complianceStatus") : undefined;
  const countries = filterList(context, input, "country")?.map((code) => code.toUpperCase());
  const method = hasOwn(input, "payoutMethod") ? checkEnum(context, input.payoutMethod, PAYOUT_METHODS, "payoutMethod") : undefined;
  const currency = hasOwn(input, "currency") ? checkEnum(context, lower(input.currency).toUpperCase(), CURRENCIES, "currency") : undefined;
  const tags = filterList(context, input, "tags");
  const { orderBy, sortBy } = sortArgs(context, input, ORDER, "createdAt");
  if (countries !== undefined && countries.some((code) => !/^[A-Z]{2}$/.test(code))) invalid(context, "country");

  const byRecipient = new Map();
  for (const account of scanAll(context, "recipient_accounts")) {
    if (!byRecipient.has(account.recipientId)) byRecipient.set(account.recipientId, []);
    byRecipient.get(account.recipientId).push(account);
  }
  const accountsFor = (id) => byRecipient.get(id) ?? [];
  const needle = search === undefined ? undefined : search.toLowerCase();
  const nameNeedle = name === undefined ? undefined : name.toLowerCase();

  const matched = scanAll(context, "recipients").filter((row) => {
    if (status === undefined ? row.status === "archived" : row.status !== status) return false;
    if (compliance !== undefined && row.complianceStatus !== compliance) return false;
    if (needle !== undefined && ![row.name, row.email, row.referenceId].some((field) => lower(field).includes(needle))) return false;
    if (nameNeedle !== undefined && ![row.name, row.firstName, row.lastName].some((field) => lower(field).includes(nameNeedle))) return false;
    if (email !== undefined && lower(row.email) !== email.toLowerCase()) return false;
    if (referenceId !== undefined && row.referenceId !== referenceId) return false;
    if (countries !== undefined && !countries.includes(row.address?.country)) return false;
    if (tags !== undefined && !tags.every((tag) => (row.tags ?? []).includes(tag))) return false;
    if (method !== undefined || currency !== undefined) {
      const primary = primaryAccount(accountsFor(row.id));
      if (method !== undefined && primary?.type !== method) return false;
      if (currency !== undefined && primary?.currency !== currency) return false;
    }
    return true;
  });
  const key = orderBy === "payoutMethod" ? (row) => primaryAccount(accountsFor(row.id))?.type ?? null : (row) => row[orderBy] ?? null;
  sortItems(matched, key, sortBy);
  return pageOf(context, matched, paging, "recipients", (row) => recipientOut(context, row, accountsFor(row.id)));
}
