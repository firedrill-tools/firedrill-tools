// Page-building widgets shared by every screen: headers, sections, key/value grids, tables with cursor
// pagination, status tabs, pickers, timelines and the loading / empty / error / denied states.
import { icon } from "./icons.js";
import { canRead, indexAll, now } from "./store.js";
import { $, ToolError, action, avatar, button, call, cardChip, dateTime, describe, el, field, input, link, money, moneyCell, nextId, openModal, select, text } from "./ui.js";

// ---------------------------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------------------------

export function pageInner(...children) {
  return el("div", { class: "page-inner" }, children);
}

export function pageHeader(title, { subtitle, actions = [], kind, breadcrumbs } = {}) {
  const heading = el("div", { class: "page-heading" });
  if (breadcrumbs) heading.append(breadcrumbsBar(breadcrumbs));
  if (kind) heading.append(el("div", { class: "object-kind", text: kind }));
  heading.append(typeof title === "string" ? el("h1", { class: "page-title", text: title }) : title);
  if (subtitle) heading.append(typeof subtitle === "string" ? el("p", { class: "page-subtitle", text: subtitle }) : subtitle);
  return el("header", { class: "page-header" }, [heading, el("div", { class: "page-actions" }, actions)]);
}

export function breadcrumbsBar(items) {
  const bar = el("nav", { class: "breadcrumbs", attrs: { "aria-label": "Breadcrumb" } });
  items.forEach((item, index) => {
    if (index > 0) bar.append(icon("chevron-right"));
    bar.append(item.href ? el("a", { text: item.label, attrs: { href: item.href } }) : el("span", { text: item.label }));
  });
  return bar;
}

export function section(title, body, { actions = [], count } = {}) {
  const heading = el("h2", { class: "section-title", text: title });
  if (count !== undefined) heading.append(el("span", { class: "section-count", text: String(count) }));
  return el("section", { class: "section" }, [el("div", { class: "section-header" }, [heading, el("div", { class: "section-actions" }, actions)]), ...(Array.isArray(body) ? body : [body])]);
}

/** Key/value grid; `rows` = [[label, valueNodeOrText], …]; null values render as "—". */
export function kv(rows) {
  const grid = el("dl", { class: "kv" });
  for (const [label, value, options = {}] of rows) {
    grid.append(el("dt", { class: "kv-label", text: label }));
    const cell = el("dd", { class: `kv-value ${options.muted ? "muted" : ""}`.trim() });
    if (value === null || value === undefined || value === "") cell.append(el("span", { class: "muted", text: "—" }));
    else if (typeof value === "string" || typeof value === "number") cell.append(text(value));
    else cell.append(value);
    grid.append(cell);
  }
  return grid;
}

export function metaBar(items) {
  return el("div", { class: "meta-bar" }, items.filter(Boolean).map(([label, value]) => el("div", { class: "meta-item" }, [el("span", { class: "meta-label", text: label }), el("span", { class: "meta-value" }, typeof value === "string" ? text(value) : value)])));
}

export function alert(message, tone = "neutral", { title, actions = [], iconName } = {}) {
  const glyph = iconName ?? (tone === "danger" ? "x-circle" : tone === "warning" ? "alert-triangle" : tone === "success" ? "check-circle" : "info");
  const body = el("div", { class: "alert-body" });
  if (title) body.append(el("div", { class: "alert-title", text: title }));
  body.append(typeof message === "string" ? el("div", { class: "alert-text", text: message }) : message);
  const element = el("div", { class: `alert alert-${tone}`, attrs: { role: tone === "danger" ? "alert" : "status" } }, [icon(glyph), body]);
  if (actions.length > 0) element.append(el("div", { class: "btn-group" }, actions));
  return element;
}

export function loading(label = "Loading…") {
  return el("div", { class: "list-loading" }, [icon("spinner", "spin"), el("span", { text: label })]);
}

export function empty(title, body, actionButton) {
  return el("div", { class: "empty" }, [el("div", { class: "empty-title", text: title }), body ? el("div", { text: body }) : null, actionButton ?? null]);
}

