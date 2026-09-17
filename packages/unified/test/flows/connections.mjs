// Drills unified-connections-flow and unified-mcp-core-aliases (admin, baseline).
import { ALIASES, ALL_OPERATIONS, C, NEW, NONE, NOW, WS, apiError, assert, del, get, ids, mcp, mcpError, mcpInit, patch, post, put, rpc, walk } from "../lib.mjs";

const U = "/unified/connection";

export async function connections() {
  const listed = (await get(U)).json;
  assert.deepEqual(ids(listed), [C.main, C.readonly, C.chat, C.mail, C.paused, C.broken, C.hris], "Sandbox connections are hidden by default");
  for (const row of listed) assert.ok(!Object.hasOwn(row.auth, "token") && !Object.hasOwn(row.auth, "access_token"), "auth carries no secrets");
  assert.deepEqual(ids((await get(`${U}?env=Sandbox`)).json), [C.sandbox, C.omni]);
  assert.deepEqual(ids((await get(`${U}?env=Sandbox&categories=crm,messaging`)).json), [C.omni], "a connection may carry several categories");
  assert.deepEqual((await get(`/crm/${C.omni}/contact`)).json, [], "the omni Sandbox connection holds no data");
  assert.deepEqual((await get(`/messaging/${C.omni}/channel`)).json, []);
  assert.deepEqual(ids((await get(`${U}?categories=messaging`)).json), [C.chat, C.mail]);
  assert.deepEqual((await get(`${U}?categories=crm,messaging`)).json, [], "every listed category must be present");
  assert.deepEqual(ids((await get(`${U}?external_xref=acct-northwind`)).json), [C.readonly]);
  assert.equal((await get(`${U}?sort=name&order=asc`)).json[0].integration_name, "BambooHR");
  assert.deepEqual(ids((await get(`${U}?updated_gte=2026-09-12T00:00:00Z`)).json), [C.main, C.chat, C.mail]);
  assert.equal((await walk(U, 2, [2, 2, 2, 1])).length, 7);
  await apiError("GET", `${U}?env=Staging`, 400, "env must be Production or Sandbox");
  await apiError("GET", `${U}?categories=parking`, 400, "not a supported category");
  const chat = (await get(`${U}/${C.chat}`)).json;
  assert.equal(chat.integration_type, "slack");
  assert.equal(chat.workspace_id, WS);
  await apiError("GET", `${U}/${NONE}`, 404, "Connection not found");

  await apiError("POST", U, 400, "integration_type is required", { body: {} });
  await apiError("POST", U, 400, "requires the messaging category", { body: { integration_type: "zoho", categories: ["crm"], permissions: ["messaging_message_read"] } });
  await apiError("POST", U, 400, "not a supported category", { body: { integration_type: "zoho", categories: ["parking"] } });
  await apiError("POST", U, 400, "Invalid value for integration_type", { body: { integration_type: "Zoho CRM", categories: ["crm"] } });
  const zoho = (await post(U, { integration_type: "zoho", categories: ["crm"], permissions: ["crm_contact_read", "crm_contact_write"], external_xref: "acct-zoho", auth: { name: "Zed", emails: ["zed@example.org"], user_id: "u-zed" } })).json;
  assert.equal(zoho.id, NEW(1));
  assert.equal(zoho.integration_name, "Zoho");
  assert.equal(zoho.is_paused, false);
  assert.equal(zoho.environment, "Production");
  assert.equal(zoho.last_healthy_at, NOW);
  assert.equal(zoho.created_at, NOW);
  assert.deepEqual(zoho.auth, { name: "Zed", emails: ["zed@example.org"], user_id: "u-zed" });
  assert.equal((await get(U)).json.length, 8, "seven Production connections plus the new one");

  const Z = `/crm/${NEW(1)}`;
  assert.deepEqual((await get(`${Z}/contact`)).json, [], "a new connection starts empty");
  const first = (await post(`${Z}/contact`, { name: "First" })).json;
  assert.equal(first.id, NEW(2));
  const narrowed = (await patch(`${U}/${NEW(1)}`, { permissions: ["crm_contact_read"] })).json;
  assert.deepEqual(narrowed.permissions, ["crm_contact_read"]);
  await apiError("POST", `${Z}/contact`, 403, "crm_contact_write", { body: { name: "Second" } });
  assert.equal((await get(`${Z}/contact`)).json.length, 1);
  await apiError("PATCH", `${U}/${NEW(1)}`, 400, "cannot be changed", { body: { categories: ["hris"] } });
  await apiError("PATCH", `${U}/${NEW(1)}`, 400, "requires the messaging category", { body: { permissions: ["messaging_message_read"] } });
  await apiError("PATCH", `${U}/${NONE}`, 404, "Connection not found", { body: { external_xref: "x" } });
  const relabelled = (await put(`${U}/${NEW(1)}`, { external_xref: "acct-z2", environment: "Sandbox" })).json;
  assert.equal(relabelled.external_xref, "acct-z2");
  assert.equal(relabelled.environment, "Sandbox");
  assert.deepEqual(relabelled.permissions, ["crm_contact_read"], "PUT merges like PATCH");
  assert.equal((await get(U)).json.length, 7, "the connection moved to Sandbox");
  await apiError("DELETE", `${U}/${NONE}`, 404, "Connection not found");
  assert.deepEqual((await del(`${U}/${NEW(1)}`)).json, {});
  await apiError("GET", `${Z}/contact`, 404, "Connection not found");
  await apiError("GET", `${U}/${NEW(1)}`, 404, "Connection not found");
  assert.equal((await get(`${U}?env=Sandbox`)).json.length, 2);
}

export async function mcpAliases() {
  await mcpInit();
  const tools = (await rpc("tools/list", {})).tools.map((tool) => tool.name);
  for (const alias of ALIASES) assert.ok(tools.includes(alias), `alias ${alias} missing`);
  for (const operationId of ALL_OPERATIONS) assert.ok(tools.includes(`unified.${operationId}`), `canonical unified.${operationId} missing`);
  assert.equal(tools.length, ALIASES.length + ALL_OPERATIONS.length);

  const first = (await mcp("list_unified_connections", { limit: 3 })).result;
  assert.deepEqual(ids(first), [C.main, C.readonly, C.chat]);
  const rest = (await mcp("list_unified_connections", { limit: 3, offset: 3 })).result;
  assert.deepEqual(ids(rest), [C.mail, C.paused, C.broken]);
  assert.deepEqual(ids((await mcp("list_unified_connections", { offset: 6 })).result), [C.hris]);
  assert.equal((await mcp("get_unified_connection", { id: C.mail })).integration_type, "gmail");
  const created = await mcp("create_unified_connection", { integration_type: "zoho", categories: ["crm"], permissions: ["crm_contact_read"], external_xref: "acct-mcp" });
  assert.equal(created.id, NEW(1));
  assert.equal(created.integration_name, "Zoho");
  const updated = await mcp("update_unified_connection", { id: NEW(1), external_xref: "acct-mcp-2" });
  assert.equal(updated.external_xref, "acct-mcp-2");
  assert.equal((await mcp("unified.connections.get", { id: NEW(1) })).external_xref, "acct-mcp-2", "canonical name sees the alias write");
  assert.deepEqual(await mcp("remove_unified_connection", { id: NEW(1) }), {});
  await mcpError("get_unified_connection", { id: NONE }, "NOT_FOUND");
  await mcpError("get_unified_connection", { id: NEW(1) }, "NOT_FOUND");
  assert.equal((await mcp("list_unified_connections", {})).result.length, 7);
}
