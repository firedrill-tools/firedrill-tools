// CRM object types in scope and their HubSpot object-type ids. Pure constants and lookups only.

export const OBJECT_TYPES = Object.freeze([
  Object.freeze({ name: "contacts", singular: "contact", typeId: "0-1", scope: "contacts", schemaScope: "contacts" }),
  Object.freeze({ name: "companies", singular: "company", typeId: "0-2", scope: "companies", schemaScope: "companies" }),
  Object.freeze({ name: "deals", singular: "deal", typeId: "0-3", scope: "deals", schemaScope: "deals" }),
  Object.freeze({ name: "notes", singular: "note", typeId: "0-46", scope: "contacts", schemaScope: "contacts" }),
  Object.freeze({ name: "tasks", singular: "task", typeId: "0-27", scope: "contacts", schemaScope: "contacts" }),
]);

/** `contacts` | `contact` | `0-1` (case-insensitive) → the type definition, or undefined. */
export function resolveObjectType(value) {
  if (typeof value !== "string") return undefined;
  const needle = value.trim().toLowerCase();
  return OBJECT_TYPES.find((type) => type.name === needle || type.singular === needle || type.typeId === needle);
}

export function objectTypeById(typeId) {
  return OBJECT_TYPES.find((type) => type.typeId === typeId);
}

export function readScope(type) {
  return `crm.objects.${type.scope}.read`;
}

export function writeScope(type) {
  return `crm.objects.${type.scope}.write`;
}

export function schemaReadScope(type) {
  return `crm.schemas.${type.schemaScope}.read`;
}

/** Every scope this Tool knows; an actor without a `scopes` attribute holds all of them. */
export const ALL_SCOPES = Object.freeze([
  "oauth",
  "crm.objects.contacts.read",
  "crm.objects.contacts.write",
  "crm.objects.companies.read",
  "crm.objects.companies.write",
  "crm.objects.deals.read",
  "crm.objects.deals.write",
  "crm.objects.owners.read",
  "crm.schemas.contacts.read",
  "crm.schemas.companies.read",
  "crm.schemas.deals.read",
]);
