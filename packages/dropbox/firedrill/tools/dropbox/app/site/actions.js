// Create, upload, rename, delete and download: each a dialog wired to a real operation with an idempotency key.
import { el, button, call, newKey, describe, action, toast, parentOf, ToolError } from "./ui.js";
import { modal, field, inlineError, confirmDialog } from "./layer.js";
import { refresh } from "./state.js";

const joinPath = (parent, name) => `${parent}/${name}`;

/** Run a mutation from a dialog; keep the key while the user retries the same uncertain action. */
function submitter(m, errors, work) {
  let key = newKey();
  let busy = false;
  return async () => {
    if (busy) return;
    busy = true;
    errors.clear();
    for (const b of m.footer.querySelectorAll("button")) b.disabled = true;
    try {
      await work(key);
      m.close();
      refresh();
    } catch (error) {
      errors.show(describe(error));
      // A definite refusal is a new action next time; an uncertain failure reuses the key.
      if (error instanceof ToolError && !error.is("INTERNAL_ERROR")) key = newKey();
    } finally {
      busy = false;
      for (const b of m.footer.querySelectorAll("button")) b.disabled = false;
    }
  };
}

export function createFolderDialog(parent) {
  const m = modal("Create folder");
  const name = field("Name", { id: "new-folder-name", placeholder: "Folder name" });
  m.body.append(name.wrap);
  const errors = inlineError(m.body);
  const submit = submitter(m, errors, async (key) => {
    const value = name.input.value.trim();
    if (!value) throw new Error("Enter a folder name.");
    const result = await call("files.create-folder", { path: joinPath(parent, value), autorename: false }, key);
    toast(`Created folder "${result.metadata.name}"`);
  });
  name.input.addEventListener("keydown", (e) => e.key === "Enter" && submit());
  m.footer.append(button("Cancel", { onClick: () => m.close() }), button("Create", { kind: "primary", onClick: submit }));
}

/** Text file editor used for "Create > Text file" and "Upload > Files" (text content only). */
export function textFileDialog(parent, { title = "Create text file", existing } = {}) {
  const m = modal(title, { wide: true });
  const name = field("File name", { id: "text-file-name", value: existing?.name ?? "Untitled.txt" });
  const body = field("Content", { id: "text-file-body", multiline: true, value: existing?.content ?? "" });
  m.body.append(name.wrap, body.wrap);
  if (!existing) m.body.append(el("p", { class: "db-modal-sub", text: "This synthetic Dropbox stores text content. Binary files from your computer are not uploaded." }));
  const errors = inlineError(m.body);
  let autorename = false;
  const submit = submitter(m, errors, async (key) => {
    const value = name.input.value.trim();
    if (!value) throw new Error("Enter a file name.");
    const args = { path: existing ? existing.path_display : joinPath(parent, value), content: body.input.value, autorename };
    args.mode = existing ? { ".tag": "update", update: existing.rev } : "add";
    const result = await call("files.upload", args, key);
    toast(existing ? `Saved "${result.name}"` : `Uploaded "${result.name}"`);
  });
  const keepBoth = button("Keep both", {
    onClick: () => {
      autorename = true;
      submit();
    },
  });
  keepBoth.hidden = true;
  m.footer.append(keepBoth, button("Cancel", { onClick: () => m.close() }), button(existing ? "Save" : "Upload", { kind: "primary", onClick: submit }));
  const originalShow = errors.show;
  errors.show = (text) => {
    originalShow(text);
    keepBoth.hidden = existing !== undefined || !text.startsWith("An item with that name");
  };
}

export function renameDialog(entry) {
  const m = modal("Rename");
  const name = field("Name", { id: "rename-name", value: entry.name });
  m.body.append(name.wrap);
  const errors = inlineError(m.body);
  queueMicrotask(() => {
    const dot = entry[".tag"] === "file" ? entry.name.lastIndexOf(".") : -1;
    name.input.setSelectionRange(0, dot > 0 ? dot : entry.name.length);
  });
  const submit = submitter(m, errors, async (key) => {
    const value = name.input.value.trim();
    if (!value) throw new Error("Enter a name.");
    if (value === entry.name) return;
    await call("files.move", { from_path: entry.path_display, to_path: joinPath(parentOf(entry.path_display), value) }, key);
    toast(`Renamed to "${value}"`);
  });
  name.input.addEventListener("keydown", (e) => e.key === "Enter" && submit());
  m.footer.append(button("Cancel", { onClick: () => m.close() }), button("Save", { kind: "primary", onClick: submit }));
}

export async function deleteEntries(entries) {
  const one = entries.length === 1;
  const title = one ? `Delete ${entries[0][".tag"] === "folder" ? "folder" : "file"}?` : `Delete ${entries.length} items?`;
  const message = one
    ? `Are you sure you want to delete "${entries[0].name}"? You can restore it from Deleted files.`
    : "Are you sure you want to delete these items? You can restore them from Deleted files.";
  if (!(await confirmDialog(title, message, "Delete", { danger: true }))) return;
  await action(async () => {
    let done = 0;
    try {
      for (const entry of entries) {
        await call("files.delete", { path: entry.path_display }, newKey());
        done += 1;
      }
      toast(one ? `Deleted "${entries[0].name}"` : `Deleted ${done} items`);
    } catch (error) {
      toast(`${done ? `Deleted ${done} of ${entries.length}. ` : ""}${describe(error)}`, { error: true });
    } finally {
      refresh();
    }
  });
}

/** Save a file (or one revision) through the browser as a Blob built from the downloaded content. */
export async function downloadEntry(entry, rev) {
  await action(async () => {
    const result = await call("files.download", rev ? { path: entry.path_display, rev } : { path: entry.path_display });
    const blob = result.content_kind === "base64" ? new Blob([Uint8Array.from(atob(result.content), (c) => c.charCodeAt(0))]) : new Blob([result.content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = el("a", { attrs: { href: url, download: result.metadata.name } });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`Downloading "${result.metadata.name}"`);
  });
}
