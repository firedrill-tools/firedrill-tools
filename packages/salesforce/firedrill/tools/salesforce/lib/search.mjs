// Parameterized search (`POST …/parameterizedSearch`): free-text prefix matching over the name,
// e-mail and phone fields of the readable record sObjects, with `*`/`?` wildcards, per-sObject
// `fields`/`where`/`orderBy`/`limit`, `in` scopes and sharing. No relevance ranking.

import { RECORD_TYPES, fieldByName, nameFieldOf } from "./schema.mjs";
import { renderPaths, requireReadableType, resolvePath, visibleRows } from "./records.mjs";
import { chargeFilterWork, compileOrder, compilePredicate, parseOrder, parseWhere, tooLargeMessage } from "./soql.mjs";
import { clip, fieldsOf, permissions, recordError, valueOf } from "./state.mjs";
import { compileTerms, prepareHaystack } from "./match.mjs";
import { RESPONSE_BYTE_BUDGET, byteBudget, jsonBytes } from "./bytes.mjs";

const SCOPES = {
  NAME: ["Name", "FirstName", "LastName", "Company", "Subject"],
  EMAIL: ["Email"],
  PHONE: ["Phone", "MobilePhone"],
  SIDEBAR: ["Name", "FirstName", "LastName", "Company", "Subject", "Email", "Phone"],
  ALL: ["Name", "FirstName", "LastName", "Company", "Subject", "Email", "Phone", "MobilePhone", "Website", "Title", "Description"],
};
const MAX_OVERALL = 2000;

/** Split the search string into terms (quoted phrases stay together). */
function terms(text) {
  const out = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const term = (match[1] ?? match[2]).trim();
    if (term.length > 0) out.push(term);
  }
  return out;
}


/** Execute a parameterized search body; returns `{ searchRecords }`. */
export function parameterizedSearch(session, input, version) {
  const q = typeof input.q === "string" ? input.q.trim() : "";
  if (q.length < 2) throw recordError("MALFORMED_QUERY", "MALFORMED_SEARCH: search term must be at least two characters");
  if (q.length > 200) throw recordError("MALFORMED_QUERY", "MALFORMED_SEARCH: search term must be at most 200 characters");
  const scope = typeof input.in === "string" ? input.in.toUpperCase() : "ALL";
  const scopeFields = Object.hasOwn(SCOPES, scope) ? SCOPES[scope] : undefined;
  if (scopeFields === undefined) throw recordError("MALFORMED_QUERY", `MALFORMED_SEARCH: unknown search scope '${clip(input.in)}'`);
  const parts = terms(q);
  if (parts.length === 0) throw recordError("MALFORMED_QUERY", "MALFORMED_SEARCH: search term must contain at least one word");
  // Every term runs in one linear pass over each record's folded haystack.
  const matcher = compileTerms(parts);
  const overallLimit = Number.isInteger(input.overallLimit) ? Math.min(input.overallLimit, MAX_OVERALL) : MAX_OVERALL;
  const defaultLimit = Number.isInteger(input.defaultLimit) ? input.defaultLimit : null;
  const globalFields = Array.isArray(input.fields) ? input.fields : null;

  const requested = Array.isArray(input.sobjects) && input.sobjects.length > 0
    ? input.sobjects
    : RECORD_TYPES.filter((type) => permissions(session, type).read).map((name) => ({ name }));

  const searchRecords = [];
  // Search has no paging: results that would encode past the response budget fail LIMIT_EXCEEDED.
  const budget = byteBudget(RESPONSE_BYTE_BUDGET, jsonBytes({ searchRecords: [] }));
  const seenTypes = new Set();
  for (const entry of requested) {
    if (typeof entry !== "object" || entry === null || typeof entry.name !== "string") throw recordError("JSON_PARSER_ERROR", "sobjects entries must carry a name");
    const type = requireReadableType(session, entry.name);
    // Each sObject may appear once, so one request scans each type at most once.
    if (seenTypes.has(type)) throw recordError("MALFORMED_QUERY", `MALFORMED_SEARCH: duplicate sObject type '${clip(type)}' in sobjects`);
    seenTypes.add(type);
    const fields = fieldsOf(session, type);
    const searchable = scopeFields.map((name) => fieldByName(fields, name)).filter((field) => field !== null);
    const wanted = Array.isArray(entry.fields) ? entry.fields : (globalFields ?? ["Id", nameFieldOf(type)]);
    const paths = wanted.map((path) => resolvePath(session, type, String(path), "entity"));
    const where = typeof entry.where === "string" && entry.where.trim().length > 0 ? parseWhere(entry.where) : null;
    const predicate = where !== null ? compilePredicate(session, type, where) : null;
    const order = typeof entry.orderBy === "string" && entry.orderBy.trim().length > 0 ? compileOrder(session, type, parseOrder(entry.orderBy)) : null;
    if (entry.fields !== undefined && !Array.isArray(entry.fields)) throw recordError("JSON_PARSER_ERROR", "sobjects[].fields must be an array of field names");
    if (entry.limit !== undefined && !Number.isInteger(entry.limit)) throw recordError("JSON_PARSER_ERROR", "sobjects[].limit must be an integer");
    const limit = Number.isInteger(entry.limit) ? entry.limit : defaultLimit;
    let rows = visibleRows(session, type).filter((row) => {
      const haystack = searchable.map((field) => valueOf(type, row, field.name)).filter((value) => value !== null).map(String).join(" \n ");
      return matcher(prepareHaystack(haystack));
    });
    if (predicate !== null) {
      chargeFilterWork(session, where, rows.length);
      rows = rows.filter(predicate);
    }
    if (order !== null) rows = order(rows);
    if (limit !== null) rows = rows.slice(0, Math.max(0, limit));
    for (const row of rows) {
      if (searchRecords.length >= overallLimit) break;
      const record = renderPaths(session, type, row, version, paths);
      if (!budget.admit(record)) throw recordError("LIMIT_EXCEEDED", tooLargeMessage(RESPONSE_BYTE_BUDGET));
      searchRecords.push(record);
    }
  }
  return { searchRecords };
}
