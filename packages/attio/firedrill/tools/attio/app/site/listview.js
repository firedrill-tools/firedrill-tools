// List view: kanban board grouped by the list's status attribute, or a paginated entry table.
import { icon } from "./icons.js";
import { attributes, choices, loadNames, refName, resolveNames, store } from "./store.js";
import { action, button, call, closePopover, confirmDialog, describe, el, iconButton, menu, newKey, popover, readPreference, toast, writePreference } from "./ui.js";
import { recordAvatar, recordPicker, renderValues, tag } from "./values.js";
import { errorState, nsButton, pageHeader, stateBox } from "./shell.js";
import { entryTable } from "./entrytable.js";

const BOARD_CAP = 2000;

export async function renderList(main, { alive, slug }) {
  const list = store.lists.find((l) => l.api_slug === slug);
  if (!list) {
    main.replaceChildren(pageHeader([{ label: "Lists", muted: true }]), stateBox({ iconName: "lock", title: "List not found", text: "This list does not exist, or you don't have access to it. Ask a workspace admin to share it with you.", kind: "denied" }));
    return;
  }
  const me = store.self.authorized_by_workspace_member_id;
  const level = store.me?.access_level === "admin" ? "full-access" : [list.workspace_access, ...list.workspace_member_access.filter((a) => a.workspace_member_id === me).map((a) => a.level)].includes("full-access") ? "full-access" : [list.workspace_access, ...list.workspace_member_access.filter((a) => a.workspace_member_id === me).map((a) => a.level)].includes("read-and-write") ? "read-and-write" : "read-only";
  const readOnly = level === "read-only";
  const parentSlug = list.parent_object[0];
  const parentObject = store.objectsBySlug.get(parentSlug);

  const add = button(`Add ${parentObject?.singular_noun.toLowerCase() ?? "record"}`, { class: "primary", icon: "plus", disabled: readOnly, title: readOnly ? "You have read-only access to this list" : undefined });
  const crumbs = [{ label: list.name, leading: el("span", { class: "at-list-icon", attrs: { "aria-hidden": "true" } }, icon("list", "", 12)) }];
  const lock = readOnly ? el("span", { class: "at-lock-badge" }, [icon("lock", "", 12), el("span", { text: "Read only" })]) : null;
  const header = pageHeader(crumbs, [lock, nsButton("Import / Export", "CSV import and export are not simulated.", { icon: "download" }), add]);
  let mode = readPreference(`list-mode:${slug}`, "board");
  const seg = el("div", { class: "at-seg", attrs: { role: "group", "aria-label": "View layout" } });
  const body = el("div", { class: "at-table-wrap" });
  const viewbar = el("div", { class: "at-viewbar" }, [seg, el("span", { class: "grow" }), nsButton("View settings", "Saved list views are not simulated.", { icon: "settings", class: "ghost" })]);
  main.replaceChildren(header, viewbar, body);

  add.addEventListener("click", () => popover(add, recordPicker({ objects: [parentSlug], placeholder: `Search ${parentObject?.plural_noun.toLowerCase() ?? "records"}…`, onPick: (hit) => {
    closePopover();
    void action(async () => {
      await call("entries.create", { list: slug, data: { parent_record_id: hit.id.record_id, parent_object: parentSlug, entry_values: {} } }, newKey());
      toast(`Added ${hit.record_text} to ${list.name}`);
      void load();
    });
  } }), { width: 340, align: "end" }));

  let defs = [];
  let statusDef;
  async function load() {
    body.replaceChildren(el("div", { class: "at-state" }, el("span", { class: "at-hint", text: "Loading entries…" })));
    try {
      defs = (await attributes("lists", slug)).filter((d) => !d.is_archived);
      statusDef = defs.find((d) => d.type === "status");
      await loadNames();
      if (!alive()) return;
      if (!statusDef) mode = "table";
      seg.replaceChildren(...[["board", "Board", "kanban"], ["table", "Table", "table"]].map(([id, label, glyph]) => {
        const b = el("button", { attrs: { type: "button", "aria-pressed": String(mode === id), disabled: id === "board" && !statusDef, title: id === "board" && !statusDef ? "This list has no status attribute to group by" : undefined } }, [icon(glyph, "", 14), el("span", { text: label })]);
        b.addEventListener("click", () => { mode = id; writePreference(`list-mode:${slug}`, id); void load(); });
        return b;
      }));
      if (mode === "table") {
        body.className = "at-table-wrap";
        body.replaceChildren();
        const table = entryTable({ list, defs, readOnly, alive, onChanged: () => void load() });
        main.replaceChildren(header, viewbar, table.toolbar, body, table.footer);
        body.append(table.wrap);
        await table.load();
      } else {
        main.replaceChildren(header, viewbar, body);
        await drawBoard();
      }
    } catch (error) {
      if (alive()) body.replaceChildren(errorState(error, () => void load()));
    }
  }

  async function drawBoard() {
    const entries = [];
    for (let offset = 0; ; offset += 500) {
      // At the cap, one single-row read tells exactly BOARD_CAP entries apart from more than that.
      if (offset >= BOARD_CAP) {
        if ((await call("entries.query", { list: slug, limit: 1, offset })).data.length > 0) throw new Error(`This list has more than ${BOARD_CAP} entries; switch to the table view to page through them.`);
        break;
      }
      const page = (await call("entries.query", { list: slug, limit: 500, offset })).data;
      entries.push(...page);
      if (page.length < 500) break;
    }
    await resolveNames(entries);
    const statuses = await choices("lists", slug, statusDef);
    if (!alive()) return;
    const board = el("div", { class: "at-board" });
    body.className = "";
    body.style.cssText = "flex:1;min-height:0;display:flex";
    body.replaceChildren(board);
    const columns = [{ title: "No " + statusDef.title.toLowerCase(), id: null }, ...statuses.map((s) => ({ title: s.title, id: s.id.status_id }))];
    const cardDefs = defs.filter((d) => d !== statusDef).slice(0, 3);
    for (const column of columns) {
      const items = entries.filter((e) => (e.entry_values[statusDef.api_slug]?.[0]?.status?.title ?? null) === (column.id === null ? null : column.title));
      if (column.id === null && items.length === 0) continue;
      const colBody = el("div", { class: "at-col-body", attrs: { role: "list" } });
      const col = el("section", { class: "at-col", attrs: { "aria-label": `${column.title}, ${items.length} entries` } }, [
        el("div", { class: "at-col-head" }, [column.id ? tag(column.title, column.id) : el("span", { class: "at-tag grey", text: column.title }), el("span", { class: "at-col-count", text: String(items.length) }), el("span", { class: "grow" })]),
        colBody,
      ]);
      if (!readOnly && column.id) {
        col.addEventListener("dragover", (event) => { event.preventDefault(); col.classList.add("drop"); });
        col.addEventListener("dragleave", () => col.classList.remove("drop"));
        col.addEventListener("drop", (event) => { event.preventDefault(); col.classList.remove("drop"); const id = event.dataTransfer.getData("text/plain"); const entry = entries.find((e) => e.id.entry_id === id); if (entry) moveEntry(entry, column.title); });
      }
      for (const entry of items) colBody.append(card(entry, cardDefs, columns));
      if (items.length === 0) colBody.append(el("div", { class: "at-hint pad", text: "No entries" }));
      if (!readOnly) {
        const addHere = el("button", { class: "at-col-add", attrs: { type: "button" } }, [icon("plus", "", 14), el("span", { text: "Add" })]);
        addHere.addEventListener("click", () => add.click());
        col.append(addHere);
      }
      board.append(col);
    }
    if (entries.length === 0) body.replaceChildren(stateBox({ iconName: "list", title: "This list is empty", text: `Add ${parentObject?.plural_noun.toLowerCase() ?? "records"} to start tracking them in ${list.name}.` }));
  }

  function card(entry, cardDefs, columns) {
    const name = refName(entry.parent_record_id);
    const node = el("div", { class: "at-kcard", attrs: { role: "listitem", draggable: readOnly ? undefined : "true", tabindex: "0", "aria-label": name } });
    const open = el("a", { class: "at-primary-link", text: name, attrs: { href: `#/${entry.parent_object}/${entry.parent_record_id}` } });
    const more = iconButton("more", `Actions for ${name}`, () => menu(more, [
      { header: "Move to" },
      ...columns.filter((c) => c.id).map((c) => ({ label: c.title, checked: entry.entry_values[statusDef.api_slug]?.[0]?.status?.title === c.title, disabled: readOnly, onSelect: () => moveEntry(entry, c.title) })),
      "divider",
      { label: "Remove from list", icon: "trash", danger: true, disabled: readOnly, onSelect: () => removeEntry(entry, name) },
    ], { align: "end" }), "small");
    node.append(el("div", { class: "at-kcard-title" }, [recordAvatar(entry.parent_object, name, entry.parent_record_id, "tiny"), open, el("span", { class: "grow" }), more]));
    node.querySelector(".grow").style.flex = "1";
    for (const d of cardDefs) {
      const values = entry.entry_values[d.api_slug];
      if (!values?.length) continue;
      node.append(el("div", { class: "at-kcard-row", title: d.title }, renderValues(d, values, "card")));
    }
    node.addEventListener("dragstart", (event) => { event.dataTransfer.setData("text/plain", entry.id.entry_id); node.classList.add("dragging"); });
    node.addEventListener("dragend", () => node.classList.remove("dragging"));
    node.addEventListener("keydown", (event) => { if (event.key === "Enter" && event.target === node) location.hash = open.getAttribute("href"); });
    return node;
  }

  function moveEntry(entry, title) {
    void action(async () => {
      await call("entries.update", { list: slug, entry_id: entry.id.entry_id, mode: "overwrite", data: { entry_values: { [statusDef.api_slug]: [title] } } }, newKey());
      toast(`Moved to ${title}`);
      void load();
    });
  }

  async function removeEntry(entry, name) {
    if (!(await confirmDialog("Remove from list?", `${name} will be removed from ${list.name}. The record itself is kept.`, "Remove"))) return;
    await action(async () => { await call("entries.delete", { list: slug, entry_id: entry.id.entry_id }, newKey()); toast(`Removed ${name}`); void load(); });
  }

  await load();
  return {};
}

export { describe };
