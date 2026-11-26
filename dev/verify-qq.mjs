/**
 * QQ 音乐通道离线校验：不联网、不碰真实 Cookie。
 *
 * 期望值全部来自“用本机 JDK 直接跑生产 Java 代码”录下来的真值：
 *   QqCookie.parse / QqUrlParser.parsePlaylistId / QqMusicClient.parseCreatedDiss
 *   以及 QqMusicClient 六个方法在桩 ClientHttpRequestFactory 下的真实出线请求与响应映射。
 * 因此这里的断言不是在验“我觉得 Java 会怎么做”，而是在验“Java 实际做了什么”。
 * 运行：node dev/verify-qq.mjs   （退出码 0 = 全部通过）
 */

import {
  addTracks, cookieGTk, createPlaylist, fetchPlaylist, hash33, javaIsBlank, javaTrim, listMyPlaylists,
  maskedUin, parseCreatedDiss, parseJavaLong, parsePlaylistId, parseQqCookie, qqAddTracks, qqConnectDemo,
  qqConnectReal, qqCreatePlaylist, qqFetchPlaylist, qqListPlaylists, qqSampleUrl, qqSearchTracks, searchTracks,
  truncateCodePoints, validate,
} from "../site/functions/qq.ts";
import { ProviderApiError } from "../site/functions/errors.ts";
// 演示通道由 demo.ts 提供（它自己按 Java 真值校验过），这里只验 qq.ts 的注入点是否把 DEMO 分支接过去。
import {
  DEMO_BUILTIN_PLAYLISTS, DEMO_TARGET_CATALOGS, createDemoProvider, emptyDemoStoreState,
} from "../site/functions/demo.ts";

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : " — " + detail}`);
  if (!ok) failed++;
};

/* ---------------------------------------------------------------- 假上游 */

const calls = [];
let script = [];

const fakeFetch = async (url, init) => {
  calls.push({ url, method: init.method, headers: init.headers, body: init.body, signal: init.signal });
  const next = script.shift();
  if (!next) throw new Error("假上游没有更多响应（调用次数超出预期）");
  if (next.throw) throw next.throw;
  return {
    status: next.status ?? 200,
    ok: (next.status ?? 200) >= 200 && (next.status ?? 200) < 300,
    async text() { return next.body ?? ""; },
    headers: new Headers({ "content-type": next.contentType ?? "application/json" }),
  };
};

/** 真实出线都带 Cookie 头，校验脚本用一个固定 Cookie，值取自 Java 测试类。 */
const COOKIE_RAW = "uin=o0012345678; qm_keyst=qmkeyst_demo; other=value";
const COOKIE = parseQqCookie(COOKIE_RAW);
/** 记录 AbortSignal.timeout 收到的毫秒数，用来验默认超时对齐 Java 的 read 25s。 */
const timeoutArgs = [];
const realTimeout = AbortSignal.timeout.bind(AbortSignal);
AbortSignal.timeout = (ms) => { timeoutArgs.push(ms); return realTimeout(ms); };

const OPTS = { fetchImpl: fakeFetch };
const reset = () => { calls.length = 0; script = []; timeoutArgs.length = 0; };

async function expectError(fn) {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
}

/** 断言错误三要素：HTTP 状态、code、中文文案，全部与 Java 一字不差。 */
function checkError(name, error, status, code, message) {
  const e = error instanceof ProviderApiError ? error : null;
  // message 省略时只断言 status 与 code —— 之前写成恒比较 undefined，导致所有未传文案的用例必然失败。
  check(name, !!e && e.status === status && e.code === code
    && (message === undefined || e.message === message),
    e ? `got ${e.status} ${e.code} | ${e.message}` : `got ${String(error)}`);
}

/* ================================================================= 1. Cookie */

console.log("--- QqCookie.parse ---");
const cookieCases = [
  ["Cookie: uin=o0012345678; qm_keyst=qmkeyst_demo; other=value", "12345678", "qmkeyst_demo", "12****78", 924345111, "uin=o0012345678; qm_keyst=qmkeyst_demo; other=value"],
  ["qqmusic_uin=123456789; qqmusic_key=abc", "123456789", "abc", "12****89", 193485963, "qqmusic_uin=123456789; qqmusic_key=abc"],
  ["COOKIE: uin=123456789; qm_keyst=xyz", "123456789", "xyz", "12****89", 193511792, "uin=123456789; qm_keyst=xyz"],
  ["uin = 123456789 ; qm_keyst = xyz ", "123456789", "xyz", "12****89", 193511792, "uin = 123456789 ; qm_keyst = xyz"],
  ["uin=O0000123456; qm_keyst=abc", "123456", "abc", "12****56", 193485963, "uin=O0000123456; qm_keyst=abc"],
  ["wxuin=123456789; qqmusic_key=abc", "123456789", "abc", "12****89", 193485963, "wxuin=123456789; qqmusic_key=abc"],
  ["p_uin=12345678; music_key=abc", "12345678", "abc", "12****78", 193485963, "p_uin=12345678; music_key=abc"],
  ["uin=12345; qm_keyst=abcdefghijklmnopqrstuvwxyz", "12345", "abcdefghijklmnopqrstuvwxyz", "12****45", 1779545604, "uin=12345; qm_keyst=abcdefghijklmnopqrstuvwxyz"],
  ["uin=123456789; qm_keyst=; qqmusic_key=k", "123456789", "k", "12****89", 177680, "uin=123456789; qm_keyst=; qqmusic_key=k"],
  ["uin=123456789; qm_keyst=a=b=c", "123456789", "a=b=c", "12****89", 251487557, "uin=123456789; qm_keyst=a=b=c"],
  ["uin=123456789;uin=999888777;qm_keyst=abc", "999888777", "abc", "99****77", 193485963, "uin=123456789;uin=999888777;qm_keyst=abc"],
  ["=novalue; uin=123456789; qm_keyst=abc", "123456789", "abc", "12****89", 193485963, "=novalue; uin=123456789; qm_keyst=abc"],
  ["novalue; uin=123456789; qm_keyst=abc", "123456789", "abc", "12****89", 193485963, "novalue; uin=123456789; qm_keyst=abc"],
  ["uin=123456789; QM_KEYST=ABC", "123456789", "ABC", "12****89", 193450027, "uin=123456789; QM_KEYST=ABC"],
  ["uin=o0000000000012345678; qm_keyst=abc", "12345678", "abc", "12****78", 193485963, "uin=o0000000000012345678; qm_keyst=abc"],
  ["uin=000123; qm_keyst=abc", "123", "abc", "***", 193485963, "uin=000123; qm_keyst=abc"],
  ["cookie:uin=123456789;qm_keyst=abc", "123456789", "abc", "12****89", 193485963, "uin=123456789;qm_keyst=abc"],
  ["x=1;y=2;uin=123456789;qm_keyst=abc;domain=.y.qq.com", "123456789", "abc", "12****89", 193485963, "x=1;y=2;uin=123456789;qm_keyst=abc;domain=.y.qq.com"],
  ["uin=123456789; qm_keyst=abc%20def", "123456789", "abc%20def", "12****89", 623905345, "uin=123456789; qm_keyst=abc%20def"],
  ["uin=o123456789; p_uin=o999; qm_keyst=keyst; wxuin=777", "123456789", "keyst", "12****89", 264811093, "uin=o123456789; p_uin=o999; qm_keyst=keyst; wxuin=777"],
];
for (const [input, uin, key, mask, gTk, raw] of cookieCases) {
  let c;
  try { c = parseQqCookie(input); } catch (e) { c = { error: e }; }
  check(`cookie ${JSON.stringify(input.slice(0, 46))}`,
    !!c && c.uin === uin && c.musicKey === key && maskedUin(c) === mask && cookieGTk(c) === gTk && c.rawCookie === raw,
    c.error ? c.error.message : `uin=${c.uin} key=${c.musicKey} mask=${maskedUin(c)} gTk=${cookieGTk(c)} raw=${c.rawCookie}`);
}

const cookieErrors = [
  ["qm_keyst=abc", "Cookie 中缺少 uin，请确认复制的是 y.qq.com 登录后的 Cookie"],
  ["uin=123456789", "Cookie 中缺少音乐登录票据（qm_keyst / qqmusic_key），请重新登录 y.qq.com 后复制"],
  ["uin=123", "Cookie 格式不完整，请从 y.qq.com 复制完整的请求 Cookie"],
  ["   ", "请粘贴 QQ 音乐 Cookie"],
  ["uin=abc; qm_keyst=abcdefg", "Cookie 中的 uin 无法识别，请重新登录 y.qq.com 后复制"],
  ["uin=12; qm_keyst=abcdefg", "Cookie 中的 uin 无法识别，请重新登录 y.qq.com 后复制"],
  ["uin=o; qm_keyst=abcdefgh", "Cookie 中的 uin 无法识别，请重新登录 y.qq.com 后复制"],
  ["uin=123456789; qm_keyst=", "Cookie 中缺少音乐登录票据（qm_keyst / qqmusic_key），请重新登录 y.qq.com 后复制"],
];
for (const [input, message] of cookieErrors) {
  const error = await expectError(() => { parseQqCookie(input); });
  checkError(`cookie 报错 ${JSON.stringify(input)}`, error, 400, "INVALID_INPUT", message);
}
check("cookie null 报错", (await expectError(() => { parseQqCookie(null); }))?.message === "请粘贴 QQ 音乐 Cookie");

/* ================================================================== 2. hash33 */

console.log("--- hash33 / g_tk ---");
const hashCases = [
  ["qmkeyst_demo", 924345111], ["abc", 193485963], ["", 5381], ["A", 177638],
  ["0123456789abcdef", 1426588295], ["中文", 6546329],
  ["C_02TWp4cHFjMDRKNk5McUsyeTBHMnlTWG9HU2dMcHhsRXNvQ0RnT2JXNVNxeUZTWjhRM0dNM0VYM3RjeXlXdjRZeXVlcXNod0dNMjhsZ3RwR0ZHU3Fzb0dSZWdsS3dWdWxNM2NlbVhjeHoxdWQyZ09nOEtLUUR0YkRjM29uRnFNRG9nTnE1aXlWc09uZG1uYU93S2JmWUQ5QmVhU3VHUlRrYjVWZjR0eUFHUkVGeTBIaVdyeTBHR1pHU0dGeThHR1ZHU0dGeTBIaVdyeTBHR1pH", 1693359779],
];
for (const [key, expected] of hashCases) {
  check(`hash33 ${JSON.stringify(key.slice(0, 24))}`, hash33(key) === expected, `got ${hash33(key)} want ${expected}`);
}
/** Java 用 charAt（码元）而非码点：代理对必须算两个，这里专门盯住。 */
check("hash33 对代理对按码元计（与 Java charAt 一致）", hash33("😀") === hash33(String.fromCharCode(0xd83d, 0xde00)));

console.log("--- Java 字符串工具 ---");
check("javaTrim 不吃 NBSP", javaTrim("\u00a0abc\u00a0") === "\u00a0abc\u00a0");
check("javaTrim 吃制表/换行", javaTrim(" \t\r\nabc ") === "abc");
check("javaIsBlank 认为 NBSP 非空白", javaIsBlank("\u00a0") === false && javaIsBlank(" \t\n\u000b\u000c") === true);
check("truncate 按码点截断", truncateCodePoints("😀😀😀", 2) === "😀😀"
  && truncateCodePoints("  中文名称测试  ", 4) === "中文名称"
  && truncateCodePoints("café", 3) === "caf"
  && truncateCodePoints("1234567890123456789012", 20) === "12345678901234567890"
  && truncateCodePoints(null, 20) === "" && truncateCodePoints("ab", 20) === "ab");
for (const [input, expected] of [["7300098051", 7300098051n], ["003PU20T3E1eBI", null], ["", null], [" 12 ", null],
  ["+12", 12n], ["-12", -12n], ["9223372036854775808", null], ["9223372036854775807", 9223372036854775807n],
  ["12.0", null], ["1e3", null]]) {
  const got = parseJavaLong(input);
  check(`parseJavaLong ${JSON.stringify(input)}`, (expected === null ? got === null : got === expected), `got ${got}`);
}

/* ================================================================== 3. 链接 */

console.log("--- QqUrlParser ---");
const urlOk = [
  ["7300098051", "7300098051"], ["12345", "12345"], ["  7300098051  ", "7300098051"],
  ["https://y.qq.com/n/ryqq/playlist/7300098051?ADTAG=share", "7300098051"],
  ["https://y.qq.com/n/ryqq/playlist/7300098051#comment", "7300098051"],
  ["https://i.y.qq.com/n2/m/share/details/taoge.html?id=7300098051&hosteuin=abc", "7300098051"],
  ["https://y.qq.com/#disstid=7300098051", "7300098051"],
  ["https://y.qq.com/?dissid=7300098051", "7300098051"],
  ["https://Y.QQ.COM/n/ryqq/playlist/7300098051", "7300098051"],
  ["http://y.qq.com/n/ryqq/playlist/7300098051", "7300098051"],
  ["https://qq.com/n/ryqq/playlist/7300098051", "7300098051"],
  ["https://user:pass@y.qq.com/n/ryqq/playlist/7300098051", "7300098051"],
  ["https://y.qq.com:443/n/ryqq/playlist/7300098051", "7300098051"],
  ["https://y.qq.com/n/ryqq/playlist/7300098051?x=y#z", "7300098051"],
  ["https://y.qq.com/playlist/12345?id=999999", "12345"],
  ["https://y.qq.com/?id=11111&disstid=222222", "11111"],
  ["https://y.qq.com/#id=11111&disstid=222222", "11111"],
  ["https://y.qq.com/n/ryqq/playlist/7300098051%20", "7300098051"],
  ["https://y.qq.com/音乐?id=123456", "123456"],
  ["https://y.qq.com/x?id=123456789012345678901234", "12345678901234567890"],
  ["https://y.qq.com/playlist/7300098051/extra", "7300098051"],
  ["https://y.qq.com/n/ryqq/playlist/0000000000", "0000000000"],
  ["https://y.qq.com/n/ryqq/playlist/7300098051?ADTAG=myqq&from=myqq&channelId=PLIST.PLAY", "7300098051"],
  ["https://y.qq.com/n/ryqq_v2/playlist/7300098051", "7300098051"],
  ["https://y.qq.com/topic2017/turnto/water/index.html?disstid=7300098051", "7300098051"],
  ["https://y.qq.com/n/ryqq/playlist/7300098051?id=x&id=999999", "7300098051"],
  // java.net.URI 细节补测
  ["https://y.qq.com/a\u0000b?id=123456", null], // 占位，下面单独断言报错
  ["https://y.qq.com/%20x?id=123456", "123456"],
  ["https://y.qq.com/x%2Fplaylist%2F12345", "12345"],
  ["https://y.qq.com/n/ryqq/playlist/7300098051%2F", "7300098051"],
  ["https://y.qq.com/n%2Fryqq%2Fplaylist%2F7300098051", "7300098051"],
  ["https://y.qq.com:/playlist/123456", "123456"],
  ["https://user@a.b.c.qq.com/playlist/123456", "123456"],
  ["https://y.qq.com/n/ryqq/playlist/12345/../playlist/999999", "12345"],
  ["https://y.qq.com/x?id=0000012345", "0000012345"],
  ["https://y.qq.com/x?id=&disstid=123456", "123456"],
  ["https://y.qq.com/x?id=12345&y=1", "12345"],
  ["https://y.qq.com/?#id=123456", "123456"],
  ["https://y.qq.com/n/ryqq/playlist/123456#x", "123456"],
  ["  https://y.qq.com/playlist/123456  ", "123456"],
  ["https://y.qq.com/x?id=12345678901234567890123456789012345", "12345678901234567890"],
  ["https://y.qq.com/playlist/1234567890123456789012345", "12345678901234567890"],
  ["https://y.qq.com/x?disstid=123456&id=777777", "123456"],
  ["https://qzone.qq.com/cgi-bin/myqq_getfriend?id=123456", "123456"],
  ["https://y.qq.com/n/ryqq/playlist/00001", "00001"],
  ["https://y.qq.com/playlist/123456;x=1", "123456"],
  ["https://y.qq.com/a#?id=123456", "123456"],
  ["https://y.qq.com/a?b#?id=123456", "123456"],
  ["https://y.qq.com/playlist/123456?", "123456"],
  ["https://y.qq.com/playlist/123456#", "123456"],
  ["https://y.qq.com//playlist/123456", "123456"],
  ["https://y.qq.com/playlist//123456", null], // 单独断言：连续斜杠不吃
  ["https://y.qq.com/playlist/1234a56", null],
  ["https://y.qq.com/playlist/12345a", null],
  ["https://y.qq.com/plAylisT/123456", null],
];
for (const [input, expected] of urlOk) {
  if (expected === null) continue;
  let got;
  try { got = parsePlaylistId(input); } catch (e) { got = `ERR ${e.message}`; }
  check(`url ${JSON.stringify(input.slice(0, 60))}`, got === expected, `got ${got}`);
}
const urlErr = [
  ["1234", "无法识别歌单链接，请粘贴完整的 QQ 音乐歌单分享链接"],
  ["730009805123456789012", "无法识别歌单链接，请粘贴完整的 QQ 音乐歌单分享链接"],
  ["https://example.com/playlist/7300098051", "这不是 QQ 音乐链接，请确认来源平台"],
  ["https://y.qq.com/n/ryqq/album/12345", "链接中没有找到歌单 ID，请使用歌单页的分享链接"],
  [" ", "请粘贴 QQ 音乐歌单链接"],
  ["not-a-link", "无法识别歌单链接，请粘贴完整的 QQ 音乐歌单分享链接"],
  ["https://y.qq.com.nope.example/playlist/123456", "这不是 QQ 音乐链接，请确认来源平台"],
  ["https://y.qq.com/a b", "歌单链接格式不正确"],
  ["https://y.qq.com/{a}?id=123456", "歌单链接格式不正确"],
  ["https://y.qq.com/|a?id=123456", "歌单链接格式不正确"],
  ["https://y.qq.com/^a?id=123456", "歌单链接格式不正确"],
  ["https://y.qq.com/`a?id=123456", "歌单链接格式不正确"],
  ["https://y.qq.com/\\a?id=123456", "歌单链接格式不正确"],
  ["https://y.qq.com/\"a?id=123456", "歌单链接格式不正确"],
  ["https://y.qq.com/<a>?id=123456", "歌单链接格式不正确"],
  ["https://y.qq.com/%zz?id=123456", "歌单链接格式不正确"],
  ["https://y.qq.com/音乐\u00a0id?id=123456", "歌单链接格式不正确"],
  ["https://音乐.qq.com/playlist/123456", "这不是 QQ 音乐链接，请确认来源平台"],
  ["https://y.qq.com:abc/playlist/123456", "这不是 QQ 音乐链接，请确认来源平台"],
  ["https://y.qq.com?/playlist/123456", "链接中没有找到歌单 ID，请使用歌单页的分享链接"],
  ["https://[::1]/playlist/123456", "这不是 QQ 音乐链接，请确认来源平台"],
  ["https://x_qq.com/playlist/123456", "这不是 QQ 音乐链接，请确认来源平台"],
  ["https://y_qq.com/playlist/123456", "这不是 QQ 音乐链接，请确认来源平台"],
  ["https://y%2eqq.com/playlist/123456", "这不是 QQ 音乐链接，请确认来源平台"],
  ["https://qq.com.evil/playlist/123456", "这不是 QQ 音乐链接，请确认来源平台"],
  ["https:///playlist/123456", "这不是 QQ 音乐链接，请确认来源平台"],
  ["https:///playlist/123456".replace("///", "//x/"), "这不是 QQ 音乐链接，请确认来源平台"],
  ["https:/playlist/123456", "无法识别歌单链接，请粘贴完整的 QQ 音乐歌单分享链接"],
  ["https://y.qq.com", "链接中没有找到歌单 ID，请使用歌单页的分享链接"],
  ["https:playlist/123456", "无法识别歌单链接，请粘贴完整的 QQ 音乐歌单分享链接"],
  ["https://y.qq.com/PLAYLIST/123456", "链接中没有找到歌单 ID，请使用歌单页的分享链接"],
  ["https://y.qq.com/x?mid=123456", "链接中没有找到歌单 ID，请使用歌单页的分享链接"],
  ["https://y.qq.com/x?a=id=123456", "链接中没有找到歌单 ID，请使用歌单页的分享链接"],
  ["https://y.qq.com/#/playlist/123456", "链接中没有找到歌单 ID，请使用歌单页的分享链接"],
  ["HTTPS://y.qq.com/playlist/123456", "无法识别歌单链接，请粘贴完整的 QQ 音乐歌单分享链接"],
  ["https://y.qq.com/x?id=١٢٣٤٥٦", "链接中没有找到歌单 ID，请使用歌单页的分享链接"],
  ["https://y.qq.com/playlist/+123456", "链接中没有找到歌单 ID，请使用歌单页的分享链接"],
  ["https://y.qq.com/x?id=1_2345", "链接中没有找到歌单 ID，请使用歌单页的分享链接"],
  ["https://connect.qq.com/widget/shareqq/index.html?url=https%3A%2F%2Fy.qq.com%2Fn%2Fryqq%2Fplaylist%2F7300098051",
    "链接中没有找到歌单 ID，请使用歌单页的分享链接"],
  ["https://y.qq.com;?id=123456", "这不是 QQ 音乐链接，请确认来源平台"],
  ["https://y.qq.com@evil/playlist/123456", "这不是 QQ 音乐链接，请确认来源平台"],
  ["https://y.qq.com?x@evil/playlist/123456", "链接中没有找到歌单 ID，请使用歌单页的分享链接"],
  ["https://y.qq.com/playlist/1234a56", "链接中没有找到歌单 ID，请使用歌单页的分享链接"],
  ["https://y.qq.com/playlist//123456", "链接中没有找到歌单 ID，请使用歌单页的分享链接"],
];
for (const [input, message] of urlErr) {
  const error = await expectError(async () => parsePlaylistId(input));
  checkError(`url 报错 ${JSON.stringify(input.slice(0, 52))}`, error, 400, "INVALID_INPUT", message);
}
const nullUrl = await expectError(async () => parsePlaylistId(null));
checkError("url null 报错", nullUrl, 400, "INVALID_INPUT", "请粘贴 QQ 音乐歌单链接");

