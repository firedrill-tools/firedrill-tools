// Shared entry work for every handler: refuse an unmappable request, resolve the caller, guard capacity.
import { invalid, notFound } from "../lib/errors.mjs";
import { resolveCaller } from "../lib/identity.mjs";
import { guardedMeta, readMeta, scanPrefix } from "../lib/store.mjs";
import { clip } from "../lib/util.mjs";

/**
 * A request the codec could not map arrives as `__request_error`. `__not_found__` means the URL is not a Google
 * endpoint at all, so it answers 404; anything else is a 400 with the codec's own explanation.
 */
export function checkRequestError(context, input) {
  const problem = input.__request_error;
  if (problem === undefined) return;
  if (problem === "__not_found__") notFound(context, "Method not found.");
  invalid(context, `Request contains an invalid argument: ${clip(String(problem), 300)}`);
}

/** Resolves the caller and the counter row; used by every operation that touches records. */
export function begin(context, input) {
  checkRequestError(context, input);
  const caller = resolveCaller(context);
  const meta = guardedMeta(context);
  return { caller, meta };
}

/** Resolves the caller without the capacity guard (used where no scan happens). */
export function beginLight(context, input) {
  checkRequestError(context, input);
  const caller = resolveCaller(context);
  return { caller, meta: readMeta(context) };
}

/** Loads one user's contacts into a Map keyed by contact id, in row-id order. */
export function loadContacts(context, ownerUserId) {
  const rows = scanPrefix(context, "contacts", `${ownerUserId}:`);
  const map = new Map();
  for (const row of rows) map.set(row.value.contactId, row.value);
  return map;
}

/** Loads one user's contact groups into a Map keyed by group id. */
export function loadGroups(context, ownerUserId) {
  const rows = scanPrefix(context, "contact-groups", `${ownerUserId}:`);
  const map = new Map();
  for (const row of rows) map.set(row.value.groupId, row.value);
  return map;
}

export const nowOf = (context) => context.clock.nowUs();
