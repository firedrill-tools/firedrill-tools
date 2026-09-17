// MD5 (RFC 1321) over a byte array in plain JavaScript, used for the `md5Checksum` of blob files. Deterministic,
// no Node built-ins. Inputs are bounded by the package's 256 KiB content limit.

const SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11,
  16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const K = Array.from({ length: 64 }, (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 4294967296) >>> 0);

function rotateLeft(value, amount) {
  return ((value << amount) | (value >>> (32 - amount))) >>> 0;
}

export function md5Hex(input) {
  const bytes = Array.from(input);
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const low = bitLength >>> 0;
  const high = Math.floor(bitLength / 4294967296) >>> 0;
  for (let index = 0; index < 4; index += 1) bytes.push((low >>> (8 * index)) & 255);
  for (let index = 0; index < 4; index += 1) bytes.push((high >>> (8 * index)) & 255);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let offset = 0; offset < bytes.length; offset += 64) {
    const words = new Array(16);
    for (let index = 0; index < 16; index += 1) {
      const base = offset + index * 4;
      words[index] = (bytes[base] | (bytes[base + 1] << 8) | (bytes[base + 2] << 16) | (bytes[base + 3] << 24)) >>> 0;
    }
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let index = 0; index < 64; index += 1) {
      let f;
      let g;
      if (index < 16) {
        f = (b & c) | (~b & d);
        g = index;
      } else if (index < 32) {
        f = (d & b) | (~d & c);
        g = (5 * index + 1) % 16;
      } else if (index < 48) {
        f = b ^ c ^ d;
        g = (3 * index + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * index) % 16;
      }
      const temp = d;
      d = c;
      c = b;
      b = (b + rotateLeft((a + f + K[index] + words[g]) >>> 0, SHIFTS[index])) >>> 0;
      a = temp;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  let hex = "";
  for (const word of [a0, b0, c0, d0]) {
    for (let index = 0; index < 4; index += 1) hex += ((word >>> (8 * index)) & 255).toString(16).padStart(2, "0");
  }
  return hex;
}
