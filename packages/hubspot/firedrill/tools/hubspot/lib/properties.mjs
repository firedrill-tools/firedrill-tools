// HubSpot-defined property definitions (the subset agents actually use), default property sets, the
// searchable properties behind free-text `query`, and value coercion. Custom properties live in the
// `properties` state namespace and are merged in by the behavior module.
import { clip, definedAt, normalizeDateTime } from "./state.mjs";

function option(value, label) {
  return { label: label ?? value, value, displayOrder: -1, hidden: false };
}

function def(name, label, type, fieldType, groupName, extra = {}) {
  const { options = [], readOnly = false, unique = false, hidden = false, calculated = false, description = "" } = extra;
  return Object.freeze({
    name,
    label,
    type,
    fieldType,
    groupName,
    description,
    options: options.map((entry, index) => ({ ...option(entry.value ?? entry, entry.label), displayOrder: index })),
    displayOrder: -1,
    hasUniqueValue: unique,
    hidden,
    formField: !readOnly && !hidden,
    calculated,
    externalOptions: false,
    archived: false,
    hubspotDefined: true,
    modificationMetadata: { archivable: false, readOnlyDefinition: true, readOnlyValue: readOnly },
    createdAt: definedAt(),
    updatedAt: definedAt(),
  });
}

const LIFECYCLE_STAGES = [
  { value: "subscriber", label: "Subscriber" },
  { value: "lead", label: "Lead" },
  { value: "marketingqualifiedlead", label: "Marketing Qualified Lead" },
  { value: "salesqualifiedlead", label: "Sales Qualified Lead" },
  { value: "opportunity", label: "Opportunity" },
  { value: "customer", label: "Customer" },
  { value: "evangelist", label: "Evangelist" },
  { value: "other", label: "Other" },
];

const LEAD_STATUSES = [
  { value: "NEW", label: "New" },
  { value: "OPEN", label: "Open" },
  { value: "IN_PROGRESS", label: "In progress" },
  { value: "OPEN_DEAL", label: "Open deal" },
  { value: "UNQUALIFIED", label: "Unqualified" },
  { value: "ATTEMPTED_TO_CONTACT", label: "Attempted to contact" },
  { value: "CONNECTED", label: "Connected" },
  { value: "BAD_TIMING", label: "Bad timing" },
];

const CONTACT = "contactinformation";
const COMPANY = "companyinformation";
const DEAL = "dealinformation";

const CONTACT_PROPERTIES = [
  def("email", "Email", "string", "text", CONTACT, { unique: true, description: "A contact's email address" }),
  def("firstname", "First Name", "string", "text", CONTACT),
  def("lastname", "Last Name", "string", "text", CONTACT),
  def("phone", "Phone Number", "string", "phonenumber", CONTACT),
  def("mobilephone", "Mobile Phone Number", "string", "phonenumber", CONTACT),
  def("company", "Company Name", "string", "text", CONTACT),
  def("jobtitle", "Job Title", "string", "text", CONTACT),
  def("website", "Website URL", "string", "text", CONTACT),
  def("city", "City", "string", "text", CONTACT),
  def("state", "State/Region", "string", "text", CONTACT),
  def("country", "Country/Region", "string", "text", CONTACT),
  def("lifecyclestage", "Lifecycle Stage", "enumeration", "radio", CONTACT, { options: LIFECYCLE_STAGES }),
  def("hs_lead_status", "Lead Status", "enumeration", "radio", CONTACT, { options: LEAD_STATUSES }),
  def("hubspot_owner_id", "Contact owner", "enumeration", "select", CONTACT, { description: "The owner of the contact" }),
  def("hubspot_owner_assigneddate", "Owner Assigned Date", "datetime", "date", CONTACT, { readOnly: true, calculated: true }),
  def("hs_object_id", "Record ID", "number", "number", CONTACT, { readOnly: true, calculated: true }),
  def("createdate", "Create Date", "datetime", "date", CONTACT, { readOnly: true }),
  def("lastmodifieddate", "Last Modified Date", "datetime", "date", CONTACT, { readOnly: true, calculated: true }),
];

