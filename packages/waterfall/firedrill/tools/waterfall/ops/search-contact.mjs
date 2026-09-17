// Search Contact: exactly one mode (single contact, company-specific, or company-set persona), AND-ed filters,
// page_number × page_size over the candidates in person row-id order. Completes synchronously as a search_contact job.
import { account, assertResponseSize, fail, limits, resolveKey } from "../lib/core.mjs";
import { allCompanies, companyByDomain, companyByLinkedin, companyByName, personByLinkedin, personsOfCompany, searchPersonWire } from "../lib/directory.mjs";
import { finderWire, launchJob, readJob } from "../lib/jobs.mjs";
import { COMPANY_SIZES, DEPARTMENTS, SENIORITIES, enumList, foldAll, matchesAny, pageParameters, stringList } from "../lib/lists.mjs";
import { parseDate } from "../lib/time.mjs";
import { compileTitleFilter, matchesTitle } from "../lib/title-filter.mjs";
import { usageWire } from "../lib/usage.mjs";
import { normalizeCustomFields, normalizeDomain, normalizeLinkedin, optionalString, rejectExtraFields } from "../lib/validate.mjs";

const FIELDS = new Set([
  "contact_linkedin", "domain", "company_linkedin", "company_name", "company_location_countries", "company_industries",
  "company_employee_ranges", "experience_start_date", "experience_start_date_new_hire", "title_filters", "title_lists",
  "excluded_names", "included_names", "departments", "seniorities", "location_countries", "page_number", "page_size",
  "custom_fields", "missing_body",
]);
const SEARCH_FIELDS = [...FIELDS].filter((name) => !["contact_linkedin", "page_number", "page_size", "custom_fields", "missing_body"].includes(name));

const bad = (context, detail) => fail(context, "VALIDATION_BAD_REQUEST", "Bad request", [detail]);

function present(input, name) {
  const value = input[name];
  return value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0);
}

function groupList(context, input, name, itemName, validateItem) {
  if (!present(input, name)) return [];
  const value = input[name];
  if (!Array.isArray(value)) bad(context, `${name}: Input should be a valid list`);
  if (value.length > 5) bad(context, `${name}: List should have at most 5 items`);
  return value.map((group, index) => {
    if (typeof group !== "object" || group === null || Array.isArray(group)) bad(context, `${name}.${index}: Input should be a valid dictionary`);
    for (const key of Object.keys(group)) if (key !== "name" && key !== itemName) bad(context, `${name}.${index}.${key.slice(0, 100)}: Extra inputs are not permitted`);
    const groupName = optionalString(context, group, "name", 100);
    if (groupName === null) bad(context, `${name}.${index}.name: Field required`);
    if (!Object.hasOwn(group, itemName) || group[itemName] === null) bad(context, `${name}.${index}.${itemName}: Field required`);
    return { name: groupName, [itemName]: validateItem(group, index) };
  });
}

function dateFilter(context, input, name) {
  const text = optionalString(context, input, name, 10);
  if (text === null) return null;
  const days = parseDate(text);
  if (days === null) bad(context, `${name}: Input should be a valid date in the format YYYY-MM-DD`);
  return { text, days };
}

function currentStartDays(person) {
  const current = person.experiences.find((item) => item.is_current === true) ?? person.experiences[0];
  if (current === undefined) return null;
  if (current.start_date !== null) return parseDate(current.start_date);
  if (current.start_year === null) return null;
  return parseDate(`${String(current.start_year).padStart(4, "0")}-${String(current.start_month ?? 1).padStart(2, "0")}-01`);
}

