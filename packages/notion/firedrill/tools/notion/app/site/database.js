// Database views: the product's Table and Board views over a data source, with a filter builder and sort menu
// that compose real data-sources.query requests, inline cell editing (pages.update), row creation
// (pages.create), schema changes (data-sources.update) and the side peek for rows.
import { closePeek, emptyState, openPeek, skeleton } from "./chrome.js";
import { openPropertyEditor } from "./editors.js";
import { icon, propertyIcon } from "./icons.js";
import { OPTION_COLORS, checkbox, emojiOf, objectIcon, pill, plain, propertyValue, textToRich } from "./rich.js";
import { canWrite, loadIndex, lookup, navigate, pageTitle, state } from "./state.js";
import { $, action, call, closePopovers, confirmDialog, describe, el, iconButton, key, openPopover, notSimulated, snackbar, textButton, ToolError, unsimulatedButton } from "./ui.js";

const PAGE_SIZE = 50;
const COMPUTED = ["created_time", "created_by", "last_edited_time", "last_edited_by"];
const orderedDefinitions = (definitions) => [...definitions.filter((definition) => !COMPUTED.includes(definition.type)), ...definitions.filter((definition) => COMPUTED.includes(definition.type))];
const CONDITIONS = {
  text: [["contains", "Contains"], ["does_not_contain", "Does not contain"], ["equals", "Is"], ["does_not_equal", "Is not"], ["starts_with", "Starts with"], ["is_empty", "Is empty"], ["is_not_empty", "Is not empty"]],
  number: [["equals", "="], ["does_not_equal", "≠"], ["greater_than", ">"], ["less_than", "<"], ["greater_than_or_equal_to", "≥"], ["less_than_or_equal_to", "≤"], ["is_empty", "Is empty"], ["is_not_empty", "Is not empty"]],
  option: [["equals", "Is"], ["does_not_equal", "Is not"], ["is_empty", "Is empty"], ["is_not_empty", "Is not empty"]],
  list: [["contains", "Contains"], ["does_not_contain", "Does not contain"], ["is_empty", "Is empty"], ["is_not_empty", "Is not empty"]],
  checkbox: [["equals", "Is"]],
  date: [["equals", "Is"], ["before", "Is before"], ["after", "Is after"], ["on_or_before", "Is on or before"], ["on_or_after", "Is on or after"], ["this_week", "This week"], ["past_week", "Past week"], ["past_month", "Past month"], ["next_week", "Next week"], ["next_month", "Next month"], ["is_empty", "Is empty"], ["is_not_empty", "Is not empty"]],
};
const NO_VALUE = new Set(["is_empty", "is_not_empty", "this_week", "past_week", "past_month", "past_year", "next_week", "next_month", "next_year"]);

// Per-database view settings for this viewer (filters, sorts, search); never authority over records.
const settings = new Map();
function settingsFor(id) {
  if (!settings.has(id)) settings.set(id, { filters: [], sort: undefined, search: "" });
  return settings.get(id);
}

function conditionKind(type) {
  if (["title", "rich_text", "url", "email", "phone_number"].includes(type)) return "text";
  if (type === "number") return "number";
  if (type === "select" || type === "status") return "option";
  if (["multi_select", "people", "relation"].includes(type)) return "list";
  if (type === "checkbox") return "checkbox";
  if (["date", "created_time", "last_edited_time"].includes(type)) return "date";
  return undefined;
}

/** Notion filter object from the viewer's filter rows and search text. */
function buildFilter(schema, setting) {
  const conditions = [];
  for (const filter of setting.filters) {
    const definition = schema[filter.property];
    if (!definition) continue;
    const type = definition.type;
    let clause;
    if (NO_VALUE.has(filter.condition)) clause = { [filter.condition]: true };
    else if (conditionKind(type) === "checkbox") clause = { equals: filter.value === "true" };
    else if (conditionKind(type) === "number") {
      if (filter.value === "" || Number.isNaN(Number(filter.value))) continue;
      clause = { [filter.condition]: Number(filter.value) };
    } else {
      if (!filter.value) continue;
      clause = { [filter.condition]: filter.value };
    }
    conditions.push({ property: definition.name, [type]: clause });
  }
  if (setting.search.trim().length > 0) {
    const title = Object.values(schema).find((definition) => definition.type === "title");
    if (title) conditions.push({ property: title.name, title: { contains: setting.search.trim() } });
  }
  if (conditions.length === 0) return undefined;
  return conditions.length === 1 ? conditions[0] : { and: conditions };
}

function buildSorts(schema, setting) {
  if (!setting.sort) return undefined;
  const definition = schema[setting.sort.property];
  if (!definition) return undefined;
  return [{ property: definition.name, direction: setting.sort.direction }];
}

// ---------------------------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------------------------

