// Google Docs Tool app — Docs home and the document editor.
//
// Every screen is wired to the Tool's own operations through /_firedrill/client.js: nothing is mocked in
// the browser, no value is invented, and "now" always comes from about.get's serverTime (the world's
// virtual clock), never from the browser. Mutations carry an idempotency key; destructive actions confirm.
import {
  $, $$, avatar, avatarClass, button, call, closeMenu, confirmDialog, describe, el, fullDate, getContext, iconButton,
  initials, listDate, newKey, openDialog, openMenuFor, placeholder, relative, setServerTime, skeletonRows,
  snack, ToolError,
} from "./ui.js";
import { hydrateIcons, icon } from "./icons.js";
import {
  blockAt, diffText, outlineEntries, placeCaret, renderBody, selectIndexRange, selectionRange, STYLE_LABEL,
} from "./docview.js";

const DOC_MIME = "application/vnd.google-apps.document";
const PAGE_SIZE = 12;

const state = {
  context: null,
  about: null,
  home: {
    scope: "recent",
    owner: "anyone",
    sort: "viewedByMeTime desc",
    layout: "list",
    search: "",
    query: "",
    files: [],
    token: null,
    loading: false,
    error: null,
  },
  doc: null,
  templatesVisible: true,
};

const SORTS = [
  { id: "viewedByMeTime desc", label: "Last opened by me", column: "Last opened by me", field: "viewedByMeTime" },
  { id: "modifiedTime desc", label: "Last modified", column: "Last modified", field: "modifiedTime" },
  { id: "createdTime desc", label: "Date created", column: "Created", field: "createdTime" },
  { id: "name_natural", label: "Title (A→Z)", column: "Last modified", field: "modifiedTime" },
];

const SCOPES = {
  recent: { title: "Recent documents", empty: ["article", "No documents yet", "Documents you create or that are shared with you appear here."] },
  starred: { title: "Starred", empty: ["star", "No starred documents", "Star a document from its row menu to find it here."] },
  shared: { title: "Shared with me", empty: ["group", "Nothing shared with you", "Documents other people share with this account appear here."] },
  trash: { title: "Trash", empty: ["delete", "Trash is empty", "Documents you remove stay here until you delete them forever."] },
};

// ---------------------------------------------------------------------------------------------
// Boot and routing
// ---------------------------------------------------------------------------------------------

async function boot() {
  hydrateIcons(document);
  try {
    state.context = await getContext();
  } catch (error) {
    return fatal("Not connected", describe(error));
  }
  try {
    state.about = await call("about.get");
    setServerTime(state.about.serverTime);
  } catch (error) {
    if (!(error instanceof ToolError) || !error.denied) return fatal("Docs is unavailable", describe(error));
    // The world withheld about.get: keep going with no identity and no clock rather than a dead end.
    state.about = {
      user: { kind: "drive#user", displayName: "Unknown account", emailAddress: "", me: true, permissionId: "" },
      storageQuota: { usage: "0", usageInDrive: "0", usageInTrash: "0" },
      exportFormats: {}, limits: {}, serverTime: null, restricted: true,
    };
  }
  $("#boot").hidden = true;
  paintAccount();
  wireChrome();
  if (state.about.restricted) {
    snack("This actor is not granted about.get, so Docs cannot show the signed-in account or the world clock. Dates are shown as absolute times.");
  }
  window.addEventListener("hashchange", route);
  route();
  watchRevision();
}

function fatal(title, text) {
  $("#boot").hidden = true;
  $("#fatal").hidden = false;
  $("#fatal-title").textContent = title;
  $("#fatal-text").textContent = text;
}

function route() {
  closeMenu();
  const hash = location.hash.replace(/^#/, "");
  const documentMatch = /^\/document\/([^/]+)/.exec(hash);
  if (documentMatch) {
    $("#home-view").hidden = true;
    $("#editor-view").hidden = false;
    openDocument(decodeURIComponent(documentMatch[1]));
    return;
  }
  const scopeMatch = /^\/home\/([a-z]+)/.exec(hash);
  state.home.scope = scopeMatch && SCOPES[scopeMatch[1]] ? scopeMatch[1] : "recent";
  state.doc = null;
  $("#editor-view").hidden = true;
  $("#home-view").hidden = false;
  renderHomeChrome();
  loadFiles({ reset: true });
}

/** Refresh when the world changes underneath us (another actor, the API, or a drill). */
function watchRevision() {
  let known = state.context.revision;
  setInterval(async () => {
    let next;
    try {
      next = await getContext();
    } catch {
      return;
    }
    if (next.revision === known) return;
    known = next.revision;
    state.context = next;
    if (state.doc?.dirty || state.doc?.saving) return; // never discard an unsaved edit
    if (document.activeElement?.isContentEditable) return;
    if ($("#dialog").open) return;
    if (state.doc) await openDocument(state.doc.fileId, { keepPanel: true, quiet: true });
    else await loadFiles({ reset: true, quiet: true });
  }, 4000);
}

function paintAccount() {
  const user = state.about.user;
  for (const id of ["#home-avatar", "#doc-avatar"]) {
    const node = $(id);
    node.textContent = initials(user.displayName, user.emailAddress);
    node.className = `avatar ${avatarClass(user.emailAddress)}`;
  }
  for (const id of ["#account-btn", "#doc-account"]) {
    $(id).setAttribute("aria-label", `Account: ${user.displayName} (${user.emailAddress})`);
  }
}

function accountMenu(owner) {
  const user = state.about.user;
  const quota = Number(state.about.storageQuota.usage ?? "0");
  openMenuFor(owner, [
    { header: `${user.displayName} · ${user.emailAddress}` },
    { label: `Synthetic account in world ${state.context.worldInstanceId.slice(0, 12)}…`, disabled: true },
    { label: `Actor: ${state.context.actorId}`, disabled: true },
    { divider: true },
    { label: `Docs storage used: ${quota} bytes`, disabled: true },
    { label: state.about.serverTime ? `Server time: ${fullDate(state.about.serverTime)}` : "Server time: about.get is not granted to this actor", disabled: true },
    { divider: true },
    { label: "About this synthetic Docs", icon: "info", onSelect: aboutDialog },
  ], { align: "right" });
}

function aboutDialog() {
  openDialog({
    title: "About this synthetic Docs",
    render: (body) => {
      const limits = state.about.limits ?? {};
      body.append(
        el("p", { text: "This is a Firedrill Tool that simulates the Google Docs API v1 and the Drive v3 endpoints a Docs agent needs. Documents, comments, shares and revisions live only in this local world; nothing is sent to Google and sharing never sends e-mail." }),
        el("p", { text: "The app calls exactly the operations an agent calls, so anything you change here is visible over HTTP and MCP, and a reset restores it." }),
        limits.maxDocuments === undefined ? null : el("p", { text: `Bounds in force: ${limits.maxDocuments} documents, ${limits.maxTextLength} characters and ${limits.maxBlocks} blocks per document, ${limits.maxComments} comments, ${limits.maxRevisions} revisions, ${limits.maxRequestsPerBatch} requests per batch.` }),
        el("p", { text: "Not simulated: page rendering and pagination, images, drawings, headers and footers, suggestions, undo/redo, folders, and export to anything but plain text, Markdown and HTML." }),
      );
    },
    actions: (close) => [button("filled-btn", "Got it", { onClick: () => close(true) })],
  });
}

function appsDialog(owner) {
  openMenuFor(owner, [
    { header: "Google apps" },
    { label: "Docs", icon: "article", checked: true, disabled: true },
    { label: "Drive — not part of this Tool", disabled: true },
    { label: "Sheets — not part of this Tool", disabled: true },
    { label: "Slides — not part of this Tool", disabled: true },
  ], { align: "right" });
}

// ---------------------------------------------------------------------------------------------
// Docs home
// ---------------------------------------------------------------------------------------------

const TEMPLATES = [
  { id: "blank", name: "Blank", title: "Untitled document", blank: true },
  {
    id: "notes", name: "Meeting notes", title: "Meeting notes",
    outline: [
      { text: "Meeting notes", style: "TITLE" },
      { text: "Attendees", style: "HEADING_1" },
      { text: "Add the people in the room.", style: "NORMAL_TEXT" },
      { text: "Agenda", style: "HEADING_1" },
      { text: "First topic", style: "NORMAL_TEXT", bullet: true },
      { text: "Second topic", style: "NORMAL_TEXT", bullet: true },
      { text: "Action items", style: "HEADING_1" },
      { text: "Owner — what — by when", style: "NORMAL_TEXT", bullet: true },
    ],
  },
  {
    id: "proposal", name: "Project proposal", title: "Project proposal",
    outline: [
      { text: "Project proposal", style: "TITLE" },
      { text: "One line on why this matters.", style: "SUBTITLE" },
      { text: "Problem", style: "HEADING_1" },
      { text: "What is broken today?", style: "NORMAL_TEXT" },
      { text: "Proposal", style: "HEADING_1" },
      { text: "What we will do about it.", style: "NORMAL_TEXT" },
      { text: "Risks", style: "HEADING_1" },
      { text: "First risk", style: "NORMAL_TEXT", bullet: true },
    ],
  },
  {
    id: "brief", name: "Product brief", title: "Product brief",
    outline: [
      { text: "Product brief", style: "TITLE" },
      { text: "Summary", style: "HEADING_1" },
      { text: "Two sentences a reader can repeat.", style: "NORMAL_TEXT" },
      { text: "Goals", style: "HEADING_1" },
      { text: "Goal one", style: "NORMAL_TEXT", bullet: true },
      { text: "Non-goals", style: "HEADING_1" },
      { text: "Explicitly out of scope.", style: "NORMAL_TEXT" },
    ],
  },
];

function renderHomeChrome() {
  $(".recent-title").textContent = SCOPES[state.home.scope].title;
  $("#owner-filter").firstChild.textContent =
    state.home.owner === "me" ? "Owned by me" : state.home.owner === "others" ? "Not owned by me" : "Owned by anyone";
  const sort = SORTS.find((entry) => entry.id === state.home.sort) ?? SORTS[0];
  $("#col-date").textContent = state.home.scope === "trash" ? "Trashed" : sort.column;
  const templates = $("#templates");
  if (templates.childElementCount === 0) {
    for (const template of TEMPLATES) {
      const card = el("button", { class: "template", attrs: { type: "button" } });
      const thumb = el("div", { class: "template-thumb" });
      if (template.blank) thumb.append(el("span", { class: "plus", text: "+" }));
      else {
        const preview = el("div", { class: "template-preview" });
        preview.append(el("div", { class: "tp-head" }));
        for (const entry of template.outline.slice(1, 7)) {
          preview.append(el("div", { class: entry.style.startsWith("HEADING") ? "tp-sub" : "tp-line" }));
        }
        thumb.append(preview);
      }
      card.append(thumb, el("span", { class: "template-name", text: template.name }));
      card.addEventListener("click", () => createFromTemplate(template));
      templates.append(card);
    }
  }
}

/** The Drive `q` for the current scope, owner filter and search box — shown to the user as a chip. */
function buildQuery() {
  const clauses = [`mimeType = '${DOC_MIME}'`];
  clauses.push(state.home.scope === "trash" ? "trashed = true" : "trashed = false");
  if (state.home.scope === "starred") clauses.push("starred = true");
  if (state.home.scope === "shared") clauses.push("sharedWithMe = true");
  if (state.home.owner === "me") clauses.push("'me' in owners");
  if (state.home.owner === "others") clauses.push("not 'me' in owners");
  const search = state.home.search.trim();
  if (search.length > 0) clauses.push(`fullText contains '${search.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`);
  return clauses.join(" and ");
}

async function loadFiles({ reset = false, quiet = false } = {}) {
  const home = state.home;
  if (reset) {
    home.files = [];
    home.token = null;
    home.error = null;
    home.query = buildQuery();
  }
  home.loading = true;
  if (!quiet) renderFiles();
  try {
    const result = await call("files.list", {
      q: home.query,
      pageSize: PAGE_SIZE,
      orderBy: home.sort,
      ...(home.token ? { pageToken: home.token } : {}),
    });
    home.files = reset ? result.files : [...home.files, ...result.files];
    home.token = result.nextPageToken ?? null;
    home.error = null;
  } catch (error) {
    if (error instanceof ToolError && error.is("INVALID_PAGE_TOKEN") && home.token) {
      home.token = null;
      home.loading = false;
      return loadFiles({ reset: true });
    }
    home.error = error;
  } finally {
    home.loading = false;
  }
  renderFiles();
}

function renderFiles() {
  const home = state.home;
  const list = $("#recent-list");
  const banner = $("#home-banner");
  banner.hidden = !home.error;
  if (home.error) $("#home-banner-text").textContent = describe(home.error);

  if (home.loading && home.files.length === 0) {
    list.replaceChildren(skeletonRows(6));
    $("#recent-more").hidden = true;
    return;
  }
  if (home.error && home.files.length === 0) {
    list.replaceChildren(placeholder("error", "Couldn't load your documents", describe(home.error), { label: "Try again", onSelect: () => loadFiles({ reset: true }) }));
    $("#recent-more").hidden = true;
    return;
  }
  if (home.files.length === 0) {
    const [glyph, title, text] = home.search.trim()
      ? ["search", "No documents match your search", `Nothing matches “${home.search.trim()}”. The search box compiles to the Drive query shown above.`]
      : SCOPES[home.scope].empty;
    list.replaceChildren(placeholder(glyph, title, text));
    $("#recent-more").hidden = true;
    renderQueryChip();
    return;
  }

  list.className = home.layout === "grid" ? "recent-grid" : "recent-list";
  $("#recent-columns").hidden = home.layout === "grid";
  list.replaceChildren(...home.files.map((file) => (home.layout === "grid" ? gridCard(file) : fileRow(file))));
  $("#recent-more").hidden = home.token === null;
  renderQueryChip();
}

function renderQueryChip() {
  const head = $("#recent");
  const existing = head.querySelector(".query-chip");
  if (existing) existing.remove();
  if (state.home.search.trim().length === 0 && state.home.scope === "recent" && state.home.owner === "anyone") return;
  const chip = el("div", { class: "query-chip", title: "The Drive query this view sends to files.list" }, [
    el("span", { text: `q: ${state.home.query}` }),
  ]);
  const clear = el("button", { attrs: { type: "button", "aria-label": "Clear filters" } });
  clear.append(icon("close"));
  clear.addEventListener("click", () => {
    state.home.search = "";
    state.home.owner = "anyone";
    $("#home-search-input").value = "";
    $("#search-clear").hidden = true;
    location.hash = "#/home";
    renderHomeChrome();
    loadFiles({ reset: true });
  });
  chip.append(clear);
  $("#recent-columns").before(chip);
}

function docIcon() {
  return el("img", { attrs: { src: "./assets/google-docs-2026.svg", alt: "Google Docs document", width: 24, height: 24 } });
}

function fileRow(file) {
  const row = el("div", { class: "doc-row", attrs: { role: "button", tabindex: "0", "data-id": file.id } });
  const name = el("div", { class: "doc-row-name" }, [docIcon(), el("span", { class: "doc-row-title", text: file.name })]);
  if (file.starred) name.append(el("span", { class: "doc-row-star", attrs: { title: "Starred" } }, icon("star_fill1")));
  const sort = SORTS.find((entry) => entry.id === state.home.sort) ?? SORTS[0];
  // A document the user never opened has no "last opened by me" date: show a dash rather than borrowing another date.
  const dateValue = state.home.scope === "trash"
    ? file.trashedTime
    : sort.field === "viewedByMeTime" ? file.viewedByMeTime : file[sort.field] ?? file.modifiedTime;
  row.append(
    name,
    el("span", { class: "doc-row-meta owner-cell", text: file.ownedByMe ? "me" : file.owners?.[0]?.displayName ?? "—" }),
    el("span", { class: "doc-row-meta", text: listDate(dateValue) }),
    el("span", { class: "doc-row-actions" }, [
      iconButton("folder_open", "Open file location", { attrs: { disabled: true, title: "Folders are out of scope in this synthetic Docs" } }),
      iconButton("more_vert", `More actions for ${file.name}`, {
        onClick: (event) => { event.stopPropagation(); rowMenu(event.currentTarget, file); },
      }),
    ]),
  );
  const open = () => openFromList(file);
  row.addEventListener("click", open);
  row.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); }
  });
  return row;
}

