// Workflow and job flow: listing/sorting/paging, node validation, run, job lifecycle, download, cancel, delete.
import assert from "node:assert/strict";
import { ID, api, del, detail, fixtures, get, multipart, partition, post, put } from "../lib.mjs";

const RUNTIME = (files, bytes) => { const s = 10 * files + Math.floor(bytes / 4096); return `PT${Math.floor(s / 60)}M${s % 60}S`; };

export async function workflowsFlow() {
  const all = (await get("/api/v1/workflows")).json;
  assert.deepEqual(all.map((w) => w.name), ["policy-ingest", "notes-basic", "legacy-scan"]);
  assert.deepEqual(all[0].sources, [ID.S1]);
  assert.deepEqual(all[0].destinations, [ID.D2]);
  assert.equal(all[0].workflow_nodes.length, 3);
  assert.deepEqual((await get("/api/v1/workflows?status=inactive")).json.map((w) => w.id), [ID.W3]);
  assert.deepEqual((await get("/api/v1/workflows?page_size=1&page=2&sort_by=name&sort_direction=desc")).json.map((w) => w.name), ["notes-basic"]);
  assert.deepEqual((await get(`/api/v1/workflows?source_id=${ID.S2}`)).json.map((w) => w.id), [ID.W2]);
  assert.deepEqual((await get("/api/v1/workflows?name=legacy-scan")).json.map((w) => w.id), [ID.W3]);
  assert.deepEqual((await get("/api/v1/workflows?page=4")).json, []);
  await detail("GET", "/api/v1/workflows?show_only_soft_deleted=true", 422, "not supported by this Tool");
  await detail("GET", "/api/v1/workflows?page=0", 422, "query.page");
  await detail("GET", "/api/v1/workflows?page_size=101", 422, "less than or equal to 100");
  await detail("GET", "/api/v1/workflows?sort_by=colour", 422, "query.sort_by");
  await detail("GET", `/api/v1/workflows/${ID.W4}`, 404, "Workflow not found");

  const nodes = (partitionSub, chunk) => [{ name: "Partitioner", type: "partition", subtype: partitionSub }, ...(chunk ? [chunk] : [])];
  await detail("POST", "/api/v1/workflows", 422, "must be the first node", { body: { name: "bad", workflow_type: "custom", workflow_nodes: [{ name: "c", type: "chunk", subtype: "chunk_by_title" }, { name: "p", type: "partition", subtype: "auto" }] } });
  await detail("POST", "/api/v1/workflows", 422, "at most one chunk node", { body: { name: "bad", workflow_type: "custom", workflow_nodes: [...nodes("auto", { name: "c", type: "chunk", subtype: "chunk_by_title" }), { name: "c2", type: "chunk", subtype: "chunk_by_page" }] } });
  await detail("POST", "/api/v1/workflows", 422, "by_similarity is not supported", { body: { name: "bad", workflow_type: "custom", workflow_nodes: nodes("auto", { name: "c", type: "chunk", subtype: "chunk_by_similarity" }) } });
  // The partition node's languages setting is bounded like the partition route's parameter: refused, never cut.
  await detail("POST", "/api/v1/workflows", 422, "at most 20 items", { body: { name: "bad", workflow_type: "custom", workflow_nodes: [{ name: "p", type: "partition", subtype: "auto", settings: { languages: Array.from({ length: 21 }, (_, i) => `l${i}`) } }] } });
  await detail("POST", "/api/v1/workflows", 422, "at most 20 characters", { body: { name: "bad", workflow_type: "custom", workflow_nodes: [{ name: "p", type: "partition", subtype: "auto", settings: { languages: "eng,abcdefghijklmnopqrstuvwxyz" } }] } });
  await detail("POST", "/api/v1/workflows", 422, "body.schedule", { body: { name: "bad", workflow_type: "auto", schedule: "hourly" } });
  const foreign = await detail("POST", "/api/v1/workflows", 422, "Source connector not found", { body: { name: "bad", workflow_type: "auto", source_id: ID.S4 } });
  assert.deepEqual(foreign.json.detail[0].loc, ["body", "source_id"]);
  await detail("POST", "/api/v1/workflows", 422, "template_id is not supported", { body: { name: "bad", workflow_type: "auto", template_id: "t" } });
  await detail("POST", "/api/v1/workflows", 422, "Field required", { body: { workflow_type: "auto" } });
  await detail("POST", "/api/v1/workflows", 422, "already exists", { body: { name: "dup", workflow_type: "auto", key: "policy-ingest" } });

  const w5 = (await post("/api/v1/workflows", { name: "notes-chars", workflow_type: "custom", source_id: ID.S2, destination_id: ID.D1, workflow_nodes: nodes("auto", { name: "Chunker", type: "chunk", subtype: "chunk_by_character", settings: { max_characters: 300 } }), key: "notes-chars" })).json;
  assert.equal(w5.status, "active");
  assert.equal(w5.workflow_nodes.length, 2);
  assert.match(w5.workflow_nodes[0].id, /^[0-9a-f-]{36}$/);
  const auto = (await post("/api/v1/workflows", { name: "auto-flow", workflow_type: "auto", source_id: ID.S1 })).json;
  assert.deepEqual(auto.workflow_nodes.map((n) => n.subtype), ["auto", "chunk_by_title"]);
  assert.equal((await get(`/api/v1/workflows/${w5.id}`)).json.name, "notes-chars");

  assert.equal((await put(`/api/v1/workflows/${w5.id}`, { status: "inactive" })).json.status, "inactive");
  await detail("POST", `/api/v1/workflows/${w5.id}/run`, 422, "Workflow is not active");
  assert.equal((await put(`/api/v1/workflows/${w5.id}`, { status: "active", schedule: "weekly" })).json.schedule, "weekly");
  await detail("PUT", `/api/v1/workflows/${w5.id}`, 422, "body.status", { body: { status: "sleeping" } });
  await detail("PUT", `/api/v1/workflows/${ID.NONE}`, 404, "Workflow not found", { body: { name: "x" } });
  await detail("POST", `/api/v1/workflows/${ID.W3}/run`, 422, "Workflow is not active");
  await detail("POST", `/api/v1/workflows/${ID.W4}/run`, 404, "Workflow not found");
  await detail("POST", `/api/v1/workflows/${w5.id}/run`, 422, "Expected multipart/form-data", { body: { input_files: [] } });
  const noSource = (await post("/api/v1/workflows", { name: "adhoc", workflow_type: "auto" })).json;
  await detail("POST", `/api/v1/workflows/${noSource.id}/run`, 422, "body.input_files");

  const job = (await api("POST", `/api/v1/workflows/${w5.id}/run`, { status: 202 })).json;
  assert.equal(job.status, "SCHEDULED");
  assert.equal(job.input_file_ids.length, 3);
  assert.deepEqual(job.output_node_files, []);
  assert.equal(job.runtime, null);
  assert.equal((await get(`/api/v1/jobs/${job.id}`)).json.status, "SCHEDULED");
  const details = (await get(`/api/v1/jobs/${job.id}/details`)).json;
  assert.equal(details.processing_status, "SCHEDULED");
  assert.deepEqual(details.node_stats.map((n) => n.ready), [3, 3]);
  const upload = multipart([{ name: "input_files", filename: "memo.md", value: "# Memo\n\nA short memo body for the runtime upload.", contentType: "text/markdown" }, { name: "input_files", filename: "scan.pdf", value: "%PDF", contentType: "application/pdf" }]);
  const job2 = (await api("POST", `/api/v1/workflows/${w5.id}/run`, { status: 202, raw: upload.raw, contentType: upload.contentType })).json;
  assert.equal(job2.input_file_ids.length, 5);
  assert.deepEqual((await get(`/api/v1/jobs/${job2.id}/failed-files`)).json.failed_files, [{ document: "upload://scan.pdf", error: "application/pdf not currently supported" }]);
  assert.deepEqual((await get(`/api/v1/jobs/${job.id}/failed-files`)).json.failed_files, []);

  assert.equal((await get(`/api/v1/jobs?workflow_id=${w5.id}`)).json.length, 2);
  assert.deepEqual((await get("/api/v1/jobs?status=COMPLETED")).json.map((j) => j.id), [ID.J2, ID.J1]);
  const pages = [];
  for (let page = 1; page <= 5; page += 1) pages.push((await get(`/api/v1/jobs?page_size=2&page=${page}`)).json);
  assert.deepEqual(pages.map((p) => p.length), [2, 2, 2, 2, 0]);
  assert.equal(new Set(pages.flat().map((j) => j.id)).size, 8);
  await detail("GET", "/api/v1/jobs?page=0", 422, "query.page");
  await detail("GET", "/api/v1/jobs?status=DONE", 422, "query.status");

  const j1 = (await get(`/api/v1/jobs/${ID.J1}`)).json;
  assert.equal(j1.status, "COMPLETED");
  assert.equal(j1.runtime, RUNTIME(7, 1446 + 965 + 754 + 1544 + 826 + 0 + 56014));
  assert.equal(j1.output_node_files.length, 7);
  assert.ok(j1.output_node_files.every((f) => f.node_id === ID.W1_EMBED_NODE && f.node_type === "embed"));
  const fileId = `${ID.S1}:handbook-md`;
  const download = (await get(`/api/v1/jobs/${ID.J2}/download?file_id=${encodeURIComponent(fileId)}&node_id=${ID.W1_EMBED_NODE}`)).json;
  const direct = (await partition([{ filename: "handbook.md", content: fixtures().get("handbook.md").content }], { chunking_strategy: "by_title", max_characters: "800", new_after_n_chars: "800", combine_under_n_chars: "200", include_orig_elements: "true" })).json;
  assert.deepEqual(download.map((c) => [c.type, c.text]), direct.map((c) => [c.type, c.text]));
  await detail("GET", `/api/v1/jobs/${ID.J2}/download?file_id=${encodeURIComponent(fileId)}&node_id=${ID.NONE}`, 404, "Job output file not found");
  await detail("GET", `/api/v1/jobs/${ID.J2}/download?node_id=${ID.W1_EMBED_NODE}`, 422, "query.file_id");
  await detail("GET", `/api/v1/jobs/${ID.J6}/download?file_id=${encodeURIComponent(fileId)}&node_id=${ID.W1_EMBED_NODE}`, 422, "not available yet");
  await detail("GET", `/api/v1/jobs/${ID.J2}/download?file_id=${encodeURIComponent(`${ID.S1}:ledger-txt`)}&node_id=${ID.W1_EMBED_NODE}`, 413, "exceeds the 921600 byte response limit");
  await detail("GET", `/api/v1/jobs/${ID.NONE}/download?file_id=x&node_id=y`, 404, "Job not found");

  const j4 = (await get(`/api/v1/jobs/${ID.J4}/details`)).json;
  assert.equal(j4.processing_status, "FAILED");
  assert.deepEqual(j4.node_stats.map((n) => n.failure), [2]);
  assert.equal((await get(`/api/v1/jobs/${ID.J4}`)).json.reason, "All files failed");
  const failed = (await get(`/api/v1/jobs/${ID.J4}/failed-files`)).json.failed_files;
  assert.deepEqual(failed.map((f) => f.document), ["az://legacy-scans/scan-001.pdf", "az://legacy-scans/photo.png"]);
  assert.equal(failed[0].error, "File is encrypted. Please decrypt it with password.");
  assert.equal((await get(`/api/v1/jobs/${ID.J3}/details`)).json.processing_status, "STOPPED");
  assert.equal((await get(`/api/v1/jobs/${ID.J3}`)).json.reason, "Cancelled by user");
  assert.equal((await get(`/api/v1/jobs/${ID.J5}`)).json.status, "IN_PROGRESS");
  assert.deepEqual((await get(`/api/v1/jobs/${ID.J5}/details`)).json.node_stats.map((n) => n.in_progress), [3, 3]);
  await detail("GET", `/api/v1/jobs/${ID.NONE}`, 404, "Job not found");
  await detail("GET", `/api/v1/jobs/${ID.NONE}/details`, 404, "Job not found");
  await detail("GET", `/api/v1/jobs/${ID.NONE}/failed-files`, 404, "Job not found");

  const cancelled = (await post(`/api/v1/jobs/${ID.J5}/cancel`, undefined)).json;
  assert.equal(cancelled.status, "STOPPED");
  assert.equal((await get(`/api/v1/jobs/${ID.J5}`)).json.status, "STOPPED");
  assert.equal((await get(`/api/v1/jobs/${ID.J5}`)).json.stop_requested, true);
  await detail("POST", `/api/v1/jobs/${ID.J1}/cancel`, 422, "already finished");
  await detail("POST", `/api/v1/jobs/${ID.NONE}/cancel`, 404, "Job not found");

  await detail("DELETE", `/api/v1/workflows/${ID.W1}`, 422, "running job");
  await detail("DELETE", `/api/v1/workflows/${w5.id}`, 422, "running job");
  await detail("DELETE", `/api/v1/workflows/${ID.NONE}`, 404, "Workflow not found");
  assert.deepEqual((await del(`/api/v1/workflows/${noSource.id}`)).json, {});
  await detail("GET", `/api/v1/workflows/${noSource.id}`, 404, "Workflow not found");
}
