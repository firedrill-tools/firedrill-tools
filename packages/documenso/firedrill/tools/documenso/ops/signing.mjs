// signing.get, signing.complete (authorised by the recipient's signing token) and workspace.context.
import { parseId, resolveCaller } from "../lib/caller.mjs";
import { formatDate } from "../lib/dates.mjs";
import { bad, invalid, notFound } from "../lib/errors.mjs";
import { eventPayload, renderField, renderMeta, renderRecipient, userMini } from "../lib/render.mjs";
import { audit, fieldsOf, recipientsOf, scanPrefix } from "../lib/store.mjs";
import { assertDocumentFits, assertReadable } from "../lib/size.mjs";
import { iso, isObject, isoOrNull, monthOf, pad10 } from "../lib/util.mjs";
import { ACTION_ROLES } from "../lib/validate.mjs";
import { checkCanReject, rejectCore, rejectionReason } from "./recipients.mjs";

const AUTO = new Set(["NAME", "EMAIL", "DATE"]);
const NOT_YOUR_TURN = "It is not your turn to sign";

function byToken(context, token) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(token)) notFound(context, "Recipient");
  const ref = context.state.get("recipient-tokens", token);
  const r = ref === null ? null : context.state.get("recipients", pad10(ref.recipientId));
  if (r === null || r.parentKind !== "document") notFound(context, "Recipient");
  const doc = context.state.get("documents", pad10(r.parentId));
  if (doc === null || doc.deletedAtUs !== null || doc.status === "DRAFT") notFound(context, "Recipient");
  return { r, doc };
}

function blocker(doc, recipients, r) {
  if (doc.status === "COMPLETED") return "Document has already been completed";
  if (doc.status === "REJECTED") return "Document has been rejected";
  if (doc.status === "CANCELLED") return "Document has been cancelled";
  if (r.role === "CC") return "CC recipients do not sign documents";
  if (r.signingStatus === "SIGNED") return "You have already completed this document";
  if (r.signingStatus === "REJECTED") return "You have rejected this document";
  if (doc.meta.signingOrder === "SEQUENTIAL") {
    const order = (o) => o.signingOrder ?? 1001;
    const waiting = recipients.filter((o) => ACTION_ROLES.has(o.role) && o.signingStatus === "NOT_SIGNED").map(order);
    if (order(r) > Math.min(...waiting)) return NOT_YOUR_TURN;
  }
  return null;
}

const self = (r) => ({ name: r.name || r.email, email: r.email, userId: null });

export function getSigning(input, context) {
  let { r, doc } = byToken(context, input.token);
  let recipients = recipientsOf(context, "document", doc.id);
  const fields = fieldsOf(context, "document", doc.id);
  if (doc.status === "PENDING" && r.readStatus === "NOT_OPENED") {
    const opened = { ...r, readStatus: "OPENED" };
    context.state.put("recipients", pad10(r.id), opened);
    audit(context, doc.envelopeId, "DOCUMENT_OPENED", self(r), { recipientId: r.id, recipientEmail: r.email });
    recipients = recipients.map((o) => (o.id === r.id ? opened : o));
    r = opened;
  }
  const reason = blocker(doc, recipients, r);
  return assertReadable(context, {
    recipient: renderRecipient(r, doc),
    document: {
      id: doc.id, envelopeId: doc.envelopeId, title: doc.title, status: doc.status, content: doc.content, pageCount: doc.pageCount,
      documentMeta: renderMeta(doc), teamName: context.state.get("teams", pad10(doc.teamId))?.name ?? "", senderName: userMini(context, doc.userId).name,
    },
    fields: fields.map((f) => ({ ...renderField(f, doc), own: f.recipientId === r.id })), canSign: reason === null, reasonIfNot: reason,
  });
}

function collectValues(context, list, own) {
  if (list === undefined) return new Map();
  if (!Array.isArray(list)) bad(context, "values must be an array");
  const byId = new Map(own.map((f) => [f.id, f]));
  const values = new Map();
  for (const item of list) {
    if (!isObject(item)) bad(context, "each value must be an object");
    const id = parseId(context, item.fieldId, "fieldId");
    if (values.has(id)) bad(context, `Field ${id} has more than one value`);
    const f = byId.get(id);
    if (f === undefined) invalid(context, `Field ${id} is not assigned to this recipient`);
    if (AUTO.has(f.type)) invalid(context, `${f.type} fields are filled in automatically`);
    if (f.type === "CHECKBOX") {
      if (typeof item.value !== "boolean") bad(context, "CHECKBOX values must be booleans");
      values.set(id, item.value ? "true" : "false");
    } else {
      const limit = f.fieldMeta?.characterLimit > 0 ? Math.min(f.fieldMeta.characterLimit, 1000) : 1000;
      if (typeof item.value !== "string" || item.value.trim().length === 0 || item.value.length > limit) {
        bad(context, `${f.type} values must be between 1 and ${limit} characters`);
      }
      values.set(id, item.value);
    }
  }
  return values;
}

