/**
 * demo.ts —— 演示通道（DEMO mode）的 TypeScript 等价实现。
 *
 * 对应 Java 侧：
 *   com.tunebridge.provider.demo.DemoCatalog      → 本文件的曲库常量 + demoBuiltin() / demoTargetCatalog()
 *   com.tunebridge.provider.demo.DemoStore        → createDemoStore()（状态由上层注入，见下方「会话状态」）
 *   com.tunebridge.provider.demo.DemoPlaylists    → demoPlaylistRefs()
 *   QqMusicProvider / AppleMusicProvider / NeteaseMusicProvider 中 `mode == DEMO` 的分支
 *                                                 → createDemoProvider() / createDemoProviders()
 *   web.dto.PlaylistView（/api/demo/library 的响应体）→ demoPlaylistView()
 *
 * 全部行为均以本机 jshell 直接调用生产 Java 代码取到的真值对齐（见 dev/verify-demo.mjs）：
 *   · 演示模式的 searchTracks 完全忽略 title / artist / limit，直接返回整张目标曲库
 *     （MigrationService 每首传 limit=6，Java 同样返回全量，由 TrackMatcher 本地打分）。
 *   · 网易云即使连着演示账号也不作为来源：fetchPlaylist / listPlaylists 一律 INVALID_INPUT(400)。
 *   · QQ / Apple 的演示分支只判断 `mode == DEMO`，**不校验 provider**；网易云额外校验 provider。
 *     这个不对称是 Java 现状，本文件照搬，不做"修正"。
 *   · 建歌单 id = "demo-" + 自增序号（序号跨会话、跨平台共享，只增不减），url = webUrl = "demo://library/<id>"。
 *   · addTracks 追加合并、允许重复 providerTrackId、找不到歌单时抛错，且按 (sessionId, provider) 隔离。
 *
 * ── 会话状态：本模块**没有解决**的部分（阻塞点，交由上层） ─────────────────────────────
 * Java 的 DemoStore 是 Spring 单例：进程内 `ConcurrentHashMap<sessionId, Map<ProviderId, List<Playlist>>>`
 * + `AtomicInteger`（初值 1000），生命周期靠 HttpSessionListener 在 sessionDestroyed 时 clear()。
 * 边缘函数运行时是请求级、无状态、实例随时回收的，不存在等价的进程级可变单例。
 * 所以这里把状态做成**注入的纯数据对象** DemoStoreState：
 *   · 上层在每次请求开始时提供（新对象 = 空库；或从 Sites DB/KV 反序列化而来）；
 *   · 写操作就地修改它；请求结束后是否回写、回写到哪、如何按 sessionId 取回，全部由上层决定；
 *   · 未提供状态（null）时，涉及演示库的操作直接抛 ProviderApiError.notConfigured，绝不静默退化成"看起来成功"。
 * 未实现且需要上层拍板：跨请求持久化、sessionId ↔ 演示库 的绑定与过期清理、序号的并发分配。
 *
 * ── 其它边界 ────────────────────────────────────────────────────────────────
 *   · REAL 模式（真实平台接口）不在本模块内，命中即抛 notConfigured(503)，由对应 provider 模块接管。
 *   · TrackMatcher 的打分、MigrationService 的任务状态机 / JobView 不在本模块内。
 *
 * 错误映射（errors.ts 已与 Java ProviderException + ApiExceptionHandler 逐码对齐，因此这里是一一对应，无降级）：
 *   ProviderException.badRequest   400 INVALID_INPUT  → ProviderApiError.badRequest    400 INVALID_INPUT
 *   IllegalArgumentException       400 INVALID_INPUT  → ProviderApiError.badRequest    400 INVALID_INPUT
 *     （Java ApiExceptionHandler 把 IllegalArgumentException 也映射成 400 + INVALID_INPUT）
 *   ProviderException.notConnected 409 NOT_CONNECTED   → ProviderApiError.notConnected  409 NOT_CONNECTED
 *   真实通道未实现 / 演示库状态未注入（本模块边界）      → ProviderApiError.notConfigured 503 NOT_CONFIGURED
 */

import { ProviderApiError } from "./errors.ts";

/* ---------------- domain（对应 com.tunebridge.domain 的 record） ---------------- */

export type ProviderId = "QQ_MUSIC" | "APPLE_MUSIC" | "NETEASE_MUSIC";
export type ConnectionMode = "DEMO" | "REAL";