function gridCard(file) {
  const card = el("button", { class: "grid-card", attrs: { type: "button" } });
  const thumb = el("div", { class: "grid-thumb" });
  thumb.append(el("div", { class: "grid-thumb-title", text: file.name }));
  for (let index = 0; index < 8; index += 1) thumb.append(el("div", { class: "grid-thumb-line" }));
  const foot = el("div", { class: "grid-foot" }, [docIcon(), el("span", { class: "grid-foot-title", text: file.name })]);
  foot.append(iconButton("more_vert", `More actions for ${file.name}`, {
    onClick: (event) => { event.stopPropagation(); event.preventDefault(); rowMenu(event.currentTarget, file); },
  }));
  card.append(thumb, foot);
  card.addEventListener("click", () => openFromList(file));
  return card;
}

function openFromList(file) {
  if (file.trashed) {
    snack("This document is in the trash. Restore it to open it.", { label: "Restore", onSelect: () => setTrashed(file, false) });
    return;
  }
  location.hash = `#/document/${encodeURIComponent(file.id)}`;
}

function rowMenu(owner, file) {
  const can = file.capabilities ?? {};
  const items = file.trashed
    ? [
        { label: "Restore", icon: "restore", disabled: !can.canUntrash, onSelect: () => setTrashed(file, false) },
        { label: "Delete forever", icon: "delete", disabled: !can.canDelete, onSelect: () => deleteForever(file) },
      ]
    : [
        { label: "Open", icon: "article", onSelect: () => openFromList(file) },
        { divider: true },
        { label: "Rename", icon: "drive_file_rename_outline", disabled: !can.canRename, onSelect: () => renameDialog(file) },
        { label: "Share", icon: "person_add", disabled: !can.canShare, onSelect: () => shareDialog(file) },
        { label: "Make a copy", icon: "content_copy", disabled: !can.canCopy, onSelect: () => copyFile(file) },
        { label: file.starred ? "Remove from Starred" : "Add to Starred", icon: file.starred ? "star_fill1" : "star", onSelect: () => toggleStar(file) },
        { divider: true },
        { label: "Download", icon: "download", onSelect: () => exportDialog(file.id, file.name) },
        { label: "Move to trash", icon: "delete", disabled: !can.canTrash, onSelect: () => setTrashed(file, true) },
      ];
  openMenuFor(owner, items, { align: "right" });
}

async function mutate(operation, args, { success, refresh = true } = {}) {
  try {
    const value = await call(operation, args, newKey());
    if (success) snack(success);
    if (refresh) await loadFiles({ reset: true, quiet: true });
    return value;
  } catch (error) {
    snack(describe(error));
    return null;
  }
}

const toggleStar = (file) =>
  mutate("files.update", { fileId: file.id, starred: !file.starred }, { success: file.starred ? "Removed from Starred" : "Added to Starred" });

const setTrashed = (file, trashed) =>
  mutate("files.update", { fileId: file.id, trashed }, { success: trashed ? "Moved to trash" : "Restored" });

async function deleteForever(file) {
  const ok = await confirmDialog({
    title: "Delete forever?",
    text: `“${file.name}” and its comments, shares and revision history will be deleted permanently. This cannot be undone.`,
    confirmLabel: "Delete forever",
    danger: true,
  });
  if (!ok) return;
  await mutate("files.delete", { fileId: file.id }, { success: "Deleted forever" });
}

async function copyFile(file) {
  const copy = await mutate("files.copy", { fileId: file.id }, { refresh: false });
  if (!copy) return;
  snack(`Created “${copy.name}”`, { label: "Open", onSelect: () => { location.hash = `#/document/${encodeURIComponent(copy.id)}`; } });
  await loadFiles({ reset: true, quiet: true });
}

function renameDialog(file) {
  let input;
  openDialog({
    title: "Rename",
    render: (body) => {
      const field = el("div", { class: "field" });
      input = el("input", { attrs: { type: "text", value: file.name, "aria-label": "Document name", maxlength: "512" } });
      field.append(el("label", { text: "Please enter a new name for the item:" }), input);
      body.append(field);
    },
    actions: (close) => [
      button("text-btn", "Cancel", { onClick: () => close(false) }),
      button("filled-btn", "OK", { onClick: () => close(input.value.trim()) }),
    ],
    onClose: async (value) => {
      if (!value || value === file.name) return;
      const updated = await mutate("files.update", { fileId: file.id, name: value }, { success: "Renamed" });
      if (updated && state.doc?.fileId === file.id) {
        state.doc.file = updated;
        $("#doc-title").value = updated.name;
      }
    },
  });
}

async function createFromTemplate(template) {
  let created;
  try {
    created = await call("documents.create", { title: template.title }, newKey());
  } catch (error) {
    snack(describe(error));
    return;
  }
  if (!template.blank) {
    const text = template.outline.map((entry) => entry.text).join("\n");
    const requests = [{ insertText: { location: { index: 1 }, text: `${text}\n` } }];
    let cursor = 1;
    const ranges = template.outline.map((entry) => {
      const start = cursor;
      cursor += entry.text.length + 1;
      return { ...entry, startIndex: start, endIndex: cursor };
    });
    for (const entry of ranges) {
      if (entry.style !== "NORMAL_TEXT") {
        requests.push({
          updateParagraphStyle: {
            range: { startIndex: entry.startIndex, endIndex: entry.endIndex },
            paragraphStyle: { namedStyleType: entry.style },
            fields: "namedStyleType",
          },
        });
      }
    }
    const bullets = ranges.filter((entry) => entry.bullet);
    for (const entry of bullets) {
      requests.push({
        createParagraphBullets: {
          range: { startIndex: entry.startIndex, endIndex: entry.endIndex },
          bulletPreset: "BULLET_DISC_CIRCLE_SQUARE",
        },
      });
    }
    try {
      await call("documents.batch-update", { documentId: created.documentId, requests }, newKey());
    } catch (error) {
      snack(`The document was created but the template body failed: ${describe(error)}`);
    }
  }
  location.hash = `#/document/${encodeURIComponent(created.documentId)}`;
}

function wireChrome() {
  $("#drawer-toggle").addEventListener("click", (event) =>
    openMenuFor(event.currentTarget, [
      { header: "Google Docs" },
      { label: "Recent documents", icon: "article", checked: state.home.scope === "recent", onSelect: () => { location.hash = "#/home"; } },
      { label: "Starred", icon: "star", checked: state.home.scope === "starred", onSelect: () => { location.hash = "#/home/starred"; } },
      { label: "Shared with me", icon: "group", checked: state.home.scope === "shared", onSelect: () => { location.hash = "#/home/shared"; } },
      { label: "Trash", icon: "delete", checked: state.home.scope === "trash", onSelect: () => { location.hash = "#/home/trash"; } },
      { divider: true },
      { label: "Settings — not part of this Tool", disabled: true },
      { label: "About this synthetic Docs", icon: "info", onSelect: aboutDialog },
    ]));

  $("#search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    state.home.search = $("#home-search-input").value;
    $("#search-clear").hidden = state.home.search.length === 0;
    loadFiles({ reset: true });
  });
  $("#home-search-input").addEventListener("input", (event) => {
    $("#search-clear").hidden = event.target.value.length === 0;
  });
  $("#search-clear").addEventListener("click", () => {
    $("#home-search-input").value = "";
    $("#search-clear").hidden = true;
    state.home.search = "";
    loadFiles({ reset: true });
  });

  $("#owner-filter").addEventListener("click", (event) =>
    openMenuFor(event.currentTarget, [
      { label: "Owned by anyone", checked: state.home.owner === "anyone", onSelect: () => setOwner("anyone") },
      { label: "Owned by me", checked: state.home.owner === "me", onSelect: () => setOwner("me") },
      { label: "Not owned by me", checked: state.home.owner === "others", onSelect: () => setOwner("others") },
    ]));
  $("#sort-btn").addEventListener("click", (event) =>
    openMenuFor(event.currentTarget, [
      { header: "Sort by" },
      ...SORTS.map((sort) => ({
        label: sort.label,
        checked: state.home.sort === sort.id,
        onSelect: () => { state.home.sort = sort.id; renderHomeChrome(); loadFiles({ reset: true }); },
      })),
      { divider: true },
      { label: "Last modified by me — unsupported here", disabled: true, title: "files.list orderBy in this Tool has no modifiedByMeTime key" },
    ], { align: "right" }));
  $("#layout-btn").addEventListener("click", () => {
    state.home.layout = state.home.layout === "list" ? "grid" : "list";
    const node = $("#layout-btn");
    node.setAttribute("aria-pressed", String(state.home.layout === "grid"));
    node.setAttribute("aria-label", state.home.layout === "grid" ? "List view" : "Grid view");
    node.replaceChildren(icon(state.home.layout === "grid" ? "view_list" : "grid_view"));
    renderFiles();
  });
  $("#picker-btn").addEventListener("click", () =>
    snack("There is no file picker in this synthetic Docs: every document in the world is already listed here."));
  $("#load-more").addEventListener("click", () => loadFiles());
  $("#home-banner-retry").addEventListener("click", () => loadFiles({ reset: true }));
  $("#apps-btn").addEventListener("click", (event) => appsDialog(event.currentTarget));
  $("#account-btn").addEventListener("click", (event) => accountMenu(event.currentTarget));
  $("#doc-account").addEventListener("click", (event) => accountMenu(event.currentTarget));
  $("#gallery-toggle").addEventListener("click", () => {
    state.templatesVisible = !state.templatesVisible;
    $("#templates").hidden = !state.templatesVisible;
    $("#template-band").classList.toggle("hidden-templates", !state.templatesVisible);
    $("#gallery-toggle").setAttribute("aria-expanded", String(state.templatesVisible));
  });
  $("#band-more").addEventListener("click", (event) =>
    openMenuFor(event.currentTarget, [
      { label: state.templatesVisible ? "Hide all templates" : "Show all templates", onSelect: () => $("#gallery-toggle").click() },
    ], { align: "right" }));

  wireEditorChrome();
}

function setOwner(owner) {
  state.home.owner = owner;
  renderHomeChrome();
  loadFiles({ reset: true });
}

// ---------------------------------------------------------------------------------------------
// Editor — loading and chrome
// ---------------------------------------------------------------------------------------------

const ZOOMS = [0.5, 0.75, 0.9, 1, 1.25, 1.5, 2];
const FONTS = ["Arial", "Courier New", "Georgia", "Roboto", "Times New Roman", "Verdana"];
const COLORS = [
  ["#000000", "black"], ["#434343", "dark grey"], ["#666666", "grey"], ["#999999", "light grey"],
  ["#cc0000", "red"], ["#e69138", "orange"], ["#f1c232", "yellow"], ["#6aa84f", "green"],
  ["#3d85c6", "blue"], ["#674ea7", "purple"], ["#a64d79", "magenta"], ["#ffffff", "white"],
];
const HIGHLIGHTS = [
  ["#ffff00", "yellow"], ["#00ff00", "green"], ["#00ffff", "cyan"], ["#ff00ff", "magenta"],
  ["#fce5cd", "light orange"], ["#d9ead3", "light green"], ["#cfe2f3", "light blue"], ["#ead1dc", "light pink"],
];