/** Panel shown where the key lacks a permission group or the framework denied the operation. */
export function deniedPanel(error, group) {
  const permission = error instanceof ToolError && error.is("PERMISSION_DENIED");
  const level = error?.details?.level ?? "read";
  const title = permission ? `This key does not have ${group ?? "the required"} permission` : "This key is not granted this operation";
  const body = permission
    ? `A restricted key needs the '${group ?? "…"}: ${level}' permission to ${level === "write" ? "do this" : "view this section"}. Ask the account owner for a key with more access.`
    : "The calling actor was not granted this operation in this Firedrill world. Add the grant to the actor to continue.";
  return el("div", { class: "denied-panel" }, [icon("alert-circle"), el("div", { class: "denied-title", text: title }), el("div", { text: body })]);
}

export function errorPanel(error, retry) {
  const actions = retry ? [button("Retry", "secondary", { onClick: retry })] : [];
  if (error instanceof ToolError && (error.denied || error.is("PERMISSION_DENIED"))) return deniedPanel(error, error.details?.group);
  if (error instanceof ToolError && error.is("API_ERROR")) return alert("Stripe is temporarily unavailable (503). Nothing was changed.", "danger", { title: "Something went wrong", actions });
  if (error instanceof ToolError && error.is("RATE_LIMITED")) return alert("Too many requests (429). Wait a moment and try again.", "warning", { title: "Rate limited", actions });
  if (error instanceof ToolError && error.is("RESOURCE_MISSING")) return alert(error.message, "neutral", { title: "Not found", actions });
  return alert(describe(error), "danger", { title: "Could not load this page", actions });
}

/** Render `task()` into `host` with loading / error states; returns the promise. */
export async function load(host, task, { retry } = {}) {
  host.replaceChildren(loading());
  try {
    const content = await task();
    host.replaceChildren(...(Array.isArray(content) ? content : [content]));
  } catch (error) {
    host.replaceChildren(errorPanel(error, retry));
  }
}

// ---------------------------------------------------------------------------------------------
// Tables with cursor pagination
// ---------------------------------------------------------------------------------------------

/**
 * Build a table. `columns`: [{ label, class, render(row) → node|string, key }]. `onOpen(row)` makes rows clickable
 * (Enter/Space too); `href(row)` adds a real link on the first cell.
 */
export function table({ columns, rows, onOpen, href, rowClass, stack = true, emptyNode, select }) {
  const wrap = el("div", { class: `table-wrap ${stack ? "stack" : ""}`.trim() });
  const element = el("table", { class: `table ${select ? "has-select" : ""}`.trim() });
  const head = el("tr");
  const boxes = [];
  let headBox;
  let bulkBar;
  const refreshBulk = () => {
    const chosen = boxes.filter((box) => box.checked);
    headBox.checked = chosen.length > 0 && chosen.length === boxes.length;
    headBox.indeterminate = chosen.length > 0 && chosen.length < boxes.length;
    bulkBar.hidden = chosen.length === 0;
    bulkBar.firstChild.textContent = `${chosen.length} selected`;
  };
  if (select) {
    headBox = el("input", { attrs: { type: "checkbox", "aria-label": `Select all ${select.label ?? "rows"}` } });
    headBox.addEventListener("change", () => {
      for (const box of boxes) box.checked = headBox.checked;
      refreshBulk();
    });
    head.append(el("th", { class: "col-select", attrs: { scope: "col" } }, headBox));
  }
  for (const column of columns) head.append(el("th", { class: column.class, text: column.label, attrs: { scope: "col" } }));
  element.append(el("thead", {}, head));
  const body = el("tbody");
  if (rows.length === 0 && emptyNode) {
    wrap.append(emptyNode);
    return wrap;
  }
  for (const row of rows) {
    const tr = el("tr", { class: rowClass?.(row), attrs: { tabindex: onOpen ? 0 : undefined } });
    if (select) {
      const box = el("input", { attrs: { type: "checkbox", "aria-label": `Select ${select.rowLabel ? select.rowLabel(row) : "row"}` } });
      box.addEventListener("change", refreshBulk);
      boxes.push(box);
      tr.append(el("td", { class: "col-select" }, box));
    }
    columns.forEach((column, index) => {
      const value = column.render(row);
      const cell = el("td", { class: column.class, attrs: { "data-label": column.label } });
      if (index === 0 && href) {
        const target = href(row);
        const anchor = el("a", { class: "row-link", attrs: { href: target } });
        anchor.append(typeof value === "string" ? text(value) : value);
        cell.append(anchor);
      } else if (value === null || value === undefined) cell.append(el("span", { class: "muted", text: "—" }));
      else cell.append(typeof value === "string" || typeof value === "number" ? text(value) : value);
      tr.append(cell);
    });
    if (onOpen) {
      tr.addEventListener("click", (event) => {
        if (event.target.closest("button, a, input, select, .menu")) return;
        onOpen(row);
      });
      tr.addEventListener("keydown", (event) => {
        if ((event.key === "Enter" || event.key === " ") && event.target === tr) {
          event.preventDefault();
          onOpen(row);
        }
      });
    } else tr.classList.add("static");
    body.append(tr);
  }
  element.append(body);
  wrap.append(element);
  if (select) {
    const actions = (select.actions ?? ["Export selected", "Edit", "Delete"]).map((label) => {
      const button = el("button", { class: "btn btn-secondary btn-sm", text: label, title: `${label} (not simulated)`, attrs: { type: "button" } });
      button.addEventListener("click", () => notSimulated(label, "Bulk actions on selected rows are not simulated by this Tool."));
      return button;
    });
    bulkBar = el("div", { class: "bulk-bar", attrs: { role: "status", hidden: "" } }, [el("span", { class: "bulk-count", text: "0 selected" }), ...actions]);
    bulkBar.hidden = true;
    wrap.append(bulkBar);
  }
  return wrap;
}

