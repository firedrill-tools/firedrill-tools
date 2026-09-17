// Real gzip stream with deflate *stored* blocks (RFC 1951 BTYPE=00, RFC 1952 header/trailer) for `orig_elements`.
// No compression happens, but every gzip/zlib reader decodes it. Pure JS, no Node built-ins.
import { base64Encode, utf8Bytes } from "./util.mjs";

const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}

export function crc32(bytes) {
  let crc = -1;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/** gzip bytes (stored blocks of at most 65,535 bytes) for a byte array; mtime is fixed to 0 (deterministic). */
export function gzipStored(bytes) {
  const out = [0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0x00, 0x03];
  const total = bytes.length;
  if (total === 0) out.push(0x01, 0x00, 0x00, 0xff, 0xff);
  for (let offset = 0; offset < total; offset += 65535) {
    const len = Math.min(65535, total - offset);
    const final = offset + len >= total ? 1 : 0;
    out.push(final, len & 255, (len >> 8) & 255, ~len & 255, (~len >> 8) & 255);
    for (let i = 0; i < len; i += 1) out.push(bytes[offset + i]);
  }
  const crc = crc32(bytes);
  out.push(crc & 255, (crc >>> 8) & 255, (crc >>> 16) & 255, (crc >>> 24) & 255);
  out.push(total & 255, (total >>> 8) & 255, (total >>> 16) & 255, (total >>> 24) & 255);
  return out;
}

/** base64(gzip(JSON.stringify(value))) — the encoding the Unstructured library uses for `orig_elements`. */
export function gzipBase64Json(value) {
  return base64Encode(gzipStored(utf8Bytes(JSON.stringify(value))));
}
