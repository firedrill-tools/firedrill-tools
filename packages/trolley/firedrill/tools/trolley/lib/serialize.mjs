// Wire objects assembled at read time from stored rows, and the recipient status rule.
import { fromCents, toCents } from "./money.mjs";
import { feeCents, minimumCents, routeType } from "./pricing.mjs";

const HOLDS = ["disabled", "suspended", "blocked"];

/** archived > hold > compliance blocked > active (address + primary account) > incomplete. */
export function deriveStatus(recipient, hasPrimary) {
  if (recipient.status === "archived") return "archived";
  if (HOLDS.includes(recipient.holdStatus)) return recipient.holdStatus;
  if (recipient.complianceStatus === "blocked") return "blocked";
  const a = recipient.address ?? {};
  const complete = [a.street1, a.city, a.postalCode, a.country].every((part) => typeof part === "string" && part.trim() !== "");
  return complete && hasPrimary ? "active" : "incomplete";
}

const mask = (last4) => (typeof last4 === "string" && last4 !== "" ? `*****${last4}` : null);

export function accountOut(row) {
  return {
    id: row.id,
    recipientAccountId: row.id,
    recipientId: row.recipientId,
    type: row.type,
    primary: row.primary,
    status: row.status,
    currency: row.currency,
    country: row.country,
    accountHolderName: row.accountHolderName ?? null,
    accountNum: mask(row.accountNumLast4),
    iban: mask(row.ibanLast4),
    bankId: row.bankId ?? null,
    branchId: row.branchId ?? null,
    swiftBic: row.swiftBic ?? null,
    bankName: row.bankName ?? null,
    emailAddress: row.emailAddress ?? null,
    phoneNumber: row.phoneNumber ?? null,
    mailing: row.mailing ?? null,
    routeType: routeType(row),
    disabledAt: row.disabledAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Active accounts, primary first, then by creation. */
export function activeAccounts(rows) {
  return rows
    .filter((row) => row.status !== "disabled")
    .sort((a, b) => (a.primary === b.primary ? (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1) : a.primary ? -1 : 1));
}

export function primaryAccount(rows) {
  return rows.find((row) => row.status !== "disabled" && row.primary === true) ?? null;
}

export function recipientOut(context, row, accountRows) {
  const accounts = activeAccounts(accountRows);
  const primary = primaryAccount(accountRows);
  const currency = primary?.currency ?? null;
  return {
    id: row.id,
    referenceId: row.referenceId ?? null,
    email: row.email,
    name: row.name,
    firstName: row.firstName ?? null,
    lastName: row.lastName ?? null,
    type: row.type,
    status: row.status,
    complianceStatus: row.complianceStatus,
    dob: row.dob ?? null,
    phone: row.phone ?? null,
    language: row.language ?? "en",
    tags: row.tags ?? [],
    address: row.address,
    payoutMethod: primary?.type ?? null,
    primaryCurrency: currency,
    routeType: routeType(primary),
    routeMinimum: primary === null ? null : fromCents(minimumCents(context, primary.type, currency)),
    estimatedFees: primary === null ? null : fromCents(feeCents(context, primary.type, currency)),
    accounts: accounts.map(accountOut),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function batchOut(row, paymentRows) {
  let amount = 0n;
  for (const payment of paymentRows) amount += toCents(payment.sourceAmount);
  return {
    id: row.id,
    status: row.status,
    amount: fromCents(amount),
    totalPayments: paymentRows.length,
    currency: row.currency,
    description: row.description,
    tags: row.tags ?? [],
    quoteExpiredAt: row.quoteExpiredAt ?? null,
    sentAt: row.sentAt ?? null,
    completedAt: row.completedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Full payment object; `recipient` may be null only for a consumer seed that references a missing recipient. */
export function paymentOut(row, recipient, batch, merchantId) {
  return {
    id: row.id,
    recipient: {
      id: row.recipientId,
      referenceId: recipient?.referenceId ?? null,
      email: recipient?.email ?? null,
      name: recipient?.name ?? null,
      status: recipient?.status ?? null,
      countryCode: recipient?.address?.country ?? null,
    },
    batch: {
      id: row.batchId,
      createdAt: batch?.createdAt ?? null,
      updatedAt: batch?.updatedAt ?? null,
      sentAt: batch?.sentAt ?? null,
      completedAt: batch?.completedAt ?? null,
    },
    status: row.status,
    sourceAmount: row.sourceAmount,
    sourceCurrency: row.sourceCurrency,
    targetAmount: row.targetAmount,
    targetCurrency: row.targetCurrency,
    exchangeRate: row.exchangeRate,
    fees: row.fees,
    recipientFees: row.recipientFees,
    merchantFees: row.merchantFees,
    coverFees: row.coverFees,
    payoutMethod: row.payoutMethod,
    memo: row.memo ?? "",
    externalId: row.externalId ?? null,
    category: row.category ?? null,
    tags: row.tags ?? [],
    failureMessage: row.failureMessage ?? null,
    returnedAmount: "0.00",
    withholdingAmount: "0.00",
    withholdingCurrency: row.sourceCurrency,
    equivalentWithholdingAmount: "0.00",
    equivalentWithholdingCurrency: row.targetCurrency,
    merchantId,
    initiatedAt: row.initiatedAt ?? null,
    processedAt: row.processedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
