// GET /v1/balances and /v1/balances/{kind}. `serverTime` (virtual time) is a Firedrill addition for the app.
import { requireKey } from "../lib/access.mjs";
import { scanAll } from "../lib/store.mjs";
import { nowIso } from "../lib/time.mjs";
import { checkEnum, hasOwn } from "../lib/validate.mjs";

export function balancesList(input, context) {
  requireKey(context, false);
  const kind = hasOwn(input, "kind") ? checkEnum(context, input.kind, ["paymentrails", "paypal"], "kind") : undefined;
  const balances = scanAll(context, "balances")
    .filter((row) => kind === undefined || row.type === kind)
    .sort((a, b) => (a.primary !== b.primary ? (a.primary ? -1 : 1) : a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : a.type < b.type ? -1 : 1))
    .map((row) => ({
      primary: row.primary,
      amount: row.amount,
      currency: row.currency,
      type: row.type,
      accountNumber: row.accountNumber,
      display: row.display,
      pendingAmount: row.pendingAmount,
    }));
  return { ok: true, balances, serverTime: nowIso(context) };
}
