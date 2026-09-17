// Note content conversion between Attio's two note formats. Every routine is a single left-to-right pass over the
// text (plus one backward pass for link targets), so its cost is linear in the content length. No RegExp is built
// from caller text.

const ESCAPED = new Set(["\\", "*", "_", "~", "=", "[", "]", "`"]);
const LINE_START_ESCAPED = new Set(["#", "-", "+", ">"]);

/** Plaintext → markdown: markdown control characters are backslash-escaped so they render literally. */
export function plaintextToMarkdown(text) {
  let out = "";
  let lineStart = true;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (ESCAPED.has(character) || (lineStart && LINE_START_ESCAPED.has(character))) out += "\\";
    out += character;
    lineStart = character === "\n";
  }
  return out;
}

function isWordCharacter(character) {
  if (character === undefined) return false;
  const code = character.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code > 127;
}

function stripLinePrefix(line) {
  let index = 0;
  while (index < line.length && line[index] === " " && index < 3) index += 1;
  let hashes = 0;
  while (index + hashes < line.length && line[index + hashes] === "#" && hashes < 4) hashes += 1;
  if (hashes >= 1 && hashes <= 3 && line[index + hashes] === " ") return line.slice(index + hashes + 1);
  const rest = line.slice(index);
  if ((rest.startsWith("- ") || rest.startsWith("* ") || rest.startsWith("+ ")) && rest.length > 2) return rest.slice(2);
  if (rest.startsWith("- [ ] ") || rest.startsWith("- [x] ")) return rest.slice(6);
  let digits = 0;
  while (digits < rest.length && digits < 9 && rest[digits] >= "0" && rest[digits] <= "9") digits += 1;
  if (digits > 0 && rest[digits] === "." && rest[digits + 1] === " ") return rest.slice(digits + 2);
  if (rest.startsWith("> ")) return rest.slice(2);
  return line;
}

/** Markdown → plaintext: headings, list and quote markers, emphasis, strike, highlight and link syntax removed. */
export function markdownToPlaintext(markdown) {
  const lines = markdown.split("\n").map(stripLinePrefix);
  const text = lines.join("\n");
  // Backward pass: index of the next ")" or newline at or after each position.
  const nextClose = new Int32Array(text.length + 1);
  nextClose[text.length] = -1;
  for (let index = text.length - 1; index >= 0; index -= 1) {
    const character = text[index];
    nextClose[index] = character === ")" ? index : character === "\n" ? -1 : nextClose[index + 1];
  }
  const parts = [];
  let openBracket = -1;
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === "\\" && index + 1 < text.length && text[index + 1] !== "\n") {
      parts.push(text[index + 1]);
      index += 2;
      continue;
    }
    if (character === "\n") {
      openBracket = -1;
      parts.push(character);
      index += 1;
      continue;
    }
    if (character === "[") {
      openBracket = parts.length;
      parts.push(character);
      index += 1;
      continue;
    }
    if (character === "]" && openBracket >= 0 && text[index + 1] === "(") {
      const close = index + 2 <= text.length ? nextClose[index + 2] : -1;
      if (close > 0) {
        parts[openBracket] = "";
        openBracket = -1;
        index = close + 1;
        continue;
      }
    }
    const pair = text.slice(index, index + 2);
    if (pair === "**" || pair === "__" || pair === "~~" || pair === "==") {
      index += 2;
      continue;
    }
    if ((character === "*" || character === "_") && !(isWordCharacter(text[index - 1]) && isWordCharacter(text[index + 1]))) {
      index += 1;
      continue;
    }
    parts.push(character);
    index += 1;
  }
  return parts.join("");
}
