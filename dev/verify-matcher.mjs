// 对拍脚本：node dev/verify-matcher.mjs
//
// 真值来源（不是手写的，也不用任何 mock）：本机 JDK 23 + target/classes，用 jshell 直接调用
// 生产代码 com.tunebridge.service.TrackMatcher（@Component，无参构造，可直接 new）：
//
//   node dev/verify-matcher.mjs --emit-cases D:/tmp_tb/cases.json     # 导出用例
//   CP="D:/Code/Projects/tunebridge/target/classes"
//   for a in jackson-core jackson-databind jackson-annotations; do
//     j=$(find ~/.m2/repository -name "$a-2.*.jar" ! -name "*sources*" | sort -V | tail -1)
//     CP="$CP;$(cygpath -w "$j")"
//   done
//   jshell --execution local --class-path "$CP" D:/tmp_tb/truth_ascii.jsh   # 读 cases.json，写 truth.json
//
// truth.jsh 里对每个用例调用 evaluate(...)，并额外调用 score(...) / normalize(...) 逐候选取真值；
// double 一律用 Double.doubleToRawLongBits 的 16 位十六进制传输，比十进制打印更严（位级相等）。
// 中文通过 Files.writeString(UTF_8) 落盘，绕开 Windows 控制台转码，避免把显示乱码误读成数据差异。
//
// TRUTH 数组就是上面 truth.json 的原样转录；改用例后要重新导出真值，否则名称对不上会直接失败。

import fs from "node:fs";
import path from "node:path";
import { evaluate, normalize, score, toTrack } from "../site/functions/matcher.ts";

