// The seeded synthetic directory: index lookups for persons and companies, and the wire shapes built from state rows.
// Every result is a function of state; nothing is looked up outside the world.
import { scanAll } from "./core.mjs";

function nameKey(text) {
  return text.trim().toLowerCase().split(/\s+/).filter((part) => part.length > 0).join(" ");
}

export function companyByDomain(context, domain) {
  const index = context.state.get("company-domains", domain);
  return index === null ? null : context.state.get("companies", index.company_id);
}

export function companyByLinkedin(context, linkedinId) {
  const index = context.state.get("company-linkedin", linkedinId);
  return index === null ? null : context.state.get("companies", index.company_id);
}

export function companyByName(context, name) {
  const key = nameKey(name);
  if (key.length === 0 || key.length > 500) return null;
  const index = context.state.get("company-names", key);
  return index === null ? null : context.state.get("companies", index.company_id);
}

export function companyById(context, id) {
  return id === null || id === undefined ? null : context.state.get("companies", id);
}

export function personByEmail(context, email) {
  const index = context.state.get("person-emails", email);
  return index === null ? null : context.state.get("persons", index.person_id);
}

export function personByLinkedin(context, linkedinId) {
  const index = context.state.get("person-linkedin", linkedinId);
  return index === null ? null : context.state.get("persons", index.person_id);
}

/** Every person of a company, in row-id order (bounded prefix scan of `company-persons`). */
export function personsOfCompany(context, companyId) {
  const persons = [];
  for (const record of scanAll(context, "company-persons", `${companyId}/`)) {
    const person = context.state.get("persons", record.value.person_id);
    if (person !== null) persons.push(person);
  }
  return persons;
}

/** First person of a company whose collapsed lowercase full name equals `fullName`. */
export function personByNameInCompany(context, companyId, fullName) {
  const key = nameKey(fullName);
  if (key.length === 0) return null;
  for (const person of personsOfCompany(context, companyId)) if (person.full_name_key === key) return person;
  return null;
}

/** Every company row (bounded scan). */
export function allCompanies(context) {
  return scanAll(context, "companies").map((record) => record.value);
}

export function fundingWire(details) {
  return {
    total_funding_rounds: details.total_funding_rounds,
    total_funding_usd: details.total_funding_usd,
    funding_rounds: details.funding_rounds.map((round) => ({
      round_name: round.round_name,
      round_date: round.round_date,
      investor_count: round.investor_count,
      amount_raised_usd: round.amount_raised_usd,
      investor_names: [...round.investor_names],
    })),
  };
}

/** The 20 documented `CompanyEnriched` fields (verification-only fields are never exposed). */
export function companyWire(company) {
  return {
    id: company.id,
    domain: company.domain,
    name: company.name,
    website: company.website,
    linkedin_id: company.linkedin_id,
    linkedin_url: company.linkedin_url,
    description: company.description,
    logo_url: company.logo_url,
    size: company.size,
    employees_count: company.employees_count,
    industry: company.industry,
    type: company.type,
    founded: company.founded,
    address: company.address,
    country: company.country,
    linkedin_followers: company.linkedin_followers,
    crunchbase_url: company.crunchbase_url,
    recent_job_posting_count: company.recent_job_posting_count,
    technologies: [...company.technologies],
    funding_details: fundingWire(company.funding_details),
  };
}

export function experiencesWire(experiences) {
  return experiences.map((item) => ({ ...item }));
}

function companyFields(context, person) {
  const company = companyById(context, person.company_id);
  return {
    company_name: company === null ? null : company.name,
    company_domain: company === null ? null : company.domain,
    company_linkedin_id: company === null ? null : company.linkedin_id,
    company_linkedin_url: company === null ? null : company.linkedin_url,
    company_website: company === null ? null : company.website,
  };
}

/** The full `Person` shape returned by contact and phone enrichment. */
export function personWire(context, person, options = {}) {
  const phones = options.phones === true;
  const company = companyFields(context, person);
  return {
    id: person.id,
    first_name: person.first_name,
    last_name: person.last_name,
    linkedin_id: person.linkedin_id,
    linkedin_url: person.linkedin_url,
    about: person.about,
    personal_email: person.personal_email,
    professional_email: person.professional_email,
    mobile_phone: phones ? person.mobile_phone : null,
    phone_numbers: phones ? [...person.phone_numbers] : [],
    location: person.location,
    country: person.country,
    company_name: company.company_name,
    company_domain: company.company_domain,
    company_linkedin_id: company.company_linkedin_id,
    company_linkedin_url: company.company_linkedin_url,
    company_website: company.company_website,
    title: person.title,
    seniority: person.seniority,
    department: person.department,
    experiences: experiencesWire(person.experiences),
    email_verified: person.email_verified,
    email_confidence: person.email_confidence,
    email_verified_status: person.email_verified_status,
    domain_age_days: person.domain_age_days,
    smtp_provider: person.smtp_provider,
    mx_record: person.mx_record,
  };
}

/** The `SearchContactPerson` shape: identity and role, never contact details. */
export function searchPersonWire(context, person) {
  const company = companyFields(context, person);
  return {
    id: person.id,
    first_name: person.first_name,
    last_name: person.last_name,
    linkedin_id: person.linkedin_id,
    linkedin_url: person.linkedin_url,
    location: person.location,
    country: person.country,
    company_name: company.company_name,
    company_domain: company.company_domain,
    company_linkedin_id: company.company_linkedin_id,
    title: person.title,
    seniority: person.seniority,
    department: person.department,
    experiences: experiencesWire(person.experiences),
    professional_email: null,
    personal_email: null,
    mobile_phone: null,
    phone_numbers: [],
  };
}

/** The redacted person of a job-change result. */
export function redactedPersonWire(context, person) {
  const company = companyFields(context, person);
  return {
    id: person.id,
    first_name: person.first_name,
    last_name: person.last_name,
    linkedin_id: person.linkedin_id,
    linkedin_url: person.linkedin_url,
    company_name: company.company_name,
    company_domain: company.company_domain,
    title: person.title,
    seniority: person.seniority,
    department: person.department,
  };
}
