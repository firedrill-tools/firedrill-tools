// Fault and scenario flows (master key unless noted).
// rate-limited: 7 launch/run tool_errors (429 + rate-limit headers), finders and account still 200; jobs 6; job.launched 0.
// enrichment-outage: 3 launch tool_errors (500); search.contact.run ok 1; jobs 7.
// key-create-lost: api_keys.create tool_error 2 (500 after commit); api-keys rows 5; api-key.created 2; api_keys.list ok 2.
// over-quota: 7 launch/run tool_errors (402); enrichment.contact.get, account.get, api_keys.list ok; jobs 6.
// slow-jobs: 3 launches stay RUNNING (3 finder reads ok, no output); search.contact.run + verify.email.run SUCCEEDED;
//   jobs 11; job.launched 5; job.completed 2.
// tight-limits (max_scan_rows 3, a fourth API key): every bounded scan answers 500 INTERNAL_UNCLASSIFIED_ERROR and writes nothing:
//   search.contact.run 2, search.company.run 1, account.get 1, api_keys.list 1, enrichment.contact.launch 1, enrichment.phone.launch 1,
//   job_change.run 1 (name + domain resolution), enrichment.contact.get 1 and enrichment.phone.get 1 (seeded due jobs by name); jobs 7.
const LAUNCHES = [
  ["/v1/enrichment/contact", { email: "ada.lindqvist@northwind.test" }],
  ["/v1/enrichment/phone", { linkedin: "ada-lindqvist" }],
  ["/v1/enrichment/company", { domain: "northwind.test" }],
  ["/v1/search/contact", { domain: "northwind.test" }],
  ["/v1/search/company", { sizes: ["1-10"] }],
  ["/v1/job/change", { contact_linkedin: "ada-lindqvist" }],
  ["/v1/verify/email", { email: "ada.lindqvist@northwind.test" }],
];

export async function rateLimited({ api, assert, SEED }) {
  for (const [path, body] of LAUNCHES) {
    const { body: json, headers } = await api("POST", path, { body, status: 429, code: "RATE_LIMIT_RATE_LIMIT_EXCEEDED" });
    assert.equal(json.category, "RATE_LIMIT");
    assert.equal(headers.get("retry-after"), "12");
    assert.equal(headers.get("x-ratelimit-limit"), "50");
    assert.equal(headers.get("x-ratelimit-remaining"), "0");
    assert.equal(headers.get("x-ratelimit-interval"), "60");
  }
  assert.equal((await api("GET", `/v1/enrichment/contact?job_id=${SEED.JID[1]}`)).body.status, "SUCCEEDED");
  assert.equal((await api("GET", "/v2/account")).body.balance_remaining_usd, 250);
}

export async function enrichmentOutage({ api, assert }) {
  for (const [path, body] of LAUNCHES.slice(0, 3)) {
    const { body: json } = await api("POST", path, { body, status: 500, code: "INTERNAL_UNCLASSIFIED_ERROR" });
    assert.equal(json.message, "Internal server error");
  }
  const search = (await api("POST", "/v1/search/contact", { body: { domain: "litware.example" } })).body;
  assert.equal(search.status, "SUCCEEDED");
  assert.equal(search.output.persons.length, 1);
}

export async function keyCreateLost({ api, assert }) {
  await api("POST", "/v1/api-keys", { body: { notes: "Reporting" }, status: 500, code: "INTERNAL_FAILED_CREATE_API_KEY" });
  const first = (await api("GET", "/v1/api-keys")).body.api_keys;
  assert.equal(first.length, 4, "the key was committed although the caller saw 500");
  assert.equal(first[3].notes, "Reporting");
  await api("POST", "/v1/api-keys", { body: { notes: "Reporting" }, status: 500, code: "INTERNAL_FAILED_CREATE_API_KEY" });
  const second = (await api("GET", "/v1/api-keys")).body.api_keys;
  assert.equal(second.length, 5, "a blind retry creates a second key with the same notes");
  assert.notEqual(second[3].api_key, second[4].api_key);
}

export async function overQuota({ api, assert, SEED }) {
  for (const [path, body] of LAUNCHES) {
    const { body: json } = await api("POST", path, { body, status: 402, code: "QUOTA_ACCOUNT_OVER_QUOTA" });
    assert.equal(json.category, "QUOTA");
  }
  assert.equal((await api("GET", `/v1/enrichment/contact?job_id=${SEED.JID[1]}`)).body.status, "SUCCEEDED");
  assert.equal((await api("GET", "/v2/account")).body.balance_remaining_usd, 0);
  assert.equal((await api("GET", "/v1/api-keys")).body.api_keys.length, 3);
}

export async function slowJobs({ api, assert }) {
  for (const [path, body] of LAUNCHES.slice(0, 3)) {
    const launched = (await api("POST", path, { body: { ...body, custom_fields: { batch: "slow" } } })).body;
    assert.equal(launched.start_date, "2026-09-16T10:00:00.000000+00:00");
    const job = (await api("GET", `${path}?job_id=${launched.job_id}`)).body;
    assert.equal(job.status, "RUNNING");
    assert.equal(job.output, undefined);
    assert.equal(job.stop_date, undefined);
    assert.deepEqual(job.input.task.custom_fields, { batch: "slow" });
    assert.equal(job.input.task.job_id, launched.job_id);
  }
  assert.equal((await api("POST", "/v1/search/contact", { body: { domain: "northwind.test", seniorities: ["Owner"] } })).body.status, "SUCCEEDED");
  assert.equal((await api("POST", "/v1/verify/email", { body: { email: "ada.lindqvist@northwind.test" } })).body.status, "SUCCEEDED");
}

export async function tightLimits({ api, assert, SEED }) {
  const bound = (path, body) => api("POST", path, { body, status: 500, code: "INTERNAL_UNCLASSIFIED_ERROR" });
  const specific = await bound("/v1/search/contact", { domain: "northwind.test" });
  assert.match(specific.body.message, /supported bound of 3 rows/);
  await bound("/v1/search/contact", { company_industries: ["Software Development"], title_filters: [{ name: "all", filter: "NOT Intern" }] });
  await bound("/v1/search/company", { industries: ["Software Development"] });
  await api("GET", "/v2/account", { status: 500, code: "INTERNAL_UNCLASSIFIED_ERROR" });
  await api("GET", "/v1/api-keys", { status: 500, code: "INTERNAL_UNCLASSIFIED_ERROR" });
  await bound("/v1/enrichment/contact", { full_name: "Ada Lindqvist", domain: "northwind.test" });
  await bound("/v1/enrichment/phone", { full_name: "Ada Lindqvist", domain: "northwind.test" });
  await bound("/v1/job/change", { contact_full_name: "Ada Lindqvist", company_domain: "northwind.test" });
  await api("GET", `/v1/enrichment/contact?job_id=${SEED.JID[5]}`, { status: 500, code: "INTERNAL_UNCLASSIFIED_ERROR" });
  await api("GET", `/v1/enrichment/phone?job_id=${SEED.JID[7]}`, { status: 500, code: "INTERNAL_UNCLASSIFIED_ERROR" });
  assert.equal((await api("GET", `/v1/enrichment/contact?job_id=${SEED.JID[1]}`)).body.status, "SUCCEEDED", "reads that do not scan still answer");
}
