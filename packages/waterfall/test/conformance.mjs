// Waterfall Tool conformance target: a scripted Tool test, not a model-driven agent. Node built-ins only.
// Calls the Waterfall-shaped REST routes (x-api-key header, JSON bodies) at FIREDRILL_HTTP_URL and, for the few
// inputs no route can express, the canonical operation endpoint. Each drill instruction names one flow.
import assert from "node:assert/strict";
import { SEED } from "./seed.mjs";
import { enrichContact, enrichPhoneCompany } from "./flows/enrich.mjs";
import { search } from "./flows/search.mjs";
import { jobChangeVerify } from "./flows/change-verify.mjs";
import { accountAndKeys, freshInstall, subKey } from "./flows/account.mjs";
import { denied, inactiveKey, revokedKey } from "./flows/access.mjs";
import { enrichmentOutage, keyCreateLost, overQuota, rateLimited, slowJobs, tightLimits } from "./flows/faults.mjs";

let task = "";
for await (const chunk of process.stdin) task += chunk;
const instruction = String(JSON.parse(task).instruction ?? "");
const flow = /Run the ([a-z-]+) flow/.exec(instruction)?.[1];
const BASE = process.env.FIREDRILL_HTTP_URL;
const TOKEN = process.env.FIREDRILL_HTTP_TOKEN;
assert.ok(BASE && TOKEN, "the HTTP binding is required");

/**
 * One REST call. Asserts the HTTP status; for errors also the Waterfall envelope (`status`, `category`, `code`).
 * Returns `{ body, headers }`. `raw` sends a body verbatim; `body: null` sends the JSON literal null.
 */
async function api(method, path, { body, status = 200, code, raw, headers = {} } = {}) {
  const init = { method, headers: { "x-api-key": TOKEN, ...headers } };
  if (body !== undefined || raw !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = raw ?? JSON.stringify(body);
  }
  const response = await fetch(`${BASE}${path}`, init);
  const text = await response.text();
  let json;
  try {
    json = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  assert.equal(response.status, status, `${method} ${path} → ${response.status} ${text.slice(0, 400)}`);
  if (status >= 400 && json?.schemaVersion === undefined) {
    assert.equal(json?.status, "error", `${method} ${path} envelope: ${text.slice(0, 300)}`);
    assert.equal(typeof json?.message, "string");
    assert.ok(Array.isArray(json?.error) && json.error.length > 0, `${method} ${path} error[]: ${text.slice(0, 300)}`);
    assert.equal(json?.category, String(json?.code).startsWith(json?.category) ? json.category : "?", `${method} ${path} category`);
    if (code !== undefined) assert.equal(json?.code, code, `${method} ${path} error code: ${text.slice(0, 300)}`);
  }
  return { body: json, headers: response.headers };
}

/** Canonical operation call; returns the outcome. */
async function canonical(operation, args) {
  const response = await fetch(`${BASE}/v1/operations/waterfall/${operation}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ arguments: args }),
  });
  const json = await response.json();
  assert.ok(json.outcome, `canonical ${operation}: ${JSON.stringify(json).slice(0, 300)}`);
  return json.outcome;
}

const FLOWS = {
  "enrich-contact": enrichContact,
  "enrich-phone-company": enrichPhoneCompany,
  search,
  "job-change-verify": jobChangeVerify,
  "account-and-keys": accountAndKeys,
  "sub-key": subKey,
  "fresh-install": freshInstall,
  "inactive-key": inactiveKey,
  "revoked-key": revokedKey,
  denied,
  "rate-limited": rateLimited,
  "enrichment-outage": enrichmentOutage,
  "key-create-lost": keyCreateLost,
  "over-quota": overQuota,
  "slow-jobs": slowJobs,
  "tight-limits": tightLimits,
};
const run = FLOWS[flow];
assert.ok(run, `unknown flow ${JSON.stringify(flow)} in instruction ${JSON.stringify(instruction)}`);
await run({ api, canonical, assert, SEED });
process.stdout.write(JSON.stringify({ completed: true, flow }));
