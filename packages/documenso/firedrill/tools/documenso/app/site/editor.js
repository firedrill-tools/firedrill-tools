// Draft editor: the four-step flow card (General · Add Signers · Add Fields · Distribute) beside the document viewer.
import { titleBlock } from "./document.js";
import { fieldViewerOptions, stepFields } from "./editor-fields.js";
import { stepSigners } from "./editor-signers.js";
import { documentViewer } from "./pages.js";
import { app, go } from "./state.js";
import { button, call, describe, el, newKey, run, toast } from "./ui.js";

const VISIBILITY = [["EVERYONE", "Everyone"], ["MANAGER_AND_ABOVE", "Managers and above"], ["ADMIN", "Admins only"]];
const LANGUAGES = [["en", "English"], ["de", "German"], ["fr", "French"], ["es", "Spanish"], ["it", "Italian"], ["nl", "Dutch"], ["pl", "Polish"], ["pt-BR", "Portuguese (Brazil)"], ["ja", "Japanese"], ["ko", "Korean"], ["zh", "Chinese"]];
const DATE_FORMATS = ["yyyy-MM-dd hh:mm a", "yyyy-MM-dd", "dd/MM/yyyy hh:mm a", "MM/dd/yyyy hh:mm a", "yyyy-MM-dd HH:mm", "yy-MM-dd hh:mm a", "yyyy-MM-dd HH:mm:ss", "MMMM dd, yyyy hh:mm a", "EEEE, MMMM dd, yyyy hh:mm a"];
const TIMEZONES = ["Etc/UTC", "Europe/London", "Europe/Paris", "Europe/Berlin", "Europe/Athens", "Asia/Dubai", "Asia/Kolkata", "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney", "America/Sao_Paulo", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles"];

export const select = (id, options, value) => el("select", { class: "input", attrs: { id } }, options.map(([v, label]) => el("option", { text: label, attrs: { value: v, selected: v === value } })));
export const field = (id, label, control, hint) => el("div", { class: "form-row" }, [el("label", { class: "label", text: label, attrs: { for: id } }), control, hint ? el("p", { class: "hint", text: hint }) : null]);

export async function renderEditor(main, id) {
  const ctx = { doc: await call("documents.get", { documentId: id }), ws: app.workspace, step: 1, dirty: false, placing: null, recipientId: null };
  if (ctx.doc.status !== "DRAFT") { go(`#/documents/${id}`); return {}; }
  const host = el("div", { class: "container doc-container" });
  main.replaceChildren(host);
  ctx.reload = async () => {
    ctx.doc = await call("documents.get", { documentId: id });
    if (ctx.doc.status !== "DRAFT") return go(`#/documents/${id}`);
    ctx.draw();
  };
  ctx.draw = () => {
    const steps = [stepGeneral, stepSigners, stepFields, stepDistribute];
    const step = steps[ctx.step - 1](ctx);
    const error = el("div", { class: "alert alert-destructive", attrs: { role: "alert" } });
    error.hidden = true;
    const back = button("Go Back", { variant: "secondary", disabled: ctx.step === 1, onClick: () => { ctx.dirty = false; ctx.step -= 1; ctx.draw(); } });
    const next = button(step.continueLabel ?? "Continue", { onClick: () => run(async () => {
      const ok = await step.onContinue();
      if (ok === false) return;
      ctx.dirty = false;
      if (ctx.step < 4) { ctx.step += 1; await ctx.reload(); }
    }, { onError: (e) => { error.textContent = describe(e); error.hidden = false; } }) });
    const flow = el("section", { class: "flow" }, [
      el("div", { class: "flow-head" }, [el("h3", { class: "flow-title", text: step.title }), el("p", { class: "flow-desc", text: step.description })]),
      el("hr", { class: "flow-hr" }), error, el("div", { class: "flow-body" }, step.body),
      el("div", { class: "flow-foot" }, [
        el("div", { class: "flow-progress" }, [el("p", { class: "muted", text: `Step ${ctx.step} of 4` }), el("div", { class: "flow-bar" }, el("div", { class: `flow-bar-fill s${ctx.step}` }))]),
        el("div", { class: "flow-actions" }, [back, next]),
      ]),
    ]);
    const viewer = documentViewer(ctx.doc.documentData.data, { fields: ctx.doc.fields, recipients: ctx.doc.recipients, ...(ctx.step === 3 ? fieldViewerOptions(ctx) : {}) });
    host.replaceChildren(titleBlock(ctx.doc), el("div", { class: "doc-grid" }, [el("div", { class: "doc-left" }, viewer), el("div", { class: "doc-right sticky" }, flow)]));
  };
  ctx.draw();
  return { refresh: ctx.reload, mayRefresh: () => !ctx.dirty };
}

function stepGeneral(ctx) {
  const { doc } = ctx;
  const meta = doc.documentMeta;
  const title = el("input", { class: "input", attrs: { id: "gen-title", maxlength: 1024, value: doc.title } });
  const language = select("gen-language", LANGUAGES, meta.language);
  const visibility = select("gen-visibility", VISIBILITY, doc.visibility);
  const access = select("gen-access", [["", "No restrictions"], ["ACCOUNT", "Require account"]], doc.authOptions.globalAccessAuth[0] ?? "");
  const externalId = el("input", { class: "input", attrs: { id: "gen-external", maxlength: 1024, value: doc.externalId ?? "" } });
  const dateFormat = select("gen-date", DATE_FORMATS.map((f) => [f, f]), meta.dateFormat);
  const timezone = select("gen-tz", (TIMEZONES.includes(meta.timezone) ? TIMEZONES : [meta.timezone, ...TIMEZONES]).map((z) => [z, z]), meta.timezone);
  const redirect = el("input", { class: "input", attrs: { id: "gen-redirect", type: "url", maxlength: 1000, value: meta.redirectUrl ?? "", placeholder: "https://example.com" } });
  const body = el("div", { class: "flow-fields" }, [
    field("gen-title", "Title", title), field("gen-language", "Language", language), field("gen-visibility", "Document visibility", visibility),
    field("gen-access", "Document access", access, "Recipients must be signed in to a Documenso account to view the document."),
    el("details", { class: "advanced" }, [el("summary", { text: "Advanced Options" }), el("div", { class: "flow-fields" }, [
      field("gen-external", "External ID", externalId, "Add an external ID to the document. This can be used to identify the document in external systems."),
      field("gen-date", "Date Format", dateFormat), field("gen-tz", "Time Zone", timezone), field("gen-redirect", "Redirect URL", redirect),
    ])]),
  ]);
  body.addEventListener("input", () => { ctx.dirty = true; });
  const key = newKey();
  return {
    title: "General", description: "Configure general settings for the document.", body,
    async onContinue() {
      const data = {};
      if (title.value.trim() !== doc.title) data.title = title.value.trim();
      if (visibility.value !== doc.visibility) data.visibility = visibility.value;
      if ((externalId.value.trim() || null) !== doc.externalId) data.externalId = externalId.value.trim() || null;
      if (access.value !== (doc.authOptions.globalAccessAuth[0] ?? "")) data.globalAccessAuth = access.value ? [access.value] : [];
      const m = {};
      if (language.value !== meta.language) m.language = language.value;
      if (dateFormat.value !== meta.dateFormat) m.dateFormat = dateFormat.value;
      if (timezone.value !== meta.timezone) m.timezone = timezone.value;
      if ((redirect.value.trim() || null) !== meta.redirectUrl) m.redirectUrl = redirect.value.trim() || null;
      if (Object.keys(data).length || Object.keys(m).length) {
        await call("documents.update", { documentId: doc.id, ...(Object.keys(data).length ? { data } : {}), ...(Object.keys(m).length ? { meta: m } : {}) }, key);
      }
    },
  };
}

function stepDistribute(ctx) {
  const { doc } = ctx;
  const meta = doc.documentMeta;
  const method = select("dist-method", [["EMAIL", "Email"], ["NONE", "None"]], meta.distributionMethod);
  const subject = el("input", { class: "input", attrs: { id: "dist-subject", maxlength: 255, value: meta.subject ?? "", placeholder: `Please sign "${doc.title}"` } });
  const message = el("textarea", { class: "input", attrs: { id: "dist-message", maxlength: 5000, placeholder: "Leave this empty to use the default message" } });
  message.value = meta.message ?? "";
  const note = el("p", { class: "hint" });
  const sync = () => {
    const email = method.value === "EMAIL";
    subject.disabled = !email;
    message.disabled = !email;
    note.textContent = email ? "Recipients are e-mailed a signing link (simulated: nothing is delivered)." : "No e-mails are sent. Share the signing links from the document page after sending.";
  };
  method.addEventListener("change", sync);
  sync();
  const body = el("div", { class: "flow-fields" }, [
    field("dist-method", "Distribution Method", method), note, field("dist-subject", "Subject (Optional)", subject), field("dist-message", "Message (Optional)", message),
    el("div", { class: "recipient-summary" }, doc.recipients.map((r) => el("div", { class: "row-sub", text: `${r.role.charAt(0)}${r.role.slice(1).toLowerCase()} · ${r.name ? `${r.name} <${r.email}>` : r.email}` }))),
  ]);
  body.addEventListener("input", () => { ctx.dirty = true; });
  const key = newKey();
  return {
    title: "Distribute Document", description: "Choose how the document will reach recipients", body, continueLabel: "Send",
    async onContinue() {
      const m = { distributionMethod: method.value };
      if (method.value === "EMAIL") { m.subject = subject.value.trim() || null; m.message = message.value.trim() || null; }
      await call("documents.distribute", { documentId: doc.id, meta: m }, key);
      toast("Your document has been sent successfully.", { title: "Document sent" });
      ctx.dirty = false;
      go(`#/documents/${doc.id}`);
      return false;
    },
  };
}