function newDocState(fileId) {
  return {
    fileId,
    file: null,
    resource: null,
    comments: [],
    commentsToken: null,
    commentFilter: "open",
    commentsLoading: false,
    revisions: [],
    revision: null,
    panel: null,
    activeComment: null,
    draftComment: null,
    dirty: null,
    saveTimer: null,
    saving: false,
    saved: false,
    selection: null,
    lastRequest: null,
    zoom: 1,
    outline: true,
    ruler: true,
    error: null,
    conflict: false,
  };
}

async function openDocument(fileId, { keepPanel = false, quiet = false } = {}) {
  const previous = state.doc;
  const doc = keepPanel && previous?.fileId === fileId ? previous : newDocState(fileId);
  if (keepPanel && previous?.fileId === fileId) Object.assign(doc, { error: null, conflict: false });
  state.doc = doc;
  if (!quiet) {
    $("#page-content").replaceChildren(skeletonRows(6));
    $("#doc-title").value = "";
    $("#save-chip").textContent = "";
    $("#page-scroll").scrollTop = 0;
  }
  try {
    const [file, resource] = await Promise.all([
      call("files.get", { fileId }),
      call("documents.get", { documentId: fileId }),
    ]);
    doc.file = file;
    doc.resource = resource;
    doc.error = null;
  } catch (error) {
    doc.error = error;
    renderEditorChrome();
    // A document that would not load has no outline and no comments: drop those columns rather than
    // leaving an empty panel beside the error, which is what Docs does when a document cannot open.
    $("#outline").hidden = true;
    $("#outline-rail").hidden = true;
    $("#doc-caret").hidden = true;
    $("#page-actions").classList.remove("show");
    $("#page-content").replaceChildren(
      placeholder(
        error instanceof ToolError && error.is("NOT_FOUND") ? "search" : "error",
        error instanceof ToolError && error.is("NOT_FOUND") ? "Can't open this document" : "Couldn't load this document",
        describe(error),
        { label: "Back to Docs home", onSelect: () => { location.hash = "#/home"; } },
      ),
    );
    return;
  }
  if (!quiet && !keepPanel) markOpened(doc);
  await loadComments({ reset: true, quiet: true });
  renderEditor();
}

/**
 * Opening a document is what "Last opened by me" records. Reads never do that in this Tool, so the app says it
 * explicitly with Drive's writable `viewedByMeTime`, stamped with the world's virtual now (never the browser clock).
 * Best effort: an actor without the files.update or about.get grant, or a rate-limited world, keeps the old value.
 */
async function markOpened(doc) {
  if (!doc.file || doc.file.trashed) return;
  let now = state.about?.serverTime ?? null;
  try {
    const about = await call("about.get");
    if (about.serverTime) {
      now = about.serverTime;
      setServerTime(about.serverTime);
    }
  } catch {
    // Keep the serverTime read at boot (or none, when about.get is not granted).
  }
  if (!now) return;
  try {
    const file = await call("files.update", { fileId: doc.fileId, viewedByMeTime: now }, newKey());
    if (state.doc === doc && doc.file) doc.file = { ...doc.file, viewedByMe: file.viewedByMe, viewedByMeTime: file.viewedByMeTime };
  } catch {
    // Not granted or refused: the document is still open; the home list keeps its previous "last opened" date.
  }
}

function renderEditor() {
  renderEditorChrome();
  renderPage();
  renderOutline();
  renderPanel();
  renderMarginComments();
  placePageActions();
  paintCaret();
}

function renderEditorChrome() {
  const doc = state.doc;
  const file = doc.file;
  $("#doc-title").value = file?.name ?? "";
  sizeTitle();
  $("#doc-title").disabled = !file?.capabilities?.canRename;
  const star = $("#star-btn");
  star.setAttribute("aria-pressed", String(Boolean(file?.starred)));
  star.setAttribute("aria-label", file?.starred ? "Remove star" : "Star");
  star.replaceChildren(icon(file?.starred ? "star_fill1" : "star"));
  buildMenubar();
  buildToolbar();

  const banner = $("#doc-banner");
  const text = $("#doc-banner-text");
  const action = $("#doc-banner-action");
  banner.className = "doc-banner";
  action.hidden = true;
  if (doc.conflict) {
    banner.hidden = false;
    banner.classList.add("warn");
    text.textContent = "This document changed somewhere else, so your last edit was not applied (writeControl precondition failed).";
    action.hidden = false;
    action.textContent = "Reload the document";
    action.onclick = () => openDocument(doc.fileId, { keepPanel: true });
  } else if (doc.error) {
    banner.hidden = false;
    banner.classList.add("error");
    text.textContent = describe(doc.error);
    action.hidden = false;
    action.textContent = "Retry";
    action.onclick = () => openDocument(doc.fileId, { keepPanel: true });
  } else if (file && !file.capabilities?.canEdit) {
    banner.hidden = false;
    text.textContent = file.capabilities?.canComment
      ? "You're commenting on this document. Ask the owner for edit access to change the text."
      : "You're viewing this document as a reader. Ask the owner for access to comment or edit.";
  } else {
    banner.hidden = true;
  }
  saveChip(doc.saving ? "saving" : doc.saved ? "saved" : "idle");
}

function saveChip(mode) {
  const chip = $("#save-chip");
  chip.replaceChildren();
  if (mode === "saving") chip.append(el("span", { text: "Saving…" }));
  // The cloud glyph lives on the document-status button beside the title, as it does in Docs;
  // the chip carries only the wording, so the header never shows two save indicators.
  else if (mode === "saved") chip.append(el("span", { text: "All changes saved in Drive" }));
}

function buildMenubar() {
  const doc = state.doc;
  const can = doc.file?.capabilities ?? {};
  const menus = {
    File: () => [
      { label: "New document", icon: "post_add", shortcut: "Ctrl+Alt+N", onSelect: () => createFromTemplate(TEMPLATES[0]) },
      { label: "Make a copy", icon: "content_copy", disabled: !can.canCopy, onSelect: () => copyFile(doc.file) },
      { divider: true },
      { label: "Share", icon: "person_add", disabled: !can.canShare, onSelect: () => shareDialog(doc.file) },
      { label: "Download", icon: "download", submenu: [
        { label: "Plain text (.txt)", onSelect: () => exportDialog(doc.fileId, doc.file.name, "text/plain") },
        { label: "Markdown (.md)", onSelect: () => exportDialog(doc.fileId, doc.file.name, "text/markdown") },
        { label: "Web page (.html)", onSelect: () => exportDialog(doc.fileId, doc.file.name, "text/html") },
        { divider: true },
        { label: "PDF, Word, EPUB — no renderer here", disabled: true },
      ] },
      { label: "Rename", icon: "drive_file_rename_outline", disabled: !can.canRename, onSelect: () => renameDialog(doc.file) },
      { label: "Move to trash", icon: "delete", disabled: !can.canTrash, onSelect: async () => {
        await setTrashed(doc.file, true);
        location.hash = "#/home";
      } },
      { divider: true },
      { label: "Version history", icon: "history", disabled: !can.canReadRevisions, onSelect: () => togglePanel("history") },
      { label: "Print — no renderer here", icon: "print", disabled: true },
      { label: "Page setup — not simulated", disabled: true },
    ],
    Edit: () => [
      { label: "Undo", icon: "undo", shortcut: "Ctrl+Z", disabled: true, title: "The Docs API has no undo: every change is a batchUpdate" },
      { label: "Redo", icon: "redo", shortcut: "Ctrl+Y", disabled: true },
      { divider: true },
      { label: "Find and replace", icon: "find_replace", shortcut: "Ctrl+H", disabled: !can.canEdit, onSelect: findReplaceDialog },
      { divider: true },
      { label: "Cut, copy and paste use the browser", disabled: true },
    ],
    View: () => [
      { label: "Show outline", checked: doc.outline, onSelect: () => { doc.outline = !doc.outline; renderOutline(); } },
      { label: "Show ruler", checked: doc.ruler, onSelect: () => { doc.ruler = !doc.ruler; $("#ruler").hidden = !doc.ruler; } },
      { label: "Show comments", checked: doc.panel === "comments", onSelect: () => togglePanel("comments") },
      { divider: true },
      { label: "Mode", submenu: [
        { label: "Editing", checked: Boolean(can.canEdit), disabled: !can.canEdit },
        { label: "Suggesting — not simulated", disabled: true },
        { label: "Viewing", checked: !can.canEdit, disabled: true },
      ] },
      { label: "Full screen — not simulated", disabled: true },
    ],
    Insert: () => [
      { label: "Table", icon: "table", disabled: !can.canEdit, onSelect: insertTableDialog },
      { label: "Page break", disabled: !can.canEdit, onSelect: () => insertPageBreak() },
      { divider: true },
      { label: "Link", icon: "add_link", shortcut: "Ctrl+K", disabled: !can.canEdit, onSelect: linkDialog },
      { label: "Comment", icon: "add_comment", shortcut: "Ctrl+Alt+M", disabled: !can.canComment, onSelect: startComment },
      { label: "Bookmark", icon: "filter_alt", disabled: !can.canEdit, onSelect: bookmarkDialog },
      { divider: true },
      { label: "Image, drawing, chart — not simulated", icon: "image", disabled: true },
      { label: "Headers, footers, footnotes — not simulated", disabled: true },
    ],
    Format: () => [
      { label: "Text", icon: "text_fields", submenu: [
        { label: "Bold", shortcut: "Ctrl+B", onSelect: () => toggleStyle("bold") },
        { label: "Italic", shortcut: "Ctrl+I", onSelect: () => toggleStyle("italic") },
        { label: "Underline", shortcut: "Ctrl+U", onSelect: () => toggleStyle("underline") },
        { label: "Strikethrough", onSelect: () => toggleStyle("strikethrough") },
        { label: "Superscript", onSelect: () => setBaseline("SUPERSCRIPT") },
        { label: "Subscript", onSelect: () => setBaseline("SUBSCRIPT") },
        { label: "Small caps", onSelect: () => toggleStyle("smallCaps") },
      ] },
      { label: "Paragraph styles", submenu: () => styleItems() },
      { label: "Align & indent", submenu: [
        { label: "Left", icon: "format_align_left", onSelect: () => setAlignment("START") },
        { label: "Centre", icon: "format_align_center", onSelect: () => setAlignment("CENTER") },
        { label: "Right", icon: "format_align_right", onSelect: () => setAlignment("END") },
        { label: "Justified", icon: "format_align_justify", onSelect: () => setAlignment("JUSTIFIED") },
        { divider: true },
        { label: "Increase indent", icon: "format_indent_increase", onSelect: () => indent(18) },
        { label: "Decrease indent", icon: "format_indent_decrease", onSelect: () => indent(-18) },
      ] },
      { label: "Line & paragraph spacing", icon: "format_line_spacing", submenu: [
        { label: "Single", onSelect: () => setLineSpacing(100) },
        { label: "1.15", onSelect: () => setLineSpacing(115) },
        { label: "1.5", onSelect: () => setLineSpacing(150) },
        { label: "Double", onSelect: () => setLineSpacing(200) },
      ] },
      { label: "Columns — not simulated", disabled: true },
      { label: "Bullets & numbering", submenu: [
        { label: "Bulleted list", icon: "format_list_bulleted", onSelect: () => addBullets("BULLET_DISC_CIRCLE_SQUARE") },
        { label: "Numbered list", icon: "format_list_numbered", onSelect: () => addBullets("NUMBERED_DECIMAL_ALPHA_ROMAN") },
        { label: "Checklist", icon: "checklist", onSelect: () => addBullets("BULLET_CHECKBOX") },
        { divider: true },
        { label: "Remove list formatting", onSelect: removeBullets },
      ] },
      { label: "Headers & footers — not simulated", disabled: true },
      { label: "Page numbers — not simulated", disabled: true },
      { label: "Page orientation — not simulated", disabled: true },
      { divider: true },
      { label: "Table — not simulated", icon: "table", disabled: true, title: "Insert > Table creates tables; table properties are not modelled" },
      { label: "Image — not simulated", icon: "image", disabled: true },
      { divider: true },
      { label: "Clear formatting", icon: "format_clear", shortcut: "Ctrl+\\", onSelect: clearFormatting },
    ],
    Tools: () => [
      { label: "Word count", shortcut: "Ctrl+Shift+C", onSelect: wordCountDialog },
      { label: "Version history", icon: "history", disabled: !can.canReadRevisions, onSelect: () => togglePanel("history") },
      { divider: true },
      { label: "Spelling and grammar — not simulated", icon: "spellcheck", disabled: true },
      { label: "Voice typing — not simulated", disabled: true },
    ],
    Extensions: () => [
      { label: "Add-ons — not part of this Tool", disabled: true },
      { label: "Apps Script — not part of this Tool", disabled: true },
    ],
    Help: () => [
      { label: "Keyboard shortcuts", onSelect: shortcutsDialog },
      { label: "About this synthetic Docs", icon: "info", onSelect: aboutDialog },
      { divider: true },
      { label: "Docs Help — no external links here", disabled: true },
    ],
  };

  const bar = $("#menubar");
  bar.replaceChildren();
  for (const [name, items] of Object.entries(menus)) {
    const node = el("button", { class: "menu-item", text: name, attrs: { type: "button", "aria-haspopup": "menu", "aria-expanded": "false" } });
    node.addEventListener("click", (event) => openMenuFor(event.currentTarget, items()));
    bar.append(node);
  }
  if (doc.file) {
    bar.append(el("span", { class: "menubar-note", text: `Last edit was ${relative(doc.file.modifiedTime)}` }));
  }
}

function styleItems() {
  return Object.entries(STYLE_LABEL).map(([value, label]) => ({
    label,
    styleClass: value === "TITLE" ? "style-title" : value === "SUBTITLE" ? "style-subtitle"
      : value === "HEADING_1" ? "style-h1" : value === "HEADING_2" ? "style-h2" : value === "HEADING_3" ? "style-h3" : "",
    checked: currentParagraphStyle() === value,
    onSelect: () => setNamedStyle(value),
  }));
}

