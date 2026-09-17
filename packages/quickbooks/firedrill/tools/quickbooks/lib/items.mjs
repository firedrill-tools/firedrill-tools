// Item entity (Service and NonInventory only): rendering and create / full update / sparse update.
import { bumpToken } from "./access.mjs";
import { updateTarget } from "./customers.mjs";
import { toScaled4 } from "./common.mjs";
import { checkKeys, has, isObject, optBool, optRef, optString } from "./fields.mjs";

const WRITABLE = new Set(["Name", "Sku", "Description", "Type", "UnitPrice", "IncomeAccountRef", "ExpenseAccountRef", "Taxable", "Active", "TrackQtyOnHand"]);
const READONLY = new Set(["Id", "SyncToken", "sparse", "domain", "MetaData", "FullyQualifiedName", "PurchaseCost", "Level", "SubItem"]);

export function refName(s, namespace, ref, field) {
  if (ref === null) return null;
  const target = s.get(namespace, ref.value);
  return { value: ref.value, name: target === null ? ref.name : target[field] };
}

export function renderItem(s, row) {
  const out = {
    Name: row.Name,
    Active: row.Active,
    FullyQualifiedName: row.Name,
    Taxable: row.Taxable,
    UnitPrice: row.UnitPrice,
    Type: row.Type,
    IncomeAccountRef: refName(s, "accounts", row.IncomeAccountRef, "Name"),
    PurchaseCost: 0,
    TrackQtyOnHand: false,
    domain: "QBO",
    sparse: false,
    Id: row.Id,
    SyncToken: row.SyncToken,
    MetaData: row.MetaData,
  };
  if (row.Description !== null) out.Description = row.Description;
  if (row.Sku !== null) out.Sku = row.Sku;
  if (row.ExpenseAccountRef !== null) out.ExpenseAccountRef = refName(s, "accounts", row.ExpenseAccountRef, "Name");
  return out;
}

function accountRef(s, id, types, element) {
  const account = s.get("accounts", id);
  if (account === null || !account.Active || !types.includes(account.AccountType)) {
    s.fail("INVALID_REFERENCE", `Invalid Reference Id : Account ${id} does not exist, is inactive or is not a ${types.join(" or ")} account.`, element);
  }
  return { value: account.Id, name: account.Name };
}

export function saveItem(s, body) {
  if (!isObject(body)) s.fail("REQUIRED_PARAM_MISSING", "Required param missing, need to supply the required value for the API: Item object", "Item");
  checkKeys(s, body, WRITABLE, READONLY);
  const hasId = has(body, "Id") && body.Id !== null;
  const current = hasId ? updateTarget(s, "items", body, "Id") : null;
  if (has(body, "sparse") && typeof body.sparse !== "boolean") s.fail("BUSINESS_VALIDATION", "Invalid value for sparse: expected true or false", "sparse");
  const sparse = current !== null && body.sparse === true;
  const keep = (key) => sparse && !has(body, key);
  const next = current === null ? { Id: "", SyncToken: "0", MetaData: null } : { ...current };

  const name = optString(s, body, "Name", 100);
  if (!keep("Name")) {
    if (typeof name !== "string" || name.trim().length === 0) s.fail("REQUIRED_PARAM_MISSING", "Required param missing, need to supply the required value for the API: Name", "Name");
    if (name.includes(":")) s.fail("BUSINESS_VALIDATION", "Invalid character in name : A name can't contain a colon (:).", "Name");
    next.Name = name.trim();
  }
  if (!keep("Type")) {
    const type = has(body, "Type") ? body.Type : null;
    if (type === null || type === undefined) s.fail("REQUIRED_PARAM_MISSING", "Required param missing, need to supply the required value for the API: Type", "Type");
    if (type === "Inventory" || type === "Group" || type === "Category") {
      s.fail("BUSINESS_VALIDATION", `Item Type ${type} is not supported by this company. Use Service or NonInventory.`, "Type");
    }
    if (type !== "Service" && type !== "NonInventory") s.fail("BUSINESS_VALIDATION", "Invalid value for Type: expected Service or NonInventory", "Type");
    if (current !== null && current.Type !== type) s.fail("BUSINESS_VALIDATION", "You can't change the type of an existing product or service.", "Type");
    next.Type = type;
  }
  if (!keep("UnitPrice")) {
    const price = has(body, "UnitPrice") && body.UnitPrice !== null ? body.UnitPrice : 0;
    if (toScaled4(price, 999_999_999) === null) s.fail("BUSINESS_VALIDATION", "Invalid value for UnitPrice: expected a non-negative amount with at most four decimals", "UnitPrice");
    next.UnitPrice = price;
  }
  if (!keep("IncomeAccountRef")) {
    const income = optRef(s, body, "IncomeAccountRef");
    if (typeof income !== "string") s.fail("REQUIRED_PARAM_MISSING", "Required param missing, need to supply the required value for the API: IncomeAccountRef", "IncomeAccountRef");
    next.IncomeAccountRef = accountRef(s, income, ["Income"], "IncomeAccountRef");
  }
  if (!keep("ExpenseAccountRef")) {
    const expense = optRef(s, body, "ExpenseAccountRef");
    next.ExpenseAccountRef = typeof expense === "string" ? accountRef(s, expense, ["Cost of Goods Sold", "Expense"], "ExpenseAccountRef") : null;
  }
  for (const [key, max] of [["Sku", 100], ["Description", 4000]]) {
    if (!keep(key)) {
      const value = optString(s, body, key, max);
      next[key] = value === undefined ? null : value;
    }
  }
  for (const [key, fallback] of [["Taxable", false], ["Active", true]]) {
    if (!keep(key)) {
      const value = optBool(s, body, key);
      next[key] = value === undefined ? fallback : value;
    }
  }
  if (optBool(s, body, "TrackQtyOnHand") === true) {
    s.fail("BUSINESS_VALIDATION", "Quantity on hand can only be tracked for Inventory items, which this company does not support.", "TrackQtyOnHand");
  }
  const fold = next.Name.toLowerCase();
  for (const other of s.rows("items")) {
    if (other.Id !== next.Id && other.Name.toLowerCase() === fold) {
      s.fail("DUPLICATE_NAME", "The name supplied already exists. : Another product or service is already using this name. Please use a different name.", "Name");
    }
  }
  if (current === null) {
    next.Id = s.nextId("item", "items");
    next.MetaData = { CreateTime: s.clock.meta, LastUpdatedTime: s.clock.meta };
  } else {
    next.SyncToken = bumpToken(current);
    next.MetaData = { CreateTime: current.MetaData.CreateTime, LastUpdatedTime: s.clock.meta };
  }
  s.put("items", next);
  return { row: next, action: current === null ? "create" : "update" };
}