/**
 * Cursor-paginated list bound to a Tool list operation. `options`: { operation, args, limit, table (rows → node),
 * emptyNode, host, pageSizeLabel }. Returns { element, reload }. Previous/Next use `ending_before`/`starting_after`.
 */
export function pagedList({ operation, args = {}, limit = 20, render, emptyNode, filterNote, transform }) {
  const host = el("div", { class: "paged-list" });
  const body = el("div", { class: "paged-body" });
  const pager = el("div", { class: "pager" });
  host.append(body, pager);
  const state = { cursors: [], direction: "forward", items: [], hasMore: false, error: undefined };

  async function fetchPage() {
    body.replaceChildren(loading());
    pager.replaceChildren();
    try {
      const cursor = state.cursors[state.cursors.length - 1];
      const request = { ...args, limit };
      if (cursor?.after) request.starting_after = cursor.after;
      if (cursor?.before) request.ending_before = cursor.before;
      const page = await call(operation, request);
      let items = page.data;
      if (transform) items = await transform(items);
      state.items = items;
      state.hasMore = page.has_more;
      state.error = undefined;
      renderPage();
    } catch (error) {
      state.error = error;
      body.replaceChildren(errorPanel(error, () => void fetchPage()));
    }
  }

  function renderPage() {
    const content = state.items.length === 0 ? (emptyNode?.() ?? empty("No results")) : render(state.items);
    body.replaceChildren(content);
    const count = el("span", { class: "pager-count", text: state.items.length === 0 ? "" : `${state.items.length} result${state.items.length === 1 ? "" : "s"}${state.hasMore || state.cursors.length > 0 ? " on this page" : ""}` });
    if (filterNote) count.append(el("span", { class: "muted", text: ` · ${filterNote}` }));
    const previous = button("Previous", "secondary", {
      size: "sm",
      disabled: state.cursors.length === 0,
      onClick: () => {
        state.cursors.pop();
        void fetchPage();
      },
    });
    const canNext = state.hasMore || (state.cursors.length > 0 && state.cursors[state.cursors.length - 1].before !== undefined);
    const next = button("Next", "secondary", {
      size: "sm",
      disabled: !canNext || state.items.length === 0,
      onClick: () => {
        const last = state.items[state.items.length - 1];
        state.cursors.push({ after: last.id });
        void fetchPage();
      },
    });
    pager.replaceChildren(count, el("div", { class: "btn-group" }, [previous, next]));
  }

  void fetchPage();
  return { element: host, reload: () => void fetchPage(), state };
}

