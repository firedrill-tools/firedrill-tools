// Full-page file preview with Share / Download / "..." and the right-hand info panel.
import { el, button, iconButton, call, describe, formatDate, formatSize, kindOf, extensionOf, parentOf } from "./ui.js";
import { icon, fileGlyph } from "./icons.js";
import { openMenu } from "./layer.js";
import { S, folderHash, loadLinks } from "./state.js";
import { downloadEntry, textFileDialog } from "./actions.js";
import { shareDialog } from "./dialogs.js";
import { entryMenuItems } from "./files.js";
import { emptyState, deniedState } from "./states.js";

const IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };

function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const cells = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
        else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ",") { cells.push(cur); cur = ""; }
      else cur += ch;
    }
    cells.push(cur);
    rows.push(cells);
    if (rows.length >= 2000) break;
  }
  return rows;
}

export async function renderPreview(host, path) {
  const shell = el("div", { class: "db-preview" });
  host.replaceChildren(shell);
  const parent = parentOf(path);
  const back = iconButton("chevronLeft", "Back to folder", { onClick: () => folderHash(parent) });
  const bar = el("div", { class: "db-preview-bar" }, [back, el("div", { class: "db-preview-title" }, [fileGlyph(kindOf({ name: path, ".tag": "file" }), extensionOf(path.split("/").pop()).length <= 4 ? extensionOf(path.split("/").pop()) : "", 28), el("h1", { text: path.split("/").pop() })])]);
  const stage = el("div", { class: "db-preview-stage" }, [el("p", { class: "db-muted", text: "Loading preview…" })]);
  const side = el("aside", { class: "db-preview-side", attrs: { "aria-label": "File info" } });
  shell.append(bar, el("div", { class: "db-preview-body" }, [stage, side]));

  let file;
  let revisions;
  try {
    [file, revisions] = await Promise.all([call("files.download", { path }), call("files.list-revisions", { path, limit: 100 }).catch(() => null), S.linksComplete ? null : loadLinks().catch(() => null)]);
  } catch (error) {
    if (error.denied || error.is?.("MISSING_SCOPE")) return stage.replaceChildren(deniedState(error));
    const gone = error.is?.("NOT_FOUND");
    return stage.replaceChildren(emptyState("alert", gone ? "This file was deleted or moved" : error.is?.("NOT_FILE") ? "This is a folder" : "Couldn't open this file", gone ? "" : describe(error), [button("Go to folder", { kind: "primary", onClick: () => folderHash(parent) })]));
  }
  const meta = file.metadata;
  const ext = extensionOf(meta.name);
  const actions = el("div", { class: "db-preview-actions" }, [
    button("Share", { kind: "primary", onClick: () => shareDialog(meta) }),
    button("Download", { iconName: "download", onClick: () => downloadEntry(meta) }),
  ]);
  if (file.content_kind === "text") actions.append(button("Edit", { iconName: "rename", onClick: () => textFileDialog(parent, { title: `Edit "${meta.name}"`, existing: { ...meta, content: file.content } }) }));
  const more = iconButton("more", "More actions", { attrs: { "aria-haspopup": "menu", "aria-expanded": "false" } });
  more.addEventListener("click", () => openMenu(more, entryMenuItems(meta).filter((i) => i === "sep" || i.label !== "Open"), { align: "right" }));
  actions.append(more);
  bar.append(actions);

  // Stage
  const mime = IMAGE_TYPES[ext];
  if (mime && file.content_kind === "base64") {
    stage.replaceChildren(el("img", { class: "db-preview-img", attrs: { src: `data:${mime};base64,${file.content}`, alt: meta.name } }));
  } else if (ext === "svg" && file.content_kind === "text") {
    stage.replaceChildren(el("img", { class: "db-preview-img", attrs: { src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(file.content)}`, alt: meta.name } }));
  } else if (file.content_kind === "text" && (ext === "csv" || ext === "tsv")) {
    const rows = ext === "tsv" ? file.content.split(/\r?\n/).filter(Boolean).map((l) => l.split("\t")) : parseCsv(file.content);
    const table = el("table", { class: "db-sheet" }, rows.map((cells, r) => el("tr", {}, cells.map((c) => el(r === 0 ? "th" : "td", { text: c })))));
    stage.replaceChildren(el("div", { class: "db-doc db-doc-wide" }, table));
  } else if (file.content_kind === "text") {
    stage.replaceChildren(el("div", { class: "db-doc" }, el("pre", { text: file.content })));
  } else {
    stage.replaceChildren(emptyState("file", "Preview not available", `Dropbox can't preview this ${ext ? ext.toUpperCase() : ""} file here.`, [button("Download", { kind: "primary", iconName: "download", onClick: () => downloadEntry(meta) })]));
  }

  // Info panel
  const link = S.links.get(meta.path_lower);
  const facts = [
    ["Size", formatSize(meta.size)],
    ["Type", ext ? `${ext.toUpperCase()} file` : "File"],
    ["Modified", formatDate(meta.server_modified)],
    ["Location", parent || "Dropbox"],
    ["Access", link ? "Anyone with the link" : "Only you"],
    ["Versions", revisions ? String(revisions.entries.length) : "--"],
  ];
  const tabs = el("div", { class: "db-tabs", attrs: { role: "tablist" } }, [el("button", { class: "db-tab", text: "Info", attrs: { type: "button", role: "tab", "aria-selected": "true" } }), el("button", { class: "db-tab", text: "Activity", attrs: { type: "button", role: "tab", "aria-selected": "false", disabled: true, title: "Activity is not simulated by this Tool" } }), el("button", { class: "db-tab", text: "Comments", attrs: { type: "button", role: "tab", "aria-selected": "false", disabled: true, title: "Comments are not simulated by this Tool" } })]);
  const dl = el("dl", { class: "db-info" });
  for (const [k, v] of facts) dl.append(el("dt", { text: k }), el("dd", { text: v }));
  const locationLink = el("button", { class: "db-link-btn", attrs: { type: "button" } }, [icon("folder"), el("span", { text: "Open containing folder" })]);
  locationLink.addEventListener("click", () => folderHash(parent));
  side.replaceChildren(tabs, dl, locationLink);
}
