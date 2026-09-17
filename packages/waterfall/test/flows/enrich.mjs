// Enrichment flows (baseline scenario, master key).
// enrich-contact: launch ok 5 / tool_error 9; contact.get ok 7 / tool_error 4; company.get ok 1; jobs 11;
//   job.launched 5, job.completed 6 (5 new + seeded due job); balance 250 − 1.33 USD. (7 of the 9 rejected launches are
//   Tool errors; the array custom_fields and the constructor key are refused by input validation before the handler runs;
//   a __proto__ key is silently dropped by the HTTP body handling before validation, so it is not probed here.)
// enrich-phone-company: phone.launch ok 3 / err 7; phone.get ok 5 / err 3; company.launch ok 4 / err 6; company.get ok 5 / err 3;
//   search.contact.get ok 1; jobs 14; job.launched 7, job.completed 8 (7 new + the seeded due phone job); balance 250 − 0.94 USD.
const UNKNOWN = "0badc0de-0000-4000-8000-000000000000";

async function launchAndGet(api, kind, body) {
  const { body: launched } = await api("POST", `/v1/enrichment/${kind}`, { body });
  return (await api("GET", `/v1/enrichment/${kind}?job_id=${launched.job_id}`)).body;
}

export async function enrichContact({ api, assert, SEED }) {
  const ada = SEED.PID["ada-lindqvist"];
  const byEmail = await launchAndGet(api, "contact", { email: "ada.lindqvist@northwind.test" });
  assert.equal(byEmail.status, "SUCCEEDED");
  assert.equal(byEmail.output.person.id, ada);
  assert.equal(byEmail.output.person.mobile_phone, null);
  assert.deepEqual(byEmail.output.person.phone_numbers, []);
  assert.equal(byEmail.output.person.company_name, "Northwind Labs");
  assert.equal(byEmail.output.usage.total_usd, 0.138);
  assert.equal(byEmail.input.task.email, "ada.lindqvist@northwind.test");
  assert.equal(byEmail.input.task.job_id, byEmail.input.task.context_id);
  const byLinkedin = await launchAndGet(api, "contact", { linkedin: "https://www.linkedin.com/in/Ada-Lindqvist/", include_phones: true, custom_fields: { crm_id: "acc-1", vip: true, score: 7 } });
  assert.equal(byLinkedin.output.person.mobile_phone, "+12065550101");
  assert.equal(byLinkedin.output.usage.total_usd, 0.458);
  assert.equal(byLinkedin.output.usage.phones_count, 1);
  assert.deepEqual(byLinkedin.input.task.custom_fields, { crm_id: "acc-1", vip: true, score: 7 });
  const byFullName = await launchAndGet(api, "contact", { full_name: "  ada   LINDQVIST ", domain: "northwind.test" });
  assert.equal(byFullName.output.person.id, ada);
  const byParts = await launchAndGet(api, "contact", { first_name: "Ada", last_name: "Lindqvist", domain: "https://www.northwind.test/about" });
  assert.equal(byParts.output.person.id, ada);
  assert.equal(byParts.input.task.domain, "northwind.test");
  const before = (await api("GET", "/v2/account")).body.balance_remaining_usd;
  const miss = await launchAndGet(api, "contact", { email: "nobody@northwind.test" });
  assert.equal(miss.status, "SUCCEEDED");
  assert.equal(miss.output.person, null);
  assert.equal(miss.output.usage.total_usd, 0);
  assert.equal((await api("GET", "/v2/account")).body.balance_remaining_usd, before, "a miss is not billed");
  // Validation errors (each leaves no job behind).
  await api("POST", "/v1/enrichment/contact", { body: { email: "info@northwind.test" }, status: 400, code: "VALIDATION_BAD_EMAIL_ROLE" });
  await api("POST", "/v1/enrichment/contact", { body: { full_name: "Ada Lindqvist", domain: "gmail.com" }, status: 400, code: "VALIDATION_BAD_DOMAIN_EMAIL_PROVIDER" });
  await api("POST", "/v1/enrichment/contact", { body: { full_name: "Ada Lindqvist", domain: "https://www.linkedin.com/in/x" }, status: 400, code: "VALIDATION_BAD_DOMAIN_SOCIAL_MEDIA" });
  await api("POST", "/v1/enrichment/contact", { body: { full_name: "Ada Lindqvist", domain: "not a domain" }, status: 400, code: "VALIDATION_BAD_DOMAIN" });
  await api("POST", "/v1/enrichment/contact", { body: { email: "bad-address" }, status: 400, code: "VALIDATION_BAD_EMAIL_INVALID" });
  const none = await api("POST", "/v1/enrichment/contact", { body: {}, status: 400, code: "VALIDATION_BAD_REQUEST" });
  assert.match(none.body.error[0], /one of email, linkedin/);
  await api("POST", "/v1/enrichment/contact", { body: { email: "ada.lindqvist@northwind.test", custom_fields: ["x"] }, status: 400, code: "VALIDATION_BAD_REQUEST" });
  await api("POST", "/v1/enrichment/contact", { raw: '{"email":"ada.lindqvist@northwind.test","custom_fields":{"constructor":"x"}}', status: 400, code: "VALIDATION_BAD_REQUEST" });
  await api("POST", "/v1/enrichment/contact", { body: { email: "ada.lindqvist@northwind.test", webhook_url: `https://hooks.example/${"a".repeat(2070)}` }, status: 400, code: "VALIDATION_BAD_REQUEST" });
  await api("POST", "/v1/enrichment/contact", { body: { email: "ada.lindqvist@northwind.test", bogus: 1 }, status: 400, code: "VALIDATION_BAD_REQUEST" });
  await api("POST", "/v1/enrichment/contact", { body: null, status: 400, code: "VALIDATION_MISSING_BODY" });
  // Finder errors.
  await api("GET", "/v1/enrichment/contact", { status: 400, code: "VALIDATION_MISSING_JOB_ID_PARAMETER" });
  await api("GET", "/v1/enrichment/contact?job_id=x", { status: 400, code: "VALIDATION_BAD_JOB_ID" });
  await api("GET", `/v1/enrichment/contact?job_id=${UNKNOWN}`, { status: 404, code: "NOT_FOUND_JOB_NOT_FOUND" });
  await api("GET", `/v1/enrichment/contact?job_id=${SEED.JID[6]}`, { status: 404, code: "NOT_FOUND_JOB_NOT_FOUND" });
  // Seeded jobs: the due RUNNING job completes on first read; the far-future one stays RUNNING.
  const due = (await api("GET", `/v1/enrichment/contact?job_id=${SEED.JID[5]}`)).body;
  assert.equal(due.status, "SUCCEEDED");
  assert.equal(due.output.person.mobile_phone, "+12065550102");
  assert.equal(due.output.usage.total_usd, 0.458);
  assert.equal(due.stop_date, "2026-09-16T10:00:00.000000+00:00");
  const future = (await api("GET", `/v1/enrichment/company?job_id=${SEED.JID[6]}`)).body;
  assert.equal(future.status, "RUNNING");
  assert.equal(future.output, undefined);
  assert.equal(future.stop_date, undefined);
  assert.deepEqual(future.input.task.custom_fields, { batch: "q3-accounts" });
  const seeded = (await api("GET", `/v1/enrichment/contact?job_id=${SEED.JID[1]}`)).body;
  assert.equal(seeded.status, "SUCCEEDED");
  assert.equal(seeded.output.person.id, ada);
  assert.equal(seeded.start_date, "2026-09-15T14:02:11.250000+00:00");
  assert.equal(seeded.stop_date, "2026-09-15T14:02:14.750000+00:00");
}

