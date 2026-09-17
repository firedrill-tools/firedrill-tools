// Records, objects, attributes, search, validation and uniqueness flows.
import { ID, assert, deepBody, del, fails, first, get, patch, post, put, rawRequest, slugs } from "./lib.mjs";

const PEOPLE = "/v2/objects/people/records";
const COMPANIES = "/v2/objects/companies/records";
const query = (object, body) => post(`/v2/objects/${object}/records/query`, body).then((r) => r.json.data);
const names = (records) => records.map((r) => r.values.name[0].full_name ?? r.values.name[0].value);

async function recordsFlow() {
  const self = (await get("/v2/self")).json;
  assert.equal(self.authorized_by_workspace_member_id, ID.priya);
  assert.equal(self.workspace_slug, "kestrel-labs");
  // The app resolves reference names past its index cap with a record_id "$in" query; unknown ids simply do not match.
  const byIds = await query("people", { filter: { record_id: { $in: [ID.aiko, ID.rafael, ID.record(999)] } }, limit: 100 });
  assert.deepEqual(byIds.map((r) => r.id.record_id).sort(), [ID.rafael, ID.aiko].sort());
  assert.equal(self.token_type, "Bearer");
  assert.equal(Object.hasOwn(self, "server_time"), false, "server_time is canonical-only");
  assert.deepEqual(slugs((await get("/v2/objects")).json.data), ["people", "companies", "deals"]);

  const peopleAttributes = ["record_id", "name", "email_addresses", "phone_numbers", "job_title", "description", "company", "created_at", "created_by"];
  assert.deepEqual(slugs((await get("/v2/objects/people/attributes")).json.data), peopleAttributes);
  assert.deepEqual(slugs((await get("/v2/objects/people/attributes?show_archived=true")).json.data), peopleAttributes);
  assert.deepEqual(slugs((await get("/v2/objects/people/attributes?limit=2&offset=1")).json.data), ["name", "email_addresses"]);
  const recruiting = (await get("/v2/lists/recruiting/attributes")).json.data;
  assert.deepEqual(slugs(recruiting), ["stage", "role"]);
  assert.deepEqual(recruiting[0].id.list_id, "00000005-0000-4000-8000-000000000142");
  const categories = (await get("/v2/objects/companies/attributes/categories/options")).json.data;
  assert.deepEqual(categories.map((option) => option.title), ["SaaS", "Logistics", "Energy", "Healthcare", "Hardware"]);
  assert.equal(categories[0].id.object_id, ID.companies);
  assert.equal((await get("/v2/objects/companies/attributes/categories/options?show_archived=true")).json.data.length, 6);
  const stages = (await get("/v2/objects/deals/attributes/stage/statuses")).json.data;
  assert.deepEqual(stages.map((status) => status.title), ["Lead", "In Progress", "Won 🎉", "Lost"]);
  assert.equal(stages[2].celebration_enabled, true);
  const listStages = (await get("/v2/lists/recruiting/attributes/stage/statuses")).json.data;
  assert.deepEqual(listStages.map((status) => status.title), ["Applied", "Screen", "Interview", "Offer"]);
  assert.equal(listStages[0].id.list_id, "00000005-0000-4000-8000-000000000142");
  assert.deepEqual((await get("/v2/lists/enterprise_accounts/attributes/priority/options")).json.data.map((option) => option.title), ["High", "Medium", "Low"]);

  assert.deepEqual(names(await query("people", { filter: { email_addresses: "marcus@brightwater-analytics.example.com" } })), ["Marcus Bell"]);
  const sams = await query("people", { filter: { name: { first_name: { $starts_with: "Sam" } } }, sorts: [{ direction: "desc", attribute: "name", field: "last_name" }] });
  assert.deepEqual(names(sams), ["Sam Okoro", "Sam Chen"]);
  const either = await query("people", { filter: { $or: [{ job_title: { $eq: "COO" } }, { name: { full_name: { $contains: "lindqvist" } } }] } });
  assert.deepEqual(names(either), ["Zoë Lindqvist", "Leo Fischer"]);
  assert.deepEqual(names(await query("people", { filter: { company: { target_record_id: ID.halcyon } } })), ["Zoë Lindqvist", "Sam Chen"]);
  assert.equal((await query("people", { limit: 5, offset: 10 })).length, 2);
  assert.equal((await query("people", { offset: 12 })).length, 0);
  assert.equal((await query("people", { filter: { $not: { email_addresses: { $not_empty: true } } } })).length, 1, "only Ines has no e-mail");

  const marcus = (await get(`${PEOPLE}/${ID.marcus}`)).json.data;
  assert.deepEqual(Object.keys(marcus.values), peopleAttributes);
  assert.equal(marcus.values.email_addresses.length, 2);
  assert.equal(marcus.values.company[0].target_record_id, ID.brightwater);
  assert.equal(marcus.web_url, `https://app.attio.com/kestrel-labs/person/${ID.marcus}/overview`);
  const brightwater = (await get(`${COMPANIES}/${ID.brightwater}`)).json.data;
  assert.deepEqual(brightwater.values.categories.map((v) => [v.option.title, v.option.is_archived]), [["SaaS", false], ["Finance", true]]);
  assert.deepEqual(names(await query("companies", { filter: { categories: "SaaS" } })), ["Brightwater Analytics"]);
  assert.equal((await query("deals", { filter: { stage: "Won 🎉" } })).length, 1);
  assert.equal((await query("deals", { filter: { value: { currency_value: { $gte: 20000 } } } })).length, 3);

  const created = (await post(PEOPLE, { data: { values: { name: "Mira Holm", email_addresses: ["mira.holm@halcyonfreight.example.com"], company: { target_object: "companies", target_record_id: ID.halcyon } } } })).json.data;
  const mira = created.id.record_id;
  assert.equal(mira, ID.record(1000));
  assert.equal(created.values.created_by[0].referenced_actor_type, "api-token");
  const halcyonTeam = (await get(`${COMPANIES}/${ID.halcyon}`)).json.data.values.team;
  assert.deepEqual(halcyonTeam.map((v) => v.target_record_id), [ID.zoe, ID.samChen, mira], "the inverse team is updated");

  const appended = (await patch(`${PEOPLE}/${mira}`, { data: { values: { email_addresses: ["mira@halcyon-freight.example.com"] } } })).json.data;
  assert.deepEqual(appended.values.email_addresses.map((v) => v.email_address), ["mira.holm@halcyonfreight.example.com", "mira@halcyon-freight.example.com"]);
  const overwritten = (await put(`${PEOPLE}/${mira}`, { data: { values: { email_addresses: ["mira.holm@halcyonfreight.example.com"] } } })).json.data;
  assert.deepEqual(overwritten.values.email_addresses.map((v) => v.email_address), ["mira.holm@halcyonfreight.example.com"]);
  const asserted = (await put(`${PEOPLE}?matching_attribute=email_addresses`, { data: { values: { email_addresses: "Mira.Holm@halcyonfreight.example.com", job_title: "Dispatcher" } } })).json.data;
  assert.equal(asserted.id.record_id, mira, "assert updates the single match");
  assert.equal(first(asserted.values.job_title, "value"), "Dispatcher");
  const jonas = (await put(`${PEOPLE}?matching_attribute=email_addresses`, { data: { values: { email_addresses: "jonas.berg@norrland-energy.example.com", name: "Jonas Berg" } } })).json.data;
  assert.equal(jonas.id.record_id, ID.record(1001), "assert creates when nothing matches");
  const kite = (await put(`${COMPANIES}?matching_attribute=domains`, { data: { values: { domains: "https://www.KiteRobotics.example.com/about", name: "Kite Robotics" } } })).json.data;
  assert.equal(kite.id.record_id, ID.record(1002));
  assert.deepEqual(kite.values.domains.map((v) => [v.domain, v.root_domain]), [["kiterobotics.example.com", "example.com"]]);

  const sam = (await post("/v2/objects/records/search", { query: "sam", objects: ["people"], request_as: { type: "workspace" } })).json.data;
  assert.deepEqual(sam.map((hit) => hit.record_text), ["Sam Chen", "Sam Okoro"]);
  const halcyon = (await post("/v2/objects/records/search", { query: "halcyon", objects: ["companies", "deals"], request_as: { type: "workspace-member", workspace_member_id: ID.tomas }, limit: 25 })).json.data;
  assert.deepEqual(halcyon.map((hit) => [hit.object_slug, hit.record_text]).sort(), [["companies", "Halcyon Freight"], ["deals", "Halcyon fleet rollout"]]);
  assert.deepEqual((await post("/v2/objects/records/search", { query: "zoe", objects: ["people"], request_as: { type: "workspace" } })).json.data.map((h) => h.record_text), ["Zoë Lindqvist"]);

  assert.deepEqual((await del(`${PEOPLE}/${ID.zoe}`)).json, {});
  await fails("GET", `${PEOPLE}/${ID.zoe}`, undefined, 404, "not_found");
  assert.deepEqual((await get(`${COMPANIES}/${ID.halcyon}`)).json.data.values.team.map((v) => v.target_record_id), [ID.samChen, mira]);
  assert.deepEqual((await get(`/v2/objects/deals/records/${ID.halcyonRollout}`)).json.data.values.associated_people.map((v) => v.target_record_id), [ID.samChen]);
  assert.equal((await get(`/v2/notes?parent_object=people&parent_record_id=${ID.zoe}`)).json.data.length, 0);
  assert.equal((await post("/v2/lists/recruiting/entries/query", {})).json.data.length, 3);
}

