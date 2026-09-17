// The analytics tables the SuiteQL subset exposes, built from state rows and filtered by the session's subsidiary scope.
import { invStatus, payStatus, soStatus } from "./project.mjs";

export const TABLES = new Map([
  ["customer", "customer"],
  ["transaction", "transaction"],
  ["transactionline", "transactionLine"],
  ["item", "item"],
  ["employee", "employee"],
  ["subsidiary", "subsidiary"],
]);

export const COLUMNS = {
  customer: [
    "id", "entityid", "companyname", "email", "phone", "isperson", "isinactive",
    "subsidiary", "datecreated", "lastmodifieddate", "firstname", "lastname", "creditlimit",
  ],
  transaction: [
    "id", "type", "entity", "trandate", "tranid", "status", "foreigntotal",
    "memo", "subsidiary", "duedate", "createdfrom",
  ],
  transactionLine: [
    "id", "transaction", "linesequencenumber", "item", "quantity", "rate", "netamount", "subsidiary",
  ],
  item: ["id", "itemid", "displayname", "description", "baseprice", "cost", "quantityonhand", "itemtype", "isinactive"],
  employee: ["id", "entityid", "firstname", "lastname", "email", "title", "subsidiary", "supervisor", "isinactive"],
  subsidiary: ["id", "name", "parent", "country", "currency", "isinactive"],
};

/** Columns whose BUILTIN.DF renders another record's display name. */
export const DF_SOURCE = {
  entity: "customer",
  customer: "customer",
  item: "item",
  subsidiary: "subsidiary",
  supervisor: "employee",
  parent: "subsidiary",
  transaction: "transaction",
  createdfrom: "transaction",
  status: "status",
};

const inScope = (session, subsidiaryId) => session.inScope(subsidiaryId);

export function buildTables(session) {
  const cache = new Map();
  return {
    rows(name) {
      if (cache.has(name)) return cache.get(name);
      const built = build(session, name);
      cache.set(name, built);
      return built;
    },
  };
}

function build(session, name) {
  if (name === "customer") {
    return session.rows("customers").filter((row) => inScope(session, row.subsidiaryId)).map((row) => ({
      id: row.id,
      entityid: row.entityId,
      companyname: row.companyName,
      email: row.email,
      phone: row.phone,
      isperson: row.isPerson ? "T" : "F",
      isinactive: row.isInactive ? "T" : "F",
      subsidiary: row.subsidiaryId,
      datecreated: row.dateCreated,
      lastmodifieddate: row.lastModifiedDate,
      firstname: row.firstName,
      lastname: row.lastName,
      creditlimit: row.creditLimit,
    }));
  }
  if (name === "transaction") {
    const rows = [];
    for (const order of session.rows("sales-orders")) {
      if (!inScope(session, order.subsidiaryId)) continue;
      rows.push({
        id: order.id, type: "SalesOrd", entity: order.entityId, trandate: order.tranDate,
        tranid: order.tranId, status: soStatus(order.status).refName, foreigntotal: order.total,
        memo: order.memo, subsidiary: order.subsidiaryId, duedate: null, createdfrom: null,
      });
    }
    for (const invoice of session.rows("invoices")) {
      if (!inScope(session, invoice.subsidiaryId)) continue;
      rows.push({
        id: invoice.id, type: "CustInvc", entity: invoice.entityId, trandate: invoice.tranDate,
        tranid: invoice.tranId, status: invStatus(invoice.status).refName, foreigntotal: invoice.total,
        memo: invoice.memo, subsidiary: invoice.subsidiaryId, duedate: invoice.dueDate,
        createdfrom: invoice.createdFromId,
      });
    }
    for (const payment of session.rows("customer-payments")) {
      if (!inScope(session, payment.subsidiaryId)) continue;
      rows.push({
        id: payment.id, type: "CustPymt", entity: payment.entityId, trandate: payment.tranDate,
        tranid: payment.tranId, status: payStatus(payment.status).refName, foreigntotal: payment.payment,
        memo: payment.memo, subsidiary: payment.subsidiaryId, duedate: null, createdfrom: null,
      });
    }
    rows.sort((left, right) => Number(left.id) - Number(right.id));
    return rows;
  }
  if (name === "transactionLine") {
    const rows = [];
    const push = (record) => {
      if (!inScope(session, record.subsidiaryId)) return;
      for (const line of record.lines) {
        rows.push({
          id: `${record.id}.${line.line}`,
          transaction: record.id,
          linesequencenumber: line.line,
          item: line.itemId,
          quantity: line.quantity,
          rate: line.rate,
          netamount: line.amount,
          subsidiary: record.subsidiaryId,
        });
      }
    };
    for (const order of session.rows("sales-orders")) push(order);
    for (const invoice of session.rows("invoices")) push(invoice);
    return rows;
  }
  if (name === "item") {
    return session.rows("items")
      .filter((row) => row.subsidiaryIds.some((id) => inScope(session, id)))
      .map((row) => ({
        id: row.id, itemid: row.itemId, displayname: row.displayName, description: row.description,
        baseprice: row.basePrice, cost: row.cost, quantityonhand: row.quantityOnHand,
        itemtype: row.itemType === "inventoryItem" ? "InvtPart" : "Service",
        isinactive: row.isInactive ? "T" : "F",
      }));
  }
  if (name === "employee") {
    return session.rows("employees").filter((row) => inScope(session, row.subsidiaryId)).map((row) => ({
      id: row.id, entityid: row.entityId, firstname: row.firstName, lastname: row.lastName,
      email: row.email, title: row.title, subsidiary: row.subsidiaryId, supervisor: row.supervisorId,
      isinactive: row.isInactive ? "T" : "F",
    }));
  }
  return session.rows("subsidiaries").filter((row) => inScope(session, row.id)).map((row) => ({
    id: row.id, name: row.name, parent: row.parentId, country: row.country,
    currency: row.currencyName, isinactive: row.isInactive ? "T" : "F",
  }));
}

/** Display names for BUILTIN.DF, resolved once per request. */
export function displayIndex(session) {
  const index = new Map();
  index.set("customer", new Map(session.rows("customers").map((row) => [row.id, row.entityId])));
  index.set("item", new Map(session.rows("items").map((row) => [row.id, row.itemId])));
  index.set("subsidiary", new Map(session.rows("subsidiaries").map((row) => [row.id, row.name])));
  index.set("employee", new Map(session.rows("employees").map((row) => [row.id, row.entityId])));
  const transactions = new Map();
  for (const order of session.rows("sales-orders")) transactions.set(order.id, order.tranId);
  for (const invoice of session.rows("invoices")) transactions.set(invoice.id, invoice.tranId);
  for (const payment of session.rows("customer-payments")) transactions.set(payment.id, payment.tranId);
  index.set("transaction", transactions);
  return index;
}
