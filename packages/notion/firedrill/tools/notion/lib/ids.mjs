// Row ids are UUID-shaped strings `fd000000-0000-4000-8000-KKKKNNNNNNNN` (version nibble 4, variant 8):
// KKKK is the kind code and NNNNNNNN a hexadecimal sequence, so creation order equals row-id order and
// `format: uuid` clients accept them. Starter rows use sequences below 0x1000; generated rows take the
// next sequence from the `meta/counters` row. Everything here is pure or reads/writes context.state.

export const KIND = Object.freeze({
  users: "0001",
  pages: "0002",
  databases: "0003",
  "data-sources": "0004",
  blocks: "0005",
  comments: "0006",
  integrations: "0007",
  discussions: "0008",
});

const PREFIX = "fd000000-0000-4000-8000-";
const DASHED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COMPACT = /^[0-9a-f]{32}$/;
const DEFAULT_COUNTERS = Object.freeze({ next_id: 4096 });

export function makeId(kind, sequence) {
  return `${PREFIX}${KIND[kind]}${sequence.toString(16).padStart(8, "0")}`;
}

/** Dashed lowercase UUID for a dashed or 32-hex input; undefined when the value is not UUID-shaped. */
export function normalizeId(value) {
  if (typeof value !== "string") return undefined;
  const lower = value.trim().toLowerCase();
  if (DASHED.test(lower)) return lower;
  if (COMPACT.test(lower)) {
    return `${lower.slice(0, 8)}-${lower.slice(8, 12)}-${lower.slice(12, 16)}-${lower.slice(16, 20)}-${lower.slice(20)}`;
  }
  return undefined;
}

export function compactId(id) {
  return id.replaceAll("-", "");
}

export function counters(context) {
  const stored = context.state.get("meta", "counters");
  return stored === null ? { ...DEFAULT_COUNTERS } : { ...stored };
}

/** Allocate the next row id of `kind` (skipping any sequence that is already taken, bounded probe). */
export function nextId(context, kind) {
  const meta = counters(context);
  let sequence = meta.next_id;
  for (let probe = 0; probe < 1000; probe += 1) {
    if (kind === "discussions" || context.state.get(kind, makeId(kind, sequence)) === null) break;
    sequence += 1;
  }
  context.state.put("meta", "counters", { next_id: sequence + 1 });
  return makeId(kind, sequence);
}

/** Short base-36 ids for schema properties and select options (Notion uses opaque short ids). */
export function nextShortId(context) {
  const meta = counters(context);
  context.state.put("meta", "counters", { next_id: meta.next_id + 1 });
  return meta.next_id.toString(36).padStart(4, "0");
}
