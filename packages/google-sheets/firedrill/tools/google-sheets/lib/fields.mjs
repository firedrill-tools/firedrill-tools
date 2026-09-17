// Google `fields` masks: `a,b(c,d),e`, `*`, slash paths `a/b/c`, and nested sub-selections at any depth
// (`files(id,capabilities(canEdit),owners(emailAddress)),nextPageToken`). A sub-selection is honoured on a field whose
// shape the vocabulary describes; on any other field (a scalar or a free-form map) it is rejected, exactly like an
// unknown name, so the handler can answer 400 `invalidParameter`. Pure functions.

export class FieldsError extends Error {
  constructor(message) {
    super(message);
    this.name = "FieldsError";
  }
}

const NAME_CHARACTER = /[A-Za-z0-9_*/.]/;

/**
 * Parses a mask into `{ all: true }` or `{ all: false, fields: Map<name, null | Map> }` (null selects the whole field).
 * `node` is `{ known: string[] | RegExp, sub: { [objectField]: vocabularyKey } }`; `resolve(key)` returns another node.
 */
export function parseFields(text, node, resolve) {
  if (text === undefined || text === null) return { all: true };
  const mask = String(text).trim();
  if (mask.length === 0 || mask.length > 2048) throw new FieldsError("Invalid field selection");
  const fields = parseList(mask, node, resolve, mask);
  return fields === null ? { all: true } : { all: false, fields };
}

function invalid(mask) {
  return new FieldsError(`Invalid field selection ${JSON.stringify(mask)}`);
}

function isKnown(node, name) {
  return node.known instanceof RegExp ? node.known.test(name) : node.known.includes(name);
}

function childNode(node, name, resolve) {
  const key = node.anySub === true ? "any" : node.sub?.[name];
  const child = key === undefined ? undefined : resolve(key);
  if (child === undefined) throw new FieldsError(`Invalid field selection ${name}: this field has no sub-fields`);
  return child;
}

/** One comma list; `null` means `*` (everything at this level). */
function parseList(text, node, resolve, mask) {
  if (text.trim() === "*") return null;
  const fields = new Map();
  let index = 0;
  const skipSpaces = () => {
    while (index < text.length && /\s/.test(text[index])) index += 1;
  };
  while (index < text.length) {
    skipSpaces();
    const start = index;
    while (index < text.length && NAME_CHARACTER.test(text[index])) index += 1;
    if (start === index) throw invalid(mask);
    const path = text.slice(start, index).split("/");
    if (path.some((segment) => segment.length === 0)) throw invalid(mask);
    skipSpaces();
    let inner;
    if (text[index] === "(") {
      index += 1;
      let depth = 1;
      const innerStart = index;
      while (index < text.length && depth > 0) {
        if (text[index] === "(") depth += 1;
        else if (text[index] === ")") depth -= 1;
        index += 1;
      }
      if (depth !== 0) throw invalid(mask);
      inner = text.slice(innerStart, index - 1);
      if (inner.trim().length === 0) throw invalid(mask);
      skipSpaces();
    }
    const [name, sub] = selectPath(path, inner, node, resolve, mask);
    merge(fields, name, sub);
    if (index < text.length) {
      if (text[index] !== ",") throw invalid(mask);
      index += 1;
      skipSpaces();
      if (index === text.length) throw invalid(mask);
    }
  }
  if (fields.size === 0) throw invalid(mask);
  return fields;
}

function selectPath(path, inner, node, resolve, mask) {
  const [name, ...rest] = path;
  if (!isKnown(node, name)) throw new FieldsError(`Invalid field selection ${name}`);
  const wholeChild = rest.length === 1 && rest[0] === "*" && inner === undefined;
  if (rest.length === 0 || wholeChild) {
    if (inner === undefined) {
      if (wholeChild) childNode(node, name, resolve);
      return [name, null];
    }
    return [name, parseList(inner, childNode(node, name, resolve), resolve, mask)];
  }
  const [childName, childTree] = selectPath(rest, inner, childNode(node, name, resolve), resolve, mask);
  return [name, new Map([[childName, childTree]])];
}

function merge(fields, name, sub) {
  if (!fields.has(name)) {
    fields.set(name, sub);
    return;
  }
  const existing = fields.get(name);
  if (existing === null || sub === null) {
    fields.set(name, null);
    return;
  }
  for (const [childName, childSub] of sub) merge(existing, childName, childSub);
}

function select(object, tree) {
  const out = {};
  // Walk the resource's own properties (never an inherited member such as `constructor`) so the selected fields keep
  // the resource's order, as Google's responses do, whatever order the mask named them in.
  for (const name of Object.keys(object)) {
    if (!tree.has(name)) continue;
    const field = object[name];
    if (field === undefined) continue;
    const sub = tree.get(name);
    out[name] = sub === null ? field : project(field, sub);
  }
  return out;
}

/** Projects one value through a parsed sub-selection (`null` keeps it whole). */
export function project(field, tree) {
  if (tree === null) return field;
  if (Array.isArray(field)) return field.map((item) => project(item, tree));
  if (field !== null && typeof field === "object") return select(field, tree);
  return field;
}

/** Applies a parsed mask to a resource; the top-level `kind` is always kept, as Google does. */
export function applyFields(value, parsed) {
  if (parsed.all) return value;
  const out = {};
  if (value.kind !== undefined) out.kind = value.kind;
  return Object.assign(out, select(value, parsed.fields));
}
