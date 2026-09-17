// Spreadsheet editor: title bar, menus, toolbar, formula bar, virtualised grid and sheet tabs. Cells are read in
// 100-row chunks with spreadsheets.get(includeGridData, ranges) and written with values.batch-update (USER_ENTERED),
// values.clear and spreadsheets.batch-update; file actions use the Drive operations; sharing uses permissions.*.
import { icon } from "./icons.js";
import {
  $,
  action,
  ago,
  avatar,
  button,
  call,
  closeMenus,
  closeModal,
  confirmDialog,
  describe,
  el,
  iconButton,
  listDate,
  newKey,
  openMenu,
  openModal,
  toast,
  ToolError,
} from "./ui.js";
import { notSimulated, unsupportedItems, unsupportedSubmenu } from "./unsupported.js";

const ROW_H = 21;
const COL_W = 100;
const HEAD_H = 24;
const HEAD_W = 46;
const CHUNK = 100;
const LOGO = "./assets/google-sheets-2026.svg";

const FUNCTIONS = ["SUM", "AVERAGE", "COUNT", "MAX", "MIN", "COUNTA", "COUNTIF", "SUMIF", "IF", "IFERROR", "AND", "OR", "NOT", "ROUND", "ROUNDUP", "ROUNDDOWN", "ABS", "CONCATENATE", "LEN", "UPPER", "LOWER", "TRIM", "LEFT", "RIGHT", "VLOOKUP", "TODAY", "NOW"];
const NUMBER_FORMATS = [
  { id: "automatic", label: "Automatic", format: null },
  { id: "text", label: "Plain text", format: { type: "TEXT", pattern: "@" } },
  "divider",
  { id: "number", label: "Number", hint: "1,000.12", format: { type: "NUMBER", pattern: "#,##0.00" } },
  { id: "percent", label: "Percent", hint: "10.12%", format: { type: "PERCENT", pattern: "0.00%" } },
  { id: "scientific", label: "Scientific", hint: "1.01E+03", format: { type: "SCIENTIFIC", pattern: "0.00E+00" } },
  "divider",
  { id: "currency", label: "Currency", hint: "$1,000.12", format: { type: "CURRENCY", pattern: '"$"#,##0.00' } },
  { id: "currency-rounded", label: "Currency rounded", hint: "$1,000", format: { type: "CURRENCY", pattern: "$#,##0" } },
  "divider",
  { id: "date", label: "Date", hint: "9/26/2008", format: { type: "DATE", pattern: "M/d/yyyy" } },
  { id: "time", label: "Time", hint: "3:59:00 PM", format: { type: "TIME", pattern: "h:mm:ss am/pm" } },
  { id: "datetime", label: "Date time", hint: "9/26/2008 15:59:00", format: { type: "DATE_TIME", pattern: "M/d/yyyy H:mm:ss" } },
];
// Only these decimal variants are rendered by the service's number formatter, so the decimal buttons step between them.
const DECIMALS = {
  "#,##0.00": { less: "#,##0", type: "NUMBER" },
  "#,##0": { more: "#,##0.00", type: "NUMBER" },
  "0.00": { less: "0", type: "NUMBER" },
  "0": { more: "0.00", type: "NUMBER" },
  "0.00%": { less: "0%", type: "PERCENT" },
  "0%": { more: "0.00%", type: "PERCENT" },
  '"$"#,##0.00': { less: "$#,##0", type: "CURRENCY" },
  "$#,##0": { more: '"$"#,##0.00', type: "CURRENCY" },
};
const PALETTE = [
  ["#000000", "#434343", "#666666", "#999999", "#b7b7b7", "#cccccc", "#d9d9d9", "#efefef", "#f3f3f3", "#ffffff"],
  ["#980000", "#ff0000", "#ff9900", "#ffff00", "#00ff00", "#00ffff", "#4a86e8", "#0000ff", "#9900ff", "#ff00ff"],
  ["#e6b8af", "#f4cccc", "#fce5cd", "#fff2cc", "#d9ead3", "#d0e0e3", "#c9daf8", "#cfe2f3", "#d9d2e9", "#ead1dc"],
  ["#dd7e6b", "#ea9999", "#f9cb9c", "#ffe599", "#b6d7a8", "#a2c4c9", "#a4c2f4", "#9fc5e8", "#b4a7d6", "#d5a6bd"],
  ["#cc4125", "#e06666", "#f6b26b", "#ffd966", "#93c47d", "#76a5af", "#6d9eeb", "#6fa8dc", "#8e7cc3", "#c27ba0"],
  ["#a61c00", "#cc0000", "#e69138", "#f1c232", "#6aa84f", "#45818e", "#3c78d8", "#3d85c6", "#674ea7", "#a64d79"],
  ["#85200c", "#990000", "#b45f06", "#bf9000", "#38761d", "#134f5c", "#1155cc", "#0b5394", "#351c75", "#741b47"],
  ["#5b0f00", "#660000", "#783f04", "#7f6000", "#274e13", "#0c343d", "#1c4587", "#073763", "#20124d", "#4c1130"],
];
const ROLE_LABELS = { reader: "Viewer", commenter: "Commenter", writer: "Editor", owner: "Owner" };
const NOT_AVAILABLE = "Not available in this simulated service";

// ---------------------------------------------------------------------------------------------
// A1 helpers
// ---------------------------------------------------------------------------------------------

export function columnName(index) {
  let n = index + 1;
  let name = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    name = String.fromCharCode(65 + m) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}
const columnIndex = (letters) => [...letters.toUpperCase()].reduce((total, ch) => total * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
const a1 = (r, c) => `${columnName(c)}${r + 1}`;
const quoteTitle = (title) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(title) && !/^[A-Za-z]{1,3}[0-9]+$/.test(title) ? title : `'${title.replace(/'/g, "''")}'`);
const rangeText = (sel) => (sel.r0 === sel.r1 && sel.c0 === sel.c1 ? a1(sel.r0, sel.c0) : `${a1(sel.r0, sel.c0)}:${a1(sel.r1, sel.c1)}`);

/** Parse `Sheet!A1:B2`, `'My sheet'!A1`, `A1:B2` or `A1` → { title?, r0, c0, r1, c1 } (inclusive), or null. */
function parseA1(text) {
  const match = /^\s*(?:('(?:[^']|'')+'|[^!']+)!)?\$?([A-Za-z]{1,3})\$?(\d{1,7})(?::\$?([A-Za-z]{1,3})\$?(\d{1,7}))?\s*$/.exec(text);
  if (!match) return null;
  let title;
  if (match[1]) title = match[1].startsWith("'") ? match[1].slice(1, -1).replace(/''/g, "'") : match[1];
  const r0 = Number(match[3]) - 1;
  const c0 = columnIndex(match[2]);
  const r1 = match[5] ? Number(match[5]) - 1 : r0;
  const c1 = match[4] ? columnIndex(match[4]) : c0;
  if (r0 < 0 || r1 < 0) return null;
  return { title, r0: Math.min(r0, r1), r1: Math.max(r0, r1), c0: Math.min(c0, c1), c1: Math.max(c0, c1) };
}

const rgbOf = (color) => {
  if (!color) return undefined;
  const channel = (value) => Math.round((value ?? 0) * 255);
  return `rgb(${channel(color.red)}, ${channel(color.green)}, ${channel(color.blue)})`;
};
const hexToColor = (hex) => ({
  red: Math.round((parseInt(hex.slice(1, 3), 16) / 255) * 10000) / 10000,
  green: Math.round((parseInt(hex.slice(3, 5), 16) / 255) * 10000) / 10000,
  blue: Math.round((parseInt(hex.slice(5, 7), 16) / 255) * 10000) / 10000,
});

