// RFC 4180 CSV/TSV parsing into a single Table element with `text_as_html`.
import { escapeHtml } from "./html-util.mjs";

const MAX_ROWS = 10000;
const MAX_COLUMNS = 200;

/** Returns { rows } or { error }. Quoted fields may contain delimiters, quotes ("") and newlines. */
export function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field.length === 0) {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = "";
      if (row.length > MAX_COLUMNS) return { error: `File has more than ${MAX_COLUMNS} columns` };
      i += 1;
      continue;
    }
    if (ch === "\r" && text[i + 1] === "\n") i += 1;
    if (ch === "\n" || ch === "\r") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      if (rows.length > MAX_ROWS) return { error: `File has more than ${MAX_ROWS} rows` };
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (quoted) return { error: "File is not a valid csv" };
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length > MAX_ROWS) return { error: `File has more than ${MAX_ROWS} rows` };
  return { rows: rows.filter((r) => !(r.length === 1 && r[0].length === 0)) };
}

export function tableHtml(rows) {
  let html = "<table>";
  for (const row of rows) {
    html += "<tr>";
    for (const cell of row) html += `<td>${escapeHtml(cell)}</td>`;
    html += "</tr>";
  }
  return `${html}</table>`;
}

export function tableText(rows) {
  return rows.map((row) => row.map((cell) => cell.replace(/[\r\n]+/g, " ")).join(" ")).join("\n");
}

export function partitionDelimited(builder, text, delimiter) {
  const parsed = parseDelimited(text, delimiter);
  if (parsed.error !== undefined) return { ok: false, message: parsed.error };
  if (parsed.rows.length > 0) builder.add("Table", tableText(parsed.rows), { text_as_html: tableHtml(parsed.rows) });
  return { ok: true };
}