/** Client-side paginated list over a bounded index (used where the provider offers no status filter). */
export function indexedList({ items, complete, pageSize = 20, render, emptyNode, note }) {
  const host = el("div", { class: "paged-list" });
  const body = el("div");
  const pager = el("div", { class: "pager" });
  host.append(body, pager);
  let page = 0;
  function draw() {
    const slice = items.slice(page * pageSize, (page + 1) * pageSize);
    body.replaceChildren(slice.length === 0 ? (emptyNode?.() ?? empty("No results")) : render(slice));
    const label = items.length === 0 ? "" : `${items.length}${complete ? "" : "+"} result${items.length === 1 ? "" : "s"}`;
    const count = el("span", { class: "pager-count", text: label });
    if (note) count.append(el("span", { class: "muted", text: ` · ${note}` }));
    if (!complete) count.append(el("span", { class: "muted", text: " · index bounded at 1,000 records" }));
    const previous = button("Previous", "secondary", { size: "sm", disabled: page === 0, onClick: () => { page -= 1; draw(); } });
    const next = button("Next", "secondary", { size: "sm", disabled: (page + 1) * pageSize >= items.length, onClick: () => { page += 1; draw(); } });
    pager.replaceChildren(count, el("div", { class: "btn-group" }, [previous, next]));
  }
  draw();
  return host;
}

/** Note shown wherever a bounded index (see store.indexAll) stopped before the end: never truncate silently. */
export function boundNote(index, noun, href) {
  if (index.complete) return null;
  return el("p", { class: "muted bound-note", attrs: { "data-bound": "true" } }, [text(`Showing the first ${index.items.length.toLocaleString("en-US")} ${noun}; more exist.`), href ? text(" ") : null, href ? link(href, `View all ${noun}`, { class: "link" }) : null]);
}

/**
 * Server-paged merge of several newest-first list operations (e.g. charges and refunds). Each stream keeps its own
 * `starting_after` cursor, so every record of every stream is reachable: no index bound. `streams`: [{ operation,
 * args, map(record) → { at, … } }]. Previous restores the snapshot taken before Next.
 */
export function mergedList({ streams, pageSize = 20, render, emptyNode, note }) {
  const host = el("div", { class: "paged-list" });
  const body = el("div", { class: "paged-body" });
  const pager = el("div", { class: "pager" });
  host.append(body, pager);
  const initial = () => streams.map(() => ({ buffer: [], after: undefined, exhausted: false }));
  let cursor = initial();
  const history = [];
  let rows = [];
  let nextCursor = cursor;

  const clone = (states) => states.map((state) => ({ buffer: [...state.buffer], after: state.after, exhausted: state.exhausted }));
  async function fill(states, index) {
    const state = states[index];
    if (state.buffer.length > 0 || state.exhausted) return;
    const stream = streams[index];
    const page = await call(stream.operation, { ...stream.args, limit: pageSize, ...(state.after === undefined ? {} : { starting_after: state.after }) });
    state.buffer = page.data.map((record) => stream.map(record));
    if (page.data.length > 0) state.after = page.data[page.data.length - 1].id;
    state.exhausted = !page.has_more || page.data.length === 0;
  }
  async function fetchPage() {
    body.replaceChildren(loading());
    pager.replaceChildren();
    try {
      const states = clone(cursor);
      const picked = [];
      while (picked.length < pageSize) {
        for (let index = 0; index < states.length; index += 1) await fill(states, index);
        let best = -1;
        states.forEach((state, index) => {
          if (state.buffer.length > 0 && (best === -1 || state.buffer[0].at > states[best].buffer[0].at)) best = index;
        });
        if (best === -1) break;
        picked.push(states[best].buffer.shift());
      }
      for (let index = 0; index < states.length; index += 1) await fill(states, index);
      rows = picked;
      nextCursor = states;
      draw();
    } catch (error) {
      body.replaceChildren(errorPanel(error, () => void fetchPage()));
    }
  }
  function draw() {
    const hasMore = nextCursor.some((state) => state.buffer.length > 0);
    body.replaceChildren(rows.length === 0 ? (emptyNode?.() ?? empty("No results")) : render(rows));
    const count = el("span", { class: "pager-count", text: rows.length === 0 ? "" : `${rows.length} result${rows.length === 1 ? "" : "s"}${hasMore || history.length > 0 ? " on this page" : ""}` });
    if (note) count.append(el("span", { class: "muted", text: ` · ${note}` }));
    const previous = button("Previous", "secondary", { size: "sm", disabled: history.length === 0, onClick: () => { cursor = history.pop(); void fetchPage(); } });
    const next = button("Next", "secondary", { size: "sm", disabled: !hasMore, onClick: () => { history.push(cursor); cursor = nextCursor; void fetchPage(); } });
    pager.replaceChildren(count, el("div", { class: "btn-group" }, [previous, next]));
  }
  void fetchPage();
  return { element: host, reload: () => void fetchPage() };
}

