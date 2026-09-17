// Google Drive Tool app — a browser client for the synthetic Drive served by this Tool package.
// Every screen calls the package's own operations through /_firedrill/client.js, so a change made here is
// visible over the Drive REST routes and the MCP tool names, and a change made there shows up here.
import { getContext } from "/_firedrill/client.js";
import { mountIcons, icon } from "./icons.js";
import { mountSidePanel, notSimulated, openAppsLauncher, openSettingsMenu, openSupportMenu } from "./chrome.js";
import {
  $,
  $$,
  action,
  avatar,
  avatarColor,
  call,
  closeMenus,
  closeModal,
  confirmDialog,
  describe,
  el,
  filledButton,
  iconButton,
  key,
  openMenu,
  openModal,
  readPreference,
  snackbar,
  textButton,
  ToolError,
  watchWorld,
  writePreference,
} from "./ui.js";
import {
  DOC,
  FOLDER,
  MODIFIED_FILTERS,
  SHEET,
  SOURCE_FILTERS,
  SLIDES,
  SHORTCUT,
  TYPE_FILTERS,
  buildQuery,
  fileIcon,
  formatFullDate,
  formatListDate,
  formatQuota,
  formatSize,
  isFolder,
  isGoogleType,
  isImage,
  isShortcut,
  isTextual,
  quote,
  recencyBucket,
  recencyOf,
  typeLabel,
} from "./drive.js";

const PAGE_SIZE = 50;

const state = {
  context: undefined,
  about: undefined,
  now: undefined,
  denied: false,
  view: { kind: "my-drive", folderId: "root", title: "My Drive" },
  path: [], // breadcrumb: [{ id, name }]
  files: [],
  nextPageToken: undefined,
  loading: false,
  error: undefined,
  selectedId: undefined,
  rootId: undefined,
  layout: readPreference("layout", "list"),
  detailsOpen: readPreference("details", "false") === "true",
  detailsTab: "details",
  chips: { type: undefined, owner: undefined, modified: undefined, source: undefined },
  multi: new Set(), // ids selected together with ctrl/cmd or shift
  treeOpen: false, // the My Drive folder tree in the sidebar
  tree: { folders: [], nextPageToken: undefined, loading: false, error: undefined },
  sort: { key: "modifiedTime", desc: true },
  search: "",
  people: new Map(), // e-mail → display name, collected from the rows on screen
  formOpen: false, // a dialog or editor with unsaved input is open: background refresh waits
};

const SECTIONS = [
  { id: "home", label: "Home", icon: "home" },
  { id: "my-drive", label: "My Drive", icon: "drive", caret: true },
  { id: "computers", label: "Computers", icon: "computer", caret: true, notSimulated: "Computers lists folders synced by Drive for desktop. No desktop client is simulated, so there are no computers in this Drive." },
  "divider",
  { id: "shared", label: "Shared with me", icon: "people" },
  "divider",
  { id: "recent", label: "Recent", icon: "schedule" },
  { id: "starred", label: "Starred", icon: "star_border" },
  "divider",
  { id: "spam", label: "Spam", icon: "report", notSimulated: "Spam holds files other people shared that Drive flagged. This Tool does not model spam classification, so Spam has no files here." },
  { id: "trash", label: "Trash", icon: "delete_outline" },
];

const me = () => state.about?.user?.emailAddress ?? "";
const myName = () => state.about?.user?.displayName ?? "You";
const fileById = (id) => state.files.find((file) => file.id === id);
const selected = () => (state.selectedId ? fileById(state.selectedId) : undefined);

/** Remember display names so the Owner column and the share dialog can print people, not raw addresses. */
function rememberPeople(files) {
  for (const file of files) {
    for (const owner of file.owners ?? []) if (owner.emailAddress) state.people.set(owner.emailAddress, owner.displayName || owner.emailAddress);
    if (file.sharingUser?.emailAddress) state.people.set(file.sharingUser.emailAddress, file.sharingUser.displayName || file.sharingUser.emailAddress);
  }
}
const personName = (address) => state.people.get(address) ?? address;

// ---------------------------------------------------------------------------------------------
// Header, sidebar and storage
// ---------------------------------------------------------------------------------------------

function renderAccount() {
  const button = $("#account-avatar");
  const name = myName();
  button.textContent = (name || "?").charAt(0).toUpperCase();
  button.style.background = state.about ? avatarColor(me()) : "#9aa0a6";
  $("#account-btn").title = state.about ? `${name} (${me()})` : "Google Account";
  $("#account-btn").setAttribute("aria-label", state.about ? `Google Account: ${name} (${me()})` : "Google Account");
}

function renderNav() {
  const nav = $("#nav");
  nav.replaceChildren();
  for (const section of SECTIONS) {
    if (section === "divider") {
      nav.append(el("div", { class: "gd-nav-gap", attrs: { "aria-hidden": "true" } }));
      continue;
    }
    const active = state.view.kind === section.id || (section.id === "my-drive" && state.view.kind === "folder");
    const line = el("div", { class: `gd-nav-line ${active ? "is-active" : ""}`.trim() });
    if (section.caret) {
      const expanded = section.id === "my-drive" && state.treeOpen;
      const caret = el("button", { class: `gd-nav-caret ${expanded ? "is-open" : ""}`.trim(), attrs: { type: "button", "aria-label": `${expanded ? "Collapse" : "Expand"} ${section.label}`, "aria-expanded": String(expanded), title: `${expanded ? "Collapse" : "Expand"} ${section.label}` } }, [icon("arrow_right", "gd-nav-caret-icon")]);
      caret.addEventListener("click", () => {
        if (section.notSimulated) return notSimulated(section.label, section.notSimulated);
        state.treeOpen = !state.treeOpen;
        renderNav();
        if (state.treeOpen && state.tree.folders.length === 0) void loadTree();
      });
      line.append(caret);
    } else line.append(el("span", { class: "gd-nav-caret-space", attrs: { "aria-hidden": "true" } }));
    const item = el("button", { class: `gd-nav-item ${active ? "is-active" : ""}`.trim(), attrs: { type: "button", "aria-current": active ? "page" : undefined } }, [
      icon(section.icon, "gd-nav-icon"),
      el("span", { class: "gd-nav-label", text: section.label }),
    ]);
    item.addEventListener("click", () => {
      if (section.notSimulated) return notSimulated(section.label, section.notSimulated);
      $("#app").classList.remove("is-drawer-open");
      $("#scrim").hidden = true;
      navigate(section.id === "my-drive" ? { kind: "my-drive", folderId: "root", title: "My Drive" } : { kind: section.id, title: section.label });
    });
    line.append(item);
    nav.append(line);
    if (section.id === "my-drive" && state.treeOpen) nav.append(renderTree());
  }
}

/** Top-level folders of My Drive under the sidebar caret; pages through every folder with "Show more". */
async function loadTree({ append = false } = {}) {
  state.tree.loading = true;
  state.tree.error = undefined;
  renderNav();
  try {
    const result = await call("files.list", { query: `'root' in parents and mimeType = ${quote(FOLDER)} and trashed = false`, orderBy: "name", pageSize: 100, ...(append && state.tree.nextPageToken ? { pageToken: state.tree.nextPageToken } : {}) });
    state.tree.folders = append ? [...state.tree.folders, ...(result.files ?? [])] : result.files ?? [];
    state.tree.nextPageToken = result.nextPageToken;
  } catch (error) {
    state.tree.error = error;
  } finally {
    state.tree.loading = false;
    renderNav();
  }
}

function renderTree() {
  const host = el("div", { class: "gd-tree", attrs: { role: "group", "aria-label": "My Drive folders" } });
  for (const folder of state.tree.folders) {
    const active = state.view.kind === "folder" && state.view.folderId === folder.id;
    const item = el("button", { class: `gd-nav-item gd-tree-item ${active ? "is-active" : ""}`.trim(), attrs: { type: "button", title: folder.name } }, [icon("folder", "gd-nav-icon"), el("span", { class: "gd-nav-label", text: folder.name })]);
    item.addEventListener("click", () => navigate({ kind: "folder", folderId: folder.id, title: folder.name }, { path: [{ id: folder.id, name: folder.name }] }));
    host.append(item);
  }
  if (state.tree.loading) host.append(el("p", { class: "gd-tree-note", text: "Loading…" }));
  else if (state.tree.error) host.append(el("p", { class: "gd-tree-note", text: describe(state.tree.error) }));
  else if (state.tree.folders.length === 0) host.append(el("p", { class: "gd-tree-note", text: "No folders" }));
  if (state.tree.nextPageToken && !state.tree.loading) host.append(textButton("Show more folders", { class: "gd-tree-more", onClick: () => void loadTree({ append: true }) }));
  return host;
}

function renderStorage() {
  const host = $("#storage");
  host.replaceChildren();
  const quota = state.about?.storageQuota;
  if (!quota) return;
  const used = Number(quota.usage ?? 0);
  const limit = quota.limit ? Number(quota.limit) : undefined;
  const share = limit ? Math.min(100, (used / limit) * 100) : 0;
  const bar = el("div", { class: "gd-storage-bar", attrs: { role: "img", "aria-label": limit ? `${formatQuota(used)} of ${formatQuota(limit)} used` : `${formatQuota(used)} used` } });
  const fill = el("span", { class: "gd-storage-fill" });
  fill.style.width = `${Math.max(share, used > 0 ? 2 : 0)}%`;
  if (share > 90) fill.classList.add("is-full");
  bar.append(fill);
  const item = el("button", { class: "gd-nav-item", attrs: { type: "button" } }, [icon("cloud", "gd-nav-icon"), el("span", { class: "gd-nav-label", text: "Storage" })]);
  item.addEventListener("click", () => openStorageDialog());
  const more = el("button", { class: "gd-outlined-btn gd-storage-more", text: "Get more storage", attrs: { type: "button" } });
  more.addEventListener("click", () => notSimulated("Get more storage", "Google One plans and purchases are not simulated. The storage limit comes from this world's quota settings."));
  host.append(item, bar, el("p", { class: "gd-storage-text", text: limit ? `${formatQuota(used)} of ${formatQuota(limit)} used` : `${formatQuota(used)} used` }), more);
}

function openStorageDialog() {
  const quota = state.about?.storageQuota ?? {};
  const rows = [
    ["Drive", formatQuota(quota.usageInDrive ?? 0)],
    ["Trash", formatQuota(quota.usageInTrash ?? 0)],
    ["Total used", formatQuota(quota.usage ?? 0)],
    ["Plan", quota.limit ? `${formatQuota(quota.limit)} of storage` : "Unlimited storage"],
  ];
  openModal({
    title: "Storage",
    className: "gd-dialog gd-modal is-small",
    body: el(
      "dl",
      { class: "gd-props" },
      rows.map(([label, value]) => el("div", { class: "gd-prop" }, [el("dt", { text: label }), el("dd", { text: value })])),
    ),
    actions: [textButton("Close", { onClick: () => closeModal() })],
  });
}

// ---------------------------------------------------------------------------------------------
// Navigation and loading
// ---------------------------------------------------------------------------------------------

function navigate(view, { keepSearch = false, path } = {}) {
  closeMenus();
  state.view = view;
  state.path = path ?? (view.kind === "folder" ? state.path : []);
  state.selectedId = undefined;
  state.multi.clear();
  state.nextPageToken = undefined;
  if (!keepSearch && view.kind !== "search") {
    state.search = "";
    $("#search").value = "";
    $("#search-clear").hidden = true;
  }
  if (view.kind !== "search") state.chips = { type: undefined, owner: undefined, modified: undefined, source: undefined };
  renderNav();
  renderChrome();
  void loadView();
}

