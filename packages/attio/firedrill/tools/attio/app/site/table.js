// Object table (People / Companies / Deals): view bar, sort, filters, search, inline editing, bulk delete, pagination.
import { icon, typeIcon } from "./icons.js";
import { attributes, loadNames, recordTitle, resolveNames, store } from "./store.js";
import { action, button, call, confirmDialog, el, newKey, toast } from "./ui.js";
import { editValue, recordAvatar, renderValues } from "./values.js";
import { errorState, loadingRows, nsButton, objectCrumb, pageHeader, stateBox } from "./shell.js";
import { combine, filterChip, openFilterPopover, openSortMenu } from "./filterbar.js";
import { openCreateRecord } from "./create.js";

const PAGE = 50;
const views = new Map();
const viewOf = (key) => {
  if (!views.has(key)) views.set(key, { sort: null, filters: [], page: 0, q: "" });
  return views.get(key);
};

/** Keyboard movement between focusable cells of a grid. */
export function gridKeys(table) {
  table.addEventListener("keydown", (event) => {
    const cell = event.target.closest?.("td[tabindex]");
    if (!cell) return;
    const row = cell.parentElement;
    const moves = { ArrowRight: [0, 1], ArrowLeft: [0, -1], ArrowDown: [1, 0], ArrowUp: [-1, 0] };
    if (!moves[event.key]) return;
    const [dr, dc] = moves[event.key];
    const rows = [...row.parentElement.children];
    const next = rows[rows.indexOf(row) + dr]?.children[[...row.children].indexOf(cell) + dc];
    if (next?.hasAttribute("tabindex")) {
      event.preventDefault();
      next.focus();
    }
  });
}

