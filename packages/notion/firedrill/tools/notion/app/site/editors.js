// Popover editors for page property values (the same controls back the property panel and table cells),
// the emoji picker and the "/" block menu. Every editor resolves to the Notion property value to write.
import { icon } from "./icons.js";
import { EMOJIS, OPTION_COLORS, checkbox, pill, plain, textToRich } from "./rich.js";
import { state } from "./state.js";
import { $$, call, closePopovers, el, menuList, openPopover, textButton } from "./ui.js";

const TEXT_TYPES = ["rich_text", "url", "email", "phone_number", "number"];

/**
 * Open the right editor for `definition` (data source property schema entry) anchored at `anchor`.
 * `current` is the rendered property object; `onChange(valueObject)` receives e.g. `{ select: { name } }`.
 */
export function openPropertyEditor(anchor, definition, current, onChange, options = {}) {
  const type = definition.type;
  const value = current?.[type];
  if (TEXT_TYPES.includes(type)) return textEditor(anchor, definition, value, onChange);
  if (type === "date") return dateEditor(anchor, value, onChange);
  if (type === "select" || type === "status") return optionEditor(anchor, definition, value, onChange, { multi: false });
  if (type === "multi_select") return optionEditor(anchor, definition, value ?? [], onChange, { multi: true });
  if (type === "people") return peopleEditor(anchor, value ?? [], onChange);
  if (type === "relation") return relationEditor(anchor, definition, value ?? [], onChange, options);
  if (type === "checkbox") return onChange({ checkbox: !(value === true) });
  return undefined;
}

function textEditor(anchor, definition, value, onChange) {
  const type = definition.type;
  const initial = type === "rich_text" ? plain(value) : value === null || value === undefined ? "" : String(value);
  const box = el("div", { class: "editor-text" });
  const input = type === "rich_text" ? el("textarea", { class: "editor-input", attrs: { rows: "3", "aria-label": definition.name } }) : el("input", { class: "editor-input", attrs: { type: type === "number" ? "number" : "text", "aria-label": definition.name, step: "any" } });
  input.value = initial;
  const commit = () => {
    const raw = input.value.trim();
    if (raw === initial.trim()) return closePopovers();
    let next;
    if (type === "rich_text") next = { rich_text: textToRich(raw) };
    else if (type === "number") next = { number: raw === "" ? null : Number(raw) };
    else next = { [type]: raw === "" ? null : raw };
    closePopovers();
    onChange(next);
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !(type === "rich_text" && event.shiftKey)) {
      event.preventDefault();
      commit();
    }
  });
  box.append(input, el("div", { class: "editor-hint", text: type === "rich_text" ? "Shift+Enter for a new line · Enter to save" : "Enter to save · Esc to cancel" }));
  const popover = openPopover(anchor, box, { width: 300, onClose: undefined });
  input.focus();
  input.select?.();
  return popover;
}

function dateEditor(anchor, value, onChange) {
  const box = el("div", { class: "editor-date" });
  const start = el("input", { class: "editor-input", attrs: { type: "date", "aria-label": "Start date" } });
  const end = el("input", { class: "editor-input", attrs: { type: "date", "aria-label": "End date" } });
  start.value = value?.start?.slice(0, 10) ?? "";
  end.value = value?.end?.slice(0, 10) ?? "";
  const endRow = el("label", { class: "editor-row" }, [el("span", { class: "editor-label", text: "End date" }), end]);
  endRow.hidden = !value?.end;
  const toggle = textButton(value?.end ? "Remove end date" : "Add end date", { class: "link", onClick: () => { endRow.hidden = !endRow.hidden; toggle.querySelector("span:last-child").textContent = endRow.hidden ? "Add end date" : "Remove end date"; if (endRow.hidden) end.value = ""; } });
  const save = textButton("Save", { class: "primary", onClick: () => { closePopovers(); onChange({ date: start.value ? { start: start.value, end: end.value && !endRow.hidden ? end.value : null } : null }); } });
  const clear = textButton("Clear", { onClick: () => { closePopovers(); onChange({ date: null }); } });
  box.append(el("label", { class: "editor-row" }, [el("span", { class: "editor-label", text: "Date" }), start]), endRow, toggle, el("div", { class: "editor-actions" }, [clear, save]));
  return openPopover(anchor, box, { width: 300 });
}

