// Search Company: AND across `industries`, `location_countries` and `sizes` (OR within), exact case-insensitive
// matches, paged in company row-id order. Completes synchronously as a search_company job.
import { account, assertResponseSize, fail, resolveKey } from "../lib/core.mjs";
import { allCompanies, companyWire } from "../lib/directory.mjs";
import { finderWire, launchJob, readJob } from "../lib/jobs.mjs";
import { COMPANY_SIZES, enumList, foldAll, matchesAny, pageParameters, stringList } from "../lib/lists.mjs";
import { usageWire } from "../lib/usage.mjs";
import { normalizeCustomFields, rejectExtraFields } from "../lib/validate.mjs";

const FIELDS = new Set(["industries", "location_countries", "sizes", "page_number", "page_size", "custom_fields", "missing_body"]);

export function searchCompanyRun(input, context) {
  const { key } = resolveKey(context, { billable: true });
  if (input.missing_body === true) fail(context, "VALIDATION_MISSING_BODY", "Missing body");
  rejectExtraFields(context, input, FIELDS);
  const task = {
    industries: stringList(context, input, "industries", { maxItems: 50, minLength: 5, maxLength: 57 }),
    location_countries: stringList(context, input, "location_countries", { maxItems: 50, minLength: 4, maxLength: 40 }),
    sizes: enumList(context, input, "sizes", COMPANY_SIZES, 8),
    ...pageParameters(context, input, 20),
    custom_fields: normalizeCustomFields(context, input),
  };
  if (task.industries.length === 0 && task.location_countries.length === 0 && task.sizes.length === 0) {
    fail(context, "VALIDATION_BAD_REQUEST", "Bad request", ["request: Value error, at least one of industries, location_countries or sizes must be provided"]);
  }
  const industries = foldAll(task.industries);
  const countries = foldAll(task.location_countries);
  const sizes = foldAll(task.sizes);
  const matches = allCompanies(context).filter(
    (company) => matchesAny(industries, company.industry) && matchesAny(countries, company.country) && matchesAny(sizes, company.size),
  );
  const start = (task.page_number - 1) * task.page_size;
  const page = matches.slice(start, start + task.page_size).map((company) => companyWire(company));
  const usage = { persons_count: 0, persons_micros: 0, phones_count: 0, phones_micros: 0, companies_count: page.length, companies_micros: page.length * account(context).price_micros.search_company_found };
  assertResponseSize(context, { status: "SUCCEEDED", input: { task }, output: { companies: page, usage: usageWire(usage) } });
  return finderWire(launchJob(context, key, "search_company", task, { output: { companies: page }, usage }));
}

export function searchCompanyGet(input, context) {
  resolveKey(context);
  return readJob(context, "search_company", input);
}
