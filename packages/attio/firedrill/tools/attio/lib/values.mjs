// Attribute definitions, per-type write coercion, stored-value merge (append / overwrite) and read expansion.
import { findMember } from "./access.mjs";
import { clip, compare, fail, isPlainObject, isReserved, isSlug, isUuid, rows, validation, valueNotFound } from "./common.mjs";

export const SYSTEM_SLUGS = new Set(["record_id", "created_at", "created_by"]);
export const OBJECT_SLUGS = Object.freeze(["people", "companies", "deals"]);
const MAX_TEXT = 10_000;
const MAX_VALUES_PER_ATTRIBUTE = 100;
const MAX_ATTRIBUTES_PER_WRITE = 100;
const CALLING_CODES = new Map([
  ["US", "1"], ["CA", "1"], ["GB", "44"], ["IE", "353"], ["FR", "33"], ["DE", "49"], ["ES", "34"], ["IT", "39"], ["NL", "31"],
  ["SE", "46"], ["NO", "47"], ["DK", "45"], ["FI", "358"], ["PT", "351"], ["CH", "41"], ["AT", "43"], ["BE", "32"], ["PL", "48"],
  ["JP", "81"], ["IN", "91"], ["AU", "61"], ["NZ", "64"], ["SG", "65"], ["BR", "55"], ["MX", "52"], ["ZA", "27"], ["NG", "234"],
  ["GH", "233"], ["KE", "254"], ["AE", "971"], ["IL", "972"], ["CN", "86"], ["KR", "82"],
]);

// ------------------------------------------------------------------------------------------------------------
// Definitions

/** Attribute definitions of an object or list, in `position` order, indexed by slug and id. */
export function loadDefs(context, target, parentSlug) {
  const list = rows(context, "attributes", { prefix: `${target}/${parentSlug}/` }).sort((a, b) => a.position - b.position || compare(a.api_slug, b.api_slug));
  const bySlug = new Map();
  const byId = new Map();
  for (const def of list) {
    bySlug.set(def.api_slug, def);
    byId.set(def.attribute_id, def);
  }
  return { list, bySlug, byId };
}

export function resolveDef(defs, key) {
  if (typeof key !== "string") return undefined;
  return defs.bySlug.get(key) ?? defs.byId.get(key);
}

export function unknownAttribute(context, key) {
  return validation(context, `Cannot find attribute with slug/ID "${clip(key)}".`);
}

// ------------------------------------------------------------------------------------------------------------
// Date and time parsing (pure arithmetic; zone-less datetimes are UTC; impossible calendar values are rejected)

const ISO = /^([0-9]{4})-([0-9]{2})-([0-9]{2})(?:[T ]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]{1,9}))?)?(Z|z|[+-][0-9]{2}:?[0-9]{2})?)?$/;

function daysInMonth(year, month) {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** `{ date: "YYYY-MM-DD" (UTC), timestamp: nanosecond ISO string, hasTime }` or undefined. */
export function parseInstant(value) {
  if (typeof value !== "string" || value.length > 40) return undefined;
  const match = ISO.exec(value.trim());
  if (match === null) return undefined;
  const [, y, mo, d, h, mi, s = "00", fraction = "", zone] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return undefined;
  if (h === undefined) {
    return { date: `${y}-${mo}-${d}`, timestamp: `${y}-${mo}-${d}T00:00:00.000000000Z`, hasTime: false };
  }
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  let offset = 0;
  if (zone !== undefined && zone !== "Z" && zone !== "z") {
    const digits = zone.slice(1).replace(":", "");
    const oh = Number(digits.slice(0, 2));
    const om = Number(digits.slice(2, 4));
    if (oh > 18 || om > 59) return undefined;
    offset = (zone[0] === "-" ? -1 : 1) * (oh * 60 + om);
  }
  const ms = Date.UTC(year, month - 1, day, hour, minute, second) - offset * 60_000;
  const iso = new Date(ms).toISOString();
  if (!/^[0-9]{4}-/.test(iso)) return undefined;
  return { date: iso.slice(0, 10), timestamp: `${iso.slice(0, 19)}.${fraction.padEnd(9, "0")}Z`, hasTime: true };
}

// ------------------------------------------------------------------------------------------------------------
// Coercion

function base(env) {
  return { active_from: env.now, active_until: null, created_by_actor: env.actor };
}

function unwrap(input, field) {
  return isPlainObject(input) && Object.hasOwn(input, field) ? input[field] : input;
}

function bad(context, def, detail) {
  return validation(context, `Invalid value passed to attribute with slug "${def.api_slug}". ${detail}`);
}

function textFrom(context, def, input, field = "value", max = MAX_TEXT) {
  const value = unwrap(input, field);
  if (typeof value !== "string") return bad(context, def, `Expected a string.`);
  if (value.length > max) return bad(context, def, `Expected at most ${max} characters.`);
  if (value.includes("�")) return bad(context, def, "The value contains an invalid character (U+FFFD).");
  return value;
}

function rootDomain(host) {
  const labels = host.split(".");
  return labels.slice(-2).join(".");
}

export function normalizeDomain(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2_048) return undefined;
  let host = raw.trim().toLowerCase();
  const scheme = host.indexOf("://");
  if (scheme >= 0 && scheme < 16) host = host.slice(scheme + 3);
  for (const stop of ["/", "?", "#"]) {
    const index = host.indexOf(stop);
    if (index >= 0) host = host.slice(0, index);
  }
  const at = host.lastIndexOf("@");
  if (at >= 0) host = host.slice(at + 1);
  const colon = host.indexOf(":");
  if (colon >= 0) host = host.slice(0, colon);
  if (host.startsWith("www.")) host = host.slice(4);
  if (host.length === 0 || host.length > 253 || !host.includes(".")) return undefined;
  for (const label of host.split(".")) if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return undefined;
  return host;
}

