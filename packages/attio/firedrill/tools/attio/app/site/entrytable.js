// List entries as a table: parent record column plus list attributes; sort, filter, offset pagination, inline edit.
import { icon, typeIcon } from "./icons.js";
import { refName, resolveNames, store } from "./store.js";
import { button, call, confirmDialog, action, el, iconButton, menu, newKey, toast } from "./ui.js";
import { editValue, recordAvatar, renderValues } from "./values.js";
import { errorState, loadingRows, stateBox } from "./shell.js";
import { combine, filterChip, openFilterPopover, openSortMenu } from "./filterbar.js";
import { gridKeys } from "./table.js";

const PAGE = 50;
const views = new Map();

export function entryTable({ list, defs, readOnly, alive, onChanged }) {
  const slug = list.api_slug;
  if (!views.has(slug)) views.set(slug, { sort: null, filters: [], page: 0 });
  const view = views.get(slug);
  const toolbar = el("div", { class: "at-toolbar" });
  const wrap = el("div");
  const footer = el("div", { class: "at-footer" });
  const parentObject = store.objectsBySlug.get(list.parent_object[0]);

  const drawToolbar = () => {
    const sortBtn = button(view.sort ? "Sorted" : "Sort", { icon: "sort", class: `ghost${view.sort ? " active" : ""}`, onClick: () => openSortMenu(sortBtn, defs, view.sort, (s) => { view.sort = s; view.page = 0; void load(); }) });
    const filterBtn = button("Filter", { icon: "filter", class: "ghost", onClick: () => openFilterPopover(filterBtn, defs, { target: "lists", slug }, (f) => { view.filters.push(f); view.page = 0; void load(); }) });
    toolbar.replaceChildren(sortBtn, filterBtn, ...view.filters.map((f, i) => filterChip(f.label, () => { view.filters.splice(i, 1); view.page = 0; void load(); })));
  };

  async function load() {
    drawToolbar();
    wrap.replaceChildren(el("table", { class: "at-table" }, loadingRows(5)));
    try {
      const args = { list: slug, limit: PAGE, offset: view.page * PAGE };
      const filter = combine(view.filters);
      if (filter) args.filter = filter;
      if (view.sort) args.sorts = [view.sort];
      const entries = (await call("entries.query", args)).data;
      await resolveNames(entries);
      if (!alive()) return;
      draw(entries, entries.length === PAGE);
    } catch (error) {
      if (alive()) wrap.replaceChildren(errorState(error, () => void load()));
    }
  }

  function draw(entries, hasMore) {
    if (entries.length === 0) {
      wrap.replaceChildren(stateBox({ iconName: "list", title: view.filters.length ? "No results" : "This list is empty", text: view.filters.length ? "No entries match your filters." : `Add ${parentObject?.plural_noun.toLowerCase() ?? "records"} to this list to get started.` }));
    } else {
      const head = [el("th", { class: "at-col-primary" }, el("span", { class: "at-th" }, [icon("link"), el("span", { text: parentObject?.singular_noun ?? "Record" })]))];
      for (const d of defs) head.push(el("th", {}, el("span", { class: "at-th" }, [icon(typeIcon(d.type)), el("span", { text: d.title })])));
      head.push(el("th", { class: "at-col-fill" }));
      const tbody = el("tbody");
      for (const entry of entries) {
        const name = refName(entry.parent_record_id);
        const more = iconButton("more", `Actions for ${name}`, () => menu(more, [{ label: "Remove from list", icon: "trash", danger: true, disabled: readOnly, onSelect: async () => {
          if (!(await confirmDialog("Remove from list?", `${name} will be removed from ${list.name}. The record itself is kept.`, "Remove"))) return;
          await action(async () => { await call("entries.delete", { list: slug, entry_id: entry.id.entry_id }, newKey()); toast(`Removed ${name}`); onChanged(); });
        } }], { align: "end" }), "small");
        const primary = el("td", { class: "at-col-primary" }, el("div", { class: "at-primary-cell" }, [recordAvatar(entry.parent_object, name, entry.parent_record_id, "tiny"), el("a", { class: "at-primary-link", text: name, attrs: { href: `#/${entry.parent_object}/${entry.parent_record_id}` } }), el("span", { class: "at-open-btn" }, more)]));
        const tr = el("tr", {}, primary);
        for (const d of defs) tr.append(cell(entry, d));
        tr.append(el("td", { class: "at-col-fill" }));
        tbody.append(tr);
      }
      const table = el("table", { class: "at-table", attrs: { "aria-label": `${list.name} entries` } }, [el("thead", {}, el("tr", {}, head)), tbody]);
      table.querySelectorAll("td.at-col-primary").forEach((td) => { td.style.left = "0"; });
      table.querySelector("th.at-col-primary").style.left = "0";
      gridKeys(table);
      wrap.replaceChildren(table);
    }
    const from = view.page * PAGE + 1;
    footer.replaceChildren(
      el("span", { text: entries.length ? `${from}–${from + entries.length - 1} entries` : "0 entries" }),
      el("span", { class: "grow" }),
      el("span", { text: `Page ${view.page + 1}` }),
      button("", { icon: "chevronLeft", class: "small ghost", ariaLabel: "Previous page", disabled: view.page === 0, onClick: () => { view.page -= 1; void load(); } }),
      button("", { icon: "chevronRight", class: "small ghost", ariaLabel: "Next page", disabled: !hasMore, onClick: () => { view.page += 1; void load(); } }),
    );
  }

  function cell(entry, def) {
    const values = entry.entry_values[def.api_slug] ?? [];
    const editable = def.is_writable && !readOnly;
    const td = el("td", { class: editable ? "editable" : "", attrs: { tabindex: "0", "aria-label": def.title } }, renderValues(def, values, "cell"));
    if (editable) {
      const open = () => editValue(td, { target: "lists", slug, def, values, save: async (next) => {
        await call("entries.update", { list: slug, entry_id: entry.id.entry_id, mode: "overwrite", data: { entry_values: { [def.api_slug]: next } } }, newKey());
        void load();
      } });
      td.addEventListener("click", open);
      td.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); open(); } });
    }
    return td;
  }

  return { toolbar, wrap, footer, load };
}
