import { ProviderApiError } from "./errors.ts";
import { evaluate, percent } from "./matcher.ts";
import type { SearchOutcome } from "./netease.ts";

/**
 * 迁移任务的无状态推进器：Java 侧靠常驻线程 + 阻塞等待确认，边缘运行时做不到，
 * 所以任务全部是可序列化的记录，由客户端每次请求推动一小段（分片匹配 / 分批写入），
 * 限流时不在函数里睡觉，而是写下 nextAttemptAt 让浏览器按点回来。
 * 进度锚点、日志文案、状态机与错误码逐条对齐 MigrationService / MigrationJob。
 */

export type JobStatus = "QUEUED" | "RUNNING" | "AWAITING_CONFIRMATION" | "COMPLETED" | "FAILED" | "INTERRUPTED";

export type MatchRow = {
  source: { providerTrackId: string; title: string; artist: string; album: string; durationSec: number };
  matched: boolean;
  lowConfidence: boolean;
  targetTitle: string;
  targetArtist: string;
  targetAlbum: string;
  targetArtworkUrl: string;
  targetTrackId: string;
  /** QQ 真实写入需要原样带 songtype；旧任务没有该字段时按 0 处理。 */
  targetSongType?: number;
  score: number;
  note: string;
};

/** Java 的 LogEntry.level 是自由字符串，实际取值就是这四种，前端按 level 上色。 */
export type LogLevel = "INFO" | "WARN" | "ERROR" | "SUCCESS";

export type LogEntry = { message: string; level: LogLevel; at: string };

export type Job = {
  id: string;
  userId: string;
  sourceProvider: string;
  sourceLabel: string | null;
  sourceUrl: string | null;
  targetProvider: string;
  targetMode: string;
  /** 建任务时的目标连接时间戳，用来识别“同模式但换了连接”；旧任务缺省时退回模式比对。 */
  targetConnectionAt?: number;
  requestedName: string;
  status: JobStatus;
  progress: number;
  currentStep: string;
  sourceTracks: { providerTrackId: string; title: string; artist: string; album: string; durationSec: number; artworkUrl: string; songType: number }[];
  sourcePlaylist: { name: string; coverUrl: string; owner: string; trackCount?: number } | null;
  matches: MatchRow[];
  selected: number[];
  /** 下一个待搜索的来源曲目下标；也是断点续跑的游标。 */
  cursor: number;
  /** 限流后退到什么时候再试；0 表示不等待。 */
  nextAttemptAt: number;
  retryHint: string;
  /** tid 是 QQ 建单后写歌的凭据句柄，随任务持久化，跨函数实例续写也不丢。 */
  createdTarget: { id: string; name: string; url: string; tid?: string } | null;
  /** 已确认写入的曲目 id，重跑时只补这些之外的。 */
  writtenIds: string[];
  pendingWriteIds: string[];
  result: { playlistId: string; playlistName: string; playlistUrl: string; addedCount: number } | null;
  error: string;
  recoveryNotice: string | null;
  logs: LogEntry[];
  createdAt: number;
  updatedAt: number;
};

const CONFIRM_TTL_MS = 2 * 60 * 60 * 1000;

export function createJob(input: {
  id: string;
  userId: string;
  sourceProvider: string;
  sourceLabel: string | null;
  sourceUrl: string | null;
  targetProvider: string;
  targetMode: string;
  targetConnectionAt?: number;
  requestedName: string;
  now?: number;
}): Job {
  const now = input.now ?? Date.now();
  const job: Job = {
    id: input.id,
    userId: input.userId,
    sourceProvider: input.sourceProvider,
    sourceLabel: input.sourceLabel,
    sourceUrl: input.sourceUrl,
    targetProvider: input.targetProvider,
    targetMode: input.targetMode,
    targetConnectionAt: input.targetConnectionAt,
    requestedName: input.requestedName,
    status: "RUNNING",
    progress: 2,
    currentStep: "正在读取来源歌单",
    sourceTracks: [],
    sourcePlaylist: null,
    matches: [],
    selected: [],
    cursor: 0,
    nextAttemptAt: 0,
    retryHint: "",
    createdTarget: null,
    writtenIds: [],
    pendingWriteIds: [],
    result: null,
    error: "",
    recoveryNotice: null,
    logs: [],
    createdAt: now,
    updatedAt: now,
  };
  // 顺序照 Java：先声明"确认前不会写入"，再报读取到的曲目数。
  job.logs.push({ message: "匹配任务已创建，确认前不会创建或写入目标歌单", level: "INFO",
    at: new Date(now).toISOString() });
  return job;
}

