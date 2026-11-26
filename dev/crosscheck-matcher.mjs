import { evaluate } from "../site/functions/matcher.ts";

const T = (id, title, artist, album, dur = 200) => ({
  providerTrackId: id, title, artist, album, durationSec: dur, artworkUrl: "", songType: 0,
});

/*
 * 期望值不来自 matcher.ts 自己的断言，而来自线上 Java 确认页的实际输出：
 * 21:00 与 10:05 两次「QQ → 网易云」迁移报告里的匹配分、勾选状态与说明文案。
 */
const CASES = [
  ["摩天动物园 全一致", T("s1", "摩天动物园", "G.E.M.邓紫棋", "摩天动物园"),
    [T("t1", "摩天动物园", "G.E.M.邓紫棋", "摩天动物园")], 100, true, "标题与歌手一致"],
  ["A.I.N.Y. 专辑 18... vs 18 Plus", T("s2", "A.I.N.Y.", "G.E.M.邓紫棋", "18..."),
    [T("t2", "A.I.N.Y.", "G.E.M.邓紫棋", "18 Plus")], 98, true, "标题与歌手一致"],
  ["后会无期 专辑多“电影原声带”", T("s3", "后会无期", "G.E.M.邓紫棋", "后会无期 电影原声带"),
    [T("t3", "后会无期", "G.E.M.邓紫棋", "后会无期")], 98, true, "标题与歌手一致"],
  // 线上那行是「已跳过 · 低置信（未选择）」：60% ≥ 0.55 仍是 matched=true，
  // 只是 lowConfidence=true 默认不勾选，而不是"未匹配"。
  ["You Raise Me Up (Live) 命中他人版本", T("s4", "You Raise Me Up (Live)", "G.E.M.邓紫棋", "Get Everybody Moving Concert 2011"),
    [T("t4", "You Raise Me Up (Live)", "张杰 / 刘润潼", "歌手 第13期")], 60, true, "相似度较低"],
  ["无候选", T("s5", "冰河时代", "G.E.M.邓紫棋", "启示录"), [], 0, false, "目标平台未找到这首歌"],
  ["再见 → 再见（good bye）全角括号", T("s6", "再见", "G.E.M.邓紫棋", "新的心跳"),
    [T("t6", "再见（good bye）", "G.E.M.邓紫棋", "新的心跳")], 100, true, "标题与歌手一致"],
  ["Where Did U Go (Album Version) → Where Did U Go", T("s7", "Where Did U Go (Album Version)", "G.E.M.邓紫棋", "G.E.M."),
    [T("t7", "Where Did U Go", "G.E.M.邓紫棋", "G.E.M.")], 100, true, "标题与歌手一致"],
  ["Blueming 目标歌手写作 IU", T("s8", "Blueming", "IU (아이유)", "Love poem"),
    [T("t8", "Blueming", "IU", "Love poem")], 100, true, "标题与歌手一致"],
  ["Walk on Water 大小写差异", T("s9", "Walk on Water", "G.E.M.邓紫棋", "摩天动物园"),
    [T("t9", "Walk On Water", "G.E.M.邓紫棋", "摩天动物园")], 100, true, "标题与歌手一致"],
  ["存在 (Live) 多首候选时取最优", T("s10", "存在 (Live)", "G.E.M.邓紫棋", "我是歌手第二季 第2期"),
    [T("x1", "存在", "李健", "李健"), T("x2", "存在 (Live)", "G.E.M.邓紫棋", "我是歌手第二季 第2期")], 100, true, null],
];

let bad = 0;
for (const [name, source, candidates, pct, matched, notePart] of CASES) {
  const evaluation = evaluate(source, candidates);
  const got = Math.round((evaluation.score ?? 0) * 100);
  const noteOk = notePart === null || String(evaluation.note || "").includes(notePart);
  const ok = got === pct && !!evaluation.matched === matched && noteOk;
  console.log(`${ok ? "PASS" : "FAIL"} ${name} -> ${got}%（java ${pct}%）matched=${evaluation.matched} low=${evaluation.lowConfidence} note=${evaluation.note}`);
  if (!ok) bad++;
}
console.log(bad === 0 ? "线上真值全部复现" : `${bad} 条与线上输出不一致`);
process.exit(bad === 0 ? 0 : 1);
