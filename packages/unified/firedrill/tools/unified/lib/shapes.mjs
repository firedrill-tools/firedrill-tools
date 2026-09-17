// Composite value validators (emails, telephones, address, metadata, members, references, `raw`). Each returns the
// normalised value or fails BAD_REQUEST naming the field; caller keys are copied one by one, never spread.
import { badRequest, invalidField } from "./errors.mjs";
import { clip, isHex24, isPlainObject, jsonBytes } from "./util.mjs";

const BANNED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const EMAIL_TYPES = ["WORK", "HOME", "OTHER"];
const TELEPHONE_TYPES = ["WORK", "HOME", "OTHER", "FAX", "MOBILE"];
export const METADATA_FORMATS = ["TEXT", "NUMBER", "DATE", "BOOLEAN", "TEXTAREA", "SINGLE_SELECT", "MULTIPLE_SELECT", "URL", "EMAIL", "PHONE", "CURRENCY", "PERCENT", "USER", "OBJECT", "MEASUREMENT"];
const ADDRESS_FIELDS = ["address1", "address2", "city", "region", "region_code", "postal_code", "country", "country_code"];
const MEMBER_FIELDS = ["user_id", "email", "name", "image_url"];
const RAW_MAX_DEPTH = 8;
const RAW_MAX_KEYS = 64;
const RAW_MAX_BYTES = 16384;

const nullableString = (context, field, value, max) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > max) invalidField(context, field, `must be a string of at most ${max} characters`);
  return value;
};

function objectWith(context, field, value, names, max) {
  if (!isPlainObject(value)) invalidField(context, field, "must be an object");
  const out = {};
  for (const key of Object.keys(value)) {
    if (!names.includes(key)) badRequest(context, `Unknown field "${clip(`${field}.${key}`, 80)}"`);
  }
  for (const name of names) out[name] = nullableString(context, `${field}.${name}`, value[name], max);
  return out;
}

function arrayOf(context, field, value, maxItems, each) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) invalidField(context, field, "must be an array");
  if (value.length > maxItems) invalidField(context, field, `must have at most ${maxItems} entries`);
  return value.map((entry, index) => each(`${field}[${index}]`, entry));
}

const emails = (context, field, value) =>
  arrayOf(context, field, value, 32, (where, entry) => {
    const out = objectWith(context, where, entry, ["email", "type"], 320);
    if (typeof out.email !== "string" || !out.email.includes("@") || out.email.length < 3) invalidField(context, `${where}.email`, "must be an e-mail address");
    if (out.type !== null && !EMAIL_TYPES.includes(out.type)) invalidField(context, `${where}.type`, `must be one of ${EMAIL_TYPES.join(", ")}`);
    return out;
  });

const telephones = (context, field, value) =>
  arrayOf(context, field, value, 32, (where, entry) => {
    const out = objectWith(context, where, entry, ["telephone", "type"], 64);
    if (typeof out.telephone !== "string" || out.telephone.length === 0) invalidField(context, `${where}.telephone`, "is required");
    if (out.type !== null && !TELEPHONE_TYPES.includes(out.type)) invalidField(context, `${where}.type`, `must be one of ${TELEPHONE_TYPES.join(", ")}`);
    return out;
  });

const address = (context, field, value) => (value === undefined || value === null ? null : objectWith(context, field, value, ADDRESS_FIELDS, 256));

const member = (context, field, value) => {
  const out = objectWith(context, field, value, MEMBER_FIELDS, 320);
  if (out.email !== null && !out.email.includes("@")) invalidField(context, `${field}.email`, "must be an e-mail address");
  return out;
};

const members = (context, field, value) => arrayOf(context, field, value, 100, (where, entry) => member(context, where, entry));

const metadata = (context, field, value) =>
  arrayOf(context, field, value, 100, (where, entry) => {
    if (!isPlainObject(entry)) invalidField(context, where, "must be an object");
    for (const key of Object.keys(entry)) {
      if (!["id", "slug", "namespace", "format", "value", "extra_data"].includes(key)) badRequest(context, `Unknown field "${clip(`${where}.${key}`, 80)}"`);
    }
    const out = {
      id: nullableString(context, `${where}.id`, entry.id, 256),
      slug: nullableString(context, `${where}.slug`, entry.slug, 256),
      namespace: nullableString(context, `${where}.namespace`, entry.namespace, 256),
      format: nullableString(context, `${where}.format`, entry.format, 32),
      value: entry.value === undefined ? null : entry.value,
      extra_data: entry.extra_data === undefined ? null : entry.extra_data,
    };
    if (out.id === null && out.slug === null) invalidField(context, where, "needs an id or a slug");
    if (out.format !== null && !METADATA_FORMATS.includes(out.format)) invalidField(context, `${where}.format`, `must be one of ${METADATA_FORMATS.join(", ")}`);
    const kind = typeof out.value;
    if (out.value !== null && kind !== "string" && kind !== "number" && kind !== "boolean") invalidField(context, `${where}.value`, "must be a string, number, boolean or null");
    if (kind === "string" && out.value.length > 4000) invalidField(context, `${where}.value`, "must be at most 4000 characters");
    if (kind === "number" && !Number.isFinite(out.value)) invalidField(context, `${where}.value`, "must be finite");
    out.extra_data = out.extra_data === null ? null : raw(context, `${where}.extra_data`, out.extra_data);
    return out;
  });

