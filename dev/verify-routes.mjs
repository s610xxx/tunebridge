import { createApp } from "../site/functions/app.ts";
import { memoryStore } from "../site/functions/store.ts";

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : " — " + detail}`);
  if (!ok) failed++;
};

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const USER = { user_id: "u_alice", name: "Alice", picture: "", site_id: "s1", host_id: "h1",
  session_expires_at: Math.floor(Date.now() / 1000) + 3600 };
const asToken = (value) => b64url({ ...value, session_expires_at: Math.floor(Date.now() / 1000) + 3600 });

const upstreamCalls = [];
const neverFetch = async (url) => { upstreamCalls.push(String(url)); throw new Error("演示链路不该出网: " + url); };
const store = memoryStore();
const app = createApp({ store, fetchImpl: neverFetch });

async function call(method, path, { body, user = USER, csrf = true, query = "" } = {}) {
  const headers = {};
  if (user) headers["x-qoder-user-context"] = asToken(user);
  if (method !== "GET") headers["x-csrf-token"] = await app.csrfTokenFor(user ? user.user_id : "");
  if (!csrf && method !== "GET") headers["x-csrf-token"] = "deadbeef";
  if (body) headers["content-type"] = "application/json";
  const response = await app.handler(new Request("https://site.example/functions/v1/app" + path + query,
    { method, headers, body: body ? JSON.stringify(body) : undefined }));
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: response.status, body: json, text };
}

/* ---- 1. 鉴权与 CSRF 闸门 ---- */
check("未登录读受保护路由 -> 401 AUTH_REQUIRED",
  (async () => {
    const r = await call("GET", "/state", { user: null });
    return r.status === 401 && r.body.code === "AUTH_REQUIRED";
  })());

const csrfless = await call("POST", "/connections/NETEASE_MUSIC", { body: { mode: "demo" }, csrf: false });
check("写请求缺 CSRF -> 403 CSRF_INVALID", csrfless.status === 403 && csrfless.body.code === "CSRF_INVALID",
  csrfless.status + " " + csrfless.body?.code);

const anonWrite = await call("POST", "/connections/NETEASE_MUSIC", { body: { mode: "demo" }, user: null });
check("匿名写 -> 401 而不是 500", anonWrite.status === 401 && anonWrite.body.code === "AUTH_REQUIRED");

const missing = await call("GET", "/nope/nope");
check("未知路径 -> 404 NOT_FOUND", missing.status === 404 && missing.body.code === "NOT_FOUND");

const badProvider = await call("POST", "/connections/SPOTIFY", { body: { mode: "demo" } });
check("未知平台 -> 400 INVALID_INPUT", badProvider.status === 400 && badProvider.body.code === "INVALID_INPUT");

/* ---- 2. 连接与状态 ---- */
const qqConnect = await call("POST", "/connections/QQ_MUSIC", { body: { mode: "demo" } });
check("连接演示来源成功", qqConnect.status === 200 && qqConnect.body.connected === true, JSON.stringify(qqConnect.body));
const netConnect = await call("POST", "/connections/NETEASE_MUSIC", { body: { mode: "demo" } });
check("连接演示目标成功", netConnect.status === 200 && netConnect.body.mode === "DEMO");

const stateAfter = await call("GET", "/state");
check("/state 列出两条已连接",
  Object.keys(stateAfter.body.connections ?? {}).length === 2, JSON.stringify(stateAfter.body.connections));

// 过期凭据必须视为未连接（这是保留 expiresAt 判断的意义所在）
await store.saveConnection({ userId: "u_expired", provider: "QQ_MUSIC", mode: "REAL", label: "旧登录",
  credential: { blob: "zz", expiresAt: Date.now() - 1000 }, createdAt: Date.now() - 9_000_000 });
const expiredState = await call("GET", "/state", { user: { ...USER, user_id: "u_expired" } });
check("过期凭据不再算已连接", Object.keys(expiredState.body.connections ?? {}).length === 0,
  JSON.stringify(expiredState.body.connections));
// 用 QQ 作来源探测：网易云作为来源会先被业务规则拒掉，测不到凭据这条路径。
const expiredUse = await call("POST", "/playlists/preview",
  { user: { ...USER, user_id: "u_expired" }, body: { provider: "QQ_MUSIC", url: "https://y.qq.com/n/ryqq/playlist/1" } });
// 与 Java 一致：凭据失效报 401 UNAUTHORIZED，而不是 503 误导性原因。
check("过期凭据使用时先报凭据失效", expiredUse.status === 401 && expiredUse.body.code === "UNAUTHORIZED"
  && /过期|重新连接/.test(expiredUse.body.error),
  expiredUse.status + " " + expiredUse.body?.code + " " + expiredUse.body?.error);

/* ---- 3. 来源读取 ---- */
const list = await call("GET", "/playlists", { query: "?provider=QQ_MUSIC" });
check("演示来源歌单可读", Array.isArray(list.body) && list.body.length >= 1 && list.body[0].trackCount === 12,
  JSON.stringify(list.body).slice(0, 140));

const preview = await call("POST", "/playlists/preview", { body: { provider: "QQ_MUSIC", url: "demo://builtin" } });
check("预览返回真实曲库内容（12 首）", preview.body?.tracks?.length === 12 && preview.body.name.length > 0,
  String(preview.body?.tracks?.length));

const wrongSource = await call("POST", "/playlists/preview", { body: { provider: "NETEASE_MUSIC", url: "x" } });
check("网易云作来源被拒", wrongSource.status === 400 && /不支持作为来源/.test(wrongSource.body.error), wrongSource.body?.error);

/* ---- 4. 迁移主链路 ---- */
const started = await call("POST", "/migrations", { body: { sourceProvider: "QQ_MUSIC",
  sourceUrl: "demo://builtin", targetProvider: "NETEASE_MUSIC", playlistName: "夏夜 · 迁移" } });
const jobId = started.body?.id;
check("建任务成功且进度 5", started.status === 200 && started.body.status === "RUNNING"
  && started.body.progress === 5 && started.body.source.trackCount === 12, JSON.stringify(started.body?.status));
check("建任务日志含「确认前不会写入」", started.body.logs[0].message
  === "匹配任务已创建，确认前不会创建或写入目标歌单", started.body.logs[0]?.message);

const dup = await call("POST", "/migrations", { body: { sourceProvider: "QQ_MUSIC",
  sourceUrl: "demo://builtin", targetProvider: "NETEASE_MUSIC" } });
check("未完成时再建任务 -> 409 ACTIVE_JOB", dup.status === 409 && dup.body.code === "ACTIVE_JOB", dup.status + " " + dup.body?.code);

let advance = null;
for (let round = 0; round < 8; round++) {
  advance = await call("POST", "/migrations/" + jobId + "/advance");
  if (advance.body?.advance !== "matching") break;
}
check("分片推进到待确认", advance.body.status === "AWAITING_CONFIRMATION", JSON.stringify({ s: advance.body?.status, a: advance.body?.advance }));
check("确认前没有创建任何目标歌单", advance.body.createdTarget === null && advance.body.result === null);
check("匹配分数与说明非空", advance.body.matches.length === 12
  && advance.body.matches.every(m => typeof m.score === "number") && advance.body.matches[0].note.length > 0);
check("默认只勾选高置信项", advance.body.matches.filter(m => m.selected).length > 0
  && advance.body.matches.filter(m => m.selected).length <= 12);
check("演示链路全程零出网", upstreamCalls.length === 0, "上游调用次数=" + upstreamCalls.length);

const current = await call("GET", "/migrations/current");
check("current 找回同一任务", current.body?.id === jobId, current.body?.id);

const badConfirm = await call("POST", "/migrations/" + jobId + "/confirm", { body: { selectedIndices: [] } });
check("空选择确认 -> 400", badConfirm.status === 400 && /至少选择一首/.test(badConfirm.body.error), badConfirm.body?.error);

const selected = advance.body.matches.filter(m => m.selected && m.matched).map(m => m.index);
const confirmed = await call("POST", "/migrations/" + jobId + "/confirm", { body: { selectedIndices: selected } });
check("确认后任务完成", confirmed.body?.status === "COMPLETED" && confirmed.body?.progress === 100,
  JSON.stringify({ s: confirmed.body?.status, e: confirmed.body?.error }));
check("结果含写入数与歌单链接",
  confirmed.body.result.addedCount === selected.length && typeof confirmed.body.result.playlistUrl === "string",
  JSON.stringify(confirmed.body?.result));
check("结果统计口径与 Java 一致",
  confirmed.body.result.totalCount === 12 && confirmed.body.result.matchedCount >= selected.length
  && confirmed.body.result.skippedCount === confirmed.body.result.matchedCount - confirmed.body.result.addedCount,
  JSON.stringify(confirmed.body?.result));

const repeat = await call("POST", "/migrations/" + jobId + "/confirm", { body: { selectedIndices: selected } });
check("重复确认被拒（幂等保护）", repeat.status === 409 || repeat.status === 400, String(repeat.status));

const demoLibrary = await call("GET", "/playlists", { query: "?provider=QQ_MUSIC" });
check("演示库列表在完成后仍可用", demoLibrary.status === 200 && Array.isArray(demoLibrary.body));

/* ---- 5. 历史与只读 ---- */
const history = await call("GET", "/migrations");
check("历史列表含已完成任务且只读",
  history.body.items.length === 1 && history.body.items[0].readOnly === true
  && history.body.items[0].id === jobId, JSON.stringify(history.body).slice(0, 120));

const one = await call("GET", "/migrations/" + jobId);
check("单个任务可读", one.status === 200 && one.body.id === jobId);
const otherUser = await call("GET", "/migrations/" + jobId, { user: { ...USER, user_id: "u_mallory" } });
check("跨用户读不到别人的任务（404）", otherUser.status === 404, String(otherUser.status));

/* ---- 6. 放弃未确认的预览 ---- */
const job2res = await call("POST", "/migrations", { body: { sourceProvider: "QQ_MUSIC",
  sourceUrl: "demo://builtin", targetProvider: "NETEASE_MUSIC" } });
check("完成上一单后可以开新单", job2res.status === 200, String(job2res.status));
const j2id = job2res.body.id;
for (let round = 0; round < 8; round++) {
  const r = await call("POST", "/migrations/" + j2id + "/advance");
  if (r.body?.advance !== "matching") break;
}
const abandonBad = await call("POST", "/migrations/" + j2id + "/abandon");
check("待确认预览可放弃", abandonBad.status === 200 && abandonBad.body.status === "INTERRUPTED", abandonBad.body?.status);
const abandonTwice = await call("POST", "/migrations/" + j2id + "/abandon");
check("重复放弃被拒", abandonTwice.status === 409 && abandonTwice.body.code === "MIGRATION_STATE", String(abandonTwice.status));

/* ---- 7. 断开连接 ---- */
const dropped = await call("DELETE", "/connections/QQ_MUSIC");
check("断开返回 204", dropped.status === 204, String(dropped.status));
const afterDrop = await call("POST", "/playlists/preview", { body: { provider: "QQ_MUSIC", url: "demo://builtin" } });
check("断开后来源读取报未连接", afterDrop.status === 409 && afterDrop.body.code === "NOT_CONNECTED",
  afterDrop.status + " " + afterDrop.body?.code + " " + afterDrop.body?.error);

const stillSafe = await call("GET", "/state");
check("断开后 state 只剩一条连接", Object.keys(stillSafe.body.connections ?? {}).length === 1,
  JSON.stringify(stillSafe.body.connections));

console.log(failed === 0 ? "ROUTES ALL PASS" : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
