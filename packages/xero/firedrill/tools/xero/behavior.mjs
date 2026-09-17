// Xero Accounting API 2.0 (subset) Tool behavior: synchronous handlers over context.state plus pure wire codecs.
import { contactWriteOperations } from "./lib/contacts-write.mjs";
import { readOperations } from "./lib/handlers-read.mjs";
import { invoiceWriteOperations } from "./lib/invoices-write.mjs";
import { paymentWriteOperations } from "./lib/payments-write.mjs";
import { routes } from "./lib/routes.mjs";

export default {
  operations: { ...readOperations, ...contactWriteOperations, ...invoiceWriteOperations, ...paymentWriteOperations },
  http: routes,
};
