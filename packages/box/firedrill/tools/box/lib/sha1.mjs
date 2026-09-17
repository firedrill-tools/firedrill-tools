// Pure JavaScript SHA-1 over bytes (Box reports a file's sha1 as 40 lowercase hex digits).

const rotl = (value, bits) => ((value << bits) | (value >>> (32 - bits))) >>> 0;

export function sha1Hex(bytes) {
  const length = bytes.length;
  const total = Math.ceil((length + 9) / 64) * 64;
  const data = new Uint8Array(total);
  data.set(bytes);
  data[length] = 0x80;
  const bitLength = length * 8;
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  data[total - 8] = (high >>> 24) & 255;
  data[total - 7] = (high >>> 16) & 255;
  data[total - 6] = (high >>> 8) & 255;
  data[total - 5] = high & 255;
  data[total - 4] = (low >>> 24) & 255;
  data[total - 3] = (low >>> 16) & 255;
  data[total - 2] = (low >>> 8) & 255;
  data[total - 1] = low & 255;
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let offset = 0; offset < total; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      const j = offset + i * 4;
      w[i] = ((data[j] << 24) | (data[j + 1] << 16) | (data[j + 2] << 8) | data[j + 3]) >>> 0;
    }
    for (let i = 16; i < 80; i += 1) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i += 1) {
      let f;
      let k;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (rotl(a, 5) + (f >>> 0) + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = temp;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((h) => h.toString(16).padStart(8, "0")).join("");
}
