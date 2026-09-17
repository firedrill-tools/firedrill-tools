// Home, Photos, Shared, Deleted files and Search.
import { el, button, iconButton, call, describe, formatDate, formatSize, relativeDate, monthLabel, kindOf, extensionOf, parentOf, newKey, toast } from "./ui.js";

const THUMB_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };
import { icon, fileGlyph } from "./icons.js";
import { openMenu, confirmDialog, notSimulated } from "./layer.js";
import { S, go, folderHash, listAll, loadLinks, refresh } from "./state.js";
import { openEntry, nameCell, accessCell, entryMenuItems } from "./files.js";
import { emptyState, deniedState, skeleton } from "./states.js";

const head = (title, extra = []) => el("div", { class: "db-page-head" }, [el("h1", { class: "db-h1", text: title }), ...extra]);

function failure(host, error, retry) {
  if (error.denied || error.is?.("MISSING_SCOPE")) return host.replaceChildren(deniedState(error));
  host.replaceChildren(emptyState("alert", "Something went wrong", describe(error), [button("Retry", { kind: "primary", onClick: retry })]));
}

function simpleTable(rows, columns) {
  const t = el("table", { class: "db-table" }, [el("thead", {}, el("tr", {}, columns.map((c) => el("th", { text: c.label, class: c.class }))))]);
  const tbody = el("tbody");
  for (const r of rows) {
    const tr = el("tr", { class: "db-row", attrs: { tabindex: "0" } }, columns.map((c) => el("td", { class: c.class }, c.cell(r))));
    tr.addEventListener("keydown", (e) => e.key === "Enter" && e.target === tr && r[".tag"] !== "deleted" && openEntry(r));
    tbody.append(tr);
  }
  t.append(tbody);
  return t;
}

const moreCell = (entry) => {
  const more = iconButton("more", `More actions for ${entry.name}`, { attrs: { "aria-haspopup": "menu", "aria-expanded": "false" } });
  more.addEventListener("click", () => openMenu(more, entryMenuItems(entry), { align: "right" }));
  return el("div", { class: "db-row-actions" }, more);
};

export async function renderHome(host, { soft }) {
  const name = S.account?.name?.familiar_name ?? "";
  const body = el("div");
  host.replaceChildren(head(name ? `Welcome, ${name}` : "Home"), el("div", { class: "db-home-cards" }, [
    card("upload", "Upload files", () => go("files")),
    card("newFolder", "Create folder", () => go("files")),
    card("send", "Send and track", () => notSimulated("Send and track")),
    card("signature", "Get signatures", () => notSimulated("Dropbox Sign")),
  ]), el("h2", { class: "db-h2", text: "Recent" }), body);
  if (!soft) body.append(skeleton(6));
  try {
    const [all] = await Promise.all([listAll("", { recursive: true }), S.linksComplete ? null : loadLinks().catch(() => null)]);
    const recent = all.filter((e) => e[".tag"] === "file").sort((a, b) => (a.server_modified < b.server_modified ? 1 : -1)).slice(0, 12);
    if (!recent.length) return body.replaceChildren(emptyState("logo", "No recent files", "Files you add or edit show up here.", [button("Go to All files", { kind: "primary", onClick: () => go("files") })]));
    body.replaceChildren(simpleTable(recent, [
      { label: "Name", cell: (e) => nameCell(e, parentOf(e.path_display) || "Dropbox") },
      { label: "Who can access", class: "col-access", cell: accessCell },
      { label: "Modified", cell: (e) => el("span", { text: relativeDate(e.server_modified) }) },
      { label: "", cell: moreCell },
    ]));
  } catch (error) {
    failure(body, error, () => renderHome(host, { soft: false }));
  }
}

function card(iconName, label, onClick) {
  const b = el("button", { class: "db-card", attrs: { type: "button" } }, [el("span", { class: "db-card-ico" }, icon(iconName)), el("span", { text: label })]);
  b.addEventListener("click", onClick);
  return b;
}

