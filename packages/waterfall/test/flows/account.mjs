// Account reporter, API keys, sub-key and fresh-install flows (baseline scenario).
// account-and-keys (master): account.get ok 3 / tool_error 7; api_keys.list ok 2; api_keys.create ok 1 / tool_error 3;
//   api_keys.modify ok 1 / tool_error 6; api-keys rows 4; api-key.created 1.
// sub-key (outbound): search.contact.run ok 1; account.get ok 1; api_keys.list/create/modify tool_error 1 each (AUTH_NEED_MASTER_API_KEY);
//   usage/outbound/2026-09-16 search_contact_found 3; balance 249.88.
// fresh-install (no attribute): account.get ok 1, enrichment.contact.get ok 1, api_keys.list ok 1; nothing written.
const UNKNOWN = "0badc0de-0000-4000-8000-000000000000";

export async function accountAndKeys({ api, assert, SEED }) {
  const current = (await api("GET", "/v2/account")).body;
  assert.ok(current.price, "the master key sees unit prices");
  assert.equal(current.price.enrichment_contact_persons, 0.138);
  assert.equal(current.key_usage.start_date, "2026-09-01");
  assert.equal(current.key_usage.end_date, "2026-10-01");
  assert.equal(current.key_usage.enrichment_contact_requests, 5);
  assert.equal(current.key_usage.enrichment_phone_requests, 1);
  assert.equal(current.account_usage.enrichment_phone_requests, 2, "account usage includes the sub-keys");
  assert.equal(current.balance_remaining_usd, 250);
  assert.equal(current.server_date, "2026-09-16");
  const july = (await api("GET", "/v2/account?month=2026-07")).body;
  assert.equal(july.key_usage.verify_email_requests, 0);
  assert.equal(july.account_usage.verify_email_requests, 4);
  assert.equal(july.account_usage.start_date, "2026-07-01");
  assert.equal(july.account_usage.end_date, "2026-08-01");
  const span = (await api("GET", "/v2/account?start_date=2026-07-01&end_date=2026-09-16")).body;
  assert.equal(span.account_usage.search_contact_requests, 3);
  assert.equal(span.key_usage.enrichment_contact_requests, 4, "end_date is exclusive");
  const accountError = (query) => api("GET", `/v2/account?${query}`, { status: 400, code: "VALIDATION_BAD_REQUEST" });
  await accountError("month=2026-07&start_date=2026-07-01&end_date=2026-08-01");
  await accountError("start_date=2026-07-01");
  await accountError("start_date=2026-09-16&end_date=2026-09-16");
  await accountError("start_date=2025-09-15&end_date=2026-09-16");
  await accountError("month=2025-08");
  await accountError("start_date=2026-10-01&end_date=2026-11-01");
  await accountError("month=2026-13");
  const keys = (await api("GET", "/v1/api-keys")).body.api_keys;
  assert.equal(keys.length, 3);
  assert.equal(keys[0].master, true);
  assert.equal(keys[0].api_key, SEED.KEY.master);
  assert.deepEqual(keys.slice(1).map((key) => key.notes), ["Legacy zap", "Outbound team"]);
  const created = (await api("POST", "/v1/api-keys", { body: { notes: "CI runner" } })).body;
  assert.deepEqual(created, { api_key: created.api_key, active: true, notes: "CI runner", master: false, per_interval: 50, interval_seconds: 60 });
  assert.match(created.api_key, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  await api("POST", "/v1/api-keys", { body: { notes: "too fast", per_interval: 51 }, status: 400, code: "VALIDATION_SUBKEY_RATE_EXCEEDS_MASTER" });
  const noNotes = await api("POST", "/v1/api-keys", { body: {}, status: 400, code: "VALIDATION_BAD_REQUEST" });
  assert.deepEqual(noNotes.body.error, ["notes: Field required"]);
  await api("POST", "/v1/api-keys", { body: null, status: 400, code: "VALIDATION_MISSING_BODY" });
  const modified = (await api("PUT", "/v1/api-keys", { body: { api_key: created.api_key, notes: "CI runner (paused)", active: false } })).body;
  assert.deepEqual(modified, { api_key: created.api_key, active: false, notes: "CI runner (paused)", master: false, per_interval: 50 });
  await api("PUT", "/v1/api-keys", { body: { api_key: SEED.KEY.master, notes: "x", active: true }, status: 400, code: "VALIDATION_CANNOT_EDIT_MASTER_API_KEY" });
  await api("PUT", "/v1/api-keys", { body: { api_key: UNKNOWN, notes: "x", active: true }, status: 404, code: "NOT_FOUND_API_KEY_NOT_FOUND" });
  await api("PUT", "/v1/api-keys", { body: { api_key: created.api_key, notes: "x", active: true, per_interval: 0 }, status: 400, code: "VALIDATION_BAD_REQUEST" });
  await api("PUT", "/v1/api-keys", { body: { api_key: created.api_key, notes: "x", active: true, per_interval: 99 }, status: 400, code: "VALIDATION_SUBKEY_RATE_EXCEEDS_MASTER" });
  await api("PUT", "/v1/api-keys", { body: null, status: 400, code: "VALIDATION_MISSING_BODY" });
  await api("PUT", "/v1/api-keys", { body: { api_key: created.api_key, notes: "x" }, status: 400, code: "VALIDATION_BAD_REQUEST" });
  const after = (await api("GET", "/v1/api-keys")).body.api_keys;
  assert.equal(after.length, 4);
  assert.equal(after[3].api_key, created.api_key);
  assert.equal(after[3].active, false);
}

export async function subKey({ api, assert, SEED }) {
  const result = (await api("POST", "/v1/search/contact", { body: { domain: "contoso-freight.test", departments: ["Operations"] } })).body;
  assert.deepEqual(result.output.persons.map((person) => person.first_name), ["Petra", "Quentin", "Rosa"]);
  assert.equal(result.output.usage.total_usd, 0.12);
  const account = (await api("GET", "/v2/account")).body;
  assert.equal(account.price, undefined, "sub-keys never see prices");
  assert.equal(account.key_usage.search_contact_found, 3);
  assert.equal(account.key_usage.search_contact_requests, 2);
  assert.equal(account.account_usage.enrichment_contact_requests, 5);
  assert.equal(account.balance_remaining_usd, 249.88);
  await api("GET", "/v1/api-keys", { status: 403, code: "AUTH_NEED_MASTER_API_KEY" });
  await api("POST", "/v1/api-keys", { body: { notes: "nope" }, status: 403, code: "AUTH_NEED_MASTER_API_KEY" });
  await api("PUT", "/v1/api-keys", { body: { api_key: SEED.KEY.outbound, notes: "nope", active: true }, status: 403, code: "AUTH_NEED_MASTER_API_KEY" });
}

export async function freshInstall({ api, assert, SEED }) {
  const account = (await api("GET", "/v2/account")).body;
  assert.ok(account.price, "an actor without waterfallApiKey falls back to the master key");
  assert.equal(account.key_usage.enrichment_contact_requests, 5);
  const seeded = (await api("GET", `/v1/enrichment/contact?job_id=${SEED.JID[1]}`)).body;
  assert.equal(seeded.status, "SUCCEEDED");
  assert.equal(seeded.output.person.id, SEED.PID["ada-lindqvist"]);
  assert.equal((await api("GET", "/v1/api-keys")).body.api_keys.length, 3);
}
