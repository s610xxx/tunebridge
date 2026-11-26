/**
 * TrackMatcher 的逐字节移植（源：src/main/java/com/tunebridge/service/TrackMatcher.java、
 * src/main/java/com/tunebridge/domain/Track.java）。
 *
 * 与 Java 的对应关系：
 *   evaluate(Track, List<Track>)  -> evaluate(source, candidates)
 *   score(Track, Track)           -> score(source, candidate)
 *   normalize(String)             -> normalize(value)
 *   record Evaluation(...)        -> interface Evaluation（字段顺序一致）
 *   private static percent(double)-> percent(score)（MigrationService 的“匹配分 77%”就是它算的）
 *
 * 权重按生产代码取 0.60 / 0.34 / 0.06（docs/TECH_DESIGN.md 第 11 节的 0.55/0.35/0.10 与
 * “互相包含 = 0.9”是旧文档，Java 实际是 0.60/0.34/0.06、包含判定 0.88，以代码为准）。
 * 阈值：< 0.55 判未匹配（note = 未找到足够相似的版本 + 最接近候选）；0.55 <= s < 0.72 记 lowConfidence。
 * 候选数量：MigrationService 调 searchTracks(..., 6)，Java 侧对列表长度无上限，本函数同样不设限。
 *
 * 为对齐 JDK，显式复刻了以下 Java/JS 语义差异（逐条实测，见文件末尾“已知差异”）：
 *   1) String.toLowerCase(Locale.ROOT)：逐码点查表 + JDK 的 Final_Cased 条件，
 *      不用 JS 的 toLowerCase()（Unicode 16 表 + Unicode 版 Final_Sigma，两者与 JDK 不同）。
 *   2) java.util.regex 默认口径是 ASCII：\s = [ \t\n\x0B\f\r]、\b 只认 ASCII 词字符、
 *      (?i)/CASE_INSENSITIVE 只做 ASCII 折叠 —— JS 的 \s/\b/i 都是 Unicode 口径，故这里展开写。
 *   3) Java 的 `.` 不匹配 U+0085(NEL)，JS 的 `.` 匹配；且 Java 的 `.` 以码点为单位。
 *   4) Java 的 \p{L}\p{N} 与 V8 的 Unicode 版本不同（JDK 23 = Unicode 15.1，Node 24 = 16.0），
 *      用实测差异区间表修正。
 *   5) String.split 丢尾随空串、String.isBlank 的字符集、Math.round 的取整方向。
 */

/** 与 Track record 的字段顺序一致；null -> ""（Java compact 构造器里的 safe()）。 */
export interface Track {
  providerTrackId: string;
  title: string;
  artist: string;
  album: string;
  durationSec: number;
  artworkUrl: string;
  songType: number;
}

/** 上游 JSON 里字段可能缺失或为 null，Java 侧靠 record 构造器兜住，这里同样兜住。 */
export interface TrackInput {
  providerTrackId?: string | null;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  durationSec?: number | null;
  artworkUrl?: string | null;
  songType?: number | null;
}

/** record Evaluation(Track candidate, double score, boolean matched, boolean lowConfidence, String note)。 */
export interface Evaluation {
  candidate: Track | null;
  score: number;
  matched: boolean;
  lowConfidence: boolean;
  note: string;
}

function safe(value: string | null | undefined): string {
  return value === null || value === undefined ? "" : value;
}

/** 等价于 Java 的 new Track(...)。 */
export function toTrack(input: TrackInput | Track): Track {
  return {
    providerTrackId: safe(input.providerTrackId),
    title: safe(input.title),
    artist: safe(input.artist),
    album: safe(input.album),
    durationSec: input.durationSec ?? 0,
    artworkUrl: safe(input.artworkUrl),
    songType: input.songType ?? 0,
  };
}

/* ------------------------------------------------------------------ *
 * 1. Locale.ROOT 小写
 * ------------------------------------------------------------------ */

/**
 * JS 会小写、JDK 23 保持原样的码点（Unicode 16 新增/调整项）。
 * 来源：jshell 全码点扫描 String.valueOf(cp).toLowerCase(Locale.ROOT)。
 */