const MATCH_TRACK_LIMIT = 200;

export function attachSource(job: Job, playlist: {
  name: string; coverUrl?: string; owner?: string; tracks: Job["sourceTracks"];
}, now = Date.now()): void {
  const total = playlist.tracks.length;
  job.sourcePlaylist = { name: playlist.name, coverUrl: playlist.coverUrl ?? "",
    owner: playlist.owner ?? "", trackCount: total };
  job.sourceTracks = playlist.tracks.slice(0, MATCH_TRACK_LIMIT);
  job.currentStep = "正在读取来源歌单";
  bump(job, 5, now);
  log(job, "已读取《" + playlist.name + "》，共 " + total + " 首", "SUCCESS");
}

export function trackCount(job: Job): number {
  return job.sourceTracks.length;
}

function bump(job: Job, target: number, now: number): void {
  job.progress = Math.max(job.progress, Math.min(99, target));
  job.updatedAt = now;
}

function log(job: Job, message: string, level: LogEntry["level"] = "INFO"): void {
  job.logs.push({ message, level, at: new Date().toISOString() });
  if (job.logs.length > 400) job.logs.splice(0, job.logs.length - 400);
}

export function logJob(job: Job, message: string, level: LogEntry["level"] = "INFO"): void {
  log(job, message, level);
}

export type MatchAdvance =
  | { kind: "waiting"; retryAfterMs: number }
  | { kind: "matching"; progress: number }
  | { kind: "ready" }
  | { kind: "failed"; message: string };

/**
 * 推进至多 slice 首匹配。一次函数调用只做有限次上游搜索，
 * 剩余部分由浏览器下一次轮询继续，避免顶爆请求时限。
 */
export async function advanceMatch(
    job: Job, search: (sourceTrack: Job["sourceTracks"][number]) => Promise<SearchOutcome>,
    slice: number, now = Date.now()): Promise<MatchAdvance> {
  if (job.status !== "RUNNING") throw notAwaiting(job, "任务不在匹配阶段");
  if (job.nextAttemptAt > now) {
    return { kind: "waiting", retryAfterMs: job.nextAttemptAt - now };
  }
  if (job.cursor === 0) {
    job.currentStep = "正在匹配歌曲";
    bump(job, 15, now);
  }

  const total = job.sourceTracks.length;
  const limit = Math.min(total, job.cursor + Math.max(1, slice));
  for (; job.cursor < limit; job.cursor++) {
    const source = job.sourceTracks[job.cursor];
    const outcome = await search(source);
    if (outcome.kind === "throttled") {
      job.nextAttemptAt = now + outcome.retryAfterMs;
      job.retryHint = source.title;
      log(job, "搜索《" + source.title + "》遇到限流（" + outcome.detail + "），稍后自动重试", "WARN");
      bump(job, 15 + Math.floor(60 * job.cursor / Math.max(1, total)), now);
      return { kind: "waiting", retryAfterMs: outcome.retryAfterMs };
    }
    if (outcome.kind === "rejected") {
      // 对齐 PR #5：上游报错就终止本次匹配，不交付缺歌的确认页。
      job.status = "FAILED";
      job.error = outcome.message;
      job.progress = Math.max(job.progress, 15);
      log(job, "搜索《" + source.title + "》失败：" + outcome.message, "WARN");
      return { kind: "failed", message: outcome.message };
    }

    const candidates = outcome.kind === "candidates" ? outcome.tracks : [];
    const evaluation = evaluate(source, candidates);
    if (evaluation.matched && evaluation.candidate) {
      const hit = evaluation.candidate;
      job.matches.push({
        source: pick(source), matched: true, lowConfidence: evaluation.lowConfidence,
        targetTitle: hit.title, targetArtist: hit.artist, targetAlbum: hit.album,
        targetArtworkUrl: hit.artworkUrl, targetTrackId: hit.providerTrackId,
        targetSongType: hit.songType, score: evaluation.score, note: evaluation.note,
      });
      if (!evaluation.lowConfidence) job.selected.push(job.matches.length - 1);
      log(job, "✓ " + source.title + " → " + hit.title + "（" + percent(evaluation.score) + "%）"
        + (evaluation.lowConfidence ? " · 低置信" : ""), "SUCCESS");
    } else {
      job.matches.push({
        source: pick(source), matched: false, lowConfidence: false, targetTitle: "", targetArtist: "",
        targetAlbum: "", targetArtworkUrl: "", targetTrackId: "", score: evaluation.score, note: evaluation.note,
      });
      log(job, "✗ " + source.title + " · " + evaluation.note, "WARN");
    }
    bump(job, 15 + Math.floor(60 * (job.cursor + 1) / Math.max(1, total)), now);
  }

  if (job.cursor < total) return { kind: "matching", progress: job.progress };

  const matchedCount = job.matches.filter(row => row.matched).length;
  if (matchedCount === 0) {
    job.status = "FAILED";
    job.error = "没有匹配到任何歌曲，已取消创建空歌单";
    log(job, job.error, "ERROR");
    return { kind: "failed", message: job.error };
  }
  log(job, "匹配完成：" + matchedCount + " / " + job.matches.length + " 首；尚未创建目标歌单", "INFO");
  job.status = "AWAITING_CONFIRMATION";
  job.currentStep = "匹配完成，等待勾选确认";
  bump(job, 75, now);
  return { kind: "ready" };
}