export function completeSigning(input, context) {
  const { r, doc } = byToken(context, input.token);
  if (input.values !== undefined && input.reject !== undefined) bad(context, "Provide either values or reject, not both");
  const recipients = recipientsOf(context, "document", doc.id);
  const reason = blocker(doc, recipients, r);
  if (input.reject !== undefined) {
    const text = rejectionReason(context, isObject(input.reject) ? input.reject.reason : undefined);
    if (reason !== null && reason !== NOT_YOUR_TURN) invalid(context, reason);
    checkCanReject(context, doc, r);
    rejectCore(context, doc, r, text, self(r));
    return { recipientStatus: "REJECTED", documentStatus: "REJECTED", completedAt: null };
  }
  const own = fieldsOf(context, "document", doc.id).filter((f) => f.recipientId === r.id);
  const values = collectValues(context, input.values, own);
  if (reason !== null) invalid(context, reason);
  const now = context.clock.nowUs();
  for (const f of own) {
    let text;
    if (f.type === "NAME") text = r.name || r.email;
    else if (f.type === "EMAIL") text = r.email;
    else if (f.type === "DATE") text = formatDate(now, doc.meta.dateFormat, doc.meta.timezone);
    else if (values.has(f.id)) text = values.get(f.id);
    else if (f.type === "SIGNATURE" || f.type === "INITIALS" || f.fieldMeta?.required === true) invalid(context, "Missing required field values");
    else continue;
    context.state.put("fields", pad10(f.id), { ...f, inserted: true, customText: text.slice(0, 1000) });
    audit(context, doc.envelopeId, "DOCUMENT_FIELD_INSERTED", self(r), { fieldId: f.id, fieldType: f.type });
  }
  const signed = { ...r, readStatus: "OPENED", signingStatus: "SIGNED", signedAtUs: now };
  context.state.put("recipients", pad10(r.id), signed);
  audit(context, doc.envelopeId, "DOCUMENT_RECIPIENT_COMPLETED", self(r), { recipientId: r.id, recipientEmail: r.email, recipientRole: r.role });
  const after = recipients.map((o) => (o.id === r.id ? signed : o));
  const next = { ...doc, updatedAtUs: now };
  if (after.filter((o) => ACTION_ROLES.has(o.role)).every((o) => o.signingStatus === "SIGNED")) {
    next.status = "COMPLETED";
    next.completedAtUs = now;
    audit(context, doc.envelopeId, "DOCUMENT_COMPLETED", null, {});
    context.events.emit("document.completed", eventPayload(next, after));
  }
  context.state.put("documents", pad10(doc.id), next);
  assertDocumentFits(context, doc.id);
  return { recipientStatus: "SIGNED", documentStatus: next.status, completedAt: isoOrNull(next.completedAtUs) };
}

export function workspaceContext(_input, context) {
  const caller = resolveCaller(context);
  const teams = [];
  for (const { value } of scanPrefix(context, "user-teams", `${pad10(caller.userId)}/`)) {
    const team = context.state.get("teams", pad10(value.teamId));
    const member = context.state.get("team-members", `${pad10(value.teamId)}/${pad10(caller.userId)}`);
    if (team !== null && member !== null) teams.push({ id: team.id, name: team.name, url: team.url, role: member.role });
  }
  const now = context.clock.nowUs();
  const month = monthOf(now);
  const usage = context.state.get("usage", `${pad10(caller.teamId)}/${month}`);
  return {
    now: iso(now), user: userMini(context, caller.userId),
    team: { id: caller.team.id, name: caller.team.name, url: caller.team.url, role: caller.role, plan: caller.team.plan }, teams,
    usage: { month, documentsCreated: usage?.documentsCreated ?? 0, monthlyDocumentLimit: caller.team.monthlyDocumentLimit },
  };
}