const JS_ONLY_LOWER = new Set<number>([
  0x1c89, 0xa7cb, 0xa7cc, 0xa7da, 0xa7dc,
  0x10d50, 0x10d51, 0x10d52, 0x10d53, 0x10d54, 0x10d55, 0x10d56, 0x10d57, 0x10d58,
  0x10d59, 0x10d5a, 0x10d5b, 0x10d5c, 0x10d5d, 0x10d5e, 0x10d5f, 0x10d60, 0x10d61,
  0x10d62, 0x10d63, 0x10d64, 0x10d65,
]);

/** JDK ConditionalSpecialCasing.isCased：Lu/Ll/Lt + Other_Lowercase/Other_Uppercase 定段。 */
function isCased(codePoint: number): boolean {
  if (/\p{Lu}|\p{Ll}|\p{Lt}/u.test(String.fromCodePoint(codePoint))) return true;
  return (codePoint >= 0x02b0 && codePoint <= 0x02b8)
    || (codePoint >= 0x02c0 && codePoint <= 0x02c1)
    || (codePoint >= 0x02e0 && codePoint <= 0x02e4)
    || codePoint === 0x0345 // COMBINING GREEK YPOGEGRAMMENI
    || codePoint === 0x037a // GREEK YPOGEGRAMMENI
    || (codePoint >= 0x1d2c && codePoint <= 0x1d61)
    || (codePoint >= 0x2160 && codePoint <= 0x217f)
    || (codePoint >= 0x24b6 && codePoint <= 0x24e9);
}

const isMark = (codePoint: number): boolean => /\p{M}/u.test(String.fromCodePoint(codePoint));
const isNumber = (codePoint: number): boolean => /\p{N}/u.test(String.fromCodePoint(codePoint));

/**
 * Java 用 BreakIterator.getWordInstance(ROOT) 决定 Final_Cased 的扫描范围；
 * 这里用“可作为词内延续的字符”近似（组合符号/数字/下划线/软连字符）。见文末误差统计。
 */
const continuesWord = (codePoint: number): boolean =>
  isMark(codePoint) || isNumber(codePoint) || codePoint === 0x5f || codePoint === 0xad;

/**
 * JDK 的 Final_Cased：同一词内前面有 cased 字母、后面没有 cased 字母时 Σ -> ς。
 * 与 JS 的 Unicode Final_Sigma 不同：JS 会跳过任意 Case_Ignorable 字符，
 * JDK 只认自己那份 isCased 表、且前导若是组合符号则不算“cased 在前”。
 */
function isFinalCased(codePoints: number[], index: number): boolean {
  let hasCasedBefore = false;
  for (let i = index - 1; i >= 0; i--) {
    const cp = codePoints[i];
    if (isCased(cp) && !isMark(cp)) {
      hasCasedBefore = true;
      break;
    }
    if (!continuesWord(cp)) break;
  }
  if (!hasCasedBefore) return false;
  for (let i = index + 1; i < codePoints.length; i++) {
    const cp = codePoints[i];
    if (isCased(cp)) return false;
    if (!continuesWord(cp)) break;
  }
  return true;
}

const codePointsOf = (value: string): number[] => {
  const list: number[] = [];
  for (const ch of value) list.push(ch.codePointAt(0) as number);
  return list;
};

