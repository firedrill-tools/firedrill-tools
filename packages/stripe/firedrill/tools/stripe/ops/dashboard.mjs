// Dashboard context for the browser app: the simulated account, the world's virtual time, the caller's mode and
// restricted-key permission levels. Read-only, never fails, and reachable only as the canonical operation
// (there is no Stripe REST route for it); the app uses it so "today" never comes from the browser clock.

import { PERMISSION_GROUPS, nowSeconds, permissionLevel, livemode } from "../lib/state.mjs";
import { API_VERSION } from "../lib/wire.mjs";
import { accountInfo } from "./payments.mjs";

export function dashboardContext(input, context) {
  void input;
  const permissions = {};
  for (const group of PERMISSION_GROUPS) permissions[group] = permissionLevel(context, group);
  const account = accountInfo(context);
  return {
    object: "dashboard.context",
    account: {
      id: account.id,
      business_name: account.business_name,
      country: account.country,
      default_currency: account.default_currency,
      statement_descriptor: account.statement_descriptor,
      support_email: account.support_email,
    },
    now: nowSeconds(context),
    livemode: livemode(context),
    permissions,
    api_version: API_VERSION,
  };
}
