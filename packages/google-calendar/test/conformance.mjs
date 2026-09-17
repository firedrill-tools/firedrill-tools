// Google Calendar Tool conformance target. A scripted Tool test, not a model-driven agent.
// Uses only Node built-ins: fetch against the Calendar API v3-shaped routes, the canonical
// /v1/operations endpoint, and raw MCP JSON-RPC (Streamable HTTP) for Google's Calendar MCP tool names.
//
// Coverage note: `firedrill tool test` requires every declared error of every operation to be observed,
// so this script deliberately triggers each of them. The 50-calendars-per-user bound (FAILED_PRECONDITION on
// calendars.insert) is reached by inserting secondary calendars in a loop; the 2,000-instance expansion cap
// (FAILED_PRECONDITION on events.list / events.instances / events.search) by expanding an unbounded daily
// series over seven years.
import assert from "node:assert/strict";

let task = "";
for await (const chunk of process.stdin) task += chunk;
const invocation = JSON.parse(task);
const instruction = String(invocation.instruction ?? "");

const HTTP = process.env.FIREDRILL_HTTP_URL;
const HTTP_TOKEN = process.env.FIREDRILL_HTTP_TOKEN;
const MCP = process.env.FIREDRILL_MCP_URL;
const MCP_TOKEN = process.env.FIREDRILL_MCP_TOKEN;
assert.ok(HTTP && HTTP_TOKEN && MCP && MCP_TOKEN, "HTTP and MCP bindings are required");

const DANA = "dana.reyes@example.test";
const SAM = "sam.okafor@example.test";
const PRIYA = "priya.natarajan@example.com";
const TEAM = "c_st000000000000000000000001@group.calendar.google.com";
const HOLIDAYS = "c_st000000000000000000000002@group.calendar.google.com";
const AURORA = "room-aurora@resource.calendar.google.com";
const ID = (n) => `st${String(n).padStart(24, "0")}`;
const E = { standup: ID(1), designReview: ID(2), holiday: ID(3), focus: ID(4), ooo: ID(5), cancelled: ID(6), invoice: ID(7), oneOnOne: ID(8), planning: ID(9), review: ID(10), contract: ID(11), dentist: ID(12), retro: ID(13), coffee: ID(16) };
const V3 = `${HTTP}/calendar/v3`;
const WEEK = "timeMin=2026-09-14T00:00:00Z&timeMax=2026-09-21T00:00:00Z";

// ---------------------------------------------------------------------------------------------
// Transport helpers
// ---------------------------------------------------------------------------------------------

async function rest(method, path, { body, status = 200, headers = {} } = {}) {
  const response = await fetch(path.startsWith("http") ? path : `${V3}${path}`, {
    method,
    headers: { authorization: `Bearer ${HTTP_TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const json = text.length > 0 ? JSON.parse(text) : undefined;
  assert.equal(response.status, status, `${method} ${path} -> ${response.status} ${text.slice(0, 400)}`);
  return { json, headers: response.headers, status: response.status };
}

/** Expect the Calendar API error envelope with the given HTTP status and `reason`. */
async function restError(method, path, status, reason, options = {}) {
  const result = await rest(method, path, { ...options, status });
  assert.ok(result.json?.error?.errors, `expected a Calendar error envelope for ${method} ${path}: ${JSON.stringify(result.json)}`);
  assert.equal(result.json.error.code, status);
  assert.equal(result.json.error.errors[0].reason, reason, JSON.stringify(result.json));
  return result;
}

async function op(operationId, args, expected = "ok") {
  const response = await fetch(`${HTTP}/v1/operations/google-calendar/${operationId}`, {
    method: "POST",
    headers: { authorization: `Bearer ${HTTP_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ arguments: args }),
  });
  const json = await response.json();
  assert.ok(json.outcome, `canonical ${operationId}: ${JSON.stringify(json).slice(0, 400)}`);
  if (expected === "ok") {
    assert.equal(json.outcome.status, "ok", `${operationId}: ${JSON.stringify(json.outcome).slice(0, 400)}`);
    return json.outcome.value;
  }
  assert.equal(json.outcome.status, "tool_error", `${operationId}: ${JSON.stringify(json.outcome).slice(0, 400)}`);
  assert.equal(json.outcome.error.code, `tool.${expected}`, JSON.stringify(json.outcome.error));
  return json.outcome.error;
}