/** Copies a caller object key by key into fresh objects, bounding depth, keys per level and encoded size. */
function raw(context, field, value) {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) invalidField(context, field, "must be an object");
  const root = {};
  const stack = [[value, root, 1]];
  while (stack.length > 0) {
    const [source, target, depth] = stack.pop();
    if (depth > RAW_MAX_DEPTH) invalidField(context, field, `must not nest deeper than ${RAW_MAX_DEPTH} levels`);
    const keys = Object.keys(source);
    if (keys.length > RAW_MAX_KEYS) invalidField(context, field, `must have at most ${RAW_MAX_KEYS} keys per level`);
    for (const key of keys) {
      if (BANNED_KEYS.has(key) || key.length > 256) badRequest(context, `Invalid key in ${clip(field, 80)}: "${clip(key, 60)}"`);
      const child = source[key];
      if (isPlainObject(child)) {
        const copy = {};
        target[key] = copy;
        stack.push([child, copy, depth + 1]);
      } else if (Array.isArray(child)) {
        if (child.length > RAW_MAX_KEYS) invalidField(context, field, `arrays must have at most ${RAW_MAX_KEYS} entries`);
        const copy = [];
        target[key] = copy;
        for (const entry of child) {
          if (isPlainObject(entry)) {
            const inner = {};
            copy.push(inner);
            stack.push([entry, inner, depth + 1]);
          } else if (Array.isArray(entry)) invalidField(context, field, "nested arrays are not supported");
          else copy.push(entry === undefined ? null : entry);
        }
      } else if (typeof child === "number" && !Number.isFinite(child)) invalidField(context, field, "numbers must be finite");
      else target[key] = child === undefined ? null : child;
    }
  }
  if (jsonBytes(root) > RAW_MAX_BYTES) invalidField(context, field, `must encode to at most ${RAW_MAX_BYTES} bytes`);
  return root;
}

const reactions = (context, field, value) =>
  arrayOf(context, field, value, 200, (where, entry) => {
    if (!isPlainObject(entry)) invalidField(context, where, "must be an object");
    for (const key of Object.keys(entry)) if (key !== "reaction" && key !== "member") badRequest(context, `Unknown field "${clip(`${where}.${key}`, 80)}"`);
    const reaction = nullableString(context, `${where}.reaction`, entry.reaction, 64);
    if (reaction === null) invalidField(context, `${where}.reaction`, "is required");
    return { reaction, member: member(context, `${where}.member`, entry.member ?? {}) };
  });

const attachments = (context, field, value) =>
  arrayOf(context, field, value, 32, (where, entry) => {
    if (!isPlainObject(entry)) invalidField(context, where, "must be an object");
    const size = entry.size;
    const rest = {};
    for (const key of Object.keys(entry)) if (key !== "size") rest[key] = entry[key];
    const out = objectWith(context, where, rest, ["filename", "content_type", "download_url", "content_identifier", "message_id"], 2048);
    if (size !== undefined && size !== null && (typeof size !== "number" || !Number.isFinite(size) || size < 0)) invalidField(context, `${where}.size`, "must be a non-negative number");
    out.size = size === undefined ? null : size;
    return out;
  });

const buttons = (context, field, value) =>
  arrayOf(context, field, value, 16, (where, entry) => {
    const out = objectWith(context, where, entry, ["id", "text", "icon"], 256);
    if (out.id === null) invalidField(context, `${where}.id`, "is required");
    return out;
  });

/** `channels`, `pipelines`, `stages`: arrays of `{ id, name?, type? }` references whose ids must be well-formed. */
const refs = (max, names) => (context, field, value) =>
  arrayOf(context, field, value, max, (where, entry) => {
    const out = objectWith(context, where, entry, names, 256);
    if (!isHex24(out.id)) invalidField(context, `${where}.id`, "must be a valid id");
    return out;
  });

export const SHAPES = new Map([
  ["emails", emails],
  ["telephones", telephones],
  ["address", address],
  ["member", (context, field, value) => (value === undefined || value === null ? null : member(context, field, value))],
  ["members", members],
  ["metadata", metadata],
  ["raw", raw],
  ["reactions", reactions],
  ["attachments", attachments],
  ["buttons", buttons],
  ["channelRefs", refs(8, ["id", "name"])],
  ["pipelineRefs", refs(1, ["id", "name", "type"])],
]);
