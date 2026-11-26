/**
 * QQ 音乐通道（边缘函数版）—— 从 Java 侧逐字移植：
 *   src/main/java/com/tunebridge/provider/qq/QqCookie.java
 *   src/main/java/com/tunebridge/provider/qq/QqUrlParser.java
 *   src/main/java/com/tunebridge/provider/qq/QqMusicClient.java
 *   src/main/java/com/tunebridge/provider/qq/QqMusicProvider.java
 *
 * 契约来源不是“读代码猜”，而是用本机 JDK 直接调用编译后的 QqCookie / QqUrlParser /
 * QqMusicClient（用桩 ClientHttpRequestFactory 录下真实出线请求与响应映射），逐条对齐：
 * URL、参数顺序、请求头、body 字段顺序、响应取值、错误码与中文文案。
 * 校验脚本：node dev/verify-qq.mjs（离线，全部用内联样本）。
 *
 * 【密码学】本通道不需要任何加解密或签名：QQ 只需要 g_tk，它是 hash33（DJB2 变体，
 * 32 位整数溢出 + & 0x7fffffff），纯算术，没有 AES/ECB、没有 MD5、没有自定义 Base64。
 * 因此 eapi.ts（AES-CBC 冒充 ECB）与 md5.ts 在这里都用不上，也不存在 WebCrypto 能力缺口。
 *
 * 【已知缺口，不粉饰】
 * 1. 演示模式（DemoCatalog / DemoStore）不在本文件里：它已由 site/functions/demo.ts 移植
 *    （createDemoProvider("QQ_MUSIC", state)）。本文件的 provider 层函数把它做成注入点
 *    QqOptions.demoProvider，注入后 DEMO 连接与 demo:// 链接走它，语义与 Java 的
 *    QqMusicProvider 内部路由一致；未注入时这些分支抛 503 NOT_CONFIGURED，绝不退化成真实通道。
 * 2. 业务码 2000（上游要求 ecode+sign 签名通道）Java 自己也只报错，本实现同样报错，
 *    文案一字不差；写入被风控（80105）同理。
 * 3. 超时：Java 是 connect 6s / read 25s 两段，边缘 fetch 只有一段，这里取 25s 单一超时，
 *    并把所有网络异常（含 DNS、连接被拒、出网被拦）统一归到 Java 的 ResourceAccessException
 *    口径：502「QQ 音乐响应超时，请稍后重试」。
 * 4. 非 2xx 之外的响应体异常：Java 侧空响应体（GET）会 NPE、非 JSON 体会抛
 *    RestClientException，二者都落到 ApiExceptionHandler 的 500 INTERNAL_ERROR
 *    「服务暂时不可用，请稍后重试」。本实现照此输出 500 + 同码同文案，不自创 502 文案。
 * 5. JSON 数字取值：Jackson 的 asText() 对超过 int64/浮点的数字输出原始字面量，
 *    JS 的 JSON.parse 已按 IEEE-754 折损（如 12345678901234567890 -> ...568000）。
 *    真实 QQ 歌曲 ID / 歌单 ID 都在 2^53 内，写请求侧另用 BigInt 保精度（见 stringifyJson）。
 */

import { ProviderApiError } from "./errors.ts";
import type { DemoMusicProvider } from "./demo.ts";

/* ------------------------------------------------------------------ 域模型 */

/** 字段顺序与 domain/Track.java 一致：providerTrackId,title,artist,album,durationSec,artworkUrl,songType */
export interface QqTrack {
  providerTrackId: string;
  title: string;
  artist: string;
  album: string;
  durationSec: number;
  artworkUrl: string;
  songType: number;
}

/** 字段顺序与 domain/Playlist.java 一致。 */
export interface QqPlaylist {
  id: string;
  name: string;
  description: string;
  coverUrl: string;
  owner: string;
  webUrl: string;
  tracks: QqTrack[];
}

/** 字段顺序与 domain/PlaylistRef.java 一致。 */
export interface QqPlaylistRef {
  id: string;
  name: string;
  url: string;
  coverUrl: string;
  trackCount: number;
}

/** 字段顺序与 domain/CreatedPlaylist.java 一致；metadata 必须带回 tid/dirId，addTracks 依赖 tid。 */
export interface QqCreatedPlaylist {
  id: string;
  name: string;
  url: string;
  trackCount: number;
  metadata: Record<string, string>;
}

export type QqConnectionMode = "DEMO" | "REAL";

/** ProviderConnection 的最小形状（provider,mode,accountName,credentials）。 */
export interface QqConnection {
  provider?: string;
  mode?: QqConnectionMode;
  accountName?: string;
  credentials?: Record<string, string>;
}

/* -------------------------------------------------------------------- 常量 */

/** AppConfig：connect 6_000 / read 25_000；边缘只有单一超时，取读超时。 */
const TIMEOUT_MS = 25_000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";
const REFERER = "https://y.qq.com/";
const MUSICU_URL = "https://u.y.qq.com/cgi-bin/musicu.fcg";
const PLAYLIST_URL = "https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg";
const SMARTBOX_URL = "https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg";
const CREATED_DISS_URL = "https://c.y.qq.com/rsc/fcg-bin/fcg_user_created_diss";
/** QqMusicProvider.SOURCE_LIST_LIMIT */
const SOURCE_LIST_LIMIT = 50;
/** TuneBridgeProperties.Migration 默认值（max-tracks 200 由调用方/迁移编排负责）。 */
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_REQUEST_INTERVAL_MS = 120;
const SAMPLE_URL = "https://y.qq.com/n/ryqq/playlist/7300098051";

/* ------------------------------------------------------ Java 字符串语义工具 */

/** Java String.trim()：只去掉 <= U+0020 的字符（U+00A0/U+3000 不去），与 JS trim() 不同。 */
export function javaTrim(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) <= 0x20) start++;
  while (end > start && value.charCodeAt(end - 1) <= 0x20) end--;
  return value.slice(start, end);
}