let rpcId = 0;
async function rpc(method, params) {
  const response = await fetch(MCP, {
    method: "POST",
    headers: { authorization: `Bearer ${MCP_TOKEN}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  assert.equal(response.status, 200, `MCP ${method} -> HTTP ${response.status}`);
  const text = await response.text();
  const type = response.headers.get("content-type") ?? "";
  const messages = type.includes("text/event-stream")
    ? text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5).trim()))
    : [JSON.parse(text)];
  const reply = messages.find((message) => message.id === rpcId);
  assert.ok(reply, `MCP ${method}: no JSON-RPC reply`);
  if (reply.error) throw new Error(`MCP ${method} failed: ${JSON.stringify(reply.error)}`);
  return reply.result;
}

async function mcpInit() {
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "google-calendar-conformance", version: "0.1.0" } });
}

async function mcp(name, args) {
  const result = await rpc("tools/call", { name, arguments: args });
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result).slice(0, 500)}`);
  return result.structuredContent;
}

async function mcpError(name, args, code) {
  const result = await rpc("tools/call", { name, arguments: args });
  assert.ok(result.isError, `${name} unexpectedly succeeded: ${JSON.stringify(result).slice(0, 300)}`);
  const error = result.structuredContent?.error;
  assert.ok(error, `${name}: ${JSON.stringify(result).slice(0, 400)}`);
  if (code) assert.equal(error.code, code, JSON.stringify(error));
  return result.structuredContent;
}

const ids = (items) => items.map((item) => item.id);
const q = (params) => new URLSearchParams(params).toString();
const timed = (day, from, to, zone = "Europe/London", offset = "+01:00") => ({
  start: { dateTime: `2026-${day}T${from}:00${offset}`, timeZone: zone },
  end: { dateTime: `2026-${day}T${to}:00${offset}`, timeZone: zone },
});

// ---------------------------------------------------------------------------------------------
// Drill: rest-flow (owner = Dana, baseline)
// ---------------------------------------------------------------------------------------------

async function restFlow() {
  // Colours and settings ---------------------------------------------------------------------
  const colors = (await rest("GET", "/colors")).json;
  assert.equal(colors.kind, "calendar#colors");
  assert.equal(Object.keys(colors.calendar).length, 24);
  assert.equal(Object.keys(colors.event).length, 11);
  assert.deepEqual(colors.event["11"], { background: "#dc2127", foreground: "#1d1d1d" });

  const settings = (await rest("GET", "/users/me/settings")).json;
  assert.equal(settings.kind, "calendar#settings");
  assert.equal(settings.items.length, 8);
  assert.ok(!("serverTime" in settings), "the REST settings resource carries no server time");
  assert.equal((await op("settings.list", {})).serverTime, "2026-09-14T09:00:00Z", "the canonical settings read exposes the world's virtual now");
  assert.equal(settings.items.find((item) => item.id === "timezone").value, "Europe/London");
  assert.equal((await rest("GET", "/users/me/settings/weekStart")).json.value, "1");
  await restError("GET", "/users/me/settings/notASetting", 404, "notFound");
  await restError("GET", "/users/me/settings?pageToken=stale", 400, "invalid");

  // Calendar list ----------------------------------------------------------------------------
  const list = (await rest("GET", "/users/me/calendarList")).json;
  assert.equal(list.kind, "calendar#calendarList");
  assert.deepEqual(ids(list.items), [DANA, HOLIDAYS, TEAM], "primary first, then by summary; hidden Aurora excluded");
  assert.ok(!("serverTime" in list), "the REST calendarList resource carries no server time");
  assert.equal((await op("calendar-list.list", {})).serverTime, "2026-09-14T09:00:00Z", "the canonical calendar list exposes the world's virtual now");
  assert.equal(list.items[0].primary, true);
  assert.equal(list.items[0].accessRole, "owner");
  assert.equal((await rest("GET", "/users/me/calendarList?showHidden=true")).json.items.length, 4);
  assert.deepEqual(ids((await rest("GET", "/users/me/calendarList?minAccessRole=writer&showHidden=true")).json.items), [DANA, TEAM]);
  const page1 = (await rest("GET", "/users/me/calendarList?showHidden=true&maxResults=2")).json;
  assert.equal(page1.items.length, 2);
  assert.ok(page1.nextPageToken);
  const page2 = (await rest("GET", `/users/me/calendarList?showHidden=true&maxResults=2&pageToken=${encodeURIComponent(page1.nextPageToken)}`)).json;
  assert.equal(page2.items.length, 2);
  assert.equal(page2.nextPageToken, undefined);
  await restError("GET", `/users/me/calendarList?maxResults=2&pageToken=${encodeURIComponent(page1.nextPageToken)}`, 400, "invalid", {});
  await restError("GET", "/users/me/calendarList?pageToken=not-a-token", 400, "invalid");
  assert.equal((await rest("GET", `/users/me/calendarList/${TEAM}`)).json.accessRole, "owner");
  assert.equal((await rest("GET", `/users/me/calendarList/${AURORA}`)).json.hidden, true);
  await restError("GET", "/users/me/calendarList/nobody@example.org", 404, "notFound");
  const recoloured = (await rest("PATCH", `/users/me/calendarList/${TEAM}`, { body: { colorId: "3", selected: false } })).json;
  assert.equal(recoloured.colorId, "3");
  assert.equal(recoloured.backgroundColor, "#f83a22");
  assert.equal(recoloured.selected, false);
  await restError("PATCH", `/users/me/calendarList/${TEAM}`, 400, "invalid", { body: { colorId: "99" } });
  await restError("PATCH", `/users/me/calendarList/${TEAM}`, 412, "conditionNotMet", { body: { selected: true }, headers: { "if-match": '"3000000000000000000"' } });
  await restError("PATCH", "/users/me/calendarList/nobody@example.org", 404, "notFound", { body: { selected: true } });
  assert.equal((await rest("PATCH", `/users/me/calendarList/${TEAM}`, { body: { selected: true }, headers: { "if-match": recoloured.etag } })).json.selected, true);

  // Calendars --------------------------------------------------------------------------------
  assert.equal((await rest("GET", `/calendars/${TEAM}`)).json.summary, "Platform Team");
  assert.equal((await rest("GET", "/calendars/primary")).json.id, DANA);
  await restError("GET", "/calendars/nobody@example.org", 404, "notFound");
  const client = (await rest("POST", "/calendars", { body: { summary: "Client projects", timeZone: "Europe/Berlin" } })).json;
  assert.equal(client.kind, "calendar#calendar");
  assert.match(client.id, /^c_[a-v0-9]{26}@group\.calendar\.google\.com$/);
  assert.equal((await rest("GET", `/users/me/calendarList/${client.id}`)).json.accessRole, "owner");
  assert.equal((await rest("PATCH", `/calendars/${client.id}`, { body: { timeZone: "Europe/Paris", description: "Customer-facing milestones" } })).json.timeZone, "Europe/Paris");
  await restError("PATCH", `/calendars/${client.id}`, 400, "invalid", { body: { timeZone: "Mars/Olympus_Mons" } });
  await restError("PATCH", `/calendars/${client.id}`, 412, "conditionNotMet", { body: { summary: "x" }, headers: { "if-match": '"3000000000000000000"' } });
  await restError("PATCH", `/calendars/${HOLIDAYS}`, 403, "requiredAccessLevel", { body: { summary: "Renamed" } });
  await restError("PATCH", "/calendars/nobody@example.org", 404, "notFound", { body: { summary: "x" } });
  await restError("POST", "/calendars", 400, "invalid", { body: { summary: "Broken zone", timeZone: "Nowhere/Nope" } });
  await restError("DELETE", "/calendars/primary", 403, "forbidden");
  await restError("DELETE", "/calendars/nobody@example.org", 404, "notFound");
  await restError("DELETE", `/calendars/${HOLIDAYS}`, 403, "requiredAccessLevel");

  // Malformed identifiers: whitespace-only, whitespace-padded, control-character and over-long ids can name no calendar or
  // event, so every route and operation answers Google's 404 notFound (never a handler crash); nothing is written.
  const BLANK_CALENDAR_IDS = ["%20", "%09", "%20%20%20", "%E2%80%83", "%20primary", "primary%20", `%20${encodeURIComponent(TEAM)}`];
  for (const bad of BLANK_CALENDAR_IDS) {
    await restError("GET", `/calendars/${bad}/events`, 404, "notFound");
    await restError("GET", `/calendars/${bad}`, 404, "notFound");
  }
  await restError("DELETE", "/calendars/%20", 404, "notFound");
  await restError("PATCH", "/calendars/%20", 404, "notFound", { body: { summary: "x" } });
  await restError("POST", "/calendars/%20/events", 404, "notFound", { body: { summary: "Blank calendar", ...timed("09-23", "10:00", "11:00") } });
  await restError("POST", "/calendars/%09/events/quickAdd?text=Lunch%20tomorrow", 404, "notFound");
  await restError("GET", "/users/me/calendarList/%20", 404, "notFound");
  await restError("PATCH", "/users/me/calendarList/%0A", 404, "notFound", { body: { selected: true } });
  await restError("GET", `/calendars/%20/events/${E.focus}`, 404, "notFound");
  await restError("GET", `/calendars/%20/events/${E.standup}/instances`, 404, "notFound");
  await restError("PATCH", `/calendars/%20/events/${E.focus}`, 404, "notFound", { body: { summary: "x" } });
  await restError("PUT", `/calendars/%20/events/${E.focus}`, 404, "notFound", { body: { summary: "x", ...timed("09-23", "10:00", "11:00") } });
  await restError("DELETE", `/calendars/%20/events/${E.focus}`, 404, "notFound");
  await restError("POST", `/calendars/%20/events/${E.focus}/move?destination=${encodeURIComponent(TEAM)}`, 404, "notFound");
  await restError("POST", `/calendars/primary/events/${E.focus}/move?destination=%20`, 404, "notFound");
  await restError("GET", "/calendars/primary/events/%20%20%20%20%20", 404, "notFound");
  await restError("GET", `/calendars/primary/events/%20${E.focus}`, 404, "notFound");
  await restError("GET", `/calendars/primary/events/${"a".repeat(600)}`, 404, "notFound");
  await restError("POST", "/calendars/primary/events", 400, "invalid", { body: { id: "a".repeat(600), summary: "Over-long id", ...timed("09-23", "10:00", "11:00") } });

  // Route fuzz retrofit (2026-09-16): JSON bodies nested past 512 levels answer 400 in decode, before argument validation.
  const deepObject = (depth) => `${'{"a":'.repeat(depth)}1${"}".repeat(depth)}`;
  const deepArray = (depth) => `${"[".repeat(depth)}1${"]".repeat(depth)}`;
  // envelope: "guard" = refused by the depth guard in decode (framework envelope);
  // "google" = the guard let it through and the operation's own validation refused it (Google error envelope).
  const deepBody = async (method, path, rawBody, envelope) => {
    const response = await fetch(`${V3}${path}`, {
      method,
      headers: { authorization: `Bearer ${HTTP_TOKEN}`, "content-type": "application/json" },
      body: rawBody,
    });
    const text = await response.text();
    assert.equal(response.status, 400, `${method} ${path} deep body -> ${response.status} ${text.slice(0, 300)}`);
    assert.ok(!/RangeError|call stack/i.test(text), `deep body must not leak a runtime error: ${text.slice(0, 300)}`);
    if (!envelope) return;
    const payload = JSON.parse(text);
    if (envelope === "guard") {
      assert.equal(payload.code, "framework.HTTP_REQUEST_MAPPING_FAILED", `expected the depth guard to refuse: ${text.slice(0, 300)}`);
      assert.match(String(payload.error), /nested more than 512 levels deep/);
    } else {
      assert.ok(Array.isArray(payload.error?.errors), `expected validation (Google envelope), got: ${text.slice(0, 300)}`);
      assert.ok(payload.code === undefined, `the guard must not fire at the bound: ${text.slice(0, 300)}`);
    }
  };
  await deepBody("POST", "/calendars", `{"summary":${deepArray(2995)}}`);
  await deepBody("POST", "/calendars", `{"summary":${deepObject(3155)}}`);
  await deepBody("PATCH", `/calendars/${TEAM}`, `{"summary":${deepArray(2995)}}`);
  await deepBody("PATCH", `/calendars/${TEAM}`, `{"summary":${deepObject(3155)}}`);
  await deepBody("PATCH", `/users/me/calendarList/${TEAM}`, `{"defaultReminders":${deepArray(2995)}}`);
  await deepBody("PATCH", `/users/me/calendarList/${TEAM}`, `{"defaultReminders":${deepObject(3155)}}`);
  await deepBody("POST", "/freeBusy", `{"items":${deepArray(2995)}}`);
  await deepBody("POST", "/freeBusy", `{"items":${deepObject(3155)}}`);
  await deepBody("POST", "/calendars/primary/events", `{"summary":${deepObject(513)}}`);
  await deepBody("PATCH", `/calendars/primary/events/${E.focus}`, `{"description":${deepArray(513)}}`);
  await deepBody("PUT", `/calendars/primary/events/${E.focus}`, deepObject(1000));
  // At the bound (total depth 512: the outer object plus 511 nested levels) the guard does not fire; the body
  // reaches argument validation and is still answered 400, never 5xx. One level deeper is refused by the guard.
  await deepBody("POST", "/calendars", `{"summary":${deepObject(511)}}`, "google");
  await deepBody("POST", "/calendars", `{"summary":${deepObject(512)}}`, "guard");
  for (const calendarId of [" ", "\t", "   ", "\u00a0", " primary", "primary ", `${TEAM}\n`, "\u0000"]) {
    await op("calendars.get", { calendarId }, "NOT_FOUND");
    await op("calendar-list.get", { calendarId }, "NOT_FOUND");
    await op("events.list", { calendarId }, "NOT_FOUND");
  }
  await op("calendars.delete", { calendarId: " " }, "NOT_FOUND");
  await op("calendars.patch", { calendarId: "\t", summary: "x" }, "NOT_FOUND");
  await op("calendar-list.patch", { calendarId: " ", selected: true }, "NOT_FOUND");
  await op("events.get", { calendarId: " ", eventId: E.focus }, "NOT_FOUND");
  await op("events.get", { eventId: "     " }, "NOT_FOUND");
  await op("events.insert", { calendarId: " ", summary: "Blank", startTime: "2026-09-23T10:00:00+01:00", endTime: "2026-09-23T11:00:00+01:00" }, "NOT_FOUND");
  await op("events.quick-add", { calendarId: " ", text: "Lunch tomorrow" }, "NOT_FOUND");
  await op("events.patch", { calendarId: " ", eventId: E.focus, summary: "x" }, "NOT_FOUND");
  await op("events.delete", { calendarId: " ", eventId: E.focus }, "NOT_FOUND");
  await op("events.respond", { calendarId: " ", eventId: E.oneOnOne, responseStatus: "accepted" }, "NOT_FOUND");
  await op("events.instances", { calendarId: " ", eventId: E.standup }, "NOT_FOUND");
  await op("events.move", { calendarId: " ", eventId: E.focus, destination: TEAM }, "NOT_FOUND");
  await op("events.move", { eventId: E.focus, destination: " " }, "NOT_FOUND");
  const blankBusy = await op("freebusy.query", { timeMin: "2026-09-14T00:00:00Z", timeMax: "2026-09-15T00:00:00Z", items: [{ id: " " }, { id: "\t" }, { id: "primary" }] });
  assert.deepEqual(blankBusy.calendars[" "], { errors: [{ domain: "global", reason: "notFound" }] });
  assert.deepEqual(blankBusy.calendars["\t"], { errors: [{ domain: "global", reason: "notFound" }] });
  assert.ok(Array.isArray(blankBusy.calendars.primary.busy));
  // Forged page tokens: wrong length, non-zero trailing bits, and well-formed base64url of a JSON value with the wrong shape.
  for (const token of ["A", "AB", "e30", "bnVsbA", "WzFd", "____"]) await restError("GET", `/users/me/calendarList?maxResults=2&pageToken=${token}`, 400, "invalid");
  // Forged token contents: a real token's scope with a position tuple that is not the endpoint's key shape
  // (objects whose coercion throws, nested arrays, null, wrong length, wrong position types) is an invalid page token.
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const scopeOfToken = (token) => JSON.parse(Buffer.from(token, "base64url").toString("utf8")).s;
  const listToken = (await rest("GET", "/users/me/calendarList?maxResults=1")).json.nextPageToken;
  const eventsToken = (await rest("GET", `/calendars/primary/events?${WEEK}&maxResults=1`)).json.nextPageToken;
  const instancesToken = (await rest("GET", `/calendars/${TEAM}/events/${E.standup}/instances?${WEEK}&maxResults=1`)).json.nextPageToken;
  const searchToken = (await op("events.search", { query: "priya", pageSize: 1 })).nextPageToken;
  const badTuples = [[{ toString: 1 }], [[1], [2]], [null, "x"], [], [0, "a", "b", "c"], ["0", "x", "y"]];
  for (const a of badTuples) {
    await restError("GET", `/users/me/calendarList?maxResults=1&pageToken=${b64({ s: scopeOfToken(listToken), a })}`, 400, "invalid");
    await restError("GET", `/calendars/primary/events?${WEEK}&maxResults=1&pageToken=${b64({ s: scopeOfToken(eventsToken), a })}`, 400, "invalid");
    await restError("GET", `/calendars/${TEAM}/events/${E.standup}/instances?${WEEK}&maxResults=1&pageToken=${b64({ s: scopeOfToken(instancesToken), a })}`, 400, "invalid");
    await op("events.search", { query: "priya", pageSize: 1, pageToken: b64({ s: scopeOfToken(searchToken), a }) }, "INVALID_PAGE_TOKEN");
  }
  await op("calendar-list.list", { pageSize: 1, pageToken: b64({ s: scopeOfToken(listToken), a: [0, "x", "y"], extra: 1 }) }, "INVALID_PAGE_TOKEN");
  assert.equal((await rest("GET", `/users/me/calendarList?maxResults=1&pageToken=${encodeURIComponent(listToken)}`)).json.items.length, 1, "genuine tokens still page");
  // Far-future recurrence: expansion fast-forwards to the window, so year-9999 instance ids and windows answer promptly.
  const farInstance = `${E.standup}_99991231T093000Z`;
  assert.equal((await rest("GET", `/calendars/${TEAM}/events/${farInstance}`)).json.start.dateTime, "9999-12-31T09:30:00Z");
  const notAnInstance = `${E.standup}_99991231T235959Z`;
  await restError("GET", `/calendars/${TEAM}/events/${notAnInstance}`, 404, "notFound");
  await restError("PATCH", `/calendars/${TEAM}/events/${notAnInstance}`, 404, "notFound", { body: { summary: "Never" } });
  await restError("DELETE", `/calendars/${TEAM}/events/${notAnInstance}`, 404, "notFound");
  await op("events.respond", { calendarId: TEAM, eventId: notAnInstance, responseStatus: "accepted" }, "NOT_FOUND");
  const FAR = "timeMin=9999-12-01T00:00:00Z&timeMax=9999-12-31T23:59:59Z";
  assert.equal((await rest("GET", `/calendars/${TEAM}/events?${FAR}&singleEvents=true`)).json.items.length, 14, "MO/WE/FR in December 9999");
  assert.equal((await rest("GET", `/calendars/${TEAM}/events/${E.standup}/instances?${FAR}`)).json.items.length, 14);
  assert.equal((await rest("POST", "/freeBusy", { body: { timeMin: "9999-12-01T00:00:00Z", timeMax: "9999-12-31T00:00:00Z", items: [{ id: TEAM }] } })).json.calendars[TEAM].busy.length, 13);
  assert.equal((await op("events.search", { query: "standup", startTime: "9999-12-01T00:00:00Z", endTime: "9999-12-31T23:59:59Z" })).events.length, 28, "team standup and its mirrored copy on Dana's primary");
  assert.ok((await op("time.suggest", { attendeeEmails: [DANA], startTime: "9999-12-01T00:00:00Z", endTime: "9999-12-31T00:00:00Z" })).timeSlots.length > 0);
  await restError("GET", `/calendars/${TEAM}/events/${E.standup}/instances?timeMin=2026-01-01T00:00:00Z&timeMax=9999-12-31T00:00:00Z`, 400, "failedPrecondition");
  assert.equal((await rest("GET", `/calendars/primary/events/${E.focus}`)).json.summary, "Focus time", "malformed-id calls wrote nothing");

  // The 50-subscriptions bound: Dana has 5 entries now, so 45 inserts succeed and the 46th fails.
  const extra = [];
  for (let index = 1; index <= 45; index += 1) extra.push((await rest("POST", "/calendars", { body: { summary: `Scratch ${index}` } })).json.id);
  await restError("POST", "/calendars", 400, "failedPrecondition", { body: { summary: "One too many" } });
  for (const id of extra) await rest("DELETE", `/calendars/${id}`, { status: 204 });
  assert.equal((await rest("GET", "/users/me/calendarList?showHidden=true")).json.items.length, 5);

  // Event listing ----------------------------------------------------------------------------
  const week = (await rest("GET", `/calendars/primary/events?${WEEK}&singleEvents=true`)).json;
  assert.equal(week.kind, "calendar#events");
  assert.equal(week.accessRole, "owner");
  assert.equal(week.timeZone, "Europe/London");
  assert.equal(week.items.length, 15, "the working week: 3 standup instances, 11 timed events and the 1:1 copy; cancelled vendor call excluded");
  assert.ok(week.items.every((item) => item.kind === "calendar#event" && !("availability" in item) && !("conferenceUrl" in item)));
  assert.equal(week.items.filter((item) => item.recurringEventId === E.standup).length, 3);
  assert.equal((await rest("GET", `/calendars/primary/events?${WEEK}&singleEvents=true&showDeleted=true`)).json.items.length, 16);
  assert.equal((await rest("GET", `/calendars/primary/events?${WEEK}&singleEvents=true&eventTypes=focusTime`)).json.items.length, 1);
  assert.deepEqual(ids((await rest("GET", `/calendars/primary/events?${WEEK}&singleEvents=true&q=Priya`)).json.items), [E.designReview, E.coffee, E.contract], "matches attendee, summary and organizer");
  assert.equal((await rest("GET", `/calendars/primary/events?${WEEK}&singleEvents=true&q=priya%20lumen`)).json.items.length, 1, "terms are ANDed");
  let seen = [];
  let token;
  let pages = 0;
  do {
    const page = (await rest("GET", `/calendars/primary/events?${WEEK}&singleEvents=true&orderBy=startTime&maxResults=5${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`)).json;
    seen = [...seen, ...ids(page.items)];
    token = page.nextPageToken;
    pages += 1;
  } while (token);
  assert.equal(pages, 3);
  assert.equal(new Set(seen).size, 15, "walking every page yields each event once");
  await restError("GET", `/calendars/primary/events?${WEEK}&pageToken=zzz`, 400, "invalid");
  await restError("GET", "/calendars/primary/events?timeMin=2026-09-21T00:00:00Z&timeMax=2026-09-14T00:00:00Z", 400, "timeRangeEmpty");
  await restError("GET", "/calendars/primary/events?orderBy=startTime", 400, "invalid");
  await restError("GET", "/calendars/primary/events?syncToken=abc", 400, "invalid");
  await restError("GET", "/calendars/nobody@example.org/events", 404, "notFound");
  const teamRecent = (await rest("GET", `/calendars/${TEAM}/events?updatedMin=2026-09-01T00:00:00Z`)).json;
  assert.deepEqual(ids(teamRecent.items), [E.standup], "Q3 planning was updated in August");
  assert.equal((await rest("GET", `/calendars/${TEAM}/events`)).json.items.length, 2);
  const byUpdate = (await rest("GET", `/calendars/${TEAM}/events?orderBy=updated`)).json;
  assert.deepEqual(ids(byUpdate.items), [E.planning, E.standup]);

  // Instances --------------------------------------------------------------------------------
  const instances = (await rest("GET", `/calendars/primary/events/${E.invoice}/instances`)).json;
  assert.equal(instances.items.length, 6, "COUNT=6 with one instance replaced by its exception row");
  assert.ok(instances.items.every((item) => item.recurringEventId === E.invoice));
  assert.equal(instances.items[1].id, `${E.invoice}_20261101T090000Z`);
  assert.equal(instances.items[1].start.dateTime, "2026-11-02T10:00:00Z", "the November exception was moved to the Monday");
  const half = (await rest("GET", `/calendars/primary/events/${E.invoice}/instances?maxResults=4`)).json;
  assert.equal(half.items.length, 4);
  assert.equal((await rest("GET", `/calendars/primary/events/${E.invoice}/instances?maxResults=4&pageToken=${encodeURIComponent(half.nextPageToken)}`)).json.items.length, 2);
  await restError("GET", `/calendars/primary/events/${E.invoice}/instances?pageToken=zzz`, 400, "invalid");
  await restError("GET", `/calendars/primary/events/${E.invoice}/instances?timeMin=2027-01-01T00:00:00Z&timeMax=2026-01-01T00:00:00Z`, 400, "timeRangeEmpty");
  await restError("GET", `/calendars/primary/events/${E.focus}/instances`, 400, "invalid");
  await restError("GET", `/calendars/primary/events/${ID(99)}/instances`, 404, "notFound");

  // Reads ------------------------------------------------------------------------------------
  const oneOnOne = (await rest("GET", `/calendars/primary/events/${E.oneOnOne}?timeZone=Europe/London`)).json;
  assert.equal(oneOnOne.start.dateTime, "2026-09-17T15:00:00+01:00", "10:00 New York rendered in London time");
  assert.equal(oneOnOne.organizer.email, SAM);
  assert.equal(oneOnOne.hangoutLink, "https://meet.google.com/stb-aaaa-bbb");
  assert.equal((await rest("GET", `/calendars/primary/events/${E.cancelled}`)).json.status, "cancelled");
  const wednesday = (await rest("GET", `/calendars/${TEAM}/events/${E.standup}_20260916T083000Z`)).json;
  assert.equal(wednesday.recurringEventId, E.standup);
  assert.equal(wednesday.start.dateTime, "2026-09-16T09:30:00+01:00");
  await restError("GET", `/calendars/primary/events/${ID(99)}`, 404, "notFound");
  await restError("GET", `/calendars/${TEAM}/events/${E.standup}_20260921T083000Z`, 404, "notFound", {}); // excluded by EXDATE
  // events.get validates timeZone like events.list: unknown zones are Calendar 400s, never 500s.
  for (const zone of ["Bad/Zone", "UTC+99", "abc"]) {
    const bad = await restError("GET", `/calendars/${TEAM}/events/${E.standup}?timeZone=${encodeURIComponent(zone)}`, 400, "invalid");
    assert.match(bad.json.error.message, /Invalid time zone/);
  }
  await restError("GET", `/calendars/primary/events/${E.oneOnOne}_20260917T140000Z?timeZone=Bad/Zone`, 400, "invalid");
  // An empty timeZone is Calendar's own invalid-parameter error, not the framework's schema refusal.
  const emptyZone = (await rest("GET", `/calendars/primary/events/${E.oneOnOne}?timeZone=`, { status: 400 })).json;
  assert.equal(emptyZone.error.errors[0].reason, "invalid", "an empty timeZone is Calendar's 400 invalid");
  assert.match(emptyZone.error.message, /Invalid time zone/);
  await op("events.get", { calendarId: TEAM, eventId: E.standup, timeZone: "Bad/Zone" }, "INVALID_ARGUMENT");
  assert.equal((await rest("GET", `/calendars/${TEAM}/events/${E.standup}?timeZone=America/New_York`)).json.start.dateTime, "2026-09-14T04:30:00-04:00");
  const oddItems = (await rest("POST", "/freeBusy", { body: { timeMin: "2026-09-14T00:00:00Z", timeMax: "2026-09-15T00:00:00Z", items: [{ id: "__proto__" }, { id: "constructor" }] } })).json;
  assert.ok(Object.hasOwn(oddItems.calendars, "constructor"), "a caller id named like a prototype member is an ordinary response key");
  assert.equal(oddItems.calendars.constructor.errors[0].reason, "notFound");
  assert.equal({}.errors, undefined, "no prototype was written");
  assert.equal((await rest("GET", "/colors")).json.kind, "calendar#colors", "other routes keep working");

  // Inserts ----------------------------------------------------------------------------------
  const billing = (await rest("POST", "/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all", {
    body: {
      summary: "Billing sync",
      description: "Weekly billing status.",
      ...timed("09-22", "10:00", "10:30"),
      attendees: [{ email: SAM }, { email: PRIYA, optional: true }, { email: AURORA, resource: true }],
      conferenceData: { createRequest: { requestId: "conf-1" } },
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 15 }] },
    },
  })).json;
  assert.equal(billing.id, "fd000000000000000000000001");
  assert.equal(billing.organizer.email, DANA);
  assert.equal(billing.organizer.self, true);
  assert.deepEqual(billing.attendees.map((attendee) => attendee.email), [DANA, SAM, PRIYA, AURORA]);
  assert.equal(billing.attendees[0].organizer, true);
  assert.equal(billing.attendees[2].optional, true);
  assert.equal(billing.attendees[3].responseStatus, "accepted", "rooms accept automatically");
  assert.match(billing.hangoutLink, /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
  assert.equal(billing.conferenceData.conferenceSolution.key.type, "hangoutsMeet");
  assert.equal(billing.htmlLink, `https://www.google.com/calendar/event?eid=${Buffer.from(`${billing.id} ${DANA}`).toString("base64url")}`);
  const roomCopy = (await rest("GET", `/calendars/${AURORA}/events/${billing.id}`)).json;
  assert.equal(roomCopy.organizer.self, undefined);
  assert.equal(roomCopy.iCalUID, billing.iCalUID);
  assert.equal((await rest("POST", "/calendars/primary/events", { body: { id: "fdclientevent001", summary: "Client-supplied id", ...timed("09-23", "09:00", "09:30") } })).json.id, "fdclientevent001");
  await restError("POST", "/calendars/primary/events", 409, "duplicate", { body: { id: "fdclientevent001", summary: "Again", ...timed("09-23", "09:00", "09:30") } });
  await restError("POST", "/calendars/primary/events", 400, "invalid", { body: { summary: "Backwards", ...timed("09-23", "10:00", "09:00") } });
  await restError("POST", "/calendars/primary/events", 400, "timeRangeEmpty", { body: { summary: "Zero length", ...timed("09-23", "10:00", "10:00") } });
  await restError("POST", "/calendars/primary/events", 400, "invalid", { body: { summary: "Bad rule", ...timed("09-23", "10:00", "11:00"), recurrence: ["RRULE:FREQ=HOURLY"] } });
  await restError("POST", `/calendars/${HOLIDAYS}/events`, 403, "requiredAccessLevel", { body: { summary: "Not allowed", ...timed("09-23", "10:00", "11:00") } });
  await restError("POST", "/calendars/nobody@example.org/events", 404, "notFound", { body: { summary: "Nowhere", ...timed("09-23", "10:00", "11:00") } });

  // quickAdd ---------------------------------------------------------------------------------
  const lunch = (await rest("POST", `/calendars/primary/events/quickAdd?${q({ text: "Lunch with Priya tomorrow at 12:30 for 45 minutes at Café Lumen" })}`)).json;
  assert.equal(lunch.id, "fd000000000000000000000002");
  assert.equal(lunch.summary, "Lunch with Priya");
  assert.equal(lunch.location, "Café Lumen");
  assert.equal(lunch.start.dateTime, "2026-09-15T12:30:00+01:00");
  assert.equal(lunch.end.dateTime, "2026-09-15T13:15:00+01:00");
  const holidayQuick = (await rest("POST", `/calendars/primary/events/quickAdd?${q({ text: "Team day on Friday" })}`)).json;
  assert.deepEqual(holidayQuick.start, { date: "2026-09-18" });
  assert.deepEqual(holidayQuick.end, { date: "2026-09-19" });
  await restError("POST", "/calendars/primary/events/quickAdd", 400, "required");
  await restError("POST", `/calendars/${HOLIDAYS}/events/quickAdd?text=Nope`, 403, "requiredAccessLevel");
  await restError("POST", "/calendars/nobody@example.org/events/quickAdd?text=Nope", 404, "notFound");

  // Patches ----------------------------------------------------------------------------------
  const moved = (await rest("PATCH", `/calendars/primary/events/${billing.id}`, { body: { summary: "Billing sync (moved)", start: { dateTime: "2026-09-22T11:00:00+01:00" } } })).json;
  assert.equal(moved.start.dateTime, "2026-09-22T11:00:00+01:00");
  assert.equal(moved.end.dateTime, "2026-09-22T11:30:00+01:00", "changing only the start keeps the duration");
  assert.equal(moved.sequence, 1);
  assert.notEqual(moved.etag, billing.etag);
  assert.equal((await rest("GET", `/calendars/${AURORA}/events/${billing.id}`)).json.summary, "Billing sync (moved)", "shared changes propagate to copies");
  await restError("PUT", `/calendars/primary/events/${billing.id}`, 400, "required", { body: { summary: "Replace", start: { dateTime: "2026-09-22T11:00:00+01:00" } } });
  const replaced = (await rest("PUT", `/calendars/primary/events/${billing.id}`, { body: { summary: "Billing sync (replaced)", ...timed("09-22", "11:00", "11:45") } })).json;
  assert.equal(replaced.description, undefined, "PUT resets unspecified fields");
  assert.equal(replaced.attendees, undefined);
  assert.equal(replaced.reminders.useDefault, true);
  await restError("PATCH", `/calendars/primary/events/${E.contract}`, 403, "forbiddenForNonOrganizer", { body: { summary: "Mine now" } });
  await restError("PATCH", `/calendars/primary/events/${E.cancelled}`, 410, "deleted", { body: { summary: "Revive" } });
  await restError("PATCH", `/calendars/primary/events/${billing.id}`, 412, "conditionNotMet", { body: { summary: "Stale" }, headers: { "if-match": billing.etag } });
  await restError("PATCH", `/calendars/${HOLIDAYS}/events/${E.holiday}`, 403, "requiredAccessLevel", { body: { summary: "Not mine" } });
  await restError("PATCH", `/calendars/primary/events/${ID(99)}`, 404, "notFound", { body: { summary: "Ghost" } });
  await restError("PATCH", `/calendars/primary/events/${billing.id}`, 400, "timeRangeEmpty", { body: timed("09-22", "11:00", "11:00") });
  const december = (await rest("PATCH", `/calendars/primary/events/${E.invoice}_20261201T090000Z`, { body: { summary: "Invoice run (December close)" } })).json;
  assert.equal(december.recurringEventId, E.invoice);
  assert.equal(december.originalStartTime.dateTime, "2026-12-01T09:00:00Z");
  const afterPatch = (await rest("GET", `/calendars/primary/events/${E.invoice}/instances`)).json;
  assert.equal(afterPatch.items.length, 6);
  assert.equal(afterPatch.items.find((item) => item.id === december.id).summary, "Invoice run (December close)");
  const tinted = (await rest("PATCH", `/calendars/primary/events/${E.oneOnOne}`, { body: { colorId: "5" } })).json;
  assert.equal(tinted.colorId, "5", "private fields of a copy may change without being the organizer");

  // Expansion cap ----------------------------------------------------------------------------
  const daily = (await rest("POST", `/calendars/${client.id}/events`, { body: { summary: "Standing check", ...timed("09-14", "08:00", "08:15"), recurrence: ["RRULE:FREQ=DAILY"], attendees: [{ email: SAM }] } })).json;
  assert.equal(daily.recurrence[0], "RRULE:FREQ=DAILY");
  assert.equal(daily.organizer.email, client.id, "events on a secondary calendar are organised by the calendar");
  const far = "timeMin=2026-01-01T00:00:00Z&timeMax=2033-01-01T00:00:00Z";
  await restError("GET", `/calendars/${client.id}/events?${far}&singleEvents=true`, 400, "failedPrecondition");
  await restError("GET", `/calendars/${client.id}/events/${daily.id}/instances?${far}`, 400, "failedPrecondition");
  assert.equal((await rest("GET", `/calendars/${client.id}/events?${WEEK}&singleEvents=true`)).json.items.length, 7);

  // Moves ------------------------------------------------------------------------------------
  const relocated = (await rest("POST", `/calendars/primary/events/${billing.id}/move?destination=${encodeURIComponent(client.id)}`)).json;
  assert.equal(relocated.organizer.email, client.id);
  await restError("GET", `/calendars/primary/events/${billing.id}`, 404, "notFound");
  assert.equal((await rest("GET", `/calendars/${client.id}/events/${billing.id}`)).json.summary, "Billing sync (replaced)");
  await restError("POST", `/calendars/${TEAM}/events/${E.standup}_20260916T083000Z/move?destination=primary`, 400, "invalid");
  await restError("POST", `/calendars/primary/events/fdclientevent001/move?destination=primary`, 400, "invalid");
  await restError("POST", `/calendars/primary/events/fdclientevent001/move?destination=nobody@example.org`, 404, "notFound");
  await restError("POST", `/calendars/primary/events/${E.oneOnOne}/move?destination=${encodeURIComponent(TEAM)}`, 403, "forbiddenForNonOrganizer");
  await restError("POST", `/calendars/primary/events/${E.cancelled}/move?destination=${encodeURIComponent(TEAM)}`, 410, "deleted");
  await restError("POST", `/calendars/primary/events/fdclientevent001/move?destination=${encodeURIComponent(HOLIDAYS)}`, 403, "requiredAccessLevel");
  await rest("POST", `/calendars/${client.id}/events`, { body: { id: "fdclientevent001", summary: "Same id elsewhere", ...timed("09-24", "09:00", "09:30") } });
  await restError("POST", `/calendars/primary/events/fdclientevent001/move?destination=${encodeURIComponent(client.id)}`, 409, "duplicate");

  // Deletes ----------------------------------------------------------------------------------
  await rest("DELETE", "/calendars/primary/events/fdclientevent001", { status: 204 });
  await restError("DELETE", "/calendars/primary/events/fdclientevent001", 410, "deleted");
  assert.equal((await rest("GET", "/calendars/primary/events/fdclientevent001")).json.status, "cancelled");
  await restError("DELETE", `/calendars/primary/events/${ID(99)}`, 404, "notFound");
  await restError("DELETE", `/calendars/${HOLIDAYS}/events/${E.holiday}`, 403, "requiredAccessLevel");

  // Free/busy --------------------------------------------------------------------------------
  const busy = (await rest("POST", "/freeBusy", { body: { timeMin: "2026-09-14T00:00:00Z", timeMax: "2026-09-19T00:00:00Z", items: [{ id: "primary" }, { id: AURORA }, { id: SAM }, { id: "nobody@example.org" }] } })).json;
  assert.equal(busy.kind, "calendar#freeBusy");
  assert.equal(busy.calendars.primary.busy.length, 11, "adjacent intervals merged, the all-day team day blocks Friday; transparent, declined and cancelled events skipped");
  assert.deepEqual(busy.calendars.primary.busy[6], { start: "2026-09-16T08:00:00Z", end: "2026-09-16T08:45:00Z" }, "coffee and the standup merge into one block");
  assert.deepEqual(busy.calendars.primary.busy[10], { start: "2026-09-18T00:00:00Z", end: "2026-09-19T00:00:00Z" }, "the all-day team day is busy for the whole day");
  assert.deepEqual(busy.calendars[AURORA].busy, [{ start: "2026-09-15T13:00:00Z", end: "2026-09-15T14:00:00Z" }]);
  assert.ok(busy.calendars[SAM].busy.some((interval) => interval.start === "2026-09-15T12:00:00Z"), "the private dentist appointment still blocks time");
  assert.deepEqual(busy.calendars["nobody@example.org"], { errors: [{ domain: "global", reason: "notFound" }] });
  await restError("POST", "/freeBusy", 400, "timeRangeEmpty", { body: { timeMin: "2026-09-19T00:00:00Z", timeMax: "2026-09-14T00:00:00Z", items: [{ id: "primary" }] } });
  await restError("POST", "/freeBusy", 400, "invalid", { body: { timeMin: "2026-01-01T00:00:00Z", timeMax: "2026-09-14T00:00:00Z", items: [{ id: "primary" }] } });

  // Calendar deletion cascades ---------------------------------------------------------------
  await rest("DELETE", `/calendars/${client.id}`, { status: 204 });
  await restError("GET", `/users/me/calendarList/${client.id}`, 404, "notFound");
  await restError("GET", `/calendars/${client.id}/events`, 404, "notFound");
  assert.equal((await rest("GET", `/calendars/${AURORA}/events/${billing.id}`)).json.status, "cancelled", "the room lost its copy when the PUT dropped every attendee");
  assert.equal((await op("events.get", { calendarId: DANA, eventId: daily.id }, "NOT_FOUND")).code, "tool.NOT_FOUND");
  assert.deepEqual(ids((await rest("GET", "/users/me/calendarList?showHidden=true")).json.items), [DANA, AURORA, HOLIDAYS, TEAM]);

  // Caller text named like an Object.prototype member: a WKST of __proto__/constructor/toString is an unsupported rule
  // (400 invalid, nothing stored), so every later read of the calendar keeps working; WKST=SU is accepted.
  for (const wkst of ["__proto__", "constructor", "toString"]) {
    const bad = await restError("POST", "/calendars/primary/events", 400, "invalid", { body: { summary: `Week start ${wkst}`, ...timed("09-21", "07:00", "07:15"), recurrence: [`RRULE:FREQ=WEEKLY;WKST=${wkst};COUNT=4`] } });
    assert.match(bad.json.error.message, /WKST/);
    await restError("PATCH", `/calendars/primary/events/${E.focus}`, 400, "invalid", { body: { recurrence: [`RRULE:FREQ=WEEKLY;BYDAY=MO,WE;WKST=${wkst}`] } });
  }
  const sundayStart = (await rest("POST", "/calendars/primary/events", { body: { summary: "Sunday-start series", ...timed("09-21", "07:00", "07:15"), recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO,TH;WKST=SU;COUNT=4"] } })).json;
  assert.equal(sundayStart.recurrence[0], "RRULE:FREQ=WEEKLY;BYDAY=MO,TH;WKST=SU;COUNT=4");
  assert.equal((await rest("GET", `/calendars/primary/events/${sundayStart.id}/instances`)).json.items.length, 4);
  assert.ok((await rest("GET", "/calendars/primary/events")).json.items.length > 0, "the calendar still lists without bounds");
  assert.ok((await rest("GET", `/calendars/primary/events?${WEEK}&singleEvents=true`)).json.items.length > 0, "the calendar still lists with bounds");
  assert.ok((await rest("POST", "/freeBusy", { body: { timeMin: "2026-09-14T00:00:00Z", timeMax: "2026-10-14T00:00:00Z", items: [{ id: "primary" }] } })).json.calendars.primary.busy.length > 0);
  // quickAdd keeps such words in the title instead of reading them as weekdays, months or duration units.
  const constructorMeeting = (await rest("POST", `/calendars/primary/events/quickAdd?${q({ text: "Meet the constructor tomorrow at 10am" })}`)).json;
  assert.equal(constructorMeeting.summary, "Meet the constructor");
  assert.equal(constructorMeeting.start.dateTime, "2026-09-15T10:00:00+01:00");
  const lunchFive = (await rest("POST", `/calendars/primary/events/quickAdd?${q({ text: "Lunch 5 constructor" })}`)).json;
  assert.equal(lunchFive.summary, "Lunch 5 constructor");
  assert.match(lunchFive.start.date, /^\d{4}-\d{2}-\d{2}$/);
  const lunchTwo = (await rest("POST", `/calendars/primary/events/quickAdd?${q({ text: "Lunch at 3pm for 2 __proto__" })}`)).json;
  assert.equal(lunchTwo.summary, "Lunch for 2 __proto__");
  assert.match(lunchTwo.start.dateTime, /T15:00:00\+01:00$/);

  await mangledEncoding();
  await parameterValidation();
}

// ---------------------------------------------------------------------------------------------
// Malformed percent-encoding (U+FFFD) and parameter-envelope probes, run at the end of rest-flow.
// The framework decodes query strings leniently: `%E0%A4%A` arrives as U+FFFD and `%ZZ` stays literal.
// A query-language or time-zone value carrying U+FFFD is a mangled request, not a value to search for.
// ---------------------------------------------------------------------------------------------

const MANGLED = "%E0%A4%A";
const ENCODED_FFFD = "%EF%BF%BD";

async function mangledEncoding() {
  // A legitimate non-ASCII search keeps working: accented text, CJK and emoji all round-trip. ----
  const accented = (await rest("POST", "/calendars/primary/events", { body: { summary: "Café résumé 漢字 🎉 sync", ...timed("09-22", "09:00", "09:30") } })).json;
  for (const term of ["Café", "résumé", "漢字", "🎉"]) {
    const found = (await rest("GET", `/calendars/primary/events?q=${encodeURIComponent(term)}`)).json.items;
    assert.ok(ids(found).includes(accented.id), `search for ${term} finds the event`);
  }
  assert.ok(ids((await op("events.search", { query: "漢字" })).events).includes(accented.id), "canonical search finds CJK text");

  // `%ZZ` is not percent-encoding at all: it stays literal and is searched for verbatim. ---------
  assert.equal((await rest("GET", "/calendars/primary/events?q=%ZZnothing")).json.items.length, 0);
  const literal = (await rest("POST", "/calendars/primary/events", { body: { summary: "Budget %ZZ review", ...timed("09-22", "11:00", "11:30") } })).json;
  assert.deepEqual(ids((await rest("GET", "/calendars/primary/events?q=%ZZ")).json.items), [literal.id], "a literal %ZZ still matches");

  // Mangled and pre-encoded U+FFFD are refused with Calendar's 400 `invalid`, on both spellings. -
  for (const bad of [MANGLED, ENCODED_FFFD]) {
    await restError("GET", `/calendars/primary/events?q=${bad}`, 400, "invalid");
    await restError("GET", `/calendars/primary/events?q=budget${bad}`, 400, "invalid");
    await restError("GET", `/calendars/primary/events?timeZone=${bad}`, 400, "invalid");
    await restError("GET", `/calendars/primary/events/${E.standup}?timeZone=${bad}`, 400, "invalid");
    await restError("GET", `/calendars/${TEAM}/events/${E.standup}/instances?timeZone=${bad}`, 400, "invalid");
    await restError("GET", `/calendars/primary/events?${WEEK}&iCalUID=${bad}`, 400, "invalid");
    await restError("GET", `/calendars/primary/events?timeMin=${bad}`, 400, "invalid");
    await restError("POST", `/calendars/primary/events/quickAdd?text=Lunch${bad}`, 400, "invalid");
    await restError("POST", "/freeBusy", 400, "invalid", { body: { timeMin: "2026-09-14T00:00:00Z", timeMax: "2026-09-15T00:00:00Z", timeZone: "Europe/�ondon", items: [{ id: "primary" }] } });
  }
  for (const value of ["�", "budget �"]) {
    const error = await op("events.search", { query: value }, "INVALID_ARGUMENT");
    assert.match(error.message, /U\+FFFD/, JSON.stringify(error));
    await op("events.list", { calendarId: "primary", fullText: value }, "INVALID_ARGUMENT");
    await op("events.get", { calendarId: "primary", eventId: E.standup, timeZone: value }, "INVALID_ARGUMENT");
  }
  // The refusal never echoes the replacement character back to the caller.
  const echoed = await op("events.get", { calendarId: "primary", eventId: E.standup, timeZone: "Europe/�ondon" }, "INVALID_ARGUMENT");
  assert.ok(!echoed.message.includes("�"), echoed.message);

  // An empty, repeated or non-numeric parameter answers Calendar's envelope, not the framework's. -
  for (const path of [`/calendars/primary/events?timeZone=`, `/calendars/primary/events/${E.standup}?timeZone=`, `/calendars/${TEAM}/events/${E.standup}/instances?timeZone=`]) {
    const empty = await restError("GET", path, 400, "invalid");
    assert.equal(empty.json.error.errors[0].domain, "global");
    assert.match(empty.json.error.message, /Invalid time zone/);
  }
  await restError("GET", "/calendars/primary/events?timeZone=UTC&timeZone=Europe/Paris", 400, "invalid");
  // events.get takes no maxResults, and an unknown query parameter is ignored (it never reaches a handler).
  assert.equal((await rest("GET", `/calendars/primary/events/${E.standup}?maxResults=0`)).json.id, E.standup);
  for (const path of ["/calendars/primary/events?maxResults=0", "/calendars/primary/events?maxResults=1&maxResults=2", "/calendars/primary/events?maxResults=abc"]) {
    await restError("GET", path, 400, "invalid");
  }
  await restError("GET", `/calendars/primary/events/${E.standup}?maxAttendees=0`, 400, "invalid");
  await restError("GET", "/users/me/calendarList?maxResults=0", 400, "invalid");
  await restError("GET", "/users/me/settings?maxResults=0", 400, "invalid");
  await restError("GET", `/calendars/${TEAM}/events/${E.standup}/instances?maxResults=0`, 400, "invalid");
  await op("events.list", { calendarId: "primary", timeZone: "" }, "INVALID_ARGUMENT");
  await op("freebusy.query", { timeMin: "2026-09-14T00:00:00Z", timeMax: "2026-09-15T00:00:00Z", timeZone: "", items: [{ id: "primary" }] }, "INVALID_ARGUMENT");
  await op("events.insert", { calendarId: "primary", summary: "Empty zone", startTime: "2026-09-22T13:00:00Z", endTime: "2026-09-22T13:30:00Z", timeZone: "" }, "INVALID_ARGUMENT");
  await op("calendar-list.list", { pageSize: "0" }, "INVALID_ARGUMENT");
  await op("settings.list", { pageSize: "0" }, "INVALID_ARGUMENT");
  await op("time.suggest", { attendeeEmails: [DANA], startTime: "2026-09-22T08:00:00Z", endTime: "2026-09-22T18:00:00Z", preferences: { pageSize: "0" } }, "INVALID_ARGUMENT");

  // A blank or whitespace event id is a lookup that misses: Calendar's 404, not a schema refusal. -
  for (const eventId of ["%20%20", "%20", "%09"]) {
    await restError("GET", `/calendars/primary/events/${eventId}`, 404, "notFound");
    await restError("PATCH", `/calendars/primary/events/${eventId}`, 404, "notFound", { body: { summary: "x" } });
    await restError("DELETE", `/calendars/primary/events/${eventId}`, 404, "notFound");
  }
  for (const eventId of ["  ", " ", "\t"]) {
    await op("events.get", { calendarId: "primary", eventId }, "NOT_FOUND");
    await op("events.respond", { calendarId: "primary", eventId, responseStatus: "accepted" }, "NOT_FOUND");
  }

  // Years 0-99 are literal years, never 1900-1999 (the Date two-digit-year trap). ----------------
  const ancient = (await rest("POST", "/calendars/primary/events", {
    body: { summary: "Year 50 series", start: { date: "0050-01-01" }, end: { date: "0050-01-02" }, recurrence: ["RRULE:FREQ=YEARLY;COUNT=3"] },
  })).json;
  assert.equal(ancient.start.date, "0050-01-01");
  const ancientInstances = (await rest("GET", `/calendars/primary/events/${ancient.id}/instances`)).json.items;
  assert.deepEqual(ancientInstances.map((item) => item.start.date), ["0050-01-01", "0051-01-01", "0052-01-01"]);
  const untilRun = (await rest("POST", "/calendars/primary/events", {
    body: { summary: "Year 7 weekly", start: { dateTime: "0007-03-01T09:00:00Z" }, end: { dateTime: "0007-03-01T10:00:00Z" }, recurrence: ["RRULE:FREQ=WEEKLY;UNTIL=00070322T000000Z"] },
  })).json;
  // UNTIL is inclusive of the instant itself: a 09:00 occurrence on 0007-03-22 is past UNTIL 00:00:00Z, so three remain.
  const untilItems = (await rest("GET", `/calendars/primary/events/${untilRun.id}/instances`)).json.items;
  assert.deepEqual(untilItems.map((item) => item.start.dateTime.slice(0, 10)), ["0007-03-01", "0007-03-08", "0007-03-15"]);
}

// Repeated singular query parameters and out-of-enum values answer Calendar's 400 `invalid`, never a joined value,
// a silently ignored value or the framework envelope. Nothing here creates or changes state.
async function parameterValidation() {
  const once = /supplied more than once/;
  const repeated = [
    ["GET", "/calendars/primary/events?q=alpha&q=beta", /parameter q:/],
    ["GET", `/calendars/primary/events?timeMin=2026-09-14T00:00:00Z&timeMin=2026-09-15T00:00:00Z&${WEEK.split("&")[1]}`, /parameter timeMin:/],
    ["GET", "/calendars/primary/events?singleEvents=true&orderBy=startTime&orderBy=updated", /parameter orderBy:/],
    ["GET", "/calendars/primary/events?iCalUID=a@example.test&iCalUID=b@example.test", /parameter iCalUID:/],
    ["GET", `/calendars/primary/events/${E.standup}?timeZone=UTC&timeZone=Europe/Paris`, /parameter timeZone:/],
    ["GET", `/calendars/${TEAM}/events/${E.standup}/instances?timeMin=2026-09-14T00:00:00Z&timeMin=2026-09-15T00:00:00Z`, /parameter timeMin:/],
    ["GET", "/users/me/calendarList?minAccessRole=reader&minAccessRole=owner", /parameter minAccessRole:/],
    ["GET", "/users/me/settings?maxResults=1&maxResults=2", /parameter maxResults:/],
    ["POST", "/calendars/primary/events/quickAdd?text=Lunch%20Monday&text=Dinner%20Tuesday", /parameter text:/],
    ["POST", `/calendars/primary/events/${E.standup}/move?destination=${TEAM}&destination=primary`, /parameter destination:/],
    ["DELETE", `/calendars/primary/events/${E.standup}?sendUpdates=all&sendUpdates=none`, /parameter sendUpdates:/],
  ];
  for (const [method, path, field] of repeated) {
    const result = await restError(method, path, 400, "invalid");
    assert.match(result.json.error.message, once, `${method} ${path}`);
    assert.match(result.json.error.message, field, `${method} ${path}`);
  }
  const write = { summary: "Never created", ...timed("09-22", "15:00", "15:30") };
  assert.match((await restError("POST", "/calendars/primary/events?sendUpdates=all&sendUpdates=none", 400, "invalid", { body: write })).json.error.message, once);
  assert.match(
    (await restError("PATCH", `/calendars/primary/events/${E.standup}?conferenceDataVersion=1&conferenceDataVersion=1`, 400, "invalid", { body: { summary: "Never applied" } })).json.error.message,
    once,
  );
  // The refused requests changed nothing: the standup still exists with its seeded summary, and no "Never created" event exists.
  const standup = (await rest("GET", `/calendars/primary/events/${E.standup}`)).json;
  assert.notEqual(standup.summary, "Never applied");
  assert.equal((await rest("GET", "/calendars/primary/events?q=Never%20created")).json.items.length, 0);
  assert.equal((await rest("GET", "/calendars/primary/events?q=Dinner%20Tuesday")).json.items.length, 0);

  // Out-of-enum values: Calendar's 400 `invalid`, not a schema failure; the echoed value is clipped.
  const orderBy = await restError("GET", "/calendars/primary/events?singleEvents=true&orderBy=bogus", 400, "invalid");
  assert.equal(orderBy.json.error.message, "Invalid value for: bogus is not a valid value");
  const longOrderBy = await restError("GET", `/calendars/primary/events?orderBy=${"x".repeat(60)}${encodeURIComponent("é".repeat(60))}`, 400, "invalid");
  assert.ok(longOrderBy.json.error.message.length < 120, longOrderBy.json.error.message);
  assert.ok(longOrderBy.json.error.message.includes("\u2026"), longOrderBy.json.error.message);
  const role = await restError("GET", "/users/me/calendarList?minAccessRole=bogus", 400, "invalid");
  assert.equal(role.json.error.message, "Invalid value for: bogus is not a valid value");
  // minAccessRole is not an events.list parameter: like any unknown query parameter it is ignored on that path.
  assert.ok((await rest("GET", `/calendars/primary/events?${WEEK}&minAccessRole=bogus`)).json.items.length > 0);
  // The valid spellings still work.
  const owned = ids((await rest("GET", "/users/me/calendarList?minAccessRole=owner&showHidden=true")).json.items);
  assert.ok(owned.includes(DANA) && owned.every((id) => [DANA, TEAM].includes(id)), JSON.stringify(owned));
  assert.ok((await rest("GET", `/calendars/${TEAM}/events?orderBy=updated`)).json.items.length > 0);

  // Canonical path: the same refusals as tool.INVALID_ARGUMENT, including the codec-set duplicateParameters argument.
  const canonical = await op("events.list", { calendarId: "primary", orderBy: "bogus" }, "INVALID_ARGUMENT");
  assert.equal(canonical.message, "Invalid value for: bogus is not a valid value");
  await op("calendar-list.list", { minAccessRole: "bogus" }, "INVALID_ARGUMENT");
  assert.match((await op("events.list", { calendarId: "primary", duplicateParameters: ["q"] }, "INVALID_ARGUMENT")).message, /parameter q: .*more than once/);
  assert.match((await op("events.delete", { calendarId: "primary", eventId: E.standup, duplicateParameters: ["sendUpdates"] }, "INVALID_ARGUMENT")).message, once);
  assert.equal((await rest("GET", `/calendars/primary/events/${E.standup}`)).json.status, "confirmed");
  await op("settings.list", { duplicateParameters: ["maxResults"] }, "INVALID_ARGUMENT");
}

// ---------------------------------------------------------------------------------------------
// Drill: mcp-aliases (owner = Dana, baseline)
// ---------------------------------------------------------------------------------------------

async function mcpAliases() {
  await mcpInit();
  const tools = (await rpc("tools/list", {})).tools.map((tool) => tool.name);
  for (const alias of ["list_calendars", "list_events", "search_events", "get_event", "create_event", "update_event", "delete_event", "respond_to_event", "suggest_time"]) {
    assert.ok(tools.includes(alias), `alias ${alias} missing`);
  }
  assert.equal(tools.filter((name) => name.startsWith("google-calendar.")).length, 23, "every canonical name is listed");

  const now = await mcp("google-calendar.time.now", {});
  assert.deepEqual(now, { dateTime: "2026-09-14T10:00:00+01:00", date: "2026-09-14", timeZone: "Europe/London", utc: "2026-09-14T09:00:00Z" });

  const calendars = await mcp("list_calendars", { pageSize: 2, showHidden: true });
  assert.deepEqual(ids(calendars.calendars), [DANA, AURORA]);
  assert.equal(calendars.serverTime, "2026-09-14T09:00:00Z", "the alias carries the world's virtual now too");
  const rest2 = await mcp("list_calendars", { pageSize: 2, showHidden: true, pageToken: calendars.nextPageToken });
  assert.deepEqual(ids(rest2.calendars), [HOLIDAYS, TEAM]);
  assert.equal(rest2.nextPageToken, undefined);

  const reviews = await mcp("list_events", { startTime: "2026-09-14T00:00:00Z", endTime: "2026-09-21T00:00:00Z", fullText: "review" });
  assert.deepEqual(ids(reviews.events), [ID(15), E.designReview], "matches the roadmap sync's description and the design review's summary");
  assert.equal(reviews.events[0].availability, "AVAILABILITY_BUSY");
  const focus = await mcp("list_events", { startTime: "2026-09-14T00:00:00Z", endTime: "2026-09-21T00:00:00Z", eventType: ["FOCUS_TIME"] });
  assert.deepEqual(ids(focus.events), [E.focus]);
  const descending = await mcp("list_events", { startTime: "2026-09-14T00:00:00Z", endTime: "2026-09-21T00:00:00Z", singleEvents: true, orderBy: "startTimeDesc" });
  assert.equal(descending.events[0].id, E.focus, "Friday 13:00 focus time starts last in the week");

  const found = await mcp("search_events", { query: "priya", pageSize: 1 });
  assert.equal(found.events.length, 1);
  assert.equal(found.events[0].calendarId, DANA);
  assert.ok(found.nextPageToken);
  assert.equal((await mcp("search_events", { query: "priya", pageSize: 1, pageToken: found.nextPageToken })).events.length, 1);
  assert.deepEqual(ids((await mcp("search_events", { query: "planning" })).events), [E.planning], "team calendar is searched too");
  await mcpError("search_events", { query: "   " }, "tool.INVALID_ARGUMENT");
  await mcpError("search_events", { query: "priya", startTime: "2026-09-21T00:00:00Z", endTime: "2026-09-14T00:00:00Z" }, "tool.TIME_RANGE_EMPTY");
  await mcpError("search_events", { query: "priya", pageToken: "broken" }, "tool.INVALID_PAGE_TOKEN");

  await mcpError("get_event", { eventId: E.oneOnOne, timeZone: "Mars/Olympus_Mons" }, "tool.INVALID_ARGUMENT");
  const got = await mcp("get_event", { eventId: E.oneOnOne, timeZone: "Europe/London" });
  assert.equal(got.conferenceUrl, "https://meet.google.com/stb-aaaa-bbb");
  assert.equal(got.start.dateTime, "2026-09-17T15:00:00+01:00");

  const offsite = await mcp("create_event", {
    summary: "Team offsite",
    startTime: "2026-10-05T00:00:00Z",
    endTime: "2026-10-07T00:00:00Z",
    allDay: true,
    attendees: [{ email: SAM, optionalAttendee: true }],
    overrideReminders: [{ method: "popup", minutes: 30 }],
    addGoogleMeetUrl: true,
    availability: "AVAILABILITY_FREE",
    notificationLevel: "NONE",
    guestPermissions: { guestsCanModify: true },
  });
  assert.equal(offsite.id, "fd000000000000000000000001");
  assert.deepEqual(offsite.start, { date: "2026-10-05" });
  assert.deepEqual(offsite.end, { date: "2026-10-07" });
  assert.equal(offsite.attendees.find((attendee) => attendee.email === SAM).optional, true);
  assert.equal(offsite.availability, "AVAILABILITY_FREE");
  assert.equal(offsite.transparency, "transparent");
  assert.equal(offsite.guestsCanModify, true);
  assert.deepEqual(offsite.reminders, { useDefault: false, overrides: [{ method: "popup", minutes: 30 }] });
  assert.ok(offsite.conferenceUrl?.startsWith("https://meet.google.com/"));

  const updated = await mcp("update_event", { eventId: offsite.id, addedAttendees: [{ email: PRIYA }], removedAttendeeEmails: [SAM], startTime: "2026-10-06T00:00:00Z" });
  assert.deepEqual(updated.attendees.map((attendee) => attendee.email), [DANA, PRIYA]);
  assert.deepEqual(updated.start, { date: "2026-10-06" });
  assert.deepEqual(updated.end, { date: "2026-10-08" }, "moving the start keeps the two-day length");

  const responded = await mcp("respond_to_event", { eventId: E.oneOnOne, responseStatus: "accepted", responseComment: "See you there" });
  assert.equal(responded.attendees.find((attendee) => attendee.self).responseStatus, "accepted");
  await mcpError("respond_to_event", { eventId: ID(99), responseStatus: "accepted" }, "tool.NOT_FOUND");
  await mcpError("respond_to_event", { calendarId: HOLIDAYS, eventId: E.holiday, responseStatus: "accepted" }, "tool.REQUIRED_ACCESS_LEVEL");
  await mcpError("respond_to_event", { eventId: E.focus, responseStatus: "accepted" }, "tool.INVALID_ARGUMENT");
  await mcpError("respond_to_event", { eventId: E.cancelled, responseStatus: "accepted" }, "tool.GONE");

  const slots = await mcp("suggest_time", { attendeeEmails: [DANA, SAM], startTime: "2026-09-15T09:00:00+01:00", endTime: "2026-09-15T17:00:00+01:00", timeZone: "Europe/London", durationMinutes: 30, preferences: { excludeWeekends: true, pageSize: 3 } });
  assert.equal(slots.timeSlots.length, 3);
  assert.deepEqual(slots.timeSlots[0], { start: { dateTime: "2026-09-15T09:00:00+01:00", timeZone: "Europe/London" }, end: { dateTime: "2026-09-15T09:30:00+01:00", timeZone: "Europe/London" } });
  assert.deepEqual(slots.unresolvedAttendees, []);
  const afternoon = await mcp("suggest_time", { attendeeEmails: [DANA, SAM, "guest@example.org"], startTime: "2026-09-15T13:00:00+01:00", endTime: "2026-09-15T18:00:00+01:00", timeZone: "Europe/London", durationMinutes: 60, preferences: { pageSize: 1 } });
  assert.equal(afternoon.timeSlots[0].start.dateTime, "2026-09-15T15:00:00+01:00", "13:00-14:00 dentist (New York) and 14:00-15:00 review block the early afternoon");
  assert.deepEqual(afternoon.unresolvedAttendees, ["guest@example.org"]);
  await mcpError("suggest_time", { attendeeEmails: [DANA], startTime: "2026-09-15T09:00:00Z", endTime: "2026-09-15T17:00:00Z", preferences: { startHour: "25:00" } }, "tool.INVALID_ARGUMENT");
  await mcpError("suggest_time", { attendeeEmails: [DANA], startTime: "2026-09-15T17:00:00Z", endTime: "2026-09-15T09:00:00Z" }, "tool.TIME_RANGE_EMPTY");

  const dailyCheck = await mcp("create_event", { summary: "Daily check", startTime: "2026-09-14T08:00:00+01:00", endTime: "2026-09-14T08:15:00+01:00", timeZone: "Europe/London", recurrenceData: ["RRULE:FREQ=DAILY"] });
  await mcpError("search_events", { query: "daily check", startTime: "2026-01-01T00:00:00Z", endTime: "2033-01-01T00:00:00Z" }, "tool.FAILED_PRECONDITION");
  assert.equal((await mcp("search_events", { query: "daily check", startTime: "2026-09-14T00:00:00Z", endTime: "2026-09-21T00:00:00Z" })).events.length, 7);
  await mcp("delete_event", { eventId: dailyCheck.id });

  const gone = await mcp("delete_event", { eventId: offsite.id });
  assert.equal(gone.status, "cancelled");

  const canonical = await op("events.instances", { calendarId: TEAM, eventId: E.standup, startTime: "2026-09-14T00:00:00Z", endTime: "2026-09-21T00:00:00Z" });
  assert.equal(canonical.events.length, 3);
  assert.equal(canonical.accessRole, "owner");
  const search = await op("events.search", { query: "standup", startTime: "2026-09-14T00:00:00Z", endTime: "2026-09-21T00:00:00Z" });
  assert.equal(search.events.length, 6, "three instances on the team calendar and three mirrored on the primary");
}

// ---------------------------------------------------------------------------------------------
// Drill: sharing-roles (colleague = Sam, baseline)
// ---------------------------------------------------------------------------------------------

async function sharingRoles() {
  const list = (await rest("GET", "/users/me/calendarList")).json;
  assert.deepEqual(Object.fromEntries(list.items.map((item) => [item.id, item.accessRole])), { [SAM]: "owner", [AURORA]: "freeBusyReader", [HOLIDAYS]: "owner", [TEAM]: "writer" });

  assert.equal((await rest("GET", `/calendars/${TEAM}/events`)).json.items.length, 2);
  const deploy = (await rest("POST", `/calendars/${TEAM}/events`, { body: { summary: "Deploy window", ...timed("09-24", "18:00", "19:00") } })).json;
  assert.equal(deploy.organizer.email, TEAM);
  assert.equal(deploy.creator.email, SAM);
  assert.equal((await rest("GET", `/calendars/${TEAM}/events/${deploy.id}`)).json.summary, "Deploy window");
  await restError("GET", `/calendars/primary/events/${deploy.id}`, 404, "notFound");

  await restError("GET", `/calendars/${AURORA}/events`, 403, "requiredAccessLevel");
  await restError("GET", `/calendars/${AURORA}/events/${E.designReview}`, 403, "requiredAccessLevel");
  await restError("GET", `/calendars/${AURORA}/events/${E.standup}/instances`, 403, "requiredAccessLevel");
  await restError("DELETE", `/calendars/${AURORA}/events/${E.designReview}`, 403, "requiredAccessLevel");
  const room = (await rest("POST", "/freeBusy", { body: { timeMin: "2026-09-14T00:00:00Z", timeMax: "2026-09-19T00:00:00Z", items: [{ id: AURORA }] } })).json;
  assert.deepEqual(room.calendars[AURORA].busy, [{ start: "2026-09-15T13:00:00Z", end: "2026-09-15T14:00:00Z" }], "free/busy readers see busy blocks but no events");

  await restError("GET", `/calendars/${DANA}/events/${E.designReview}`, 404, "notFound", {});
  const copy = (await rest("GET", `/calendars/primary/events/${E.designReview}`)).json;
  assert.equal(copy.organizer.self, undefined);
  assert.equal(copy.attendees.find((attendee) => attendee.email === SAM).self, true);
  await restError("PATCH", `/calendars/primary/events/${E.designReview}`, 403, "forbiddenForNonOrganizer", { body: { summary: "Renamed by a guest" } });
  assert.equal((await rest("PATCH", `/calendars/primary/events/${E.designReview}`, { body: { colorId: "5" } })).json.colorId, "5");
  const retro = (await rest("PATCH", `/calendars/primary/events/${E.retro}`, { body: { summary: "Retro prep (agenda added)" } })).json;
  assert.equal(retro.summary, "Retro prep (agenda added)");
  assert.equal(retro.sequence, 0);

  await mcpInit();
  const declined = await mcp("respond_to_event", { eventId: E.designReview, responseStatus: "declined", responseComment: "Double booked" });
  assert.equal(declined.attendees.find((attendee) => attendee.email === SAM).responseStatus, "declined");

  await rest("DELETE", `/calendars/primary/events/${E.oneOnOne}`, { status: 204 });
  assert.equal((await rest("GET", `/calendars/primary/events/${E.oneOnOne}`)).json.status, "cancelled");

  await restError("PATCH", `/calendars/${TEAM}`, 403, "requiredAccessLevel", { body: { summary: "Platform crew" } });
  await restError("DELETE", `/calendars/${TEAM}`, 403, "requiredAccessLevel");
  await rest("DELETE", `/calendars/${HOLIDAYS}`, { status: 204 });
  assert.deepEqual(ids((await rest("GET", "/users/me/calendarList")).json.items), [SAM, AURORA, TEAM]);
}

// ---------------------------------------------------------------------------------------------
// Drill: denied (auditor, baseline)
// ---------------------------------------------------------------------------------------------

async function denied() {
  const listing = await rest("GET", "/users/me/calendarList", { status: 403 });
  assert.equal(listing.json.error.errors[0].reason, "forbidden");
  assert.equal(listing.json.error.message, "Insufficient Permission");
  await rest("GET", "/calendars/primary/events", { status: 403 });
  await mcpInit();
  const result = await rpc("tools/call", { name: "list_events", arguments: {} });
  assert.ok(result.isError);
  assert.equal(result.structuredContent.status, "denied");
}

// ---------------------------------------------------------------------------------------------
// Drill: write-rate-limited (owner, scenario write-rate-limited)
// ---------------------------------------------------------------------------------------------

async function writeRateLimited() {
  const limited = await restError("POST", "/calendars/primary/events", 403, "rateLimitExceeded", { body: { summary: "Refused", ...timed("09-23", "10:00", "11:00") } });
  assert.equal(limited.headers.get("retry-after"), "30");
  assert.equal(limited.json.error.errors[0].domain, "usageLimits");
  await restError("PATCH", `/calendars/primary/events/${E.focus}`, 403, "rateLimitExceeded", { body: { summary: "Refused" } });
  await restError("DELETE", `/calendars/primary/events/${E.focus}`, 403, "rateLimitExceeded");
  await restError("POST", "/calendars/primary/events/quickAdd?text=Refused%20tomorrow", 403, "rateLimitExceeded");
  await restError("POST", `/calendars/primary/events/${E.focus}/move?destination=${encodeURIComponent(TEAM)}`, 403, "rateLimitExceeded");
  assert.equal((await rest("GET", `/calendars/primary/events/${E.focus}`)).json.status, "confirmed");
  assert.equal((await rest("GET", `/calendars/primary/events?${WEEK}&singleEvents=true`)).json.items.length, 15);
  await mcpInit();
  await mcpError("create_event", { summary: "Refused", startTime: "2026-09-23T10:00:00+01:00", endTime: "2026-09-23T11:00:00+01:00" }, "tool.RATE_LIMITED");
}

// ---------------------------------------------------------------------------------------------
// Drill: backend-error (owner, scenario backend-error)
// ---------------------------------------------------------------------------------------------

async function backendError() {
  const outage = await restError("GET", `/calendars/primary/events?${WEEK}`, 500, "backendError");
  assert.equal(outage.json.error.message, "Backend Error");
  await mcpInit();
  await mcpError("search_events", { query: "priya" }, "tool.BACKEND_ERROR");
  await restError("POST", "/freeBusy", 500, "backendError", { body: { timeMin: "2026-09-14T00:00:00Z", timeMax: "2026-09-19T00:00:00Z", items: [{ id: "primary" }] } });
  await restError("POST", "/calendars/primary/events", 500, "backendError", { body: { summary: "Lost", ...timed("09-23", "10:00", "11:00") } });
  assert.equal((await rest("GET", `/calendars/primary/events/${E.focus}`)).json.summary, "Focus time", "reads by id still work");
  assert.equal((await rest("GET", "/users/me/calendarList")).json.items.length, 3);
}

// ---------------------------------------------------------------------------------------------
// Drill: state-bounds (owner, scenario state-bound)
// ---------------------------------------------------------------------------------------------

const MAX_BODY = 1024 * 1024;

/** GET returning the raw body size alongside the JSON. */
async function restSized(path) {
  const response = await fetch(`${V3}${path}`, { headers: { authorization: `Bearer ${HTTP_TOKEN}` } });
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, 200, `GET ${path} -> ${response.status} ${bytes.toString("utf8").slice(0, 300)}`);
  return { bytes: bytes.length, json: JSON.parse(bytes.toString("utf8")) };
}

/** Follow every page of a list route; each body stays under 1 MiB. Returns [pageSizes, ids]. */
async function allPages(path) {
  const sizes = [];
  const seen = [];
  let token;
  for (let guard = 0; guard < 50; guard += 1) {
    const page = await restSized(`${path}${token === undefined ? "" : `&pageToken=${encodeURIComponent(token)}`}`);
    assert.ok(page.bytes < MAX_BODY, `${path} page of ${page.bytes} bytes`);
    sizes.push(page.json.items.length);
    seen.push(...page.json.items.map((item) => item.id));
    token = page.json.nextPageToken;
    if (token === undefined) return [sizes, seen];
  }
  throw new Error(`${path} did not finish paging`);
}

async function stateBounds() {
  // Scan bound (tool overrides stand in for a world holding more than 10,000 rows): Calendar's 400 envelope, nothing changes.
  await restError("GET", "/users/me/calendarList", 400, "failedPrecondition");
  await restError("DELETE", `/calendars/${TEAM}`, 400, "failedPrecondition");
  await restError("PATCH", `/calendars/primary/events/${E.focus}`, 400, "failedPrecondition", { body: { summary: "Refused" } });
  await restError("PUT", `/calendars/primary/events/${E.focus}`, 400, "failedPrecondition", { body: { summary: "Refused", ...timed("09-15", "13:00", "14:00") } });
  await restError("POST", `/calendars/${TEAM}/events/${E.standup}/move?destination=primary`, 400, "failedPrecondition");
  assert.equal((await rest("GET", `/calendars/primary/events/${E.focus}`)).json.summary, "Focus time");
  assert.equal((await rest("GET", `/calendars/${TEAM}`)).json.id, TEAM);

  // Byte-bounded pages: eight maximum-size events (~150 KB each) exceed 1 MiB together, so pages stop early with a real token.
  const guests = Array.from({ length: 100 }, (_, n) => ({
    email: `guest${String(n).padStart(3, "0")}.${"g".repeat(80)}@example.org`,
    displayName: "D".repeat(200),
    comment: "C".repeat(1024),
  }));
  const big = [];
  for (let n = 0; n < 8; n += 1) {
    const hour = String(8 + n).padStart(2, "0");
    const created = (await rest("POST", "/calendars/primary/events", {
      body: { summary: `Megameeting ${n} ${"S".repeat(1000)}`, description: "Q".repeat(8192), location: "L".repeat(1024), attendees: guests, ...timed("09-29", `${hour}:00`, `${hour}:30`) },
    })).json;
    big.push(created.id);
  }
  const window = "timeMin=2026-09-28T00:00:00Z&timeMax=2026-10-01T00:00:00Z";
  const [listSizes, listIds] = await allPages(`/calendars/primary/events?${window}&maxResults=250`);
  assert.ok(listSizes.length >= 2 && listSizes[0] < 8, `pages ${JSON.stringify(listSizes)}`);
  assert.equal(new Set(listIds).size, listIds.length, "no event repeats across pages");
  assert.deepEqual(listIds.filter((id) => big.includes(id)), big, "every large event exactly once, in start order");
  const recurring = (await rest("POST", "/calendars/primary/events", {
    body: { summary: "Megaseries", description: "Q".repeat(8192), attendees: guests, recurrence: ["RRULE:FREQ=DAILY;COUNT=8"], ...timed("10-05", "07:00", "07:30") },
  })).json;
  const [instanceSizes, instanceIds] = await allPages(`/calendars/primary/events/${recurring.id}/instances?maxResults=250`);
  assert.ok(instanceSizes.length >= 2, `instance pages ${JSON.stringify(instanceSizes)}`);
  assert.equal(new Set(instanceIds).size, 8);
  const searched = await op("events.search", { query: "megameeting", pageSize: 250, startTime: "2026-09-28T00:00:00Z", endTime: "2026-10-01T00:00:00Z" });
  assert.ok(searched.events.length < 8 && typeof searched.nextPageToken === "string", "search pages are byte-bounded too");

  // Free/busy refuses a response past the size budget instead of building it: four daily series give 368 intervals per calendar
  // over 92 days; fifty spellings of the primary calendar id would need ~1.1 MB.
  for (const hour of ["06", "12", "18", "21"]) {
    await rest("POST", "/calendars/primary/events", { body: { summary: `Daily ${hour}`, recurrence: ["RRULE:FREQ=DAILY"], ...timed("09-14", `${hour}:00`, `${hour}:30`) } });
  }
  const spellings = Array.from({ length: 50 }, (_, n) => DANA.replace(/[a-z]/g, (letter, index) => ((n >> (index % 6)) & 1 ? letter.toUpperCase() : letter)));
  assert.equal(new Set(spellings).size, 50);
  const range = { timeMin: "2026-09-14T00:00:00Z", timeMax: "2026-12-15T00:00:00Z" };
  const tooLarge = await restError("POST", "/freeBusy", 400, "invalid", { body: { ...range, items: spellings.map((id) => ({ id })) } });
  assert.match(tooLarge.json.error.message, /exceed the supported size/);
  const fine = (await rest("POST", "/freeBusy", { body: { ...range, items: spellings.slice(0, 5).map((id) => ({ id })) } })).json;
  assert.ok(fine.calendars[spellings[0]].busy.length >= 368);
}

// ---------------------------------------------------------------------------------------------
// Drill: fresh-install (newcomer: no identity attributes, every grant; baseline)
// ---------------------------------------------------------------------------------------------

async function freshInstall() {
  // Without an `email` attribute the actor acts as the primary seeded user: the owner of the first primary calendar in
  // `calendars` row-id order (Dana), with that calendar's summary as display name.
  const list = (await rest("GET", "/users/me/calendarList")).json;
  assert.deepEqual(ids(list.items), [DANA, HOLIDAYS, TEAM]);
  assert.equal(list.items[0].primary, true);
  assert.equal((await rest("GET", "/calendars/primary")).json.id, DANA);
  assert.equal((await rest("GET", "/users/me/settings/timezone")).json.value, "Europe/London", "Dana's settings row, not the defaults");
  assert.equal((await op("settings.list", {})).serverTime, "2026-09-14T09:00:00Z");
  assert.equal((await rest("GET", `/calendars/primary/events?${WEEK}&singleEvents=true`)).json.items.length, 15, "the seeded working week is visible");
  const now = await op("time.now", {});
  assert.equal(now.dateTime, "2026-09-14T10:00:00+01:00", "virtual now rendered in Dana's zone");
  const created = (await rest("POST", "/calendars/primary/events", { body: { summary: "Created without attributes", ...timed("09-24", "09:00", "09:30"), attendees: [{ email: SAM }] } })).json;
  assert.equal(created.organizer.email, DANA);
  assert.equal(created.organizer.displayName, "Dana Reyes", "the seeded calendar's summary is the display name");
  assert.equal(created.creator.email, DANA);
  assert.equal((await rest("GET", `/calendars/${SAM}/events/${created.id}`, { status: 404 })).status, 404, "Sam's calendar is still not readable by Dana");
  await restError("DELETE", "/calendars/primary", 403, "forbidden");
}

// ---------------------------------------------------------------------------------------------

const flows = {
  "rest-flow": restFlow,
  "mcp-aliases": mcpAliases,
  "sharing-roles": sharingRoles,
  denied,
  "write-rate-limited": writeRateLimited,
  "backend-error": backendError,
  "fresh-install": freshInstall,
  "state-bound": stateBounds,
};
const selected = Object.keys(flows).find((name) => instruction.includes(name));
if (selected === undefined) throw new Error(`Unknown drill instruction: ${instruction}`);
await flows[selected]();
process.stdout.write(JSON.stringify({ completed: true, flow: selected }));