export async function renderObject(main, { alive, slug }) {
  const object = store.objectsBySlug.get(slug);
  const view = viewOf(`objects/${slug}`);
  const selected = new Set();
  let defs = [];
  let modal;

  const newButton = button(`New ${object.singular_noun.toLowerCase()}`, { class: "primary", icon: "plus" });
  const header = pageHeader([objectCrumb(object)], [nsButton("Import / Export", "CSV import and export are not simulated.", { icon: "download" }), newButton]);
  const viewPill = el("button", { class: "at-view-pill", attrs: { type: "button", "aria-haspopup": "menu" } }, [icon("table"), el("span", { text: `All ${object.plural_noun}` }), icon("chevronDown", "at-caret")]);
  viewPill.addEventListener("click", () => import("./ui.js").then(({ menu }) => menu(viewPill, [{ header: "Views" }, { label: `All ${object.plural_noun}`, icon: "table", checked: true }, "divider", { label: "Create view", icon: "plus", notSimulated: "Saved views are not simulated; sorts and filters apply to this browser tab only." }], { width: 240 })));
  const viewbar = el("div", { class: "at-viewbar" }, [viewPill, el("span", { class: "grow" }), nsButton("View settings", "Column order and visibility follow attribute positions and are not configurable here.", { icon: "settings", class: "ghost" })]);
  const sortBtn = button(view.sort ? "Sorted" : "Sort", { icon: "sort", class: `ghost${view.sort ? " active" : ""}`, onClick: () => openSortMenu(sortBtn, defs, view.sort, (s) => { view.sort = s; view.page = 0; void rerender(); }) });
  const filterBtn = button("Filter", { icon: "filter", class: "ghost", onClick: () => openFilterPopover(filterBtn, defs, { target: "objects", slug }, (f) => { view.filters.push(f); view.page = 0; void rerender(); }) });
  const chips = el("span", { class: "at-toolbar" });
  chips.style.padding = "0";
  view.filters.forEach((f, i) => chips.append(filterChip(f.label, () => { view.filters.splice(i, 1); view.page = 0; void rerender(); })));
  const bulk = el("span");
  const search = el("input", { attrs: { type: "search", placeholder: `Search ${object.plural_noun.toLowerCase()}…`, "aria-label": `Search ${object.plural_noun}` } });
  search.value = view.q;
  let timer;
  search.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => { view.q = search.value.trim(); view.page = 0; void load(); }, 250); });
  const toolbar = el("div", { class: "at-toolbar" }, [sortBtn, filterBtn, chips, bulk, el("span", { class: "grow" }), el("label", { class: "at-search-box" }, [icon("search"), search])]);
  toolbar.querySelector(".grow").style.flex = "1";
  const wrap = el("div", { class: "at-table-wrap" });
  const footer = el("div", { class: "at-footer" });
  main.replaceChildren(header, viewbar, toolbar, wrap, footer);

  const rerender = () => renderObject(main, { alive, slug });
  newButton.addEventListener("click", () => {
    modal = openCreateRecord(object, defs, (record, more) => {
      toast(`${object.singular_noun} created`);
      if (!more) location.hash = `#/${slug}/${record.id.record_id}`;
    });
    void modal.promise.then(() => { modal = undefined; void load(); });
  });

  const refreshBulk = () => {
    bulk.replaceChildren();
    if (selected.size === 0) return;
    bulk.append(button(`Delete ${selected.size} ${selected.size === 1 ? "record" : "records"}`, { class: "danger small", icon: "trash", onClick: async () => {
      const ok = await confirmDialog(`Delete ${selected.size} ${selected.size === 1 ? object.singular_noun.toLowerCase() : object.plural_noun.toLowerCase()}?`, "Deleted records are removed from every list, and references to them are cleared. This cannot be undone.");
      if (!ok) return;
      await action(async () => {
        for (const id of [...selected]) {
          await call("records.delete", { object: slug, record_id: id }, newKey());
          selected.delete(id);
        }
        toast("Records deleted");
      });
      void load();
    } }));
  };

  async function load() {
    wrap.replaceChildren(el("table", { class: "at-table" }, loadingRows(6)));
    footer.replaceChildren();
    try {
      defs = (await attributes("objects", slug)).filter((d) => !d.is_archived && d.api_slug !== "record_id");
      await loadNames();
      let records;
      let hasMore = false;
      if (view.q) {
        const hits = (await call("records.search", { query: view.q, objects: [slug], request_as: { type: "workspace" }, limit: 25 })).data;
        records = (await Promise.all(hits.map((h) => call("records.get", { object: slug, record_id: h.id.record_id })))).map((r) => r.data);
      } else {
        const args = { object: slug, limit: PAGE, offset: view.page * PAGE };
        const filter = combine(view.filters);
        if (filter) args.filter = filter;
        if (view.sort) args.sorts = [view.sort];
        records = (await call("records.query", args)).data;
        hasMore = records.length === PAGE;
      }
      await resolveNames(records);
      if (!alive()) return;
      drawTable(records, hasMore);
    } catch (error) {
      if (alive()) wrap.replaceChildren(errorState(error, load));
    }
  }

  function drawTable(records, hasMore) {
    const primary = defs.find((d) => d.api_slug === "name") ?? defs[0];
    const columns = defs.filter((d) => d !== primary);
    if (records.length === 0) {
      const filtered = view.q || view.filters.length > 0;
      wrap.replaceChildren(stateBox({ iconName: filtered ? "search" : "inbox", title: filtered ? "No results" : `No ${object.plural_noun.toLowerCase()} yet`, text: filtered ? "No records match your search or filters." : `Create your first ${object.singular_noun.toLowerCase()} to get started.`, action: filtered ? null : button(`New ${object.singular_noun.toLowerCase()}`, { class: "primary", icon: "plus", onClick: () => newButton.click() }) }));
    } else {
      wrap.replaceChildren(buildTable(records, primary, columns));
    }
    const from = view.q ? 1 : view.page * PAGE + 1;
    const prev = button("", { icon: "chevronLeft", class: "small ghost", ariaLabel: "Previous page", disabled: view.page === 0 || Boolean(view.q), onClick: () => { view.page -= 1; void load(); } });
    const next = button("", { icon: "chevronRight", class: "small ghost", ariaLabel: "Next page", disabled: !hasMore, onClick: () => { view.page += 1; void load(); } });
    footer.replaceChildren(el("span", { text: records.length === 0 ? `0 ${object.plural_noun.toLowerCase()}` : `${from}–${from + records.length - 1}${hasMore ? " of many" : ""} ${object.plural_noun.toLowerCase()}` }), el("span", { class: "grow" }), view.q ? el("span", { text: records.length >= 25 ? "Showing the top 25 search matches; refine the search to narrow them" : "Showing top search matches" }) : el("span", { text: `Page ${view.page + 1}` }), prev, next);
  }

  function buildTable(records, primary, columns) {
    const allBox = el("input", { class: "at-cb", attrs: { type: "checkbox", "aria-label": "Select all rows on this page" } });
    allBox.checked = records.length > 0 && records.every((r) => selected.has(r.id.record_id));
    const headCells = [el("th", { class: "at-col-check" }, allBox), el("th", { class: "at-col-primary" }, thButton(primary))];
    for (const d of columns) headCells.push(el("th", {}, thButton(d)));
    headCells.push(el("th", { class: "at-col-add" }, nsButton("Add column", "Creating attributes is not simulated; columns follow the object's attributes.", { icon: "plus", iconOnly: true, class: "ghost small" })), el("th", { class: "at-col-fill" }));
    const tbody = el("tbody");
    const boxes = [];
    for (const record of records) {
      const id = record.id.record_id;
      const name = recordTitle(record);
      const tr = el("tr", { class: selected.has(id) ? "selected" : "" });
      const box = el("input", { class: "at-cb", attrs: { type: "checkbox", "aria-label": `Select ${name}` } });
      box.checked = selected.has(id);
      box.addEventListener("change", () => { if (box.checked) selected.add(id); else selected.delete(id); tr.classList.toggle("selected", box.checked); refreshBulk(); });
      boxes.push([box, id, tr]);
      const link = el("a", { class: "at-primary-link", text: name, attrs: { href: `#/${slug}/${id}` } });
      const open = el("a", { class: "at-open-btn", attrs: { href: `#/${slug}/${id}`, "aria-label": `Open ${name}` } }, [el("span", { text: "Open" }), icon("arrowUpRight", "", 12)]);
      tr.append(el("td", { class: "at-col-check" }, box), el("td", { class: "at-col-primary" }, el("div", { class: "at-primary-cell" }, [recordAvatar(slug, name, id, "tiny"), link, open])));
      for (const d of columns) tr.append(cell(record, d));
      tr.append(el("td"), el("td", { class: "at-col-fill" }));
      tbody.append(tr);
    }
    allBox.addEventListener("change", () => {
      for (const [box, id, tr] of boxes) { box.checked = allBox.checked; tr.classList.toggle("selected", allBox.checked); if (allBox.checked) selected.add(id); else selected.delete(id); }
      refreshBulk();
    });
    const foot = el("tfoot", {}, el("tr", {}, [el("td", { class: "at-col-check" }), el("td", { class: "at-col-primary", text: `${records.length} ${records.length === 1 ? "record" : "records"}` }), ...columns.map(() => el("td", {}, el("span", { class: "at-calc" }, [el("span", { text: "Calculate" }), icon("chevronDown", "", 12)]))), el("td"), el("td", { class: "at-col-fill" })]));
    const table = el("table", { class: "at-table", attrs: { "aria-label": `${object.plural_noun} table` } }, [el("thead", {}, el("tr", {}, headCells)), tbody, foot]);
    gridKeys(table);
    return table;
  }

  function thButton(def) {
    const sorted = view.sort?.attribute === def.api_slug;
    const b = el("button", { class: "at-th-btn", attrs: { type: "button", title: `Sort by ${def.title}` } }, [icon(typeIcon(def.type)), el("span", { text: def.title }), sorted ? icon(view.sort.direction === "asc" ? "chevronUp" : "chevronDown", "at-th-sort", 12) : null]);
    b.addEventListener("click", () => { view.sort = sorted && view.sort.direction === "asc" ? { attribute: def.api_slug, direction: "desc" } : sorted ? null : { attribute: def.api_slug, direction: "asc" }; void rerender(); });
    return b;
  }

  function cell(record, def) {
    const values = record.values[def.api_slug] ?? [];
    const td = el("td", { class: def.is_writable ? "editable" : "", attrs: { tabindex: "0", "aria-label": def.title } }, renderValues(def, values, "cell"));
    if (def.is_writable) {
      const openEditor = () => editValue(td, { target: "objects", slug, def, values, save: async (next) => {
        await call("records.update", { object: slug, record_id: record.id.record_id, mode: "overwrite", data: { values: { [def.api_slug]: next } } }, newKey());
        void load();
      } });
      td.addEventListener("click", (event) => { if (!event.target.closest("a")) openEditor(); });
      td.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); openEditor(); } });
    }
    return td;
  }

  await load();
  return { unsaved: () => Boolean(modal?.unsaved()) };
}
