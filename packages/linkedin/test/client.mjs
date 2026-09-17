// HTTP helpers for the LinkedIn conformance target (Node built-ins only).
import assert from "node:assert/strict";

const BASE = process.env.FIREDRILL_HTTP_URL;
const TOKEN = process.env.FIREDRILL_HTTP_TOKEN;
assert.ok(BASE && TOKEN, "the HTTP binding is required (FIREDRILL_HTTP_URL / FIREDRILL_HTTP_TOKEN)");

export const VERSION = "202608";

/** Percent-encodes a URN or key value for a path segment (parentheses and commas included). */
export const enc = (value) => encodeURIComponent(value).replace(/\(/g, "%28").replace(/\)/g, "%29");
export const personUrn = (id) => `urn:li:person:${id}`;
export const orgUrn = (id) => `urn:li:organization:${id}`;

/**
 * Calls a LinkedIn route. `expect` is a status or [status, code]. `/rest` paths send LinkedIn-Version unless `version: null`.
 * Error bodies are checked against LinkedIn's envelope: `/rest` carries `code`, `/v2` does not.
 */
export async function call(method, path, expect = 200, { json, headers = {}, version = VERSION, restli } = {}) {
  const [status, code] = Array.isArray(expect) ? expect : [expect];
  const rest = path.startsWith("/rest/");
  const init = { method, headers: { authorization: `Bearer ${TOKEN}`, "x-restli-protocol-version": "2.0.0", ...headers } };
  if (rest && version !== null) init.headers["linkedin-version"] = version;
  if (restli !== undefined) init.headers["x-restli-method"] = restli;
  if (json !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = typeof json === "string" ? json : JSON.stringify(json);
  }
  const response = await fetch(`${BASE}${path}`, init);
  const text = await response.text();
  assert.equal(response.status, status, `${method} ${path} → ${response.status} ${text.slice(0, 600)}`);
  let body;
  if (status === 204 || status === 202 || (status === 201 && text === "")) assert.equal(text, "", `${method} ${path}: ${status} has no body`);
  else body = JSON.parse(text);
  if (status >= 400) {
    assert.equal(body.status, status, `${method} ${path}: envelope status`);
    assert.equal(typeof body.serviceErrorCode, "number");
    assert.equal(typeof body.message, "string");
    if (rest) {
      assert.equal(typeof body.code, "string", `${method} ${path}: /rest envelope carries code`);
      if (code !== undefined) assert.equal(body.code, code, `${method} ${path}: expected ${code}, got ${body.code} (${body.message})`);
    } else {
      assert.equal(body.code, undefined, `${method} ${path}: /v2 envelope has no code`);
    }
  }
  if (status < 500 && response.status !== 404) assert.equal(response.headers.get("x-restli-protocol-version"), "2.0.0");
  return { status: response.status, body, headers: response.headers };
}

export const get = (path, expect, options) => call("GET", path, expect, options);
export const post = (path, json, expect = 201, options = {}) => call("POST", path, expect, { ...options, json });
export const partial = (path, json, expect = 204, options = {}) => call("POST", path, expect, { restli: "PARTIAL_UPDATE", ...options, json });
export const del = (path, expect = 204, options = {}) => call("DELETE", path, expect, options);

/** Canonical operation call. `expect` is "ok", "denied", "invalid" or a declared error code. Returns the outcome. */
export async function op(operationId, args = {}, expect = "ok") {
  const response = await fetch(`${BASE}/v1/operations/linkedin/${operationId}`, {
    method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ arguments: args }),
  });
  const record = await response.json();
  const outcome = record.outcome ?? {};
  const got = outcome.status === "tool_error" ? String(outcome.error?.code ?? "").split(".").pop() : outcome.status;
  assert.equal(got, expect, `${operationId} ${JSON.stringify(args).slice(0, 300)} → ${JSON.stringify(outcome).slice(0, 600)}`);
  return outcome;
}

/** A text post body for POST /rest/posts. */
export const textPost = (author, commentary, extra = {}) => ({
  author, commentary, visibility: "PUBLIC", distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
  lifecycleState: "PUBLISHED", isReshareDisabledByAuthor: false, ...extra,
});
