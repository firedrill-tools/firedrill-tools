// The synthetic org's object model: the standard field catalogue per sObject, picklists, the
// opportunity stage table, key prefixes, relationships and the describe renderers. Pure data and
// pure functions only; custom (`__c`) fields are merged in from the `custom-fields` state rows.

export const DEFAULT_VERSION = "v62.0";
export const MIN_VERSION = 46;
export const MAX_VERSION = 66;

/** Release labels for `GET /services/data` (the API versions this org answers). */
const RELEASES = [
  "Summer '19", "Winter '20", "Spring '20", "Summer '20", "Winter '21", "Spring '21", "Summer '21",
  "Winter '22", "Spring '22", "Summer '22", "Winter '23", "Spring '23", "Summer '23", "Winter '24",
  "Spring '24", "Summer '24", "Winter '25", "Spring '25", "Summer '25", "Winter '26", "Spring '26",
];

export function versionsTable() {
  const rows = [];
  for (let major = MIN_VERSION; major <= MAX_VERSION; major += 1) {
    rows.push({ label: RELEASES[major - MIN_VERSION], url: `/services/data/v${major}.0`, version: `${major}.0` });
  }
  return rows;
}

/** `v62.0` → true when the org serves that API version. */
export function isSupportedVersion(version) {
  if (typeof version !== "string") return false;
  const match = /^v(\d{2})\.0$/.exec(version);
  if (match === null) return false;
  const major = Number(match[1]);
  return major >= MIN_VERSION && major <= MAX_VERSION;
}

export const RECORD_TYPES = ["Account", "Contact", "Lead", "Opportunity", "Task"];
export const READ_ONLY_TYPES = ["User", "Profile"];
export const ALL_TYPES = [...RECORD_TYPES, ...READ_ONLY_TYPES];

export const KEY_PREFIXES = {
  Account: "001",
  Contact: "003",
  Lead: "00Q",
  Opportunity: "006",
  Task: "00T",
  User: "005",
  Profile: "00e",
  Organization: "00D",
};

export const NAMESPACES = {
  Account: "accounts",
  Contact: "contacts",
  Lead: "leads",
  Opportunity: "opportunities",
  Task: "tasks",
  User: "users",
  Profile: "profiles",
};

const LABELS = {
  Account: ["Account", "Accounts"],
  Contact: ["Contact", "Contacts"],
  Lead: ["Lead", "Leads"],
  Opportunity: ["Opportunity", "Opportunities"],
  Task: ["Task", "Tasks"],
  User: ["User", "Users"],
  Profile: ["Profile", "Profiles"],
};

export function typeByPrefix(prefix) {
  for (const [type, value] of Object.entries(KEY_PREFIXES)) if (value === prefix && type !== "Organization") return type;
  return null;
}

/** Case-insensitive sObject name → catalogue spelling, or null. */
export function canonicalType(name) {
  if (typeof name !== "string") return null;
  const lower = name.toLowerCase();
  return ALL_TYPES.find((type) => type.toLowerCase() === lower) ?? null;
}

export const PICKLISTS = {
  AccountType: ["Prospect", "Customer - Direct", "Customer - Channel", "Channel Partner / Reseller", "Installation Partner", "Technology Partner", "Other"],
  Industry: ["Agriculture", "Banking", "Biotechnology", "Consulting", "Education", "Energy", "Finance", "Healthcare", "Manufacturing", "Media", "Retail", "Technology", "Telecommunications", "Other"],
  Salutation: ["Mr.", "Ms.", "Mrs.", "Dr.", "Prof."],
  LeadSource: ["Web", "Phone Inquiry", "Partner Referral", "Purchased List", "Other"],
  LeadStatus: ["Open - Not Contacted", "Working - Contacted", "Closed - Not Converted", "Closed - Converted"],
  Rating: ["Hot", "Warm", "Cold"],
  OpportunityType: ["Existing Customer - Upgrade", "Existing Customer - Replacement", "Existing Customer - Downgrade", "New Customer"],
  TaskStatus: ["Not Started", "In Progress", "Completed", "Waiting on someone else", "Deferred"],
  TaskPriority: ["High", "Normal", "Low"],
};