/** Java Character.isWhitespace：U+00A0 与 U+202F 返回 false（实测口径）。 */
function javaIsWhitespace(code: number): boolean {
  if (code === 0x20) return true;
  if (code < 0x20) return code >= 0x09 && code <= 0x0d;
  if (code >= 0x1c && code <= 0x1f) return true;
  if (code === 0x85 || code === 0xa0) return false;
  if (code === 0x1680) return true;
  if (code >= 0x2000 && code <= 0x2006) return true;
  if (code >= 0x2008 && code <= 0x200a) return true;
  return code === 0x2028 || code === 0x2029 || code === 0x205f || code === 0x3000;
}

/** Java String.isBlank()：按 Character.isWhitespace 判定，不等于 JS 的 /^\s*$/。 */
export function javaIsBlank(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return true;
  for (let i = 0; i < value.length; i++) {
    if (!javaIsWhitespace(value.charCodeAt(i))) return false;
  }
  return true;
}

/** Java truncate(value, maxCodePoints)：先 trim()，再按码点计数截断（代理对算一个）。 */
export function truncateCodePoints(value: string | null | undefined, maxCodePoints: number): string {
  const safe = javaTrim(value ?? "");
  const chars = Array.from(safe);
  return chars.length <= maxCodePoints ? safe : chars.slice(0, maxCodePoints).join("");
}

/* ------------------------------------------------- Jackson JsonNode 取值子集 */

type Json = unknown;

function isObjectNode(value: Json): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JsonNode.path(String)：非容器 / 不存在都得到 MissingNode（这里用 undefined 表示）。 */
function path(node: Json, field: string): Json {
  return isObjectNode(node) ? node[field] : undefined;
}

/** JsonNode.path(int)：非数组取不到元素。 */
function pathIndex(node: Json, index: number): Json {
  return Array.isArray(node) ? node[index] : undefined;
}

/**
 * QqMusicClient#text：node 为 null/missing 给 ""；字段 missing/null 给 ""；
 * 其余走 Jackson asText("")——数字给字面量、布尔给 "true"/"false"、容器给 ""（实测）。
 */
function text(node: Json, field: string): string {
  if (node === null || node === undefined) return "";
  const value = path(node, field);
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  return "";
}

/**
 * JsonNode.asInt(default)：数值向零取整并按 int32 回绕（实测 1.9 -> 1、
 * 12345678901234567890 -> -350287150）；字符串按 Java 数字解析（"12.5" -> 12、"abc" -> 0）；
 * 布尔 true -> 1；容器/null/missing -> 默认值。
 */
function asInt(node: Json, fallback = 0): number {
  if (typeof node === "number") return Number.isFinite(node) ? Math.trunc(node) | 0 : fallback;
  if (typeof node === "boolean") return node ? 1 : 0;
  if (typeof node === "string") {
    const trimmed = javaTrim(node);
    if (trimmed === "") return fallback;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? Math.trunc(parsed) | 0 : fallback;
  }
  return fallback;
}

/** JsonNode 的迭代语义（nodes()）：数组取元素，对象取其值，其它为空。 */
function elements(node: Json): Json[] {
  if (Array.isArray(node)) return node;
  if (isObjectNode(node)) return Object.values(node);
  return [];
}

/** JsonNode.has(field)：字段存在即 true，即便值是 null —— songtype/type 的回退就卡在这里。 */
function hasField(node: Json, field: string): boolean {
  return isObjectNode(node) && Object.prototype.hasOwnProperty.call(node, field);
}

/** QqMusicClient#joinSingers：非数组给 ""，空名跳过，分隔符 " / "。 */
export function joinSingers(singers: Json): string {
  if (!Array.isArray(singers)) return "";
  const names: string[] = [];
  for (const singer of singers) {
    const name = text(singer, "name");
    if (!javaIsBlank(name)) names.push(name);
  }
  return names.join(" / ");
}

/* ------------------------------------------------------ Spring 的 query 编码 */

function isUnreserved(c: number): boolean {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)
    || c === 0x2d || c === 0x2e || c === 0x5f || c === 0x7e;
}

function isSubDelimiter(c: number): boolean {
  return c === 0x21 || c === 0x24 || c === 0x26 || c === 0x27 || c === 0x28 || c === 0x29
    || c === 0x2a || c === 0x2b || c === 0x2c || c === 0x3b || c === 0x3d;
}

/** HierarchicalUriComponents.Type.QUERY#isAllowed：'=' 与 '&' 强制转义，其余 pchar 加 '/' '?' 原样。 */
function queryAllowed(c: number): boolean {
  if (c === 0x3d || c === 0x26) return false;
  return isUnreserved(c) || isSubDelimiter(c) || c === 0x3a || c === 0x40 || c === 0x2f || c === 0x3f;
}

