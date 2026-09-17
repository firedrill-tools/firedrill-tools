// Signing page (#/sign/<token>): signing.get to open, signing.complete to sign/approve/view or reject.
import { icon } from "./icons.js";
import { dialog } from "./overlay.js";
import { documentViewer, FIELD_LABEL } from "./pages.js";
import { button, call, describe, el, newKey, run, toast } from "./ui.js";

const VERB = { SIGNER: ["Sign Document", "sign", "Complete"], APPROVER: ["Approve Document", "approve", "Approve"], VIEWER: ["View Document", "view", "Mark as viewed"], ASSISTANT: ["Assist Document", "assist", "Complete"], CC: ["View Document", "view", "Close"] };
const TYPED = new Set(["SIGNATURE", "INITIALS", "TEXT"]);

export async function renderSign(main, token) {
  let data = await call("signing.get", { token });
  const values = new Map();
  let done = null;
  const host = el("div", { class: "container doc-container sign-page" });
  main.replaceChildren(host);

  function draw() {
    const { recipient: r, document: doc, fields, canSign, reasonIfNot } = data;
    const [heading, verb, completeLabel] = VERB[r.role] ?? VERB.SIGNER;
    const own = fields.filter((f) => f.own && !f.inserted);
    const needsValue = own.filter((f) => TYPED.has(f.type) || f.type === "CHECKBOX");
    const missing = own.filter((f) => (f.type === "SIGNATURE" || f.type === "INITIALS" || f.fieldMeta?.required) && !values.has(f.id));
    if (done) return drawDone(doc, r);
    const viewer = documentViewer(doc.content, {
      fields: fields.map((f) => (values.has(f.id) ? { ...f, inserted: true, customText: String(values.get(f.id)) } : f)),
      recipients: [r],
      highlight: (f) => f.own,
      fieldNode: (f) => {
        if (!f.own || f.inserted || !canSign || !needsValue.includes(needsValue.find((x) => x.id === f.id))) return [];
        const hit = el("button", { class: "field-hit", attrs: { type: "button", "aria-label": `Fill ${FIELD_LABEL[f.type]} field` } });
        hit.addEventListener("click", () => fillField(f));
        return [hit];
      },
    });
    const panel = el("section", { class: "widget sign-panel" }, [
      el("h3", { class: "widget-title big", text: heading }),
      el("p", { class: "widget-sub", text: canSign ? `Please review the document before you ${verb}.` : reasonIfNot }),
    ]);
    if (canSign) {
      panel.append(el("div", { class: "sign-fields" }, [
        el("div", { class: "form-row" }, [el("label", { class: "label", text: "Full Name", attrs: { for: "sign-name" } }), el("input", { class: "input", attrs: { id: "sign-name", value: r.name || r.email, readonly: true } })]),
        el("div", { class: "form-row" }, [el("label", { class: "label", text: "Email", attrs: { for: "sign-email" } }), el("input", { class: "input", attrs: { id: "sign-email", value: r.email, readonly: true } })]),
        el("div", { class: "hint", text: own.length === 0 ? "There are no fields for you on this document." : `${own.length - missing.length} of ${own.length} fields ready · click a highlighted field on the document to fill it in.` }),
      ]));
      const complete = button(completeLabel, { cls: "btn-block", disabled: missing.length > 0, onClick: () => confirmComplete(doc, r, completeLabel) });
      const reject = r.role === "CC" ? null : button("Reject Document", { variant: "outline", cls: "btn-block", onClick: () => rejectDialog(r) });
      panel.append(el("div", { class: "widget-foot two" }, [reject, complete]));
    }
    host.replaceChildren(
      el("h1", { class: "doc-title", text: doc.title, title: doc.title }),
      el("p", { class: "sign-invite", text: `${doc.senderName} (${doc.teamName}) has invited you to ${verb} this document` }),
      el("div", { class: "doc-grid" }, [el("div", { class: "doc-left" }, viewer), el("div", { class: "doc-right sticky" }, panel)]),
    );
  }

  function fillField(f) {
    if (f.type === "CHECKBOX") { values.has(f.id) && values.get(f.id) === true ? values.delete(f.id) : values.set(f.id, true); return draw(); }
    const d = dialog({ title: f.type === "SIGNATURE" ? "Sign as" : f.type === "INITIALS" ? "Initials" : f.fieldMeta?.label || "Text", description: f.type === "SIGNATURE" ? "Type your signature. Drawing and uploading are not simulated." : undefined });
    const input = el("input", { class: `input ${f.type === "SIGNATURE" || f.type === "INITIALS" ? "sig-input" : ""}`, attrs: { id: "fill-value", maxlength: 1000, value: values.get(f.id) ?? (f.type === "SIGNATURE" ? data.recipient.name : "") } });
    d.body.append(el("div", { class: "form-row" }, [el("label", { class: "label", text: FIELD_LABEL[f.type], attrs: { for: "fill-value" } }), input]));
    d.footer.append(button("Cancel", { variant: "secondary", onClick: d.close }), button("Save", { onClick: () => {
      if (!input.value.trim()) return d.setError("A value is required.");
      values.set(f.id, input.value.trim());
      d.close();
      draw();
    } }));
  }

  function confirmComplete(doc, r, label) {
    const d = dialog({ title: "Are you sure?", description: `You are about to complete ${r.role === "APPROVER" ? "approving" : r.role === "VIEWER" ? "viewing" : "signing"} "${doc.title}". This action cannot be undone.` });
    const key = newKey();
    d.footer.append(button("Cancel", { variant: "secondary", onClick: d.close }), button(label, { onClick: () => run(async () => {
      const list = [...values].map(([fieldId, value]) => ({ fieldId, value }));
      done = await call("signing.complete", { token, ...(list.length ? { values: list } : {}) }, key);
      d.close();
      draw();
    }, { onError: (e) => d.setError(describe(e)) }) }));
  }

  function rejectDialog(r) {
    const d = dialog({ title: "Reject Document", description: "Are you sure you want to reject this document? This action cannot be undone." });
    const reason = el("textarea", { class: "input", attrs: { id: "reject-reason", maxlength: 500, placeholder: "Please provide a reason for rejecting this document" } });
    d.body.append(el("div", { class: "form-row" }, [el("label", { class: "label", text: "Reason for rejection", attrs: { for: "reject-reason" } }), reason]));
    const key = newKey();
    d.footer.append(button("Cancel", { variant: "secondary", onClick: d.close }), button("Reject Document", { variant: "destructive", onClick: () => run(async () => {
      if (!reason.value.trim()) return d.setError("Please provide a reason");
      done = await call("signing.complete", { token, reject: { reason: reason.value.trim() } }, key);
      d.close();
      toast("The document has been rejected.", { title: "Document rejected" });
      draw();
    }, { onError: (e) => d.setError(describe(e)) }) }));
  }

  function drawDone(doc, r) {
    const rejected = done.recipientStatus === "REJECTED";
    host.replaceChildren(el("div", { class: "sign-done" }, [
      el("span", { class: `sign-done-ic ${rejected ? "is-red" : ""}` }, icon(rejected ? "xCircle" : "checkCircle")),
      el("h1", { text: rejected ? `You have rejected "${doc.title}"` : `You have ${r.role === "APPROVER" ? "approved" : r.role === "VIEWER" ? "viewed" : "signed"} "${doc.title}"` }),
      el("p", { class: "muted", text: rejected ? "The document owner has been notified of your decision." : done.documentStatus === "COMPLETED" ? "Everyone has signed! You will receive an email copy of the signed document." : "Waiting for others to complete signing." }),
      el("a", { class: "btn btn-outline", text: "Go back home", attrs: { href: "#/documents" } }),
    ]));
  }

  async function refresh() {
    if (done) return;
    data = await call("signing.get", { token });
    draw();
  }
  draw();
  return { refresh, mayRefresh: () => values.size === 0 };
}