const CASES = [
  { name: "01-chinese-exact", source: { title: "晴天", artist: "周杰伦", album: "叶惠美" },
    candidates: [{ title: "晴天", artist: "周杰伦", album: "叶惠美" }] },
  { name: "02-latin-case-only", source: { title: "Walk on Water", artist: "Eminem", album: "Recovery" },
    candidates: [{ title: "Walk On Water", artist: "Eminem", album: "Recovery" }] },
  { name: "03-gem-contains", source: { title: "泡沫", artist: "G.E.M.邓紫棋", album: "新的心跳" },
    candidates: [{ title: "泡沫", artist: "邓紫棋", album: "新的心跳" }] },
  { name: "04-gem-dots-only", source: { title: "泡沫", artist: "G.E.M.邓紫棋", album: "新的心跳" },
    candidates: [{ title: "泡沫", artist: "G.E.M.", album: "新的心跳" }] },
  { name: "05-iu-korean-paren", source: { title: "Blueming", artist: "IU (아이유)", album: "Love Poem" },
    candidates: [{ title: "Blueming", artist: "IU", album: "Love Poem" },
      { title: "블루밍 (IU)", artist: "아이유", album: "Love Poem" }] },
  { name: "06-live-source-only", source: { title: "存在 (Live)", artist: "李健", album: "人间" },
    candidates: [{ title: "存在", artist: "李健", album: "人间" }] },
  { name: "07-fullwidth-paren", source: { title: "再见（good bye）", artist: "张震岳", album: "OK" },
    candidates: [{ title: "再见", artist: "张震岳", album: "OK" }] },
  { name: "08-tornado-live", source: { title: "龙卷风 (Live)", artist: "周杰伦", album: "Fantasy" },
    candidates: [{ title: "龙卷风", artist: "周杰伦", album: "Fantasy" }] },
  { name: "09-version-both-sides", source: { title: "告白气球 (Acoustic)", artist: "周杰伦", album: "周杰伦的床边故事" },
    candidates: [{ title: "告白气球 (Remix)", artist: "周杰伦", album: "周杰伦的床边故事" }] },
  { name: "10-cover-in-fullwidth-bracket", source: { title: "稻香", artist: "周杰伦", album: "魔杰座" },
    candidates: [{ title: "稻香（翻唱版）", artist: "周杰伦", album: "魔杰座" }] },
  { name: "11-instrumental-family", source: { title: "安静", artist: "周杰伦", album: "范特西" },
    candidates: [{ title: "安静 伴奏", artist: "周杰伦", album: "范特西" },
      { title: "安静 纯音乐", artist: "周杰伦", album: "范特西" },
      { title: "安静 (Instrumental)", artist: "周杰伦", album: "范特西" },
      { title: "安静 (重制)", artist: "周杰伦", album: "范特西" },
      { title: "安静 混音", artist: "周杰伦", album: "范特西" },
      { title: "安静", artist: "周杰伦", album: "范特西" }] },
  { name: "12-artist-slash-vs-fullwidth-comma", source: { title: "海盗", artist: "周杰伦/蔡依林", album: "11月的萧邦" },
    candidates: [{ title: "海盗", artist: "周杰伦，蔡依林", album: "11月的萧邦" }] },
  { name: "13-artist-ampersand-vs-ideographic-comma", source: { title: "无名的人", artist: "A & B", album: "X" },
    candidates: [{ title: "无名的人", artist: "A、B", album: "X" }] },
  { name: "14-artist-semicolon-vs-comma", source: { title: "滚滚长江", artist: "A;B", album: "Y" },
    candidates: [{ title: "滚滚长江", artist: "A，B", album: "Y" }] },
  { name: "15-feat-word-boundary-cjk", source: { title: "我说了算", artist: "周杰伦feat.蔡依林", album: "Z" },
    candidates: [{ title: "我说了算", artist: "周杰伦 / 蔡依林", album: "Z" }] },
  { name: "16-ft-with-boundary", source: { title: "AftB", artist: "AftB with C", album: "W" },
    candidates: [{ title: "AftB", artist: "AftB C", album: "W" },
      { title: "AftB", artist: "A ft. B C", album: "W" }] },
  { name: "17-empty-candidates", source: { title: "晴天", artist: "周杰伦", album: "叶惠美" }, candidates: [] },
  { name: "18-null-candidates", source: { title: "晴天", artist: "周杰伦", album: "叶惠美" }, candidates: null },
  { name: "19-just-below-055", source: { title: "Yesterday Remix", artist: "陈奕迅", album: "七里香" },
    candidates: [{ title: "Yestedayr", artist: "奕迅陈", album: "七里香" }] },
  { name: "20-exactly-055", source: { title: "双截棍 Remix", artist: "苏打绿", album: "21" },
    candidates: [{ title: "截棍（现场）", artist: "苏打绿", album: "21" }] },
  { name: "21-just-below-072", source: { title: "Someonelikeyou", artist: "邓紫棋", album: "" },
    candidates: [{ title: "omeonelikeyouS", artist: "", album: "" }] },
  { name: "22-exactly-072", source: { title: "不爱我就拉倒 Remix", artist: "IU", album: "1989" },
    candidates: [{ title: "爱我就拉倒不 (Live)", artist: "IU", album: "1989" }] },
  { name: "23-short-title-11", source: { title: "11", artist: "艾热", album: "11" },
    candidates: [{ title: "11", artist: "艾热", album: "11" }, { title: "1", artist: "艾热", album: "11" }] },
  { name: "24-dotted-title", source: { title: "A.I.N.Y.", artist: "G.E.M.", album: "X.X.X." },
    candidates: [{ title: "AINY", artist: "G.E.M.", album: "X.X.X." }] },
  { name: "25-target-artist-album-empty", source: { title: "晴天", artist: "周杰伦", album: "叶惠美" },
    candidates: [{ title: "晴天", artist: "", album: "" }] },
  { name: "26-null-fields-safe", source: { title: "晴天", artist: null, album: null },
    candidates: [{ title: null, artist: "周杰伦", album: "叶惠美" },
      { title: "晴天", artist: null, album: "叶惠美" }] },
  { name: "27-tie-break-first-wins", source: { title: "夜曲", artist: "周杰伦", album: "十一月的萧邦" },
    candidates: [{ title: "夜曲", artist: "周杰伦", album: "十一月的萧邦" },
      { title: "夜曲", artist: "周杰伦", album: "十一月的萧邦" }] },
  { name: "28-greek-title-vs-artist-case", source: { title: "ΑΝΕΜΟΣ", artist: "ΓΡΗΓΩΡΑ", album: "18 ΤΡΑΓΟΥΔΙΑ" },
    candidates: [{ title: "Ανεμος", artist: "Γρηγορα", album: "18 τραγουδια" }] },
  { name: "29-turkish-dotted-i", source: { title: "İstanbul", artist: "Sezen Aksu", album: "Istaro" },
    candidates: [{ title: "Istanbul", artist: "Sezen Aksu", album: "Istaro" }] },
  { name: "30-fullwidth-letters-digits", source: { title: "ＡＢＣ　１２３", artist: "测试", album: "盘" },
    candidates: [{ title: "abc123", artist: "测试", album: "盘" }] },
  { name: "31-version-mismatch-and-low-confidence", source: { title: "Someonelikeyou Remix", artist: "邓紫棋", album: "21" },
    candidates: [{ title: "omeonelikeyouS", artist: "", album: "" }] },
  { name: "32-surrogate-and-punct", source: { title: "泡沫😀泡沫 (Live)", artist: "G.E.M. 邓紫棋", album: "❤" },
    candidates: [{ title: "泡沫泡沫", artist: "邓紫棋", album: "" }] },
  // 全小写形式的同名希腊标题：验证 Final_Sigma 与 Ω/ω 折叠后真正等价
  { name: "33-greek-exact-case-fold", source: { title: "ΑΝΕΜΟΣ", artist: "ΓΡΗΓΩΡΑ", album: "18 ΤΡΑΓΟΥΔΙΑ" },
    candidates: [{ title: "ΑΝΕΜΟΣ", artist: "ΓΡΗΓΩΡΑ", album: "18 ΤΡΑΓΟΥΔΙΑ" },
      { title: "ανεμος", artist: "γρηγορα", album: "18 τραγουδια" }] },
  // 结尾 sigma 形态不同（大写 Σ 折叠成 ς，而已是小写 σ 的保持 σ）：Final_Sigma 直接决定打分
  { name: "34-greek-sigma-variant", source: { title: "ΑΝΕΜΟΣ", artist: "ΓΡΗΓΩΡΑ", album: "18 ΤΡΑΓΟΥΔΙΑ" },
    candidates: [{ title: "ΑΝΕΜΟσ", artist: "ΓΡΗΓΩΡΑ", album: "18 ΤΡΑΓΟΥΔΙΑ" }] },
];

