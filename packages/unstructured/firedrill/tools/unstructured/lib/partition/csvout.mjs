// `output_format=text/csv`: a fixed column set, arrays as JSON strings, RFC 4180 quoting.

export const CSV_COLUMNS = [
  "type", "element_id", "text", "filename", "filetype", "languages", "page_number", "parent_id", "category_depth", "text_as_html", "last_modified",
  "link_urls", "link_texts", "emphasized_text_contents", "emphasized_text_tags", "is_continuation", "orig_elements",
];

function cell(value) {
  if (value === undefined || value === null) return "";
  const text = typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function elementsToCsv(elements) {
  const lines = [CSV_COLUMNS.join(",")];
  for (const element of elements) {
    const row = [];
    for (const column of CSV_COLUMNS) {
      if (column === "type" || column === "element_id" || column === "text") row.push(cell(element[column]));
      else row.push(cell(element.metadata[column]));
    }
    lines.push(row.join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}
