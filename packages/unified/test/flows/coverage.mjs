// Drill unified-error-coverage (admin, baseline): every data operation answers 404 (unknown connection), 501 (wrong
// category), 403 (paused CRM connection / permission-less messaging connection) and 400 (malformed connection_id);
// connection operations answer 400 and 404.
import { C, CH, CO, D, K, MSG, NEW, NONE, PL, apiError, assert, del, post } from "../lib.mjs";

/** [operation, method, path builder (connection id -> path), body] for the 24 connection-scoped operations. */
const DATA_CALLS = [
  ["contacts.list", "GET", (c) => `/crm/${c}/contact`],
  ["contacts.get", "GET", (c) => `/crm/${c}/contact/${K.elena}`],
  ["contacts.create", "POST", (c) => `/crm/${c}/contact`, { name: "Probe" }],
  ["contacts.update", "PATCH", (c) => `/crm/${c}/contact/${K.elena}`, { title: "Probe" }],
  ["contacts.remove", "DELETE", (c) => `/crm/${c}/contact/${K.elena}`],
  ["companies.list", "GET", (c) => `/crm/${c}/company`],
  ["companies.get", "GET", (c) => `/crm/${c}/company/${CO.northwind}`],
  ["companies.create", "POST", (c) => `/crm/${c}/company`, { name: "Probe Co" }],
  ["companies.update", "PUT", (c) => `/crm/${c}/company/${CO.northwind}`, { industry: "Probe" }],
  ["companies.remove", "DELETE", (c) => `/crm/${c}/company/${CO.northwind}`],
  ["deals.list", "GET", (c) => `/crm/${c}/deal`],
  ["deals.get", "GET", (c) => `/crm/${c}/deal/${D.q4}`],
  ["deals.create", "POST", (c) => `/crm/${c}/deal`, { name: "Probe deal" }],
  ["deals.update", "PATCH", (c) => `/crm/${c}/deal/${D.q4}`, { description: "Probe" }],
  ["deals.remove", "DELETE", (c) => `/crm/${c}/deal/${D.q4}`],
  ["pipelines.list", "GET", (c) => `/crm/${c}/pipeline`],
  ["pipelines.get", "GET", (c) => `/crm/${c}/pipeline/${PL.sales}`],
  ["channels.list", "GET", (c) => `/messaging/${c}/channel`],
  ["channels.get", "GET", (c) => `/messaging/${c}/channel/${CH.general}`],
  ["messages.list", "GET", (c) => `/messaging/${c}/message`],
  ["messages.get", "GET", (c) => `/messaging/${c}/message/${MSG(1)}`],
  ["messages.create", "POST", (c) => `/messaging/${c}/message`, { message: "probe", channels: [{ id: CH.sales }] }],
  ["messages.update", "PATCH", (c) => `/messaging/${c}/message/${MSG(1)}`, { message: "probe" }],
  ["messages.remove", "DELETE", (c) => `/messaging/${c}/message/${MSG(1)}`],
];

const isCrm = (path) => path.startsWith("/crm/");

export async function errorCoverage() {
  // A messaging connection without any permission: every messaging operation answers 403 on it.
  const bare = (await post("/unified/connection", { integration_type: "teams", categories: ["messaging"], permissions: [] })).json;
  assert.equal(bare.id, NEW(1));
  for (const [, method, pathFor, body] of DATA_CALLS) {
    const options = body === undefined ? {} : { body };
    await apiError(method, pathFor(NONE), 404, "Connection not found", options);
    await apiError(method, pathFor(C.hris), 501, "not supported by this integration", options);
    await apiError(method, pathFor("notahexid"), 400, "Invalid connection_id", options);
    const sample = pathFor(C.main);
    if (isCrm(sample)) await apiError(method, pathFor(C.paused), 403, "paused", options);
    else await apiError(method, pathFor(NEW(1)), 403, "lacks the required permissions", options);
  }
  // Connection operations: malformed ids and unknown ids.
  await apiError("GET", "/unified/connection?limit=0", 400, "limit must be a positive integer");
  await apiError("GET", "/unified/connection/notahexid", 400, "Invalid connection_id");
  await apiError("GET", `/unified/connection/${NONE}`, 404, "Connection not found");
  await apiError("POST", "/unified/connection", 400, "integration_type is required", { body: {} });
  await apiError("POST", "/unified/connection", 400, "Unknown field", { body: { integration_type: "zoho", categories: ["crm"], token: "secret" } });
  await apiError("PATCH", "/unified/connection/notahexid", 400, "Invalid connection_id", { body: { external_xref: "x" } });
  await apiError("PATCH", `/unified/connection/${NONE}`, 404, "Connection not found", { body: { external_xref: "x" } });
  await apiError("PATCH", `/unified/connection/${C.chat}`, 400, "cannot be changed", { body: { integration_type: "zoho" } });
  await apiError("DELETE", "/unified/connection/notahexid", 400, "Invalid connection_id");
  await apiError("DELETE", `/unified/connection/${NONE}`, 404, "Connection not found");
  // Broken connection: 401 from the Tool for a CRM read and a CRM write.
  await apiError("GET", `/crm/${C.broken}/company`, 401, "likely broken");
  await apiError("POST", `/crm/${C.broken}/deal`, 401, "likely broken", { body: { name: "x" } });
  assert.deepEqual((await del(`/unified/connection/${NEW(1)}`)).json, {});
}
