import { ProviderApiError } from "./errors.ts";
import { errorResponse, json, readJson, resolve, routeCandidates, type Ctx, type Route } from "./http.ts";
import { assertCsrf, csrfToken } from "./csrf.ts";
import { getUser } from "./auth.mjs";
import { open, seal } from "./vault.ts";
import { memoryStore, type Store } from "./store.ts";
import { NeteaseClient, type NetTrack, type SearchOutcome } from "./netease.ts";
import { advanceMatch, attachSource, confirmJob, createJob, interrupt, isTerminal, jobView, reap, type Job } from "./job.ts";
import { toTrack } from "./matcher.ts";
import { createDemoProvider, emptyDemoStoreState, providerIdFrom, type CreatedPlaylist, type ProviderId } from "./demo.ts";
import { qqConnectReal, qqFetchPlaylist, qqListPlaylists, type QqConnection, type QqOptions } from "./qq.ts";

/**
 * 站点侧的 API 入口（纯 handler，便于本地用 Node 直接驱动验证；index.ts 只负责 Deno.serve）。
 * 覆盖核心链路：连接、来源读取、分片匹配、确认写入、断点续跑、放弃、状态与历史列表。
 * 尚未接线（留到第 5 阶段）：网易云扫码登录两条、备份预览/恢复、批量队列、音桥账号注册。
 */

const PROVIDER_LABELS: Record<string, string> = {
  QQ_MUSIC: "QQ 音乐", APPLE_MUSIC: "Apple Music", NETEASE_MUSIC: "网易云音乐",
};
const CREDENTIAL_TTL_MS: Record<string, number> = {
  QQ_MUSIC: 3 * 24 * 3600 * 1000,
  NETEASE_MUSIC: 30 * 24 * 3600 * 1000,
  APPLE_MUSIC: 70 * 24 * 3600 * 1000,
};
const MAX_TRACKS = 200;
function processEnvGuard(): { env?: Record<string, string | undefined> } | undefined {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
}

const runtimeProcess = processEnvGuard();
const MATCH_SLICE = Number(runtimeProcess?.env?.TUNEBRIDGE_MATCH_SLICE ?? 8);

export type AppDeps = { store: Store; fetchImpl?: typeof fetch; now?: () => number };

