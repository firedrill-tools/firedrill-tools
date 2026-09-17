// people:searchContacts and otherContacts.list.
import { invalid, outOfRange } from "../lib/errors.mjs";
import { SCOPES, requireScope } from "../lib/identity.mjs";
import { parseOtherContactMask, parsePersonFields } from "../lib/mask.mjs";
import { fillPage, mintKeyedToken, pageSize, resumeIndex } from "../lib/page.mjs";
import { renderContact, renderOtherContact } from "../lib/render.mjs";
import { scanPrefix } from "../lib/store.mjs";
import { isMangled, jsonBytes, tokenize } from "../lib/util.mjs";
import { begin, loadContacts } from "./common.mjs";

const PEOPLE = "people.googleapis.com";

/**
 * Deterministic prefix matching over the precomputed `searchText`. Every comparison is a linear
 * `startsWith`/`indexOf` over folded tokens; no caller text is ever compiled into a regular expression.
 */
export function searchContacts(input, context) {
  const { caller } = begin(context, input);
  requireScope(context, caller, [SCOPES.CONTACTS, SCOPES.CONTACTS_READONLY], PEOPLE, "google.people.v1.PeopleService.SearchContacts");
  const raw = input.query;
  if (raw !== undefined && typeof raw !== "string") invalid(context, "The query parameter must be a string.");
  if (typeof raw === "string" && raw.length > 256) invalid(context, "The query parameter accepts at most 256 characters.");
  if (isMangled(raw)) invalid(context, "The query parameter contains characters that could not be decoded.");
  const wanted = parsePersonFields(context, input.readMask, "readMask");
  const limit = pageSize(context, input.pageSize, 1, 30, 10);

  const query = typeof raw === "string" ? raw.trim() : "";
  // Google answers a warmup request (an empty query) with an empty body.
  if (query.length === 0) return {};

  const terms = tokenize(query, 16);
  if (terms.length === 0) return { results: [] };

  const scored = [];
  for (const contact of loadContacts(context, caller.user.id).values()) {
    const haystack = contact.searchText ?? "";
    const tokens = haystack.length > 0 ? haystack.split(" ") : [];
    let score = 0;
    let matchedAll = true;
    for (const term of terms) {
      let best = 0;
      for (const token of tokens) {
        if (token === term) best = Math.max(best, 3);
        else if (token.startsWith(term)) best = Math.max(best, 2);
        else if (term.length >= 3 && token.includes(term)) best = Math.max(best, 1);
      }
      if (best === 0) {
        matchedAll = false;
        break;
      }
      score += best;
    }
    if (matchedAll) scored.push({ contact, score });
  }
  scored.sort((a, b) => b.score - a.score || (a.contact.sortName < b.contact.sortName ? -1 : a.contact.sortName > b.contact.sortName ? 1 : 0));

  const results = [];
  let bytes = 512;
  for (const entry of scored.slice(0, limit)) {
    const person = renderContact(entry.contact, wanted);
    const size = jsonBytes(person);
    if (results.length > 0 && bytes + size > 900000) break;
    bytes += size;
    results.push({ person });
  }
  return { results };
}

export function listOtherContacts(input, context) {
  const { caller } = begin(context, input);
  requireScope(
    context,
    caller,
    [SCOPES.CONTACTS, SCOPES.CONTACTS_READONLY, SCOPES.CONTACTS_OTHER_READONLY],
    PEOPLE,
    "google.people.v1.PeopleService.ListOtherContacts",
  );
  const wanted = parseOtherContactMask(context, input.readMask);
  const limit = pageSize(context, input.pageSize, 1, 1000, 100);
  const rows = scanPrefix(context, "other-contacts", `${caller.user.id}:`).map((row) => row.value);
  rows.sort((a, b) => (a.sortName < b.sortName ? -1 : a.sortName > b.sortName ? 1 : a.otherContactId < b.otherContactId ? -1 : 1));

  const scope = `otherContacts:${caller.user.id}`;
  const otherKey = (row) => [row.sortName, row.otherContactId];
  const start = resumeIndex(context, input.pageToken, scope, rows, (row) => row.otherContactId, otherKey);

  const { entries, nextIndex } = fillPage(
    rows,
    start,
    limit,
    (row) => renderOtherContact(row, wanted),
    () => outOfRange(context, "A single other contact is larger than the maximum response size for this simulation."),
  );
  const out = { otherContacts: entries, totalSize: rows.length };
  if (nextIndex < rows.length) out.nextPageToken = mintKeyedToken(scope, rows[nextIndex].otherContactId, otherKey(rows[nextIndex]));
  return out;
}
