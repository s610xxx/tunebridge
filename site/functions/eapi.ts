import { md5Hex } from "./md5.ts";

/**
 * 网易云 eapi 通道：请求发往 /eapi/... ，但签名里用对应的 /api/... 路径。
 * 加密是 AES-128-ECB/PKCS5 —— WebCrypto 没有 ECB 模式，这里用"每块一次 IV=0 的
 * 单块 CBC"复现：CBC 首块输出为 E(P ⊕ IV)，取 IV=0 且丢弃补位块即为 E(P)。
 */

const AES_KEY_TEXT = "e82ckenh8dichen8";
const SEPARATOR = "36cd479b6b5";
const BLOCK = 16;

let cachedKey: Promise<CryptoKey> | null = null;

function aesKey(): Promise<CryptoKey> {
  if (!cachedKey) {
    cachedKey = crypto.subtle.importKey(
      "raw", new TextEncoder().encode(AES_KEY_TEXT), "AES-CBC", false, ["encrypt"]);
  }
  return cachedKey;
}

function pkcs5Pad(bytes: Uint8Array): Uint8Array {
  const pad = BLOCK - (bytes.length % BLOCK);
  const out = new Uint8Array(bytes.length + pad);
  out.set(bytes);
  out.fill(pad, bytes.length);
  return out;
}

async function ecbEncrypt(plain: Uint8Array): Promise<Uint8Array> {
  const key = await aesKey();
  const zeroIv = new Uint8Array(BLOCK);
  const padded = pkcs5Pad(plain);
  const out = new Uint8Array(padded.length);
  for (let offset = 0; offset < padded.length; offset += BLOCK) {
    const block = padded.subarray(offset, offset + BLOCK);
    // 单块输入下 WebCrypto 仍会追加一个整块补位，只取第一块即为 E(block)。
    const chained = await crypto.subtle.encrypt({ name: "AES-CBC", iv: zeroIv }, key, block);
    out.set(new Uint8Array(chained, 0, BLOCK), offset);
  }
  return out;
}

function hexUpper(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).toUpperCase().padStart(2, "0");
  return hex;
}

export async function sign(apiPath: string, paramsJson: string): Promise<string> {
  const digest = md5Hex(`nobody${apiPath}use${paramsJson}md5forencrypt`);
  const payload = `${apiPath}-${SEPARATOR}-${paramsJson}-${SEPARATOR}-${digest}`;
  return hexUpper(await ecbEncrypt(new TextEncoder().encode(payload)));
}

export function params(deviceId: string, csrfToken: string): Record<string, string | number> {
  return {
    os: "pc",
    appver: "9.2.0",
    versioncode: "150",
    mobilename: "chrome",
    buildver: String(Math.floor(Date.now() / 1000)),
    channelId: "desktop",
    deviceId,
    csrf_token: csrfToken,
  };
}

export async function formBody(
  apiPath: string, values: Record<string, string | number>): Promise<string> {
  return "params=" + await sign(apiPath, JSON.stringify(values));
}
