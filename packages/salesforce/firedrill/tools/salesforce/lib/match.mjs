// Wildcard matching for SOQL LIKE and parameterized search terms, in time linear in the value length.
// No regular expression is ever built from caller input (a `%` → `.*` regex backtracks polynomially),
// and no candidate position is re-tested character by character (a naive "try every start" scan costs
// value length × segment length, which a 32,000-character textarea and a long near-miss segment turn
// into seconds per row). Values are folded once into code-point arrays; then:
//   - SOQL LIKE: `%`-free literal segments are located with Knuth–Morris–Pratt; segments that contain
//     the one-character wildcard `_` are located with a bit-parallel shift-and automaton. Segments are
//     placed leftmost from left to right, so the scanned text regions are disjoint: O(value + pattern).
//   - Search terms: every term of the search string is simulated at once as one bit-parallel automaton
//     (at most 200 symbols, so at most 7 machine words per character): O(value).

// ---------------------------------------------------------------------------------------------
// Case folding
// ---------------------------------------------------------------------------------------------

/** Case folding per code point; keeps the UTF-16 length so the fold never merges or splits characters. */
function foldChar(char) {
  const upper = char.toUpperCase();
  if (upper.length === char.length) {
    const lower = upper.toLowerCase();
    if (lower.length === char.length) return lower;
  }
  const lower = char.toLowerCase();
  return lower.length === char.length ? lower : char;
}

function foldCode(code) {
  if (code < 0x80) return code >= 0x41 && code <= 0x5a ? code + 32 : code;
  return foldChar(String.fromCodePoint(code)).codePointAt(0);
}

/** Fold a string into an Int32Array of folded code points (ASCII takes a fast path). */
export function foldText(text) {
  const out = new Int32Array(text.length);
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    let code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const low = text.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = (code - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
        index += 1;
      }
    }
    out[count] = foldCode(code);
    count += 1;
  }
  return count === out.length ? out : out.subarray(0, count);
}

const ANY = -1; // one-character wildcard inside a segment (never a code point)
const WORD = 32;

// ---------------------------------------------------------------------------------------------
// SOQL LIKE
// ---------------------------------------------------------------------------------------------

/**
 * Longest `%`-free segment containing `_` this Tool locates (shift-and state is ceil(length / 32) words
 * per character). Longer ones fail MALFORMED_QUERY through `reject`; `_`-free segments are unbounded.
 */
export const MAX_WILDCARD_SEGMENT = 256;

/** Does `segment` match `chars` at `at` exactly (O(segment length), used for the anchored ends)? */
function segmentAt(chars, at, segment) {
  if (at < 0 || at + segment.length > chars.length) return false;
  for (let offset = 0; offset < segment.length; offset += 1) {
    const want = segment[offset];
    if (want !== ANY && want !== chars[at + offset]) return false;
  }
  return true;
}

/** Leftmost occurrence finder for a wildcard-free segment (KMP). Returns the end index or -1. */
function literalFinder(segment) {
  const m = segment.length;
  const failure = new Int32Array(m);
  for (let i = 1, k = 0; i < m; i += 1) {
    while (k > 0 && segment[i] !== segment[k]) k = failure[k - 1];
    if (segment[i] === segment[k]) k += 1;
    failure[i] = k;
  }
  return (chars, from, to) => {
    let k = 0;
    for (let i = from; i < to; i += 1) {
      const c = chars[i];
      while (k > 0 && c !== segment[k]) k = failure[k - 1];
      if (c === segment[k]) k += 1;
      if (k === m) return i + 1;
    }
    return -1;
  };
}

/** Leftmost occurrence finder for a segment with `_` (bit-parallel shift-and). Returns the end index or -1. */
function wildcardFinder(segment) {
  const m = segment.length;
  const words = Math.ceil(m / WORD);
  const anyMask = new Uint32Array(words);
  const masks = new Map();
  for (let j = 0; j < m; j += 1) if (segment[j] === ANY) anyMask[j >>> 5] |= 1 << (j & 31);
  for (let j = 0; j < m; j += 1) {
    const code = segment[j];
    if (code === ANY || masks.has(code)) continue;
    const mask = Uint32Array.from(anyMask);
    for (let k = 0; k < m; k += 1) if (segment[k] === code) mask[k >>> 5] |= 1 << (k & 31);
    masks.set(code, mask);
  }
  const lastWord = (m - 1) >>> 5;
  const lastBit = 1 << ((m - 1) & 31);
  if (words === 1) {
    const plain = anyMask[0];
    const single = new Map([...masks].map(([code, mask]) => [code, mask[0]]));
    return (chars, from, to) => {
      let state = 0;
      for (let i = from; i < to; i += 1) {
        const mask = single.get(chars[i]);
        state = ((state << 1) | 1) & (mask === undefined ? plain : mask);
        if ((state & lastBit) !== 0) return i + 1;
      }
      return -1;
    };
  }
  return (chars, from, to) => {
    const state = new Uint32Array(words);
    for (let i = from; i < to; i += 1) {
      const mask = masks.get(chars[i]) ?? anyMask;
      let carry = 1;
      for (let w = 0; w < words; w += 1) {
        const current = state[w];
        state[w] = ((current << 1) | carry) & mask[w];
        carry = current >>> 31;
      }
      if ((state[lastWord] & lastBit) !== 0) return i + 1;
    }
    return -1;
  };
}

