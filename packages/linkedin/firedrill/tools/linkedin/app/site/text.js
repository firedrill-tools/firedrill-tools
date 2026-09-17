// Little-text rendering (hashtag templates, @[Name](urn) mentions, backslash escapes) into safe DOM nodes.
import { el } from "./ui.js";
import { hrefForUrn } from "./store.js";

const RESERVED = new Set(["\\", "|", "{", "}", "@", "[", "]", "(", ")", "<", ">", "#", "*", "_", "~"]);

/** Escape plain user text for the posts commentary field. `#word` stays unescaped so the service templates hashtags. */
export function escapeLittleText(text) {
  let out = "";
  const chars = [...String(text)];
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i];
    const next = chars[i + 1] ?? "";
    const hashtag = char === "#" && /[\p{L}\p{N}_]/u.test(next) && !/[\p{L}\p{N}_]/u.test(chars[i - 1] ?? "");
    out += RESERVED.has(char) && !hashtag ? `\\${char}` : char;
  }
  return out;
}

/** Parse little text into segments: {kind:"text"|"hashtag"|"mention", text, urn?}. Linear single pass. */
export function parseLittleText(source) {
  const chars = [...String(source ?? "")];
  const segments = [];
  let buffer = "";
  const flush = () => { if (buffer) segments.push({ kind: "text", text: buffer }); buffer = ""; };
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i];
    if (char === "\\" && i + 1 < chars.length) { buffer += chars[i + 1]; i += 1; continue; }
    if (char === "{" && chars.slice(i + 1, i + 12).join("") === "hashtag|\\#|") {
      const end = chars.indexOf("}", i + 12);
      if (end > i + 12) { flush(); segments.push({ kind: "hashtag", text: chars.slice(i + 12, end).join("") }); i = end; continue; }
    }
    if (char === "@" && chars[i + 1] === "[") {
      const close = chars.indexOf("]", i + 2);
      if (close > i + 1 && chars[close + 1] === "(") {
        const paren = chars.indexOf(")", close + 2);
        const urn = paren > close ? chars.slice(close + 2, paren).join("") : "";
        if (urn.startsWith("urn:li:")) {
          flush();
          segments.push({ kind: "mention", text: chars.slice(i + 2, close).join("").replace(/\\(.)/gu, "$1"), urn });
          i = paren;
          continue;
        }
      }
    }
    buffer += char;
  }
  flush();
  return segments;
}

/** Plain text form (for counting and edit boxes). */
export function littleTextToPlain(source) {
  return parseLittleText(source).map((s) => (s.kind === "hashtag" ? `#${s.text}` : s.text)).join("");
}

/** Render commentary into a container. */
export function renderLittleText(container, source) {
  for (const segment of parseLittleText(source)) {
    if (segment.kind === "text") container.append(document.createTextNode(segment.text));
    else if (segment.kind === "hashtag") container.append(el("a", { class: "hashtag", text: `#${segment.text}`, attrs: { href: "#/feed", "data-not-simulated": "Hashtag feeds" } }));
    else container.append(el("a", { class: "mention", text: segment.text, attrs: { href: hrefForUrn(segment.urn) } }));
  }
  return container;
}

/** Render comment text with {start,length,value} mention attributes (offsets in UTF-16 units). */
export function renderAttributedText(container, text, attributes = []) {
  const ranges = [...attributes].filter((a) => a && Number.isInteger(a.start) && Number.isInteger(a.length)).sort((a, b) => a.start - b.start);
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor || range.start + range.length > text.length) continue;
    container.append(document.createTextNode(text.slice(cursor, range.start)));
    const urn = range.value?.person?.person ?? range.value?.organization?.organization;
    container.append(el("a", { class: "mention", text: text.slice(range.start, range.start + range.length), attrs: { href: urn ? hrefForUrn(urn) : "#/feed" } }));
    cursor = range.start + range.length;
  }
  container.append(document.createTextNode(text.slice(cursor)));
  return container;
}
