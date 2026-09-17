// Resend Tool conformance target: a scripted Tool test, not a model-driven agent. Node built-ins only.
// Calls the Resend-shaped REST routes (JSON bodies, Bearer token, Idempotency-Key) at FIREDRILL_HTTP_URL, plus the
// canonical operation endpoint for inputs no REST route can express. Each drill instruction names one flow.
import assert from "node:assert/strict";

let task = "";
for await (const chunk of process.stdin) task += chunk;
const instruction = String(JSON.parse(task).instruction ?? "");
const flow = /Run the ([a-z-]+) flow/.exec(instruction)?.[1];
const BASE = process.env.FIREDRILL_HTTP_URL;
const TOKEN = process.env.FIREDRILL_HTTP_TOKEN;
assert.ok(BASE && TOKEN, "the HTTP binding is required");

// Seeded ids (see starter.json): descending 8-hex sequence per resource kind.
const NS = { emails: 1, domains: 2, apiKeys: 3, segments: 4, contacts: 5 };
const seed = (kind, seq) => `${(0xffffffff - seq).toString(16).padStart(8, "0")}-0000-4000-8000-${String(NS[kind]).padStart(4, "0")}${String(seq).padStart(8, "0")}`;
const EMAIL = (n) => seed("emails", n);
const DOMAIN = { legacy: seed("domains", 1), mail: seed("domains", 2), updates: seed("domains", 3), billing: seed("domains", 4) };
const KEY = { staging: seed("apiKeys", 1), marketing: seed("apiKeys", 2), production: seed("apiKeys", 3) };
const SEGMENT = { newsletter: seed("segments", 1), beta: seed("segments", 2), empty: seed("segments", 3) };
const CONTACT = (n) => seed("contacts", n);
const UNKNOWN = "0badc0de-0000-4000-8000-000000000000";
const LONG_KEY = "k".repeat(300);
const HELLO = "Northwind Labs <hello@mail.northwind.test>";
const NOW_MS = Date.UTC(2026, 8, 15, 14, 0, 0);
const inHours = (hours) => new Date(NOW_MS + hours * 3_600_000).toISOString();