/** Full-page database view (route #/database/<id>/<view>). */
export function renderDatabaseView(host, databaseId, options = {}) {
  const view = { databaseId, mode: options.view ?? "table", inline: false, database: undefined, source: undefined, rows: [], cursor: null, more: false, error: undefined, queryError: undefined, loading: true, onChanged: options.onChanged, onLoaded: options.onLoaded };
  host.replaceChildren(el("div", { class: "page-shell" }, skeleton(8)));
  view.refresh = () => load(host, view);
  view.setMode = (mode) => { view.mode = mode; render(host, view); };
  void view.refresh();
  return view;
}

/** Inline database (child_database block with is_inline) rendered inside a page; returns the element. */
export function renderInlineDatabase(databaseId, options = {}) {
  const host = el("div", { class: "inline-db-host" }, skeleton(3));
  const view = { databaseId, mode: "table", inline: true, database: undefined, source: undefined, rows: [], cursor: null, more: false, error: undefined, queryError: undefined, loading: true, onChanged: options.onChanged };
  view.refresh = () => load(host, view);
  view.setMode = (mode) => { view.mode = mode; render(host, view); };
  void view.refresh();
  return host;
}

async function load(host, view) {
  try {
    view.database = await call("databases.retrieve", { database_id: view.databaseId });
    const sourceId = view.database.data_sources[0]?.id;
    view.source = await call("data-sources.retrieve", { data_source_id: sourceId });
    view.error = undefined;
    await query(view, false);
  } catch (error) {
    view.error = error;
  }
  view.loading = false;
  render(host, view);
  view.onLoaded?.(view);
}

async function query(view, append) {
  const setting = settingsFor(view.databaseId);
  const request = { data_source_id: view.source.id, page_size: PAGE_SIZE };
  const filter = buildFilter(view.source.properties, setting);
  const sorts = buildSorts(view.source.properties, setting);
  if (filter) request.filter = filter;
  if (sorts) request.sorts = sorts;
  if (append && view.cursor) request.start_cursor = view.cursor;
  try {
    const result = await call("data-sources.query", request);
    view.rows = append ? [...view.rows, ...result.results] : result.results;
    view.cursor = result.next_cursor;
    view.more = result.has_more;
    view.queryError = undefined;
  } catch (error) {
    view.queryError = error;
    if (!append) view.rows = [];
  }
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

function render(host, view) {
  host.replaceChildren();
  if (view.error) {
    const error = view.error;
    const denied = error instanceof ToolError && (error.denied || error.is("RESTRICTED_RESOURCE"));
    host.append(el("div", { class: "page-shell" }, el("div", { class: "page-content" }, emptyState(denied ? "You don't have access to this database" : "This content doesn't exist or you don't have access.", describe(error), [textButton("Go to Home", { onClick: () => navigate({ name: "home" }) })]))));
    return;
  }
  const shell = el("div", { class: `page-shell ${view.inline ? "inline" : "database-page"}`.trim() });
  const content = el("div", { class: "page-content wide" });
  content.append(databaseHeader(view, host));
  content.append(viewToolbar(view, host));
  const setting = settingsFor(view.databaseId);
  if (setting.filters.length > 0 || setting.sort) content.append(filterBar(view, host));
  if (view.queryError) content.append(el("div", { class: "query-error" }, [icon("warning"), el("span", { text: describe(view.queryError) }), textButton("Retry", { onClick: () => action(async () => { await query(view, false); render(host, view); }) })]));
  else if (view.mode === "board") content.append(boardView(view, host));
  else content.append(tableView(view, host));
  shell.append(content);
  host.append(shell);
}

function databaseHeader(view, host) {
  const database = view.database;
  const header = el("div", { class: `db-header ${view.inline ? "inline" : ""}`.trim() });
  const title = plain(database.title) || "Untitled";
  const emoji = emojiOf(database.icon);
  const heading = el(view.inline ? "h2" : "h1", { class: `db-title ${view.inline ? "inline" : "page-title"}`.trim() });
  if (emoji !== undefined) heading.append(el("span", { class: view.inline ? "db-inline-icon" : "page-emoji", text: emoji }));
  const text = el("span", { class: "db-title-text", text: title, attrs: { "aria-label": "Database title" } });
  if (canWrite() && !database.in_trash) {
    text.setAttribute("contenteditable", "plaintext-only");
    text.setAttribute("spellcheck", "false");
    text.addEventListener("blur", () => {
      const next = text.textContent.trim();
      if (next === title || next.length === 0) { text.textContent = title; return; }
      void action(async () => {
        await call("data-sources.update", { data_source_id: view.source.id, title: textToRich(next) }, key());
        await loadIndex();
        await view.refresh();
        view.onChanged?.();
      });
    });
    text.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); text.blur(); } });
  }
  heading.append(text);
  header.append(heading);
  const description = plain(database.description);
  if (description) header.append(el("p", { class: "db-description", text: description }));
  return header;
}

