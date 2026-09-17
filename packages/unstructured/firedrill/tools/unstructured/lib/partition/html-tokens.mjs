// Linear, single-pass HTML tokenizer. One explicit index moves forward over the input; every scan is bounded by the tag
// or raw-text element it belongs to, nothing is lowercased or rescanned per tag, and no regular expression touches the
// caller's markup. Tokens are streamed to a sink so a document never needs a token array.
import { decodeEntities } from "./html-util.mjs";

const RAW_TEXT = new Set(["script", "style"]);
const WANTED_ATTRS = new Set(["class", "href", "alt", "src", "style"]);

const isSpace = (c) => c === 32 || c === 9 || c === 10 || c === 13 || c === 12;
const isNameChar = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 58 || c === 95;

/** End index (exclusive) of the tag or attribute name starting at `i`. */
function readName(text, i) {
  let j = i;
  while (j < text.length && isNameChar(text.charCodeAt(j))) j += 1;
  return j;
}

/** Parses attributes in `text[i..end)`; every scan stops at `end`, so the cost is the tag's own length. */
function readAttrs(text, i, end) {
  const attrs = Object.create(null);
  while (i < end) {
    while (i < end && isSpace(text.charCodeAt(i))) i += 1;
    if (i >= end || text.charCodeAt(i) === 47) break; // "/"
    const nameEnd = readName(text, i);
    if (nameEnd === i) {
      i += 1;
      continue;
    }
    const name = text.slice(i, nameEnd).toLowerCase();
    i = nameEnd;
    while (i < end && isSpace(text.charCodeAt(i))) i += 1;
    let value = "";
    if (i < end && text.charCodeAt(i) === 61) { // "="
      i += 1;
      while (i < end && isSpace(text.charCodeAt(i))) i += 1;
      const quote = i < end ? text.charCodeAt(i) : 0;
      if (quote === 34 || quote === 39) {
        let j = i + 1;
        while (j < end && text.charCodeAt(j) !== quote) j += 1;
        value = text.slice(i + 1, j);
        i = j + 1;
      } else {
        let j = i;
        while (j < end && !isSpace(text.charCodeAt(j))) j += 1;
        value = text.slice(i, j);
        i = j;
      }
    }
    if (WANTED_ATTRS.has(name) && attrs[name] === undefined) attrs[name] = decodeEntities(value);
  }
  return attrs;
}

/** True when `text[at..]` starts with `name` ignoring ASCII case and the name ends there. */
function matchesName(text, at, name) {
  for (let k = 0; k < name.length; k += 1) {
    const c = text.charCodeAt(at + k);
    if (c !== name.charCodeAt(k) && (c | 32) !== name.charCodeAt(k)) return false;
  }
  return !isNameChar(text.charCodeAt(at + name.length));
}

/** Index of the `</name` closing a raw-text element, searched forward from `from` only (linear over the element). */
function findRawEnd(text, name, from) {
  let at = text.indexOf("</", from);
  while (at >= 0) {
    if (matchesName(text, at + 2, name)) return at;
    at = text.indexOf("</", at + 2);
  }
  return -1;
}

/**
 * Streams tokens to `sink`: { kind: "text", text }, { kind: "open", name, attrs, selfClosing } or { kind: "close", name }.
 * `sink` returns undefined to continue or an error message to stop. Returns { error } when the sink stopped or the
 * markup has an unterminated tag, else {}.
 */
export function tokenize(html, sink) {
  const n = html.length;
  let i = 0;
  let error;
  const emit = (token) => {
    error = sink(token);
    return error === undefined;
  };
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      if (!emit({ kind: "text", text: decodeEntities(html.slice(i)) })) return { error };
      break;
    }
    if (lt > i && !emit({ kind: "text", text: decodeEntities(html.slice(i, lt)) })) return { error };
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
      const end = html.indexOf(">", lt + 2);
      i = end < 0 ? n : end + 1;
      continue;
    }
    const closing = html.charCodeAt(lt + 1) === 47;
    const nameStart = closing ? lt + 2 : lt + 1;
    const nameEnd = readName(html, nameStart);
    if (nameEnd === nameStart) {
      if (!emit({ kind: "text", text: "<" })) return { error };
      i = lt + 1;
      continue;
    }
    const gt = html.indexOf(">", nameEnd);
    if (gt < 0) return { error: "File is not valid html" };
    const name = html.slice(nameStart, nameEnd).toLowerCase();
    i = gt + 1;
    if (closing) {
      if (!emit({ kind: "close", name })) return { error };
      continue;
    }
    const selfClosing = html.charCodeAt(gt - 1) === 47 && gt - 1 >= nameEnd;
    if (!emit({ kind: "open", name, attrs: readAttrs(html, nameEnd, selfClosing ? gt - 1 : gt), selfClosing })) return { error };
    if (RAW_TEXT.has(name) && !selfClosing) {
      const end = findRawEnd(html, name, i);
      if (end < 0) {
        i = n;
        continue;
      }
      const close = html.indexOf(">", end);
      if (!emit({ kind: "close", name })) return { error };
      i = close < 0 ? n : close + 1;
    }
  }
  return {};
}
