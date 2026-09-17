// Deterministic one-page invoice PDF (PDF 1.4, Helvetica, ASCII text) and a hand-written base64 codec.
// The document derives only from state, so repeated runs produce identical bytes.

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** base64 of a string whose char codes are all < 256. */
export function base64FromBinary(binary) {
  let out = "";
  for (let i = 0; i < binary.length; i += 3) {
    const a = binary.charCodeAt(i);
    const b = i + 1 < binary.length ? binary.charCodeAt(i + 1) : 0;
    const c = i + 2 < binary.length ? binary.charCodeAt(i + 2) : 0;
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < binary.length ? B64[((b & 15) << 2) | (c >> 6)] : "=";
    out += i + 2 < binary.length ? B64[c & 63] : "=";
  }
  return out;
}

/** Strict base64 → Uint8Array, or null when the text is not canonical base64. */
export function bytesFromBase64(text) {
  if (typeof text !== "string" || text.length % 4 !== 0) return null;
  const pad = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const bytes = new Uint8Array((text.length / 4) * 3 - pad);
  let k = 0;
  for (let i = 0; i < text.length; i += 4) {
    const values = [];
    for (let j = 0; j < 4; j += 1) {
      const char = text[i + j];
      if (char === "=" && i + 4 === text.length && j >= 4 - pad) values.push(0);
      else {
        const index = B64.indexOf(char);
        if (index < 0) return null;
        values.push(index);
      }
    }
    const n = (values[0] << 18) | (values[1] << 12) | (values[2] << 6) | values[3];
    if (k < bytes.length) bytes[k++] = (n >> 16) & 255;
    if (k < bytes.length) bytes[k++] = (n >> 8) & 255;
    if (k < bytes.length) bytes[k++] = n & 255;
  }
  return bytes;
}

function pdfText(value) {
  let out = "";
  for (const char of String(value)) {
    const code = char.codePointAt(0);
    if (code < 32 || code > 126) out += "?";
    else if (char === "(" || char === ")" || char === "\\") out += `\\${char}`;
    else out += char;
  }
  return out.length > 120 ? `${out.slice(0, 117)}...` : out;
}

const money = (value) => `$${Number(value).toFixed(2)}`;

/** Text lines of the invoice document. */
export function invoiceLines(company, invoice) {
  const lines = [company.CompanyName, "INVOICE", `Invoice no. ${invoice.DocNumber}`, `Invoice date: ${invoice.TxnDate}`, `Due date: ${invoice.DueDate}`, `Bill to: ${invoice.CustomerRef.name ?? invoice.CustomerRef.value}`];
  if (invoice.BillEmail) lines.push(`Email: ${invoice.BillEmail.Address}`);
  lines.push("");
  for (const line of invoice.Line) {
    if (line.DetailType !== "SalesItemLineDetail") continue;
    const detail = line.SalesItemLineDetail;
    const label = line.Description ?? detail.ItemRef.name ?? detail.ItemRef.value;
    lines.push(`${line.LineNum}. ${label}  ${detail.Qty} x ${money(detail.UnitPrice)} = ${money(line.Amount)}`);
  }
  lines.push("", `Total: ${money(invoice.TotalAmt)}`, `Balance due: ${money(invoice.Balance)}`);
  if (invoice.CustomerMemo) lines.push(`Message: ${invoice.CustomerMemo.value}`);
  return lines;
}

/** Complete PDF file as a binary (Latin-1) string. */
export function invoicePdf(company, invoice) {
  const text = invoiceLines(company, invoice).slice(0, 60);
  const stream = `BT /F1 10 Tf 13 TL 50 790 Td ${text.map((line) => `(${pdfText(line)}) Tj T*`).join(" ")} ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let file = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(file.length);
    file += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = file.length;
  file += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) file += `${String(offset).padStart(10, "0")} 00000 n \n`;
  file += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return file;
}
