// organizations.get, organizations.find_by_vanity_name and organization_acls.list.
import { caller, checkWire, requireScope, rolesOn, urnField } from "../lib/auth.mjs";
import { badRequest, fail, invalidValue, missing, notFound } from "../lib/errors.mjs";
import { buildPage, pageArgs } from "../lib/paging.mjs";
import { scanValues } from "../lib/store.mjs";
import { organizationUrn, personUrn } from "../lib/urn.mjs";

const ORG_ID = /^[1-9][0-9]{0,11}$/;
const ROLES = new Set(["ADMINISTRATOR", "DIRECT_SPONSORED_CONTENT_POSTER", "RECRUITING_POSTER", "LEAD_CAPTURE_ADMINISTRATOR",
  "LEAD_GEN_FORMS_MANAGER", "ANALYST", "CURATOR", "CONTENT_ADMINISTRATOR"]);
const STATES = new Set(["APPROVED", "REQUESTED", "REJECTED", "REVOKED"]);

const localized = (org, value) => ({
  localized: { [`${org.localeLanguage}_${org.localeCountry}`]: value }, preferredLocale: { country: org.localeCountry, language: org.localeLanguage },
});
const locations = (org) => org.locations.map((location) => ({
  address: { city: location.city, country: location.country, ...(location.geographicArea === null ? {} : { geographicArea: location.geographicArea }),
    ...(location.postalCode === null ? {} : { postalCode: location.postalCode }) },
  locationType: "OTHER",
}));

function nonAdminFields(org) {
  return {
    id: org.id, name: localized(org, org.name), localizedName: org.name, ...(org.website === null ? {} : { localizedWebsite: org.website }),
    vanityName: org.vanityName, locations: locations(org), primaryOrganizationType: org.primaryOrganizationType,
  };
}

export function getOrganization(input, context) {
  const who = caller(context);
  checkWire(context, input, "GET");
  requireScope(context, who, ["rw_organization_admin"], "GET /organizations");
  const id = input.organizationId;
  if (typeof id !== "string" || !ORG_ID.test(id)) badRequest(context, "Syntax exception in path variables");
  const org = context.state.get("organizations", id);
  if (org === null) notFound(context, `Organization ${id} is inactive`);
  if (!rolesOn(context, id, who.personId).has("ADMINISTRATOR")) {
    fail(context, "ACCESS_DENIED", `Viewer don't have permission to the ADMIN_ONLY VisibilityReduction for urn:li:organization:${id}`);
  }
  return {
    ...nonAdminFields(org), $URN: organizationUrn(id),
    ...(org.description === null ? {} : { localizedDescription: org.description, description: localized(org, org.description) }),
    ...(org.website === null ? {} : { website: localized(org, org.website) }),
    industries: org.industries, staffCountRange: org.staffCountRange, organizationType: org.organizationType,
    ...(org.foundedOn === null ? {} : { foundedOn: org.foundedOn }),
    defaultLocale: { country: org.localeCountry, language: org.localeLanguage }, versionTag: String(org.createdAtMs % 1000000),
    alternativeNames: [], specialties: [], localizedSpecialties: [], groups: [],
  };
}

export function findByVanityName(input, context) {
  const who = caller(context);
  checkWire(context, input, "FINDER");
  requireScope(context, who, ["rw_organization_admin", "r_organization_social"], "GET /organizations");
  const vanity = input.vanityName;
  if (typeof vanity !== "string" || !/^[A-Za-z0-9-]{1,100}$/.test(vanity)) invalidValue(context, "vanityName", vanity);
  const entry = context.state.get("org-vanity", vanity.toLowerCase());
  const org = entry === null ? null : context.state.get("organizations", String(entry.organizationId));
  const elements = org === null ? [] : [nonAdminFields(org)];
  return { paging: { start: 0, count: 10, links: [], total: elements.length }, elements };
}

export function listAcls(input, context) {
  const who = caller(context);
  checkWire(context, input, "FINDER");
  requireScope(context, who, ["rw_organization_admin"], "GET /organizationAcls");
  if (input.q === undefined || input.q === null) missing(context, "q");
  if (input.q !== "roleAssignee" && input.q !== "organization") invalidValue(context, "q", input.q);
  if (input.role !== undefined && input.role !== null && !(typeof input.role === "string" && ROLES.has(input.role))) invalidValue(context, "role", input.role);
  if (input.state !== undefined && input.state !== null && !(typeof input.state === "string" && STATES.has(input.state))) {
    invalidValue(context, "state", input.state);
  }
  const { start, count } = pageArgs(context, input);
  let rows;
  let target = null;
  if (input.q === "organization") {
    target = urnField(context, "organization", input.organization, ["organization"]);
    if (context.state.get("organizations", target.id) === null) notFound(context, `Organization ${target.id} is inactive`);
    if (!rolesOn(context, target.id, who.personId).has("ADMINISTRATOR")) {
      fail(context, "ACCESS_DENIED", `Not enough permissions to access: GET /organizationAcls for ${target.urn}`);
    }
    rows = scanValues(context, "organization-acls", `${target.id}|`);
  } else {
    rows = scanValues(context, "organization-acls").filter((acl) => acl.personId === who.personId);
  }
  rows = rows.filter((acl) => (input.role == null || acl.role === input.role) && (input.state == null || acl.state === input.state));
  const field = target === null ? "organization" : "organizationTarget";
  const render = (acl) => ({ role: acl.role, [field]: organizationUrn(acl.organizationId), roleAssignee: personUrn(acl.personId), state: acl.state });
  return buildPage(context, rows, render, {
    start, count, path: "/rest/organizationAcls",
    query: [["q", input.q], ["organization", target?.urn], ["role", input.role], ["state", input.state]],
  });
}