export function createApp(deps: AppDeps) {
  const store = deps.store;
  const now = deps.now ?? (() => Date.now());

  const routes: Route[] = [
    { method: "GET", segments: ["state"], auth: true, handle: state },
    { method: "GET", segments: ["config"], auth: false, handle: config },
    { method: "POST", segments: ["connections", ":provider"], auth: true, handle: connect },
    { method: "DELETE", segments: ["connections", ":provider"], auth: true, handle: disconnect },
    { method: "GET", segments: ["playlists"], auth: true, handle: playlists },
    { method: "POST", segments: ["playlists", "preview"], auth: true, handle: preview },
    { method: "POST", segments: ["migrations"], auth: true, handle: startMigration },
    { method: "GET", segments: ["migrations"], auth: true, handle: listMigrations },
    { method: "GET", segments: ["migrations", "current"], auth: true, handle: currentMigration },
    { method: "GET", segments: ["migrations", ":id"], auth: true, handle: getMigration },
    { method: "POST", segments: ["migrations", ":id", "advance"], auth: true, handle: advance },
    { method: "POST", segments: ["migrations", ":id", "confirm"], auth: true, handle: confirm },
    { method: "POST", segments: ["migrations", ":id", "abandon"], auth: true, handle: abandon },
  ];

  async function state(ctx: Ctx) {
    const connections: Record<string, unknown> = {};
    for (const provider of Object.keys(PROVIDER_LABELS)) {
      const stored = await store.loadConnection(ctx.user.user_id, provider);
      // 演示连接按设计不持有凭据，不能用"有凭据"当作已连接的判据。
      const usable = stored && (stored.mode === "DEMO"
        || (stored.credential !== null && stored.credential.expiresAt > now()));
      if (usable) {
        connections[provider] = { provider, label: stored.label, mode: stored.mode, connected: true };
      }
    }
    const active = await store.findRunningJob(ctx.user.user_id);
    return json({
      connections,
      providers: Object.entries(PROVIDER_LABELS).map(([id, label]) => ({ id, label, sampleUrl: "" })),
      config: configBody(),
      activeJobId: active ? active.id : null,
    });
  }

  function configBody() {
    return {
      appleRealReady: false, demoEnabled: true, defaultStorefront: "cn", maxTracks: MAX_TRACKS,
      appleDeveloperToken: null, neteaseRealReady: true, authMode: "sites",
    };
  }

  async function config() {
    return json(configBody());
  }

  async function connect(ctx: Ctx) {
    const provider = normalizeProvider(ctx.params.provider);
    const body = await readJson(ctx.request);
    const mode = String(body.mode ?? "real");
    if (mode === "demo") {
      await store.saveConnection({ userId: ctx.user.user_id, provider, mode: "DEMO",
        label: PROVIDER_LABELS[provider] + " 演示", credential: null, createdAt: now() });
      return json({ provider, label: PROVIDER_LABELS[provider], mode: "DEMO", connected: true });
    }
    if (provider === "NETEASE_MUSIC") {
      const cookie = String(body.cookie ?? "").trim();
      if (!cookie) throw ProviderApiError.badRequest("请粘贴网易云登录 Cookie");
      const client = new NeteaseClient(deviceIdFor(ctx.user.user_id), deps.fetchImpl);
      const nickname = await client.accountName(cookie);
      await store.saveConnection({ userId: ctx.user.user_id, provider, mode: "REAL", label: nickname,
        credential: await seal(ctx.user.user_id, cookie, CREDENTIAL_TTL_MS[provider]), createdAt: now() });
      return json({ provider, label: nickname, mode: "REAL", connected: true });
    }
    if (provider === "QQ_MUSIC") {
      const cookie = String(body.cookie ?? "").trim();
      if (!cookie) throw ProviderApiError.badRequest("请粘贴 QQ 音乐登录 Cookie");
      const connection = await qqConnectReal({ cookie }, qqOptions());
      await store.saveConnection({ userId: ctx.user.user_id, provider, mode: "REAL",
        label: connection.accountName,
        credential: await seal(ctx.user.user_id, cookie, CREDENTIAL_TTL_MS[provider]), createdAt: now() });
      return json({ provider, label: connection.accountName, mode: "REAL", connected: true });
    }
    throw ProviderApiError.badRequest("该平台请使用对应的连接方式");
  }

  async function disconnect(ctx: Ctx) {
    await store.dropConnection(ctx.user.user_id, normalizeProvider(ctx.params.provider));
    return new Response(null, { status: 204 });
  }

  /** 返回该连接的凭据明文；DEMO 连接没有凭据，返回空串由调用方分流。 */
  async function credentialsFor(userId: string, provider: string): Promise<{ mode: string; cookie: string }> {
    const stored = await store.loadConnection(userId, provider);
    if (!stored) throw ProviderApiError.notConnected("请先连接 " + PROVIDER_LABELS[provider]);
    if (stored.mode === "DEMO") return { mode: "DEMO", cookie: "" };
    if (!stored.credential) throw ProviderApiError.notConnected("请先连接 " + PROVIDER_LABELS[provider]);
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
    const stored = await store.loadConnection(userId, provider);
    if (!stored) throw ProviderApiError.notConnected("请先连接 " + PROVIDER_LABELS[provider]);
    // 先解凭据：过期要报 401 凭据失效，而不是被后面任何分支的误导性原因顶掉。
    const cookie = await open(userId, stored.credential);
    return { provider: provider as "QQ_MUSIC", mode: "REAL", accountName: stored.label, credentials: { cookie } };
  }

  async function loadSource(userId: string, provider: ProviderId, url: string) {
    // 与 Java 一致：网易云作为来源是无条件 400，不能被"请先连接"这类状态错误抢先掩盖。
    if (provider === "NETEASE_MUSIC") {
      throw ProviderApiError.badRequest("网易云音乐暂不支持作为来源平台");
    }
    const stored = await store.loadConnection(userId, provider);
    if (!stored) throw ProviderApiError.notConnected("请先连接 " + PROVIDER_LABELS[provider]);
    if (stored.mode !== "DEMO") {
      const connection = await qqRealConnection(userId, provider);
      const playlist = await qqFetchPlaylist(connection, url, qqOptions());
      return {
        name: playlist.name, coverUrl: playlist.coverUrl ?? "", owner: playlist.owner ?? "",
        tracks: playlist.tracks.slice(0, MAX_TRACKS).map(track => ({
          providerTrackId: String(track.providerTrackId), title: track.title, artist: track.artist,
          album: track.album, durationSec: track.durationSec, artworkUrl: track.artworkUrl ?? "",
          songType: track.songType ?? 0,
        })),
      };
    }
    const state = (await store.loadDemoState(userId)) ?? emptyDemoStoreState();
    const adapter = createDemoProvider(provider, state);
    const conn = adapter.connectDemo(userId);
    const playlist = adapter.fetchPlaylist(conn, url || "demo://builtin");
    await store.saveDemoState(userId, state);
    return {
      name: playlist.name, coverUrl: playlist.coverUrl ?? "", owner: playlist.owner ?? "",
      tracks: playlist.tracks.slice(0, MAX_TRACKS).map(track => ({
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
    if (!stored) throw ProviderApiError.notConnected("请先连接 " + PROVIDER_LABELS[provider]);
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
    const url = String(body.url ?? "");
    if (!url) throw ProviderApiError.badRequest("请填写歌单链接");
    const playlist = await loadSource(ctx.user.user_id, provider, url);
    return json(playlistView(provider, url, playlist));
  }

  async function startMigration(ctx: Ctx) {
    const body = await readJson(ctx.request);
    const source = normalizeProvider(String(body.sourceProvider ?? ""));
    const target = normalizeProvider(String(body.targetProvider ?? ""));
    if (target !== "NETEASE_MUSIC") throw ProviderApiError.badRequest("真实迁移目前只支持写入网易云音乐");
    const running = await store.findRunningJob(ctx.user.user_id);
    if (running && !isTerminal(running)) {
      throw new ProviderApiError(409, "ACTIVE_JOB", "已有未完成的迁移任务，请先完成或放弃");
    }
    const playlist = await loadSource(ctx.user.user_id, source, String(body.sourceUrl ?? ""));
    if (playlist.tracks.length === 0) throw ProviderApiError.badRequest("来源歌单是空的");
    const job = createJob({ id: newId(), userId: ctx.user.user_id, sourceProvider: source,
      sourceLabel: null, sourceUrl: String(body.sourceUrl ?? ""), targetProvider: target,
      targetMode: (await store.loadConnection(ctx.user.user_id, target))?.mode ?? "REAL",
      requestedName: String(body.playlistName ?? "").trim() || (playlist.name + " · 音桥"), now: now() });
    attachSource(job, playlist, now());
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
    const indices = Array.isArray(body.selectedIndices)
      ? (body.selectedIndices as unknown[]).map(value => typeof value === "number" ? value : Number(value))
      : [];
    const outcome = await confirmJob(job, indices, {
      createPlaylist: (name) => createTarget(ctx.user.user_id, job, name),
      addTracks: (target, ids) => writeTarget(ctx.user.user_id, job, target, ids),
      playlistNameFor: (value) => value.requestedName,
      now: now(),
    });
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
    const jobs = await store.listJobs(ctx.user.user_id, 50);
    return json({ items: jobs.map(job => jobView(job, true)), total: jobs.length });
  }

  async function currentMigration(ctx: Ctx) {
    const job = await store.findRunningJob(ctx.user.user_id);
    if (!job) throw ProviderApiError.notFound("没有进行中的任务");
    return json(jobView(job));
  }

  async function getMigration(ctx: Ctx) {
    const job = await needJob(ctx);
    return json(jobView(job, isTerminal(job)));
  }

  /** 目标平台搜索：DEMO 走内置目标曲库，REAL 走已对拍的 eapi 通道。 */
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
      const client = new NeteaseClient(deviceIdFor(userId), deps.fetchImpl);
      const { cookie } = await credentialsFor(userId, job.targetProvider);
      return client.search(cookie, source.title, source.artist, 6);
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
      const conn = adapter.connectDemo(userId);
      const playlist: CreatedPlaylist = { id: target.id, name: job.requestedName,
        url: "demo://library/" + target.id, trackCount: 0, metadata: {} };
      adapter.addTracks(conn, playlist, ids.map(id => toTrack(trackFor(id, job))));
      await store.saveDemoState(userId, state);
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
    const client = await netease(userId);
    const { cookie } = await credentialsFor(userId, "NETEASE_MUSIC");
    return client.createPlaylist(cookie, name);
  }

  async function needJob(ctx: Ctx): Promise<Job> {
    const job = await store.loadJob(ctx.user.user_id, ctx.params.id);
    if (!job) throw ProviderApiError.notFound("任务不存在");
    return job;
  }

  function trackFor(id: string, job: Job): NetTrack {
    const row = job.matches.find(match => match.targetTrackId === id);
    return { providerTrackId: id, title: row ? row.targetTitle : "", artist: row ? row.targetArtist : "",
      album: row ? row.targetAlbum : "", durationSec: 0, artworkUrl: row ? row.targetArtworkUrl : "" };
  }

  async function handler(request: Request): Promise<Response> {
    const found = resolve(routes, request.method, request);
    if (!found) return json({ error: "页面不存在", code: "NOT_FOUND" }, 404);
    const user = getUser(request);
    if (found.route.auth && !user) {
      return errorResponse(new ProviderApiError(401, "AUTH_REQUIRED", "请先登录音桥账号"));
    }
    const ctx: Ctx = { request, params: found.params, query: new URL(request.url).searchParams,
      user: user ?? { user_id: "" }, csrfValid: false };
    try {
      if (request.method !== "GET") {
        if (!user) throw ProviderApiError.authRequired();
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

function playlistView(provider: string, url: string,
    playlist: { name: string; coverUrl: string; owner: string; tracks: NetTrack[] }) {
  return { provider, url, name: playlist.name, coverUrl: playlist.coverUrl,
    owner: playlist.owner, tracks: playlist.tracks, trackCount: playlist.tracks.length };
}

export { memoryStore };
