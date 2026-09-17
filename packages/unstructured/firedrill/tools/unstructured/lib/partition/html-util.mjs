// HTML escaping and entity decoding without regular expressions over caller text.

export function escapeHtml(text) {
  let out = "";
  for (const ch of text) {
    if (ch === "&") out += "&amp;";
    else if (ch === "<") out += "&lt;";
    else if (ch === ">") out += "&gt;";
    else if (ch === '"') out += "&quot;";
    else out += ch;
  }
  return out;
}

const NAMED = new Map([
  ["amp", "&"], ["lt", "<"], ["gt", ">"], ["quot", '"'], ["apos", "'"], ["nbsp", "\u00a0"], ["middot", "\u00b7"], ["copy", "\u00a9"], ["reg", "\u00ae"],
  ["trade", "\u2122"], ["mdash", "\u2014"], ["ndash", "\u2013"], ["hellip", "\u2026"], ["laquo", "\u00ab"], ["raquo", "\u00bb"], ["ldquo", "\u201c"],
  ["rdquo", "\u201d"], ["lsquo", "\u2018"], ["rsquo", "\u2019"], ["euro", "\u20ac"], ["pound", "\u00a3"], ["deg", "\u00b0"], ["times", "\u00d7"], ["bull", "\u2022"],
]);

/** Decodes named and numeric character references; unknown references are kept literally. */
export function decodeEntities(text) {
  if (!text.includes("&")) return text;
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch !== "&") {
      out += ch;
      i += 1;
      continue;
    }
    // The `;` is searched within the next 12 code units only (the longest recognised reference), so a run of `&` without
    // any `;` costs a bounded scan per `&` and the pass stays linear.
    let end = -1;
    const limit = Math.min(text.length, i + 13);
    for (let j = i + 1; j < limit; j += 1)
      if (text.charCodeAt(j) === 59) {
        end = j;
        break;
      }
    if (end < 0) {
      out += ch;
      i += 1;
      continue;
    }
    const name = text.slice(i + 1, end);
    let decoded = null;
    if (NAMED.has(name)) decoded = NAMED.get(name);
    else if (name.length > 1 && name[0] === "#") {
      const hex = name[1] === "x" || name[1] === "X";
      const digits = name.slice(hex ? 2 : 1);
      const valid = digits.length > 0 && digits.length <= 7 && [...digits].every((d) => (hex ? /[0-9A-Fa-f]/.test(d) : /[0-9]/.test(d)));
      if (valid) {
        const code = parseInt(digits, hex ? 16 : 10);
        if (code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) decoded = String.fromCodePoint(code);
      }
    }
    if (decoded === null) {
      out += ch;
      i += 1;
    } else {
      out += decoded;
      i = end + 1;
    }
  }
  return out;
}

const isCollapsible = (c) => c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 0xa0;

/** Runs of ASCII whitespace and NBSP become one space; leading and trailing runs are dropped. Linear, no regex. */
export function collapseSpace(text) {
  const parts = [];
  let start = -1;
  for (let i = 0; i < text.length; i += 1) {
    if (isCollapsible(text.charCodeAt(i))) {
      if (start >= 0) {
        parts.push(text.slice(start, i));
        start = -1;
      }
    } else if (start < 0) start = i;
  }
  if (start >= 0) parts.push(text.slice(start));
  return parts.join(" ");
}

/** True when the whitespace-separated `value` (an HTML class attribute) contains `token`. */
export function hasClassToken(value, token) {
  let start = -1;
  for (let i = 0; i <= value.length; i += 1) {
    const space = i === value.length || isCollapsible(value.charCodeAt(i));
    if (space) {
      if (start >= 0 && i - start === token.length && value.startsWith(token, start)) return true;
      start = -1;
    } else if (start < 0) start = i;
  }
  return false;
}