/** 由 jshell 调用生产 Java 代码得到的真值（位级 score + evaluate 全字段）。 */
const TRUTH = [
  {"name":"01-chinese-exact","scoreBits":"3ff0000000000000","matched":1,"lowConfidence":0,"note":"标题与歌手一致","candidate":true,"candidateTitle":"晴天","candidateArtist":"周杰伦","candidateAlbum":"叶惠美","perCandidateBits":"3ff0000000000000","normalizeSource":"晴天","normalizeCandidates":"晴天"},
  {"name":"02-latin-case-only","scoreBits":"3ff0000000000000","matched":1,"lowConfidence":0,"note":"标题与歌手一致","candidate":true,"candidateTitle":"Walk On Water","candidateArtist":"Eminem","candidateAlbum":"Recovery","perCandidateBits":"3ff0000000000000","normalizeSource":"walkonwater","normalizeCandidates":"walkonwater"},
  {"name":"03-gem-contains","scoreBits":"3feb564efe898232","matched":1,"lowConfidence":0,"note":"标题一致，歌手信息有差异","candidate":true,"candidateTitle":"泡沫","candidateArtist":"邓紫棋","candidateAlbum":"新的心跳","perCandidateBits":"3feb564efe898232","normalizeSource":"泡沫","normalizeCandidates":"泡沫"},
  {"name":"04-gem-dots-only","scoreBits":"3feb564efe898232","matched":1,"lowConfidence":0,"note":"标题一致，歌手信息有差异","candidate":true,"candidateTitle":"泡沫","candidateArtist":"G.E.M.","candidateAlbum":"新的心跳","perCandidateBits":"3feb564efe898232","normalizeSource":"泡沫","normalizeCandidates":"泡沫"},
  {"name":"05-iu-korean-paren","scoreBits":"3ff0000000000000","matched":1,"lowConfidence":0,"note":"标题与歌手一致","candidate":true,"candidateTitle":"Blueming","candidateArtist":"IU","candidateAlbum":"Love Poem","perCandidateBits":"3ff0000000000000,3faeb851eb851eb8","normalizeSource":"blueming","normalizeCandidates":"blueming|블루밍"},
  {"name":"06-live-source-only","scoreBits":"3fed70a3d70a3d71","matched":1,"lowConfidence":0,"note":"检测到 Live / Remix 等版本差异","candidate":true,"candidateTitle":"存在","candidateArtist":"李健","candidateAlbum":"人间","perCandidateBits":"3fed70a3d70a3d71","normalizeSource":"存在","normalizeCandidates":"存在"},
  {"name":"07-fullwidth-paren","scoreBits":"3ff0000000000000","matched":1,"lowConfidence":0,"note":"标题与歌手一致","candidate":true,"candidateTitle":"再见","candidateArtist":"张震岳","candidateAlbum":"OK","perCandidateBits":"3ff0000000000000","normalizeSource":"再见","normalizeCandidates":"再见"},
  {"name":"08-tornado-live","scoreBits":"3fed70a3d70a3d71","matched":1,"lowConfidence":0,"note":"检测到 Live / Remix 等版本差异","candidate":true,"candidateTitle":"龙卷风","candidateArtist":"周杰伦","candidateAlbum":"Fantasy","perCandidateBits":"3fed70a3d70a3d71","normalizeSource":"龙卷风","normalizeCandidates":"龙卷风"},
  {"name":"09-version-both-sides","scoreBits":"3ff0000000000000","matched":1,"lowConfidence":0,"note":"标题与歌手一致","candidate":true,"candidateTitle":"告白气球 (Remix)","candidateArtist":"周杰伦","candidateAlbum":"周杰伦的床边故事","perCandidateBits":"3ff0000000000000","normalizeSource":"告白气球","normalizeCandidates":"告白气球"},
  {"name":"10-cover-in-fullwidth-bracket","scoreBits":"3fed70a3d70a3d71","matched":1,"lowConfidence":0,"note":"检测到 Live / Remix 等版本差异","candidate":true,"candidateTitle":"稻香（翻唱版）","candidateArtist":"周杰伦","candidateAlbum":"魔杰座","perCandidateBits":"3fed70a3d70a3d71","normalizeSource":"稻香","normalizeCandidates":"稻香"},
  {"name":"11-instrumental-family","scoreBits":"3ff0000000000000","matched":1,"lowConfidence":0,"note":"标题与歌手一致","candidate":true,"candidateTitle":"安静","candidateArtist":"周杰伦","candidateAlbum":"范特西","perCandidateBits":"3fe3d70a3d70a3d7,3fe1eb851eb851ed,3fed70a3d70a3d71,3fed70a3d70a3d71,3fe3d70a3d70a3d7,3ff0000000000000","normalizeSource":"安静","normalizeCandidates":"安静伴奏|安静纯音乐|安静|安静|安静混音|安静"},
  {"name":"12-artist-slash-vs-fullwidth-comma","scoreBits":"3ff0000000000000","matched":1,"lowConfidence":0,"note":"标题与歌手一致","candidate":true,"candidateTitle":"海盗","candidateArtist":"周杰伦，蔡依林","candidateAlbum":"11月的萧邦","perCandidateBits":"3ff0000000000000","normalizeSource":"海盗","normalizeCandidates":"海盗"},
  {"name":"13-artist-ampersand-vs-ideographic-comma","scoreBits":"3ff0000000000000","matched":1,"lowConfidence":0,"note":"标题与歌手一致","candidate":true,"candidateTitle":"无名的人","candidateArtist":"A、B","candidateAlbum":"X","perCandidateBits":"3ff0000000000000","normalizeSource":"无名的人","normalizeCandidates":"无名的人"},
  {"name":"14-artist-semicolon-vs-comma","scoreBits":"3ff0000000000000","matched":1,"lowConfidence":0,"note":"标题与歌手一致","candidate":true,"candidateTitle":"滚滚长江","candidateArtist":"A，B","candidateAlbum":"Y","perCandidateBits":"3ff0000000000000","normalizeSource":"滚滚长江","normalizeCandidates":"滚滚长江"},
  {"name":"15-feat-word-boundary-cjk","scoreBits":"3ff0000000000000","matched":1,"lowConfidence":0,"note":"标题与歌手一致","candidate":true,"candidateTitle":"我说了算","candidateArtist":"周杰伦 / 蔡依林","candidateAlbum":"Z","perCandidateBits":"3ff0000000000000","normalizeSource":"我说了算","normalizeCandidates":"我说了算"},
  {"name":"16-ft-with-boundary","scoreBits":"3feeb1c432ca57a8","matched":1,"lowConfidence":0,"note":"标题与歌手一致","candidate":true,"candidateTitle":"AftB","candidateArtist":"AftB C","candidateAlbum":"W","perCandidateBits":"3feeb1c432ca57a8,3fe51eb851eb851e","normalizeSource":"aftb","normalizeCandidates":"aftb|aftb"},
  {"name":"17-empty-candidates","scoreBits":"0000000000000000","matched":0,"lowConfidence":0,"note":"目标平台未找到这首歌","candidate":false,"candidateTitle":null,"candidateArtist":null,"candidateAlbum":null,"perCandidateBits":"","normalizeSource":"晴天","normalizeCandidates":""},
  {"name":"18-null-candidates","scoreBits":"0000000000000000","matched":0,"lowConfidence":0,"note":"目标平台未找到这首歌","candidate":false,"candidateTitle":null,"candidateArtist":null,"candidateAlbum":null,"perCandidateBits":"","normalizeSource":"晴天","normalizeCandidates":""},
  {"name":"19-just-below-055","scoreBits":"3fe1999999999999","matched":0,"lowConfidence":0,"note":"未找到足够相似的版本（最接近：Yestedayr · 奕迅陈，相似度 55）","candidate":false,"candidateTitle":null,"candidateArtist":null,"candidateAlbum":null,"perCandidateBits":"3fe1999999999999","normalizeSource":"yesterdayremix","normalizeCandidates":"yestedayr"},
  {"name":"20-exactly-055","scoreBits":"3fe199999999999a","matched":1,"lowConfidence":1,"note":"相似度较低，建议试听确认","candidate":true,"candidateTitle":"截棍（现场）","candidateArtist":"苏打绿","candidateAlbum":"21","perCandidateBits":"3fe199999999999a","normalizeSource":"双截棍remix","normalizeCandidates":"截棍"},
  {"name":"21-just-below-072","scoreBits":"3fe708facd1d75af","matched":1,"lowConfidence":1,"note":"相似度较低，建议试听确认","candidate":true,"candidateTitle":"omeonelikeyouS","candidateArtist":"","candidateAlbum":"","perCandidateBits":"3fe708facd1d75af","normalizeSource":"someonelikeyou","normalizeCandidates":"omeonelikeyous"},
  {"name":"22-exactly-072","scoreBits":"3fe70a3d70a3d70a","matched":1,"lowConfidence":0,"note":"标题与歌手近似","candidate":true,"candidateTitle":"爱我就拉倒不 (Live)","candidateArtist":"IU","candidateAlbum":"1989","perCandidateBits":"3fe70a3d70a3d70a","normalizeSource":"不爱我就拉倒remix","normalizeCandidates":"爱我就拉倒不"},
  {"name":"23-short-title-11","scoreBits":"3ff0000000000000","matched":1,"lowConfidence":0,"note":"标题与歌手一致","candidate":true,"candidateTitle":"11","candidateArtist":"艾热","candidateAlbum":"11","perCandidateBits":"3ff0000000000000,3fd999999999999a","normalizeSource":"11","normalizeCandidates":"11|1"},
  {"name":"24-dotted-title","scoreBits":"3ff0000000000000","matched":1,"lowConfidence":0,"note":"标题与歌手一致","candidate":true,"candidateTitle":"AINY","candidateArtist":"G.E.M.","candidateAlbum":"X.X.X.","perCandidateBits":"3ff0000000000000","normalizeSource":"ainy","normalizeCandidates":"ainy"},
  {"name":"25-target-artist-album-empty","scoreBits":"3fe883126e978d50","matched":1,"lowConfidence":0,"note":"标题一致，歌手信息有差异","candidate":true,"candidateTitle":"晴天","candidateArtist":"","candidateAlbum":"","perCandidateBits":"3fe883126e978d50","normalizeSource":"晴天","normalizeCandidates":"晴天"},
  {"name":"26-null-fields-safe","scoreBits":"3feab020c49ba5e4","matched":1,"lowConfidence":0,"note":"标题一致，歌手信息有差异","candidate":true,"candidateTitle":"晴天","candidateArtist":"","candidateAlbum":"叶惠美","perCandidateBits":"3fc53f7ced916873,3feab020c49ba5e4","normalizeSource":"晴天","normalizeCandidates":"|晴天"},
  {"name":"27-tie-break-first-wins","scoreBits":"3ff0000000000000","matched":1,"lowConfidence":0,"note":"标题与歌手一致","candidate":true,"candidateTitle":"夜曲","candidateArtist":"周杰伦","candidateAlbum":"十一月的萧邦","perCandidateBits":"3ff0000000000000,3ff0000000000000","normalizeSource":"夜曲","normalizeCandidates":"夜曲|夜曲"},
  {"name":"28-greek-title-vs-artist-case","scoreBits":"3fec5f92c5f92c60","matched":1,"lowConfidence":0,"note":"标题一致，歌手信息有差异","candidate":true,"candidateTitle":"Ανεμος","candidateArtist":"Γρηγορα","candidateAlbum":"18 τραγουδια","perCandidateBits":"3fec5f92c5f92c60","normalizeSource":"ανεμος","normalizeCandidates":"ανεμος"},
  {"name":"29-turkish-dotted-i","scoreBits":"3ff0000000000000","matched":1,"lowConfidence":0,"note":"标题与歌手一致","candidate":true,"candidateTitle":"Istanbul","candidateArtist":"Sezen Aksu","candidateAlbum":"Istaro","perCandidateBits":"3ff0000000000000","normalizeSource":"istanbul","normalizeCandidates":"istanbul"},
  {"name":"30-fullwidth-letters-digits","scoreBits":"3ff0000000000000","matched":1,"lowConfidence":0,"note":"标题与歌手一致","candidate":true,"candidateTitle":"abc123","candidateArtist":"测试","candidateAlbum":"盘","perCandidateBits":"3ff0000000000000","normalizeSource":"abc123","normalizeCandidates":"abc123"},
  {"name":"31-version-mismatch-and-low-confidence","scoreBits":"3fe19dd40043a66b","matched":1,"lowConfidence":1,"note":"检测到 Live / Remix 等版本差异；相似度较低，建议试听确认","candidate":true,"candidateTitle":"omeonelikeyouS","candidateArtist":"","candidateAlbum":"","perCandidateBits":"3fe19dd40043a66b","normalizeSource":"someonelikeyouremix","normalizeCandidates":"omeonelikeyous"},
  {"name":"32-surrogate-and-punct","scoreBits":"3fe7d130463796ad","matched":1,"lowConfidence":0,"note":"检测到 Live / Remix 等版本差异","candidate":true,"candidateTitle":"泡沫泡沫","candidateArtist":"邓紫棋","candidateAlbum":"","perCandidateBits":"3fe7d130463796ad","normalizeSource":"泡沫泡沫","normalizeCandidates":"泡沫泡沫"},
  {"name":"33-greek-exact-case-fold","scoreBits":"3ff0000000000000","matched":1,"lowConfidence":0,"note":"标题与歌手一致","candidate":true,"candidateTitle":"ΑΝΕΜΟΣ","candidateArtist":"ΓΡΗΓΩΡΑ","candidateAlbum":"18 ΤΡΑΓΟΥΔΙΑ","perCandidateBits":"3ff0000000000000,3fec5f92c5f92c60","normalizeSource":"ανεμος","normalizeCandidates":"ανεμος|ανεμος"},
  {"name":"34-greek-sigma-variant","scoreBits":"3fec28f5c28f5c2a","matched":1,"lowConfidence":0,"note":"标题与歌手近似","candidate":true,"candidateTitle":"ΑΝΕΜΟσ","candidateArtist":"ΓΡΗΓΩΡΑ","candidateAlbum":"18 ΤΡΑΓΟΥΔΙΑ","perCandidateBits":"3fec28f5c28f5c2a","normalizeSource":"ανεμος","normalizeCandidates":"ανεμοσ"},
];;

