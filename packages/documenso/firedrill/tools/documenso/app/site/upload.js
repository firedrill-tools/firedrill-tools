// Upload Document dialog: a UTF-8 text file (or pasted text) becomes a draft through documents.create.
import { icon } from "./icons.js";
import { dialog } from "./overlay.js";
import { app, go } from "./state.js";
import { button, call, describe, el, newKey, run, toast } from "./ui.js";

const MAX = 262144;

export function openUpload() {
  const d = dialog({ title: "Upload Document", description: "This simulation stores documents as UTF-8 text. Use a form feed character to separate pages." });
  const file = el("input", { class: "visually-hidden", attrs: { type: "file", id: "upload-file", accept: ".txt,.md,text/plain" } });
  const zone = el("label", { class: "dropzone", attrs: { for: "upload-file" } }, [icon("upload"), el("strong", { text: "Add a document" }), el("span", { text: "Drag & drop your text file here, or click to choose one." })]);
  const title = el("input", { class: "input", attrs: { id: "upload-title", maxlength: 1024, placeholder: "Document title" } });
  const text = el("textarea", { class: "input", attrs: { id: "upload-text", placeholder: "…or paste the document text here" } });
  let fileName = null;
  const usage = app.workspace?.usage;
  if (usage && usage.monthlyDocumentLimit !== null) {
    d.body.append(el("div", { class: usage.documentsCreated >= usage.monthlyDocumentLimit ? "alert alert-warning" : "alert alert-info", text: `${usage.documentsCreated} of ${usage.monthlyDocumentLimit} documents created this month on the ${app.workspace.team.plan} plan.` }));
  }
  const read = async (picked) => {
    if (!picked) return;
    if (picked.size > MAX) return d.setError("File is too large: this simulation accepts up to 256 KB of text.");
    fileName = picked.name;
    text.value = await picked.text();
    if (!title.value) title.value = picked.name.replace(/\.[^.]+$/, "");
    d.setError(null);
  };
  file.addEventListener("change", () => void read(file.files?.[0]));
  zone.addEventListener("dragover", (event) => { event.preventDefault(); zone.classList.add("is-over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("is-over"));
  zone.addEventListener("drop", (event) => { event.preventDefault(); zone.classList.remove("is-over"); void read(event.dataTransfer?.files?.[0]); });
  d.body.append(file, zone,
    el("div", { class: "form-row" }, [el("label", { class: "label", text: "Title", attrs: { for: "upload-title" } }), title]),
    el("div", { class: "form-row" }, [el("label", { class: "label", text: "Document text", attrs: { for: "upload-text" } }), text]));
  const key = newKey();
  d.footer.append(button("Cancel", { variant: "secondary", onClick: d.close }), button("Upload", { iconName: "upload", onClick: () => run(async () => {
    const content = text.value;
    if (!content.trim()) return d.setError("Add a file or paste the document text.");
    const name = fileName ?? `${(title.value.trim() || "document").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "document"}.txt`;
    const created = await call("documents.create", { payload: title.value.trim() ? { title: title.value.trim() } : {}, file: { name, content } }, key);
    d.close();
    toast("Your document has been uploaded successfully.", { title: "Document uploaded" });
    go(`#/documents/${created.id}/edit`);
  }, { onError: (e) => d.setError(describe(e)) }) }));
}
