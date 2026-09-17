// Opaque pagination markers: base64url of ASCII JSON, fully validated on the way back in (they are caller input).
import { b64urlDecode, b64urlEncode } from "./util.mjs";

function asciiJson(value) {
  const text = JSON.stringify(value);
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    out += code >= 0x7f ? `\\u${code.toString(16).padStart(4, "0")}` : text[i];
  }
  return out;
}

export function encodeMarker(value) {
  const text = asciiJson(value);
  const bytes = new Array(text.length);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i);
  return b64urlEncode(bytes);
}

/** Returns the parsed object or null for anything malformed. */
export function decodeMarker(marker) {
  const bytes = b64urlDecode(marker);
  if (bytes === null) return null;
  let text = "";
  for (const byte of bytes) {
    if (byte < 0x20 || byte > 0x7e) return null;
    text += String.fromCharCode(byte);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.hasOwn(value, "__proto__")) return null;
  return value;
}