function openFolder(file) {
  const path = [...state.path, { id: file.id, name: file.name }];
  navigate({ kind: "folder", folderId: file.id, title: file.name }, { path });
}

function orderByString() {
  const { key: sortKey, desc } = state.sort;
  const column = sortKey === "size" ? "quotaBytesUsed" : sortKey;
  return `folder,${column}${desc ? " desc" : ""}${sortKey === "name" ? "" : ",name"}`;
}

/** The Drive `q` for the current view plus its chips — also shown in the advanced-search dialog. */
function currentQuery() {
  const view = state.view;
  if (view.kind === "search") return buildQuery({ scope: "all", text: state.search, ...state.chips, me: me(), now: state.now });
  if (view.kind === "my-drive" || view.kind === "folder") return buildQuery({ scope: "folder", folderId: view.folderId ?? "root", ...state.chips, me: me(), now: state.now });
  if (view.kind === "shared") return buildQuery({ scope: "shared", ...state.chips, me: me(), now: state.now });
  if (view.kind === "starred") return buildQuery({ scope: "starred", ...state.chips, me: me(), now: state.now });
  if (view.kind === "trash") return buildQuery({ scope: "trash", ...state.chips, me: me(), now: state.now });
  return buildQuery({ scope: "all", ...state.chips, me: me(), now: state.now });
}

async function loadView({ append = false, silent = false } = {}) {
  const view = state.view;
  if (!silent) {
    state.loading = true;
    state.error = undefined;
    if (!append) renderContent();
  }
  try {
    let files = [];
    let nextPageToken;
    if (view.kind === "home") {
      const [recent, folders] = await Promise.all([
        call("files.recent", { orderBy: "recency", pageSize: 24 }),
        call("files.list", { query: `mimeType = ${quote(FOLDER)} and trashed = false`, orderBy: "recency desc,name", pageSize: 8 }),
      ]);
      files = recent.files ?? [];
      state.homeFolders = folders.files ?? [];
    } else if (view.kind === "recent") {
      const result = await call("files.list", { query: currentQuery(), orderBy: "recency desc,name", pageSize: PAGE_SIZE, ...(append && state.nextPageToken ? { pageToken: state.nextPageToken } : {}) });
      files = result.files ?? [];
      nextPageToken = result.nextPageToken;
    } else {
      const result = await call("files.list", { query: currentQuery(), orderBy: orderByString(), pageSize: PAGE_SIZE, ...(append && state.nextPageToken ? { pageToken: state.nextPageToken } : {}) });
      files = result.files ?? [];
      nextPageToken = result.nextPageToken;
    }
    rememberPeople(files);
    state.files = append ? [...state.files, ...files] : files;
    state.nextPageToken = nextPageToken;
    state.error = undefined;
  } catch (error) {
    if (error instanceof ToolError && error.is("INVALID_PAGE_TOKEN")) {
      state.nextPageToken = undefined;
      return loadView();
    }
    state.error = error;
    if (!append) state.files = [];
  } finally {
    state.loading = false;
    renderContent();
    renderSelectionBar();
    renderDetails();
  }
}

async function refreshAll(first = false) {
  try {
    state.about = await call("about.get", {});
    state.now = state.about.serverTime ?? state.now;
    state.denied = false;
  } catch (error) {
    if (error instanceof ToolError && error.denied) {
      state.denied = true;
      renderDenied(error);
      return;
    }
    state.error = error;
  }
  if (state.rootId === undefined) {
    try {
      state.rootId = (await call("files.get", { fileId: "root" })).file.id;
    } catch {
      /* the root id is only used to disable a no-op move; the view works without it */
    }
  }
  $("#new-btn").hidden = false;
  renderAccount();
  renderStorage();
  renderNav();
  renderChrome();
  await loadView({ silent: !first });
}

function renderDenied(error) {
  $("#content").replaceChildren(
    el("div", { class: "gd-empty" }, [
      icon("lock", "gd-empty-icon"),
      el("h2", { class: "gd-empty-title", text: "You don't have access to this Drive" }),
      el("p", { class: "gd-empty-text", text: describe(error) }),
      el("p", { class: "gd-empty-text", text: "Ask the world author to grant this actor the google-drive operations (about.get, files.list, …)." }),
    ]),
  );
  $("#chips").hidden = true;
  $("#new-btn").hidden = true;
  $("#details").hidden = true;
  $("#crumbs").replaceChildren(el("h1", { class: "gd-title", text: "Drive" }));
}

// ---------------------------------------------------------------------------------------------
// Breadcrumb, chips, layout toggles
// ---------------------------------------------------------------------------------------------

function renderChrome() {
  const crumbs = $("#crumbs");
  crumbs.replaceChildren();
  const view = state.view;
  if (view.kind === "folder") {
    const root = el("button", { class: "gd-crumb", text: "My Drive", attrs: { type: "button" } });
    root.addEventListener("click", () => navigate({ kind: "my-drive", folderId: "root", title: "My Drive" }, { path: [] }));
    crumbs.append(root);
    state.path.forEach((entry, index) => {
      crumbs.append(icon("chevron_right", "gd-crumb-sep"));
      const last = index === state.path.length - 1;
      if (last) {
        const title = el("button", { class: "gd-crumb is-current", attrs: { type: "button", "aria-haspopup": "menu", "aria-expanded": "false" } }, [el("span", { text: entry.name }), icon("arrow_drop_down", "gd-crumb-arrow")]);
        title.addEventListener("click", () => openFolderMenu(title, entry));
        crumbs.append(title);
      } else {
        const crumb = el("button", { class: "gd-crumb", text: entry.name, attrs: { type: "button" } });
        crumb.addEventListener("click", () => navigate({ kind: "folder", folderId: entry.id, title: entry.name }, { path: state.path.slice(0, index + 1) }));
        crumbs.append(crumb);
      }
    });
  } else if (view.kind === "search") {
    crumbs.append(el("h1", { class: "gd-title", text: "Search results" }));
  } else if (view.kind === "my-drive") {
    const title = el("button", { class: "gd-crumb is-current", attrs: { type: "button", "aria-haspopup": "menu", "aria-expanded": "false" } }, [el("span", { text: "My Drive" }), icon("arrow_drop_down", "gd-crumb-arrow")]);
    title.addEventListener("click", () => openFolderMenu(title, { id: "root", name: "My Drive" }));
    crumbs.append(title);
  } else {
    crumbs.append(el("h1", { class: "gd-title", text: view.kind === "home" ? "Welcome to Drive" : view.title ?? "Drive" }));
  }

  document.title = `${view.kind === "folder" ? view.title : view.kind === "search" ? "Search results" : view.title ?? "Drive"} - Google Drive`;
  renderSelectionBar();
  const chips = $("#chips");
  chips.hidden = state.denied || selectionIds().length > 0;
  chips.replaceChildren();
  if (chips.hidden) return;
  chips.append(
    chip("type", "Type", TYPE_FILTERS.find((entry) => entry.id === state.chips.type)?.label),
    chip("owner", "People", state.chips.owner ? personName(state.chips.owner) : undefined),
    chip("modified", "Modified", MODIFIED_FILTERS.find((entry) => entry.id === state.chips.modified)?.label),
  );
  if (state.view.kind !== "shared" && state.view.kind !== "trash") chips.append(chip("source", "Source", SOURCE_FILTERS.find((entry) => entry.id === state.chips.source)?.label));

  if (state.chips.type || state.chips.owner || state.chips.modified || state.chips.source) {
    const clear = el("button", { class: "gd-chip gd-chip-clear", text: "Clear filters", attrs: { type: "button" } });
    clear.addEventListener("click", () => {
      state.chips = { type: undefined, owner: undefined, modified: undefined, source: undefined };
      renderChrome();
      void loadView();
    });
    chips.append(clear);
  }
}

function chip(name, label, value) {
  const button = el("button", { class: `gd-chip ${value ? "is-active" : ""}`.trim(), attrs: { type: "button", "aria-haspopup": "menu", "aria-expanded": "false" } }, [
    el("span", { text: value ?? label }),
    icon("arrow_drop_down", "gd-chip-arrow"),
  ]);
  button.addEventListener("click", () => {
    const apply = (id) => {
      state.chips[name] = state.chips[name] === id ? undefined : id;
      // Home's suggestions are not a query, so Drive answers a filter there with the filtered result list.
      if (state.view.kind === "home") return navigate({ kind: "search", title: "Search results" }, { keepSearch: true });
      renderChrome();
      void loadView();
    };
    if (name === "type") openMenu(button, TYPE_FILTERS.map((entry) => ({ label: entry.label, radio: state.chips.type === entry.id, onSelect: () => apply(entry.id) })));
    else if (name === "source") openMenu(button, SOURCE_FILTERS.map((entry) => ({ label: entry.label, radio: state.chips.source === entry.id, onSelect: () => apply(entry.id) })));
    else if (name === "modified") openMenu(button, MODIFIED_FILTERS.map((entry) => ({ label: entry.label, radio: state.chips.modified === entry.id, onSelect: () => apply(entry.id) })));
    else {
      const people = [...state.people.entries()].sort((a, b) => a[1].localeCompare(b[1]));
      const items = [{ label: `Owned by me`, radio: state.chips.owner === me(), onSelect: () => apply(me()) }];
      for (const [address, name2] of people) if (address !== me()) items.push({ label: name2, hint: address, radio: state.chips.owner === address, onSelect: () => apply(address) });
      openMenu(button, items.length > 1 ? items : [...items, { label: "No other people in view", disabled: true }]);
    }
  });
  return button;
}

function openFolderMenu(anchor, entry) {
  const isRoot = entry.id === "root";
  openMenu(anchor, [
    { label: "New folder", icon: "create_new_folder", onSelect: () => openNewFolderDialog(entry.id) },
    { label: "Upload file", icon: "upload_file", onSelect: () => openUploadDialog(entry.id) },
    "divider",
    { label: "Get link", icon: "link", disabled: isRoot, onSelect: () => void copyLink(fileById(entry.id) ?? { id: entry.id, name: entry.name }) },
    { label: "Share", icon: "person_add", disabled: isRoot, onSelect: () => void openShareDialog(entry.id) },
    { label: "File information", icon: "info", disabled: isRoot, onSelect: () => void openDetailsFor(entry.id) },
  ]);
}

// ---------------------------------------------------------------------------------------------
// File list
// ---------------------------------------------------------------------------------------------

const EMPTY_STATES = {
  "my-drive": ["A place for all of your files", "Use the New button to add a folder or a file to this Drive."],
  folder: ["This folder is empty", "Use the New button to add a folder or a file here."],
  shared: ["No files shared with you", "Files other people share with this account appear here."],
  recent: ["No recent files", "Files you open or change appear here, newest first."],
  starred: ["No starred files", "Add stars to things you want to find quickly later."],
  trash: ["Trash is empty", "Items you move to the trash appear here, and you can restore them."],
  search: ["No results found", "Try different keywords or remove the filters."],
  home: ["Nothing to suggest yet", "Files you work with appear here."],
};

