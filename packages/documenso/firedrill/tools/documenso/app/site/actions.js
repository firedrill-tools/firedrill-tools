// Document actions shared by the documents table and the document page: primary action button, ⋯ menu and dialogs.
import { icon } from "./icons.js";
import { avatar, confirm, dialog, menu, notSimulated } from "./overlay.js";
import { app, go, isOwnEmail } from "./state.js";
import { button, call, describe, el, newKey, run, toast } from "./ui.js";

const ownRecipient = (doc) => doc.recipients.find((r) => isOwnEmail(r.email));
const canManage = (doc) => doc.user.id === app.workspace.user.id || doc.teamId === app.workspace.team.id;

/** The coloured primary action of a row, mirroring the web app's rules. */
export function actionButton(doc) {
  const r = ownRecipient(doc);
  if (r?.role === "CC" && doc.status !== "COMPLETED") return el("div");
  if (doc.status === "DRAFT" && canManage(doc)) return linkButton("Edit", "edit", `#/documents/${doc.id}/edit`);
  if (r && doc.status === "PENDING" && r.signingStatus === "NOT_SIGNED") {
    const [label, name] = r.role === "SIGNER" ? ["Sign", "pencil"] : r.role === "APPROVER" ? ["Approve", "checkCircle"] : ["View", "eye"];
    return linkButton(label, name, `#/sign/${encodeURIComponent(r.token)}`);
  }
  if (doc.status === "PENDING" && r?.signingStatus === "SIGNED") return button("View", { iconName: "eye", cls: "btn-w32", disabled: true });
  if (doc.status === "PENDING") return linkButton("View", "eye", `#/documents/${doc.id}`);
  if (doc.status === "COMPLETED") return button("Download", { iconName: "download", cls: "btn-w32", onClick: () => notSimulated("Downloading the signed PDF", "This Tool stores documents as text and never renders or seals a PDF.") });
  return el("div");
}

function linkButton(label, iconName, href) {
  return el("a", { class: "btn btn-default btn-w32", attrs: { href } }, [icon(iconName, "btn-ic"), document.createTextNode(label)]);
}

export function documentMenu(anchor, doc, onChanged) {
  const pending = doc.status === "PENDING";
  menu(anchor, [
    { heading: "Action" },
    { label: "Edit", iconName: "edit", disabled: doc.status !== "DRAFT", onClick: () => go(`#/documents/${doc.id}/edit`) },
    { label: "Download", iconName: "download", onClick: () => notSimulated("Downloading PDFs", "This Tool stores documents as text and never renders or seals a PDF.") },
    { label: "Download Original", iconName: "download", onClick: () => notSimulated("Downloading PDFs") },
    { label: "Duplicate", iconName: "copy", onClick: () => duplicateDocument(doc) },
    { label: "Move to Folder", iconName: "folder", onClick: () => notSimulated("Folders") },
    { label: "Save as Template", iconName: "fileText", onClick: () => notSimulated("Saving a document as a template") },
    { label: "Signing Links", iconName: "link", disabled: !pending, onClick: () => signingLinksDialog(doc) },
    { label: "Resend", iconName: "mail", disabled: !pending || doc.recipients.every((r) => r.signingStatus !== "NOT_SIGNED"), onClick: () => resendDialog(doc, onChanged) },
    { label: "Cancel", iconName: "xCircle", disabled: !pending, onClick: () => cancelDialog(doc, onChanged) },
    { label: "Delete", iconName: "trash", onClick: () => deleteDialog(doc, onChanged) },
  ], { width: 208 });
}

export function duplicateDocument(doc) {
  return run(async () => {
    const copy = await call("documents.duplicate", { documentId: doc.id }, newKey());
    toast("Document duplicated", { title: "Document Duplicated" });
    go(`#/documents/${copy.documentId}/edit`);
  });
}

