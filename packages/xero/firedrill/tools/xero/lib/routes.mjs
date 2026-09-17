// Route codec table: one entry per manifest http route id.
import { args, bodyArgs, boolParam, clip, encodeEmpty, encodeEnvelope, listCommon, listParam, paged, param, tenant, unitdp, withKey } from "./wire.mjs";

const pathValue = (request, name, max = 256) => clip(Object.hasOwn(request.path, name) ? request.path[name] : "", max);

const read = (build) => ({ decode: (request) => ({ arguments: args(build(request)) }), encode: encodeEnvelope });

const write = (build) => ({ decode: (request) => withKey(request, args(build(request))), encode: encodeEnvelope });

const save = (method, pathName, argName, extra = () => []) =>
  write((request) => [
    ["tenantId", tenant(request)],
    ["method", method],
    ...(pathName === null ? [] : [[argName, pathValue(request, pathName, 64)]]),
    ...Object.entries(bodyArgs(request)),
    ["summarizeErrors", boolParam(request, "summarizeErrors")],
    ...extra(request),
  ]);

const withUnitdp = (request) => [["unitdp", unitdp(request)]];

export const routes = {
  "organisation-get": read((request) => [["tenantId", tenant(request)]]),
  "accounts-list": read((request) => listCommon(request)),
  "account-get": read((request) => [["tenantId", tenant(request)], ["accountId", pathValue(request, "AccountID")]]),
  "tax-rates-list": read((request) => [...listCommon(request), ["taxType", clip(param(request, "TaxType"), 50)]]),
  "contacts-list": read((request) => [
    ...listCommon(request),
    ...paged(request),
    ["ids", listParam(request, "IDs", 64)],
    ["searchTerm", clip(param(request, "searchTerm"), 256)],
    ["includeArchived", boolParam(request, "includeArchived")],
    ["summaryOnly", boolParam(request, "summaryOnly")],
  ]),
  "contact-get": read((request) => [["tenantId", tenant(request)], ["contactId", pathValue(request, "ContactID")]]),
  "contacts-put": save("PUT", null),
  "contacts-post": save("POST", null),
  "contact-post": save("POST", "ContactID", "pathContactId"),
  "invoices-list": read((request) => [
    ...listCommon(request),
    ...paged(request),
    ["ids", listParam(request, "IDs", 64)],
    ["invoiceNumbers", listParam(request, "InvoiceNumbers", 256)],
    ["contactIds", listParam(request, "ContactIDs", 64)],
    ["statuses", listParam(request, "Statuses", 32)],
    ["searchTerm", clip(param(request, "searchTerm"), 256)],
    ["summaryOnly", boolParam(request, "summaryOnly")],
    ["includeArchived", boolParam(request, "includeArchived")],
    ["createdByMyApp", boolParam(request, "createdByMyApp")],
    ...withUnitdp(request),
  ]),
  "invoice-get": read((request) => [["tenantId", tenant(request)], ["invoiceId", pathValue(request, "InvoiceID")], ...withUnitdp(request)]),
  "invoices-put": save("PUT", null, null, withUnitdp),
  "invoices-post": save("POST", null, null, withUnitdp),
  "invoice-post": save("POST", "InvoiceID", "pathInvoiceId", withUnitdp),
  "invoice-email": {
    decode: (request) => withKey(request, args([["tenantId", tenant(request)], ["invoiceId", pathValue(request, "InvoiceID", 64)]])),
    encode: encodeEmpty,
  },
  "payments-list": read((request) => [...listCommon(request), ...paged(request)]),
  "payment-get": read((request) => [["tenantId", tenant(request)], ["paymentId", pathValue(request, "PaymentID", 64)]]),
  "payments-put": save("PUT", null),
  "payments-post": save("POST", null),
  "payment-post": write((request) => [["tenantId", tenant(request)], ["paymentId", pathValue(request, "PaymentID", 64)], ...Object.entries(bodyArgs(request))]),
};