/* ==================================================== 4. vec_diss -> PlaylistRef */

console.log("--- parseCreatedDiss ---");
const dirs = JSON.parse(`[
  {"disstid": 7300098051, "title": "深夜写代码", "song_count": 12, "covermidts": [{"cover_mid": "004FfF1V1KQh6s"}]},
  {"disstid": "8123", "song_count": 0},
  {"disstid": 555, "title": "", "song_count": "7", "covermidts": []},
  {"disstid": 666, "title": null, "covermidts": {"cover_mid": "obj"}},
  {"title": "no id dirty row", "song_count": 5},
  {"disstid": null, "title": "null id"},
  {"disstid": 0, "title": "zero id"},
  {"disstid": 777, "song_count": null},
  {"disstid": 888, "song_count": 1.9},
  {"disstid": 999, "song_count": "abc", "title": "  带空格  "},
  {"disstid": 1000, "title": "1000", "covermidts": [{"other": 1}]},
  {"disstid": 1001, "title": "1001", "covermidts": [{"cover_mid": ""}]},
  ["nested array row"],
  "string row"
]`);
/** Java 录得的 REF 行：id / name / url / coverUrl / trackCount */
const refRows = [
  ["7300098051", "深夜写代码", "https://y.qq.com/n/ryqq/playlist/7300098051", "https://y.gtimg.cn/music/photo_new/T002R300x300M000004FfF1V1KQh6s.jpg", 12],
  ["8123", "QQ 歌单 8123", "https://y.qq.com/n/ryqq/playlist/8123", "", 0],
  ["555", "QQ 歌单 555", "https://y.qq.com/n/ryqq/playlist/555", "", 7],
  ["666", "QQ 歌单 666", "https://y.qq.com/n/ryqq/playlist/666", "", 0],
  ["0", "zero id", "https://y.qq.com/n/ryqq/playlist/0", "", 0],
  ["777", "QQ 歌单 777", "https://y.qq.com/n/ryqq/playlist/777", "", 0],
  ["888", "QQ 歌单 888", "https://y.qq.com/n/ryqq/playlist/888", "", 1],
  ["999", "  带空格  ", "https://y.qq.com/n/ryqq/playlist/999", "", 0],
  ["1000", "1000", "https://y.qq.com/n/ryqq/playlist/1000", "", 0],
  ["1001", "1001", "https://y.qq.com/n/ryqq/playlist/1001", "", 0],
];
const refs50 = parseCreatedDiss(dirs, 50);
check(`vec_diss 行数 ${refRows.length}`, refs50.length === refRows.length, `got ${refs50.length}`);
refRows.forEach(([id, name, url, cover, count], i) => {
  const r = refs50[i];
  check(`vec_diss 第 ${i} 行 ${id}`, !!r && r.id === id && r.name === name && r.url === url && r.coverUrl === cover && r.trackCount === count,
    r ? JSON.stringify(r) : "missing");
});
/** 字段顺序也是契约（PlaylistRef record 的顺序），前端/落盘按它序列化。 */
check("PlaylistRef 字段顺序", JSON.stringify(refs50[1]) === '{"id":"8123","name":"QQ 歌单 8123","url":"https://y.qq.com/n/ryqq/playlist/8123","coverUrl":"","trackCount":0}',
  JSON.stringify(refs50[1]));