/** One REST call. Asserts the status; for errors also the Resend envelope name. Returns `{ body, headers }`. */
async function api(method, path, { body, status = 200, name, headers = {}, raw } = {}) {
  const init = { method, headers: { authorization: `Bearer ${TOKEN}`, ...headers } };
  if (body !== undefined || raw !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = raw ?? JSON.stringify(body);
  }
  const response = await fetch(`${BASE}${path}`, init);
  const text = await response.text();
  let json;
  try {
    json = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  assert.equal(response.status, status, `${method} ${path} → ${response.status} ${text.slice(0, 400)}`);
  if (status >= 400) {
    assert.equal(json?.statusCode, status, `${method} ${path} envelope statusCode: ${text.slice(0, 300)}`);
    assert.equal(typeof json?.message, "string");
    if (name !== undefined) assert.equal(json?.name, name, `${method} ${path} error name: ${text.slice(0, 300)}`);
  }
  return { body: json, headers: response.headers, bytes: Buffer.byteLength(text, "utf8") };
}

/** Canonical operation call; returns the outcome. */
async function canonical(operation, args) {
  const response = await fetch(`${BASE}/v1/operations/resend/${operation}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ arguments: args }),
  });
  const json = await response.json();
  assert.ok(json.outcome, `canonical ${operation}: ${JSON.stringify(json).slice(0, 300)}`);
  return json.outcome;
}

async function canonicalError(operation, args, code) {
  const outcome = await canonical(operation, args);
  assert.equal(outcome.status, "tool_error", `${operation} expected ${code}: ${JSON.stringify(outcome).slice(0, 300)}`);
  assert.equal(outcome.error.code, `tool.${code}`);
  return outcome;
}

const send = (overrides = {}) => ({ from: HELLO, to: ["ada.okafor@example.com"], subject: "Conformance probe", text: "Hello from the conformance flow.", ...overrides });
const enc = encodeURIComponent;

/** One valid-shaped request per operation (manifest order), used by the key flows. */
const CALLS = [
  ["emails.send", "POST", "/emails", send()],
  ["emails.send_batch", "POST", "/emails/batch", [send()]],
  ["emails.list", "GET", "/emails"],
  ["emails.get", "GET", `/emails/${EMAIL(1)}`],
  ["emails.update", "PATCH", `/emails/${EMAIL(21)}`, { scheduled_at: inHours(30) }],
  ["emails.cancel", "POST", `/emails/${EMAIL(21)}/cancel`],
  ["domains.create", "POST", "/domains", { name: "probe.northwind.test" }],
  ["domains.list", "GET", "/domains"],
  ["domains.get", "GET", `/domains/${DOMAIN.mail}`],
  ["domains.verify", "POST", `/domains/${DOMAIN.billing}/verify`],
  ["domains.remove", "DELETE", `/domains/${DOMAIN.billing}`],
  ["api_keys.create", "POST", "/api-keys", { name: "Probe" }],
  ["api_keys.list", "GET", "/api-keys"],
  ["api_keys.remove", "DELETE", `/api-keys/${KEY.staging}`],
  ["segments.create", "POST", "/segments", { name: "Probe" }],
  ["segments.list", "GET", "/segments"],
  ["segments.remove", "DELETE", `/segments/${SEGMENT.empty}`],
  ["contacts.create", "POST", "/contacts", { email: "probe@example.com" }],
  ["contacts.list", "GET", "/contacts"],
  ["contacts.get", "GET", `/contacts/${CONTACT(1)}`],
  ["contacts.update", "PATCH", `/contacts/${CONTACT(1)}`, { first_name: "Probe" }],
  ["contacts.remove", "DELETE", `/contacts/${CONTACT(9)}`],
  ["contacts.add_segment", "POST", `/contacts/${CONTACT(9)}/segments/${SEGMENT.empty}`],
  ["contacts.remove_segment", "DELETE", `/contacts/${CONTACT(1)}/segments/${SEGMENT.newsletter}`],
  ["contacts.list_segments", "GET", `/contacts/${CONTACT(1)}/segments`],
];

async function emailFlow() {
  const a = (await api("POST", "/emails", { body: send(), headers: { "idempotency-key": "email-flow-a" } })).body;
  const replay = (await api("POST", "/emails", { body: send(), headers: { "idempotency-key": "email-flow-a" } })).body;
  assert.equal(replay.id, a.id, "an Idempotency-Key replay returns the same email");
  await api("POST", "/emails", { body: send({ subject: "Different" }), headers: { "idempotency-key": "email-flow-a" }, status: 400, name: "validation_error" });
  const got = (await api("GET", `/emails/${a.id}`)).body;
  assert.equal(got.object, "email");
  assert.equal(got.last_event, "delivered");
  assert.equal(got.created_at, "2026-09-15 14:00:00.000000+00");
  assert.deepEqual(got.to, ["ada.okafor@example.com"]);
  assert.equal(got.html, null);
  assert.deepEqual([got.cc, got.bcc, got.reply_to, got.tags], [[], [], [], []]);

  const b = (await api("POST", "/emails", { body: send({ to: "former@nowhere.invalid", html: "<p>x</p>" }) })).body;
  assert.equal((await api("GET", `/emails/${b.id}`)).body.last_event, "bounced");

  const c = (await api("POST", "/emails", { body: send({ scheduled_at: inHours(1), tags: [{ name: "flow", value: "email_flow" }] }) })).body;
  let scheduled = (await api("GET", `/emails/${c.id}`)).body;
  assert.equal(scheduled.last_event, "scheduled");
  assert.equal(scheduled.scheduled_at, "2026-09-15 15:00:00.000000+00");
  assert.deepEqual(await (await api("PATCH", `/emails/${c.id}`, { body: { scheduled_at: inHours(2) } })).body, { object: "email", id: c.id });
  scheduled = (await api("GET", `/emails/${c.id}`)).body;
  assert.equal(scheduled.scheduled_at, "2026-09-15 16:00:00.000000+00");
  assert.deepEqual((await api("POST", `/emails/${c.id}/cancel`)).body, { object: "email", id: c.id });
  assert.equal((await api("GET", `/emails/${c.id}`)).body.last_event, "canceled");

  // Only a pending scheduled email can change; the seeded 13:30 email is already due.
  await api("POST", `/emails/${a.id}/cancel`, { status: 422, name: "validation_error" });
  await api("POST", `/emails/${EMAIL(18)}/cancel`, { status: 422, name: "validation_error" });
  await api("PATCH", `/emails/${a.id}`, { body: { scheduled_at: inHours(3) }, status: 422, name: "validation_error" });
  await api("PATCH", `/emails/${c.id}`, { body: {}, status: 422, name: "missing_required_field" });
  assert.equal((await api("GET", `/emails/${EMAIL(18)}`)).body.last_event, "delivered");
  for (const [method, suffix, body] of [["GET", ""], ["PATCH", "", { scheduled_at: inHours(3) }], ["POST", "/cancel"]]) {
    await api(method, `/emails/not-a-uuid${suffix}`, { body, status: 422, name: "invalid_parameter" });
    await api(method, `/emails/${UNKNOWN}${suffix}`, { body, status: 404, name: "not_found" });
  }
  const badKey = { "idempotency-key": LONG_KEY };
  await api("POST", "/emails", { body: send(), headers: badKey, status: 400, name: "invalid_idempotency_key" });
  await api("POST", "/emails/batch", { body: [send()], headers: badKey, status: 400, name: "invalid_idempotency_key" });
  await api("PATCH", `/emails/${EMAIL(21)}`, { body: { scheduled_at: inHours(30) }, headers: badKey, status: 400, name: "invalid_idempotency_key" });
  await api("POST", `/emails/${EMAIL(21)}/cancel`, { headers: badKey, status: 400, name: "invalid_idempotency_key" });

  const invalid = [
    [send({ from: undefined }), 422, "missing_required_field"],
    [send({ from: "not an address" }), 422, "validation_error"],
    [send({ to: [] }), 422, "missing_required_field"],
    [send({ to: Array.from({ length: 51 }, (_, i) => `r${i}@example.com`) }), 422, "validation_error"],
    [send({ subject: undefined }), 422, "missing_required_field"],
    [send({ text: undefined }), 422, "missing_required_field"],
    [send({ tags: [{ name: "bad tag!", value: "x" }] }), 422, "validation_error"],
    [send({ scheduled_at: inHours(-1) }), 422, "validation_error"],
    [send({ scheduled_at: inHours(24 * 31) }), 422, "validation_error"],
    [send({ scheduled_at: "2026-09-16T10:00:00" }), 422, "validation_error"],
    [send({ attachments: [{ filename: "a.txt", content: "aGk=" }] }), 422, "validation_error"],
    [send({ headers: { __proto__: null, constructor: "x" } }), 422, "validation_error"],
    [send({ from: "Billing <invoices@billing.northwind.test>" }), 403, "validation_error"],
    [send({ from: "someone@unknown-domain.test" }), 403, "validation_error"],
  ];
  for (const [body, status, name] of invalid) await api("POST", "/emails", { body, status, name });

  const batch = (await api("POST", "/emails/batch", { body: [send(), send({ to: "lena.hart@example.com" }), send({ subject: "Third" })] })).body;
  assert.equal(batch.data.length, 3);
  const badBatches = [
    [Array.from({ length: 101 }, () => send()), 422, "validation_error"],
    [[], 422, "validation_error"],
    [[send({ scheduled_at: inHours(1) })], 422, "validation_error"],
    [[send(), send({ from: undefined })], 422, "missing_required_field"],
    [[send({ from: "x <a@billing.northwind.test>" })], 403, "validation_error"],
    [send(), 422, "validation_error"],
    [[send(), 5], 400, "validation_error"],
  ];
  for (const [body, status, name] of badBatches) await api("POST", "/emails/batch", { body, status, name });
  await api("POST", "/emails/batch", { body: [send()], headers: { "x-batch-validation": "permissive" }, status: 422, name: "validation_error" });
  // Bodies nested past 512 levels answer 400 before argument validation (including the framework's 3,000-level window).
  const nest = (key, depth, shape) => {
    const inner = `${(shape === "array" ? "[" : '{"a":').repeat(depth)}1${(shape === "array" ? "]" : "}").repeat(depth)}`;
    return key === undefined ? inner : `{"${key}":${inner}}`;
  };
  const rawStatus = async (method, path, text) => {
    const response = await fetch(`${BASE}${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: text });
    return { status: response.status, text: await response.text() };
  };
  for (const [method, path, key] of [
    ["POST", "/emails", "from"], ["POST", "/emails/batch", undefined], ["POST", "/domains", "name"], ["POST", "/api-keys", "name"],
    ["POST", "/segments", "name"], ["POST", "/contacts", "email"], ["PATCH", "/contacts/ada.okafor@example.com", "email"],
  ]) {
    for (const depth of [513, 2998, 3152]) {
      for (const shape of ["array", "object"]) {
        const { status, text } = await rawStatus(method, path, nest(key, depth, shape));
        assert.equal(status, 400, `${method} ${path} ${shape}s nested ${depth} -> ${status} ${text.slice(0, 200)}`);
      }
    }
  }
  const shallow = await rawStatus("POST", "/domains", nest("name", 510, "array"));
  assert.equal(shallow.status, 400, `510 levels reach Resend's own validation: ${shallow.text.slice(0, 200)}`);
  assert.equal(JSON.parse(shallow.text).name, "validation_error", `510 levels answer the Resend envelope, not the depth guard: ${shallow.text.slice(0, 200)}`);

  const page1 = (await api("GET", "/emails")).body;
  assert.equal(page1.object, "list");
  assert.equal(page1.data.length, 20);
  assert.equal(page1.has_more, true);
  assert.equal(page1.data[0].id, batch.data[2].id, "newest first");
  const page2 = (await api("GET", `/emails?after=${page1.data[19].id}`)).body;
  assert.equal(page2.data.length, 9);
  assert.equal(page2.has_more, false);
  const back = (await api("GET", `/emails?before=${page2.data[0].id}&limit=5`)).body;
  assert.deepEqual(back.data.map((e) => e.id), page1.data.slice(15).map((e) => e.id));
  assert.equal(back.has_more, true);
  for (const query of ["limit=0", "limit=abc", "after=nope", `after=${UNKNOWN}`, `after=${EMAIL(1)}&before=${EMAIL(2)}`]) {
    await api("GET", `/emails?${query}`, { status: 422, name: "validation_error" });
  }
  const filtered = await canonical("emails.list", { query: "order nw-77", status: "delivered" });
  assert.equal(filtered.value.data.length, 3);
}

