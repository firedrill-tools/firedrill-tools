// NetSuite (SuiteTalk REST Web Services subset) Tool behavior: synchronous handlers over context.state plus
// pure provider-shaped wire codecs. Reads live in lib/handlers-read.mjs, the MCP-shaped reads, metadata and
// SuiteQL in lib/handlers-meta.mjs, and the nine writes in lib/handlers-write.mjs.
import { readOperations } from "./lib/handlers-read.mjs";
import { metaOperations } from "./lib/handlers-meta.mjs";
import { writeOperations } from "./lib/handlers-write.mjs";
import { sessionOperations } from "./lib/handlers-session.mjs";
import { routes } from "./lib/wire.mjs";

export default {
  operations: { ...readOperations, ...metaOperations, ...writeOperations, ...sessionOperations },
  http: routes,
};
