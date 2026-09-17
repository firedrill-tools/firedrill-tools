// Record-type metadata. The field table below mirrors this Tool's own state schemas and the `q` filter tables;
// the response body is assembled from it on every call, never stored as a blob.
import { FILTER_FIELDS } from "./collections.mjs";

const string = (maxLength, extra = {}) => ({ type: "string", maxLength, ...extra });
const number = (extra = {}) => ({ type: "number", ...extra });
const boolean = () => ({ type: "boolean" });
const reference = (recordType) => ({ type: "object", "x-ns-reference": recordType });
const date = () => ({ type: "string", format: "date" });
const timestamp = () => ({ type: "string", format: "date-time" });

export const RECORD_TYPES = ["customer", "salesOrder", "invoice", "customerPayment", "inventoryItem", "subsidiary"];

const FIELDS = {
  customer: {
    id: [string(15), "Internal ID", true],
    entityId: [string(83), "Name", true],
    companyName: [string(83), "Company Name", false],
    isPerson: [boolean(), "Individual", true],
    firstName: [string(32), "First Name", false],
    middleName: [string(32), "Middle Name", false],
    lastName: [string(32), "Last Name", false],
    email: [string(254), "Email", false],
    phone: [string(22), "Phone", false],
    altPhone: [string(22), "Alt. Phone", false],
    subsidiary: [reference("subsidiary"), "Subsidiary", true],
    currency: [reference("currency"), "Primary Currency", false],
    terms: [reference("term"), "Terms", false],
    creditLimit: [number({ minimum: 0 }), "Credit Limit", false],
    comments: [string(999), "Comments", false],
    isInactive: [boolean(), "Inactive", true],
    balance: [number(), "Balance", false],
    unbilledOrders: [number(), "Unbilled Orders", false],
    overdueBalance: [number(), "Overdue Balance", false],
    dateCreated: [timestamp(), "Date Created", true],
    lastModifiedDate: [timestamp(), "Last Modified", true],
  },
  salesOrder: {
    id: [string(15), "Internal ID", true],
    tranId: [string(45), "Document Number", true],
    tranDate: [date(), "Date", true],
    entity: [reference("customer"), "Customer", true],
    subsidiary: [reference("subsidiary"), "Subsidiary", true],
    status: [string(40, { enum: ["A", "B", "D", "E", "F", "G", "H"] }), "Status", true],
    memo: [string(999), "Memo", false],
    otherRefNum: [string(45), "PO/Check Number", false],
    currency: [reference("currency"), "Currency", false],
    terms: [reference("term"), "Terms", false],
    subtotal: [number(), "Subtotal", false],
    taxTotal: [number(), "Tax Total", false],
    total: [number(), "Amount", true],
    item: [{ type: "array", "x-ns-sublist": "item" }, "Items", false],
  },
  invoice: {
    id: [string(15), "Internal ID", true],
    tranId: [string(45), "Document Number", true],
    tranDate: [date(), "Date", true],
    dueDate: [date(), "Due Date", true],
    entity: [reference("customer"), "Customer", true],
    subsidiary: [reference("subsidiary"), "Subsidiary", true],
    createdFrom: [reference("salesOrder"), "Created From", true],
    status: [string(40, { enum: ["A", "B", "C", "V"] }), "Status", true],
    memo: [string(999), "Memo", false],
    currency: [reference("currency"), "Currency", false],
    terms: [reference("term"), "Terms", false],
    subtotal: [number(), "Subtotal", false],
    taxTotal: [number(), "Tax Total", false],
    total: [number(), "Amount", true],
    amountPaid: [number(), "Amount Paid", false],
    amountRemaining: [number(), "Amount Remaining", true],
    item: [{ type: "array", "x-ns-sublist": "item" }, "Items", false],
  },
  customerPayment: {
    id: [string(15), "Internal ID", true],
    tranId: [string(45), "Document Number", true],
    tranDate: [date(), "Date", true],
    customer: [reference("customer"), "Customer", true],
    subsidiary: [reference("subsidiary"), "Subsidiary", false],
    payment: [number(), "Payment Amount", true],
    unapplied: [number(), "Unapplied", false],
    account: [reference("account"), "Account", false],
    currency: [reference("currency"), "Currency", false],
    status: [string(40, { enum: ["A", "B"] }), "Status", true],
    apply: [{ type: "array", "x-ns-sublist": "apply" }, "Apply", false],
  },
  inventoryItem: {
    id: [string(15), "Internal ID", true],
    itemId: [string(60), "Item Name/Number", true],
    displayName: [string(60), "Display Name", true],
    description: [string(999), "Description", false],
    basePrice: [number({ minimum: 0 }), "Base Price", true],
    cost: [number({ minimum: 0 }), "Purchase Price", false],
    quantityOnHand: [number({ minimum: 0 }), "Quantity On Hand", false],
    incomeAccount: [reference("account"), "Income Account", false],
    taxSchedule: [reference("taxSchedule"), "Tax Schedule", false],
    subsidiary: [{ type: "array", "x-ns-sublist": "subsidiary" }, "Subsidiary", false],
    isInactive: [boolean(), "Inactive", true],
  },
  subsidiary: {
    id: [string(15), "Internal ID", true],
    name: [string(120), "Name", true],
    parent: [reference("subsidiary"), "Parent Subsidiary", false],
    country: [string(2), "Country", false],
    currency: [reference("currency"), "Currency", false],
    isElimination: [boolean(), "Elimination", false],
    isInactive: [boolean(), "Inactive", false],
  },
};

const FILTER_KEY = {
  customer: "customer",
  salesOrder: "salesOrder",
  invoice: "invoice",
  customerPayment: "customerPayment",
  inventoryItem: "inventoryItem",
};

/** The `application/schema+json`-shaped description of one record type. */
export function describe(recordType, serverTime) {
  const fields = FIELDS[recordType];
  const filterable = FILTER_KEY[recordType] === undefined ? {} : FILTER_FIELDS[FILTER_KEY[recordType]];
  const properties = {};
  const required = [];
  for (const [name, [schema, title, isRequired]] of Object.entries(fields)) {
    properties[name] = { ...schema, title };
    if (Object.hasOwn(filterable, name)) properties[name]["x-ns-filterable"] = true;
    if (isRequired === true) required.push(name);
  }
  return {
    "x-ns-type": recordType,
    "x-ns-serverTime": serverTime,
    type: "object",
    properties,
    required,
  };
}

export function catalog(serverTime) {
  return {
    links: [{ rel: "self", href: "/services/rest/record/v1/metadata-catalog" }],
    "x-ns-serverTime": serverTime,
    items: RECORD_TYPES.map((name) => ({
      name,
      links: [{ rel: "canonical", href: `/services/rest/record/v1/metadata-catalog/${name}` }],
    })),
    totalResults: RECORD_TYPES.length,
  };
}