function renderContent() {
  if (state.denied) return;
  const host = $("#content");
  const banner = $("#banner");
  if (state.error && !(state.error instanceof ToolError && state.error.denied)) {
    $("#banner-text").textContent = describe(state.error);
    banner.hidden = false;
  } else banner.hidden = true;

  if (state.loading && state.files.length === 0) {
    host.replaceChildren(skeleton());
    return;
  }
  if (state.error && state.files.length === 0) {
    host.replaceChildren(
      el("div", { class: "gd-empty" }, [
        icon("error_outline", "gd-empty-icon"),
        el("h2", { class: "gd-empty-title", text: "Couldn't load your files" }),
        el("p", { class: "gd-empty-text", text: describe(state.error) }),
        filledButton("Try again", { onClick: () => void loadView() }),
      ]),
    );
    return;
  }
  if (state.files.length === 0) {
    const [title, text] = EMPTY_STATES[state.view.kind] ?? EMPTY_STATES["my-drive"];
    host.replaceChildren(
      el("div", { class: "gd-empty" }, [
        icon(state.view.kind === "trash" ? "delete_outline" : state.view.kind === "starred" ? "star_border" : state.view.kind === "search" ? "search" : "drive", "gd-empty-icon"),
        el("h2", { class: "gd-empty-title", text: title }),
        el("p", { class: "gd-empty-text", text }),
      ]),
    );
    return;
  }

  host.replaceChildren();
  if (state.view.kind === "trash")
    host.append(
      el("div", { class: "gd-trash-bar" }, [
        el("span", { class: "gd-trash-text", text: "Items in the trash are deleted forever after 30 days." }),
        (() => {
          const button = el("button", { class: "gd-outlined-btn", text: "Empty trash", attrs: { type: "button" } });
          button.addEventListener("click", () => void emptyTrash());
          return button;
        })(),
      ]),
    );
  if (state.view.kind === "home") host.append(renderHome());
  else if (state.view.kind === "recent") host.append(groupedHeader(), ...renderGrouped((file) => recencyBucket(recencyOf(file), state.now)));
  else if (state.view.kind === "shared") host.append(groupedHeader(), ...renderGrouped((file) => (file.sharingUser ? `Shared by ${file.sharingUser.displayName || file.sharingUser.emailAddress}` : "Shared with me")));
  else if (state.layout === "grid") host.append(...gridSections(state.files));
  else host.append(list(state.files));

  if (state.nextPageToken) {
    const more = textButton(state.loading ? "Loading…" : "Load more", { class: "gd-load-more", onClick: () => void loadView({ append: true }) });
    more.disabled = state.loading;
    host.append(more);
  }

}

/** Grid layout splits folders from files as Drive does, so short folder chips never share a row with tall file cards. */
function gridSections(files) {
  const folders = files.filter((file) => isFolder(file));
  const rest = files.filter((file) => !isFolder(file));
  if (folders.length === 0 || rest.length === 0) return [grid(files, { compact: rest.length === 0 })];
  return [
    el("section", { class: "gd-group" }, [el("h2", { class: "gd-group-title", text: "Folders" }), grid(folders, { compact: true })]),
    el("section", { class: "gd-group" }, [el("h2", { class: "gd-group-title", text: "Files" }), grid(rest)]),
  ];
}

/** Grouped views (Recent, Shared with me) keep one set of column headings above the groups. */
function groupedHeader() {
  return state.layout === "grid" ? el("div", { class: "gd-grid-head-spacer" }) : list([], { header: true });
}

function renderGrouped(bucketOf) {
  const groups = new Map();
  for (const file of state.files) {
    const bucket = bucketOf(file);
    if (!groups.has(bucket)) groups.set(bucket, []);
    groups.get(bucket).push(file);
  }
  return [...groups.entries()].map(([label, files]) => el("section", { class: "gd-group" }, [el("h2", { class: "gd-group-title", text: label }), state.layout === "grid" ? grid(files) : list(files, { header: false })]));
}

function renderHome() {
  const wrap = el("div", { class: "gd-home" });
  const folders = state.homeFolders ?? [];
  const files = state.files.filter((file) => !isFolder(file));
  if (folders.length > 0) {
    wrap.append(el("h2", { class: "gd-group-title", text: "Suggested folders" }));
    wrap.append(grid(folders, { compact: true }));
  }
  if (files.length > 0) {
    wrap.append(el("h2", { class: "gd-group-title", text: "Suggested files" }));
    wrap.append(list(files, { header: true }));
  }
  wrap.append(el("p", { class: "gd-foot-note", text: `Suggestions show the ${folders.length} most recent folders and ${files.length} most recently opened or changed files. Open My Drive, Recent or search to see everything.` }));
  return wrap;
}

function skeleton() {
  const host = el("div", { class: "gd-skeleton", attrs: { "aria-label": "Loading files" } });
  for (let index = 0; index < 8; index += 1) host.append(el("div", { class: "gd-skeleton-row" }, [el("span", { class: "gd-skeleton-icon" }), el("span", { class: "gd-skeleton-bar" }), el("span", { class: "gd-skeleton-bar is-short" })]));
  return host;
}

const SORTS = [
  { key: "name", label: "Name", class: "col-name" },
  { key: "owner", label: "Owner", class: "col-owner", sortable: false },
  { key: "modifiedTime", label: "Last modified", class: "col-modified" },
  { key: "size", label: "File size", class: "col-size" },
];

function list(files, { header = true } = {}) {
  const table = el("div", { class: "gd-list", attrs: { role: "grid", "aria-label": state.view.title ?? "Files" } });
  if (header) {
    const head = el("div", { class: "gd-list-head", attrs: { role: "row" } });
    for (const column of SORTS) {
      const active = state.sort.key === column.key;
      const cell = el("div", { class: `gd-cell ${column.class}`, attrs: { role: "columnheader", "aria-sort": active ? (state.sort.desc ? "descending" : "ascending") : "none" } });
      if (column.sortable === false || state.view.kind === "recent") cell.append(el("span", { text: column.label }));
      else {
        const button = el("button", { class: `gd-sort ${active ? "is-active" : ""}`.trim(), attrs: { type: "button" } }, [el("span", { text: column.label }), active ? icon(state.sort.desc ? "arrow_downward" : "arrow_upward", "gd-sort-arrow") : undefined]);
        button.addEventListener("click", () => {
          state.sort = state.sort.key === column.key ? { key: column.key, desc: !state.sort.desc } : { key: column.key, desc: column.key !== "name" };
          state.nextPageToken = undefined;
          void loadView();
        });
        cell.append(button);
      }
      head.append(cell);
    }
    head.append(el("div", { class: "gd-cell col-actions", attrs: { role: "columnheader" } }));
    table.append(head);
  }
  for (const file of files) table.append(row(file));
  return table;
}

function row(file) {
  const isSelected = state.selectedId === file.id;
  const element = el("div", { class: `gd-row ${isSelected ? "is-selected" : ""}`.trim(), attrs: { role: "row", tabindex: "0", "data-id": file.id, "aria-selected": String(isSelected) } });
  const owner = file.owners?.[0];
  const ownerLabel = owner ? (owner.me ? "me" : owner.displayName || owner.emailAddress) : "—";
  element.append(
    el("div", { class: "gd-cell col-name", attrs: { role: "gridcell" } }, [
      fileIcon(file),
      el("span", { class: "gd-row-name", text: file.name, title: file.name }),
      isShortcut(file) ? icon("shortcut", "gd-row-badge") : undefined,
      file.starred ? icon("star", "gd-row-badge is-star") : undefined,
      file.shared && !isShortcut(file) ? icon("people", "gd-row-badge") : undefined,
    ]),
    el("div", { class: "gd-cell col-owner", attrs: { role: "gridcell" } }, [owner ? avatar(owner.displayName, owner.emailAddress, "small") : undefined, el("span", { text: ownerLabel })]),
    el("div", { class: "gd-cell col-modified", attrs: { role: "gridcell" } }, [
      el("span", { text: formatListDate(state.view.kind === "trash" ? file.trashedTime ?? file.modifiedTime : file.modifiedTime, state.now) }),
      file.lastModifyingUser && !file.lastModifyingUser.me ? el("span", { class: "gd-row-sub", text: (file.lastModifyingUser.displayName || file.lastModifyingUser.emailAddress).split(" ")[0] }) : undefined,
    ]),
    el("div", { class: "gd-cell col-size", attrs: { role: "gridcell" }, text: isFolder(file) || isShortcut(file) ? "—" : formatSize(file.size ?? 0) }),
  );
  const actions = el("div", { class: "gd-cell col-actions", attrs: { role: "gridcell" } });
  const star = iconButton(file.starred ? "star" : "star_border", file.starred ? "Remove from starred" : "Add to starred", {
    class: `gd-row-action ${file.starred ? "is-on" : ""}`.trim(),
    onClick: (event) => {
      event.stopPropagation();
      void toggleStar(file);
    },
  });
  const more = iconButton("more_vert", `More actions for ${file.name}`, {
    class: "gd-row-action",
    attrs: { "aria-haspopup": "menu", "aria-expanded": "false" },
    onClick: (event) => {
      event.stopPropagation();
      select(file.id);
      openMenu(more, rowMenu(file), { align: "end" });
    },
  });
  const can = file.capabilities ?? {};
  if (state.view.kind !== "trash") {
    const hover = (name, label, enabled, run) =>
      iconButton(name, label, {
        class: "gd-row-action gd-row-hover",
        attrs: enabled ? {} : { disabled: "" },
        onClick: (event) => {
          event.stopPropagation();
          select(file.id);
          run();
        },
      });
    actions.append(
      hover("person_add", "Share", can.canShare, () => void openShareDialog(file.id)),
      hover("download", "Download", can.canDownload, () => void download(file)),
      hover("edit", "Rename", can.canRename, () => openRenameDialog(file)),
    );
  }
  actions.append(star, more);
  element.append(actions);

  element.addEventListener("click", (event) => pick(file.id, event));
  element.addEventListener("dblclick", () => open(file));
  element.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    select(file.id);
    openMenu(element, rowMenu(file), { point: { x: event.clientX, y: event.clientY } });
  });
  element.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      open(file);
    }
  });
  return element;
}

function grid(files, { compact = false } = {}) {
  const host = el("div", { class: `gd-grid ${compact ? "is-compact" : ""}`.trim(), attrs: { role: "list" } });
  for (const file of files) {
    const card = el("div", { class: `gd-card ${state.selectedId === file.id ? "is-selected" : ""}`.trim(), attrs: { role: "listitem", tabindex: "0", "data-id": file.id } });
    card.append(
      el("div", { class: "gd-card-head" }, [
        fileIcon(file),
        el("span", { class: "gd-card-name", text: file.name, title: file.name }),
        iconButton("more_vert", `More actions for ${file.name}`, {
          class: "gd-row-action",
          attrs: { "aria-haspopup": "menu", "aria-expanded": "false" },
          onClick: (event) => {
            event.stopPropagation();
            select(file.id);
            openMenu(event.currentTarget, rowMenu(file), { align: "end" });
          },
        }),
      ]),
    );
    // Drive's grid keeps folders as one-line cards and gives files a thumbnail tile.
    if (!isFolder(file)) {
      const thumb = el("div", { class: "gd-card-thumb" }, [fileIcon(file, "gd-card-thumb-icon"), el("span", { class: "gd-card-thumb-label", text: typeLabel(file.mimeType) })]);
      card.append(thumb);
    } else card.classList.add("is-folder");
    card.addEventListener("click", (event) => pick(file.id, event));
    card.addEventListener("dblclick", () => open(file));
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        open(file);
      }
    });
    card.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      select(file.id);
      openMenu(card, rowMenu(file), { point: { x: event.clientX, y: event.clientY } });
    });
    host.append(card);
  }
  return host;
}