/** UriComponentsBuilder#encode()：UTF-8 字节 + 大写十六进制；'%' 一律转义（Spring 不保留既有转义）。 */
function springQueryEncode(value: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(value)) {
    out += queryAllowed(byte) ? String.fromCharCode(byte)
      : "%" + byte.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

/**
 * Java 侧把 encode() 之后的整串交给 RestClient.uri(String)，query 值因此被编码两次：
 * 实测出线 key=%25E7%25A8%25BB%25E9%25A6%2599（"稻香"）、key=50%2525（"50%"）、
 * 'a+b&c=d/e?f%g~i*j(k)' -> a+b%26c%3Dd/e?f%25g~i*j(k)。
 * 这是实测行为（上游能吃），照抄，不“修正”成一次编码。
 */
function qqQueryValue(value: string): string {
  return springQueryEncode(springQueryEncode(value));
}

function buildUrl(base: string, params: Array<[string, string]>): string {
  return base + "?" + params.map(([name, value]) => `${springQueryEncode(name)}=${qqQueryValue(value)}`).join("&");
}

/* --------------------------------------------------------- 出线 JSON 序列化 */

type JsonValue = string | number | boolean | bigint | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Jackson ObjectNode.put(String,long) 写的是裸十进制（实测 dirId:9223372036854775807），
 * 所以这里用 bigint 承载 ID，Stringify 时原样吐出，避免 JS number 丢精度。
 */
function stringifyJson(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stringifyJson).join(",") + "]";
  const parts: string[] = [];
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${stringifyJson(item)}`);
  }
  return "{" + parts.join(",") + "}";
}

/* ------------------------------------------------------------------ Cookie */

export interface QqCookie {
  uin: string;
  musicKey: string;
  rawCookie: string;
}

/** QqCookie.parse：整串 Cookie -> 归一化 uin + 音乐登录票据 + 原样回传的 Cookie 头。 */
export function parseQqCookie(raw: string | null | undefined): QqCookie {
  if (javaIsBlank(raw)) throw ProviderApiError.badRequest("请粘贴 QQ 音乐 Cookie");
  const source = raw as string;
  let cleaned = javaTrim(source);
  if (cleaned.length >= 7 && /^cookie:/i.test(cleaned.slice(0, 7))) cleaned = javaTrim(cleaned.slice(7));
  if (cleaned.length < 12 || !cleaned.includes("=")) {
    throw ProviderApiError.badRequest("Cookie 格式不完整，请从 y.qq.com 复制完整的请求 Cookie");
  }

  const values = new Map<string, string>();
  for (const part of cleaned.split(";")) {
    const token = javaTrim(part);
    const index = token.indexOf("=");
    if (index > 0) {
      values.set(javaTrim(token.slice(0, index)).toLowerCase(), javaTrim(token.slice(index + 1)));
    }
  }

  let uin = firstNonBlank(values, "uin", "qqmusic_uin", "wxuin", "p_uin");
  if (uin === null) {
    throw ProviderApiError.badRequest("Cookie 中缺少 uin，请确认复制的是 y.qq.com 登录后的 Cookie");
  }
  uin = normalizeUin(uin);

  const key = firstNonBlank(values, "qm_keyst", "qqmusic_key", "music_key");
  if (key === null) {
    throw ProviderApiError.badRequest(
      "Cookie 中缺少音乐登录票据（qm_keyst / qqmusic_key），请重新登录 y.qq.com 后复制");
  }
  return { uin, musicKey: key, rawCookie: cleaned };
}

function firstNonBlank(values: Map<string, string>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = values.get(key);
    if (value !== undefined && !javaIsBlank(value)) return value;
  }
  return null;
}

/** normalizeUin：去一个前导 o/O，再去前导 0，最后必须整体匹配 \d{3,}。 */
function normalizeUin(value: string): string {
  let normalized = javaTrim(value);
  if (normalized.length >= 1 && /^o/i.test(normalized.slice(0, 1))) normalized = normalized.slice(1);
  while (normalized.length > 1 && normalized.startsWith("0")) normalized = normalized.slice(1);
  if (!/^\d{3,}$/.test(normalized)) {
    throw ProviderApiError.badRequest("Cookie 中的 uin 无法识别，请重新登录 y.qq.com 后复制");
  }
  return normalized;
}

/**
 * hash33：Java 用 charAt（UTF-16 码元）+ int 溢出，所以这里必须用 charCodeAt 和 |0，
 * 不能用 [...key]（码点迭代）——代理对会算成两个。
 */
export function hash33(key: string): number {
  let hash = 5381;
  for (let i = 0; i < key.length; i++) {
    hash = (hash + ((hash << 5) + key.charCodeAt(i))) | 0;
  }
  return hash & 0x7fffffff;
}

export function cookieGTk(cookie: QqCookie): number {
  return hash33(cookie.musicKey);
}

/** maskedUin：长度 <= 4 给 "***"，否则前 2 + "****" + 后 2。 */
export function maskedUin(cookie: QqCookie): string {
  if (cookie.uin.length <= 4) return "***";
  return cookie.uin.slice(0, 2) + "****" + cookie.uin.slice(cookie.uin.length - 2);
}

/* -------------------------------------------------------------- 链接解析 */

const NUMERIC = /^\d{5,20}$/;
const PATH_PLAYLIST = /\/playlist\/(\d{5,20})/;
const QUERY_ID = /[?&#](?:id|disstid|dissid)=(\d{5,20})/;

/** QqUrlParser.parsePlaylistId：纯数字 / 路径里的 /playlist/<id> / ?|&|# 上的 id|disstid|dissid。 */
export function parsePlaylistId(raw: string | null | undefined): string {
  if (javaIsBlank(raw)) throw ProviderApiError.badRequest("请粘贴 QQ 音乐歌单链接");
  const value = javaTrim(raw as string);
  if (NUMERIC.test(value)) return value;
  if (!value.startsWith("http://") && !value.startsWith("https://")) {
    // 注意：HTTPS:// 大写也被拒（Java 是 startsWith 字面量比较）
    throw ProviderApiError.badRequest("无法识别歌单链接，请粘贴完整的 QQ 音乐歌单分享链接");
  }

  const uri = splitUri(value); // URI.create 语义，非法字符在这里抛「格式不正确」
  const host = serverAuthorityHost(uri.authority);
  if (host !== "qq.com" && !host.endsWith(".qq.com")) {
    throw ProviderApiError.badRequest("这不是 QQ 音乐链接，请确认来源平台");
  }
  const pathMatch = PATH_PLAYLIST.exec(uri.path);
  if (pathMatch) return pathMatch[1];
  const query = uri.query === null ? "" : uri.query;
  const fragment = uri.fragment === null ? "" : uri.fragment;
  const queryMatch = QUERY_ID.exec(`?${query}#${fragment}`);
  if (queryMatch) return queryMatch[1];
  throw ProviderApiError.badRequest("链接中没有找到歌单 ID，请使用歌单页的分享链接");
}

/**
 * 手工切分，对齐 java.net.URI：authority 结束于第一个 "/?#"，path 结束于第一个 ";?#"，
 * 之后按 param(;) -> query(?) -> fragment(#) 顺序解析；path 取解码值（getPath），
 * query/fragment 取原始值（getRawQuery/getRawFragment）。
 */
function splitUri(value: string): { authority: string; path: string; query: string | null; fragment: string | null } {
  const from = value.indexOf("://") + 3;
  const authorityEnd = indexOfAny(value, from, "/?#");
  requireLegal(value, authorityEnd);
  const authority = value.slice(from, authorityEnd);
  let i = authorityEnd;
  const pathEnd = indexOfAny(value, i, ";?#");
  const path = percentDecode(value.slice(i, pathEnd));
  i = pathEnd;
  if (value[i] === ";") i = indexOfAny(value, i, "?#");
  let query: string | null = null;
  let fragment: string | null = null;
  if (value[i] === "?") {
    const fragmentStart = value.indexOf("#", i + 1);
    query = fragmentStart < 0 ? value.slice(i + 1) : value.slice(i + 1, fragmentStart);
    i = fragmentStart < 0 ? value.length : fragmentStart;
  }
  if (value[i] === "#") fragment = value.slice(i + 1);
  return { authority, path, query, fragment };
}