/** StageName → default probability, forecast category, closed and won flags. */
export const STAGES = [
  { name: "Prospecting", probability: 10, forecastCategory: "Pipeline", closed: false, won: false },
  { name: "Qualification", probability: 10, forecastCategory: "Pipeline", closed: false, won: false },
  { name: "Needs Analysis", probability: 20, forecastCategory: "Pipeline", closed: false, won: false },
  { name: "Value Proposition", probability: 30, forecastCategory: "Pipeline", closed: false, won: false },
  { name: "Id. Decision Makers", probability: 60, forecastCategory: "Pipeline", closed: false, won: false },
  { name: "Perception Analysis", probability: 70, forecastCategory: "Pipeline", closed: false, won: false },
  { name: "Proposal/Price Quote", probability: 75, forecastCategory: "BestCase", closed: false, won: false },
  { name: "Negotiation/Review", probability: 90, forecastCategory: "Commit", closed: false, won: false },
  { name: "Closed Won", probability: 100, forecastCategory: "Closed", closed: true, won: true },
  { name: "Closed Lost", probability: 0, forecastCategory: "Omitted", closed: true, won: false },
];

export const FORECAST_LABELS = { Pipeline: "Pipeline", BestCase: "Best Case", Commit: "Commit", Closed: "Closed", Omitted: "Omitted" };

export function stageByName(name) {
  return STAGES.find((stage) => stage.name === name) ?? null;
}

// ---------------------------------------------------------------------------------------------
// Field catalogue
// ---------------------------------------------------------------------------------------------

function f(name, type, options = {}) {
  return { name, label: options.label ?? labelOf(name), type, length: null, precision: null, scale: null, required: false, readOnly: false, picklist: null, picklistDefault: null, defaultValue: null, referenceTo: null, relationshipName: null, nameField: false, externalId: false, unique: false, custom: false, ...options };
}

function labelOf(name) {
  return name
    .replace(/__c$/, "")
    .replace(/Id$/, (match, offset) => (offset > 0 ? " ID" : match))
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .trim();
}

const text = (name, length = 255, options = {}) => f(name, "string", { length, ...options });
const textarea = (name, length = 32000, options = {}) => f(name, "textarea", { length, ...options });
const picklist = (name, values, options = {}) => f(name, "picklist", { picklist: values, length: 255, ...options });
const reference = (name, referenceTo, relationshipName, options = {}) => f(name, "reference", { referenceTo, relationshipName, length: 18, ...options });
const currency = (name, options = {}) => f(name, "currency", { precision: 18, scale: 2, ...options });
const percent = (name, options = {}) => f(name, "percent", { precision: 3, scale: 0, ...options });
const int = (name, options = {}) => f(name, "int", { precision: 8, ...options });
const bool = (name, options = {}) => f(name, "boolean", { defaultValue: false, ...options });

export const SYSTEM_FIELDS = [
  f("Id", "id", { label: "Record ID", length: 18, readOnly: true }),
  bool("IsDeleted", { label: "Deleted", readOnly: true }),
  f("CreatedDate", "datetime", { readOnly: true }),
  reference("CreatedById", ["User"], "CreatedBy", { readOnly: true }),
  f("LastModifiedDate", "datetime", { readOnly: true }),
  reference("LastModifiedById", ["User"], "LastModifiedBy", { readOnly: true }),
  f("SystemModstamp", "datetime", { label: "System Modstamp", readOnly: true }),
];

const OWNER = reference("OwnerId", ["User"], "Owner", { label: "Owner ID" });