/** Ids currently selected: the ctrl/shift set, or the single focused selection. */
function selectionIds() {
  if (state.multi.size > 0) return [...state.multi];
  return state.selectedId ? [state.selectedId] : [];
}

/** Click selection with Drive's modifiers: ctrl/cmd toggles, shift extends a range from the last pick. */
function pick(id, event) {
  if (event && (event.metaKey || event.ctrlKey)) {
    if (state.multi.size === 0 && state.selectedId) state.multi.add(state.selectedId);
    if (state.multi.has(id)) state.multi.delete(id);
    else state.multi.add(id);
    state.selectedId = state.multi.has(id) ? id : [...state.multi].pop();
    return select(state.selectedId, { keepMulti: true });
  }
  if (event?.shiftKey && state.selectedId) {
    const ids = [...new Set($$("[data-id]").map((element) => element.dataset.id))];
    const from = ids.indexOf(state.selectedId);
    const to = ids.indexOf(id);
    if (from !== -1 && to !== -1) {
      state.multi = new Set(ids.slice(Math.min(from, to), Math.max(from, to) + 1));
      return select(id, { keepMulti: true, anchor: state.selectedId });
    }
  }
  select(id);
}

function select(id, { keepMulti = false, anchor } = {}) {
  if (!keepMulti) state.multi.clear();
  state.selectedId = anchor ?? id;
  const chosen = new Set(selectionIds());
  for (const element of $$("[data-id]")) {
    const on = chosen.has(element.dataset.id);
    element.classList.toggle("is-selected", on);
    if (element.getAttribute("role") === "row") element.setAttribute("aria-selected", String(on));
  }
  renderChrome();
  renderDetails();
}

function open(file) {
  if (state.view.kind === "trash") {
    snackbar("Items in the trash can't be opened. Restore the item first.");
    return;
  }
  if (isFolder(file)) openFolder(file);
  else void openPreview(file.id);
}

// ---------------------------------------------------------------------------------------------
// Row menu and the actions behind it
// ---------------------------------------------------------------------------------------------

const FOLDER_COLORS = [
  ["#5f6368", "Grey"],
  ["#4285f4", "Blue"],
  ["#0b8043", "Green"],
  ["#f4b400", "Yellow"],
  ["#db4437", "Red"],
  ["#8e24aa", "Purple"],
  ["#00acc1", "Cyan"],
  ["#e8710a", "Orange"],
];

function rowMenu(file) {
  const can = file.capabilities ?? {};
  if (state.view.kind === "trash") {
    return [
      { label: "Restore", icon: "restore", disabled: !can.canUntrash, onSelect: () => void restore(file) },
      { label: "Delete forever", icon: "delete_forever", disabled: !can.canDelete, onSelect: () => void deleteForever(file) },
      "divider",
      { label: "File information", icon: "info", onSelect: () => void openDetailsFor(file.id) },
    ];
  }
  const items = [];
  if (isFolder(file)) items.push({ label: "Open", icon: "folder", onSelect: () => openFolder(file) });
  else items.push({ label: "Preview", icon: "visibility", onSelect: () => void openPreview(file.id) });
  items.push(
    { label: "Share", icon: "person_add", disabled: !can.canShare, onSelect: () => void openShareDialog(file.id) },
    { label: "Copy link", icon: "link", onSelect: () => void copyLink(file) },
    { label: "Download", icon: "download", disabled: !can.canDownload, onSelect: () => void download(file) },
    "divider",
    { label: "Rename", icon: "edit", disabled: !can.canRename, onSelect: () => openRenameDialog(file) },
    { label: "Make a copy", icon: "content_copy", disabled: !can.canCopy || isFolder(file), onSelect: () => void makeCopy(file) },
    { label: "Move", icon: "drive_file_move", disabled: !can.canMoveItemWithinDrive, onSelect: () => openMoveDialog(file) },
    { label: file.starred ? "Remove from starred" : "Add to starred", icon: file.starred ? "star" : "star_border", onSelect: () => void toggleStar(file) },
  );
  if (isFolder(file)) items.push({ label: "Change colour", icon: "palette", disabled: !can.canEdit, submenu: () => FOLDER_COLORS.map(([value, label]) => ({ label, radio: (file.folderColorRgb ?? "#5f6368") === value, onSelect: () => void setFolderColor(file, value) })) });
  items.push("divider", { label: "File information", icon: "info", onSelect: () => void openDetailsFor(file.id) }, { label: "Move to trash", icon: "delete_outline", disabled: !can.canTrash, onSelect: () => void trash(file) });
  return items;
}

/** Reload the current view and keep the selection where it still exists. */
async function afterMutation(message, { undo } = {}) {
  await loadView({ silent: true });
  renderStorage();
  if (message) snackbar(message, undo ? { actionLabel: "Undo", onAction: undo } : {});
  try {
    state.about = await call("about.get", {});
    state.now = state.about.serverTime ?? state.now;
    renderStorage();
  } catch {
    /* the list is already refreshed; a failing quota read must not break the view */
  }
}

const toggleStar = (file) =>
  action(async () => {
    await call("files.update", { fileId: file.id, starred: !file.starred }, key());
    await afterMutation(file.starred ? "Removed from starred" : "Added to starred");
  });

const setFolderColor = (file, folderColorRgb) =>
  action(async () => {
    await call("files.update", { fileId: file.id, folderColorRgb }, key());
    await afterMutation("Folder colour changed");
  });

const trash = (file) =>
  action(async () => {
    await call("files.update", { fileId: file.id, trashed: true }, key());
    if (state.selectedId === file.id) state.selectedId = undefined;
    await afterMutation(`"${file.name}" moved to trash`, {
      undo: async () => {
        await call("files.update", { fileId: file.id, trashed: false }, key());
        await afterMutation(`"${file.name}" restored`);
      },
    });
  });

const restore = (file) =>
  action(async () => {
    await call("files.update", { fileId: file.id, trashed: false }, key());
    await afterMutation(`"${file.name}" restored from trash`);
  });

async function deleteForever(file) {
  const answer = await confirmDialog("Delete forever?", `"${file.name}" will be deleted forever and you won't be able to restore it.`, { okLabel: "Delete forever", danger: true });
  if (answer !== "ok") return;
  await action(async () => {
    await call("files.delete", { fileId: file.id }, key());
    if (state.selectedId === file.id) state.selectedId = undefined;
    await afterMutation(`"${file.name}" deleted forever`);
  });
}

async function emptyTrash() {
  const answer = await confirmDialog("Delete all items forever?", "All items in the trash you own will be deleted forever and you won't be able to restore them.", { okLabel: "Delete forever", danger: true });
  if (answer !== "ok") return;
  await action(async () => {
    const result = await call("files.empty-trash", {}, key());
    state.selectedId = undefined;
    await afterMutation(`${result.deleted} item${result.deleted === 1 ? "" : "s"} deleted forever`);
  });
}

const makeCopy = (file) =>
  action(async () => {
    const copy = await call("files.copy", { fileId: file.id }, key());
    await afterMutation(`Copy created: "${copy.file.name}"`);
  });

function openRenameDialog(file) {
  const input = el("input", { class: "gd-input", attrs: { type: "text", value: file.name, "aria-label": "Name", maxlength: "1024" } });
  const form = el("form", { class: "gd-form", attrs: { id: "rename-form" } }, [input]);
  state.formOpen = true;
  const submit = (event) => {
    event?.preventDefault();
    const name = input.value.trim();
    if (name.length === 0 || name === file.name) {
      closeModal();
      return;
    }
    closeModal();
    void action(async () => {
      await call("files.update", { fileId: file.id, name }, key());
      await afterMutation("Renamed");
    });
  };
  form.addEventListener("submit", submit);
  openModal({
    title: "Rename",
    className: "gd-dialog gd-modal is-small",
    body: form,
    actions: [textButton("Cancel", { onClick: () => closeModal() }), filledButton("OK", { onClick: submit })],
    onClose: () => {
      state.formOpen = false;
    },
  });
  input.focus();
  input.select();
}

async function copyLink(file) {
  const link = file.webViewLink ?? `https://drive.google.com/file/d/${file.id}/view`;
  try {
    await navigator.clipboard.writeText(link);
    snackbar("Link copied to clipboard");
  } catch {
    snackbar(`Link: ${link}`, { timeout: 9000 });
  }
}

/** Fetch the bytes through the Tool and hand them to the browser; nothing is fetched from the internet. */
async function download(file) {
  await action(async () => {
    const payload = await call("files.download", { fileId: file.id });
    const binary = atob(payload.content ?? "");
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const url = URL.createObjectURL(new Blob([bytes], { type: payload.mimeType || "application/octet-stream" }));
    const anchor = el("a", { attrs: { href: url, download: payload.title || file.name } });
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    snackbar(`Downloading "${payload.title || file.name}" (${formatSize(bytes.length)})`);
  });
}

// ---------------------------------------------------------------------------------------------
// Details pane (Drive's right-hand information panel)
// ---------------------------------------------------------------------------------------------

async function openDetailsFor(fileId) {
  state.detailsOpen = true;
  writePreference("details", "true");
  $("#details-toggle").setAttribute("aria-pressed", "true");
  if (fileById(fileId)) select(fileId);
  else {
    state.selectedId = fileId;
    await action(async () => {
      const result = await call("files.get", { fileId });
      state.extraFile = result.file;
      rememberPeople([result.file]);
      renderDetails();
    });
  }
  renderDetails();
}

const detailsFile = () => selected() ?? (state.extraFile?.id === state.selectedId ? state.extraFile : undefined);