async function domainsAndKeysFlow() {
  const badKey = { "idempotency-key": LONG_KEY };
  const created = await api("POST", "/domains", { body: { name: "Shop.Northwind.test", region: "eu-west-1", capabilities: { receiving: "enabled" } }, status: 201 });
  const shop = created.body;
  assert.equal(shop.name, "shop.northwind.test");
  assert.equal(shop.status, "not_started");
  assert.deepEqual(shop.records.map((r) => `${r.record}/${r.type}`), ["SPF/MX", "SPF/TXT", "DKIM/TXT", "Receiving/MX"]);
  assert.equal(shop.records[0].value, "feedback-smtp.eu-west-1.amazonses.com");
  await api("POST", "/domains", { body: { name: "shop.northwind.test" }, status: 422, name: "validation_error" });
  await api("POST", "/domains", { body: { name: "not a domain" }, status: 422, name: "validation_error" });
  await api("POST", "/domains", { body: {}, status: 422, name: "missing_required_field" });
  await api("POST", "/domains", { body: { name: "x.northwind.test", region: "mars-1" }, status: 422, name: "validation_error" });
  await api("POST", "/domains", { body: { name: "x.northwind.test", tracking_subdomain: "links" }, status: 422, name: "validation_error" });
  await api("POST", "/domains", { body: { name: "x.northwind.test" }, headers: badKey, status: 400, name: "invalid_idempotency_key" });

  assert.deepEqual((await api("POST", `/domains/${shop.id}/verify`)).body, { object: "domain", id: shop.id });
  const verified = (await api("GET", `/domains/${shop.id}`)).body;
  assert.equal(verified.object, "domain");
  assert.equal(verified.status, "verified");
  assert.ok(verified.records.every((r) => r.status === "verified"));
  await api("POST", `/domains/${DOMAIN.legacy}/verify`);
  assert.equal((await api("GET", `/domains/${DOMAIN.legacy}`)).body.status, "failed");

  const domains = (await api("GET", "/domains")).body;
  assert.equal(domains.data.length, 5);
  assert.equal(domains.data[0].id, shop.id);
  const first = (await api("GET", "/domains?limit=2")).body;
  assert.equal(first.has_more, true);
  const rest = (await api("GET", `/domains?limit=2&after=${first.data[1].id}`)).body;
  assert.deepEqual(rest.data.map((d) => d.id), domains.data.slice(2, 4).map((d) => d.id));
  await api("GET", "/domains?before=zzz", { status: 422, name: "validation_error" });
  for (const [method, suffix] of [["GET", ""], ["POST", "/verify"], ["DELETE", ""]]) {
    await api(method, `/domains/bad-id${suffix}`, { status: 422, name: "invalid_parameter" });
    await api(method, `/domains/${UNKNOWN}${suffix}`, { status: 404, name: "not_found" });
  }
  await api("POST", `/domains/${shop.id}/verify`, { headers: badKey, status: 400, name: "invalid_idempotency_key" });
  await api("DELETE", `/domains/${shop.id}`, { headers: badKey, status: 400, name: "invalid_idempotency_key" });
  assert.deepEqual((await api("DELETE", `/domains/${shop.id}`)).body, { object: "domain", id: shop.id, deleted: true });
  await api("GET", `/domains/${shop.id}`, { status: 404, name: "not_found" });
  await api("POST", "/emails", { body: send({ from: "orders@shop.northwind.test" }), status: 403, name: "validation_error" });

  const full = (await api("POST", "/api-keys", { body: { name: "Probe key" }, status: 201 })).body;
  assert.match(full.token, /^re_[0-9A-Za-z]{32}$/);
  const restricted = (await api("POST", "/api-keys", { body: { name: "Updates only", permission: "sending_access", domain_id: DOMAIN.updates }, status: 201 })).body;
  await api("POST", "/api-keys", { body: { name: "Wrong", domain_id: DOMAIN.updates }, status: 422, name: "validation_error" });
  await api("POST", "/api-keys", { body: { name: "Wrong", permission: "admin" }, status: 422, name: "validation_error" });
  await api("POST", "/api-keys", { body: {}, status: 422, name: "missing_required_field" });
  await api("POST", "/api-keys", { body: { name: "x" }, headers: badKey, status: 400, name: "invalid_idempotency_key" });
  const keys = (await api("GET", "/api-keys")).body;
  assert.deepEqual(keys.data.slice(0, 2).map((k) => k.id), [restricted.id, full.id]);
  assert.equal(keys.data.length, 5);
  assert.equal(keys.data.find((k) => k.id === KEY.staging).last_used_at, null);
  assert.ok(!JSON.stringify(keys).includes(full.token), "tokens are never listed");
  await api("GET", "/api-keys?limit=101", { status: 422, name: "validation_error" });
  assert.deepEqual((await api("DELETE", `/api-keys/${full.id}`)).body, { object: "api_key", id: full.id, deleted: true });
  await api("DELETE", `/api-keys/${full.id}`, { status: 404, name: "not_found" });
  await api("DELETE", "/api-keys/nope", { status: 422, name: "invalid_parameter" });
  await api("DELETE", `/api-keys/${KEY.production}`, { status: 422, name: "validation_error" });
  await api("DELETE", `/api-keys/${KEY.staging}`, { headers: badKey, status: 400, name: "invalid_idempotency_key" });
}