function toLowerCaseRoot(value: string): string {
  const codePoints = codePointsOf(value);
  let result = "";
  for (let i = 0; i < codePoints.length; i++) {
    const cp = codePoints[i];
    if (cp === 0x3a3) {
      result += isFinalCased(codePoints, i) ? "\u03c2" : "\u03c3";
      continue;
    }
    if (JS_ONLY_LOWER.has(cp)) {
      result += String.fromCodePoint(cp);
      continue;
    }
    // 1:1 / 1:N 映射（含 U+0130 -> i + U+0307）与 JDK 实测全量一致，直接用 JS 单码点结果。
    result += String.fromCodePoint(cp).toLowerCase();
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * 2. \p{L}\p{N} 的 JDK 口径
 * ------------------------------------------------------------------ */

type Range = readonly [number, number];

/** JS 认可是字母/数字、JDK 23 会当非字母数字删掉的码点区间。 */
const JAVA_DROPS: Range[] = [
  [0x1c89, 0x1c8a], [0xa7cb, 0xa7cd], [0xa7da, 0xa7dc], [0xfdc0, 0xfdf3],
  [0x10540, 0x10565], [0x1056f, 0x10585], [0x106c2, 0x106c4], [0x10b80, 0x10b89],
  [0x10b8b, 0x10b8b], [0x10b8e, 0x10b8e], [0x10b90, 0x10bb5], [0x10bb7, 0x10bb7],
  [0x10bd1, 0x10bd1], [0x10bd3, 0x10bd3], [0x10ed0, 0x10ee3], [0x113c0, 0x113e0],
  [0x113f0, 0x113f9], [0x12c60, 0x13bfa], [0x15900, 0x1591d], [0x15930, 0x15939],
  [0x16540, 0x1656c], [0x16570, 0x16579], [0x184ff, 0x184ff], [0x1c4f0, 0x1c4f9],
  [0x1ddd0, 0x1dded], [0x1ddf0, 0x1ddfa],
];

/** JDK 23 认可、JS 会删掉的区间。 */
const JAVA_KEEPS: Range[] = [[0x10f800, 0x10ffff]];

function inRanges(codePoint: number, ranges: Range[]): boolean {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const [start, end] = ranges[mid];
    if (codePoint < start) high = mid - 1;
    else if (codePoint > end) low = mid + 1;
    else return true;
  }
  return false;
}

const NOT_ALPHANUMERIC = /[^\p{L}\p{N}]/u;

function isJavaLetterOrDigit(codePoint: number): boolean {
  if (inRanges(codePoint, JAVA_DROPS)) return false;
  if (inRanges(codePoint, JAVA_KEEPS)) return true;
  return !NOT_ALPHANUMERIC.test(String.fromCodePoint(codePoint));
}

/* ------------------------------------------------------------------ *
 * 3. 正则（Java 口径）
 * ------------------------------------------------------------------ */

/** Java 的 `.`：排除 \n \r \u0085 \u2028 \u2029；u 标志让它按码点计格（JDK 的 . 不拆代理对）。 */
const JAVA_DOT = "[^\\n\\r\\u0085\\u2028\\u2029]";

/** Pattern.compile("[\\(（\\[【].*?[\\)）\\]】]") */
const BRACKETS = new RegExp("[\\(\\uff08\\[\\u3010]" + JAVA_DOT + "*?[\\)\\uff09\\]\\u3011]", "gu");

/** JDK 未开 UNICODE_CHARACTER_CLASS 时 (?i) 只做 ASCII 折叠，因此展开成显式字符类。 */
function asciiInsensitive(word: string): string {
  let out = "";
  for (const ch of word) {
    out += ch >= "a" && ch <= "z" ? "[" + ch + ch.toUpperCase() + "]" : ch;
  }
  return out;
}

/** (?i)live|remix|acoustic|remaster|instrumental|demo|cover|现场|翻唱|伴奏|纯音乐|重制|混音 */
const VERSION_MARKER = new RegExp(
  ["live", "remix", "acoustic", "remaster", "instrumental", "demo", "cover"]
    .map(asciiInsensitive).join("|")
  + "|\u73b0\u573a|\u7ffb\u5531|\u4f34\u594f|\u7eaf\u97f3\u4e50|\u91cd\u5236|\u6df7\u97f3",
  "g");

/**
 * ARTIST_SPLIT：Java 默认口径下 \s = [ \t\n\x0B\f\r]、\b 只看 ASCII 词字符，
 * 所以这里不用 \s、也不加 u 标志（加了 u 之后“周杰伦feat.蔡依林”会变成一个整体，与 Java 不同）。
 */
const ARTIST_SPLIT = new RegExp(
  "[ \\t\\n\\v\\f\\r]*(?:/|,|\uff0c|&|\uff06|\u3001|;|\uff1b|"
  + "\\b" + asciiInsensitive("feat") + "\\.?\\b|\\b" + asciiInsensitive("ft") + "\\.?\\b|\\b"
  + asciiInsensitive("with") + "\\b)[ \\t\\n\\v\\f\\r]*");

function hasVersionMarker(title: string): boolean {
  VERSION_MARKER.lastIndex = 0;
  return VERSION_MARKER.test(title);
}

/* ------------------------------------------------------------------ *
 * 4. 归一化与打分
 * ------------------------------------------------------------------ */

/** Character.isWhitespace(int) 的 JDK 口径（NBSP / U+2007 / U+202F 不算空白）。 */
function isJavaWhitespace(codePoint: number): boolean {
  if (codePoint === 0x20) return true;
  if (codePoint >= 0x09 && codePoint <= 0x0d) return true;
  if (codePoint >= 0x1c && codePoint <= 0x1f) return true;
  if (codePoint === 0x00a0 || codePoint === 0x2007 || codePoint === 0x202f) return false;
  return /\p{Zs}|\p{Zl}|\p{Zp}/u.test(String.fromCodePoint(codePoint));
}

/** String.isBlank()。 */
function isBlankJava(value: string): boolean {
  for (const ch of value) {
    if (!isJavaWhitespace(ch.codePointAt(0) as number)) return false;
  }
  return true;
}

/** 对应 TrackMatcher.normalize(String)。 */
export function normalize(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  let halfWidth = "";
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i); // Java 侧同样遍历 char（UTF-16 码元）
    if (code >= 0xff01 && code <= 0xff5e) halfWidth += String.fromCharCode(code - 0xfee0);
    else if (code === 0x3000) halfWidth += " ";
    else halfWidth += value[i];
  }
  const bracketless = halfWidth.replace(BRACKETS, " ");
  const lowered = toLowerCaseRoot(bracketless);
  let result = "";
  for (const cp of codePointsOf(lowered)) {
    if (isJavaLetterOrDigit(cp)) result += String.fromCodePoint(cp);
  }
  return result;
}

