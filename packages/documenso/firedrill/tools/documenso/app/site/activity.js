// Audit log wording and the document page's "Recent activity" widget (envelopes.audit_log).
import { icon } from "./icons.js";
import { relative } from "./overlay.js";
import { call, describe, el } from "./ui.js";

const who = (log) => log.name || log.email || "System";

export function auditText(log) {
  const d = log.data ?? {};
  const actor = who(log);
  switch (log.type) {
    case "DOCUMENT_CREATED": return `${actor} created the document`;
    case "DOCUMENT_SENT": return `${actor} sent the document`;
    case "EMAIL_SENT": return `Email sent to ${d.recipientEmail ?? d.recipientName ?? "a recipient"}`;
    case "DOCUMENT_OPENED": return `${actor} opened the document`;
    case "DOCUMENT_FIELD_INSERTED": return `${actor} inserted a ${String(d.fieldType ?? "").toLowerCase() || "field"} field`;
    case "DOCUMENT_FIELD_UNINSERTED": return `${actor} removed a field value`;
    case "DOCUMENT_RECIPIENT_COMPLETED": return `${actor} ${d.recipientRole === "APPROVER" ? "approved" : d.recipientRole === "VIEWER" ? "viewed" : "signed"} the document`;
    case "DOCUMENT_RECIPIENT_REJECTED": return `${actor} rejected the document`;
    case "DOCUMENT_COMPLETED": return "All recipients have signed the document";
    case "DOCUMENT_CANCELLED": return `${actor} cancelled the document`;
    case "DOCUMENT_DELETED": return `${actor} deleted the document`;
    case "DOCUMENT_TITLE_UPDATED": return `${actor} updated the document title`;
    case "DOCUMENT_VISIBILITY_UPDATED": return `${actor} updated the document visibility`;
    case "DOCUMENT_EXTERNAL_ID_UPDATED": return `${actor} updated the document external ID`;
    case "DOCUMENT_META_UPDATED": return `${actor} updated the document settings`;
    case "RECIPIENT_CREATED": return `${actor} added a recipient`;
    case "RECIPIENT_UPDATED": return `${actor} updated a recipient`;
    case "RECIPIENT_DELETED": return `${actor} removed a recipient`;
    case "FIELD_CREATED": return `${actor} added a field`;
    case "FIELD_DELETED": return `${actor} removed a field`;
    default: return `${actor}: ${log.type.toLowerCase().replaceAll("_", " ")}`;
  }
}

const ICON = { DOCUMENT_COMPLETED: "checkCircle", DOCUMENT_RECIPIENT_COMPLETED: "checkCircle", DOCUMENT_RECIPIENT_REJECTED: "xCircle", DOCUMENT_CANCELLED: "xCircle", DOCUMENT_OPENED: "eye", EMAIL_SENT: "mail", DOCUMENT_SENT: "send" };

export async function recentActivity(doc, ws) {
  const section = el("section", { class: "widget" }, el("h3", { class: "widget-title", text: "Recent activity" }));
  try {
    const logs = await call("envelopes.audit_log", { envelopeId: doc.envelopeId, page: 1, perPage: 10 });
    const list = el("ul", { class: "timeline" });
    for (const log of logs.data) {
      list.append(el("li", { class: "timeline-row" }, [
        el("span", { class: "timeline-dot" }, icon(ICON[log.type] ?? "circleDot")),
        el("div", { class: "grow" }, [el("div", { class: "timeline-text", text: auditText(log) }), el("div", { class: "row-sub", text: relative(log.createdAt, ws.now) })]),
      ]));
    }
    if (logs.data.length === 0) list.append(el("li", { class: "muted pad", text: "No recent activity" }));
    section.append(list);
    if (logs.count > 0) section.append(el("div", { class: "widget-foot" }, el("a", { class: "btn btn-outline btn-block", text: logs.count > logs.data.length ? `View more (${logs.count})` : "View audit log", attrs: { href: `#/documents/${doc.id}/logs` } })));
  } catch (error) {
    section.append(el("div", { class: "muted pad", attrs: { role: "alert" }, text: describe(error) }));
  }
  return section;
}