function viewToolbar(view, host) {
  const bar = el("div", { class: "view-toolbar" });
  const tabs = el("div", { class: "view-tabs", attrs: { role: "tablist" } });
  for (const [mode, label, glyph] of [["table", "Table", "table"], ["board", "Board", "board"]]) {
    const tab = el("button", { class: `view-tab ${view.mode === mode ? "active" : ""}`.trim(), attrs: { type: "button", role: "tab", "aria-selected": String(view.mode === mode) } }, [icon(glyph, "view-tab-icon"), el("span", { text: label })]);
    tab.addEventListener("click", () => {
      if (view.inline) view.setMode(mode);
      else navigate({ name: "database", id: view.databaseId, view: mode });
    });
    tabs.append(tab);
  }
  const addView = el("button", { class: "view-tab add", attrs: { type: "button", title: "Add a new view", "aria-label": "Add a new view", "aria-expanded": "false" } }, [icon("plus", "view-tab-icon")]);
  addView.addEventListener("click", () => openPopover(addView, [
    { header: "Add a new view" },
    { label: "Table", icon: "table", checked: view.mode === "table", onSelect: () => (view.inline ? view.setMode("table") : navigate({ name: "database", id: view.databaseId, view: "table" })) },
    { label: "Board", icon: "board", checked: view.mode === "board", onSelect: () => (view.inline ? view.setMode("board") : navigate({ name: "database", id: view.databaseId, view: "board" })) },
    "divider",
    { header: "Not simulated by this Tool" },
    ...[["Timeline", "timeline"], ["Calendar", "calendar"], ["List", "list_view"], ["Gallery", "gallery"], ["Chart", "chart"], ["Feed", "feed"], ["Map", "map"]].map(([label, glyph]) => ({ label, icon: glyph, disabled: true })),
  ], { width: 260 }));
  tabs.append(addView);
  bar.append(tabs);

  const actions = el("div", { class: "view-actions" });
  const setting = settingsFor(view.databaseId);
  const filterBtn = textButton("Filter", { class: `toolbar-btn ${setting.filters.length > 0 ? "active" : ""}`.trim(), onClick: () => openAddFilter(filterBtn, view, host) });
  const sortBtn = textButton("Sort", { class: `toolbar-btn ${setting.sort ? "active" : ""}`.trim(), onClick: () => openSortMenu(sortBtn, view, host) });
  const searchBtn = iconButton("search", "Search", { class: setting.search ? "active" : "" });
  const searchBox = el("input", { class: "view-search", attrs: { type: "search", placeholder: "Type to search…", "aria-label": "Search in view" } });
  searchBox.value = setting.search;
  searchBox.hidden = setting.search.length === 0;
  let timer;
  searchBox.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      setting.search = searchBox.value;
      void action(async () => { await query(view, false); render(host, view); if (setting.search) { const box = host.querySelector(".view-search"); box?.focus(); box?.setSelectionRange(box.value.length, box.value.length); } }, { exclusive: false });
    }, 250);
  });
  searchBtn.addEventListener("click", () => { searchBox.hidden = false; searchBox.focus(); });
  const more = iconButton("more", "View options", { onClick: () => openPopover(more, [
    { header: "View options" },
    { label: "Properties", icon: "prop_multi_select", description: "Add, rename or delete properties", onSelect: () => openSchemaEditor(more, view.source.id, view.source.properties, async () => { await loadIndex(); await view.refresh(); view.onChanged?.(); }) },
    { label: "Open as full page", icon: "open", disabled: !view.inline, onSelect: () => navigate({ name: "database", id: view.databaseId, view: view.mode }) },
    "divider",
    { label: "Reload", icon: "refresh", onSelect: () => action(async () => { await view.refresh(); }) },
  ], { align: "end", width: 260 }) });
  const create = el("button", { class: "btn primary new-btn", attrs: { type: "button" } }, [el("span", { text: "New" })]);
  create.disabled = !canWrite("read_update_insert") || view.database.in_trash;
  create.addEventListener("click", () => createRow(view, host));
  const caret = el("button", { class: "new-caret", attrs: { type: "button", "aria-label": "New page options", title: "New page options", "aria-expanded": "false" } }, [icon("chevron_down")]);
  caret.disabled = create.disabled;
  caret.addEventListener("click", () => openPopover(caret, [
    { header: "Templates" },
    { label: "New page", icon: "page", onSelect: () => createRow(view, host) },
    "divider",
    { label: "New template", icon: "plus", disabled: true, description: "Database templates are not simulated by this Tool" },
  ], { align: "end", width: 260 }));
  const automations = unsimulatedButton("bolt", "Automations", "Database automations are not part of the API subset this Tool serves.", { align: "end" });
  actions.append(filterBtn, sortBtn, automations, searchBtn, searchBox, more, el("span", { class: "new-split" }, [create, caret]));
  bar.append(actions);
  return bar;
}

