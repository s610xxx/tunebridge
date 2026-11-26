import { ProviderApiError } from "./errors.ts";
import { getUser, requireUser, UserContextError } from "./auth.mjs";

export type Route = {
  method: "GET" | "POST" | "DELETE";
  /** 以段匹配，":" 开头为参数段，例如 ["migrations", ":id", "confirm"] */
  segments: string[];
  auth: boolean;
  handle: (ctx: Ctx) => Promise<Response | unknown>;
};

export type Ctx = {
  request: Request;
  params: Record<string, string>;
  query: URLSearchParams;
  user: { user_id: string; name?: string; picture?: string };
  /** 只有写路由需要；用于服务端自签的 CSRF 校验。 */
  csrfValid: boolean;
};

const MAX_BODY_BYTES = 256 * 1024;

export function secret(name: string): string | null {
  const deno = (globalThis as { Deno?: { env?: { get?(k: string): string | undefined } } }).Deno;
  const fromDeno = deno?.env?.get ? deno.env.get(name) : undefined;
  if (fromDeno !== undefined && fromDeno !== null && fromDeno !== "") return fromDeno;
  const node = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  const fromNode = node?.env?.[name];
  return fromNode ? fromNode : null;
}

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

/** 与 Java ApiExceptionHandler 一致：响应体恒为 { error, code }。 */
export function errorResponse(error: unknown): Response {
  if (error instanceof UserContextError) {
    // 上下文缺失/过期都是"重新登录"，只有 CSRF 失败才让前端走刷新令牌分支。
    const auth = error.code === "login_required" || error.code === "invalid_user_context";
    return json({
      error: auth ? "请先登录 Qoder 账号" : "安全令牌已失效，请刷新页面后手动重试",
      code: auth ? "AUTH_REQUIRED" : "CSRF_INVALID",
    }, auth ? 401 : 403);
  }
  if (error instanceof ProviderApiError) {
    return json({ error: error.message, code: error.code }, error.status);
  }
  if (error instanceof SyntaxError) {
    return json({ error: "请求内容格式不正确", code: "INVALID_JSON" }, 400);
  }
  console.error("unhandled function error", error);
  return json({ error: "服务暂时不可用，请稍后重试", code: "INTERNAL_ERROR" }, 500);
}

/**
 * 网关会把 /functions/v1/app 里的函数名段替换成上游名字（app 或 app-d<32位>），
 * 前端又在业务路径前统一加了 /api。这里生成所有可能的候选后缀交给路由表匹配，
 * 不猜任何具体函数名。
 */
export function routeCandidates(request: Request): string[] {
  const path = new URL(request.url).pathname;
  const out: string[] = [];
  const push = (candidate: string) => {
    if (candidate && candidate !== "/" && !out.includes(candidate)) out.push(candidate);
  };
  const withApiAlias = (candidate: string) => {
    push(candidate);
    if (candidate.startsWith("/api/")) push(candidate.slice(4));
  };
  const functionMatch = path.match(/^\/(?:functions\/v1\/)?app(?:-d[0-9a-f]{32})?(\/.*)?$/);
  if (functionMatch) withApiAlias(functionMatch[1] || "/");
  const at = path.indexOf("/app/");
  if (at >= 0) withApiAlias(path.slice(at + 4));
  if (path.startsWith("/api/")) push(path.slice(4));
  const parts = path.split("/").filter(Boolean);
  if (parts.length > 1) push("/" + parts.slice(1).join("/"));
  push(path);
  return out;
}

export function resolve(routes: Route[], method: string, request: Request):
    { route: Route; params: Record<string, string> } | null {
  for (const candidate of routeCandidates(request)) {
    const found = matchRoute(routes, method, candidate);
    if (found) return found;
  }
  return null;
}

export function pathExists(routes: Route[], request: Request): boolean {
  return routeCandidates(request).some(candidate => {
    const parts = candidate.split("/").filter(Boolean);
    return routes.some(route => route.segments.length === parts.length
      && route.segments.every((seg, i) => seg.startsWith(":") || seg === parts[i]));
  });
}

export function matchRoute(routes: Route[], method: string, path: string):
    { route: Route; params: Record<string, string> } | null {
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  for (const route of routes) {
    if (route.method !== method) continue;
    if (route.segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      const want = route.segments[i];
      if (want.startsWith(":")) params[want.slice(1)] = parts[i];
      else if (want !== parts[i]) { ok = false; break; }
    }
    if (ok) return { route, params };
  }
  return null;
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text();
  if (!raw) return {};
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
    throw ProviderApiError.badRequest("请求体过大");
  }
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw ProviderApiError.badRequest("请求内容格式不正确");
  }
  return parsed as Record<string, unknown>;
}

export function requireUserFor(request: Request): Ctx["user"] {
  return requireUser(request);
}

export { getUser, requireUser, UserContextError };
