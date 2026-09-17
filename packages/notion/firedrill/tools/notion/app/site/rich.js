// Rendering of Notion rich text and property values into safe DOM (textContent only; links are anchors with
// rel="noopener" that never resolve inside the test environment).
import { icon } from "./icons.js";
import { avatar, el, propertyDate } from "./ui.js";

export const OPTION_COLORS = ["default", "gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];

export const EMOJIS = [
  "📄", "📝", "📚", "📖", "🗂️", "🗃️", "📁", "📌", "📎", "🔖", "🧭", "🗺️", "🏠", "🏢", "🏭", "🚀", "🛠️", "⚙️", "🔧", "🔩",
  "🤖", "🦾", "🔋", "🔌", "💡", "🧪", "🔬", "📡", "🛰️", "📦", "🚚", "🏗️", "📐", "🎨", "🖌️", "🧩", "🎯", "✅", "☑️", "📋",
  "📅", "🗓️", "⏰", "🔔", "💬", "📣", "📊", "📈", "📉", "💰", "🏷️", "🔑", "🔒", "🛡️", "⚠️", "🚧", "🔥", "⭐", "🌟", "❤️",
  "👋", "🙌", "🧠", "👀", "🍀", "🌱", "🌍", "☕", "🍕", "🎉", "🎁", "🏆", "🥇", "🎓", "✈️", "🚗", "🐛", "🦄", "🐙", "🐝",
];

/** Rich text array → span with annotated runs, links and mentions. */
export function richText(items, { className = "rich" } = {}) {
  const host = el("span", { class: className });
  for (const item of Array.isArray(items) ? items : []) host.append(richItem(item));
  return host;
}

function richItem(item) {
  const annotations = item.annotations ?? {};
  let text = item.plain_text ?? item.text?.content ?? "";
  let node;
  if (item.type === "mention") {
    const mention = item.mention ?? {};
    if (mention.type === "user") node = el("span", { class: "mention mention-user", text: `@${mention.user?.name ?? text.replace(/^@/, "") ?? "user"}` });
    else if (mention.type === "page") node = el("span", { class: "mention mention-page" }, [icon("page", "mention-icon"), el("span", { text: text || "Untitled" })]);
    else if (mention.type === "date") node = el("span", { class: "mention mention-date", text: `@${propertyDate(mention.date) || text}` });
    else node = el("span", { class: "mention", text });
  } else if (item.href || item.text?.link?.url) {
    node = el("a", { class: "rich-link", text, attrs: { href: item.href ?? item.text.link.url, target: "_blank", rel: "noopener noreferrer" } });
  } else {
    node = el("span", { text });
  }
  const classes = [];
  if (annotations.bold) classes.push("b");
  if (annotations.italic) classes.push("i");
  if (annotations.strikethrough) classes.push("s");
  if (annotations.underline) classes.push("u");
  if (annotations.code) classes.push("code");
  if (classes.length > 0) node.classList.add(...classes);
  if (annotations.color && annotations.color !== "default") node.dataset.color = annotations.color;
  return node;
}

export function plain(items) {
  return (Array.isArray(items) ? items : []).map((item) => item.plain_text ?? item.text?.content ?? "").join("");
}

/** Plain-text content → the rich text array the API expects. */
export function textToRich(content) {
  return content.length === 0 ? [] : [{ type: "text", text: { content } }];
}

/** Coloured pill for select / multi-select / status options. */
export function pill(option, { status = false } = {}) {
  const element = el("span", { class: `pill ${status ? "status" : ""}`.trim(), text: option.name });
  element.dataset.color = option.color ?? "default";
  if (status) element.prepend(el("span", { class: "status-dot" }));
  return element;
}

export function checkbox(checked, { onToggle, label = "Checkbox" } = {}) {
  const box = el("button", { class: `checkbox ${checked ? "checked" : ""}`.trim(), attrs: { type: "button", role: "checkbox", "aria-checked": String(checked), "aria-label": label } });
  if (checked) box.append(icon("check", "checkbox-mark"));
  if (onToggle) box.addEventListener("click", (event) => { event.stopPropagation(); onToggle(!checked); });
  else box.disabled = true;
  return box;
}

/** Name for a user object (partial objects have no name). */
export function userName(user, users) {
  if (!user) return "";
  if (user.name) return user.name;
  const known = users?.get?.(user.id);
  return known?.name ?? "Unknown user";
}

export function person(user, users, { size = "" } = {}) {
  const name = userName(user, users);
  return el("span", { class: "person" }, [avatar({ id: user?.id, name }, size), el("span", { class: "person-name", text: name })]);
}

/**
 * Render one property value (Notion page property object) for a cell or the property panel.
 * `lookup`: { users: Map, pages: Map<id, {title, icon}> } for people and relation values.
 */
export function propertyValue(property, lookup = {}) {
  const type = property.type;
  const value = property[type];
  const host = el("span", { class: `prop-value type-${type}` });
  switch (type) {
    case "title":
    case "rich_text":
      host.append(richText(value));
      break;
    case "number":
      host.textContent = value === null || value === undefined ? "" : String(value);
      break;
    case "select":
      if (value) host.append(pill(value));
      break;
    case "status":
      if (value) host.append(pill(value, { status: true }));
      break;
    case "multi_select":
      for (const option of value ?? []) host.append(pill(option));
      break;
    case "date":
      host.textContent = propertyDate(value);
      break;
    case "checkbox":
      host.append(checkbox(value === true));
      break;
    case "url":
      if (value) host.append(el("a", { class: "cell-link", text: value, attrs: { href: value, target: "_blank", rel: "noopener noreferrer" } }));
      break;
    case "email":
      if (value) host.append(el("a", { class: "cell-link", text: value, attrs: { href: `mailto:${value}` } }));
      break;
    case "phone_number":
      host.textContent = value ?? "";
      break;
    case "people":
      for (const user of value ?? []) host.append(person(user, lookup.users));
      break;
    case "created_by":
    case "last_edited_by":
      if (value) host.append(person(value, lookup.users));
      break;
    case "relation":
      for (const ref of value ?? []) {
        const target = lookup.pages?.get(ref.id);
        host.append(el("span", { class: "relation-chip" }, [target?.icon ? el("span", { class: "relation-icon", text: target.icon }) : icon("page", "relation-icon"), el("span", { text: target?.title ?? "Untitled" })]));
      }
      break;
    case "created_time":
    case "last_edited_time":
      host.textContent = value ? propertyDate({ start: value }) : "";
      break;
    default:
      host.textContent = typeof value === "string" ? value : "";
  }
  return host;
}

/** Emoji string of an icon object, or undefined for none / external images (never loaded here). */
export function emojiOf(iconObject) {
  return iconObject && iconObject.type === "emoji" ? iconObject.emoji : undefined;
}

/** Page or database icon node: the emoji, or the product's grey document / database glyph. */
export function objectIcon(iconObject, kind = "page", className = "") {
  const emoji = emojiOf(iconObject);
  if (emoji !== undefined) return el("span", { class: `obj-icon emoji ${className}`.trim(), text: emoji, attrs: { "aria-hidden": "true" } });
  return icon(kind === "database" ? "database" : "page", `obj-icon glyph ${className}`.trim());
}