export type ConfirmOutcome =
  | { kind: "waiting"; retryAfterMs: number }
  | { kind: "done" }
  | { kind: "partial"; written: number };

/** 确认写入。已建过的歌单与已落库的曲目都记住，重跑只补差集（issue #7 的续跑原语）。 */
export async function confirmJob(job: Job, indices: (number | null)[], deps: {
  createPlaylist: (name: string) => Promise<{ id: string; name: string; url: string; tid?: string }>;
  addTracks: (target: { id: string }, ids: string[]) => Promise<{ kind: "written"; count: number }
    | { kind: "throttled"; written: number; retryAfterMs: number }>;
  playlistNameFor: (job: Job) => string;
  /** 建单成功后立刻落一次库，避免"已建单但响应丢失"被下一请求重复创建。 */
  checkpoint?: () => Promise<void>;
  now?: number;
}): Promise<ConfirmOutcome> {
  const now = deps.now ?? Date.now();
  if (job.status === "AWAITING_CONFIRMATION") {
    if (!indices || indices.length === 0) throw ProviderApiError.badRequest("请至少选择一首已匹配的歌曲");
    const seen = new Set<number>();
    for (const index of indices) {
      if (index === null || index === undefined || !Number.isInteger(index) || index < 0
          || index >= job.matches.length || !job.matches[index].matched || seen.has(index)) {
        throw ProviderApiError.badRequest("所选歌曲无效，请选择不重复的已匹配歌曲");
      }
      seen.add(index);
    }
    const ordered = [...seen].sort((a, b) => a - b);
    job.selected = ordered;
    job.pendingWriteIds = ordered.map(index => job.matches[index].targetTrackId);
    if (job.targetProvider === "NETEASE_MUSIC"
        && new Set(job.pendingWriteIds).size !== job.pendingWriteIds.length) {
      throw ProviderApiError.badRequest("网易云不能重复加入同一首歌曲，请取消重复的匹配项");
    }
    log(job, "已确认迁移 " + seen.size + " 首，跳过 "
      + (job.matches.filter(row => row.matched).length - seen.size) + " 首匹配项", "INFO");
    job.status = "RUNNING";
    job.currentStep = "正在创建目标歌单";
    bump(job, 79, now);
  } else if (!(job.status === "RUNNING" && job.createdTarget && job.pendingWriteIds.length > 0)) {
    // 只有"已建单、尚有未落库曲目"的 RUNNING 任务允许续写；其余一律按 Java 的 MIGRATION_STATE 拒绝。
    throw notAwaiting(job, "任务不在等待确认状态，请勿重复确认");
  }

  if (!job.createdTarget) {
    job.createdTarget = await deps.createPlaylist(deps.playlistNameFor(job));
    await deps.checkpoint?.();
  }
  job.currentStep = "正在写入歌曲";
  bump(job, 88, now);

  const remaining = job.pendingWriteIds.filter(id => !job.writtenIds.includes(id));
  if (remaining.length > 0) {
    const outcome = await deps.addTracks(job.createdTarget, remaining);
    if (outcome.kind === "throttled") {
      job.writtenIds = mergeIds(job.writtenIds, remaining.slice(0, outcome.written));
      job.nextAttemptAt = now + outcome.retryAfterMs;
      return { kind: "partial", written: outcome.written };
    }
    job.writtenIds = mergeIds(job.writtenIds, remaining);
  }

  const added = job.writtenIds.length;
  const matchedCount = job.matches.filter(row => row.matched).length;
  const total = job.matches.length;
  job.result = {
    playlistId: job.createdTarget.id,
    playlistName: job.createdTarget.name,
    playlistUrl: job.createdTarget.url,
    addedCount: added,
  };
  job.status = "COMPLETED";
  job.currentStep = "迁移完成";
  job.progress = 100;
  job.nextAttemptAt = 0;
  log(job, "迁移完成：写入 " + added + " 首，匹配 " + matchedCount + "/" + total + " 首", "INFO");
  return { kind: "done" };
}