function indexOfAny(value: string, from: number, chars: string): number {
  for (let i = from; i < value.length; i++) {
    if (chars.includes(value[i])) return i;
  }
  return value.length;
}

/**
 * URI.create 的非法字符集（实测表）：控制字符与空格、'%' 转义不完整，以及
 * " < > [ ] \ ^ ` { | }（方括号只在 authority 里合法）；
 * 非 ASCII 中排除 C0-C1 控制区（U+0080-U+009F）与 Unicode 空白族（NBSP、U+2028/2029、U+3000 等）。
 */
function requireLegal(value: string, authorityEnd: number): void {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f) || isSpaceChar(c)) {
      throw ProviderApiError.badRequest("歌单链接格式不正确");
    }
    if (c === 0x25) {
      if (!/^[0-9a-fA-F]{2}/.test(value.slice(i + 1, i + 3))) {
        throw ProviderApiError.badRequest("歌单链接格式不正确");
      }
      i += 2;
      continue;
    }
    if (isUriExcluded(c) && !((c === 0x5b || c === 0x5d) && i < authorityEnd)) {
      throw ProviderApiError.badRequest("歌单链接格式不正确");
    }
  }
}

function isUriExcluded(c: number): boolean {
  return c === 0x22 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d
    || c === 0x5c || c === 0x5e || c === 0x60 || c === 0x7b || c === 0x7c || c === 0x7d;
}

/** Character.isSpaceChar（Zs/Zl/Zp）。 */
function isSpaceChar(c: number): boolean {
  if (c === 0xa0 || c === 0x1680) return true;
  if (c >= 0x2000 && c <= 0x200a) return true;
  return c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000;
}

/** percentDecode：UTF-8 解码，非法字节序列按替换字符处理（到这里转义格式已校验过）。 */
function percentDecode(value: string): string {
  if (!value.includes("%")) return value;
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "%" && /^[0-9a-fA-F]{2}/.test(value.slice(i + 1, i + 3))) {
      bytes.push(parseInt(value.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      const encoded = new TextEncoder().encode(value[i]);
      for (const b of encoded) bytes.push(b);
    }
  }
  return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
}

/**
 * java.net.URI#getHost()：authority 必须是 server-based，否则返回 null（这里用 ""）。
 * 规则：去掉最后一个 '@' 之前的 userinfo；方括号取 IPv6 字面量；否则从最后一个 ':' 切端口
 * （端口必须全数字、可为空）；主机名只允许字母数字与 '.' '-'。
 * 实测：y_qq.com / y%2eqq.com / :abc 端口 / 空 authority / 非 ASCII 主机 全部 -> null。
 */
function serverAuthorityHost(authority: string): string {
  if (authority === "") return "";
  const at = authority.lastIndexOf("@");
  let hostPart = at < 0 ? authority : authority.slice(at + 1);
  if (hostPart.startsWith("[")) {
    const close = hostPart.indexOf("]");
    return close < 0 ? "" : hostPart.slice(0, close + 1).toLowerCase();
  }
  const colon = hostPart.lastIndexOf(":");
  if (colon >= 0) {
    const port = hostPart.slice(colon + 1);
    if (port !== "" && !/^\d+$/.test(port)) return "";
    hostPart = hostPart.slice(0, colon);
  }
  if (!/^[A-Za-z0-9.-]+$/.test(hostPart)) return "";
  return hostPart.toLowerCase();
}

/* ---------------------------------------------------------------- 传输层 */

export interface QqOptions {
  /** 注入点：校验脚本用它喂内联样本，绝不联网。 */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  batchSize?: number;
  requestIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * 演示通道：demo.ts 的 createDemoProvider("QQ_MUSIC", state)。
   * Java 的 QqMusicProvider 自己持有 DemoCatalog/DemoStore 并按 mode 路由；边缘侧演示通道已经
   * 独立移植到 demo.ts，所以这里以注入点还原同一条路由。不注入时 DEMO 分支报 503，不会偷走真实通道。
   */
  demoProvider?: DemoMusicProvider;
}

const DEFAULT_OPTIONS: QqOptions = {};

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Java 未捕获异常 -> ApiExceptionHandler.handleUnexpected：500 + INTERNAL_ERROR + 这句文案。 */
function internalError(): ProviderApiError {
  return new ProviderApiError(500, "INTERNAL_ERROR", "服务暂时不可用，请稍后重试");
}

/** QqMusicClient#mapHttpError。 */
function mapHttpError(status: number): ProviderApiError {
  if (status === 401 || status === 403) {
    return ProviderApiError.unauthorized(`QQ 音乐拒绝了请求（HTTP ${status}），请重新连接账号`);
  }
  if (status === 404) return ProviderApiError.notFound("QQ 音乐歌单不存在或不可访问");
  if (status === 429) return ProviderApiError.rateLimited("QQ 音乐请求过于频繁，请稍后再试");
  return ProviderApiError.upstream(`QQ 音乐暂时不可用（HTTP ${status}），请稍后重试`);
}

/** QqMusicClient#businessError：业务码 -> HTTP 语义，一一对应。 */
function businessError(code: number): ProviderApiError {
  if (code === 301 || code === 401 || code === 1000) {
    return ProviderApiError.unauthorized("QQ 音乐登录态已失效，请重新复制 Cookie 后连接");
  }
  if (code === 2000) {
    return ProviderApiError.upstream("QQ 音乐要求签名请求（业务码 2000），当前通道暂不支持；请使用演示模式体验");
  }
  if (code === 2001) return ProviderApiError.rateLimited("QQ 音乐请求过于频繁，请稍后再试");
  if (code === 80105) {
    return ProviderApiError.upstream(
      "QQ 音乐拒绝了此次写入（业务码 80105），可能触发风控或需要签名通道；请稍后重试或使用演示模式");
  }
  return ProviderApiError.upstream(`QQ 音乐返回业务错误（${code}）`);
}

