// Reaction emoji parsing and ASCII row keys. Pure.
import { isSnowflake, pad } from "./snowflake.mjs";

const HEX = "0123456789abcdef";

/** Lowercase hex of the string's UTF-8 bytes, or null when it contains a lone surrogate. */
export function utf8Hex(text) {
  let out = "";
  const push = (byte) => {
    out += HEX[byte >> 4] + HEX[byte & 15];
  };
  for (let index = 0; index < text.length; index += 1) {
    let code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return null;
      code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return null;
    }
    if (code < 0x80) push(code);
    else if (code < 0x800) {
      push(0xc0 | (code >> 6));
      push(0x80 | (code & 63));
    } else if (code < 0x10000) {
      push(0xe0 | (code >> 12));
      push(0x80 | ((code >> 6) & 63));
      push(0x80 | (code & 63));
    } else {
      push(0xf0 | (code >> 18));
      push(0x80 | ((code >> 12) & 63));
      push(0x80 | ((code >> 6) & 63));
      push(0x80 | (code & 63));
    }
  }
  return out;
}

const CUSTOM = /^([A-Za-z0-9_]{2,32}):([0-9]{1,20})$/;

/**
 * `name:id` → custom emoji; otherwise a unicode emoji. The unicode check is a heuristic: 1–32 UTF-16 units, no lone
 * surrogates, at least one non-ASCII code point, and ASCII limited to the keycap bases 0-9, # and *.
 */
export function parseEmoji(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 64) return null;
  const custom = CUSTOM.exec(raw);
  if (custom !== null) {
    return isSnowflake(custom[2]) ? { kind: "custom", name: custom[1], id: custom[2] } : null;
  }
  if (raw.length > 32) return null;
  let nonAscii = false;
  for (const char of raw) {
    const code = char.codePointAt(0);
    if (code < 0x80) {
      if (!/^[0-9#*]$/.test(char)) return null;
    } else if ((code >= 0x80 && code < 0xa0) || code === 0x2028 || code === 0x2029 || (code >= 0xd800 && code <= 0xdfff)) {
      return null;
    } else {
      nonAscii = true;
    }
  }
  if (!nonAscii || utf8Hex(raw) === null) return null;
  return { kind: "unicode", name: raw, id: null };
}

export function emojiKey(emoji) {
  return emoji.kind === "custom" ? `c${pad(emoji.id)}` : `u${utf8Hex(emoji.name)}`;
}
