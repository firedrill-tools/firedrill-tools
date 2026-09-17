// Drive-specific model helpers: MIME vocabulary, file-type glyphs, sizes, dates and the `q` query builder.
// "Now" always comes from the world's virtual clock (`about.get` → `serverTime`), never from the browser clock.
import { el } from "./ui.js";
import { icon } from "./icons.js";

export const FOLDER = "application/vnd.google-apps.folder";
export const SHORTCUT = "application/vnd.google-apps.shortcut";
export const DOC = "application/vnd.google-apps.document";
export const SHEET = "application/vnd.google-apps.spreadsheet";
export const SLIDES = "application/vnd.google-apps.presentation";

export const isFolder = (file) => file?.mimeType === FOLDER;
export const isShortcut = (file) => file?.mimeType === SHORTCUT;
export const isGoogleType = (mimeType) => typeof mimeType === "string" && mimeType.startsWith("application/vnd.google-apps.");

const TEXTUAL = /^(text\/|application\/(json|xml|javascript|x-yaml))/;
/** Files this app can show inline: Google editor types and UTF-8 text blobs. */
export const isTextual = (file) => (file ? isGoogleType(file.mimeType) ? file.mimeType !== FOLDER && file.mimeType !== SHORTCUT : TEXTUAL.test(file.mimeType ?? "") : false);
export const isImage = (file) => (file?.mimeType ?? "").startsWith("image/");

/** Drive's own type labels, as the Details pane prints them. */
export function typeLabel(mimeType) {
  switch (mimeType) {
    case FOLDER:
      return "Google Drive Folder";
    case SHORTCUT:
      return "Shortcut";
    case DOC:
      return "Google Docs";
    case SHEET:
      return "Google Sheets";
    case SLIDES:
      return "Google Slides";
    case "application/pdf":
      return "PDF";
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return "Microsoft Word";
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
      return "Microsoft Excel";
    case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
      return "Microsoft PowerPoint";
    case "text/plain":
      return "Text";
    case "text/markdown":
      return "Markdown";
    case "text/csv":
      return "Comma Separated Values";
    case "application/json":
      return "JSON";
    case "image/png":
      return "PNG image";
    case "image/jpeg":
      return "JPEG image";
    default:
      return mimeType ?? "File";
  }
}

const PRODUCT_ICONS = { [DOC]: "./assets/google-docs-2026.svg", [SHEET]: "./assets/google-sheets-2026.svg", [SLIDES]: "./assets/google-slides-2026.svg" };

/** Glyph colours Drive uses for non-Google file types. */
function blobGlyph(mimeType = "") {
  if (mimeType === "application/pdf") return ["picture_as_pdf", "#ea4335"];
  if (mimeType.startsWith("image/")) return ["image", "#ea4335"];
  if (mimeType.startsWith("video/")) return ["movie", "#ea4335"];
  if (mimeType.startsWith("audio/")) return ["audio", "#ea4335"];
  if (mimeType.includes("wordprocessingml") || mimeType === "application/msword") return ["description", "#4285f4"];
  if (mimeType.includes("spreadsheetml") || mimeType === "text/csv" || mimeType === "application/vnd.ms-excel") return ["description", "#34a853"];
  if (mimeType.includes("presentationml") || mimeType === "application/vnd.ms-powerpoint") return ["description", "#fbbc04"];
  if (mimeType === "application/json" || mimeType === "application/xml" || mimeType === "text/html") return ["code", "#5f6368"];
  if (mimeType.startsWith("text/")) return ["description", "#5f6368"];
  if (mimeType.includes("zip") || mimeType.includes("compressed")) return ["archive", "#5f6368"];
  return ["insert_drive_file", "#5f6368"];
}

/** The type icon Drive puts in front of every row: the real product mark for Docs/Sheets/Slides, a Material glyph otherwise. */
export function fileIcon(file, className = "") {
  const source = PRODUCT_ICONS[file?.mimeType];
  if (source) return el("img", { class: `gd-file-icon ${className}`.trim(), attrs: { src: source, alt: "", width: 20, height: 20 } });
  if (isFolder(file)) {
    const glyph = icon(file.shared ? "folder_shared" : "folder", `gd-file-icon ${className}`.trim());
    glyph.style.color = file.folderColorRgb || "#5f6368";
    return glyph;
  }
  if (isShortcut(file)) {
    const target = file.shortcutDetails?.targetMimeType;
    if (target && target !== SHORTCUT) return fileIcon({ mimeType: target }, className);
    const glyph = icon("shortcut", `gd-file-icon ${className}`.trim());
    glyph.style.color = "#5f6368";
    return glyph;
  }
  const [name, color] = blobGlyph(file?.mimeType);
  const glyph = icon(name, `gd-file-icon ${className}`.trim());
  glyph.style.color = color;
  return glyph;
}

// ---------------------------------------------------------------------------------------------
// Sizes and dates
// ---------------------------------------------------------------------------------------------

/** Drive prints sizes in KB/MB/GB with one decimal place; folders and shortcuts print an em dash. */
export function formatSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "0 bytes";
  if (value < 1024) return `${value} bytes`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Storage figures in the sidebar ("1.4 GB of 15 GB used"). */