/**
 * getJson / postJson 的合体：请求头顺序与集合按实测抓包
 * （GET: Referer, User-Agent[, Cookie]；POST 再加 Content-Type: application/json，无 charset）。
 * RestClientResponseException -> mapHttpError；ResourceAccessException -> 502 超时文案。
 */
async function requestJson(
  method: "GET" | "POST", url: string, cookie: QqCookie | null,
  body: string | null, options: QqOptions): Promise<Json> {
  const headers: Record<string, string> = { Referer: REFERER, "User-Agent": USER_AGENT };
  if (body !== null) headers["Content-Type"] = "application/json";
  if (cookie !== null) headers.Cookie = cookie.rawCookie;
  const doFetch = options.fetchImpl ?? globalThis.fetch;

  let response: Response;
  try {
    response = await doFetch(url, {
      method,
      headers,
      body: body ?? undefined,
      signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
    } as RequestInit);
  } catch {
    throw ProviderApiError.upstream("QQ 音乐响应超时，请稍后重试");
  }
  if (response.status < 200 || response.status >= 300) throw mapHttpError(response.status);

  const raw = await response.text();
  let parsed: Json;
  if (raw === "") {
    // Java: GET 侧 Jackson 返回 null 后 root.path(...) NPE -> 500；POST 侧显式判空 -> 502。
    if (body !== null) throw ProviderApiError.upstream("QQ 音乐返回了空响应");
    throw internalError();
  }
  try {
    parsed = JSON.parse(raw) as Json;
  } catch {
    // Java: UnknownContentTypeException / RestClientException 未被捕获 -> 500 INTERNAL_ERROR。
    throw internalError();
  }
  if (parsed === null && body === null) throw internalError();
  if (parsed === null) throw ProviderApiError.upstream("QQ 音乐返回了空响应");
  return parsed;
}

/* ------------------------------------------------------- musicu 信封调用 */

/**
 * comm 块字段顺序、ct=24 / cv=4747474 / g_tk 双写、authst 仅在带 Cookie 时出现、
 * 无 Cookie 时 uin="0" 且 g_tk=5381——全部按实测 body 原样保留。
 */
function call(
  cookie: QqCookie | null, module: string, method: string,
  param: Record<string, JsonValue>, options: QqOptions): Promise<Json> {
  const gTk = cookie === null ? 5381 : cookieGTk(cookie);
  const comm: Record<string, JsonValue> = {
    ct: 24,
    cv: 4747474,
    platform: "yqq.json",
    uin: cookie === null ? "0" : cookie.uin,
    g_tk: gTk,
    g_tk_new_20200303: gTk,
    format: "json",
    inCharset: "utf-8",
    outCharset: "utf-8",
    notice: 0,
    need_new_code: 1,
  };
  if (cookie !== null) comm.authst = cookie.musicKey;
  const envelope: Record<string, JsonValue> = { comm, req_0: { module, method, param } };

  return requestJson("POST", MUSICU_URL, cookie, stringifyJson(envelope), options).then((response) => {
    const outerCode = asInt(path(response, "code"), 0);
    if (outerCode !== 0) throw businessError(outerCode);
    const block = path(response, "req_0");
    if (!isObjectNode(block)) throw ProviderApiError.upstream("QQ 音乐返回了无法识别的数据");
    const blockCode = asInt(path(block, "code"), 0);
    if (blockCode !== 0) throw businessError(blockCode);
    const data = path(block, "data");
    let retCode = asInt(path(data, "retCode"), 0);
    const result = path(data, "result");
    if (retCode === 0 && isObjectNode(result)) retCode = asInt(path(result, "retCode"), 0);
    if (retCode !== 0) throw businessError(retCode);
    return block;
  });
}

/* ------------------------------------------------------------- 歌单读取 */

/** GET fcg_ucc_getcdinfo_byids_cp.fcg；参数顺序 = Java 里 queryParam 的调用顺序。 */
export async function fetchPlaylist(
  dissid: string, cookie: QqCookie | null, options: QqOptions = DEFAULT_OPTIONS): Promise<QqPlaylist> {
  const url = buildUrl(PLAYLIST_URL, [
    ["type", "1"], ["json", "1"], ["utf8", "1"], ["onlysong", "0"],
    ["disstid", dissid], ["format", "json"], ["platform", "yqq.json"], ["needNewCode", "0"],
  ]);
  const root = await requestJson("GET", url, cookie, null, options);
  const code = asInt(path(root, "code"), 0);
  if (code !== 0) throw ProviderApiError.upstream(`QQ 音乐返回错误（${code}）`);
  const cdlist = path(root, "cdlist");
  if (!Array.isArray(cdlist) || cdlist.length === 0) {
    throw ProviderApiError.notFound("歌单不存在或不可访问，请确认歌单是公开状态");
  }

  const playlist = cdlist[0];
  const tracks: QqTrack[] = [];
  for (const song of elements(path(playlist, "songlist"))) {
    let id = text(song, "songid");
    if (javaIsBlank(id)) id = text(song, "songmid");
    let title = text(song, "songname");
    if (javaIsBlank(title)) title = text(song, "name");
    const artist = joinSingers(path(song, "singer"));
    const album = text(song, "albumname");
    const duration = asInt(path(song, "interval"), 0);
    const songType = hasField(song, "songtype") ? asInt(path(song, "songtype"), 0) : asInt(path(song, "type"), 0);
    const albumMid = text(song, "albummid");
    const artwork = javaIsBlank(albumMid) ? ""
      : "https://y.gtimg.cn/music/photo_new/T002R300x300M000" + albumMid + ".jpg";
    if (!javaIsBlank(id) && !javaIsBlank(title)) {
      tracks.push({
        providerTrackId: id,
        title,
        artist,
        album,
        durationSec: duration,
        artworkUrl: artwork,
        songType,
      });
    }
  }

  let owner = text(playlist, "nickname");
  if (javaIsBlank(owner)) owner = text(path(playlist, "creator"), "nickname");
  let name = text(playlist, "dissname");
  if (javaIsBlank(name)) name = "QQ 音乐歌单";
  return {
    id: dissid,
    name,
    description: text(playlist, "desc"),
    coverUrl: text(playlist, "logo"),
    owner,
    webUrl: "https://y.qq.com/n/ryqq/playlist/" + dissid,
    tracks,
  };
}

/* --------------------------------------------------------- 我的歌单列表 */

