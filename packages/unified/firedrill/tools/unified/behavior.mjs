// Synthetic Unified.to workspace for Firedrill: connections, unified CRM (contact, company, deal, pipeline) and
// Messaging (channel, message). Every operation computes from `context.state`; ids come from `meta/counters`,
// timestamps from virtual time. No Unified.to service and no underlying platform is contacted.
import { Q, decoder, encoder } from "./lib/wire.mjs";
import { channels } from "./ops/channels.mjs";
import { connections } from "./ops/connections.mjs";
import { companies, contacts } from "./ops/crm.mjs";
import { deals } from "./ops/deals.mjs";
import { messages } from "./ops/messages.mjs";
import { pipelines } from "./ops/pipelines.mjs";

const LIST = { limit: Q.int, offset: Q.int, updated_gte: Q.str, sort: Q.str, order: Q.str, query: Q.str, fields: Q.list };
const FIELDS = { fields: Q.list };
const CONNECTION = ["connection_id"];
const CONNECTION_ID = ["connection_id", "id"];

const listRoute = (extra) => decoder({ path: CONNECTION, query: { ...LIST, ...extra } });
const getRoute = () => decoder({ path: CONNECTION_ID, query: FIELDS });
const createRoute = () => decoder({ path: CONNECTION, body: "json", idem: true });
const updateRoute = () => decoder({ path: CONNECTION_ID, body: "json", idem: true });
const removeRoute = () => decoder({ path: CONNECTION_ID, idem: true });

/** [operation id, handler, [route id, decoder]...] */
const TABLE = [
  ["connections.list", connections.list, ["list-connections", decoder({ query: { limit: Q.int, offset: Q.int, updated_gte: Q.str, sort: Q.str, order: Q.str, env: Q.str, categories: Q.list, external_xref: Q.str } })]],
  ["connections.get", connections.get, ["get-connection", decoder({ path: ["id"] })]],
  ["connections.create", connections.create, ["create-connection", decoder({ body: "json", idem: true })]],
  ["connections.update", connections.update, ["update-connection-put", decoder({ path: ["id"], body: "json", idem: true })], ["update-connection-patch", decoder({ path: ["id"], body: "json", idem: true })]],
  ["connections.remove", connections.remove, ["remove-connection", decoder({ path: ["id"], idem: true })]],

  ["contacts.list", contacts.list, ["list-crm-contacts", listRoute({ company_id: Q.str, deal_id: Q.str, user_id: Q.str })]],
  ["contacts.get", contacts.get, ["get-crm-contact", getRoute()]],
  ["contacts.create", contacts.create, ["create-crm-contact", createRoute()]],
  ["contacts.update", contacts.update, ["update-crm-contact-put", updateRoute()], ["update-crm-contact-patch", updateRoute()]],
  ["contacts.remove", contacts.remove, ["remove-crm-contact", removeRoute()]],

  ["companies.list", companies.list, ["list-crm-companies", listRoute({ contact_id: Q.str, deal_id: Q.str, user_id: Q.str })]],
  ["companies.get", companies.get, ["get-crm-company", getRoute()]],
  ["companies.create", companies.create, ["create-crm-company", createRoute()]],
  ["companies.update", companies.update, ["update-crm-company-put", updateRoute()], ["update-crm-company-patch", updateRoute()]],
  ["companies.remove", companies.remove, ["remove-crm-company", removeRoute()]],

  ["deals.list", deals.list, ["list-crm-deals", listRoute({ company_id: Q.str, contact_id: Q.str, user_id: Q.str, pipeline_id: Q.str })]],
  ["deals.get", deals.get, ["get-crm-deal", getRoute()]],
  ["deals.create", deals.create, ["create-crm-deal", createRoute()]],
  ["deals.update", deals.update, ["update-crm-deal-put", updateRoute()], ["update-crm-deal-patch", updateRoute()]],
  ["deals.remove", deals.remove, ["remove-crm-deal", removeRoute()]],

  ["pipelines.list", pipelines.list, ["list-crm-pipelines", decoder({ path: CONNECTION, query: { limit: Q.int, offset: Q.int, updated_gte: Q.str, sort: Q.str, order: Q.str, fields: Q.list } })]],
  ["pipelines.get", pipelines.get, ["get-crm-pipeline", getRoute()]],

  ["channels.list", channels.list, ["list-messaging-channels", listRoute({ parent_id: Q.str, type: Q.str })]],
  ["channels.get", channels.get, ["get-messaging-channel", getRoute()]],

  ["messages.list", messages.list, ["list-messaging-messages", listRoute({ channel_id: Q.str, parent_id: Q.str, type: Q.str, start_gte: Q.str, end_lt: Q.str, expand: Q.str, user_id: Q.str, user_mentioned_id: Q.str })]],
  ["messages.get", messages.get, ["get-messaging-message", getRoute()]],
  ["messages.create", messages.create, ["create-messaging-message", createRoute()]],
  ["messages.update", messages.update, ["update-messaging-message-put", updateRoute()], ["update-messaging-message-patch", updateRoute()]],
  ["messages.remove", messages.remove, ["remove-messaging-message", removeRoute()]],
];

const operations = {};
const http = {};
for (const [operationId, handler, ...routes] of TABLE) {
  operations[operationId] = handler;
  for (const [routeId, decode] of routes) http[routeId] = { decode, encode: encoder };
}

export default { operations, http };
