// Check Tool conformance target. A scripted Tool test, not a model-driven agent.
// Node built-ins only: fetch against the Check-shaped REST routes (`Authorization: Bearer <token>`) and the canonical
// Firedrill operation endpoint. Every flow fails loudly on an unexpected status, envelope, field path or value.
import { main } from "./harness.mjs";
import "./flow-directory.mjs";
import "./flow-people.mjs";
import "./flow-payroll-run.mjs";
import "./flow-payroll-rules.mjs";
import "./flow-access.mjs";
import "./flow-faults.mjs";
import "./flow-limits.mjs";

await main();
