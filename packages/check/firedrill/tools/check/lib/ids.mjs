// Check-style ids: `<prefix>_` + 20 base-62 characters. New ids render the shared `meta/counters.next` value through a
// fixed bijection (multiply by an odd constant coprime to 62, modulo 62^20), so they look scrambled but are deterministic.
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const WIDTH = 20;
const MODULUS = 62n ** 20n;
const MULTIPLIER = 541872957718394823647509218345677633n; // odd, not divisible by 31
const OFFSET = 918273645546372819283746n;
const SHAPE = /^[A-Za-z0-9]{1,64}$/;
export const PREFIXES = ["com", "wrk", "emp", "rte", "psc", "pay", "itm"];

export function renderId(prefix, sequence) {
  let n = (BigInt(sequence) * MULTIPLIER + OFFSET) % MODULUS;
  let out = "";
  for (let i = 0; i < WIDTH; i++) {
    out = ALPHABET[Number(n % 62n)] + out;
    n /= 62n;
  }
  return `${prefix}_${out}`;
}

/** True when `value` is `<prefix>_` + 1–64 alphanumerics. Never throws. */
export function isId(prefix, value) {
  return typeof value === "string" && value.length <= prefix.length + 65 && value.startsWith(`${prefix}_`) && SHAPE.test(value.slice(prefix.length + 1));
}

/** Allocates a fresh id for `namespace`, skipping any id already present (at most 8 tries). */
export function nextId(context, prefix, namespace) {
  const row = context.state.get("meta", "counters");
  let next = row !== null && Number.isSafeInteger(row.next) && row.next >= 1 ? row.next : 1000;
  for (let attempt = 0; attempt < 8; attempt++) {
    const id = renderId(prefix, next);
    next += 1;
    if (context.state.get(namespace, id) === null) {
      context.state.put("meta", "counters", { next });
      return { id, seq: next - 1 };
    }
  }
  return context.fail({ code: "INTERNAL_ERROR", message: "Could not allocate an id." });
}