/**
 * Compile a SOQL LIKE pattern. `value` is the decoded literal and `wild` a same-length (UTF-16) marker
 * string from the tokenizer: `%` / `_` where the literal carried an unescaped wildcard, anything else
 * for a literal character (so `\%` and `\_` stay literal). Returns `(text) => boolean`: case-insensitive,
 * `%` any sequence (including empty), `_` exactly one character (code point), whole-value match.
 * `reject(message)` must throw; it is called for a `_`-bearing segment longer than MAX_WILDCARD_SEGMENT.
 */
export function compileLike(value, wild, reject) {
  const segments = [[]];
  let index = 0;
  for (const char of value) {
    const marker = wild[index];
    index += char.length;
    if (marker === "%") segments.push([]);
    else if (marker === "_") segments[segments.length - 1].push(ANY);
    else segments[segments.length - 1].push(foldCode(char.codePointAt(0)));
  }
  const first = segments[0];
  const last = segments.length > 1 ? segments[segments.length - 1] : null;
  const minLength = segments.reduce((sum, segment) => sum + segment.length, 0);
  const middle = [];
  for (const segment of segments.slice(1, -1)) {
    if (segment.length === 0) continue;
    const hasAny = segment.includes(ANY);
    const allAny = segment.every((code) => code === ANY);
    if (hasAny && !allAny && segment.length > MAX_WILDCARD_SEGMENT) {
      reject(`LIKE pattern segment with '_' exceeds the supported length of ${MAX_WILDCARD_SEGMENT} characters between '%' wildcards`);
    }
    middle.push({ length: segment.length, find: allAny ? null : hasAny ? wildcardFinder(segment) : literalFinder(segment) });
  }
  // `text` is the raw stored value; `folded` (optional) returns its folded code points, so a caller that
  // evaluates several clauses over the same value folds it once. The anchored first and last segments are
  // tested on the raw value first (O(segment)), so a value they reject is never folded or scanned.
  return (text, folded) => {
    if (text.length < minLength) return false;
    if (last === null) {
      // Exact match: more than 2 UTF-16 units per pattern character cannot match.
      if (text.length > 2 * first.length) return false;
      const chars = folded === undefined ? foldText(text) : folded();
      return chars.length === first.length && segmentAt(chars, 0, first);
    }
    if (!prefixAt(text, first) || !suffixAt(text, last)) return false;
    // Enough code points for both anchors without overlap: at least ceil(length / 2) code points.
    if (middle.length === 0 && text.length >= 2 * minLength) return true;
    const chars = folded === undefined ? foldText(text) : folded();
    if (chars.length < minLength) return false;
    const end = chars.length - last.length;
    if (!segmentAt(chars, 0, first) || !segmentAt(chars, end, last)) return false;
    let position = first.length;
    for (const segment of middle) {
      if (segment.find === null) {
        if (position + segment.length > end) return false;
        position += segment.length;
        continue;
      }
      const found = segment.find(chars, position, end);
      if (found < 0) return false;
      position = found;
    }
    return position <= end;
  };
}

/** Does the raw `text` start with `segment` (folded code points, ANY for `_`)? O(segment length). */
function prefixAt(text, segment) {
  let index = 0;
  for (let offset = 0; offset < segment.length; offset += 1) {
    if (index >= text.length) return false;
    let code = text.charCodeAt(index);
    index += 1;
    if (code >= 0xd800 && code <= 0xdbff && index < text.length) {
      const low = text.charCodeAt(index);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = (code - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
        index += 1;
      }
    }
    const want = segment[offset];
    if (want !== ANY && want !== foldCode(code)) return false;
  }
  return true;
}

