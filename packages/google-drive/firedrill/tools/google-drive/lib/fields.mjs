// Drive `fields` masks, one level deep: `a,b(c,d),e`, `*`, `files(id,name),nextPageToken`. Deeper sub-masks select the
// whole parent field. Unknown names are reported so the handler can answer 400 `invalidParameter`. Pure functions.

export class FieldsError extends Error {
  constructor(message) {
    super(message);
    this.name = "FieldsError";
  }
}

/**
 * Parses a mask into `{ all: true }` or `{ all: false, fields: Map<name, null | Set<subName>> }`.
 * `known` lists the top-level names allowed; `knownSub` maps a top-level name to the names allowed under it.
 */
export function parseFields(text, known, knownSub = {}) {
  if (text === undefined || text === null) return { all: true };
  const mask = String(text).trim();
  if (mask.length === 0 || mask.length > 2048) throw new FieldsError("Invalid field selection");
  if (mask === "*") return { all: true };
  const fields = new Map();
  let index = 0;
  const readName = () => {
    const start = index;
    while (index < mask.length && /[A-Za-z0-9_*/.]/.test(mask[index])) index += 1;
    if (start === index) throw new FieldsError(`Invalid field selection ${JSON.stringify(mask)}`);
    return mask.slice(start, index);
  };
  const skipSpaces = () => {
    while (index < mask.length && /\s/.test(mask[index])) index += 1;
  };
  while (index < mask.length) {
    skipSpaces();
    const rawName = readName();
    const name = rawName.includes("/") ? rawName.slice(0, rawName.indexOf("/")) : rawName;
    if (!known.includes(name)) throw new FieldsError(`Invalid field selection ${name}`);
    let sub = null;
    skipSpaces();
    if (mask[index] === "(") {
      index += 1;
      let depth = 1;
      const start = index;
      while (index < mask.length && depth > 0) {
        if (mask[index] === "(") depth += 1;
        else if (mask[index] === ")") depth -= 1;
        index += 1;
      }
      if (depth !== 0) throw new FieldsError(`Invalid field selection ${JSON.stringify(mask)}`);
      const inner = mask.slice(start, index - 1);
      const allowed = knownSub[name];
      if (allowed !== undefined) {
        const parsed = parseFields(inner, allowed);
        sub = parsed.all ? null : new Set(parsed.fields.keys());
      }
    } else if (rawName.includes("/")) {
      const allowed = knownSub[name];
      const child = rawName.slice(rawName.indexOf("/") + 1).split("/")[0];
      if (allowed !== undefined) {
        if (!allowed.includes(child)) throw new FieldsError(`Invalid field selection ${rawName}`);
        sub = new Set([child]);
      }
    }
    const existing = fields.get(name);
    if (existing === undefined) fields.set(name, sub);
    else if (existing !== null && sub !== null) for (const value of sub) existing.add(value);
    else fields.set(name, null);
    skipSpaces();
    if (index < mask.length) {
      if (mask[index] !== ",") throw new FieldsError(`Invalid field selection ${JSON.stringify(mask)}`);
      index += 1;
    }
  }
  if (fields.size === 0) throw new FieldsError("Invalid field selection");
  return { all: false, fields };
}

function pick(object, names) {
  const out = {};
  for (const name of names) if (object[name] !== undefined) out[name] = object[name];
  return out;
}

/** Applies a parsed mask to a resource; `kind` is always kept, as Google does. */
export function applyFields(value, parsed) {
  if (parsed.all) return value;
  const out = {};
  if (value.kind !== undefined) out.kind = value.kind;
  for (const [name, sub] of parsed.fields) {
    const field = value[name];
    if (field === undefined) continue;
    if (sub === null) out[name] = field;
    else if (Array.isArray(field)) out[name] = field.map((item) => (item !== null && typeof item === "object" ? pick(item, sub) : item));
    else if (field !== null && typeof field === "object") out[name] = pick(field, sub);
    else out[name] = field;
  }
  return out;
}