check("limit=2 只留前两行", parseCreatedDiss(dirs, 2).length === 2);
check("limit=0 直接空", parseCreatedDiss(dirs, 0).length === 0);
check("limit 负数直接空", parseCreatedDiss(dirs, -3).length === 0);
check("非数组 vec_diss 给空", parseCreatedDiss(JSON.parse(`{"vec_diss":1}`).vec_diss, 10).length === 0
  && parseCreatedDiss([], 10).length === 0 && parseCreatedDiss(null, 10).length === 0);

/* ================================================================ 5. 歌单读取 */

console.log("--- fetchPlaylist 响应映射 ---");
const playlistJson = `{"code":0,"subcode":0,"notice":"","prompt":"","cdlist":[
  {"dissid":7300098051,"dissname":"深夜写代码","desc":"一个人加班的歌","logo":"https://imgta1.sou5.com/a.jpg",
   "nickname":"阿桥","creation_username":"builder","song_total_count":4,
   "songlist":[
     {"songid":600001,"songmid":"003PU20T3E1eBI","songname":"稻香","albumname":"魔杰座","interval":223,
      "songtype":0,"type":0,"albummid":"004FfF1V1KQh6s","singer":[{"name":"周杰伦","mid":"x"},{"singermid":"y","name":" "}],"other":1},
     {"songid":600002,"songname":"夜曲","albumname":"十一月的萧邦","interval":227.7,"type":0,
      "albummid":"002mreet1rCZFE","singer":[{"name":"周杰伦"},{"name":"费玉清"}]},
     {"songmid":"00999midonly","name":"仅有 mid 的歌","singer":[{"name":"某人"}],"interval":10},
     {"songname":"没有 ID","interval":10},
     {"songid":600005,"songname":"空歌手","singer":[],"interval":0},
     {"songid":600006,"songname":"songtype 为 null","songtype":null,"type":2,"interval":12},
     {"songid":600007,"songname":"type only","type":5,"interval":13}
   ]}
]}`;
/** Java 侧 OM.writeValueAsString(Playlist) 的原样输出，字段顺序 = record 顺序。 */
const PLAYLIST_HAPPY = '{"id":"7300098051","name":"深夜写代码","description":"一个人加班的歌","coverUrl":"https://imgta1.sou5.com/a.jpg","owner":"阿桥","webUrl":"https://y.qq.com/n/ryqq/playlist/7300098051","tracks":[{"providerTrackId":"600001","title":"稻香","artist":"周杰伦","album":"魔杰座","durationSec":223,"artworkUrl":"https://y.gtimg.cn/music/photo_new/T002R300x300M000004FfF1V1KQh6s.jpg","songType":0},{"providerTrackId":"600002","title":"夜曲","artist":"周杰伦 / 费玉清","album":"十一月的萧邦","durationSec":227,"artworkUrl":"https://y.gtimg.cn/music/photo_new/T002R300x300M000002mreet1rCZFE.jpg","songType":0},{"providerTrackId":"00999midonly","title":"仅有 mid 的歌","artist":"某人","album":"","durationSec":10,"artworkUrl":"","songType":0},{"providerTrackId":"600005","title":"空歌手","artist":"","album":"","durationSec":0,"artworkUrl":"","songType":0},{"providerTrackId":"600006","title":"songtype 为 null","artist":"","album":"","durationSec":12,"artworkUrl":"","songType":0},{"providerTrackId":"600007","title":"type only","artist":"","album":"","durationSec":13,"artworkUrl":"","songType":5}]}';
reset();
script = [{ body: playlistJson }];
let got = await fetchPlaylist("7300098051", COOKIE, OPTS);
check("fetchPlaylist 映射与 Java 逐字节一致", JSON.stringify(got) === PLAYLIST_HAPPY,
  JSON.stringify(got).slice(0, 200));
