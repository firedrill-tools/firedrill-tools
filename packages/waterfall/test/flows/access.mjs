// Access flows: inactive-key and revoked-key (every operation answers 403 AUTH_BAD_API_KEY: 17 tool_errors, nothing
// written), denied (an actor without grants: framework denial rendered as 403 PERMISSION_NEED_ADMIN_API_KEY).

async function everyOperationRejected({ api, SEED }, code) {
  const opts = { status: 403, code };
  await api("POST", "/v1/enrichment/contact", { body: { email: "ada.lindqvist@northwind.test" }, ...opts });
  await api("GET", `/v1/enrichment/contact?job_id=${SEED.JID[1]}`, opts);
  await api("POST", "/v1/enrichment/phone", { body: { linkedin: "ada-lindqvist" }, ...opts });
  await api("GET", `/v1/enrichment/phone?job_id=${SEED.JID[2]}`, opts);
  await api("POST", "/v1/enrichment/company", { body: { domain: "northwind.test" }, ...opts });
  await api("GET", `/v1/enrichment/company?job_id=${SEED.JID[3]}`, opts);
  await api("POST", "/v1/search/contact", { body: { domain: "northwind.test" }, ...opts });
  await api("GET", `/v1/search/contact?job_id=${SEED.JID[4]}`, opts);
  await api("POST", "/v1/search/company", { body: { sizes: ["1-10"] }, ...opts });
  await api("GET", `/v1/search/company?job_id=${SEED.JID[4]}`, opts);
  await api("POST", "/v1/job/change", { body: { contact_linkedin: "ada-lindqvist" }, ...opts });
  await api("GET", `/v1/job/change?job_id=${SEED.JID[4]}`, opts);
  await api("POST", "/v1/verify/email", { body: { email: "ada.lindqvist@northwind.test" }, ...opts });
  await api("GET", "/v2/account", opts);
  await api("GET", "/v1/api-keys", opts);
  await api("POST", "/v1/api-keys", { body: { notes: "nope" }, ...opts });
  await api("PUT", "/v1/api-keys", { body: { api_key: SEED.KEY.outbound, notes: "nope", active: true }, ...opts });
}

export async function inactiveKey(harness) {
  await everyOperationRejected(harness, "AUTH_BAD_API_KEY");
}

export async function revokedKey(harness) {
  await everyOperationRejected(harness, "AUTH_BAD_API_KEY");
}

export async function denied({ api, assert, SEED }) {
  const launch = await api("POST", "/v1/enrichment/contact", { body: { email: "ada.lindqvist@northwind.test" }, status: 403, code: "PERMISSION_NEED_ADMIN_API_KEY" });
  assert.equal(launch.body.category, "PERMISSION");
  await api("GET", `/v1/enrichment/contact?job_id=${SEED.JID[1]}`, { status: 403, code: "PERMISSION_NEED_ADMIN_API_KEY" });
  await api("GET", "/v2/account", { status: 403, code: "PERMISSION_NEED_ADMIN_API_KEY" });
}
