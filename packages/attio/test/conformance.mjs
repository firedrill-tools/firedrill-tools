// Attio Tool conformance target: a scripted Tool test, not a model-driven agent. Node built-ins only (fetch against
// the Attio-shaped REST routes). The drill instruction names the flow; every flow fails loudly on an unexpected
// status, header or body.
import { faultFlows } from "./flows-faults.mjs";
import { listNoteFlows } from "./flows-lists-notes.mjs";
import { recordFlows } from "./flows-records.mjs";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const invocation = JSON.parse(input);
const instruction = String(invocation.instruction ?? invocation.task?.instruction ?? "");

const flows = { ...recordFlows, ...listNoteFlows, ...faultFlows };
const selected = Object.keys(flows).find((name) => instruction.includes(`the ${name} conformance flow`));
if (selected === undefined) throw new Error(`Unknown drill instruction: ${instruction}`);
await flows[selected]();
process.stdout.write(JSON.stringify({ completed: true, flow: selected }));
