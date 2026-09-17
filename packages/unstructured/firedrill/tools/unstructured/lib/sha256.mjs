// Pure SHA-256 over UTF-8 text (hex digest). Used for deterministic element ids, so it runs once per element: the message is
// encoded straight into a reused byte buffer (lone surrogates become U+FFFD), the schedule and state live in reused typed
// arrays, and the digest is formatted through a lookup table. No allocation per block.

const K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
const W = new Int32Array(64);
const H = new Int32Array(8);
let buffer = new Uint8Array(1024);

/** Writes the UTF-8 bytes of the concatenated `parts` plus SHA-256 padding into `buffer`; returns the padded length (a multiple of 64). */
function encode(parts) {
  let chars = 0;
  for (let p = 0; p < parts.length; p += 1) chars += parts[p].length;
  const need = chars * 3 + 72;
  if (buffer.length < need) buffer = new Uint8Array(Math.max(need, buffer.length * 2));
  const out = buffer;
  let n = 0;
  for (let p = 0; p < parts.length; p += 1) {
    const text = parts[p];
    for (let i = 0; i < text.length; i += 1) {
      let code = text.charCodeAt(i);
      if (code < 0x80) {
        out[n++] = code;
        continue;
      }
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
        const low = text.charCodeAt(i + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
          i += 1;
        } else code = 0xfffd;
      } else if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
      if (code < 0x800) {
        out[n++] = 0xc0 | (code >> 6);
        out[n++] = 0x80 | (code & 0x3f);
      } else if (code < 0x10000) {
        out[n++] = 0xe0 | (code >> 12);
        out[n++] = 0x80 | ((code >> 6) & 0x3f);
        out[n++] = 0x80 | (code & 0x3f);
      } else {
        out[n++] = 0xf0 | (code >> 18);
        out[n++] = 0x80 | ((code >> 12) & 0x3f);
        out[n++] = 0x80 | ((code >> 6) & 0x3f);
        out[n++] = 0x80 | (code & 0x3f);
      }
    }
  }
  const bitLength = n * 8;
  out[n++] = 0x80;
  while (n % 64 !== 56) out[n++] = 0;
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  out[n++] = (high >>> 24) & 255;
  out[n++] = (high >>> 16) & 255;
  out[n++] = (high >>> 8) & 255;
  out[n++] = high & 255;
  out[n++] = (low >>> 24) & 255;
  out[n++] = (low >>> 16) & 255;
  out[n++] = (low >>> 8) & 255;
  out[n++] = low & 255;
  return n;
}

/**
 * Hex SHA-256 of the UTF-8 encoding of `parts` joined (without building the joined string). A surrogate pair must not be split
 * across two parts; callers separate parts with ASCII.
 */
export function sha256Hex(...parts) {
  digest(parts);
  return hexOf(8);
}

/** The first 32 hex characters of `sha256Hex(a, NUL, b, NUL, c, NUL, d)` (element and chunk ids), without a rest array. */
export function sha256Id(a, b, c, d) {
  ID_PARTS[0] = a;
  ID_PARTS[2] = b;
  ID_PARTS[4] = c;
  ID_PARTS[6] = d;
  digest(ID_PARTS);
  ID_PARTS[0] = ID_PARTS[2] = ID_PARTS[4] = ID_PARTS[6] = "";
  return hexOf(4);
}

const NUL = String.fromCharCode(0);
const ID_PARTS = ["", NUL, "", NUL, "", NUL, ""];

function hexOf(words) {
  let hex = "";
  for (let i = 0; i < words; i += 1) {
    const word = H[i];
    hex += HEX[(word >>> 24) & 255] + HEX[(word >>> 16) & 255] + HEX[(word >>> 8) & 255] + HEX[word & 255];
  }
  return hex;
}

/** Runs SHA-256 over the encoded `parts`, leaving the state words in `H`. */
function digest(parts) {
  const length = encode(parts);
  const bytes = buffer;
  const w = W;
  const h = H;
  h[0] = 0x6a09e667;
  h[1] = 0xbb67ae85;
  h[2] = 0x3c6ef372;
  h[3] = 0xa54ff53a;
  h[4] = 0x510e527f;
  h[5] = 0x9b05688c;
  h[6] = 0x1f83d9ab;
  h[7] = 0x5be0cd19;
  for (let offset = 0; offset < length; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      const j = offset + (i << 2);
      w[i] = (bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3];
    }
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let hh = h[7];
    for (let i = 0; i < 64; i += 1) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (hh + s1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0;
    h[1] = (h[1] + b) | 0;
    h[2] = (h[2] + c) | 0;
    h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0;
    h[5] = (h[5] + f) | 0;
    h[6] = (h[6] + g) | 0;
    h[7] = (h[7] + hh) | 0;
  }
}
