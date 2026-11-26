import { ProviderApiError } from "./errors.ts";
import { hmacKey } from "./keystore.ts";

/**
 * 应用层 CSRF：站点网关会做同源检查，但"绕过入口"的保护不由我们假设成立，
 * 所以保留与 Java 侧等价的令牌校验，让前端 app.js 现有的 403 + CSRF_INVALID
 * 恢复分支（刷新登录态、且不自动重发写入）继续有效。
 * 令牌由服务端密钥绑定 user_id 派生，不需要额外存储。
 */

const KEY_DOMAIN = "csrf:";

export async function csrfToken(userId: string): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(),
    new TextEncoder().encode(KEY_DOMAIN + userId));
  return Array.from(new Uint8Array(mac), b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

/** 定长比对，避免把令牌是否匹配变成可测时序。 */
export function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function assertCsrf(request: Request, userId: string): Promise<void> {
  const header = request.headers.get("x-csrf-token") || "";
  return csrfToken(userId).then(expected => {
    if (!sameToken(header, expected)) throw ProviderApiError.csrfInvalid();
  });
}
