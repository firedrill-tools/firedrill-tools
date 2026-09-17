// Fault and bound drills: rate-limited, write-unavailable, write-committed-lost, bounds, many-workspaces, large-channels.
import { C, CH, CO, NEW, apiError, assert, get, ids, mcpError, mcpInit, post } from "../lib.mjs";
import { ALL_CALLS, expectAll } from "./identity.mjs";

const M = `/crm/${C.main}`;
const H = `/messaging/${C.chat}`;

export async function rateLimited() {
  const results = await expectAll(429, "Too many requests to Unified.to");
  for (const [operationId, result] of results) {
    assert.equal(result.headers.get("retry-after"), "1", `${operationId}: Retry-After header`);
    assert.equal(result.json.error, "Too Many Requests");
  }
  await mcpInit();
  await mcpError("list_unified_connections", {}, "RATE_LIMITED");
}

export async function writeUnavailable() {
  const writes = ALL_CALLS.filter(([operationId]) => /\.(create|update|remove)$/.test(operationId));
  assert.equal(writes.length, 15);
  for (const [, method, path, body] of writes) {
    const result = await apiError(method, path, 500, "Internal Server Error", body === undefined ? {} : { body });
    assert.equal(result.json.error, "Internal Server Error");
  }
  // PUT routes share the operation with PATCH: both are unavailable.
  await apiError("PUT", `${M}/contact/68c800000000000000000501`, 500, "Internal Server Error", { body: { title: "x" } });
  assert.equal((await get(`${M}/contact`)).json.length, 8, "reads keep working and nothing was written");
  assert.equal((await get("/unified/connection")).json.length, 7);
}

export async function writeCommittedLost() {
  await apiError("POST", `${H}/message`, 500, "Internal Server Error", { body: { message: "Ship it", channels: [{ id: CH.sales }] } });
  const latest = (await get(`${H}/message?channel_id=${CH.sales}&sort=created_at&order=desc&limit=1`)).json;
  assert.deepEqual(ids(latest), [NEW(1)], "the message was committed although the response was lost");
  assert.equal(latest[0].message, "Ship it");
  // A blind client retry posts a duplicate.
  await apiError("POST", `${H}/message`, 500, "Internal Server Error", { body: { message: "Ship it", channels: [{ id: CH.sales }] } });
  assert.deepEqual(ids((await get(`${H}/message?channel_id=${CH.sales}&query=ship`)).json), [NEW(1), NEW(2)]);
  assert.equal((await get(`${H}/message?channel_id=${CH.sales}`)).json.length, 7);
}

export async function bounds() {
  const contacts = await apiError("GET", `${M}/contact`, 500, "State exceeds the supported bound of 5 rows for contacts");
  assert.equal(contacts.json.error, "Internal Server Error");
  await apiError("GET", `${H}/message?limit=1`, 500, "bound of 5 rows for messages");
  await apiError("GET", "/unified/connection", 500, "bound of 5 rows for connections");
  assert.equal((await get(`${M}/company`)).json.length, 5, "a namespace within the bound still lists");
  await apiError("POST", `${M}/contact`, 500, "bound of 5 rows for contacts", { body: { name: "Over" } });
  await apiError("DELETE", `/unified/connection/${C.main}`, 500, "bound of 5 rows", {});
  assert.equal((await get(`/unified/connection/${C.main}`)).json.id, C.main, "the cascade refused instead of half-deleting");
}

export async function manyWorkspaces() {
  const results = await expectAll(500, "State exceeds the supported bound of 100 rows for workspaces");
  assert.equal(results.length, 29);
  await mcpInit();
  await mcpError("list_unified_connections", {}, "FAILED_PRECONDITION");
}

export async function largeChannels() {
  const tooLarge = await apiError("GET", `${H}/channel`, 413, "Response exceeds 1 MB");
  assert.equal(tooLarge.json.error, "Payload Too Large");
  await apiError("GET", `${H}/channel?limit=100`, 413, "Response exceeds 1 MB");
  const sizes = [];
  const seen = [];
  for (let offset = 0; ; offset += 1) {
    const result = await get(`${H}/channel?limit=1&offset=${offset}`);
    assert.ok(Buffer.byteLength(result.text) <= 900000, "each page stays within the budget");
    sizes.push(result.json.length);
    seen.push(...ids(result.json));
    if (result.json.length < 1) break;
  }
  assert.equal(seen.length, 6, "every channel appears exactly once when paged");
  assert.equal(new Set(seen).size, 6);
  const projected = (await get(`${H}/channel?fields=id,name,description`)).json;
  assert.equal(projected.length, 6, "a projection without members fits one page");
  assert.equal(projected.filter((row) => row.name.startsWith("all-hands-")).length, 2);
  assert.equal((await get(`${H}/channel?fields=id,name&limit=100`)).json.length, 6);
  assert.equal((await get(`${H}/channel?limit=1&offset=4`)).json[0].members.length, 350);
  assert.equal((await get(`${H}/channel/68c800000000000000070000`)).json.members.length, 350);
  assert.equal((await get(`${M}/company`)).json.length, 5, CO.northwind);
}