function mergeIds(existing: string[], added: string[]): string[] {
  const set = new Set(existing);
  for (const id of added) set.add(id);
  return [...set];
}

function notAwaiting(job: Job, message: string): ProviderApiError {
  return new ProviderApiError(409, "MIGRATION_STATE", message);
}

function pick(track: Job["sourceTracks"][number]) {
  return { providerTrackId: track.providerTrackId, title: track.title, artist: track.artist,
    album: track.album, durationSec: track.durationSec };
}

/** 端口自 Java 的 MigrationJob.interrupt()：状态转 INTERRUPTED 并留同一句提示。 */
export function interrupt(job: Job, notice: string, now = Date.now()): void {
  job.status = "INTERRUPTED";
  job.error = notice;
  job.recoveryNotice = notice;
  job.currentStep = "任务已中断";
  job.updatedAt = now;
}

export function isTerminal(job: Job): boolean {
  return job.status === "COMPLETED" || job.status === "FAILED" || job.status === "INTERRUPTED";
}

/** 端口自 MigrationService.cleanup()：超两小时未确认的预览按过期中断。 */
export function reap(job: Job, now = Date.now()): { evictable: boolean } {
  const cutoff = now - CONFIRM_TTL_MS;
  if (job.status === "AWAITING_CONFIRMATION" && job.createdAt < cutoff) {
    interrupt(job, "匹配预览已过期", now);
  }
  return { evictable: isTerminal(job) && job.createdAt < cutoff };
}

const PROVIDER_LABELS: Record<string, string> = {
  QQ_MUSIC: "QQ 音乐", APPLE_MUSIC: "Apple Music", NETEASE_MUSIC: "网易云音乐",
  LOCAL_BACKUP: "本地备份",
};

function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

/** 与 Java JobView 同形；浏览器代码不需要为 Sites 版改字段名。 */
export function jobView(job: Job, readOnly = false): Record<string, unknown> {
  const sourceProvider = job.sourceLabel === null ? job.sourceProvider : "LOCAL_BACKUP";
  const matchedCount = job.matches.filter(row => row.matched).length;
  const total = job.matches.length;
  const added = job.result ? job.result.addedCount : 0;
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    currentStep: job.currentStep,
    source: {
      provider: sourceProvider,
      providerLabel: job.sourceLabel ?? providerLabel(job.sourceProvider),
      name: job.sourcePlaylist ? job.sourcePlaylist.name : (job.requestedName || "正在读取歌单"),
      coverUrl: job.sourcePlaylist ? job.sourcePlaylist.coverUrl : "",
      owner: job.sourcePlaylist ? job.sourcePlaylist.owner : "",
      trackCount: job.sourcePlaylist ? (job.sourcePlaylist.trackCount ?? job.sourceTracks.length) : 0,
    },
    target: { provider: job.targetProvider, providerLabel: providerLabel(job.targetProvider), mode: job.targetMode },
    logs: job.logs,
    matches: job.matches.map((row, index) => ({
      index,
      selected: job.selected.includes(index),
      title: row.source.title,
      artist: row.source.artist,
      album: row.source.album,
      durationSec: row.source.durationSec,
      matched: row.matched,
      lowConfidence: row.lowConfidence,
      targetTitle: row.targetTitle,
      targetArtist: row.targetArtist,
      targetAlbum: row.targetAlbum,
      targetArtworkUrl: row.targetArtworkUrl,
      score: Math.round(row.score * 100),
      note: row.note,
    })),
    result: job.result ? {
      playlistId: job.result.playlistId,
      playlistName: job.result.playlistName,
      playlistUrl: job.result.playlistUrl,
      addedCount: added,
      unmatchedCount: total - matchedCount,
      totalCount: total,
      matchRate: total === 0 ? 0 : Math.round(matchedCount * 100 / total),
      skippedCount: matchedCount - added,
      matchedCount,
    } : null,
    error: job.error || null,
    createdAt: new Date(job.createdAt).toISOString(),
    readOnly,
    recoveryNotice: job.recoveryNotice,
    createdTarget: job.createdTarget
      ? { playlistId: job.createdTarget.id, playlistName: job.createdTarget.name, playlistUrl: job.createdTarget.url }
      : null,
    nextAttemptAt: job.nextAttemptAt || null,
  };
}