function bigrams(value: string): string[] {
  const grams: string[] = [];
  for (let i = 0; i < value.length - 1; i++) grams.push(value.substring(i, i + 2));
  return grams;
}

/** 对应 private double similarity(String a, String b)。 */
function similarity(a: string, b: string): number {
  // 入参恒为 normalize() 的结果（只剩字母数字），故 isBlank() <=> isEmpty()
  if (a.length === 0 || b.length === 0) return 0;
  if (a === b) return 1;
  const min = Math.min(a.length, b.length);
  const max = Math.max(a.length, b.length);
  if (min >= 2 && (a.includes(b) || b.includes(a)) && min * 1.0 / max >= 0.6) return 0.88;
  if (a.length < 2 || b.length < 2) return 0;
  const left = bigrams(a);
  const right = bigrams(b);
  let intersection = 0;
  const copy = right.slice();
  for (const gram of left) {
    const at = copy.indexOf(gram);
    if (at !== -1) {
      copy.splice(at, 1);
      intersection++;
    }
  }
  return (2.0 * intersection) / (left.length + right.length);
}

/** 对应 private List<String> splitArtists(String)。 */
function splitArtists(artist: string): string[] {
  const parts: string[] = [];
  if (isBlankJava(artist)) return parts;
  for (const piece of artist.split(ARTIST_SPLIT)) {
    const normalized = normalize(piece);
    if (normalized.length !== 0) parts.push(normalized);
  }
  return parts;
}

function artistSimilarity(sourceArtist: string, targetArtist: string): number {
  const sourceParts = splitArtists(sourceArtist);
  const targetParts = splitArtists(targetArtist);
  if (sourceParts.length === 0 && targetParts.length === 0) return 0.6;
  if (sourceParts.length === 0 || targetParts.length === 0) return 0.4;
  let best = 0;
  for (const source of sourceParts) {
    for (const target of targetParts) {
      best = Math.max(best, similarity(source, target));
    }
  }
  return best;
}

function albumSimilarity(sourceAlbum: string, targetAlbum: string): number {
  const source = normalize(sourceAlbum);
  const target = normalize(targetAlbum);
  if (source.length === 0 || target.length === 0) return 0.5;
  if (source === target) return 1;
  return source.includes(target) || target.includes(source) ? 0.6 : 0;
}

