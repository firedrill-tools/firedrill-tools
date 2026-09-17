// Caller identity (account → role → subsidiary scope), bounded state access and the per-operation session.
import { fail, LOGIN_DETAIL } from "./errors.mjs";
import { accountDate, isInternalId, timestamp } from "./primitives.mjs";

const LEVELS = ["none", "view", "create", "edit", "full"];
const rank = (level) => {
  const index = LEVELS.indexOf(level);
  return index < 0 ? 0 : index;
};

export const PERMISSION_LABELS = new Map([
  ["LIST_CUSTJOB", "Customers"],
  ["TRAN_SALESORD", "Sales Order"],
  ["TRAN_CUSTINVC", "Invoice"],
  ["TRAN_CUSTPYMT", "Customer Payment"],
  ["LIST_ITEM", "Items"],
  ["LIST_SUBSIDIARY", "Subsidiaries"],
  ["SETUP_RECORD_METADATA", "SuiteAnalytics Workbook"],
  ["REPO_ANALYTICS", "SuiteAnalytics Workbook"],
]);

const DEFAULT_ROLE_ID = "3";
const DEFAULT_OFFSET = -480;

function attribute(attributes, name) {
  return Object.hasOwn(attributes, name) ? attributes[name] : undefined;
}

/** Open a session for one operation call. Applies account → role → employee, before any permission check. */
export function open(context) {
  const account = context.state.get("meta", "account");
  if (account === null) {
    fail(context, "INVALID_LOGIN", LOGIN_DETAIL);
  }
  const attributes = context.actor.attributes ?? {};
  const claimedAccount = attribute(attributes, "netsuiteAccountId");
  if (claimedAccount !== undefined && claimedAccount !== account.accountId) {
    fail(context, "INVALID_LOGIN", LOGIN_DETAIL);
  }
  const roleId = attribute(attributes, "netsuiteRoleId") ?? DEFAULT_ROLE_ID;
  if (!isInternalId(roleId)) fail(context, "INVALID_LOGIN", LOGIN_DETAIL);
  const role = context.state.get("roles", roleId);
  if (role === null) fail(context, "INVALID_LOGIN", LOGIN_DETAIL);

  const employeeId = attribute(attributes, "netsuiteEmployeeId") ?? account.defaultEmployeeId;
  if (!isInternalId(employeeId)) fail(context, "INVALID_LOGIN", LOGIN_DETAIL);
  const employee = context.state.get("employees", employeeId);
  if (employee === null) fail(context, "INVALID_LOGIN", LOGIN_DETAIL);

  const claimedScope = attribute(attributes, "netsuiteSubsidiaryId");
  let scope = typeof role.subsidiaryId === "string" ? role.subsidiaryId : "0";
  if (claimedScope !== undefined) {
    if (typeof claimedScope !== "string" || !/^[0-9]{1,15}$/.test(claimedScope)) {
      fail(context, "INVALID_LOGIN", LOGIN_DETAIL);
    }
    scope = claimedScope;
  }
  if (scope !== "0" && context.state.get("subsidiaries", scope) === null) {
    fail(context, "INVALID_LOGIN", LOGIN_DETAIL);
  }
  return createSession(context, account, role, employee, scope);
}

const NUMBERED = new Set(["customers", "items", "sales-orders", "invoices", "customer-payments", "subsidiaries", "employees"]);

