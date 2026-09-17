// Document page (non-draft view) and its audit log page.
import { cancelDialog, documentMenu, resendDialog } from "./actions.js";
import { auditText, recentActivity } from "./activity.js";
import { icon } from "./icons.js";
import { avatar, mediumDate, notSimulated, recipientType, relative, stackAvatars, STATUS, statusChip } from "./overlay.js";
import { documentViewer } from "./pages.js";
import { pagination } from "./table.js";
import { app, go, isOwnEmail, setParams } from "./state.js";
import { button, call, el, tooltip } from "./ui.js";

const ROLE_DONE = { SIGNER: "Signed", APPROVER: "Approved", VIEWER: "Viewed", CC: "CC", ASSISTANT: "Assisted" };

export function titleBlock(doc, backHref = "#/documents", backLabel = "Documents") {
  return el("div", {}, [
    el("a", { class: "back-link", attrs: { href: backHref } }, [icon("chevronLeft"), el("span", { text: backLabel })]),
    el("h1", { class: "doc-title", text: doc.title, title: doc.title }),
    el("div", { class: "doc-meta" }, [
      statusChip(doc.status, { inherit: true }),
      doc.recipients.length ? el("div", { class: "doc-meta-recipients" }, [icon("users"), stackAvatars(doc.recipients, doc.status, { label: `${doc.recipients.length} Recipient${doc.recipients.length === 1 ? "" : "s"}` })]) : null,
    ]),
  ]);
}

export async function renderDocument(main, id) {
  let doc = await call("documents.get", { documentId: id });
  if (doc.status === "DRAFT") { go(`#/documents/${doc.id}/edit`); return {}; }
  const ws = app.workspace;
  const host = el("div", { class: "container doc-container" });
  main.replaceChildren(host);

  // documents.get carries only userId; the sender's display name comes from the matching documents.find row.
  let senderName;
  async function lookupSender() {
    if (doc.userId === ws.user.id) return;
    const found = await call("documents.find", { query: doc.title.slice(0, 255), perPage: 100 }).catch(() => null);
    senderName = found?.data.find((row) => row.id === doc.id)?.user.name;
  }
  async function refresh() {
    doc = await call("documents.get", { documentId: id });
    await lookupSender();
    draw();
  }
  await lookupSender();
  function draw() {
    const pendingCount = doc.recipients.filter((r) => r.signingStatus === "NOT_SIGNED").length;
    const summary = {
      COMPLETED: "This document has been signed by all recipients", REJECTED: "This document has been rejected by a recipient",
      CANCELLED: "This document has been cancelled", DRAFT: "This document is currently a draft and has not been sent",
      PENDING: `Waiting on ${pendingCount} recipient${pendingCount === 1 ? "" : "s"}`,
    }[doc.status];
    const more = el("button", { class: "more-btn", attrs: { type: "button", "aria-label": "Document actions", "aria-haspopup": "menu", "aria-expanded": "false" } }, icon("more"));
    more.addEventListener("click", () => documentMenu(more, { ...doc, user: { id: doc.userId } }, refresh));
    const mine = doc.recipients.find((r) => isOwnEmail(r.email) && r.signingStatus === "NOT_SIGNED" && r.role !== "CC");
    let primary = null;
    if (doc.status === "PENDING" && mine) primary = el("a", { class: "btn btn-default btn-block", attrs: { href: `#/sign/${encodeURIComponent(mine.token)}` } }, [icon("signature", "btn-ic"), document.createTextNode(mine.role === "APPROVER" ? "Approve" : mine.role === "VIEWER" ? "View" : "Sign")]);
    else if (doc.status === "PENDING") primary = button("Resend", { iconName: "mail", cls: "btn-block", disabled: doc.documentMeta.distributionMethod !== "EMAIL" || pendingCount === 0, onClick: () => resendDialog(doc, refresh) });
    else if (doc.status === "COMPLETED") primary = button("Download", { iconName: "download", cls: "btn-block", onClick: () => notSimulated("Downloading the signed PDF", "This Tool stores documents as text and never renders or seals a PDF.") });

    const recipients = el("ul", { class: "widget-list" });
    for (const r of doc.recipients) {
      const type = recipientType(r, doc.status);
      const badge = r.signingStatus === "SIGNED" ? el("span", { class: "badge badge-green" }, [icon("checkCircle"), el("span", { text: ROLE_DONE[r.role] ?? "Signed" })])
        : r.signingStatus === "REJECTED" ? tooltip(el("span", { class: "badge badge-red", attrs: { tabindex: "0" } }, [icon("xCircle"), el("span", { text: "Rejected" })]), `Reason: ${r.rejectionReason || "No reason given"}`)
          : r.role === "CC" ? el("span", { class: "badge badge-muted", text: "CC" })
            : doc.status === "PENDING" ? el("span", { class: "badge badge-muted" }, [icon("clock"), el("span", { text: r.readStatus === "OPENED" ? "Viewed" : "Pending" })]) : null;
      recipients.append(el("li", { class: "widget-row" }, [avatar(r.name || r.email, type, "avatar-sm"), el("div", { class: "grow" }, [el("div", { class: "row-email", text: r.email }), el("div", { class: "row-sub", text: r.name || r.role.charAt(0) + r.role.slice(1).toLowerCase() })]), badge]));
    }
    const left = documentViewer(doc.documentData.data, { fields: doc.status === "COMPLETED" ? doc.fields.filter((f) => f.inserted) : doc.fields, recipients: doc.recipients });
    const activity = el("section", { class: "widget" }, [el("h3", { class: "widget-title", text: "Recent activity" }), el("div", { class: "muted pad", text: "Loading…" })]);
    host.replaceChildren(titleBlock(doc), el("div", { class: "doc-grid" }, [
      el("div", { class: "doc-left" }, left),
      el("div", { class: "doc-right" }, [
        el("section", { class: "widget" }, [
          el("div", { class: "widget-head" }, [el("h3", { class: "widget-title big", text: STATUS[doc.status]?.ext ?? doc.status }), more]),
          el("p", { class: "widget-sub", text: summary }),
          doc.status === "PENDING" ? el("div", { class: "widget-foot two" }, [primary, button("Cancel document", { variant: "outline", iconName: "xCircle", onClick: () => cancelDialog(doc, refresh) })]) : primary ? el("div", { class: "widget-foot" }, primary) : null,
        ]),
        el("section", { class: "widget" }, [el("h3", { class: "widget-title", text: "Information" }), el("ul", { class: "widget-list info" }, [
          infoRow("Uploaded by", doc.userId === ws.user.id ? "You" : senderName ?? `Team member #${doc.userId}`),
          infoRow("Created", mediumDate(doc.createdAt)), infoRow("Last modified", relative(doc.updatedAt, ws.now)),
          doc.completedAt ? infoRow("Completed", mediumDate(doc.completedAt)) : null, infoRow("Document ID", String(doc.id)),
        ])]),
        el("section", { class: "widget" }, [el("h3", { class: "widget-title", text: "Recipients" }), recipients]),
        activity,
      ]),
    ]));
    void recentActivity(doc, ws).then((node) => activity.replaceWith(node));
  }
  draw();
  return { refresh };
}

