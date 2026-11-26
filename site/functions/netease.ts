import { formBody, params } from "./eapi.ts";
import { ProviderApiError } from "./errors.ts";

/**
 * 网易云 eapi 网页端通道的 TypeScript 移植。
 * 与 Java 侧 NeteaseWebClient 对齐：同一条 eapi 路径、同一套签名、同一组请求头、
 * 同一套"候选可用性优先 / 405 才算限流 / 缺 songs 是契约破坏"的判定顺序。
 *
 * 关键差异（边缘运行时无请求级长睡）：搜索不在函数里退避，而是把"何时重试"作为结果返回，
 * 由任务状态机安排下一次调用。这样 8s / 25s 的等待不会占住一次函数请求。
 */

const BASE = "https://music.163.com";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
  + "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const MAX_TRACKS = 200;
const BATCH_SIZE = 20;
const READ_TIMEOUT_MS = 25_000;
const RETRY_BASE_MS = 8_000;
const UNVERIFIED = "网易云歌单写入结果未确认，请到网易云客户端核对后再决定是否重试";

export type SearchOutcome =
  | { kind: "candidates"; tracks: NetTrack[] }
  | { kind: "empty" }
  | { kind: "throttled"; retryAfterMs: number; detail: string }
  | { kind: "rejected"; message: string };

export type NetTrack = {
  providerTrackId: string;
  title: string;
  artist: string;
  album: string;
  durationSec: number;
  artworkUrl: string;
  /** QQ 搜索会带回 songtype；网易云候选不填，写入时默认 0。 */
  songType?: number;
};

export type CreatedPlaylist = { id: string; name: string; url: string };

type Reply = { status: number; body: string; setCookies: string[] };

export class NeteaseClient {
  private readonly deviceId: string;
  private readonly fetchImpl: typeof fetch;

  constructor(deviceId: string, fetchImpl: typeof fetch = fetch) {
    this.deviceId = deviceId;
    this.fetchImpl = fetchImpl;
  }