function renderDetails() {
  const host = $("#details");
  host.hidden = !state.detailsOpen;
  document.body.classList.toggle("has-details", state.detailsOpen);
  if (!state.detailsOpen) return;
  const file = detailsFile();
  host.replaceChildren();
  if (!file) {
    host.append(
      el("div", { class: "gd-details-head" }, [el("h2", { class: "gd-details-title", text: state.view.title ?? "My Drive" }), iconButton("close", "Close details", { onClick: () => toggleDetails(false) })]),
      el("div", { class: "gd-details-empty" }, [icon("info", "gd-empty-icon"), el("p", { class: "gd-empty-text", text: "Select an item to see its details." })]),
    );
    return;
  }

  host.append(
    el("div", { class: "gd-details-head" }, [fileIcon(file), el("h2", { class: "gd-details-title", text: file.name, title: file.name }), iconButton("close", "Close details", { onClick: () => toggleDetails(false) })]),
  );
  const tabs = el("div", { class: "gd-tabs", attrs: { role: "tablist" } });
  for (const [id, label] of [
    ["details", "Details"],
    ["activity", "Activity"],
  ]) {
    const tab = el("button", { class: `gd-tab ${state.detailsTab === id ? "is-active" : ""}`.trim(), text: label, attrs: { type: "button", role: "tab", "aria-selected": String(state.detailsTab === id) } });
    tab.addEventListener("click", () => {
      state.detailsTab = id;
      renderDetails();
    });
    tabs.append(tab);
  }
  host.append(tabs);

  const body = el("div", { class: "gd-details-body", attrs: { role: "tabpanel" } });
  host.append(body);
  if (state.detailsTab === "activity") {
    body.append(el("p", { class: "gd-details-note", text: "Loading activity…" }));
    void loadActivity(file, body);
    return;
  }

  const thumb = el("div", { class: "gd-details-thumb" }, [fileIcon(file, "gd-details-thumb-icon")]);
  body.append(thumb);

  const access = el("section", { class: "gd-details-section" }, [el("h3", { class: "gd-details-h3", text: "Who has access" })]);
  const people = el("div", { class: "gd-access-row" });
  for (const permission of (file.permissions ?? []).slice(0, 6)) {
    const label = permission.emailAddress || permission.domain || (permission.type === "anyone" ? "Anyone with the link" : permission.type);
    const badge = permission.type === "anyone" ? el("span", { class: "gd-avatar small is-generic" }, [icon("public")]) : permission.type === "domain" ? el("span", { class: "gd-avatar small is-generic" }, [icon("domain")]) : avatar(permission.displayName, permission.emailAddress, "small");
    badge.title = `${label} · ${permission.role}`;
    people.append(badge);
  }
  if ((file.permissions ?? []).length === 0) people.append(el("span", { class: "gd-details-note", text: "Only you" }));
  access.append(people);
  if (file.capabilities?.canShare) access.append(textButton("Manage access", { class: "gd-outlined-btn", onClick: () => void openShareDialog(file.id) }));
  body.append(access);

  const rows = [
    ["Type", typeLabel(file.mimeType)],
    ["Size", isFolder(file) || isShortcut(file) ? "—" : formatSize(file.size ?? 0)],
    ["Storage used", formatSize(file.quotaBytesUsed ?? 0)],
    ["Location", file.trashed ? "Trash" : state.view.kind === "folder" ? state.view.title : file.ownedByMe ? "My Drive" : "Shared with me"],
    ["Owner", file.owners?.[0] ? (file.owners[0].me ? "me" : file.owners[0].displayName || file.owners[0].emailAddress) : "—"],
    ["Modified", `${formatFullDate(file.modifiedTime)}${file.lastModifyingUser ? ` by ${file.lastModifyingUser.me ? "me" : file.lastModifyingUser.displayName || file.lastModifyingUser.emailAddress}` : ""}`],
    ["Opened", file.viewedByMeTime ? formatFullDate(file.viewedByMeTime) : "Never opened by me"],
    ["Created", formatFullDate(file.createdTime)],
  ];
  if (file.md5Checksum) rows.push(["MD5 checksum", file.md5Checksum]);
  if (isShortcut(file) && file.shortcutDetails) rows.push(["Shortcut target", typeLabel(file.shortcutDetails.targetMimeType)]);
  rows.push(["Download permission", file.capabilities?.canDownload ? "Viewers can download" : "Download, print and copy are off"]);
  body.append(el("section", { class: "gd-details-section" }, [el("h3", { class: "gd-details-h3", text: "File details" }), el("dl", { class: "gd-props" }, rows.map(([label, value]) => el("div", { class: "gd-prop" }, [el("dt", { text: label }), el("dd", { text: value })])))]));

  const description = el("section", { class: "gd-details-section" }, [el("h3", { class: "gd-details-h3", text: "Description" })]);
  const box = el("textarea", { class: "gd-textarea", attrs: { rows: "3", "aria-label": "Description", placeholder: "Add a description", maxlength: "4096" } });
  box.value = file.description ?? "";
  box.disabled = !file.capabilities?.canEdit;
  description.append(box);
  if (file.capabilities?.canEdit) {
    const save = textButton("Save", {
      class: "gd-outlined-btn",
      onClick: () =>
        void action(async () => {
          await call("files.update", { fileId: file.id, description: box.value }, key());
          state.extraFile = undefined;
          await afterMutation("Description saved");
        }),
    });
    save.disabled = true;
    box.addEventListener("input", () => {
      save.disabled = box.value === (file.description ?? "");
      state.formOpen = !save.disabled;
    });
    description.append(save);
  }
  body.append(description);
  body.append(el("p", { class: "gd-details-note", text: `Link: ${file.webViewLink ?? "—"} (synthetic; it does not resolve)` }));
}

function toggleDetails(next = !state.detailsOpen) {
  state.detailsOpen = next;
  writePreference("details", String(next));
  $("#details-toggle").setAttribute("aria-pressed", String(next));
  renderDetails();
}

/** The Activity tab reads the Drive change journal and keeps the rows for this one file. */
async function loadActivity(file, body) {
  try {
    // Read the whole journal (it ends with newStartPageToken); nothing past an early page is dropped.
    const entries = [];
    let token = "1";
    while (token) {
      const result = await call("changes.list", { pageToken: token, pageSize: 1000, includeRemoved: true });
      for (const change of result.changes ?? []) if (change.fileId === file.id) entries.push(change);
      token = result.nextPageToken;
    }
    if (!body.isConnected) return;
    body.replaceChildren();
    if (entries.length === 0) {
      body.append(el("div", { class: "gd-details-empty" }, [icon("history", "gd-empty-icon"), el("p", { class: "gd-empty-text", text: "No activity recorded for this item in this world yet." })]));
      return;
    }
    const listing = el("ul", { class: "gd-activity" });
    for (const change of entries.reverse()) {
      listing.append(
        el("li", { class: "gd-activity-item" }, [
          el("span", { class: "gd-activity-dot" }),
          el("div", {}, [
            el("p", { class: "gd-activity-text", text: change.removed ? "Deleted forever" : "Changed" }),
            el("p", { class: "gd-activity-time", text: formatFullDate(change.time) }),
          ]),
        ]),
      );
    }
    body.append(listing);
  } catch (error) {
    if (!body.isConnected) return;
    body.replaceChildren(el("p", { class: "gd-details-note", text: describe(error) }));
  }
}

// ---------------------------------------------------------------------------------------------
// Preview overlay and the minimal editor for Google editor files
// ---------------------------------------------------------------------------------------------

let previewState;

async function openPreview(fileId) {
  const host = $("#preview");
  host.hidden = false;
  host.replaceChildren(el("div", { class: "gd-preview-loading" }, [el("span", { class: "gd-spinner" }), el("p", { text: "Loading preview…" })]));
  document.body.classList.add("has-overlay");
  await action(
    async () => {
      const { file } = await call("files.get", { fileId });
      rememberPeople([file]);
      previewState = { file, editing: false, body: undefined, dirty: false };
      if (isImage(file)) {
        const result = await call("files.get", { fileId, alt: "media" });
        previewState.media = result.media;
      } else if (file.mimeType === SHEET) {
        previewState.sheet = await call("files.export", { fileId, mimeType: "text/csv" });
        previewState.body = previewState.sheet.data;
      } else if (isTextual(file)) {
        const content = await call("files.read-content", { fileId });
        previewState.body = content.fileContent ?? "";
        previewState.unsupported = content.textFormattingNotSupported && (content.fileContent ?? "") === "";
      }
      renderPreview();
    },
    {
      onError: (error) => {
        closePreview();
        snackbar(describe(error), { error: true });
      },
    },
  );
}

function closePreview() {
  previewState = undefined;
  const host = $("#preview");
  host.hidden = true;
  host.replaceChildren();
  document.body.classList.remove("has-overlay");
  state.formOpen = false;
}

function renderPreview() {
  if (!previewState) return;
  const { file } = previewState;
  const host = $("#preview");
  host.replaceChildren();

  const bar = el("div", { class: "gd-preview-bar" }, [
    iconButton("arrow_back", "Close preview", { class: "on-dark", onClick: () => closePreview() }),
    fileIcon(file, "gd-preview-icon"),
    el("span", { class: "gd-preview-name", text: file.name }),
  ]);
  const tools = el("div", { class: "gd-preview-tools" });
  if (isGoogleType(file.mimeType) && file.capabilities?.canModifyContent && !previewState.editing && previewState.body !== undefined) {
    tools.append(
      textButton("Edit", {
        class: "gd-preview-edit",
        onClick: () => {
          previewState.editing = true;
          state.formOpen = true;
          renderPreview();
        },
      }),
    );
  }
  if (file.capabilities?.canShare) tools.append(iconButton("person_add", "Share", { class: "on-dark", onClick: () => void openShareDialog(file.id) }));
  if (file.capabilities?.canDownload) tools.append(iconButton("download", "Download", { class: "on-dark", onClick: () => void download(file) }));
  tools.append(
    iconButton("more_vert", "More actions", {
      class: "on-dark",
      attrs: { "aria-haspopup": "menu", "aria-expanded": "false" },
      onClick: (event) => openMenu(event.currentTarget, rowMenu(file), { align: "end" }),
    }),
    iconButton("close", "Close", { class: "on-dark", onClick: () => closePreview() }),
  );
  bar.append(tools);
  host.append(bar);

  const stage = el("div", { class: "gd-preview-stage" });
  if (previewState.editing) stage.append(editorSurface(file));
  else if (previewState.media) {
    const image = el("img", { class: "gd-preview-image", attrs: { alt: file.name, src: `data:${previewState.media.mimeType};base64,${previewState.media.data}` } });
    // Stored bytes that the browser cannot decode fall back to Drive's "No preview available" card.
    image.addEventListener("error", () => {
      previewState.media = undefined;
      previewState.unsupported = true;
      renderPreview();
    });
    stage.append(image);
  } else if (file.mimeType === SHEET && previewState.sheet) stage.append(sheetSurface(previewState.sheet.data ?? ""));
  else if (previewState.body !== undefined && !previewState.unsupported) stage.append(el("article", { class: `gd-page ${file.mimeType === SLIDES ? "is-slides" : ""}`.trim() }, [el("pre", { class: "gd-page-text", text: previewState.body })]));
  else
    stage.append(
      el("div", { class: "gd-preview-none" }, [
        fileIcon(file, "gd-preview-none-icon"),
        el("h2", { class: "gd-preview-none-title", text: "No preview available" }),
        el("p", { class: "gd-preview-none-text", text: `${typeLabel(file.mimeType)} · ${formatSize(file.size ?? 0)}` }),
        file.capabilities?.canDownload ? filledButton("Download", { onClick: () => void download(file) }) : undefined,
      ]),
    );
  host.append(stage);
  if (previewState.editing) {
    const input = $(".gd-editor-input", host);
    if (input) {
      input.focus();
      input.setSelectionRange(0, 0);
      input.scrollTop = 0;
      stage.scrollTop = 0;
    }
  }
}

function editorSurface(file) {
  const wrap = el("div", { class: "gd-editor" });
  const title = el("input", { class: "gd-editor-title", attrs: { type: "text", value: file.name, "aria-label": "File name", maxlength: "1024" } });
  const area = el("textarea", { class: "gd-editor-input", attrs: { "aria-label": "File content", spellcheck: "false" } });
  area.value = previewState.body ?? "";
  const status = el("span", { class: "gd-editor-status", text: "All changes saved in Drive" });
  const save = filledButton("Save", {
    onClick: () =>
      void action(async () => {
        const patch = { fileId: file.id, textContent: area.value };
        if (title.value.trim() && title.value.trim() !== file.name) patch.name = title.value.trim();
        const updated = await call("files.update", patch, key());
        previewState.file = updated.file;
        previewState.body = area.value;
        previewState.dirty = false;
        previewState.editing = false;
        state.formOpen = false;
        renderPreview();
        await afterMutation("Changes saved to Drive");
      }),
  });
  const mark = () => {
    previewState.dirty = true;
    state.formOpen = true;
    status.textContent = "Unsaved changes";
  };
  area.addEventListener("input", mark);
  title.addEventListener("input", mark);
  wrap.append(
    el("div", { class: "gd-editor-bar" }, [
      title,
      status,
      textButton("Cancel", {
        onClick: () => {
          previewState.editing = false;
          previewState.dirty = false;
          state.formOpen = false;
          renderPreview();
        },
      }),
      save,
    ]),
    el("div", { class: "gd-editor-page" }, [area]),
  );
  return wrap;
}

