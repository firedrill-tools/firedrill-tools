// Messaging channels: read-only list and get. `has_subchannels` is computed from the connection's `parent_id` rows
// at read time; the internal `alias` field (INBOX/SENT/DRAFT resolution for messages) is never returned.
import { enumFilter, finishPage, idFilter, matchesQuery, parseFields, parseListParams, project, sortRows, updatedSince } from "../lib/query.mjs";
import { open, requireId, rowsOf } from "./resource.mjs";

const SPEC = { namespace: "channels", label: "Channel", category: "messaging", permission: "messaging_channel" };
const HIDDEN = ["alias"];

const parentsOf = (rows) => {
  const parents = new Set();
  for (const row of rows) if (typeof row.parent_id === "string") parents.add(row.parent_id);
  return parents;
};

const withSubchannels = (row, parents) => ({ ...row, has_subchannels: parents.has(row.id) });

export const channels = {
  list(input, context) {
    const { workspace, connection } = open(input, context, SPEC, "read");
    const params = parseListParams(input, context);
    const fields = parseFields(input, context);
    const parentId = idFilter(input, context, "parent_id");
    const type = enumFilter(input, context, "type", ["PUBLIC", "PRIVATE"]);
    const all = rowsOf(context, workspace, SPEC, connection.id);
    const parents = parentsOf(all);
    const rows = all
      .filter(
        (row) =>
          updatedSince(row, params.updatedGteUs) &&
          matchesQuery(row, params.query, ["name", "description"]) &&
          (parentId === null || row.parent_id === parentId) &&
          (type === null || row.is_private === (type === "PRIVATE")),
      )
      .map((row) => withSubchannels(row, parents));
    sortRows(rows, params.sort, params.order, "name");
    return finishPage(context, rows, params, fields, HIDDEN);
  },
  get(input, context) {
    const { workspace, connection } = open(input, context, SPEC, "read");
    const fields = parseFields(input, context);
    const row = requireId(context, SPEC, connection.id, input.id);
    const parents = parentsOf(rowsOf(context, workspace, SPEC, connection.id));
    return project(withSubchannels(row, parents), fields, HIDDEN);
  },
};