function filterBar(view, host) {
  const setting = settingsFor(view.databaseId);
  const bar = el("div", { class: "filter-bar" });
  setting.filters.forEach((filter, index) => {
    const definition = view.source.properties[filter.property];
    if (!definition) return;
    const label = NO_VALUE.has(filter.condition) ? labelFor(definition.type, filter.condition) : `${labelFor(definition.type, filter.condition).toLowerCase()} ${displayValue(definition, filter.value)}`;
    const chip = el("button", { class: "filter-chip", attrs: { type: "button", "aria-expanded": "false" } }, [icon(propertyIcon(definition.type), "chip-icon"), el("span", { class: "chip-name", text: definition.name }), el("span", { class: "chip-cond", text: label }), icon("chevron_down", "chip-chevron")]);
    chip.addEventListener("click", () => openFilterEditor(chip, view, host, index));
    bar.append(chip);
  });
  if (setting.sort) {
    const definition = view.source.properties[setting.sort.property];
    if (definition) {
      const chip = el("button", { class: "filter-chip sort", attrs: { type: "button" } }, [icon("sort", "chip-icon"), el("span", { class: "chip-name", text: definition.name }), el("span", { class: "chip-cond", text: setting.sort.direction === "ascending" ? "Ascending" : "Descending" }), icon("chevron_down", "chip-chevron")]);
      chip.addEventListener("click", () => openSortMenu(chip, view, host));
      bar.append(chip);
    }
  }
  const add = textButton("Add filter", { class: "ghost small", icon: "plus", onClick: () => openAddFilter(add, view, host) });
  bar.append(add);
  return bar;
}

function labelFor(type, condition) {
  const kind = conditionKind(type);
  const entry = (CONDITIONS[kind] ?? []).find(([id]) => id === condition);
  return entry ? entry[1] : condition;
}

function displayValue(definition, value) {
  if (definition.type === "people") return state.users.get(value)?.name ?? value;
  if (definition.type === "relation") return state.pages.get(value)?.title ?? value;
  return value;
}

function openAddFilter(anchor, view, host) {
  const properties = Object.values(view.source.properties).filter((definition) => conditionKind(definition.type) !== undefined);
  const box = el("div", { class: "editor-options" });
  const search = el("input", { class: "editor-search", attrs: { type: "text", placeholder: "Filter by…", "aria-label": "Filter by property" } });
  const list = el("div", { class: "picker-list" });
  const renderList = () => {
    list.replaceChildren();
    const needle = search.value.trim().toLowerCase();
    for (const definition of properties.filter((candidate) => candidate.name.toLowerCase().includes(needle))) {
      const row = el("button", { class: "picker-item", attrs: { type: "button" } }, [icon(propertyIcon(definition.type), "picker-icon"), el("span", { class: "picker-label", text: definition.name })]);
      row.addEventListener("click", () => {
        closePopovers();
        const setting = settingsFor(view.databaseId);
        const kind = conditionKind(definition.type);
        setting.filters.push({ property: definition.name, condition: CONDITIONS[kind][0][0], value: kind === "checkbox" ? "true" : "" });
        render(host, view);
        const chip = host.querySelectorAll(".filter-chip:not(.sort)")[setting.filters.length - 1];
        if (chip) openFilterEditor(chip, view, host, setting.filters.length - 1);
      });
      list.append(row);
    }
  };
  search.addEventListener("input", renderList);
  box.append(search, list);
  renderList();
  return openPopover(anchor, box, { width: 260 });
}

