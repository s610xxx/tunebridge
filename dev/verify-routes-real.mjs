/**
 * 真实通道的路由级验证：QQ REAL 来源接线 + 凭据不外泄。
 * 上游响应样本取自 dev/verify-qq.mjs（源自 Java 测试类固化的真实形状），全程不联网。
 */
import { createApp } from "../site/functions/app.ts";
import { memoryStore } from "../site/functions/store.ts";

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : " — " + detail}`);
  if (!ok) failed++;
};

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const USER = { user_id: "u_real", name: "", picture: "", site_id: "s1", host_id: "h1",
  session_expires_at: Math.floor(Date.now() / 1000) + 3600 };

const VALIDATE_OK = `{"code":0,"req_0":{"code":0,"data":{"retCode":0,"result":{"retCode":0,"retMsg":"ok"},"v_diss_list":[{"id":7300098051,"name":"深夜写代码","sin":0,"num":4}]}}}`;
const PLAYLIST = `{"code":0,"subcode":0,"notice":"","prompt":"","cdlist":[
  {"dissid":7300098051,"dissname":"深夜写代码","desc":"一个人加班的歌","logo":"https://imgta1.sou5.com/a.jpg",
   "nickname":"阿桥","song_total_count":2,
   "songlist":[
     {"songid":600001,"songmid":"003PU20T3E1eBI","songname":"稻香","albumname":"魔杰座","interval":223,
      "songtype":0,"albummid":"004FfF1V1KQh6s","singer":[{"name":"周杰伦","mid":"x"}]},
     {"songid":600002,"songname":"夜曲","albumname":"十一月的萧邦","interval":227.7,
      "singer":[{"name":"周杰伦"},{"name":"费玉清"}]}
   ]}]}`;

const seen = [];
const queue = [];
const scriptedFetch = async (url, init) => {
  seen.push({ url: String(url), headers: init?.headers ?? {}, body: init?.body ?? "" });
  const next = queue.shift();
  // 与真实 Response 一致：json() 是把 body 文本解析一遍，而不是原样吐对象。
  const body = typeof next === "string" ? next : JSON.stringify(next ?? {});
  return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body };
};

const store = memoryStore();
const app = createApp({ store, fetchImpl: scriptedFetch });

async function call(method, path, body) {
  const headers = { "x-qoder-user-context": b64url({ ...USER,
    session_expires_at: Math.floor(Date.now() / 1000) + 3600 }) };
  if (method !== "GET") headers["x-csrf-token"] = await app.csrfTokenFor(USER.user_id);
  if (body) headers["content-type"] = "application/json";
  const response = await app.handler(new Request("https://site.example/functions/v1/app" + path,
    { method, headers, body: body ? JSON.stringify(body) : undefined }));
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, text };
}

/* ---- 1. 真实 Cookie 连接 ---- */
queue.length = 0; seen.length = 0;
queue.push(VALIDATE_OK);
const connected = await call("POST", "/connections/QQ_MUSIC",
  { mode: "real", cookie: "uin=o0012345678; qm_keyst=qmkeyst_demo; other=x" });
check("真实 QQ 连接成功", connected.status === 200 && connected.body.connected === true,
  JSON.stringify(connected.body));
check("账号名是脱敏 UIN", connected.body?.label === "QQ 音乐 · 12****78", connected.body?.label);
check("连接时确实带上 Cookie 头打上游", /uin=o0012345678/.test(String(seen[0]?.headers?.cookie ?? seen[0]?.headers?.Cookie)),
  JSON.stringify(seen[0]?.headers ?? {}).slice(0, 90));
check("响应体不含 Cookie 原文", !connected.text.includes("qmkeyst_demo"), connected.text.slice(0, 120));

const badCookie = await call("POST", "/connections/QQ_MUSIC", { mode: "real", cookie: "no_uin=1" });
check("缺 UIN 的 Cookie 被拒", badCookie.status === 400 && badCookie.body.code === "INVALID_INPUT",
  badCookie.status + " " + badCookie.body?.error);

/* ---- 2. 真实来源预览（列表路由由 verify-qq 单元级覆盖，此处不重复造样本） ---- */
const listRes = await call("GET", "/playlists", undefined);
check("无 provider 参数时报 400", listRes.status === 400, String(listRes.status));

queue.length = 0; seen.length = 0;
queue.push(PLAYLIST);
const preview = await call("POST", "/playlists/preview",
  { provider: "QQ_MUSIC", url: "https://y.qq.com/n/ryqq/playlist/7300098051" });
check("预览映射出歌单名", preview.body?.name === "深夜写代码", JSON.stringify(preview.body?.error ?? preview.body?.name));
check("曲目字段映射正确",
  preview.body?.tracks?.[0]?.title === "稻香" && preview.body.tracks[0].artist === "周杰伦"
  && preview.body.tracks[0].album === "魔杰座" && preview.body.tracks[0].durationSec === 223,
  JSON.stringify(preview.body?.tracks?.[0]));
check("多歌手拼接保留顺序", preview.body?.tracks?.[1]?.artist === "周杰伦 / 费玉清",
  preview.body?.tracks?.[1]?.artist);
check("预览响应不含 Cookie 原文", !preview.text.includes("qmkeyst_demo"));
check("预览只打一次上游", seen.length === 1, String(seen.length));

const neteaseSource = await call("POST", "/playlists/preview",
  { provider: "NETEASE_MUSIC", url: "https://music.163.com/#/playlist?id=1" });
check("网易云作为来源被拒且不改走 QQ 凭据",
  neteaseSource.status === 400 && /不支持作为来源/.test(neteaseSource.body.error), neteaseSource.body?.error);

/* ---- 3. 过期凭据：先报凭据失效，不是别的误导性原因 ---- */
await store.saveConnection({ userId: "u_old", provider: "QQ_MUSIC", mode: "REAL", label: "旧登录",
  credential: { blob: "zz", expiresAt: Date.now() - 1000 }, createdAt: Date.now() - 9_000_000 });
const headersOld = { "x-qoder-user-context": b64url({ ...USER, user_id: "u_old",
  session_expires_at: Math.floor(Date.now() / 1000) + 3600 }), "content-type": "application/json" };
const expiredRes = await app.handler(new Request("https://site.example/functions/v1/app/playlists/preview",
  { method: "POST", headers: { ...headersOld, "x-csrf-token": await app.csrfTokenFor("u_old") },
    body: JSON.stringify({ provider: "QQ_MUSIC", url: "https://y.qq.com/n/ryqq/playlist/1" }) }));
const expiredBody = await expiredRes.json();
check("过期凭据报 401 UNAUTHORIZED",
  expiredRes.status === 401 && expiredBody.code === "UNAUTHORIZED",
  expiredRes.status + " " + expiredBody.code + " " + expiredBody.error);

console.log(failed === 0 ? "REAL CHANNEL ROUTES PASS" : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