const STANDARD_FIELDS = {
  Account: [
    text("Name", 255, { label: "Account Name", required: true, nameField: true }),
    picklist("Type", PICKLISTS.AccountType, { label: "Account Type" }),
    picklist("Industry", PICKLISTS.Industry),
    f("Website", "url", { length: 255 }),
    f("Phone", "phone", { label: "Account Phone", length: 40 }),
    text("BillingStreet", 255),
    text("BillingCity", 40),
    text("BillingState", 80, { label: "Billing State/Province" }),
    text("BillingPostalCode", 20, { label: "Billing Zip/Postal Code" }),
    text("BillingCountry", 80),
    currency("AnnualRevenue"),
    int("NumberOfEmployees", { label: "Employees" }),
    textarea("Description", 32000, { label: "Account Description" }),
    reference("ParentId", ["Account"], "Parent", { label: "Parent Account ID" }),
    OWNER,
  ],
  Contact: [
    text("FirstName", 40),
    text("LastName", 80, { required: true }),
    text("Name", 121, { label: "Full Name", readOnly: true, nameField: true }),
    picklist("Salutation", PICKLISTS.Salutation),
    f("Email", "email", { length: 80 }),
    f("Phone", "phone", { label: "Business Phone", length: 40 }),
    f("MobilePhone", "phone", { length: 40 }),
    text("Title", 128),
    text("Department", 80),
    reference("AccountId", ["Account"], "Account", { label: "Account ID" }),
    text("MailingCity", 40),
    text("MailingCountry", 80),
    picklist("LeadSource", PICKLISTS.LeadSource),
    bool("HasOptedOutOfEmail", { label: "Email Opt Out" }),
    textarea("Description", 32000, { label: "Contact Description" }),
    OWNER,
  ],
  Lead: [
    text("FirstName", 40),
    text("LastName", 80, { required: true }),
    text("Name", 121, { label: "Full Name", readOnly: true, nameField: true }),
    text("Company", 255, { required: true }),
    text("Title", 128),
    f("Email", "email", { length: 80 }),
    f("Phone", "phone", { length: 40 }),
    f("Website", "url", { length: 255 }),
    picklist("Status", PICKLISTS.LeadStatus, { picklistDefault: "Open - Not Contacted", required: true }),
    picklist("LeadSource", PICKLISTS.LeadSource),
    picklist("Industry", PICKLISTS.Industry),
    picklist("Rating", PICKLISTS.Rating),
    int("NumberOfEmployees", { label: "Employees" }),
    text("City", 40),
    text("Country", 80),
    textarea("Description", 32000),
    bool("IsConverted", { label: "Converted", readOnly: true }),
    f("ConvertedDate", "date", { readOnly: true }),
    reference("ConvertedAccountId", ["Account"], "ConvertedAccount", { readOnly: true }),
    reference("ConvertedContactId", ["Contact"], "ConvertedContact", { readOnly: true }),
    reference("ConvertedOpportunityId", ["Opportunity"], "ConvertedOpportunity", { readOnly: true }),
    OWNER,
  ],
  Opportunity: [
    text("Name", 120, { required: true, nameField: true }),
    reference("AccountId", ["Account"], "Account", { label: "Account ID" }),
    picklist("StageName", STAGES.map((stage) => stage.name), { label: "Stage", required: true }),
    currency("Amount"),
    f("CloseDate", "date", { required: true }),
    percent("Probability", { label: "Probability (%)" }),
    picklist("Type", PICKLISTS.OpportunityType, { label: "Opportunity Type" }),
    picklist("LeadSource", PICKLISTS.LeadSource),
    text("NextStep", 255),
    textarea("Description", 32000),
    bool("IsClosed", { label: "Closed", readOnly: true }),
    bool("IsWon", { label: "Won", readOnly: true }),
    picklist("ForecastCategory", Object.keys(FORECAST_LABELS), { readOnly: true }),
    picklist("ForecastCategoryName", Object.values(FORECAST_LABELS), { label: "Forecast Category", readOnly: true }),
    OWNER,
  ],
  Task: [
    text("Subject", 255, { nameField: true }),
    picklist("Status", PICKLISTS.TaskStatus, { picklistDefault: "Not Started", required: true }),
    picklist("Priority", PICKLISTS.TaskPriority, { picklistDefault: "Normal", required: true }),
    f("ActivityDate", "date", { label: "Due Date Only" }),
    textarea("Description", 32000, { label: "Comments" }),
    reference("WhoId", ["Contact", "Lead"], "Who", { label: "Name ID" }),
    reference("WhatId", ["Account", "Opportunity"], "What", { label: "Related To ID" }),
    bool("IsClosed", { label: "Closed", readOnly: true }),
    OWNER,
  ],
  User: [
    text("Username", 80, { required: true }),
    f("Email", "email", { length: 128, required: true }),
    text("FirstName", 40),
    text("LastName", 80, { required: true }),
    text("Name", 121, { label: "Full Name", readOnly: true, nameField: true }),
    text("Alias", 8, { required: true }),
    text("Title", 80),
    bool("IsActive", { label: "Active" }),
    reference("ProfileId", ["Profile"], "Profile", { required: true }),
    picklist("UserType", ["Standard"]),
    text("TimeZoneSidKey", 40, { label: "Time Zone", required: true }),
    text("LocaleSidKey", 40, { label: "Locale", required: true }),
    text("LanguageLocaleKey", 40, { label: "Language", required: true }),
    text("EmailEncodingKey", 40, { label: "Email Encoding", required: true }),
  ],
  Profile: [
    text("Name", 255, { required: true, nameField: true }),
    text("UserLicense", 80, { label: "User License" }),
  ],
};

