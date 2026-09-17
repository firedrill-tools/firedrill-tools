// Field placement validation: type, page within the document, a box inside the page (percent units) and fieldMeta.
import { bad, invalid } from "./errors.mjs";
import { isObject, toInt, toNumber } from "./util.mjs";
import { FIELD_TYPES } from "./validate.mjs";

const META_KEYS = new Map([
  ["label", "text100"], ["placeholder", "text100"], ["required", "bool"], ["readOnly", "bool"], ["fontSize", "fontSize"], ["text", "text1000"],
  ["characterLimit", "limit"], ["type", "type"],
]);

function fieldMeta(context, input, type) {
  if (input === undefined || input === null) return null;
  if (!isObject(input)) bad(context, "fieldMeta must be an object");
  const out = {};
  for (const key of Object.keys(input)) {
    if (!META_KEYS.has(key)) bad(context, `fieldMeta.${key.slice(0, 40)} is not supported by this simulation`);
    const value = input[key];
    const kind = META_KEYS.get(key);
    if (kind === "bool") {
      if (typeof value !== "boolean") bad(context, `fieldMeta.${key} must be a boolean`);
      out[key] = value;
    } else if (kind === "text100" || kind === "text1000") {
      const max = kind === "text100" ? 100 : 1000;
      if (typeof value !== "string" || value.length > max) bad(context, `fieldMeta.${key} must be at most ${max} characters`);
      out[key] = value;
    } else if (kind === "fontSize" || kind === "limit") {
      const n = kind === "fontSize" ? toInt(value, 8, 96) : toInt(value, 0, 1000);
      if (n === null) bad(context, `fieldMeta.${key} is out of range`);
      out[key] = n;
    } else {
      if (typeof value !== "string") bad(context, "fieldMeta.type must be a string");
      if (value !== type.toLowerCase()) invalid(context, `fieldMeta type "${value.slice(0, 20)}" does not match field type ${type}`);
      out.type = value;
    }
  }
  return out;
}

/** Returns { type, page, positionX, positionY, width, height, fieldMeta } for a recipient row on a parent with `pageCount` pages. */
export function placement(context, input, pageCount, recipient) {
  if (!isObject(input)) bad(context, "field must be an object");
  if (typeof input.type !== "string" || !FIELD_TYPES.has(input.type)) bad(context, "field type must be one of SIGNATURE, INITIALS, NAME, EMAIL, DATE, TEXT, CHECKBOX");
  const page = toInt(input.pageNumber, 1, 1000);
  if (page === null) bad(context, "pageNumber must be a positive integer");
  const box = {};
  for (const [key, min] of [["pageX", 0], ["pageY", 0], ["width", 1], ["height", 1]]) {
    const n = toNumber(input[key]);
    if (n === null || n < min || n > 100) bad(context, `${key} must be a number between ${min} and 100`);
    box[key] = n;
  }
  if (page > pageCount) invalid(context, `Page ${page} does not exist: the document has ${pageCount} page(s)`);
  if (box.pageX + box.width > 100 || box.pageY + box.height > 100) invalid(context, "Field is outside the page bounds");
  if (recipient.role === "CC" || recipient.role === "VIEWER") invalid(context, `${recipient.role} recipients cannot have fields`);
  return {
    type: input.type, page, positionX: box.pageX, positionY: box.pageY, width: box.width, height: box.height,
    fieldMeta: fieldMeta(context, input.fieldMeta, input.type),
  };
}
