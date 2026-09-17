// The signed-in context of one SuiteTalk session: account, employee, role, subsidiary scope and server time.
// NetSuite exposes this to a browser session through the application shell rather than a REST resource, so this
// operation carries no HTTP route; the browser app reads it to render the account/role chrome and the world clock.
import { open, PERMISSION_LABELS } from "./session.mjs";

const LEVELS = ["none", "view", "create", "edit", "full"];

function permissionList(role) {
  const entries = [];
  for (const [name, label] of PERMISSION_LABELS) {
    const granted = role.isAdmin === true
      ? "full"
      : (role.permissions !== undefined && Object.hasOwn(role.permissions, name) ? role.permissions[name] : "none");
    entries.push({ name, label, level: LEVELS.includes(granted) ? granted : "none" });
  }
  return entries;
}

export const sessionOperations = {
  "session.get": (input, context) => {
    const session = open(context);
    session.permit("SETUP_RECORD_METADATA", "view");
    const account = session.account;
    const employee = session.employee;
    const scopeRow = session.scope === "0" ? null : session.get("subsidiaries", session.scope);
    return {
      account: {
        accountId: account.accountId,
        companyName: account.companyName,
        baseCurrency: account.baseCurrency,
        dateFormat: account.dateFormat,
        isOneWorld: account.isOneWorld === true,
      },
      user: {
        id: employee.id,
        entityId: employee.entityId,
        name: `${employee.firstName} ${employee.lastName}`,
        email: employee.email,
        title: employee.title,
      },
      role: {
        id: session.role.id,
        name: session.role.name,
        isAdmin: session.role.isAdmin === true,
        permissions: permissionList(session.role),
      },
      subsidiaryScope: session.scope === "0" ? { id: "0", refName: "All" } : { id: session.scope, refName: scopeRow === null ? session.scope : scopeRow.name },
      serverTime: session.now,
      accountDate: session.today,
    };
  },
};
