// Document viewer: the stored text split into pages (form feed), with fields overlaid at their percentage boxes.
import { icon } from "./icons.js";
import { el } from "./ui.js";

export const FIELD_LABEL = { SIGNATURE: "Signature", INITIALS: "Initials", NAME: "Name", EMAIL: "Email", DATE: "Date", TEXT: "Text", CHECKBOX: "Checkbox", NUMBER: "Number", RADIO: "Radio", DROPDOWN: "Dropdown" };
const COLORS = ["green", "blue", "purple", "orange", "yellow", "pink"];

/** Stable colour per recipient, by the recipient's position in the document's recipient list. */
export const recipientColor = (recipients, recipientId) => COLORS[Math.max(0, recipients.findIndex((r) => r.id === recipientId)) % COLORS.length];

/**
 * options: { fields, recipients, fieldNode(field) → extra children, onPlace(page, x, y), placing: boolean, highlight(field) → boolean }
 */
export function documentViewer(content, options = {}) {
  const { fields = [], recipients = [] } = options;
  const pages = String(content ?? "").split("\f");
  const card = el("div", { class: "doc-card" });
  const inner = el("div", { class: "doc-card-inner" });
  card.append(inner);
  pages.forEach((text, index) => {
    const number = index + 1;
    const page = el("div", { class: `doc-page ${options.placing ? "is-placing" : ""}`, attrs: { "data-page": number, "aria-label": `Page ${number} of ${pages.length}`, role: "region" } });
    const lines = text.split("\n");
    const body = el("div", { class: "doc-page-text" });
    lines.forEach((line, i) => body.append(el(i === 0 ? "h2" : "p", { class: i === 0 ? "doc-page-title" : line.trim() === "" ? "doc-gap" : "", text: line })));
    page.append(body);
    for (const f of fields.filter((x) => x.page === number)) page.append(fieldBox(f, recipients, options));
    if (options.onPlace) {
      page.addEventListener("click", (event) => {
        if (!options.placing || event.target.closest(".field")) return;
        const rect = page.getBoundingClientRect();
        options.onPlace(number, ((event.clientX - rect.left) / rect.width) * 100, ((event.clientY - rect.top) / rect.height) * 100);
      });
    }
    inner.append(page);
  });
  return card;
}

function fieldBox(f, recipients, options) {
  const color = recipientColor(recipients, f.recipientId);
  const recipient = recipients.find((r) => r.id === f.recipientId);
  const own = options.highlight ? options.highlight(f) : true;
  const box = el("div", { class: `field field-${color} ${f.inserted ? "is-inserted" : ""} ${own ? "" : "is-dim"} field-type-${f.type.toLowerCase()}`, title: `${FIELD_LABEL[f.type] ?? f.type}${recipient ? ` · ${recipient.name || recipient.email}` : ""}` });
  box.style.left = `${f.positionX}%`;
  box.style.top = `${f.positionY}%`;
  box.style.width = `${f.width}%`;
  box.style.height = `${f.height}%`;
  const value = f.inserted ? (f.type === "CHECKBOX" ? (f.customText === "true" ? "☑" : "☐") : f.customText) : null;
  if (value !== null) box.append(el("span", { class: `field-value ${f.type === "SIGNATURE" || f.type === "INITIALS" ? "is-signature" : ""}`, text: value }));
  else box.append(el("span", { class: "field-label" }, [f.type === "CHECKBOX" ? icon("checkSquare") : null, el("span", { text: f.fieldMeta?.label || FIELD_LABEL[f.type] || f.type })]));
  for (const extra of options.fieldNode?.(f) ?? []) box.append(extra);
  return box;
}

/** Default box size (percent of the page) for a newly placed field type. */
export function defaultSize(type) {
  if (type === "CHECKBOX") return { width: 5, height: 4 };
  if (type === "SIGNATURE") return { width: 30, height: 8 };
  if (type === "INITIALS") return { width: 12, height: 6 };
  return { width: 25, height: 5 };
}
