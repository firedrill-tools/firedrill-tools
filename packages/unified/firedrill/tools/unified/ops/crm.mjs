// CRM contacts and companies: body specs, defaults, derived `name`, list filters.
import { badRequest } from "../lib/errors.mjs";
import { idFilter, textFilter } from "../lib/query.mjs";
import { bool, idArray, num, shape, str, strArray } from "../lib/validate.mjs";
import { makeResource } from "./resource.mjs";

const TEXT = 1000;

const CONTACT_SPECS = {
  name: str(TEXT),
  first_name: str(TEXT),
  last_name: str(TEXT),
  title: str(TEXT),
  company: str(TEXT),
  department: str(TEXT),
  image_url: str(2048),
  user_id: str(256),
  emails: shape("emails"),
  telephones: shape("telephones"),
  address: shape("address"),
  company_ids: idArray(100),
  deal_ids: idArray(100),
  link_urls: strArray(32, 2048),
  metadata: shape("metadata"),
  raw: shape("raw"),
};

const COMPANY_SPECS = {
  name: str(TEXT, { nullable: false, min: 1 }),
  description: str(20000),
  industry: str(TEXT),
  timezone: str(128),
  employees: num({ min: 0, integer: true }),
  is_active: bool(),
  tags: strArray(100, 256),
  websites: strArray(32, 253),
  domains: strArray(32, 253),
  emails: shape("emails"),
  telephones: shape("telephones"),
  address: shape("address"),
  link_urls: strArray(32, 2048),
  contact_ids: idArray(100),
  deal_ids: idArray(100),
  user_id: str(256),
  metadata: shape("metadata"),
  raw: shape("raw"),
};

const contactDefaults = () => ({
  name: null, first_name: null, last_name: null, title: null, company: null, department: null, image_url: null, user_id: null,
  emails: [], telephones: [], address: null, company_ids: [], deal_ids: [], link_urls: [], metadata: [], raw: {},
});

const companyDefaults = () => ({
  name: "", description: null, industry: null, timezone: null, employees: null, is_active: true, tags: [], websites: [], domains: [],
  emails: [], telephones: [], address: null, link_urls: [], contact_ids: [], deal_ids: [], user_id: null, metadata: [], raw: {},
});

/** `name` derives from first/last name when the body does not set it. */
function deriveName(fields) {
  if (fields.name !== null && fields.name !== undefined) return fields.name;
  const parts = [fields.first_name, fields.last_name].filter((part) => typeof part === "string" && part.length > 0);
  return parts.length > 0 ? parts.join(" ") : null;
}

/** Reference filters by association array membership plus the exact `user_id`. */
function crmFilter(names) {
  return (input, context) => {
    const wanted = [];
    for (const [param, field] of Object.entries(names)) {
      const value = idFilter(input, context, param);
      if (value !== null) wanted.push([field, value]);
    }
    const userId = textFilter(input, context, "user_id");
    return (row) => {
      if (userId !== null && row.user_id !== userId) return false;
      for (const [field, value] of wanted) if (!Array.isArray(row[field]) || !row[field].includes(value)) return false;
      return true;
    };
  };
}

export const contacts = makeResource({
  namespace: "contacts",
  label: "Contact",
  category: "crm",
  permission: "crm_contact",
  objectType: "crm_contact",
  searchFields: ["name", "first_name", "last_name", "emails"],
  bodySpecs: CONTACT_SPECS,
  defaults: contactDefaults,
  filter: crmFilter({ company_id: "company_ids", deal_id: "deal_ids" }),
  prepareCreate(context, connection, fields) {
    const row = { ...contactDefaults(), ...fields };
    row.name = deriveName(row);
    if (row.name === null && row.emails.length === 0) badRequest(context, "At least one of name, first_name, last_name or emails is required");
    return row;
  },
  prepareUpdate(context, connection, existing, fields) {
    const merged = { ...existing, ...fields };
    if (!Object.hasOwn(fields, "name") && (Object.hasOwn(fields, "first_name") || Object.hasOwn(fields, "last_name"))) {
      merged.name = deriveName({ ...merged, name: null }) ?? merged.name;
    }
    if (merged.name === null && merged.emails.length === 0) badRequest(context, "At least one of name, first_name, last_name or emails is required");
    return merged;
  },
});

export const companies = makeResource({
  namespace: "companies",
  label: "Company",
  category: "crm",
  permission: "crm_company",
  objectType: "crm_company",
  searchFields: ["name", "emails", "domains", "websites"],
  bodySpecs: COMPANY_SPECS,
  defaults: companyDefaults,
  filter: crmFilter({ contact_id: "contact_ids", deal_id: "deal_ids" }),
  prepareCreate(context, connection, fields) {
    if (typeof fields.name !== "string" || fields.name.length === 0) badRequest(context, "name is required");
    return { ...companyDefaults(), ...fields };
  },
  prepareUpdate(context, connection, existing, fields) {
    return { ...existing, ...fields };
  },
});