const infoRow = (label, value) => el("li", { class: "info-row" }, [el("span", { class: "muted", text: label }), el("span", { text: value })]);

export async function renderLogs(main, id, params) {
  const page = Math.max(1, Number.parseInt(params.get("page") ?? "1", 10) || 1);
  const perPage = [10, 20, 30, 40, 50].includes(Number(params.get("perPage"))) ? Number(params.get("perPage")) : 10;
  const host = el("div", { class: "container doc-container" });
  main.replaceChildren(host);
  async function refresh() {
    const doc = await call("documents.get", { documentId: id });
    const logs = await call("envelopes.audit_log", { envelopeId: doc.envelopeId, page, perPage });
    const body = el("tbody");
    for (const log of logs.data) body.append(el("tr", {}, [el("td", { text: mediumDate(log.createdAt) }), el("td", {}, log.name || log.email ? el("div", {}, [el("div", { text: log.name || log.email }), log.name ? el("div", { class: "row-sub", text: log.email }) : null]) : el("span", { class: "muted", text: "System" })),
      el("td", { text: auditText(log) }), el("td", { class: "muted", text: log.ipAddress ?? "N/A" }), el("td", { class: "muted", text: log.userAgent ?? "N/A" })]));
    host.replaceChildren(titleBlock(doc, `#/documents/${doc.id}`, "Document"),
      el("div", { class: "logs-meta" }, [el("span", { text: `Document ID ${doc.id}` }), el("span", { text: `Envelope ${doc.envelopeId}` }), el("span", { text: `Created ${mediumDate(doc.createdAt)}` })]),
      el("div", { class: "table-wrap" }, el("table", { class: "data" }, [el("thead", {}, el("tr", {}, ["Time", "User", "Action", "IP Address", "Browser"].map((h) => el("th", { text: h })))), body])),
      pagination(logs, (changes) => setParams(changes)));
  }
  await refresh();
  return { refresh };
}
