// LinkedIn Tool conformance target: a scripted Tool test, not a model-driven agent. Node built-ins only.
// Calls the LinkedIn-shaped routes (Bearer token, LinkedIn-Version header) and canonical operations at FIREDRILL_HTTP_URL.
// Each drill instruction names one flow ("Run the <flow> flow ..."); every flow throws on any unexpected status, header or body.
import assert from "node:assert/strict";
import { FLOWS as COMMENTS } from "./flows/comments.mjs";
import { FLOWS as FAULTS } from "./flows/faults.mjs";
import { FLOWS as IDENTITY } from "./flows/identity.mjs";
import { FLOWS as ORGS } from "./flows/orgs.mjs";
import { FLOWS as POSTS } from "./flows/posts.mjs";
import { FLOWS as REACTIONS } from "./flows/reactions.mjs";
import { FLOWS as WIRE } from "./flows/wire.mjs";

let task = "";
for await (const chunk of process.stdin) task += chunk;
const instruction = String(JSON.parse(task).instruction ?? "");
const flow = /Run the ([a-z-]+) flow/.exec(instruction)?.[1];
const FLOWS = { ...IDENTITY, ...POSTS, ...COMMENTS, ...REACTIONS, ...ORGS, ...WIRE, ...FAULTS };
assert.ok(flow !== undefined && Object.hasOwn(FLOWS, flow), `unknown flow in instruction: ${instruction}`);
await FLOWS[flow]();
console.log(JSON.stringify({ flow, status: "passed" }));
