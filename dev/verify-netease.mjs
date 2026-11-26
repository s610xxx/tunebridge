import { createDecipheriv } from "node:crypto";
import { NeteaseClient } from "../site/functions/netease.ts";

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : " — " + detail}`);
  if (!ok) failed++;
};

/*
 * 测试预言用 Node 原生 aes-128-ecb，而不是拿被测代码自己的实现去验自己。
 * 注："用 WebCrypto 做 ECB 解密"这条路本身不成立 —— CBC 解密会校验 PKCS7，
 * 而 ECB 密文末块解出来必然是非法填充。生产代码只需要加密方向，
 * 那个方向已在 dev/verify-eapi.mjs 里与 Java 生产实现逐字节对拍通过。
 */
const KEY = new TextEncoder().encode("e82ckenh8dichen8");
const SEPARATOR = "36cd479b6b5";

function ecbDecryptHex(hex) {
  const decipher = createDecipheriv("aes-128-ecb", KEY, null);
  return Buffer.concat([decipher.update(Buffer.from(hex, "hex")), decipher.final()]).toString("utf8");
}

/** eapi 载荷 = apiPath - SEP - paramsJson - SEP - digest，切出来恰好三段。 */
function decodePayload(formBodyText) {
  return ecbDecryptHex(formBodyText.replace(/^params=/, "")).split("-" + SEPARATOR + "-");
}

/* ---- 脚本化的假上游：记录请求，回放响应 ---- */
const calls = [];
let script = [];

const fakeFetch = async (url, init) => {
  const sent = { url, headers: init.headers, body: init.body, signal: !!init.signal };
  calls.push(sent);
  const next = script.shift();
  if (!next) throw new Error("假上游没有更多响应（调用次数超出预期）");
  return {
    status: next.status ?? 200,
    ok: (next.status ?? 200) < 400,
    text: async () => next.body,
    headers: { getSetCookie: () => next.setCookies ?? [] },
  };
};

const client = new NeteaseClient("device-fixed-0001", fakeFetch);
const COOKIE = "MUSIC_U=tok; __csrf=csrf-abc";

/* ---- 1. 请求形状 ---- */
script = [{ body: '{"account":{"nickname":"予遥望兮"},"code":200}' }];
const name = await client.accountName(COOKIE);
check("账号名解析", name === "予遥望兮");
const first = calls[0];
check("走 /eapi 通道", first.url === "https://music.163.com/eapi/nuser/account/get", first.url);
check("带齐四个头",
  first.headers["content-type"] === "application/x-www-form-urlencoded"
  && first.headers.referer === "https://music.163.com/"
  && first.headers.origin === "https://music.163.com"
  && /Chrome\/124/.test(first.headers["user-agent"]));
check("Cookie 只在服务端出站上出现", first.headers.cookie === COOKIE);
check("请求体是 params=<hex>", /^params=[0-9A-F]+$/.test(first.body), first.body.slice(0, 40));

const [pPath, pJson, pDigest] = await decodePayload(first.body);
check("签名内用的是 /api 路径", pPath === "/api/nuser/account/get", pPath);
const values = JSON.parse(pJson);
check("csrf_token 取到 __csrf 的值", values.csrf_token === "csrf-abc", JSON.stringify(values));
check("客户端标识齐全",
  ["os", "appver", "versioncode", "mobilename", "buildver", "channelId", "deviceId"].every(k => k in values));
check("deviceId 用注入的稳定值", values.deviceId === "device-fixed-0001");
check("摘要为 32 位大写十六进制", /^[0-9A-F]{32}$/.test(pDigest), pDigest);
check("请求带超时控制", first.signal === true);

/* ---- 2. 搜索的五种响应形态 ---- */
const songsBody = (songs) => JSON.stringify({ code: 200, result: { songs } });

calls.length = 0;
script = [{ body: songsBody([{ id: 1404511131, name: "海阔天空", ar: [{ name: "G.E.M.邓紫棋" }],
  al: { name: "乐行者", picUrl: "p1.jpg" }, dt: 262000, privilege: { st: 0 } }]) }];
let outcome = await client.search(COOKIE, "海阔天空", "G.E.M.", 6);
check("形态①非空候选被采纳", outcome.kind === "candidates");
check("ar/al/dt 字段映射正确",
  outcome.tracks[0].artist === "G.E.M.邓紫棋" && outcome.tracks[0].album === "乐行者"
  && outcome.tracks[0].durationSec === 262 && outcome.tracks[0].artworkUrl === "p1.jpg"
  && outcome.tracks[0].providerTrackId === "1404511131", JSON.stringify(outcome.tracks[0]));
check("数字 id 转成字符串", typeof outcome.tracks[0].providerTrackId === "string");

script = [{ body: songsBody([{ id: "vip1", name: "泡沫", privilege: { st: 0 }, fee: 1 },
  { id: "off", name: "已下架", privilege: { st: -200 } }]) }];
outcome = await client.search(COOKIE, "泡沫", "G.E.M.", 6);
check("形态②会员曲保留、-200 剔除",
  outcome.tracks.map(t => t.providerTrackId).join(",") === "vip1",
  JSON.stringify(outcome.tracks.map(t => t.providerTrackId)));

script = [{ body: '{"header":{"code":"405","msg":"操作频繁，请稍候再试"}}' }];
outcome = await client.search(COOKIE, "倒数", "", 6);
check("形态③405 判为限流并给 retryAfterMs",
  outcome.kind === "throttled" && outcome.retryAfterMs > 0
  && /业务码 405：操作频繁/.test(outcome.detail), JSON.stringify(outcome));

script = [{ body: '{"code":200,"result":{"hasMore":false}}' }];
outcome = await client.search(COOKIE, "某首不存在的歌", "", 6);
check("形态④缺 songs 记为契约破坏而非未命中",
  outcome.kind === "rejected" && /响应格式无效/.test(outcome.message), JSON.stringify(outcome));

script = [{ body: songsBody([]) }];
outcome = await client.search(COOKIE, "某首不存在的歌", "", 6);
check("形态⑤200+空数组是真未命中且不重试", outcome.kind === "empty", JSON.stringify(outcome));

script = [{ body: '{"header":{"code":"403","msg":"illegal request!"}}' }];
outcome = await client.search(COOKIE, "情人", "", 6);
check("形态⑥非 200 业务码直接报出上游原因",
  outcome.kind === "rejected" && /业务码 403：illegal request!/.test(outcome.message), JSON.stringify(outcome));

/* ---- 3. 建单 ---- */
calls.length = 0;
script = [{ body: '{"code":200,"id":"18636602414","playlist":{"name":"I AM GLORIA · 音桥"}}' }];
const created = await client.createPlaylist(COOKIE, "I AM GLORIA · 音桥");
check("建单返回 id 与链接",
  created.id === "18636602414" && created.url.includes("playlist?id=18636602414"));
const createPayload = (await decodePayload(calls[0].body))[1];
check("建单请求带上了 name 与 privacy",
  createPayload.includes("\"name\":\"I AM GLORIA · 音桥\"") && createPayload.includes("\"privacy\":\"0\""));
check("建单也带 __csrf", createPayload.includes("csrf-abc"));

script = [{ body: '{"code":403,"header":{"code":"403","msg":"illegal request!"}}' }];
let hint = "";
try { await client.createPlaylist("MUSIC_U=tok", "无 csrf"); } catch (e) { hint = e.message; }
check("缺 __csrf 时点明原因", /缺少 __csrf/.test(hint), hint);

/* ---- 4. 分批写入 + 回读 ---- */
const tracks = (n) => Array.from({ length: n }, (_, i) => ({
  providerTrackId: String(1000 + i), title: "t" + i, artist: "", album: "", durationSec: 0, artworkUrl: "" }));

calls.length = 0;
const ids = tracks(45);
const writtenIds = ids.map(t => t.providerTrackId);
const present = JSON.stringify({ playlist: { trackIds: writtenIds.map(id => ({ id })) } });
script = [
  { body: '{"code":200}' },                          // 批 1（20 首）
  { body: '{"code":200}' },                          // 批 2（20 首）
  { body: '{"code":200}' },                          // 批 3（5 首）
  { body: present },                                 // 回读一次
];
let add = await client.addTracks(COOKIE, "18636602414", ids);
check("45 首按 20/20/5 分三批", calls.filter(c => c.url.includes("manipulate/tracks")).length === 3,
  String(calls.length));
check("回读只做一次", calls.filter(c => c.url.includes("playlist/detail")).length === 1);
check("全部写入并回读通过", add.kind === "written" && add.count === 45, JSON.stringify(add));

const batch2 = JSON.parse((await decodePayload(calls[1].body))[1]);
check("第二批是 20 首", JSON.parse(batch2.trackIds).length === 20, batch2.trackIds);
check("op=add 与 pid/d 都带上", batch2.op === "add" && batch2.pid === "18636602414" && batch2.d === "18636602414");

calls.length = 0;
script = [{ body: '{"code":200}' }, { body: '{"header":{"code":"405","msg":"操作频繁，请稍候再试"}}' }];
add = await client.addTracks(COOKIE, "pl1", tracks(45));
check("写入中途限流返回断点而非整单失败",
  add.kind === "throttled" && add.written === 20, JSON.stringify(add));

script = [{ body: '{"code":200}' }, { body: '{"playlist":{"trackIds":[{"id":"1000"}]}}' }];
let unver = "";
try { await client.addTracks(COOKIE, "pl1", tracks(3)); } catch (e) { unver = e.message; }
check("回读不齐时报「结果未确认」", /结果未确认/.test(unver), unver);

console.log(failed === 0 ? "NETEASE CHANNEL ALL PASS" : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
