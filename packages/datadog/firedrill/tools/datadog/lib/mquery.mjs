// Parser for the documented metric query grammar subset, the metric monitor query and composite expressions.
// Hand-written scanner over length-bounded text; caller text is never compiled into a RegExp.

const SPACE_AGGR = ["avg", "sum", "min", "max"];
const ROLLUP = ["avg", "sum", "min", "max", "count"];
const FILL = ["null", "zero", "last"];
const METRIC = /^[A-Za-z][A-Za-z0-9_.]{0,199}$/;
const TAG_CHARS = /^[A-Za-z0-9_.:/\-*À-￼]+$/;
const KEY = /^[A-Za-z][A-Za-z0-9_.\-/]{0,199}$/;

class ParseError extends Error {
  constructor(position) {
    super(`Error parsing query: unsupported syntax at position ${position}`);
    this.position = position;
  }
}

function reader(source, offset = 0) {
  let i = 0;
  const r = {
    get pos() { return i; },
    peek: () => source[i],
    rest: () => source.slice(i),
    eof: () => i >= source.length,
    skip: () => { while (source[i] === " ") i += 1; },
    fail: () => { throw new ParseError(i + offset); },
    take: (literal) => { if (source.startsWith(literal, i)) { i += literal.length; return true; } return false; },
    expect: (literal) => { if (!r.take(literal)) r.fail(); },
    until: (stop) => { const start = i; while (i < source.length && !stop.includes(source[i])) i += 1; return source.slice(start, i); },
  };
  return r;
}

function scopeEntries(raw, r) {
  const trimmed = raw.trim();
  if (trimmed === "*") return [];
  const entries = [];
  for (const piece of trimmed.split(",")) {
    let tag = piece.trim();
    const negate = tag.startsWith("!");
    if (negate) tag = tag.slice(1);
    if (tag.length === 0 || tag.length > 200 || !TAG_CHARS.test(tag) || tag.startsWith("*") || tag.startsWith("$")) r.fail();
    const colon = tag.indexOf(":");
    const key = colon < 0 ? tag : tag.slice(0, colon);
    const value = colon < 0 ? null : tag.slice(colon + 1);
    if (!KEY.test(key) || key.includes("*") || (value !== null && value.indexOf("*") >= 0 && value.indexOf("*") !== value.length - 1)) r.fail();
    entries.push(value === null ? { key, value: null, prefix: false, negate }
      : value.endsWith("*") ? { key, value: value.slice(0, -1), prefix: true, negate }
        : { key, value, prefix: false, negate });
  }
  return entries;
}

/** One `aggr:metric{scope} by {keys}.fn()` expression starting at the reader position. */
function expression(r) {
  const start = r.pos;
  const aggr = SPACE_AGGR.find((name) => r.take(`${name}:`));
  if (aggr === undefined) r.fail();
  const metric = r.until("{");
  if (!METRIC.test(metric)) r.fail();
  r.expect("{");
  const scopeText = r.until("}");
  const scope = scopeEntries(scopeText, r);
  r.expect("}");
  const by = [];
  const save = r.pos;
  r.skip();
  if (r.take("by")) {
    r.skip();
    r.expect("{");
    for (const key of r.until("}").split(",")) {
      const trimmed = key.trim();
      if (!KEY.test(trimmed) || by.includes(trimmed)) r.fail();
      by.push(trimmed);
    }
    r.expect("}");
    if (by.length === 0 || by.length > 5) r.fail();
  } else if (r.pos !== save) {
    // only whitespace was consumed; leave it for the caller
  }
  const fns = { rollup: null, asCount: false, asRate: false, fill: null };
  while (r.take(".")) {
    if (r.take("rollup(")) {
      const method = ROLLUP.find((name) => r.take(name));
      if (method === undefined) r.fail();
      let seconds = null;
      if (r.take(",")) {
        r.skip();
        const digits = r.until(")");
        if (!/^[0-9]{1,5}$/.test(digits) || Number(digits) < 1 || Number(digits) > 86400) r.fail();
        seconds = Number(digits);
      }
      r.expect(")");
      fns.rollup = { method, seconds };
    } else if (r.take("as_count()")) fns.asCount = true;
    else if (r.take("as_rate()")) fns.asRate = true;
    else if (r.take("fill(")) {
      const mode = FILL.find((name) => r.take(name));
      if (mode === undefined) r.fail();
      r.expect(")");
      fns.fill = mode;
    } else r.fail();
  }
  return { aggr, metric, scope, scopeText: scopeText.trim(), by, fns, text: null, start };
}

/** `query := expr ("," expr){0,3}` → `{ ok, exprs }` or `{ ok:false, message }`. */
export function parseMetricQuery(source) {
  if (typeof source !== "string" || source.length === 0 || source.length > 4000 || source.includes("�")) {
    return { ok: false, message: "Error parsing query: unsupported syntax at position 0" };
  }
  try {
    const r = reader(source);
    const exprs = [];
    do {
      r.skip();
      const start = r.pos;
      const expr = expression(r);
      expr.text = source.slice(start, r.pos).trim();
      exprs.push(expr);
      r.skip();
    } while (exprs.length < 4 && r.take(","));
    if (!r.eof()) r.fail();
    return { ok: true, exprs };
  } catch (error) {
    if (error instanceof ParseError) return { ok: false, message: error.message };
    throw error;
  }
}

const WINDOW_UNITS = new Map([["m", 60], ["h", 3600], ["d", 86400], ["w", 604800]]);
const COMPARATORS = [">=", "<=", "==", "!=", ">", "<"];

