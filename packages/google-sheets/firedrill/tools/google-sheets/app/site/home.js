// Sheets home: "Start a new spreadsheet" strip and the recent-spreadsheets list/grid, backed by the Drive v3
// files.list / files.update / files.copy / files.delete operations and Sheets spreadsheets.create.
import { icon } from "./icons.js";
import { notSimulated } from "./unsupported.js";
import {
  $,
  action,
  avatar,
  call,
  closeMenus,
  confirmDialog,
  describe,
  el,
  iconButton,
  listDate,
  newKey,
  openMenu,
  openModal,
  readPreference,
  recencyGroup,
  toast,
  ToolError,
  writePreference,
} from "./ui.js";

const PAGE_SIZE = 20;
const LOGO = "./assets/google-sheets-2026.svg";

const VIEWS = [
  { id: "recent", label: "Recent", icon: "history", title: "Recent spreadsheets" },
  { id: "starred", label: "Starred", icon: "star_border", title: "Starred" },
  { id: "shared", label: "Shared with me", icon: "people", title: "Shared with me" },
  { id: "trash", label: "Trash", icon: "delete", title: "Trash" },
];
const OWNERS = [
  { id: "anyone", label: "Owned by anyone" },
  { id: "me", label: "Owned by me" },
  { id: "not-me", label: "Not owned by me" },
];
const SORTS = [
  { id: "viewedByMeTime", label: "Last opened by me", order: "viewedByMeTime desc", dateField: "viewedByMeTime", verb: "Opened" },
  { id: "modifiedTime", label: "Last modified", order: "modifiedTime desc", dateField: "modifiedTime", verb: "Modified" },
  { id: "name", label: "Title", order: "name", dateField: "modifiedTime", verb: "Modified" },
];