/** Sheets are stored as CSV text; the preview renders the grid the way the viewer shows it. */
function sheetSurface(csv) {
  const table = el("table", { class: "gd-sheet" });
  const rows = csv.split(/\r?\n/).filter((line, index, all) => line.length > 0 || index < all.length - 1);
  rows.forEach((line, index) => {
    const cells = splitCsvLine(line);
    const tr = el("tr", { class: index === 0 ? "is-head" : "" });
    tr.append(el("th", { class: "gd-sheet-gutter", text: String(index + 1) }));
    for (const cell of cells) tr.append(el(index === 0 ? "th" : "td", { text: cell }));
    table.append(tr);
  });
  return el("div", { class: "gd-sheet-wrap" }, [table]);
}

function splitCsvLine(line) {
  const cells = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"' && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else current += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") {
      cells.push(current);
      current = "";
    } else current += character;
  }
  cells.push(current);
  return cells;
}

// ---------------------------------------------------------------------------------------------
// Share dialog
// ---------------------------------------------------------------------------------------------

const ROLE_LABELS = { owner: "Owner", writer: "Editor", commenter: "Commenter", reader: "Viewer" };
const ROLE_ORDER = ["reader", "commenter", "writer"];

async function openShareDialog(fileId) {
  const body = el("div", { class: "gd-share" }, [el("p", { class: "gd-details-note", text: "Loading sharing settings…" })]);
  let file = fileById(fileId) ?? (state.extraFile?.id === fileId ? state.extraFile : undefined);
  const shell = openModal({
    title: "Share",
    className: "gd-dialog gd-modal is-share",
    body,
    actions: [],
    onClose: () => {
      state.formOpen = false;
    },
  });
  state.formOpen = true;
  const reload = async () => {
    try {
      if (!file || file.id !== fileId) file = (await call("files.get", { fileId })).file;
      // Follow nextPageToken so every direct and inherited grant is shown (pages are also bounded by bytes).
      const permissions = [];
      let pageToken;
      do {
        const page = await call("permissions.list", { fileId, pageSize: 100, ...(pageToken ? { pageToken } : {}) });
        permissions.push(...(page.permissions ?? []));
        pageToken = page.nextPageToken;
      } while (pageToken);
      $("#modal-title").textContent = `Share "${file.name}"`;
      body.replaceChildren(shareBody(file, permissions, reload, shell));
    } catch (error) {
      body.replaceChildren(el("p", { class: "gd-share-error", text: describe(error) }));
    }
  };
  await reload();
}

function shareBody(file, permissions, reload, shell) {
  const wrap = el("div", { class: "gd-share" });
  const error = el("p", { class: "gd-share-error", attrs: { role: "alert" }, text: "" });
  error.hidden = true;
  const fail = (problem) => {
    error.textContent = describe(problem);
    error.hidden = false;
  };
  const canShare = file.capabilities?.canShare === true;

  // Add people
  const address = el("input", { class: "gd-input", attrs: { type: "email", placeholder: "Add people and groups", "aria-label": "Add people and groups", autocomplete: "off" } });
  const role = el("select", { class: "gd-select", attrs: { "aria-label": "Role for the new person" } }, ROLE_ORDER.map((value) => el("option", { text: ROLE_LABELS[value], attrs: { value } })));
  role.value = "writer";
  const notify = el("input", { attrs: { type: "checkbox", id: "share-notify", checked: "checked" } });
  const send = filledButton("Share", {
    onClick: () => {
      const value = address.value.trim();
      if (!value) {
        fail(new Error("Enter an e-mail address to share with."));
        return;
      }
      void action(
        async () => {
          await call("permissions.create", { fileId: file.id, type: value.includes("@") ? "user" : "domain", ...(value.includes("@") ? { emailAddress: value } : { domain: value }), role: role.value, sendNotificationEmail: notify.checked }, key());
          address.value = "";
          error.hidden = true;
          snackbar(`Shared with ${value}`);
          await reload();
          await loadView({ silent: true });
        },
        { onError: fail },
      );
    },
  });
  if (!canShare) {
    address.disabled = true;
    role.disabled = true;
    send.disabled = true;
  }
  wrap.append(el("div", { class: "gd-share-add" }, [address, role, send]));
  wrap.append(el("label", { class: "gd-check" }, [notify, el("span", { text: "Notify people" })]));
  if (!canShare) wrap.append(el("p", { class: "gd-share-note", text: "The owner has turned off sharing for people who aren't the owner of this item." }));
  wrap.append(error);

  // People with access
  const people = el("section", { class: "gd-share-section" }, [el("h3", { class: "gd-details-h3", text: "People with access" })]);
  for (const permission of permissions.filter((entry) => entry.type === "user" || entry.type === "group")) {
    const inherited = permission.permissionDetails?.[0]?.inherited === true;
    const label = permission.displayName || permission.emailAddress || permission.type;
    const line = el("div", { class: "gd-share-person" }, [
      avatar(permission.displayName, permission.emailAddress),
      el("div", { class: "gd-share-person-text" }, [
        el("span", { class: "gd-share-person-name", text: `${label}${permission.emailAddress === me() ? " (you)" : ""}` }),
        el("span", { class: "gd-share-person-mail", text: permission.emailAddress ?? "" }),
        permission.expirationTime ? el("span", { class: "gd-share-person-mail", text: `Access expires ${formatFullDate(permission.expirationTime)}` }) : undefined,
        inherited ? el("span", { class: "gd-share-person-mail", text: "Inherited from a parent folder" }) : undefined,
      ]),
    ]);
    if (permission.role === "owner" || inherited || !canShare) line.append(el("span", { class: "gd-share-role-static", text: permission.role === "owner" ? "Owner" : ROLE_LABELS[permission.role] }));
    else {
      const roleSelect = el("select", { class: "gd-select", attrs: { "aria-label": `Role for ${label}` } }, [
        ...ROLE_ORDER.map((value) => el("option", { text: ROLE_LABELS[value], attrs: { value } })),
        el("option", { text: "Transfer ownership", attrs: { value: "owner" } }),
        el("option", { text: "Remove access", attrs: { value: "remove" } }),
      ]);
      roleSelect.value = permission.role;
      roleSelect.addEventListener("change", () => {
        const next = roleSelect.value;
        void action(
          async () => {
            if (next === "remove") await call("permissions.delete", { fileId: file.id, permissionId: permission.id }, key());
            else if (next === "owner") await call("permissions.update", { fileId: file.id, permissionId: permission.id, role: "owner", transferOwnership: true }, key());
            else await call("permissions.update", { fileId: file.id, permissionId: permission.id, role: next }, key());
            error.hidden = true;
            snackbar(next === "remove" ? `Removed access for ${label}` : `${label} is now ${next === "owner" ? "the owner" : ROLE_LABELS[next].toLowerCase()}`);
            await reload();
            await loadView({ silent: true });
          },
          {
            onError: (problem) => {
              roleSelect.value = permission.role;
              fail(problem);
            },
          },
        );
      });
      line.append(roleSelect);
    }
    people.append(line);
  }
  wrap.append(people);

  // General access
  const general = el("section", { class: "gd-share-section" }, [el("h3", { class: "gd-details-h3", text: "General access" })]);
  const anyone = permissions.find((entry) => entry.type === "anyone");
  const domainRow = permissions.find((entry) => entry.type === "domain");
  const currentScope = anyone ? "anyone" : domainRow ? "domain" : "restricted";
  const scopeSelect = el("select", { class: "gd-select", attrs: { "aria-label": "General access" } }, [
    el("option", { text: "Restricted", attrs: { value: "restricted" } }),
    el("option", { text: `${(me().split("@")[1] ?? "your organisation")} (anyone in the domain)`, attrs: { value: "domain" } }),
    el("option", { text: "Anyone with the link", attrs: { value: "anyone" } }),
  ]);
  scopeSelect.value = currentScope;
  scopeSelect.disabled = !canShare;
  const scopeIcon = icon(currentScope === "anyone" ? "public" : currentScope === "domain" ? "domain" : "lock", "gd-share-scope-icon");
  scopeSelect.addEventListener("change", () => {
    const next = scopeSelect.value;
    void action(
      async () => {
        if (anyone && next !== "anyone") await call("permissions.delete", { fileId: file.id, permissionId: anyone.id }, key());
        if (domainRow && next !== "domain") await call("permissions.delete", { fileId: file.id, permissionId: domainRow.id }, key());
        if (next === "anyone" && !anyone) await call("permissions.create", { fileId: file.id, type: "anyone", role: "reader", allowFileDiscovery: false }, key());
        if (next === "domain" && !domainRow) await call("permissions.create", { fileId: file.id, type: "domain", domain: me().split("@")[1] ?? "example.test", role: "reader", allowFileDiscovery: true }, key());
        error.hidden = true;
        snackbar("General access updated");
        await reload();
        await loadView({ silent: true });
      },
      {
        onError: (problem) => {
          scopeSelect.value = currentScope;
          fail(problem);
        },
      },
    );
  });
  general.append(
    el("div", { class: "gd-share-general" }, [
      el("span", { class: "gd-share-scope" }, [scopeIcon]),
      el("div", { class: "gd-share-person-text" }, [scopeSelect, el("span", { class: "gd-share-person-mail", text: currentScope === "restricted" ? "Only people with access can open with the link" : currentScope === "anyone" ? `Anyone with the link can ${ROLE_LABELS[anyone?.role ?? "reader"].toLowerCase()}` : `Anyone in ${me().split("@")[1] ?? "the domain"} can ${ROLE_LABELS[domainRow?.role ?? "reader"].toLowerCase()}` })]),
    ]),
  );
  wrap.append(general);

  wrap.append(
    el("div", { class: "gd-share-foot" }, [
      textButton("Copy link", { class: "gd-outlined-btn", onClick: () => void copyLink(file) }),
      filledButton("Done", { onClick: () => shell.close() }),
    ]),
  );
  return wrap;
}

// ---------------------------------------------------------------------------------------------
// Move dialog
// ---------------------------------------------------------------------------------------------