export function normalizeEmail(raw) {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 320) return undefined;
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at > 64 || trimmed.indexOf("@") !== at) return undefined;
  const local = trimmed.slice(0, at);
  if (/[\s"(),:;<>[\]\\]/.test(local)) return undefined;
  const domain = normalizeDomain(trimmed.slice(at + 1));
  if (domain === undefined || trimmed.slice(at + 1).toLowerCase() !== domain) return undefined;
  return { original: trimmed, address: `${local.toLowerCase()}@${domain}`, local: local.toLowerCase(), domain };
}

function coerceOne(context, env, def, input) {
  const entry = base(env);
  switch (def.type) {
    case "text":
      return { ...entry, value: textFrom(context, def, input) };
    case "number": {
      let value = unwrap(input, "value");
      if (typeof value === "string" && /^-?[0-9]{1,15}(?:\.[0-9]{1,10})?$/.test(value)) value = Number(value);
      if (typeof value !== "number" || !Number.isFinite(value)) return bad(context, def, "Expected a number.");
      return { ...entry, value };
    }
    case "checkbox": {
      let value = unwrap(input, "value");
      if (value === "true") value = true;
      if (value === "false") value = false;
      if (typeof value !== "boolean") return bad(context, def, "Expected a boolean.");
      return { ...entry, value };
    }
    case "currency": {
      const code = def.config.currency.default_currency_code ?? "USD";
      let amount = input;
      let currency = code;
      if (isPlainObject(input)) {
        amount = input.currency_value;
        if (input.currency_code !== undefined && input.currency_code !== null) currency = input.currency_code;
      }
      if (typeof amount === "string" && /^-?[0-9]{1,15}(?:\.[0-9]{1,4})?$/.test(amount)) amount = Number(amount);
      if (typeof amount !== "number" || !Number.isFinite(amount)) return bad(context, def, "Expected a currency amount.");
      if (currency !== code) return bad(context, def, `Currency code must be "${code}".`);
      return { ...entry, currency_value: amount, currency_code: code };
    }
    case "date": {
      const parsed = parseInstant(unwrap(input, "value"));
      if (parsed === undefined) return bad(context, def, "Expected a date in YYYY-MM-DD format.");
      return { ...entry, value: parsed.date };
    }
    case "timestamp": {
      const parsed = parseInstant(unwrap(input, "value"));
      if (parsed === undefined) return bad(context, def, "Expected an ISO 8601 timestamp.");
      return { ...entry, value: parsed.timestamp };
    }
    case "select": {
      const key = unwrap(input, "option");
      if (typeof key !== "string" || key.length > 500) return bad(context, def, "Expected a select option title or ID.");
      const option = def.options.find((candidate) => candidate.option_id === key || candidate.title === key);
      if (option === undefined || option.is_archived) {
        return valueNotFound(context, `Cannot find select option with title/ID "${clip(key)}" for attribute "${def.api_slug}".`);
      }
      return { ...entry, option_id: option.option_id };
    }
    case "status": {
      const key = unwrap(input, "status");
      if (typeof key !== "string" || key.length > 500) return bad(context, def, "Expected a status title or ID.");
      const status = def.statuses.find((candidate) => candidate.status_id === key || candidate.title === key);
      if (status === undefined || status.is_archived) {
        return valueNotFound(context, `Cannot find status with title/ID "${clip(key)}" for attribute "${def.api_slug}".`);
      }
      return { ...entry, status_id: status.status_id };
    }
    case "record-reference": {
      let objectKey;
      let recordId = input;
      if (isPlainObject(input)) {
        objectKey = input.target_object;
        recordId = input.target_record_id;
      }
      if (typeof recordId !== "string") return bad(context, def, "Expected a record reference with target_object and target_record_id.");
      const allowed = def.config.record_reference.allowed_object_ids;
      const candidates = OBJECT_SLUGS.filter((slug) => {
        const object = context.state.get("objects", slug);
        if (object === null || (allowed !== null && !allowed.includes(object.object_id))) return false;
        return objectKey === undefined || objectKey === slug || objectKey === object.object_id;
      });
      if (objectKey !== undefined && (typeof objectKey !== "string" || candidates.length === 0)) {
        return bad(context, def, `Records of object "${clip(objectKey)}" cannot be referenced by this attribute.`);
      }
      const target = isUuid(recordId) ? candidates.find((slug) => context.state.get(slug, recordId) !== null) : undefined;
      if (target === undefined) return valueNotFound(context, `Cannot find record with ID "${clip(recordId)}" for attribute "${def.api_slug}".`);
      return { ...entry, target_object: target, target_record_id: recordId };
    }
    case "actor-reference": {
      const member = findMember(context, input);
      if (member === null) {
        if (typeof input !== "string" && !isPlainObject(input)) return bad(context, def, "Expected a workspace member reference.");
        return valueNotFound(context, `Cannot find workspace member ${clip(typeof input === "string" ? input : JSON.stringify(input))} for attribute "${def.api_slug}".`);
      }
      if (member.access_level === "suspended") return bad(context, def, "Suspended workspace members cannot be referenced.");
      return { ...entry, referenced_actor_type: "workspace-member", referenced_actor_id: member.workspace_member_id };
    }
    case "domain": {
      const host = normalizeDomain(unwrap(input, "domain"));
      if (host === undefined) return bad(context, def, "Expected a valid domain.");
      return { ...entry, domain: host, root_domain: rootDomain(host) };
    }
    case "email-address": {
      const email = normalizeEmail(unwrap(input, "email_address"));
      if (email === undefined) return bad(context, def, "Expected a valid email address.");
      return {
        ...entry,
        original_email_address: email.original,
        email_address: email.address,
        email_domain: email.domain,
        email_root_domain: rootDomain(email.domain),
        email_local_specifier: email.local,
      };
    }
    case "phone-number": {
      let original = input;
      let country = null;
      if (isPlainObject(input)) {
        original = input.original_phone_number;
        if (input.country_code !== undefined && input.country_code !== null) country = input.country_code;
      }
      if (typeof original !== "string" || original.length > 64) return bad(context, def, "Expected a phone number string.");
      if (country !== null && (typeof country !== "string" || !CALLING_CODES.has(country))) return bad(context, def, "Unsupported country_code.");
      let digits = "";
      for (const character of original) if (character >= "0" && character <= "9") digits += character;
      const international = original.trim().startsWith("+");
      if (!international && country === null) return bad(context, def, "Phone numbers without a leading + require a country_code.");
      const full = international ? digits : `${CALLING_CODES.get(country)}${digits.replace(/^0+/, "")}`;
      if (full.length < 6 || full.length > 15) return bad(context, def, "Expected between 6 and 15 digits.");
      return { ...entry, original_phone_number: original, country_code: country, phone_number: `+${full}` };
    }
    case "personal-name": {
      let first;
      let last;
      if (typeof input === "string") {
        const trimmed = input.trim();
        const space = trimmed.lastIndexOf(" ");
        first = space < 0 ? trimmed : trimmed.slice(0, space).trim();
        last = space < 0 ? "" : trimmed.slice(space + 1);
      } else if (isPlainObject(input)) {
        first = input.first_name ?? "";
        last = input.last_name ?? "";
        if (typeof input.full_name === "string" && input.first_name === undefined && input.last_name === undefined) {
          const trimmed = input.full_name.trim();
          const space = trimmed.lastIndexOf(" ");
          first = space < 0 ? trimmed : trimmed.slice(0, space).trim();
          last = space < 0 ? "" : trimmed.slice(space + 1);
        }
      }
      if (typeof first !== "string" || typeof last !== "string" || first.length > 500 || last.length > 500) {
        return bad(context, def, "Expected a name string or an object with first_name and last_name.");
      }
      const full = [first, last].filter((part) => part.length > 0).join(" ");
      if (full.length === 0) return bad(context, def, "A name cannot be empty.");
      return { ...entry, first_name: first, last_name: last, full_name: full };
    }
    default:
      return bad(context, def, "This attribute type is not writable through this Tool.");
  }
}

/** Identity of a stored value, used for duplicate detection and change detection. */
export function entryKey(entry) {
  if (entry.email_address !== undefined) return `e:${entry.email_address}`;
  if (entry.domain !== undefined) return `d:${entry.domain}`;
  if (entry.option_id !== undefined) return `o:${entry.option_id}`;
  if (entry.status_id !== undefined) return `s:${entry.status_id}`;
  if (entry.target_record_id !== undefined) return `r:${entry.target_object}/${entry.target_record_id}`;
  if (entry.referenced_actor_id !== undefined) return `a:${entry.referenced_actor_id}`;
  if (entry.phone_number !== undefined) return `p:${entry.phone_number}`;
  if (entry.full_name !== undefined) return `n:${JSON.stringify([entry.first_name, entry.last_name])}`;
  if (entry.currency_value !== undefined) return `c:${entry.currency_code}:${entry.currency_value}`;
  return `v:${JSON.stringify(entry.value)}`;
}

/**
 * Validate a `values` / `entry_values` payload. Returns a Map slug → coerced entries ([] clears). Unknown or
 * read-only attributes and wrong cardinality fail VALIDATION_TYPE; unknown options, statuses, references and
 * members fail VALUE_NOT_FOUND.
 */
export function coerceWrite(context, env, defs, raw) {
  if (!isPlainObject(raw)) return validation(context, "Expected an object of attribute values.");
  const keys = Object.keys(raw);
  if (keys.length > MAX_ATTRIBUTES_PER_WRITE) return validation(context, `At most ${MAX_ATTRIBUTES_PER_WRITE} attributes can be written at once.`);
  const out = new Map();
  for (const key of keys) {
    if (isReserved(key)) return unknownAttribute(context, key);
    const def = resolveDef(defs, key);
    if (def === undefined || def.is_archived) return unknownAttribute(context, key);
    if (!def.is_writable || SYSTEM_SLUGS.has(def.api_slug)) {
      return validation(context, `Cannot write to attribute with slug "${def.api_slug}" because it is not writable.`);
    }
    const input = raw[key];
    let items;
    if (input === null || input === undefined) items = [];
    else if (Array.isArray(input)) items = input;
    else items = [input];
    if (items.length > MAX_VALUES_PER_ATTRIBUTE) return bad(context, def, `At most ${MAX_VALUES_PER_ATTRIBUTE} values are accepted.`);
    if (!def.is_multiselect && items.length > 1) {
      return bad(context, def, "This attribute accepts a single value, but multiple values were provided.");
    }
    const entries = [];
    const seen = new Set();
    for (const item of items) {
      if (item === null) return bad(context, def, "Values in a list cannot be null.");
      const entry = coerceOne(context, env, def, item);
      const identity = entryKey(entry);
      if (seen.has(identity)) continue;
      seen.add(identity);
      entries.push(entry);
    }
    if (out.has(def.api_slug)) return bad(context, def, "The attribute was provided more than once (by slug and by ID).");
    out.set(def.api_slug, entries);
  }
  return out;
}

/**
 * Merge coerced updates into stored values. `modeFor(slug)` returns "append" or "overwrite"; single-value
 * attributes always replace. Returns `{ values, changed: slug[] }`; unchanged values keep their `active_from`.
 */
export function mergeValues(defs, stored, updates, modeFor) {
  const values = Object.create(null);
  for (const [slug, entries] of Object.entries(stored)) values[slug] = entries;
  const changed = [];
  for (const [slug, incoming] of updates) {
    const def = defs.bySlug.get(slug);
    const existing = Object.hasOwn(values, slug) ? values[slug] : [];
    const existingKeys = existing.map(entryKey);
    let next;
    if (def.is_multiselect && modeFor(slug) === "append") {
      next = [...existing];
      for (const entry of incoming) if (!existingKeys.includes(entryKey(entry))) next.push(entry);
    } else {
      next = incoming.map((entry) => {
        const index = existingKeys.indexOf(entryKey(entry));
        return index >= 0 ? existing[index] : entry;
      });
    }
    const nextKeys = next.map(entryKey);
    if (nextKeys.length !== existingKeys.length || nextKeys.some((key, index) => key !== existingKeys[index])) changed.push(slug);
    if (next.length === 0) delete values[slug];
    else values[slug] = next;
  }
  return { values: { ...values }, changed };
}

// ------------------------------------------------------------------------------------------------------------
// Read expansion

export function expandEntry(env, def, entry) {
  const out = { ...entry, attribute_type: def.type };
  if (def.type === "select") {
    delete out.option_id;
    const option = def.options.find((candidate) => candidate.option_id === entry.option_id);
    out.option = {
      id: { workspace_id: env.workspaceId, [env.parentField]: env.parentId, attribute_id: def.attribute_id, option_id: entry.option_id },
      title: option?.title ?? "",
      is_archived: option?.is_archived ?? true,
    };
  } else if (def.type === "status") {
    delete out.status_id;
    const status = def.statuses.find((candidate) => candidate.status_id === entry.status_id);
    out.status = {
      id: { workspace_id: env.workspaceId, [env.parentField]: env.parentId, attribute_id: def.attribute_id, status_id: entry.status_id },
      title: status?.title ?? "",
      is_archived: status?.is_archived ?? true,
      celebration_enabled: status?.celebration_enabled ?? false,
      target_time_in_status: null,
    };
  }
  return out;
}

/** Every non-archived attribute in position order, `[]` when unset, system attributes synthesised. */
export function expandValues(env, defs, row, stored) {
  const out = {};
  const system = { active_from: row.created_at, active_until: null, created_by_actor: { type: "system", id: null } };
  for (const def of defs.list) {
    if (def.is_archived) continue;
    if (env.recordId !== undefined && def.api_slug === "record_id") out.record_id = [{ ...system, value: env.recordId, attribute_type: def.type }];
    else if (env.recordId !== undefined && def.api_slug === "created_at") out.created_at = [{ ...system, value: row.created_at, attribute_type: def.type }];
    else if (env.recordId !== undefined && def.api_slug === "created_by") {
      out.created_by = [{ ...system, referenced_actor_type: row.created_by_actor.type, referenced_actor_id: row.created_by_actor.id, attribute_type: def.type }];
    } else {
      const entries = Object.hasOwn(stored, def.api_slug) ? stored[def.api_slug] : [];
      out[def.api_slug] = entries.map((entry) => expandEntry(env, def, entry));
    }
  }
  return out;
}

/** Scalar views of a stored entry used by filters, sorts and search. */
export function fieldValue(def, entry, field) {
  switch (field) {
    case "option": {
      const option = def.options.find((candidate) => candidate.option_id === entry.option_id);
      return option?.title;
    }
    case "status": {
      const status = def.statuses.find((candidate) => candidate.status_id === entry.status_id);
      return status?.title;
    }
    default:
      return Object.hasOwn(entry, field) ? entry[field] : undefined;
  }
}

export const PRIMARY_FIELD = Object.freeze({
  text: "value",
  number: "value",
  checkbox: "value",
  date: "value",
  timestamp: "value",
  currency: "currency_value",
  select: "option",
  status: "status",
  "record-reference": "target_record_id",
  "actor-reference": "referenced_actor_id",
  domain: "domain",
  "email-address": "email_address",
  "phone-number": "phone_number",
  "personal-name": "full_name",
});

export const FIELDS = Object.freeze({
  text: ["value"],
  number: ["value"],
  checkbox: ["value"],
  date: ["value"],
  timestamp: ["value"],
  currency: ["currency_value", "currency_code"],
  select: ["option"],
  status: ["status"],
  "record-reference": ["target_record_id", "target_object"],
  "actor-reference": ["referenced_actor_id", "referenced_actor_type"],
  domain: ["domain", "root_domain"],
  "email-address": ["email_address", "email_domain", "email_root_domain", "email_local_specifier", "original_email_address"],
  "phone-number": ["phone_number", "country_code", "original_phone_number"],
  "personal-name": ["full_name", "first_name", "last_name"],
});

export function assertSlugParam(context, value, label) {
  if (!isSlug(value) && !isUuid(value)) return fail(context, "NOT_FOUND", `${label} with slug/ID "${clip(String(value))}" not found.`);
  return value;
}