/** Child relationships reachable as SOQL subqueries (`(SELECT … FROM Contacts)`). */
export const CHILD_RELATIONSHIPS = {
  Account: [
    { relationshipName: "Contacts", childSObject: "Contact", field: "AccountId", cascadeDelete: true },
    { relationshipName: "Opportunities", childSObject: "Opportunity", field: "AccountId", cascadeDelete: true },
    { relationshipName: "Tasks", childSObject: "Task", field: "WhatId", cascadeDelete: true },
  ],
  Contact: [{ relationshipName: "Tasks", childSObject: "Task", field: "WhoId", cascadeDelete: true }],
  Lead: [{ relationshipName: "Tasks", childSObject: "Task", field: "WhoId", cascadeDelete: true }],
  Opportunity: [{ relationshipName: "Tasks", childSObject: "Task", field: "WhatId", cascadeDelete: true }],
  Task: [],
  User: [],
  Profile: [],
};

export function isRecordType(type) {
  return RECORD_TYPES.includes(type);
}

/** A custom-field row (from `custom-fields/<type>`) → catalogue field. Rows not ending in `__c` are ignored. */
function customField(row) {
  const kinds = { text: "string", textarea: "textarea", number: "double", currency: "currency", percent: "percent", checkbox: "boolean", date: "date", datetime: "datetime", email: "email", url: "url", phone: "phone", picklist: "picklist" };
  const type = kinds[row.type] ?? "string";
  return f(row.name, type, {
    label: row.label,
    length: row.length ?? (type === "string" || type === "textarea" || type === "email" || type === "url" || type === "phone" || type === "picklist" ? 255 : null),
    precision: row.precision ?? null,
    scale: row.scale ?? null,
    required: row.required === true,
    picklist: type === "picklist" ? (row.picklistValues ?? []).map((entry) => entry.value) : null,
    picklistDefault: type === "picklist" ? ((row.picklistValues ?? []).find((entry) => entry.default === true)?.value ?? null) : null,
    defaultValue: row.defaultValue ?? (type === "boolean" ? false : null),
    externalId: row.externalId === true,
    unique: row.unique === true,
    custom: true,
  });
}

/**
 * Full ordered field list of one sObject in Salesforce's rendering order: `Id`, `IsDeleted`, the
 * standard fields, the custom rows, then the audit fields. User and Profile carry no `IsDeleted`,
 * `CreatedById` or `LastModifiedById`.
 */
export function catalogue(type, customRows) {
  const standard = STANDARD_FIELDS[type] ?? [];
  const custom = (customRows ?? []).filter((row) => typeof row.name === "string" && row.name.endsWith("__c")).map(customField);
  const [id, deleted, createdDate, createdBy, modifiedDate, modifiedBy, modstamp] = SYSTEM_FIELDS;
  return isRecordType(type)
    ? [id, deleted, ...standard, ...custom, createdDate, createdBy, modifiedDate, modifiedBy, modstamp]
    : [id, ...standard, createdDate, modifiedDate, modstamp];
}

/** Names of the audit/system fields a caller may never write. */
export const SYSTEM_FIELD_NAMES = SYSTEM_FIELDS.map((field) => field.name);

export function fieldByName(fields, name) {
  if (typeof name !== "string") return null;
  const lower = name.toLowerCase();
  return fields.find((field) => field.name.toLowerCase() === lower) ?? null;
}

/** Relationship name (`Account`, `Owner`, `Who`) → the lookup field, case-insensitively. */
export function relationshipByName(fields, name) {
  if (typeof name !== "string") return null;
  const lower = name.toLowerCase();
  return fields.find((field) => field.relationshipName !== null && field.relationshipName.toLowerCase() === lower) ?? null;
}