  private async post(apiPath: string, values: Record<string, unknown>, cookie: string): Promise<Reply> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(BASE + "/eapi" + apiPath.slice("/api".length), {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": USER_AGENT,
          referer: BASE + "/",
          origin: BASE,
          ...(cookie ? { cookie } : {}),
        },
        body: await formBody(apiPath, values as Record<string, string | number>),
        signal: controller.signal,
        // 凭据只在服务端与上游之间流动，绝不回传浏览器。
        redirect: "manual",
      });
      const text = await response.text();
      return {
        status: response.status,
        body: text,
        setCookies: response.headers.getSetCookie ? response.headers.getSetCookie() : [],
      };
    } catch (error) {
      throw ProviderApiError.upstream("网易云响应超时或不可达，请稍后重试");
    } finally {
      clearTimeout(timer);
    }
  }

  private async json(apiPath: string, values: Record<string, unknown>, cookie: string): Promise<JsonData> {
    const reply = await this.post(apiPath, values, cookie);
    if (reply.status < 200 || reply.status >= 300) {
      throw ProviderApiError.upstream("网易云返回 HTTP " + reply.status);
    }
    try {
      return JSON.parse(reply.body || "{}") as JsonData;
    } catch {
      throw ProviderApiError.upstream("网易云响应格式无效");
    }
  }

  /** 写操作必须带上 Cookie 里的 __csrf，留空会被判 403 illegal request。 */
  private body(cookie: string, extra: Record<string, unknown>): Record<string, unknown> {
    const values: Record<string, unknown> = { ...params(this.deviceId, csrfToken(cookie)), ...extra };
    return values;
  }

  async accountName(cookie: string): Promise<string> {
    const body = await this.json("/api/nuser/account/get", this.body(cookie, {}), cookie);
    const account = pick(body, "account");
    if (!account) throw ProviderApiError.unauthorized("网易云登录态无效，请重新扫码");
    const nickname = text(account, "nickname");
    return nickname || "网易云用户";
  }

  /** 单次尝试；是否重试由调用方根据 outcome 决定。 */
  async search(cookie: string, title: string, artist: string, limit: number): Promise<SearchOutcome> {
    const keyword = ((title || "").trim() + " " + (artist || "").trim()).trim();
    if (!keyword) return { kind: "empty" };
    const capped = Math.max(1, Math.min(30, limit));
    const body = await this.json("/api/cloudsearch/pc",
      this.body(cookie, { s: keyword, type: 1, limit: capped, offset: 0, total: "false" }), cookie);
    const result = pick(body, "result");
    const songs = result ? arr(result, "songs") : null;

    if (songs && songs.length > 0) return { kind: "candidates", tracks: toTracks(songs, capped) };

    const code = businessCode(body);
    if (code === "405") {
      return { kind: "throttled", retryAfterMs: RETRY_BASE_MS, detail: describeRejection(body) };
    }
    if (code && code !== "200") {
      return { kind: "rejected", message: "网易云搜索失败（" + describeRejection(body) + "）" };
    }
    if (!songs) {
      return { kind: "rejected", message: "网易云搜索响应格式无效（" + describeRejection(body) + "）" };
    }
    return { kind: "empty" };
  }

  async createPlaylist(cookie: string, name: string): Promise<CreatedPlaylist> {
    const values = this.body(cookie, { name, privacy: "0" });
    const body = await this.json("/api/playlist/create", values, cookie);
    const id = firstNonBlank(text(body, "id"), text(pick(body, "playlist"), "id"), text(pick(body, "data"), "id"));
    if (!id) {
      const hint = csrfToken(cookie) ? "" : "，Cookie 中缺少 __csrf";
      throw ProviderApiError.upstream("网易云未返回新歌单 ID（" + describeRejection(body) + hint + "）");
    }
    return { id, name: text(pick(body, "playlist"), "name") || name, url: BASE + "/#/playlist?id=" + id };
  }

  /**
   * 分批写入，全部落批后回读一次校验（与 Java 一致）。
   * 中途遇到 405 不再抛成"未知失败"，而是返回已落库的前缀，让任务层从断点续跑 —— 这也是
   * issue #7 要的续跑原语：重试时只需补写剩余曲目，不必整单重来。
   */
  async addTracks(
      cookie: string, playlistId: string, tracks: NetTrack[]):
      Promise<{ kind: "written"; count: number } | { kind: "throttled"; written: number; retryAfterMs: number }> {
    if (!playlistId) throw ProviderApiError.badRequest("网易云歌单无效");
    if (tracks.length > MAX_TRACKS) throw ProviderApiError.badRequest("网易云单次最多写入 " + MAX_TRACKS + " 首");
    const ids = tracks.map(track => {
      if (!track.providerTrackId) throw ProviderApiError.badRequest("网易云歌曲 ID 无效");
      return track.providerTrackId;
    });
    if (new Set(ids).size !== ids.length) throw ProviderApiError.badRequest("待写入的歌曲里有重复项");
    if (ids.length === 0) return { kind: "written", count: 0 };

    for (let start = 0; start < ids.length; start += BATCH_SIZE) {
      const batch = ids.slice(start, start + BATCH_SIZE);
      const body = await this.json("/api/playlist/manipulate/tracks", this.body(cookie, {
        op: "add",
        pid: playlistId,
        trackIds: JSON.stringify(batch),
        d: playlistId,
      }), cookie);
      const code = Number(businessCode(body) || "0");
      if (code === 405) {
        return { kind: "throttled", written: start, retryAfterMs: RETRY_BASE_MS };
      }
      if (code !== 200) {
        throw ProviderApiError.upstream("网易云拒绝了此次写入（业务码 " + code + "），可能触发风控，请稍后重试");
      }
    }
    await this.verify(cookie, playlistId, ids);
    return { kind: "written", count: ids.length };
  }

  private async verify(cookie: string, playlistId: string, expected: string[]): Promise<void> {
    const values = { ...params(this.deviceId, ""), id: playlistId, n: "0", s: "1" };
    const body = await this.json("/api/v6/playlist/detail", values, cookie);
    const playlist = pick(body, "playlist");
    if (!playlist) throw ProviderApiError.upstream(UNVERIFIED);
    let present = (arr(playlist, "trackIds") || []).map(entry => text(entry ?? {}, "id")).filter(Boolean);
    if (present.length === 0) {
      present = (arr(playlist, "tracks") || []).map(track => text(track ?? {}, "id")).filter(Boolean);
    }
    const have = new Set(present);
    if (!expected.every(id => have.has(id))) {
      throw ProviderApiError.upstream(UNVERIFIED);
    }
  }
}