function createSession(context, account, role, employee, scope) {
  const limits = context.state.get("meta", "limits");
  const maxScanRows = limits !== null && Number.isInteger(limits.maxScanRows) ? limits.maxScanRows : 5000;
  const maxPageBytes = limits !== null && Number.isInteger(limits.maxPageBytes) ? limits.maxPageBytes : 900000;
  const cache = new Map();
  const nowUs = context.clock.nowUs();

  const session = {
    context,
    account,
    role,
    employee,
    scope,
    maxScanRows,
    maxPageBytes,
    nowUs,
    now: timestamp(nowUs),
    today: accountDate(nowUs, Number.isInteger(account.timeZoneOffsetMinutes) ? account.timeZoneOffsetMinutes : DEFAULT_OFFSET),
    fail: (code, detail, extra = {}) => fail(context, code, detail, extra),

    /** Enforce one NetSuite permission at a minimum level. */
    permit(permission, level) {
      if (role.isAdmin === true) return;
      const granted = role.permissions !== undefined && Object.hasOwn(role.permissions, permission)
        ? role.permissions[permission]
        : "none";
      if (rank(granted) < rank(level)) {
        session.fail(
          "INSUFFICIENT_PERMISSION",
          `Permission Violation: You need a higher level of the '${PERMISSION_LABELS.get(permission) ?? permission}' permission to access this page. Please contact your account administrator.`,
        );
      }
    },

    /** Every row of one namespace, id-ascending, bounded by maxScanRows. */
    rows(namespace) {
      if (cache.has(namespace)) return cache.get(namespace);
      const scanned = context.state.scan(namespace, { limit: maxScanRows });
      if (scanned.length >= maxScanRows) {
        session.fail(
          "RESULT_SET_TOO_LARGE",
          `Search error occurred: The result set for ${namespace} is larger than the supported maximum of ${maxScanRows} rows. Narrow the request and try again.`,
        );
      }
      const values = scanned.map((record) => record.value);
      if (NUMBERED.has(namespace)) values.sort((left, right) => Number(left.id) - Number(right.id));
      else values.sort((left, right) => (left.id ?? "") < (right.id ?? "") ? -1 : 1);
      cache.set(namespace, values);
      return values;
    },

    get(namespace, rowId) {
      return isInternalId(rowId) ? context.state.get(namespace, rowId) : null;
    },

    put(namespace, rowId, value) {
      context.state.put(namespace, rowId, value);
      cache.delete(namespace);
    },

    remove(namespace, rowId) {
      const removed = context.state.delete(namespace, rowId);
      cache.delete(namespace);
      return removed;
    },

    /** True when a record's subsidiary is inside the effective scope (the scope or one of its descendants). */
    inScope(subsidiaryId) {
      if (scope === "0") return true;
      if (subsidiaryId === scope) return true;
      let current = context.state.get("subsidiaries", subsidiaryId);
      for (let depth = 0; depth < 16 && current !== null; depth += 1) {
        if (current.parentId === null || current.parentId === undefined) return false;
        if (current.parentId === scope) return true;
        current = context.state.get("subsidiaries", current.parentId);
      }
      return false;
    },

    /** Draw the next id from one of the three NetSuite counters, skipping ids already taken. */
    nextId(counterKey, namespace) {
      const counters = context.state.get("meta", "counters");
      const start = counters !== null && Number.isInteger(counters[counterKey]) ? counters[counterKey] : 1;
      let next = start < 1 ? 1 : start;
      for (let guard = 0; guard <= maxScanRows; guard += 1) {
        if (context.state.get(namespace, String(next)) === null) break;
        next += 1;
        if (guard === maxScanRows) {
          session.fail("UNEXPECTED_ERROR", "An unexpected error occurred while allocating an internal id.");
        }
      }
      const updated = { ...(counters ?? { nextEntityId: 1, nextItemId: 1, nextTransactionId: 1 }) };
      updated[counterKey] = next + 1;
      context.state.put("meta", "counters", updated);
      return String(next);
    },

    recordChanged(recordType, recordId, changeType, subsidiaryId) {
      context.events.emit("record.changed", {
        recordType,
        recordId,
        changeType,
        occurredAt: session.now,
        employeeId: employee.id,
        subsidiaryId,
      });
    },

    statusChanged(recordType, record, previousStatus, amountRemaining) {
      context.events.emit("transaction.status-changed", {
        recordType,
        recordId: record.id,
        tranId: record.tranId,
        previousStatus,
        status: record.status,
        occurredAt: session.now,
        total: record.total,
        amountRemaining: amountRemaining ?? null,
      });
    },
  };
  return session;
}