function openFilterEditor(anchor, view, host, index) {
  const setting = settingsFor(view.databaseId);
  const filter = setting.filters[index];
  const definition = view.source.properties[filter.property];
  const kind = conditionKind(definition.type);
  const box = el("div", { class: "filter-editor" });
  const head = el("div", { class: "filter-editor-head" }, [icon(propertyIcon(definition.type), "chip-icon"), el("span", { class: "chip-name", text: definition.name })]);
  const condition = el("select", { class: "filter-select", attrs: { "aria-label": "Condition" } });
  for (const [id, label] of CONDITIONS[kind]) condition.append(el("option", { text: label, attrs: { value: id, selected: id === filter.condition ? "" : undefined } }));
  head.append(condition);
  box.append(head);
  const valueHost = el("div", { class: "filter-value" });
  const renderValue = () => {
    valueHost.replaceChildren();
    if (NO_VALUE.has(condition.value)) return;
    if (kind === "checkbox") {
      const select = el("select", { class: "filter-select", attrs: { "aria-label": "Value" } }, [el("option", { text: "Checked", attrs: { value: "true" } }), el("option", { text: "Unchecked", attrs: { value: "false" } })]);
      select.value = filter.value || "true";
      select.addEventListener("change", () => { filter.value = select.value; apply(); });
      valueHost.append(select);
    } else if (kind === "option") {
      const options = definition[definition.type]?.options ?? [];
      const select = el("select", { class: "filter-select", attrs: { "aria-label": "Value" } }, [el("option", { text: "Select an option", attrs: { value: "" } }), ...options.map((option) => el("option", { text: option.name, attrs: { value: option.name } }))]);
      select.value = filter.value;
      select.addEventListener("change", () => { filter.value = select.value; apply(); });
      valueHost.append(select);
    } else if (definition.type === "multi_select") {
      const options = definition.multi_select?.options ?? [];
      const select = el("select", { class: "filter-select", attrs: { "aria-label": "Value" } }, [el("option", { text: "Select an option", attrs: { value: "" } }), ...options.map((option) => el("option", { text: option.name, attrs: { value: option.name } }))]);
      select.value = filter.value;
      select.addEventListener("change", () => { filter.value = select.value; apply(); });
      valueHost.append(select);
    } else if (definition.type === "people") {
      const people = [...state.users.values()].filter((user) => user.type === "person");
      const select = el("select", { class: "filter-select", attrs: { "aria-label": "Person" } }, [el("option", { text: "Select a person", attrs: { value: "" } }), ...people.map((user) => el("option", { text: user.name, attrs: { value: user.id } }))]);
      select.value = filter.value;
      select.addEventListener("change", () => { filter.value = select.value; apply(); });
      valueHost.append(select);
    } else if (definition.type === "relation") {
      const targets = [...state.pages.values()].filter((page) => page.parent?.type === "data_source_id" && page.parent.data_source_id === definition.relation?.data_source_id);
      const select = el("select", { class: "filter-select", attrs: { "aria-label": "Page" } }, [el("option", { text: "Select a page", attrs: { value: "" } }), ...targets.map((page) => el("option", { text: page.title, attrs: { value: page.id } }))]);
      select.value = filter.value;
      select.addEventListener("change", () => { filter.value = select.value; apply(); });
      valueHost.append(select);
    } else {
      const input = el("input", { class: "editor-input", attrs: { type: kind === "number" ? "number" : kind === "date" ? "date" : "text", placeholder: "Type a value…", "aria-label": "Value", step: "any" } });
      input.value = filter.value;
      let timer;
      input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => { filter.value = input.value; apply(true); }, 300); });
      input.addEventListener("keydown", (event) => { if (event.key === "Enter") { clearTimeout(timer); filter.value = input.value; apply(); } });
      valueHost.append(input);
    }
  };
  const apply = (keepOpen = false) => {
    void action(async () => {
      await query(view, false);
      if (!keepOpen) closePopovers();
      render(host, view);
    }, { exclusive: false });
  };
  condition.addEventListener("change", () => { filter.condition = condition.value; renderValue(); apply(true); });
  renderValue();
  box.append(valueHost);
  const remove = textButton("Delete filter", { class: "ghost small danger", icon: "trash", onClick: () => { setting.filters.splice(index, 1); apply(); } });
  box.append(el("div", { class: "filter-editor-actions" }, [remove]));
  return openPopover(anchor, box, { width: 300 });
}

function openSortMenu(anchor, view, host) {
  const setting = settingsFor(view.databaseId);
  const properties = Object.values(view.source.properties);
  const items = [{ header: "Sort by" }];
  for (const definition of properties) {
    for (const direction of ["ascending", "descending"]) {
      const checked = setting.sort?.property === definition.name && setting.sort.direction === direction;
      items.push({ label: `${definition.name} · ${direction === "ascending" ? "Ascending" : "Descending"}`, icon: propertyIcon(definition.type), checked, onSelect: () => { setting.sort = { property: definition.name, direction }; void action(async () => { await query(view, false); render(host, view); }); } });
    }
  }
  if (setting.sort) items.push("divider", { label: "Remove sort", icon: "close", danger: true, onSelect: () => { setting.sort = undefined; void action(async () => { await query(view, false); render(host, view); }); } });
  return openPopover(anchor, items, { width: 280 });
}

// ---------------------------------------------------------------------------------------------
// Table view
// ---------------------------------------------------------------------------------------------

