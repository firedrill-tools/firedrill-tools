// Sort menu and filter builder for record and entry tables. Filters compile to Attio's filter syntax.
import { icon, typeIcon } from "./icons.js";
import { choices } from "./store.js";
import { button, closePopover, el, menu, popover } from "./ui.js";

const TEXT_TYPES = new Set(["text", "personal-name", "email-address", "domain", "phone-number"]);
const ORDERED = new Set(["number", "currency", "date", "timestamp"]);

export function filterableDefs(defs) {
  return defs.filter((d) => !d.is_archived && (TEXT_TYPES.has(d.type) || ORDERED.has(d.type) || ["select", "status", "checkbox", "actor-reference", "record-reference"].includes(d.type)));
}

export function operatorsFor(def) {
  if (TEXT_TYPES.has(def.type)) return [["$contains", "contains"], ["$starts_with", "starts with"], ["$eq", "is"], ["$not_empty", "is not empty"], ["$empty", "is empty"]];
  if (ORDERED.has(def.type)) return [["$eq", "is"], ["$gt", "greater than"], ["$gte", "at least"], ["$lt", "less than"], ["$lte", "at most"], ["$not_empty", "is not empty"], ["$empty", "is empty"]];
  if (def.type === "select" || def.type === "status") return [["$eq", "is"], ["$not_empty", "is not empty"], ["$empty", "is empty"]];
  if (def.type === "checkbox") return [["true", "is checked"], ["false", "is not checked"]];
  return [["$not_empty", "is not empty"], ["$empty", "is empty"]];
}

const FIELD = { "personal-name": "full_name", "email-address": "email_address", domain: "domain", "phone-number": "phone_number", currency: "currency_value", select: "option", status: "status" };

/** Build one Attio filter clause. */
export function clause(def, op, raw) {
  const slug = def.api_slug;
  if (def.type === "checkbox") return { [slug]: op === "true" };
  if (op === "$empty") return { $not: { [slug]: { $not_empty: true } } };
  if (op === "$not_empty") return { [slug]: { $not_empty: true } };
  let value = raw;
  if (def.type === "number" || def.type === "currency") value = Number(raw);
  const inner = { [op]: value };
  return FIELD[def.type] ? { [slug]: { [FIELD[def.type]]: inner } } : { [slug]: inner };
}

export function combine(filters) {
  if (filters.length === 0) return undefined;
  return filters.length === 1 ? filters[0].filter : { $and: filters.map((f) => f.filter) };
}

/** Sort menu; `onPick({attribute, direction} | null)`. */
export function openSortMenu(anchor, defs, current, onPick) {
  const items = [{ header: "Sort by" }];
  if (current) items.push({ label: "Remove sort", icon: "x", onSelect: () => onPick(null) }, "divider");
  for (const d of defs.filter((x) => !x.is_multiselect && x.type !== "record-reference" && x.type !== "actor-reference")) {
    const on = current?.attribute === d.api_slug;
    items.push({ label: d.title, icon: typeIcon(d.type), hint: on ? (current.direction === "asc" ? "Ascending" : "Descending") : undefined, checked: on || undefined, onSelect: () => onPick({ attribute: d.api_slug, direction: on && current.direction === "asc" ? "desc" : "asc" }) });
  }
  menu(anchor, items, { width: 260 });
}

/** Filter builder popover; `onAdd({ filter, label })`. `target`/`slug` identify the attribute owner for option lookups. */
export function openFilterPopover(anchor, defs, { target, slug }, onAdd) {
  const usable = filterableDefs(defs);
  const box = el("form", { class: "at-filter-pop" });
  const attr = el("select", { class: "at-select", attrs: { "aria-label": "Attribute", id: "filter-attr" } });
  for (const d of usable) attr.append(el("option", { text: d.title, attrs: { value: d.api_slug } }));
  const op = el("select", { class: "at-select", attrs: { "aria-label": "Condition", id: "filter-op" } });
  const valueSlot = el("div");
  const error = el("div", { class: "at-field-error", attrs: { role: "alert" } });
  let valueControl;
  const defOf = () => usable.find((d) => d.api_slug === attr.value);
  const syncValue = async () => {
    const def = defOf();
    const needsValue = !["$empty", "$not_empty", "true", "false"].includes(op.value);
    valueSlot.replaceChildren();
    valueControl = undefined;
    if (!needsValue || !def) return;
    if (def.type === "select" || def.type === "status") {
      valueControl = el("select", { class: "at-select", attrs: { "aria-label": "Value" } });
      valueSlot.append(valueControl);
      try {
        for (const c of await choices(target, slug, def)) valueControl.append(el("option", { text: c.title, attrs: { value: c.title } }));
      } catch {
        error.textContent = "Options could not be loaded.";
      }
    } else {
      const type = def.type === "number" || def.type === "currency" ? "number" : def.type === "date" ? "date" : def.type === "timestamp" ? "datetime-local" : "text";
      valueControl = el("input", { class: "at-input", attrs: { type, "aria-label": "Value", placeholder: "Value", step: type === "number" ? "any" : undefined } });
      valueSlot.append(valueControl);
    }
  };
  const syncOps = () => {
    const def = defOf();
    op.replaceChildren(...(def ? operatorsFor(def) : []).map(([v, label]) => el("option", { text: label, attrs: { value: v } })));
    void syncValue();
  };
  attr.addEventListener("change", syncOps);
  op.addEventListener("change", () => void syncValue());
  const add = button("Apply filter", { class: "primary small" });
  add.type = "submit";
  box.append(el("div", { class: "at-hint", text: "Where" }), el("div", { class: "at-filter-row" }, [attr, op, valueSlot]), error, el("div", { class: "at-editor-actions" }, [button("Cancel", { class: "small ghost", onClick: () => closePopover() }), add]));
  box.addEventListener("submit", (event) => {
    event.preventDefault();
    const def = defOf();
    if (!def) return;
    let raw = valueControl?.value?.trim?.() ?? "";
    if (valueControl && raw === "") {
      error.textContent = "Enter a value to filter by.";
      return;
    }
    if (def.type === "timestamp" && raw) raw = `${raw}:00.000000000Z`;
    const opLabel = op.selectedOptions[0]?.textContent ?? op.value;
    closePopover();
    onAdd({ filter: clause(def, op.value, raw), label: `${def.title} ${opLabel}${valueControl ? ` ${valueControl.value}` : ""}` });
  });
  if (usable.length === 0) box.replaceChildren(el("div", { class: "at-hint pad", text: "No filterable attributes" }));
  else syncOps();
  popover(anchor, box, { width: 480 });
}

export function filterChip(label, onRemove) {
  const chip = el("span", { class: "at-chip-filter" }, [icon("filter", "", 12), el("span", { text: label })]);
  const x = el("button", { class: "at-icon-btn", attrs: { type: "button", "aria-label": `Remove filter ${label}`, title: "Remove filter" } }, icon("x", "", 12));
  x.addEventListener("click", onRemove);
  chip.append(x);
  return chip;
}
