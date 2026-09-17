// Lists and entries, list permissions, notes, tasks, identity and scope flows.
import { ID, assert, del, fails, get, patch, post, put, slugs } from "./lib.mjs";

const E = "/v2/lists/enterprise_accounts/entries";

async function listsEntriesFlow() {
  assert.deepEqual(slugs((await get("/v2/lists")).json.data), ["enterprise_accounts", "recruiting", "partner_referrals"], "investors is invisible to Tomás");
  assert.deepEqual(slugs((await get("/v2/lists/enterprise_accounts/attributes")).json.data), ["stage", "priority", "next_review"]);
  await fails("POST", "/v2/lists/investors/entries/query", {}, 404, "not_found", "investors");

  const negotiation = (await post(`${E}/query`, { filter: { stage: "Negotiation" }, sorts: [{ direction: "asc", attribute: "next_review" }] })).json.data;
  assert.deepEqual(negotiation.map((entry) => entry.parent_record_id), [ID.norrland, ID.halcyon]);
  const pathFilter = { filter: { path: [["enterprise_accounts", "parent_record"], ["companies", "name"]], constraints: { value: { $contains: "bright" } } } };
  assert.deepEqual((await post(`${E}/query`, pathFilter)).json.data.map((entry) => entry.parent_record_id), [ID.brightwater, ID.brightwater]);
  assert.equal((await post(`${E}/query`, { limit: 2, offset: 4 })).json.data.length, 1);

  const created = (await post(E, { data: { parent_record_id: ID.juniper, parent_object: "companies", entry_values: { priority: "High", stage: "Prospecting" } } })).json.data;
  const entryId = created.id.entry_id;
  assert.equal(entryId, ID.entry(1000));
  assert.equal(created.entry_values.priority[0].option.title, "High");
  assert.deepEqual((await get(`${E}/${entryId}`)).json.data.id, created.id);
  const reviewed = (await patch(`${E}/${entryId}`, { data: { entry_values: { next_review: "2026-10-15T08:00:00+02:00" } } })).json.data;
  assert.equal(reviewed.entry_values.next_review[0].value, "2026-10-15");
  const cleared = (await put(`${E}/${entryId}`, { data: { entry_values: { priority: [] } } })).json.data;
  assert.deepEqual(cleared.entry_values.priority, []);
  assert.equal(cleared.entry_values.stage[0].status.title, "Prospecting", "overwrite leaves unmentioned attributes");

  const second = (await post(E, { data: { parent_record_id: ID.juniper, parent_object: ID.companies, entry_values: {} } })).json.data;
  assert.equal(second.id.entry_id, ID.entry(1001), "a record can be in a list more than once");
  assert.deepEqual((await del(`${E}/${second.id.entry_id}`)).json, {});
  await fails("GET", `${E}/${second.id.entry_id}`, undefined, 404, "not_found");

  const referral = (await post("/v2/lists/partner_referrals/entries", { data: { parent_record_id: ID.rafael, parent_object: "people", entry_values: { referred_by: { workspace_member_email_address: "tomas.ferreira@kestrel-labs.example.com" } } } })).json.data;
  assert.equal(referral.entry_values.referred_by[0].referenced_actor_id, ID.tomas, "member access upgrades a read-only list");
}

async function listPermissionsFlow() {
  assert.deepEqual(slugs((await get("/v2/lists")).json.data), ["enterprise_accounts", "recruiting", "partner_referrals"]);
  await fails("POST", "/v2/lists/investors/entries/query", {}, 404, "not_found");
  await fails("GET", "/v2/lists/investors/attributes", undefined, 404, "not_found");
  const P = "/v2/lists/partner_referrals/entries";
  await fails("POST", P, { data: { parent_record_id: ID.rafael, parent_object: "people", entry_values: {} } }, 403, "unauthorized", "permission to write");
  await fails("PATCH", `${P}/${ID.entry(161)}`, { data: { entry_values: { referred_by: ID.hana } } }, 403, "unauthorized");
  await fails("DELETE", `${P}/${ID.entry(162)}`, undefined, 403, "unauthorized");
}

