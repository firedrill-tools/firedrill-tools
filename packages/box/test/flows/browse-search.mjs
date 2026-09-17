// Search query language, filters and paging; the user event stream.
import assert from "node:assert/strict";
import { F, FI, get, names } from "../client.mjs";

const search = async (params, expect = 200) => get(`/2.0/search?${new URLSearchParams(params)}`, expect);

export async function searchAndEvents() {
  const budget = await search({ query: "quarterly budget" });
  assert.deepEqual(names(budget.body.entries), ["meeting-notes-2026-09-10.md"], "terms match file content");
  assert.equal(budget.body.type, "search_results_items");
  assert.deepEqual(names((await search({ query: '"budget for the Q3"' })).body.entries), ["meeting-notes-2026-09-10.md"]);
  assert.equal((await search({ query: '"budget quarterly"' })).body.total_count, 0, "phrases keep word order");
  const readmes = await search({ query: "README", type: "file", content_types: "name" });
  assert.equal(readmes.body.total_count, 2);
  const either = await search({ query: "INV-2026-0142 OR INV-2026-0143", content_types: "name" });
  assert.equal(either.body.total_count, 2);
  const notPress = await search({ query: "launch NOT press", type: "file", content_types: "name" });
  assert.deepEqual(names(notPress.body.entries), ["launch-plan.md"]);
  assert.deepEqual(names((await search({ query: "Q3", type: "folder" })).body.entries), ["Q3 Launch"]);
  const weekly = await search({ query: "weekly", file_extensions: "csv", sort: "modified_at", direction: "ASC", limit: "3", offset: "3" });
  assert.equal(weekly.body.total_count, 8);
  assert.deepEqual(names(weekly.body.entries), ["weekly-report-2026-07-20.csv", "weekly-report-2026-08-03.csv", "weekly-report-2026-08-17.csv"]);
  assert.equal((await search({ query: "INV", ancestor_folder_ids: F(5), content_types: "name" })).body.total_count, 3, "Invoices folder and both invoices");
  assert.deepEqual(names((await search({ query: "contract", owner_user_ids: "20002" })).body.entries), ["Vendor Contracts", "acme-logistics-msa.txt"], "name substrings match folders too");
  assert.deepEqual(names((await search({ query: "legal", content_types: "tag" })).body.entries), ["acme-logistics-msa.txt"]);
  assert.deepEqual(names((await search({ query: "budget", trash_content: "trashed_only" })).body.entries), ["obsolete-budget.csv"]);
  assert.deepEqual(names((await search({ query: '"webinar date"', content_types: "comments" })).body.entries), ["launch-plan.md"]);
  assert.deepEqual(names((await search({ query: "Größe" })).body.entries), ["Präsentation Übersicht.md"]);
  assert.equal((await search({ query: "notes.txt" })).body.total_count, 0, "another user's private files are invisible");
  const recent = await search({ query: "launch", created_at_range: "2026-09-01T00:00:00Z," });
  assert.deepEqual(names(recent.body.entries), ["meeting-notes-2026-09-10.md"], "only launch matches created on or after 2026-09-01");
  await search({ query: "(launch)" }, [400, "bad_request"]);
  await search({ query: "launch AND" }, [400, "bad_request"]);
  await search({ query: "launch", created_at_range: "2026-09-01T00:00:00," }, [400, "bad_request"]);
  await search({ query: "launch", mdfilters: "[]" }, [400, "bad_request"]);
  // Malformed percent-encoding reaches the Tool as U+FFFD (a correctly encoded %EF%BF%BD is rejected too); %ZZ stays literal.
  for (const qs of ["query=budget%E0%A4%A", "query=budget%EF%BF%BD", "query=weekly&file_extensions=csv%E0%A4%A", `query=INV&ancestor_folder_ids=${F(5)}%E0%A4%A`,
    "query=weekly&fields=name%E0%A4%A"]) {
    const bad = await get(`/2.0/search?${qs}`, [400, "bad_request"]);
    assert.match(JSON.stringify(bad.body), /malformed characters/, qs);
  }
  await get("/2.0/folders/0/items?fields=name%E0%A4%A", [400, "bad_request"]);
  await get("/2.0/users/me?fields=name%EF%BF%BD", [400, "bad_request"]);
  assert.equal((await get("/2.0/search?query=budget%ZZ")).body.total_count, 0, "%ZZ stays literal");
  assert.deepEqual(names((await get("/2.0/search?query=Gr%C3%B6%C3%9Fe")).body.entries), ["Präsentation Übersicht.md"]);
  assert.equal((await search({ query: "漢字 🔥" })).body.total_count, 0);

  const all = await get("/2.0/events?stream_position=0");
  assert.equal(all.body.chunk_size, 6);
  assert.equal(all.body.next_stream_position, "6");
  assert.deepEqual(all.body.entries.map((e) => e.event_type), ["ITEM_CREATE", "ITEM_UPLOAD", "ITEM_UPLOAD", "COLLAB_ADD_COLLABORATOR", "COMMENT_CREATE", "ITEM_UPLOAD"]);
  assert.equal(all.body.entries[4].source.type, "comment");
  const changes = await get("/2.0/events?stream_type=changes&stream_position=0");
  assert.equal(changes.body.chunk_size, 4);
  const firstTwo = await get("/2.0/events?stream_position=0&limit=2");
  assert.equal(firstTwo.body.next_stream_position, "2");
  const next = await get(`/2.0/events?stream_position=${firstTwo.body.next_stream_position}&limit=2`);
  assert.equal(next.body.entries[0].event_id, all.body.entries[2].event_id);
  const now = await get("/2.0/events?stream_position=now");
  assert.deepEqual([now.body.chunk_size, now.body.next_stream_position], [0, "6"]);
  const beyond = await get("/2.0/events?stream_position=900");
  assert.deepEqual([beyond.body.chunk_size, beyond.body.next_stream_position], [0, "6"]);
  await get("/2.0/events?stream_type=admin_logs", [400, "bad_request"]);
  await get("/2.0/events?stream_position=yesterday", [400, "bad_request"]);
  assert.ok(FI(1));
}
