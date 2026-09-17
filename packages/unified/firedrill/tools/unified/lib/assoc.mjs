// Symmetric CRM associations: a contact's `company_ids` mirrors each company's `contact_ids`, and so on. Only rows
// whose membership actually changes are rewritten (each rewrite emits object.updated for that row). References are
// checked with point lookups by id, never by rescanning the namespace.
import { badRequest } from "./errors.mjs";
import { emitUpdated } from "./events.mjs";
import { getRow, putRow } from "./store.mjs";
import { nowIso } from "./time.mjs";
import { clip } from "./util.mjs";

/** namespace -> { objectType, links: { field: [target namespace, reverse field] } } */
export const CRM = {
  contacts: { objectType: "crm_contact", label: "Contact", links: { company_ids: ["companies", "contact_ids"], deal_ids: ["deals", "contact_ids"] } },
  companies: { objectType: "crm_company", label: "Company", links: { contact_ids: ["contacts", "company_ids"], deal_ids: ["deals", "company_ids"] } },
  deals: { objectType: "crm_deal", label: "Deal", links: { contact_ids: ["contacts", "deal_ids"], company_ids: ["companies", "deal_ids"] } },
};

const LABEL = { contacts: "contact", companies: "company", deals: "deal" };

/** Every referenced id must be a row of the same connection. */
export function checkReferences(context, connectionId, namespace, fields) {
  for (const [field, [target]] of Object.entries(CRM[namespace].links)) {
    const ids = fields[field];
    if (!Array.isArray(ids)) continue;
    for (const id of ids) {
      if (getRow(context, target, connectionId, id) === null) badRequest(context, `Unknown ${LABEL[target]} id in ${field}: ${clip(id, 40)}`);
    }
  }
}

function rewrite(context, connection, target, row, reverseField, ids) {
  const next = { ...row, [reverseField]: ids, updated_at: nowIso(context) };
  putRow(context, target, next);
  emitUpdated(context, connection, CRM[target].objectType, row.id, [reverseField]);
}

/** Adds `ownId` to the reverse arrays of newly linked rows and removes it from rows no longer linked. */
export function syncAssociations(context, connection, namespace, row, previous) {
  for (const [field, [target, reverseField]] of Object.entries(CRM[namespace].links)) {
    const before = new Set(previous === null ? [] : previous[field] ?? []);
    const after = new Set(row[field] ?? []);
    for (const id of after) {
      if (before.has(id)) continue;
      const other = getRow(context, target, connection.id, id);
      if (other === null) continue;
      const ids = other[reverseField] ?? [];
      if (!ids.includes(row.id)) rewrite(context, connection, target, other, reverseField, [...ids, row.id]);
    }
    for (const id of before) {
      if (after.has(id)) continue;
      const other = getRow(context, target, connection.id, id);
      if (other === null) continue;
      const ids = other[reverseField] ?? [];
      if (ids.includes(row.id)) rewrite(context, connection, target, other, reverseField, ids.filter((entry) => entry !== row.id));
    }
  }
}

/** Removes a deleted row's id from every associated row. */
export function detachAll(context, connection, namespace, row) {
  syncAssociations(context, connection, namespace, { ...row, contact_ids: [], company_ids: [], deal_ids: [] }, row);
}