export function childRelationship(type, name) {
  if (typeof name !== "string") return null;
  const lower = name.toLowerCase();
  return (CHILD_RELATIONSHIPS[type] ?? []).find((entry) => entry.relationshipName.toLowerCase() === lower) ?? null;
}

export function nameFieldOf(type) {
  return type === "Task" ? "Subject" : "Name";
}

// ---------------------------------------------------------------------------------------------
// Describe rendering
// ---------------------------------------------------------------------------------------------

const SOAP_TYPES = { id: "tns:ID", string: "xsd:string", textarea: "xsd:string", email: "xsd:string", url: "xsd:string", phone: "xsd:string", boolean: "xsd:boolean", int: "xsd:int", double: "xsd:double", currency: "xsd:double", percent: "xsd:double", date: "xsd:date", datetime: "xsd:dateTime", picklist: "xsd:string", reference: "tns:ID" };

export function sobjectSummary(type, version, permissions) {
  const [label, labelPlural] = LABELS[type];
  const record = isRecordType(type);
  const base = `/services/data/${version}/sobjects/${type}`;
  return {
    activateable: false,
    associateEntityType: null,
    associateParentEntity: null,
    createable: record && permissions.create === true,
    custom: false,
    customSetting: false,
    deepCloneable: false,
    deletable: record && permissions.delete === true,
    deprecatedAndHidden: false,
    feedEnabled: record,
    hasSubtypes: false,
    isInterface: false,
    isSubtype: false,
    keyPrefix: KEY_PREFIXES[type],
    label,
    labelPlural,
    layoutable: record,
    mergeable: type === "Account" || type === "Contact" || type === "Lead",
    mruEnabled: record,
    name: type,
    queryable: true,
    replicateable: record,
    retrieveable: true,
    searchable: record || type === "User",
    triggerable: record,
    undeletable: record,
    updateable: record && permissions.edit === true,
    urls: { sobject: base, describe: `${base}/describe`, rowTemplate: `${base}/{ID}` },
  };
}

function describeField(field, type) {
  const writable = !field.readOnly && isRecordType(type);
  return {
    name: field.name,
    label: field.label,
    type: field.type,
    length: field.length ?? 0,
    precision: field.precision ?? 0,
    scale: field.scale ?? 0,
    nillable: !field.required && field.name !== "Id",
    createable: writable,
    updateable: writable,
    custom: field.custom,
    defaultedOnCreate: field.name === "OwnerId" || field.name === "Id" || field.picklistDefault !== null || field.type === "boolean" || field.readOnly,
    externalId: field.externalId,
    unique: field.unique,
    idLookup: field.name === "Id" || field.externalId || field.name === "Username",
    nameField: field.nameField,
    filterable: !(field.type === "textarea" && (field.length ?? 0) > 255),
    sortable: !(field.type === "textarea" && (field.length ?? 0) > 255),
    groupable: field.type !== "textarea" && field.type !== "currency" && field.type !== "double" && field.type !== "percent",
    calculated: false,
    picklistValues: (field.picklist ?? []).map((value) => ({ active: true, defaultValue: value === field.picklistDefault, label: value, value })),
    referenceTo: field.referenceTo ?? [],
    relationshipName: field.relationshipName,
    restrictedPicklist: field.type === "picklist",
    soapType: SOAP_TYPES[field.type] ?? "xsd:string",
  };
}

export function describeSObject(type, version, permissions, fields) {
  const summary = sobjectSummary(type, version, permissions);
  const labelPlural = LABELS[type][1];
  return {
    ...summary,
    fields: fields.map((field) => describeField(field, type)),
    childRelationships: (CHILD_RELATIONSHIPS[type] ?? []).map((entry) => ({
      childSObject: entry.childSObject,
      field: entry.field,
      relationshipName: entry.relationshipName,
      cascadeDelete: entry.cascadeDelete,
      restrictedDelete: false,
    })),
    recordTypeInfos: [{ available: true, defaultRecordTypeMapping: true, master: true, name: "Master", recordTypeId: "012000000000000AAA" }],
    supportedScopes: [
      { label: `All ${labelPlural.toLowerCase()}`, name: "everything" },
      { label: `My ${labelPlural.toLowerCase()}`, name: "mine" },
    ],
  };
}