function optionEditor(anchor, definition, value, onChange, { multi }) {
  const options = definition[definition.type]?.options ?? definition.config?.options ?? [];
  const selectedIds = new Set(multi ? value.map((option) => option.id) : value ? [value.id] : []);
  const box = el("div", { class: "editor-options" });
  const chips = el("div", { class: "editor-chips" });
  const search = el("input", { class: "editor-search", attrs: { type: "text", placeholder: multi ? "Search or create an option…" : "Search for an option…", "aria-label": "Search options" } });
  const list = el("div", { class: "picker-list", attrs: { role: "listbox" } });
  const renderChips = () => {
    chips.replaceChildren();
    for (const option of options.filter((candidate) => selectedIds.has(candidate.id))) {
      const chip = pill(option, { status: definition.type === "status" });
      const remove = el("button", { class: "chip-remove", attrs: { type: "button", "aria-label": `Remove ${option.name}` } }, icon("close"));
      remove.addEventListener("click", () => { selectedIds.delete(option.id); commit(true); });
      chip.append(remove);
      chips.append(chip);
    }
    chips.hidden = chips.childElementCount === 0;
  };
  const commit = (keepOpen = false) => {
    if (multi) onChange({ multi_select: options.filter((option) => selectedIds.has(option.id)).map((option) => ({ id: option.id })) });
    else {
      const chosen = options.find((option) => selectedIds.has(option.id));
      onChange({ [definition.type]: chosen ? { id: chosen.id } : null });
    }
    if (!keepOpen) closePopovers();
    else render();
  };
  const render = () => {
    renderChips();
    list.replaceChildren();
    const needle = search.value.trim().toLowerCase();
    const visible = options.filter((option) => option.name.toLowerCase().includes(needle));
    list.append(el("div", { class: "picker-heading", text: "Select an option" }));
    for (const option of visible) {
      const row = el("button", { class: `picker-item ${selectedIds.has(option.id) ? "selected" : ""}`.trim(), attrs: { type: "button", role: "option", "aria-selected": String(selectedIds.has(option.id)) } });
      row.append(pill(option, { status: definition.type === "status" }));
      if (selectedIds.has(option.id)) row.append(icon("check", "picker-check"));
      row.addEventListener("click", () => {
        if (multi) {
          if (selectedIds.has(option.id)) selectedIds.delete(option.id);
          else selectedIds.add(option.id);
          commit(true);
        } else {
          selectedIds.clear();
          selectedIds.add(option.id);
          commit();
        }
      });
      list.append(row);
    }
    if (multi && needle.length > 0 && !options.some((option) => option.name.toLowerCase() === needle)) {
      const create = el("button", { class: "picker-item create", attrs: { type: "button" } }, [el("span", { text: "Create " }), pill({ name: search.value.trim(), color: OPTION_COLORS[(search.value.length % (OPTION_COLORS.length - 1)) + 1] })]);
      create.addEventListener("click", () => {
        // A new option name is accepted by the Tool, which adds it to the schema exactly as the product does.
        const names = options.filter((option) => selectedIds.has(option.id)).map((option) => ({ id: option.id }));
        closePopovers();
        onChange({ multi_select: [...names, { name: search.value.trim() }] });
      });
      list.append(create);
    }
    if (visible.length === 0 && !(multi && needle.length > 0)) list.append(el("div", { class: "picker-empty", text: "No options" }));
    if (!multi && selectedIds.size > 0) {
      const clear = el("button", { class: "picker-item clear", attrs: { type: "button" } }, [icon("close", "picker-icon"), el("span", { text: "Clear" })]);
      clear.addEventListener("click", () => { selectedIds.clear(); commit(); });
      list.append(clear);
    }
  };
  search.addEventListener("input", render);
  box.append(chips, search, list);
  render();
  return openPopover(anchor, box, { width: 300 });
}

