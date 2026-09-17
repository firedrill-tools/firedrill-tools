// The nine write operations, grouped by record.
import { customerWrites } from "./write-customer.mjs";
import { orderWrites } from "./write-order.mjs";
import { invoiceWrites } from "./write-invoice.mjs";

export const writeOperations = { ...customerWrites, ...orderWrites, ...invoiceWrites };
