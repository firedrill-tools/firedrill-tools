// users/get_current_account and users/get_space_usage.
import { callerAccount } from "../lib/account.mjs";
import { openStore, usedBytes } from "../lib/store.mjs";
import { timestamp } from "../lib/util.mjs";

export function getCurrentAccount(_input, context) {
  const account = callerAccount(context, "account_info.read");
  return {
    account_id: account.accountId,
    name: {
      given_name: account.givenName,
      surname: account.surname,
      familiar_name: account.familiarName,
      display_name: account.displayName,
      abbreviated_name: account.abbreviatedName,
    },
    email: account.email,
    email_verified: account.emailVerified,
    disabled: account.disabled,
    locale: account.locale,
    referral_link: account.referralLink,
    is_paired: false,
    account_type: { ".tag": account.accountType },
    root_info: { ".tag": "user", root_namespace_id: account.rootNamespaceId, home_namespace_id: account.rootNamespaceId },
    country: account.country,
    server_time: timestamp(context.clock.nowUs()),
  };
}

export function getSpaceUsage(_input, context) {
  const account = callerAccount(context, "account_info.read");
  const store = openStore(context, account);
  return { used: usedBytes(store), allocation: { ".tag": "individual", allocated: account.allocated } };
}