/** Status "stat tabs" (label + count) the list pages show above their tables. */
export function statTabs(tabs, selected, onSelect) {
  const bar = el("div", { class: "stat-tabs", attrs: { role: "tablist" } });
  for (const tab of tabs) {
    const element = el("button", { class: `stat-tab ${tab.notSimulated ? "is-not-simulated" : ""}`.trim(), title: tab.title, attrs: { type: "button", role: "tab", "aria-selected": String(tab.key === selected) } }, [el("span", { class: "stat-tab-label", text: tab.label }), el("span", { class: "stat-tab-count", text: tab.count === undefined ? "–" : String(tab.count) })]);
    if (tab.notSimulated) {
      element.title = tab.title ?? `${tab.label} (not simulated)`;
      element.addEventListener("click", () => notSimulated(tab.label, tab.notSimulated));
    } else element.addEventListener("click", () => onSelect(tab.key));
    bar.append(element);
  }
  return bar;
}

export function tabs(items, selected, onSelect) {
  const bar = el("div", { class: "tabs", attrs: { role: "tablist" } });
  for (const item of items) {
    const element = el("button", { class: "tab", text: item.label, attrs: { type: "button", role: "tab", "aria-selected": String(item.key === selected) } });
    if (item.notSimulated) {
      element.title = `${item.label} (not simulated)`;
      element.addEventListener("click", () => notSimulated(item.label, item.notSimulated));
    } else element.addEventListener("click", () => onSelect(item.key));
    bar.append(element);
  }
  return bar;
}

/**
 * Dashboard filter chip: a dashed pill with a circled plus while unset; once set it turns solid and shows
 * "(x) Label | value" where the circled x clears it.
 */
export function chip(label, { active = false, value, onClick, onClear } = {}) {
  const element = el("button", { class: `chip ${active ? "is-active" : ""}`.trim(), attrs: { type: "button", "aria-label": active && value ? `${label}: ${value}` : `Filter by ${label.toLowerCase()}` } });
  const glyph = icon(active ? "x-circle-outline" : "plus-circle", "chip-glyph");
  element.append(glyph, el("span", { class: "chip-label", text: label }));
  if (active && value) element.append(el("span", { class: "chip-sep", attrs: { "aria-hidden": "true" } }), el("span", { class: "chip-value", text: value }), icon("chevron-down", "chip-caret"));
  if (onClick) element.addEventListener("click", (event) => {
    if (active && onClear && event.target.closest(".chip-glyph")) {
      event.stopPropagation();
      onClear();
      return;
    }
    onClick(event);
  });
  return element;
}

/**
 * Short panel for a Dashboard control whose feature this Tool does not simulate. It never shows invented data.
 */
export function notSimulated(feature, detail) {
  openModal({
    title: feature,
    size: "modal-sm",
    body: [
      el("div", { class: "not-simulated" }, [icon("flask", "not-simulated-icon"), el("div", {}, [el("p", { class: "modal-text", text: `${feature} is not simulated by this Tool.` }), el("p", { class: "muted", text: detail ?? "This synthetic Stripe account only models customers, payment methods, payments, refunds, the product catalog, invoices, subscriptions and the balance. The control is shown so the Dashboard looks the way you know it." })])]),
    ],
    actions: [{ label: "Close", kind: "secondary" }],
  });
}

/** Wire a control to the not-simulated panel and give it the matching tooltip. */
export function markNotSimulated(control, feature, detail) {
  control.title = control.title || `${feature} (not simulated)`;
  control.dataset.notSimulated = "true";
  control.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    notSimulated(feature, detail);
  });
  return control;
}

/** Right-hand list toolbar the Dashboard shows beside the filter chips (Export, Edit columns, …). */
export function listTools(extra = []) {
  const tools = el("div", { class: "list-tools" });
  for (const [label, glyph, detail] of [...extra, ["Export", "download", "Exports (CSV downloads and scheduled reports) are not produced by this synthetic account."], ["Edit columns", "columns", "Column customisation is not simulated; the table shows the Dashboard's default columns."]]) {
    tools.append(markNotSimulated(button(label, "secondary", { size: "sm", icon: glyph }), label, detail));
  }
  return tools;
}

