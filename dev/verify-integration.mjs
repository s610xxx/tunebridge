/**
 * 跨模块整合探针：demo 通道、netease 通道、matcher 三者由不同实现独立写出，
 * 这里验证它们能不能真的串成一条「取来源 → 搜目标 → 打分 → 出报告」的链路。
 */
import { createDemoProvider } from "../site/functions/demo.ts";
import { evaluate, percent, toTrack } from "../site/functions/matcher.ts";

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : " — " + detail}`);
  if (!ok) failed++;
};

const state = { sessions: {}, sequence: 1000 };
const qqSource = createDemoProvider("QQ_MUSIC", state);
const conn = qqSource.connectDemo("sess-int");
const playlist = await qqSource.fetchPlaylist(conn, "demo://builtin");

check("来源歌单可读", playlist.tracks.length > 0, `曲目 ${playlist.tracks.length} 首`);
check("来源曲目字段齐", playlist.tracks.every(t => t.providerTrackId && t.title && t.artist),
  JSON.stringify(playlist.tracks[0]).slice(0, 120));

/** 目标候选刻意用 netease.ts 的 NetTrack 形状（无 songType、album 可为空串） */
const neteaseShapedCandidates = (track) => [
  {
    providerTrackId: "t-" + track.providerTrackId,
    title: track.title,
    artist: track.artist,
    album: track.album,
    durationSec: track.durationSec,
    artworkUrl: "",
  },
];

let perfect = 0;
for (const source of playlist.tracks) {
  const evaluation = evaluate(source, neteaseShapedCandidates(source));
  if (evaluation.matched && percent(evaluation.score) === 100) perfect++;
  else console.log(`   ↳ ${source.title} -> ${percent(evaluation.score)}% ${evaluation.note}`);
}
check("netease 形状候选可被 matcher 采纳为满分",
  perfect === playlist.tracks.length, `${perfect}/${playlist.tracks.length}`);

const missing = evaluate(playlist.tracks[0], []);
check("空候选走「未找到」而非异常", missing.matched === false && missing.score === 0
  && missing.note === "目标平台未找到这首歌", missing.note);

/** toTrack 是 netease.NetTrack（缺 songType）与 matcher 之间的归一化接缝 */
check("toTrack 补齐缺省字段并保留关键字段", (() => {
  const t = toTrack({ providerTrackId: "9", title: "句号", artist: "G.E.M.邓紫棋",
    album: "摩天动物园", durationSec: 210, artworkUrl: "" });
  return t.providerTrackId === "9" && t.title === "句号" && t.artist.includes("G.E.M.")
    && t.songType === 0 && t.durationSec === 210;
})());

check("netease 候选经 toTrack 后可直接打分且满分", (() => {
  const raw = { providerTrackId: "1404511131", title: "海阔天空", artist: "G.E.M.邓紫棋",
    album: "乐行者", durationSec: 262, artworkUrl: "" };
  const evaluation = evaluate(toTrack({ providerTrackId: "s", title: "海阔天空",
    artist: "G.E.M.邓紫棋", album: "乐行者", durationSec: 262 }), [toTrack(raw)]);
  return evaluation.matched === true && percent(evaluation.score) === 100;
})());

check("null 字段不产生 undefined 文本", (() => {
  const t = toTrack({ providerTrackId: "1", title: "X", artist: null, album: undefined });
  return t.artist === "" && t.album === "" && t.artworkUrl === "";
})());

console.log(failed === 0 ? "CROSS-MODULE INTEGRATION PASS" : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
