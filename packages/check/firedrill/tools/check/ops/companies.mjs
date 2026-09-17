// Companies (read-only) and workplaces.
import { requireKey, inScope } from "../lib/access.mjs";
import { nowStamp } from "../lib/dates.mjs";
import { nextId } from "../lib/ids.mjs";
import { keyComparator, limitArg, pageOf } from "../lib/paging.mjs";
import { mustFind } from "../lib/records.mjs";
import { companyOut, workplaceOut } from "../lib/serialize.mjs";
import { scanAll } from "../lib/store.mjs";
import { taxTable } from "../lib/tax.mjs";
import { address, bool, hasOwn, metadata, requireField, text } from "../lib/validate.mjs";
import { boolFilter, cursorArg, idFilter, nameKey, refFilter } from "./common.mjs";

export function companiesList(input, context) {
  const key = requireKey(context, false);
  const filters = {};
  const active = boolFilter(context, input, filters, "active", true);
  const ids = idFilter(context, input, filters);
  const limit = limitArg(context, input, 25);
  const cursor = cursorArg(context, input);
  const rows = scanAll(context, "companies")
    .filter((row) => inScope(key, row.id) && row.active === active && (ids === undefined || ids.has(row.id)))
    .sort((a, b) => keyComparator()([a.legal_name, a.seq], [b.legal_name, b.seq]));
  return pageOf(context, {
    resource: "companies", path: "/companies", rows, filters, limit, cursor, keyTypes: ["s", "i"],
    keyOf: (row) => [row.legal_name, row.seq], compare: keyComparator(), map: companyOut, extra: { server_time: nowStamp(context) },
  });
}

export function companiesGet(input, context) {
  const key = requireKey(context, false);
  return companyOut(mustFind(context, key, "companies", input.company, "company"));
}

export function workplacesList(input, context) {
  const key = requireKey(context, false);
  const filters = {};
  const company = refFilter(context, input, filters, "company", "com");
  const ids = idFilter(context, input, filters);
  const limit = limitArg(context, input, 500);
  const cursor = cursorArg(context, input);
  const keyOf = (row) => [nameKey(row.name), row.seq];
  const compare = keyComparator();
  const rows = scanAll(context, "workplaces")
    .filter((row) => inScope(key, row.company) && (company === undefined || row.company === company) && (ids === undefined || ids.has(row.id)))
    .sort((a, b) => compare(keyOf(a), keyOf(b)));
  return pageOf(context, { resource: "workplaces", path: "/workplaces", rows, filters, limit, cursor, keyTypes: ["s", "i"], keyOf, compare, map: workplaceOut });
}

export function workplacesCreate(input, context) {
  const key = requireKey(context, true);
  requireField(context, input, "company");
  requireField(context, input, "address");
  const name = hasOwn(input, "name") ? text(context, input.name, "name", 200, { nullable: true }) : null;
  const active = hasOwn(input, "active") ? bool(context, input.active, "active") : true;
  const meta = hasOwn(input, "metadata") ? metadata(context, input.metadata) : {};
  const company = mustFind(context, key, "companies", input.company, "company");
  const addr = address(context, input.address, "address", taxTable(context).supported_states);
  const { id, seq } = nextId(context, "wrk", "workplaces");
  const row = { id, seq, company: company.id, name, address: addr, active, metadata: meta, created_at: nowStamp(context) };
  context.state.put("workplaces", id, row);
  return workplaceOut(row);
}
