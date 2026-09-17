// Customer entity: rendering (computed Balance) and create / full update / sparse update / make inactive.
import { bumpToken, load, staleCheck } from "./access.mjs";
import { TERMS, USD, fromCents, toCents } from "./common.mjs";
import { checkKeys, has, isObject, optAddr, optBool, optEmail, optEnum, optPhone, optRef, optString, own } from "./fields.mjs";

const TEXT_FIELDS = [["DisplayName", 500], ["Title", 16], ["GivenName", 100], ["MiddleName", 100], ["FamilyName", 100], ["Suffix", 16], ["CompanyName", 100], ["PrintOnCheckName", 110], ["Notes", 2000]];
const NULLABLE = ["Title", "GivenName", "MiddleName", "FamilyName", "Suffix", "CompanyName", "PrimaryEmailAddr", "PrimaryPhone", "Mobile", "BillAddr", "ShipAddr", "Notes", "SalesTermRef", "PaymentMethodRef"];
const WRITABLE = new Set([...TEXT_FIELDS.map(([name]) => name), "PrimaryEmailAddr", "PrimaryPhone", "Mobile", "BillAddr", "ShipAddr", "Taxable", "PreferredDeliveryMethod", "SalesTermRef", "PaymentMethodRef", "Active"]);
const READONLY = new Set(["Id", "SyncToken", "sparse", "domain", "MetaData", "FullyQualifiedName", "Balance", "BalanceWithJobs", "Job", "BillWithParent", "CurrencyRef"]);

export function renderCustomer(s, row) {
  const balance = fromCents(s.balances().get(row.Id) ?? 0);
  const out = {
    Taxable: row.Taxable,
    Job: false,
    BillWithParent: false,
    Balance: balance,
    BalanceWithJobs: balance,
    CurrencyRef: USD,
    PreferredDeliveryMethod: row.PreferredDeliveryMethod,
    domain: "QBO",
    sparse: false,
    Id: row.Id,
    SyncToken: row.SyncToken,
    MetaData: row.MetaData,
    FullyQualifiedName: row.DisplayName,
    DisplayName: row.DisplayName,
    PrintOnCheckName: row.PrintOnCheckName ?? row.DisplayName,
    Active: row.Active,
  };
  for (const key of NULLABLE) if (row[key] !== null) out[key] = row[key];
  if (row.SalesTermRef !== null) out.SalesTermRef = { value: row.SalesTermRef.value, name: TERMS.get(row.SalesTermRef.value)?.name ?? row.SalesTermRef.name };
  return out;
}

function blank() {
  const row = { Id: "", SyncToken: "0", DisplayName: null, PrintOnCheckName: null, Taxable: false, PreferredDeliveryMethod: "Print", Active: true, MetaData: null };
  for (const key of NULLABLE) row[key] = null;
  return row;
}

/** Id + SyncToken of an update body, loaded and stale-checked. */
export function updateTarget(s, namespace, body, element) {
  if (!has(body, "Id") || body.Id === null) s.fail("REQUIRED_PARAM_MISSING", "Required param missing, need to supply the required value for the API: Id", "Id");
  if (!has(body, "SyncToken") || body.SyncToken === null) s.fail("REQUIRED_PARAM_MISSING", "Required param missing, need to supply the required value for the API: SyncToken", "SyncToken");
  const id = typeof body.Id === "string" || typeof body.Id === "number" ? String(body.Id) : "";
  const row = load(s, namespace, id, element);
  staleCheck(s, row, typeof body.SyncToken === "string" || typeof body.SyncToken === "number" ? String(body.SyncToken) : null);
  return row;
}

