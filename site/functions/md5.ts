/**
 * MD5 —— WebCrypto 只提供 SHA-1/256/384/512，不含 MD5，而 eapi 的摘要用的就是 MD5。
 * 输出大写十六进制、字内小端，逐字节对齐 JDK 的 MessageDigest("MD5") + 生产代码里的 hex()。
 * 已用 jshell 直接调用 NeteaseEapi.sign 的三条真值验证（含中文关键词路径）。
 */

const SHIFT = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const SINE = new Int32Array(64).map((_, i) =>
  Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296));

export function md5Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const bitLen = bytes.length * 8;
  const padded = new Uint8Array((((bytes.length + 8) >> 6) + 1) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  new DataView(padded.buffer).setUint32(padded.length - 8, bitLen >>> 0, true);
  new DataView(padded.buffer).setUint32(padded.length - 4, Math.floor(bitLen / 4294967296), true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const m = new Int32Array(16);

  for (let offset = 0; offset < padded.length; offset += 64) {
    const view = new DataView(padded.buffer, offset, 64);
    for (let i = 0; i < 16; i++) m[i] = view.getInt32(i * 4, true);

    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f = 0, g = 0;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }

      const sum = (a + f + SINE[i] + m[g]) | 0;
      const rotated = ((sum << SHIFT[i]) | (sum >>> (32 - SHIFT[i]))) | 0;
      a = d; d = c; c = b;
      b = (b + rotated) | 0;
    }
    a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
  }

  const out = new Uint8Array(16);
  const view = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach((word, i) => view.setInt32(i * 4, word, true));
  let hex = "";
  for (const byte of out) hex += byte.toString(16).toUpperCase().padStart(2, "0");
  return hex;
}