function peopleEditor(anchor, value, onChange) {
  const persons = [...state.users.values()].filter((user) => user.type === "person");
  const selected = new Set(value.map((user) => user.id));
  const box = el("div", { class: "editor-options" });
  const search = el("input", { class: "editor-search", attrs: { type: "text", placeholder: "Search for a person…", "aria-label": "Search people" } });
  const list = el("div", { class: "picker-list", attrs: { role: "listbox" } });
  const commit = () => onChange({ people: [...selected].map((id) => ({ id })) });
  const render = () => {
    list.replaceChildren();
    const needle = search.value.trim().toLowerCase();
    if (state.usersDenied) {
      list.append(el("div", { class: "picker-empty", text: "This integration can't list workspace users (no user-information capability)." }));
      return;
    }
    if (state.usersTruncated) list.append(el("div", { class: "picker-empty", text: `Showing the first ${state.users.size} workspace members.` }));
    list.append(el("div", { class: "picker-heading", text: "Select a person" }));
    for (const user of persons.filter((user) => user.name.toLowerCase().includes(needle))) {
      const row = el("button", { class: `picker-item ${selected.has(user.id) ? "selected" : ""}`.trim(), attrs: { type: "button", role: "option", "aria-selected": String(selected.has(user.id)) } });
      const initial = el("span", { class: "avatar small", text: user.name.charAt(0).toUpperCase() });
      row.append(initial, el("span", { class: "picker-label", text: user.name }), el("span", { class: "picker-sub", text: user.person?.email ?? (user.is_guest ? "Guest" : "") }));
      if (selected.has(user.id)) row.append(icon("check", "picker-check"));
      row.addEventListener("click", () => {
        if (selected.has(user.id)) selected.delete(user.id);
        else selected.add(user.id);
        commit();
        render();
      });
      list.append(row);
    }
  };
  search.addEventListener("input", render);
  box.append(search, list);
  render();
  return openPopover(anchor, box, { width: 300 });
}

function relationEditor(anchor, definition, value, onChange, options) {
  const config = definition.relation ?? definition.config ?? {};
  const sourceId = config.data_source_id;
  const selected = new Set(value.map((ref) => ref.id));
  const box = el("div", { class: "editor-options" });
  const search = el("input", { class: "editor-search", attrs: { type: "text", placeholder: "Search for a page…", "aria-label": "Search pages" } });
  const list = el("div", { class: "picker-list", attrs: { role: "listbox" } });
  let candidates = [];
  let loading = true;
  let failure;
  const titleOf = (page) => {
    const property = Object.values(page.properties).find((entry) => entry.type === "title");
    const text = property ? plain(property.title) : "";
    return text || "Untitled";
  };
  const commit = () => onChange({ relation: [...selected].map((id) => ({ id })) });
  const render = () => {
    list.replaceChildren();
    if (loading) {
      list.append(el("div", { class: "picker-empty", text: "Loading…" }));
      return;
    }
    if (failure) {
      list.append(el("div", { class: "picker-empty", text: failure }));
      return;
    }
    const needle = search.value.trim().toLowerCase();
    list.append(el("div", { class: "picker-heading", text: "Link to page" }));
    const visible = candidates.filter((page) => titleOf(page).toLowerCase().includes(needle));
    for (const page of visible) {
      const row = el("button", { class: `picker-item ${selected.has(page.id) ? "selected" : ""}`.trim(), attrs: { type: "button", role: "option", "aria-selected": String(selected.has(page.id)) } });
      row.append(el("span", { class: "picker-emoji", text: page.icon?.type === "emoji" ? page.icon.emoji : "" }), el("span", { class: "picker-label", text: titleOf(page) }));
      if (selected.has(page.id)) row.append(icon("check", "picker-check"));
      row.addEventListener("click", () => {
        if (selected.has(page.id)) selected.delete(page.id);
        else selected.add(page.id);
        commit();
        render();
      });
      list.append(row);
    }
    if (visible.length === 0) list.append(el("div", { class: "picker-empty", text: "No pages found" }));
  };
  search.addEventListener("input", render);
  box.append(search, list);
  render();
  const popover = openPopover(anchor, box, { width: 320 });
  void (async () => {
    try {
      const result = await call("data-sources.query", { data_source_id: sourceId, page_size: 100, filter_properties: ["title"], sorts: [{ timestamp: "last_edited_time", direction: "descending" }] });
      candidates = result.results;
      if (result.has_more) options.onNotice?.(`Showing the ${result.results.length} most recently edited pages of the related database; search to narrow the list.`);
    } catch (error) {
      failure = error?.message ?? "Could not load the related pages.";
    }
    loading = false;
    if (popover.isConnected) render();
  })();
  return popover;
}

// ---------------------------------------------------------------------------------------------
// Emoji picker (page / database icons)
// ---------------------------------------------------------------------------------------------