function candidates(context, task, mode) {
  if (mode === "contact") {
    const person = personByLinkedin(context, task.contact_linkedin);
    return person === null ? [] : [person];
  }
  if (mode === "company") {
    const company = task.domain !== null ? companyByDomain(context, task.domain)
      : task.company_linkedin !== null ? companyByLinkedin(context, task.company_linkedin) : companyByName(context, task.company_name);
    return company === null ? [] : personsOfCompany(context, company.id);
  }
  const countries = foldAll(task.company_location_countries);
  const industries = foldAll(task.company_industries);
  const sizes = foldAll(task.company_employee_ranges);
  const bound = limits(context).maxScanRows;
  const persons = [];
  for (const company of allCompanies(context)) {
    if (!matchesAny(countries, company.country) || !matchesAny(industries, company.industry) || !matchesAny(sizes, company.size)) continue;
    for (const person of personsOfCompany(context, company.id)) {
      if (persons.length >= bound) fail(context, "INTERNAL_UNCLASSIFIED_ERROR", `state exceeds the supported bound of ${bound} rows`);
      persons.push(person);
    }
  }
  return persons.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function searchContactRun(input, context) {
  const { key } = resolveKey(context, { billable: true });
  if (input.missing_body === true) fail(context, "VALIDATION_MISSING_BODY", "Missing body");
  rejectExtraFields(context, input, FIELDS);
  const contactLinkedin = optionalString(context, input, "contact_linkedin", 2083);
  const others = SEARCH_FIELDS.filter((name) => present(input, name));
  let mode;
  if (contactLinkedin !== null) {
    if (others.length > 0) bad(context, "request: Value error, contact_linkedin cannot be set together with other fields");
    mode = "contact";
  } else {
    const specific = ["domain", "company_linkedin", "company_name"].some((name) => present(input, name));
    const persona = ["company_location_countries", "company_industries", "company_employee_ranges"].some((name) => present(input, name));
    if (specific && persona) bad(context, "request: Value error, company identifiers cannot be combined with company-set filters");
    if (!specific && !persona) bad(context, "request: Value error, one search mode is required");
    mode = specific ? "company" : "persona";
  }
  const domain = optionalString(context, input, "domain", 2083);
  const companyLinkedin = optionalString(context, input, "company_linkedin", 2083);
  const task = {
    contact_linkedin: contactLinkedin === null ? null : normalizeLinkedin(context, contactLinkedin, "contact_linkedin"),
    domain: domain === null ? null : normalizeDomain(context, domain),
    company_linkedin: companyLinkedin === null ? null : normalizeLinkedin(context, companyLinkedin, "company_linkedin"),
    company_name: optionalString(context, input, "company_name", 500),
    company_location_countries: stringList(context, input, "company_location_countries", { maxItems: 50, maxLength: 60 }),
    company_industries: stringList(context, input, "company_industries", { maxItems: 50, maxLength: 100 }),
    company_employee_ranges: enumList(context, input, "company_employee_ranges", COMPANY_SIZES, 8),
    experience_start_date: dateFilter(context, input, "experience_start_date")?.text ?? null,
    experience_start_date_new_hire: dateFilter(context, input, "experience_start_date_new_hire")?.text ?? null,
    title_filters: groupList(context, input, "title_filters", "filter", (group, index) => optionalString(context, group, "filter", 500) ?? bad(context, `title_filters.${index}.filter: Field required`)),
    title_lists: groupList(context, input, "title_lists", "titles", (group) => stringList(context, group, "titles", { maxItems: 100, maxLength: 200 })),
    excluded_names: stringList(context, input, "excluded_names", { maxItems: 200 }),
    included_names: stringList(context, input, "included_names", { maxItems: 100 }),
    departments: enumList(context, input, "departments", DEPARTMENTS, 14),
    seniorities: enumList(context, input, "seniorities", SENIORITIES, 9),
    location_countries: stringList(context, input, "location_countries", { maxItems: 50, maxLength: 60 }),
    ...pageParameters(context, input, 10),
    custom_fields: normalizeCustomFields(context, input),
  };
  const filters = task.title_filters.map((group) => compileTitleFilter(context, group.filter));
  if (mode === "persona" && filters.length === 0 && task.title_lists.every((group) => group.titles.length === 0)) {
    fail(context, "VALIDATION_MISSING_TITLE_FILTERS", "Missing title filters: title_filters or title_lists is required for a company-set search");
  }
  const titles = new Set(task.title_lists.flatMap((group) => foldAll(group.titles)));
  const departments = foldAll(task.departments);
  const seniorities = foldAll(task.seniorities);
  const countries = foldAll(task.location_countries);
  const included = foldAll(task.included_names);
  const excluded = foldAll(task.excluded_names);
  const sinceDays = [task.experience_start_date, task.experience_start_date_new_hire].filter((text) => text !== null).map((text) => parseDate(text));
  const matches = candidates(context, task, mode).filter((person) => {
    if (mode === "contact") return true;
    if (!matchesAny(departments, person.department) || !matchesAny(seniorities, person.seniority) || !matchesAny(countries, person.country)) return false;
    const fullName = `${person.first_name} ${person.last_name}`.toLowerCase();
    if (included.length > 0 && !included.some((needle) => fullName.includes(needle))) return false;
    if (excluded.some((needle) => fullName.includes(needle))) return false;
    if (sinceDays.length > 0) {
      const started = currentStartDays(person);
      if (started === null || sinceDays.some((days) => started < days)) return false;
    }
    if (filters.length > 0 || titles.size > 0) {
      const title = (person.title ?? "").toLowerCase();
      if (!titles.has(title) && !filters.some((rpn) => matchesTitle(rpn, title))) return false;
    }
    return true;
  });
  const start = (task.page_number - 1) * task.page_size;
  const page = matches.slice(start, start + task.page_size).map((person) => searchPersonWire(context, person));
  const usage = { persons_count: page.length, persons_micros: page.length * account(context).price_micros.search_contact_found, phones_count: 0, phones_micros: 0, companies_count: 0, companies_micros: 0 };
  assertResponseSize(context, { status: "SUCCEEDED", input: { task }, output: { persons: page, usage: usageWire(usage) } });
  return finderWire(launchJob(context, key, "search_contact", task, { output: { persons: page }, usage }));
}

export function searchContactGet(input, context) {
  resolveKey(context);
  return readJob(context, "search_contact", input);
}