check("无 ID 歌曲被丢弃", got.tracks.every((t) => t.providerTrackId !== "" ) && got.tracks.length === 6);
check("songtype 显式 null 不回退到 type（has() 语义）", got.tracks.find((t) => t.title === "songtype 为 null").songType === 0);
check("只有 type 时取 type", got.tracks.find((t) => t.title === "type only").songType === 5);
check("interval 小数向零取整", got.tracks.find((t) => t.title === "夜曲").durationSec === 227);
check("singer 数组拼 ' / '", got.tracks.find((t) => t.title === "夜曲").artist === "周杰伦 / 费玉清");
check("singer 里空名跳过", got.tracks.find((t) => t.title === "稻香").artist === "周杰伦");

const PLAYLIST_CREATOR = '{"id":"12345","name":"QQ 音乐歌单","description":"","coverUrl":"","owner":"创建者","webUrl":"https://y.qq.com/n/ryqq/playlist/12345","tracks":[{"providerTrackId":"1","title":"a","artist":"A","album":"","durationSec":1,"artworkUrl":"","songType":0}]}';
reset();
script = [{ body: `{"code":0,"cdlist":[{"dissname":"","desc":null,"logo":null,"creator":{"nickname":"创建者"},
  "songlist":[{"songid":1,"songname":"a","singer":[{"name":"A"}],"interval":1}]}]}` }];
got = await fetchPlaylist("12345", COOKIE, OPTS);
check("creator.nickname 回退 + 空 dissname 用默认名", JSON.stringify(got) === PLAYLIST_CREATOR, JSON.stringify(got));

reset();
script = [{ body: playlistJson }];
await fetchPlaylist("7300098051", COOKIE, OPTS);
check("歌单 URL 与 Java 完全一致", calls[0].url === "https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?type=1&json=1&utf8=1&onlysong=0&disstid=7300098051&format=json&platform=yqq.json&needNewCode=0", calls[0].url);
check("歌单请求是 GET", calls[0].method === "GET");
check("歌单请求头三件（Referer/UA/Cookie）", calls[0].headers.Referer === "https://y.qq.com/"
  && calls[0].headers["User-Agent"] === "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36"
  && calls[0].headers.Cookie === COOKIE_RAW, JSON.stringify(calls[0].headers));
check("歌单请求不带 Content-Type", !("Content-Type" in calls[0].headers));
check("默认超时对齐 Java read 25s", timeoutArgs[0] === 25000, `got ${timeoutArgs[0]}`);

const playlistFail = [
  [`{"code":-60004,"cdlist":[]}`, 502, "UPSTREAM_ERROR", "QQ 音乐返回错误（-60004）"],
  ["{\"code\":0,\"cdlist\":[]}", 404, "NOT_FOUND", "歌单不存在或不可访问，请确认歌单是公开状态"],
  ["{\"code\":0}", 404, "NOT_FOUND", "歌单不存在或不可访问，请确认歌单是公开状态"],
  ["{\"code\":0,\"cdlist\":{\"a\":1}}", 404, "NOT_FOUND", "歌单不存在或不可访问，请确认歌单是公开状态"],
];
for (const [body, status, code, message] of playlistFail) {
  reset();
  script = [{ body }];
  const error = await expectError(() => fetchPlaylist("7300098051", COOKIE, OPTS));
  checkError(`歌单响应 ${body.slice(0, 26)}`, error, status, code, message);
}
for (const [status, expected] of [[401, [401, "UNAUTHORIZED", "QQ 音乐拒绝了请求（HTTP 401），请重新连接账号"]],
  [404, [404, "NOT_FOUND", "QQ 音乐歌单不存在或不可访问"]],
  [429, [429, "RATE_LIMITED", "QQ 音乐请求过于频繁，请稍后再试"]],
  [500, [502, "UPSTREAM_ERROR", "QQ 音乐暂时不可用（HTTP 500），请稍后重试"]],
  [403, [401, "UNAUTHORIZED", "QQ 音乐拒绝了请求（HTTP 403），请重新连接账号"]],
  [409, [502, "UPSTREAM_ERROR", "QQ 音乐暂时不可用（HTTP 409），请稍后重试"]]]) {
  reset();
  script = [{ status, body: "boom" }];
  const error = await expectError(() => fetchPlaylist("7300098051", COOKIE, OPTS));
  checkError(`歌单 HTTP ${status}`, error, expected[0], expected[1], expected[2]);
}
reset();
script = [{ body: "" }];
let error = await expectError(() => fetchPlaylist("7300098051", COOKIE, OPTS));
check("空响应体：Java 是 NPE->500，这里同 500 INTERNAL_ERROR",
  error?.status === 500 && error?.code === "INTERNAL_ERROR" && error?.message === "服务暂时不可用，请稍后重试",
  `${error?.status} ${error?.code} ${error?.message}`);
reset();
script = [{ body: "<html>login</html>", contentType: "text/html;charset=utf-8" }];
error = await expectError(() => fetchPlaylist("7300098051", COOKIE, OPTS));
check("HTML 响应体：Java RestClientException->500，这里同码同文案",
  error?.status === 500 && error?.code === "INTERNAL_ERROR", `${error?.status} ${error?.code} ${error?.message}`);
reset();
script = [{ body: "{not json" }];
error = await expectError(() => fetchPlaylist("7300098051", COOKIE, OPTS));
check("坏 JSON：同上 500 INTERNAL_ERROR", error?.status === 500 && error?.code === "INTERNAL_ERROR");
reset();
script = [{ throw: new Error("socket hang up") }];
error = await expectError(() => fetchPlaylist("7300098051", COOKIE, OPTS));
checkError("网络异常 -> Java ResourceAccessException 口径", error, 502, "UPSTREAM_ERROR", "QQ 音乐响应超时，请稍后重试");
reset();
script = [{ hang: true }];
error = await expectError(() => fetchPlaylist("7300098051", COOKIE, { fetchImpl: hangingFetch, timeoutMs: 20 }));
checkError("真超时 -> 502 超时文案", error, 502, "UPSTREAM_ERROR", "QQ 音乐响应超时，请稍后重试");

