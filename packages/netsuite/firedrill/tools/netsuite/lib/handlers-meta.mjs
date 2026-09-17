// The MCP-shaped record reads, the record-type metadata catalog and the two SuiteQL operations.
import { quote } from "./errors.mjs";
import { requireId } from "./primitives.mjs";
import { open } from "./session.mjs";
import { collection, paging } from "./collections.mjs";
import { projectSubsidiary } from "./project-tran.mjs";
import { KINDS, loadRecord, projectOne } from "./handlers-read.mjs";
import { catalog, describe, RECORD_TYPES } from "./metadata.mjs";
import { executeSql } from "./suiteql-select.mjs";
import { SqlError } from "./suiteql-parse.mjs";

const BY_RESOURCE = new Map(Object.entries(KINDS).map(([kind, definition]) => [definition.resource, kind]));
const SQL_MAX_ROWS = 1000;
const SUITEQL_PATH = "/services/rest/query/v1/suiteql";

function runQuery(session, statement, params) {
  if (typeof statement !== "string" || statement.trim().length === 0) {
    session.fail("INVALID_REQUEST", "A SuiteQL request must carry a non-empty q value.");
  }
  try {
    return executeSql(session, statement, params);
  } catch (error) {
    if (error instanceof SqlError) {
      session.fail("INVALID_REQUEST", `Invalid SuiteQL statement: ${error.message}.`);
    }
    throw error;
  }
}

function boundParams(session, params) {
  if (params === undefined) return [];
  if (!Array.isArray(params)) {
    session.fail("INVALID_PARAMETER", "The params value must be an array of bind values.", { errorPath: "params" });
  }
  return params;
}

export const metaOperations = {
  "record.get": (input, context) => {
    const session = open(context);
    const recordType = input.recordType;
    if (typeof recordType !== "string" || !RECORD_TYPES.includes(recordType)) {
      session.fail("INVALID_CONTENT", `Record type ${quote(String(recordType))} is not supported by this service.`, {
        errorPath: "recordType",
      });
    }
    if (recordType === "subsidiary") {
      session.permit("LIST_SUBSIDIARY", "view");
      requireId(context, input.recordId, "id");
      const row = session.get("subsidiaries", input.recordId);
      if (row === null || !session.inScope(row.id)) {
        session.fail("NONEXISTENT_ID", `Invalid subsidiary reference key ${quote(String(input.recordId))}.`);
      }
      const index = new Map(session.rows("subsidiaries").map((entry) => [entry.id, entry]));
      return projectSubsidiary(row, index);
    }
    const kind = BY_RESOURCE.get(recordType);
    session.permit(KINDS[kind].permission, "view");
    const row = loadRecord(session, kind, input.recordId);
    return projectOne(session, kind, row, true);
  },

  "record.metadata": (input, context) => {
    const session = open(context);
    session.permit("SETUP_RECORD_METADATA", "view");
    if (input.recordType === undefined) return catalog(session.now);
    if (typeof input.recordType !== "string" || !RECORD_TYPES.includes(input.recordType)) {
      session.fail("INVALID_CONTENT", `Record type ${quote(String(input.recordType))} is not supported by this service.`, {
        errorPath: "recordType",
      });
    }
    return describe(input.recordType, session.now);
  },

  "suiteql.query": (input, context) => {
    const session = open(context);
    session.permit("REPO_ANALYTICS", "view");
    const prefer = typeof input.prefer === "string" ? input.prefer.toLowerCase() : "";
    if (!prefer.split(",").map((entry) => entry.trim()).includes("transient")) {
      session.fail("INVALID_REQUEST", "The Prefer: transient header is required for SuiteQL requests.", {
        errorHeader: "Prefer",
      });
    }
    const { limit, offset } = paging(session, input, 10);
    const rows = runQuery(session, input.q, boundParams(session, input.params));
    const entries = rows.slice(offset, offset + limit).map((row) => ({
      links: [{ rel: "self", href: SUITEQL_PATH }],
      ...row,
    }));
    return collection(session, SUITEQL_PATH, entries, { limit, offset, total: rows.length });
  },

  "suiteql.run": (input, context) => {
    const session = open(context);
    session.permit("REPO_ANALYTICS", "view");
    const rows = runQuery(session, input.query, []);
    const items = rows.slice(0, SQL_MAX_ROWS);
    return { items, count: items.length, hasMore: rows.length > items.length, totalResults: rows.length };
  },
};
