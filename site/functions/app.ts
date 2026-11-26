import { ProviderApiError } from "./errors.ts";
import { errorResponse, json, readJson, resolve, type Ctx, type Route } from "./http.ts";
import { assertCsrf, csrfToken } from "./csrf.ts";
import { getUser } from "./auth.mjs";
import { open, seal } from "./vault.ts";
import { historyBoundary, memoryStore, type Connection, type Store } from "./store.ts";
import { NeteaseClient, type SearchOutcome } from "./netease.ts";
import { advanceMatch, attachSource, confirmJob, createJob, interrupt, isTerminal, jobView, logJob, reap, type Job } from "./job.ts";
import { toTrack, type Track as MatcherTrack } from "./matcher.ts";
import { createDemoProvider, demoLibraryView, emptyDemoStoreState, providerIdFrom, type CreatedPlaylist, type ProviderId } from "./demo.ts";
import {
  qqAddTracks, qqConnectReal, qqCreatePlaylist, qqFetchPlaylist, qqListPlaylists,
  qqSampleUrl, qqSearchTracks, type QqConnection, type QqOptions,
} from "./qq.ts";

/**
 * 站点侧的 API 入口（纯 handler，便于本地用 Node 直接驱动验证；index.ts 只负责 Deno.serve）。
 * 覆盖线上工作台的全部业务契约：Qoder 登录态 + CSRF、连接管理、来源/备份读取、
 * 分片匹配、确认写入、断点续跑、放弃、演示音乐库、历史分页筛选与只读报告。
 * 平台受限的 Apple 真实通道、网易云扫码/CLI 不在站点开放，相关入口按 Java 文案明确拒绝。
 */

const PROVIDER_LABELS: Record<string, string> = {
  QQ_MUSIC: "QQ 音乐", APPLE_MUSIC: "Apple Music", NETEASE_MUSIC: "网易云音乐",
};
/** 线上工作台只暴露 QQ 与网易云；Apple 真实通道受平台限制，接口层明确拒绝。 */
const SUPPORTED_PROVIDERS: ProviderId[] = ["QQ_MUSIC", "NETEASE_MUSIC"];
const CREDENTIAL_TTL_MS: Record<string, number> = {
  QQ_MUSIC: 3 * 24 * 3600 * 1000,
  NETEASE_MUSIC: 30 * 24 * 3600 * 1000,
  APPLE_MUSIC: 70 * 24 * 3600 * 1000,
};
const MAX_TRACKS = 200;
const BACKUP_INPUT_LIMIT = MAX_TRACKS * 5;
const HISTORY_DEFAULT_PAGE = 20;
const HISTORY_MAX_PAGE = 50;
const JOB_STATUSES = new Set(["QUEUED", "RUNNING", "AWAITING_CONFIRMATION", "COMPLETED", "FAILED", "INTERRUPTED"]);
const CSRF_HEADER = "x-csrf-token";
function processEnvGuard(): { env?: Record<string, string | undefined> } | undefined {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
}

const runtimeProcess = processEnvGuard();
const MATCH_SLICE = Number(runtimeProcess?.env?.TUNEBRIDGE_MATCH_SLICE ?? 8);

export type AppDeps = { store: Store; fetchImpl?: typeof fetch; now?: () => number };

type LoadedPlaylist = {
  id: string; name: string; description: string; coverUrl: string; owner: string; webUrl: string;
  tracks: Job["sourceTracks"];
};

