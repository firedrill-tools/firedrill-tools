// Xero Tool conformance target. A scripted Tool test, not a model-driven agent. Node built-ins only: fetch against the
// Xero-shaped /api.xro/2.0 routes and the canonical operation endpoint, and raw MCP JSON-RPC for the tool-name aliases.
import { contacts, settingsReads } from "./flows-a.mjs";
import { invoices, payments } from "./flows-b.mjs";
import { contactsOnly, fresh, noGrants, noScopes, otherTenant, paymentResponseLost, rateLimited, readOnly, tightLimits, writeOutage } from "./flows-c.mjs";
import { rpc } from "./lib.mjs";

let task = "";
for await (const chunk of process.stdin) task += chunk;
const instruction = String(JSON.parse(task).instruction ?? "");

const flows = {
  "settings-reads": settingsReads,
  contacts,
  invoices,
  payments,
  "no-scopes": noScopes,
  "other-tenant": otherTenant,
  "read-only": readOnly,
  "contacts-only": contactsOnly,
  fresh,
  "no-grants": noGrants,
  "rate-limited": rateLimited,
  "write-outage": writeOutage,
  "payment-response-lost": paymentResponseLost,
  "tight-limits": tightLimits,
};
const selected = Object.keys(flows).find((name) => instruction.startsWith(`[${name}]`));
if (selected === undefined) throw new Error(`Unknown drill instruction: ${instruction}`);
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "xero-conformance", version: "0.1.0" } });
await flows[selected]();
process.stdout.write(JSON.stringify({ completed: true, flow: selected }));
