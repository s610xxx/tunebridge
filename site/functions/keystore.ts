import { ProviderApiError } from "./errors.ts";
import { secret } from "./http.ts";

/**
 * 服务端主密钥的唯一来源：应用 Secret CREDENTIAL_KEY（32 字节，hex 或 base64）。
 * 值只经由站点设置录入，不进源码、不进对话、不进工具参数。
 */

let cachedRaw: Uint8Array | null = null;

export function masterKey(): Uint8Array {
  if (cachedRaw) return cachedRaw;
  const raw = secret("CREDENTIAL_KEY");
  if (!raw) throw ProviderApiError.notConfigured("服务端未配置凭据密钥");
  const trimmed = raw.trim();
  let bytes: Uint8Array;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = parseInt(trimmed.slice(i * 2, i * 2 + 2), 16);
  } else {
    const binary = atob(trimmed);
    bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  }
  if (bytes.length !== 32) throw ProviderApiError.notConfigured("凭据密钥长度不是 32 字节");
  cachedRaw = bytes;
  return bytes;
}

export function hmacKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", masterKey(), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

export function aesKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", masterKey(), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** 仅测试用：清掉缓存的密钥材料。 */
export function resetMasterKeyCache(): void {
  cachedRaw = null;
}