async function audienceFlow() {
  const badKey = { "idempotency-key": LONG_KEY };
  const vip = (await api("POST", "/segments", { body: { name: "VIP" }, status: 201 })).body;
  assert.equal(vip.object, "segment");
  await api("POST", "/segments", { body: {}, status: 422, name: "missing_required_field" });
  await api("POST", "/segments", { body: { name: "Filtered", filter: { and: [] } }, status: 422, name: "validation_error" });
  await api("POST", "/segments", { body: { name: "x" }, headers: badKey, status: 400, name: "invalid_idempotency_key" });
  const segments = (await api("GET", "/segments")).body;
  assert.deepEqual(segments.data.map((s) => s.name), ["VIP", "Empty segment", "Beta testers", "Newsletter"]);
  await api("GET", "/segments?limit=-1", { status: 422, name: "validation_error" });
  await api("DELETE", `/segments/${vip.id}`);
  await api("DELETE", `/segments/${vip.id}`, { status: 404, name: "not_found" });
  await api("DELETE", "/segments/1234", { status: 422, name: "invalid_parameter" });
  await api("DELETE", `/segments/${SEGMENT.beta}`, { headers: badKey, status: 400, name: "invalid_idempotency_key" });
  assert.deepEqual((await api("DELETE", `/segments/${SEGMENT.beta}`)).body, { object: "segment", id: SEGMENT.beta, deleted: true });
  assert.equal((await api("GET", `/contacts/${CONTACT(1)}/segments`)).body.data.length, 1, "Beta testers membership removed");

  const created = (await api("POST", "/contacts", { body: { email: "new.person@example.com", first_name: "New", segments: [{ id: SEGMENT.newsletter }], properties: { company_name: "Newco", seats: 2 } }, status: 201 })).body;
  assert.equal(created.object, "contact");
  await api("POST", "/contacts", { body: { email: "New.Person@example.com" }, status: 422, name: "validation_error" });
  await api("POST", "/contacts", { body: { email: "nope" }, status: 422, name: "validation_error" });
  await api("POST", "/contacts", { body: {}, status: 422, name: "missing_required_field" });
  await api("POST", "/contacts", { body: { email: "z@example.com", segments: [{ id: UNKNOWN }] }, status: 422, name: "validation_error" });
  await api("POST", "/contacts", { body: { email: "z@example.com", topics: [{ id: UNKNOWN, subscription: "opt_in" }] }, status: 422, name: "validation_error" });
  await api("POST", "/contacts", { body: { email: "z@example.com" }, headers: badKey, status: 400, name: "invalid_idempotency_key" });

  const byId = (await api("GET", `/contacts/${created.id}`)).body;
  assert.deepEqual([byId.email, byId.first_name, byId.last_name, byId.unsubscribed, byId.properties.seats], ["new.person@example.com", "New", null, false, 2]);
  const byEmail = (await api("GET", `/contacts/${enc("MARA.QUINN@example.com")}`)).body;
  assert.equal(byEmail.id, CONTACT(1));
  await api("GET", "/contacts/not-a-uuid", { status: 422, name: "invalid_parameter" });
  await api("GET", `/contacts/${UNKNOWN}`, { status: 404, name: "not_found" });
  await api("GET", `/contacts/${enc("nobody@example.com")}`, { status: 404, name: "not_found" });
  await api("GET", `/contacts/${enc("a@b")}`, { status: 422, name: "invalid_parameter" });
  await canonicalError("contacts.get", {}, "MISSING_REQUIRED_FIELD");

  const theo = `/contacts/${enc("theo.brandt@example.com")}`;
  assert.deepEqual((await api("PATCH", theo, { body: { first_name: "Theodor", unsubscribed: true } })).body, { object: "contact", id: CONTACT(2) });
  const updated = (await api("GET", `/contacts/${CONTACT(2)}`)).body;
  assert.deepEqual([updated.first_name, updated.unsubscribed], ["Theodor", true]);
  await api("PATCH", theo, { body: { properties: { "Bad Key": 1 } }, status: 422, name: "validation_error" });
  await api("PATCH", theo, { body: { email: "mara.quinn@example.com" }, status: 422, name: "validation_error" });
  await api("PATCH", `/contacts/${UNKNOWN}`, { body: { first_name: "x" }, status: 404, name: "not_found" });
  await api("PATCH", "/contacts/xyz", { body: { first_name: "x" }, status: 422, name: "invalid_parameter" });
  await api("PATCH", theo, { body: { first_name: "x" }, headers: badKey, status: 400, name: "invalid_idempotency_key" });
  await canonicalError("contacts.update", { firstName: "x" }, "MISSING_REQUIRED_FIELD");

  const all = (await api("GET", "/contacts")).body;
  assert.deepEqual([all.data.length, all.has_more, all.data[0].id], [15, false, created.id]);
  const firstTen = (await api("GET", "/contacts?limit=10")).body;
  assert.equal(firstTen.has_more, true);
  assert.equal((await api("GET", `/contacts?limit=10&after=${firstTen.data[9].id}`)).body.data.length, 5);
  assert.equal((await api("GET", `/contacts?segment_id=${SEGMENT.newsletter}`)).body.data.length, 10);
  const empty = (await api("GET", `/contacts?segment_id=${SEGMENT.empty}`)).body;
  assert.deepEqual([empty.data.length, empty.has_more], [0, false]);
  await api("GET", `/contacts?segment_id=${SEGMENT.beta}`, { status: 404, name: "not_found" });
  await api("GET", "/contacts?segment_id=beta", { status: 422, name: "invalid_parameter" });
  await api("GET", `/contacts?after=${UNKNOWN}`, { status: 422, name: "validation_error" });
  assert.equal((await canonical("contacts.list", { query: "HADDAD" })).value.data.length, 1);

  const membership = `/contacts/${CONTACT(2)}/segments/${SEGMENT.empty}`;
  const added = { object: "contact_segment", contact_id: CONTACT(2), segment_id: SEGMENT.empty };
  assert.deepEqual((await api("POST", membership)).body, added);
  assert.deepEqual((await api("POST", `/contacts/${enc("theo.brandt@example.com")}/segments/${SEGMENT.empty}`)).body, added);
  await api("POST", `/contacts/${CONTACT(2)}/segments/${UNKNOWN}`, { status: 404, name: "not_found" });
  await api("POST", `/contacts/nope/segments/${SEGMENT.empty}`, { status: 422, name: "invalid_parameter" });
  await api("POST", membership, { headers: badKey, status: 400, name: "invalid_idempotency_key" });
  await canonicalError("contacts.add_segment", { segmentId: SEGMENT.empty }, "MISSING_REQUIRED_FIELD");
  const theoSegments = (await api("GET", `/contacts/${CONTACT(2)}/segments`)).body;
  assert.deepEqual(theoSegments.data.map((s) => s.name), ["Empty segment", "Newsletter"]);
  await api("GET", `/contacts/${CONTACT(2)}/segments?after=xyz`, { status: 422, name: "validation_error" });
  await api("GET", `/contacts/${UNKNOWN}/segments`, { status: 404, name: "not_found" });
  await api("GET", "/contacts/nope/segments", { status: 422, name: "invalid_parameter" });
  await canonicalError("contacts.list_segments", {}, "MISSING_REQUIRED_FIELD");
  await api("DELETE", membership, { headers: badKey, status: 400, name: "invalid_idempotency_key" });
  assert.deepEqual((await api("DELETE", membership)).body, { ...added, deleted: true });
  await api("DELETE", membership, { status: 404, name: "not_found" });
  await api("DELETE", `/contacts/nope/segments/${SEGMENT.empty}`, { status: 422, name: "invalid_parameter" });
  await canonicalError("contacts.remove_segment", { segmentId: SEGMENT.empty }, "MISSING_REQUIRED_FIELD");

  await api("DELETE", `/contacts/${CONTACT(1)}`, { headers: badKey, status: 400, name: "invalid_idempotency_key" });
  assert.deepEqual((await api("DELETE", `/contacts/${enc("mara.quinn@example.com")}`)).body, { object: "contact", id: CONTACT(1), deleted: true });
  await api("GET", `/contacts/${enc("mara.quinn@example.com")}`, { status: 404, name: "not_found" });
  await api("DELETE", `/contacts/${CONTACT(1)}`, { status: 404, name: "not_found" });
  await api("DELETE", "/contacts/12", { status: 422, name: "invalid_parameter" });
  await canonicalError("contacts.remove", {}, "MISSING_REQUIRED_FIELD");
}

