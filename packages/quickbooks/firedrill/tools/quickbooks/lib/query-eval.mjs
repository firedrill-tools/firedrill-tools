// Query evaluation over package state: entity metadata (filterable / sortable properties), typed comparisons,
// QuickBooks' Active default, ordering, 1-based paging and a response byte budget. Shared by query.run and the
// MCP search operations (criteria compile to the same AST).
import { dayNumber, instantOf, utf8Bytes } from "./common.mjs";
import { renderCustomer } from "./customers.mjs";
import { renderInvoice } from "./invoices.mjs";
import { renderItem } from "./items.mjs";
import { compileLike, likeMatches } from "./like.mjs";
import { renderPayment } from "./payments.mjs";
import { renderAccount, renderCompany } from "./views.mjs";

const META_TIMES = [["MetaData.CreateTime", "datetime"], ["MetaData.LastUpdatedTime", "datetime"]];
const ENTITIES = new Map([
  ["customer", { name: "Customer", namespace: "customers", capability: "customers.read", activeDefault: true, render: renderCustomer, props: new Map([["Id", "id"], ["DisplayName", "string"], ["GivenName", "string"], ["FamilyName", "string"], ["CompanyName", "string"], ["PrimaryEmailAddr", "email"], ["Active", "bool"], ["Balance", "number"], ...META_TIMES]) }],
  ["item", { name: "Item", namespace: "items", capability: "items.read", activeDefault: true, render: renderItem, props: new Map([["Id", "id"], ["Name", "string"], ["Active", "bool"], ["Type", "string"], ["Sku", "string"], ...META_TIMES]) }],
  ["invoice", { name: "Invoice", namespace: "invoices", capability: "invoices.read", activeDefault: false, render: renderInvoice, props: new Map([["Id", "id"], ["DocNumber", "string"], ["TxnDate", "date"], ["DueDate", "date"], ["CustomerRef", "ref"], ["Balance", "number"], ["TotalAmt", "number"], ["EmailStatus", "string"], ...META_TIMES]) }],
  ["payment", { name: "Payment", namespace: "payments", capability: "payments.read", activeDefault: false, render: renderPayment, props: new Map([["Id", "id"], ["TxnDate", "date"], ["CustomerRef", "ref"], ["TotalAmt", "number"], ["PaymentRefNum", "string"], ...META_TIMES]) }],
  ["account", { name: "Account", namespace: "accounts", capability: "accounts.read", activeDefault: true, render: renderAccount, props: new Map([["Id", "id"], ["Name", "string"], ["AccountType", "string"], ["Classification", "string"], ["Active", "bool"], ["CurrentBalance", "number"], ...META_TIMES]) }],
  ["companyinfo", { name: "CompanyInfo", namespace: null, capability: "company.read", activeDefault: false, render: null, props: new Map([["Id", "id"], ...META_TIMES]) }],
]);

// Encoded-page budget (the framework refuses HTTP responses over 1 MiB). A stored invoice is bounded by
// INVOICE_DESCRIPTION_BYTES (invoice-draft.mjs) so that any single rendered row plus the QueryResponse envelope
// fits under this budget: the first row of a page is therefore always returned, and a page stops before the row
// that would pass the budget (maxResults = rows returned, so STARTPOSITION + maxResults is the real next position).
export const RESPONSE_BYTE_BUDGET = 900_000;
export { utf8Bytes };

export function entityMeta(s, name) {
  const meta = typeof name === "string" ? ENTITIES.get(name.toLowerCase()) : undefined;
  if (meta === undefined) s.fail("QUERY_VALIDATION_ERROR", `QueryValidationError: Invalid entity name: ${String(name).slice(0, 64)}`, "query");
  return meta;
}

function invalidProp(s, prop, why = "is not queryable") {
  return s.fail("QUERY_VALIDATION_ERROR", `QueryValidationError: property '${String(prop).slice(0, 64)}' ${why}`, "query");
}

/** Typed value of a rendered entity property (null when absent). */
function valueOf(entity, prop, type) {
  if (prop === "MetaData.CreateTime" || prop === "MetaData.LastUpdatedTime") {
    const text = entity.MetaData?.[prop === "MetaData.CreateTime" ? "CreateTime" : "LastUpdatedTime"];
    return typeof text === "string" ? instantOf(text) : null;
  }
  if (!Object.hasOwn(entity, prop)) return null;
  const raw = entity[prop];
  if (raw === null || raw === undefined) return null;
  switch (type) {
    case "id": return Number(raw);
    case "email": return typeof raw.Address === "string" ? raw.Address.toLowerCase() : null;
    case "ref": return typeof raw.value === "string" ? raw.value : null;
    case "string": return typeof raw === "string" ? raw.toLowerCase() : null;
    case "date": return dayNumber(raw);
    default: return raw;
  }
}