export async function renderPhotos(host, { soft }) {
  const body = el("div");
  host.replaceChildren(head("Photos"), body);
  if (!soft) body.append(skeleton(4));
  try {
    // Search needs at least one word, so Photos walks the whole account (every page) and keeps image files.
    const images = (await listAll("", { recursive: true })).filter((e) => e[".tag"] === "file" && kindOf(e) === "image");
    images.sort((a, b) => (a.server_modified < b.server_modified ? 1 : -1));
    if (!images.length) return body.replaceChildren(emptyState("photos", "No photos yet", "Photos and images you add to Dropbox appear here."));
    let month = "";
    let grid;
    const thumbs = [];
    for (const img of images) {
      const label = monthLabel(img.server_modified);
      if (label !== month) {
        month = label;
        grid = el("div", { class: "db-photo-grid" });
        body.append(el("h2", { class: "db-h2", text: label }), grid);
      }
      const tile = el("button", { class: "db-photo", attrs: { type: "button", "aria-label": img.name, title: img.name } }, fileGlyph("image", "", 48));
      tile.addEventListener("click", () => openEntry(img));
      grid.append(tile);
      thumbs.push([tile, img]);
    }
    // Thumbnails come from the file bytes themselves (one download at a time; a failure keeps the file-type tile).
    for (const [tile, img] of thumbs) {
      const mime = THUMB_TYPES[extensionOf(img.name)];
      if (!mime || !tile.isConnected) continue;
      try {
        const file = await call("files.download", { path: img.path_display });
        const src = file.content_kind === "base64" ? `data:${mime};base64,${file.content}` : `data:${mime};charset=utf-8,${encodeURIComponent(file.content)}`;
        tile.replaceChildren(el("img", { attrs: { src, alt: "" } }));
      } catch {
        /* keep the placeholder */
      }
    }
    if (!soft) body.querySelector('[role="status"]')?.remove();
  } catch (error) {
    failure(body, error, () => renderPhotos(host, { soft: false }));
  }
}

export async function renderShared(host, { soft }) {
  const tabs = el("div", { class: "db-tabs", attrs: { role: "tablist" } });
  const body = el("div");
  const tab = (label, selected, disabled) => el("button", { class: "db-tab", text: label, attrs: { type: "button", role: "tab", "aria-selected": String(selected), disabled, title: disabled ? `${label} is not simulated by this Tool` : undefined } });
  tabs.append(tab("Folders", false, true), tab("Files", false, true), tab("Links", true, false));
  host.replaceChildren(head("Shared"), tabs, body);
  if (!soft) body.append(skeleton(4));
  try {
    const links = [...(await loadLinks()).values()].sort((a, b) => a.name.localeCompare(b.name));
    if (!links.length) return body.replaceChildren(emptyState("link", "No links yet", "Links you create to share files and folders appear here."));
    body.replaceChildren(simpleTable(links, [
      { label: "Name", cell: (l) => nameCell({ ".tag": l[".tag"], name: l.name, path_display: l.path_lower, path_lower: l.path_lower }, l.url) },
      { label: "Access", class: "col-access", cell: (l) => el("span", { class: "db-access" }, [icon(l.link_permissions?.resolved_visibility?.[".tag"] === "password" ? "lock" : "globe"), el("span", { text: l.link_permissions?.resolved_visibility?.[".tag"] === "password" ? "Password" : "Anyone with link" })]) },
      { label: "Expires", cell: (l) => el("span", { text: l.expires ? formatDate(l.expires) : "Never" }) },
      { label: "", cell: (l) => {
        const del = button("Delete link", { kind: "ghost", onClick: async () => {
          if (!(await confirmDialog("Delete link?", `People with the link to "${l.name}" will no longer be able to open it.`, "Delete link", { danger: true }))) return;
          try { await call("sharing.revoke-shared-link", { url: l.url }, newKey()); toast("Link deleted"); refresh(); } catch (error) { toast(describe(error), { error: true }); }
        } });
        return el("div", { class: "db-row-actions" }, del);
      } },
    ]));
  } catch (error) {
    failure(body, error, () => renderShared(host, { soft: false }));
  }
}