// ---------------------------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------------------------

export function customerCell(customer, { showAvatar = false } = {}) {
  if (!customer) return el("span", { class: "muted", text: "Guest" });
  if (typeof customer === "string") return link(`#/customers/${customer}`, customer, { class: "link-quiet" });
  const name = customer.name || customer.email || customer.id;
  const nodes = [el("span", { class: "customer-cell-text" }, [el("span", { class: "truncate", text: name }), customer.name && customer.email ? el("span", { class: "customer-cell-sub", text: customer.email }) : null])];
  const anchor = link(`#/customers/${customer.id}`, "", { class: "link-quiet" });
  anchor.append(el("span", { class: "customer-cell" }, showAvatar ? [avatar(name, customer.id, "sm"), ...nodes] : nodes));
  return anchor;
}

export function dateCell(seconds) {
  return el("span", { class: "nowrap muted", text: dateTime(seconds, now()) });
}

export function amountWithStatus(amount, currency, status) {
  return el("span", { class: "amount-status" }, [moneyCell(amount, currency), status]);
}

// ---------------------------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------------------------

/** `events`: [{ title, at (seconds), text, tone, icon }] newest first. */
export function timeline(events) {
  const list = el("ol", { class: "timeline" });
  for (const event of events) {
    const item = el("li", { class: "timeline-item" });
    item.append(el("span", { class: `timeline-dot ${event.tone ?? ""}`.trim() }, icon(event.icon ?? "dot")));
    item.append(el("div", { class: "timeline-title", text: event.title }));
    if (event.at !== undefined) item.append(el("div", { class: "timeline-time", text: dateTime(event.at, now()) }));
    if (event.text) item.append(el("div", { class: "timeline-text", text: event.text }));
    list.append(item);
  }
  return list;
}

// ---------------------------------------------------------------------------------------------
// Pickers
// ---------------------------------------------------------------------------------------------

/**
 * Searchable customer combobox backed by `customers.list` (bounded index). `options.value` preselects an id.
 * Returns the field element with `.value` (customer id or "") and `.customer` (the record).
 */