export function openEmojiPicker(anchor, current, onPick) {
  const box = el("div", { class: "emoji-picker" });
  const tabs = el("div", { class: "picker-tabs" }, [el("span", { class: "picker-tab active", text: "Emoji" }), el("span", { class: "picker-tab", text: "Icons" }), el("span", { class: "picker-tab", text: "Upload" })]);
  const remove = textButton("Remove", { onClick: () => { closePopovers(); onPick(null); } });
  remove.disabled = current === undefined;
  const search = el("input", { class: "editor-search", attrs: { type: "text", placeholder: "Filter…", "aria-label": "Filter emoji" } });
  const grid = el("div", { class: "emoji-grid", attrs: { role: "listbox", "aria-label": "Emoji" } });
  const render = () => {
    grid.replaceChildren();
    for (const emoji of EMOJIS) {
      const button = el("button", { class: `emoji-cell ${emoji === current ? "selected" : ""}`.trim(), text: emoji, attrs: { type: "button", role: "option", "aria-selected": String(emoji === current), "aria-label": emoji } });
      button.addEventListener("click", () => { closePopovers(); onPick(emoji); });
      grid.append(button);
    }
  };
  render();
  box.append(el("div", { class: "picker-head" }, [tabs, remove]), search, el("div", { class: "picker-heading", text: "Emoji" }), grid);
  return openPopover(anchor, box, { width: 352 });
}

// ---------------------------------------------------------------------------------------------
// "/" block menu
// ---------------------------------------------------------------------------------------------

export const BLOCK_MENU = [
  { type: "paragraph", label: "Text", description: "Just start writing with plain text.", icon: "block_text" },
  { type: "heading_1", label: "Heading 1", description: "Big section heading.", icon: "block_h1" },
  { type: "heading_2", label: "Heading 2", description: "Medium section heading.", icon: "block_h2" },
  { type: "heading_3", label: "Heading 3", description: "Small section heading.", icon: "block_h3" },
  { type: "bulleted_list_item", label: "Bulleted list", description: "Create a simple bulleted list.", icon: "block_bullet" },
  { type: "numbered_list_item", label: "Numbered list", description: "Create a list with numbering.", icon: "block_numbered" },
  { type: "to_do", label: "To-do list", description: "Track tasks with a to-do list.", icon: "block_todo" },
  { type: "toggle", label: "Toggle list", description: "Toggles can hide and show content inside.", icon: "block_toggle" },
  { type: "quote", label: "Quote", description: "Capture a quote.", icon: "block_quote" },
  { type: "callout", label: "Callout", description: "Make writing stand out.", icon: "block_callout" },
  { type: "code", label: "Code", description: "Capture a code snippet.", icon: "block_code" },
  { type: "divider", label: "Divider", description: "Visually divide blocks.", icon: "block_divider" },
  { type: "page", label: "Page", description: "Embed a sub-page inside this page.", icon: "block_page" },
];

/** Block content object for a fresh block of `type` (the shape blocks.children.append accepts). */
export function newBlockInput(type, text = "") {
  if (type === "divider") return { type, divider: {} };
  if (type === "code") return { type, code: { rich_text: textToRich(text), language: "plain text" } };
  if (type === "callout") return { type, callout: { rich_text: textToRich(text), icon: { type: "emoji", emoji: "💡" } } };
  if (type === "to_do") return { type, to_do: { rich_text: textToRich(text), checked: false } };
  return { type, [type]: { rich_text: textToRich(text) } };
}

export function openBlockMenu(anchor, onPick, { filter = "" } = {}) {
  const box = el("div", { class: "block-menu" });
  const render = (needle) => {
    box.replaceChildren();
    const items = BLOCK_MENU.filter((item) => item.label.toLowerCase().includes(needle) || item.type.includes(needle));
    if (items.length === 0) {
      box.append(el("div", { class: "picker-empty", text: "No results" }));
      return;
    }
    box.append(el("div", { class: "picker-heading", text: "Basic blocks" }));
    box.append(menuList(items.map((item) => ({ label: item.label, description: item.description, icon: item.icon, onSelect: () => onPick(item.type) }))));
  };
  render(filter.toLowerCase());
  const popover = openPopover(anchor, box, { width: 320, focusFirst: false });
  popover.filter = (needle) => render(needle.toLowerCase());
  return popover;
}

/** Focus the first menu item of the open block menu (Enter from the block that triggered it). */
export function pickFirstMenuItem(popover) {
  const first = $$(".menu-item:not(:disabled)", popover)[0];
  first?.click();
}

export function checkboxControl(checked, onToggle, label) {
  return checkbox(checked, { onToggle, label });
}