/** Does the raw `text` end with `segment`? Pairs surrogates exactly as `foldText` does. O(segment length). */
function suffixAt(text, segment) {
  let index = text.length;
  for (let offset = segment.length - 1; offset >= 0; offset -= 1) {
    if (index <= 0) return false;
    index -= 1;
    let code = text.charCodeAt(index);
    if (code >= 0xdc00 && code <= 0xdfff && index > 0) {
      const high = text.charCodeAt(index - 1);
      if (high >= 0xd800 && high <= 0xdbff) {
        code = (high - 0xd800) * 0x400 + (code - 0xdc00) + 0x10000;
        index -= 1;
      }
    }
    const want = segment[offset];
    if (want !== ANY && want !== foldCode(code)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Parameterized search terms
// ---------------------------------------------------------------------------------------------

// JavaScript's `\s` set, by code point.
function isSpaceCode(code) {
  if (code <= 0x20) return code === 0x20 || (code >= 0x09 && code <= 0x0d);
  if (code < 0xa0) return false;
  return code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff;
}

const TOKEN_BREAK_CODES = new Set([..."@./_-,;:()\"'"].map((char) => char.charCodeAt(0)));

/** Fold a search haystack once so every term reuses it. */
export function prepareHaystack(text) {
  return foldText(text);
}

/**
 * Compile the terms of one search string into `(prepared) => boolean` (true when every term matches).
 * A term matches a case-insensitive prefix of a token that starts at the beginning of the haystack or
 * after whitespace or one of `@ . / _ - , ; : ( ) " '`; `*` matches any run of non-whitespace
 * characters and `?` exactly one non-whitespace character. All terms run as one shift-and automaton:
 * bit j is "the term owning symbol j has matched through symbol j here".
 */
export function compileTerms(terms) {
  const symbols = [];
  const starts = [];
  const accepts = [];
  const loops = [];
  const leading = [];
  for (const term of terms) {
    const codes = [];
    const starAfter = [];
    let leadingStar = false;
    for (const char of term) {
      if (char === "*") {
        if (codes.length === 0) leadingStar = true;
        else starAfter[codes.length - 1] = true;
      } else codes.push(char === "?" ? ANY : foldCode(char.codePointAt(0)));
    }
    if (codes.length === 0) continue; // only stars: matches at the first token start of any haystack
    const base = symbols.length;
    starts.push(base);
    accepts.push(base + codes.length - 1);
    if (leadingStar) leading.push(base);
    codes.forEach((code, offset) => {
      symbols.push(code);
      if (starAfter[offset] === true) loops.push(base + offset);
    });
  }
  const total = symbols.length;
  if (total === 0) return () => true;
  const words = Math.ceil(total / WORD);
  const bits = (positions) => {
    const mask = new Uint32Array(words);
    for (const position of positions) mask[position >>> 5] |= 1 << (position & 31);
    return mask;
  };
  const startMask = bits(starts);
  const leadingMask = bits(leading);
  const acceptMask = bits(accepts);
  const loopMask = bits(loops);
  const notStart = startMask.map((word) => ~word >>> 0);
  const questionMask = bits(symbols.flatMap((code, position) => (code === ANY ? [position] : [])));
  const literalMasks = new Map();
  symbols.forEach((code, position) => {
    if (code === ANY) return;
    if (!literalMasks.has(code)) literalMasks.set(code, isSpaceCode(code) ? new Uint32Array(words) : Uint32Array.from(questionMask));
    literalMasks.get(code)[position >>> 5] |= 1 << (position & 31);
  });
  const blank = new Uint32Array(words);
  const termCount = accepts.length;

  return (chars) => {
    const n = chars.length;
    const state = new Uint32Array(words);
    const pending = Uint32Array.from(acceptMask);
    let remaining = termCount;
    let previous = -1; // code before position i (-1 at the start)
    let inToken = false; // some token start s <= i has no whitespace in [s, i)
    for (let i = 0; i < n; i += 1) {
      const code = chars[i];
      const previousSpace = previous >= 0 && isSpaceCode(previous);
      const tokenStart = previous < 0 || previousSpace || TOKEN_BREAK_CODES.has(previous);
      inToken = tokenStart || (inToken && !previousSpace);
      const space = isSpaceCode(code);
      const mask = literalMasks.get(code) ?? (space ? blank : questionMask);
      let carry = 0;
      for (let w = 0; w < words; w += 1) {
        const current = state[w];
        let inject = 0;
        if (tokenStart) inject |= startMask[w];
        else if (inToken) inject |= leadingMask[w];
        const shifted = (((current << 1) | carry) & notStart[w]) | inject;
        carry = current >>> 31;
        const next = (shifted & mask[w]) | (space ? 0 : current & loopMask[w]);
        state[w] = next;
        const hit = next & pending[w];
        if (hit !== 0) {
          pending[w] &= ~hit;
          for (let bit = hit; bit !== 0; bit &= bit - 1) remaining -= 1;
          if (remaining === 0) return true;
        }
      }
      previous = code;
    }
    return false;
  };
}