/** Create (no Id) or update (Id + SyncToken). `intent` "create" refuses an Id, "update" requires one. */
export function saveCustomer(s, body, intent) {
  if (!isObject(body)) s.fail("REQUIRED_PARAM_MISSING", "Required param missing, need to supply the required value for the API: Customer object", "Customer");
  checkKeys(s, body, WRITABLE, READONLY);
  const hasId = has(body, "Id") && body.Id !== null;
  if (intent === "create" && hasId) s.fail("BUSINESS_VALIDATION", "Id is assigned by QuickBooks and cannot be supplied when creating a customer.", "Id");
  const current = intent === "update" || hasId ? updateTarget(s, "customers", body, "Id") : null;
  if (has(body, "sparse") && typeof body.sparse !== "boolean") s.fail("BUSINESS_VALIDATION", "Invalid value for sparse: expected true or false", "sparse");
  const sparse = current !== null && body.sparse === true;
  const next = { ...(current ?? blank()) };
  const assign = (key, value, reset) => {
    if (value !== undefined) next[key] = value;
    else if (current !== null && !sparse) next[key] = reset;
  };
  for (const [key, max] of TEXT_FIELDS) assign(key, optString(s, body, key, max), null);
  assign("PrimaryEmailAddr", optEmail(s, body, "PrimaryEmailAddr"), null);
  assign("PrimaryPhone", optPhone(s, body, "PrimaryPhone"), null);
  assign("Mobile", optPhone(s, body, "Mobile"), null);
  assign("BillAddr", optAddr(s, body, "BillAddr"), null);
  assign("ShipAddr", optAddr(s, body, "ShipAddr"), null);
  assign("Taxable", optBool(s, body, "Taxable"), false);
  assign("PreferredDeliveryMethod", optEnum(s, body, "PreferredDeliveryMethod", ["Print", "Email", "None"]), "Print");
  assign("Active", optBool(s, body, "Active"), true);
  const term = optRef(s, body, "SalesTermRef");
  if (typeof term === "string" && !TERMS.has(term)) s.fail("INVALID_REFERENCE", `Invalid Reference Id : Term assigned to this customer does not exist: ${term}`, "SalesTermRef");
  assign("SalesTermRef", typeof term === "string" ? { value: term, name: TERMS.get(term).name } : term, null);
  const method = optRef(s, body, "PaymentMethodRef");
  const methodName = own(body.PaymentMethodRef, "name");
  assign("PaymentMethodRef", typeof method === "string" ? { value: method, name: typeof methodName === "string" ? methodName.slice(0, 100) : null } : method, null);
  const currency = own(body, "CurrencyRef");
  if (currency !== undefined && currency !== null && own(currency, "value") !== "USD") {
    s.fail("BUSINESS_VALIDATION", "Multicurrency is not enabled for this company: CurrencyRef must be USD.", "CurrencyRef");
  }
  let display = typeof next.DisplayName === "string" ? next.DisplayName.trim() : "";
  if (display.length === 0) {
    display = ["Title", "GivenName", "MiddleName", "FamilyName", "Suffix"].map((key) => next[key]).filter((part) => typeof part === "string" && part.trim().length > 0).map((part) => part.trim()).join(" ");
    if (display.length === 0 && typeof next.CompanyName === "string") display = next.CompanyName.trim();
  }
  if (display.length === 0) s.fail("REQUIRED_PARAM_MISSING", "Required param missing, need to supply the required value for the API: DisplayName or a name part", "DisplayName");
  if (display.includes(":")) s.fail("BUSINESS_VALIDATION", "Invalid character in name : A name can't contain a colon (:).", "DisplayName");
  next.DisplayName = display.slice(0, 500);
  const fold = next.DisplayName.toLowerCase();
  for (const other of s.rows("customers")) {
    if (other.Id !== next.Id && other.DisplayName.trim().toLowerCase() === fold) {
      s.fail("DUPLICATE_NAME", "The name supplied already exists. : Another customer is already using this name. Please use a different name.", "DisplayName");
    }
  }
  const openCents = current === null ? 0 : (s.balances().get(current.Id) ?? 0);
  if (has(body, "Balance") && toCents(body.Balance, { allowNegative: true }) !== openCents) {
    s.fail("BUSINESS_VALIDATION", "Balance is read-only: it is computed from open invoices and cannot be set on a customer.", "Balance");
  }
  if (current !== null && current.Active && next.Active === false && openCents > 0) {
    s.fail("BUSINESS_VALIDATION", "This customer has an open balance. Receive payment or void the open invoices before making the customer inactive.", "Active");
  }
  return commitCustomer(s, current, next);
}

function commitCustomer(s, current, next) {
  if (current === null) {
    next.Id = s.nextId("customer", "customers");
    next.SyncToken = "0";
    next.MetaData = { CreateTime: s.clock.meta, LastUpdatedTime: s.clock.meta };
  } else {
    next.SyncToken = bumpToken(current);
    next.MetaData = { CreateTime: current.MetaData.CreateTime, LastUpdatedTime: s.clock.meta };
  }
  s.put("customers", next);
  s.emit("customer.changed", "Customer", next.Id, current === null ? "Create" : "Update");
  return { row: next, action: current === null ? "create" : "update" };
}

/** delete_customer: QuickBooks has no customer delete, so this makes the customer inactive. */
export function deactivateCustomer(s, idOrEntity) {
  let id = "";
  let token;
  if (typeof idOrEntity === "string") id = idOrEntity;
  else if (isObject(idOrEntity)) {
    const rawId = own(idOrEntity, "Id");
    id = typeof rawId === "string" || typeof rawId === "number" ? String(rawId) : "";
    const rawToken = own(idOrEntity, "SyncToken");
    if (rawToken !== undefined) token = typeof rawToken === "string" || typeof rawToken === "number" ? String(rawToken) : null;
  }
  const current = load(s, "customers", id);
  if (token !== undefined) staleCheck(s, current, token);
  if ((s.balances().get(current.Id) ?? 0) > 0) {
    s.fail("BUSINESS_VALIDATION", "This customer has an open balance. Receive payment or void the open invoices before making the customer inactive.", "Active");
  }
  return commitCustomer(s, current, { ...current, Active: false });
}
