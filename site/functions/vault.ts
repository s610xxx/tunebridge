import { ProviderApiError } from "./errors.ts";
import { aesKey } from "./keystore.ts";

/**
 * 平台凭据的信封存储。这是本次重写刻意放弃的边界：Java 侧凭据只存服务端会话内存，
 * 而边缘运行时没有可依赖的常驻会话，只能落库，因此这里做到——
 *   · AES-256-GCM 加密，明文（Cookie / media-user-token）绝不明文入库；
 *   · user_id 作为 AAD 绑定，密文跨用户搬运会直接解密失败；
 *   · 带 expiresAt，读取时强制过期，等同 Java 侧"会话过期即清除"；
 *   · 提供显式清除路径，断开连接即删除该行。
 * 未验证项：平台直连数据库的能力是否已被限制到只有本函数可达，需在部署后单独验收。
 */

const IV_BYTES = 12;

export type Sealed = { blob: string; expiresAt: number };

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

export async function seal(userId: string, plaintext: string, ttlMs: number): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode("cred:" + userId) },
    await aesKey(),
    new TextEncoder().encode(plaintext),
  );
  const bytes = new Uint8Array(sealed);
  const packed = new Uint8Array(iv.length + bytes.length);
  packed.set(iv);
  packed.set(bytes, iv.length);
  return { blob: toBase64(packed), expiresAt: Date.now() + ttlMs };
}

export async function open(userId: string, envelope: Sealed | null): Promise<string> {
  if (!envelope || !envelope.blob) throw ProviderApiError.unauthorized("尚未连接该平台");
  if (!Number.isFinite(envelope.expiresAt) || envelope.expiresAt <= Date.now()) {
    throw ProviderApiError.unauthorized("平台登录态已过期，请重新连接");
  }
  const packed = fromBase64(envelope.blob);
  try {
    const plain = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: packed.subarray(0, IV_BYTES),
        additionalData: new TextEncoder().encode("cred:" + userId),
      },
      await aesKey(),
      packed.subarray(IV_BYTES),
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw ProviderApiError.unauthorized("凭据解密失败，请重新连接该平台");
  }
}