/* ========================================================= 6. 我的歌单列表 */

console.log("--- listMyPlaylists ---");
const createdJson = `{"code":0,"data":{"vec_diss":[
  {"disstid":7300098051,"title":"深夜写代码","song_count":12,"covermidts":[{"cover_mid":"004FfF1V1KQh6s"}]},
  {"disstid":"8123","song_count":0},
  {"title":"no id dirty row"}
]}}`;
const CREATED_OK = '[{"id":"7300098051","name":"深夜写代码","url":"https://y.qq.com/n/ryqq/playlist/7300098051","coverUrl":"https://y.gtimg.cn/music/photo_new/T002R300x300M000004FfF1V1KQh6s.jpg","trackCount":12},{"id":"8123","name":"QQ 歌单 8123","url":"https://y.qq.com/n/ryqq/playlist/8123","coverUrl":"","trackCount":0}]';
reset(); script = [{ body: createdJson }];
got = await listMyPlaylists(COOKIE, 50, OPTS);
check("我的歌单映射一致", JSON.stringify(got) === CREATED_OK, JSON.stringify(got));
check("列表 URL（uin 归一化 + e=49）", calls[0].url === "https://c.y.qq.com/rsc/fcg-bin/fcg_user_created_diss?loginUin=12345678&hostUin=0&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0&pic=1&sin=0&e=49", calls[0].url);
reset(); script = [{ body: createdJson }];
await listMyPlaylists(COOKIE, 500, OPTS);
check("limit 500 夹到 100 -> e=99", calls[0].url.endsWith("&e=99"), calls[0].url.slice(-8));
reset(); script = [{ body: createdJson }];
got = await listMyPlaylists(COOKIE, 0, OPTS);
check("limit 0 夹到 1 -> e=0 且只回 1 条", calls[0].url.endsWith("&e=0") && got.length === 1, calls[0].url.slice(-5));
reset(); script = [{ body: createdJson }];
await listMyPlaylists(COOKIE, -5, OPTS);
check("limit -5 也夹到 1", calls[0].url.endsWith("&e=0"));
reset(); script = [{ body: `{"code":1000,"data":{}}` }];
checkError("列表业务码 1000 -> 401", await expectError(() => listMyPlaylists(COOKIE, 50, OPTS)),
  401, "UNAUTHORIZED", "QQ 音乐登录态已失效，请重新复制 Cookie 后连接");
reset(); script = [{ body: `{"code":0,"data":{"other":1}}` }];
checkError("缺 vec_diss -> 502", await expectError(() => listMyPlaylists(COOKIE, 50, OPTS)),
  502, "UPSTREAM_ERROR", "QQ 音乐未返回歌单列表，请改用粘贴歌单链接");
reset(); script = [{ body: `{"code":"2001"}` }];
checkError("code 是字符串也按业务码定性", await expectError(() => listMyPlaylists(COOKIE, 50, OPTS)),
  429, "RATE_LIMITED", "QQ 音乐请求过于频繁，请稍后再试");
reset(); script = [{ body: `{"code":0,"data":{"vec_diss":[]}}` }];
check("空数组回空列表", (await listMyPlaylists(COOKIE, 50, OPTS)).length === 0);

/* ============================================================ 7. Cookie 校验 */

console.log("--- validate ---");
const validateCases = [
  ["登录态正常", `{"code":0,"req_0":{"code":0,"data":{"retCode":0,"result":{"retCode":0,"retMsg":"ok"},"v_diss_list":[]}}}`, "12****78", null],
  ["业务码 80001 被放过", `{"code":0,"req_0":{"code":80001,"data":{}}}`, "12****78", null],
  ["业务码 2001（限流）被放过", `{"code":0,"req_0":{"code":2001,"data":{}}}`, "12****78", null],
  ["req_0 不是对象也放过", `{"code":0,"req_0":"nope"}`, "12****78", null],
  ["外层 code 非零被放过", `{"code":-60004}`, "12****78", null],
  ["result.retCode 驱动错误但非 401 被放过", `{"code":0,"req_0":{"code":0,"data":{"retCode":0,"result":{"retCode":80105}}}}`, "12****78", null],
  ["业务码 1000 必须上抛", `{"code":0,"req_0":{"code":1000,"data":{}}}`, null, [401, "UNAUTHORIZED", "QQ 音乐登录态已失效，请重新复制 Cookie 后连接"]],
  ["retCode 301 必须上抛", `{"code":0,"req_0":{"code":0,"data":{"retCode":301}}}`, null, [401, "UNAUTHORIZED", "QQ 音乐登录态已失效，请重新复制 Cookie 后连接"]],
];
for (const [name, body, expected, expectedError] of validateCases) {
  reset(); script = [{ body }];
  if (expectedError) {
    const e = await expectError(() => validate(COOKIE, OPTS));
    checkError(`validate ${name}`, e, expectedError[0], expectedError[1], expectedError[2]);
  } else {
    const value = await validate(COOKIE, OPTS);
    check(`validate ${name}`, value === expected, `got ${value}`);
  }
}
reset(); script = [{ status: 403, body: "no" }];
checkError("validate 见 HTTP 403 上抛 401（前端据此重新授权）",
  await expectError(() => validate(COOKIE, OPTS)), 401, "UNAUTHORIZED", "QQ 音乐拒绝了请求（HTTP 403），请重新连接账号");
reset(); script = [{ body: `{"code":0,"req_0":{"code":0,"data":{"retCode":0}}}` }];
await validate(COOKIE, OPTS);
check("校验请求信封逐字节一致", calls[0].body === '{"comm":{"ct":24,"cv":4747474,"platform":"yqq.json","uin":"12345678","g_tk":924345111,"g_tk_new_20200303":924345111,"format":"json","inCharset":"utf-8","outCharset":"utf-8","notice":0,"need_new_code":1,"authst":"qmkeyst_demo"},"req_0":{"module":"music.srfDissInfo.DissInfo","method":"CgiGetDiss","param":{"disstid":0,"dirid":201,"tag":true,"song_begin":0,"song_num":1,"userinfo":true,"orderlist":true}}}', calls[0].body);
check("校验请求 URL = musicu.fcg", calls[0].url === "https://u.y.qq.com/cgi-bin/musicu.fcg");
check("POST 头含 Content-Type 且无 charset", calls[0].headers["Content-Type"] === "application/json"
  && calls[0].headers.Referer === "https://y.qq.com/" && calls[0].headers.Cookie === COOKIE_RAW);

/* =============================================================== 8. 搜索 */

