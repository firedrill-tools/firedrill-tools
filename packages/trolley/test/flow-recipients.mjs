// Recipients flow: list paging, search, filters, ordering, validation, create, update, archive and restore.
import { B, R, api, assert, fails, flow } from "./harness.mjs";

flow("recipients", async () => {
  const first = await api("GET", "/v1/recipients");
  assert.equal(first.recipients.length, 10);
  assert.deepEqual(first.meta, { page: 1, pages: 2, records: 13 });
  assert.ok(first.recipients.every((recipient) => recipient.status !== "archived"), "archived recipients are hidden by default");
  const second = await api("GET", "/v1/recipients?page=2", { scheme: "Bearer" });
  assert.equal(second.recipients.length, 3);
  const ids = new Set([...first.recipients, ...second.recipients].map((recipient) => recipient.id));
  assert.equal(ids.size, 13, "pages do not overlap");
  const beyond = await api("GET", "/v1/recipients?page=99");
  assert.deepEqual(beyond.recipients, []);
  assert.deepEqual(beyond.meta, { page: 99, pages: 2, records: 13 });

  const quarry = await api("GET", "/v1/recipients?search=QUARRY");
  assert.deepEqual(quarry.recipients.map((recipient) => recipient.id), [R(2)]);
  const archived = await api("GET", "/v1/recipients?status=archived");
  assert.deepEqual(archived.recipients.map((recipient) => recipient.id), [R(11)]);
  const countries = await api("GET", "/v1/recipients?country=CA,GB&orderBy=name&sortBy=asc");
  assert.deepEqual(countries.recipients.map((recipient) => recipient.id), [R(3), R(4)].sort((a, b) => (a === R(3) ? 1 : -1)));
  const tagged = await api("GET", "/v1/recipients?tags=editor,video");
  assert.deepEqual(tagged.recipients.map((recipient) => recipient.id), [R(6)]);
  const byName = await api("GET", "/v1/recipients?orderBy=name&sortBy=asc&pageSize=1");
  assert.equal(byName.recipients[0].name, "Estudio Nopal S.A. de C.V.");
  const paypal = await api("GET", "/v1/recipients?payoutMethod=paypal&currency=usd");
  assert.deepEqual(paypal.recipients.map((recipient) => recipient.id).sort(), [R(6), R(13)].sort());
  await fails("GET", "/v1/recipients?pageSize=0", 400, "invalid_field", { field: "pageSize" });
  await fails("GET", "/v1/recipients?pageSize=abc", 400, "invalid_field", { field: "pageSize" });
  await fails("GET", "/v1/recipients?sortBy=up", 400, "invalid_field", { field: "sortBy" });
  await fails("GET", "/v1/recipients?startDate=2026-01-01", 400, "invalid_field", { field: "startDate" });
  await fails("GET", "/v1/recipients?search=%FF", 400, "invalid_field", { field: "search" });

  const maya = (await api("GET", `/v1/recipients/${R(1)}`)).recipient;
  assert.equal(maya.payoutMethod, "bank-transfer");
  assert.equal(maya.routeType, "ach");
  assert.equal(maya.primaryCurrency, "USD");
  assert.equal(maya.accounts[0].accountNum, "*****2847");
  await fails("GET", `/v1/recipients/${R(999)}`, 404, "not_found");
  await fails("GET", "/v1/recipients/R-nope", 404, "not_found");

  await fails("POST", "/v1/recipients", 400, "empty_field", { field: "firstName", body: { type: "individual", email: "rowan.pike@example.com", lastName: "Pike" } });
  await fails("POST", "/v1/recipients", 400, "invalid_field", { field: "email", body: { type: "individual", email: "MAYA.castellanos@example.com", firstName: "M", lastName: "C" } });
  await fails("POST", "/v1/recipients", 400, "invalid_field", { field: "email", body: { type: "individual", email: "not-an-email", firstName: "M", lastName: "C" } });

  const studio = (await api("POST", "/v1/recipients", {
    body: {
      type: "business", email: "payables@northlantern.example.com", name: "North Lantern Studio", referenceId: "CR-2002",
      address: { street1: "400 Mill Rd", city: "Burlington", region: "VT", postalCode: "05401", country: "US" },
      accounts: [{ type: "check", mailing: { name: "North Lantern Studio", street1: "400 Mill Rd", city: "Burlington", region: "VT", postal: "05401", country: "US" } }],
    },
  })).recipient;
  assert.equal(studio.status, "active");
  assert.equal(studio.accounts.length, 1);
  assert.equal(studio.accounts[0].primary, true);
  assert.equal(studio.payoutMethod, "check");

  const rowanBody = { type: "individual", email: "rowan.pike@example.com", firstName: "Rowan", lastName: "Pike", referenceId: "CR-2001", tags: ["writer"] };
  const rowanKey = { "idempotency-key": "conformance-rowan-1" };
  const rowan = (await api("POST", "/v1/recipients", { body: rowanBody, headers: rowanKey })).recipient;
  assert.equal(rowan.status, "incomplete");
  // Idempotency-Key (Firedrill addition): same key + same body replays the recorded recipient; a different body or an
  // unsupported endpoint answers Trolley's invalid_field on the header; an over-long key is refused before dispatch.
  const replay = (await api("POST", "/v1/recipients", { body: rowanBody, headers: rowanKey })).recipient;
  assert.equal(replay.id, rowan.id, "same key and body replays the recorded outcome");
  await fails("POST", "/v1/recipients", 400, "invalid_field", { field: "Idempotency-Key", body: { ...rowanBody, lastName: "Pyke" }, headers: rowanKey });
  await fails("GET", "/v1/recipients?pageSize=1", 400, "invalid_field", { field: "Idempotency-Key", headers: rowanKey });
  await fails("POST", "/v1/recipients", 400, "invalid_field", { field: "Idempotency-Key", body: rowanBody, headers: { "idempotency-key": "k".repeat(256) } });
  const afterKeys = await api("GET", "/v1/recipients?search=rowan.pike");
  assert.deepEqual(afterKeys.recipients.map((recipient) => recipient.id), [rowan.id], "refused key reuse created nothing");
  assert.equal(rowan.name, "Rowan Pike");
  const addressed = (await api("PATCH", `/v1/recipients/${rowan.id}`, { body: { address: { street1: "8 Quay St", city: "Halifax", region: "NS", postalCode: "B3J 1A1", country: "CA" }, phone: "902-555-0120" } })).recipient;
  assert.equal(addressed.status, "incomplete", "an address without a payout method stays incomplete");
  assert.equal(addressed.address.city, "Halifax");
  const fetched = (await api("GET", `/v1/recipients/${rowan.id}`)).recipient;
  assert.equal(fetched.phone, "902-555-0120");
  await fails("PATCH", `/v1/recipients/${rowan.id}`, 400, "invalid_field", { field: "type", body: { type: "business" } });
  await fails("PATCH", `/v1/recipients/${rowan.id}`, 400, "empty_field", { field: "email", body: { email: "" } });
  await fails("PATCH", `/v1/recipients/${rowan.id}`, 400, "invalid_status", { body: { status: "active" } });
  await fails("PATCH", `/v1/recipients/${rowan.id}`, 400, "invalid_field", { body: { id: "R-0000000000000000000001" } });
  await fails("PATCH", `/v1/recipients/${R(999)}`, 404, "not_found", { body: { phone: "1" } });

  await fails("DELETE", `/v1/recipients/${R(1)}`, 400, "invalid_status");
  await fails("DELETE", `/v1/recipients/${R(999)}`, 404, "not_found");
  assert.deepEqual(await api("DELETE", `/v1/recipients/${rowan.id}`), { ok: true });
  assert.equal((await api("GET", `/v1/recipients/${rowan.id}`)).recipient.status, "archived");
  assert.equal((await api("GET", "/v1/recipients")).meta.records, 14);
  const restored = (await api("PATCH", `/v1/recipients/${rowan.id}`, { body: { status: "active" } })).recipient;
  assert.equal(restored.status, "incomplete");
  assert.equal((await api("GET", "/v1/recipients?search=CR-200")).meta.records, 2);
  assert.ok(B(1));
});