export function createHome(app) {
  const state = {
    view: "recent",
    owner: "anyone",
    sort: readPreference("sort", "viewedByMeTime"),
    layout: readPreference("layout", "list"),
    search: "",
    files: [],
    nextPageToken: undefined,
    loading: false,
    error: undefined,
    generation: 0,
  };
  const sortDef = () => SORTS.find((sort) => sort.id === state.sort) ?? SORTS[0];
  const me = () => app.about?.user?.emailAddress ?? "";
  const quote = (text) => `'${String(text).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

  /** Compile the visible filters into the Drive `q` this Tool understands. */
  function buildQuery() {
    const parts = [];
    if (state.view === "trash") parts.push("trashed = true");
    else parts.push("trashed = false");
    if (state.view === "starred") parts.push("starred = true");
    if (state.view === "shared") parts.push("sharedWithMe = true");
    if (state.owner === "me" && me()) parts.push(`${quote(me())} in owners`);
    if (state.owner === "not-me" && me()) parts.push(`not ${quote(me())} in owners`);
    if (state.search.trim()) parts.push(`name contains ${quote(state.search.trim())}`);
    return parts.join(" and ");
  }

  function orderBy() {
    // "Last opened by me" ranks never-opened files after opened ones; Drive sorts empty times last in descending order.
    return state.view === "trash" ? "modifiedTime desc" : sortDef().order;
  }

  // -------------------------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------------------------

  async function load({ append = false } = {}) {
    const generation = ++state.generation;
    if (!append) {
      state.files = [];
      state.nextPageToken = undefined;
    }
    state.loading = true;
    state.error = undefined;
    render();
    try {
      const result = await call("files.list", {
        q: buildQuery(),
        orderBy: orderBy(),
        pageSize: PAGE_SIZE,
        ...(append && state.nextPageToken ? { pageToken: state.nextPageToken } : {}),
      });
      if (generation !== state.generation) return;
      state.files = append ? [...state.files, ...result.files] : result.files;
      state.nextPageToken = result.nextPageToken;
    } catch (error) {
      if (generation !== state.generation) return;
      if (error instanceof ToolError && error.denied) {
        app.showDenied();
        return;
      }
      state.error = error;
    } finally {
      if (generation === state.generation) {
        state.loading = false;
        render();
      }
    }
  }

  /** Background refresh after the world changed: reload as many rows as are on screen. */
  async function refresh() {
    const generation = ++state.generation;
    const wanted = Math.max(PAGE_SIZE, state.files.length);
    try {
      let files = [];
      let token;
      do {
        const result = await call("files.list", { q: buildQuery(), orderBy: orderBy(), pageSize: PAGE_SIZE, ...(token ? { pageToken: token } : {}) });
        files = files.concat(result.files);
        token = result.nextPageToken;
      } while (token && files.length < wanted);
      if (generation !== state.generation) return;
      state.files = files;
      state.nextPageToken = token;
      state.error = undefined;
    } catch (error) {
      if (generation !== state.generation) return;
      state.error = error;
    }
    render();
  }

  // -------------------------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------------------------

  function renderChrome() {
    const view = VIEWS.find((item) => item.id === state.view);
    $("#docs-title").textContent = state.search.trim() ? `Results for “${state.search.trim()}”` : view.title;
    $("#templates").hidden = state.view !== "recent" || Boolean(state.search.trim());
    $("#owner-label").textContent = OWNERS.find((owner) => owner.id === state.owner).label;
    const list = state.layout === "list";
    const layoutButton = $("#layout-btn");
    layoutButton.replaceChildren(icon(list ? "grid_view" : "view_list"));
    layoutButton.title = list ? "Grid view" : "List view";
    layoutButton.setAttribute("aria-label", layoutButton.title);
    $("#sort-btn").hidden = state.view === "trash";
    const hint = $("#query-hint");
    hint.hidden = !state.search.trim();
    hint.replaceChildren(el("span", { text: "Drive query " }), el("code", { text: buildQuery() }));
    $("#search-clear").hidden = !$("#search-input").value;
    const items = $("#drawer-items");
    items.replaceChildren(
      ...VIEWS.map((item) => {
        const link = el("button", { class: `drawer-item ${item.id === state.view ? "active" : ""}`, attrs: { type: "button", "aria-current": item.id === state.view ? "page" : undefined } }, [icon(item.icon), el("span", { text: item.label })]);
        link.addEventListener("click", () => {
          closeDrawer();
          setView(item.id);
        });
        return link;
      }),
    );
  }

  function render() {
    renderChrome();
    const banner = $("#home-banner");
    banner.hidden = !state.error;
    if (state.error) $("#home-banner-text").textContent = describe(state.error);
    const host = $("#docs");
    host.className = `docs-list ${state.layout}`;
    host.setAttribute("aria-busy", String(state.loading));
    $("#docs-more").hidden = !state.nextPageToken && !(state.loading && state.files.length > 0);
    $("#load-more").hidden = state.loading;
    $(".docs-more .spinner").hidden = !state.loading;

    if (state.loading && state.files.length === 0) {
      host.replaceChildren(...Array.from({ length: 6 }, () => el("div", { class: "skeleton-row" }, [el("span"), el("span"), el("span")])));
      return;
    }
    if (state.files.length === 0) {
      if (state.error) {
        host.replaceChildren();
        return;
      }
      host.replaceChildren(emptyState());
      return;
    }
    const nodes = [];
    if (state.layout === "list") {
      nodes.push(
        el("div", { class: "list-head", attrs: { "aria-hidden": "true" } }, [
          el("span", { class: "col-name", text: "" }),
          el("span", { class: "col-owner", text: "Owner" }),
          el("span", { class: "col-date", text: state.view === "trash" ? "Date trashed" : sortDef().label }),
          el("span", { class: "col-menu" }),
        ]),
      );
    }
    const grouped = state.view !== "trash" && state.sort !== "name" && !state.search.trim();
    let lastGroup;
    const gridRow = () => el("div", { class: "card-grid" });
    let currentGrid;
    for (const file of state.files) {
      if (grouped) {
        const group = recencyGroup(file[sortDef().dateField] ?? file.modifiedTime, app.nowMs());
        if (group !== lastGroup) {
          lastGroup = group;
          nodes.push(el("h3", { class: "group-label", text: group }));
          currentGrid = undefined;
        }
      }
      if (state.layout === "list") nodes.push(listRow(file));
      else {
        if (!currentGrid) {
          currentGrid = gridRow();
          nodes.push(currentGrid);
        }
        currentGrid.append(card(file));
      }
    }
    host.replaceChildren(...nodes);
  }

  function emptyState() {
    const search = state.search.trim();
    const text = search
      ? ["No results", "Try a different word, or check the spelling."]
      : state.view === "trash"
        ? ["Trash is empty", "Spreadsheets you move to the trash appear here."]
        : state.view === "starred"
          ? ["No starred spreadsheets", "Add stars to spreadsheets you want to find easily later."]
          : state.view === "shared"
            ? ["No spreadsheets shared with you", "Spreadsheets that others share with you appear here."]
            : state.owner !== "anyone"
              ? ["No spreadsheets match this filter", "Change the owner filter to see more."]
              : ["No spreadsheets yet", "Click + to create a new spreadsheet."];
    return el("div", { class: "empty" }, [el("img", { attrs: { src: LOGO, alt: "", width: 72, height: 52 } }), el("h3", { text: text[0] }), el("p", { text: text[1] })]);
  }

  const ownerLabel = (file) => (file.ownedByMe ? "me" : (file.owners?.[0]?.displayName ?? file.owners?.[0]?.emailAddress ?? "—"));
  const dateLabel = (file) => {
    if (state.view === "trash") return listDate(file.trashedTime ?? file.modifiedTime, app.nowMs());
    const value = file[sortDef().dateField];
    if (value === undefined && sortDef().dateField === "viewedByMeTime") return "Never opened";
    return listDate(value ?? file.modifiedTime, app.nowMs());
  };

  function open(file) {
    if (file.trashed) {
      toast("This spreadsheet is in the trash. Restore it to open it.", { actionLabel: "Restore", onAction: () => setTrashed(file, false) });
      return;
    }
    app.openSpreadsheet(file.id);
  }

  function listRow(file) {
    const row = el("div", { class: "doc-row", attrs: { role: "link", tabindex: 0, "aria-label": `${file.name}, owner ${ownerLabel(file)}, ${dateLabel(file)}` } });
    const name = el("div", { class: "col-name" }, [
      el("img", { class: "doc-icon", attrs: { src: LOGO, alt: "", width: 20, height: 15 } }),
      el("span", { class: "doc-name", text: file.name, title: file.name }),
    ]);
    if (file.shared) name.append(el("span", { class: "doc-shared", title: "Shared" }, [icon("people")]));
    if (file.starred) name.append(el("span", { class: "doc-starred", title: "Starred" }, [icon("star")]));
    row.append(
      name,
      el("div", { class: "col-owner", text: ownerLabel(file) }),
      el("div", { class: "col-date", text: dateLabel(file), title: file[sortDef().dateField] ?? file.modifiedTime }),
    );
    const more = iconButton("more_vert", "More actions", { className: "col-menu", attrs: { "aria-haspopup": "menu" } });
    more.addEventListener("click", (event) => {
      event.stopPropagation();
      openRowMenu(more, file);
    });
    row.append(more);
    row.addEventListener("click", () => open(file));
    row.addEventListener("keydown", (event) => {
      if (event.target !== row) return;
      if (event.key === "Enter") open(file);
      if (event.key === "ArrowDown") row.nextElementSibling?.focus?.();
      if (event.key === "ArrowUp") row.previousElementSibling?.focus?.();
    });
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openRowMenu(more, file, { x: event.clientX, y: event.clientY });
    });
    return row;
  }

  function card(file) {
    const thumb = el("div", { class: "card-thumb", attrs: { "aria-hidden": "true" } });
    const item = el("div", { class: "card", attrs: { role: "link", tabindex: 0, "aria-label": `${file.name}, ${dateLabel(file)}` } }, [
      thumb,
      el("div", { class: "card-info" }, [
        el("div", { class: "card-title", text: file.name, title: file.name }),
        el("div", { class: "card-meta" }, [
          el("img", { attrs: { src: LOGO, alt: "", width: 16, height: 12 } }),
          file.shared ? el("span", { class: "doc-shared" }, [icon("people")]) : null,
          el("span", { class: "card-date", text: `${state.view === "trash" ? "Trashed" : sortDef().verb} ${dateLabel(file)}` }),
        ]),
      ]),
    ]);
    const more = iconButton("more_vert", "More actions", { className: "card-menu", attrs: { "aria-haspopup": "menu" } });
    more.addEventListener("click", (event) => {
      event.stopPropagation();
      openRowMenu(more, file);
    });
    item.querySelector(".card-meta").append(more);
    item.addEventListener("click", () => open(file));
    item.addEventListener("keydown", (event) => {
      if (event.target === item && event.key === "Enter") open(file);
    });
    void fillThumbnail(thumb, file);
    return item;
  }

  /** Grid-view thumbnail: the first rows of the first sheet, read with values.get (FORMATTED_VALUE). */
  async function fillThumbnail(thumb, file) {
    if (file.trashed) {
      thumb.classList.add("empty-thumb");
      return;
    }
    try {
      const range = await call("values.get", { spreadsheetId: file.id, range: "A1:F18" });
      const table = el("div", { class: "mini-grid" });
      const rows = range.values ?? [];
      for (let r = 0; r < 18; r += 1) {
        const line = el("div", { class: "mini-row" });
        for (let c = 0; c < 6; c += 1) line.append(el("span", { text: String(rows[r]?.[c] ?? "") }));
        table.append(line);
      }
      thumb.replaceChildren(table);
    } catch {
      thumb.classList.add("empty-thumb");
    }
  }

  // -------------------------------------------------------------------------------------------
  // Row actions
  // -------------------------------------------------------------------------------------------

  function openRowMenu(anchor, file, point) {
    const caps = file.capabilities ?? {};
    const items = file.trashed
      ? [
          { label: "Restore", icon: "restore", disabled: !caps.canUntrash, title: "Only the owner can restore this spreadsheet", onSelect: () => setTrashed(file, false) },
          { label: "Delete forever", icon: "delete", disabled: !caps.canDelete, title: "Only the owner can delete this spreadsheet", onSelect: () => deleteForever(file) },
        ]
      : [
          { label: "Rename", icon: "edit", disabled: !caps.canRename, title: "You need edit access to rename", onSelect: () => rename(file) },
          { label: file.starred ? "Remove from starred" : "Add to starred", icon: file.starred ? "star" : "star_border", onSelect: () => setStarred(file, !file.starred) },
          { label: "Make a copy", icon: "content_copy", disabled: !caps.canCopy, onSelect: () => copy(file) },
          { label: "Remove", icon: "delete", disabled: !caps.canTrash, title: "Only the owner can move this spreadsheet to the trash", onSelect: () => setTrashed(file, true) },
          "divider",
          { label: "Open in new tab", icon: "open_in_new", onSelect: () => window.open(`${location.pathname}#d/${encodeURIComponent(file.id)}`, "_blank", "noopener") },
        ];
    openMenu(anchor, items, { point, align: "end" });
  }

  function rename(file) {
    const input = el("input", { class: "text-field", attrs: { type: "text", value: file.name, "aria-label": "New name", maxlength: 255 } });
    const ok = el("button", { class: "filled-btn", text: "OK", attrs: { type: "button" } });
    const cancel = el("button", { class: "text-btn", text: "Cancel", attrs: { type: "button" } });
    const key = newKey();
    const modal = openModal({ title: "Rename", body: el("div", {}, [el("p", { class: "dialog-sub", text: "Please enter a new name for the item:" }), input]), actions: [cancel, ok], onClose: () => app.formClosed() });
    app.formOpened();
    input.select();
    cancel.addEventListener("click", modal.close);
    const submit = () =>
      action(async () => {
        const name = input.value.trim();
        if (!name) return;
        if (name === file.name) return modal.close();
        ok.disabled = true;
        try {
          await call("files.update", { fileId: file.id, name }, key);
          modal.close();
          toast(`Renamed to “${name}”`);
          await refresh();
        } finally {
          ok.disabled = false;
        }
      });
    ok.addEventListener("click", submit);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") submit();
    });
  }

  const setStarred = (file, starred) =>
    action(async () => {
      await call("files.update", { fileId: file.id, starred }, newKey());
      toast(starred ? "Added to starred" : "Removed from starred");
      await refresh();
    });

  const setTrashed = (file, trashed) =>
    action(async () => {
      await call("files.update", { fileId: file.id, trashed }, newKey());
      if (trashed) toast(`“${file.name}” was moved to the trash.`, { actionLabel: "Undo", onAction: async () => { await call("files.update", { fileId: file.id, trashed: false }, newKey()); await refresh(); } });
      else toast(`“${file.name}” was restored.`);
      await refresh();
    });

  async function deleteForever(file) {
    const confirmed = await confirmDialog("Delete forever?", `“${file.name}” will be deleted forever and you won't be able to restore it.`, { okLabel: "Delete forever", danger: true });
    if (!confirmed) return;
    await action(async () => {
      await call("files.delete", { fileId: file.id }, newKey());
      toast("Spreadsheet deleted forever");
      await refresh();
    });
  }

  function copy(file) {
    const input = el("input", { class: "text-field", attrs: { type: "text", value: `Copy of ${file.name}`, "aria-label": "Name", maxlength: 255 } });
    const ok = el("button", { class: "filled-btn", text: "Make a copy", attrs: { type: "button" } });
    const cancel = el("button", { class: "text-btn", text: "Cancel", attrs: { type: "button" } });
    const key = newKey();
    const modal = openModal({ title: "Copy document", body: el("div", {}, [el("label", { class: "field-label", text: "Name", attrs: { for: "copy-name" } }), input]), actions: [cancel, ok], onClose: () => app.formClosed() });
    input.id = "copy-name";
    app.formOpened();
    input.select();
    cancel.addEventListener("click", modal.close);
    ok.addEventListener("click", () =>
      action(async () => {
        const name = input.value.trim();
        if (!name) return;
        ok.disabled = true;
        try {
          const created = await call("files.copy", { fileId: file.id, name }, key);
          modal.close();
          toast(`Created “${created.name}”`, { actionLabel: "Open", onAction: () => app.openSpreadsheet(created.id) });
          await refresh();
        } finally {
          ok.disabled = false;
        }
      }),
    );
  }

  const createBlank = () =>
    action(async () => {
      const created = await call("spreadsheets.create", { properties: { title: "Untitled spreadsheet" } }, newKey());
      app.openSpreadsheet(created.spreadsheetId);
    });

  // -------------------------------------------------------------------------------------------
  // Chrome wiring
  // -------------------------------------------------------------------------------------------

  function setView(view) {
    state.view = view;
    state.search = "";
    $("#search-input").value = "";
    void load();
  }

  function openDrawer() {
    $("#drawer").hidden = false;
    $("#scrim").hidden = false;
    $("#drawer-toggle").setAttribute("aria-expanded", "true");
    $("#drawer .drawer-item")?.focus();
  }
  function closeDrawer() {
    $("#drawer").hidden = true;
    $("#scrim").hidden = true;
    $("#drawer-toggle").setAttribute("aria-expanded", "false");
  }

  function openFilePicker() {
    const list = el("div", { class: "picker-list" });
    const search = el("input", { class: "text-field", attrs: { type: "text", placeholder: "Search", "aria-label": "Search spreadsheets" } });
    let token;
    let query = "trashed = false";
    const more = el("button", { class: "text-btn", text: "Load more", attrs: { type: "button" } });
    const loadPage = async (reset) => {
      if (reset) {
        list.replaceChildren(el("div", { class: "picker-empty", text: "Loading…" }));
        token = undefined;
      }
      try {
        const result = await call("files.list", { q: query, orderBy: "name", pageSize: PAGE_SIZE, ...(token ? { pageToken: token } : {}) });
        if (reset) list.replaceChildren();
        for (const file of result.files) {
          const row = el("button", { class: "picker-row", attrs: { type: "button" } }, [
            el("img", { attrs: { src: LOGO, alt: "", width: 20, height: 15 } }),
            el("span", { class: "picker-name", text: file.name }),
            el("span", { class: "picker-owner", text: ownerLabel(file) }),
            el("span", { class: "picker-date", text: listDate(file.modifiedTime, app.nowMs()) }),
          ]);
          row.addEventListener("click", () => {
            modal.close();
            app.openSpreadsheet(file.id);
          });
          list.append(row);
        }
        if (list.childElementCount === 0) list.append(el("div", { class: "picker-empty", text: "No spreadsheets found" }));
        token = result.nextPageToken;
        more.hidden = !token;
      } catch (error) {
        list.replaceChildren(el("div", { class: "picker-empty error", text: describe(error) }));
      }
    };
    search.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      query = search.value.trim() ? `trashed = false and name contains ${quote(search.value.trim())}` : "trashed = false";
      void loadPage(true);
    });
    more.addEventListener("click", () => void loadPage(false));
    const modal = openModal({ title: "Open a file", className: "picker", body: el("div", {}, [search, list, more]), actions: [el("button", { class: "text-btn", text: "Cancel", attrs: { type: "button" } })] });
    modal.dialog.querySelector(".dialog-actions .text-btn").addEventListener("click", modal.close);
    void loadPage(true);
  }

  $("#drawer-toggle").addEventListener("click", () => ($("#drawer").hidden ? openDrawer() : closeDrawer()));
  $("#scrim").addEventListener("click", closeDrawer);
  for (const entry of document.querySelectorAll("#drawer [data-app]")) {
    entry.title = entry.dataset.app;
    entry.addEventListener("click", () => {
      closeDrawer();
      notSimulated(entry.dataset.app);
    });
  }
  $("#drawer-sheets").addEventListener("click", () => {
    closeDrawer();
    setView("recent");
  });
  $("#drawer").addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeDrawer();
  });
  $("#home-logo").addEventListener("click", (event) => {
    event.preventDefault();
    setView("recent");
  });
  $("#new-blank").addEventListener("click", createBlank);
  $("#gallery-btn").addEventListener("click", () => notSimulated("Template gallery", "Only Blank spreadsheet is available; templates are not modelled by this Tool."));
  $("#templates-more").addEventListener("click", (event) => openMenu(event.currentTarget, [{ label: "Hide templates", onSelect: () => notSimulated("Hide templates") }], { align: "end" }));
  $("#home-retry").addEventListener("click", () => void load());
  $("#load-more").addEventListener("click", () => void load({ append: true }));
  $("#picker-btn").addEventListener("click", openFilePicker);
  $("#search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    state.search = $("#search-input").value;
    void load();
  });
  $("#search-input").addEventListener("input", () => ($("#search-clear").hidden = !$("#search-input").value));
  $("#search-clear").addEventListener("click", () => {
    $("#search-input").value = "";
    state.search = "";
    void load();
  });
  $("#owner-btn").addEventListener("click", (event) => {
    openMenu(
      event.currentTarget,
      OWNERS.map((owner) => ({
        label: owner.label,
        checked: owner.id === state.owner,
        onSelect: () => {
          state.owner = owner.id;
          void load();
        },
      })),
    );
  });
  $("#sort-btn").addEventListener("click", (event) => {
    openMenu(
      event.currentTarget,
      [
        { heading: "Sort options" },
        ...SORTS.map((sort) => ({
          label: sort.label,
          checked: sort.id === state.sort,
          onSelect: () => {
            state.sort = sort.id;
            writePreference("sort", sort.id);
            void load();
          },
        })),
      ],
      { align: "end" },
    );
  });
  $("#layout-btn").addEventListener("click", () => {
    state.layout = state.layout === "list" ? "grid" : "list";
    writePreference("layout", state.layout);
    render();
  });
  $("#apps-btn").addEventListener("click", (event) => {
    openMenu(event.currentTarget, [{ label: "Sheets", icon: "sheet", onSelect: () => setView("recent") }, { label: "Other Google apps are not part of this simulated service", disabled: true }], { align: "end" });
  });
  const accountMenu = (event) => {
    const user = app.about?.user;
    openMenu(event.currentTarget, [{ heading: user ? `${user.displayName} · ${user.emailAddress}` : "Signed out" }, { label: `Firedrill actor: ${app.context?.actorId ?? "unknown"}`, disabled: true }], { align: "end" });
  };
  $("#account-btn").addEventListener("click", accountMenu);
  document.addEventListener("keydown", (event) => {
    if ($("#home").hidden) return;
    if (event.key === "/" && document.activeElement?.tagName !== "INPUT") {
      event.preventDefault();
      $("#search-input").focus();
    }
  });

  return {
    show() {
      closeMenus();
      void load();
    },
    refresh,
    accountMenu,
  };
}
