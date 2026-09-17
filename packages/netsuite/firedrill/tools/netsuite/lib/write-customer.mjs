// Customer writes: create, merge-patch update and the referential delete.
import { quote } from "./errors.mjs";
import { open } from "./session.mjs";
import { loadRecord } from "./handlers-read.mjs";
import {
  booleanField, checkPropertyNames, checkVersion, idempotencyKey, numberField,
  referenceField, replaceList, requestBody, stringField,
} from "./body.mjs";

const KNOWN = new Set([
  "entityId", "companyName", "isPerson", "firstName", "middleName", "lastName", "email", "phone",
  "altPhone", "subsidiary", "currency", "terms", "creditLimit", "comments", "isInactive", "categoryId",
]);
const REPLACEABLE = new Set(["companyName", "email", "phone", "altPhone", "comments", "creditLimit", "terms", "addressBook"]);
const CURRENCY_FOR = new Map([["1", "1"], ["2", "3"]]);

function readFields(session, input, body) {
  checkPropertyNames(session, input, body, KNOWN);
  return {
    entityId: stringField(session, body, "entityId", 83),
    companyName: stringField(session, body, "companyName", 83),
    isPerson: booleanField(session, body, "isPerson"),
    firstName: stringField(session, body, "firstName", 32),
    middleName: stringField(session, body, "middleName", 32),
    lastName: stringField(session, body, "lastName", 32),
    email: stringField(session, body, "email", 254),
    phone: stringField(session, body, "phone", 22),
    altPhone: stringField(session, body, "altPhone", 22),
    comments: stringField(session, body, "comments", 999),
    creditLimit: numberField(session, body, "creditLimit", { min: 0, max: 1000000000 }),
    isInactive: booleanField(session, body, "isInactive"),
    subsidiaryId: referenceField(session, body, "subsidiary"),
    termsId: referenceField(session, body, "terms"),
  };
}

function resolveSubsidiary(session, subsidiaryId) {
  const id = subsidiaryId ?? session.account.defaultSubsidiaryId;
  if (session.get("subsidiaries", id) === null) {
    session.fail("INVALID_KEY_OR_REF", `Invalid subsidiary reference key ${quote(String(id))}.`, { errorPath: "subsidiary" });
  }
  if (!session.inScope(id)) {
    session.fail("INVALID_KEY_OR_REF", `Subsidiary ${quote(String(id))} is outside the subsidiary restriction of this role.`, {
      errorPath: "subsidiary",
    });
  }
  return id;
}

function checkTerms(session, termsId) {
  if (termsId === undefined || termsId === null) return termsId ?? null;
  if (!["1", "2", "3"].includes(termsId)) {
    session.fail("INVALID_KEY_OR_REF", `Invalid terms reference key ${quote(termsId)}.`, { errorPath: "terms" });
  }
  return termsId;
}

function checkDuplicate(session, entityId, ownId) {
  for (const row of session.rows("customers")) {
    if (row.id !== ownId && row.entityId.toLowerCase() === entityId.toLowerCase()) {
      session.fail("USER_ERROR", `This entity already exists. The name ${quote(entityId)} is already in use by another customer.`, {
        errorPath: "entityId",
      });
    }
  }
}