/** 对应 public double score(Track source, Track candidate)。 */
export function score(source: TrackInput, candidate: TrackInput): number {
  const src = toTrack(source);
  const dst = toTrack(candidate);
  const titleScore = similarity(normalize(src.title), normalize(dst.title));
  const artistScore = artistSimilarity(src.artist, dst.artist);
  const albumScore = albumSimilarity(src.album, dst.album);
  let value = 0.60 * titleScore + 0.34 * artistScore + 0.06 * albumScore;
  if (hasVersionMarker(src.title) !== hasVersionMarker(dst.title)) {
    value -= 0.08;
  }
  return Math.max(0, Math.min(1, value));
}

/** 对应 private static int percent(double)：Java 的 Math.round(d) == floor(d + 0.5)。 */
export function percent(scoreValue: number): number {
  return Math.floor(scoreValue * 100 + 0.5);
}

/** 对应 public Evaluation evaluate(Track source, List<Track> candidates)。 */
export function evaluate(
  source: TrackInput,
  candidates: TrackInput[] | null | undefined): Evaluation {
  if (candidates === null || candidates === undefined || candidates.length === 0) {
    return { candidate: null, score: 0, matched: false, lowConfidence: false, note: "目标平台未找到这首歌" };
  }
  const src = toTrack(source);
  let best: Track | null = null;
  let bestScore = -1;
  for (const raw of candidates) {
    const candidate = toTrack(raw);
    const candidateScore = score(src, candidate);
    if (candidateScore > bestScore) {
      best = candidate;
      bestScore = candidateScore;
    }
  }
  if (best === null || bestScore < 0.55) {
    const closest = best === null ? ""
      : "（最接近：" + best.title + " · " + best.artist + "，相似度 " + percent(bestScore) + "）";
    return {
      candidate: null,
      score: Math.max(0, bestScore),
      matched: false,
      lowConfidence: false,
      note: "未找到足够相似的版本" + closest,
    };
  }

  const lowConfidence = bestScore < 0.72;
  const versionMismatch = hasVersionMarker(src.title) !== hasVersionMarker(best.title);
  let note = "";
  if (versionMismatch) {
    note += "检测到 Live / Remix 等版本差异";
  }
  if (lowConfidence) {
    if (note.length !== 0) note += "；";
    note += "相似度较低，建议试听确认";
  }
  if (note.length === 0) {
    if (normalize(src.title) === normalize(best.title) && artistSimilarity(src.artist, best.artist) >= 0.8) {
      note = "标题与歌手一致";
    } else if (normalize(src.title) === normalize(best.title)) {
      note = "标题一致，歌手信息有差异";
    } else {
      note = "标题与歌手近似";
    }
  }
  return { candidate: best, score: bestScore, matched: true, lowConfidence, note };
}

/* ------------------------------------------------------------------ *
 * 已知差异（量化）
 * ------------------------------------------------------------------ *
 * JDK 的 Final_Cased 依赖 BreakIterator.getWordInstance(ROOT)——Oracle 私有规则引擎，
 * 对前导组合符号、数字/字母交界的处理与 UAX#29 也不一致，不搬整个分词器无法精确复刻，
 * 这里用 continuesWord() 近似。对拍语料是专挑的希腊大写 Σ 压力测试（非随机标题）：
 *   819  例（Σ/σ/Α/α/空格/·/ͅ/AD/ǅ 全组合） -> 0 例不一致
 *   8420 例（再加 CJK/数字/下划线/撇号/Roman）-> 9 例不一致（0.11%）
 *   11110 例（Σ 与 case-ignorable 相邻）      -> 20 例不一致（0.18%）
 * 同一语料直接用 JS toLowerCase() 分别是 110 / 250 例，移植版收敛约 10 倍。
 * 触发条件极窄：标题需同时含希腊大写字母 Σ(U+03A3) 且紧邻组合符号/软连字符。
 * 其余项为 0 差异：全 1433 条小写映射、\p{L}\p{N} 判定（27 个 JS-only 映射 + 27 段区间已修正）、
 * 括注剥离（含代理对与 NEL）、\b/\s/ASCII 折叠、split 尾随空串、percent 取整。
 */