function openMoveDialog(file) {
  const browse = { id: "root", name: "My Drive", path: [] };
  const body = el("div", { class: "gd-move" });
  const shell = openModal({
    title: `Move "${file.name}"`,
    className: "gd-dialog gd-modal is-move",
    body,
    actions: [],
    onClose: () => {
      state.formOpen = false;
    },
  });
  state.formOpen = true;

  const render = async () => {
    body.replaceChildren(el("p", { class: "gd-details-note", text: "Loading folders…" }));
    const crumbs = el("div", { class: "gd-move-crumbs" });
    const back = iconButton("chevron_left", "Back", {
      onClick: () => {
        if (browse.path.length === 0) return;
        const previous = browse.path.pop();
        browse.id = previous.id;
        browse.name = previous.name;
        void render();
      },
    });
    back.disabled = browse.path.length === 0;
    crumbs.append(back, el("span", { class: "gd-move-current", text: browse.name }));
    const folderQuery = { query: `${quote(browse.id)} in parents and mimeType = ${quote(FOLDER)} and trashed = false`, orderBy: "name", pageSize: 100 };
    let folders = [];
    let nextToken;
    let problem;
    try {
      const result = await call("files.list", folderQuery);
      folders = result.files ?? [];
      nextToken = result.nextPageToken;
    } catch (failure) {
      problem = failure;
    }
    const listing = el("ul", { class: "gd-move-list" });
    if (problem) listing.append(el("li", { class: "gd-share-error", text: describe(problem) }));
    else if (folders.length === 0) listing.append(el("li", { class: "gd-move-empty", text: "No folders here" }));
    const appendFolders = (batch) => {
      for (const folder of batch) listing.append(folderItem(folder));
    };
    // Every folder stays reachable: "Show more folders" follows nextPageToken until the parent has no further pages.
    const moreItem = el("li", { class: "gd-move-more-item" });
    const renderMore = () => {
      moreItem.replaceChildren();
      moreItem.remove();
      if (!nextToken) return;
      const more = textButton("Show more folders", {
        class: "gd-move-more",
        onClick: async () => {
          more.disabled = true;
          more.textContent = "Loading…";
          try {
            const result = await call("files.list", { ...folderQuery, pageToken: nextToken });
            appendFolders(result.files ?? []);
            nextToken = result.nextPageToken;
          } catch (failure) {
            if (failure instanceof ToolError && failure.is("INVALID_PAGE_TOKEN")) nextToken = undefined;
            listing.append(el("li", { class: "gd-share-error", text: describe(failure) }));
          }
          renderMore();
        },
      });
      moreItem.append(more);
      listing.append(moreItem);
    };
    const folderItem = (folder) => {
      const item = el("li", {}, [
        (() => {
          const button = el("button", { class: "gd-move-item", attrs: { type: "button" } }, [fileIcon(folder), el("span", { text: folder.name }), icon("chevron_right", "gd-move-arrow")]);
          button.disabled = folder.id === file.id;
          button.addEventListener("click", () => {
            browse.path.push({ id: browse.id, name: browse.name });
            browse.id = folder.id;
            browse.name = folder.name;
            void render();
          });
          return button;
        })(),
      ]);
      return item;
    };
    appendFolders(folders);
    renderMore();
    const currentParent = file.parents?.[0];
    const targetId = browse.id === "root" ? state.rootId ?? "root" : browse.id;
    const move = filledButton("Move", {
      onClick: () =>
        void action(
          async () => {
            await call("files.update", { fileId: file.id, addParents: browse.id, ...(currentParent ? { removeParents: currentParent } : {}) }, key());
            shell.close();
            snackbar(`"${file.name}" moved to ${browse.name}`);
            await afterMutation();
          },
          {
            onError: (failure) => {
              const banner = el("p", { class: "gd-share-error", text: describe(failure) });
              body.append(banner);
            },
          },
        ),
    });
    move.disabled = targetId === currentParent || browse.id === file.id;
    body.replaceChildren(crumbs, listing, el("div", { class: "gd-share-foot" }, [textButton("Cancel", { onClick: () => shell.close() }), move]));
  };
  void render();
}

// ---------------------------------------------------------------------------------------------
// New folder / upload / blank editor files
// ---------------------------------------------------------------------------------------------

const parentForNew = () => (state.view.kind === "folder" ? state.view.folderId : "root");

function openNewFolderDialog(parentId = parentForNew()) {
  const input = el("input", { class: "gd-input", attrs: { type: "text", value: "Untitled folder", "aria-label": "Folder name", maxlength: "1024" } });
  const form = el("form", { class: "gd-form" }, [input]);
  const submit = (event) => {
    event?.preventDefault();
    const name = input.value.trim() || "Untitled folder";
    closeModal();
    void action(async () => {
      await call("files.create", { name, mimeType: FOLDER, parentId }, key());
      await afterMutation(`Folder "${name}" created`);
    });
  };
  form.addEventListener("submit", submit);
  state.formOpen = true;
  openModal({
    title: "New folder",
    className: "gd-dialog gd-modal is-small",
    body: form,
    actions: [textButton("Cancel", { onClick: () => closeModal() }), filledButton("Create", { onClick: submit })],
    onClose: () => {
      state.formOpen = false;
    },
  });
  input.focus();
  input.select();
}

const UPLOAD_TYPES = [
  ["text/plain", "Plain text (.txt)"],
  ["text/markdown", "Markdown (.md)"],
  ["text/csv", "Comma separated values (.csv)"],
  ["application/json", "JSON (.json)"],
  ["text/html", "HTML (.html)"],
];

function openUploadDialog(parentId = parentForNew()) {
  const name = el("input", { class: "gd-input", attrs: { type: "text", value: "notes.txt", "aria-label": "File name", maxlength: "1024" } });
  const type = el("select", { class: "gd-select", attrs: { "aria-label": "File type" } }, UPLOAD_TYPES.map(([value, label]) => el("option", { text: label, attrs: { value } })));
  const convert = el("input", { attrs: { type: "checkbox", id: "upload-convert" } });
  const content = el("textarea", { class: "gd-textarea is-tall", attrs: { rows: "10", "aria-label": "File content", placeholder: "Paste the file's text here" } });
  const form = el("form", { class: "gd-form" }, [
    el("label", { class: "gd-field" }, [el("span", { class: "gd-field-label", text: "File name" }), name]),
    el("label", { class: "gd-field" }, [el("span", { class: "gd-field-label", text: "Type" }), type]),
    el("label", { class: "gd-check" }, [convert, el("span", { text: "Convert to the matching Google editor format" })]),
    el("label", { class: "gd-field" }, [el("span", { class: "gd-field-label", text: "Content" }), content]),
  ]);
  const submit = (event) => {
    event?.preventDefault();
    const title = name.value.trim() || "Untitled";
    closeModal();
    void action(async () => {
      const googleType = type.value === "text/csv" ? SHEET : DOC;
      await call(
        "files.create",
        convert.checked
          ? { name: title, mimeType: googleType, contentMimeType: type.value, textContent: content.value, parentId, disableConversionToGoogleType: false }
          : { name: title, contentMimeType: type.value, textContent: content.value, parentId },
        key(),
      );
      await afterMutation(`"${title}" uploaded`);
    });
  };
  form.addEventListener("submit", submit);
  state.formOpen = true;
  openModal({
    title: "Upload a file",
    className: "gd-dialog gd-modal",
    body: form,
    actions: [textButton("Cancel", { onClick: () => closeModal() }), filledButton("Upload", { onClick: submit })],
    onClose: () => {
      state.formOpen = false;
    },
  });
  name.focus();
  name.select();
}

function openBlankDialog(mimeType, label, parentId = parentForNew()) {
  const name = el("input", { class: "gd-input", attrs: { type: "text", value: `Untitled ${label.toLowerCase()}`, "aria-label": "Name", maxlength: "1024" } });
  const content = el("textarea", { class: "gd-textarea is-tall", attrs: { rows: "8", "aria-label": "Starting content", placeholder: mimeType === SHEET ? "Optional starting rows, one per line, comma separated" : "Optional starting text" } });
  const form = el("form", { class: "gd-form" }, [
    el("label", { class: "gd-field" }, [el("span", { class: "gd-field-label", text: "Name" }), name]),
    el("label", { class: "gd-field" }, [el("span", { class: "gd-field-label", text: "Content" }), content]),
  ]);
  const submit = (event) => {
    event?.preventDefault();
    const title = name.value.trim() || `Untitled ${label.toLowerCase()}`;
    closeModal();
    void action(async () => {
      const created = await call("files.create", { name: title, mimeType, parentId, ...(content.value ? { textContent: content.value } : {}) }, key());
      await afterMutation(`${label} "${title}" created`);
      await openPreview(created.file.id);
    });
  };
  form.addEventListener("submit", submit);
  state.formOpen = true;
  openModal({
    title: `New ${label}`,
    className: "gd-dialog gd-modal",
    body: form,
    actions: [textButton("Cancel", { onClick: () => closeModal() }), filledButton("Create", { onClick: submit })],
    onClose: () => {
      state.formOpen = false;
    },
  });
  name.focus();
  name.select();
}

/** Drive's selection toolbar: replaces the filter chips while anything is selected. */
function renderSelectionBar() {
  const bar = $("#selbar");
  if (!bar) return;
  const ids = selectionIds().filter((id) => fileById(id));
  bar.hidden = ids.length === 0 || state.view.kind === "home" || state.denied;
  bar.replaceChildren();
  if (bar.hidden) return;
  const files = ids.map((id) => fileById(id));
  const one = files.length === 1 ? files[0] : undefined;
  const all = (flag) => files.every((file) => file.capabilities?.[flag]);
  const tool = (name, label, enabled, run) => {
    const button = iconButton(name, label, { class: "gd-selbar-btn", onClick: () => run() });
    if (!enabled) button.disabled = true;
    return button;
  };
  const clear = iconButton("close", "Clear selection", { class: "gd-selbar-btn", onClick: () => select(undefined) });
  bar.append(clear, el("span", { class: "gd-selbar-count", text: `${files.length} selected` }));
  if (state.view.kind === "trash") {
    bar.append(
      tool("restore", "Restore from trash", all("canUntrash"), () => void bulk(files, "restore")),
      tool("delete_forever", "Delete forever", Boolean(one) && all("canDelete"), () => one && void deleteForever(one)),
    );
    return;
  }
  bar.append(
    tool("person_add", one ? "Share" : "Share (select one item)", Boolean(one) && all("canShare"), () => void openShareDialog(one.id)),
    tool("download", "Download", all("canDownload"), () => void (async () => { for (const file of files) await download(file); })()),
    tool("drive_file_move", one ? "Move" : "Move (select one item)", Boolean(one) && all("canMoveItemWithinDrive"), () => openMoveDialog(one)),
    tool("delete_outline", "Move to trash", all("canTrash"), () => void bulk(files, "trash")),
    tool("link", one ? "Copy link" : "Copy link (select one item)", Boolean(one), () => void copyLink(one)),
  );
  const more = iconButton("more_vert", "More actions", {
    class: "gd-selbar-btn",
    attrs: { "aria-haspopup": "menu", "aria-expanded": "false" },
    onClick: () => openMenu(more, one ? rowMenu(one) : [
      { label: "Add to starred", icon: "star_border", onSelect: () => void bulk(files, "star") },
      { label: "Remove from starred", icon: "star", onSelect: () => void bulk(files, "unstar") },
      "divider",
      { label: "Move to trash", icon: "delete_outline", disabled: !all("canTrash"), onSelect: () => void bulk(files, "trash") },
    ]),
  });
  bar.append(more);
}

/** Apply one files.update to every selected item, one idempotent call each, then refresh once. */
const bulk = (files, kind) =>
  action(async () => {
    const patch = { trash: { trashed: true }, restore: { trashed: false }, star: { starred: true }, unstar: { starred: false } }[kind];
    for (const file of files) await call("files.update", { fileId: file.id, ...patch }, key());
    state.multi.clear();
    state.selectedId = undefined;
    const label = files.length === 1 ? `"${files[0].name}"` : `${files.length} items`;
    const message = { trash: `${label} moved to trash`, restore: `${label} restored`, star: `${label} added to starred`, unstar: `${label} removed from starred` }[kind];
    await afterMutation(message, kind === "trash" ? { undo: async () => {
      for (const file of files) await call("files.update", { fileId: file.id, trashed: false }, key());
      await afterMutation(`${label} restored`);
    } } : {});
    renderChrome();
  });

