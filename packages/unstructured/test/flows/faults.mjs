// Fault and bound flows: rate limit, overload, committed-but-lost run, lowered state bounds and a lowered response budget.
import assert from "node:assert/strict";
import { ID, api, detail, get, partition, post } from "../lib.mjs";

const NOTE = [{ filename: "note.txt", content: "Fault Drill\n\nThis note is uploaded while a fault is active." }];

export async function rateLimitedFlow() {
  const first = await detail("POST", "/general/v0/general", 429, "Rate limit exceeded", { ...multipartNote() });
  assert.equal(first.headers.get("retry-after"), "1");
  await partition(NOTE, {}, { status: 429 });
  assert.equal((await get("/api/v1/sources")).json.length, 3, "platform routes are unaffected");
}

export async function overloadedFlow() {
  for (let i = 0; i < 2; i += 1) await detail("POST", "/general/v0/general", 503, "Server is under heavy load. Please try again later.", { ...multipartNote() });
  assert.equal((await get("/api/v1/workflows")).json.length, 3);
}

export async function runLostFlow() {
  const before = (await get(`/api/v1/jobs?workflow_id=${ID.W2}`)).json.length;
  await detail("POST", `/api/v1/workflows/${ID.W2}/run`, 500, "Internal Server Error");
  const after = (await get(`/api/v1/jobs?workflow_id=${ID.W2}`)).json;
  assert.equal(after.length, before + 1, "the job was committed although the response was lost");
  assert.equal(after[0].status, "SCHEDULED");
  await detail("POST", `/api/v1/workflows/${ID.W2}/run`, 500, "Internal Server Error");
  assert.equal((await get(`/api/v1/jobs?workflow_id=${ID.W2}`)).json.length, before + 2, "a naive retry creates a second job");
}

export async function tightLimitsFlow() {
  await detail("GET", "/api/v1/sources", 500, "state exceeds the supported bound of 2 sources rows");
  await detail("GET", "/api/v1/destinations", 500, "state exceeds the supported bound of 2 destinations rows");
  await detail("GET", "/api/v1/workflows", 500, "state exceeds the supported bound of 2 workflows rows");
  await detail("GET", "/api/v1/jobs", 500, "state exceeds the supported bound of 2 jobs rows");
  await detail("POST", "/api/v1/sources", 500, "supported bound", { body: { name: "n", type: "s3", config: { remote_url: "s3://x/" }, key: "fresh-key" } });
  await detail("POST", "/api/v1/destinations", 500, "supported bound", { body: { name: "n", type: "s3", config: { remote_url: "s3://x/" }, key: "fresh-key" } });
  await detail("POST", "/api/v1/workflows", 500, "supported bound", { body: { name: "n", workflow_type: "auto", key: "fresh-key" } });
  await detail("DELETE", `/api/v1/sources/${ID.S1}`, 500, "supported bound of 2 jobs rows");
  await detail("DELETE", `/api/v1/destinations/${ID.D1}`, 500, "supported bound of 2 jobs rows");
  await detail("DELETE", `/api/v1/workflows/${ID.W1}`, 500, "supported bound of 2 jobs rows");
  await detail("POST", `/api/v1/workflows/${ID.W1}/run`, 500, "supported bound of 2 source-files rows");
  assert.equal((await get(`/api/v1/sources/${ID.S1}`)).json.name, "Policy archive", "point reads still work");
  assert.equal((await post("/api/v1/sources", { name: "No key", type: "s3", config: { remote_url: "s3://x/" } })).json.type, "s3", "a create without a key needs no scan");
  await api("GET", `/api/v1/jobs/${ID.J1}`);
}

/** response_bytes = 520: every list or page over the budget answers 413 and is never shortened; small lists and point reads work. */
export async function smallResponsesFlow() {
  const tooLarge = (path, fragment) => detail("GET", path, 413, fragment);
  await tooLarge("/api/v1/sources", "The list of 3 source connectors of ");
  await tooLarge("/api/v1/sources", "exceeds the 520 byte response limit; filter by source_type or delete unused source connectors");
  await tooLarge("/api/v1/destinations", "The list of 2 destination connectors of ");
  await tooLarge("/api/v1/workflows", "A page of 3 rows of ");
  await tooLarge("/api/v1/workflows", "exceeds the 520 byte response limit; lower page_size");
  await tooLarge("/api/v1/workflows?page_size=2", "A page of 2 rows of ");
  await tooLarge("/api/v1/workflows?page_size=2&page=2", "A page of 1 rows of ");
  await tooLarge("/api/v1/workflows?page_size=1", "the row itself exceeds the budget");
  await tooLarge("/api/v1/jobs", "A page of 6 rows of ");
  await tooLarge("/api/v1/jobs?page_size=1", "A page of 1 rows of ");
  assert.equal((await get("/api/v1/sources?source_type=s3")).json.length, 1, "a filtered list under the budget is returned whole");
  assert.equal((await get("/api/v1/destinations?destination_type=s3")).json.length, 1);
  assert.equal((await get("/api/v1/jobs?status=FAILED")).json.length, 1, "a page under the budget is returned whole");
  assert.equal((await get("/api/v1/jobs?status=FAILED&page=2")).json.length, 0, "an empty page is fine");
  assert.equal((await get("/api/v1/workflows?name=no-such-workflow")).json.length, 0, "an empty workflow page is fine");
  assert.equal((await get(`/api/v1/workflows/${ID.W1}`)).json.name, "policy-ingest", "point reads are not budgeted");
  const created = (await post("/api/v1/sources", { name: "Fourth", type: "s3", config: { remote_url: "s3://x/" } })).json;
  assert.equal(created.type, "s3", "writes still work");
  await tooLarge("/api/v1/sources", "The list of 4 source connectors of ");
  assert.equal((await get(`/api/v1/sources/${created.id}`)).json.name, "Fourth", "the created row is reachable by id although the list is over budget");
}

function multipartNote() {
  return { raw: `--b\r\nContent-Disposition: form-data; name="files"; filename="note.txt"\r\n\r\n${NOTE[0].content}\r\n--b--\r\n`, contentType: "multipart/form-data; boundary=b" };
}
