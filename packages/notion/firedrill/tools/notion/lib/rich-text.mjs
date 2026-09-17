// Notion rich text: validation of request items (`text`, `mention`) and the normalised stored/returned form.
import { normalizeId } from "./ids.mjs";
import { jsonBytes, OBJECT_BUDGET_BYTES } from "./size.mjs";
import { shown, validationError } from "./state.mjs";

export const COLORS = Object.freeze([
  "default", "gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red",
  "gray_background", "brown_background", "orange_background", "yellow_background", "green_background",
  "blue_background", "purple_background", "pink_background", "red_background",
]);
const MAX_ITEMS = 100;
const MAX_CONTENT = 2000;
const MAX_URL = 2000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

export function isDateString(value) {
  return typeof value === "string" && (DATE_ONLY.test(value) || DATE_TIME.test(value));
}

export function defaultAnnotations() {
  return { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" };
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function annotations(context, value, path) {
  const result = defaultAnnotations();
  if (value === undefined) return result;
  if (!isObject(value)) return validationError(context, `body failed validation: body.${path}.annotations should be an object.`);
  for (const key of ["bold", "italic", "strikethrough", "underline", "code"]) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== "boolean") return validationError(context, `body failed validation: body.${path}.annotations.${key} should be a boolean.`);
    result[key] = value[key];
  }
  if (value.color !== undefined) {
    if (!COLORS.includes(value.color)) return validationError(context, `body failed validation: body.${path}.annotations.color should be a valid color, instead was \`${shown(value.color)}\`.`);
    result.color = value.color;
  }
  return result;
}

export function textItem(content, options = {}) {
  const link = options.link ?? null;
  return {
    type: "text",
    text: { content, link },
    annotations: { ...defaultAnnotations(), ...(options.annotations ?? {}) },
    plain_text: content,
    href: link === null ? null : link.url,
  };
}

/** Validate and normalise a rich text array from a request body. `path` names the field for messages. */
export function normalizeRichText(context, value, path) {
  if (!Array.isArray(value)) return validationError(context, `body failed validation: body.${path} should be an array, instead was \`${JSON.stringify(value)}\`.`);
  if (value.length > MAX_ITEMS) return validationError(context, `body failed validation: body.${path}.length should be ≤ ${MAX_ITEMS}, instead was ${value.length}.`);
  const items = [];
  // Rendered text appears twice per item (text.content and plain_text), so the array is bounded by the encoded bytes
  // it renders to, measured as items are admitted; one stored block, page or comment always fits one response.
  let bytes = 0;
  const admit = (normalized) => {
    bytes += jsonBytes(normalized) + 1;
    if (bytes > OBJECT_BUDGET_BYTES) {
      return validationError(context, `body failed validation: body.${path} would be more than ${OBJECT_BUDGET_BYTES} bytes once rendered (text.content and plain_text both carry the text).`);
    }
    items.push(normalized);
  };
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    const itemPath = `${path}[${index}]`;
    if (!isObject(item)) return validationError(context, `body failed validation: body.${itemPath} should be an object.`);
    const type = item.type ?? (item.text !== undefined ? "text" : item.mention !== undefined ? "mention" : undefined);
    if (type === "text") {
      if (!isObject(item.text) || typeof item.text.content !== "string") {
        return validationError(context, `body failed validation: body.${itemPath}.text.content should be a string.`);
      }
      if (item.text.content.length > MAX_CONTENT) {
        return validationError(context, `body failed validation: body.${itemPath}.text.content.length should be ≤ ${MAX_CONTENT}, instead was ${item.text.content.length}.`);
      }
      let link = null;
      if (item.text.link !== undefined && item.text.link !== null) {
        if (!isObject(item.text.link) || typeof item.text.link.url !== "string" || item.text.link.url.length === 0) {
          return validationError(context, `body failed validation: body.${itemPath}.text.link.url should be a string.`);
        }
        if (item.text.link.url.length > MAX_URL) {
          return validationError(context, `body failed validation: body.${itemPath}.text.link.url.length should be ≤ ${MAX_URL}, instead was ${item.text.link.url.length}.`);
        }
        link = { url: item.text.link.url };
      }
      admit(textItem(item.text.content, { link, annotations: annotations(context, item.annotations, itemPath) }));
      continue;
    }
    if (type === "mention") {
      const mention = item.mention;
      if (!isObject(mention)) return validationError(context, `body failed validation: body.${itemPath}.mention should be an object.`);
      const mentionType = mention.type ?? (mention.user !== undefined ? "user" : mention.page !== undefined ? "page" : mention.date !== undefined ? "date" : undefined);
      const base = { type: "mention", annotations: annotations(context, item.annotations, itemPath), href: null };
      if (mentionType === "user") {
        const id = isObject(mention.user) ? normalizeId(mention.user.id) : undefined;
        const user = id === undefined ? null : context.state.get("users", id);
        if (user === null) return validationError(context, `body failed validation: body.${itemPath}.mention.user.id should be the id of a user in the workspace.`);
        admit({ ...base, mention: { type: "user", user: { object: "user", id: user.id } }, plain_text: `@${user.name}` });
        continue;
      }
      if (mentionType === "page") {
        const id = isObject(mention.page) ? normalizeId(mention.page.id) : undefined;
        const page = id === undefined ? null : context.state.get("pages", id);
        if (page === null) return validationError(context, `body failed validation: body.${itemPath}.mention.page.id should be the id of a page in the workspace.`);
        admit({ ...base, mention: { type: "page", page: { id: page.id } }, plain_text: page.title_plain, href: `https://www.notion.so/${page.id.replaceAll("-", "")}` });
        continue;
      }
      if (mentionType === "date") {
        const date = mention.date;
        if (!isObject(date) || !isDateString(date.start) || (date.end !== undefined && date.end !== null && !isDateString(date.end))) {
          return validationError(context, `body failed validation: body.${itemPath}.mention.date.start should be a valid ISO 8601 date string.`);
        }
        const end = date.end ?? null;
        const timeZone = typeof date.time_zone === "string" ? date.time_zone : null;
        admit({ ...base, mention: { type: "date", date: { start: date.start, end, time_zone: timeZone } }, plain_text: end === null ? date.start : `${date.start} → ${end}` });
        continue;
      }
      return validationError(context, `body failed validation: body.${itemPath}.mention.type should be "user", "page" or "date", instead was \`${shown(mentionType)}\`.`);
    }
    return validationError(context, `body failed validation: body.${itemPath}.type should be "text" or "mention", instead was \`${shown(type)}\`.`);
  }
  return items;
}

export function plainText(items) {
  return items.map((item) => item.plain_text).join("");
}
