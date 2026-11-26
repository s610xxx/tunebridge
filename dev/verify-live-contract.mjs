/**
 * 线上契约回归：用与 site/web/app.js 完全相同的 /api 路径、字段和调用顺序，
 * 在本地驱动真实 handler + 平台 Store 形状（内存实现）+ 脚本化上游。
 * 覆盖 M1（登录快照/演示/真实 QQ 目标/预览确认写入）、M2（备份/历史/筛选/分页/演示音乐库）、
 * M3（过期预览、TARGET_CHANGED、响应不漏凭据、200 条上限与全量备份口径）。
 */
import { createApp } from "../site/functions/app.ts";
import { memoryStore } from "../site/functions/store.ts";

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : " — " + detail}`);
  if (!ok) failed++;
};

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const USER = { user_id: "u_live", name: "", picture: "", site_id: "s1", host_id: "h1",
  session_expires_at: Math.floor(Date.now() / 1000) + 3600 };
const token = (user) => b64url({ ...user,
  session_expires_at: Math.floor(Date.now() / 1000) + 3600 });
const BASE = "https://site.example/functions/v1/app";

/* ---------------- 脚本化上游：QQ 公开歌单 / 搜索 / 建单 / 写歌 ---------------- */

const calls = [];
const addBodies = [];
const jsonReply = (value, status = 200) => new Response(
  typeof value === "string" ? value : JSON.stringify(value),
  { status, headers: { "content-type": "application/json" } });

const publicSongs = Array.from({ length: 201 }, (_, i) => ({
  songid: 800000 + i, songmid: "mid" + i, songname: "公开曲目 " + (i + 1),
  albumname: "公开专辑", interval: 180, songtype: 0, singer: [{ name: "公开歌手" }],
  albummid: "albummid" + i,
}));
const PUBLIC_PLAYLIST = {
  code: 0,
  cdlist: [{
    dissid: 7500000001, dissname: "公开测试歌单", desc: "匿名读取", logo: "https://img.example/a.jpg",
    nickname: "公开作者", songlist: publicSongs,
  }],
};
const QQ_SEARCH = {
  "music.search.SearchCgiService": {
    code: 0,
    data: { body: { song: { list: [
      { id: "7001", name: "晴天", singer: [{ name: "周杰伦" }], album: { name: "叶惠美" }, type: 0 },
      { id: "7002", name: "稻香", singer: [{ name: "周杰伦" }], album: { name: "魔杰座" }, type: 0 },
    ] } } },
  },
};
const QQ_VALIDATE = {
  code: 0,
  req_0: { code: 0, data: { retCode: 0, result: { retCode: 0, v_diss_list: [] } } },
};
const QQ_CREATE = {
  code: 0,
  req_0: { code: 0, data: { result: {
    dirId: "778899", tid: "tid-778899", dirName: "QQ 目标备份",
  } } },
};

const fetchImpl = async (input, init = {}) => {
  const url = String(input);
  const method = String(init.method ?? "GET").toUpperCase();
  const headers = init.headers ?? {};
  const body = init.body === undefined ? "" : String(init.body);
  calls.push({ url, method, headers, body });
  if (url.includes("fcg_ucc_getcdinfo_byids_cp.fcg")) {
    return jsonReply(url.includes("disstid=7500000001")
      ? PUBLIC_PLAYLIST
      : { code: -60004, cdlist: [] });
  }
  if (url.includes("smartbox")) return jsonReply("", 500);
  if (url.includes("musicu.fcg")) {
    if (body.includes("music.search.SearchCgiService")) return jsonReply(QQ_SEARCH);
    if (body.includes("AddPlaylist")) return jsonReply(QQ_CREATE);
    if (body.includes("AddSonglist")) {
      addBodies.push(body);
      return jsonReply({ code: 0, req_0: { code: 0, data: {} } });
    }
    if (body.includes("music.srfDissInfo.DissInfo")) return jsonReply(QQ_VALIDATE);
    return jsonReply({ code: 0, req_0: { code: 0, data: {} } });
  }
  throw new Error("意外的上游请求: " + method + " " + url);
};

const store = memoryStore();
const app = createApp({ store, fetchImpl });

async function api(target, method, path, { body, user = USER, csrf = true, query = "" } = {}) {
  const headers = {};
  if (user) headers["x-qoder-user-context"] = token(user);
  if (method !== "GET") {
    headers["x-csrf-token"] = csrf ? await target.csrfTokenFor(user ? user.user_id : "") : "deadbeef";
  }
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await target.handler(new Request(BASE + path + query, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: response.status, body: json, text };
}
const call = (method, path, options) => api(app, method, path, options);
const query = (values) => "?" + new URLSearchParams(values).toString();

async function toAwaiting(jobId, maxRounds = 40) {
  let last = null;
  for (let round = 0; round < maxRounds; round++) {
    last = await call("POST", "/api/migrations/" + jobId + "/advance");
    if (last.body?.advance !== "matching") break;
  }
  return last;
}

/* ---------------- 1. Qoder 登录快照 / 配置 / 公开读取 ---------------- */

const anonAuth = await call("GET", "/api/auth", { user: null });
check("未登录 /api/auth 返回 200 快照", anonAuth.status === 200
  && anonAuth.body.authenticated === false && anonAuth.body.csrfToken === null
  && anonAuth.body.csrfHeader === "x-csrf-token" && anonAuth.body.mode === "sites");

const auth = await call("GET", "/api/auth");
check("登录快照含用户名与 CSRF", auth.status === 200 && auth.body.authenticated === true
  && auth.body.username === "Qoder 用户"
  && auth.body.csrfToken === await app.csrfTokenFor(USER.user_id));

const config = await call("GET", "/api/config", { user: null });
check("公开配置与 Java config 口径一致", config.status === 200 && config.body.demoEnabled === true
  && config.body.maxTracks === 200 && config.body.neteaseRealReady === true
  && config.body.authMode === "sites", JSON.stringify(config.body));

const anonymousPreview = await call("POST", "/api/playlists/preview",
  { body: { provider: "QQ_MUSIC", url: "https://y.qq.com/n/ryqq/playlist/7500000001" } });
check("未连接也能匿名预览 QQ 公开歌单", anonymousPreview.status === 200
  && anonymousPreview.body.name === "公开测试歌单"
  && anonymousPreview.body.totalTracks === 201
  && anonymousPreview.body.trackCount === 201
  && anonymousPreview.body.tracks.length === 200
  && anonymousPreview.body.truncated === true,
JSON.stringify({ status: anonymousPreview.status, total: anonymousPreview.body?.totalTracks,
  listed: anonymousPreview.body?.tracks?.length, truncated: anonymousPreview.body?.truncated }));
const anonFetch = calls.find(item => item.url.includes("fcg_ucc_getcdinfo_byids_cp.fcg"));
check("匿名预览不带 Cookie 头", anonFetch && !anonFetch.headers.Cookie);

const anonymousBackup = await call("POST", "/api/playlists/backup",
  { body: { provider: "QQ_MUSIC", url: "https://y.qq.com/n/ryqq/playlist/7500000001" } });
check("备份读取不截断（201 首全量）", anonymousBackup.status === 200
  && anonymousBackup.body.tracks.length === 201 && anonymousBackup.body.truncated === false,
String(anonymousBackup.body?.tracks?.length));

/* ---------------- 2. 连接管理 ---------------- */

const missingMode = await call("POST", "/api/connections/QQ_MUSIC", { body: {} });
check("缺连接方式 -> 400", missingMode.status === 400
  && missingMode.body.error === "请选择连接方式", String(missingMode.status));
const badMode = await call("POST", "/api/connections/QQ_MUSIC", { body: { mode: "jvm" } });
check("未知连接方式 -> 400", badMode.status === 400 && /不支持的连接方式/.test(badMode.body.error));
const apple = await call("POST", "/api/connections/APPLE_MUSIC", { body: { mode: "demo" } });
check("Apple 在站点明确拒绝", apple.status === 400 && /Apple/.test(apple.body.error));

for (const provider of ["QQ_MUSIC", "NETEASE_MUSIC"]) {
  const connected = await call("POST", "/api/connections/" + provider, { body: { mode: "demo" } });
  check("演示连接 " + provider, connected.status === 200 && connected.body.mode === "DEMO"
    && typeof connected.body.accountName === "string");
}
const state = await call("GET", "/api/state");
check("state 只暴露 QQ/网易云且含 sampleUrl", state.status === 200
  && state.body.providers.length === 2
  && state.body.providers[0].id === "QQ_MUSIC" && state.body.providers[1].id === "NETEASE_MUSIC"
  && state.body.providers[0].sampleUrl === "https://y.qq.com/n/ryqq/playlist/7300098051"
  && state.body.providers[1].sampleUrl === "",
JSON.stringify(state.body.providers));
check("state 连接字段用 accountName", state.body.connections.QQ_MUSIC.accountName
  && state.body.connections.NETEASE_MUSIC.accountName
  && state.body.connections.QQ_MUSIC.connected === true,
JSON.stringify(state.body.connections));
check("state.config 与 /config 同源", state.body.config.maxTracks === 200 && state.body.config.authMode === "sites");

const emptyLibrary = await call("GET", "/api/demo/library", { query: "?provider=NETEASE_MUSIC" });
check("初始演示音乐库为空数组", emptyLibrary.status === 200
  && Array.isArray(emptyLibrary.body) && emptyLibrary.body.length === 0);

/* ---------------- 3. 目标连接更换 -> TARGET_CHANGED ---------------- */

const currentNone = await call("GET", "/api/migrations/current");
check("无任务时 current 返回 200 null", currentNone.status === 200 && currentNone.body === null,
JSON.stringify(currentNone.body));

const jobA = await call("POST", "/api/migrations", { body: {
  sourceProvider: "QQ_MUSIC", sourceUrl: "demo://builtin",
  targetProvider: "NETEASE_MUSIC", playlistName: "目标更换测试",
} });
check("建任务返回 Java 进度与日志", jobA.status === 200 && jobA.body.status === "RUNNING"
  && jobA.body.progress === 5 && jobA.body.source.trackCount === 12
  && jobA.body.logs[0].message === "匹配任务已创建，确认前不会创建或写入目标歌单"
  && jobA.body.logs[1].level === "SUCCESS",
JSON.stringify(jobA.body?.logs?.slice(0, 2)));
const aReady = await toAwaiting(jobA.body.id);
check("任务 A 进入待确认", aReady.body.status === "AWAITING_CONFIRMATION", aReady.body?.status);
const currentA = await call("GET", "/api/migrations/current");
check("current 找回待确认任务", currentA.body?.id === jobA.body.id);

await new Promise(resolve => setTimeout(resolve, 5));
const reconnected = await call("POST", "/api/connections/NETEASE_MUSIC", { body: { mode: "demo" } });
check("同平台重连成功", reconnected.status === 200);
const changed = await call("POST", "/api/migrations/" + jobA.body.id + "/confirm",
  { body: { selectedIndices: [0] } });
check("重连目标后确认 -> TARGET_CHANGED", changed.status === 409
  && changed.body.code === "TARGET_CHANGED", changed.status + " " + changed.body?.code);
const abandoned = await call("POST", "/api/migrations/" + jobA.body.id + "/abandon");
check("放弃被更换目标的预览", abandoned.status === 200 && abandoned.body.status === "INTERRUPTED");
const currentNoneAgain = await call("GET", "/api/migrations/current");
check("放弃后 current 回到 null", currentNoneAgain.status === 200 && currentNoneAgain.body === null);

/* ---------------- 4. 演示迁移完整闭环 + 演示音乐库 ---------------- */

const jobB = await call("POST", "/api/migrations", { body: {
  sourceProvider: "QQ_MUSIC", sourceUrl: "demo://builtin",
  targetProvider: "NETEASE_MUSIC", playlistName: "  演示闭环 · 音桥  ",
} });
const bReady = await toAwaiting(jobB.body.id);
const selectedB = bReady.body.matches.filter(row => row.matched && row.selected).map(row => row.index);
const bConfirm = await call("POST", "/api/migrations/" + jobB.body.id + "/confirm",
  { body: { selectedIndices: selectedB } });
check("演示迁移完成", bConfirm.status === 200 && bConfirm.body.status === "COMPLETED"
  && bConfirm.body.progress === 100 && bConfirm.body.result.addedCount === selectedB.length,
JSON.stringify({ status: bConfirm.body?.status, result: bConfirm.body?.result }));
check("任务 B 名字两端空白被清理", bConfirm.body.result.playlistName === "演示闭环 · 音桥",
bConfirm.body.result?.playlistName);

const targetLibrary = await call("GET", "/api/demo/library", { query: "?provider=NETEASE_MUSIC" });
check("目标演示库出现新歌单", targetLibrary.status === 200 && targetLibrary.body.length === 1
  && targetLibrary.body[0].name === "演示闭环 · 音桥"
  && targetLibrary.body[0].tracks.length === selectedB.length,
JSON.stringify(targetLibrary.body.map(item => ({ name: item.name, tracks: item.tracks?.length }))));

const sourceLibrary = await call("GET", "/api/demo/library", { query: "?provider=QQ_MUSIC" });
check("来源演示库不含目标歌单", sourceLibrary.status === 200 && sourceLibrary.body.length === 0);

/* ---------------- 5. 备份迁移 + 200 首上限口径 ---------------- */

const backupTracks = [
  { title: "晴天", artist: "周杰伦", album: "叶惠美", durationSec: 269 },
  { title: "稻香", artist: "周杰伦", album: "魔杰座", durationSec: 223 },
  { title: "", artist: "坏数据", durationSec: -5 },
  null,
  { title: "不存在曲目", artist: "无名", durationSec: "not-a-number" },
  ...Array.from({ length: 202 }, (_, i) => ({
    title: "离线收藏 " + (i + 1), artist: "本地歌手", album: "本地备份", durationSec: 200,
  })),
];
const jobC = await call("POST", "/api/backups/migrations", { body: {
  targetProvider: "NETEASE_MUSIC", playlistName: "本地 205 首",
  sourceName: "我的本地备份", tracks: backupTracks,
} });
check("备份任务跳过坏条目并保留 205 首", jobC.status === 200
  && jobC.body.source.provider === "LOCAL_BACKUP"
  && jobC.body.source.name === "我的本地备份"
  && jobC.body.source.trackCount === 205,
JSON.stringify(jobC.body?.source));
check("超 200 首时日志说明按上限迁移", jobC.body.logs.some(entry =>
  entry.level === "WARN" && /来源共 205 首.*前 200 首/.test(entry.message)),
JSON.stringify(jobC.body.logs.map(entry => entry.message).slice(-3)));
const cReady = await toAwaiting(jobC.body.id, 40);
check("备份任务推进到待确认且只匹配 200 首", cReady.body.status === "AWAITING_CONFIRMATION"
  && cReady.body.matches.length === 200, JSON.stringify({ status: cReady.body?.status,
  matches: cReady.body?.matches?.length }));
const selectedC = cReady.body.matches.filter(row => row.selected && row.matched).map(row => row.index);
check("205 首里只命中曲库中的两首", selectedC.length === 2, String(selectedC.length));
const cConfirm = await call("POST", "/api/migrations/" + jobC.body.id + "/confirm",
  { body: { selectedIndices: selectedC } });
check("备份任务完成且统计按 200 首口径", cConfirm.body.status === "COMPLETED"
  && cConfirm.body.result.addedCount === 2
  && cConfirm.body.result.totalCount === 200
  && cConfirm.body.source.trackCount === 205,
JSON.stringify({ result: cConfirm.body?.result, source: cConfirm.body?.source }));

/* ---------------- 6. QQ 真实目标：连接、搜索、建单、写歌 ---------------- */

const badCookie = await call("POST", "/api/connections/QQ_MUSIC", { body: { mode: "real", cookie: "x" } });
check("坏 Cookie 被拒且不发请求", badCookie.status === 400, String(badCookie.status));
const qqReal = await call("POST", "/api/connections/QQ_MUSIC", {
  body: { mode: "real", cookie: "uin=123456789; qm_keyst=abcdefghij" },
});
check("QQ 真实连接返回脱敏账号", qqReal.status === 200 && qqReal.body.mode === "REAL"
  && qqReal.body.accountName === "QQ 音乐 · 12****89", JSON.stringify(qqReal.body));
const storedQq = await store.loadConnection(USER.user_id, "QQ_MUSIC");
check("QQ 凭据加密落库且不泄露明文", storedQq?.credential?.blob
  && !storedQq.credential.blob.includes("qm_keyst")
  && !JSON.stringify(qqReal.body).includes("qm_keyst"));

const jobD = await call("POST", "/api/backups/migrations", { body: {
  targetProvider: "QQ_MUSIC", playlistName: "QQ 目标备份",
  sourceName: "两张单曲", tracks: [
    { title: "晴天", artist: "周杰伦", album: "叶惠美", durationSec: 269 },
    { title: "稻香", artist: "周杰伦", album: "魔杰座", durationSec: 223 },
  ],
} });
check("QQ 真实目标可建任务", jobD.status === 200 && jobD.body.target.provider === "QQ_MUSIC"
  && jobD.body.target.mode === "REAL",
JSON.stringify(jobD.body?.target));
const dReady = await toAwaiting(jobD.body.id);
check("QQ 真实目标匹配到两首", dReady.body.status === "AWAITING_CONFIRMATION"
  && dReady.body.matches.every(row => row.matched), JSON.stringify(dReady.body?.matches));
const dConfirm = await call("POST", "/api/migrations/" + jobD.body.id + "/confirm",
  { body: { selectedIndices: [0, 1] } });
check("QQ 真实目标建单并写歌完成", dConfirm.status === 200
  && dConfirm.body.status === "COMPLETED"
  && dConfirm.body.result.playlistUrl === "https://y.qq.com/n/ryqq/playlist/778899"
  && dConfirm.body.createdTarget.playlistId === "778899",
JSON.stringify({ status: dConfirm.status, code: dConfirm.body?.code,
  error: dConfirm.body?.error, result: dConfirm.body?.result }));
check("建单 tid 随任务持久化并用于写歌", dConfirm.body.createdTarget
  && addBodies.length === 1 && addBodies[0].includes('"tid":"tid-778899"')
  && addBodies[0].includes('"dirId":778899'),
JSON.stringify(addBodies));

const rePreview = await call("POST", "/api/playlists/preview",
  { body: { provider: "QQ_MUSIC", url: "https://y.qq.com/n/ryqq/playlist/7500000001" } });
const realPlayerFetch = calls.filter(item => item.url.includes("fcg_ucc_getcdinfo_byids_cp.fcg")).at(-1);
check("真实连接后预览带上 Cookie 且响应不泄露", rePreview.status === 200
  && realPlayerFetch.headers.Cookie === "uin=123456789; qm_keyst=abcdefghij"
  && !rePreview.text.includes("qm_keyst"));

const qqLibrary = await call("GET", "/api/demo/library", { query: "?provider=QQ_MUSIC" });
check("QQ 切到真实连接后演示库返回空", qqLibrary.status === 200
  && Array.isArray(qqLibrary.body) && qqLibrary.body.length === 0);

/* ---------------- 7. 历史分页 / 筛选 / 只读 ---------------- */

const history = await call("GET", "/api/migrations");
check("历史含 4 个任务且默认只读", history.status === 200 && history.body.items.length === 4
  && history.body.items.every(item => item.readOnly === true) && history.body.hasMore === false,
JSON.stringify(history.body?.items?.map(item => ({ id: item.id, status: item.status }))));
const page1 = await call("GET", "/api/migrations", { query: query({ offset: 0, limit: 2 }) });
const page2 = await call("GET", "/api/migrations", { query: query({ offset: 2, limit: 2 }) });
check("历史分页 hasMore 正确", page1.body.items.length === 2 && page1.body.hasMore === true
  && page2.body.items.length === 2 && page2.body.hasMore === false);

const backupHistory = await call("GET", "/api/migrations", { query: query({ source: "LOCAL_BACKUP" }) });
check("来源筛选 LOCAL_BACKUP", backupHistory.body.items.length === 2
  && backupHistory.body.items.every(item => item.source.provider === "LOCAL_BACKUP"));
const neteaseHistory = await call("GET", "/api/migrations", { query: query({ target: "NETEASE_MUSIC" }) });
check("目标筛选网易云", neteaseHistory.body.items.length === 3);
const qqTargetHistory = await call("GET", "/api/migrations", { query: query({ target: "QQ_MUSIC" }) });
check("目标筛选 QQ", qqTargetHistory.body.items.length === 1);
const completedHistory = await call("GET", "/api/migrations", { query: query({ status: "COMPLETED" }) });
const interruptedHistory = await call("GET", "/api/migrations", { query: query({ status: "INTERRUPTED" }) });
check("状态筛选", completedHistory.body.items.length === 3
  && interruptedHistory.body.items.length === 1, JSON.stringify({
  completed: completedHistory.body.items.length, interrupted: interruptedHistory.body.items.length }));
const qqSourceHistory = await call("GET", "/api/migrations", { query: query({ source: "QQ_MUSIC" }) });
check("来源筛选 QQ（不含备份）", qqSourceHistory.body.items.length === 2);

const today = new Date().toISOString().slice(0, 10);
const todayHistory = await call("GET", "/api/migrations", { query: query({ from: today, to: today }) });
check("按 UTC 当天筛选命中全部", todayHistory.body.items.length === 4, String(todayHistory.body.items.length));
const futureDay = new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString().slice(0, 10);
const futureHistory = await call("GET", "/api/migrations", { query: query({ from: futureDay }) });
check("未来日期筛选为空", futureHistory.body.items.length === 0);
const isoFrom = new Date(Date.now() - 3600 * 1000).toISOString();
const isoTo = new Date(Date.now() + 3600 * 1000).toISOString();
const isoHistory = await call("GET", "/api/migrations", { query: query({ from: isoFrom, to: isoTo }) });
check("ISO 带时区时间筛选可用", isoHistory.body.items.length === 4, String(isoHistory.body.items.length));

for (const [name, value] of [
  ["非法状态", "/api/migrations?status=DONE"],
  ["非法平台", "/api/migrations?source=SPOTIFY"],
  ["LOCAL_BACKUP 不能作目标", "/api/migrations?target=LOCAL_BACKUP"],
  ["非法日期", "/api/migrations?from=2026-13-40"],
  ["无时区 ISO", "/api/migrations?from=2026-11-27T10:00:00"],
  ["起止颠倒", "/api/migrations?from=" + futureDay + "&to=" + today],
]) {
  const rejected = await call("GET", value);
  check("历史筛选拒绝" + name, rejected.status === 400 && rejected.body.code === "INVALID_INPUT",
    rejected.status + " " + rejected.body?.code + " " + rejected.body?.error);
}

const detail = await call("GET", "/api/migrations/" + jobB.body.id);
check("历史详情可读且只读", detail.status === 200 && detail.body.readOnly === true
  && detail.body.id === jobB.body.id);
const otherUser = await call("GET", "/api/migrations/" + jobB.body.id,
  { user: { ...USER, user_id: "u_mallory" } });
check("跨用户任务 404", otherUser.status === 404, String(otherUser.status));
const currentEnd = await call("GET", "/api/migrations/current");
check("全部完成后 current 为 null", currentEnd.status === 200 && currentEnd.body === null);

/* ---------------- 8. 两小时预览过期（路由层） ---------------- */

let clock = Date.now();
const store2 = memoryStore();
const app2 = createApp({ store: store2, fetchImpl, now: () => clock });
const call2 = (method, path, options) => api(app2, method, path, options);
await call2("POST", "/api/connections/QQ_MUSIC", { body: { mode: "demo" } });
await call2("POST", "/api/connections/NETEASE_MUSIC", { body: { mode: "demo" } });
const expiring = await call2("POST", "/api/migrations", { body: {
  sourceProvider: "QQ_MUSIC", sourceUrl: "demo://builtin", targetProvider: "NETEASE_MUSIC",
} });
for (let round = 0; round < 8; round++) {
  const step = await call2("POST", "/api/migrations/" + expiring.body.id + "/advance");
  if (step.body?.advance !== "matching") break;
}
clock += 2 * 3600 * 1000 + 1;
const expiredCurrent = await call2("GET", "/api/migrations/current");
check("超两小时 current 返回 null", expiredCurrent.status === 200 && expiredCurrent.body === null);
const expiredDetail = await call2("GET", "/api/migrations/" + expiring.body.id);
check("超时预览转为 INTERRUPTED 且仍可审计", expiredDetail.status === 200
  && expiredDetail.body.status === "INTERRUPTED"
  && /过期/.test(expiredDetail.body.error), JSON.stringify({
  status: expiredDetail.body?.status, error: expiredDetail.body?.error }));
const freshJob = await call2("POST", "/api/migrations", { body: {
  sourceProvider: "QQ_MUSIC", sourceUrl: "demo://builtin", targetProvider: "NETEASE_MUSIC",
} });
check("过期任务不再占用 ACTIVE_JOB 名额", freshJob.status === 200, String(freshJob.status));

console.log(failed === 0 ? "LIVE CONTRACT ALL PASS" : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);