console.log("--- searchTracks ---");
const smartboxJson = `{"code":0,"data":{"song":{"itemlist":[
  {"id":100001,"name":"稻香","singer":[{"name":"周杰伦"}]},
  {"id":100002,"name":"夜曲","singer":[{"name":"周杰伦"}]},
  {"id":100001,"name":"重复的稻香","singer":[{"name":"周杰伦"}]}
],"total":3}}}`;
const musicuSearchJson = `{"code":0,"music.search.SearchCgiService":{"code":0,"data":{"body":{"song":{"list":[
  {"id":100001,"name":"稻香","singer":[{"name":"周杰伦"}],"album":{"name":"魔杰座"},"type":0},
  {"mid":"003PU20T3E1eBI","title":"仅有 mid","singer":[{"name":"X"}],"type":0},
  {"songid":100003,"name":"songid 字段","album":{"name":"专辑三"},"type":0},
  {"id":100004,"name":"没有歌手","album":{"name":"专辑四"}},
  {"id":100005,"name":"album 是字符串","album":"字符串专辑","type":0}
],"total":5}}}}}`;
const SEARCH_BOTH = '[{"providerTrackId":"100001","title":"稻香","artist":"","album":"","durationSec":0,"artworkUrl":"","songType":0},{"providerTrackId":"100002","title":"夜曲","artist":"","album":"","durationSec":0,"artworkUrl":"","songType":0},{"providerTrackId":"100003","title":"songid 字段","artist":"","album":"专辑三","durationSec":0,"artworkUrl":"","songType":0}]';
reset(); script = [{ body: smartboxJson }, { body: musicuSearchJson }];
got = await searchTracks("稻香", "周杰伦", 3, OPTS);
check("两路合并 + 先到先得 + 截断", JSON.stringify(got) === SEARCH_BOTH, JSON.stringify(got));
check("smartbox URL 的中文关键词按 Java 双编码", calls[0].url === "https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg?key=%25E7%25A8%25BB%25E9%25A6%2599&format=json&inCharset=utf-8&outCharset=utf-8&platform=yqq.json", calls[0].url);
check("smartbox 请求不带 Cookie", !("Cookie" in calls[0].headers));
check("搜索体不套 comm 信封", calls[1].body === '{"music.search.SearchCgiService":{"module":"music.search.SearchCgiService","method":"DoSearchForQQMusicDesktop","param":{"search_type":0,"query":"稻香 周杰伦","page_num":1,"num_per_page":8}}}', calls[1].body);
check("musicu 搜索请求也不带 Cookie", !("Cookie" in calls[1].headers));
reset(); script = [{ body: smartboxJson }, { body: musicuSearchJson }];
check("limit 0 也至少回 1 条", (await searchTracks("稻香", "周杰伦", 0, OPTS)).length === 1);
reset(); script = [{ body: smartboxJson }, { body: musicuSearchJson }];
got = await searchTracks("稻香", null, 2, OPTS);
check("artist=null 时 query 被 trim 成单词", JSON.parse(calls[1].body)["music.search.SearchCgiService"].param.query === "稻香" && got.length === 2);
reset();
check("空标题不发任何请求", (await searchTracks("  ", "周杰伦", 5, OPTS)).length === 0 && calls.length === 0);
reset();
check("null 标题不发任何请求", (await searchTracks(null, "周杰伦", 5, OPTS)).length === 0 && calls.length === 0);
reset(); script = [{ status: 500, body: "boom" }, { body: musicuSearchJson }];
got = await searchTracks("稻香", "周杰伦", 5, OPTS);
check("smartbox 挂了仍用 musicu 结果", got.length === 4 && got[0].artist === "周杰伦" && got[3].title === "album 是字符串", JSON.stringify(got));
check("album 是字符串时取空（Jackson path 语义）", got.find((t) => t.title === "album 是字符串").album === "");
check("缺 singer 时 artist 空", got.find((t) => t.title === "没有歌手").artist === "");
reset(); script = [{ body: smartboxJson }, { status: 429, body: "slow" }];
got = await searchTracks("稻香", "周杰伦", 5, OPTS);
check("musicu 挂了但 smartbox 成功 -> 不报错", got.length === 2);
reset(); script = [{ status: 500, body: "boom" }, { body: `{"music.search.SearchCgiService":{"code":2001}}` }];
checkError("两路都挂 -> 抛最后一个错误", await expectError(() => searchTracks("稻香", "周杰伦", 5, OPTS)),
  429, "RATE_LIMITED", "QQ 音乐请求过于频繁，请稍后再试");
reset(); script = [{ body: `{"retcode":-60004,"data":{}}` }, { body: musicuSearchJson }];
got = await searchTracks("稻香", "周杰伦", 5, OPTS);
check("smartbox 用 retcode 字段也当成功（Java 不看）", got.length === 4);
reset(); script = [{ body: `{"code":0,"data":{"song":{"itemlist":[]}}}` },
  { body: `{"code":0,"music.search.SearchCgiService":{"code":0,"data":{"body":{"song":{"list":[]}}}}}` }];
check("两路都空回空列表", (await searchTracks("不存在的歌", "X", 5, OPTS)).length === 0);
check("空结果时 query 拼了 artist", JSON.parse(calls[1].body)["music.search.SearchCgiService"].param.query === "不存在的歌 X");
reset(); script = [{ body: smartboxJson }, { body: musicuSearchJson }];
await searchTracks("周杰伦 稻香", "G.E.M. &+()?", 5, OPTS);
check("特殊字符关键词的出线编码", calls[0].url.startsWith("https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg?key=%25E5%2591%25A8%25E6%259D%25B0%25E4%25BC%25A6%2520%25E7%25A8%25BB%25E9%25A6%2599&"), calls[0].url);
check("query 里的 & + ? 原样透传（Java 的 encode 不吃 '+'）",
  JSON.parse(calls[1].body)["music.search.SearchCgiService"].param.query === "周杰伦 稻香 G.E.M. &+()?");

/* =========================================================== 9. 创建歌单 */

console.log("--- createPlaylist ---");
const nested = `{"code":0,"req_0":{"code":0,"data":{"retCode":0,"result":{"retCode":0,"dirId":987654321,"tid":"TID_ABC","dirName":"上游改名"}}}}`;
reset(); script = [{ body: nested }];
got = await createPlaylist(COOKIE, "我的迁移歌单名字超过二十个字符会被截断的处理", "描述同样会被截断到八十字符".repeat(6), OPTS);
check("新歌单 ID 从 result 里取", got.id === "987654321" && got.name === "上游改名"
  && got.url === "https://y.qq.com/n/ryqq/playlist/987654321" && got.trackCount === 0 && got.metadata.tid === "TID_ABC",
  JSON.stringify(got));
check("metadata 也带 dirId", got.metadata.dirId === "987654321");
let param = JSON.parse(calls[0].body).req_0.param;
check("dirName 截到 20 码点", param.dirName === "我的迁移歌单名字超过二十个字符会被截断的"
  && Array.from(param.dirName).length === 20, `${param.dirName} len=${Array.from(param.dirName).length}`);
check("dirDesc 未超 80 码点则原样", Array.from(param.dirDesc).length === 78
  && param.dirDesc === "描述同样会被截断到八十字符".repeat(6), `len=${Array.from(param.dirDesc).length}`);
check("param 字段顺序与固定字段", JSON.stringify(param) === '{"dirName":' + JSON.stringify(param.dirName)
  + ',"dirDesc":' + JSON.stringify(param.dirDesc) + ',"dirPicUrl":"","taglist":"","dirShow":2}', JSON.stringify(param).slice(0, 60));
check("写请求模块名", JSON.parse(calls[0].body).req_0.module === "music.musicasset.PlaylistBaseWrite"
  && JSON.parse(calls[0].body).req_0.method === "AddPlaylist");
reset(); script = [{ body: nested }];
await createPlaylist(COOKIE, "n", "描述".repeat(60), OPTS);
check("dirDesc 超 80 码点才截到 80", Array.from(JSON.parse(calls[0].body).req_0.param.dirDesc).length === 80,
  `len=${Array.from(JSON.parse(calls[0].body).req_0.param.dirDesc).length}`);
reset(); script = [{ body: `{"code":0,"req_0":{"code":0,"data":{"retCode":0,"dirId":"112233","tid":"T2"}}}` }];
got = await createPlaylist(COOKIE, "名字", null, OPTS);
check("扁平 data 也能取到 ID；description=null -> 空串", got.id === "112233" && got.name === "名字"
  && JSON.parse(calls[0].body).req_0.param.dirDesc === "", JSON.stringify(got));
reset(); script = [{ body: `{"code":0,"req_0":{"code":0,"data":{"retCode":0,"tid":"T2"}}}` }];
checkError("没返回 dirId -> 502", await expectError(() => createPlaylist(COOKIE, "名字", "描述", OPTS)),
  502, "UPSTREAM_ERROR", "QQ 音乐未返回新歌单 ID，请稍后重试");
reset(); script = [{ body: `{"code":0,"req_0":{"code":0,"data":{"retCode":0,"result":{"retCode":0,"dirId":1,"tid":"T","dirName":"x"}}}}` }];
await createPlaylist(COOKIE, "😀".repeat(21) + " name", "描述", OPTS);
check("emoji 歌单名按码点截 20", JSON.parse(calls[0].body).req_0.param.dirName === "😀".repeat(20),
  JSON.parse(calls[0].body).req_0.param.dirName);
check("上游改名优先于本地名", (await (async () => { reset(); script = [{ body: nested }]; return (await createPlaylist(COOKIE, "n", "d", OPTS)).name; })()) === "上游改名");
reset(); script = [{ body: `{"code":0,"req_0":{"code":0,"data":{"retCode":0,"result":{"retCode":0,"dirId":1,"tid":"T"}}}}` }];
got = await createPlaylist(COOKIE, "  短名字  ", "  短描述  ", OPTS);
check("名字先 trim 再截断，且无 dirName 时回退本地名", got.name === "短名字"
  && JSON.parse(calls[0].body).req_0.param.dirDesc === "短描述", JSON.stringify(got));

/* ============================================================= 10. 写入歌曲 */

console.log("--- addTracks ---");
const okEnvelope = `{"code":0,"req_0":{"code":0,"data":{"retCode":0}}}`;
const track = (id, type = 0) => ({ providerTrackId: id, title: "T" + id, artist: "", album: "", durationSec: 0, artworkUrl: "", songType: type });
reset(); script = [{ body: okEnvelope }, { body: okEnvelope }];
const sleeps = [];
await addTracks(COOKIE, { id: "987654321", name: "n", url: "u", trackCount: 0, metadata: { tid: "TID_ABC" } },
  [track("100001"), track("100002", 2), track("100003")], { ...OPTS, batchSize: 2, sleep: async (ms) => { sleeps.push(ms); }, requestIntervalMs: 120 });
