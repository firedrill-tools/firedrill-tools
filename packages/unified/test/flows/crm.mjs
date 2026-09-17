// Drill unified-crm-flow (admin, baseline): contacts, companies, deals, pipelines, permissions and connection states.
import { C, CO, D, K, NEW, NONE, NOW, PL, apiError, assert, del, get, ids, noneHas, patch, post, put, walk } from "../lib.mjs";

const M = `/crm/${C.main}`;

export async function crm() {
  // Listing, paging and parameter validation.
  const all = (await get(`${M}/contact`)).json;
  assert.deepEqual(ids(all), [K.elena, K.tomas, K.priya, K.jonas, K.ravi, K.ana, K.liwei, K.sam]);
  assert.ok(noneHas(all, "raw") && noneHas(all, "connection_id"), "default projection hides raw and connection_id");
  assert.equal((await walk(`${M}/contact`, 3, [3, 3, 2])).length, 8);
  assert.deepEqual((await get(`${M}/contact?offset=50`)).json, []);
  for (const bad of ["limit=0", "limit=x", "offset=-1", "sort=email", "order=up", "updated_gte=2026-13-01", "query=%ZZ%FF", "company_id=notanid"]) {
    await apiError("GET", `${M}/contact?${bad}`, 400, "");
  }
  assert.equal((await get(`${M}/contact?limit=500`)).json.length, 8, "limit above 100 is capped, not rejected");
  assert.deepEqual(ids((await get(`${M}/contact?query=northwind`)).json), [K.elena, K.tomas], "query matches e-mail domains");
  assert.deepEqual(ids((await get(`${M}/contact?query=JONAS`)).json), [K.jonas], "query is case-folded and matches names");
  assert.deepEqual(ids((await get(`${M}/contact?company_id=${CO.northwind}`)).json), [K.elena, K.tomas]);
  assert.deepEqual(ids((await get(`${M}/contact?deal_id=${D.pilot}`)).json), [K.priya]);
  assert.deepEqual(ids((await get(`${M}/contact?user_id=u-maya`)).json), [K.tomas]);
  assert.deepEqual(ids((await get(`${M}/contact?updated_gte=2026-09-10`)).json), [K.elena, K.tomas, K.liwei, K.sam], "zone-less updated_gte is UTC midnight");
  assert.equal(ids((await get(`${M}/contact?sort=name&order=desc`)).json)[0], K.liwei, "CJK name sorts last by code point");
  assert.equal(ids((await get(`${M}/contact?sort=updated_at&order=asc`)).json)[0], K.ravi);
  const projected = (await get(`${M}/contact?fields=id,name,emails`)).json;
  for (const row of projected) assert.deepEqual(Object.keys(row).sort(), ["emails", "id", "name"]);
  const withRaw = (await get(`${M}/contact?fields=raw&limit=1`)).json[0];
  assert.deepEqual(withRaw, { id: K.elena, raw: { hs_object_id: "501" } });

  // Point reads.
  const elena = (await get(`${M}/contact/${K.elena}`)).json;
  assert.equal(elena.name, "Elena Marsh");
  assert.equal(elena.emails.length, 2);
  assert.equal(elena.address.city, "Bristol");
  assert.deepEqual(elena.deal_ids, [D.q4, D.renewal]);
  await apiError("GET", `${M}/contact/${NONE}`, 404, "Contact not found");
  await apiError("GET", `${M}/contact/notahexid`, 400, "Invalid contact id");

  // Create with symmetric associations, merge updates (PATCH and PUT), remove with detachment.
  await apiError("POST", `${M}/contact`, 400, "At least one of name", { body: {} });
  await apiError("POST", `${M}/contact`, 400, "Unknown company id", { body: { name: "Ghost", company_ids: [NONE] } });
  await apiError("POST", `${M}/contact`, 400, "emails[0].email", { body: { name: "Bad mail", emails: [{ email: "nope" }] } });
  const lena = (await post(`${M}/contact`, { first_name: "Lena", emails: [{ email: "lena@example.org", type: "WORK" }], company_ids: [CO.contoso] })).json;
  assert.equal(lena.id, NEW(1));
  assert.equal(lena.name, "Lena", "name derives from first_name");
  assert.equal(lena.created_at, NOW);
  assert.deepEqual(lena.company_ids, [CO.contoso]);
  assert.deepEqual((await get(`${M}/company/${CO.contoso}`)).json.contact_ids, [K.priya, NEW(1)], "company gained the reverse link");
  const renamed = (await patch(`${M}/contact/${NEW(1)}`, { last_name: "Ortiz", company_ids: [] })).json;
  assert.equal(renamed.name, "Lena Ortiz");
  assert.deepEqual((await get(`${M}/company/${CO.contoso}`)).json.contact_ids, [K.priya], "company lost the reverse link");
  const jonas = (await put(`${M}/contact/${K.jonas}`, { title: "Director" })).json;
  assert.equal(jonas.title, "Director");
  assert.equal(jonas.name, "Jonas Weber", "PUT merges instead of replacing");
  assert.deepEqual((await del(`${M}/contact/${K.elena}`)).json, {});
  assert.deepEqual((await get(`${M}/deal/${D.q4}`)).json.contact_ids, [K.tomas], "deal dropped the removed contact");
  assert.deepEqual((await get(`${M}/company/${CO.northwind}`)).json.contact_ids, [K.tomas]);
  await apiError("GET", `${M}/contact/${K.elena}`, 404, "Contact not found");
  assert.deepEqual((await get(`${M}/contact?deal_id=${D.q4}`)).json.map((row) => row.id), [K.tomas]);

  // Companies.
  await apiError("POST", `${M}/company`, 400, "name", { body: {} });
  const woodgrove = (await post(`${M}/company`, { name: "Woodgrove", domains: ["woodgrove.example.org"] })).json;
  assert.equal(woodgrove.id, NEW(2));
  assert.equal(woodgrove.is_active, true);
  assert.deepEqual(ids((await get(`${M}/company?query=woodgrove.example`)).json), [NEW(2)], "query matches company domains");
  assert.deepEqual((await get(`${M}/company?contact_id=${K.elena}`)).json, []);
  assert.equal((await get(`${M}/company`)).json.length, 6);
  assert.equal((await get(`${M}/company?query=山田`)).json[0].id, CO.yamada);
  assert.equal((await patch(`${M}/company/${NEW(2)}`, { employees: 12 })).json.employees, 12);
  await apiError("PUT", `${M}/company/${CO.fabrikam}`, 400, "Invalid value for name", { body: { name: null } });
  await apiError("GET", `${M}/company/${NONE}`, 404, "Company not found");
  assert.deepEqual((await del(`${M}/company/${NEW(2)}`)).json, {});

  // Deals: pipeline and stage derivation.
  await apiError("POST", `${M}/deal`, 400, "name", { body: {} });
  const deal = (await post(`${M}/deal`, { name: "New", stages: [{ id: PL.negotiation }], company_ids: [CO.contoso] })).json;
  assert.equal(deal.id, NEW(3));
  assert.deepEqual(deal.pipelines, [{ id: PL.sales, name: "Sales Pipeline", type: null }], "pipeline derived from the stage");
  assert.equal(deal.stages[0].name, "Negotiation");
  assert.equal(deal.probability, 70, "probability defaults from the stage");
  assert.deepEqual((await get(`${M}/company/${CO.contoso}`)).json.deal_ids, [D.pilot, NEW(3)]);
  await apiError("POST", `${M}/deal`, 400, "does not belong to pipeline", { body: { name: "Bad", pipelines: [{ id: PL.renewals }], stages: [{ id: PL.negotiation }] } });
  const won = (await patch(`${M}/deal/${D.q4}`, { stages: [{ id: PL.won }] })).json;
  assert.equal(won.closed_at, NOW, "entering a closed stage stamps closed_at with virtual time");
  assert.equal(won.probability, 100);
  const reopened = (await patch(`${M}/deal/${D.q4}`, { stages: [{ id: PL.proposal }] })).json;
  assert.equal(reopened.closed_at, null);
  assert.equal(reopened.probability, 40);
  await apiError("PATCH", `${M}/deal/${D.q4}`, 400, "currency", { body: { currency: "usd" } });
  assert.deepEqual(ids((await get(`${M}/deal?pipeline_id=${PL.renewals}`)).json), [D.renewal]);
  assert.deepEqual(ids((await get(`${M}/deal?company_id=${CO.northwind}`)).json), [D.q4, D.renewal]);
  assert.equal((await get(`${M}/deal`)).json.length, 7);
  await apiError("GET", `${M}/deal?sort=amount`, 400, "sort must be one of");
  assert.equal((await put(`${M}/deal/${NEW(3)}`, { amount: 1000, currency: "USD" })).json.amount, 1000);
  assert.deepEqual((await del(`${M}/deal/${NEW(3)}`)).json, {});
  assert.deepEqual((await get(`${M}/company/${CO.contoso}`)).json.deal_ids, [D.pilot]);
  await apiError("GET", `${M}/deal/${NEW(3)}`, 404, "Deal not found");

  // Pipelines (read-only reference data).
  const pipelines = (await get(`${M}/pipeline`)).json;
  assert.deepEqual(ids(pipelines), [PL.sales, PL.renewals]);
  assert.deepEqual(pipelines[0].stages.map((stage) => stage.name), ["Qualification", "Proposal", "Negotiation", "Closed Won", "Closed Lost"]);
  assert.equal((await get(`${M}/pipeline/${PL.sales}`)).json.name, "Sales Pipeline");
  await apiError("GET", `${M}/pipeline/${NONE}`, 404, "Pipeline not found");

  // Connection states: permissions, paused, broken, wrong category, Sandbox, unknown, absent route.
  assert.deepEqual(ids((await get(`/crm/${C.readonly}/contact`)).json), [K.dana]);
  await apiError("POST", `/crm/${C.readonly}/contact`, 403, "crm_contact_write", { body: { name: "Nope" } });
  await apiError("GET", `/crm/${C.readonly}/deal`, 403, "crm_deal_read");
  await apiError("GET", `/crm/${C.readonly}/pipeline`, 403, "crm_pipeline_read");
  await apiError("GET", `/crm/${C.paused}/contact`, 403, "paused");
  await apiError("GET", `/crm/${C.broken}/contact`, 401, "likely broken");
  await apiError("GET", `/crm/${C.hris}/contact`, 501, "not supported by this integration");
  assert.deepEqual(ids((await get(`/crm/${C.sandbox}/contact`)).json), [K.sandbox]);
  await apiError("GET", `/crm/${NONE}/contact`, 404, "Connection not found");
  assert.equal((await api404(`${M}/lead`)), 404);
}

async function api404(path) {
  const response = await fetch(`${process.env.FIREDRILL_HTTP_URL}${path}`, { method: "POST", headers: { authorization: `Bearer ${process.env.FIREDRILL_HTTP_TOKEN}`, "content-type": "application/json" }, body: "{}" });
  await response.text();
  return response.status;
}
