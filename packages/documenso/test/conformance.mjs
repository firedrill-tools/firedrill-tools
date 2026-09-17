// Documenso Tool conformance target: a scripted Tool test, not a model-driven agent. Node built-ins only.
// Calls the Documenso API v2-shaped routes (raw API key in Authorization) at FIREDRILL_HTTP_URL, and the canonical
// operation endpoint for the operations without a provider route. Each drill instruction names one flow
// ("Run the <flow> flow ..."); every flow throws on any unexpected status, header or body.
import assert from "node:assert/strict";
import { FLOWS as DOCUMENTS } from "./flows/documents.mjs";
import { FLOWS as FAULTS } from "./flows/faults.mjs";
import { FLOWS as RECIPIENTS } from "./flows/recipients.mjs";
import { FLOWS as ROLES } from "./flows/roles.mjs";
import { FLOWS as SIGNING } from "./flows/signing.mjs";

let task = "";
for await (const chunk of process.stdin) task += chunk;
const instruction = String(JSON.parse(task).instruction ?? "");
const flow = /Run the ([a-z-]+) flow/.exec(instruction)?.[1];
const FLOWS = { ...DOCUMENTS, ...RECIPIENTS, ...SIGNING, ...ROLES, ...FAULTS };
assert.ok(flow !== undefined && Object.hasOwn(FLOWS, flow), `unknown flow in instruction: ${instruction}`);
await FLOWS[flow]();
console.log(JSON.stringify({ flow, status: "passed" }));
