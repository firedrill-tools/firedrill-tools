// Access flow: fresh-install fallback, workspace scoping, an invalid key on every operation, framework denial.
import assert from "node:assert/strict";
import { ALL_OPERATIONS, ID, api, detail, get, op, partition } from "../lib.mjs";

/** Arguments that would succeed for a valid key, used to prove UNAUTHORIZED fires before anything else. */
const ARGS = {
  "general.partition": { files: [{ filename: "a.txt", content: "Hello" }] },
  "sources.list": {}, "sources.create": { name: "x", type: "s3", config: { remote_url: "s3://x/" } }, "sources.get": { source_id: ID.S1 }, "sources.update": { source_id: ID.S1, name: "x" },
  "sources.delete": { source_id: ID.S1 }, "sources.check_connection": { source_id: ID.S1 }, "sources.get_connection_check": { source_id: ID.S1 },
  "destinations.list": {}, "destinations.create": { name: "x", type: "s3", config: { remote_url: "s3://x/" } }, "destinations.get": { destination_id: ID.D1 }, "destinations.update": { destination_id: ID.D1, name: "x" }, "destinations.delete": { destination_id: ID.D1 },
  "workflows.list": {}, "workflows.create": { name: "x", workflow_type: "auto" }, "workflows.get": { workflow_id: ID.W1 }, "workflows.update": { workflow_id: ID.W1, name: "x" }, "workflows.delete": { workflow_id: ID.W1 }, "workflows.run": { workflow_id: ID.W1 },
  "jobs.list": {}, "jobs.get": { job_id: ID.J1 }, "jobs.cancel": { job_id: ID.J5 }, "jobs.get_details": { job_id: ID.J1 }, "jobs.get_failed_files": { job_id: ID.J1 }, "jobs.download_output": { job_id: ID.J2, file_id: `${ID.S1}:handbook-md`, node_id: ID.W1_EMBED_NODE },
};

/** A fresh `firedrill tool add` actor (no attributes) sees the seeded Northgate account. */
export async function freshFlow() {
  assert.equal((await get("/api/v1/sources")).json.length, 3);
  assert.equal((await get("/api/v1/destinations")).json.length, 2);
  assert.equal((await get("/api/v1/workflows")).json.length, 3);
  assert.equal((await get("/api/v1/jobs")).json.length, 6);
  const elements = (await partition([{ filename: "hello.txt", content: "Fresh Install\n\nThe fresh actor can partition documents without any identity attribute." }])).json;
  assert.deepEqual(elements.map((e) => e.type), ["Title", "NarrativeText"]);
  assert.equal((await get(`/api/v1/jobs/${ID.J1}`)).json.status, "COMPLETED");
}

/** The archive workspace key sees only S4 / D3 / W4; Northgate ids do not exist for it. */
export async function archivistFlow() {
  assert.deepEqual((await get("/api/v1/sources")).json.map((s) => s.id), [ID.S4]);
  assert.deepEqual((await get("/api/v1/destinations")).json.map((d) => d.id), [ID.D3]);
  assert.deepEqual((await get("/api/v1/workflows")).json.map((w) => w.id), [ID.W4]);
  assert.deepEqual((await get("/api/v1/jobs")).json, []);
  await detail("GET", `/api/v1/sources/${ID.S1}`, 404, "Source connector not found");
  await detail("GET", `/api/v1/workflows/${ID.W1}`, 404, "Workflow not found");
  await detail("GET", `/api/v1/jobs/${ID.J1}`, 404, "Job not found");
  await detail("POST", "/api/v1/workflows", 422, "Source connector not found", { body: { name: "cross", workflow_type: "auto", source_id: ID.S1 } });
  await detail("POST", `/api/v1/workflows/${ID.W4}/run`, 422, "holds no files");
  assert.equal((await get("/api/v1/jobs")).json.length, 0);
}

/** A key whose workspace does not exist: 401 API key is invalid on every operation, wire and canonical. */
export async function revokedFlow() {
  await detail("POST", "/general/v0/general", 401, "API key is invalid", { raw: "--b\r\nContent-Disposition: form-data; name=\"files\"; filename=\"a.txt\"\r\n\r\nHi\r\n--b--\r\n", contentType: "multipart/form-data; boundary=b" });
  await detail("GET", "/api/v1/sources", 401, "API key is invalid");
  await detail("GET", `/api/v1/jobs/${ID.J1}`, 401, "API key is invalid");
  for (const operationId of ALL_OPERATIONS) await op(operationId, ARGS[operationId], "UNAUTHORIZED");
}

/** An actor without grants: the framework denies before the Tool runs; the codec renders it in the detail envelope. */
export async function deniedFlow() {
  await detail("GET", "/api/v1/sources", 403, "not granted");
  await detail("POST", "/general/v0/general", 403, "not granted", { raw: "--b\r\nContent-Disposition: form-data; name=\"files\"; filename=\"a.txt\"\r\n\r\nHi\r\n--b--\r\n", contentType: "multipart/form-data; boundary=b" });
  await op("sources.list", {}, "denied");
  await api("GET", "/api/v1/sources", { status: 401, token: "wrong-key" });
}