export function createApp(deps: AppDeps) {
  const store = deps.store;
  const now = deps.now ?? (() => Date.now());

  const routes: Route[] = [
    { method: "GET", segments: ["auth"], auth: false, handle: authSnapshot },
    { method: "GET", segments: ["state"], auth: true, handle: state },
    { method: "GET", segments: ["config"], auth: false, handle: config },
    { method: "POST", segments: ["connections", ":provider"], auth: true, handle: connect },
    { method: "DELETE", segments: ["connections", ":provider"], auth: true, handle: disconnect },
    { method: "POST", segments: ["connections", "netease", "qr"], auth: true, handle: neteaseQrUnavailable },
    { method: "GET", segments: ["connections", "netease", "qr", ":loginId"], auth: true, handle: neteaseQrUnavailable },
    { method: "GET", segments: ["demo", "library"], auth: true, handle: demoLibrary },
    { method: "GET", segments: ["playlists"], auth: true, handle: playlists },
    { method: "POST", segments: ["playlists", "preview"], auth: true, handle: preview },
    { method: "POST", segments: ["playlists", "backup"], auth: true, handle: readBackup },
    { method: "POST", segments: ["migrations"], auth: true, handle: startMigration },
    { method: "POST", segments: ["backups", "migrations"], auth: true, handle: startBackupMigration },
    { method: "GET", segments: ["migrations"], auth: true, handle: listMigrations },
    { method: "GET", segments: ["migrations", "current"], auth: true, handle: currentMigration },
    { method: "GET", segments: ["migrations", ":id"], auth: true, handle: getMigration },
    { method: "POST", segments: ["migrations", ":id", "advance"], auth: true, handle: advance },
    { method: "POST", segments: ["migrations", ":id", "confirm"], auth: true, handle: confirm },
    { method: "POST", segments: ["migrations", ":id", "abandon"], auth: true, handle: abandon },
  ];

  /** 与线上 /api/auth 快照同形；未登录也返回 200，前端据此展示 Qoder 登录入口。 */
  async function authSnapshot(ctx: Ctx) {
    const userId = ctx.user.user_id;
    if (!userId) {
      return json({
        authenticated: false, username: null, csrfToken: null, csrfHeader: CSRF_HEADER,
        registrationAllowed: false, registrationCodeRequired: false, mode: "sites",
      });
    }
    return json({
      authenticated: true,
      username: (ctx.user.name ?? "").trim() || "Qoder 用户",
      csrfToken: await csrfToken(userId),
      csrfHeader: CSRF_HEADER,
      registrationAllowed: false,
      registrationCodeRequired: false,
      mode: "sites",
    });
  }

  async function state(ctx: Ctx) {
    const connections: Record<string, unknown> = {};
    for (const provider of SUPPORTED_PROVIDERS) {
      const stored = await store.loadConnection(ctx.user.user_id, provider);
      // 演示连接按设计不持有凭据，不能用"有凭据"当作已连接的判据。
      const usable = stored && (stored.mode === "DEMO"
        || (stored.credential !== null && stored.credential.expiresAt > now()));
      if (usable) {
        connections[provider] = {
          provider, label: stored.label, accountName: stored.label,
          mode: stored.mode, connected: true,
        };
      }
    }
    const active = await activeJob(ctx.user.user_id);
    return json({
      connections,
      providers: SUPPORTED_PROVIDERS.map(id => ({
        id, label: providerLabel(id), sampleUrl: id === "QQ_MUSIC" ? qqSampleUrl() : "",
      })),
      config: configBody(),
      activeJobId: active ? active.id : null,
    });
  }

  function configBody() {
    return { demoEnabled: true, maxTracks: MAX_TRACKS, neteaseRealReady: true, authMode: "sites" };
  }

  async function config() {
    return json(configBody());
  }

  async function connect(ctx: Ctx) {
    const provider = normalizeProvider(ctx.params.provider);
    const body = await readJson(ctx.request);
    const mode = String(body.mode ?? "").trim().toLowerCase();
    if (!mode) throw ProviderApiError.badRequest("请选择连接方式");
    if (provider === "APPLE_MUSIC") {
      throw ProviderApiError.badRequest("Apple Music 真实通道暂未在站点开放");
    }
    if (mode === "demo") {
      const connection = createDemoProvider(provider, null).connectDemo(ctx.user.user_id);
      await store.saveConnection({ userId: ctx.user.user_id, provider, mode: "DEMO",
        label: connection.accountName, credential: null, createdAt: now() });
      return json({ provider, label: connection.accountName, accountName: connection.accountName,
        mode: "DEMO", connected: true });
    }
    if (mode !== "real") throw ProviderApiError.badRequest("不支持的连接方式：" + mode);
    if (provider === "NETEASE_MUSIC") {
      const cookie = String(body.cookie ?? "").trim();
      if (!cookie) throw ProviderApiError.badRequest("请粘贴网易云登录 Cookie");
      const client = new NeteaseClient(deviceIdFor(ctx.user.user_id), deps.fetchImpl);
      const nickname = await client.accountName(cookie);
      await store.saveConnection({ userId: ctx.user.user_id, provider, mode: "REAL", label: nickname,
        credential: await seal(ctx.user.user_id, cookie, CREDENTIAL_TTL_MS[provider]), createdAt: now() });
      return json({ provider, label: nickname, accountName: nickname, mode: "REAL", connected: true });
    }
    if (provider === "QQ_MUSIC") {
      const cookie = String(body.cookie ?? "").trim();
      if (!cookie) throw ProviderApiError.badRequest("请粘贴 QQ 音乐登录 Cookie");
      const connection = await qqConnectReal({ cookie }, qqOptions());
      await store.saveConnection({ userId: ctx.user.user_id, provider, mode: "REAL",
        label: connection.accountName,
        credential: await seal(ctx.user.user_id, cookie, CREDENTIAL_TTL_MS[provider]), createdAt: now() });
      return json({ provider, label: connection.accountName, accountName: connection.accountName,
        mode: "REAL", connected: true });
    }
    throw ProviderApiError.badRequest("Apple Music 真实通道暂未在站点开放");
  }

  async function disconnect(ctx: Ctx) {
    await store.dropConnection(ctx.user.user_id, normalizeProvider(ctx.params.provider));
    return new Response(null, { status: 204 });
  }

  /**
   * 网易云扫码登录在云函数出口会被 8821 拦截（已实测），站点版只保留 Cookie 连接。
   * 前端仍保留入口，所以这里给出明确原因而不是 404。
   */
  async function neteaseQrUnavailable() {
    throw ProviderApiError.notConfigured(
      "站点云端出口会被网易云拦截（错误码 8821），扫码登录不可用；请改用 Cookie 连接真实账号");
  }

  /** 返回该连接的凭据明文；DEMO 连接没有凭据，返回空串由调用方分流。 */
  async function credentialsFor(userId: string, provider: string): Promise<{ mode: string; cookie: string }> {
    const stored = await store.loadConnection(userId, provider);
    if (!stored) throw ProviderApiError.notConnected("请先连接 " + providerLabel(provider));
    if (stored.mode === "DEMO") return { mode: "DEMO", cookie: "" };
    if (!stored.credential) throw ProviderApiError.notConnected("请先连接 " + providerLabel(provider));
    return { mode: stored.mode, cookie: await open(userId, stored.credential) };
  }

  function qqOptions(): QqOptions {
    return { fetchImpl: deps.fetchImpl };
  }

  /** 真实来源只有 QQ：按请求的 provider 取连接，不能顺手拿别的平台凭据。 */
  async function qqRealConnection(userId: string, provider: ProviderId): Promise<QqConnection> {
    if (provider === "NETEASE_MUSIC") {
      throw ProviderApiError.badRequest("网易云音乐暂不支持作为来源平台");
    }
    if (provider !== "QQ_MUSIC") {
      throw ProviderApiError.badRequest("Apple Music 真实通道暂未在站点开放");
    }
    const stored = await store.loadConnection(userId, provider);
    if (!stored) throw ProviderApiError.notConnected("请先连接 " + providerLabel(provider));
    // 先解凭据：过期要报 401 凭据失效，而不是被后面任何分支的误导性原因顶掉。
    const cookie = await open(userId, stored.credential);
    return { provider: provider as "QQ_MUSIC", mode: "REAL", accountName: stored.label, credentials: { cookie } };
  }

  async function loadSource(userId: string, provider: ProviderId, url: string): Promise<LoadedPlaylist> {
    // 与 Java 一致：网易云作为来源是无条件 400，不能被"请先连接"这类状态错误抢先掩盖。
    if (provider === "NETEASE_MUSIC") {
      throw ProviderApiError.badRequest("网易云音乐暂不支持作为来源平台");
    }
    const stored = await store.loadConnection(userId, provider);
    // QQ 公开歌单匿名可读：没有连接时直接用 null connection 出网，不被迫先登录平台。
    if (provider === "QQ_MUSIC" && (!stored || stored.mode !== "DEMO")) {
      const connection = stored ? await qqRealConnection(userId, provider) : null;
      const playlist = await qqFetchPlaylist(connection, url, qqOptions());
      return mapPlaylist(playlist.name, playlist.description, playlist.coverUrl, playlist.owner,
        playlist.webUrl, playlist.id, playlist.tracks);
    }
    if (!stored) throw ProviderApiError.notConnected("请先连接 " + providerLabel(provider));
    if (stored.mode === "DEMO") {
      const state = (await store.loadDemoState(userId)) ?? emptyDemoStoreState();
      const adapter = createDemoProvider(provider, state);
      const connection = adapter.connectDemo(userId);
      const playlist = adapter.fetchPlaylist(connection, url || "demo://builtin");
      await store.saveDemoState(userId, state);
      return mapPlaylist(playlist.name, playlist.description, playlist.coverUrl, playlist.owner,
        playlist.webUrl, playlist.id, playlist.tracks);
    }
    throw ProviderApiError.badRequest("Apple Music 真实通道暂未在站点开放");
  }

  function mapPlaylist(name: string, description: string, coverUrl: string, owner: string,
      webUrl: string, id: string, tracks: readonly MatcherTrack[]): LoadedPlaylist {
    return {
      id, name, description, coverUrl, owner, webUrl,
      tracks: tracks.map(track => ({
        providerTrackId: String(track.providerTrackId), title: track.title, artist: track.artist,
        album: track.album, durationSec: track.durationSec, artworkUrl: track.artworkUrl ?? "",
        songType: track.songType ?? 0,
      })),
    };
  }

  async function playlists(ctx: Ctx) {
    const provider = normalizeProvider(ctx.query.get("provider") ?? "");
    if (provider === "NETEASE_MUSIC") {
      throw ProviderApiError.badRequest("网易云音乐暂不支持作为来源平台");
    }
    const stored = await store.loadConnection(ctx.user.user_id, provider);
    if (!stored) throw ProviderApiError.notConnected("请先连接 " + providerLabel(provider));
    if (stored.mode !== "DEMO") {
      const refs = await qqListPlaylists(await qqRealConnection(ctx.user.user_id, provider), qqOptions());
      return json(refs);
    }
    const state = (await store.loadDemoState(ctx.user.user_id)) ?? emptyDemoStoreState();
    const adapter = createDemoProvider(provider, state);
    const refs = adapter.listPlaylists(adapter.connectDemo(ctx.user.user_id));
    return json(refs);
  }

  async function preview(ctx: Ctx) {
    const body = await readJson(ctx.request);
    const provider = normalizeProvider(String(body.provider ?? ""));
    const url = String(body.url ?? "").trim();
    if (!url) throw ProviderApiError.badRequest("请填写歌单链接");
    const playlist = await loadSource(ctx.user.user_id, provider, url);
    return json(playlistView(provider, url, playlist));
  }

  /** 备份读取：QQ 公开歌单允许匿名读取，登录 Cookie 只用于提升可见范围。 */
  async function readBackup(ctx: Ctx) {
    const body = await readJson(ctx.request);
    const provider = normalizeProvider(String(body.provider ?? ""));
    const url = String(body.url ?? "").trim();
    if (!url) throw ProviderApiError.badRequest("请粘贴来源歌单链接");
    if (provider === "NETEASE_MUSIC") {
      throw ProviderApiError.badRequest("网易云音乐暂不支持作为来源平台");
    }
    if (provider !== "QQ_MUSIC") {
      throw ProviderApiError.badRequest("Apple Music 真实通道暂未在站点开放");
    }
    if (url.startsWith("demo://")) {
      return json(playlistView(provider, url, await loadSource(ctx.user.user_id, provider, url), 0));
    }
    const stored = await store.loadConnection(ctx.user.user_id, provider);
    let connection: QqConnection | null = null;
    if (stored && stored.mode === "REAL" && stored.credential) {
      const cookie = await open(ctx.user.user_id, stored.credential);
      connection = { provider: "QQ_MUSIC", mode: "REAL", accountName: stored.label, credentials: { cookie } };
    }
    const playlist = await qqFetchPlaylist(connection, url, qqOptions());
    return json(playlistView(provider, url, mapPlaylist(playlist.name, playlist.description,
      playlist.coverUrl, playlist.owner, playlist.webUrl, playlist.id, playlist.tracks), 0));
  }

  async function startMigration(ctx: Ctx) {
    const body = await readJson(ctx.request);
    const source = normalizeProvider(String(body.sourceProvider ?? ""));
    const target = normalizeProvider(String(body.targetProvider ?? ""));
    const sourceUrl = String(body.sourceUrl ?? "").trim();
    if (!sourceUrl) throw ProviderApiError.badRequest("请粘贴来源歌单链接");
    if (source === target) throw ProviderApiError.badRequest("来源平台和目标平台不能相同");
    if (target === "APPLE_MUSIC") throw ProviderApiError.badRequest("Apple Music 真实通道暂未在站点开放");
    if (sourceUrl.startsWith("demo://") && !await store.loadConnection(ctx.user.user_id, source)) {
      throw ProviderApiError.notConnected("请先连接 " + providerLabel(source) + " 演示账号");
    }
    const targetConnection = await requireTarget(ctx.user.user_id, target);
    const running = await activeJob(ctx.user.user_id);
    if (running) {
      throw new ProviderApiError(409, "ACTIVE_JOB", "已有未完成的迁移任务，请先完成或放弃");
    }
    const playlist = await loadSource(ctx.user.user_id, source, sourceUrl);
    if (playlist.tracks.length === 0) throw ProviderApiError.badRequest("来源歌单是空的");
    const requestedName = sanitizeName(body.playlistName)
      || sanitizeName(playlist.name + " · 音桥") || "音桥迁移歌单";
    const job = createJob({ id: newId(), userId: ctx.user.user_id, sourceProvider: source,
      sourceLabel: null, sourceUrl, targetProvider: target,
      targetMode: targetConnection.mode, targetConnectionAt: targetConnection.createdAt,
      requestedName, now: now() });
    attachSource(job, { name: playlist.name, coverUrl: playlist.coverUrl, owner: playlist.owner,
      tracks: playlist.tracks }, now());
    if (playlist.tracks.length > MAX_TRACKS) {
      logJob(job, "来源共 " + playlist.tracks.length + " 首，本次按上限迁移前 " + MAX_TRACKS + " 首", "WARN");
    }
    await store.saveJob(job);
    return json(jobView(job));
  }

  async function startBackupMigration(ctx: Ctx) {
    const body = await readJson(ctx.request);
    const target = normalizeProvider(String(body.targetProvider ?? ""));
    if (target === "APPLE_MUSIC") throw ProviderApiError.badRequest("Apple Music 真实通道暂未在站点开放");
    const targetConnection = await requireTarget(ctx.user.user_id, target);
    const rawTracks = Array.isArray(body.tracks) ? body.tracks : [];
    if (rawTracks.length === 0) throw ProviderApiError.badRequest("备份中没有可迁移的曲目");
    if (rawTracks.length > BACKUP_INPUT_LIMIT) {
      throw ProviderApiError.badRequest(`备份曲目过多，单次最多处理 ${BACKUP_INPUT_LIMIT} 首`);
    }
    const tracks = rawTracks.map(track => backupTrack(track))
      .filter((track): track is Job["sourceTracks"][number] => track !== null);
    if (tracks.length === 0) throw ProviderApiError.badRequest("备份中没有可迁移的曲目");
    const running = await activeJob(ctx.user.user_id);
    if (running) {
      throw new ProviderApiError(409, "ACTIVE_JOB", "已有未完成的迁移任务，请先完成或放弃");
    }
    const sourceName = sanitizeName(body.sourceName) || "本地备份";
    const requestedName = sanitizeName(body.playlistName)
      || sanitizeName(sourceName + " · 音桥") || "音桥迁移歌单";
    const job = createJob({ id: newId(), userId: ctx.user.user_id, sourceProvider: "LOCAL_BACKUP",
      sourceLabel: "本地备份", sourceUrl: null, targetProvider: target,
      targetMode: targetConnection.mode, targetConnectionAt: targetConnection.createdAt,
      requestedName, now: now() });
    attachSource(job, { name: sourceName, coverUrl: "", owner: "本地备份",
      tracks }, now());
    if (tracks.length > MAX_TRACKS) {
      logJob(job, "来源共 " + tracks.length + " 首，本次按上限迁移前 " + MAX_TRACKS + " 首", "WARN");
    }
    await store.saveJob(job);
    return json(jobView(job));
  }

  async function advance(ctx: Ctx) {
    const job = await needJob(ctx);
    reap(job, now());
    if (job.status === "RUNNING" && job.cursor < job.sourceTracks.length) {
      const outcome = await advanceMatch(job, searcher(ctx.user.user_id, job), MATCH_SLICE, now());
      await store.saveJob(job);
      return json({ ...jobView(job), advance: outcome.kind, retryAfterMs:
        outcome.kind === "waiting" ? outcome.retryAfterMs : null });
    }
    if (job.status === "RUNNING" && !job.createdTarget) {
      await advanceMatch(job, searcher(ctx.user.user_id, job), 0, now());
      await store.saveJob(job);
    }
    return json({ ...jobView(job), advance: job.status === "AWAITING_CONFIRMATION" ? "ready" : job.status,
      retryAfterMs: job.nextAttemptAt > now() ? job.nextAttemptAt - now() : null });
  }

  async function confirm(ctx: Ctx) {
    const job = await needJob(ctx);
    const body = await readJson(ctx.request);
    if (job.status === "AWAITING_CONFIRMATION" || (job.status === "RUNNING" && job.createdTarget)) {
      const targetConnection = await store.loadConnection(ctx.user.user_id, job.targetProvider);
      const replaced = job.targetConnectionAt !== undefined
        && (!targetConnection || targetConnection.createdAt !== job.targetConnectionAt);
      if (!targetConnection || targetConnection.mode !== job.targetMode || replaced) {
        throw new ProviderApiError(409, "TARGET_CHANGED", "目标连接已断开或更换，请重新匹配后确认");
      }
    }
    const rawIndices = body.selectedIndices;
    if (!Array.isArray(rawIndices)) throw ProviderApiError.badRequest("请至少选择一首已匹配的歌曲");
    if (rawIndices.some(value => typeof value !== "number" || !Number.isInteger(value))) {
      throw ProviderApiError.badRequest("所选歌曲序号必须是整数");
    }
    const indices = rawIndices as number[];
    let outcome;
    try {
      outcome = await confirmJob(job, indices, {
        createPlaylist: (name) => createTarget(ctx.user.user_id, job, name),
        addTracks: (target, ids) => writeTarget(ctx.user.user_id, job, target, ids),
        playlistNameFor: (value) => value.requestedName,
        checkpoint: () => store.saveJob(job),
        now: now(),
      });
    } catch (error) {
      // 已建单的任务即使写歌失败也要落库：下一次 confirm 只能续写，不能重复建单。
      if (job.createdTarget) {
        await store.saveJob(job).catch(saveError => console.error("persist confirmed target failed", saveError));
      }
      throw error;
    }
    if (outcome.kind === "partial") {
      job.currentStep = "正在写入歌曲";
      job.progress = Math.max(job.progress, 88);
    }
    await store.saveJob(job);
    return json({ ...jobView(job), write: outcome.kind,
      retryAfterMs: outcome.kind === "waiting" ? outcome.retryAfterMs : null });
  }

  async function abandon(ctx: Ctx) {
    const job = await needJob(ctx);
    if (job.status !== "AWAITING_CONFIRMATION") {
      throw new ProviderApiError(409, "MIGRATION_STATE", "只能放弃尚未确认的预览");
    }
    interrupt(job, "已放弃该预览", now());
    await store.saveJob(job);
    return json(jobView(job));
  }

  async function listMigrations(ctx: Ctx) {
    const offset = intQuery(ctx.query.get("offset"), 0, 0, 100000, "历史记录分页参数无效");
    const limit = intQuery(ctx.query.get("limit"), HISTORY_DEFAULT_PAGE, 1, HISTORY_MAX_PAGE, "历史记录分页参数无效");
    const source = optionalSource(ctx.query.get("source"));
    const target = optionalProvider(ctx.query.get("target"), "历史记录筛选参数无效");
    const status = optionalStatus(ctx.query.get("status"));
    const from = optionalDay(ctx.query.get("from"));
    const to = optionalDay(ctx.query.get("to"));
    if (from && to && historyBoundary(from, false) >= historyBoundary(to, true)) {
      throw ProviderApiError.badRequest("开始时间必须早于结束时间");
    }
    await activeJob(ctx.user.user_id);
    const page = await store.listJobs(ctx.user.user_id,
      { offset, limit, source, target, status, from, to });
    return json({
      items: page.items.map(job => jobView(job, job.status !== "AWAITING_CONFIRMATION")),
      hasMore: page.hasMore,
      offset,
    });
  }

  async function currentMigration(ctx: Ctx) {
    const job = await activeJob(ctx.user.user_id);
    return json(job ? jobView(job) : null);
  }

  async function getMigration(ctx: Ctx) {
    const job = await needJob(ctx);
    return json(jobView(job, job.status !== "AWAITING_CONFIRMATION"));
  }

  async function demoLibrary(ctx: Ctx) {
    const provider = normalizeProvider(ctx.query.get("provider") ?? "");
    const stored = await store.loadConnection(ctx.user.user_id, provider);
    if (!stored || stored.mode !== "DEMO") return json([]);
    const state = (await store.loadDemoState(ctx.user.user_id)) ?? emptyDemoStoreState();
    const connection = createDemoProvider(provider, state).connectDemo(ctx.user.user_id);
    return json(demoLibraryView(provider, connection, state));
  }

  /** 目标平台搜索：DEMO 走内置目标曲库，REAL 按平台走 eapi / QQ 公共搜索。 */
  function searcher(userId: string, job: Job) {
    return async (source: Job["sourceTracks"][number]): Promise<SearchOutcome> => {
      if (job.targetMode === "DEMO") {
        const state = (await store.loadDemoState(userId)) ?? emptyDemoStoreState();
        const adapter = createDemoProvider(providerIdFrom(job.targetProvider), state);
        const found = adapter.searchTracks(adapter.connectDemo(userId), source.title, source.artist, 6);
        await store.saveDemoState(userId, state);
        const tracks = found.map(track => toTrack(track));
        return tracks.length > 0 ? { kind: "candidates", tracks } : { kind: "empty" };
      }
      if (job.targetProvider === "NETEASE_MUSIC") {
        const client = new NeteaseClient(deviceIdFor(userId), deps.fetchImpl);
        const { cookie } = await credentialsFor(userId, job.targetProvider);
        return client.search(cookie, source.title, source.artist, 6);
      }
      if (job.targetProvider === "QQ_MUSIC") {
        const found = await qqSearchTracks(null, source.title, source.artist, 6, qqOptions());
        const tracks = found.map(track => toTrack(track));
        return tracks.length > 0 ? { kind: "candidates", tracks } : { kind: "empty" };
      }
      return { kind: "rejected", message: "Apple Music 真实通道暂未在站点开放" };
    };
  }

  async function netease(userId: string): Promise<NeteaseClient> {
    return new NeteaseClient(deviceIdFor(userId), deps.fetchImpl);
  }

  /** 写入按目标模式分流：DEMO 只动会话内演示库，REAL 才真建歌单并回读。 */
  async function writeTarget(userId: string, job: Job, target: { id: string }, ids: string[]) {
    if (job.targetMode === "DEMO") {
      const state = (await store.loadDemoState(userId)) ?? emptyDemoStoreState();
      const adapter = createDemoProvider(providerIdFrom(job.targetProvider), state);
      const connection = adapter.connectDemo(userId);
      const playlist: CreatedPlaylist = { id: target.id, name: job.requestedName,
        url: "demo://library/" + target.id, trackCount: 0, metadata: {} };
      adapter.addTracks(connection, playlist, ids.map(id => toTrack(trackFor(id, job))));
      await store.saveDemoState(userId, state);
      return { kind: "written" as const, count: ids.length };
    }
    if (job.targetProvider === "QQ_MUSIC") {
      const { cookie } = await credentialsFor(userId, "QQ_MUSIC");
      const tid = job.createdTarget?.tid ?? "";
      if (!tid) throw new ProviderApiError(409, "MIGRATION_STATE", "QQ 音乐歌单写入会话已失效，请重新创建任务");
      const connection: QqConnection = { provider: "QQ_MUSIC", mode: "REAL", credentials: { cookie } };
      await qqAddTracks(connection, {
        id: target.id, name: job.createdTarget?.name ?? job.requestedName, url: "",
        trackCount: 0, metadata: { tid },
      }, ids.map(id => trackFor(id, job)), qqOptions());
      return { kind: "written" as const, count: ids.length };
    }
    const client = await netease(userId);
    const { cookie } = await credentialsFor(userId, "NETEASE_MUSIC");
    return client.addTracks(cookie, target.id, ids.map(id => trackFor(id, job)));
  }

  async function createTarget(userId: string, job: Job, name: string) {
    if (job.targetMode === "DEMO") {
      const state = (await store.loadDemoState(userId)) ?? emptyDemoStoreState();
      const adapter = createDemoProvider(providerIdFrom(job.targetProvider), state);
      const created = adapter.createPlaylist(adapter.connectDemo(userId), name, "");
      await store.saveDemoState(userId, state);
      return { id: created.id, name: created.name, url: created.url };
    }
    if (job.targetProvider === "QQ_MUSIC") {
      const { cookie } = await credentialsFor(userId, "QQ_MUSIC");
      const connection: QqConnection = { provider: "QQ_MUSIC", mode: "REAL", credentials: { cookie } };
      const created = await qqCreatePlaylist(connection, name, "", qqOptions());
      return { id: created.id, name: created.name, url: created.url, tid: created.metadata?.tid ?? "" };
    }
    const client = await netease(userId);
    const { cookie } = await credentialsFor(userId, "NETEASE_MUSIC");
    return client.createPlaylist(cookie, name);
  }

  async function needJob(ctx: Ctx): Promise<Job> {
    const job = await store.loadJob(ctx.user.user_id, ctx.params.id);
    if (!job) throw ProviderApiError.notFound("任务不存在");
    const before = job.status;
    reap(job, now());
    if (job.status !== before) await store.saveJob(job);
    return job;
  }

  /** 当前未结束任务；顺手执行 Java cleanup() 的预览过期中断。 */
  async function activeJob(userId: string): Promise<Job | null> {
    const job = await store.findRunningJob(userId);
    if (!job) return null;
    const before = job.status;
    reap(job, now());
    if (job.status !== before) await store.saveJob(job);
    return isTerminal(job) ? null : job;
  }

  async function requireTarget(userId: string, provider: ProviderId): Promise<Connection> {
    const stored = await store.loadConnection(userId, provider);
    if (!stored) throw ProviderApiError.notConnected("请先连接 " + providerLabel(provider));
    if (stored.mode !== "DEMO" && (!stored.credential || stored.credential.expiresAt <= now())) {
      throw ProviderApiError.unauthorized("平台登录态已过期，请重新连接 " + providerLabel(provider));
    }
    return stored;
  }

  function trackFor(id: string, job: Job): MatcherTrack {
    const row = job.matches.find(match => match.targetTrackId === id);
    return { providerTrackId: id, title: row ? row.targetTitle : "", artist: row ? row.targetArtist : "",
      album: row ? row.targetAlbum : "", durationSec: 0, artworkUrl: row ? row.targetArtworkUrl : "",
      songType: row ? row.targetSongType ?? 0 : 0 };
  }

  async function handler(request: Request): Promise<Response> {
    try {
      const found = resolve(routes, request.method, request);
      if (!found) return json({ error: "页面不存在", code: "NOT_FOUND" }, 404);
      let user: Ctx["user"] | null = null;
      try {
        user = getUser(request);
      } catch (error) {
        // 登录快照必须能在旧/过期上下文下返回"未登录"，不能把用户锁在错误页。
        if (found.route.auth) throw error;
      }
      if (found.route.auth && !user) {
        return errorResponse(new ProviderApiError(401, "AUTH_REQUIRED", "请先登录 Qoder 账号"));
      }
      const ctx: Ctx = { request, params: found.params, query: new URL(request.url).searchParams,
        user: user ?? { user_id: "" }, csrfValid: false };
      if (request.method !== "GET") {
        if (!user) throw ProviderApiError.authRequired("请先登录 Qoder 账号");
        await assertCsrf(request, user.user_id);
      }
      const result = await found.route.handle(ctx);
      return result instanceof Response ? result : json(result);
    } catch (error) {
      return errorResponse(error);
    }
  }

  return { handler, routes, csrfTokenFor: (userId: string) => csrfToken(userId) };
}

