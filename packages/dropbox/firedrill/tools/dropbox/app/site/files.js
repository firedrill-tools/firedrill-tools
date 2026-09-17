// "All files": breadcrumb, Create/Upload actions, the Name · Who can access · Modified table (or grid), row menus.
import { el, button, iconButton, call, describe, formatDate, formatSize, kindOf, extensionOf, parentOf, isBusy } from "./ui.js";
import { icon, fileGlyph } from "./icons.js";
import { openMenu, notSimulated } from "./layer.js";
import { S, go, folderHash, sortEntries, loadLinks } from "./state.js";
import { createFolderDialog, textFileDialog, renameDialog, deleteEntries, downloadEntry } from "./actions.js";
import { shareDialog, moveCopyDialog, versionsDialog } from "./dialogs.js";
import { emptyState, deniedState, skeleton } from "./states.js";

const PAGE = 100;

export function openEntry(entry) {
  if (entry[".tag"] === "folder") folderHash(entry.path_display);
  else go("preview", entry.path_display.replace(/^\//, ""));
}

export function entryMenuItems(entry) {
  const file = entry[".tag"] === "file";
  return [
    { label: "Open", icon: file ? "file" : "folder", onClick: () => openEntry(entry) },
    ...(file ? [{ label: "Download", icon: "download", onClick: () => downloadEntry(entry) }] : [{ label: "Download", icon: "download", disabled: true, hint: "Folder downloads (zip) are not simulated by this Tool" }]),
    "sep",
    { label: "Copy link", icon: "link", onClick: () => shareDialog(entry) },
    { label: "Share", icon: "shared", onClick: () => shareDialog(entry) },
    "sep",
    { label: "Rename", icon: "rename", onClick: () => renameDialog(entry) },
    { label: "Move", icon: "move", onClick: () => moveCopyDialog([entry], "move") },
    { label: "Copy", icon: "copy", onClick: () => moveCopyDialog([entry], "copy") },
    ...(file ? [{ label: "Version history", icon: "history", onClick: () => versionsDialog(entry) }] : []),
    { label: "Star", icon: "star", onClick: () => notSimulated("Starred items") },
    "sep",
    { label: "Delete", icon: "trash", danger: true, onClick: () => deleteEntries([entry]) },
  ];
}

export function accessCell(entry) {
  const link = S.links.get(entry.path_lower);
  if (link) return el("span", { class: "db-access" }, [icon("link"), el("span", { text: "Anyone with link" })]);
  return el("span", { class: "db-access db-muted" }, [el("span", { text: "Only you" })]);
}

export function nameCell(entry, sub) {
  const ext = extensionOf(entry.name);
  const link = el("button", { class: "db-name-link", text: entry.name, attrs: { type: "button" } });
  link.addEventListener("click", (e) => {
    e.stopPropagation();
    openEntry(entry);
  });
  return el("div", { class: "db-name" }, [fileGlyph(kindOf(entry), ext.length <= 4 ? ext : "", 32), sub ? el("div", { class: "db-name-stack" }, [link, el("small", { class: "db-muted", text: sub })]) : link]);
}

/** Folder listing view. `path` is "" for the root. */
export async function renderFiles(host, path, { soft }) {
  const selection = new Set();
  const head = el("div", { class: "db-page-head" }, [crumbs(path)]);
  const actions = el("div", { class: "db-actions" });
  const body = el("div", { class: "db-files" });
  if (!soft) body.append(skeleton());
  host.replaceChildren(head, actions, body);

  const create = button("Create", { kind: "primary", iconName: "plus", attrs: { "aria-haspopup": "menu", "aria-expanded": "false" } });
  create.append(icon("caretDown"));
  create.addEventListener("click", () => openMenu(create, [
    { label: "Folder", icon: "folder", onClick: () => createFolderDialog(path) },
    { label: "Text file", icon: "file", onClick: () => textFileDialog(path) },
    "sep",
    { label: "Shared folder", icon: "shared", onClick: () => notSimulated("Shared folders") },
    { label: "Dropbox Paper doc", icon: "rename", onClick: () => notSimulated("Paper docs") },
  ]));
  const upload = button("Upload", { iconName: "upload", attrs: { "aria-haspopup": "menu", "aria-expanded": "false" } });
  upload.append(icon("caretDown"));
  upload.addEventListener("click", () => openMenu(upload, [
    { label: "Files", icon: "file", onClick: () => textFileDialog(path, { title: "Upload file" }) },
    { label: "Folder", icon: "folder", onClick: () => notSimulated("Folder upload") },
  ]));
  const organize = button("Organize", { iconName: "move", onClick: () => notSimulated("Organize (automated folders)") });
  const getApp = button("Get the app", { kind: "ghost", onClick: () => notSimulated("Dropbox desktop app") });
  const listBtn = iconButton("list", "List view", { attrs: { "aria-pressed": String(S.view === "list") } });
  const gridBtn = iconButton("grid", "Grid view", { attrs: { "aria-pressed": String(S.view === "grid") } });
  listBtn.addEventListener("click", () => { S.view = "list"; renderFiles(host, path, { soft: true }); });
  gridBtn.addEventListener("click", () => { S.view = "grid"; renderFiles(host, path, { soft: true }); });
  actions.append(create, upload, organize, getApp, el("span", { class: "spacer" }), el("div", { class: "db-seg" }, [listBtn, gridBtn]));

  let entries = [];
  let cursor = null;
  let hasMore = false;
  try {
    const [page] = await Promise.all([call("files.list-folder", { path, limit: PAGE }), S.linksComplete ? null : loadLinks().catch(() => null)]);
    entries = page.entries;
    cursor = page.cursor;
    hasMore = page.has_more;
  } catch (error) {
    if (error.denied || error.is?.("MISSING_SCOPE")) return body.replaceChildren(deniedState(error));
    return body.replaceChildren(emptyState("alert", error.is?.("NOT_FOUND") ? "This folder doesn't exist" : "Couldn't load this folder", describe(error), [button("Retry", { kind: "primary", onClick: () => renderFiles(host, path, { soft: false }) }), path ? button("Go to All files", { onClick: () => go("files") }) : null]));
  }

  const draw = () => {
    body.replaceChildren();
    if (!entries.length) {
      body.append(emptyState("folder", "This folder is empty", "Drag files here, or use Create and Upload to add something.", [button("Upload", { kind: "primary", iconName: "upload", onClick: () => textFileDialog(path, { title: "Upload file" }) }), button("Create folder", { onClick: () => createFolderDialog(path) })]));
      return;
    }
    if (selection.size) body.append(selectionBar());
    const sorted = sortEntries(entries);
    body.append(S.view === "grid" ? grid(sorted) : table(sorted));
    if (hasMore) {
      const more = button("Show more", {
        onClick: async () => {
          more.disabled = true;
          try {
            const page = await call("files.list-folder-continue", { cursor });
            entries = entries.concat(page.entries.filter((e) => e[".tag"] !== "deleted"));
            cursor = page.cursor;
            hasMore = page.has_more;
            draw();
          } catch (error) {
            more.disabled = false;
            body.append(el("p", { class: "db-inline-error", text: describe(error) }));
          }
        },
      });
      body.append(el("div", { class: "db-loadmore" }, [more]));
    }
  };

  const selectionBar = () => {
    const chosen = entries.filter((e) => selection.has(e.id));
    return el("div", { class: "db-selbar" }, [
      el("strong", { text: `${chosen.length} selected` }),
      button("Move", { iconName: "move", onClick: () => moveCopyDialog(chosen, "move") }),
      button("Copy", { iconName: "copy", onClick: () => moveCopyDialog(chosen, "copy") }),
      button("Delete", { iconName: "trash", onClick: () => deleteEntries(chosen) }),
      button("Clear", { kind: "ghost", onClick: () => { selection.clear(); draw(); } }),
    ]);
  };

  const sortHeader = (label, key) => {
    const b = el("button", { text: label, attrs: { type: "button", "aria-label": `Sort by ${label}` } });
    if (S.sort.key === key) b.append(icon(S.sort.dir === 1 ? "caretDown" : "caretRight"));
    b.addEventListener("click", () => {
      S.sort = { key, dir: S.sort.key === key ? -S.sort.dir : 1 };
      draw();
    });
    return b;
  };

  const table = (rows) => {
    const all = el("input", { class: "db-check", attrs: { type: "checkbox", "aria-label": "Select all" } });
    all.checked = rows.length > 0 && rows.every((e) => selection.has(e.id));
    all.addEventListener("change", () => { for (const e of rows) all.checked ? selection.add(e.id) : selection.delete(e.id); draw(); });
    const t = el("table", { class: "db-table" }, [
      el("colgroup", {}, [el("col", { class: "c-check" }), el("col"), el("col", { class: "c-access" }), el("col", { class: "c-mod" }), el("col", { class: "c-act" })]),
      el("thead", {}, el("tr", {}, [el("th", {}, all), el("th", {}, sortHeader("Name", "name")), el("th", { class: "col-access", text: "Who can access" }), el("th", {}, sortHeader("Modified", "modified")), el("th", {}, el("span", { class: "visually-hidden", text: "Actions" }))])),
    ]);
    const tbody = el("tbody");
    for (const entry of rows) tbody.append(row(entry));
    t.append(tbody);
    return t;
  };

  const row = (entry) => {
    const tr = el("tr", { class: "db-row", attrs: { tabindex: "0", "aria-selected": String(selection.has(entry.id)), "data-id": entry.id } });
    const check = el("input", { class: "db-check", attrs: { type: "checkbox", "aria-label": `Select ${entry.name}` } });
    check.checked = selection.has(entry.id);
    check.addEventListener("change", () => { check.checked ? selection.add(entry.id) : selection.delete(entry.id); draw(); });
    const share = button("Share", { kind: "secondary", className: "db-share", onClick: (e) => { e.stopPropagation(); shareDialog(entry); } });
    const more = iconButton("more", `More actions for ${entry.name}`, { attrs: { "aria-haspopup": "menu", "aria-expanded": "false" } });
    more.addEventListener("click", (e) => { e.stopPropagation(); openMenu(more, entryMenuItems(entry), { align: "right" }); });
    const modified = entry[".tag"] === "file" ? formatDate(entry.server_modified) : "--";
    tr.append(el("td", {}, check), el("td", {}, nameCell(entry)), el("td", { class: "col-access" }, accessCell(entry)), el("td", { text: modified, title: entry[".tag"] === "file" ? formatSize(entry.size) : undefined }), el("td", {}, el("div", { class: "db-row-actions" }, [share, more])));
    tr.addEventListener("click", () => { selection.clear(); selection.add(entry.id); draw(); body.querySelector(`[data-id="${CSS.escape(entry.id)}"]`)?.focus(); });
    tr.addEventListener("dblclick", () => openEntry(entry));
    tr.addEventListener("keydown", (e) => {
      if (e.target !== tr || isBusy()) return;
      if (e.key === "Enter") openEntry(entry);
      else if (e.key === "Delete" || e.key === "Backspace") deleteEntries([entry]);
      else if (e.key === "ArrowDown") tr.nextElementSibling?.focus();
      else if (e.key === "ArrowUp") tr.previousElementSibling?.focus();
      else return;
      e.preventDefault();
    });
    return tr;
  };

  const grid = (rows) => el("div", { class: "db-grid" }, rows.map((entry) => {
    const tile = el("button", { class: "db-tile", attrs: { type: "button", "aria-selected": String(selection.has(entry.id)) } }, [
      el("div", { class: "db-tile-thumb" }, fileGlyph(kindOf(entry), extensionOf(entry.name).slice(0, 4), 64)),
      el("span", { class: "db-tile-name", text: entry.name }),
      el("span", { class: "db-tile-meta", text: entry[".tag"] === "file" ? `${formatSize(entry.size)} · ${formatDate(entry.server_modified)}` : "Folder" }),
    ]);
    tile.addEventListener("click", () => openEntry(entry));
    tile.addEventListener("contextmenu", (e) => { e.preventDefault(); openMenu(tile, entryMenuItems(entry)); });
    return tile;
  }));

  draw();
}

function crumbs(path) {
  const wrap = el("nav", { class: "db-crumbs", attrs: { "aria-label": "Breadcrumb" } });
  const parts = path ? path.split("/").slice(1) : [];
  const root = el("button", { class: "db-crumb", text: "All files", attrs: { type: "button", "aria-current": parts.length ? undefined : "page" } });
  root.addEventListener("click", () => parts.length && go("files"));
  wrap.append(root);
  let acc = "";
  parts.forEach((part, i) => {
    acc += `/${part}`;
    const target = acc;
    const last = i === parts.length - 1;
    const b = el("button", { class: "db-crumb", text: part, attrs: { type: "button", "aria-current": last ? "page" : undefined } });
    if (!last) b.addEventListener("click", () => folderHash(target));
    wrap.append(el("span", { class: "db-crumb-sep" }, icon("caretRight")), b);
  });
  return wrap;
}

export { parentOf };