/** `time_aggr(last_Nu):expr comparator number` → `{ ok, parsed }` or `{ ok:false, message }`. */
export function parseMonitorQuery(source) {
  if (typeof source !== "string" || source.length === 0 || source.length > 4000 || source.includes("�")) {
    return { ok: false, message: "Error parsing query: unsupported syntax at position 0" };
  }
  try {
    const r = reader(source);
    r.skip();
    const timeAggr = SPACE_AGGR.find((name) => r.take(`${name}(`));
    if (timeAggr === undefined) r.fail();
    r.expect("last_");
    const digits = r.until("mhdw)");
    if (!/^[0-9]{1,6}$/.test(digits)) r.fail();
    const unit = r.peek();
    if (!WINDOW_UNITS.has(unit)) r.fail();
    r.take(unit);
    const windowSec = Number(digits) * WINDOW_UNITS.get(unit);
    r.expect("):");
    const offset = r.pos;
    const sub = reader(source.slice(offset), offset);
    const expr = expression(sub);
    expr.text = source.slice(offset, offset + sub.pos).trim();
    const tail = reader(source.slice(offset + sub.pos), offset + sub.pos);
    tail.skip();
    const comparator = COMPARATORS.find((op) => tail.take(op));
    if (comparator === undefined) tail.fail();
    tail.skip();
    const number = tail.rest().trim();
    if (!/^-?[0-9]{1,15}(\.[0-9]{1,6})?$/.test(number)) tail.fail();
    return { ok: true, parsed: { kind: "metric", timeAggr, windowSec, expr, comparator, threshold: Number(number) } };
  } catch (error) {
    if (error instanceof ParseError) return { ok: false, message: error.message };
    throw error;
  }
}

/** Composite expression over monitor ids with `&&`, `||`, `!` and parentheses (≤ 10 operands). */
export function parseComposite(source) {
  if (typeof source !== "string" || source.length === 0 || source.length > 1000) {
    return { ok: false, message: "Error parsing query: unsupported syntax at position 0" };
  }
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === " ") { i += 1; continue; }
    if (ch === "(" || ch === ")" || ch === "!") { tokens.push({ t: ch, at: i }); i += 1; continue; }
    if (source.startsWith("&&", i) || source.startsWith("||", i)) { tokens.push({ t: source.slice(i, i + 2), at: i }); i += 2; continue; }
    let j = i;
    while (j < source.length && source[j] >= "0" && source[j] <= "9") j += 1;
    if (j === i || j - i > 12 || source[i] === "0") return { ok: false, message: `Error parsing query: unsupported syntax at position ${i}` };
    tokens.push({ t: "id", id: Number(source.slice(i, j)), at: i });
    i = j;
  }
  let k = 0;
  let depth = 0;
  const ids = [];
  const failAt = () => ({ ok: false, message: `Error parsing query: unsupported syntax at position ${k < tokens.length ? tokens[k].at : source.length}` });
  function primary() {
    const token = tokens[k];
    if (token === undefined) return null;
    if (token.t === "!") { k += 1; const inner = primary(); return inner === null ? null : { op: "!", a: inner }; }
    if (token.t === "(") {
      depth += 1;
      if (depth > 10) return null;
      k += 1;
      const inner = orExpr();
      if (inner === null || tokens[k]?.t !== ")") return null;
      k += 1;
      depth -= 1;
      return inner;
    }
    if (token.t === "id") { k += 1; if (!ids.includes(token.id)) ids.push(token.id); return { op: "id", id: token.id }; }
    return null;
  }
  function andExpr() {
    let left = primary();
    while (left !== null && tokens[k]?.t === "&&") { k += 1; const right = primary(); left = right === null ? null : { op: "&&", a: left, b: right }; }
    return left;
  }
  function orExpr() {
    let left = andExpr();
    while (left !== null && tokens[k]?.t === "||") { k += 1; const right = andExpr(); left = right === null ? null : { op: "||", a: left, b: right }; }
    return left;
  }
  const tree = orExpr();
  if (tree === null || k !== tokens.length) return failAt();
  if (ids.length > 10 || tokens.filter((token) => token.t === "id").length > 10) {
    return { ok: false, message: "Composite monitors support at most 10 monitors" };
  }
  return { ok: true, parsed: { kind: "composite", ids, tree } };
}

/** Evaluate a composite tree; `states` maps id → overall state. Any `No Data` operand makes the result `No Data`. */
export function evaluateComposite(tree, states) {
  let noData = false;
  const walk = (node) => {
    if (node.op === "id") {
      const state = states.get(node.id);
      if (state === undefined || state === "No Data" || state === "Unknown") { noData = true; return false; }
      return state === "Alert" || state === "Warn";
    }
    if (node.op === "!") return !walk(node.a);
    const a = walk(node.a);
    const b = walk(node.b);
    return node.op === "&&" ? a && b : a || b;
  };
  const result = walk(tree);
  return noData ? "No Data" : result ? "Alert" : "OK";
}

/** Whether a tag list satisfies scope entries (AND of entries; `prefix` values match linearly with startsWith). */
export function scopeMatches(tags, scope) {
  for (const entry of scope) {
    const hit = tags.some((tag) => {
      if (entry.value === null) return tag === entry.key || tag.startsWith(`${entry.key}:`);
      const wanted = `${entry.key}:${entry.value}`;
      return entry.prefix ? tag.startsWith(wanted) : tag === wanted;
    });
    if (hit === entry.negate) return false;
  }
  return true;
}