export function signingLinksDialog(doc) {
  const d = dialog({ title: "Copy Signing Links", description: "You can copy and share these links to recipients so they can action the document. In this simulation a link opens the in-app signing page." });
  const list = el("div", { class: "link-list" });
  for (const r of doc.recipients.filter((x) => x.role !== "CC")) {
    const href = `#/sign/${encodeURIComponent(r.token)}`;
    list.append(el("div", { class: "link-row" }, [avatar(r.name || r.email, "unsigned", "avatar-sm"), el("div", { class: "grow" }, [el("div", { text: r.name ? `${r.name} (${r.email})` : r.email }), el("div", { class: "url", text: `/sign/${r.token}` })]),
      el("a", { class: "btn btn-outline btn-sm", text: "Open", attrs: { href }, on: { click: () => d.close() } })]));
  }
  d.body.append(list);
  d.footer.append(button("Done", { variant: "secondary", onClick: d.close }));
}

export function resendDialog(doc, onChanged) {
  const d = dialog({ title: "Resend Document", description: "Send a reminder to the recipients who still have to act." });
  const boxes = [];
  for (const r of doc.recipients.filter((x) => x.signingStatus === "NOT_SIGNED" && x.role !== "CC")) {
    const id = `resend-${r.id}`;
    const box = el("input", { attrs: { type: "checkbox", id, value: r.id } });
    boxes.push(box);
    d.body.append(el("label", { class: "check", attrs: { for: id } }, [box, el("span", { text: r.name ? `${r.name} (${r.email})` : r.email })]));
  }
  const key = newKey();
  const send = button("Send reminder", { onClick: () => run(async () => {
    const recipients = boxes.filter((b) => b.checked).map((b) => Number(b.value));
    if (recipients.length === 0) return d.setError("Select at least one recipient.");
    await call("documents.redistribute", { documentId: doc.id, recipients }, key);
    d.close();
    toast("The document has been resent to the selected recipients.", { title: "Document re-sent" });
    await onChanged?.();
  }, { onError: (e) => d.setError(describe(e)) }) });
  d.footer.append(button("Cancel", { variant: "secondary", onClick: d.close }), send);
}

export function cancelDialog(doc, onChanged) {
  const d = dialog({ title: "Cancel document", description: "Recipients will no longer be able to sign this document. The document stays in your list as a record that it was distributed." });
  const reason = el("textarea", { class: "input", attrs: { id: "cancel-reason", maxlength: 500, placeholder: "Reason for cancellation (optional)" } });
  d.body.append(el("div", { class: "form-row" }, [el("label", { class: "label", text: "Reason", attrs: { for: "cancel-reason" } }), reason]));
  const key = newKey();
  d.footer.append(button("Keep document", { variant: "secondary", onClick: d.close }), button("Cancel document", { variant: "destructive", onClick: () => run(async () => {
    await call("envelopes.cancel", { envelopeId: doc.envelopeId, reason: reason.value.trim() || null }, key);
    d.close();
    toast("The document has been cancelled.", { title: "Document cancelled" });
    await onChanged?.();
  }, { onError: (e) => d.setError(describe(e)) }) }));
}

export function deleteDialog(doc, onChanged) {
  const d = dialog({ title: "Are you sure?", description: doc.status === "DRAFT"
    ? `You are about to delete "${doc.title}". This draft will be permanently removed.`
    : `You are about to delete "${doc.title}". Pending documents are cancelled for every recipient and hidden from your list.` });
  const typed = el("input", { class: "input", attrs: { id: "delete-confirm", placeholder: "Type 'delete' to confirm", autocomplete: "off" } });
  if (doc.status !== "DRAFT") d.body.append(el("div", { class: "form-row" }, [el("label", { class: "label", text: "Please type delete to confirm", attrs: { for: "delete-confirm" } }), typed]));
  const key = newKey();
  const ok = button("Delete", { variant: "destructive", onClick: () => run(async () => {
    if (doc.status !== "DRAFT" && typed.value.trim().toLowerCase() !== "delete") return d.setError("Type delete to confirm.");
    await call("documents.delete", { documentId: doc.id }, key);
    d.close();
    toast("Document deleted", { title: "Document deleted" });
    if (location.hash.startsWith(`#/documents/${doc.id}`)) go("#/documents");
    else await onChanged?.();
  }, { onError: (e) => d.setError(describe(e)) }) });
  d.footer.append(button("Cancel", { variant: "secondary", onClick: d.close }), ok);
}

export { confirm };
