// Creating documents and recipients: envelope ids and signing tokens from seeded randomness, monthly usage limits.
import { limitExceeded } from "./errors.mjs";
import { nextId, putRecipient } from "./store.mjs";
import { ENVELOPE_ALPHABET, TOKEN_ALPHABET, monthOf, pad10, randomChars } from "./util.mjs";

function unique(context, namespace, make) {
  let candidate = make();
  for (let attempt = 0; attempt < 8 && context.state.get(namespace, candidate) !== null; attempt += 1) candidate = make();
  return candidate;
}

export const newEnvelopeId = (context) => unique(context, "envelope-ids", () => `envelope_${randomChars(context, ENVELOPE_ALPHABET, 16)}`);
export const newToken = (context) => unique(context, "recipient-tokens", () => randomChars(context, TOKEN_ALPHABET, 21));

const usageRowId = (context, teamId) => `${pad10(teamId)}/${monthOf(context.clock.nowUs())}`;

export function checkMonthlyLimit(context, caller) {
  const limit = caller.team.monthlyDocumentLimit;
  if (limit === null) return;
  const used = context.state.get("usage", usageRowId(context, caller.teamId))?.documentsCreated ?? 0;
  if (used >= limit) limitExceeded(context, "You have reached your document limit for this month");
}

export function incrementUsage(context, teamId) {
  const rowId = usageRowId(context, teamId);
  const row = context.state.get("usage", rowId);
  context.state.put("usage", rowId, { teamId, month: monthOf(context.clock.nowUs()), documentsCreated: (row?.documentsCreated ?? 0) + 1 });
}

/** Inserts a document row (all fields except id/envelopeId supplied) and its envelope id index. */
export function insertDocument(context, fields) {
  const doc = { id: nextId(context, "documents"), envelopeId: newEnvelopeId(context), ...fields };
  context.state.put("documents", pad10(doc.id), doc);
  context.state.put("envelope-ids", doc.envelopeId, { kind: "document", id: doc.id });
  return doc;
}

/** A new, unsent recipient on a document or template. */
export function newRecipient(context, parentKind, parentId, input, sendStatus = "NOT_SENT") {
  const recipient = {
    id: nextId(context, "recipients"), parentKind, parentId, email: input.email, name: input.name, role: input.role, signingOrder: input.signingOrder,
    readStatus: "NOT_OPENED", signingStatus: "NOT_SIGNED", sendStatus, token: newToken(context), signedAtUs: null, rejectionReason: null,
    accessAuth: input.accessAuth, actionAuth: input.actionAuth,
  };
  putRecipient(context, recipient);
  return recipient;
}

export const EDITABLE_MESSAGES = new Map([
  ["COMPLETED", "Document is already complete"], ["REJECTED", "Document has been rejected"], ["CANCELLED", "Document has been cancelled"],
]);