export function formatQuota(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value)) return "—";
  if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(value >= 10 * 1024 * 1024 * 1024 ? 0 : 2)} GB`;
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} bytes`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (value) => String(value).padStart(2, "0");

/** "13:42", "Sep 12, 2026" — the Last modified column, relative to virtual now. */
export function formatListDate(iso, now) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const today = new Date(now);
  const sameDay = date.getUTCFullYear() === today.getUTCFullYear() && date.getUTCMonth() === today.getUTCMonth() && date.getUTCDate() === today.getUTCDate();
  if (sameDay) return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
  const yesterday = new Date(today.getTime() - 86400000);
  if (date.getUTCFullYear() === yesterday.getUTCFullYear() && date.getUTCMonth() === yesterday.getUTCMonth() && date.getUTCDate() === yesterday.getUTCDate()) return "Yesterday";
  if (date.getUTCFullYear() === today.getUTCFullYear()) return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

/** "12 Sep 2026, 14:20" — the Details pane. */
export function formatFullDate(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

/** Drive groups Recent into Today / Yesterday / Earlier this week / Earlier this month / Earlier. */
export function recencyBucket(iso, now) {
  if (!iso) return "Earlier";
  const date = new Date(iso).getTime();
  const today = new Date(now);
  const startOfDay = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  if (date >= startOfDay) return "Today";
  if (date >= startOfDay - 86400000) return "Yesterday";
  if (date >= startOfDay - 7 * 86400000) return "Earlier this week";
  if (date >= startOfDay - 30 * 86400000) return "Earlier this month";
  return "Earlier";
}

/** The most recent moment Drive would sort this file by. */
export const recencyOf = (file) => [file.viewedByMeTime, file.modifiedByMeTime, file.modifiedTime, file.sharedWithMeTime].filter(Boolean).sort().pop();

export function isoDaysAgo(now, days) {
  const date = new Date(new Date(now).getTime() - days * 86400000);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

// ---------------------------------------------------------------------------------------------
// `q` query builder — every view and every chip compiles to the Drive query grammar
// ---------------------------------------------------------------------------------------------

/** Escape a value for a single-quoted Drive query string. */
export const quote = (value) => `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

export const TYPE_FILTERS = [
  { id: "folders", label: "Folders", clause: `mimeType = ${quote(FOLDER)}` },
  { id: "documents", label: "Documents", clause: `mimeType = ${quote(DOC)}` },
  { id: "spreadsheets", label: "Spreadsheets", clause: `mimeType = ${quote(SHEET)}` },
  { id: "presentations", label: "Presentations", clause: `mimeType = ${quote(SLIDES)}` },
  { id: "pdfs", label: "PDFs", clause: `mimeType = ${quote("application/pdf")}` },
  { id: "photos", label: "Photos & images", clause: `mimeType = ${quote("image/png")} or mimeType = ${quote("image/jpeg")}` },
  { id: "shortcuts", label: "Shortcuts", clause: `mimeType = ${quote(SHORTCUT)}` },
];

export const MODIFIED_FILTERS = [
  { id: "today", label: "Today", days: 0 },
  { id: "7", label: "Last 7 days", days: 7 },
  { id: "30", label: "Last 30 days", days: 30 },
  { id: "365", label: "This year", days: 365 },
];

export const SOURCE_FILTERS = [
  { id: "mine", label: "Owned by me", clause: (me) => `${quote(me)} in owners` },
  { id: "shared", label: "Shared with me", clause: "sharedWithMe = true" },
  { id: "starred", label: "Starred", clause: "starred = true" },
];

/** Compile a view plus its active chips into one Drive `q` string. */
export function buildQuery({ scope, folderId, text, type, owner, modified, source, me, now }) {
  const clauses = [];
  if (scope === "folder") clauses.push(`${quote(folderId || "root")} in parents`, "trashed = false");
  else if (scope === "shared") clauses.push("sharedWithMe = true", "trashed = false");
  else if (scope === "starred") clauses.push("starred = true", "trashed = false");
  else if (scope === "trash") clauses.push("trashed = true");
  else clauses.push("trashed = false");
  if (text) {
    const value = quote(text);
    clauses.push(`(name contains ${value} or fullText contains ${value})`);
  }
  if (type) {
    const filter = TYPE_FILTERS.find((entry) => entry.id === type);
    if (filter) clauses.push(filter.clause.includes(" or ") ? `(${filter.clause})` : filter.clause);
  }
  if (owner) clauses.push(`${quote(owner)} in owners`);
  if (source) {
    const filter = SOURCE_FILTERS.find((entry) => entry.id === source);
    if (filter) clauses.push(typeof filter.clause === "function" ? filter.clause(me ?? "") : filter.clause);
  }
  if (modified) {
    const filter = MODIFIED_FILTERS.find((entry) => entry.id === modified);
    if (filter) clauses.push(`modifiedTime > ${quote(isoDaysAgo(now, filter.days))}`);
  }
  return clauses.join(" and ");
}
