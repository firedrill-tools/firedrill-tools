// Synthetic Trolley merchant account (sandbox) for Firedrill. Every operation computes from `context.state`: ids come
// from the `meta/counters` row, timestamps from virtual time, FX and fees from the synthetic `meta/fx` and `meta/fees`
// rows. Nothing here contacts Trolley, a bank, PayPal, Venmo or a check printer; no money moves.
import { route } from "./lib/wire.mjs";
import { accountsCreate, accountsGet, accountsList } from "./ops/accounts.mjs";
import { accountsDelete, accountsUpdate } from "./ops/accounts-write.mjs";
import { balancesList } from "./ops/balances.mjs";
import { batchesCreate, batchesDelete, batchesGet, batchesList, batchesSummary, batchesUpdate } from "./ops/batches.mjs";
import { paymentsCreate, paymentsDelete, paymentsGet, paymentsList, paymentsUpdate } from "./ops/payments.mjs";
import { batchesGenerateQuote, batchesStartProcessing } from "./ops/processing.mjs";
import { recipientsCreate, recipientsDelete, recipientsGet, recipientsUpdate } from "./ops/recipients.mjs";
import { recipientsList } from "./ops/recipients-list.mjs";

const operations = {
  "recipients.create": recipientsCreate,
  "recipients.get": recipientsGet,
  "recipients.update": recipientsUpdate,
  "recipients.delete": recipientsDelete,
  "recipients.list": recipientsList,
  "recipient_accounts.create": accountsCreate,
  "recipient_accounts.list": accountsList,
  "recipient_accounts.get": accountsGet,
  "recipient_accounts.update": accountsUpdate,
  "recipient_accounts.delete": accountsDelete,
  "batches.create": batchesCreate,
  "batches.get": batchesGet,
  "batches.update": batchesUpdate,
  "batches.delete": batchesDelete,
  "batches.list": batchesList,
  "batches.generate_quote": batchesGenerateQuote,
  "batches.start_processing": batchesStartProcessing,
  "batches.summary": batchesSummary,
  "payments.create": paymentsCreate,
  "payments.list": paymentsList,
  "payments.get": paymentsGet,
  "payments.update": paymentsUpdate,
  "payments.delete": paymentsDelete,
  "balances.list": balancesList,
};

const PAGE = { page: "integer", pageSize: "integer" };
const RECIPIENT_QUERY = {
  ...PAGE, search: "string", name: "string", email: "string", referenceId: "string", status: "string", complianceStatus: "string",
  country: "string", payoutMethod: "string", currency: "string", tags: "string", orderBy: "string", sortBy: "string",
};
const BATCH_QUERY = { ...PAGE, search: "string", status: "string", currency: "string", tags: "string", orderBy: "string", sortBy: "string" };
const PAYMENT_QUERY = { ...PAGE, status: "string", search: "string" };

const http = {
  "create-recipient": route({ body: "json" }),
  "get-recipient": route(),
  "update-recipient": route({ body: "json" }),
  "delete-recipient": route(),
  "list-recipients": route({ query: RECIPIENT_QUERY }),
  "create-recipient-account": route({ body: "json" }),
  "list-recipient-accounts": route(),
  "get-recipient-account": route(),
  "update-recipient-account": route({ body: "json" }),
  "delete-recipient-account": route(),
  "create-batch": route({ body: "json" }),
  "get-batch": route(),
  "update-batch": route({ body: "json" }),
  "delete-batch": route(),
  "list-batches": route({ query: BATCH_QUERY }),
  "generate-batch-quote": route({ body: "empty" }),
  "start-batch-processing": route({ body: "empty" }),
  "get-batch-summary": route(),
  "create-payment": route({ body: "json" }),
  "list-batch-payments": route({ query: PAYMENT_QUERY }),
  "get-batch-payment": route(),
  "get-payment": route(),
  "update-payment": route({ body: "json" }),
  "delete-payment": route(),
  "list-balances": route(),
  "list-balances-by-kind": route(),
};

export default { operations, http };
