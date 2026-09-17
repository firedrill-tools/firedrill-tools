// Unstructured Tool conformance target: a scripted Tool test, not a model-driven agent. Node built-ins only.
// Reads the drill task from stdin, picks the flow named in the instruction and runs it against the provider-shaped
// routes (FIREDRILL_HTTP_URL with the unstructured-api-key header set to FIREDRILL_HTTP_TOKEN).
import { archivistFlow, deniedFlow, freshFlow, revokedFlow } from "./flows/access.mjs";
import { chunkingFlow } from "./flows/chunking.mjs";
import { connectorsFlow } from "./flows/connectors.mjs";
import { errorsFlow } from "./flows/errors.mjs";
import { overloadedFlow, rateLimitedFlow, runLostFlow, smallResponsesFlow, tightLimitsFlow } from "./flows/faults.mjs";
import { partitionFlow } from "./flows/partition.mjs";
import { workflowsFlow } from "./flows/workflows.mjs";

let task = "";
for await (const chunk of process.stdin) task += chunk;
const invocation = JSON.parse(task);
const instruction = String(invocation.instruction ?? invocation.task?.instruction ?? "");

const flows = {
  partition: partitionFlow,
  chunking: chunkingFlow,
  errors: errorsFlow,
  connectors: connectorsFlow,
  workflows: workflowsFlow,
  fresh: freshFlow,
  archivist: archivistFlow,
  revoked: revokedFlow,
  denied: deniedFlow,
  "rate-limited": rateLimitedFlow,
  overloaded: overloadedFlow,
  "run-lost": runLostFlow,
  "tight-limits": tightLimitsFlow,
  "small-responses": smallResponsesFlow,
};

const selected = /Run the ([a-z-]+) flow/.exec(instruction)?.[1];
if (selected === undefined || !Object.hasOwn(flows, selected)) throw new Error(`Unknown drill instruction: ${instruction}`);
await flows[selected]();
process.stdout.write(JSON.stringify({ completed: true, flow: selected }));