/** GET fcg_user_created_diss；limit 先夹到 [1,100]，再按闭区间末位传 e = capped - 1。 */
export async function listMyPlaylists(
  cookie: QqCookie, limit: number, options: QqOptions = DEFAULT_OPTIONS): Promise<QqPlaylistRef[]> {
  const capped = Math.max(1, Math.min(limit, 100));
  const url = buildUrl(CREATED_DISS_URL, [
    ["loginUin", cookie.uin], ["hostUin", "0"], ["format", "json"], ["inCharset", "utf8"],
    ["outCharset", "utf-8"], ["notice", "0"], ["platform", "yqq.json"], ["needNewCode", "0"],
    ["pic", "1"], ["sin", "0"], ["e", String(capped - 1)],
  ]);
  const root = await requestJson("GET", url, cookie, null, options);
  const code = asInt(path(root, "code"), 0);
  if (code !== 0) throw businessError(code);
  const dirs = path(path(root, "data"), "vec_diss");
  if (!Array.isArray(dirs)) {
    throw ProviderApiError.upstream("QQ 音乐未返回歌单列表，请改用粘贴歌单链接");
  }
  return parseCreatedDiss(dirs, capped);
}

/** 纯函数：vec_diss -> PlaylistRef[]；无 disstid 的脏数据跳过，够 limit 就停。 */
export function parseCreatedDiss(dirs: Json, limit: number): QqPlaylistRef[] {
  const refs: QqPlaylistRef[] = [];
  for (const dir of elements(dirs)) {
    if (refs.length >= limit) break;
    const dissId = text(dir, "disstid");
    if (javaIsBlank(dissId)) continue;
    let title = text(dir, "title");
    if (javaIsBlank(title)) title = "QQ 歌单 " + dissId;
    const coverMid = text(pathIndex(path(dir, "covermidts"), 0), "cover_mid");
    const cover = javaIsBlank(coverMid) ? ""
      : "https://y.gtimg.cn/music/photo_new/T002R300x300M000" + coverMid + ".jpg";
    refs.push({
      id: dissId,
      name: title,
      url: "https://y.qq.com/n/ryqq/playlist/" + dissId,
      coverUrl: cover,
      trackCount: asInt(path(dir, "song_count"), 0),
    });
  }
  return refs;
}

/* ------------------------------------------------------------ Cookie 校验 */

/**
 * music.srfDissInfo.DissInfo/CgiGetDiss：401 必须上抛（前端靠它触发重新授权），
 * 其它错误 Java 只记 WARN 后放过，本函数同样放过。返回值恒为 maskedUin。
 */
export async function validate(cookie: QqCookie, options: QqOptions = DEFAULT_OPTIONS): Promise<string> {
  const param: Record<string, JsonValue> = {
    disstid: 0, dirid: 201, tag: true, song_begin: 0, song_num: 1, userinfo: true, orderlist: true,
  };
  try {
    await call(cookie, "music.srfDissInfo.DissInfo", "CgiGetDiss", param, options);
  } catch (error) {
    if (error instanceof ProviderApiError) {
      if (error.status === 401) throw error;
      return maskedUin(cookie);
    }
    throw error;
  }
  return maskedUin(cookie);
}

/* ---------------------------------------------------------------- 搜索 */

/**
 * 两路候选：smartbox（GET，不带 Cookie）先入、musicu（POST，不带 Cookie，且不套 comm 信封）后入，
 * 同 id 先到先得（LinkedHashMap 语义）；两路都失败才抛最后那个错误。
 */
export async function searchTracks(
  title: string | null | undefined, artist: string | null | undefined,
  limit: number, options: QqOptions = DEFAULT_OPTIONS): Promise<QqTrack[]> {
  if (javaIsBlank(title)) return [];
  const candidates = new Map<string, QqTrack>();
  let anySuccess = false;
  let lastError: unknown = null;

  try {
    await collectSmartbox(title as string, candidates, options);
    anySuccess = true;
  } catch (error) {
    lastError = error;
  }
  try {
    const query = javaTrim(`${title} ${artist === null || artist === undefined ? "" : artist}`);
    await collectMusicuSearch(query, limit, candidates, options);
    anySuccess = true;
  } catch (error) {
    lastError = error;
  }

  if (!anySuccess && lastError !== null) throw lastError;
  return Array.from(candidates.values()).slice(0, Math.max(1, limit));
}

function addCandidate(
  candidates: Map<string, QqTrack>, id: string, title: string, artist: string,
  album: string, duration: number, songType: number): void {
  if (javaIsBlank(id) || javaIsBlank(title) || candidates.has(id)) return;
  candidates.set(id, {
    providerTrackId: id,
    title,
    artist,
    album,
    durationSec: duration,
    artworkUrl: "",
    songType,
  });
}

async function collectSmartbox(
  title: string, candidates: Map<string, QqTrack>, options: QqOptions): Promise<void> {
  const url = buildUrl(SMARTBOX_URL, [
    ["key", title], ["format", "json"], ["inCharset", "utf-8"], ["outCharset", "utf-8"],
    ["platform", "yqq.json"],
  ]);
  const root = await requestJson("GET", url, null, null, options);
  const itemlist = path(path(path(root, "data"), "song"), "itemlist");
  for (const song of elements(itemlist)) {
    // smartbox 的 singer 是数组，Jackson asText 对容器给 ""，所以这里 artist 恒为空串（实测）。
    addCandidate(candidates, text(song, "id"), text(song, "name"), text(song, "singer"), "", 0, 0);
  }
}

async function collectMusicuSearch(
  query: string, limit: number, candidates: Map<string, QqTrack>, options: QqOptions): Promise<void> {
  const blockName = "music.search.SearchCgiService";
  const body: Record<string, JsonValue> = {
    [blockName]: {
      module: blockName,
      method: "DoSearchForQQMusicDesktop",
      param: {
        search_type: 0,
        query,
        page_num: 1,
        num_per_page: Math.max(limit, 8),
      },
    },
  };
  const response = await requestJson("POST", MUSICU_URL, null, stringifyJson(body), options);
  const searchBlock = path(response, blockName);
  const code = asInt(path(searchBlock, "code"), 0);
  if (code !== 0) throw businessError(code);
  const list = path(path(path(path(searchBlock, "data"), "body"), "song"), "list");
  for (const song of elements(list)) {
    let id = text(song, "id");
    if (javaIsBlank(id)) id = text(song, "songid");
    let name = text(song, "name");
    if (javaIsBlank(name)) name = text(song, "title");
    addCandidate(candidates, id, name, joinSingers(path(song, "singer")),
      text(path(song, "album"), "name"), 0, asInt(path(song, "type"), 0));
  }
}

