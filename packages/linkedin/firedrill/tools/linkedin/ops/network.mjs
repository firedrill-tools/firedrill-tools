// network_sizes.get and connections.list.
import { caller, checkWire, requireScope, urnField } from "../lib/auth.mjs";
import { fail, invalidValue, missing, notFound } from "../lib/errors.mjs";
import { buildPage, pageArgs } from "../lib/paging.mjs";
import { liteProfile } from "../lib/render.mjs";
import { scanPrefix, scanValues } from "../lib/store.mjs";
import { fold } from "../lib/text.mjs";

export function getNetworkSize(input, context) {
  const who = caller(context);
  checkWire(context, input, "GET");
  const entity = urnField(context, "entity", input.entity, ["organization", "person"], { inPath: input.wire !== undefined });
  if (entity.type === "organization") {
    requireScope(context, who, ["rw_organization_admin", "r_organization_social"], "GET /networkSizes");
    if (input.edgeType === undefined || input.edgeType === null) missing(context, "edgeType");
    if (input.edgeType !== "COMPANY_FOLLOWED_BY_MEMBER") invalidValue(context, "edgeType", input.edgeType);
    const org = context.state.get("organizations", entity.id);
    if (org === null) notFound(context, `Organization ${entity.id} is inactive`);
    return { firstDegreeSize: org.followerCount };
  }
  requireScope(context, who, ["r_1st_connections_size"], "GET /connections");
  if (input.edgeType !== undefined && input.edgeType !== null) invalidValue(context, "edgeType", input.edgeType);
  if (entity.id !== who.personId) fail(context, "ACCESS_DENIED", `Not enough permissions to access: GET /connections for ${entity.urn}`);
  return { firstDegreeSize: scanPrefix(context, "connections", `${who.personId}|`).length };
}

export function listConnections(input, context) {
  const who = caller(context);
  requireScope(context, who, ["r_1st_connections_size"], "GET /connections");
  const query = input.query ?? "";
  if (typeof query !== "string" || query.length > 100 || query.includes("�")) invalidValue(context, "query", query);
  const { start, count } = pageArgs(context, input, { defaultCount: 20, maxCount: 100 });
  const needle = fold(query.trim());
  const rows = [];
  for (const edge of scanValues(context, "connections", `${who.personId}|`)) {
    const person = context.state.get("people", edge.connectedPersonId);
    if (person === null) continue;
    const haystacks = [person.firstName, person.lastName, person.headline ?? ""].map(fold);
    if (needle !== "" && !haystacks.some((text) => text.includes(needle))) continue;
    rows.push({ person, connectedAt: edge.connectedAtMs });
  }
  rows.sort((a, b) => b.connectedAt - a.connectedAt || (a.person.id < b.person.id ? -1 : a.person.id > b.person.id ? 1 : 0));
  return buildPage(context, rows, (row) => ({ person: liteProfile(row.person), connectedAt: row.connectedAt }), {
    start, count, path: "/v1/operations/linkedin/connections.list", query: needle === "" ? [] : [["query", query]],
  });
}
