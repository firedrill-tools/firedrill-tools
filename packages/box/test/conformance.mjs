// Box Tool conformance target: a scripted Tool test, not a model-driven agent. Node built-ins only.
// Calls the Box Content API 2.0-shaped routes (Bearer token) at FIREDRILL_HTTP_URL. Each drill instruction names one
// flow ("Run the <flow> flow ..."); every flow throws on any unexpected status, header or body.
import assert from "node:assert/strict";
import { FLOWS as BROWSE } from "./flows/browse.mjs";
import { FLOWS as IDENTITY } from "./flows/identity.mjs";
import { FLOWS as ROLES } from "./flows/roles.mjs";
import { FLOWS as WRITE } from "./flows/write.mjs";

let task = "";
for await (const chunk of process.stdin) task += chunk;
const instruction = String(JSON.parse(task).instruction ?? "");
const flow = /Run the ([a-z-]+) flow/.exec(instruction)?.[1];
const FLOWS = { ...BROWSE, ...WRITE, ...ROLES, ...IDENTITY };
assert.ok(flow !== undefined && Object.hasOwn(FLOWS, flow), `unknown flow in instruction: ${instruction}`);
await FLOWS[flow]();
console.log(JSON.stringify({ flow, status: "passed" }));