const COMPANY_PROPERTIES = [
  def("name", "Name", "string", "text", COMPANY),
  def("domain", "Company Domain Name", "string", "text", COMPANY),
  def("industry", "Industry", "string", "text", COMPANY),
  def("description", "Description", "string", "textarea", COMPANY),
  def("phone", "Phone Number", "string", "phonenumber", COMPANY),
  def("website", "Website URL", "string", "text", COMPANY),
  def("city", "City", "string", "text", COMPANY),
  def("state", "State/Region", "string", "text", COMPANY),
  def("country", "Country/Region", "string", "text", COMPANY),
  def("numberofemployees", "Number of Employees", "number", "number", COMPANY),
  def("annualrevenue", "Annual Revenue", "number", "number", COMPANY),
  def("lifecyclestage", "Lifecycle Stage", "enumeration", "radio", COMPANY, { options: LIFECYCLE_STAGES }),
  def("type", "Type", "enumeration", "select", COMPANY, {
    options: [
      { value: "PROSPECT", label: "Prospect" },
      { value: "PARTNER", label: "Partner" },
      { value: "RESELLER", label: "Reseller" },
      { value: "VENDOR", label: "Vendor" },
      { value: "OTHER", label: "Other" },
    ],
  }),
  def("hubspot_owner_id", "Company owner", "enumeration", "select", COMPANY),
  def("hs_object_id", "Record ID", "number", "number", COMPANY, { readOnly: true, calculated: true }),
  def("createdate", "Create Date", "datetime", "date", COMPANY, { readOnly: true }),
  def("hs_lastmodifieddate", "Last Modified Date", "datetime", "date", COMPANY, { readOnly: true, calculated: true }),
];

const DEAL_PROPERTIES = [
  def("dealname", "Deal Name", "string", "text", DEAL),
  def("amount", "Amount", "number", "number", DEAL),
  def("dealstage", "Deal Stage", "enumeration", "radio", DEAL),
  def("pipeline", "Pipeline", "enumeration", "radio", DEAL),
  def("closedate", "Close Date", "datetime", "date", DEAL),
  def("dealtype", "Deal Type", "enumeration", "radio", DEAL, {
    options: [
      { value: "newbusiness", label: "New Business" },
      { value: "existingbusiness", label: "Existing Business" },
    ],
  }),
  def("description", "Deal Description", "string", "textarea", DEAL),
  def("hubspot_owner_id", "Deal owner", "enumeration", "select", DEAL),
  def("hs_object_id", "Record ID", "number", "number", DEAL, { readOnly: true, calculated: true }),
  def("createdate", "Create Date", "datetime", "date", DEAL, { readOnly: true }),
  def("hs_lastmodifieddate", "Last Modified Date", "datetime", "date", DEAL, { readOnly: true, calculated: true }),
  def("hs_is_closed", "Is Deal Closed?", "bool", "booleancheckbox", DEAL, { readOnly: true, calculated: true }),
  def("hs_is_closed_won", "Is Closed Won", "bool", "booleancheckbox", DEAL, { readOnly: true, calculated: true }),
  def("hs_deal_stage_probability", "Deal probability", "number", "number", DEAL, { readOnly: true, calculated: true }),
];

const NOTE_PROPERTIES = [
  def("hs_note_body", "Note body", "string", "html", "note"),
  def("hs_timestamp", "Activity date", "datetime", "date", "note"),
  def("hubspot_owner_id", "Activity assigned to", "enumeration", "select", "note"),
  def("hs_attachment_ids", "Attached file IDs", "enumeration", "checkbox", "note"),
  def("hs_object_id", "Record ID", "number", "number", "note", { readOnly: true, calculated: true }),
  def("hs_createdate", "Create date", "datetime", "date", "note", { readOnly: true }),
  def("hs_lastmodifieddate", "Last modified date", "datetime", "date", "note", { readOnly: true, calculated: true }),
];

const TASK_PROPERTIES = [
  def("hs_task_subject", "Task Title", "string", "text", "task"),
  def("hs_task_body", "Notes", "string", "html", "task"),
  def("hs_task_status", "Task Status", "enumeration", "select", "task", {
    options: [
      { value: "NOT_STARTED", label: "Not started" },
      { value: "IN_PROGRESS", label: "In progress" },
      { value: "WAITING", label: "Waiting on contact" },
      { value: "COMPLETED", label: "Completed" },
      { value: "DEFERRED", label: "Deferred" },
    ],
  }),
  def("hs_task_priority", "Priority", "enumeration", "select", "task", {
    options: [
      { value: "LOW", label: "Low" },
      { value: "MEDIUM", label: "Medium" },
      { value: "HIGH", label: "High" },
    ],
  }),
  def("hs_task_type", "Task Type", "enumeration", "select", "task", {
    options: [
      { value: "TODO", label: "To-do" },
      { value: "EMAIL", label: "Email" },
      { value: "CALL", label: "Call" },
    ],
  }),
  def("hs_timestamp", "Due date", "datetime", "date", "task"),
  def("hubspot_owner_id", "Assigned to", "enumeration", "select", "task"),
  def("hs_object_id", "Record ID", "number", "number", "task", { readOnly: true, calculated: true }),
  def("hs_createdate", "Create date", "datetime", "date", "task", { readOnly: true }),
  def("hs_lastmodifieddate", "Last modified date", "datetime", "date", "task", { readOnly: true, calculated: true }),
];

