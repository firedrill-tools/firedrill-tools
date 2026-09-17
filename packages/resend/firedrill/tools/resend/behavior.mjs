// Synthetic Resend team for Firedrill. Every operation computes from `context.state`: ids from `meta/counters` plus
// seeded randomness, timestamps from the virtual clock, delivery outcomes from a fixed documented rule (a recipient in
// the reserved `.invalid` TLD bounces). Nothing here sends e-mail, queries DNS or contacts any real service.
import { guardRoutes } from "./lib/json-depth.mjs";
import { contactRef, encodeOutcome, header, isPlainObject, jsonObject, operationInput, pageArguments, pick, query } from "./lib/wire.mjs";
import { contactsAddSegment, contactsCreate, contactsGet, contactsList, contactsListSegments, contactsRemove, contactsRemoveSegment, contactsUpdate } from "./ops/contacts.mjs";
import { domainsCreate, domainsGet, domainsList, domainsRemove, domainsVerify } from "./ops/domains.mjs";
import { emailsCancel, emailsGet, emailsList, emailsSend, emailsSendBatch, emailsUpdate } from "./ops/emails.mjs";
import { apiKeysCreate, apiKeysList, apiKeysRemove, segmentsCreate, segmentsList, segmentsRemove, workspaceContext } from "./ops/keys-segments.mjs";

const operations = {
  "emails.send": emailsSend,
  "emails.send_batch": emailsSendBatch,
  "emails.list": emailsList,
  "emails.get": emailsGet,
  "emails.update": emailsUpdate,
  "emails.cancel": emailsCancel,
  "domains.create": domainsCreate,
  "domains.list": domainsList,
  "domains.get": domainsGet,
  "domains.verify": domainsVerify,
  "domains.remove": domainsRemove,
  "api_keys.create": apiKeysCreate,
  "api_keys.list": apiKeysList,
  "api_keys.remove": apiKeysRemove,
  "segments.create": segmentsCreate,
  "segments.list": segmentsList,
  "segments.remove": segmentsRemove,
  "contacts.create": contactsCreate,
  "contacts.list": contactsList,
  "contacts.get": contactsGet,
  "contacts.update": contactsUpdate,
  "contacts.remove": contactsRemove,
  "contacts.add_segment": contactsAddSegment,
  "contacts.remove_segment": contactsRemoveSegment,
  "contacts.list_segments": contactsListSegments,
  "workspace.context": workspaceContext,
};

const SEND_FIELDS = [
  ["from", "from"], ["to", "to"], ["subject", "subject"], ["html", "html"], ["text", "text"], ["cc", "cc"], ["bcc", "bcc"],
  ["reply_to", "replyTo"], ["scheduled_at", "scheduledAt"], ["headers", "headers"], ["tags", "tags"],
  ["attachments", "attachments"], ["template", "template"], ["topic_id", "topicId"],
];
const DOMAIN_FIELDS = [
  ["name", "name"], ["region", "region"], ["custom_return_path", "customReturnPath"], ["open_tracking", "openTracking"],
  ["click_tracking", "clickTracking"], ["tls", "tls"], ["capabilities", "capabilities"], ["tracking_subdomain", "trackingSubdomain"],
];
const CONTACT_FIELDS = [["first_name", "firstName"], ["last_name", "lastName"], ["unsubscribed", "unsubscribed"], ["properties", "properties"]];

function route(decode) {
  return { decode, encode: encodeOutcome };
}

const byPath = (name, argument = "id") => (request) => ({ arguments: { [argument]: request.path[name] } });
const writeByPath = (name) => (request) => operationInput(request, { id: request.path[name] });
const listOnly = (request) => ({ arguments: pageArguments(request) });

function batchDecode(request) {
  const args = {};
  if (request.body.kind === "json" && Array.isArray(request.body.value)) {
    args.emails = request.body.value.map((entry) => (isPlainObject(entry) ? pick(entry, SEND_FIELDS) : entry));
  }
  const mode = header(request, "x-batch-validation");
  if (mode !== undefined && mode !== "strict") args.batchValidation = mode.length > 0 ? mode : "(empty)";
  return operationInput(request, args);
}

function contactCreateDecode(request) {
  const body = jsonObject(request);
  const args = pick(body, [["email", "email"], ...CONTACT_FIELDS, ["topics", "topics"], ["audience_id", "audienceId"]]);
  if (Object.hasOwn(body, "segments")) {
    const segments = body.segments;
    args.segmentIds = Array.isArray(segments)
      ? segments.map((entry) => (isPlainObject(entry) && typeof entry.id === "string" ? entry.id : typeof entry === "string" ? entry : ""))
      : [""];
  }
  return operationInput(request, args);
}

const http = {
  "send-email": route((request) => operationInput(request, pick(jsonObject(request), SEND_FIELDS))),
  "send-batch": route(batchDecode),
  "list-emails": route(listOnly),
  "get-email": route(byPath("email_id")),
  "update-email": route((request) => operationInput(request, pick(jsonObject(request), [["scheduled_at", "scheduledAt"]], { id: request.path.email_id }))),
  "cancel-email": route(writeByPath("email_id")),
  "create-domain": route((request) => operationInput(request, pick(jsonObject(request), DOMAIN_FIELDS))),
  "list-domains": route(listOnly),
  "get-domain": route(byPath("domain_id")),
  "verify-domain": route(writeByPath("domain_id")),
  "remove-domain": route(writeByPath("domain_id")),
  "create-api-key": route((request) => operationInput(request, pick(jsonObject(request), [["name", "name"], ["permission", "permission"], ["domain_id", "domainId"]]))),
  "list-api-keys": route(listOnly),
  "remove-api-key": route(writeByPath("api_key_id")),
  "create-segment": route((request) => operationInput(request, pick(jsonObject(request), [["name", "name"], ["filter", "filter"], ["audience_id", "audienceId"]]))),
  "list-segments": route(listOnly),
  "remove-segment": route(writeByPath("id")),
  "create-contact": route(contactCreateDecode),
  "list-contacts": route((request) => {
    const args = pageArguments(request);
    const segment = query(request, "segment_id");
    if (segment !== undefined) args.segmentId = segment;
    return { arguments: args };
  }),
  "get-contact": route((request) => ({ arguments: contactRef(request.path.id, "id") })),
  "update-contact": route((request) => operationInput(request, pick(jsonObject(request), [...CONTACT_FIELDS, ["email", "newEmail"]], contactRef(request.path.id, "id")))),
  "remove-contact": route((request) => operationInput(request, contactRef(request.path.id, "id"))),
  "list-contact-segments": route((request) => ({ arguments: pageArguments(request, contactRef(request.path.contact_id, "contactId")) })),
  "add-contact-segment": route((request) => operationInput(request, contactRef(request.path.contact_id, "contactId", { segmentId: request.path.segment_id }))),
  "remove-contact-segment": route((request) => operationInput(request, contactRef(request.path.contact_id, "contactId", { segmentId: request.path.segment_id }))),
};

export default { operations, http: guardRoutes(http) };
