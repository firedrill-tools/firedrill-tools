// Unified.to Tool conformance target: a scripted Tool test, not a model-driven agent. Node built-ins only.
// Reads the drill task from stdin, picks the flow named in the instruction and runs it against the provider-shaped
// REST routes (FIREDRILL_HTTP_URL, bearer FIREDRILL_HTTP_TOKEN) and the MCP endpoint (FIREDRILL_MCP_URL).
import { connections, mcpAliases } from "./flows/connections.mjs";
import { errorCoverage } from "./flows/coverage.mjs";
import { crm } from "./flows/crm.mjs";
import { bounds, largeChannels, manyWorkspaces, rateLimited, writeCommittedLost, writeUnavailable } from "./flows/faults.mjs";
import { denied, fresh, ghost, scoped } from "./flows/identity.mjs";
import { messaging } from "./flows/messaging.mjs";
import { sizeBounds } from "./flows/size.mjs";

let task = "";
for await (const chunk of process.stdin) task += chunk;
const invocation = JSON.parse(task);
const instruction = String(invocation.instruction ?? invocation.task?.instruction ?? "");

const flows = {
  crm,
  messaging,
  connections,
  mcp: mcpAliases,
  scoped,
  ghost,
  denied,
  fresh,
  "error-coverage": errorCoverage,
  "rate-limited": rateLimited,
  "write-unavailable": writeUnavailable,
  "write-committed-lost": writeCommittedLost,
  bounds,
  "many-workspaces": manyWorkspaces,
  "large-channels": largeChannels,
  "size-bounds": sizeBounds,
};

const selected = /Run the ([a-z-]+) flow/.exec(instruction)?.[1];
if (selected === undefined || !Object.hasOwn(flows, selected)) throw new Error(`Unknown drill instruction: ${instruction}`);
await flows[selected]();
process.stdout.write(JSON.stringify({ completed: true, flow: selected }));