function toolSelect(label, options = {}) {
  const node = el("button", { class: "tool-select", attrs: { type: "button", "aria-haspopup": "menu", "aria-expanded": "false", title: options.title ?? label } });
  node.append(el("span", { class: "label", text: label }), icon("arrow_drop_down"));
  if (options.onClick) node.addEventListener("click", options.onClick);
  return node;
}

function buildToolbar() {
  const doc = state.doc;
  const can = doc.file?.capabilities ?? {};
  const editable = Boolean(can.canEdit);
  const bar = $("#toolbar");
  bar.replaceChildren();
  const sep = () => el("span", { class: "tool-sep", attrs: { "aria-hidden": "true" } });
  const disabledNote = "The Docs API has no undo: this app sends one batchUpdate per change";

  bar.append(
    iconButton("undo", "Undo", { attrs: { disabled: true, title: disabledNote } }),
    iconButton("redo", "Redo", { attrs: { disabled: true, title: disabledNote } }),
    iconButton("print", "Print", { attrs: { disabled: true, title: "No renderer in this synthetic Docs" } }),
    iconButton("spellcheck", "Spelling and grammar check", { attrs: { disabled: true, title: "Not simulated" } }),
    iconButton("format_paint", "Paint format", { attrs: { disabled: true, title: "Not simulated" } }),
    sep(),
    toolSelect(`${Math.round(doc.zoom * 100)}%`, {
      title: "Zoom",
      onClick: (event) => openMenuFor(event.currentTarget, ZOOMS.map((zoom) => ({
        label: `${Math.round(zoom * 100)}%`,
        checked: doc.zoom === zoom,
        onSelect: () => { doc.zoom = zoom; applyZoom(); buildToolbar(); },
      }))),
    }),
    sep(),
    toolSelect(STYLE_LABEL[currentParagraphStyle()] ?? "Normal text", {
      title: "Styles",
      onClick: (event) => openMenuFor(event.currentTarget, styleItems()),
    }),
    sep(),
    toolSelect(currentFont(), {
      title: "Font",
      onClick: (event) => openMenuFor(event.currentTarget, FONTS.map((font) => ({
        label: font,
        checked: currentFont() === font,
        onSelect: () => setFont(font),
      }))),
    }),
    sep(),
  );

  const size = el("span", { class: "tool-size" });
  const sizeInput = el("input", { attrs: { type: "text", value: String(currentFontSize()), "aria-label": "Font size", inputmode: "numeric" } });
  size.append(
    iconButton("close", "Decrease font size", { attrs: { disabled: !editable } }),
    sizeInput,
    iconButton("add", "Increase font size", { attrs: { disabled: !editable } }),
  );
  size.firstChild.replaceChildren(el("span", { text: "−" }));
  size.firstChild.addEventListener("click", () => setFontSize(currentFontSize() - 1));
  size.lastChild.addEventListener("click", () => setFontSize(currentFontSize() + 1));
  sizeInput.addEventListener("change", () => setFontSize(Number(sizeInput.value)));
  bar.append(size, sep());

  const marks = [
    ["format_bold", "Bold (Ctrl+B)", () => toggleStyle("bold"), "bold"],
    ["format_italic", "Italic (Ctrl+I)", () => toggleStyle("italic"), "italic"],
    ["format_underlined", "Underline (Ctrl+U)", () => toggleStyle("underline"), "underline"],
    ["strikethrough_s", "Strikethrough", () => toggleStyle("strikethrough"), "strikethrough"],
  ];
  const style = currentTextStyle();
  for (const [glyph, label, onSelect, field] of marks) {
    bar.append(iconButton(glyph, label, {
      onClick: onSelect,
      attrs: { disabled: !editable, "aria-pressed": String(Boolean(style[field])) },
    }));
  }
  bar.append(
    iconButton("format_color_text", "Text colour", {
      attrs: { disabled: !editable },
      onClick: (event) => openMenuFor(event.currentTarget, [
        { header: "Text colour" },
        ...COLORS.map(([value, name]) => ({ label: name, onSelect: () => setColor("foregroundColor", value) })),
      ]),
    }),
    iconButton("format_ink_highlighter", "Highlight colour", {
      attrs: { disabled: !editable },
      onClick: (event) => openMenuFor(event.currentTarget, [
        { header: "Highlight colour" },
        ...HIGHLIGHTS.map(([value, name]) => ({ label: name, onSelect: () => setColor("backgroundColor", value) })),
        { divider: true },
        { label: "None", onSelect: () => setColor("backgroundColor", null) },
      ]),
    }),
    sep(),
    iconButton("add_link", "Insert link (Ctrl+K)", { attrs: { disabled: !editable }, onClick: linkDialog }),
    iconButton("add_comment", "Add comment (Ctrl+Alt+M)", { attrs: { disabled: !can.canComment }, onClick: startComment }),
    iconButton("image", "Insert image", { attrs: { disabled: true, title: "Images are not simulated" } }),
    sep(),
    toolSelect("", {
      title: "Alignment",
      onClick: (event) => openMenuFor(event.currentTarget, [
        { label: "Left", icon: "format_align_left", onSelect: () => setAlignment("START") },
        { label: "Centre", icon: "format_align_center", onSelect: () => setAlignment("CENTER") },
        { label: "Right", icon: "format_align_right", onSelect: () => setAlignment("END") },
        { label: "Justified", icon: "format_align_justify", onSelect: () => setAlignment("JUSTIFIED") },
      ]),
    }),
    toolSelect("", {
      title: "Line & paragraph spacing",
      onClick: (event) => openMenuFor(event.currentTarget, [
        { label: "Single", onSelect: () => setLineSpacing(100) },
        { label: "1.15", onSelect: () => setLineSpacing(115) },
        { label: "1.5", onSelect: () => setLineSpacing(150) },
        { label: "Double", onSelect: () => setLineSpacing(200) },
      ]),
    }),
    iconButton("checklist", "Checklist", { attrs: { disabled: !editable }, onClick: () => addBullets("BULLET_CHECKBOX") }),
    iconButton("format_list_bulleted", "Bulleted list", { attrs: { disabled: !editable }, onClick: () => addBullets("BULLET_DISC_CIRCLE_SQUARE") }),
    iconButton("format_list_numbered", "Numbered list", { attrs: { disabled: !editable }, onClick: () => addBullets("NUMBERED_DECIMAL_ALPHA_ROMAN") }),
    iconButton("format_indent_decrease", "Decrease indent", { attrs: { disabled: !editable }, onClick: () => indent(-18) }),
    iconButton("format_indent_increase", "Increase indent", { attrs: { disabled: !editable }, onClick: () => indent(18) }),
    iconButton("format_clear", "Clear formatting", { attrs: { disabled: !editable }, onClick: clearFormatting }),
    el("span", { class: "toolbar-spacer" }),
  );
  const mode = el("button", { class: "mode-btn", attrs: { type: "button", "aria-haspopup": "menu", "aria-expanded": "false", title: "Mode" } });
  mode.append(icon(editable ? "edit" : "visibility"), el("span", { text: editable ? "Editing" : "Viewing" }));
  mode.addEventListener("click", (event) => openMenuFor(event.currentTarget, [
    { label: "Editing", icon: "edit", checked: editable, disabled: !editable, title: editable ? undefined : "You do not have edit access" },
    { label: "Suggesting — not simulated", disabled: true },
    { label: "Viewing", icon: "visibility", checked: !editable, disabled: true },
  ], { align: "right" }));
  bar.append(mode);
  // The two alignment/spacing selects carry glyphs rather than text, like the real toolbar.
  const selects = bar.querySelectorAll(".tool-select");
  selects[selects.length - 2]?.firstChild.replaceChildren(icon(alignmentIcon()));
  selects[selects.length - 1]?.firstChild.replaceChildren(icon("format_line_spacing"));
}

function applyZoom() {
  const page = $("#page");
  page.style.transform = state.doc.zoom === 1 ? "" : `scale(${state.doc.zoom})`;
  page.style.transformOrigin = "top center";
  page.style.marginBottom = state.doc.zoom < 1 ? `${(state.doc.zoom - 1) * 1056}px` : "";
}

// ---------------------------------------------------------------------------------------------
// Editor — the page surface
// ---------------------------------------------------------------------------------------------

/** Anchored comments as index ranges: Drive stores {"r":revision,"a":[{"txt":{"o":offset,"l":length}}]}. */
function commentAnchors() {
  const anchors = [];
  for (const comment of state.doc.comments) {
    if (comment.deleted || comment.resolved || typeof comment.anchor !== "string") continue;
    let parsed;
    try {
      parsed = JSON.parse(comment.anchor);
    } catch {
      continue;
    }
    for (const entry of parsed?.a ?? []) {
      const region = entry?.txt;
      if (!region || typeof region.o !== "number" || typeof region.l !== "number") continue;
      anchors.push({ startIndex: region.o, endIndex: region.o + region.l, commentId: comment.id });
    }
  }
  return anchors;
}

function renderPage() {
  const doc = state.doc;
  const container = $("#page-content");
  const editable = Boolean(doc.file?.capabilities?.canEdit);
  renderBody(container, doc.resource, {
    editable,
    anchors: commentAnchors(),
    activeComment: doc.activeComment,
  });
  for (const block of container.querySelectorAll("p[data-start]")) block.dataset.baseline = block.textContent;
  applyZoom();
}

function renderOutline() {
  const doc = state.doc;
  const panel = $("#outline");
  panel.hidden = !doc.outline;
  $("#outline-rail").hidden = doc.outline;
  if (!doc.outline) return;
  const entries = outlineEntries(doc.resource);
  const head = el("div", { class: "outline-head" }, [el("h2", { text: "Tabs and outline" })]);
  head.append(iconButton("left_panel_close", "Hide tabs and outline", {
    attrs: { title: "Hide tabs and outline" },
    onClick: () => { doc.outline = false; renderOutline(); renderMarginComments(); placePageActions(); },
  }));
  panel.replaceChildren(head);

  // Document tabs. This Tool stores one tab per document (the Docs API tab list is not modelled),
  // so the section shows that single tab and says so instead of inventing siblings.
  const tabs = el("div", { class: "outline-section" });
  const tab = el("button", { class: "doc-tab", attrs: { type: "button", "aria-current": "true" } }, [
    icon("article"),
    el("span", { class: "tab-name", text: doc.file?.name ?? "Untitled document" }),
  ]);
  tab.addEventListener("click", () => { $("#page-scroll").scrollTop = 0; });
  tabs.append(tab);
  const addTab = el("button", {
    class: "outline-add",
    text: "Add tab",
    attrs: { type: "button", disabled: "", title: "Document tabs are not simulated by this Tool" },
  });
  addTab.prepend(icon("add"));
  tabs.append(addTab);
  panel.append(tabs);

  const section = el("div", { class: "outline-section" }, [el("h3", { text: "Outline" })]);
  panel.append(section);
  if (entries.length === 0) {
    section.append(el("p", { class: "outline-empty", text: "Headings you add to the document will appear here." }));
    return;
  }
  for (const entry of entries) {
    const item = el("button", { class: `outline-item lvl${Math.min(entry.level, 3)}`, text: entry.text, attrs: { type: "button" } });
    item.addEventListener("click", () => {
      const block = blockAt($("#page-content"), entry.startIndex);
      block?.scrollIntoView({ block: "center" });
      if (block) placeCaret($("#page-content"), entry.startIndex);
    });
    section.append(item);
  }
}

function renderMarginComments() {
  const doc = state.doc;
  const holder = $("#margin-comments");
  holder.replaceChildren();
  const scroll = $("#page-scroll");
  const page = $("#page");
  const open = doc.comments.filter((comment) => !comment.deleted && !comment.resolved);
  // Docs reserves a column for comment cards, so a commented document is not centred on the canvas.
  const room = doc.panel === null && open.length > 0 && scroll.clientWidth > 900;
  scroll.style.paddingRight = room ? "296px" : "";
  $("#ruler").style.paddingRight = room ? "296px" : "";
  if (!room) {
    holder.hidden = true;
    return;
  }
  holder.hidden = false;
  holder.style.left = `${Math.round(page.offsetLeft + page.offsetWidth + 16)}px`;

  const anchors = commentAnchors();
  const placed = [];
  for (const comment of open) {
    const bubble = el("button", { class: `bubble${comment.id === doc.activeComment ? " active" : ""}`, attrs: { type: "button" } });
    bubble.append(
      el("div", { class: "bubble-head" }, [
        avatar(comment.author, true),
        el("span", { class: "bubble-author", text: comment.author.displayName }),
        el("span", { class: "bubble-time", text: relative(comment.modifiedTime) }),
      ]),
      el("div", { class: "bubble-text", text: comment.content }),
    );
    const replies = (comment.replies ?? []).filter((reply) => !reply.deleted);
    if (replies.length > 0) {
      bubble.append(el("div", { class: "bubble-replies", text: replies.length === 1 ? "1 reply" : `${replies.length} replies` }));
    }
    // Docs collapses the reply field to a placeholder until the card is opened; clicking the card
    // opens the thread in the comments panel, where the reply is actually written and sent.
    bubble.append(el("div", { class: "bubble-reply-hint", text: "Reply" }));
    bubble.addEventListener("click", () => {
      doc.activeComment = comment.id;
      togglePanel("comments", true);
      renderPage();
    });
    holder.append(bubble);
    const anchor = anchors.find((entry) => entry.commentId === comment.id);
    const marked = anchor ? $(`#page-content [data-comment-id="${CSS.escape(comment.id)}"]`) : null;
    const wanted = marked ? marked.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop - 6 : 16;
    placed.push({ bubble, wanted });
  }
  let cursor = 0;
  for (const entry of placed) {
    const top = Math.max(entry.wanted, cursor);
    entry.bubble.style.top = `${Math.round(top)}px`;
    cursor = top + entry.bubble.offsetHeight + 8;
  }
}