function normalizeProvider(value: string): ProviderId {
  const key = (value || "").trim().toUpperCase();
  if (!PROVIDER_LABELS[key]) throw ProviderApiError.badRequest("未知的音乐平台：" + value);
  return key as ProviderId;
}

function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

function newId(): string {
  return (globalThis as { crypto?: Crypto }).crypto?.randomUUID
    ? crypto.randomUUID().replace(/-/g, "").slice(0, 16)
    : String(Date.now()) + Math.random().toString(16).slice(2, 10);
}

/** 同一用户用固定 deviceId，避免每次请求都像新设备（Java 是每 JVM 随机，这是刻意改进）。 */
function deviceIdFor(userId: string): string {
  let hash = 2166136261;
  const seed = "tunebridge:" + userId;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const hex = (hash >>> 0).toString(16).padStart(8, "0");
  return (hex + hex + hex + hex).slice(0, 32);
}

function trackView(track: Job["sourceTracks"][number]) {
  return {
    id: track.providerTrackId,
    providerTrackId: track.providerTrackId,
    title: track.title,
    artist: track.artist,
    album: track.album,
    durationSec: track.durationSec,
    artworkUrl: track.artworkUrl,
  };
}

function playlistView(provider: string, url: string, playlist: LoadedPlaylist, maxTracks = MAX_TRACKS) {
  const all = playlist.tracks;
  const limit = maxTracks <= 0 ? all.length : Math.min(all.length, maxTracks);
  return {
    provider, url, id: playlist.id, name: playlist.name, description: playlist.description,
    coverUrl: playlist.coverUrl, owner: playlist.owner, webUrl: playlist.webUrl,
    totalTracks: all.length, truncated: all.length > limit,
    trackCount: all.length, tracks: all.slice(0, limit).map(trackView),
  };
}