function tableView(view, host) {
  const maps = lookup();
  const definitions = orderedDefinitions(Object.values(view.source.properties));
  const title = definitions.find((definition) => definition.type === "title");
  const columns = [title, ...definitions.filter((definition) => definition.type !== "title")].filter(Boolean);
  const wrap = el("div", { class: "table-wrap" });
  const table = el("table", { class: "db-table", attrs: { role: "grid", "aria-label": `${plain(view.database.title) || "Untitled"} table` } });
  const head = el("thead");
  const headRow = el("tr");
  for (const definition of columns) {
    const cell = el("th", { attrs: { scope: "col" } });
    const button = el("button", { class: "col-head", attrs: { type: "button", "aria-expanded": "false" } }, [icon(propertyIcon(definition.type), "col-icon"), el("span", { class: "col-name", text: definition.name })]);
    button.addEventListener("click", () => openColumnMenu(button, view, host, definition));
    cell.append(button);
    headRow.append(cell);
  }
  if (canWrite("read_update") && !view.database.in_trash) {
    const add = el("th", { class: "col-add" }, iconButton("plus", "Add a property", { class: "small", onClick: (event) => openSchemaEditor(event.currentTarget, view.source.id, view.source.properties, async () => { await loadIndex(); await view.refresh(); view.onChanged?.(); }, { add: true }) }));
    headRow.append(add);
  }
  head.append(headRow);
  table.append(head);
  const body = el("tbody");
  const writable = canWrite() && !view.database.in_trash;
  for (const row of view.rows) {
    const tr = el("tr", { attrs: { "data-page-id": row.id } });
    columns.forEach((definition, index) => {
      const property = row.properties[definition.name];
      const td = el("td", { class: `cell type-${definition.type} ${index === 0 ? "title-cell" : ""}`.trim() });
      if (!property) { tr.append(td); return; }
      if (index === 0) {
        const open = el("button", { class: "row-title", attrs: { type: "button" } }, [objectIcon(row.icon, "page", "row-icon"), el("span", { class: "row-title-text", text: pageTitle(row) })]);
        open.addEventListener("click", () => openRow(view, host, row.id));
        const peekBtn = el("button", { class: "open-btn", attrs: { type: "button", "aria-label": "Open page" } }, [icon("open"), el("span", { text: "OPEN" })]);
        peekBtn.addEventListener("click", () => openRow(view, host, row.id));
        td.append(open, peekBtn);
      } else if (definition.type === "checkbox") {
        td.append(checkbox(property.checkbox === true, { label: definition.name, onToggle: writable ? (next) => writeCell(view, host, row.id, definition.name, { checkbox: next }) : undefined }));
      } else {
        const computed = ["created_time", "created_by", "last_edited_time", "last_edited_by"].includes(definition.type);
        const cell = el("button", { class: `cell-btn ${computed || !writable ? "readonly" : ""}`.trim(), attrs: { type: "button", "aria-label": `${definition.name} of ${pageTitle(row)}`, "aria-expanded": "false" } }, propertyValue(property, maps));
        if (computed || !writable) cell.disabled = true;
        else cell.addEventListener("click", () => openPropertyEditor(cell, definition, property, (next) => writeCell(view, host, row.id, definition.name, next), { onNotice: (text) => snackbar(text) }));
        td.append(cell);
      }
      tr.append(td);
    });
    if (canWrite("read_update") && !view.database.in_trash) tr.append(el("td", { class: "col-add" }));
    body.append(tr);
  }
  if (view.rows.length === 0) {
    const empty = el("tr", { class: "empty-row" });
    const setting = settingsFor(view.databaseId);
    empty.append(el("td", { attrs: { colspan: String(columns.length + 1) } }, el("div", { class: "table-empty", text: setting.filters.length > 0 || setting.search ? "No results" : "No pages yet" })));
    body.append(empty);
  }
  table.append(body);
  const foot = el("tfoot");
  if (writable && canWrite("read_update_insert")) {
    const newRow = el("tr", { class: "new-row" });
    const cell = el("td", { attrs: { colspan: String(columns.length + 1) } });
    const button = el("button", { class: "new-row-btn", attrs: { type: "button" } }, [icon("plus"), el("span", { text: "New" })]);
    button.addEventListener("click", () => createRow(view, host));
    cell.append(button);
    newRow.append(cell);
    foot.append(newRow);
  }
  const calc = el("tr", { class: "calc-row" });
  const count = el("td", { class: "calc-cell" }, [el("span", { class: "calc-label", text: "COUNT" }), el("span", { class: "calc-value", text: view.more ? `${view.rows.length}+` : String(view.rows.length) })]);
  calc.append(count, el("td", { attrs: { colspan: String(columns.length) } }));
  foot.append(calc);
  table.append(foot);
  wrap.append(table);
  if (view.more) wrap.append(textButton(`Load ${PAGE_SIZE} more`, { class: "load-more", onClick: () => action(async () => { await query(view, true); render(host, view); }, { exclusive: false }) }));
  return wrap;
}

function writeCell(view, host, pageId, name, valueObject) {
  return action(async () => {
    await call("pages.update", { page_id: pageId, properties: { [name]: valueObject } }, key());
    await query(view, false);
    render(host, view);
    view.onChanged?.();
  });
}