/** Docs sizes the title field to its text; keep that so the header never truncates a short name. */
function sizeTitle() {
  const input = $("#doc-title");
  input.style.width = `${Math.min(46, Math.max(8, input.value.length + 2))}ch`;
}

// -------------------------------------------------------------- selection and current style

function structuralElements() {
  const elements = [];
  const walk = (list) => {
    for (const element of list ?? []) {
      if (element.paragraph) elements.push(element);
      if (element.table) {
        for (const row of element.table.tableRows ?? []) {
          for (const cell of row.tableCells ?? []) walk(cell.content);
        }
      }
    }
  };
  walk(state.doc?.resource?.body?.content);
  return elements;
}

function paragraphAt(index) {
  return structuralElements().find((element) => index >= element.startIndex && index < element.endIndex) ?? null;
}

function activeIndex() {
  const selection = state.doc?.selection;
  return selection ? selection.startIndex : null;
}

function currentParagraphStyle() {
  const index = activeIndex();
  if (index === null) return "NORMAL_TEXT";
  return paragraphAt(index)?.paragraph?.paragraphStyle?.namedStyleType ?? "NORMAL_TEXT";
}

function currentTextStyle() {
  const index = activeIndex();
  if (index === null) return {};
  const element = paragraphAt(index);
  for (const run of element?.paragraph?.elements ?? []) {
    if (run.textRun && index >= run.startIndex && index < run.endIndex) return run.textRun.textStyle ?? {};
  }
  return element?.paragraph?.elements?.[0]?.textRun?.textStyle ?? {};
}

function namedStyleDefaults(named) {
  const entry = (state.doc?.resource?.namedStyles?.styles ?? []).find((style) => style.namedStyleType === named);
  return entry?.textStyle ?? {};
}

function currentFont() {
  const style = currentTextStyle();
  return style.weightedFontFamily?.fontFamily ?? namedStyleDefaults(currentParagraphStyle()).weightedFontFamily?.fontFamily ?? "Arial";
}

function currentFontSize() {
  const style = currentTextStyle();
  return Math.round(style.fontSize?.magnitude ?? namedStyleDefaults(currentParagraphStyle()).fontSize?.magnitude ?? 11);
}

function alignmentIcon() {
  const index = activeIndex();
  const alignment = index === null ? "START" : paragraphAt(index)?.paragraph?.paragraphStyle?.alignment ?? "START";
  return alignment === "CENTER" ? "format_align_center"
    : alignment === "END" ? "format_align_right"
    : alignment === "JUSTIFIED" ? "format_align_justify" : "format_align_left";
}

// -------------------------------------------------------------- writes

/** One batchUpdate, guarded by writeControl so a change made elsewhere is refused rather than lost. */
async function batch(requests, { reload = true, caret = null, silent = false } = {}) {
  const doc = state.doc;
  if (requests.length === 0) return null;
  const payload = {
    documentId: doc.fileId,
    requests,
    writeControl: { requiredRevisionId: doc.resource.revisionId },
  };
  doc.lastRequest = { operation: "documents.batch-update", request: payload, response: null };
  doc.saving = true;
  doc.conflict = false;
  saveChip("saving");
  try {
    const value = await call("documents.batch-update", payload, newKey());
    doc.lastRequest.response = value;
    paintRequestDrawer();
    doc.saving = false;
    doc.saved = true;
    if (reload) await reloadDocument(caret);
    else saveChip("saved");
    return value;
  } catch (error) {
    doc.saving = false;
    doc.lastRequest.response = { error: { code: error.code, message: error.message } };
    paintRequestDrawer();
    saveChip("idle");
    if (error instanceof ToolError && error.is("FAILED_PRECONDITION") && /revision/i.test(error.message)) {
      doc.conflict = true;
      renderEditorChrome();
    } else if (!silent) {
      snack(describe(error));
    }
    return null;
  }
}

async function reloadDocument(caret = null) {
  const doc = state.doc;
  try {
    const [file, resource] = await Promise.all([
      call("files.get", { fileId: doc.fileId }),
      call("documents.get", { documentId: doc.fileId }),
    ]);
    doc.file = file;
    doc.resource = resource;
  } catch (error) {
    doc.error = error;
    renderEditorChrome();
    return;
  }
  await loadComments({ reset: true, quiet: true });
  if (doc.panel === "history") await loadRevisions();
  renderEditor();
  if (caret !== null) placeCaret($("#page-content"), caret);
}

/** The range the next formatting request applies to, or null with a hint to the user. */
function requireSelection({ allowCollapsed = false, verb = "format" } = {}) {
  const selection = state.doc.selection;
  if (!selection) {
    snack(`Put the cursor in the document first to ${verb} it.`);
    return null;
  }
  if (selection.collapsed && !allowCollapsed) {
    const element = paragraphAt(selection.startIndex);
    if (!element) {
      snack(`Select some text to ${verb}.`);
      return null;
    }
    return { startIndex: element.startIndex, endIndex: element.endIndex - 1, wholeParagraph: true };
  }
  return { startIndex: selection.startIndex, endIndex: selection.endIndex };
}

function paragraphRange() {
  const selection = state.doc.selection;
  if (!selection) {
    snack("Put the cursor in a paragraph first.");
    return null;
  }
  return { startIndex: selection.startIndex, endIndex: Math.max(selection.endIndex, selection.startIndex + 1) };
}

async function toggleStyle(field) {
  const range = requireSelection({ verb: "style" });
  if (!range) return;
  const current = Boolean(currentTextStyle()[field]);
  await flushEdit();
  await batch([{ updateTextStyle: { range: { startIndex: range.startIndex, endIndex: range.endIndex }, textStyle: { [field]: !current }, fields: field } }]);
  reselect(range);
}

async function setBaseline(value) {
  const range = requireSelection({ verb: "style" });
  if (!range) return;
  const current = currentTextStyle().baselineOffset;
  await flushEdit();
  await batch([{ updateTextStyle: { range, textStyle: { baselineOffset: current === value ? "NONE" : value }, fields: "baselineOffset" } }]);
  reselect(range);
}

async function setFont(fontFamily) {
  const range = requireSelection({ verb: "restyle" });
  if (!range) return;
  await flushEdit();
  await batch([{ updateTextStyle: { range, textStyle: { weightedFontFamily: { fontFamily, weight: 400 } }, fields: "weightedFontFamily" } }]);
  reselect(range);
}

async function setFontSize(magnitude) {
  if (!Number.isFinite(magnitude) || magnitude < 1 || magnitude > 400) {
    snack("Font size must be between 1 and 400 points.");
    buildToolbar();
    return;
  }
  const range = requireSelection({ verb: "resize" });
  if (!range) return;
  await flushEdit();
  await batch([{ updateTextStyle: { range, textStyle: { fontSize: { magnitude, unit: "PT" } }, fields: "fontSize" } }]);
  reselect(range);
}

function rgbColor(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return { red: ((value >> 16) & 255) / 255, green: ((value >> 8) & 255) / 255, blue: (value & 255) / 255 };
}

async function setColor(field, hex) {
  const range = requireSelection({ verb: "colour" });
  if (!range) return;
  await flushEdit();
  const textStyle = hex === null ? {} : { [field]: { color: { rgbColor: rgbColor(hex) } } };
  await batch([{ updateTextStyle: { range, textStyle, fields: field } }]);
  reselect(range);
}

async function setNamedStyle(namedStyleType) {
  const range = paragraphRange();
  if (!range) return;
  await flushEdit();
  await batch([{ updateParagraphStyle: { range, paragraphStyle: { namedStyleType }, fields: "namedStyleType" } }], { caret: range.startIndex });
}

async function setAlignment(alignment) {
  const range = paragraphRange();
  if (!range) return;
  await flushEdit();
  await batch([{ updateParagraphStyle: { range, paragraphStyle: { alignment }, fields: "alignment" } }], { caret: range.startIndex });
}

async function setLineSpacing(lineSpacing) {
  const range = paragraphRange();
  if (!range) return;
  await flushEdit();
  await batch([{ updateParagraphStyle: { range, paragraphStyle: { lineSpacing }, fields: "lineSpacing" } }], { caret: range.startIndex });
}

async function indent(delta) {
  const range = paragraphRange();
  if (!range) return;
  const element = paragraphAt(range.startIndex);
  const current = element?.paragraph?.paragraphStyle?.indentStart?.magnitude ?? 0;
  const magnitude = Math.max(0, current + delta);
  await flushEdit();
  await batch([{ updateParagraphStyle: { range, paragraphStyle: { indentStart: { magnitude, unit: "PT" } }, fields: "indentStart" } }], { caret: range.startIndex });
}

async function addBullets(bulletPreset) {
  const range = paragraphRange();
  if (!range) return;
  await flushEdit();
  await batch([{ createParagraphBullets: { range, bulletPreset } }], { caret: range.startIndex });
}

async function removeBullets() {
  const range = paragraphRange();
  if (!range) return;
  await flushEdit();
  await batch([{ deleteParagraphBullets: { range } }], { caret: range.startIndex });
}

async function clearFormatting() {
  const range = requireSelection({ verb: "clear" });
  if (!range) return;
  await flushEdit();
  await batch([
    { updateTextStyle: { range, textStyle: {}, fields: "bold,italic,underline,strikethrough,smallCaps,baselineOffset,foregroundColor,backgroundColor,link" } },
    { updateParagraphStyle: { range, paragraphStyle: { namedStyleType: "NORMAL_TEXT" }, fields: "namedStyleType" } },
  ]);
  reselect(range);
}

async function insertPageBreak() {
  const index = activeIndex();
  if (index === null) {
    snack("Put the cursor where the page break should go.");
    return;
  }
  await flushEdit();
  await batch([{ insertPageBreak: { location: { index } } }], { caret: index + 1 });
}

function reselect(range) {
  const container = $("#page-content");
  if (range.startIndex === range.endIndex) placeCaret(container, range.startIndex);
  else selectIndexRange(container, range.startIndex, range.endIndex);
}

// -------------------------------------------------------------- typing

/** Send the paragraph the user is typing in as one deleteContentRange + insertText batch. */
async function flushEdit({ caret = null } = {}) {
  const doc = state.doc;
  clearTimeout(doc.saveTimer);
  const dirty = doc.dirty;
  if (!dirty || doc.saving) return;
  const block = dirty.block;
  if (!block.isConnected) {
    doc.dirty = null;
    return;
  }
  const after = block.textContent;
  const difference = diffText(dirty.baseline, after);
  doc.dirty = null;
  if (!difference) return;
  const at = dirty.start + difference.at;
  const requests = [];
  if (difference.removed > 0) requests.push({ deleteContentRange: { range: { startIndex: at, endIndex: at + difference.removed } } });
  if (difference.inserted.length > 0) requests.push({ insertText: { location: { index: at }, text: difference.inserted } });
  const caretIndex = caret ?? at + difference.inserted.length;
  const sent = after;
  const value = await batch(requests, { reload: false });
  if (value === null) {
    // The change was refused: put the paragraph back to the last text the server confirmed.
    block.textContent = dirty.baseline;
    return;
  }
  if (block.isConnected && block.textContent !== sent) {
    // The user kept typing while the call was in flight: keep their text and send the rest next time.
    block.dataset.baseline = sent;
    scheduleFlush(block);
    return;
  }
  await reloadDocument(caretIndex);
}

function scheduleFlush(block) {
  const doc = state.doc;
  doc.dirty = { block, start: Number(block.dataset.start), baseline: block.dataset.baseline };
  clearTimeout(doc.saveTimer);
  doc.saveTimer = setTimeout(() => { flushEdit(); }, 1200);
  saveChip("saving");
}

