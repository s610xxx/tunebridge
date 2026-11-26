import { seal, open } from "../site/functions/vault.ts";
import { csrfToken, sameToken } from "../site/functions/csrf.ts";
import { errorResponse, pathExists, resolve, routeCandidates } from "../site/functions/http.ts";
import { ProviderApiError } from "../site/functions/errors.ts";

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : " — " + detail}`);
  if (!ok) failed++;
};

// ---- 1. 凭据信封 ----
const USER = "u_alice";
const COOKIE = "MUSIC_U=abc123; __csrf=tok999";
const sealed = await seal(USER, COOKIE, 3 * 24 * 3600 * 1000);
check("vault 不是明文存储", sealed.blob !== COOKIE && !sealed.blob.includes("MUSIC_U"));
check("vault 往返一致", await open(USER, sealed) === COOKIE);

let crossUser = false;
try { await open("u_mallory", sealed); } catch (e) { crossUser = e.code === "UNAUTHORIZED"; }
check("跨用户搬运密文失败（AAD 绑定）", crossUser);

let tampered = false;
try {
  const raw = Uint8Array.from(atob(sealed.blob), c => c.charCodeAt(0));
  raw[raw.length - 1] ^= 0xff;
  await open(USER, { blob: btoa(String.fromCharCode(...raw)), expiresAt: sealed.expiresAt });
} catch (e) { tampered = e.code === "UNAUTHORIZED"; }
check("篡改密文被拒绝", tampered);

let expired = false;
try { await open(USER, { blob: sealed.blob, expiresAt: Date.now() - 1 }); }
catch (e) { expired = /过期/.test(e.message); }
check("过期凭据拒绝并提示重新连接", expired);

// ---- 2. CSRF 令牌 ----
const token = await csrfToken(USER);
check("CSRF 令牌长度 32 且小写十六进制", /^[0-9a-f]{32}$/.test(token));
check("CSRF 令牌可复现", await csrfToken(USER) === token);
check("不同用户令牌不同", (await csrfToken("u_bob")) !== token);
check("定长比对接受正确值", sameToken(token, token));
check("定长比对拒绝错误值", !sameToken(token, "x".repeat(32)) && !sameToken(token, "") && !sameToken("", ""));

// ---- 3. 错误映射与 Java 对齐 ----
const TABLE = [
  ["badRequest", "INVALID_INPUT", 400],
  ["notConnected", "NOT_CONNECTED", 409],
  ["unauthorized", "UNAUTHORIZED", 401],
  ["notConfigured", "NOT_CONFIGURED", 503],
  ["notFound", "NOT_FOUND", 404],
  ["upstream", "UPSTREAM_ERROR", 502],
  ["rateLimited", "RATE_LIMITED", 429],
  ["authRequired", "AUTH_REQUIRED", 401],
  ["csrfInvalid", "CSRF_INVALID", 403],
];
for (const [factory, code, status] of TABLE) {
  const response = errorResponse(ProviderApiError[factory]("x"));
  const body = await response.clone().json();
  check(`错误映射 ${code} -> ${status}`,
    response.status === status && body.code === code && "error" in body,
    `实际 ${response.status}/${body.code}`);
}
const syntax = await errorResponse(new SyntaxError("bad json")).json();
check("SyntaxError -> INVALID_JSON 400", syntax.code === "INVALID_JSON");
const boom = await errorResponse(new Error("内部细节泄露")).json();
check("未知异常不外泄细节", boom.code === "INTERNAL_ERROR" && boom.error === "服务暂时不可用，请稍后重试");

// ---- 4. 路由解析（不猜网关给的路径前缀） ----
const ROUTES = [
  { method: "GET", segments: ["state"], auth: true, handle: async () => ({}) },
  { method: "POST", segments: ["migrations", ":id", "confirm"], auth: true, handle: async () => ({}) },
  { method: "DELETE", segments: ["connections", ":provider"], auth: true, handle: async () => ({}) },
];
const req = (path) => new Request("https://site.example" + path);

for (const prefix of ["/functions/v1/app", "/upstream-name-7742", "/api", ""]) {
  const hit = resolve(ROUTES, "POST", req(prefix + "/migrations/ab12/confirm"));
  check(`前缀 "${prefix || "(无)"}" 下仍能命中并捕获参数`, !!hit && hit.params.id === "ab12");
}
check("GET /state 命中", resolve(ROUTES, "GET", req("/functions/v1/app/state"))?.route.segments[0] === "state");
check("方法不符不匹配", resolve(ROUTES, "PUT", req("/migrations/ab12/confirm")) === null);
check("未知路径不误配也不视为存在",
  resolve(ROUTES, "GET", req("/nope")) === null && !pathExists(ROUTES, req("/nope/deep/x")));
check("中文与编码段可解码", (() => {
  const r = resolve([{ method: "GET", segments: ["p", ":name"], auth: false, handle: async () => ({}) }],
    "GET", req("/p/" + encodeURIComponent("音桥")));
  return !!r && r.params.name === "音桥";
})());

check("候选顺序：先剥未知首段，再退回原始路径",
  routeCandidates(req("/upstream-77/migrations/x")).slice(0, 2).join(" ")
    === "/migrations/x /upstream-77/migrations/x");
check("/app/ 形态优先取其后的后缀", routeCandidates(req("/functions/v1/app/state"))[0] === "/state");

console.log(failed === 0 ? "SKELETON CHECKS ALL PASS" : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