export const customerWrites = {
  "customer.create": (input, context) => {
    const session = open(context);
    session.permit("LIST_CUSTJOB", "create");
    idempotencyKey(session, input);
    const body = requestBody(session, input);
    const fields = readFields(session, input, body);
    session.rows("customers");
    const subsidiaryId = resolveSubsidiary(session, fields.subsidiaryId);
    const termsId = checkTerms(session, fields.termsId);
    const isPerson = fields.isPerson === true;
    const displayName = isPerson
      ? `${fields.lastName ?? ""}${fields.lastName !== undefined && fields.firstName !== undefined ? ", " : ""}${fields.firstName ?? ""}`.trim()
      : (fields.companyName ?? "").trim();
    if (displayName.length === 0) {
      session.fail("USER_ERROR", "Please enter a value for Company Name, or a first and last name for an individual customer.", {
        errorPath: isPerson ? "lastName" : "companyName",
      });
    }
    const id = session.nextId("nextEntityId", "customers");
    const entityId = (fields.entityId ?? `C${id} ${displayName}`).slice(0, 83);
    checkDuplicate(session, entityId, null);
    const row = {
      id,
      entityId,
      companyName: isPerson ? (fields.companyName ?? null) : displayName,
      isPerson,
      firstName: fields.firstName ?? null,
      lastName: fields.lastName ?? null,
      middleName: fields.middleName ?? null,
      email: fields.email ?? null,
      phone: fields.phone ?? null,
      altPhone: fields.altPhone ?? null,
      subsidiaryId,
      currencyId: CURRENCY_FOR.get(subsidiaryId) ?? "1",
      termsId,
      creditLimit: fields.creditLimit ?? null,
      comments: fields.comments ?? null,
      isInactive: fields.isInactive === true,
      categoryId: null,
      defaultAddress: null,
      addressBook: [],
      dateCreated: session.now,
      createdDate: session.now,
      lastModifiedDate: session.now,
      createdById: session.employee.id,
      lastModifiedById: session.employee.id,
      version: 1,
    };
    session.put("customers", id, row);
    session.recordChanged("customer", id, "CREATE", subsidiaryId);
    return { id, location: `/services/rest/record/v1/customer/${id}` };
  },

  "customer.update": (input, context) => {
    const session = open(context);
    session.permit("LIST_CUSTJOB", "edit");
    idempotencyKey(session, input);
    const body = requestBody(session, input);
    const replace = replaceList(session, input, REPLACEABLE);
    const current = loadRecord(session, "customer", input.recordId);
    checkVersion(session, input, current);
    const fields = readFields(session, input, body);
    session.rows("customers");
    const updated = { ...current };
    for (const name of replace) {
      if (name === "addressBook") {
        updated.addressBook = [];
        updated.defaultAddress = null;
      } else if (name === "terms") updated.termsId = null;
      else updated[name] = null;
    }
    for (const [key, value] of [
      ["companyName", fields.companyName], ["firstName", fields.firstName], ["middleName", fields.middleName],
      ["lastName", fields.lastName], ["email", fields.email], ["phone", fields.phone], ["altPhone", fields.altPhone],
      ["comments", fields.comments], ["creditLimit", fields.creditLimit],
    ]) {
      if (value !== undefined) updated[key] = value;
    }
    if (fields.isInactive !== undefined && fields.isInactive !== null) updated.isInactive = fields.isInactive;
    if (fields.isPerson !== undefined && fields.isPerson !== null) updated.isPerson = fields.isPerson;
    if (fields.termsId !== undefined) updated.termsId = checkTerms(session, fields.termsId);
    if (fields.subsidiaryId !== undefined && fields.subsidiaryId !== null) {
      updated.subsidiaryId = resolveSubsidiary(session, fields.subsidiaryId);
      updated.currencyId = CURRENCY_FOR.get(updated.subsidiaryId) ?? "1";
    }
    if (fields.entityId !== undefined && fields.entityId !== null) updated.entityId = fields.entityId;
    checkDuplicate(session, updated.entityId, current.id);
    updated.lastModifiedDate = session.now;
    updated.lastModifiedById = session.employee.id;
    updated.version = current.version + 1;
    session.put("customers", current.id, updated);
    session.recordChanged("customer", current.id, "UPDATE", updated.subsidiaryId);
    return { id: current.id, location: `/services/rest/record/v1/customer/${current.id}` };
  },

  "customer.delete": (input, context) => {
    const session = open(context);
    session.permit("LIST_CUSTJOB", "full");
    idempotencyKey(session, input);
    const current = loadRecord(session, "customer", input.recordId);
    const referenced = [
      ...session.rows("sales-orders"),
      ...session.rows("invoices"),
      ...session.rows("customer-payments"),
    ].some((row) => row.entityId === current.id);
    if (referenced) {
      session.fail("USER_ERROR", "This record cannot be deleted because it is referenced by one or more transactions.");
    }
    session.remove("customers", current.id);
    session.recordChanged("customer", current.id, "DELETE", current.subsidiaryId);
    return { id: current.id };
  },
};
