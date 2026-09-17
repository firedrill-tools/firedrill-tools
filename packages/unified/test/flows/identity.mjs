// Drills unified-scoped-token, unified-invalid-workspace, unified-denied, unified-fresh-actor, plus the table of one
// representative request per operation shared by the whole-surface drills (ghost, rate-limited, many-workspaces).
import { C, CH, CO, D, K, MSG, NEW, NONE, PL, apiError, assert, get, ids, mcpError, mcpInit, post } from "../lib.mjs";

const M = `/crm/${C.main}`;
const H = `/messaging/${C.chat}`;

/** One request per operation that succeeds against baseline for the admin actor (used where a fault or identity rule fires first). */
export const ALL_CALLS = [
  ["connections.list", "GET", "/unified/connection"],
  ["connections.get", "GET", `/unified/connection/${C.chat}`],
  ["connections.create", "POST", "/unified/connection", { integration_type: "zoho", categories: ["crm"], permissions: [] }],
  ["connections.update", "PATCH", `/unified/connection/${C.chat}`, { external_xref: "probe" }],
  ["connections.remove", "DELETE", `/unified/connection/${C.hris}`],
  ["contacts.list", "GET", `${M}/contact`],
  ["contacts.get", "GET", `${M}/contact/${K.elena}`],
  ["contacts.create", "POST", `${M}/contact`, { name: "Probe" }],
  ["contacts.update", "PATCH", `${M}/contact/${K.elena}`, { title: "Probe" }],
  ["contacts.remove", "DELETE", `${M}/contact/${K.ravi}`],
  ["companies.list", "GET", `${M}/company`],
  ["companies.get", "GET", `${M}/company/${CO.northwind}`],
  ["companies.create", "POST", `${M}/company`, { name: "Probe Co" }],
  ["companies.update", "PUT", `${M}/company/${CO.northwind}`, { industry: "Probe" }],
  ["companies.remove", "DELETE", `${M}/company/${CO.tailspin}`],
  ["deals.list", "GET", `${M}/deal`],
  ["deals.get", "GET", `${M}/deal/${D.q4}`],
  ["deals.create", "POST", `${M}/deal`, { name: "Probe deal" }],
  ["deals.update", "PATCH", `${M}/deal/${D.q4}`, { description: "Probe" }],
  ["deals.remove", "DELETE", `${M}/deal/${D.inbound}`],
  ["pipelines.list", "GET", `${M}/pipeline`],
  ["pipelines.get", "GET", `${M}/pipeline/${PL.sales}`],
  ["channels.list", "GET", `${H}/channel`],
  ["channels.get", "GET", `${H}/channel/${CH.general}`],
  ["messages.list", "GET", `${H}/message`],
  ["messages.get", "GET", `${H}/message/${MSG(1)}`],
  ["messages.create", "POST", `${H}/message`, { message: "probe", channels: [{ id: CH.sales }] }],
  ["messages.update", "PATCH", `${H}/message/${MSG(2)}`, { message: "probe" }],
  ["messages.remove", "DELETE", `${H}/message/${MSG(4)}`],
];

/** Sends every representative request expecting the same status and message fragment; returns the responses. */
export async function expectAll(status, fragment) {
  const results = [];
  for (const [operationId, method, path, body] of ALL_CALLS) {
    const result = await apiError(method, path, status, fragment, body === undefined ? {} : { body });
    results.push([operationId, result]);
  }
  return results;
}

export async function scoped() {
  assert.deepEqual(ids((await get("/unified/connection")).json), [C.chat], "a scoped key lists only its connections");
  await apiError("GET", `/unified/connection/${C.main}`, 404, "Connection not found");
  await apiError("GET", `${M}/contact`, 404, "Connection not found");
  assert.equal((await get(`${H}/message`)).json.length, 16);
  await apiError("POST", "/unified/connection", 403, "Connection-scoped tokens cannot create connections", { body: { integration_type: "zoho", categories: ["crm"] } });
  await apiError("DELETE", `/unified/connection/${C.main}`, 404, "Connection not found");
}

export async function ghost() {
  const results = await expectAll(401, "Unauthorized");
  assert.equal(results.length, 29);
  for (const [, result] of results) assert.equal(result.json.error, "Unauthorized");
  await mcpInit();
  const failure = await mcpError("list_unified_connections", {}, "UNAUTHORIZED");
  assert.equal(failure.status, "tool_error");
}

export async function denied() {
  for (const [method, path, body] of [["GET", "/unified/connection"], ["GET", `${M}/contact`], ["POST", `${H}/message`, { message: "x", channels: [{ id: CH.sales }] }]]) {
    const result = await apiError(method, path, 403, "Forbidden", body === undefined ? {} : { body });
    assert.equal(result.json.error, "Forbidden");
  }
}

export async function fresh() {
  assert.equal((await get("/unified/connection")).json.length, 7, "a fresh-install actor sees the seeded workspace");
  assert.equal((await get(`${M}/contact`)).json.length, 8);
  const created = (await post(`${M}/contact`, { name: "Fresh", emails: [{ email: "fresh@example.org" }] })).json;
  assert.equal(created.id, NEW(1));
  assert.equal((await get(`${M}/contact/${NEW(1)}`)).json.name, "Fresh");
  assert.deepEqual(ids((await get(`${M}/contact?updated_gte=2026-09-15`)).json), [K.sam, NEW(1)], "zone-less updated_gte is accepted as UTC");
  assert.notEqual(NONE, NEW(1));
}