/** Literal → comparable value for the property type, or a QUERY_VALIDATION_ERROR. */
function coerce(s, prop, type, literal) {
  const bad = () => s.fail("QUERY_VALIDATION_ERROR", `QueryValidationError: value ${JSON.stringify(String(literal.value)).slice(0, 80)} is not valid for property '${prop}'`, "query");
  const text = literal.kind === "bool" ? null : String(literal.value);
  switch (type) {
    case "id": {
      if (text === null || text.length === 0 || text.length > 10) return bad();
      for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) < 48 || text.charCodeAt(i) > 57) return bad();
      return Number(text);
    }
    case "string":
    case "email":
      return text === null ? bad() : text.toLowerCase();
    case "ref":
      return text === null ? bad() : text;
    case "number": {
      const n = text === null || text.trim().length === 0 || text.length > 32 ? Number.NaN : Number(text);
      return Number.isFinite(n) ? n : bad();
    }
    case "bool":
      if (literal.kind === "bool") return literal.value;
      if (text === "true" || text === "false") return text === "true";
      return bad();
    case "date": {
      const day = text === null ? null : dayNumber(text.slice(0, 10));
      return day === null ? bad() : day;
    }
    default: {
      const instant = text === null ? null : instantOf(text);
      return instant === null ? bad() : instant;
    }
  }
}

function compileCondition(s, meta, condition) {
  const type = meta.props.get(condition.prop);
  if (type === undefined) invalidProp(s, condition.prop);
  if (condition.op === "like") {
    if (type !== "string" && type !== "email") invalidProp(s, condition.prop, "does not support LIKE");
    const pattern = coerce(s, condition.prop, type, condition.values[0]);
    const compiled = compileLike(pattern);
    return (entity) => {
      const value = valueOf(entity, condition.prop, type);
      return typeof value === "string" && likeMatches(compiled, value);
    };
  }
  const values = condition.values.map((literal) => coerce(s, condition.prop, type, literal));
  return (entity) => {
    const value = valueOf(entity, condition.prop, type);
    if (value === null) return false;
    switch (condition.op) {
      case "in": return values.includes(value);
      case "=": return value === values[0];
      case "<": return value < values[0];
      case ">": return value > values[0];
      case "<=": return value <= values[0];
      default: return value >= values[0];
    }
  };
}

function compare(a, b) {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a < b ? -1 : 1;
}

/** Evaluate an AST. `all` ignores start/max (fetchAll). Returns { meta, entities (page), total }. */
export function evaluate(s, ast, { all = false } = {}) {
  const meta = entityMeta(s, ast.entity);
  s.permit(meta.capability);
  const tests = ast.where.map((condition) => compileCondition(s, meta, condition));
  const order = ast.order.map(({ prop, dir }) => {
    const type = meta.props.get(prop);
    if (type === undefined) invalidProp(s, prop, "is not sortable");
    return { prop, type, sign: dir === "desc" ? -1 : 1 };
  });
  const activeDefault = meta.activeDefault && !ast.where.some((condition) => condition.prop === "Active");
  const source = meta.namespace === null ? [s.company] : s.rows(meta.namespace);
  const matched = [];
  for (const row of source) {
    const entity = meta.namespace === null ? renderCompany(row) : meta.render(s, row);
    if (activeDefault && entity.Active !== true) continue;
    if (tests.every((test) => test(entity))) matched.push(entity);
  }
  matched.sort((a, b) => {
    for (const key of order) {
      const result = compare(valueOf(a, key.prop, key.type), valueOf(b, key.prop, key.type));
      if (result !== 0) return result * key.sign;
    }
    return Number(a.Id) - Number(b.Id);
  });
  if (ast.select.kind === "count") return { meta, entities: [], total: matched.length };
  const page = all ? matched : matched.slice(ast.start - 1, ast.start - 1 + ast.max);
  const entities = [];
  let bytes = 0;
  for (const entity of page) {
    const projected = ast.select.kind === "fields" ? project(entity, ast.select.fields) : entity;
    const size = utf8Bytes(JSON.stringify(projected)) + 1;
    if (size > RESPONSE_BYTE_BUDGET) {
      // Last line of defence: a single row that can never fit a response answers the declared error instead of an opaque
      // framework 500 (invoice-draft.mjs bounds stored invoices so this is unreachable through the public write surface).
      s.fail("STATE_BOUND_EXCEEDED", `Entity ${projected.Id ?? ""} renders to ${size} bytes, over the response bound of ${RESPONSE_BYTE_BUDGET}.`, "query");
    }
    if (entities.length > 0 && bytes + size > RESPONSE_BYTE_BUDGET) {
      // fetchAll has no next position to hand back; a paged query returns the rows that fit.
      if (all) s.fail("STATE_BOUND_EXCEEDED", "Response too large; page with limit and offset instead of fetchAll.", "query");
      break;
    }
    bytes += size;
    entities.push(projected);
  }
  return { meta, entities, total: matched.length };
}

function project(entity, fields) {
  const out = { Id: entity.Id, SyncToken: entity.SyncToken, domain: "QBO", sparse: true };
  for (const field of fields) if (Object.hasOwn(entity, field)) out[field] = entity[field];
  return out;
}