async function restrictedKeyFlow() {
  for (const [operation, method, path, body] of CALLS) {
    if (operation.startsWith("emails.send")) continue;
    await api(method, path, { body, status: 401, name: "restricted_api_key" });
  }
  const context = await canonical("workspace.context", {});
  assert.equal(context.value.apiKey.name, "Marketing sender");
  await api("POST", "/emails", { body: send({ from: "news@updates.northwind.test" }) });
  await api("POST", "/emails", { body: send(), status: 403, name: "validation_error" });
  await api("POST", "/emails/batch", { body: [send({ from: "Updates <news@updates.northwind.test>" })] });
}

async function invalidKeyFlow() {
  for (const [, method, path, body] of CALLS) await api(method, path, { body, status: 403, name: "invalid_api_key" });
  await canonicalError("workspace.context", {}, "INVALID_API_KEY");
}

async function freshInstallFlow() {
  const context = (await canonical("workspace.context", {})).value;
  assert.deepEqual([context.apiKey.name, context.team.name, context.now, context.team.sentToday], ["Production", "Northwind Labs", "2026-09-15T14:00:00.000000Z", 7]);
  assert.equal((await api("GET", "/emails")).body.data.length, 20);
  assert.equal((await api("GET", "/domains")).body.data.length, 4);
  assert.equal((await api("GET", "/contacts")).body.data.length, 14);
}