export function customerPicker({ value, onChange, placeholder = "Find or add a customer…" } = {}) {
  const box = el("div", { class: "combobox" });
  const control = input({ placeholder });
  const listHost = el("div", { class: "combobox-list", attrs: { role: "listbox" } });
  listHost.hidden = true;
  box.append(control, listHost);
  box.value = value ?? "";
  box.customer = undefined;
  let customers = [];
  let loaded = false;
  let complete = true;
  let lookup = 0;
  let active = -1;

  async function ensure() {
    if (loaded) return;
    try {
      const index = await indexAll("customers.list", {});
      customers = index.items;
      complete = index.complete;
      loaded = true;
      if (box.value && !box.customer) {
        const match = customers.find((customer) => customer.id === box.value);
        if (match) choose(match, false);
        else if (!complete) await call("customers.retrieve", { customer: box.value }).then((record) => choose(record, false), () => undefined);
      }
    } catch (error) {
      listHost.replaceChildren(el("div", { class: "combobox-empty", text: describe(error) }));
      listHost.hidden = false;
    }
  }
  function label(customer) {
    return customer.name || customer.email || customer.id;
  }
  function choose(customer, fire = true) {
    box.value = customer.id;
    box.customer = customer;
    control.value = customer.email && customer.name ? `${customer.name} (${customer.email})` : label(customer);
    listHost.hidden = true;
    control.setAttribute("aria-expanded", "false");
    if (fire) onChange?.(customer);
  }
  function draw() {
    const raw = control.value.trim();
    const query = raw.toLowerCase();
    const hits = customers.filter((customer) => !query || label(customer).toLowerCase().includes(query) || (customer.email ?? "").toLowerCase().includes(query) || customer.id.toLowerCase() === query).slice(0, 8);
    const token = (lookup += 1);
    if (hits.length === 0 && !complete && query && (raw.includes("@") || raw.startsWith("cus_"))) {
      // The local index stops at its bound: look the exact e-mail or id up on the server instead of claiming "no match".
      showHits([], "Looking up…");
      const request = raw.startsWith("cus_") ? call("customers.retrieve", { customer: raw }).then((record) => [record]) : call("customers.list", { email: raw, limit: 8 }).then((page) => page.data);
      request.then((found) => { if (token === lookup) showHits(found, "No customer has this e-mail or id"); }, () => { if (token === lookup) showHits([], "No customer has this e-mail or id"); });
      return;
    }
    const bound = `No match among the first ${customers.length.toLocaleString("en-US")} customers; type an exact e-mail or cus_… id`;
    showHits(hits, customers.length === 0 ? "No customers yet" : complete ? "No customers match" : bound);
    if (!complete && hits.length > 0 && !query) listHost.append(el("div", { class: "combobox-empty", text: `Showing matches among the first ${customers.length.toLocaleString("en-US")} customers` }));
  }
  function showHits(hits, emptyText) {
    listHost.replaceChildren();
    if (hits.length === 0) listHost.append(el("div", { class: "combobox-empty", text: emptyText }));
    hits.forEach((customer, index) => {
      const option = el("button", { class: "combobox-option", attrs: { type: "button", role: "option", "aria-selected": String(index === active) } }, [avatar(label(customer), customer.id, "sm"), el("span", { class: "truncate", text: label(customer) }), customer.email ? el("span", { class: "combobox-option-sub", text: customer.email }) : null]);
      option.addEventListener("mousedown", (event) => event.preventDefault());
      option.addEventListener("click", () => choose(customer));
      listHost.append(option);
    });
    listHost.hidden = false;
    control.setAttribute("aria-expanded", "true");
  }
  control.addEventListener("focus", () => void ensure().then(draw));
  control.addEventListener("input", () => {
    box.value = "";
    box.customer = undefined;
    onChange?.(undefined);
    active = -1;
    draw();
  });
  control.addEventListener("blur", () => {
    listHost.hidden = true;
    control.setAttribute("aria-expanded", "false");
  });
  control.addEventListener("keydown", (event) => {
    const options = [...listHost.querySelectorAll(".combobox-option")];
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (listHost.hidden) draw();
      active = event.key === "ArrowDown" ? Math.min(active + 1, options.length - 1) : Math.max(active - 1, 0);
      options.forEach((option, index) => option.setAttribute("aria-selected", String(index === active)));
      event.preventDefault();
    } else if (event.key === "Enter" && !listHost.hidden && active >= 0) {
      event.preventDefault();
      options[active]?.click();
    } else if (event.key === "Escape") {
      listHost.hidden = true;
    }
  });
  control.setAttribute("role", "combobox");
  control.setAttribute("aria-expanded", "false");
  control.setAttribute("aria-autocomplete", "list");
  if (value) void ensure();
  box.control = control;
  box.reset = () => {
    box.value = "";
    box.customer = undefined;
    control.value = "";
  };
  return box;
}

/** Stripe's published test cards, offered wherever a payment method can be chosen. */
export const TEST_CARDS = Object.freeze([
  { id: "pm_card_visa", label: "Visa •••• 4242", note: "Succeeds" },
  { id: "pm_card_visa_debit", label: "Visa debit •••• 5556", note: "Succeeds" },
  { id: "pm_card_mastercard", label: "Mastercard •••• 4444", note: "Succeeds" },
  { id: "pm_card_amex", label: "American Express •••• 8431", note: "Succeeds" },
  { id: "pm_card_chargeDeclined", label: "Visa •••• 0002", note: "Generic decline" },
  { id: "pm_card_chargeDeclinedInsufficientFunds", label: "Visa •••• 9995", note: "Insufficient funds" },
  { id: "pm_card_authenticationRequired", label: "Visa •••• 3155", note: "Requires 3D Secure" },
]);

/**
 * Payment-method chooser: the customer's attached cards (from `payment_methods.list`) followed by the test cards.
 * Returns an element with `.value` (a `pm_…` id or "") and `.setCustomer(id)`.
 */