async function notesTasksFlow() {
  const newest = (await get("/v2/notes?limit=2")).json.data;
  assert.deepEqual(newest.map((note) => note.id.note_id), [ID.note(173), ID.note(175)]);
  assert.equal((await get("/v2/notes?offset=4")).json.data.length, 2);
  assert.equal((await get("/v2/notes?offset=6")).json.data.length, 0);
  assert.equal((await get(`/v2/notes?parent_object=companies&parent_record_id=${ID.halcyon}`)).json.data.length, 3);
  assert.equal(newest[0].content_markdown, "Discount tiers use \\*literal asterisks\\* in their internal sheet: \\*A\\*, \\*B\\* and \\*C\\*.");

  const markdown = "# Onboarding plan\n\n- Train **drivers** first\n- Then _dispatch_\n\nDetails in [the plan](https://example.com/plan).";
  const md = (await post("/v2/notes", { data: { parent_object: "companies", parent_record_id: ID.halcyon, title: "Plan", format: "markdown", content: markdown } })).json.data;
  assert.equal(md.id.note_id, ID.note(1000));
  assert.equal(md.content_markdown, markdown);
  assert.equal(md.content_plaintext, "Onboarding plan\n\nTrain drivers first\nThen dispatch\n\nDetails in the plan.");
  assert.deepEqual((await get(`/v2/notes/${md.id.note_id}`)).json.data, md);
  const plain = (await post("/v2/notes", { data: { parent_object: "people", parent_record_id: ID.rafael, title: "Stars", format: "plaintext", content: "Use *stars*" } })).json.data;
  assert.equal(plain.content_markdown, "Use \\*stars\\*");
  assert.deepEqual((await del(`/v2/notes/${plain.id.note_id}`)).json, {});
  await fails("GET", `/v2/notes/${plain.id.note_id}`, undefined, 404, "not_found");

  const ids = (path) => get(path).then((r) => r.json.data.map((task) => task.id.task_id));
  assert.equal((await ids("/v2/tasks?is_completed=false")).length, 6);
  assert.deepEqual(await ids("/v2/tasks?assignee=tomas.ferreira@kestrel-labs.example.com"), [ID.task(181), ID.task(185), ID.task(187)]);
  assert.deepEqual(await ids(`/v2/tasks?assignee=${ID.hana}`), [ID.task(182), ID.task(186)]);
  assert.deepEqual(await ids("/v2/tasks?assignee="), [ID.task(184)]);
  assert.deepEqual(await ids(`/v2/tasks?linked_object=companies&linked_record_id=${ID.halcyon}`), [ID.task(181)]);
  // Completion combines with the linked-record filter server-side (the app's record Overview asks for open tasks only).
  const linkedAll = (await get(`/v2/tasks?linked_object=companies&linked_record_id=${ID.halcyon}`)).json.data;
  for (const flag of [true, false]) {
    assert.deepEqual(await ids(`/v2/tasks?linked_object=companies&linked_record_id=${ID.halcyon}&is_completed=${flag}&limit=5`), linkedAll.filter((t) => t.is_completed === flag).map((t) => t.id.task_id));
  }
  assert.equal((await ids("/v2/tasks?sort=completed_at:desc"))[0], ID.task(183));
  assert.deepEqual(await ids("/v2/tasks?limit=3&offset=3&sort=created_at:desc"), [ID.task(185), ID.task(184), ID.task(183)]);

  const body = { data: { content: "Call Zoë about onboarding", format: "plaintext", deadline_at: "2026-09-18T10:00:00Z", is_completed: false, linked_records: [{ target_object: "people", email_addresses: "zoe.lindqvist@halcyonfreight.example.com" }], assignees: [{ workspace_member_email_address: "hana.sato@kestrel-labs.example.com" }] } };
  const task = (await post("/v2/tasks", body)).json.data;
  assert.equal(task.id.task_id, ID.task(1002));
  assert.deepEqual(task.linked_records, [{ target_object_id: ID.people, target_record_id: ID.zoe }]);
  assert.deepEqual(task.assignees, [{ referenced_actor_type: "workspace-member", referenced_actor_id: ID.hana }]);
  assert.equal(task.deadline_at, "2026-09-18T10:00:00.000000000Z");
  const done = (await patch(`/v2/tasks/${task.id.task_id}`, { data: { is_completed: true } })).json.data;
  assert.equal(done.completed_at, "2026-09-15T09:00:00.000000000Z", "completed_at comes from virtual time");
  const reopened = (await patch(`/v2/tasks/${task.id.task_id}`, { data: { is_completed: false, deadline_at: null } })).json.data;
  assert.equal(reopened.completed_at, null);
  assert.equal(reopened.deadline_at, null);
  assert.deepEqual((await del(`/v2/tasks/${ID.task(186)}`)).json, {});
  assert.equal((await ids("/v2/tasks")).length, 7);

  const members = (await get("/v2/workspace_members")).json.data;
  assert.deepEqual(members.map((m) => [m.first_name, m.access_level]), [["Priya", "admin"], ["Tomás", "member"], ["Hana", "member"], ["Owen", "suspended"]]);
}

async function defaultIdentityFlow() {
  const self = (await get("/v2/self")).json;
  assert.equal(self.authorized_by_workspace_member_id, ID.priya, "a fresh actor acts as the first admin");
  assert.equal((await get("/v2/lists")).json.data.length, 4, "the admin sees the investors list");
  const task = (await post("/v2/tasks", { data: { content: "Fresh install check", format: "plaintext", deadline_at: null, is_completed: false, linked_records: [], assignees: [] } })).json.data;
  assert.equal(task.id.task_id, ID.task(1000));
  assert.equal(task.created_at, "2026-09-15T09:00:00.000000000Z");
  assert.equal(task.created_by_actor.type, "api-token");
}

async function scopesFlow() {
  assert.equal((await post("/v2/objects/people/records/query", { limit: 1 })).json.data.length, 1);
  assert.equal((await get("/v2/self")).json.scope, "object_configuration:read record_permission:read");
  await fails("POST", "/v2/objects/people/records", { data: { values: { name: "Scoped" } } }, 403, "unauthorized", "record_permission:read-write");
  await fails("GET", "/v2/notes", undefined, 403, "unauthorized", "note:read");
  await fails("GET", "/v2/lists", undefined, 403, "unauthorized", "list_configuration:read");
  await fails("GET", "/v2/tasks", undefined, 403, "unauthorized", "task:read");
}

export const listNoteFlows = {
  "lists-entries": listsEntriesFlow,
  "list-permissions": listPermissionsFlow,
  "notes-tasks": notesTasksFlow,
  "default-identity": defaultIdentityFlow,
  scopes: scopesFlow,
};