/* ------------------------------------------------------------ 歌单写入 */

export async function createPlaylist(
  cookie: QqCookie, name: string | null | undefined, description: string | null | undefined,
  options: QqOptions = DEFAULT_OPTIONS): Promise<QqCreatedPlaylist> {
  const param: Record<string, JsonValue> = {
    dirName: truncateCodePoints(name, 20),
    dirDesc: truncateCodePoints(description, 80),
    dirPicUrl: "",
    taglist: "",
    dirShow: 2,
  };
  const block = await call(cookie, "music.musicasset.PlaylistBaseWrite", "AddPlaylist", param, options);
  const data = path(block, "data");
  const result = isObjectNode(path(data, "result")) ? path(data, "result") : data;
  let dirId = text(result, "dirId");
  if (javaIsBlank(dirId)) dirId = text(data, "dirId");
  let tid = text(result, "tid");
  if (javaIsBlank(tid)) tid = text(data, "tid");
  if (javaIsBlank(dirId)) throw ProviderApiError.upstream("QQ 音乐未返回新歌单 ID，请稍后重试");
  let finalName = text(result, "dirName");
  if (javaIsBlank(finalName)) finalName = truncateCodePoints(name, 20);
  // Java 用 Map.of("tid",...,"dirId",...)，顺序本就未定义；这里按 Java 源码书写顺序保留。
  return {
    id: dirId,
    name: finalName,
    url: "https://y.qq.com/n/ryqq/playlist/" + dirId,
    trackCount: 0,
    metadata: { tid, dirId },
  };
}

/** POST music.musicasset.PlaylistDetailWrite/AddSonglist，按 batchSize 分批，批间 sleep requestIntervalMs。 */
export async function addTracks(
  cookie: QqCookie, playlist: QqCreatedPlaylist, tracks: QqTrack[],
  options: QqOptions = DEFAULT_OPTIONS): Promise<void> {
  if (tracks.length === 0) return;
  const tid = playlist.metadata?.tid ?? "";
  if (javaIsBlank(tid)) {
    throw ProviderApiError.upstream("QQ 音乐未返回歌单 tid，无法写入歌曲，请重新迁移");
  }
  const dirId = parseJavaLong(playlist.id);
  if (dirId === null) throw ProviderApiError.upstream("QQ 音乐返回的歌单 ID 无法识别");

  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
  const wait = options.sleep ?? sleepMs;
  const interval = options.requestIntervalMs ?? DEFAULT_REQUEST_INTERVAL_MS;
  for (let start = 0; start < tracks.length; start += batchSize) {
    const end = Math.min(start + batchSize, tracks.length);
    const songInfo: JsonValue[] = [];
    for (const track of tracks.slice(start, end)) {
      const songId = parseJavaLong(track.providerTrackId);
      if (songId === null) {
        throw ProviderApiError.upstream("QQ 歌曲 ID 无法识别：" + track.providerTrackId);
      }
      songInfo.push({ songId, songType: track.songType });
    }
    const param: Record<string, JsonValue> = { dirId, tid, bFmtUtf8: true, v_songInfo: songInfo };
    await call(cookie, "music.musicasset.PlaylistDetailWrite", "AddSonglist", param, options);
    if (end < tracks.length) await wait(interval);
  }
}

/** Long.parseLong 的接受集（实测）：可选符号 + 纯数字且落在 int64 内；" 12 "、"12.0"、"1e3"、越界都拒。 */
export function parseJavaLong(raw: string): bigint | null {
  if (!/^[+-]?\d+$/.test(raw)) return null;
  const value = BigInt(raw);
  return value < -(2n ** 63n) || value > 2n ** 63n - 1n ? null : value;
}

/* ------------------------------------------------------ Provider 层封装 */

/**
 * QQ 音乐演示通道（demo.ts）未注入。不是"没实现"：DemoCatalog/DemoStore 已在 demo.ts 移植，
 * 只是这里需要一个显式的注入点。
 */
function demoNotPorted(): ProviderApiError {
  return ProviderApiError.notConfigured(
    "QQ 音乐演示通道未注入：请在 QqOptions.demoProvider 传入 demo.ts 的 createDemoProvider(\"QQ_MUSIC\", state)");
}

function credentialOf(connection: QqConnection | null | undefined, key: string): string | undefined {
  return connection?.credentials?.[key];
}

function isDemo(connection: QqConnection | null | undefined): boolean {
  return connection !== null && connection !== undefined && connection.mode === "DEMO";
}

/** 只查 null/undefined：Java 侧签名是 String，但 JS 调用方可能把缺失字段传成 null。 */
function jsIsNullish(value: unknown): boolean {
  return value === null || value === undefined;
}

/**
 * 演示通道注入点。demo.ts 用只读域模型、本文件用可写域模型，字段与 Java record 完全一致，
 * 差异只在类型层，运行时是同一批对象。
 */
function demoOf(options: QqOptions): DemoMusicProvider | null {
  return options.demoProvider === undefined ? null : options.demoProvider;
}

/**
 * DEMO 连接的统一处置：注入了 demo.ts 就交回它（它会自己按 Java 检查 demoSessionId），
 * 没注入时保留 Java 的判定顺序——先「会话已过期」409，再 503 提示注入点。
 */
function demoDispatch<T>(
  connection: QqConnection, options: QqOptions, run: (demo: DemoMusicProvider) => T): T {
  const demo = demoOf(options);
  if (demo) return run(demo);
  if (javaIsBlank(credentialOf(connection, "demoSessionId"))) {
    throw ProviderApiError.notConnected("演示会话已过期，请重新连接演示账号");
  }
  throw demoNotPorted();
}