check("按 batchSize 分两批", calls.length === 2 && sleeps.length === 1 && sleeps[0] === 120, `calls=${calls.length} sleeps=${JSON.stringify(sleeps)}`);
check("第一批 body 与 Java 完全一致", calls[0].body === '{"comm":{"ct":24,"cv":4747474,"platform":"yqq.json","uin":"12345678","g_tk":924345111,"g_tk_new_20200303":924345111,"format":"json","inCharset":"utf-8","outCharset":"utf-8","notice":0,"need_new_code":1,"authst":"qmkeyst_demo"},"req_0":{"module":"music.musicasset.PlaylistDetailWrite","method":"AddSonglist","param":{"dirId":987654321,"tid":"TID_ABC","bFmtUtf8":true,"v_songInfo":[{"songId":100001,"songType":0},{"songId":100002,"songType":2}]}}}', calls[0].body);
check("第二批只带剩下的歌", JSON.parse(calls[1].body).req_0.param.v_songInfo.length === 1);
reset(); script = [{ body: okEnvelope }];
await addTracks(COOKIE, { id: "9223372036854775807", name: "n", url: "u", trackCount: 0, metadata: { tid: "T" } },
  [track("9223372036854775807")], OPTS);
check("int64 边界 ID 原样出线（不丢精度）",
  calls[0].body.includes('"dirId":9223372036854775807') && calls[0].body.includes('"songId":9223372036854775807'),
  calls[0].body.slice(calls[0].body.indexOf("AddSonglist")));
reset();
script = [{ body: okEnvelope }, { body: okEnvelope }];
const many = Array.from({ length: 101 }, (_, i) => track(String(i + 1)));
await addTracks(COOKIE, { id: "1", name: "n", url: "u", trackCount: 0, metadata: { tid: "T" } }, many, OPTS);
check("默认 batchSize=100 时 101 首歌发两次", calls.length === 2, `calls=${calls.length}`);
reset(); script = [{ body: okEnvelope }];
checkError("mid 形态的歌曲 ID 被拒", await expectError(() => addTracks(COOKIE,
  { id: "1", name: "n", url: "u", trackCount: 0, metadata: { tid: "T" } }, [track("003PU20T3E1eBI")], OPTS)),
  502, "UPSTREAM_ERROR", "QQ 歌曲 ID 无法识别：003PU20T3E1eBI");
check("ID 不合格时没发出任何请求", calls.length === 0);
checkError("歌单 ID 非数字 -> 502", await expectError(() => addTracks(COOKIE,
  { id: "abc", name: "n", url: "u", trackCount: 0, metadata: { tid: "T" } }, [track("123456")], OPTS)),
  502, "UPSTREAM_ERROR", "QQ 音乐返回的歌单 ID 无法识别");
checkError("缺 tid -> 502", await expectError(() => addTracks(COOKIE,
  { id: "1", name: "n", url: "u", trackCount: 0, metadata: {} }, [track("123456")], OPTS)),
  502, "UPSTREAM_ERROR", "QQ 音乐未返回歌单 tid，无法写入歌曲，请重新迁移");
reset(); script = [];
await addTracks(COOKIE, { id: "1", name: "n", url: "u", trackCount: 0, metadata: { tid: "T" } }, [], OPTS);
check("空列表不发请求", calls.length === 0);
reset(); script = [{ body: `{"code":0,"req_0":{"code":0,"data":{"retCode":80105}}}` }];
checkError("写入被风控 -> 80105 专属文案", await expectError(() => addTracks(COOKIE,
  { id: "1", name: "n", url: "u", trackCount: 0, metadata: { tid: "T" } }, [track("123456")], OPTS)),
  502, "UPSTREAM_ERROR", "QQ 音乐拒绝了此次写入（业务码 80105），可能触发风控或需要签名通道；请稍后重试或使用演示模式");
reset(); script = [{ body: `{"code":2000}` }];
checkError("业务码 2000（签名通道）报错口径与 Java 一致", await expectError(() => addTracks(COOKIE,
  { id: "1", name: "n", url: "u", trackCount: 0, metadata: { tid: "T" } }, [track("123456")], OPTS)),
  502, "UPSTREAM_ERROR", "QQ 音乐要求签名请求（业务码 2000），当前通道暂不支持；请使用演示模式体验");
reset(); script = [{ body: `{"code":0,"req_0":{"code":500,"data":{}}}` }];
checkError("未知业务码给通用文案", await expectError(() => addTracks(COOKIE,
  { id: "1", name: "n", url: "u", trackCount: 0, metadata: { tid: "T" } }, [track("123456")], OPTS)),
  502, "UPSTREAM_ERROR", "QQ 音乐返回业务错误（500）");

/* ========================================================= 11. Provider 层 */

console.log("--- Provider 连接与守卫 ---");
reset(); script = [{ body: okEnvelope }];
let conn = await qqConnectReal({ cookie: COOKIE_RAW }, OPTS);
check("connectReal 产出 ProviderConnection 形状", JSON.stringify(conn) === '{"provider":"QQ_MUSIC","mode":"REAL","accountName":"QQ 音乐 · 12****78","credentials":{"cookie":"uin=o0012345678; qm_keyst=qmkeyst_demo; other=value"}}', JSON.stringify(conn));
check("connectReal 只发一次校验请求", calls.length === 1);
checkError("connectReal 缺 cookie -> 400", await expectError(() => qqConnectReal({}, OPTS)),
  400, "INVALID_INPUT", "请粘贴 QQ 音乐 Cookie");
reset(); script = [{ body: `{"code":0,"req_0":{"code":1000,"data":{}}}` }];
checkError("connectReal 登录态失效 -> 401（前端据此重新授权）",
  await expectError(() => qqConnectReal({ cookie: COOKIE_RAW }, OPTS)), 401, "UNAUTHORIZED", "QQ 音乐登录态已失效，请重新复制 Cookie 后连接");

const real = { provider: "QQ_MUSIC", mode: "REAL", accountName: "x", credentials: { cookie: COOKIE_RAW } };
const demo = { provider: "QQ_MUSIC", mode: "DEMO", accountName: "y", credentials: { demoSessionId: "s1" } };
check("sampleUrl", qqSampleUrl() === "https://y.qq.com/n/ryqq/playlist/7300098051");

reset(); script = [{ body: playlistJson }];
got = await qqFetchPlaylist(real, "https://y.qq.com/n/ryqq/playlist/7300098051", OPTS);
check("REAL 连接读真实歌单", got.id === "7300098051" && calls[0].headers.Cookie === COOKIE_RAW);
reset(); script = [{ body: playlistJson }];
got = await qqFetchPlaylist(null, "7300098051", OPTS);
check("未连接也能取公开歌单（不发 Cookie 头）", got.id === "7300098051" && !("Cookie" in calls[0].headers));
checkError("demo:// 链接 + 未连接 -> 400", await expectError(() => qqFetchPlaylist(null, "demo://builtin", OPTS)),
  400, "INVALID_INPUT", "演示歌单链接需要先连接 QQ 音乐演示账号");
checkError("demo:// 链接 + REAL 连接 -> 400", await expectError(() => qqFetchPlaylist(real, "demo://builtin", OPTS)),
  400, "INVALID_INPUT", "演示歌单链接需要先连接 QQ 音乐演示账号");
checkError("真实链接 + DEMO 连接 -> 400", await expectError(() => qqFetchPlaylist(demo, "https://y.qq.com/n/ryqq/playlist/123456", OPTS)),
  400, "INVALID_INPUT", "当前是演示连接，请使用演示歌单链接，或切换为真实 QQ 音乐连接");
checkError("demo:// + DEMO 连接但会话过期 -> 409", await expectError(() => qqFetchPlaylist(
  { mode: "DEMO", credentials: { demoSessionId: "  " } }, "demo://builtin", OPTS)),
  409, "NOT_CONNECTED", "演示会话已过期，请重新连接演示账号");
checkError("demo:// + DEMO 连接、未注入演示通道 -> 503",
  await expectError(() => qqFetchPlaylist(demo, "demo://builtin", OPTS)), 503, "NOT_CONFIGURED",
  "QQ 音乐演示通道未注入：请在 QqOptions.demoProvider 传入 demo.ts 的 createDemoProvider(\"QQ_MUSIC\", state)");
checkError("Cookie 解析先于链接解析：坏 Cookie + 坏链接报 Cookie",
  await expectError(() => qqFetchPlaylist({ mode: "REAL", credentials: { cookie: "" } }, "nonsense", OPTS)),
  400, "INVALID_INPUT", "请粘贴 QQ 音乐 Cookie");
checkError("好 Cookie + 坏链接报链接",
  await expectError(() => qqFetchPlaylist(real, "nonsense", OPTS)),
  400, "INVALID_INPUT", "无法识别歌单链接，请粘贴完整的 QQ 音乐歌单分享链接");

checkError("listPlaylists 未连接 -> 409 来源平台", await expectError(() => qqListPlaylists(null, OPTS)),
  409, "NOT_CONNECTED", "请先连接 QQ 音乐（来源平台）");