/* ---------------- 与 Java 侧逐条对齐的小工具 ---------------- */

type JsonData = Record<string, unknown>;

function pick(node: JsonData | null | undefined, key: string): JsonData | null {
  const value = node?.[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonData : null;
}

function arr(node: JsonData, key: string): JsonData[] | null {
  const value = node[key];
  return Array.isArray(value) ? value as JsonData[] : null;
}

function text(node: JsonData | null | undefined, key: string): string {
  const value = node?.[key];
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function firstNonBlank(...values: string[]): string {
  return values.find(value => !!value) || "";
}

export function csrfToken(cookie: string): string {
  if (!cookie) return "";
  for (const part of cookie.split(";")) {
    const pair = part.trim();
    if (pair.startsWith("__csrf=")) return pair.slice("__csrf=".length);
  }
  return "";
}

function businessCode(body: JsonData): string {
  return firstNonBlank(text(pick(body, "header"), "code"), text(body, "code"));
}

/** 网易云把拒因放在 header.code/msg，顶层只是兜底；风控命中时这是唯一线索，不能吞掉。 */
function describeRejection(body: JsonData): string {
  const header = pick(body, "header");
  const code = businessCode(body);
  const message = firstNonBlank(text(header, "msg"), text(body, "msg"));
  if (!code && !message) {
    const names = Object.keys(body).slice(0, 6);
    return names.length === 0 ? "无业务码，响应为空" : "无业务码，字段 " + names.join("/");
  }
  const trimmed = message.length > 80 ? message.slice(0, 80) : message;
  return trimmed ? "业务码 " + (code || "-") + "：" + trimmed : "业务码 " + (code || "-");
}

/** 实测 cloudsearch 候选不下发 visible / noCopyrightRcmd，可播性只看 privilege.st == -200。 */
function isUnplayable(song: JsonData): boolean {
  const privilege = pick(song, "privilege");
  return Number(privilege?.st ?? 0) === -200;
}

function firstObject(song: JsonData, ...keys: string[]): JsonData | null {
  for (const key of keys) {
    const value = pick(song, key);
    if (value) return value;
  }
  return null;
}

function artistNames(song: JsonData): string[] {
  for (const key of ["artists", "ar"]) {
    const list = arr(song, key);
    if (!list) continue;
    const names = list
      .map(item => firstNonBlank(text(item, "name"), text(item, "artistName")))
      .filter(Boolean);
    if (names.length) return names;
  }
  return [];
}

function toTracks(songs: JsonData[], capped: number): NetTrack[] {
  const found: NetTrack[] = [];
  for (const song of songs) {
    if (isUnplayable(song)) continue;
    const id = text(song, "id");
    const name = text(song, "name");
    if (!id || !name) continue;
    const albumNode = firstObject(song, "album", "al");
    const duration = typeof song.duration === "number" ? song.duration : Number(song.dt ?? 0);
    found.push({
      providerTrackId: id,
      title: name,
      artist: artistNames(song).join(" / "),
      album: text(albumNode, "name"),
      durationSec: Math.max(0, Math.floor(duration / 1000)),
      artworkUrl: firstNonBlank(text(song, "arturl"), text(albumNode, "picUrl")),
    });
    if (found.length === capped) break;
  }
  return found;
}

export const NETEASE_LIMITS = { MAX_TRACKS, BATCH_SIZE };