async function validationFlow() {
  const P = PEOPLE;
  await fails("GET", "/v2/objects/widgets/attributes", undefined, 404, "not_found", "widgets");
  await fails("GET", "/v2/objects/people/attributes?limit=0", undefined, 400, "validation_type");
  await fails("GET", "/v2/lists/recruiting/attributes?show_archived=maybe", undefined, 400, "validation_type");
  await fails("GET", "/v2/objects/companies/attributes/shoe_size/options", undefined, 404, "not_found", "shoe_size");
  await fails("GET", "/v2/objects/companies/attributes/name/options", undefined, 400, "validation_type");
  await fails("GET", "/v2/objects/widgets/attributes/stage/statuses", undefined, 404, "not_found");
  await fails("GET", "/v2/objects/deals/attributes/stage/statuses?show_archived=maybe", undefined, 400, "validation_type");
  await fails("POST", "/v2/objects/widgets/records/query", {}, 404, "not_found");
  for (const body of [
    { filter: { shoe_size: 42 } }, { filter_view_id: "view" }, { filter: { name: { full_name: { $regex: "^Z" } } } },
    { filter: { $and: [{ $and: [{ $and: [{ $and: [{ $and: [{ $and: [{ $and: [{ $and: [{ name: "x" }] }] }] }] }] }] }] }] } },
    { limit: 0 }, { offset: -1 }, { filter: { constructor: "x" } }, { filter: { job_title: { $contains: "bad�text" } } },
    { sorts: [{ direction: "sideways", attribute: "name" }] }, [1, 2],
    { filter: { record_id: { $in: Array.from({ length: 101 }, (_, i) => ID.record(i)) } } }, { filter: { record_id: { $in: [] } } },
  ]) await fails("POST", "/v2/objects/people/records/query", body, 400, "validation_type");
  await fails("GET", `${P}/${ID.record(999)}`, undefined, 404, "not_found");
  await fails("GET", `${P}/not-a-uuid`, undefined, 404, "not_found");

  await fails("POST", "/v2/objects/widgets/records", { data: { values: {} } }, 404, "not_found");
  await fails("POST", P, { data: { values: { nope: "x" } } }, 400, "validation_type", "nope");
  await fails("POST", P, { data: { values: { record_id: "x" } } }, 400, "validation_type", "not writable");
  await fails("POST", P, { data: { values: { email_addresses: "not-an-email" } } }, 400, "validation_type");
  await fails("POST", P, { data: { values: { job_title: ["A", "B"] } } }, 400, "validation_type");
  await fails("POST", P, { data: {} }, 400, "validation_type");
  await fails("POST", "/v2/objects/deals/records", { data: { values: { name: "No stage", owner: { workspace_member_email_address: "hana.sato@kestrel-labs.example.com" } } } }, 400, "validation_type", "stage");
  await fails("POST", COMPANIES, { data: { values: { name: "X", categories: ["Crypto"] } } }, 400, "value_not_found");
  await fails("POST", COMPANIES, { data: { values: { name: "X", categories: ["Finance"] } } }, 400, "value_not_found");
  await fails("POST", "/v2/objects/deals/records", { data: { values: { name: "X", stage: "Paused", owner: ID.priya } } }, 400, "value_not_found");
  await fails("POST", P, { data: { values: { company: { target_object: "companies", target_record_id: ID.record(998) } } } }, 400, "value_not_found");
  await fails("POST", "/v2/objects/deals/records", { data: { values: { name: "X", stage: "Lead", owner: { workspace_member_email_address: "nobody@kestrel-labs.example.com" } } } }, 400, "value_not_found");
  await fails("POST", P, { data: { values: { name: "Copy", email_addresses: "MARCUS.BELL@brightwater.example.com" } } }, 409, "uniqueness_conflict", "email_addresses");

  await fails("PUT", "/v2/objects/widgets/records?matching_attribute=domains", { data: { values: {} } }, 404, "not_found");
  await fails("PUT", `${P}?matching_attribute=job_title`, { data: { values: { job_title: "X" } } }, 400, "validation_type", "not unique");
  await fails("PUT", P, { data: { values: { email_addresses: "x@example.com" } } }, 400, "validation_type", "matching_attribute");
  await fails("PUT", `${COMPANIES}?matching_attribute=domains`, { data: { values: { domains: "cobaltpine.example.com" } } }, 400, "multiple_match_results");
  await fails("PUT", `${COMPANIES}?matching_attribute=domains`, { data: { values: { domains: "new.example.com", categories: "Crypto" } } }, 400, "value_not_found");

  await fails("PATCH", `${P}/${ID.record(999)}`, { data: { values: { job_title: "x" } } }, 404, "not_found");
  await fails("PATCH", `${P}/${ID.marcus}`, { data: { values: {} } }, 400, "validation_type", "empty payload");
  await fails("PATCH", `${COMPANIES}/${ID.halcyon}`, { data: { values: { employee_range: "Huge" } } }, 400, "value_not_found");
  await fails("PATCH", `${P}/${ID.zoe}`, { data: { values: { email_addresses: "marcus.bell@brightwater.example.com" } } }, 409, "uniqueness_conflict");
  await fails("PUT", `/v2/objects/deals/records/${ID.atlasPoc}`, { data: { values: { stage: [] } } }, 400, "validation_type", "cannot be cleared");
  await fails("DELETE", `${P}/${ID.record(999)}`, undefined, 404, "not_found");

  await fails("POST", "/v2/objects/records/search", { query: "a", objects: ["widgets"], request_as: { type: "workspace" } }, 404, "not_found");
  await fails("POST", "/v2/objects/records/search", { query: 7, objects: ["people"], request_as: { type: "workspace" } }, 400, "validation_type");
  await fails("POST", "/v2/objects/records/search", { query: "a", objects: ["people"], request_as: { type: "workspace-member", email_address: "nobody@kestrel-labs.example.com" } }, 400, "value_not_found");

  const E = "/v2/lists/enterprise_accounts/entries";
  await fails("POST", "/v2/lists/unknown_list/entries/query", {}, 404, "not_found");
  await fails("POST", `${E}/query`, { filter: { stage: { $gt: "x" } } }, 400, "validation_type");
  await fails("POST", "/v2/lists/unknown_list/entries", { data: {} }, 404, "not_found");
  await fails("POST", E, { data: { parent_object: "people", parent_record_id: ID.marcus, entry_values: {} } }, 400, "validation_type");
  await fails("POST", E, { data: { parent_object: "companies", parent_record_id: ID.record(997), entry_values: {} } }, 404, "not_found");
  await fails("POST", E, { data: { parent_object: "companies", parent_record_id: ID.juniper, entry_values: { priority: "Urgent" } } }, 400, "value_not_found");
  await fails("GET", `${E}/${ID.entry(999)}`, undefined, 404, "not_found");
  await fails("PATCH", `${E}/${ID.entry(999)}`, { data: { entry_values: { priority: "Low" } } }, 404, "not_found");
  await fails("PATCH", `${E}/${ID.entry(151)}`, { data: { entry_values: {} } }, 400, "validation_type");
  await fails("PATCH", `${E}/${ID.entry(151)}`, { data: { entry_values: { priority: "Urgent" } } }, 400, "value_not_found");
  await fails("DELETE", `${E}/${ID.entry(999)}`, undefined, 404, "not_found");

  await fails("GET", "/v2/notes?parent_object=people", undefined, 400, "validation_type");
  await fails("GET", `/v2/notes?parent_object=widgets&parent_record_id=${ID.zoe}`, undefined, 404, "not_found");
  await fails("GET", "/v2/notes?limit=51", undefined, 400, "validation_type");
  await fails("GET", `/v2/notes/${ID.note(999)}`, undefined, 404, "not_found");
  const note = (extra) => ({ data: { parent_object: "people", parent_record_id: ID.rafael, title: "T", format: "plaintext", content: "c", ...extra } });
  await fails("POST", "/v2/notes", note({ parent_object: "widgets" }), 404, "not_found");
  await fails("POST", "/v2/notes", note({ format: "html" }), 400, "validation_type");
  await fails("POST", "/v2/notes", note({ content: "x".repeat(100_001) }), 413, "content_too_large");
  await fails("DELETE", `/v2/notes/${ID.note(999)}`, undefined, 404, "not_found");

  await fails("GET", `/v2/tasks?linked_object=widgets&linked_record_id=${ID.zoe}`, undefined, 404, "not_found");
  await fails("GET", "/v2/tasks?sort=deadline_at:asc", undefined, 400, "validation_type");
  await fails("GET", "/v2/tasks?is_completed=yes", undefined, 400, "validation_type");
  await fails("GET", "/v2/tasks?assignee=nobody@kestrel-labs.example.com", undefined, 400, "value_not_found");
  const task = (extra) => ({ data: { content: "T", format: "plaintext", deadline_at: null, is_completed: false, linked_records: [], assignees: [], ...extra } });
  await fails("POST", "/v2/tasks", { data: { format: "plaintext" } }, 400, "validation_type", "content");
  await fails("POST", "/v2/tasks", task({ deadline_at: "2026-02-30T10:00:00Z" }), 400, "validation_type");
  await fails("POST", "/v2/tasks", task({ linked_records: [{ target_object: "people", target_record_id: ID.record(996) }] }), 404, "not_found");
  await fails("POST", "/v2/tasks", task({ assignees: [{ workspace_member_email_address: "nobody@kestrel-labs.example.com" }] }), 400, "value_not_found");
  await fails("PATCH", `/v2/tasks/${ID.task(999)}`, { data: { is_completed: true } }, 404, "not_found");
  await fails("PATCH", `/v2/tasks/${ID.task(181)}`, { data: { content: "new" } }, 400, "validation_type", "cannot be updated");
  await fails("PATCH", `/v2/tasks/${ID.task(181)}`, { data: { assignees: [{ referenced_actor_type: "workspace-member", referenced_actor_id: ID.record(1) }] } }, 400, "value_not_found");
  await fails("DELETE", `/v2/tasks/${ID.task(999)}`, undefined, 404, "not_found");
  // Bodies nested past 512 levels answer 400 before argument validation (including the framework's 3,000-level window).
  const deep = [
    ["POST", "/v2/objects/people/records/query", "filter"], ["POST", "/v2/objects/people/records", "data"],
    ["POST", "/v2/notes", "data"], ["POST", "/v2/tasks", "data"], ["PATCH", `/v2/tasks/${ID.task(181)}`, "data"],
    ["POST", "/v2/objects/records/search", "query"], ["POST", "/v2/lists/enterprise_accounts/entries/query", "filter"],
  ];
  for (const [method, path, key] of deep) {
    for (const depth of [513, 2998, 3152]) {
      for (const shape of ["array", "object"]) {
        const { status } = await rawRequest(method, path, deepBody(key, depth, shape));
        assert.equal(status, 400, `${method} ${path}: ${shape}s nested ${depth} under ${key} -> ${status}`);
      }
    }
  }
  // 510 levels is inside the guard, so the handler answers Attio's own validation error.
  const shallow = await rawRequest("POST", "/v2/objects/people/records/query", deepBody("filter", 510, "array"));
  assert.equal(shallow.status, 400);
  assert.equal(shallow.json.code, "validation_type", `510 levels reach the handler: ${JSON.stringify(shallow.json).slice(0, 200)}`);
}

async function assertUniquenessFlow() {
  const clash = { data: { values: { email_addresses: "zoe.lindqvist@halcyonfreight.example.com", phone_numbers: "+46 70 123 45 67" } } };
  await fails("PUT", `${PEOPLE}?matching_attribute=email_addresses`, clash, 409, "uniqueness_conflict", "phone_numbers");
  const ok = { data: { values: { email_addresses: "zoe.lindqvist@halcyonfreight.example.com", phone_numbers: { original_phone_number: "070 123 49 99", country_code: "SE" } } } };
  const zoe = (await put(`${PEOPLE}?matching_attribute=email_addresses`, ok)).json.data;
  assert.equal(zoe.id.record_id, ID.zoe);
  assert.equal(zoe.values.phone_numbers[0].phone_number, "+46701234999");
}

export const recordFlows = { "records-flow": recordsFlow, "validation-errors": validationFlow, "assert-uniqueness": assertUniquenessFlow };