export async function enrichPhoneCompany({ api, assert, SEED }) {
  const withPhone = await launchAndGet(api, "phone", { linkedin: "ada-lindqvist" });
  assert.equal(withPhone.output.person.mobile_phone, "+12065550101");
  assert.deepEqual(withPhone.output.person.phone_numbers, ["+12065550101"]);
  assert.equal(withPhone.output.usage.total_usd, 0.32);
  assert.equal(withPhone.output.usage.phones_count, 1);
  const noPhone = await launchAndGet(api, "phone", { email: "dana.kowalski@litware.example" });
  assert.equal(noPhone.output.person.id, SEED.PID["dana-kowalski"]);
  assert.equal(noPhone.output.person.mobile_phone, null);
  assert.equal(noPhone.output.usage.total_usd, 0);
  const missing = await launchAndGet(api, "phone", { full_name: "Nobody Here", domain: "fabrikam.example" });
  assert.equal(missing.output.person, null);
  const byDomain = await launchAndGet(api, "company", { domain: "https://www.northwind.test/" });
  assert.equal(byDomain.output.company.name, "Northwind Labs");
  assert.equal(byDomain.output.company.funding_details.total_funding_rounds, 3);
  assert.equal(byDomain.output.company.funding_details.funding_rounds[2].investor_count, 4);
  assert.equal(byDomain.output.company.smtp_provider, undefined, "verification fields never appear on a company");
  assert.equal(byDomain.output.usage.total_usd, 0.1);
  const byLinkedin = await launchAndGet(api, "company", { linkedin: "https://www.linkedin.com/company/contoso-freight/" });
  assert.equal(byLinkedin.output.company.name, "Contoso Freight");
  const byName = await launchAndGet(api, "company", { name: "fabrikam" });
  assert.equal(byName.output.company.id, SEED.CID["fabrikam.example"]);
  assert.equal(byName.output.company.founded, null);
  await api("POST", "/v1/enrichment/company", { body: { domain: "northwind.test", name: "Northwind Labs" }, status: 400, code: "VALIDATION_BAD_REQUEST" });
  await api("POST", "/v1/enrichment/company", { body: {}, status: 400, code: "VALIDATION_BAD_REQUEST" });
  await api("POST", "/v1/enrichment/company", { body: { domain: "gmail.com" }, status: 400, code: "VALIDATION_BAD_DOMAIN_EMAIL_PROVIDER" });
  const unknown = await launchAndGet(api, "company", { name: "Unknown Corp" });
  assert.equal(unknown.output.company, null);
  assert.equal(unknown.output.usage.total_usd, 0);
  await api("GET", `/v1/enrichment/phone?job_id=${SEED.JID[1]}`, { status: 404, code: "NOT_FOUND_JOB_NOT_FOUND" });
  await api("POST", "/v1/enrichment/phone", { body: { email: "sales@northwind.test" }, status: 400, code: "VALIDATION_BAD_EMAIL_ROLE" });
  await api("POST", "/v1/enrichment/phone", { body: {}, status: 400, code: "VALIDATION_BAD_REQUEST" });
  await api("POST", "/v1/enrichment/phone", { body: { full_name: "Ada Lindqvist", domain: "-bad-" }, status: 400, code: "VALIDATION_BAD_DOMAIN" });
  await api("POST", "/v1/enrichment/phone", { body: { full_name: "Ada Lindqvist", domain: "outlook.com" }, status: 400, code: "VALIDATION_BAD_DOMAIN_EMAIL_PROVIDER" });
  await api("POST", "/v1/enrichment/phone", { body: { full_name: "Ada Lindqvist", domain: "twitter.com" }, status: 400, code: "VALIDATION_BAD_DOMAIN_SOCIAL_MEDIA" });
  await api("POST", "/v1/enrichment/phone", { body: { email: "no-at-sign" }, status: 400, code: "VALIDATION_BAD_EMAIL_INVALID" });
  await api("POST", "/v1/enrichment/phone", { body: null, status: 400, code: "VALIDATION_MISSING_BODY" });
  await api("POST", "/v1/enrichment/company", { body: { domain: "not a domain" }, status: 400, code: "VALIDATION_BAD_DOMAIN" });
  await api("POST", "/v1/enrichment/company", { body: { domain: "https://www.instagram.com/northwind" }, status: 400, code: "VALIDATION_BAD_DOMAIN_SOCIAL_MEDIA" });
  await api("POST", "/v1/enrichment/company", { body: null, status: 400, code: "VALIDATION_MISSING_BODY" });
  await api("GET", "/v1/enrichment/company", { status: 400, code: "VALIDATION_MISSING_JOB_ID_PARAMETER" });
  await api("GET", "/v1/enrichment/company?job_id=1&job_id=2", { status: 400, code: "VALIDATION_BAD_JOB_ID" });
  await api("GET", `/v1/enrichment/company?job_id=${UNKNOWN}`, { status: 404, code: "NOT_FOUND_JOB_NOT_FOUND" });
  await api("GET", "/v1/enrichment/phone", { status: 400, code: "VALIDATION_MISSING_JOB_ID_PARAMETER" });
  await api("GET", "/v1/enrichment/phone?job_id=%7B", { status: 400, code: "VALIDATION_BAD_JOB_ID" });
  const duePhone = (await api("GET", `/v1/enrichment/phone?job_id=${SEED.JID[7]}`)).body;
  assert.equal(duePhone.status, "SUCCEEDED", "the seeded due phone job completes on first read");
  assert.equal(duePhone.output.person.mobile_phone, "+12065550101");
  assert.equal(duePhone.output.usage.total_usd, 0.32);
  const failed = (await api("GET", `/v1/enrichment/phone?job_id=${SEED.JID[2]}`)).body;
  assert.equal(failed.status, "FAILED");
  assert.equal(failed.error, "Provider error");
  assert.equal(failed.output, undefined);
  assert.equal((await api("GET", `/v1/enrichment/company?job_id=${SEED.JID[3]}`)).body.status, "TIMED_OUT");
  assert.equal((await api("GET", `/v1/search/contact?job_id=${SEED.JID[4]}`)).body.status, "ABORTED");
}