function openColumnMenu(anchor, view, host, definition) {
  const setting = settingsFor(view.databaseId);
  const items = [
    { header: definition.type.replace(/_/g, " ") },
    { label: "Sort ascending", icon: "sort", onSelect: () => { setting.sort = { property: definition.name, direction: "ascending" }; void action(async () => { await query(view, false); render(host, view); }); } },
    { label: "Sort descending", icon: "sort", onSelect: () => { setting.sort = { property: definition.name, direction: "descending" }; void action(async () => { await query(view, false); render(host, view); }); } },
  ];
  if (conditionKind(definition.type)) items.push({ label: "Filter", icon: "filter", onSelect: () => { const kind = conditionKind(definition.type); setting.filters.push({ property: definition.name, condition: CONDITIONS[kind][0][0], value: kind === "checkbox" ? "true" : "" }); render(host, view); const chip = host.querySelectorAll(".filter-chip:not(.sort)")[setting.filters.length - 1]; if (chip) openFilterEditor(chip, view, host, setting.filters.length - 1); } });
  if (canWrite("read_update") && !view.database.in_trash) {
    items.push("divider", { label: "Edit property", icon: "settings", onSelect: () => openSchemaEditor(anchor, view.source.id, view.source.properties, async () => { await loadIndex(); await view.refresh(); view.onChanged?.(); }, { focus: definition.name }) });
    if (definition.type !== "title") items.push({ label: "Delete property", icon: "trash", danger: true, onSelect: () => action(async () => {
      if (!(await confirmDialog(`Delete the property "${definition.name}"?`, "Its values are removed from every page of this database.", "Delete"))) return;
      await call("data-sources.update", { data_source_id: view.source.id, properties: { [definition.name]: null } }, key());
      await loadIndex();
      await view.refresh();
      view.onChanged?.();
    }) });
  }
  return openPopover(anchor, items, { width: 240 });
}

async function createRow(view, host) {
  await action(async () => {
    const title = Object.values(view.source.properties).find((definition) => definition.type === "title");
    const created = await call("pages.create", { parent: { data_source_id: view.source.id }, properties: { [title.name]: { title: [] } } }, key());
    await loadIndex();
    await query(view, false);
    render(host, view);
    view.onChanged?.();
    openRow(view, host, created.id);
  });
}

async function openRow(view, host, pageId) {
  const { renderPageView, pageTopbarActions } = await import("./page.js");
  const body = el("div", { class: "peek-page" });
  const controller = renderPageView(body, pageId, { peek: true, onChanged: async () => { await query(view, false); render(host, view); view.onChanged?.(); } });
  openPeek(body, { onExpand: () => { closePeek(); navigate({ name: "page", id: pageId }); } });
  const head = $("#peek .peek-head");
  const actions = el("div", { class: "peek-actions" });
  head.append(actions);
  controller.onLoadedActions = () => actions.replaceChildren(...pageTopbarActions(controller, {}).slice(2));
  const wait = setInterval(() => { if (controller.page) { clearInterval(wait); controller.onLoadedActions(); } if (!body.isConnected) clearInterval(wait); }, 150);
}

// ---------------------------------------------------------------------------------------------
// Board view (grouped by the first status, else select, property)
// ---------------------------------------------------------------------------------------------