export function methodPicker({ customer, value, includeTestCards = true, allowNone = false, noneLabel = "No payment method" } = {}) {
  const host = el("div", { class: "pm-list" });
  host.value = value ?? "";
  let attached = [];
  let attachedComplete = true;
  const name = nextId("pm");
  function optionRow(id, labelNode, note, checked) {
    const radio = el("input", { attrs: { type: "radio", name, value: id } });
    radio.checked = checked;
    radio.addEventListener("change", () => {
      host.value = id;
    });
    const row = el("label", { class: "pm-option" }, [radio, labelNode, note ? el("span", { class: "pm-option-note", text: note }) : null]);
    return row;
  }
  function draw() {
    host.replaceChildren();
    if (allowNone) host.append(optionRow("", el("span", { text: noneLabel }), undefined, host.value === ""));
    if (customer) {
      host.append(el("div", { class: "form-section-title", text: "Customer's saved cards" }));
      if (attached.length === 0) host.append(el("div", { class: "muted", text: "No cards attached to this customer yet." }));
      for (const method of attached) host.append(optionRow(method.id, cardChip(method, { expiry: true }), method.isDefault ? "Default" : undefined, host.value === method.id));
      if (!attachedComplete) host.append(el("div", { class: "muted bound-note", attrs: { "data-bound": "true" }, text: `Showing the first ${attached.length.toLocaleString("en-US")} saved cards of this customer; more exist.` }));
    }
    if (includeTestCards) {
      host.append(el("div", { class: "form-section-title", text: "Test cards" }));
      for (const card of TEST_CARDS) host.append(optionRow(card.id, el("span", { text: card.label }), card.note, host.value === card.id));
    }
  }
  host.setCustomer = async (id, defaultMethod) => {
    customer = id;
    attached = [];
    attachedComplete = true;
    if (id && canRead("payment_methods")) {
      try {
        const index = await indexAll("payment_methods.list", { customer: id });
        attached = index.items.map((method) => ({ ...method, isDefault: method.id === defaultMethod }));
        attachedComplete = index.complete;
        if (!host.value && defaultMethod && attached.some((method) => method.id === defaultMethod)) host.value = defaultMethod;
      } catch {
        attached = [];
      }
    }
    draw();
  };
  draw();
  if (customer) void host.setCustomer(customer);
  return host;
}

/** Amount input with a currency select ("18.90" + USD). Returns element with `.amount()` (minor units | undefined) and `.currency()`. */
export function amountInput({ amount, currency = "usd", currencies, disabled = false } = {}) {
  const value = input({ placeholder: "0.00", inputmode: "decimal", value: amount ?? "" });
  const currencySelect = select((currencies ?? ["usd", "eur", "gbp", "cad", "aud", "chf", "sek", "nok", "dkk", "jpy", "nzd", "sgd"]).map((code) => ({ value: code, label: code.toUpperCase() })), currency);
  currencySelect.setAttribute("aria-label", "Currency");
  currencySelect.name = "currency";
  if (disabled) {
    value.disabled = true;
    currencySelect.disabled = true;
  }
  const group = el("div", { class: "amount-input" }, [value, currencySelect]);
  group.input = value;
  group.select = currencySelect;
  group.currency = () => currencySelect.value;
  group.amount = () => {
    const cleaned = value.value.replace(/[,\s]/g, "");
    if (!/^-?\d+(\.\d{0,2})?$/.test(cleaned)) return undefined;
    const [whole, fraction = ""] = cleaned.split(".");
    if (currencySelect.value === "jpy") return fraction && Number(fraction) !== 0 ? undefined : Number(whole);
    const negative = whole.startsWith("-");
    return (negative ? -1 : 1) * (Math.abs(Number(whole)) * 100 + Number(fraction.padEnd(2, "0")));
  };
  return group;
}

/** Field + control shortcut used by the create forms. */
export function formField(label, control, options) {
  return field(label, control, options);
}

/** Run a mutation from a modal: shows the busy state, applies field/summary errors, closes on success. */
export async function submitModal(api, fields, task, onSuccess) {
  api.setError(undefined);
  for (const entry of Object.values(fields)) entry.setError?.(undefined);
  api.setBusy(true);
  try {
    const value = await action(task, { onError: (error) => applyError(error, fields, api) });
    if (value !== undefined) {
      api.close("ok");
      onSuccess?.(value);
    }
  } finally {
    api.setBusy(false);
  }
}

export function applyError(error, fields, api) {
  const message = describe(error);
  const param = error instanceof ToolError ? error.param : undefined;
  const base = param ? param.replace(/\[.*$/, "") : undefined;
  if (base && fields[base]?.setError) {
    fields[base].setError(message);
    fields[base].querySelector?.("input, select, textarea")?.focus();
  } else api.setError(message);
}

export function moneyText(amount, currency) {
  return money(amount, currency);
}