async function deniedFlow() {
  for (const [method, path, body] of [["POST", "/emails", send()], ["GET", "/emails"]]) {
    const response = await fetch(`${BASE}${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal(response.status, 403, `${method} ${path} must be denied`);
  }
}

async function rateLimitedFlow() {
  for (let i = 0; i < 2; i += 1) {
    const { headers } = await api("POST", "/emails", { body: send(), status: 429, name: "rate_limit_exceeded" });
    assert.deepEqual([headers.get("retry-after"), headers.get("ratelimit-limit"), headers.get("ratelimit-remaining")], ["1", "10", "0"]);
  }
  await api("POST", "/emails/batch", { body: [send()], status: 429, name: "rate_limit_exceeded" });
  assert.equal((await api("GET", "/emails")).body.data.length, 20);
}

async function contactsOutageFlow() {
  await api("POST", "/contacts", { body: { email: "outage@example.com" }, status: 500, name: "application_error" });
  assert.equal((await api("GET", `/contacts/${enc("outage@example.com")}`)).body.email, "outage@example.com");
  await api("POST", "/contacts", { body: { email: "outage@example.com" }, status: 422, name: "validation_error" });
}

async function quotaExhaustedFlow() {
  await api("POST", "/emails", { body: send() });
  await api("POST", "/emails", { body: send(), status: 429, name: "daily_quota_exceeded" });
  await api("POST", "/emails/batch", { body: [send(), send()], status: 429, name: "daily_quota_exceeded" });
}

async function tightLimitsFlow() {
  for (const path of ["/emails", "/domains", "/api-keys", "/segments", "/contacts", `/contacts/${CONTACT(1)}/segments`]) {
    await api("GET", path, { status: 500, name: "application_error" });
  }
  await api("DELETE", `/segments/${SEGMENT.beta}`, { status: 500, name: "application_error" });
  await api("DELETE", `/contacts/${CONTACT(1)}`, { status: 500, name: "application_error" });
}

async function largePageFlow() {
  // 24 emails of about 50-120 KB each push list pages past the byte cap; every row must stay reachable both ways.
  const addr = (i) => `${"r".repeat(50)}.${String(i).padStart(5, "0")}@${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.example.com`;
  // The second batch uses 190-character CJK display names: three UTF-8 bytes per character, one UTF-16 unit each.
  const cjk = (i) => `${"\u540d".repeat(190)} <r${i}@example.com>`;
  const heavy = (n, mk) => send({ to: Array.from({ length: 50 }, (_, i) => mk(n * 1000 + i)), cc: Array.from({ length: 50 }, (_, i) => mk(n * 1000 + 50 + i)), bcc: Array.from({ length: 50 }, (_, i) => mk(n * 1000 + 100 + i)), reply_to: Array.from({ length: 50 }, (_, i) => mk(n * 1000 + 150 + i)) });
  // CJK emails carry 100 recipients (to + cc) so the batch request stays under 1 MiB; the resulting page is about 1.3 MB
  // of UTF-8 but under 900k UTF-16 units, so a character-counted budget would overflow the response cap.
  const light = (n) => send({ to: Array.from({ length: 50 }, (_, i) => cjk(n * 1000 + i)), cc: Array.from({ length: 50 }, (_, i) => cjk(n * 1000 + 50 + i)) });
  await api("POST", "/emails/batch", { body: Array.from({ length: 12 }, (_, i) => heavy(i, addr)) });
  await api("POST", "/emails/batch", { body: Array.from({ length: 12 }, (_, i) => light(12 + i)) });
  const MIB = 1024 * 1024;
  const cjkPage = await api("GET", "/emails?limit=100");
  assert.ok(cjkPage.bytes < MIB, `non-ASCII page is ${cjkPage.bytes} UTF-8 bytes, over the 1 MiB cap`);
  const forward = [];
  let capped = false;
  let page = cjkPage.body;
  for (;;) {
    forward.push(...page.data.map((e) => e.id));
    if (page.has_more && page.data.length < 100) capped = true;
    if (!page.has_more) break;
    const next = await api("GET", `/emails?limit=100&after=${page.data.at(-1).id}`);
    assert.ok(next.bytes < MIB, `forward page is ${next.bytes} bytes`);
    page = next.body;
  }
  assert.ok(capped, "a forward page was byte-capped");
  assert.equal(forward.length, 47);
  assert.equal(new Set(forward).size, 47);
  const backward = [];
  let cursor = forward.at(-1);
  let cappedBack = false;
  for (;;) {
    const backResponse = await api("GET", `/emails?limit=100&before=${cursor}`);
    assert.ok(backResponse.bytes < MIB, `backward page is ${backResponse.bytes} bytes`);
    const back = backResponse.body;
    backward.unshift(...back.data.map((e) => e.id));
    if (back.has_more && back.data.length < 100) cappedBack = true;
    if (!back.has_more) break;
    cursor = back.data[0].id;
  }
  assert.ok(cappedBack, "a backward page was byte-capped");
  assert.deepEqual(backward, forward.slice(0, -1), "paging back from the last row reaches every earlier row in order");
}

const FLOWS = {
  "email-flow": emailFlow, "domains-and-keys": domainsAndKeysFlow, audience: audienceFlow, "restricted-key": restrictedKeyFlow,
  "invalid-key": invalidKeyFlow, "fresh-install": freshInstallFlow, denied: deniedFlow, "rate-limited": rateLimitedFlow,
  "contacts-outage": contactsOutageFlow, "quota-exhausted": quotaExhaustedFlow, "tight-limits": tightLimitsFlow,
  "large-page": largePageFlow,
};
assert.ok(flow !== undefined && Object.hasOwn(FLOWS, flow), `unknown conformance flow in instruction: ${instruction}`);
await FLOWS[flow]();
process.stdout.write(JSON.stringify({ completed: true, flow }));