function indexed(list) {
  const map = new Map();
  list.forEach((definition, index) => map.set(definition.name, Object.freeze({ ...definition, displayOrder: index })));
  return map;
}

/** HubSpot-defined property definitions per object type (`Map<name, definition>`). */
export const DEFINED_PROPERTIES = Object.freeze({
  contacts: indexed(CONTACT_PROPERTIES),
  companies: indexed(COMPANY_PROPERTIES),
  deals: indexed(DEAL_PROPERTIES),
  notes: indexed(NOTE_PROPERTIES),
  tasks: indexed(TASK_PROPERTIES),
});

/** Properties returned when a request names none. */
export const DEFAULT_PROPERTIES = Object.freeze({
  contacts: ["createdate", "email", "firstname", "hs_object_id", "lastmodifieddate", "lastname"],
  companies: ["createdate", "domain", "hs_lastmodifieddate", "hs_object_id", "name"],
  deals: ["amount", "closedate", "createdate", "dealname", "dealstage", "hs_lastmodifieddate", "hs_object_id", "pipeline"],
  notes: ["hs_createdate", "hs_lastmodifieddate", "hs_object_id"],
  tasks: ["hs_createdate", "hs_lastmodifieddate", "hs_object_id"],
});

/** Properties matched by the free-text `query` of a search. */
export const SEARCHABLE_PROPERTIES = Object.freeze({
  contacts: ["firstname", "lastname", "email", "phone", "company", "hs_object_id"],
  companies: ["name", "domain", "website", "phone"],
  deals: ["dealname"],
  notes: ["hs_note_body"],
  tasks: ["hs_task_subject", "hs_task_body"],
});

/** Timestamp property names per object type. */
export const TIMESTAMPS = Object.freeze({
  contacts: { created: "createdate", modified: "lastmodifieddate" },
  companies: { created: "createdate", modified: "hs_lastmodifieddate" },
  deals: { created: "createdate", modified: "hs_lastmodifieddate" },
  notes: { created: "hs_createdate", modified: "hs_lastmodifieddate" },
  tasks: { created: "hs_createdate", modified: "hs_lastmodifieddate" },
});

/** Properties a create must carry. */
export const REQUIRED_ON_CREATE = Object.freeze({
  contacts: [],
  companies: [],
  deals: ["dealstage"],
  notes: ["hs_timestamp"],
  tasks: ["hs_timestamp"],
});

// Unambiguous (no nested or adjacent overlapping quantifiers), so a long non-numeric digit run fails in linear time.
const NUMBER = /^-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][-+]?[0-9]+)?$/;

/** HubSpot's maximum length of a single property value (characters); longer values fail with INVALID_LENGTH. */
export const MAX_PROPERTY_VALUE = 65_536;

/**
 * Coerce one incoming property value to its stored string form. Returns `{ value }` or `{ error }`
 * (the error names HubSpot's validation reason). `null` always clears the property.
 */
export function coerceValue(definition, raw) {
  if (raw === null) return { value: null };
  if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") {
    return { error: `Property "${definition.name}" must be a string, number, boolean or null`, code: "INVALID_TYPE" };
  }
  const text = String(raw);
  if (text.length > MAX_PROPERTY_VALUE) {
    return { error: `Property "${definition.name}" value has ${text.length} characters, above the maximum of ${MAX_PROPERTY_VALUE}`, code: "INVALID_LENGTH" };
  }
  switch (definition.type) {
    case "number": {
      if (!NUMBER.test(text.trim()) || !Number.isFinite(Number(text))) {
        return { error: `${clip(JSON.stringify(text))} was not a valid number for property "${definition.name}"`, code: "INVALID_NUMBER" };
      }
      return { value: text.trim() };
    }
    case "datetime":
    case "date": {
      const iso = normalizeDateTime(text.trim());
      if (iso === undefined) {
        return { error: `${clip(JSON.stringify(text))} was not a valid date or datetime for property "${definition.name}"`, code: "INVALID_DATE" };
      }
      return { value: iso };
    }
    case "bool": {
      const lowered = text.trim().toLowerCase();
      if (lowered !== "true" && lowered !== "false") {
        return { error: `${clip(JSON.stringify(text))} was not a valid boolean for property "${definition.name}"`, code: "INVALID_OPTION" };
      }
      return { value: lowered };
    }
    case "enumeration": {
      if (definition.options.length > 0 && !definition.options.some((entry) => entry.value === text)) {
        return { error: `${clip(JSON.stringify(text))} was not one of the allowed options for property "${definition.name}"`, code: "INVALID_OPTION" };
      }
      return { value: text };
    }
    default:
      return { value: text };
  }
}