function boardView(view, host) {
  const definitions = Object.values(view.source.properties);
  const groupBy = definitions.find((definition) => definition.type === "status") ?? definitions.find((definition) => definition.type === "select");
  if (!groupBy) return el("div", { class: "board-empty", text: "Add a Status or Select property to group this board." });
  const options = groupBy[groupBy.type]?.options ?? [];
  const maps = lookup();
  const board = el("div", { class: "board" });
  const columns = [{ id: "__none", name: `No ${groupBy.name}`, color: "default" }, ...options];
  const shown = orderedDefinitions(definitions).filter((definition) => definition.type !== "title" && definition.name !== groupBy.name && !COMPUTED.includes(definition.type)).slice(0, 4);
  const writable = canWrite() && !view.database.in_trash;
  for (const column of columns) {
    const rows = view.rows.filter((row) => {
      const value = row.properties[groupBy.name]?.[groupBy.type];
      return column.id === "__none" ? !value : value?.id === column.id;
    });
    if (column.id === "__none" && rows.length === 0) continue;
    const col = el("section", { class: "board-column", attrs: { "aria-label": column.name } });
    col.append(el("header", { class: "board-head" }, [pill(column, { status: groupBy.type === "status" }), el("span", { class: "board-count", text: String(rows.length) })]));
    for (const row of rows) {
      const card = el("button", { class: "board-card", attrs: { type: "button" } });
      card.append(el("div", { class: "card-title" }, [row.icon ? objectIcon(row.icon, "page", "row-icon") : null, el("span", { text: pageTitle(row) })]));
      for (const definition of shown) {
        const property = row.properties[definition.name];
        if (!property) continue;
        const raw = property[definition.type];
        if (raw === null || raw === undefined || raw === "" || (Array.isArray(raw) && raw.length === 0) || raw === false) continue;
        card.append(el("div", { class: "card-prop" }, propertyValue(property, maps)));
      }
      card.addEventListener("click", () => openRow(view, host, row.id));
      col.append(card);
    }
    if (writable && canWrite("read_update_insert")) {
      const add = el("button", { class: "board-new", attrs: { type: "button" } }, [icon("plus"), el("span", { text: "New" })]);
      add.addEventListener("click", () => action(async () => {
        const title = definitions.find((definition) => definition.type === "title");
        const properties = { [title.name]: { title: [] } };
        if (column.id !== "__none") properties[groupBy.name] = { [groupBy.type]: { id: column.id } };
        const created = await call("pages.create", { parent: { data_source_id: view.source.id }, properties }, key());
        await loadIndex();
        await query(view, false);
        render(host, view);
        view.onChanged?.();
        openRow(view, host, created.id);
      }));
      col.append(add);
    }
    board.append(col);
  }
  const wrap = el("div", { class: "board-wrap" }, board);
  if (view.more) wrap.append(textButton(`Load ${PAGE_SIZE} more`, { class: "load-more", onClick: () => action(async () => { await query(view, true); render(host, view); }, { exclusive: false }) }));
  return wrap;
}

// ---------------------------------------------------------------------------------------------
// Schema editor (data-sources.update)
// ---------------------------------------------------------------------------------------------

const PROPERTY_TYPES = [["rich_text", "Text"], ["number", "Number"], ["select", "Select"], ["multi_select", "Multi-select"], ["status", "Status"], ["date", "Date"], ["people", "Person"], ["checkbox", "Checkbox"], ["url", "URL"], ["email", "Email"], ["phone_number", "Phone"], ["created_time", "Created time"], ["created_by", "Created by"], ["last_edited_time", "Last edited time"], ["last_edited_by", "Last edited by"]];

export function openSchemaEditor(anchor, dataSourceId, schema, onDone, { add = false, focus } = {}) {
  const box = el("div", { class: "schema-editor" });
  const list = el("div", { class: "schema-list" });
  const update = (properties, success) => action(async () => {
    await call("data-sources.update", { data_source_id: dataSourceId, properties }, key());
    closePopovers();
    snackbar(success);
    await onDone();
  });
  if (!add) {
    box.append(el("div", { class: "picker-heading", text: "Properties" }));
    for (const definition of Object.values(schema)) {
      const row = el("div", { class: `schema-row ${focus === definition.name ? "focus" : ""}`.trim() });
      const name = el("input", { class: "schema-name", attrs: { type: "text", "aria-label": `Rename ${definition.name}` } });
      name.value = definition.name;
      name.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); name.blur(); } });
      name.addEventListener("blur", () => {
        const next = name.value.trim();
        if (next === definition.name || next.length === 0) { name.value = definition.name; return; }
        void update({ [definition.name]: { name: next } }, `Renamed to ${next}`);
      });
      row.append(icon(propertyIcon(definition.type), "col-icon"), name);
      if (definition.type !== "title") {
        row.append(iconButton("trash", `Delete ${definition.name}`, { class: "small", onClick: () => action(async () => {
          if (!(await confirmDialog(`Delete the property "${definition.name}"?`, "Its values are removed from every page of this database.", "Delete"))) return;
          await update({ [definition.name]: null }, "Property deleted");
        }) }));
      }
      list.append(row);
    }
    box.append(list);
  }
  box.append(el("div", { class: "picker-heading", text: "New property" }));
  const form = el("form", { class: "schema-add" });
  const name = el("input", { class: "editor-input", attrs: { type: "text", placeholder: "Property name", "aria-label": "New property name", required: "" } });
  const type = el("select", { class: "filter-select", attrs: { "aria-label": "Property type" } }, PROPERTY_TYPES.map(([id, label]) => el("option", { text: label, attrs: { value: id } })));
  const submit = el("button", { class: "btn primary", text: "Add", attrs: { type: "submit" } });
  form.append(name, type, submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const label = name.value.trim();
    if (label.length === 0) return;
    const config = ["select", "multi_select", "status"].includes(type.value) ? { options: [] } : type.value === "number" ? { format: "number" } : {};
    void update({ [label]: { [type.value]: config } }, `Added ${label}`);
  });
  box.append(form);
  const popover = openPopover(anchor, box, { width: 320, align: "end" });
  (add ? name : list.querySelector(".schema-row.focus input") ?? name).focus();
  return popover;
}

export { OPTION_COLORS };