function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return [...value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()]
    .slice(0, max).join("").trim();
}

/** Java MigrationService.sanitizeName：控制字符直接去掉，折叠空白，最多 60 个字符。 */
function sanitizeName(value: unknown): string {
  if (typeof value !== "string") return "";
  return [...value.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim()]
    .slice(0, 60).join("").trim();
}

/** 与 Java createBackupJob 一致：坏条目直接跳过，时长夹到 [0, 24h]，不清空整份备份。 */
function backupTrack(value: unknown): Job["sourceTracks"][number] | null {
  const row = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
  if (!row) return null;
  const title = cleanText(row.title, 300);
  if (!title) return null;
  const rawDuration = Number(row.durationSec);
  const duration = Number.isFinite(rawDuration) ? Math.max(0, Math.min(Math.floor(rawDuration), 24 * 3600)) : 0;
  return {
    providerTrackId: "", title, artist: cleanText(row.artist, 300), album: cleanText(row.album, 300),
    durationSec: duration, artworkUrl: "", songType: 0,
  };
}

function intQuery(value: string | null, fallback: number, min: number, max: number, message: string): number {
  if (value === null || value === "") return fallback;
  if (!/^\d{1,7}$/.test(value)) throw ProviderApiError.badRequest(message);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw ProviderApiError.badRequest(message);
  }
  return parsed;
}

function optionalProvider(value: string | null, message: string): string | null {
  if (value === null || value === "") return null;
  const key = value.trim().toUpperCase();
  if (!PROVIDER_LABELS[key]) throw ProviderApiError.badRequest(message);
  return key;
}

function optionalSource(value: string | null): string | null {
  if (value === null || value === "") return null;
  const key = value.trim().toUpperCase();
  if (key === "LOCAL_BACKUP" || PROVIDER_LABELS[key]) return key;
  throw ProviderApiError.badRequest("历史记录筛选参数无效");
}

function optionalStatus(value: string | null): string | null {
  if (value === null || value === "") return null;
  const key = value.trim().toUpperCase();
  if (!JOB_STATUSES.has(key)) throw ProviderApiError.badRequest("历史记录筛选参数无效");
  return key;
}

function optionalDay(value: string | null): string | null {
  if (value === null || value === "") return null;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/.test(value);
  if ((!day && !instant) || !Number.isFinite(historyBoundary(value, false))) {
    throw ProviderApiError.badRequest("时间筛选格式无效，请使用 YYYY-MM-DD 或带时区的 ISO 时间");
  }
  return value;
}

export { memoryStore };