/** Track 的字段顺序即 Java record 的分量顺序，序列化后的键顺序以此为准。 */
export interface Track {
  readonly providerTrackId: string;
  readonly title: string;
  readonly artist: string;
  readonly album: string;
  readonly durationSec: number;
  readonly artworkUrl: string;
  readonly songType: number;
}

export interface Playlist {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly coverUrl: string;
  readonly owner: string;
  readonly webUrl: string;
  readonly tracks: readonly Track[];
}

export interface PlaylistRef {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly coverUrl: string;
  readonly trackCount: number;
}

export interface CreatedPlaylist {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly trackCount: number;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface ProviderConnection {
  readonly provider: ProviderId;
  readonly mode: ConnectionMode;
  readonly accountName: string;
  readonly credentials: Readonly<Record<string, string>>;
}

/** Java record 的紧凑构造器把 null 归一成 ""，这里等价。 */
function safe(value: string | null | undefined): string {
  return value === null || value === undefined ? "" : value;
}

/** new Track(providerTrackId, title, artist, album, durationSec, artworkUrl, songType) */
export function newTrack(
  providerTrackId: string,
  title: string,
  artist: string,
  album: string,
  durationSec: number,
  artworkUrl: string = "",
  songType: number = 0,
): Track {
  return Object.freeze({
    providerTrackId: safe(providerTrackId),
    title: safe(title),
    artist: safe(artist),
    album: safe(album),
    durationSec,
    artworkUrl: safe(artworkUrl),
    songType,
  });
}

/** Track.of(id, title, artist, album, durationSec) —— artworkUrl=""、songType=0。 */
export function trackOf(id: string, title: string, artist: string, album: string, durationSec: number): Track {
  return newTrack(id, title, artist, album, durationSec, "", 0);
}

/** new Playlist(id, name, description, coverUrl, owner, webUrl, tracks) */
export function newPlaylist(
  id: string,
  name: string,
  description: string,
  coverUrl: string,
  owner: string,
  webUrl: string,
  tracks: readonly Track[] | null,
): Playlist {
  return Object.freeze({
    id: safe(id),
    name: safe(name),
    description: safe(description),
    coverUrl: safe(coverUrl),
    owner: safe(owner),
    webUrl: safe(webUrl),
    // List.copyOf(...)：Java 侧的歌单曲目列表不可变，且 builtin 的列表是共享实例。
    tracks: Object.freeze([...(tracks ?? [])]),
  });
}

/** new PlaylistRef(id, name, url, coverUrl, trackCount) —— trackCount 负数被夹到 0。 */
export function newPlaylistRef(
  id: string, name: string, url: string, coverUrl: string, trackCount: number,
): PlaylistRef {
  return Object.freeze({
    id: safe(id),
    name: safe(name),
    url: safe(url),
    coverUrl: safe(coverUrl),
    trackCount: Math.max(0, trackCount),
  });
}

/** CreatedPlaylist.of(id, name, url, trackCount) */
export function createdPlaylistOf(
  id: string, name: string, url: string, trackCount: number,
): CreatedPlaylist {
  return Object.freeze({
    id: safe(id),
    name: safe(name),
    url: safe(url),
    trackCount,
    metadata: Object.freeze({} as Record<string, string>),
  });
}

/* ---------------- ProviderId（对应 ProviderId.from / label） ---------------- */

export const PROVIDER_IDS: readonly ProviderId[] = Object.freeze(["QQ_MUSIC", "APPLE_MUSIC", "NETEASE_MUSIC"]);

export const PROVIDER_LABELS: Readonly<Record<ProviderId, string>> = Object.freeze({
  QQ_MUSIC: "QQ 音乐",
  APPLE_MUSIC: "Apple Music",
  NETEASE_MUSIC: "网易云音乐",
});

export function providerLabel(provider: ProviderId): string {
  return PROVIDER_LABELS[provider];
}

/**
 * Locale.ROOT 的大写映射：单字符映射照做，但 ß→SS 这类会改变长度的特殊扩展不做
 * （toUpperCase(Locale.ROOT) 只在存在单字符大写形式时才映射）。
 */
function upperRoot(value: string): string {
  let out = "";
  for (const ch of value) {
    const up = ch.toUpperCase();
    out += up.length === 1 ? up : ch;
  }
  return out;
}

/**
 * ProviderId.from(value)：trim → 大写(ROOT) → '-'、' ' 换成 '_' → 别名表。
 * 空值与未知值在 Java 里抛 IllegalArgumentException（HTTP 400 INVALID_INPUT）。
 */
export function providerIdFrom(value: string | null | undefined): ProviderId {
  if (value === null || value === undefined || value.trim() === "") {
    throw ProviderApiError.badRequest("请选择音乐平台");
  }
  const normalized = upperRoot(value.trim()).replace(/-/g, "_").replace(/ /g, "_");
  switch (normalized) {
    case "QQ": case "QQ_MUSIC": case "QQMUSIC":
      return "QQ_MUSIC";
    case "APPLE": case "APPLE_MUSIC": case "APPLEMUSIC":
      return "APPLE_MUSIC";
    case "NETEASE": case "NETEASE_MUSIC": case "NETEASEMUSIC": case "NCM":
      return "NETEASE_MUSIC";
    default:
      throw ProviderApiError.badRequest(`不支持的音乐平台：${value}`);
  }
}

/* ---------------- DemoCatalog ---------------- */

export const DEMO_BUILTIN_URL = "demo://builtin";
export const DEMO_BUILTIN_ALT_URL = "demo://playlist/builtin";
export const DEMO_LIBRARY_PREFIX = "demo://library/";

/** 演示会话 id 存在连接的 credentials.demoSessionId 里。 */
export const DEMO_SESSION_KEY = "demoSessionId";

/** MigrationService.match()：`sleep(realUpstream ? requestIntervalMs : 80)` —— 演示走 80ms，不吃配置的 120。 */
export const DEMO_REQUEST_INTERVAL_MS = 80;

const QQ_SOURCE_TRACKS: readonly Track[] = Object.freeze([
  trackOf("dq-1", "晴天", "周杰伦", "叶惠美", 269),
  trackOf("dq-2", "小半", "陈粒", "小梦大半", 297),
  trackOf("dq-3", "平凡之路", "朴树", "猎户星座", 302),
  trackOf("dq-4", "夜空中最亮的星", "逃跑计划", "世界", 252),
  trackOf("dq-5", "起风了", "买辣椒也用券", "起风了", 325),
  trackOf("dq-6", "漠河舞厅", "柳爽", "漠河舞厅", 333),
  trackOf("dq-7", "孤勇者", "陈奕迅", "孤勇者", 257),
  trackOf("dq-8", "稻香", "周杰伦", "魔杰座", 223),
  trackOf("dq-9", "海底", "一支榴莲", "海底", 276),
  trackOf("dq-10", "像风一样", "薛之谦", "渡", 247),
  trackOf("dq-11", "若把你", "KIV", "若把你", 214),
  trackOf("dq-12", "晚风心里吹", "阿梨粤", "晚风心里吹", 231),
]);

const APPLE_SOURCE_TRACKS: readonly Track[] = Object.freeze([
  trackOf("da-1", "Snow on the Beach", "Taylor Swift", "Midnights", 256),
  trackOf("da-2", "As It Was", "Harry Styles", "Harry's House", 167),
  trackOf("da-3", "凄美地", "郭顶", "飞行器的执行周期", 250),
  trackOf("da-4", "Sunset Lover", "Petit Biscuit", "Presence", 238),
  trackOf("da-5", "关于我爱你", "张悬", "城市", 305),
  trackOf("da-6", "I Love You So", "The Walters", "Songs for Dads", 160),
  trackOf("da-7", "水星记", "郭顶", "飞行器的执行周期", 325),
  trackOf("da-8", "Lover", "Taylor Swift", "Lover", 221),
  trackOf("da-9", "Golden Hour", "JVKE", "this is what ____ feels like", 209),
  trackOf("da-10", "浪漫手机", "周杰伦", "十一月的萧邦", 243),
]);

/** 只有 QQ 与 Apple 有内置来源歌单；网易云调用会抛（与 Java 一致）。 */
export const DEMO_BUILTIN_PLAYLISTS: Readonly<Partial<Record<ProviderId, Playlist>>> = Object.freeze({
  QQ_MUSIC: newPlaylist("demo-qq-builtin", "夏夜循环 · 华语流行", "QQ 音乐演示歌单",
    "", "演示账号 · 阿桥", DEMO_BUILTIN_URL, QQ_SOURCE_TRACKS),
  APPLE_MUSIC: newPlaylist("demo-apple-builtin", "Indie 深夜电台", "Apple Music 演示歌单",
    "", "演示账号 · Bridge", DEMO_BUILTIN_URL, APPLE_SOURCE_TRACKS),
});

const APPLE_TARGET_TRACKS: readonly Track[] = Object.freeze([
  newTrack("1440857781", "晴天 (Live)", "周杰伦", "地表最强世界巡回演唱会", 271, "", 0),
  newTrack("1440857792", "小半", "陈粒", "小梦大半", 297, "", 0),
  newTrack("1440857803", "平凡之路", "朴树", "猎户星座", 302, "", 0),
  newTrack("1440857814", "夜空中最亮的星", "逃跑计划", "世界", 252, "", 0),
  newTrack("1440857825", "起风了", "买辣椒也用券", "起风了", 325, "", 0),
  newTrack("1440857836", "漠河舞厅", "柳爽", "漠河舞厅", 333, "", 0),
  newTrack("1440857847", "孤勇者", "陈奕迅", "孤勇者", 257, "", 0),
  newTrack("1440857858", "稻香", "周杰伦", "魔杰座", 223, "", 0),
  newTrack("1440857869", "海底", "一支榴莲", "海底", 276, "", 0),
  newTrack("1440857870", "像风一样", "薛之谦", "渡", 247, "", 0),
  newTrack("1440857881", "七里香", "周杰伦", "七里香", 299, "", 0),
  newTrack("1440857892", "反方向的钟", "周杰伦", "Jay", 258, "", 0),
]);

const QQ_TARGET_TRACKS: readonly Track[] = Object.freeze([
  newTrack("97773", "Snow on the Beach", "Taylor Swift", "Midnights", 256, "", 0),
  newTrack("102065756", "As It Was", "Harry Styles", "Harry's House", 167, "", 0),
  newTrack("107762070", "凄美地", "郭顶", "飞行器的执行周期", 250, "", 0),
  newTrack("718475", "关于我爱你", "张悬", "城市", 305, "", 0),
  newTrack("5177680", "I Love You So", "The Walters", "Songs for Dads", 160, "", 0),
  newTrack("279917003", "水星记", "郭顶", "飞行器的执行周期", 325, "", 0),
  newTrack("279917248", "Lover", "Taylor Swift", "Lover", 221, "", 0),
  newTrack("501052971", "浪漫手机", "周杰伦", "十一月的萧邦", 243, "", 0),
  newTrack("482567808", "七里香", "周杰伦", "七里香", 299, "", 0),
  newTrack("279917247", "晴天", "周杰伦", "叶惠美", 269, "", 0),
  newTrack("279917301", "小半", "陈粒", "小梦大半", 297, "", 0),
  newTrack("279917302", "平凡之路", "朴树", "猎户星座", 302, "", 0),
  newTrack("279917303", "夜空中最亮的星", "逃跑计划", "世界", 252, "", 0),
  newTrack("279917304", "起风了", "买辣椒也用券", "起风了", 325, "", 0),
  newTrack("279917305", "漠河舞厅", "柳爽", "漠河舞厅", 333, "", 0),
  newTrack("279917306", "孤勇者", "陈奕迅", "孤勇者", 257, "", 0),
  newTrack("279917307", "稻香", "周杰伦", "魔杰座", 223, "", 0),
  newTrack("279917308", "海底", "一支榴莲", "海底", 276, "", 0),
  newTrack("279917309", "像风一样", "薛之谦", "渡", 247, "", 0),
  newTrack("279917310", "若把你", "KIV", "若把你", 214, "", 0),
  newTrack("279917311", "晚风心里吹", "阿梨粤", "晚风心里吹", 231, "", 0),
]);

/** 网易云复用 QQ 的同一份列表实例（Java: targetCatalogs.put(NETEASE, targetCatalogs.get(QQ))）。 */
export const DEMO_TARGET_CATALOGS: Readonly<Record<ProviderId, readonly Track[]>> = Object.freeze({
  QQ_MUSIC: QQ_TARGET_TRACKS,
  APPLE_MUSIC: APPLE_TARGET_TRACKS,
  NETEASE_MUSIC: QQ_TARGET_TRACKS,
});

/** DemoCatalog.builtin(provider)：网易云没有内置歌单，抛 IllegalArgumentException → 400。 */
export function demoBuiltin(provider: ProviderId): Playlist {
  const playlist = DEMO_BUILTIN_PLAYLISTS[provider];
  if (playlist === undefined) {
    throw ProviderApiError.badRequest("没有可用的演示歌单");
  }
  return playlist;
}

/** DemoCatalog.targetCatalog(provider)：未登记的平台返回空列表（Java 的 getOrDefault）。 */
export function demoTargetCatalog(provider: ProviderId): readonly Track[] {
  return DEMO_TARGET_CATALOGS[provider] ?? Object.freeze([]);
}

/* ---------------- DemoStore（状态注入式） ---------------- */

/**
 * Java DemoStore 的进程内状态等价物。刻意做成纯 JSON 可序列化的结构，方便上层
 * 自行决定存到哪里（Sites DB / KV / 只存活于本次请求），本模块不发明持久化方案。
 * sequence 对应 AtomicInteger：初值 1000，create 先自增再取用，所以第一个 id 是 demo-1001。
 */
export interface DemoStoreState {
  /** sessionId -> providerId -> 该会话该平台已创建的演示歌单（按创建顺序）。 */
  sessions: Record<string, Partial<Record<ProviderId, Playlist[]>>>;
  /** 全局单调递增序号；上层若换成持久化计数器，需要自己在回写时保证不重号。 */
  sequence: number;
}

export const DEMO_SEQUENCE_START = 1000;

export function emptyDemoStoreState(sequence: number = DEMO_SEQUENCE_START): DemoStoreState {
  return { sessions: {}, sequence };
}

export interface DemoStore {
  create(sessionId: string, provider: ProviderId, name: string, description: string): Playlist;
  addTracks(sessionId: string, provider: ProviderId, playlistId: string, tracks: readonly Track[]): void;
  find(sessionId: string, provider: ProviderId, playlistId: string): Playlist;
  list(sessionId: string, provider: ProviderId): readonly Playlist[];
  clear(sessionId: string): void;
}

const NO_STATE = "演示音乐库状态未注入：边缘运行时是请求级的，请由上层传入 DemoStoreState（新对象或从持久层载入）";

function requireState(state: DemoStoreState | null): DemoStoreState {
  if (state === null || state === undefined) {
    throw ProviderApiError.notConfigured(NO_STATE);
  }
  return state;
}

/** Java 侧 synchronized(lock) 保护的会话表；单请求内天然是串行的。 */
export function createDemoStore(state: DemoStoreState | null): DemoStore {
  function playlists(sessionId: string, provider: ProviderId): Playlist[] {
    const store = requireState(state);
    let byProvider = store.sessions[sessionId];
    if (byProvider === undefined) {
      byProvider = {};
      store.sessions[sessionId] = byProvider;
    }
    let list = byProvider[provider];
    if (list === undefined) {
      list = [];
      byProvider[provider] = list;
    }
    return list;
  }

  return {
    create(sessionId, provider, name, description) {
      const store = requireState(state);
      const id = `demo-${++store.sequence}`;
      const playlist = newPlaylist(id, name, description, "", "演示音乐库", `${DEMO_LIBRARY_PREFIX}${id}`, []);
      playlists(sessionId, provider).push(playlist);
      return playlist;
    },

    addTracks(sessionId, provider, playlistId, tracks) {
      const list = playlists(sessionId, provider);
      for (let i = 0; i < list.length; i++) {
        const current = list[i];
        if (current.id === playlistId) {
          const merged: Track[] = [...current.tracks];
          for (const item of tracks) merged.push(item);
          // Java 用 new Playlist(...) 整体替换，而不是原地改列表。
          list[i] = newPlaylist(current.id, current.name, current.description,
            current.coverUrl, current.owner, current.webUrl, merged);
          return;
        }
      }
      throw ProviderApiError.badRequest("演示歌单不存在");
    },

    find(sessionId, provider, playlistId) {
      for (const item of playlists(sessionId, provider)) {
        if (item.id === playlistId) return item;
      }
      throw ProviderApiError.badRequest("演示歌单不存在或已过期");
    },

    list(sessionId, provider) {
      // List.copyOf(...)：返回快照（冻结），之后的 create 不会反映到已发出的列表上。
      return Object.freeze([...playlists(sessionId, provider)]);
    },

    clear(sessionId) {
      const store = requireState(state);
      delete store.sessions[sessionId];
    },
  };
}

/* ---------------- DemoPlaylists ---------------- */

/** 演示账号可选的来源：内置歌单 + 本次会话已创建的歌单（tracks 换成曲目数）。 */
export function demoPlaylistRefs(store: DemoStore, provider: ProviderId, sessionId: string): readonly PlaylistRef[] {
  const builtin = demoBuiltin(provider);
  const refs: PlaylistRef[] = [
    newPlaylistRef(builtin.id, builtin.name, builtin.webUrl, builtin.coverUrl, builtin.tracks.length),
  ];
  for (const created of store.list(sessionId, provider)) {
    refs.push(newPlaylistRef(created.id, created.name, created.webUrl, created.coverUrl, created.tracks.length));
  }
  // Java: List.copyOf(refs)
  return Object.freeze(refs);
}

/* ---------------- 错误构造辅助（保持 Java 文案逐字一致） ---------------- */

function badRequest(message: string): ProviderApiError {
  return ProviderApiError.badRequest(message);
}

/** Java ProviderException.notConnected → 409 NOT_CONNECTED，逐码一致。 */
function notConnected(message: string): ProviderApiError {
  return ProviderApiError.notConnected(message);
}

function realChannelMissing(provider: ProviderId): ProviderApiError {
  return ProviderApiError.notConfigured(
    `${providerLabel(provider)} 的真实账号通道不在 demo.ts 内，请由 provider 模块接管该连接`);
}

/* ---------------- 演示通道（MusicProvider 的 DEMO 分支） ---------------- */

export interface DemoMusicProvider {
  readonly provider: ProviderId;
  /** MusicProvider.sampleUrl() */
  sampleUrl(): string;
  /** MusicProvider.connectDemo(sessionId) */
  connectDemo(sessionId: string): ProviderConnection;
  /** MusicProvider.fetchPlaylist(connection, url) */
  fetchPlaylist(connection: ProviderConnection | null, url: string | null): Playlist;
  /** MusicProvider.listPlaylists(connection) */
  listPlaylists(connection: ProviderConnection | null): readonly PlaylistRef[];
  /** MusicProvider.searchTracks(connection, title, artist, limit) —— 演示模式下三个入参全部被忽略 */
  searchTracks(connection: ProviderConnection | null, title: string, artist: string, limit: number): readonly Track[];
  /** MusicProvider.createPlaylist(connection, name, description) */
  createPlaylist(connection: ProviderConnection | null, name: string, description: string): CreatedPlaylist;
  /** MusicProvider.addTracks(connection, playlist, tracks) */
  addTracks(connection: ProviderConnection | null, playlist: CreatedPlaylist, tracks: readonly Track[]): void;
}

interface DemoProviderProfile {
  readonly sampleUrl: string;
  readonly demoAccountName: string;
  /** 连接为空时"请先连接…"的来源侧文案；网易云没有来源侧文案（一律拒绝）。 */
  readonly sourceConnectHint: string | null;
  readonly targetConnectHint: string | null;
  readonly demoUrlConnectHint: string;
  readonly demoUrlOnRealHint: string;
  /** true = QQ / Apple：只判断 mode === DEMO；false = 网易云：额外判断 provider 一致。 */
  readonly modeOnly: boolean;
  readonly supportsSource: boolean;
}

const PROFILES: Readonly<Record<ProviderId, DemoProviderProfile>> = Object.freeze({
  QQ_MUSIC: Object.freeze({
    sampleUrl: "https://y.qq.com/n/ryqq/playlist/7300098051",
    demoAccountName: "演示账号 · 阿桥",
    sourceConnectHint: "请先连接 QQ 音乐（来源平台）",
    targetConnectHint: "请先连接 QQ 音乐（目标平台）",
    demoUrlConnectHint: "演示歌单链接需要先连接 QQ 音乐演示账号",
    demoUrlOnRealHint: "当前是演示连接，请使用演示歌单链接，或切换为真实 QQ 音乐连接",
    modeOnly: true,
    supportsSource: true,
  }),
  APPLE_MUSIC: Object.freeze({
    sampleUrl: "https://music.apple.com/cn/playlist/jason-mraz-essentials/pl.77d8b27b5ca1442e8378920504f115d1",
    demoAccountName: "演示账号 · Bridge",
    sourceConnectHint: "请先连接 Apple Music（来源平台）",
    targetConnectHint: "请先连接 Apple Music（目标平台）",
    demoUrlConnectHint: "演示歌单链接需要先连接 Apple Music 演示账号",
    demoUrlOnRealHint: "当前是演示连接，请使用演示歌单链接，或切换为真实 Apple Music 连接",
    modeOnly: true,
    supportsSource: true,
  }),
  NETEASE_MUSIC: Object.freeze({
    sampleUrl: "",
    demoAccountName: "网易云音乐 · 演示账号",
    sourceConnectHint: null,
    targetConnectHint: "请先连接网易云音乐目标账号",
    demoUrlConnectHint: "网易云音乐暂不支持作为来源平台",
    demoUrlOnRealHint: "网易云音乐暂不支持作为来源平台",
    modeOnly: false,
    supportsSource: false,
  }),
});

/**
 * 构造某个平台的演示通道。state 为该请求注入的会话状态；传 null 表示"只读内置曲库"，
 * 任何触碰演示音乐库的操作都会以 notConfigured(503) 失败（不假装写入成功）。
 */
export function createDemoProvider(provider: ProviderId, state: DemoStoreState | null): DemoMusicProvider {
  const profile = PROFILES[provider];
  const store = createDemoStore(state);

  /** 各 provider 私有 sessionId(connection)：credentials.demoSessionId 缺失即视为会话过期。 */
  function sessionIdOf(connection: ProviderConnection): string {
    const sessionId = connection.credentials[DEMO_SESSION_KEY];
    if (sessionId === undefined || sessionId === null || sessionId.trim() === "") {
      throw notConnected("演示会话已过期，请重新连接演示账号");
    }
    return sessionId;
  }

  function isDemo(connection: ProviderConnection | null): connection is ProviderConnection {
    if (connection === null || connection === undefined) return false;
    if (!profile.modeOnly) return connection.provider === provider && connection.mode === "DEMO";
    return connection.mode === "DEMO";
  }

  /**
   * 非演示连接的兜底。QQ / Apple 在 Java 里直接落进真实通道（不在本模块，交回 provider 模块）；
   * 网易云会先过 webCookie / grant 的前置校验：provider 必须一致且 mode 必须是 REAL，
   * 否则抛 NOT_CONNECTED「请先连接网易云音乐目标账号」。这段是可移植的 Java 行为，照搬。
   */
  function rejectNonDemo(connection: ProviderConnection): never {
    if (!profile.modeOnly && (connection.provider !== provider || connection.mode !== "REAL")) {
      throw notConnected(profile.targetConnectHint ?? "请先连接目标平台");
    }
    throw realChannelMissing(provider);
  }

  return {
    provider,

    sampleUrl() {
      return profile.sampleUrl;
    },

    connectDemo(sessionId: string): ProviderConnection {
      const credentials: Record<string, string> = { [DEMO_SESSION_KEY]: sessionId };
      return Object.freeze({
        provider,
        mode: "DEMO" as ConnectionMode,
        accountName: profile.demoAccountName,
        credentials: Object.freeze(credentials),
      });
    },

    fetchPlaylist(connection, url): Playlist {
      if (!profile.supportsSource) {
        // 网易云在 DEMO 与 REAL 下都直接拒绝，且不看 url。
        throw badRequest("网易云音乐暂不支持作为来源平台");
      }
      const target = url === null || url === undefined ? "" : url;
      if (target.startsWith("demo://")) {
        if (connection === null || connection === undefined || connection.mode !== "DEMO") {
          throw badRequest(profile.demoUrlConnectHint);
        }
        const sessionId = sessionIdOf(connection);
        if (target === DEMO_BUILTIN_URL || target === DEMO_BUILTIN_ALT_URL) {
          return demoBuiltin(provider);
        }
        if (target.startsWith(DEMO_LIBRARY_PREFIX)) {
          return store.find(sessionId, provider, target.slice(DEMO_LIBRARY_PREFIX.length));
        }
        throw badRequest("演示歌单链接无法识别，请使用 demo://builtin 或演示音乐库中的歌单");
      }
      if (connection !== null && connection !== undefined && connection.mode === "DEMO") {
        throw badRequest(profile.demoUrlOnRealHint);
      }
      if (provider === "APPLE_MUSIC" && (connection === null || connection === undefined)) {
        throw notConnected("请先连接 Apple Music");
      }
      throw realChannelMissing(provider);
    },

    listPlaylists(connection): readonly PlaylistRef[] {
      if (!profile.supportsSource) {
        throw badRequest("网易云音乐暂不支持作为来源平台");
      }
      if (connection === null || connection === undefined) {
        throw notConnected(profile.sourceConnectHint ?? "请先连接来源平台");
      }
      if (connection.mode === "DEMO") {
        return demoPlaylistRefs(store, provider, sessionIdOf(connection));
      }
      throw realChannelMissing(provider);
    },

    searchTracks(connection, _title, _artist, _limit): readonly Track[] {
      if (isDemo(connection)) {
        return demoTargetCatalog(provider);
      }
      if (connection === null || connection === undefined) {
        // Java: QQ/Apple 落进 client（真实接口，本模块不含）；网易云先过 webCookie 校验抛 NOT_CONNECTED。
        if (!profile.modeOnly) throw notConnected(profile.targetConnectHint ?? "请先连接目标平台");
        throw realChannelMissing(provider);
      }
      rejectNonDemo(connection);
    },

    createPlaylist(connection, name, description): CreatedPlaylist {
      if (isDemo(connection)) {
        const created = store.create(sessionIdOf(connection), provider, name, description);
        return createdPlaylistOf(created.id, created.name, created.webUrl, 0);
      }
      if (connection === null || connection === undefined) {
        throw notConnected(profile.targetConnectHint ?? "请先连接目标平台");
      }
      rejectNonDemo(connection);
    },

    addTracks(connection, playlist, tracks): void {
      if (isDemo(connection)) {
        store.addTracks(sessionIdOf(connection), provider, playlist.id, tracks);
        return;
      }
      if (connection === null || connection === undefined) {
        throw notConnected(profile.targetConnectHint ?? "请先连接目标平台");
      }
      rejectNonDemo(connection);
    },
  };
}

export function createDemoProviders(
  state: DemoStoreState | null,
): Readonly<Record<ProviderId, DemoMusicProvider>> {
  const out = {} as Record<ProviderId, DemoMusicProvider>;
  for (const id of PROVIDER_IDS) out[id] = createDemoProvider(id, state);
  return Object.freeze(out);
}

/* ---------------- /api/demo/library 的响应体（web.dto.PlaylistView） ---------------- */

export interface TrackView {
  readonly id: string;
  readonly title: string;
  readonly artist: string;
  readonly album: string;
  readonly durationSec: number;
  readonly artworkUrl: string;
}

export interface PlaylistView {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly coverUrl: string;
  readonly owner: string;
  readonly webUrl: string;
  readonly totalTracks: number;
  readonly truncated: boolean;
  readonly tracks: readonly TrackView[];
}

export function demoTrackView(track: Track): TrackView {
  return Object.freeze({
    id: track.providerTrackId,
    title: track.title,
    artist: track.artist,
    album: track.album,
    durationSec: track.durationSec,
    artworkUrl: track.artworkUrl,
  });
}

/** PlaylistView.from(playlist, maxTracks)：maxTracks <= 0 表示不限；/api/demo/library 传 Integer.MAX_VALUE。 */
export function demoPlaylistView(playlist: Playlist, maxTracks: number): PlaylistView {
  const all = playlist.tracks;
  const limit = maxTracks <= 0 ? all.length : Math.min(all.length, maxTracks);
  const tracks: TrackView[] = [];
  for (let i = 0; i < limit; i++) tracks.push(demoTrackView(all[i]));
  return Object.freeze({
    id: playlist.id,
    name: playlist.name,
    description: playlist.description,
    coverUrl: playlist.coverUrl,
    owner: playlist.owner,
    webUrl: playlist.webUrl,
    totalTracks: all.length,
    truncated: all.length > limit,
    tracks: Object.freeze(tracks),
  });
}

/**
 * GET /api/demo/library?provider=...：未连接、或连接不是 DEMO 时返回空数组（Java ApiController.demoLibrary）。
 * 注意它按 HttpSession.getId() 取库，与 provider 连接里的 demoSessionId 是同一个值才能看到内容。
 */
export function demoLibraryView(
  provider: ProviderId,
  connection: ProviderConnection | null,
  state: DemoStoreState | null,
): readonly PlaylistView[] {
  if (connection === null || connection === undefined || connection.mode !== "DEMO") {
    return Object.freeze([]);
  }
  const store = createDemoStore(state);
  return Object.freeze(store.list(sessionIdOfConnection(connection), provider)
    .map((playlist) => demoPlaylistView(playlist, Number.MAX_SAFE_INTEGER)));
}

function sessionIdOfConnection(connection: ProviderConnection): string {
  const sessionId = connection.credentials[DEMO_SESSION_KEY];
  if (sessionId === undefined || sessionId === null || sessionId.trim() === "") {
    throw notConnected("演示会话已过期，请重新连接演示账号");
  }
  return sessionId;
}
