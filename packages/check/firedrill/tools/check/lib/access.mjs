// API-key model from actor attributes. `companies` (array of company ids) limits reach; absent → every company.
// `accessLevel` `full` (default) or `read_only`. Malformed attributes → AUTHENTICATION_ERROR on every operation.
import { isId } from "./ids.mjs";

/** Returns `{ scope: Set|null }`; fails for an invalid key, and for writes with a read-only key. */
export function requireKey(context, write) {
  const attributes = context.actor?.attributes ?? {};
  const level = Object.hasOwn(attributes, "accessLevel") ? attributes.accessLevel : "full";
  let scope = null;
  if (Object.hasOwn(attributes, "companies")) {
    const list = attributes.companies;
    if (!Array.isArray(list) || list.length > 100 || !list.every((id) => typeof id === "string" && isId("com", id))) invalidKey(context);
    scope = new Set(list);
  }
  if (level !== "full" && level !== "read_only") invalidKey(context);
  if (write && level === "read_only") {
    context.fail({ code: "PERMISSION_DENIED", message: "This API key does not have permission to perform this action." });
  }
  return { scope };
}

function invalidKey(context) {
  context.fail({ code: "AUTHENTICATION_ERROR", message: "Invalid API key." });
}

export const inScope = (key, companyId) => key.scope === null || key.scope.has(companyId);