function bitsOf(value) {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, false);
  let hex = "";
  for (let i = 0; i < 8; i++) hex += view.getUint8(i).toString(16).padStart(2, "0");
  return hex;
}

function bitsToString(bits) {
  const view = new DataView(new ArrayBuffer(8));
  for (let i = 0; i < 8; i++) view.setUint8(i, parseInt(bits.slice(i * 2, i * 2 + 2), 16));
  return view.getFloat64(0, false);
}

const argv = process.argv.slice(2);
if (argv[0] === "--emit-cases") {
  const target = argv[1];
  if (!target) {
    console.error("用法: node dev/verify-matcher.mjs --emit-cases <绝对路径>");
    process.exit(2);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(CASES, null, 2), "utf8");
  console.log("已导出 " + CASES.length + " 条用例 -> " + target);
  process.exit(0);
}

if (TRUTH.length === 0) {
  console.error("TRUTH 为空：先跑 --emit-cases 与 jshell 取真值（见文件头注释）。");
  process.exit(1);
}

let failed = 0;
let checked = 0;
for (const testCase of CASES) {
  const truth = TRUTH.find((t) => t.name === testCase.name);
  if (!truth) {
    console.log(`FAIL ${testCase.name} 缺少 Java 真值`);
    failed++;
    continue;
  }
  const actual = evaluate(testCase.source, testCase.candidates);
  const diffs = [];
  const push = (field, want, got) => {
    if (want !== got) diffs.push(`${field}: java=${JSON.stringify(want)} ts=${JSON.stringify(got)}`);
  };
  push("scoreBits", truth.scoreBits, bitsOf(actual.score));
  push("matched", truth.matched !== 0, actual.matched);
  push("lowConfidence", truth.lowConfidence !== 0, actual.lowConfidence);
  push("note", truth.note, actual.note);
  push("candidate.title", truth.candidate ? truth.candidateTitle : null, actual.candidate ? actual.candidate.title : null);
  push("candidate.artist", truth.candidate ? truth.candidateArtist : null, actual.candidate ? actual.candidate.artist : null);
  push("candidate.album", truth.candidate ? truth.candidateAlbum : null, actual.candidate ? actual.candidate.album : null);

  // 逐候选的 score() 与 normalize()：evaluate 只暴露最大值，这两个函数单独对拍才能定位差异来源。
  const src = toTrack(testCase.source);
  const perCandidate = (testCase.candidates || []).map((candidate) => bitsOf(score(src, toTrack(candidate))));
  push("perCandidateBits", truth.perCandidateBits, perCandidate.join(","));
  push("normalize(source.title)", truth.normalizeSource, normalize(testCase.source.title));
  push("normalize(candidate.titles)", truth.normalizeCandidates,
    (testCase.candidates || []).map((c) => normalize(c.title)).join("|"));

  checked += 3;
  if (diffs.length === 0) {
    console.log(`PASS ${testCase.name}  score=${bitsToString(truth.scoreBits)} note=${truth.note}`);
  } else {
    failed++;
    console.log(`FAIL ${testCase.name}`);
    for (const d of diffs) console.log("      " + d);
  }
}

console.log(`\n用例 ${CASES.length} 条，断言 ${checked} 组（evaluate 全字段 + 逐候选 score/normalize），失败用例 ${failed} 条。`);
console.log(failed === 0 ? "ALL MATCH JAVA BYTE-FOR-BYTE" : `${failed} MISMATCH`);
process.exit(failed === 0 ? 0 : 1);