export function createEditor(app) {
  const s = {
    id: undefined,
    meta: undefined,
    file: undefined,
    sheetId: undefined,
    rows: new Map(),
    chunks: new Map(),
    dataGen: 0,
    openGen: 0,
    loadError: undefined,
    sel: { r0: 0, c0: 0, r1: 0, c1: 0, ar: 0, ac: 0 },
    anchor: { r: 0, c: 0 },
    edit: undefined,
    queue: Promise.resolve(),
    saving: 0,
    stat: "Sum",
    findCursor: undefined,
  };

  const grid = $("#grid");
  const body = $("#grid-body");
  const spacer = $("#grid-spacer");
  const colhead = $("#grid-colhead");
  const rowhead = $("#grid-rowhead");
  const corner = $("#grid-corner");
  const gridState = $("#grid-state");
  const formulaInput = $("#formula-input");
  const nameBox = $("#name-box");
  const titleInput = $("#doc-title");

  const mainLayer = el("div", { class: "layer gridlines" });
  spacer.append(mainLayer);
  const topOverlay = el("div", { class: "overlay" }, [el("div", { class: "layer gridlines" })]);
  const leftOverlay = el("div", { class: "overlay" }, [el("div", { class: "layer gridlines" })]);
  const cornerOverlay = el("div", { class: "overlay" }, [el("div", { class: "layer gridlines" })]);
  cornerOverlay.style.zIndex = "4";
  const freezeH = el("div", { class: "freeze-bar" });
  const freezeV = el("div", { class: "freeze-bar" });
  grid.append(topOverlay, leftOverlay, cornerOverlay, freezeH, freezeV);

  // -------------------------------------------------------------------------------------------
  // Model helpers
  // -------------------------------------------------------------------------------------------

  const sheets = () => (s.meta?.sheets ?? []).map((sheet) => sheet.properties).sort((a, b) => a.index - b.index);
  const sheetById = (id) => sheets().find((sheet) => sheet.sheetId === id);
  const active = () => sheetById(s.sheetId);
  const dims = () => {
    const sheet = active();
    const g = sheet?.gridProperties ?? {};
    const rows = g.rowCount ?? 1000;
    const cols = g.columnCount ?? 26;
    return { rows, cols, fr: Math.min(g.frozenRowCount ?? 0, rows), fc: Math.min(g.frozenColumnCount ?? 0, cols) };
  };
  const canEdit = () => s.file?.capabilities?.canEdit === true;
  const cellAt = (r, c) => s.rows.get(r)?.[c];
  const hasValue = (cell) => cell !== undefined && cell !== null && cell.formattedValue !== undefined && cell.formattedValue !== "";
  const rangeOfSelection = () => ({
    sheetId: s.sheetId,
    startRowIndex: s.sel.r0,
    endRowIndex: s.sel.r1 + 1,
    startColumnIndex: s.sel.c0,
    endColumnIndex: s.sel.c1 + 1,
  });

  /** The text the user typed, as the formula bar shows it. */
  function enteredText(cell) {
    if (!cell) return "";
    const entered = cell.userEnteredValue;
    if (!entered) return cell.formattedValue ?? "";
    if (entered.formulaValue !== undefined) return entered.formulaValue;
    if (entered.stringValue !== undefined) return entered.stringValue;
    if (entered.boolValue !== undefined) return entered.boolValue ? "TRUE" : "FALSE";
    if (entered.numberValue !== undefined) {
      const type = cell.userEnteredFormat?.numberFormat?.type;
      if (["PERCENT", "DATE", "TIME", "DATE_TIME"].includes(type)) return cell.formattedValue ?? String(entered.numberValue);
      return String(entered.numberValue);
    }
    return cell.formattedValue ?? "";
  }

  // -------------------------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------------------------

  function showGridState(kind, text, retry) {
    if (!kind) {
      gridState.hidden = true;
      return;
    }
    gridState.hidden = false;
    gridState.className = `grid-state ${kind === "error" ? "error" : ""}`;
    const nodes = [];
    if (kind === "loading") nodes.push(el("span", { class: "spinner" }));
    nodes.push(el("div", { text }));
    if (retry) nodes.push(button("Try again", { onClick: retry }));
    gridState.replaceChildren(...nodes);
  }

  async function open(id, gid) {
    const gen = ++s.openGen;
    if (s.id !== id) {
      s.id = id;
      s.meta = undefined;
      s.file = undefined;
      s.rows = new Map();
      s.chunks = new Map();
      s.sel = { r0: 0, c0: 0, r1: 0, c1: 0, ar: 0, ac: 0 };
      s.anchor = { r: 0, c: 0 };
      cancelEdit();
      $("#side-panel").hidden = true;
      titleInput.value = "";
      $("#tabs").replaceChildren();
      renderChrome();
      body.scrollTo(0, 0);
    }
    showGridState("loading", "Loading…");
    try {
      const [meta, file] = await Promise.all([call("spreadsheets.get", { spreadsheetId: id, markViewed: true }), call("files.get", { fileId: id })]);
      if (gen !== s.openGen) return;
      s.meta = meta;
      s.file = file;
    } catch (error) {
      if (gen !== s.openGen) return;
      if (error instanceof ToolError && error.denied) return app.showDenied();
      if (error instanceof ToolError && (error.is("NOT_FOUND") || error.status === "invalid")) return app.showNotFound();
      showGridState("error", describe(error), () => void open(id, gid));
      return;
    }
    const visible = sheets().filter((sheet) => !sheet.hidden);
    const wanted = gid !== undefined ? sheetById(gid) : undefined;
    const chosen = wanted && !wanted.hidden ? wanted : sheetById(s.sheetId) && !sheetById(s.sheetId).hidden ? sheetById(s.sheetId) : visible[0];
    s.sheetId = chosen?.sheetId;
    if (chosen) app.replaceGid(id, chosen.sheetId);
    renderChrome();
    await reloadVisible({ initial: true });
    grid.focus({ preventScroll: true });
  }

  function close() {
    s.openGen += 1;
    s.id = undefined;
    cancelEdit();
    hideTooltip();
  }

  async function refreshMeta() {
    const [meta, file] = await Promise.all([call("spreadsheets.get", { spreadsheetId: s.id }), call("files.get", { fileId: s.id })]);
    s.meta = meta;
    s.file = file;
    if (!sheetById(s.sheetId) || sheetById(s.sheetId).hidden) {
      s.sheetId = sheets().find((sheet) => !sheet.hidden)?.sheetId;
      s.rows = new Map();
      s.chunks = new Map();
    }
    clampSelection();
    renderChrome();
  }

  /** Background refresh after the world revision moved. */
  async function refresh() {
    if (!s.id || s.edit) return;
    try {
      await refreshMeta();
      await reloadVisible();
    } catch (error) {
      if (error instanceof ToolError && error.is("NOT_FOUND")) app.showNotFound();
      else toast(describe(error), { error: true });
    }
  }

  function neededChunks() {
    const { rows, fr } = dims();
    const st = body.scrollTop;
    const ch = body.clientHeight || 600;
    const first = Math.max(fr, Math.floor(st / ROW_H));
    const last = Math.min(rows - 1, Math.floor((st + ch) / ROW_H) + 20);
    const chunks = new Set();
    if (fr > 0) for (let r = 0; r < fr; r += CHUNK) chunks.add(Math.floor(r / CHUNK));
    for (let r = first; r <= last; r += CHUNK) chunks.add(Math.floor(r / CHUNK));
    chunks.add(Math.floor(last / CHUNK));
    return [...chunks];
  }

  /** True for the service's refusal of a response over its byte limit (cells full of long text). */
  const tooLarge = (error) => error instanceof ToolError && error.is("INVALID_ARGUMENT") && /^Response too large/.test(error.message);

  /**
   * Grid data for a window [r0, r1) x [c0, c1). A window whose cells are too large for one response is split in half
   * (rows first, then columns) and re-read, so every cell still loads; only a single cell too large on its own fails.
   */
  async function fetchWindow(sheet, r0, r1, c0, c1, out) {
    const range = `${quoteTitle(sheet.title)}!${columnName(c0)}${r0 + 1}:${columnName(c1 - 1)}${r1}`;
    let result;
    try {
      result = await call("spreadsheets.get", { spreadsheetId: s.id, includeGridData: true, ranges: [range] });
    } catch (error) {
      if (!tooLarge(error) || (r1 - r0 === 1 && c1 - c0 === 1)) throw error;
      if (r1 - r0 > 1) {
        const mid = r0 + Math.floor((r1 - r0) / 2);
        await fetchWindow(sheet, r0, mid, c0, c1, out);
        await fetchWindow(sheet, mid, r1, c0, c1, out);
      } else {
        const mid = c0 + Math.floor((c1 - c0) / 2);
        await fetchWindow(sheet, r0, r1, c0, mid, out);
        await fetchWindow(sheet, r0, r1, mid, c1, out);
      }
      return;
    }
    mergeGrid(result, sheet, out);
  }

  async function fetchChunk(chunk) {
    const sheet = active();
    const { rows, cols } = dims();
    const start = chunk * CHUNK;
    const end = Math.min(rows, start + CHUNK);
    const out = new Map();
    if (end > start && cols > 0) await fetchWindow(sheet, start, end, 0, cols, out);
    return out;
  }

  function mergeGrid(result, sheet, out) {
    const target = result.sheets.find((candidate) => candidate.properties.sheetId === sheet.sheetId);
    for (const data of target?.data ?? []) {
      const startRow = data.startRow ?? 0;
      const startColumn = data.startColumn ?? 0;
      (data.rowData ?? []).forEach((rowData, offset) => {
        const values = rowData.values ?? [];
        if (values.length === 0) return;
        const row = out.get(startRow + offset) ?? [];
        values.forEach((cell, index) => (row[startColumn + index] = cell));
        out.set(startRow + offset, row);
      });
    }
  }

  /** Re-read every visible chunk, swapping the cache only when all have arrived (no flicker, formulas recomputed). */
  async function reloadVisible({ initial = false } = {}) {
    if (!active()) {
      showGridState("error", "This spreadsheet has no visible sheets.");
      render();
      return;
    }
    const gen = ++s.dataGen;
    const sheetId = s.sheetId;
    const chunks = neededChunks();
    if (initial) showGridState("loading", "Loading…");
    try {
      const parts = await Promise.all(chunks.map((chunk) => fetchChunk(chunk)));
      if (gen !== s.dataGen || sheetId !== s.sheetId) return;
      const rows = new Map();
      for (const part of parts) for (const [r, row] of part) rows.set(r, row);
      s.rows = rows;
      s.chunks = new Map(chunks.map((chunk) => [chunk, "loaded"]));
      s.loadError = undefined;
      showGridState(null);
    } catch (error) {
      if (gen !== s.dataGen) return;
      if (error instanceof ToolError && error.denied) return app.showDenied();
      s.loadError = error;
      showGridState("error", describe(error), () => void reloadVisible({ initial: true }));
    }
    render();
  }

  async function ensureChunks() {
    const missing = neededChunks().filter((chunk) => !s.chunks.has(chunk));
    if (missing.length === 0) return;
    const gen = s.dataGen;
    const sheetId = s.sheetId;
    for (const chunk of missing) s.chunks.set(chunk, "loading");
    try {
      const parts = await Promise.all(missing.map((chunk) => fetchChunk(chunk)));
      if (gen !== s.dataGen || sheetId !== s.sheetId) return;
      for (const part of parts) for (const [r, row] of part) s.rows.set(r, row);
      for (const chunk of missing) s.chunks.set(chunk, "loaded");
      render();
    } catch (error) {
      for (const chunk of missing) s.chunks.delete(chunk);
      toast(describe(error), { error: true });
    }
  }

  // -------------------------------------------------------------------------------------------
  // Chrome: title bar, menus, toolbar, tabs
  // -------------------------------------------------------------------------------------------

  function renderChrome() {
    const file = s.file;
    const title = file?.name ?? s.meta?.properties?.title ?? "";
    if (document.activeElement !== titleInput) titleInput.value = title;
    titleInput.readOnly = !(file?.capabilities?.canRename && !file?.trashed);
    document.title = title ? `${title} - Google Sheets` : "Google Sheets";
    const star = $("#star-btn");
    star.setAttribute("aria-pressed", String(file?.starred === true));
    star.replaceChildren(icon(file?.starred ? "star" : "star_border"));
    star.title = file?.starred ? "Starred" : "Star";
    star.setAttribute("aria-label", star.title);
    star.disabled = !file;
    $("#view-only").hidden = !file || canEdit() || file.trashed;
    const history = $("#history-btn");
    history.title = file ? `Last edit was ${ago(file.modifiedTime, app.nowMs())}` : "Last edit";
    history.setAttribute("aria-label", history.title);
    renderBanner();
    renderMenubar();
    renderToolbar();
    renderTabs();
    updateFormulaBar();
  }

  function renderBanner() {
    const banner = $("#doc-banner");
    const file = s.file;
    if (file?.trashed) {
      banner.hidden = false;
      banner.className = "doc-banner";
      $("#doc-banner-text").textContent = "This file is in the trash.";
      const actions = [];
      if (file.capabilities?.canUntrash) actions.push(button("Restore", { onClick: () => setTrashed(false) }));
      $("#doc-banner-actions").replaceChildren(...actions);
    } else banner.hidden = true;
  }

  function setSaving(delta) {
    s.saving += delta;
    const node = $("#save-state");
    node.classList.toggle("saving", s.saving > 0);
    node.title = s.saving > 0 ? "Saving…" : "All changes saved in Drive";
  }

  const MENUS = [
    { label: "File", items: fileMenu },
    { label: "Edit", items: editMenu },
    { label: "View", items: viewMenu },
    { label: "Insert", items: insertMenu },
    { label: "Format", items: formatMenu },
    { label: "Data", items: dataMenu },
    { label: "Tools", items: () => unsupportedItems([["Create a new form", "sheet"], "divider", ["Spelling", "check"], ["Autocomplete", "edit"], ["Suggestion controls", "info"], "divider", ["Notification settings", "info"], ["Accessibility", "help"], ["Activity dashboard", "history"]]) },
    { label: "Extensions", items: () => unsupportedItems([["Add-ons", "extension"], ["Macros", "extension"], ["Apps Script", "extension"], ["AppSheet", "extension"]]) },
    { label: "Help", items: helpMenu },
  ];

  function renderMenubar() {
    const bar = $("#menubar");
    if (bar.childElementCount > 0) return;
    for (const menu of MENUS) {
      const item = el("button", { class: "menubar-item", text: menu.label, attrs: { type: "button", "aria-haspopup": "menu", "aria-expanded": "false" } });
      const show = () => openMenu(item, menu.items(), { className: "menubar-menu" });
      item.addEventListener("click", (event) => {
        event.stopPropagation();
        if (item.getAttribute("aria-expanded") === "true") closeMenus();
        else show();
      });
      item.addEventListener("mouseenter", () => {
        if (document.querySelector(".menubar-menu") && item.getAttribute("aria-expanded") !== "true") show();
      });
      bar.append(item);
    }
  }

  const editDisabled = () => !canEdit();
  const colLabel = () => columnName(s.sel.ac);
  const rowLabel = () => String(s.sel.ar + 1);

  function fileMenu() {
    const caps = s.file?.capabilities ?? {};
    return [
      { label: "New", icon: "add", submenu: () => [{ label: "Spreadsheet", icon: "sheet", onSelect: createSpreadsheet }] },
      { label: "Open", icon: "folder_open", shortcut: "Ctrl+O", onSelect: () => app.goHome() },
      { label: "Make a copy", icon: "content_copy", disabled: !caps.canCopy, onSelect: makeCopy },
      "divider",
      { label: "Share", icon: "person_add", submenu: () => [{ label: "Share with others", icon: "person_add", onSelect: openShare }] },
      "divider",
      { label: "Rename", icon: "edit", disabled: !caps.canRename, onSelect: () => titleInput.select() },
      { label: s.file?.starred ? "Remove from starred" : "Add to starred", icon: s.file?.starred ? "star" : "star_border", onSelect: toggleStar },
      { label: "Move to trash", icon: "delete", disabled: !caps.canTrash, title: "Only the owner can move this file to the trash", onSelect: () => setTrashed(true) },
      "divider",
      ...unsupportedItems([["Import", "folder_open"], ["Download", "arrow_forward"], ["Email", "person_add"], ["Move", "drive_file_move"], ["Version history", "history"], ["Make available offline", "cloud_done"], ["Details", "info"], ["Settings", "palette"], ["Print", "print", "Ctrl+P"]]),
    ];
  }

  // Browsers only allow page scripts to use the clipboard during a keyboard copy, cut or paste, so (as in the product)
  // the menu entries explain the shortcut; the shortcuts themselves copy, cut and paste through the grid handlers below.
  function clipboardHint(verb, keys) {
    const body = el("div", { class: "unsupported" }, [
      el("div", { class: "unsupported-text" }, [
        el("p", { text: `These actions are unavailable via the Edit menu, but you can still use ${keys} to ${verb}.` }),
        el("p", { class: "unsupported-detail", text: "Ctrl+C copy · Ctrl+X cut · Ctrl+V paste" }),
      ]),
    ]);
    const modal = openModal({ title: "Copying and pasting in this browser", body, className: "unsupported-dialog", actions: [button("Got it", { className: "filled-btn", onClick: () => modal.close() })] });
  }

  function editMenu() {
    return [
      ...unsupportedItems([["Undo", "undo", "Ctrl+Z"], ["Redo", "redo", "Ctrl+Y"]]),
      "divider",
      { label: "Cut", icon: "content_cut", shortcut: "Ctrl+X", disabled: editDisabled(), onSelect: () => clipboardHint("cut", "Ctrl+X") },
      { label: "Copy", icon: "content_copy", shortcut: "Ctrl+C", onSelect: () => clipboardHint("copy", "Ctrl+C") },
      { label: "Paste", icon: "content_paste", shortcut: "Ctrl+V", disabled: editDisabled(), onSelect: () => clipboardHint("paste", "Ctrl+V") },
      unsupportedSubmenu("Paste special", "content_paste", ["Values only", "Format only", "Conditional formatting only", "Data validation only", "Transposed", "Column width only", "All except borders"]),
      "divider",
      unsupportedSubmenu("Move", "arrow_forward", ["Row up", "Row down", "Column left", "Column right"]),
      {
        label: "Delete",
        icon: "delete",
        disabled: editDisabled(),
        submenu: () => [
          { label: "Values", onSelect: clearSelection },
          { label: s.sel.r0 === s.sel.r1 ? `Row ${s.sel.r0 + 1}` : `Rows ${s.sel.r0 + 1} - ${s.sel.r1 + 1}`, onSelect: () => deleteDimension("ROWS") },
          { label: s.sel.c0 === s.sel.c1 ? `Column ${columnName(s.sel.c0)}` : `Columns ${columnName(s.sel.c0)} - ${columnName(s.sel.c1)}`, onSelect: () => deleteDimension("COLUMNS") },
        ],
      },
      "divider",
      { label: "Find and replace", icon: "find_replace", shortcut: "Ctrl+H", onSelect: openFindReplace },
    ];
  }

  function viewMenu() {
    const { fr, fc } = dims();
    const freeze = (rows, cols) => updateSheet({ sheetId: s.sheetId, gridProperties: rows !== undefined ? { frozenRowCount: rows } : { frozenColumnCount: cols } }, rows !== undefined ? "gridProperties.frozenRowCount" : "gridProperties.frozenColumnCount");
    const hidden = sheets().filter((sheet) => sheet.hidden);
    return [
      unsupportedSubmenu("Show", "visibility_off", ["Formula bar", "Gridlines", "Formulas", "Protected ranges"]),
      {
        label: "Freeze",
        icon: "freeze",
        disabled: editDisabled(),
        submenu: () => [
          { label: "No rows", checked: fr === 0, onSelect: () => freeze(0) },
          { label: "1 row", checked: fr === 1, onSelect: () => freeze(1) },
          { label: "2 rows", checked: fr === 2, onSelect: () => freeze(2) },
          { label: `Up to row ${s.sel.ar + 1}`, checked: fr === s.sel.ar + 1 && fr > 2, onSelect: () => freeze(s.sel.ar + 1) },
          "divider",
          { label: "No columns", checked: fc === 0, onSelect: () => freeze(undefined, 0) },
          { label: "1 column", checked: fc === 1, onSelect: () => freeze(undefined, 1) },
          { label: "2 columns", checked: fc === 2, onSelect: () => freeze(undefined, 2) },
          { label: `Up to column ${columnName(s.sel.ac)}`, checked: fc === s.sel.ac + 1 && fc > 2, onSelect: () => freeze(undefined, s.sel.ac + 1) },
        ],
      },
      {
        label: "Hidden sheets",
        icon: "visibility_off",
        hint: hidden.length ? `(${hidden.length})` : undefined,
        disabled: hidden.length === 0 || editDisabled(),
        submenu: () => hidden.map((sheet) => ({ label: sheet.title, onSelect: () => unhide(sheet) })),
      },
      unsupportedSubmenu("Group", "view_column", ["Group rows", "Group columns"]),
      unsupportedSubmenu("Comments", "comment", ["Minimize comments", "Hide comments"]),
      "divider",
      unsupportedSubmenu("Zoom", "zoom_in", ["50%", "75%", "90%", "100%", "125%", "150%", "200%"]),
      ...unsupportedItems([["Full screen", "fullscreen"]]),
    ];
  }

  function insertMenu() {
    const disabled = editDisabled();
    return [
      unsupportedSubmenu("Cells", "sheet", ["Insert cells and shift right", "Insert cells and shift down"]),
      {
        label: "Rows",
        icon: "table_rows",
        disabled,
        submenu: () => [
          { label: `Insert ${count("ROWS")} above`, onSelect: () => insertDimension("ROWS", "before") },
          { label: `Insert ${count("ROWS")} below`, onSelect: () => insertDimension("ROWS", "after") },
        ],
      },
      {
        label: "Columns",
        icon: "view_column",
        disabled,
        submenu: () => [
          { label: `Insert ${count("COLUMNS")} left`, onSelect: () => insertDimension("COLUMNS", "before") },
          { label: `Insert ${count("COLUMNS")} right`, onSelect: () => insertDimension("COLUMNS", "after") },
        ],
      },
      { label: "Sheet", icon: "add", shortcut: "Shift+F11", disabled, onSelect: addSheet },
      "divider",
      ...unsupportedItems([["Pivot table", "table_chart"], ["Chart", "insert_chart"]]),
      unsupportedSubmenu("Image", "image", ["Insert image in cell", "Insert image over cells"]),
      ...unsupportedItems([["Drawing", "format_paint"], ["Timeline", "view_list"]]),
      "divider",
      { label: "Function", icon: "functions", disabled, submenu: () => FUNCTIONS.map((name) => ({ label: name, onSelect: () => insertFunction(name) })) },
      ...unsupportedItems([["Link", "link", "Ctrl+K"], "divider", ["Checkbox", "check_box"], ["Dropdown", "dropdown_circle"], ["Emoji", "emoji"]]),
      unsupportedSubmenu("Smart chips", "people", ["People", "File", "Calendar events", "Place", "Finance"]),
      "divider",
      ...unsupportedItems([["Comment", "add_comment", "Ctrl+Alt+M"], ["Note", "note", "Shift+F2"]]),
    ];
  }

  function count(dimension) {
    const n = dimension === "ROWS" ? s.sel.r1 - s.sel.r0 + 1 : s.sel.c1 - s.sel.c0 + 1;
    return dimension === "ROWS" ? `${n} row${n === 1 ? "" : "s"}` : `${n} column${n === 1 ? "" : "s"}`;
  }

  function formatMenu() {
    const disabled = editDisabled();
    const fmt = cellAt(s.sel.ar, s.sel.ac)?.userEnteredFormat ?? {};
    const text = fmt.textFormat ?? {};
    return [
      ...unsupportedItems([["Theme", "palette"]]),
      "divider",
      { label: "Number", icon: "sheet", disabled, submenu: numberFormatItems },
      {
        label: "Text",
        icon: "format_bold",
        disabled,
        submenu: () => [
          { label: "Bold", checked: text.bold === true, shortcut: "Ctrl+B", onSelect: () => toggleText("bold") },
          { label: "Italic", checked: text.italic === true, shortcut: "Ctrl+I", onSelect: () => toggleText("italic") },
          { label: "Underline", checked: text.underline === true, shortcut: "Ctrl+U", onSelect: () => toggleText("underline") },
          { label: "Strikethrough", checked: text.strikethrough === true, shortcut: "Alt+Shift+5", onSelect: () => toggleText("strikethrough") },
        ],
      },
      { label: "Alignment", icon: "align_left", disabled, submenu: alignItems },
      { label: "Wrapping", icon: "wrap_text", disabled, submenu: wrapItems },
      unsupportedSubmenu("Rotation", "text_rotate", ["None", "Tilt up", "Tilt down", "Stack vertically", "Rotate up", "Rotate down", "Custom angle"]),
      "divider",
      {
        label: "Font size",
        icon: "text_color",
        disabled,
        submenu: () => [6, 7, 8, 9, 10, 11, 12, 14, 18, 24, 36].map((size) => ({ label: String(size), checked: (text.fontSize ?? 10) === size, onSelect: () => setFontSize(size) })),
      },
      unsupportedSubmenu("Merge cells", "merge_cells", ["Merge all", "Merge vertically", "Merge horizontally", "Unmerge"]),
      ...unsupportedItems([["Convert to table", "table_chart", "Ctrl+Alt+T"], ["Conditional formatting", "fill_color"], ["Alternating colors", "format_paint"]]),
      "divider",
      { label: "Clear formatting", icon: "format_clear", shortcut: "Ctrl+\\", disabled, onSelect: clearFormatting },
    ];
  }

  function numberFormatItems() {
    const current = cellAt(s.sel.ar, s.sel.ac)?.userEnteredFormat?.numberFormat;
    return NUMBER_FORMATS.map((entry) =>
      entry === "divider"
        ? entry
        : {
            label: entry.label,
            hint: entry.hint,
            checked: entry.format === null ? !current : current?.type === entry.format.type && (current.pattern ?? "") === entry.format.pattern,
            onSelect: () => setNumberFormat(entry.format),
          },
    );
  }
  function alignItems() {
    const current = cellAt(s.sel.ar, s.sel.ac)?.userEnteredFormat?.horizontalAlignment;
    return [
      { label: "Left", icon: "align_left", hint: current === "LEFT" ? "✓" : undefined, onSelect: () => setFormat({ horizontalAlignment: "LEFT" }, "userEnteredFormat.horizontalAlignment") },
      { label: "Center", icon: "align_center", hint: current === "CENTER" ? "✓" : undefined, onSelect: () => setFormat({ horizontalAlignment: "CENTER" }, "userEnteredFormat.horizontalAlignment") },
      { label: "Right", icon: "align_right", hint: current === "RIGHT" ? "✓" : undefined, onSelect: () => setFormat({ horizontalAlignment: "RIGHT" }, "userEnteredFormat.horizontalAlignment") },
    ];
  }
  function wrapItems() {
    const current = cellAt(s.sel.ar, s.sel.ac)?.userEnteredFormat?.wrapStrategy ?? "OVERFLOW_CELL";
    return [
      { label: "Overflow", icon: "overflow", hint: current === "OVERFLOW_CELL" ? "✓" : undefined, onSelect: () => setFormat({ wrapStrategy: "OVERFLOW_CELL" }, "userEnteredFormat.wrapStrategy") },
      { label: "Wrap", icon: "wrap_text", hint: current === "WRAP" ? "✓" : undefined, onSelect: () => setFormat({ wrapStrategy: "WRAP" }, "userEnteredFormat.wrapStrategy") },
      { label: "Clip", icon: "clip", hint: current === "CLIP" ? "✓" : undefined, onSelect: () => setFormat({ wrapStrategy: "CLIP" }, "userEnteredFormat.wrapStrategy") },
    ];
  }

  function dataMenu() {
    const disabled = editDisabled();
    const col = colLabel();
    return [
      {
        label: "Sort sheet",
        icon: "sort",
        disabled,
        submenu: () => [
          { label: `Sort sheet by column ${col} (A to Z)`, onSelect: () => sortSheet(false, true) },
          { label: `Sort sheet by column ${col} (Z to A)`, onSelect: () => sortSheet(true, true) },
        ],
      },
      {
        label: "Sort range",
        icon: "sort_by_alpha",
        disabled: disabled || (s.sel.r0 === s.sel.r1 && s.sel.c0 === s.sel.c1),
        submenu: () => [
          { label: `Sort range by column ${col} (A to Z)`, onSelect: () => sortSheet(false, false) },
          { label: `Sort range by column ${col} (Z to A)`, onSelect: () => sortSheet(true, false) },
        ],
      },
      "divider",
      ...unsupportedItems([["Create a filter", "filter_list"], ["Create filter view", "filter_views"], ["Add a slicer", "filter_list"], "divider", ["Protect sheets and ranges", "shield"]]),
      { label: "Named ranges", icon: "bookmark", onSelect: openNamedRanges },
      ...unsupportedItems([["Named functions", "functions"], ["Randomize range", "sort"], "divider", ["Column stats", "insert_chart"], ["Data validation", "check_box"]]),
      unsupportedSubmenu("Data cleanup", "format_clear", ["Cleanup suggestions", "Column stats", "Remove duplicates", "Trim whitespace"]),
      ...unsupportedItems([["Split text to columns", "view_column"], ["Data extraction", "open_in_new"], "divider", ["Data connectors", "extension"]]),
    ];
  }

  function helpMenu() {
    return [
      { heading: "Keyboard shortcuts" },
      { label: "Edit cell", shortcut: "Enter / F2", disabled: true },
      { label: "Clear values", shortcut: "Delete", disabled: true },
      { label: "Find and replace", shortcut: "Ctrl+H", disabled: true },
      "divider",
      ...unsupportedItems([["Help", "help"], ["Training", "info"], ["Updates", "info"], ["Help Sheets improve", "info"], ["Privacy Policy", "lock"], ["Terms of Service", "lock"], ["Function list", "functions"], ["Keyboard shortcuts", "info", "Ctrl+/"]]),
      "divider",
      { label: "Simulated service: data lives only in this Firedrill world", disabled: true },
    ];
  }

  // --- toolbar ---------------------------------------------------------------------------------

  const toolbarButtons = {};
  function tb(id, { label, iconName, text, onClick, toggle = false, drop = false, className = "" }) {
    const node = el("button", { class: `tb-btn ${className}`.trim(), title: label, attrs: { type: "button", "aria-label": label, "aria-pressed": toggle ? "false" : undefined, "aria-haspopup": drop ? "menu" : undefined } });
    if (iconName) node.append(icon(iconName));
    if (text) node.append(el("span", { class: "tb-text", text }));
    if (drop) node.append(icon("arrow_drop_down", "tb-drop"));
    node.addEventListener("click", (event) => onClick(event.currentTarget));
    toolbarButtons[id] = node;
    return node;
  }
  const sep = () => el("span", { class: "tb-sep", attrs: { "aria-hidden": "true" } });
  /** A toolbar control outside this Tool's scope: same glyph, hover and tooltip, opens the not-simulated panel. */
  function tbx(label, { iconName, text, drop = false, className = "", feature }) {
    const node = el("button", { class: `tb-btn ${className}`.trim(), title: label, attrs: { type: "button", "aria-label": label, "aria-haspopup": "dialog" } });
    if (iconName) node.append(icon(iconName));
    if (text) node.append(el("span", { class: "tb-text", text }));
    if (drop) node.append(icon("arrow_drop_down", "tb-drop"));
    node.addEventListener("click", () => notSimulated(feature ?? label));
    return node;
  }

  function buildToolbar() {
    const bar = $("#toolbar");
    const fontSize = el("input", { class: "fs-input", attrs: { type: "text", inputmode: "numeric", "aria-label": "Font size", value: "10" } });
    fontSize.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        const size = Number.parseInt(fontSize.value, 10);
        if (Number.isInteger(size) && size >= 1 && size <= 400) void setFontSize(size);
        grid.focus();
      }
    });
    toolbarButtons.fontSizeInput = fontSize;
    const textColor = tb("textColor", { label: "Text color", iconName: "text_color", className: "tb-color", onClick: (anchor) => openColorMenu(anchor, "text") });
    textColor.append(el("span", { class: "color-bar", attrs: { id: "text-color-bar" } }));
    const fillColor = tb("fillColor", { label: "Fill color", iconName: "fill_color", className: "tb-color", onClick: (anchor) => openColorMenu(anchor, "fill") });
    const fillBar = el("span", { class: "color-bar", attrs: { id: "fill-color-bar" } });
    fillBar.style.background = "#fff";
    fillColor.append(fillBar);
    const menusSearch = el("button", { class: "tb-search", title: "Search the menus (Alt+/)", attrs: { type: "button", "aria-label": "Search the menus (Alt+/)" } }, [icon("search"), el("span", { class: "tb-search-text", text: "Menus" })]);
    menusSearch.addEventListener("click", () => notSimulated("Search the menus"));
    const hideMenus = el("button", { class: "tb-btn tb-collapse", title: "Hide the menus (Ctrl+Shift+F)", attrs: { type: "button", "aria-label": "Hide the menus (Ctrl+Shift+F)", "aria-expanded": "true" } }, [icon("keyboard_arrow_up")]);
    hideMenus.addEventListener("click", () => {
      const nowHidden = $("#editor").classList.toggle("menus-hidden");
      const label = nowHidden ? "Show the menus (Ctrl+Shift+F)" : "Hide the menus (Ctrl+Shift+F)";
      hideMenus.title = label;
      hideMenus.setAttribute("aria-label", label);
      hideMenus.setAttribute("aria-expanded", String(!nowHidden));
      hideMenus.replaceChildren(icon(nowHidden ? "keyboard_arrow_down" : "keyboard_arrow_up"));
    });
    bar.replaceChildren(
      menusSearch,
      tbx("Undo (Ctrl+Z)", { iconName: "undo", feature: "Undo" }),
      tbx("Redo (Ctrl+Y)", { iconName: "redo", feature: "Redo" }),
      tbx("Print (Ctrl+P)", { iconName: "print", feature: "Print" }),
      tbx("Paint format", { iconName: "format_paint" }),
      tbx("Zoom", { text: "100%", drop: true, className: "tb-zoom" }),
      sep(),
      tb("currency", { label: "Format as currency", text: "$", onClick: () => setNumberFormat({ type: "CURRENCY", pattern: '"$"#,##0.00' }) }),
      tb("percent", { label: "Format as percent", text: "%", onClick: () => setNumberFormat({ type: "PERCENT", pattern: "0.00%" }) }),
      tb("decLess", { label: "Decrease decimal places", text: ".0←", onClick: () => stepDecimals("less") }),
      tb("decMore", { label: "Increase decimal places", text: ".00→", onClick: () => stepDecimals("more") }),
      tb("numberFormats", { label: "More formats", text: "123", drop: true, onClick: (anchor) => openMenu(anchor, numberFormatItems()) }),
      sep(),
      tbx("Font", { text: "Default (Ari…", drop: true, className: "tb-font", feature: "Changing the font" }),
      sep(),
      el("span", { class: "fs-group" }, [
        tb("fontLess", { label: "Decrease font size (Ctrl+Shift+comma)", iconName: "remove", onClick: () => bumpFontSize(-1) }),
        fontSize,
        tb("fontMore", { label: "Increase font size (Ctrl+Shift+period)", iconName: "add", onClick: () => bumpFontSize(1) }),
      ]),
      sep(),
      tb("bold", { label: "Bold (Ctrl+B)", iconName: "format_bold", toggle: true, onClick: () => toggleText("bold") }),
      tb("italic", { label: "Italic (Ctrl+I)", iconName: "format_italic", toggle: true, onClick: () => toggleText("italic") }),
      tb("strikethrough", { label: "Strikethrough (Alt+Shift+5)", iconName: "strikethrough", toggle: true, onClick: () => toggleText("strikethrough") }),
      textColor,
      sep(),
      fillColor,
      tbx("Borders", { iconName: "border_all" }),
      tbx("Merge cells", { iconName: "merge_cells", drop: true }),
      sep(),
      tb("align", { label: "Horizontal align", iconName: "align_left", drop: true, onClick: (anchor) => openMenu(anchor, alignItems()) }),
      tbx("Vertical align", { iconName: "valign_bottom", drop: true }),
      tb("wrap", { label: "Text wrapping", iconName: "overflow", drop: true, onClick: (anchor) => openMenu(anchor, wrapItems()) }),
      tbx("Text rotation", { iconName: "text_rotate", drop: true }),
      sep(),
      tbx("Insert link (Ctrl+K)", { iconName: "link", feature: "Insert link" }),
      tbx("Insert comment (Ctrl+Alt+M)", { iconName: "add_comment", feature: "Comments" }),
      tbx("Insert chart", { iconName: "insert_chart", feature: "Charts" }),
      tbx("Create a filter", { iconName: "filter_list", feature: "Filters" }),
      tbx("Filter views", { iconName: "filter_views", drop: true }),
      tb("functions", { label: "Functions", iconName: "functions", drop: true, onClick: (anchor) => openMenu(anchor, FUNCTIONS.map((name) => ({ label: name, onSelect: () => insertFunction(name) }))) }),
      el("span", { class: "tb-spacer" }),
      hideMenus,
    );
  }
  buildToolbar();

  function renderToolbar() {
    const disabled = !canEdit();
    for (const node of Object.values(toolbarButtons)) node.disabled = disabled;
    const cell = cellAt(s.sel.ar, s.sel.ac);
    const fmt = cell?.userEnteredFormat ?? {};
    const text = fmt.textFormat ?? {};
    for (const key of ["bold", "italic", "strikethrough"]) toolbarButtons[key].setAttribute("aria-pressed", String(text[key] === true));
    if (document.activeElement !== toolbarButtons.fontSizeInput) toolbarButtons.fontSizeInput.value = String(text.fontSize ?? 10);
    const textBar = document.getElementById("text-color-bar");
    if (textBar) textBar.style.background = rgbOf(text.foregroundColorStyle?.rgbColor ?? text.foregroundColor) ?? "#000";
    const fillBar = document.getElementById("fill-color-bar");
    if (fillBar) fillBar.style.background = rgbOf(fmt.backgroundColorStyle?.rgbColor ?? fmt.backgroundColor) ?? "#fff";
    const alignIcon = { LEFT: "align_left", CENTER: "align_center", RIGHT: "align_right" }[fmt.horizontalAlignment] ?? "align_left";
    toolbarButtons.align.firstChild.replaceWith(icon(alignIcon));
    const wrapIcon = { WRAP: "wrap_text", CLIP: "clip" }[fmt.wrapStrategy] ?? "overflow";
    toolbarButtons.wrap.firstChild.replaceWith(icon(wrapIcon));
  }

  // --- tabs -------------------------------------------------------------------------------------

  function renderTabs() {
    const host = $("#tabs");
    if (host.querySelector(".tab-rename")) return;
    const nodes = [];
    for (const sheet of sheets()) {
      if (sheet.hidden) continue;
      const selected = sheet.sheetId === s.sheetId;
      const tab = el("button", { class: `tab ${selected ? "active" : ""}`, attrs: { type: "button", role: "tab", "aria-selected": String(selected), "data-sheet-id": sheet.sheetId } }, [el("span", { class: "tab-name", text: sheet.title })]);
      const drop = el("span", { class: "tab-drop", attrs: { "aria-hidden": "true" } }, [icon("arrow_drop_down")]);
      tab.append(drop);
      const color = rgbOf(sheet.tabColorStyle?.rgbColor ?? sheet.tabColor);
      if (color) {
        const stripe = el("span", { class: "tab-color" });
        stripe.style.background = color;
        tab.append(stripe);
      }
      tab.addEventListener("click", (event) => {
        if (drop.contains(event.target) || (selected && event.detail === 1 && event.target === drop)) {
          openTabMenu(tab, sheet);
          return;
        }
        if (!selected) switchSheet(sheet.sheetId);
      });
      drop.addEventListener("click", (event) => {
        event.stopPropagation();
        openTabMenu(tab, sheet);
      });
      tab.addEventListener("dblclick", () => canEdit() && renameSheetInline(tab, sheet));
      tab.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        openTabMenu(tab, sheet, { x: event.clientX, y: event.clientY });
      });
      tab.addEventListener("keydown", (event) => {
        if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
          const list = [...host.querySelectorAll(".tab")];
          const next = list[(list.indexOf(tab) + (event.key === "ArrowRight" ? 1 : -1) + list.length) % list.length];
          next?.focus();
        }
      });
      nodes.push(tab);
    }
    host.replaceChildren(...nodes);
  }

  function switchSheet(sheetId) {
    cancelEdit();
    s.sheetId = sheetId;
    s.rows = new Map();
    s.chunks = new Map();
    s.sel = { r0: 0, c0: 0, r1: 0, c1: 0, ar: 0, ac: 0 };
    s.anchor = { r: 0, c: 0 };
    app.replaceGid(s.id, sheetId);
    body.scrollTo(0, 0);
    renderChrome();
    void reloadVisible({ initial: true });
    grid.focus({ preventScroll: true });
  }

  function openTabMenu(anchor, sheet, point) {
    const disabled = !canEdit();
    const visible = sheets().filter((candidate) => !candidate.hidden);
    const position = visible.findIndex((candidate) => candidate.sheetId === sheet.sheetId);
    openMenu(
      anchor,
      [
        { label: "Delete", icon: "delete", disabled: disabled || sheets().length <= 1, onSelect: () => deleteSheet(sheet) },
        { label: "Duplicate", icon: "content_copy", disabled, onSelect: () => duplicateSheet(sheet) },
        { label: "Copy to", icon: "open_in_new", submenu: () => [{ label: "Existing spreadsheet", onSelect: () => copySheetTo(sheet) }] },
        { label: "Rename", icon: "edit", disabled, onSelect: () => renameSheetInline($(`.tab[data-sheet-id="${sheet.sheetId}"]`) ?? anchor, sheet) },
        { label: "Change color", icon: "palette", disabled, submenu: () => [{ element: swatchPanel((hex) => setTabColor(sheet, hex)) }] },
        "divider",
        { label: "Hide sheet", icon: "visibility_off", disabled: disabled || visible.length <= 1, onSelect: () => hideSheet(sheet) },
        "divider",
        { label: "Move right", icon: "arrow_forward", disabled: disabled || position >= visible.length - 1, onSelect: () => moveSheet(sheet, visible[position + 1].index + 1) },
        { label: "Move left", icon: "arrow_back", disabled: disabled || position <= 0, onSelect: () => moveSheet(sheet, visible[position - 1].index) },
      ],
      { point: point ?? { x: anchor.getBoundingClientRect().left, y: anchor.getBoundingClientRect().top - 330 }, below: false },
    );
  }

  function renameSheetInline(tab, sheet) {
    const input = el("input", { class: "tab-rename", attrs: { type: "text", value: sheet.title, "aria-label": "Sheet name", maxlength: 100 } });
    tab.replaceChildren(input);
    input.select();
    let done = false;
    const finish = async (commit) => {
      if (done) return;
      done = true;
      const title = input.value.trim();
      tab.querySelector(".tab-rename")?.remove();
      if (commit && title && title !== sheet.title) await updateSheet({ sheetId: sheet.sheetId, title }, "title");
      renderTabs();
    };
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") void finish(true);
      if (event.key === "Escape") void finish(false);
    });
    input.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("blur", () => void finish(true));
  }

  // -------------------------------------------------------------------------------------------
  // Grid rendering
  // -------------------------------------------------------------------------------------------

  let frame = 0;
  const scheduleRender = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      render();
    });
  };

  function visibleRegion() {
    const { rows, cols, fr, fc } = dims();
    const st = body.scrollTop;
    const sl = body.scrollLeft;
    const cw = body.clientWidth;
    const ch = body.clientHeight;
    return {
      rows, cols, fr, fc, st, sl, cw, ch,
      r0: Math.max(fr, Math.floor((st + fr * ROW_H) / ROW_H)),
      r1: Math.min(rows - 1, Math.floor((st + ch) / ROW_H)),
      c0: Math.max(fc, Math.floor((sl + fc * COL_W) / COL_W)),
      c1: Math.min(cols - 1, Math.floor((sl + cw) / COL_W)),
    };
  }

  function cellNodes(r0, r1, c0, c1, maxCol) {
    const nodes = [];
    for (let r = r0; r <= r1; r += 1) {
      const row = s.rows.get(r);
      if (!row) continue;
      for (let c = c0; c <= c1; c += 1) {
        const cell = row[c];
        if (!cell) continue;
        const fmt = cell.userEnteredFormat ?? {};
        const background = rgbOf(fmt.backgroundColorStyle?.rgbColor ?? fmt.backgroundColor);
        const text = cell.formattedValue ?? "";
        if (!text && !background) continue;
        const x = c * COL_W;
        const y = r * ROW_H;
        if (background) {
          const bg = el("div", { class: "cell" });
          Object.assign(bg.style, { left: `${x}px`, top: `${y}px`, width: `${COL_W - 1}px`, background });
          nodes.push(bg);
        }
        if (!text) continue;
        const effective = cell.effectiveValue ?? {};
        const node = el("div", { class: "cell", text });
        const textFormat = fmt.textFormat ?? {};
        let align = fmt.horizontalAlignment;
        if (!align) align = effective.numberValue !== undefined ? "RIGHT" : effective.boolValue !== undefined ? "CENTER" : "LEFT";
        if (align === "RIGHT") node.classList.add("right");
        if (align === "CENTER") node.classList.add("center");
        if (effective.errorValue) node.classList.add("err");
        if (cell.pending) node.classList.add("pending");
        let width = COL_W - 1;
        const wrap = fmt.wrapStrategy;
        if (wrap === "WRAP") node.classList.add("wrap");
        else if (wrap !== "CLIP" && align === "LEFT" && effective.stringValue !== undefined) {
          let next = c + 1;
          while (next <= maxCol && next < c + 12 && !hasValue(row[next])) {
            width += COL_W;
            next += 1;
          }
        }
        Object.assign(node.style, { left: `${x}px`, top: `${y}px`, width: `${width}px` });
        if (textFormat.bold) node.style.fontWeight = "700";
        if (textFormat.italic) node.style.fontStyle = "italic";
        const decoration = [textFormat.underline ? "underline" : "", textFormat.strikethrough ? "line-through" : ""].filter(Boolean).join(" ");
        if (decoration) node.style.textDecoration = decoration;
        if (textFormat.fontSize && textFormat.fontSize !== 10) node.style.fontSize = `${(textFormat.fontSize * 4) / 3}px`;
        const color = rgbOf(textFormat.foregroundColorStyle?.rgbColor ?? textFormat.foregroundColor);
        if (color) node.style.color = color;
        nodes.push(node);
      }
    }
    return nodes;
  }

  function selectionNodes() {
    const nodes = [];
    const { r0, r1, c0, c1, ar, ac } = s.sel;
    const box = (className, x, y, w, h) => {
      const node = el("div", { class: className });
      Object.assign(node.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
      return node;
    };
    if (r0 !== r1 || c0 !== c1) nodes.push(box("sel-range", c0 * COL_W - 1, r0 * ROW_H - 1, (c1 - c0 + 1) * COL_W + 1, (r1 - r0 + 1) * ROW_H + 1));
    if (!s.edit) nodes.push(box("sel-active", ac * COL_W - 1, ar * ROW_H - 1, COL_W + 1, ROW_H + 1));
    nodes.push(box("sel-handle", (c1 + 1) * COL_W - 5, (r1 + 1) * ROW_H - 5, 7, 7));
    return nodes;
  }

  function render() {
    if (!active()) return;
    const v = visibleRegion();
    const FH = v.fr * ROW_H;
    const FW = v.fc * COL_W;
    spacer.style.width = `${v.cols * COL_W}px`;
    spacer.style.height = `${v.rows * ROW_H}px`;
    mainLayer.style.width = spacer.style.width;
    mainLayer.style.height = spacer.style.height;

    const selection = selectionNodes;
    mainLayer.replaceChildren(...cellNodes(v.r0, v.r1, v.c0, v.c1, v.c1), ...selection());

    const place = (overlay, show, left, top, width, height, tx, ty, r0, r1, c0, c1) => {
      overlay.hidden = !show;
      if (!show) return;
      Object.assign(overlay.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
      const layer = overlay.firstChild;
      Object.assign(layer.style, { width: `${v.cols * COL_W}px`, height: `${v.rows * ROW_H}px`, transform: `translate(${-tx}px, ${-ty}px)` });
      layer.replaceChildren(...cellNodes(r0, r1, c0, c1, c1), ...selection());
    };
    place(topOverlay, v.fr > 0, HEAD_W, HEAD_H, v.cw, FH, v.sl, 0, 0, v.fr - 1, v.c0, v.c1);
    place(leftOverlay, v.fc > 0, HEAD_W, HEAD_H, FW, v.ch, 0, v.st, v.r0, v.r1, 0, v.fc - 1);
    place(cornerOverlay, v.fr > 0 && v.fc > 0, HEAD_W, HEAD_H, FW, FH, 0, 0, 0, v.fr - 1, 0, v.fc - 1);
    freezeH.hidden = v.fr === 0;
    if (v.fr > 0) Object.assign(freezeH.style, { left: "0px", top: `${HEAD_H + FH - 2}px`, width: `${HEAD_W + Math.min(v.cw, v.cols * COL_W)}px`, height: "4px" });
    freezeV.hidden = v.fc === 0;
    if (v.fc > 0) Object.assign(freezeV.style, { left: `${HEAD_W + FW - 2}px`, top: "0px", width: "4px", height: `${HEAD_H + Math.min(v.ch, v.rows * ROW_H)}px` });

    // Headers
    const fullCols = s.sel.r0 === 0 && s.sel.r1 === v.rows - 1;
    const fullRows = s.sel.c0 === 0 && s.sel.c1 === v.cols - 1;
    const colCell = (c, x) => {
      const node = el("div", { class: "hcell", text: columnName(c) });
      if (c >= s.sel.c0 && c <= s.sel.c1) node.classList.add(fullCols ? "full-sel" : "has-sel");
      Object.assign(node.style, { left: `${x}px`, top: "0px", width: `${COL_W}px`, height: `${HEAD_H}px` });
      return node;
    };
    const rowCell = (r, y) => {
      const node = el("div", { class: "hcell", text: String(r + 1) });
      if (r >= s.sel.r0 && r <= s.sel.r1) node.classList.add(fullRows ? "full-sel" : "has-sel");
      Object.assign(node.style, { left: "0px", top: `${y}px`, width: `${HEAD_W}px`, height: `${ROW_H}px` });
      return node;
    };
    const cols = [];
    for (let c = v.c0; c <= v.c1; c += 1) cols.push(colCell(c, c * COL_W - v.sl));
    for (let c = 0; c < v.fc; c += 1) cols.push(colCell(c, c * COL_W));
    colhead.replaceChildren(...cols);
    const rows = [];
    for (let r = v.r0; r <= v.r1; r += 1) rows.push(rowCell(r, r * ROW_H - v.st));
    for (let r = 0; r < v.fr; r += 1) rows.push(rowCell(r, r * ROW_H));
    rowhead.replaceChildren(...rows);

    positionEditor();
    updateStats();
  }

  body.addEventListener("scroll", () => {
    scheduleRender();
    void ensureChunks();
    hideTooltip();
  });
  new ResizeObserver(() => scheduleRender()).observe(grid);
  for (const overlay of [topOverlay, leftOverlay, cornerOverlay, colhead, rowhead]) {
    overlay.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        body.scrollBy(event.deltaX, event.deltaY);
      },
      { passive: false },
    );
  }

  // -------------------------------------------------------------------------------------------
  // Selection and pointer input
  // -------------------------------------------------------------------------------------------

  function clampSelection() {
    const { rows, cols } = dims();
    const clamp = (value, max) => Math.max(0, Math.min(value, max - 1));
    s.sel = { r0: clamp(s.sel.r0, rows), r1: clamp(s.sel.r1, rows), c0: clamp(s.sel.c0, cols), c1: clamp(s.sel.c1, cols), ar: clamp(s.sel.ar, rows), ac: clamp(s.sel.ac, cols) };
    s.anchor = { r: clamp(s.anchor.r, rows), c: clamp(s.anchor.c, cols) };
  }

  function select(r, c, { extend = false } = {}) {
    const { rows, cols } = dims();
    r = Math.max(0, Math.min(r, rows - 1));
    c = Math.max(0, Math.min(c, cols - 1));
    if (extend) {
      s.sel = { r0: Math.min(s.anchor.r, r), r1: Math.max(s.anchor.r, r), c0: Math.min(s.anchor.c, c), c1: Math.max(s.anchor.c, c), ar: s.anchor.r, ac: s.anchor.c };
      s.focus = { r, c };
    } else {
      s.anchor = { r, c };
      s.focus = { r, c };
      s.sel = { r0: r, r1: r, c0: c, c1: c, ar: r, ac: c };
    }
    scrollIntoView(r, c);
    afterSelection();
  }

  function selectRect(r0, c0, r1, c1) {
    s.anchor = { r: r0, c: c0 };
    s.focus = { r: r1, c: c1 };
    s.sel = { r0: Math.min(r0, r1), r1: Math.max(r0, r1), c0: Math.min(c0, c1), c1: Math.max(c0, c1), ar: r0, ac: c0 };
    afterSelection();
  }

  function afterSelection() {
    updateFormulaBar();
    renderToolbar();
    render();
  }

  function scrollIntoView(r, c) {
    const { fr, fc } = dims();
    const st = body.scrollTop;
    const sl = body.scrollLeft;
    if (r >= fr) {
      const top = r * ROW_H;
      if (top - fr * ROW_H < st) body.scrollTop = top - fr * ROW_H;
      else if (top + ROW_H > st + body.clientHeight) body.scrollTop = top + ROW_H - body.clientHeight;
    }
    if (c >= fc) {
      const left = c * COL_W;
      if (left - fc * COL_W < sl) body.scrollLeft = left - fc * COL_W;
      else if (left + COL_W > sl + body.clientWidth) body.scrollLeft = left + COL_W - body.clientWidth;
    }
  }

  function updateFormulaBar() {
    const cell = cellAt(s.sel.ar, s.sel.ac);
    if (document.activeElement !== nameBox) nameBox.value = rangeText(s.sel);
    if (!s.edit) formulaInput.value = enteredText(cell);
    formulaInput.readOnly = !canEdit();
  }

  /** Map a point inside #grid to { area, r, c }. */
  function hit(clientX, clientY) {
    const rect = grid.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const { rows, cols, fr, fc } = dims();
    const toCol = (px) => Math.max(0, Math.min(cols - 1, Math.floor((px < fc * COL_W ? px : px + body.scrollLeft) / COL_W)));
    const toRow = (py) => Math.max(0, Math.min(rows - 1, Math.floor((py < fr * ROW_H ? py : py + body.scrollTop) / ROW_H)));
    if (x < HEAD_W && y < HEAD_H) return { area: "corner" };
    if (y < HEAD_H) return { area: "colhead", c: toCol(x - HEAD_W) };
    if (x < HEAD_W) return { area: "rowhead", r: toRow(y - HEAD_H) };
    if (x - HEAD_W > body.clientWidth || y - HEAD_H > body.clientHeight) return { area: "scrollbar" };
    return { area: "cell", r: toRow(y - HEAD_H), c: toCol(x - HEAD_W) };
  }

  let drag;
  grid.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || gridState.contains(event.target) || event.target.classList?.contains("cell-editor")) return;
    const target = hit(event.clientX, event.clientY);
    if (target.area === "scrollbar") return;
    if (s.edit) void commitEdit(0, 0);
    const { rows, cols } = dims();
    event.preventDefault();
    grid.focus({ preventScroll: true });
    if (target.area === "corner") {
      selectRect(0, 0, rows - 1, cols - 1);
      return;
    }
    if (target.area === "colhead") {
      if (event.shiftKey) selectRect(0, s.anchor.c, rows - 1, target.c);
      else selectRect(0, target.c, rows - 1, target.c);
      drag = { kind: "col" };
    } else if (target.area === "rowhead") {
      if (event.shiftKey) selectRect(s.anchor.r, 0, target.r, cols - 1);
      else selectRect(target.r, 0, target.r, cols - 1);
      drag = { kind: "row" };
    } else {
      select(target.r, target.c, { extend: event.shiftKey });
      drag = { kind: "cell" };
    }
    grid.setPointerCapture(event.pointerId);
  });
  grid.addEventListener("pointermove", (event) => {
    if (!drag) {
      maybeTooltip(event);
      return;
    }
    const target = hit(event.clientX, event.clientY);
    const { rows, cols } = dims();
    if (drag.kind === "col" && target.c !== undefined) selectRect(0, s.anchor.c, rows - 1, target.c);
    else if (drag.kind === "row" && target.r !== undefined) selectRect(s.anchor.r, 0, target.r, cols - 1);
    else if (drag.kind === "cell" && target.area === "cell") {
      if (s.focus?.r !== target.r || s.focus?.c !== target.c) select(target.r, target.c, { extend: true });
    }
  });
  const endDrag = () => (drag = undefined);
  grid.addEventListener("pointerup", endDrag);
  grid.addEventListener("pointercancel", endDrag);
  grid.addEventListener("dblclick", (event) => {
    const target = hit(event.clientX, event.clientY);
    if (target.area === "cell") startEdit(null);
  });
  grid.addEventListener("contextmenu", (event) => {
    const target = hit(event.clientX, event.clientY);
    if (target.area === "scrollbar") return;
    event.preventDefault();
    if (target.area === "cell") {
      const inside = target.r >= s.sel.r0 && target.r <= s.sel.r1 && target.c >= s.sel.c0 && target.c <= s.sel.c1;
      if (!inside) select(target.r, target.c);
    }
    openCellMenu({ x: event.clientX, y: event.clientY });
  });

  function openCellMenu(point) {
    const disabled = !canEdit();
    openMenu(
      grid,
      [
        { label: `Insert ${count("ROWS")} above`, icon: "add", disabled, onSelect: () => insertDimension("ROWS", "before") },
        { label: `Insert ${count("ROWS")} below`, icon: "add", disabled, onSelect: () => insertDimension("ROWS", "after") },
        { label: `Insert ${count("COLUMNS")} left`, icon: "add", disabled, onSelect: () => insertDimension("COLUMNS", "before") },
        { label: `Insert ${count("COLUMNS")} right`, icon: "add", disabled, onSelect: () => insertDimension("COLUMNS", "after") },
        "divider",
        { label: s.sel.r0 === s.sel.r1 ? "Delete row" : `Delete rows ${s.sel.r0 + 1} - ${s.sel.r1 + 1}`, icon: "delete", disabled, onSelect: () => deleteDimension("ROWS") },
        { label: s.sel.c0 === s.sel.c1 ? "Delete column" : `Delete columns ${columnName(s.sel.c0)} - ${columnName(s.sel.c1)}`, icon: "delete", disabled, onSelect: () => deleteDimension("COLUMNS") },
        { label: "Delete values", icon: "format_clear", shortcut: "Delete", disabled, onSelect: clearSelection },
        "divider",
        { label: "Sort range", icon: "sort_by_alpha", disabled: disabled || (s.sel.r0 === s.sel.r1), submenu: () => [
          { label: "Sort range by column " + colLabel() + " (A to Z)", onSelect: () => sortSheet(false, false) },
          { label: "Sort range by column " + colLabel() + " (Z to A)", onSelect: () => sortSheet(true, false) },
        ] },
        { label: "Define named range", icon: "bookmark", disabled, onSelect: () => openNamedRanges({ adding: true }) },
      ],
      { point },
    );
  }

  // --- error tooltip ------------------------------------------------------------------------------
  const tooltip = $("#cell-tooltip");
  function hideTooltip() {
    tooltip.hidden = true;
  }
  function maybeTooltip(event) {
    const target = hit(event.clientX, event.clientY);
    const error = target.area === "cell" ? cellAt(target.r, target.c)?.effectiveValue?.errorValue : undefined;
    if (!error || s.edit) return hideTooltip();
    tooltip.replaceChildren(el("strong", { text: "Error" }), el("span", { text: error.message ?? error.type }));
    const rect = grid.getBoundingClientRect();
    const { fr, fc } = dims();
    const x = rect.left + HEAD_W + (target.c < fc ? target.c * COL_W : target.c * COL_W - body.scrollLeft) + COL_W;
    const y = rect.top + HEAD_H + (target.r < fr ? target.r * ROW_H : target.r * ROW_H - body.scrollTop);
    tooltip.style.left = `${Math.min(x + 4, window.innerWidth - 300)}px`;
    tooltip.style.top = `${y}px`;
    tooltip.hidden = false;
  }
  grid.addEventListener("pointerleave", hideTooltip);

  // -------------------------------------------------------------------------------------------
  // Keyboard
  // -------------------------------------------------------------------------------------------

  grid.addEventListener("keydown", (event) => {
    if (s.edit || event.target !== grid) return;
    const { rows, cols } = dims();
    const mod = event.ctrlKey || event.metaKey;
    const focus = s.focus ?? { r: s.sel.ar, c: s.sel.ac };
    const move = (dr, dc) => {
      event.preventDefault();
      if (event.shiftKey) {
        const r = mod ? (dr < 0 ? 0 : dr > 0 ? rows - 1 : focus.r) : focus.r + dr;
        const c = mod ? (dc < 0 ? 0 : dc > 0 ? cols - 1 : focus.c) : focus.c + dc;
        select(r, c, { extend: true });
      } else {
        const r = mod ? (dr < 0 ? 0 : dr > 0 ? rows - 1 : s.sel.ar) : s.sel.ar + dr;
        const c = mod ? (dc < 0 ? 0 : dc > 0 ? cols - 1 : s.sel.ac) : s.sel.ac + dc;
        select(r, c);
      }
    };
    const key = event.key;
    if (key === "ArrowDown") return move(1, 0);
    if (key === "ArrowUp") return move(-1, 0);
    if (key === "ArrowRight") return move(0, 1);
    if (key === "ArrowLeft") return move(0, -1);
    if (key === "Tab") {
      event.preventDefault();
      return select(s.sel.ar, s.sel.ac + (event.shiftKey ? -1 : 1));
    }
    if (key === "PageDown" || key === "PageUp") {
      event.preventDefault();
      const page = Math.max(1, Math.floor(body.clientHeight / ROW_H) - 1);
      return select(s.sel.ar + (key === "PageDown" ? page : -page), s.sel.ac);
    }
    if (key === "Home") {
      event.preventDefault();
      return select(mod ? 0 : s.sel.ar, 0);
    }
    if (key === "Enter" || key === "F2") {
      event.preventDefault();
      if (event.shiftKey && key === "Enter") return select(s.sel.ar - 1, s.sel.ac);
      return startEdit(null);
    }
    if (key === "Delete" || key === "Backspace") {
      event.preventDefault();
      return void clearSelection();
    }
    if (mod && key.toLowerCase() === "a") {
      event.preventDefault();
      return selectRect(0, 0, rows - 1, cols - 1);
    }
    if (mod && key.toLowerCase() === "b") {
      event.preventDefault();
      return void toggleText("bold");
    }
    if (mod && key.toLowerCase() === "i") {
      event.preventDefault();
      return void toggleText("italic");
    }
    if (mod && key.toLowerCase() === "u") {
      event.preventDefault();
      return void toggleText("underline");
    }
    if (event.altKey && event.shiftKey && (key === "5" || key === "%")) {
      event.preventDefault();
      return void toggleText("strikethrough");
    }
    if (mod && key === "\\") {
      event.preventDefault();
      return void clearFormatting();
    }
    if (mod && (key.toLowerCase() === "h" || key.toLowerCase() === "f")) {
      event.preventDefault();
      return openFindReplace();
    }
    if (event.shiftKey && key === "F11") {
      event.preventDefault();
      return void addSheet();
    }
    if (!mod && !event.altKey && key.length === 1) {
      event.preventDefault();
      startEdit(key);
    }
  });

  document.addEventListener("keydown", (event) => {
    if ($("#editor").hidden) return;
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === "o" && !event.shiftKey) {
      event.preventDefault();
      app.goHome();
    }
  });

  // --- clipboard -----------------------------------------------------------------------------------
  grid.addEventListener("copy", (event) => {
    if (s.edit) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", selectionText());
  });
  grid.addEventListener("cut", (event) => {
    if (s.edit || !canEdit()) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", selectionText());
    void clearSelection();
  });
  grid.addEventListener("paste", (event) => {
    if (s.edit) return;
    event.preventDefault();
    if (!canEdit()) return toast("You need edit access to paste into this spreadsheet.", { error: true });
    const text = event.clipboardData.getData("text/plain");
    if (!text) return;
    const values = text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").map((line) => line.split("\t"));
    const sheet = active();
    const width = Math.max(...values.map((row) => row.length));
    const range = `${quoteTitle(sheet.title)}!${a1(s.sel.ar, s.sel.ac)}:${a1(s.sel.ar + values.length - 1, s.sel.ac + width - 1)}`;
    const key = newKey();
    enqueueWrite(async () => {
      await call("values.batch-update", { spreadsheetId: s.id, valueInputOption: "USER_ENTERED", data: [{ range, values }] }, key);
      selectRect(s.sel.ar, s.sel.ac, s.sel.ar + values.length - 1, s.sel.ac + width - 1);
    });
  });

  function selectionText() {
    const lines = [];
    const r1 = Math.min(s.sel.r1, s.sel.r0 + 999);
    const c1 = Math.min(s.sel.c1, s.sel.c0 + 50);
    for (let r = s.sel.r0; r <= r1; r += 1) {
      const line = [];
      for (let c = s.sel.c0; c <= c1; c += 1) line.push(cellAt(r, c)?.formattedValue ?? "");
      lines.push(line.join("\t"));
    }
    return lines.join("\n");
  }

  // -------------------------------------------------------------------------------------------
  // Cell editing
  // -------------------------------------------------------------------------------------------

  function startEdit(initial, { draft, key, quick } = {}) {
    if (!canEdit()) {
      if (s.file?.trashed) toast("This file is in the trash. Restore it to edit.", { error: true });
      else toast("You can only view this spreadsheet.", { error: true });
      return;
    }
    const r = s.sel.ar;
    const c = s.sel.ac;
    const original = enteredText(cellAt(r, c));
    const input = el("textarea", { class: "cell-editor", attrs: { "aria-label": `Edit cell ${a1(r, c)}`, spellcheck: "false", rows: 1 } });
    input.value = draft ?? (initial === null ? original : initial);
    s.edit = { r, c, sheetId: s.sheetId, input, original, key: key ?? newKey(), quick: quick ?? initial !== null };
    grid.append(input);
    hideTooltip();
    positionEditor();
    formulaInput.value = input.value;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    input.addEventListener("input", () => {
      formulaInput.value = input.value;
      positionEditor();
    });
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      const edit = s.edit;
      if (!edit) return;
      if (event.key === "Enter" && !event.altKey) {
        event.preventDefault();
        void commitEdit(event.shiftKey ? -1 : 1, 0);
      } else if (event.key === "Tab") {
        event.preventDefault();
        void commitEdit(0, event.shiftKey ? -1 : 1);
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancelEdit();
      } else if (edit.quick && ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.key) && !input.value.startsWith("=")) {
        event.preventDefault();
        const moves = { ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
        void commitEdit(...moves[event.key]);
      } else if (event.key === "Enter" && event.altKey) {
        event.preventDefault();
        input.setRangeText("\n", input.selectionStart, input.selectionEnd, "end");
        formulaInput.value = input.value;
      }
    });
    render();
  }

  function positionEditor() {
    const edit = s.edit;
    if (!edit) return;
    if (edit.sheetId !== s.sheetId) return cancelEdit();
    const { fr, fc } = dims();
    const x = HEAD_W + (edit.c < fc ? edit.c * COL_W : edit.c * COL_W - body.scrollLeft) - 1;
    const y = HEAD_H + (edit.r < fr ? edit.r * ROW_H : edit.r * ROW_H - body.scrollTop) - 1;
    const input = edit.input;
    Object.assign(input.style, { left: `${x}px`, top: `${y}px`, minWidth: `${COL_W + 1}px`, width: "auto", height: "auto" });
    input.style.width = `${Math.max(COL_W + 1, Math.min(input.scrollWidth + 8, 600))}px`;
    const lines = input.value.split("\n").length;
    input.style.height = `${Math.max(ROW_H + 2, lines * 17 + 6)}px`;
  }

  function cancelEdit() {
    if (!s.edit) return;
    s.edit.input.remove();
    s.edit = undefined;
    updateFormulaBar();
    render();
    grid.focus({ preventScroll: true });
  }

  function commitEdit(dr, dc) {
    const edit = s.edit;
    if (!edit) return Promise.resolve();
    const text = edit.input.value;
    edit.input.remove();
    s.edit = undefined;
    grid.focus({ preventScroll: true });
    if (dr || dc) select(edit.r + dr, edit.c + dc);
    else afterSelection();
    if (text === edit.original) return Promise.resolve();
    return writeCell(edit, text);
  }

  function enqueueWrite(task, onFailure) {
    setSaving(1);
    s.queue = s.queue
      .then(async () => {
        try {
          await task();
          await reloadVisible();
        } catch (error) {
          if (onFailure) onFailure(error);
          else toast(describe(error), { error: true });
          await reloadVisible().catch(() => {});
        }
      })
      .finally(() => setSaving(-1));
    return s.queue;
  }

  function writeCell(edit, text) {
    const sheet = sheetById(edit.sheetId);
    if (!sheet) return Promise.resolve();
    const row = s.rows.get(edit.r) ?? [];
    const previous = row[edit.c];
    row[edit.c] = { ...(previous ?? {}), formattedValue: text, effectiveValue: { stringValue: text }, userEnteredValue: { stringValue: text }, pending: true };
    s.rows.set(edit.r, row);
    render();
    const range = `${quoteTitle(sheet.title)}!${a1(edit.r, edit.c)}`;
    return enqueueWrite(
      async () => {
        if (text === "") await call("values.clear", { spreadsheetId: s.id, range }, edit.key);
        else await call("values.batch-update", { spreadsheetId: s.id, valueInputOption: "USER_ENTERED", data: [{ range, values: [[text]] }] }, edit.key);
      },
      (error) => {
        const current = s.rows.get(edit.r);
        if (current && current[edit.c]?.pending) {
          if (previous) current[edit.c] = previous;
          else delete current[edit.c];
        }
        toast(`Your edit to ${a1(edit.r, edit.c)} wasn't saved. ${describe(error)}`, { error: true, timeout: 9000 });
        // Keep the unsaved text in the cell editor so it can be retried with the same idempotency key.
        if (s.sheetId === edit.sheetId && !s.edit && canEdit()) {
          select(edit.r, edit.c);
          startEdit(null, { draft: text, key: edit.key, quick: false });
        }
      },
    );
  }

  formulaInput.addEventListener("focus", () => {
    if (!canEdit() || s.edit) return;
    startEdit(null, { quick: false });
    formulaInput.focus();
  });
  formulaInput.addEventListener("input", () => {
    if (!s.edit) return;
    s.edit.input.value = formulaInput.value;
    positionEditor();
  });
  formulaInput.addEventListener("keydown", (event) => {
    if (!s.edit) return;
    if (event.key === "Enter") {
      event.preventDefault();
      void commitEdit(1, 0);
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelEdit();
    } else if (event.key === "Tab") {
      event.preventDefault();
      void commitEdit(0, 1);
    }
  });

  nameBox.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      nameBox.value = rangeText(s.sel);
      grid.focus();
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    const text = nameBox.value.trim();
    const named = (s.meta?.namedRanges ?? []).find((range) => range.name.toLowerCase() === text.toLowerCase());
    if (named) {
      goToNamed(named);
    } else {
      const parsed = parseA1(text);
      if (!parsed) {
        toast(`Invalid range: ${text}`, { error: true });
        return;
      }
      const target = parsed.title ? sheets().find((sheet) => sheet.title === parsed.title) : active();
      if (!target) return toast(`There is no sheet named “${parsed.title}”.`, { error: true });
      if (target.sheetId !== s.sheetId) switchSheet(target.sheetId);
      scrollIntoView(parsed.r0, parsed.c0);
      selectRect(parsed.r0, parsed.c0, parsed.r1, parsed.c1);
    }
    grid.focus();
  });
  $("#name-box-drop").addEventListener("click", (event) => {
    const ranges = s.meta?.namedRanges ?? [];
    openMenu(event.currentTarget, [
      ...(ranges.length ? ranges.map((range) => ({ label: range.name, hint: namedRangeText(range), onSelect: () => goToNamed(range) })) : [{ label: "No named ranges", disabled: true }]),
      "divider",
      { label: "Manage named ranges", icon: "bookmark", onSelect: openNamedRanges },
    ]);
  });

  // -------------------------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------------------------

  /** One spreadsheets.batch-update from a user action; reloads metadata and cells afterwards. */
  function batch(requests, { message, reloadMeta = true, key = newKey() } = {}) {
    if (!canEdit()) {
      toast("You need edit access to make this change.", { error: true });
      return Promise.resolve(undefined);
    }
    return action(async () => {
      setSaving(1);
      try {
        const result = await call("spreadsheets.batch-update", { spreadsheetId: s.id, requests }, key);
        if (reloadMeta) await refreshMeta();
        await reloadVisible();
        if (message) toast(typeof message === "function" ? message(result) : message);
        return result;
      } finally {
        setSaving(-1);
      }
    });
  }

  function setFormat(userEnteredFormat, fields) {
    return batch([{ repeatCell: { range: rangeOfSelection(), cell: { userEnteredFormat }, fields } }], { reloadMeta: false });
  }
  function toggleText(key) {
    const current = cellAt(s.sel.ar, s.sel.ac)?.userEnteredFormat?.textFormat?.[key] === true;
    return setFormat({ textFormat: { [key]: !current } }, `userEnteredFormat.textFormat.${key}`);
  }
  const setFontSize = (size) => setFormat({ textFormat: { fontSize: size } }, "userEnteredFormat.textFormat.fontSize");
  function bumpFontSize(delta) {
    const sizes = [6, 7, 8, 9, 10, 11, 12, 14, 18, 24, 36];
    const current = cellAt(s.sel.ar, s.sel.ac)?.userEnteredFormat?.textFormat?.fontSize ?? 10;
    const next = delta > 0 ? (sizes.find((size) => size > current) ?? current + 2) : ([...sizes].reverse().find((size) => size < current) ?? Math.max(1, current - 1));
    return setFontSize(next);
  }
  const setNumberFormat = (format) => setFormat(format ? { numberFormat: format } : {}, "userEnteredFormat.numberFormat");
  function stepDecimals(direction) {
    const current = cellAt(s.sel.ar, s.sel.ac)?.userEnteredFormat?.numberFormat;
    const step = current?.pattern ? DECIMALS[current.pattern] : undefined;
    if (step?.[direction]) return setNumberFormat({ type: step.type, pattern: step[direction] });
    if (!current) return setNumberFormat({ type: "NUMBER", pattern: direction === "more" ? "#,##0.00" : "#,##0" });
    toast(direction === "more" ? "This format already shows the most decimal places supported here." : "This format already shows no decimal places.");
    return Promise.resolve();
  }
  const clearFormatting = () => setFormat({}, "userEnteredFormat");

  function swatchPanel(onPick) {
    const panel = el("div", { class: "swatch-panel" });
    const reset = el("button", { class: "swatch-reset", attrs: { type: "button" } }, [icon("format_clear"), el("span", { text: "Reset" })]);
    reset.addEventListener("click", () => {
      closeMenus();
      onPick(null);
    });
    panel.append(reset);
    const gridNode = el("div", { class: "swatch-grid" });
    for (const row of PALETTE) {
      for (const hex of row) {
        const swatch = el("button", { class: "swatch", title: hex, attrs: { type: "button", "aria-label": hex } });
        swatch.style.background = hex;
        swatch.addEventListener("click", () => {
          closeMenus();
          onPick(hex);
        });
        gridNode.append(swatch);
      }
    }
    panel.append(gridNode);
    return panel;
  }

  function openColorMenu(anchor, kind) {
    openMenu(anchor, [
      {
        element: swatchPanel((hex) => {
          if (kind === "text") void setFormat(hex ? { textFormat: { foregroundColorStyle: { rgbColor: hexToColor(hex) } } } : {}, "userEnteredFormat.textFormat.foregroundColor");
          else void setFormat(hex ? { backgroundColorStyle: { rgbColor: hexToColor(hex) } } : {}, "userEnteredFormat.backgroundColor");
        }),
      },
    ]);
  }

  function clearSelection() {
    if (!canEdit()) {
      toast("You can only view this spreadsheet.", { error: true });
      return Promise.resolve();
    }
    const sheet = active();
    const range = `${quoteTitle(sheet.title)}!${rangeText(s.sel)}`;
    const key = newKey();
    return enqueueWrite(() => call("values.clear", { spreadsheetId: s.id, range }, key));
  }

  function insertDimension(dimension, where) {
    const rows = dimension === "ROWS";
    const start = rows ? s.sel.r0 : s.sel.c0;
    const length = rows ? s.sel.r1 - s.sel.r0 + 1 : s.sel.c1 - s.sel.c0 + 1;
    const startIndex = where === "before" ? start : start + length;
    return batch([{ insertDimension: { range: { sheetId: s.sheetId, dimension, startIndex, endIndex: startIndex + length }, inheritFromBefore: where === "after" || startIndex > 0 } }]);
  }

  async function deleteDimension(dimension) {
    const rows = dimension === "ROWS";
    const { rows: rowCount, cols } = dims();
    const start = rows ? s.sel.r0 : s.sel.c0;
    const end = (rows ? s.sel.r1 : s.sel.c1) + 1;
    if (end - start >= (rows ? rowCount : cols)) {
      toast(`You can't delete all the ${rows ? "rows" : "columns"} on the sheet.`, { error: true });
      return;
    }
    const label = rows ? (end - start === 1 ? `row ${start + 1}` : `rows ${start + 1}–${end}`) : end - start === 1 ? `column ${columnName(start)}` : `columns ${columnName(start)}–${columnName(end - 1)}`;
    if (!(await confirmDialog(`Delete ${label}?`, `Everything in ${label} will be removed and formulas that refer to it will change.`, { okLabel: "Delete", danger: true }))) return;
    await batch([{ deleteDimension: { range: { sheetId: s.sheetId, dimension, startIndex: start, endIndex: end } } }]);
    clampSelection();
    afterSelection();
  }

  async function addSheet() {
    const result = await batch([{ addSheet: { properties: {} } }]);
    const created = result?.replies?.[0]?.addSheet?.properties;
    if (created) switchSheet(created.sheetId);
  }

  async function deleteSheet(sheet) {
    if (!(await confirmDialog("Are you sure?", `Delete “${sheet.title}”? Formulas in other sheets that refer to it will show #REF!.`, { okLabel: "OK", danger: true }))) return;
    await batch([{ deleteSheet: { sheetId: sheet.sheetId } }], { message: `Deleted “${sheet.title}”` });
    if (s.sheetId === sheet.sheetId || !sheetById(s.sheetId)) switchSheet(sheets().find((candidate) => !candidate.hidden)?.sheetId);
  }

  async function duplicateSheet(sheet) {
    const result = await batch([{ duplicateSheet: { sourceSheetId: sheet.sheetId, insertSheetIndex: sheet.index + 1 } }]);
    const created = result?.replies?.[0]?.duplicateSheet?.properties;
    if (created) switchSheet(created.sheetId);
  }

  function updateSheet(properties, fields) {
    return batch([{ updateSheetProperties: { properties, fields } }]);
  }
  const setTabColor = (sheet, hex) => updateSheet(hex ? { sheetId: sheet.sheetId, tabColorStyle: { rgbColor: hexToColor(hex) } } : { sheetId: sheet.sheetId }, "tabColorStyle");
  const moveSheet = (sheet, index) => updateSheet({ sheetId: sheet.sheetId, index }, "index");
  async function hideSheet(sheet) {
    await updateSheet({ sheetId: sheet.sheetId, hidden: true }, "hidden");
    if (s.sheetId === sheet.sheetId) switchSheet(sheets().find((candidate) => !candidate.hidden)?.sheetId);
  }
  async function unhide(sheet) {
    await updateSheet({ sheetId: sheet.sheetId, hidden: false }, "hidden");
    if (sheetById(sheet.sheetId) && !sheetById(sheet.sheetId).hidden) switchSheet(sheet.sheetId);
  }

  async function sortSheet(descending, wholeSheet) {
    const { rows, cols, fr } = dims();
    const range = wholeSheet
      ? { sheetId: s.sheetId, startRowIndex: fr, endRowIndex: rows, startColumnIndex: 0, endColumnIndex: cols }
      : rangeOfSelection();
    await batch([{ sortRange: { range, sortSpecs: [{ dimensionIndex: s.sel.ac, sortOrder: descending ? "DESCENDING" : "ASCENDING" }] } }], { reloadMeta: false });
  }

  function insertFunction(name) {
    if (!canEdit()) return;
    const needsArgs = !["TODAY", "NOW"].includes(name);
    startEdit(`=${name}(${needsArgs ? "" : ")"}`, { quick: false });
  }

  // --- file actions ---------------------------------------------------------------------------------

  const toggleStar = () =>
    action(async () => {
      s.file = await call("files.update", { fileId: s.id, starred: !s.file.starred }, newKey());
      renderChrome();
      toast(s.file.starred ? "Added to starred" : "Removed from starred");
    });
  $("#star-btn").addEventListener("click", toggleStar);

  const setTrashed = (trashed) =>
    action(async () => {
      s.file = await call("files.update", { fileId: s.id, trashed }, newKey());
      renderChrome();
      toast(trashed ? "File moved to trash" : "File restored", trashed ? { actionLabel: "Undo", onAction: () => setTrashed(false) } : {});
    });

  let titleKey = newKey();
  let titleSaving = false;
  async function saveTitle() {
    const name = titleInput.value.trim();
    if (!s.file || titleSaving) return;
    if (!name) {
      titleInput.value = s.file.name;
      return;
    }
    if (name === s.file.name) return;
    titleSaving = true;
    await action(
      async () => {
        s.file = await call("files.update", { fileId: s.id, name }, titleKey);
        titleKey = newKey();
        renderChrome();
      },
      {
        exclusive: false,
        onError: (error) => {
          toast(`Couldn't rename: ${describe(error)}`, { error: true });
          titleInput.value = s.file.name;
        },
      },
    );
    titleSaving = false;
  }
  titleInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      grid.focus();
    } else if (event.key === "Escape") {
      titleInput.value = s.file?.name ?? "";
      grid.focus();
    }
  });
  titleInput.addEventListener("blur", () => void saveTitle());
  $("#editor-home").addEventListener("click", (event) => {
    event.preventDefault();
    app.goHome();
  });
  $("#history-btn").addEventListener("click", (event) => {
    const file = s.file;
    if (!file) return;
    const who = file.lastModifyingUser?.me ? "you" : (file.lastModifyingUser?.displayName ?? "someone");
    openMenu(event.currentTarget, [
      { heading: `Last edit was ${ago(file.modifiedTime, app.nowMs())} by ${who}` },
      { label: listDate(file.modifiedTime, app.nowMs()), icon: "history", disabled: true },
      { label: "Version history is not available in this simulated service", disabled: true },
    ], { align: "end" });
  });

  const createSpreadsheet = () =>
    action(async () => {
      const created = await call("spreadsheets.create", { properties: { title: "Untitled spreadsheet" } }, newKey());
      app.openSpreadsheet(created.spreadsheetId);
    });

  function makeCopy() {
    const input = el("input", { class: "text-field", attrs: { id: "copy-title", type: "text", value: `Copy of ${s.file?.name ?? ""}`, maxlength: 255 } });
    const ok = button("Make a copy", { className: "filled-btn" });
    const cancel = button("Cancel");
    const key = newKey();
    app.formOpened();
    const modal = openModal({ title: "Copy document", body: el("div", {}, [el("label", { class: "field-label", text: "Name", attrs: { for: "copy-title" } }), input, el("p", { class: "dialog-note", text: "Sheets, values, formats and named ranges are copied. Comments and version history are not part of this simulated service." })]), actions: [cancel, ok], onClose: () => app.formClosed() });
    input.select();
    cancel.addEventListener("click", modal.close);
    ok.addEventListener("click", () =>
      action(async () => {
        const name = input.value.trim();
        if (!name) return;
        ok.disabled = true;
        try {
          const created = await call("files.copy", { fileId: s.id, name }, key);
          modal.close();
          app.openSpreadsheet(created.id);
          toast(`Created “${created.name}”`);
        } finally {
          ok.disabled = false;
        }
      }),
    );
  }

  // --- copy sheet to another spreadsheet ------------------------------------------------------------

  function copySheetTo(sheet) {
    const list = el("div", { class: "picker-list" });
    const more = button("Load more");
    let token;
    const key = newKey();
    const loadPage = async (reset) => {
      if (reset) list.replaceChildren(el("div", { class: "picker-empty", text: "Loading…" }));
      try {
        const result = await call("files.list", { q: "trashed = false", orderBy: "modifiedTime desc", pageSize: 20, ...(token && !reset ? { pageToken: token } : {}) });
        if (reset) list.replaceChildren();
        for (const file of result.files) {
          const row = el("button", { class: "picker-row", attrs: { type: "button", disabled: !file.capabilities?.canEdit }, title: file.capabilities?.canEdit ? undefined : "You need edit access to copy a sheet here" }, [
            el("img", { attrs: { src: LOGO, alt: "", width: 20, height: 15 } }),
            el("span", { class: "picker-name", text: file.name }),
            el("span", { class: "picker-owner", text: file.ownedByMe ? "me" : (file.owners?.[0]?.displayName ?? "") }),
            el("span", { class: "picker-date", text: listDate(file.modifiedTime, app.nowMs()) }),
          ]);
          row.addEventListener("click", () =>
            action(async () => {
              await call("sheets.copy-to", { spreadsheetId: s.id, sheetId: sheet.sheetId, destinationSpreadsheetId: file.id }, key);
              modal.close();
              if (file.id === s.id) await refreshMeta();
              toast("Sheet copied successfully.", { actionLabel: "Open spreadsheet", onAction: async () => app.openSpreadsheet(file.id) });
            }),
          );
          list.append(row);
        }
        if (list.childElementCount === 0) list.append(el("div", { class: "picker-empty", text: "No spreadsheets" }));
        token = result.nextPageToken;
        more.hidden = !token;
      } catch (error) {
        list.replaceChildren(el("div", { class: "picker-empty error", text: describe(error) }));
      }
    };
    more.addEventListener("click", () => void loadPage(false));
    const cancel = button("Cancel");
    const modal = openModal({ title: "Select a spreadsheet to copy this sheet to", className: "picker", body: el("div", {}, [list, more]), actions: [cancel] });
    cancel.addEventListener("click", modal.close);
    void loadPage(true);
  }

  // --- named ranges ----------------------------------------------------------------------------------

  function namedRangeText(range) {
    const g = range.range ?? {};
    const sheet = sheetById(g.sheetId ?? 0);
    const title = sheet ? `${quoteTitle(sheet.title)}!` : "";
    if (g.startRowIndex === undefined && g.startColumnIndex === undefined) return title.replace(/!$/, "");
    const r0 = g.startRowIndex ?? 0;
    const c0 = g.startColumnIndex ?? 0;
    const r1 = (g.endRowIndex ?? (sheet?.gridProperties?.rowCount ?? 1000)) - 1;
    const c1 = (g.endColumnIndex ?? (sheet?.gridProperties?.columnCount ?? 26)) - 1;
    return `${title}${rangeText({ r0, c0, r1, c1 })}`;
  }

  function goToNamed(range) {
    const g = range.range ?? {};
    if (g.sheetId !== undefined && g.sheetId !== s.sheetId) switchSheet(g.sheetId);
    const { rows, cols } = dims();
    const r0 = g.startRowIndex ?? 0;
    const c0 = g.startColumnIndex ?? 0;
    scrollIntoView(r0, c0);
    selectRect(r0, c0, (g.endRowIndex ?? rows) - 1, (g.endColumnIndex ?? cols) - 1);
  }

  function openNamedRanges({ adding = false } = {}) {
    const panel = $("#side-panel");
    panel.hidden = false;
    const renderPanel = (showForm) => {
      const bodyNode = el("div", { class: "panel-body" });
      const ranges = s.meta?.namedRanges ?? [];
      if (ranges.length === 0 && !showForm) bodyNode.append(el("p", { class: "dialog-sub", text: "No named ranges yet. Name a range to refer to it in formulas, like =SUM(Budget)." }));
      for (const range of ranges) {
        const row = el("div", { class: "nr-row" }, [el("div", { class: "nr-info" }, [el("div", { class: "nr-name", text: range.name }), el("div", { class: "nr-range", text: namedRangeText(range) })])]);
        row.firstChild.addEventListener("click", () => goToNamed(range));
        row.firstChild.style.cursor = "pointer";
        const remove = iconButton("delete", `Delete ${range.name}`, { className: "small" });
        remove.disabled = !canEdit();
        remove.addEventListener("click", async () => {
          if (!(await confirmDialog("Remove named range?", `Are you sure you want to remove the named range “${range.name}”? Formulas that use it will show #NAME?.`, { okLabel: "Remove", danger: true }))) return;
          await batch([{ deleteNamedRange: { namedRangeId: range.namedRangeId } }]);
          renderPanel(false);
        });
        row.append(remove);
        bodyNode.append(row);
      }
      if (showForm) {
        const name = el("input", { class: "text-field", attrs: { type: "text", placeholder: "Enter a name", "aria-label": "Named range name", maxlength: 250 } });
        const range = el("input", { class: "text-field", attrs: { type: "text", "aria-label": "Range", value: `${quoteTitle(active().title)}!${rangeText(s.sel)}` } });
        const error = el("div", { class: "dialog-error", attrs: { role: "alert" } });
        const done = button("Done", { className: "filled-btn" });
        const cancel = button("Cancel");
        const key = newKey();
        cancel.addEventListener("click", () => renderPanel(false));
        done.addEventListener("click", async () => {
          const parsed = parseA1(range.value);
          const target = parsed?.title ? sheets().find((sheet) => sheet.title === parsed.title) : active();
          if (!parsed || !target) {
            error.textContent = "Enter a valid range, like Sheet1!A1:B10.";
            return;
          }
          const result = await batch([{ addNamedRange: { namedRange: { name: name.value.trim(), range: { sheetId: target.sheetId, startRowIndex: parsed.r0, endRowIndex: parsed.r1 + 1, startColumnIndex: parsed.c0, endColumnIndex: parsed.c1 + 1 } } } }], { key });
          if (result) renderPanel(false);
        });
        bodyNode.append(el("div", { class: "panel-form" }, [name, range, error, el("div", { class: "panel-actions" }, [cancel, done])]));
        name.focus();
      } else if (canEdit()) {
        const add = el("button", { class: "add-link", attrs: { type: "button" } }, [icon("add"), el("span", { text: "Add a range" })]);
        add.addEventListener("click", () => renderPanel(true));
        bodyNode.append(add);
      }
      const closeButton = iconButton("close", "Close", { className: "small" });
      closeButton.addEventListener("click", () => {
        panel.hidden = true;
        grid.focus();
      });
      panel.replaceChildren(el("div", { class: "panel-head" }, [el("span", { text: "Named ranges" }), closeButton]), bodyNode);
    };
    renderPanel(adding && canEdit());
  }

  // --- find and replace ------------------------------------------------------------------------------

  function openFindReplace() {
    const find = el("input", { class: "text-field", attrs: { id: "fr-find", type: "text", autocomplete: "off" } });
    const replace = el("input", { class: "text-field", attrs: { id: "fr-replace", type: "text", autocomplete: "off" } });
    const scope = el("select", { attrs: { id: "fr-scope" } }, [el("option", { text: "All sheets", attrs: { value: "all" } }), el("option", { text: "This sheet", attrs: { value: "sheet" } }), el("option", { text: "Specific range", attrs: { value: "range" } })]);
    const range = el("input", { class: "text-field", attrs: { type: "text", "aria-label": "Range", value: `${quoteTitle(active().title)}!${rangeText(s.sel)}` } });
    range.hidden = true;
    scope.addEventListener("change", () => (range.hidden = scope.value !== "range"));
    const check = (label, options = {}) => {
      const box = el("input", { attrs: { type: "checkbox", disabled: options.disabled } });
      const row = el("label", { class: `checkbox-row ${options.disabled ? "disabled" : ""}`, title: options.title }, [box, el("span", { text: label })]);
      return { box, row };
    };
    const matchCase = check("Match case");
    const entire = check("Match entire cell contents");
    const regex = check("Search using regular expressions", { disabled: true, title: NOT_AVAILABLE });
    const formulas = check("Also search within formulas");
    const status = el("div", { class: "dialog-note", attrs: { role: "status" } });
    const findButton = button("Find", { className: "outlined-btn" });
    const replaceButton = button("Replace", { className: "outlined-btn" });
    const replaceAll = button("Replace all", { className: "outlined-btn" });
    const done = button("Done", { className: "filled-btn" });
    app.formOpened();
    const modal = openModal({
      title: "Find and replace",
      className: "find-dialog",
      body: el("div", { class: "form-grid" }, [
        el("label", { text: "Find", attrs: { for: "fr-find" } }), find,
        el("label", { text: "Replace with", attrs: { for: "fr-replace" } }), replace,
        el("label", { text: "Search", attrs: { for: "fr-scope" } }), el("div", {}, [scope, range]),
        el("span"), el("div", {}, [matchCase.row, entire.row, regex.row, formulas.row, status]),
      ]),
      actions: [findButton, replaceButton, replaceAll, done],
      onClose: () => app.formClosed(),
    });
    find.focus();
    done.addEventListener("click", modal.close);

    const targetSheets = () => {
      if (scope.value === "all") return sheets();
      if (scope.value === "sheet") return [active()];
      const parsed = parseA1(range.value);
      const target = parsed?.title ? sheets().find((sheet) => sheet.title === parsed.title) : active();
      return parsed && target ? [{ ...target, bounds: parsed }] : [];
    };
    const matches = (text) => {
      const needle = find.value;
      if (!needle) return false;
      const a = matchCase.box.checked ? text : text.toLowerCase();
      const b = matchCase.box.checked ? needle : needle.toLowerCase();
      return entire.box.checked ? a === b : a.includes(b);
    };

    findButton.addEventListener("click", () =>
      action(async () => {
        if (!find.value) return;
        const targets = targetSheets();
        if (targets.length === 0) return (status.textContent = "Enter a valid range.");
        const hits = [];
        const [formatted, entered] = await Promise.all([
          call("values.batch-get", { spreadsheetId: s.id, ranges: targets.map((sheet) => (sheet.bounds ? `${quoteTitle(sheet.title)}!${rangeText(sheet.bounds)}` : quoteTitle(sheet.title))), valueRenderOption: "FORMATTED_VALUE" }),
          call("values.batch-get", { spreadsheetId: s.id, ranges: targets.map((sheet) => (sheet.bounds ? `${quoteTitle(sheet.title)}!${rangeText(sheet.bounds)}` : quoteTitle(sheet.title))), valueRenderOption: "FORMULA" }),
        ]);
        targets.forEach((sheet, index) => {
          const offsetR = sheet.bounds?.r0 ?? 0;
          const offsetC = sheet.bounds?.c0 ?? 0;
          const shown = formatted.valueRanges[index]?.values ?? [];
          const typed = entered.valueRanges[index]?.values ?? [];
          shown.forEach((row, r) =>
            row.forEach((value, c) => {
              const formula = String(typed[r]?.[c] ?? "");
              const isFormula = formula.startsWith("=");
              if (matches(String(value)) || (formulas.box.checked && isFormula && matches(formula))) hits.push({ sheetId: sheet.sheetId, r: r + offsetR, c: c + offsetC, formula });
            }),
          );
        });
        if (hits.length === 0) {
          status.textContent = `No other results found for “${find.value}”`;
          s.findCursor = undefined;
          return;
        }
        const order = (hit) => [sheets().findIndex((sheet) => sheet.sheetId === hit.sheetId), hit.r, hit.c];
        const current = [sheets().findIndex((sheet) => sheet.sheetId === s.sheetId), s.sel.ar, s.sel.ac];
        const after = (a, b) => a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])));
        let next = hits.find((hit) => after(order(hit), current));
        let looped = false;
        if (!next) {
          next = hits[0];
          looped = true;
        }
        if (next.sheetId !== s.sheetId) switchSheet(next.sheetId);
        scrollIntoView(next.r, next.c);
        select(next.r, next.c);
        s.findCursor = next;
        status.textContent = `${hits.length} result${hits.length === 1 ? "" : "s"}${looped ? " · no more results, looping around" : ""}`;
      }),
    );

    replaceButton.addEventListener("click", () => {
      const hit = s.findCursor;
      if (!hit || hit.sheetId !== s.sheetId || hit.r !== s.sel.ar || hit.c !== s.sel.ac) {
        findButton.click();
        return;
      }
      const sheet = sheetById(hit.sheetId);
      const original = enteredText(cellAt(hit.r, hit.c)) || hit.formula;
      if (original.startsWith("=") && !formulas.box.checked) return findButton.click();
      const flags = matchCase.box.checked ? "g" : "gi";
      const escaped = find.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const next = entire.box.checked ? replace.value : original.replace(new RegExp(escaped, flags), () => replace.value);
      if (!canEdit()) return toast("You need edit access to replace.", { error: true });
      const key = newKey();
      void enqueueWrite(async () => {
        await call("values.batch-update", { spreadsheetId: s.id, valueInputOption: "USER_ENTERED", data: [{ range: `${quoteTitle(sheet.title)}!${a1(hit.r, hit.c)}`, values: [[next]] }] }, key);
        s.findCursor = undefined;
        status.textContent = `Replaced 1 instance of “${find.value}” with “${replace.value}”`;
      });
    });

    replaceAll.addEventListener("click", async () => {
      if (!find.value) return;
      const request = { find: find.value, replacement: replace.value, matchCase: matchCase.box.checked, matchEntireCell: entire.box.checked, includeFormulas: formulas.box.checked };
      if (scope.value === "all") request.allSheets = true;
      else if (scope.value === "sheet") request.sheetId = s.sheetId;
      else {
        const target = targetSheets()[0];
        if (!target) return (status.textContent = "Enter a valid range.");
        request.range = { sheetId: target.sheetId, startRowIndex: target.bounds.r0, endRowIndex: target.bounds.r1 + 1, startColumnIndex: target.bounds.c0, endColumnIndex: target.bounds.c1 + 1 };
      }
      const result = await batch([{ findReplace: request }], { reloadMeta: false });
      const counts = result?.replies?.[0]?.findReplace;
      if (counts) status.textContent = counts.occurrencesChanged ? `Replaced ${counts.occurrencesChanged} instance${counts.occurrencesChanged === 1 ? "" : "s"} of “${find.value}” with “${replace.value}”` : `No instances of “${find.value}” found`;
    });
  }

  // --- sharing ---------------------------------------------------------------------------------------

  async function openShare() {
    const file = s.file;
    if (!file) return;
    const canShare = file.capabilities?.canShare === true;
    const people = el("div", { class: "share-people" });
    const general = el("div", { class: "general-access" });
    const more = button("Show more");
    more.hidden = true;
    const email = el("input", { class: "text-field", attrs: { type: "email", placeholder: "Add people and groups", "aria-label": "Add people and groups", autocomplete: "off", disabled: !canShare } });
    const role = el("select", { attrs: { "aria-label": "Role", disabled: !canShare } }, ["reader", "commenter", "writer"].map((value) => el("option", { text: ROLE_LABELS[value], attrs: { value, selected: value === "writer" } })));
    const send = button("Share", { className: "filled-btn" });
    send.disabled = true;
    email.addEventListener("input", () => (send.disabled = !email.value.trim()));
    const error = el("div", { class: "dialog-error", attrs: { role: "alert" } });
    let permissions = [];
    let token;

    const load = async (reset) => {
      try {
        const result = await call("permissions.list", { fileId: s.id, pageSize: 20, ...(reset || !token ? {} : { pageToken: token }) });
        permissions = reset ? result.permissions : [...permissions, ...result.permissions];
        token = result.nextPageToken;
        more.hidden = !token;
        error.textContent = "";
        draw();
      } catch (problem) {
        error.textContent = describe(problem);
      }
    };

    const mutate = (task) =>
      action(
        async () => {
          await task();
          await load(true);
          s.file = await call("files.get", { fileId: s.id });
          renderChrome();
        },
        { onError: (problem) => (error.textContent = describe(problem)) },
      );

    function draw() {
      const me = app.about?.user?.emailAddress;
      const rows = permissions.filter((permission) => permission.type === "user").map((permission) => {
        const name = permission.displayName ?? permission.emailAddress;
        const info = el("div", { class: "person-info" }, [el("div", { class: "person-name", text: `${name}${permission.emailAddress === me ? " (you)" : ""}` }), el("div", { class: "person-email", text: permission.emailAddress })]);
        let control;
        if (permission.role === "owner" || !canShare) control = el("span", { class: "person-role", text: ROLE_LABELS[permission.role] ?? permission.role });
        else {
          control = el("select", { class: "role-select", attrs: { "aria-label": `Access for ${name}` } }, [
            ...["reader", "commenter", "writer"].map((value) => el("option", { text: ROLE_LABELS[value], attrs: { value, selected: permission.role === value } })),
            el("option", { text: "Remove access", attrs: { value: "remove" } }),
          ]);
          control.addEventListener("change", () => {
            if (control.value === "remove") void mutate(() => call("permissions.delete", { fileId: s.id, permissionId: permission.id }, newKey()));
            else void mutate(() => call("permissions.create", { fileId: s.id, type: "user", role: control.value, emailAddress: permission.emailAddress, sendNotificationEmail: false }, newKey()));
          });
        }
        return el("div", { class: "person-row" }, [avatar(name, permission.emailAddress), info, control]);
      });
      people.replaceChildren(...rows);

      const anyone = permissions.find((permission) => permission.type === "anyone");
      const domainPermission = permissions.find((permission) => permission.type === "domain");
      const domain = domainPermission?.domain ?? (me ? me.split("@")[1] : "example.test");
      const mode = anyone ? "anyone" : domainPermission ? "domain" : "restricted";
      const current = anyone ?? domainPermission;
      const modeSelect = el("select", { attrs: { "aria-label": "General access", disabled: !canShare } }, [
        el("option", { text: "Restricted", attrs: { value: "restricted", selected: mode === "restricted" } }),
        el("option", { text: domain, attrs: { value: "domain", selected: mode === "domain" } }),
        el("option", { text: "Anyone with the link", attrs: { value: "anyone", selected: mode === "anyone" } }),
      ]);
      const description = mode === "restricted" ? "Only people with access can open with the link" : mode === "domain" ? `Anyone in this group with the link can ${current.role === "writer" ? "edit" : current.role === "commenter" ? "comment" : "view"}` : `Anyone on the internet with the link can ${current.role === "writer" ? "edit" : current.role === "commenter" ? "comment" : "view"}`;
      const nodes = [
        el("span", { class: `general-icon ${mode === "restricted" ? "restricted" : ""}` }, [icon(mode === "anyone" ? "public" : mode === "domain" ? "domain" : "lock")]),
        el("div", { class: "general-body" }, [modeSelect, el("div", { class: "general-desc", text: description })]),
      ];
      if (current) {
        const roleSelect = el("select", { class: "role-select", attrs: { "aria-label": "Link role", disabled: !canShare } }, ["reader", "commenter", "writer"].map((value) => el("option", { text: ROLE_LABELS[value], attrs: { value, selected: current.role === value } })));
        roleSelect.addEventListener("change", () => void mutate(() => call("permissions.create", { fileId: s.id, type: current.type, role: roleSelect.value, ...(current.type === "domain" ? { domain: current.domain } : {}), allowFileDiscovery: false }, newKey())));
        nodes.push(roleSelect);
      }
      modeSelect.addEventListener("change", () =>
        void mutate(async () => {
          const next = modeSelect.value;
          if (current) await call("permissions.delete", { fileId: s.id, permissionId: current.id }, newKey());
          if (next === "anyone") await call("permissions.create", { fileId: s.id, type: "anyone", role: current?.role ?? "reader", allowFileDiscovery: false }, newKey());
          if (next === "domain") await call("permissions.create", { fileId: s.id, type: "domain", domain, role: current?.role ?? "reader", allowFileDiscovery: false }, newKey());
        }),
      );
      general.replaceChildren(el("div", { class: "general-row" }, nodes));
    }

    send.addEventListener("click", () => {
      const address = email.value.trim();
      if (!address) return;
      const key = newKey();
      void mutate(async () => {
        await call("permissions.create", { fileId: s.id, type: "user", role: role.value, emailAddress: address, sendNotificationEmail: false }, key);
        email.value = "";
        send.disabled = true;
        toast(`Shared with ${address}. No e-mail is sent in this simulated service.`);
      });
    });
    more.addEventListener("click", () => void load(false));

    const copyLink = el("button", { class: "outlined-btn copy-link", attrs: { type: "button" } }, [icon("link"), el("span", { text: "Copy link" })]);
    copyLink.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(file.webViewLink ?? "");
        toast("Link copied");
      } catch {
        toast(file.webViewLink ?? "", { timeout: 9000 });
      }
    });
    const doneButton = button("Done", { className: "filled-btn" });
    app.formOpened();
    const modal = openModal({
      title: `Share “${file.name}”`,
      className: "share-dialog",
      body: el("div", {}, [
        el("div", { class: "share-add" }, [email, role, send]),
        canShare ? null : el("p", { class: "dialog-note", text: "Only the owner can change who has access." }),
        error,
        el("h3", { class: "section-title", text: "People with access" }),
        people,
        more,
        el("h3", { class: "section-title", text: "General access" }),
        general,
      ]),
      actions: [el("div", { class: "share-footer", attrs: { style: undefined } }, [copyLink]), doneButton],
      onClose: () => app.formClosed(),
    });
    doneButton.addEventListener("click", modal.close);
    people.append(el("div", { class: "picker-empty", text: "Loading…" }));
    await load(true);
  }
  $("#share-btn").addEventListener("click", () => void openShare());
  $("#move-btn").addEventListener("click", () => notSimulated("Move", "Folders are not modelled by this Tool, so a spreadsheet cannot be moved."));
  $("#comments-btn").addEventListener("click", () => notSimulated("Comments", "Comments and comment history are not modelled by this Tool."));
  $("#meet-btn").addEventListener("click", () => notSimulated("Google Meet"));
  $("#explore-btn").addEventListener("click", () => notSimulated("Explore"));

  // -------------------------------------------------------------------------------------------
  // Selection statistics (bottom-right chip)
  // -------------------------------------------------------------------------------------------

  const statChip = $("#stat-chip");
  function statistics() {
    const { r0, r1, c0, c1 } = s.sel;
    if (r0 === r1 && c0 === c1) return undefined;
    const numbers = [];
    let counta = 0;
    let pattern;
    let visited = 0;
    for (const [r, row] of s.rows) {
      if (r < r0 || r > r1) continue;
      for (let c = c0; c <= Math.min(c1, row.length - 1); c += 1) {
        const cell = row[c];
        if (!hasValue(cell)) continue;
        visited += 1;
        if (visited > 50000) break;
        counta += 1;
        const value = cell.effectiveValue?.numberValue;
        if (typeof value === "number") {
          numbers.push(value);
          pattern ??= cell.userEnteredFormat?.numberFormat;
        }
      }
    }
    if (counta === 0) return undefined;
    const format = (value) => {
      if (pattern?.type === "CURRENCY") return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
      if (pattern?.type === "PERCENT") return new Intl.NumberFormat("en-US", { style: "percent", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
      return new Intl.NumberFormat("en-US", { maximumFractionDigits: 10 }).format(value);
    };
    if (numbers.length === 0) return { stats: { Count: String(counta) }, primary: "Count" };
    const sum = numbers.reduce((total, value) => total + value, 0);
    return {
      stats: {
        Sum: format(sum),
        Average: format(sum / numbers.length),
        Min: format(Math.min(...numbers)),
        Max: format(Math.max(...numbers)),
        Count: String(counta),
        "Count numbers": String(numbers.length),
      },
      primary: s.stat,
    };
  }
  function updateStats() {
    const result = statistics();
    if (!result) {
      statChip.hidden = true;
      return;
    }
    const key = result.stats[result.primary] !== undefined ? result.primary : Object.keys(result.stats)[0];
    statChip.hidden = false;
    statChip.replaceChildren(el("span", { text: `${key}: ${result.stats[key]}` }), icon("arrow_drop_down"));
    statChip.onclick = () =>
      openMenu(
        statChip,
        Object.entries(result.stats).map(([name, value]) => ({ label: `${name}: ${value}`, checked: name === key, onSelect: () => ((s.stat = name), updateStats()) })),
        { point: { x: statChip.getBoundingClientRect().right - 220, y: statChip.getBoundingClientRect().top - 32 * Object.keys(result.stats).length - 16 } },
      );
  }

  // -------------------------------------------------------------------------------------------
  // Sheet bar buttons
  // -------------------------------------------------------------------------------------------

  $("#add-sheet").addEventListener("click", () => void addSheet());
  $("#all-sheets").addEventListener("click", (event) => {
    const anchor = event.currentTarget;
    const rect = anchor.getBoundingClientRect();
    openMenu(
      anchor,
      sheets().map((sheet) => ({
        label: sheet.title,
        checked: sheet.sheetId === s.sheetId,
        hint: sheet.hidden ? "Hidden" : undefined,
        onSelect: () => (sheet.hidden ? (canEdit() ? void unhide(sheet) : toast("You need edit access to unhide a sheet.", { error: true })) : switchSheet(sheet.sheetId)),
      })),
      { point: { x: rect.left, y: rect.top - 8 - 32 * sheets().length - 12 } },
    );
  });

  return {
    open,
    close,
    refresh,
    hasUnsavedInput: () => Boolean(s.edit) || document.activeElement === titleInput || Boolean(document.querySelector(".tab-rename, .panel-form")),
  };
}