function wirePage() {
  const container = $("#page-content");

  container.addEventListener("input", (event) => {
    const block = event.target.closest?.("p[data-start]") ?? (event.target.nodeType === 1 ? null : event.target.parentElement?.closest("p[data-start]"));
    if (!block || !block.isContentEditable) return;
    scheduleFlush(block);
  });

  container.addEventListener("focusout", (event) => {
    if (!state.doc?.dirty) return;
    if (event.relatedTarget?.closest?.("#page-content")) return;
    flushEdit();
  });

  container.addEventListener("keydown", async (event) => {
    const doc = state.doc;
    if (!doc?.resource) return;
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && !event.altKey) {
      const key = event.key.toLowerCase();
      if (key === "b" || key === "i" || key === "u") {
        event.preventDefault();
        await flushEdit();
        await toggleStyle(key === "b" ? "bold" : key === "i" ? "italic" : "underline");
        return;
      }
      if (key === "k") { event.preventDefault(); await flushEdit(); linkDialog(); return; }
      if (key === "s") { event.preventDefault(); await flushEdit(); return; }
      if (key === "h") { event.preventDefault(); await flushEdit(); findReplaceDialog(); return; }
    }
    if (modifier && event.altKey && event.key.toLowerCase() === "m") {
      event.preventDefault();
      startComment();
      return;
    }
    const selection = selectionRange(container);
    if (!selection) return;
    const block = selection.block;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      const index = selection.startIndex;
      await flushEdit({ caret: index });
      await batch([{ insertText: { location: { index }, text: "\n" } }], { caret: index + 1 });
      return;
    }
    const spansBlocks = !selection.collapsed && blockAt(container, selection.endIndex - 1) !== block;
    if ((event.key === "Backspace" || event.key === "Delete") && spansBlocks) {
      event.preventDefault();
      await flushEdit({ caret: selection.startIndex });
      await batch([{ deleteContentRange: { range: { startIndex: selection.startIndex, endIndex: selection.endIndex } } }], { caret: selection.startIndex });
      return;
    }
    if (event.key === "Backspace" && selection.collapsed && block && selection.startIndex === Number(block.dataset.start)) {
      const start = Number(block.dataset.start);
      if (start <= 1) { event.preventDefault(); return; }
      event.preventDefault();
      await flushEdit({ caret: start });
      await batch([{ deleteContentRange: { range: { startIndex: start - 1, endIndex: start } } }], { caret: start - 1 });
    }
  });

  container.addEventListener("paste", async (event) => {
    const selection = selectionRange(container);
    if (!selection) return;
    event.preventDefault();
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (text.length === 0) return;
    await flushEdit({ caret: selection.startIndex });
    const requests = [];
    if (!selection.collapsed) requests.push({ deleteContentRange: { range: { startIndex: selection.startIndex, endIndex: selection.endIndex } } });
    requests.push({ insertText: { location: { index: selection.startIndex }, text } });
    await batch(requests, { caret: selection.startIndex + text.length });
  });

  container.addEventListener("contextmenu", (event) => {
    const cell = event.target.closest?.("td[data-table-start]");
    if (!cell || !state.doc?.file?.capabilities?.canEdit) return;
    event.preventDefault();
    const location = {
      tableStartLocation: { index: Number(cell.dataset.tableStart) },
      rowIndex: Number(cell.dataset.row),
      columnIndex: Number(cell.dataset.column),
    };
    openMenuFor(cell, [
      { header: `Row ${location.rowIndex + 1}, column ${location.columnIndex + 1}` },
      { label: "Insert row above", icon: "table_rows", onSelect: () => tableEdit({ insertTableRow: { tableCellLocation: location, insertBelow: false } }) },
      { label: "Insert row below", icon: "table_rows", onSelect: () => tableEdit({ insertTableRow: { tableCellLocation: location, insertBelow: true } }) },
      { label: "Insert column left", icon: "table", onSelect: () => tableEdit({ insertTableColumn: { tableCellLocation: location, insertRight: false } }) },
      { label: "Insert column right", icon: "table", onSelect: () => tableEdit({ insertTableColumn: { tableCellLocation: location, insertRight: true } }) },
      { divider: true },
      { label: "Delete row", icon: "delete", onSelect: () => tableEdit({ deleteTableRow: { tableCellLocation: location } }) },
      { label: "Delete column", icon: "delete", onSelect: () => tableEdit({ deleteTableColumn: { tableCellLocation: location } }) },
    ]);
  });

  container.addEventListener("click", (event) => {
    const marked = event.target.closest?.("[data-comment-id]");
    if (!marked) return;
    state.doc.activeComment = marked.dataset.commentId;
    togglePanel("comments", true);
    renderPage();
  });

  document.addEventListener("selectionchange", () => {
    if (!state.doc) return;
    const range = selectionRange(container);
    if (!range) return;
    state.doc.selection = range;
    buildToolbar();
    paintCaret();
    placePageActions();
  });
}

async function tableEdit(request) {
  await flushEdit();
  await batch([request]);
}

// ---------------------------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------------------------

async function loadComments({ reset = false, quiet = false } = {}) {
  const doc = state.doc;
  if (!doc.file?.capabilities) return;
  if (reset) {
    doc.comments = [];
    doc.commentsToken = null;
  }
  doc.commentsLoading = true;
  if (!quiet) renderPanel();
  try {
    const result = await call("comments.list", {
      fileId: doc.fileId,
      pageSize: 20,
      ...(doc.commentsToken ? { pageToken: doc.commentsToken } : {}),
    });
    doc.comments = reset ? result.comments : [...doc.comments, ...result.comments];
    doc.commentsToken = result.nextPageToken ?? null;
  } catch (error) {
    if (!quiet) snack(describe(error));
  } finally {
    doc.commentsLoading = false;
  }
  if (!quiet) {
    renderPanel();
    renderMarginComments();
  }
}

function startComment() {
  const doc = state.doc;
  if (!doc.file?.capabilities?.canComment) {
    snack("You need comment access to add a comment.");
    return;
  }
  const selection = doc.selection;
  if (!selection || selection.collapsed) {
    doc.draftComment = { range: null, quoted: "" };
  } else {
    const container = $("#page-content");
    const block = blockAt(container, selection.startIndex);
    const text = block ? block.textContent.slice(selection.startIndex - Number(block.dataset.start), selection.endIndex - Number(block.dataset.start)) : "";
    doc.draftComment = { range: { startIndex: selection.startIndex, endIndex: selection.endIndex }, quoted: text };
  }
  togglePanel("comments", true);
}

async function createComment(content) {
  const doc = state.doc;
  const draft = doc.draftComment;
  const args = { fileId: doc.fileId, content };
  if (draft?.range) args.range = draft.range;
  try {
    await call("comments.create", args, newKey());
    doc.draftComment = null;
    await loadComments({ reset: true });
    renderPage();
    renderMarginComments();
    snack("Comment added");
  } catch (error) {
    snack(describe(error));
  }
}

async function replyToComment(comment, content, action) {
  try {
    await call("replies.create", {
      fileId: state.doc.fileId,
      commentId: comment.id,
      ...(content ? { content } : {}),
      ...(action ? { action } : {}),
    }, newKey());
    await loadComments({ reset: true });
    renderPage();
    renderMarginComments();
  } catch (error) {
    snack(describe(error));
  }
}

function editCommentDialog(comment) {
  let input;
  openDialog({
    title: "Edit comment",
    render: (body) => {
      const field = el("div", { class: "field" });
      input = el("textarea", { attrs: { rows: "4", "aria-label": "Comment" } });
      input.value = comment.content;
      field.append(el("label", { text: "Comment" }), input);
      body.append(field);
    },
    actions: (close) => [
      button("text-btn", "Cancel", { onClick: () => close(null) }),
      button("filled-btn", "Save", { onClick: () => close(input.value.trim()) }),
    ],
    onClose: async (value) => {
      if (!value || value === comment.content) return;
      try {
        await call("comments.update", { fileId: state.doc.fileId, commentId: comment.id, content: value }, newKey());
        await loadComments({ reset: true });
        renderPage();
      } catch (error) {
        snack(describe(error));
      }
    },
  });
}

