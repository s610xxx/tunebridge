import { advanceMatch, attachSource, confirmJob, createJob, jobView, reap } from "../site/functions/job.ts";

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : " — " + detail}`);
  if (!ok) failed++;
};

const tracks = (n) => Array.from({ length: n }, (_, i) => ({
  providerTrackId: "s" + i, title: "歌" + i, artist: "G.E.M.邓紫棋", album: "A" + i,
  durationSec: 200, artworkUrl: "", songType: 0,
}));

function fresh(n = 43) {
  const job = createJob({ id: "job-1", userId: "u1", sourceProvider: "QQ_MUSIC", sourceLabel: null,
    sourceUrl: "https://y.qq.com/n/ryqq/playlist/1", targetProvider: "NETEASE_MUSIC",
    targetMode: "REAL", requestedName: "I AM GLORIA · 音桥", now: 1_000 });
  attachSource(job, { name: "I AM GLORIA", coverUrl: "c", owner: "me", tracks: tracks(n) }, 1_000);
  return job;
}

const candidate = (track) => [{ providerTrackId: "t-" + track.providerTrackId, title: track.title,
  artist: track.artist, album: track.album, durationSec: track.durationSec, artworkUrl: "" }];

/* ---- 1. 分片推进 ---- */
let calls = 0;
const searching = async (track) => { calls++; return { kind: "candidates", tracks: candidate(track) }; };
const job = fresh(43);
let advance;
for (let round = 0; round < 6; round++) {
  advance = await advanceMatch(job, searching, 10, 2_000 + round * 1000);
  if (advance.kind !== "matching") break;
}
check("43 首按分片跑完并进入待确认", job.status === "AWAITING_CONFIRMATION", JSON.stringify(advance));
check("每首都只搜一次", calls === 43, String(calls));
check("进度单调到 75", job.progress === 75, String(job.progress));
check("日志首条是创建声明", job.logs[0].message === "匹配任务已创建，确认前不会创建或写入目标歌单", job.logs[0].message);
check("读取来源日志与 Java 同文案", job.logs[1].message === "已读取《I AM GLORIA》，共 43 首", job.logs[1].message);
check("匹配完成日志与 Java 同文案",
  job.logs.some(l => l.message === "匹配完成：43 / 43 首；尚未创建目标歌单"));
check("逐首成功日志格式一致", job.logs.some(l => /^✓ 歌0 → 歌0（100%）$/.test(l.message)),
  job.logs.find(l => l.message.startsWith("✓ 歌0"))?.message);
check("成功日志级别是 SUCCESS（与 Java 一致）",
  job.logs.find(l => l.message.startsWith("✓ 歌0"))?.level === "SUCCESS",
  String(job.logs.find(l => l.message.startsWith("✓ 歌0"))?.level));

/* ---- 2. 限流后从断点续跑，不重搜 ---- */
calls = 0;
const throttledAt = 30;
let throttledOnce = false;
const flaky = async (track) => {
  calls++;
  if (track.providerTrackId === "s" + throttledAt && !throttledOnce) {
    throttledOnce = true;
    return { kind: "throttled", retryAfterMs: 8000, detail: "业务码 405：操作频繁，请稍候再试" };
  }
  return { kind: "candidates", tracks: candidate(track) };
};
const job2 = fresh(43);
let a2 = await advanceMatch(job2, flaky, 50, 5_000);
check("命中限流返回 waiting 而不是失败", a2.kind === "waiting" && a2.retryAfterMs === 8000, JSON.stringify(a2));
check("游标停在限流那一首", job2.cursor === throttledAt, String(job2.cursor));
const callsAtThrottle = calls;
const tooEarly = await advanceMatch(job2, flaky, 50, 5_000 + 7_000);
check("退避窗口内再调不发包", tooEarly.kind === "waiting" && calls === callsAtThrottle, `calls=${calls}`);
a2 = await advanceMatch(job2, flaky, 50, 5_000 + 8_500);
check("窗口过后从断点继续", job2.status === "AWAITING_CONFIRMATION", JSON.stringify(a2));
check("续跑只补剩余，不重搜前 30 首", calls === callsAtThrottle + (43 - throttledAt),
  `总搜索 ${calls}，期望 ${callsAtThrottle + 13}`);
check("限流日志写明稍后自动重试",
  job2.logs.some(l => l.level === "WARN" && /遇到限流（业务码 405：操作频繁，请稍候再试）/.test(l.message)));

/* ---- 3. 上游报错终止整单，且不建歌单 ---- */
const abortive = async (track) => track.providerTrackId === "s5"
  ? { kind: "rejected", message: "网易云搜索失败（业务码 403：illegal request!）" }
  : { kind: "candidates", tracks: candidate(track) };
const job3 = fresh(43);
const a3 = await advanceMatch(job3, abortive, 50, 1_000);
check("非限流报错终止本次匹配", a3.kind === "failed" && job3.status === "FAILED", JSON.stringify(a3));
check("终止时未创建目标歌单", job3.createdTarget === null);
check("终止原因透出上游文案", /业务码 403：illegal request!/.test(job3.error), job3.error);

/* ---- 4. 零匹配 ---- */
const job4 = fresh(3);
await advanceMatch(job4, async () => ({ kind: "empty" }), 10, 1_000);
check("零匹配取消建单并报指定文案",
  job4.status === "FAILED" && job4.error === "没有匹配到任何歌曲，已取消创建空歌单", job4.error);
check("零匹配时未建单", job4.createdTarget === null);
check("未匹配行日志级别是 WARN（对齐 Java）",
  job4.logs.filter(l => l.message.startsWith("✗")).length === 3
  && job4.logs.filter(l => l.message.startsWith("✗")).every(l => l.level === "WARN"),
  JSON.stringify(job4.logs.filter(l => l.message.startsWith("✗")).map(l => l.level)));

/* ---- 5. 确认阶段入参校验 ---- */
const mk = () => {
  const j = fresh(5);
  return advanceMatch(j, searching, 10, 1_000).then(() => j);
};
let j5 = await mk();
let err = null;
try { await confirmJob(j5, [], { createPlaylist: async () => ({ id: "p", name: "n", url: "u" }),
  addTracks: async () => ({ kind: "written", count: 0 }), playlistNameFor: () => "n" }); }
catch (e) { err = e; }
check("空选择被拒", err && err.status === 400 && /至少选择一首/.test(err.message), String(err && err.message));

j5 = await mk();
err = null;
try { await confirmJob(j5, [0, 0], { createPlaylist: async () => ({ id: "p", name: "n", url: "u" }),
  addTracks: async () => ({ kind: "written", count: 0 }), playlistNameFor: () => "n" }); }
catch (e) { err = e; }
check("重复下标被拒", err && /不重复的已匹配歌曲/.test(err.message), String(err && err.message));

j5 = await mk();
j5.matches[1].matched = false;
err = null;
try { await confirmJob(j5, [0, 1], { createPlaylist: async () => ({ id: "p", name: "n", url: "u" }),
  addTracks: async () => ({ kind: "written", count: 0 }), playlistNameFor: () => "n" }); }
catch (e) { err = e; }
check("选择未匹配下标被拒", err && err.status === 400, String(err && err.code));

/* ---- 6. 正常确认写入 ---- */
let created = 0, writeCalls = [];
const j6 = await mk();
let out = await confirmJob(j6, [0, 1, 2, 3, 4], {
  createPlaylist: async (name) => { created++; return { id: "pl-1", name, url: "https://music.163.com/#/playlist?id=pl-1" }; },
  addTracks: async (_t, ids) => { writeCalls.push(ids.length); return { kind: "written", count: ids.length }; },
  playlistNameFor: (job) => job.requestedName,
});
check("确认后立即建单并写入", out.kind === "done" && created === 1 && jobView(j6).status === "COMPLETED");
check("写入的是全部 5 首", writeCalls.join(",") === "5", writeCalls.join(","));
const view = jobView(j6);
check("结果字段与 Java ResultView 同义",
  view.result.addedCount === 5 && view.result.matchedCount === 5 && view.result.matchRate === 100
  && view.result.skippedCount === 0 && view.result.playlistId === "pl-1", JSON.stringify(view.result));
check("完成后进度 100", j6.progress === 100);
check("确认日志与 Java 同文案",
  j6.logs.some(l => l.message === "已确认迁移 5 首，跳过 0 首匹配项"));

/* ---- 7. 写入中途限流 → 续跑不重建歌单、只补差集 ---- */
created = 0; writeCalls = [];
const j7 = await mk();
out = await confirmJob(j7, [0, 1, 2, 3, 4], {
  createPlaylist: async () => { created++; return { id: "pl-7", name: "n", url: "u" }; },
  addTracks: async () => ({ kind: "throttled", written: 2, retryAfterMs: 8_000 }),
  playlistNameFor: () => "n",
}, 20_000);
check("写入限流返回 partial 且记住已写 2 首",
  out.kind === "partial" && out.written === 2 && j7.writtenIds.length === 2, JSON.stringify(out));
check("任务未被误判为完成", j7.status === "RUNNING" && j7.progress === 88);
out = await confirmJob(j7, [], {
  createPlaylist: async () => { created++; return { id: "should-not-happen", name: "n", url: "u" }; },
  addTracks: async (_t, ids) => { writeCalls.push(ids.length); return { kind: "written", count: ids.length }; },
  playlistNameFor: () => "n",
}, 20_000 + 9_000);
check("续跑不重建歌单", created === 1, String(created));
check("续跑只补剩余 3 首", writeCalls.join(",") === "3", writeCalls.join(","));
check("续跑后完成", out.kind === "done" && j7.result.addedCount === 5);

/* ---- 8. 预览过期由后台回收处理（对齐 Java cleanup） ---- */
const j8 = await mk();
j8.createdAt = 0;
const reaped = reap(j8, 3 * 3600 * 1000);
check("超两小时未确认按过期中断",
  j8.status === "INTERRUPTED" && j8.error === "匹配预览已过期" && reaped.evictable, j8.status);
err = null;
try { await confirmJob(j8, [0], { createPlaylist: async () => ({ id: "p", name: "n", url: "u" }),
  addTracks: async () => ({ kind: "written", count: 1 }), playlistNameFor: () => "n" }, 3 * 3600 * 1000); }
catch (e) { err = e; }
check("过期后确认被拒", err && err.status === 409 && err.code === "MIGRATION_STATE", String(err && err.message));

const freshJob = await mk();
check("未超时的预览不被回收",
  reap(freshJob, freshJob.createdAt + 3_599_000).evictable === false && freshJob.status === "AWAITING_CONFIRMATION");

/* ---- 9. 视图契约 ---- */
const v = jobView(j6);
const KEYS = ["id", "status", "progress", "currentStep", "source", "target", "logs", "matches",
  "result", "error", "createdAt", "readOnly", "recoveryNotice", "createdTarget"];
check("JobView 字段名与 Java 一致", KEYS.every(k => k in v), KEYS.filter(k => !(k in v)).join(","));
check("matches 行字段齐且 score 为整数百分比", (() => {
  const m = v.matches[0];
  return ["index", "selected", "title", "artist", "album", "durationSec", "matched", "lowConfidence",
    "targetTitle", "targetArtist", "targetAlbum", "targetArtworkUrl", "score", "note"].every(k => k in m)
    && m.score === 100;
})());
check("readOnly 历史视图可读", jobView(j6, true).readOnly === true);

console.log(failed === 0 ? "JOB STATE MACHINE ALL PASS" : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
