// Trolley-format ids: `<prefix>-<22 base-62 characters>`. The characters are the zero-padded base-62 rendering of
// one shared counter (`meta/counters.next`), alphabet `0-9A-Za-z`, so lexical order equals creation order.
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const WIDTH = 22;
const ID_PATTERN = /^[RABPM]-[0-9A-Za-z]{22}$/;

export function renderId(prefix, sequence) {
  let n = sequence;
  let out = "";
  while (n > 0) {
    out = ALPHABET[n % 62] + out;
    n = Math.floor(n / 62);
  }
  return `${prefix}-${out.padStart(WIDTH, "0")}`;
}

/** True when `value` has the exact id shape for `prefix`. Never throws. */
export function isId(prefix, value) {
  return typeof value === "string" && value.length === WIDTH + 2 && value[0] === prefix && ID_PATTERN.test(value);
}

/** Next id for `prefix`, advancing the shared counter row. */
export function nextId(context, prefix) {
  const row = context.state.get("meta", "counters");
  const next = row !== null && Number.isSafeInteger(row.next) && row.next >= 1 ? row.next : 1000;
  context.state.put("meta", "counters", { next: next + 1 });
  return renderId(prefix, next);
}
