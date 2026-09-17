// Google Workspace Tool conformance target: a scripted Tool test, not a model-driven agent. Node built-ins only.
// Calls the People, Workspace Events and Apps Script-shaped routes (Bearer token) at FIREDRILL_HTTP_URL, plus the
// canonical operation endpoint where a specific actor, a denial or a route-less operation must be proven.
// Each drill instruction names one flow ("Run the <flow> flow ..."); every flow throws on any unexpected
// status, header or body.
import assert from "node:assert/strict";
import { FLOWS as CONTACTS } from "./flows/contacts.mjs";
import { FLOWS as EVENTS } from "./flows/events.mjs";
import { FLOWS as FAULTS } from "./flows/faults.mjs";
import { FLOWS as FUZZ } from "./flows/fuzz.mjs";
import { FLOWS as IDENTITY } from "./flows/identity.mjs";
import { FLOWS as SCRIPT } from "./flows/script.mjs";

let task = "";
for await (const chunk of process.stdin) task += chunk;
const instruction = String(JSON.parse(task).instruction ?? "");
const flow = /Run the ([a-z-]+) flow/.exec(instruction)?.[1];
const FLOWS = { ...CONTACTS, ...EVENTS, ...SCRIPT, ...IDENTITY, ...FAULTS, ...FUZZ };
assert.ok(flow !== undefined && Object.hasOwn(FLOWS, flow), `unknown flow in instruction: ${instruction}`);
await FLOWS[flow]();
console.log(JSON.stringify({ flow, status: "passed" }));
