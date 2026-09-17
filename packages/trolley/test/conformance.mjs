// Trolley Tool conformance target. A scripted Tool test, not a model-driven agent.
// Node built-ins only: fetch against the Trolley-shaped REST routes (`Authorization: prsign <token>` or `Bearer`) and the
// canonical Firedrill operation endpoint. Every flow fails loudly on an unexpected status, envelope or field.
import { main } from "./harness.mjs";
import "./flow-recipients.mjs";
import "./flow-accounts.mjs";
import "./flow-batches.mjs";
import "./flow-processing.mjs";
import "./flow-access.mjs";
import "./flow-faults.mjs";

await main();