function openNewMenu(anchor) {
  openMenu(
    anchor,
    [
      { label: "New folder", icon: "create_new_folder", onSelect: () => openNewFolderDialog() },
      "divider",
      { label: "File upload", icon: "upload_file", onSelect: () => openUploadDialog() },
      { label: "Folder upload", icon: "drive_folder_upload", onSelect: () => notSimulated("Folder upload", "Uploading a folder from your computer needs the browser's file system. Create the folder with New folder and add files with File upload instead.") },
      "divider",
      { label: "Google Docs", iconImage: "./assets/google-docs-2026.svg", onSelect: () => openBlankDialog(DOC, "Document") },
      { label: "Google Sheets", iconImage: "./assets/google-sheets-2026.svg", onSelect: () => openBlankDialog(SHEET, "Spreadsheet") },
      { label: "Google Slides", iconImage: "./assets/google-slides-2026.svg", onSelect: () => openBlankDialog(SLIDES, "Presentation") },
      { label: "Google Forms", iconImage: "./assets/google-forms-2026.svg", onSelect: () => notSimulated("Google Forms", "Forms are not a file type this Tool models. Docs, Sheets and Slides can be created from this menu.") },
      { label: "More", icon: "", submenu: () => ["Google Drawings", "Google My Maps", "Google Sites", "Google Apps Script", "Google Jamboard"].map((label) => ({ label, onSelect: () => notSimulated(label, `${label} files are not modeled by this Tool.`) })) },
    ],
    { className: "gd-menu-new" },
  );
}

// ---------------------------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------------------------

function runSearch(text) {
  state.search = text.trim();
  if (state.search.length === 0) {
    navigate({ kind: "my-drive", folderId: "root", title: "My Drive" }, { path: [] });
    return;
  }
  closeMenus();
  state.view = { kind: "search", title: "Search results" };
  state.path = [];
  state.selectedId = undefined;
  state.nextPageToken = undefined;
  renderNav();
  renderChrome();
  void loadView();
}

function openAdvancedSearch(anchor) {
  const type = el("select", { class: "gd-select" }, [el("option", { text: "Any", attrs: { value: "" } }), ...TYPE_FILTERS.map((entry) => el("option", { text: entry.label, attrs: { value: entry.id } }))]);
  type.value = state.chips.type ?? "";
  const owner = el("select", { class: "gd-select" }, [el("option", { text: "Anyone", attrs: { value: "" } }), ...[...state.people.entries()].map(([address, name]) => el("option", { text: address === me() ? `${name} (me)` : name, attrs: { value: address } }))]);
  owner.value = state.chips.owner ?? "";
  const words = el("input", { class: "gd-input", attrs: { type: "text", value: state.search, placeholder: "Enter words found in the file" } });
  const modified = el("select", { class: "gd-select" }, [el("option", { text: "Any time", attrs: { value: "" } }), ...MODIFIED_FILTERS.map((entry) => el("option", { text: entry.label, attrs: { value: entry.id } }))]);
  modified.value = state.chips.modified ?? "";
  const form = el("form", { class: "gd-advanced" }, [
    el("h3", { class: "gd-advanced-title", text: "Advanced search" }),
    el("label", { class: "gd-field" }, [el("span", { class: "gd-field-label", text: "Type" }), type]),
    el("label", { class: "gd-field" }, [el("span", { class: "gd-field-label", text: "Owner" }), owner]),
    el("label", { class: "gd-field" }, [el("span", { class: "gd-field-label", text: "Has the words" }), words]),
    el("label", { class: "gd-field" }, [el("span", { class: "gd-field-label", text: "Date modified" }), modified]),
  ]);
  const preview = el("code", { class: "gd-advanced-q", text: "" });
  const update = () => {
    preview.textContent = buildQuery({ scope: "all", text: words.value.trim(), type: type.value || undefined, owner: owner.value || undefined, modified: modified.value || undefined, now: state.now });
  };
  for (const field of [type, owner, words, modified]) field.addEventListener("input", update);
  update();
  form.append(el("p", { class: "gd-advanced-label", text: "Drive query" }), preview);
  const search = filledButton("Search", {
    type: "submit",
    onClick: () => {
      state.chips = { type: type.value || undefined, owner: owner.value || undefined, modified: modified.value || undefined };
      const text = words.value.trim();
      $("#search").value = text;
      $("#search-clear").hidden = text.length === 0;
      closeMenus();
      if (text.length === 0 && !state.chips.type && !state.chips.owner && !state.chips.modified) navigate({ kind: "my-drive", folderId: "root", title: "My Drive" }, { path: [] });
      else {
        state.search = text;
        state.view = { kind: "search", title: "Search results" };
        state.path = [];
        state.nextPageToken = undefined;
        renderNav();
        renderChrome();
        void loadView();
      }
    },
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    search.click();
  });
  form.append(el("div", { class: "gd-advanced-actions" }, [textButton("Reset", { onClick: () => {
    type.value = "";
    owner.value = "";
    words.value = "";
    modified.value = "";
    update();
  } }), search]));
  openMenu(anchor, form, { align: "end", className: "gd-menu-advanced" });
}

// ---------------------------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------------------------

function moveSelection(delta) {
  const ids = $$("[data-id]").map((element) => element.dataset.id);
  if (ids.length === 0) return;
  const index = ids.indexOf(state.selectedId);
  const next = index === -1 ? 0 : Math.min(ids.length - 1, Math.max(0, index + delta));
  select(ids[next]);
  $(`[data-id="${CSS.escape(ids[next])}"]`)?.focus();
}

function setLayout(layout) {
  state.layout = layout;
  writePreference("layout", layout);
  $("#layout-list").setAttribute("aria-pressed", String(layout === "list"));
  $("#layout-grid").setAttribute("aria-pressed", String(layout === "grid"));
  renderContent();
}

function wire() {
  mountIcons();
  mountSidePanel();
  $("#menu-toggle").addEventListener("click", () => {
    const app = $("#app");
    if (window.matchMedia("(max-width: 768px)").matches) {
      const open = app.classList.toggle("is-drawer-open");
      $("#scrim").hidden = !open;
      $("#menu-toggle").setAttribute("aria-expanded", String(open));
      return;
    }
    const collapsed = app.classList.toggle("is-collapsed");
    $("#menu-toggle").setAttribute("aria-expanded", String(!collapsed));
  });
  $("#logo-link").addEventListener("click", (event) => {
    event.preventDefault();
    navigate({ kind: "home", title: "Home" });
  });
  $("#new-btn").addEventListener("click", (event) => openNewMenu(event.currentTarget));
  $("#layout-list").addEventListener("click", () => setLayout("list"));
  $("#layout-grid").addEventListener("click", () => setLayout("grid"));
  $("#details-toggle").addEventListener("click", () => toggleDetails());
  $("#banner-retry").addEventListener("click", () => void refreshAll());
  $("#search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    runSearch($("#search").value);
  });
  $("#search").addEventListener("input", (event) => {
    $("#search-clear").hidden = event.target.value.length === 0;
  });
  $("#search-clear").addEventListener("click", () => {
    $("#search").value = "";
    $("#search-clear").hidden = true;
    runSearch("");
  });
  $("#search-tune").addEventListener("click", (event) => openAdvancedSearch(event.currentTarget));
  const openHelp = () =>
    openModal({
      title: "About this Drive",
      className: "gd-dialog gd-modal",
      body: el("div", { class: "gd-help" }, [
        el("p", { text: "This is a synthetic Google Drive served by a Firedrill Tool package. Files, shares, storage figures and activity are world state on your machine; nothing is uploaded, downloaded from the internet, or e-mailed to anyone." }),
        el("p", { text: "Everything you do here runs the same operations an agent calls over the Drive REST routes or the MCP tool names, so the two always see the same Drive." }),
        el("dl", { class: "gd-props" }, [
          ["/", "Search in Drive"],
          ["Enter", "Open the selected item"],
          ["↑ / ↓", "Move the selection"],
          ["Esc", "Close the preview, a dialog or a menu"],
        ].map(([keys, text]) => el("div", { class: "gd-prop" }, [el("dt", { text: keys }), el("dd", { text })]))),
      ]),
      actions: [filledButton("Close", { onClick: () => closeModal() })],
    });
  $("#help-btn").addEventListener("click", (event) => openSupportMenu(event.currentTarget, { onHelp: openHelp }));
  $("#offline-btn").addEventListener("click", () => notSimulated("Ready for offline", "Offline access keeps copies of files on this device. This synthetic Drive is always local, so there is nothing to sync."));
  $("#settings-btn").addEventListener("click", (event) =>
    openSettingsMenu(event.currentTarget, {
      onKeyboard: openHelp,
      extra: [
        { label: state.detailsOpen ? "Hide details pane" : "Show details pane", icon: "info", onSelect: () => toggleDetails() },
        { label: "Refresh", icon: "refresh", onSelect: () => void refreshAll(true) },
        { label: "Storage", icon: "cloud", onSelect: () => openStorageDialog() },
      ],
    }),
  );
  $("#apps-btn").addEventListener("click", (event) =>
    openAppsLauncher(event.currentTarget, {
      initial: (myName() || "?").charAt(0).toUpperCase(),
      onDrive: () => navigate({ kind: "home", title: "Home" }),
      onCreate: (name) => (name === "Docs" ? openBlankDialog(DOC, "Document") : name === "Sheets" ? openBlankDialog(SHEET, "Spreadsheet") : openBlankDialog(SLIDES, "Presentation")),
    }),
  );
  $("#account-btn").addEventListener("click", (event) =>
    openMenu(
      event.currentTarget,
      [
        { label: myName(), hint: me(), disabled: true },
        "divider",
        { label: "Storage", icon: "cloud", onSelect: () => openStorageDialog() },
      ],
      { align: "end", header: "Google Account (synthetic)" },
    ),
  );
  $("#scrim").addEventListener("click", () => {
    $("#app").classList.remove("is-drawer-open");
    $("#scrim").hidden = true;
  });

  document.addEventListener("keydown", (event) => {
    const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(event.target?.tagName);
    if (event.key === "Escape") {
      if (!$("#preview").hidden) {
        if (previewState?.dirty) {
          void confirmDialog("Leave without saving?", "Your changes to this file have not been saved to Drive.", { okLabel: "Discard", danger: true }).then((answer) => {
            if (answer === "ok") closePreview();
          });
        } else closePreview();
      }
      return;
    }
    if (typing) return;
    if (event.key === "/") {
      event.preventDefault();
      $("#search").focus();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSelection(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(-1);
    } else if (event.key === "Enter") {
      const file = selected();
      if (file) {
        event.preventDefault();
        open(file);
      }
    } else if (event.key === "n" && event.shiftKey) {
      event.preventDefault();
      openNewFolderDialog();
    }
  });

  setLayout(state.layout);
  $("#details-toggle").setAttribute("aria-pressed", String(state.detailsOpen));
}

async function start() {
  wire();
  try {
    state.context = await getContext();
  } catch {
    /* the context call is a convenience; the operations below report the real problem */
  }
  watchWorld(
    (first) => refreshAll(first),
    () => !state.formOpen && !$("#modal").open && !$("#confirm-dialog").open && $("#preview").hidden,
    (context) => {
      state.context = context;
    },
  );
}

void start();
