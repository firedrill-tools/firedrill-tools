// Connector flow: sources and destinations CRUD, masking, connection checks, in-use protection.
import assert from "node:assert/strict";
import { ID, api, del, detail, get, post, put } from "../lib.mjs";

export async function connectorsFlow() {
  const sources = (await get("/api/v1/sources")).json;
  assert.deepEqual(sources.map((s) => s.name), ["Policy archive", "Field notes", "Legacy scans"]);
  assert.equal((await get("/api/v1/sources?source_type=s3")).json.length, 1);
  await detail("GET", "/api/v1/sources?source_type=ftp", 422, "query.source_type");
  await api("GET", "/api/v1/sources/", { status: 404 }); // trailing slash: framework 404 (route templates cannot end with /)
  const s1 = (await get(`/api/v1/sources/${ID.S1}`)).json;
  assert.equal(s1.config.secret_access_key, "********");
  assert.equal(s1.config.remote_url, "s3://northgate-policies/");
  assert.equal(s1.key, "policy-archive");
  await detail("GET", `/api/v1/sources/${ID.S4}`, 404, "Source connector not found");
  await detail("GET", `/api/v1/sources/${"x".repeat(600)}`, 400, "source_id"); // schema-invalid argument: framework status 400, detail array from the codec

  const missing = await detail("POST", "/api/v1/sources", 422, "drive_id", { body: { name: "Drive", type: "google_drive", config: {} } });
  assert.deepEqual(missing.json.detail[0].loc, ["body", "config", "drive_id"]);
  await detail("POST", "/api/v1/sources", 422, "already exists", { body: { name: "Dup", type: "s3", config: { remote_url: "s3://x/" }, key: "policy-archive" } });
  await detail("POST", "/api/v1/sources", 422, "Extra inputs are not permitted", { body: { name: "Dup", type: "s3", config: { remote_url: "s3://x/" }, colour: "red" } });
  await detail("POST", "/api/v1/sources", 422, "at most 200 characters", { body: { name: "n".repeat(5000), type: "s3", config: { remote_url: "s3://x/" } } });
  await detail("POST", "/api/v1/sources", 422, "Invalid key", { body: { name: "Bad", type: "s3", config: { remote_url: "s3://x/", constructor: 1 } } });
  await detail("POST", "/api/v1/sources", 422, "Input should be a valid dictionary or object", { raw: "[1,2]" });
  await api("POST", "/api/v1/sources", { raw: "", status: 400 }); // empty JSON body: framework HTTP_BODY_INVALID before any codec runs
  await api("POST", "/api/v1/sources", { raw: "{not json", status: 400 });

  const created = (await post("/api/v1/sources", { name: "Survey bucket", type: "s3", config: { remote_url: "s3://northgate-surveys/", access_key_id: "AKIAEXAMPLE0000009", secret_access_key: "not-a-real-secret" }, key: "survey-bucket" })).json;
  assert.equal(created.config.secret_access_key, "********");
  assert.equal(created.updated_at, null);
  assert.equal((await get(`/api/v1/sources/${created.id}`)).json.config.secret_access_key, "********");
  const renamed = (await put(`/api/v1/sources/${created.id}`, { name: "Survey bucket (EU)" })).json;
  assert.equal(renamed.name, "Survey bucket (EU)");
  assert.equal(renamed.updated_at, "2026-09-16T09:00:00.000Z");
  await detail("PUT", `/api/v1/sources/${created.id}`, 422, "cannot be changed", { body: { type: "gcs" } });
  await detail("PUT", `/api/v1/sources/${created.id}`, 422, "remote_url", { body: { config: { access_key_id: "x" } } });
  await detail("PUT", `/api/v1/sources/${ID.NONE}`, 404, "Source connector not found", { body: { name: "x" } });
  const masked = (await put(`/api/v1/sources/${created.id}`, { config: { remote_url: "s3://northgate-surveys-eu/", secret_access_key: "********" } })).json;
  assert.equal(masked.config.remote_url, "s3://northgate-surveys-eu/");
  assert.equal(masked.config.secret_access_key, "********");
  assert.equal(masked.config.access_key_id, undefined, "config is replaced whole");

  // Connection checks: computed from the required keys of the type.
  const check = (await post(`/api/v1/sources/${ID.S1}/connection-check`, undefined)).json;
  assert.deepEqual(check, { status: "SUCCESS", reason: null, created_at: "2026-09-16T09:00:00.000Z" });
  assert.equal((await get(`/api/v1/sources/${ID.S3}/connection-check`)).json.status, "FAILURE");
  await detail("GET", `/api/v1/sources/${created.id}/connection-check`, 404, "No connection check found");
  const broken = (await post("/api/v1/sources", { name: "No drive", type: "google_drive", config: { drive_id: "1", service_account_key: "x" } })).json;
  await put(`/api/v1/sources/${broken.id}`, { config: { drive_id: "", service_account_key: "x" } }, { status: 422 });
  await detail("POST", `/api/v1/sources/${ID.NONE}/connection-check`, 404, "Source connector not found");
  await detail("GET", `/api/v1/sources/${ID.NONE}/connection-check`, 404, "Source connector not found");

  // Destinations mirror the same rules.
  const destinations = (await get("/api/v1/destinations")).json;
  assert.deepEqual(destinations.map((d) => d.name), ["Parsed output bucket", "Policy index"]);
  assert.equal((await get("/api/v1/destinations?destination_type=pinecone")).json[0].config.api_key, "********");
  await detail("GET", "/api/v1/destinations?destination_type=s3x", 422, "destination_type");
  await detail("POST", "/api/v1/destinations", 422, "cluster_url", { body: { name: "Vectors", type: "weaviate_cloud", config: { collection: "docs" } } });
  const weaviate = (await post("/api/v1/destinations", { name: "Vectors", type: "weaviate_cloud", config: { cluster_url: "https://vectors.example.test", collection: "docs", api_key: "x" } })).json;
  assert.equal((await get(`/api/v1/destinations/${weaviate.id}`)).json.config.api_key, "********");
  assert.equal((await put(`/api/v1/destinations/${weaviate.id}`, { name: "Vectors (prod)" })).json.name, "Vectors (prod)");
  await detail("PUT", `/api/v1/destinations/${weaviate.id}`, 422, "cannot be changed", { body: { type: "s3" } });
  await detail("PUT", `/api/v1/destinations/${ID.NONE}`, 404, "Destination connector not found", { body: { name: "x" } });
  assert.deepEqual((await del(`/api/v1/destinations/${weaviate.id}`)).json, {});
  await detail("GET", `/api/v1/destinations/${weaviate.id}`, 404, "Destination connector not found");
  await detail("DELETE", `/api/v1/destinations/${weaviate.id}`, 404, "Destination connector not found");
  await detail("GET", `/api/v1/destinations/${ID.D3}`, 404, "Destination connector not found");

  // Connectors used by a running job cannot be deleted (J5 runs W2 = S2 -> D1; J6 runs W1 = S1 -> D2).
  await detail("DELETE", `/api/v1/sources/${ID.S1}`, 422, "in use by a running job");
  await detail("DELETE", `/api/v1/destinations/${ID.D1}`, 422, "in use by a running job");
  await detail("DELETE", `/api/v1/sources/${ID.NONE}`, 404, "Source connector not found");
  assert.deepEqual((await del(`/api/v1/sources/${broken.id}`)).json, {});
  await detail("GET", `/api/v1/sources/${broken.id}`, 404);
  assert.equal((await get("/api/v1/sources")).json.length, 4);
}
