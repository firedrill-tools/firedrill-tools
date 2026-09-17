// Single-record response sizes: document and template bodies must stay under the framework's 1 MiB HTTP response cap.
import { fail, invalid } from "./errors.mjs";
import { documentBody } from "./render.mjs";
import { fieldsOf, recipientsOf } from "./store.mjs";
import { jsonBytes, pad10 } from "./util.mjs";

export const RECORD_BYTE_BUDGET = 900_000;

/** A write that would make a body too large fails INVALID_REQUEST (rolled back). */
export function assertBodyFits(context, body) {
  if (jsonBytes(body) > RECORD_BYTE_BUDGET) invalid(context, "Document is too large: its API representation would exceed 900 KB");
  return body;
}

export function assertDocumentFits(context, documentId) {
  const doc = context.state.get("documents", pad10(documentId));
  if (doc !== null) assertBodyFits(context, documentBody(doc, recipientsOf(context, "document", doc.id), fieldsOf(context, "document", doc.id)));
}

/** A stored record (for example authored starting data) too large to return fails UNKNOWN_ERROR instead of a truncated body. */
export function assertReadable(context, body) {
  if (jsonBytes(body) > RECORD_BYTE_BUDGET) fail(context, "UNKNOWN_ERROR", "record exceeds the supported response size of 900 KB");
  return body;
}
