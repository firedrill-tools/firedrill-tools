// Result computers for the asynchronous enrichment kinds. They run from the stored (already normalised) task, either
// in the launching call (job delay 0) or in the finder that first reads a due job, so both paths compute identically.
import { account } from "./core.mjs";
import { companyByDomain, companyByLinkedin, companyByName, companyWire, personByEmail, personByLinkedin, personByNameInCompany, personWire } from "./directory.mjs";
import { zeroUsage } from "./usage.mjs";

/** Resolve a person from a normalised enrichment task: email > linkedin > full_name+domain > first+last+domain. */
export function resolvePerson(context, task) {
  if (task.email !== null && task.email !== undefined) return personByEmail(context, task.email);
  if (task.linkedin !== null && task.linkedin !== undefined) return personByLinkedin(context, task.linkedin);
  const company = task.domain === null || task.domain === undefined ? null : companyByDomain(context, task.domain);
  if (company === null) return null;
  if (task.full_name !== null && task.full_name !== undefined) return personByNameInCompany(context, company.id, task.full_name);
  if (task.first_name !== null && task.first_name !== undefined && task.last_name !== null && task.last_name !== undefined) {
    return personByNameInCompany(context, company.id, `${task.first_name} ${task.last_name}`);
  }
  return null;
}

/** Resolve a company from a normalised company-enrichment task: domain > linkedin > name. */
export function resolveCompany(context, task) {
  if (task.domain !== null && task.domain !== undefined) return companyByDomain(context, task.domain);
  if (task.linkedin !== null && task.linkedin !== undefined) return companyByLinkedin(context, task.linkedin);
  if (task.name !== null && task.name !== undefined) return companyByName(context, task.name);
  return null;
}

function contactResult(context, task) {
  const person = resolvePerson(context, task);
  const usage = zeroUsage();
  if (person === null) return { output: { person: null }, usage };
  const price = account(context).price_micros;
  const withPhones = task.include_phones === true;
  const wire = personWire(context, person, { phones: withPhones });
  usage.persons_count = 1;
  usage.persons_micros = price.enrichment_contact_persons;
  if (withPhones && wire.mobile_phone !== null) {
    usage.phones_count = 1;
    usage.phones_micros = price.enrichment_contact_persons_phones;
  }
  return { output: { person: wire }, usage };
}

function phoneResult(context, task) {
  const person = resolvePerson(context, task);
  const usage = zeroUsage();
  if (person === null) return { output: { person: null }, usage };
  const wire = personWire(context, person, { phones: true });
  if (wire.mobile_phone !== null) {
    usage.phones_count = 1;
    usage.phones_micros = account(context).price_micros.enrichment_phone_phones;
  }
  return { output: { person: wire }, usage };
}

function companyResult(context, task) {
  const company = resolveCompany(context, task);
  const usage = zeroUsage();
  if (company === null) return { output: { company: null }, usage };
  usage.companies_count = 1;
  usage.companies_micros = account(context).price_micros.enrichment_company_companies;
  return { output: { company: companyWire(company) }, usage };
}

/** `{ output, usage }` of an asynchronous job, computed from its stored task. */
export function computeAsyncResult(context, job) {
  if (job.kind === "enrichment_contact") return contactResult(context, job.task);
  if (job.kind === "enrichment_phone") return phoneResult(context, job.task);
  if (job.kind === "enrichment_company") return companyResult(context, job.task);
  // Synchronous kinds always complete in their launching call; a seeded RUNNING row of such a kind would be a data error.
  return { output: {}, usage: zeroUsage() };
}
