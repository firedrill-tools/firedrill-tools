// Firedrill events mirroring the provider's webhook vocabulary: object.created / object.updated / object.deleted
// with object types crm_contact, crm_company, crm_deal and messaging_message. A create emits both created and
// updated (the provider documents that "updated" fires for newly created records too).

function payload(connection, objectType, objectId) {
  return {
    workspace_id: connection.workspace_id,
    connection_id: connection.id,
    object_type: objectType,
    object_id: objectId,
    external_xref: connection.external_xref ?? null,
  };
}

export function emitCreated(context, connection, objectType, objectId) {
  context.events.emit("object.created", payload(connection, objectType, objectId));
  context.events.emit("object.updated", { ...payload(connection, objectType, objectId), changed_fields: ["*"] });
}

export function emitUpdated(context, connection, objectType, objectId, changedFields) {
  if (changedFields.length === 0) return;
  context.events.emit("object.updated", { ...payload(connection, objectType, objectId), changed_fields: changedFields.slice(0, 64) });
}

export function emitDeleted(context, connection, objectType, objectId) {
  context.events.emit("object.deleted", payload(connection, objectType, objectId));
}