/** MusicProvider#connectReal：先解析 Cookie（400 在这一层），再校验登录态（401 在这一层）。 */
export async function qqConnectReal(
  credentials: Record<string, string>, options: QqOptions = DEFAULT_OPTIONS): Promise<QqConnection> {
  const cookie = parseQqCookie(credentials.cookie);
  const masked = await validate(cookie, options);
  return {
    provider: "QQ_MUSIC",
    mode: "REAL",
    accountName: "QQ 音乐 · " + masked,
    credentials: { cookie: cookie.rawCookie },
  };
}

/** MusicProvider#connectDemo：Java 这里只做 Map.of，不校验 sessionId；409 延后到使用该连接的接口。 */
export function qqConnectDemo(sessionId: string): QqConnection {
  // Map.of(key, null) 抛未捕获 NPE → 全局兜底 500 INTERNAL_ERROR；空串/空白在 Java 侧是合法的。
  if (jsIsNullish(sessionId)) throw internalError();
  return {
    provider: "QQ_MUSIC",
    mode: "DEMO",
    accountName: "演示账号 · 阿桥",
    credentials: { demoSessionId: sessionId },
  };
}

/** MusicProvider#fetchPlaylist：demo:// 与模式互斥检查在前，Cookie 解析先于链接解析，且 connection=null 时不带 Cookie 头。 */
export async function qqFetchPlaylist(
  connection: QqConnection | null | undefined, url: string | null | undefined,
  options: QqOptions = DEFAULT_OPTIONS): Promise<QqPlaylist> {
  if (url !== null && url !== undefined && url.startsWith("demo://")) {
    // 注入 demo.ts 后整条 demo:// 分支交回它：400「需要先连接演示账号」、409「会话已过期」、
    // 400「链接无法识别」以及 builtin / library/<id> 取数都按 Java 实现过，本文件不再重复一份。
    const demo = demoOf(options);
    if (demo) return demo.fetchPlaylist(connection as never, url as never) as unknown as QqPlaylist;
    if (connection === null || connection === undefined || connection.mode !== "DEMO") {
      throw ProviderApiError.badRequest("演示歌单链接需要先连接 QQ 音乐演示账号");
    }
    if (javaIsBlank(credentialOf(connection, "demoSessionId"))) {
      throw ProviderApiError.notConnected("演示会话已过期，请重新连接演示账号");
    }
    // 没注入时也要保住 Java 的判定顺序：能否识别链接只是字符串判断，与演示通道无关。
    if (url !== "demo://builtin" && url !== "demo://playlist/builtin" && !url.startsWith("demo://library/")) {
      throw ProviderApiError.badRequest("演示歌单链接无法识别，请使用 demo://builtin 或演示音乐库中的歌单");
    }
    throw demoNotPorted();
  }
  if (isDemo(connection)) {
    throw ProviderApiError.badRequest("当前是演示连接，请使用演示歌单链接，或切换为真实 QQ 音乐连接");
  }
  const cookie = connection === null || connection === undefined ? null : parseQqCookie(credentialOf(connection, "cookie"));
  return fetchPlaylist(parsePlaylistId(url), cookie, options);
}

/** MusicProvider#listPlaylists（REAL 走 fcg_user_created_diss，limit 固定 50）。 */
export async function qqListPlaylists(
  connection: QqConnection | null | undefined, options: QqOptions = DEFAULT_OPTIONS): Promise<QqPlaylistRef[]> {
  if (connection === null || connection === undefined) {
    throw ProviderApiError.notConnected("请先连接 QQ 音乐（来源平台）");
  }
  if (isDemo(connection)) {
    // Java: DemoPlaylists.of(demoCatalog, demoStore, QQ_MUSIC, sessionId(connection))
    return demoDispatch(connection as QqConnection, options, (demo) =>
      demo.listPlaylists(connection as never) as unknown as QqPlaylistRef[]);
  }
  return listMyPlaylists(parseQqCookie(credentialOf(connection, "cookie")), SOURCE_LIST_LIMIT, options);
}

/** MusicProvider#searchTracks：搜索本身不需要 Cookie；DEMO 连接读演示目标曲库。 */
export async function qqSearchTracks(
  connection: QqConnection | null | undefined, title: string, artist: string,
  limit: number, options: QqOptions = DEFAULT_OPTIONS): Promise<QqTrack[]> {
  if (isDemo(connection)) {
    // Java 的 DEMO 分支是 demoCatalog.targetCatalog(QQ_MUSIC)，不读 demoSessionId，
    // 入参 title/artist/limit 全被忽略——demo.ts 同样如此，所以这里不检查会话、也不透传三个入参。
    const demo = demoOf(options);
    if (demo) return demo.searchTracks(connection as never, title, artist, limit) as unknown as QqTrack[];
    throw demoNotPorted();
  }
  return searchTracks(title, artist, limit, options);
}

export async function qqCreatePlaylist(
  connection: QqConnection | null | undefined, name: string, description: string,
  options: QqOptions = DEFAULT_OPTIONS): Promise<QqCreatedPlaylist> {
  if (connection === null || connection === undefined) {
    throw ProviderApiError.notConnected("请先连接 QQ 音乐（目标平台）");
  }
  if (isDemo(connection)) {
    // Java: demoStore.create(sessionId(connection), QQ_MUSIC, name, description)
    //       再 CreatedPlaylist.of(id, name, webUrl, 0)
    return demoDispatch(connection as QqConnection, options, (demo) =>
      demo.createPlaylist(connection as never, name, description) as unknown as QqCreatedPlaylist);
  }
  return createPlaylist(parseQqCookie(credentialOf(connection, "cookie")), name, description, options);
}

export async function qqAddTracks(
  connection: QqConnection | null | undefined, playlist: QqCreatedPlaylist, tracks: QqTrack[],
  options: QqOptions = DEFAULT_OPTIONS): Promise<void> {
  if (connection === null || connection === undefined) {
    throw ProviderApiError.notConnected("请先连接 QQ 音乐（目标平台）");
  }
  if (isDemo(connection)) {
    // Java: demoStore.addTracks(sessionId(connection), QQ_MUSIC, playlist.id(), tracks)
    return demoDispatch(connection as QqConnection, options, (demo) =>
      demo.addTracks(connection as never, playlist as never, tracks as never));
  }
  await addTracks(parseQqCookie(credentialOf(connection, "cookie")), playlist, tracks, options);
}

export const qqSampleUrl = (): string => SAMPLE_URL;