export async function renderDeleted(host, { soft }) {
  const body = el("div");
  host.replaceChildren(head("Deleted files"), el("p", { class: "db-muted db-lede", text: "Restore files and folders you deleted from this account." }), body);
  if (!soft) body.append(skeleton(4));
  try {
    const all = await listAll("", { recursive: true, includeDeleted: true });
    const deleted = all.filter((e) => e[".tag"] === "deleted").sort((a, b) => a.path_lower.localeCompare(b.path_lower));
    if (!deleted.length) return body.replaceChildren(emptyState("trash", "No deleted files", "Files you delete appear here."));
    body.replaceChildren(simpleTable(deleted, [
      { label: "Name", cell: (e) => el("div", { class: "db-name" }, [fileGlyph(kindOf({ ...e, ".tag": "file" }), "", 32), el("div", { class: "db-name-stack" }, [el("span", { class: "db-deleted-name", text: e.name }), el("small", { class: "db-muted", text: parentOf(e.path_display) || "Dropbox" })])]) },
      { label: "", cell: (e) => el("div", { class: "db-row-actions" }, button("Restore", { onClick: () => restoreDeleted(e) })) },
    ]));
  } catch (error) {
    failure(body, error, () => renderDeleted(host, { soft: false }));
  }
}

async function restoreDeleted(entry) {
  try {
    const history = await call("files.list-revisions", { path: entry.path_display, limit: 1 });
    const rev = history.entries[0]?.rev;
    if (!rev) return toast("This item is a folder or has no earlier version to restore.", { error: true });
    if (!(await confirmDialog("Restore file?", `"${entry.name}" will be restored to ${parentOf(entry.path_display) || "Dropbox"}.`, "Restore"))) return;
    await call("files.restore", { path: entry.path_display, rev }, newKey());
    toast(`Restored "${entry.name}"`, { actionLabel: "Show in folder", onAction: () => folderHash(parentOf(entry.path_display)) });
    refresh();
  } catch (error) {
    toast(describe(error), { error: true });
  }
}

const FILTERS = [["All", null], ["Folders", "folder"], ["Documents", "document"], ["Images", "image"], ["PDFs", "pdf"], ["Spreadsheets", "spreadsheet"]];

export async function renderSearch(host, query, { soft }) {
  const filter = S.searchFilter ?? null;
  const chips = el("div", { class: "db-chipbar" }, FILTERS.map(([label, value]) => {
    const chip = el("button", { class: "db-chip", text: label, attrs: { type: "button", "aria-pressed": String(filter === value) } });
    chip.addEventListener("click", () => { S.searchFilter = value; renderSearch(host, query, { soft: false }); });
    return chip;
  }));
  const namesOnly = el("input", { attrs: { type: "checkbox", id: "search-names-only" } });
  namesOnly.checked = Boolean(S.searchNamesOnly);
  namesOnly.addEventListener("change", () => { S.searchNamesOnly = namesOnly.checked; renderSearch(host, query, { soft: false }); });
  chips.append(el("label", { class: "db-chip", attrs: { for: "search-names-only" } }, [namesOnly, el("span", { text: "File names only" })]));
  const body = el("div");
  host.replaceChildren(head(`Search results for "${query}"`), chips, body);
  if (!soft) body.append(skeleton(5));
  const options = { max_results: 50, filename_only: Boolean(S.searchNamesOnly) };
  if (filter) options.file_categories = [filter];
  try {
    const page = await call("files.search", { query, options });
    const rows = page.matches.map((m) => m.metadata.metadata);
    const draw = (items, next) => {
      if (!items.length) return body.replaceChildren(emptyState("search", "No results", "Try different keywords or remove filters."));
      body.replaceChildren(simpleTable(items, [
        { label: "Name", cell: (e) => nameCell(e, parentOf(e.path_display) || "Dropbox") },
        { label: "Modified", cell: (e) => el("span", { text: e[".tag"] === "file" ? formatDate(e.server_modified) : "--", title: e[".tag"] === "file" ? formatSize(e.size) : undefined }) },
        { label: "", cell: moreCell },
      ]));
      if (next?.has_more && next.cursor) {
        const more = button("Show more results", { onClick: async () => {
          more.disabled = true;
          try { const p = await call("files.search-continue", { cursor: next.cursor }); draw(items.concat(p.matches.map((m) => m.metadata.metadata)), p); }
          catch (error) { more.disabled = false; toast(describe(error), { error: true }); }
        } });
        body.append(el("div", { class: "db-loadmore" }, more));
      }
    };
    draw(rows, page);
  } catch (error) {
    if (error.is?.("INVALID_ARGUMENT")) return body.replaceChildren(el("p", { class: "db-inline-error", text: describe(error) }));
    failure(body, error, () => renderSearch(host, query, { soft: false }));
  }
}
