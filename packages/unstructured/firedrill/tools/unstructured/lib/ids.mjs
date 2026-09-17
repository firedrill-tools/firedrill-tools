// Ids and counters: UUID v4 strings drawn from the seeded random source, `seq` from meta/counters.

const HEX = "0123456789abcdef";

/** Deterministic (per seed) UUID v4 from context.random. */
export function uuid(context) {
  let out = "";
  for (let i = 0; i < 32; i += 1) {
    if (i === 8 || i === 12 || i === 16 || i === 20) out += "-";
    if (i === 12) out += "4";
    else if (i === 16) out += HEX[8 + context.random.nextInteger(0, 4)];
    else out += HEX[context.random.nextInteger(0, 16)];
  }
  return out;
}

export function nextSeq(context) {
  const row = context.state.get("meta", "counters");
  const current = row !== null && Number.isInteger(row.next_seq) ? row.next_seq : 1000;
  context.state.put("meta", "counters", { next_seq: current + 1 });
  return current;
}

const DEFAULT_LIMITS = { connectors: 2000, workflows: 5000, jobs: 5000, files_per_source: 200, source_file_bytes: 262144, response_bytes: 900 * 1024 };

export function limits(context) {
  const row = context.state.get("meta", "limits");
  const out = { ...DEFAULT_LIMITS };
  if (row !== null) for (const key of Object.keys(DEFAULT_LIMITS)) if (Number.isInteger(row[key]) && row[key] >= 0) out[key] = row[key];
  return out;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A caller-supplied row id is usable when it is a non-empty string short enough for the state store. */
export const usableId = (value) => typeof value === "string" && value.length > 0 && value.length <= 512;
