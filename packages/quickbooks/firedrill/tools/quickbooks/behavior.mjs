// QuickBooks Online (Accounting API v3 subset) Tool behavior: synchronous handlers over context.state plus pure
// provider-shaped wire codecs. Read handlers live in lib/handlers-read.mjs, write handlers in lib/handlers-write.mjs.
import { readOperations } from "./lib/handlers-read.mjs";
import { writeOperations } from "./lib/handlers-write.mjs";
import { routes } from "./lib/wire.mjs";

export default {
  operations: { ...readOperations, ...writeOperations },
  http: routes,
};