checkError("createPlaylist 未连接 -> 409 目标平台", await expectError(() => qqCreatePlaylist(null, "n", "d", OPTS)),
  409, "NOT_CONNECTED", "请先连接 QQ 音乐（目标平台）");
checkError("addTracks 未连接 -> 409 目标平台", await expectError(() => qqAddTracks(null, { id: "1", metadata: { tid: "T" } }, [], OPTS)),
  409, "NOT_CONNECTED", "请先连接 QQ 音乐（目标平台）");
checkError("listPlaylists DEMO -> 503", await expectError(() => qqListPlaylists(demo, OPTS)),
  503, "NOT_CONFIGURED", "QQ 音乐演示通道未注入：请在 QqOptions.demoProvider 传入 demo.ts 的 createDemoProvider(\"QQ_MUSIC\", state)");
checkError("searchTracks DEMO -> 503", await expectError(() => qqSearchTracks(demo, "稻香", "周杰伦", 5, OPTS)),
  503, "NOT_CONFIGURED", "QQ 音乐演示通道未注入：请在 QqOptions.demoProvider 传入 demo.ts 的 createDemoProvider(\"QQ_MUSIC\", state)");
// Java 的搜索分支是 demoCatalog.targetCatalog(...)，不读 demoSessionId，所以会话过期也报 503 而不是 409。
checkError("searchTracks DEMO 会话过期仍 -> 503", await expectError(() => qqSearchTracks(
  { mode: "DEMO", credentials: { demoSessionId: "" } }, "稻香", "周杰伦", 5, OPTS)),
  503, "NOT_CONFIGURED", "QQ 音乐演示通道未注入：请在 QqOptions.demoProvider 传入 demo.ts 的 createDemoProvider(\"QQ_MUSIC\", state)");
checkError("无法识别的 demo:// 链接 -> 400（这条不依赖演示数据源）", await expectError(() => qqFetchPlaylist(
  demo, "demo://playlist/zzz", OPTS)),
  400, "INVALID_INPUT", "演示歌单链接无法识别，请使用 demo://builtin 或演示音乐库中的歌单");
reset(); script = [{ body: smartboxJson }, { body: musicuSearchJson }];
got = await qqSearchTracks(real, "稻香", "周杰伦", 3, OPTS);
check("REAL 连接搜索不校验 Cookie、不发 Cookie 头", got.length === 3 && calls.every((c) => !("Cookie" in c.headers)));
reset(); script = [{ body: createdJson }];
got = await qqListPlaylists(real, OPTS);
check("Provider 层列表固定 limit 50 -> e=49", got.length === 2 && calls[0].url.includes("&e=49"));
reset(); script = [{ body: nested }];
const created = await qqCreatePlaylist(real, "n", "d", OPTS);
reset(); script = [{ body: okEnvelope }];
await qqAddTracks(real, created, [track("100001")], OPTS);
check("createPlaylist 产出的 metadata 可直接喂 addTracks", JSON.parse(calls[0].body).req_0.param.tid === "TID_ABC"
  && JSON.parse(calls[0].body).req_0.param.dirId === 987654321);
const demoConn = qqConnectDemo("s1");
check("connectDemo 形状", JSON.stringify(demoConn) === '{"provider":"QQ_MUSIC","mode":"DEMO","accountName":"演示账号 · 阿桥","credentials":{"demoSessionId":"s1"}}', JSON.stringify(demoConn));
// Java connectDemo 只做 Map.of：空 sessionId 也能连上，409 延后到使用该连接的接口（对照 sessionId()）。
check("connectDemo 空会话仍产出连接（Java 不校验）", qqConnectDemo("  ").credentials.demoSessionId === "  ");
checkError("空 sessionId 的连接用在 listPlaylists 才报 409", await expectError(() => qqListPlaylists(qqConnectDemo(""), OPTS)),
  409, "NOT_CONNECTED", "演示会话已过期，请重新连接演示账号");
checkError("connectDemo(null) 复刻 Map.of 的未捕获 NPE -> 500", await expectError(() => { qqConnectDemo(undefined); }),
  500, "INTERNAL_ERROR", "服务暂时不可用，请稍后重试");

/* --------------------------------------------- 31. Provider 层：注入演示通道（demo.ts） */

console.log("--- DEMO 分支委托给 demo.ts ---");
const demoState = emptyDemoStoreState();
const DEMO_OPTS = { fetchImpl: fakeFetch, demoProvider: createDemoProvider("QQ_MUSIC", demoState) };
reset();

got = await qqSearchTracks(demo, "任意歌名", "任意歌手", 6, DEMO_OPTS);
check("searchTracks DEMO 返回演示目标曲库、忽略三个入参",
  got.length === DEMO_TARGET_CATALOGS.QQ_MUSIC.length && got[1].providerTrackId === DEMO_TARGET_CATALOGS.QQ_MUSIC[1].providerTrackId);
got = await qqSearchTracks({ mode: "DEMO", credentials: {} }, "x", "y", 1, DEMO_OPTS);
check("searchTracks DEMO 不检查 demoSessionId（Java 的 targetCatalog 分支）", got.length === DEMO_TARGET_CATALOGS.QQ_MUSIC.length);

got = await qqFetchPlaylist(demo, "demo://builtin", DEMO_OPTS);
check("fetchPlaylist demo://builtin 走 DemoCatalog", JSON.stringify(got) === JSON.stringify(DEMO_BUILTIN_PLAYLISTS.QQ_MUSIC));
got = await qqFetchPlaylist(demo, "demo://playlist/builtin", DEMO_OPTS);
check("fetchPlaylist 备用 builtin 链接同样命中", got.id === DEMO_BUILTIN_PLAYLISTS.QQ_MUSIC.id);
checkError("注入后无法识别的 demo:// 链接仍 400（文案由 demo.ts 保持）",
  await expectError(() => qqFetchPlaylist(demo, "demo://playlist/zzz", DEMO_OPTS)),
  400, "INVALID_INPUT", "演示歌单链接无法识别，请使用 demo://builtin 或演示音乐库中的歌单");
checkError("注入后 demoSessionId 缺失 -> 409", await expectError(() => qqListPlaylists(
  { mode: "DEMO", credentials: {} }, DEMO_OPTS)), 409, "NOT_CONNECTED", "演示会话已过期，请重新连接演示账号");
checkError("注入后 demo:// + REAL 连接 -> 400（不是 503）", await expectError(() => qqFetchPlaylist(
  real, "demo://builtin", DEMO_OPTS)), 400, "INVALID_INPUT", "演示歌单链接需要先连接 QQ 音乐演示账号");

const made = await qqCreatePlaylist(demo, "迁移歌单", "由 qq.ts 委托", DEMO_OPTS);
check("createPlaylist DEMO 产出 demo-1001 / demo://library/demo-1001",
  JSON.stringify(made) === '{"id":"demo-1001","name":"迁移歌单","url":"demo://library/demo-1001","trackCount":0,"metadata":{}}', JSON.stringify(made));
await qqAddTracks(demo, made, [track("100001"), track("100002")], DEMO_OPTS);
got = await qqFetchPlaylist(demo, "demo://library/demo-1001", DEMO_OPTS);
check("addTracks DEMO 追加后可读回", got.tracks.length === 2 && got.tracks[0].providerTrackId === "100001" && got.webUrl === "demo://library/demo-1001");
const refs = await qqListPlaylists(demo, DEMO_OPTS);
// Java DemoPlaylists.of：先放 catalog.builtin(provider)，再追加 store.list(session, provider)。
// 所以会话内建过一张单之后应当是「内置 + 新建」两条，而不是只有新建那条。
check("listPlaylists DEMO 列出内置歌单与本会话新建歌单",
  refs.length === 2 && refs[0].id === "demo-qq-builtin" && refs[0].trackCount === 12
  && refs[1].id === "demo-1001" && refs[1].trackCount === 2, JSON.stringify(refs));
check("整条 DEMO 通道零次出网请求", calls.length === 0, `calls=${calls.length}`);
checkError("REAL 连接不受注入影响，仍走真实通道", await expectError(() => qqFetchPlaylist(
  real, "https://y.qq.com/n/ryqq/playlist/123456", DEMO_OPTS)), 502, "UPSTREAM_ERROR");
reset();

/* 供上面超时用例使用：命中 abort 后按 TimeoutError 拒绝。 */
function hangingFetch(_url, init) {
  return new Promise((_resolve, reject) => {
    // Node 的 AbortSignal.timeout 用的是 unref 定时器，这里补一个 ref 句柄让事件循环撑到超时。
    const keep = setTimeout(() => {}, 5_000);
    init.signal.addEventListener("abort", () => { clearTimeout(keep); reject(init.signal.reason); });
  });
}

console.log(failed === 0 ? "QQ CHANNEL ALL PASS" : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