async function deleteComment(comment) {
  const ok = await confirmDialog({
    title: "Delete comment?",
    text: "The comment will be removed from the document. Drive keeps a tombstone, so the thread disappears but its id remains.",
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;
  try {
    await call("comments.delete", { fileId: state.doc.fileId, commentId: comment.id }, newKey());
    await loadComments({ reset: true });
    renderPage();
    renderMarginComments();
    snack("Comment deleted");
  } catch (error) {
    snack(describe(error));
  }
}

function threadCard(comment) {
  const doc = state.doc;
  const can = doc.file?.capabilities ?? {};
  const mine = comment.author?.me === true;
  const card = el("div", { class: `thread${comment.id === doc.activeComment ? " active" : ""}${comment.resolved ? " resolved" : ""}` });
  const head = el("div", { class: "thread-head" }, [
    avatar(comment.author, true),
    el("div", {}, [
      el("div", { class: "thread-author", text: comment.author?.displayName ?? "Unknown" }),
      el("div", { class: "thread-time", text: relative(comment.createdTime) }),
    ]),
  ]);
  const actions = el("div", { class: "thread-actions" });
  if (can.canComment) {
    actions.append(iconButton(comment.resolved ? "refresh" : "done", comment.resolved ? "Reopen" : "Resolve", {
      class: "small",
      onClick: () => replyToComment(comment, "", comment.resolved ? "reopen" : "resolve"),
    }));
  }
  if (mine || doc.file?.ownedByMe) {
    actions.append(iconButton("more_vert", "Comment options", {
      class: "small",
      onClick: (event) => openMenuFor(event.currentTarget, [
        { label: "Edit", icon: "drive_file_rename_outline", disabled: !mine, title: mine ? undefined : "Only the author can edit a comment", onSelect: () => editCommentDialog(comment) },
        { label: "Delete", icon: "delete", onSelect: () => deleteComment(comment) },
      ], { align: "right" }),
    }));
  }
  head.append(actions);
  card.append(head);
  const quoted = comment.quotedFileContent?.value;
  if (quoted) card.append(el("div", { class: "thread-quote", text: quoted }));
  card.append(el("div", { class: "thread-text", text: comment.content }));

  for (const reply of comment.replies ?? []) {
    const node = el("div", { class: "thread-reply" }, [
      el("div", { class: "thread-head" }, [
        avatar(reply.author, true),
        el("div", {}, [
          el("div", { class: "thread-author", text: reply.author?.displayName ?? "Unknown" }),
          el("div", { class: "thread-time", text: relative(reply.createdTime) }),
        ]),
      ]),
    ]);
    if (reply.action) node.append(el("div", { class: "thread-action-note", text: reply.action === "resolve" ? "Marked as resolved" : "Reopened the thread" }));
    if (reply.content) node.append(el("div", { class: "thread-text", text: reply.content }));
    card.append(node);
  }

  if (can.canComment) {
    const box = el("div", { class: "thread-box" });
    const input = el("textarea", { attrs: { rows: "1", placeholder: "Reply", "aria-label": `Reply to ${comment.author?.displayName ?? "comment"}` } });
    const send = button("text-btn", "Reply", {
      onClick: () => {
        const value = input.value.trim();
        if (value.length === 0) return;
        input.value = "";
        replyToComment(comment, value);
      },
    });
    box.append(input, send);
    card.append(box);
  } else {
    card.append(el("div", { class: "thread-denied", text: "You have read-only access, so you cannot reply to this thread." }));
  }
  card.addEventListener("click", () => {
    if (doc.activeComment === comment.id) return;
    doc.activeComment = comment.id;
    renderPanel();
    renderPage();
  });
  return card;
}

function draftCard() {
  const doc = state.doc;
  const card = el("div", { class: "thread active" });
  card.append(el("div", { class: "thread-head" }, [
    avatar(state.about.user, true),
    el("div", {}, [
      el("div", { class: "thread-author", text: state.about.user.displayName }),
      el("div", { class: "thread-time", text: "New comment" }),
    ]),
  ]));
  if (doc.draftComment.quoted) card.append(el("div", { class: "thread-quote", text: doc.draftComment.quoted }));
  else card.append(el("div", { class: "thread-denied", text: "Nothing was selected, so this comment will not be anchored to any text." }));
  const box = el("div", { class: "thread-box" });
  const input = el("textarea", { attrs: { rows: "2", placeholder: "Comment", "aria-label": "New comment" } });
  box.append(input);
  card.append(box, el("div", { class: "dialog-actions" }, [
    button("text-btn", "Cancel", { onClick: () => { doc.draftComment = null; renderPanel(); } }),
    button("filled-btn", "Comment", {
      onClick: () => {
        const value = input.value.trim();
        if (value.length === 0) { input.focus(); return; }
        createComment(value);
      },
    }),
  ]));
  setTimeout(() => input.focus(), 0);
  return card;
}

// ---------------------------------------------------------------------------------------------
// Side panels
// ---------------------------------------------------------------------------------------------

function togglePanel(name, force = false) {
  const doc = state.doc;
  doc.panel = force ? name : doc.panel === name ? null : name;
  $("#comments-btn").setAttribute("aria-expanded", String(doc.panel === "comments"));
  if (doc.panel === "history" && doc.revisions.length === 0) loadRevisions();
  else renderPanel();
  renderMarginComments();
  placePageActions();
}

function renderPanel() {
  const doc = state.doc;
  const panel = $("#side-panel");
  paintAppRail();
  if (!doc || !doc.panel) {
    panel.hidden = true;
    panel.replaceChildren();
    return;
  }
  panel.hidden = false;
  panel.replaceChildren();
  if (doc.panel === "comments") renderCommentsPanel(panel);
  else if (doc.panel.startsWith("app:")) renderRailAppPanel(panel, doc.panel);
  else renderHistoryPanel(panel);
}

function renderCommentsPanel(panel) {
  const doc = state.doc;
  const head = el("div", { class: "panel-head" }, [el("span", { class: "panel-title", text: "Comments" })]);
  head.append(
    iconButton("filter_alt", "Filter comments", {
      onClick: (event) => openMenuFor(event.currentTarget, [
        { label: "Open", checked: doc.commentFilter === "open", onSelect: () => { doc.commentFilter = "open"; renderPanel(); } },
        { label: "Resolved", checked: doc.commentFilter === "resolved", onSelect: () => { doc.commentFilter = "resolved"; renderPanel(); } },
        { label: "All", checked: doc.commentFilter === "all", onSelect: () => { doc.commentFilter = "all"; renderPanel(); } },
      ], { align: "right" }),
    }),
    iconButton("close", "Close comments", { onClick: () => togglePanel("comments") }),
  );
  const body = el("div", { class: "panel-body" });
  if (doc.draftComment) body.append(draftCard());
  const visible = doc.comments.filter((comment) => {
    if (comment.deleted) return false;
    if (doc.commentFilter === "open") return !comment.resolved;
    if (doc.commentFilter === "resolved") return comment.resolved;
    return true;
  });
  if (doc.commentsLoading && doc.comments.length === 0) body.append(skeletonRows(3));
  else if (visible.length === 0 && !doc.draftComment) {
    body.append(placeholder("mode_comment", doc.commentFilter === "resolved" ? "No resolved comments" : "No comments yet",
      doc.file?.capabilities?.canComment
        ? "Select some text in the document and choose Add comment to start a thread."
        : "You have read-only access to this document."));
  } else {
    for (const comment of visible) body.append(threadCard(comment));
  }
  panel.append(head, body);
  if (doc.commentsToken) {
    panel.append(el("div", { class: "panel-foot" }, button("text-btn", "Show more comments", { onClick: () => loadComments() })));
  }
}

/** Every entry of a Drive list: follows nextPageToken until it is exhausted (the Tool bounds the rows behind it). */
async function listAll(operationId, args, key) {
  const entries = [];
  let pageToken;
  for (let pages = 0; pages < 1000; pages += 1) {
    const result = await call(operationId, { ...args, ...(pageToken ? { pageToken } : {}) });
    entries.push(...(result[key] ?? []));
    pageToken = result.nextPageToken;
    if (!pageToken) return entries;
  }
  throw new Error(`${operationId} returned more than 1000 pages`);
}

async function loadRevisions() {
  const doc = state.doc;
  try {
    // Page until the token is exhausted: a document keeps up to maxRevisions (200) and pages are also byte-bounded,
    // so a single page would hide the newest revisions, including the current one.
    const all = await listAll("revisions.list", { fileId: doc.fileId, pageSize: 100 }, "revisions");
    doc.revisions = all.reverse();
  } catch (error) {
    snack(describe(error));
    doc.revisions = [];
  }
  renderPanel();
}

function renderHistoryPanel(panel) {
  const doc = state.doc;
  const head = el("div", { class: "panel-head" }, [el("span", { class: "panel-title", text: "Version history" })]);
  head.append(iconButton("close", "Close version history", { onClick: () => togglePanel("history") }));
  const body = el("div", { class: "panel-body" });
  if (doc.revisions.length === 0) body.append(skeletonRows(3));
  for (const [position, revision] of doc.revisions.entries()) {
    const item = el("button", { class: `history-item${doc.revision?.id === revision.id ? " active" : ""}`, attrs: { type: "button" } });
    const detail = el("div", {}, [
      el("div", { class: "history-when", text: fullDate(revision.modifiedTime) }),
      el("div", { class: "history-who", text: `${revision.lastModifyingUser?.displayName ?? "Unknown"}${position === 0 ? " · current version" : ""}` }),
    ]);
    const kinds = el("div", { class: "history-kinds" });
    for (const kind of revision.requestTypes ?? []) kinds.append(el("span", { class: "kind-chip", text: kind }));
    if ((revision.requestTypes ?? []).length > 0) detail.append(kinds);
    detail.append(el("div", { class: "history-who", text: `${revision.textLength} characters · revision ${revision.id}` }));
    item.append(el("span", { class: "history-dot" }), detail);
    item.addEventListener("click", async () => {
      try {
        doc.revision = await call("revisions.get", { fileId: doc.fileId, revisionId: revision.id });
      } catch (error) {
        snack(describe(error));
        return;
      }
      renderPanel();
    });
    body.append(item);
  }
  body.append(el("p", { class: "thread-denied", text: "Revisions here are metadata only: this Tool stores no previous content, so a version cannot be restored." }));
  panel.append(head, body);
}

// ---------------------------------------------------------------------------------------------
// Share
// ---------------------------------------------------------------------------------------------

const ROLES = [["writer", "Editor"], ["commenter", "Commenter"], ["reader", "Viewer"]];

async function shareDialog(file) {
  let permissions = [];
  let error = null;
  try {
    permissions = await listAll("permissions.list", { fileId: file.id, pageSize: 100 }, "permissions");
  } catch (loadError) {
    error = loadError;
  }
  const canShare = Boolean(file.capabilities?.canShare);
  let emailInput;
  let roleSelect;
  let errorLine;

  const refresh = async () => {
    try {
      permissions = await listAll("permissions.list", { fileId: file.id, pageSize: 100 }, "permissions");
    } catch (loadError) {
      snack(describe(loadError));
    }
    shareDialogBody(body);
  };

  const grant = async (args, message) => {
    errorLine.textContent = "";
    try {
      await call("permissions.create", { fileId: file.id, ...args }, newKey());
      if (message) snack(message);
      await refresh();
      if (state.doc?.fileId === file.id) await openDocument(file.id, { keepPanel: true, quiet: true });
      else await loadFiles({ reset: true, quiet: true });
    } catch (shareError) {
      errorLine.textContent = describe(shareError);
    }
  };

  const revoke = async (permission) => {
    const who = permission.emailAddress ?? permission.domain ?? "anyone with the link";
    const ok = await confirmDialog({
      title: "Remove access?",
      text: `${who} will no longer have access to “${file.name}”.`,
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    try {
      await call("permissions.delete", { fileId: file.id, permissionId: permission.id }, newKey());
      snack("Access removed");
      await refresh();
    } catch (deleteError) {
      snack(describe(deleteError));
    }
  };

  let body;
  function shareDialogBody(target) {
    target.replaceChildren();
    if (error) {
      target.append(el("p", { text: describe(error) }));
      return;
    }
    if (canShare) {
      const field = el("div", { class: "field" });
      emailInput = el("input", { attrs: { type: "email", placeholder: "Add people and groups", "aria-label": "Add people and groups" } });
      const row = el("div", { class: "share-person" });
      roleSelect = el("select", { attrs: { "aria-label": "Role for the new person" } });
      for (const [value, label] of ROLES) roleSelect.append(el("option", { text: label, attrs: { value } }));
      row.append(el("div", { class: "share-person-main" }, emailInput), el("div", { class: "share-role" }, roleSelect));
      row.append(button("filled-btn", "Share", {
        onClick: () => {
          const address = emailInput.value.trim();
          if (address.length === 0) { errorLine.textContent = "Enter an e-mail address."; return; }
          grant({ type: "user", role: roleSelect.value, emailAddress: address, sendNotificationEmail: false }, `Shared with ${address}`);
          emailInput.value = "";
        },
      }));
      field.append(row);
      target.append(field);
    }
    errorLine = el("p", { class: "field-error" });
    target.append(errorLine);

    target.append(el("h3", { class: "share-section-title", text: "People with access" }));
    for (const permission of permissions.filter((entry) => entry.type === "user" || entry.type === "group" || entry.type === "domain")) {
      const label = permission.type === "domain" ? `Everyone at ${permission.domain}` : permission.displayName ?? permission.emailAddress;
      const row = el("div", { class: "share-person" }, [
        permission.type === "domain"
          ? el("span", { class: "share-general-icon restricted" }, icon("group"))
          : avatar({ displayName: permission.displayName, emailAddress: permission.emailAddress }),
        el("div", { class: "share-person-main" }, [
          el("div", { class: "share-person-name", text: label + (permission.emailAddress === state.about.user.emailAddress ? " (you)" : "") }),
          el("div", { class: "share-person-mail", text: permission.emailAddress ?? permission.domain ?? "" }),
        ]),
      ]);
      if (permission.role === "owner") {
        row.append(el("span", { class: "share-role-static", text: "Owner" }));
      } else if (canShare) {
        const select = el("select", { attrs: { "aria-label": `Role for ${label}` } });
        for (const [value, text] of ROLES) select.append(el("option", { text, attrs: { value, selected: permission.role === value } }));
        select.append(el("option", { text: "Remove access", attrs: { value: "remove" } }));
        select.value = permission.role;
        select.addEventListener("change", () => {
          if (select.value === "remove") { select.value = permission.role; revoke(permission); return; }
          grant(
            permission.type === "domain"
              ? { type: "domain", role: select.value, domain: permission.domain }
              : { type: permission.type, role: select.value, emailAddress: permission.emailAddress, sendNotificationEmail: false },
            "Access updated",
          );
        });
        row.append(el("div", { class: "share-role" }, select));
      } else {
        row.append(el("span", { class: "share-role-static", text: ROLES.find(([value]) => value === permission.role)?.[1] ?? permission.role }));
      }
      target.append(row);
    }

    const anyone = permissions.find((permission) => permission.type === "anyone");
    target.append(el("h3", { class: "share-section-title", text: "General access" }));
    const general = el("div", { class: "share-general" }, [
      el("span", { class: `share-general-icon${anyone ? "" : " restricted"}` }, icon(anyone ? "public" : "lock")),
    ]);
    const generalMain = el("div", { class: "share-person-main" });
    if (canShare) {
      const select = el("select", { attrs: { "aria-label": "General access" } });
      select.append(el("option", { text: "Restricted", attrs: { value: "restricted" } }), el("option", { text: "Anyone with the link", attrs: { value: "anyone" } }));
      select.value = anyone ? "anyone" : "restricted";
      select.addEventListener("change", () => {
        if (select.value === "anyone") grant({ type: "anyone", role: "reader", allowFileDiscovery: false }, "Anyone with the link can view");
        else if (anyone) {
          call("permissions.delete", { fileId: file.id, permissionId: anyone.id }, newKey())
            .then(() => { snack("Link sharing turned off"); return refresh(); })
            .catch((deleteError) => { errorLine.textContent = describe(deleteError); });
        }
      });
      generalMain.append(select);
      if (anyone) {
        const roleSelectGeneral = el("select", { attrs: { "aria-label": "Role for anyone with the link" } });
        for (const [value, text] of [["reader", "Viewer"], ["commenter", "Commenter"]]) {
          roleSelectGeneral.append(el("option", { text, attrs: { value, selected: anyone.role === value } }));
        }
        roleSelectGeneral.value = anyone.role;
        roleSelectGeneral.addEventListener("change", () =>
          grant({ type: "anyone", role: roleSelectGeneral.value, allowFileDiscovery: false }, "Link role updated"));
        generalMain.append(roleSelectGeneral);
      }
    } else {
      generalMain.append(el("div", { class: "share-person-name", text: anyone ? "Anyone with the link" : "Restricted" }));
    }
    generalMain.append(el("div", { class: "share-note", text: anyone
      ? "Anyone in this synthetic world who has the link can open it. Nothing leaves the world."
      : "Only people with access can open with the link." }));
    if (!canShare) generalMain.append(el("div", { class: "share-note", text: "Only the owner can change sharing in this Tool." }));
    general.append(generalMain);
    target.append(general);
  }

  openDialog({
    title: `Share “${file.name}”`,
    render: (target) => { body = target; shareDialogBody(target); },
    actions: (close) => [
      button("outlined-btn", "Copy link", {
        icon: "link",
        onClick: async () => {
          const link = file.webViewLink;
          try {
            await navigator.clipboard.writeText(link);
            snack("Link copied to clipboard");
          } catch {
            snack(`Copy this link: ${link}`);
          }
        },
      }),
      el("span", { class: "spacer" }),
      button("filled-btn", "Done", { onClick: () => close(true) }),
    ],
  });
}

// ---------------------------------------------------------------------------------------------
// Editor dialogs
// ---------------------------------------------------------------------------------------------

function findReplaceDialog() {
  let findInput;
  let replaceInput;
  let matchCase;
  openDialog({
    title: "Find and replace",
    render: (body) => {
      const find = el("div", { class: "field" });
      findInput = el("input", { attrs: { type: "text", "aria-label": "Find" } });
      find.append(el("label", { text: "Find" }), findInput);
      const replace = el("div", { class: "field" });
      replaceInput = el("input", { attrs: { type: "text", "aria-label": "Replace with" } });
      replace.append(el("label", { text: "Replace with" }), replaceInput);
      const check = el("label", { class: "check-row" });
      matchCase = el("input", { attrs: { type: "checkbox" } });
      check.append(matchCase, el("span", { text: "Match case" }));
      body.append(find, replace, check, el("p", { class: "share-note", text: "This sends one replaceAllText request. Regular expressions are not supported by this Tool and are rejected rather than ignored." }));
    },
    actions: (close) => [
      button("text-btn", "Cancel", { onClick: () => close(null) }),
      button("filled-btn", "Replace all", {
        onClick: () => close({ find: findInput.value, replace: replaceInput.value, matchCase: matchCase.checked }),
      }),
    ],
    onClose: async (value) => {
      if (!value || value.find.length === 0) return;
      await flushEdit();
      const result = await batch([{
        replaceAllText: { containsText: { text: value.find, matchCase: value.matchCase }, replaceText: value.replace },
      }]);
      if (result) {
        const changed = result.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0;
        snack(changed === 0 ? `No matches for “${value.find}”` : `${changed} replacement${changed === 1 ? "" : "s"} made`);
      }
    },
  });
}

function insertTableDialog() {
  let rows;
  let columns;
  openDialog({
    title: "Insert table",
    render: (body) => {
      const rowField = el("div", { class: "field" });
      rows = el("input", { attrs: { type: "text", value: "3", inputmode: "numeric", "aria-label": "Rows" } });
      rowField.append(el("label", { text: "Rows (1–20)" }), rows);
      const columnField = el("div", { class: "field" });
      columns = el("input", { attrs: { type: "text", value: "3", inputmode: "numeric", "aria-label": "Columns" } });
      columnField.append(el("label", { text: "Columns (1–20)" }), columns);
      body.append(rowField, columnField);
    },
    actions: (close) => [
      button("text-btn", "Cancel", { onClick: () => close(null) }),
      button("filled-btn", "Insert", { onClick: () => close({ rows: Number(rows.value), columns: Number(columns.value) }) }),
    ],
    onClose: async (value) => {
      if (!value) return;
      const index = activeIndex();
      await flushEdit();
      const request = { insertTable: { rows: value.rows, columns: value.columns } };
      if (index === null) request.insertTable.endOfSegmentLocation = {};
      else request.insertTable.location = { index };
      await batch([request]);
    },
  });
}

function linkDialog() {
  const range = requireSelection({ verb: "link" });
  if (!range) return;
  let input;
  openDialog({
    title: "Insert link",
    render: (body) => {
      const field = el("div", { class: "field" });
      input = el("input", { attrs: { type: "text", placeholder: "https://example.test/page", "aria-label": "Link URL" } });
      field.append(el("label", { text: "Link" }), input);
      body.append(field, el("p", { class: "share-note", text: "Links are stored on the text run exactly as the Docs API stores them. Nothing in this app opens an external address." }));
    },
    actions: (close) => [
      button("text-btn", "Remove link", { onClick: () => close({ url: null }) }),
      button("text-btn", "Cancel", { onClick: () => close(null) }),
      button("filled-btn", "Apply", { onClick: () => close({ url: input.value.trim() }) }),
    ],
    onClose: async (value) => {
      if (!value) return;
      await flushEdit();
      const textStyle = value.url ? { link: { url: value.url } } : {};
      await batch([{ updateTextStyle: { range, textStyle, fields: "link" } }]);
      reselect(range);
    },
  });
}

function bookmarkDialog() {
  const ranges = state.doc.resource.namedRanges ?? {};
  const names = Object.keys(ranges);
  let input;
  openDialog({
    title: "Bookmarks (named ranges)",
    render: (body) => {
      const field = el("div", { class: "field" });
      input = el("input", { attrs: { type: "text", placeholder: "Name this range", "aria-label": "Bookmark name" } });
      field.append(el("label", { text: "Add a bookmark over the current selection" }), input);
      body.append(field);
      if (names.length === 0) body.append(el("p", { class: "share-note", text: "This document has no named ranges yet." }));
      for (const name of names) {
        const entry = ranges[name];
        const row = el("div", { class: "share-person" }, [
          el("span", { class: "share-general-icon restricted" }, icon("filter_alt")),
          el("div", { class: "share-person-main" }, [
            el("div", { class: "share-person-name", text: name }),
            el("div", { class: "share-person-mail", text: `${entry.namedRanges?.length ?? 0} range(s) · id ${entry.namedRanges?.[0]?.namedRangeId ?? "—"}` }),
          ]),
        ]);
        row.append(button("text-btn", "Delete", {
          onClick: async () => {
            await batch([{ deleteNamedRange: { name } }]);
            snack(`Bookmark “${name}” deleted`);
          },
        }));
        body.append(row);
      }
    },
    actions: (close) => [
      button("text-btn", "Close", { onClick: () => close(null) }),
      button("filled-btn", "Add bookmark", { onClick: () => close(input.value.trim()) }),
    ],
    onClose: async (value) => {
      if (!value) return;
      const range = requireSelection({ verb: "bookmark" });
      if (!range) return;
      await flushEdit();
      const result = await batch([{ createNamedRange: { name: value, range: { startIndex: range.startIndex, endIndex: range.endIndex } } }]);
      if (result) snack(`Bookmark “${value}” created (${result.replies?.[0]?.createNamedRange?.namedRangeId ?? "no id"})`);
    },
  });
}

function wordCountDialog() {
  const content = state.doc.resource.content ?? "";
  const words = content.split(/\s+/).filter((word) => word.length > 0).length;
  const characters = content.length;
  const withoutSpaces = content.replace(/\s/g, "").length;
  const paragraphs = structuralElements().length;
  openDialog({
    title: "Word count",
    render: (body) => {
      for (const [label, value] of [
        ["Pages", "not simulated (this Tool stores no layout)"],
        ["Words", String(words)],
        ["Characters", String(characters)],
        ["Characters excluding spaces", String(withoutSpaces)],
        ["Paragraphs", String(paragraphs)],
      ]) {
        body.append(el("div", { class: "share-person" }, [
          el("div", { class: "share-person-main" }, el("div", { class: "share-person-name", text: label })),
          el("span", { class: "share-role-static", text: value }),
        ]));
      }
    },
    actions: (close) => [button("filled-btn", "OK", { onClick: () => close(true) })],
  });
}

async function exportDialog(fileId, name, mimeType) {
  if (!mimeType) {
    openDialog({
      title: `Download “${name}”`,
      render: (body) => body.append(el("p", { text: "Choose a format. This Tool has no renderer, so only text formats exist — PDF, Word, ODT, EPUB and RTF answer NOT_EXPORTABLE, exactly like an unexportable Drive file." })),
      actions: (close) => [
        button("text-btn", "Plain text", { onClick: () => close("text/plain") }),
        button("text-btn", "Markdown", { onClick: () => close("text/markdown") }),
        button("filled-btn", "Web page", { onClick: () => close("text/html") }),
      ],
      onClose: (value) => { if (value) exportDialog(fileId, name, value); },
    });
    return;
  }
  let result;
  try {
    result = await call("files.export", { fileId, mimeType });
  } catch (error) {
    snack(describe(error));
    return;
  }
  openDialog({
    title: `${name} · ${mimeType}`,
    render: (body) => {
      body.append(
        el("p", { text: `${result.byteLength} bytes. Browser downloads are blocked inside a Tool app, so the exported bytes are shown here exactly as files.export returned them.` }),
        el("pre", { class: "export-pre", text: result.content }),
      );
    },
    actions: (close) => [
      button("text-btn", "Copy", {
        onClick: async () => {
          try {
            await navigator.clipboard.writeText(result.content);
            snack("Export copied to clipboard");
          } catch {
            snack("The browser refused clipboard access.");
          }
        },
      }),
      button("filled-btn", "Close", { onClick: () => close(true) }),
    ],
  });
}

function shortcutsDialog() {
  openDialog({
    title: "Keyboard shortcuts",
    render: (body) => {
      for (const [keys, what] of [
        ["Ctrl/⌘ + B, I, U", "Bold, italic, underline the selection"],
        ["Ctrl/⌘ + K", "Insert or remove a link"],
        ["Ctrl/⌘ + Alt + M", "Comment on the selection"],
        ["Ctrl/⌘ + H", "Find and replace"],
        ["Ctrl/⌘ + S", "Send the pending paragraph now (edits also save after a pause)"],
        ["Enter", "New paragraph (insertText with a newline)"],
        ["Backspace at the start of a paragraph", "Merge with the previous paragraph (deleteContentRange)"],
        ["Right-click a table cell", "Insert or delete rows and columns"],
      ]) {
        body.append(el("div", { class: "share-person" }, [
          el("div", { class: "share-person-main" }, el("div", { class: "share-person-name", text: what })),
          el("span", { class: "share-role-static", text: keys }),
        ]));
      }
    },
    actions: (close) => [button("filled-btn", "Close", { onClick: () => close(true) })],
  });
}

// ---------------------------------------------------------------------------------------------
// Editor chrome wiring
// ---------------------------------------------------------------------------------------------

function paintRequestDrawer() {
  const doc = state.doc;
  $("#request-json").textContent = doc?.lastRequest ? JSON.stringify(doc.lastRequest, null, 2) : "No Docs API call yet.";
}

function wireEditorChrome() {
  wirePage();
  wireRightChrome();
  $("#star-btn").addEventListener("click", async () => {
    const doc = state.doc;
    const updated = await mutate("files.update", { fileId: doc.fileId, starred: !doc.file.starred }, { refresh: false });
    if (updated) {
      doc.file = updated;
      renderEditorChrome();
    }
  });
  const title = $("#doc-title");
  title.addEventListener("change", async () => {
    const doc = state.doc;
    const value = title.value.trim();
    if (value.length === 0 || value === doc.file.name) {
      title.value = doc.file.name;
      return;
    }
    const updated = await mutate("files.update", { fileId: doc.fileId, name: value }, { success: "Renamed", refresh: false });
    if (updated) {
      doc.file = updated;
      renderEditorChrome();
    } else {
      title.value = doc.file.name;
    }
  });
  title.addEventListener("input", sizeTitle);
  title.addEventListener("keydown", (event) => { if (event.key === "Enter") title.blur(); });
  $("#comments-btn").addEventListener("click", () => togglePanel("comments"));
  $("#history-btn").addEventListener("click", () => togglePanel("history"));
  $("#share-btn").addEventListener("click", () => { if (state.doc?.file) shareDialog(state.doc.file); });
  $("#request-tab").addEventListener("click", () => {
    const drawer = $("#request-drawer");
    drawer.hidden = !drawer.hidden;
    $("#request-tab").setAttribute("aria-expanded", String(!drawer.hidden));
    paintRequestDrawer();
  });
  $("#request-close").addEventListener("click", () => {
    $("#request-drawer").hidden = true;
    $("#request-tab").setAttribute("aria-expanded", "false");
  });
}

window.addEventListener("resize", () => { if (state.doc?.resource) { renderMarginComments(); placePageActions(); } });

boot();

// ---------------------------------------------------------------------------------------------
// Persistent right-hand chrome: the side-panel app rail and the floating page actions.
//
// Docs keeps a rail of Workspace side-panel apps to the right of every document. None of those
// products is part of this Tool, so each button renders with its real mark, keeps the hover and
// pressed states of the product, and opens a short "not simulated" panel instead of inventing data.
// ---------------------------------------------------------------------------------------------

const RAIL_APPS = [
  { id: "calendar", name: "Calendar", file: "google-calendar-2026.svg" },
  { id: "keep", name: "Keep", file: "google-keep-2026.svg" },
  { id: "tasks", name: "Tasks", file: "google-tasks-2026.svg" },
  { id: "contacts", name: "Contacts", file: "google-contacts.svg" },
  { id: "maps", name: "Maps", file: "google-maps.svg" },
];

function buildAppRail() {
  const rail = $("#app-rail");
  rail.replaceChildren();
  for (const app of RAIL_APPS) {
    const node = el("button", { class: "rail-btn", attrs: { type: "button", title: app.name, "aria-label": app.name, "aria-pressed": "false" } });
    node.append(el("img", { attrs: { src: `./assets/${app.file}`, alt: "", width: "22", height: "22" } }));
    node.addEventListener("click", () => togglePanel(`app:${app.id}`));
    rail.append(node);
  }
  rail.append(el("div", { class: "app-rail-sep", attrs: { "aria-hidden": "true" } }));
  const addOns = el("button", { class: "rail-btn", attrs: { type: "button", title: "Get add-ons — not simulated by this Tool", "aria-label": "Get add-ons" } }, [icon("add")]);
  addOns.addEventListener("click", () => togglePanel("app:addons"));
  rail.append(addOns, el("div", { class: "rail-spacer", attrs: { "aria-hidden": "true" } }));
  const hide = el("button", { class: "rail-btn", attrs: { type: "button", title: "Hide side panel", "aria-label": "Hide side panel" } }, [icon("right_panel_close")]);
  hide.addEventListener("click", () => { state.railHidden = true; paintAppRail(); });
  rail.append(hide);
}

function paintAppRail() {
  const rail = $("#app-rail");
  rail.hidden = Boolean(state.railHidden);
  $("#rail-show").hidden = !state.railHidden;
  const panel = state.doc?.panel ?? "";
  for (const node of $$(".rail-btn[aria-pressed]", rail)) {
    const app = RAIL_APPS.find((entry) => entry.name === node.getAttribute("aria-label"));
    node.setAttribute("aria-pressed", String(app !== undefined && panel === `app:${app.id}`));
  }
}

function railAppTitle(panel) {
  if (panel === "app:addons") return "Add-ons";
  const app = RAIL_APPS.find((entry) => `app:${entry.id}` === panel);
  return app ? app.name : "Side panel";
}

function renderRailAppPanel(panel, kind) {
  const title = railAppTitle(kind);
  const head = el("div", { class: "panel-head" }, [el("span", { class: "panel-title", text: title })]);
  head.append(iconButton("close", `Close ${title}`, { onClick: () => togglePanel(kind) }));
  const body = el("div", { class: "panel-body" });
  body.append(
    placeholder(
      "info",
      `${title} is not simulated by this Tool`,
      "This Firedrill Tool simulates Google Docs documents, comments, sharing and version history only. The Workspace side-panel apps render here so the editor chrome is complete, but they hold no data and make no call.",
    ),
  );
  panel.append(head, body);
}

/** Docs floats an add-comment / add-reaction pill just outside the right edge of the page. */
function placePageActions() {
  const actions = $("#page-actions");
  const doc = state.doc;
  if (!doc?.resource) { actions.classList.remove("show"); return; }
  const scroll = $("#page-scroll");
  const page = $("#page");
  const right = page.offsetLeft + page.offsetWidth;
  const room = scroll.clientWidth - right;
  if (room < 56) { actions.classList.remove("show"); return; }
  actions.classList.add("show");
  actions.style.left = `${Math.round(right + 12)}px`;
  const block = doc.selection ? blockAt($("#page-content"), doc.selection.start) : null;
  const top = block
    ? block.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop - 6
    : 16;
  actions.style.top = `${Math.round(Math.max(top, 8))}px`;
}

function wireRightChrome() {
  buildAppRail();
  $("#outline-show").addEventListener("click", () => {
    state.doc.outline = true;
    renderOutline();
    renderMarginComments();
    placePageActions();
  });
  $("#rail-show").addEventListener("click", () => { state.railHidden = false; paintAppRail(); });
  $("#status-btn").addEventListener("click", (event) => {
    const doc = state.doc;
    const label = doc?.saving ? "Saving to the Docs Tool…" : doc?.dirty ? "Unsaved changes in this tab" : "All changes saved in the Docs Tool";
    openMenuFor(event.currentTarget, [{ label, disabled: true }], { align: "right" });
  });
  $("#fab-comment").addEventListener("click", () => startComment());
}

/**
 * Docs paints its own caret instead of relying on the browser's, so an open document always shows
 * where typing would land. The bar is placed from the live selection, or from the start of the
 * document body when nothing is selected yet; it is hidden whenever the document is read-only.
 */
function paintCaret() {
  const caret = $("#doc-caret");
  const doc = state.doc;
  const container = $("#page-content");
  const editable = Boolean(doc?.resource) && doc?.file?.capabilities?.canEdit === true;
  if (!editable) { caret.hidden = true; return; }
  let rect = null;
  const selection = window.getSelection();
  if (selection && selection.rangeCount > 0 && container.contains(selection.anchorNode)) {
    const range = selection.getRangeAt(0).cloneRange();
    range.collapse(true);
    const rects = range.getClientRects();
    rect = rects.length > 0 ? rects[0] : range.getBoundingClientRect();
    if (rect && rect.height === 0) rect = null;
  }
  if (!rect) {
    const first = container.querySelector("p, td, li");
    if (first) {
      const box = first.getBoundingClientRect();
      const styles = window.getComputedStyle(first);
      rect = { left: box.left, top: box.top, height: Number.parseFloat(styles.lineHeight) || box.height || 22 };
    }
  }
  if (!rect) { caret.hidden = true; return; }
  const page = $("#page").getBoundingClientRect();
  caret.hidden = false;
  caret.style.left = `${Math.round(rect.left - page.left)}px`;
  caret.style.top = `${Math.round(rect.top - page.top)}px`;
  caret.style.height = `${Math.max(Math.round(rect.height), 16)}px`;
}
