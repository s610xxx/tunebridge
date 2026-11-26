/**
 * dev/verify-demo.mjs —— 演示通道（DEMO）的离线对拍脚本。
 *
 * 做什么：把 site/functions/demo.ts 的输出，逐条比对 Java 侧的真值，任何一条不一致就以非零码退出。
 * 不联网、不调用任何音乐平台上游接口：演示通道本身也是纯本地查表 + 匹配取数。
 *
 * 真值怎么来的（本机 JDK 23，工程已编译到 target/classes）：
 *   mvn -o dependency:build-classpath -Dmdep.outputFile=target/cp.txt -DincludeScope=runtime
 *   CP="target/classes;$(tr -d '\n' < target/cp.txt)"
 *   jshell --class-path "$CP" target/demo-truth-{1,2,3,4}.jsh
 * 四个 jsh 脚本分别 dump：曲库/连接/搜索/建库写库主流程、provider×mode 的判定细节、
 * PlaylistView 响应体、以及若干 guard 分支。每个探针都把结果用 UTF-8 写成 JSON 再内联到本文件，
 * 因为 Windows 控制台会把中文打成乱码 —— 直接读屏幕会误判。
 * 第三道核对：本脚本还会正则解析 src/main/java/com/tunebridge/provider/demo/DemoCatalog.java 的源文本，
 * 要求「Java 源码 == jshell 运行时真值 == demo.ts 输出」三者一致，防止我手抄曲库时出错。
 *
 * 运行：node dev/verify-demo.mjs
 */

import {
  DEMO_BUILTIN_ALT_URL,
  DEMO_BUILTIN_PLAYLISTS,
  DEMO_BUILTIN_URL,
  DEMO_LIBRARY_PREFIX,
  DEMO_REQUEST_INTERVAL_MS,
  DEMO_SEQUENCE_START,
  DEMO_TARGET_CATALOGS,
  PROVIDER_IDS,
  PROVIDER_LABELS,
  createDemoProvider,
  createDemoProviders,
  createDemoStore,
  demoBuiltin,
  demoLibraryView,
  demoPlaylistRefs,
  demoPlaylistView,
  demoTargetCatalog,
  emptyDemoStoreState,
  newPlaylist,
  newPlaylistRef,
  newTrack,
  createdPlaylistOf,
  providerIdFrom,
  providerLabel,
  trackOf,
} from "../site/functions/demo.ts";
import { ProviderApiError } from "../site/functions/errors.ts";
import fs from "node:fs";

/* ============================ Java 真值（jshell dump，勿手改） ============================ */

// 由 target/gen-truth.mjs 从 demo-truth-{1,2,3,4}.json 生成，勿手改。
const JAVA_TRACK_KEYS = ["providerTrackId", "title", "artist", "album", "durationSec", "artworkUrl", "songType"];

const JAVA_QQ_BUILTIN_TRACKS = [
    ["dq-1", "晴天", "周杰伦", "叶惠美", 269, "", 0],
    ["dq-2", "小半", "陈粒", "小梦大半", 297, "", 0],
    ["dq-3", "平凡之路", "朴树", "猎户星座", 302, "", 0],
    ["dq-4", "夜空中最亮的星", "逃跑计划", "世界", 252, "", 0],
    ["dq-5", "起风了", "买辣椒也用券", "起风了", 325, "", 0],
    ["dq-6", "漠河舞厅", "柳爽", "漠河舞厅", 333, "", 0],
    ["dq-7", "孤勇者", "陈奕迅", "孤勇者", 257, "", 0],
    ["dq-8", "稻香", "周杰伦", "魔杰座", 223, "", 0],
    ["dq-9", "海底", "一支榴莲", "海底", 276, "", 0],
    ["dq-10", "像风一样", "薛之谦", "渡", 247, "", 0],
    ["dq-11", "若把你", "KIV", "若把你", 214, "", 0],
    ["dq-12", "晚风心里吹", "阿梨粤", "晚风心里吹", 231, "", 0],
];

const JAVA_APPLE_BUILTIN_TRACKS = [
    ["da-1", "Snow on the Beach", "Taylor Swift", "Midnights", 256, "", 0],
    ["da-2", "As It Was", "Harry Styles", "Harry's House", 167, "", 0],
    ["da-3", "凄美地", "郭顶", "飞行器的执行周期", 250, "", 0],
    ["da-4", "Sunset Lover", "Petit Biscuit", "Presence", 238, "", 0],
    ["da-5", "关于我爱你", "张悬", "城市", 305, "", 0],
    ["da-6", "I Love You So", "The Walters", "Songs for Dads", 160, "", 0],
    ["da-7", "水星记", "郭顶", "飞行器的执行周期", 325, "", 0],
    ["da-8", "Lover", "Taylor Swift", "Lover", 221, "", 0],
    ["da-9", "Golden Hour", "JVKE", "this is what ____ feels like", 209, "", 0],
    ["da-10", "浪漫手机", "周杰伦", "十一月的萧邦", 243, "", 0],
];

const JAVA_APPLE_TARGET_TRACKS = [
    ["1440857781", "晴天 (Live)", "周杰伦", "地表最强世界巡回演唱会", 271, "", 0],
    ["1440857792", "小半", "陈粒", "小梦大半", 297, "", 0],
    ["1440857803", "平凡之路", "朴树", "猎户星座", 302, "", 0],
    ["1440857814", "夜空中最亮的星", "逃跑计划", "世界", 252, "", 0],
    ["1440857825", "起风了", "买辣椒也用券", "起风了", 325, "", 0],
    ["1440857836", "漠河舞厅", "柳爽", "漠河舞厅", 333, "", 0],
    ["1440857847", "孤勇者", "陈奕迅", "孤勇者", 257, "", 0],
    ["1440857858", "稻香", "周杰伦", "魔杰座", 223, "", 0],
    ["1440857869", "海底", "一支榴莲", "海底", 276, "", 0],
    ["1440857870", "像风一样", "薛之谦", "渡", 247, "", 0],
    ["1440857881", "七里香", "周杰伦", "七里香", 299, "", 0],
    ["1440857892", "反方向的钟", "周杰伦", "Jay", 258, "", 0],
];

const JAVA_QQ_TARGET_TRACKS = [
    ["97773", "Snow on the Beach", "Taylor Swift", "Midnights", 256, "", 0],
    ["102065756", "As It Was", "Harry Styles", "Harry's House", 167, "", 0],
    ["107762070", "凄美地", "郭顶", "飞行器的执行周期", 250, "", 0],
    ["718475", "关于我爱你", "张悬", "城市", 305, "", 0],
    ["5177680", "I Love You So", "The Walters", "Songs for Dads", 160, "", 0],
    ["279917003", "水星记", "郭顶", "飞行器的执行周期", 325, "", 0],
    ["279917248", "Lover", "Taylor Swift", "Lover", 221, "", 0],
    ["501052971", "浪漫手机", "周杰伦", "十一月的萧邦", 243, "", 0],
    ["482567808", "七里香", "周杰伦", "七里香", 299, "", 0],
    ["279917247", "晴天", "周杰伦", "叶惠美", 269, "", 0],
    ["279917301", "小半", "陈粒", "小梦大半", 297, "", 0],
    ["279917302", "平凡之路", "朴树", "猎户星座", 302, "", 0],
    ["279917303", "夜空中最亮的星", "逃跑计划", "世界", 252, "", 0],
    ["279917304", "起风了", "买辣椒也用券", "起风了", 325, "", 0],
    ["279917305", "漠河舞厅", "柳爽", "漠河舞厅", 333, "", 0],
    ["279917306", "孤勇者", "陈奕迅", "孤勇者", 257, "", 0],
    ["279917307", "稻香", "周杰伦", "魔杰座", 223, "", 0],
    ["279917308", "海底", "一支榴莲", "海底", 276, "", 0],
    ["279917309", "像风一样", "薛之谦", "渡", 247, "", 0],
    ["279917310", "若把你", "KIV", "若把你", 214, "", 0],
    ["279917311", "晚风心里吹", "阿梨粤", "晚风心里吹", 231, "", 0],
];

const JAVA_BUILTIN_HEADS = {
  QQ_MUSIC: {"id":"demo-qq-builtin","name":"夏夜循环 · 华语流行","description":"QQ 音乐演示歌单","coverUrl":"","owner":"演示账号 · 阿桥","webUrl":"demo://builtin","trackCount":12},
  APPLE_MUSIC: {"id":"demo-apple-builtin","name":"Indie 深夜电台","description":"Apple Music 演示歌单","coverUrl":"","owner":"演示账号 · Bridge","webUrl":"demo://builtin","trackCount":10},
};

const JAVA_CONNECT_DEMO = {
  QQ_MUSIC: {"provider":"QQ_MUSIC","mode":"DEMO","accountName":"演示账号 · 阿桥","credentials":{"demoSessionId":"sess-1"}},
  APPLE_MUSIC: {"provider":"APPLE_MUSIC","mode":"DEMO","accountName":"演示账号 · Bridge","credentials":{"demoSessionId":"sess-1"}},
  NETEASE_MUSIC: {"provider":"NETEASE_MUSIC","mode":"DEMO","accountName":"网易云音乐 · 演示账号","credentials":{"demoSessionId":"sess-1"}},
};

const JAVA_SAMPLE_URLS = {"QQ":"https://y.qq.com/n/ryqq/playlist/7300098051","APPLE":"https://music.apple.com/cn/playlist/jason-mraz-essentials/pl.77d8b27b5ca1442e8378920504f115d1","NETEASE":""};
const JAVA_PROVIDER_LABELS = {"QQ_MUSIC":"QQ 音乐","APPLE_MUSIC":"Apple Music","NETEASE_MUSIC":"网易云音乐"};
const JAVA_PROVIDER_FROM = [{"input":"qq","result":"QQ_MUSIC"},{"input":"QQ","result":"QQ_MUSIC"},{"input":"QQ_MUSIC","result":"QQ_MUSIC"},{"input":"qq-music","result":"QQ_MUSIC"},{"input":"QQ MUSIC","result":"QQ_MUSIC"},{"input":"apple","result":"APPLE_MUSIC"},{"input":"APPLE_MUSIC","result":"APPLE_MUSIC"},{"input":"applemusic","result":"APPLE_MUSIC"},{"input":"netease","result":"NETEASE_MUSIC"},{"input":"NCM","result":"NETEASE_MUSIC"},{"input":"NetEase_Music","result":"NETEASE_MUSIC"},{"input":"  qq  ","result":"QQ_MUSIC"},{"input":"","result":null,"exception":"java.lang.IllegalArgumentException","message":"请选择音乐平台"},{"input":"spotify","result":null,"exception":"java.lang.IllegalArgumentException","message":"不支持的音乐平台：spotify"}];

const JAVA_REFS_FRESH = [{"id":"demo-qq-builtin","name":"夏夜循环 · 华语流行","url":"demo://builtin","coverUrl":"","trackCount":12}];
const JAVA_REFS_QQ_AFTER = [{"id":"demo-qq-builtin","name":"夏夜循环 · 华语流行","url":"demo://builtin","coverUrl":"","trackCount":12},{"id":"demo-1001","name":"夏夜加歌","url":"demo://library/demo-1001","coverUrl":"","trackCount":3},{"id":"demo-1002","name":"第二次","url":"demo://library/demo-1002","coverUrl":"","trackCount":0}];
const JAVA_REFS_APPLE_AFTER = [{"id":"demo-apple-builtin","name":"Indie 深夜电台","url":"demo://builtin","coverUrl":"","trackCount":10},{"id":"demo-1003","name":"Apple 侧新建","url":"demo://library/demo-1003","coverUrl":"","trackCount":0}];
const JAVA_CREATES = [{"id":"demo-1001","name":"夏夜加歌","url":"demo://library/demo-1001","trackCount":0,"metadata":{}},{"id":"demo-1002","name":"第二次","url":"demo://library/demo-1002","trackCount":0,"metadata":{}},{"id":"demo-1003","name":"Apple 侧新建","url":"demo://library/demo-1003","trackCount":0,"metadata":{}}];
const JAVA_CREATED_HEAD = {"id":"demo-1001","name":"夏夜加歌","description":"由演示创建","coverUrl":"","owner":"演示音乐库","webUrl":"demo://library/demo-1001","trackCount":0,"tracks":[]};
const JAVA_AFTER_ADD2 = {"id":"demo-1001","name":"夏夜加歌","description":"由演示创建","coverUrl":"","owner":"演示音乐库","webUrl":"demo://library/demo-1001","trackCount":2,"tracks":[{"providerTrackId":"t-a","title":"A","artist":"B","album":"C","durationSec":100,"artworkUrl":"","songType":0},{"providerTrackId":"t-b","title":"D","artist":"E","album":"F","durationSec":200,"artworkUrl":"","songType":0}]};
const JAVA_AFTER_ADD3 = {"id":"demo-1001","name":"夏夜加歌","description":"由演示创建","coverUrl":"","owner":"演示音乐库","webUrl":"demo://library/demo-1001","trackCount":3,"tracks":[{"providerTrackId":"t-a","title":"A","artist":"B","album":"C","durationSec":100,"artworkUrl":"","songType":0},{"providerTrackId":"t-b","title":"D","artist":"E","album":"F","durationSec":200,"artworkUrl":"","songType":0},{"providerTrackId":"t-c","title":"G","artist":"H","album":"I","durationSec":300,"artworkUrl":"","songType":0}]};
const JAVA_EMPTY_ADD = {"id":"demo-1002","name":"第二次","description":"","coverUrl":"","owner":"演示音乐库","webUrl":"demo://library/demo-1002","trackCount":0,"tracks":[]};
const JAVA_REFS_AFTER_CLEAR = [{"id":"demo-qq-builtin","name":"夏夜循环 · 华语流行","url":"demo://builtin","coverUrl":"","trackCount":12}];
const JAVA_CREATE_AFTER_CLEAR = {"id":"demo-1004","name":"清空后新建","url":"demo://library/demo-1004","trackCount":0,"metadata":{}};
const JAVA_CROSS_SESSION_IDS = ["demo-1008","demo-1009","demo-1010"];
const JAVA_APPLE_LIST_AFTER_QQ = ["demo-apple-builtin","demo-1002"];
const JAVA_ADDTRACKS_ORDER = ["b1","b2","b3","b1"];
const JAVA_LIST_SNAPSHOT = {"sizeBefore":3,"sizeAfter":4};
const JAVA_QQ_SEARCH_WITH_APPLE_CONN = ["97773","102065756","107762070","718475","5177680","279917003","279917248","501052971","482567808","279917247","279917301","279917302","279917303","279917304","279917305","279917306","279917307","279917308","279917309","279917310","279917311"];
const JAVA_APPLE_SEARCH_WITH_QQ_CONN = ["1440857781","1440857792","1440857803","1440857814","1440857825","1440857836","1440857847","1440857858","1440857869","1440857870","1440857881","1440857892"];
const JAVA_FETCH_QQ_BUILTIN_VIA_APPLE_CONN = "demo-qq-builtin";
const JAVA_BLANK_NAME_CREATE = {"name":"","id":"demo-1004","url":"demo://library/demo-1004"};
const JAVA_NULL_NORMALIZATION = {"track":{"providerTrackId":"","title":"","artist":"","album":"","durationSec":42,"artworkUrl":"","songType":7},"playlistKeys":["id","name","description","coverUrl","owner","webUrl","trackCount","tracks"],"playlist":{"id":"","name":"","description":"","coverUrl":"","owner":"","webUrl":"","trackCount":0,"tracks":[]},"created":{"id":"i","name":"n","url":"u","trackCount":3,"metadata":{}},"refNegative":{"id":"i","name":"n","url":"u","coverUrl":"c","trackCount":0},"trackOf":{"providerTrackId":"id1","title":"标题","artist":"歌手","album":"专辑","durationSec":12,"artworkUrl":"","songType":0}};
const JAVA_VIEW_KEYS = ["id","name","description","coverUrl","owner","webUrl","totalTracks","truncated","tracks"];
const JAVA_VIEW_TRACK_KEYS = ["id","title","artist","album","durationSec","artworkUrl"];
const JAVA_VIEW_CREATED = {"id":"demo-1001","name":"夏夜加歌","description":"由演示创建","coverUrl":"","owner":"演示音乐库","webUrl":"demo://library/demo-1001","totalTracks":3,"truncated":false,"tracks":[{"id":"t-a","title":"A","artist":"B","album":"C","durationSec":100,"artworkUrl":""},{"id":"t-b","title":"D","artist":"E","album":"F","durationSec":200,"artworkUrl":"https://img/x.png"},{"id":"t-c","title":"G","artist":"H","album":"I","durationSec":300,"artworkUrl":""}]};
const JAVA_VIEW_QQ_HEAD = {"id":"demo-qq-builtin","name":"夏夜循环 · 华语流行","description":"QQ 音乐演示歌单","coverUrl":"","owner":"演示账号 · 阿桥","webUrl":"demo://builtin","totalTracks":12,"truncated":false};
const JAVA_VIEW_APPLE_HEAD = {"id":"demo-apple-builtin","name":"Indie 深夜电台","description":"Apple Music 演示歌单","coverUrl":"","owner":"演示账号 · Bridge","webUrl":"demo://builtin","totalTracks":10,"truncated":false};
const JAVA_VIEW_LIMITED = {"id":"demo-qq-builtin","name":"夏夜循环 · 华语流行","description":"QQ 音乐演示歌单","coverUrl":"","owner":"演示账号 · 阿桥","webUrl":"demo://builtin","totalTracks":12,"truncated":true,"tracks":["dq-1","dq-2","dq-3"]};
const JAVA_VIEW_ZERO = {"id":"demo-qq-builtin","name":"夏夜循环 · 华语流行","description":"QQ 音乐演示歌单","coverUrl":"","owner":"演示账号 · 阿桥","webUrl":"demo://builtin","totalTracks":12,"truncated":false,"tracks":12};
const JAVA_CREATED_SHAPE = {"id":"demo-1001","name":"夏夜加歌","url":"demo://library/demo-1001","trackCount":0,"metadata":{}};

const JAVA_ERRORS = {
  "builtin_NETEASE": {"message":"没有可用的演示歌单","code":null,"status":null,"exception":"IllegalArgumentException"},
  "fetch_qq_unknown_demo_url": {"message":"演示歌单链接无法识别，请使用 demo://builtin 或演示音乐库中的歌单","code":"INVALID_INPUT","status":400,"exception":"ProviderException"},
  "fetch_qq_real_url_on_demo": {"message":"当前是演示连接，请使用演示歌单链接，或切换为真实 QQ 音乐连接","code":"INVALID_INPUT","status":400,"exception":"ProviderException"},
  "fetch_qq_builtin_without_connection": {"message":"演示歌单链接需要先连接 QQ 音乐演示账号","code":"INVALID_INPUT","status":400,"exception":"ProviderException"},
  "fetch_qq_builtin_with_blank_session": {"message":"演示会话已过期，请重新连接演示账号","code":"NOT_CONNECTED","status":409,"exception":"ProviderException"},
  "fetch_qq_empty_url_on_demo": {"message":"当前是演示连接，请使用演示歌单链接，或切换为真实 QQ 音乐连接","code":"INVALID_INPUT","status":400,"exception":"ProviderException"},
  "fetch_qq_null_url": {"message":"当前是演示连接，请使用演示歌单链接，或切换为真实 QQ 音乐连接","code":"INVALID_INPUT","status":400,"exception":"ProviderException"},
  "addtracks_missing_playlist": {"message":"演示歌单不存在","code":null,"status":null,"exception":"IllegalArgumentException"},
  "addtracks_other_sessions_playlist": {"message":"演示歌单不存在","code":null,"status":null,"exception":"IllegalArgumentException"},
  "fetch_missing_library_url": {"message":"演示歌单不存在或已过期","code":null,"status":null,"exception":"IllegalArgumentException"},
  "fetch_other_sessions_library_url": {"message":"演示歌单不存在或已过期","code":null,"status":null,"exception":"IllegalArgumentException"},
  "listplaylists_netease": {"message":"网易云音乐暂不支持作为来源平台","code":"INVALID_INPUT","status":400,"exception":"ProviderException"},
  "listplaylists_qq_null": {"message":"请先连接 QQ 音乐（来源平台）","code":"NOT_CONNECTED","status":409,"exception":"ProviderException"},
  "listplaylists_apple_null": {"message":"请先连接 Apple Music（来源平台）","code":"NOT_CONNECTED","status":409,"exception":"ProviderException"},
  "create_qq_null_connection": {"message":"请先连接 QQ 音乐（目标平台）","code":"NOT_CONNECTED","status":409,"exception":"ProviderException"},
  "addtracks_qq_null_connection": {"message":"请先连接 QQ 音乐（目标平台）","code":"NOT_CONNECTED","status":409,"exception":"ProviderException"},
  "fetch_netease_any": {"message":"网易云音乐暂不支持作为来源平台","code":"INVALID_INPUT","status":400,"exception":"ProviderException"},
  "store_clear_then_find": {"message":"演示歌单不存在或已过期","code":null,"status":null,"exception":"IllegalArgumentException"},
  "netease_search_with_qq_demo_conn": {"message":"请先连接网易云音乐目标账号","code":"NOT_CONNECTED","status":409,"exception":"ProviderException"},
  "netease_create_with_qq_demo_conn": {"message":"请先连接网易云音乐目标账号","code":"NOT_CONNECTED","status":409,"exception":"ProviderException"},
  "find_builtin_id_in_store": {"message":"演示歌单不存在或已过期","code":null,"status":null,"exception":"IllegalArgumentException"},
  "addtracks_to_builtin_id": {"message":"演示歌单不存在","code":null,"status":null,"exception":"IllegalArgumentException"},
  "netease_addtracks_with_qq_demo_conn": {"message":"请先连接网易云音乐目标账号","code":"NOT_CONNECTED","status":409,"exception":"ProviderException"},
  "netease_addtracks_own_demo_missing": {"message":"演示歌单不存在","code":null,"status":null,"exception":"IllegalArgumentException"},
  "list_with_blank_session": {"message":"演示会话已过期，请重新连接演示账号","code":"NOT_CONNECTED","status":409,"exception":"ProviderException"},
  "create_with_blank_session": {"message":"演示会话已过期，请重新连接演示账号","code":"NOT_CONNECTED","status":409,"exception":"ProviderException"},
};

const JAVA_PROVIDER_FROM_ERRORS = [{"input":"","result":null,"exception":"java.lang.IllegalArgumentException","message":"请选择音乐平台"},{"input":"spotify","result":null,"exception":"java.lang.IllegalArgumentException","message":"不支持的音乐平台：spotify"}];
const JAVA_SEARCH_IGNORES_SESSION = true;
const JAVA_IMMUTABLE = {"builtinList":"IMMUTABLE","searchResult":"IMMUTABLE","listSnapshot":"IMMUTABLE"};

/* ================================ 比对工具与用例 ================================ */

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    const detail = fn();
    passed++;
    console.log(`PASS ${name}${detail ? `  (${detail})` : ""}`);
  } catch (error) {
    failures.push({ name, message: error?.message ?? String(error) });
    console.log(`FAIL ${name}\n     ${error?.message ?? String(error)}`);
  }
}

const json = (value) => JSON.stringify(value);

/** 与 jshell 探针 dump 的 Playlist 形状对齐（Track 用 record 分量顺序，见 JAVA_TRACK_KEYS）。 */
const dumpPlaylist = (p) => ({
  id: p.id, name: p.name, description: p.description, coverUrl: p.coverUrl,
  owner: p.owner, webUrl: p.webUrl, trackCount: p.tracks.length, tracks: p.tracks,
});

function eq(actual, expected, label = "") {
  if (json(actual) !== json(expected)) {
    throw new Error(`${label || "不一致"}\n     期望: ${json(expected).slice(0, 400)}`
      + `\n     实际: ${json(actual).slice(0, 400)}`);
  }
  return true;
}

/** 把 Track 摊成 Java record 分量顺序的 7 元组，顺序与内容一起验。 */
function rowsOf(tracks) {
  return tracks.map((t) => [
    t.providerTrackId, t.title, t.artist, t.album, t.durationSec, t.artworkUrl, t.songType,
  ]);
}

function checkTrackRows(actual, javaRows, label) {
  for (const t of actual) eq(Object.keys(t), JAVA_TRACK_KEYS, `${label}: Track 字段顺序`);
  eq(rowsOf(actual), javaRows, `${label}: 曲目内容与顺序`);
  return `${javaRows.length} 首`;
}

function throws(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("未抛错（Java 侧会抛）");
}

/** errors.ts 已与 Java 逐码对齐，这里只做非法入参异常 → 400 INVALID_INPUT 的归一。 */
const JAVA_TO_TS = {
  "INVALID_INPUT/400": { code: "INVALID_INPUT", status: 400 },
  "NOT_CONNECTED/409": { code: "NOT_CONNECTED", status: 409 },
  "IllegalArgumentException": { code: "INVALID_INPUT", status: 400 },
};

function expectJavaError(javaKey, fn) {
  const java = JAVA_ERRORS[javaKey];
  if (!java) throw new Error(`没有 ${javaKey} 的 Java 真值`);
  const error = throws(fn);
  if (!(error instanceof ProviderApiError)) {
    throw new Error(`抛出的不是 ProviderApiError：${error?.name}: ${error?.message}`);
  }
  const want = java.exception === "ProviderException"
    ? JAVA_TO_TS[`${java.code}/${java.status}`]
    : JAVA_TO_TS.IllegalArgumentException;
  if (!want) throw new Error(`未登记的 Java 错误映射：${java.code}/${java.status}`);
  if (error.message !== java.message) {
    throw new Error(`文案不一致\n     Java: ${java.message}\n     TS  : ${error.message}`);
  }
  if (error.code !== want.code || error.status !== want.status) {
    throw new Error(`错误类型不一致，期望 ${want.code}/${want.status}，实际 ${error.code}/${error.status}`);
  }
  return `「${java.message}」→ ${error.status} ${error.code}`;
}

/* ================= 1. 曲库规模与内容（对照 DemoCatalog.java） ================= */

const providers = createDemoProviders(emptyDemoStoreState());
const qq = providers.QQ_MUSIC;
const apple = providers.APPLE_MUSIC;
const netease = providers.NETEASE_MUSIC;

check("1.1 QQ 内置来源歌单 12 首，字段与顺序一致", () =>
  checkTrackRows(demoBuiltin("QQ_MUSIC").tracks, JAVA_QQ_BUILTIN_TRACKS, "builtin QQ"));
check("1.2 Apple 内置来源歌单 10 首，字段与顺序一致", () =>
  checkTrackRows(demoBuiltin("APPLE_MUSIC").tracks, JAVA_APPLE_BUILTIN_TRACKS, "builtin APPLE"));
check("1.3 Apple 目标曲库 12 首", () =>
  checkTrackRows(demoTargetCatalog("APPLE_MUSIC"), JAVA_APPLE_TARGET_TRACKS, "target APPLE"));
check("1.4 QQ 目标曲库 21 首", () =>
  checkTrackRows(demoTargetCatalog("QQ_MUSIC"), JAVA_QQ_TARGET_TRACKS, "target QQ"));
check("1.5 网易云目标曲库 = QQ 同一份列表实例", () => {
  eq(rowsOf(demoTargetCatalog("NETEASE_MUSIC")), JAVA_QQ_TARGET_TRACKS, "target NETEASE");
  if (DEMO_TARGET_CATALOGS.NETEASE_MUSIC !== DEMO_TARGET_CATALOGS.QQ_MUSIC) {
    throw new Error("Java 侧 NETEASE 复用 QQ 的列表实例，TS 侧不是同一个引用");
  }
  if (demoTargetCatalog("NETEASE_MUSIC") !== demoTargetCatalog("QQ_MUSIC")) {
    throw new Error("demoTargetCatalog() 两次调用返回了不同对象");
  }
  return "共享实例";
});
check("1.6 内置歌单元数据（id/name/description/coverUrl/owner/webUrl/曲目数）", () => {
  eq(Object.keys(DEMO_BUILTIN_PLAYLISTS), ["QQ_MUSIC", "APPLE_MUSIC"], "导出的内置表只含两张");
  for (const key of ["QQ_MUSIC", "APPLE_MUSIC"]) {
    if (DEMO_BUILTIN_PLAYLISTS[key] !== demoBuiltin(key)) {
      throw new Error(`${key}: 导出表与 demoBuiltin() 不是同一实例（Java 侧返回同一个不可变 record）`);
    }
    const p = demoBuiltin(key);
    const head = {
      id: p.id, name: p.name, description: p.description, coverUrl: p.coverUrl,
      owner: p.owner, webUrl: p.webUrl, trackCount: p.tracks.length,
    };
    eq(head, JAVA_BUILTIN_HEADS[key], `builtin ${key} 头部字段`);
    eq(Object.keys(head), Object.keys(JAVA_BUILTIN_HEADS[key]), `builtin ${key} 字段顺序`);
  }
  return `${demoBuiltin("QQ_MUSIC").tracks.length}+${demoBuiltin("APPLE_MUSIC").tracks.length} 首`;
});
check("1.7 网易云没有内置来源歌单（Java: IllegalArgumentException）", () =>
  expectJavaError("builtin_NETEASE", () => demoBuiltin("NETEASE_MUSIC")));
check("1.8 曲库对象不可变（Java: List.of / List.copyOf）", () => {
  eq(JAVA_IMMUTABLE, { builtinList: "IMMUTABLE", searchResult: "IMMUTABLE", listSnapshot: "IMMUTABLE" },
    "Java 侧三个列表都不可变");
  if (!Object.isFrozen(demoBuiltin("QQ_MUSIC").tracks)) throw new Error("builtin.tracks 未冻结");
  if (!Object.isFrozen(qq.searchTracks(qq.connectDemo("s"), "x", "y", 6))) throw new Error("searchTracks 结果未冻结");
  if (!Object.isFrozen(qq.listPlaylists(qq.connectDemo("s")))) throw new Error("listPlaylists 结果未冻结");
  const store = createDemoStore(emptyDemoStoreState());
  if (!Object.isFrozen(store.list("s", "QQ_MUSIC"))) throw new Error("DemoStore.list 结果未冻结");
  return "builtin/search/list 均为冻结数组";
});

/* ============ 2. 交叉核对 DemoCatalog.java 源文本（防手抄错） ============ */

function splitArgs(text) {
  const parts = [];
  let depth = 0, inStr = false, esc = false, cur = "";
  for (const ch of text) {
    if (inStr) {
      cur += ch;
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; cur += ch; continue; }
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) { parts.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim() !== "") parts.push(cur.trim());
  return parts;
}

function findCalls(src, head) {
  const out = [];
  let i = 0;
  for (;;) {
    const at = src.indexOf(head, i);
    if (at < 0) break;
    let j = at + head.length, depth = 1, inStr = false, esc = false;
    const start = j;
    while (j < src.length && depth > 0) {
      const ch = src[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === "(") depth++;
      else if (ch === ")") depth--;
      j++;
    }
    out.push(splitArgs(src.slice(start, j - 1)));
    i = j;
  }
  return out;
}

const unquote = (a) => a.replace(/^"|"$/g, "").replace(/\\(.)/g, "$1");

function javaRows(calls) {
  return calls.map((args) => {
    const row = args.map((a, idx) => (idx === 4 || idx === 6 ? Number(a) : unquote(a)));
    // Track.of(id,title,artist,album,dur) 省略了 artworkUrl/songType，Java 侧默认 "" 与 0。
    return row.length === 5 ? [...row, "", 0] : row;
  });
}

function blockOf(src, re, label) {
  const m = src.match(re);
  if (!m) throw new Error(`DemoCatalog.java 里找不到 ${label}`);
  return m[1];
}

check("2.1 Java 源文本解析结果 == jshell 运行时真值 == demo.ts 输出", () => {
  const javaSrc = fs.readFileSync(
    new URL("../src/main/java/com/tunebridge/provider/demo/DemoCatalog.java", import.meta.url), "utf8");
  const groups = [
    ["qqSourceTracks", blockOf(javaSrc, /List<Track> qqSourceTracks = List\.of\(([\s\S]*?)\n\s*\);/, "qqSourceTracks"),
      "Track.of(", JAVA_QQ_BUILTIN_TRACKS, demoBuiltin("QQ_MUSIC").tracks],
    ["appleSourceTracks", blockOf(javaSrc, /List<Track> appleSourceTracks = List\.of\(([\s\S]*?)\n\s*\);/, "appleSourceTracks"),
      "Track.of(", JAVA_APPLE_BUILTIN_TRACKS, demoBuiltin("APPLE_MUSIC").tracks],
    ["target APPLE", blockOf(javaSrc, /targetCatalogs\.put\(ProviderId\.APPLE_MUSIC, List\.of\(([\s\S]*?)\n\s*\)\);/, "APPLE target"),
      "new Track(", JAVA_APPLE_TARGET_TRACKS, demoTargetCatalog("APPLE_MUSIC")],
    ["target QQ", blockOf(javaSrc, /targetCatalogs\.put\(ProviderId\.QQ_MUSIC, List\.of\(([\s\S]*?)\n\s*\)\);/, "QQ target"),
      "new Track(", JAVA_QQ_TARGET_TRACKS, demoTargetCatalog("QQ_MUSIC")],
  ];
  for (const [label, text, head, truth, actual] of groups) {
    const parsed = javaRows(findCalls(text, head));
    eq(parsed, truth, `${label}: Java 源码 vs jshell 真值`);
    eq(rowsOf(actual), truth, `${label}: demo.ts vs jshell 真值`);
  }
  const neteaseAlias = /targetCatalogs\.put\(ProviderId\.NETEASE_MUSIC, targetCatalogs\.get\(ProviderId\.QQ_MUSIC\)\);/.test(javaSrc);
  eq(neteaseAlias, true, "网易云复用 QQ 曲库这一写法");
  return `${groups.reduce((n, g) => n + g[3].length, 0)} 条曲目三方一致`;
});

check("2.2 内置歌单头部字段与源文本一致", () => {
  const javaSrc = fs.readFileSync(
    new URL("../src/main/java/com/tunebridge/provider/demo/DemoCatalog.java", import.meta.url), "utf8");
  for (const [key, re, tracksVar] of [
    ["QQ_MUSIC", /builtinPlaylists\.put\(ProviderId\.QQ_MUSIC,\s*new Playlist\(([\s\S]*?)\)\);/, "qqSourceTracks"],
    ["APPLE_MUSIC", /builtinPlaylists\.put\(ProviderId\.APPLE_MUSIC,\s*new Playlist\(([\s\S]*?)\)\);/, "appleSourceTracks"],
  ]) {
    const args = splitArgs(blockOf(javaSrc, re, `${key} builtin`));
    const p = demoBuiltin(key);
    eq([p.id, p.name, p.description, p.coverUrl, p.owner, p.webUrl], args.slice(0, 6).map(unquote), `${key} 头部`);
    eq(args[6], tracksVar, `${key} 曲目变量名`);
  }
  return "6 字段 × 2 张";
});

/* ==================== 3. ProviderId / 连接 / 采样链接 ==================== */

check("3.1 PROVIDER_LABELS 与 ProviderId.label()", () => {
  eq(PROVIDER_LABELS, JAVA_PROVIDER_LABELS, "label 表");
  eq(PROVIDER_IDS, ["QQ_MUSIC", "APPLE_MUSIC", "NETEASE_MUSIC"], "枚举顺序（ProviderId.values()）");
  eq(providerLabel("NETEASE_MUSIC"), "网易云音乐", "providerLabel()");
  return "3 个平台";
});

check("3.2 providerIdFrom 别名表 + 大小写/连字符/空格 + 错误文案", () => {
  for (const row of JAVA_PROVIDER_FROM) {
    if (row.result !== null) {
      eq(providerIdFrom(row.input), row.result, `from(${JSON.stringify(row.input)})`);
    }
  }
  for (const row of JAVA_PROVIDER_FROM_ERRORS) {
    const error = throws(() => providerIdFrom(row.input));
    if (error.message !== row.message || error.status !== 400) {
      throw new Error(`from(${JSON.stringify(row.input)}) 期望「${row.message}」400，实际「${error.message}」${error.status}`);
    }
  }
  return `${JAVA_PROVIDER_FROM.length} 个入参`;
});

check("3.3 connectDemo 返回体与 Java 完全一致", () => {
  for (const [provider, channel] of [["QQ_MUSIC", qq], ["APPLE_MUSIC", apple], ["NETEASE_MUSIC", netease]]) {
    const conn = channel.connectDemo("sess-1");
    eq({ ...conn }, JAVA_CONNECT_DEMO[provider], `${provider} 连接`);
    eq(Object.keys(conn), Object.keys(JAVA_CONNECT_DEMO[provider]), `${provider} 连接字段顺序`);
  }
  return "3 个平台";
});

check("3.4 sampleUrl（/api/state 用来自愈粘贴框）", () => {
  eq(qq.sampleUrl(), JAVA_SAMPLE_URLS.QQ, "QQ");
  eq(apple.sampleUrl(), JAVA_SAMPLE_URLS.APPLE, "APPLE");
  eq(netease.sampleUrl(), JAVA_SAMPLE_URLS.NETEASE, "NETEASE");
  return "3 条";
});

/* ============ 4. 演示模式下的 searchTracks：整张目标曲库，忽略入参 ============ */

const connQ = qq.connectDemo("flow-1");
const connA = apple.connectDemo("flow-1");
const connN = netease.connectDemo("flow-1");

check("4.1 QQ：title/artist/limit 全部被忽略（Java 同样返回 21 首全量）", () => {
  for (const args of [["晴天", "周杰伦", 6], ["", "", 6], ["晴天", "周杰伦", 1], ["x", "y", 0], ["不存在的歌", "不存在的歌手", 999]]) {
    eq(rowsOf(qq.searchTracks(connQ, ...args)), JAVA_QQ_TARGET_TRACKS, `searchTracks(${json(args)})`);
  }
  return "5 组入参同结果";
});
check("4.2 Apple：返回 12 首全量（含「晴天 (Live)」这个版本差异样本）", () => {
  eq(rowsOf(apple.searchTracks(connA, "As It Was", "Harry Styles", 6)), JAVA_APPLE_TARGET_TRACKS, "apple");
  eq(rowsOf(apple.searchTracks(connA, "", "", 6)), JAVA_APPLE_TARGET_TRACKS, "apple 空查询");
  eq(demoTargetCatalog("APPLE_MUSIC")[0].title, "晴天 (Live)", "Live 样本");
  return "12 首";
});
check("4.3 网易云：演示搜索可用（作为目标），结果等于 QQ 曲库", () => {
  eq(rowsOf(netease.searchTracks(connN, "晴天", "周杰伦", 6)), JAVA_QQ_TARGET_TRACKS, "netease");
  eq(rowsOf(netease.searchTracks(connN, "晴天", null, 2)), JAVA_QQ_TARGET_TRACKS, "netease limit=2");
  return "21 首";
});
check("4.4 Java 现状：QQ/Apple 只判 mode，不判 provider；网易云额外判 provider", () => {
  eq(rowsOf(qq.searchTracks(connA, "x", "y", 1)).map((r) => r[0]), JAVA_QQ_SEARCH_WITH_APPLE_CONN, "qq×apple 连接");
  eq(rowsOf(apple.searchTracks(connQ, "x", "y", 1)).map((r) => r[0]), JAVA_APPLE_SEARCH_WITH_QQ_CONN, "apple×qq 连接");
  eq(qq.fetchPlaylist(connA, DEMO_BUILTIN_URL).id, JAVA_FETCH_QQ_BUILTIN_VIA_APPLE_CONN, "qq×apple 取内置");
  expectJavaError("netease_search_with_qq_demo_conn", () => netease.searchTracks(connQ, "x", "y", 1));
  expectJavaError("netease_create_with_qq_demo_conn", () => netease.createPlaylist(connQ, "n", "d"));
  expectJavaError("netease_addtracks_with_qq_demo_conn",
    () => netease.addTracks(connQ, createdPlaylistOf("demo-1001", "n", "u", 0), []));
  return "2 处不对称 + 3 处网易云 guard";
});
check("4.5 搜索不校验 demoSessionId（Java: 空 session 也能搜）", () => {
  eq(JAVA_SEARCH_IGNORES_SESSION, true, "Java 真值");
  const blank = { provider: "QQ_MUSIC", mode: "DEMO", accountName: "x", credentials: {} };
  eq(rowsOf(qq.searchTracks(blank, "t", "a", 1)), JAVA_QQ_TARGET_TRACKS, "空 session 搜索");
  return "不抛错";
});
check("4.6 演示模式不走 requestIntervalMs（MigrationService 固定 80ms）", () => {
  eq(DEMO_REQUEST_INTERVAL_MS, 80, "DEMO_REQUEST_INTERVAL_MS");
  return "80ms（配置里的 120 只作用于 REAL）";
});

/* ============= 5. fetchPlaylist（来源侧）：demo:// 的三种链接 ============= */

check("5.1 demo://builtin 与 demo://playlist/builtin 都返回内置歌单", () => {
  eq(qq.fetchPlaylist(connQ, DEMO_BUILTIN_URL).id, "demo-qq-builtin", "QQ builtin");
  eq(qq.fetchPlaylist(connQ, DEMO_BUILTIN_ALT_URL).id, "demo-qq-builtin", "QQ alt");
  eq(apple.fetchPlaylist(connA, DEMO_BUILTIN_URL).id, "demo-apple-builtin", "APPLE builtin");
  eq(qq.fetchPlaylist(connQ, DEMO_BUILTIN_URL), demoBuiltin("QQ_MUSIC"), "同一实例");
  return "3 条 + 实例一致";
});
check("5.2 非 demo:// 链接在演示连接上被拒（含空串与 null）", () => {
  expectJavaError("fetch_qq_real_url_on_demo", () => qq.fetchPlaylist(connQ, "https://y.qq.com/x"));
  expectJavaError("fetch_qq_empty_url_on_demo", () => qq.fetchPlaylist(connQ, ""));
  expectJavaError("fetch_qq_null_url", () => qq.fetchPlaylist(connQ, null));
  expectJavaError("fetch_netease_any", () => netease.fetchPlaylist(connN, DEMO_BUILTIN_URL));
  expectJavaError("listplaylists_netease", () => netease.listPlaylists(connN));
  return "5 条";
});
check("5.3 demo:// 链接但连接不是 DEMO / 连接为空", () => {
  expectJavaError("fetch_qq_builtin_without_connection", () => qq.fetchPlaylist(null, DEMO_BUILTIN_URL));
  const real = { provider: "APPLE_MUSIC", mode: "REAL", accountName: "x", credentials: {} };
  const error = throws(() => apple.fetchPlaylist(real, DEMO_BUILTIN_URL));
  if (!(error instanceof ProviderApiError) || error.status !== 400) {
    throw new Error("REAL 连接拿 demo:// 应该 400");
  }
  if (error.message !== "演示歌单链接需要先连接 Apple Music 演示账号") {
    throw new Error(`Apple 变体文案不符：${error.message}`);
  }
  return "含 Apple 文案变体";
});
check("5.4 demoSessionId 缺失 = 会话过期（先取 session 再取链接）", () => {
  expectJavaError("fetch_qq_builtin_with_blank_session", () => qq.fetchPlaylist(
    { provider: "QQ_MUSIC", mode: "DEMO", accountName: "x", credentials: {} }, DEMO_BUILTIN_URL));
  expectJavaError("list_with_blank_session", () => qq.listPlaylists(
    { provider: "QQ_MUSIC", mode: "DEMO", accountName: "x", credentials: {} }));
  expectJavaError("create_with_blank_session", () => qq.createPlaylist(
    { provider: "QQ_MUSIC", mode: "DEMO", accountName: "x", credentials: {} }, "n", "d"));
  return "3 个入口";
});
check("5.5 无法识别的 demo:// 链接", () =>
  expectJavaError("fetch_qq_unknown_demo_url", () => qq.fetchPlaylist(connQ, "demo://other")));

/* ===== 6. DemoStore 生命周期：建库、写歌、取库、清库（完整复刻 Java 探针顺序） ===== */

const flowState = emptyDemoStoreState();
eq(flowState.sequence, DEMO_SEQUENCE_START, "序号起点");
const flow = createDemoProviders(flowState);
const flowQq = flow.QQ_MUSIC.connectDemo("flow-1");
const flowApple = flow.APPLE_MUSIC.connectDemo("flow-1");

check("6.1 空会话的来源列表 = 只有内置歌单", () => {
  const refs = qq.listPlaylists(qq.connectDemo("brand-new"));
  eq(refs, JAVA_REFS_FRESH, "fresh refs");
  eq(Object.keys(refs[0]), Object.keys(JAVA_REFS_FRESH[0]), "PlaylistRef 字段顺序");
  return "1 条 ref";
});
check("6.2 createPlaylist → demo-1001/1002（QQ）与 demo-1003（Apple）", () => {
  const c1 = flow.QQ_MUSIC.createPlaylist(flowQq, "夏夜加歌", "由演示创建");
  const c2 = flow.QQ_MUSIC.createPlaylist(flowQq, "第二次", "");
  const c3 = flow.APPLE_MUSIC.createPlaylist(flowApple, "Apple 侧新建", "desc");
  eq([c1, c2, c3], JAVA_CREATES, "CreatedPlaylist 四元组 + metadata");
  eq(Object.keys(c1), Object.keys(JAVA_CREATES[0]), "CreatedPlaylist 字段顺序");
  if (flowState.sequence !== 1003) throw new Error(`序号应为 1003，实际 ${flowState.sequence}`);
  return "id/url/trackCount 全等";
});
check("6.3 新建出来的歌单字段（owner=演示音乐库、coverUrl 空、webUrl=demo://library/<id>、0 首）", () =>
  eq(dumpPlaylist(createDemoStore(flowState).find("flow-1", "QQ_MUSIC", "demo-1001")),
    JAVA_CREATED_HEAD, "created head"));
check("6.4 addTracks 追加合并，整体替换 Playlist 实例", () => {
  flow.QQ_MUSIC.addTracks(flowQq, createdPlaylistOf("demo-1001", "夏夜加歌", "demo://library/demo-1001", 0),
    [trackOf("t-a", "A", "B", "C", 100), trackOf("t-b", "D", "E", "F", 200)]);
  const store = createDemoStore(flowState);
  eq(dumpPlaylist(store.find("flow-1", "QQ_MUSIC", "demo-1001")), JAVA_AFTER_ADD2, "写 2 首后");
  flow.QQ_MUSIC.addTracks(flowQq, createdPlaylistOf("demo-1001", "", "", 0), [trackOf("t-c", "G", "H", "I", 300)]);
  eq(dumpPlaylist(store.find("flow-1", "QQ_MUSIC", "demo-1001")), JAVA_AFTER_ADD3, "再写 1 首后");
  eq(store.find("flow-1", "QQ_MUSIC", "demo-1001"), flow.QQ_MUSIC.fetchPlaylist(flowQq, `${DEMO_LIBRARY_PREFIX}demo-1001`),
    "fetch 与 find 同一实例");
  flow.QQ_MUSIC.addTracks(flowQq, createdPlaylistOf("demo-1002", "", "", 0), []);
  eq(dumpPlaylist(store.find("flow-1", "QQ_MUSIC", "demo-1002")), JAVA_EMPTY_ADD, "空列表写入不报错");
  return "2 首 → 3 首";
});
check("6.5 listPlaylists（= DemoPlaylists.of）顺序与曲目数", () => {
  eq(flow.QQ_MUSIC.listPlaylists(flowQq), JAVA_REFS_QQ_AFTER, "QQ refs");
  eq(flow.APPLE_MUSIC.listPlaylists(flowApple), JAVA_REFS_APPLE_AFTER, "Apple refs");
  eq(demoPlaylistRefs(createDemoStore(flowState), "QQ_MUSIC", "flow-1"), JAVA_REFS_QQ_AFTER, "demoPlaylistRefs");
  return "3 条 / 2 条";
});
check("6.6 找不到歌单的三种文案", () => {
  expectJavaError("addtracks_missing_playlist", () => flow.QQ_MUSIC.addTracks(flowQq,
    createdPlaylistOf("demo-9999", "x", "y", 0), [trackOf("z", "z", "z", "z", 1)]));
  expectJavaError("fetch_missing_library_url", () => flow.QQ_MUSIC.fetchPlaylist(flowQq, `${DEMO_LIBRARY_PREFIX}demo-404`));
  expectJavaError("addtracks_other_sessions_playlist", () => flow.QQ_MUSIC.addTracks(
    flow.QQ_MUSIC.connectDemo("flow-2"), createdPlaylistOf("demo-1001", "x", "y", 0), []));
  expectJavaError("fetch_other_sessions_library_url", () => flow.APPLE_MUSIC.fetchPlaylist(flowApple,
    `${DEMO_LIBRARY_PREFIX}demo-1001`));
  expectJavaError("find_builtin_id_in_store", () => createDemoStore(flowState).find("flow-1", "QQ_MUSIC", "demo-qq-builtin"));
  expectJavaError("addtracks_to_builtin_id", () => createDemoStore(flowState).addTracks("flow-1", "QQ_MUSIC",
    "demo-qq-builtin", [trackOf("x", "x", "x", "x", 1)]));
  return "6 条";
});
check("6.7 clear 之后：来源列表回到只有内置，序号继续走", () => {
  createDemoStore(flowState).clear("flow-1");
  eq(flow.QQ_MUSIC.listPlaylists(flowQq), JAVA_REFS_AFTER_CLEAR, "clear 后 refs");
  expectJavaError("store_clear_then_find", () => createDemoStore(flowState).find("flow-1", "QQ_MUSIC", "demo-1001"));
  eq(flow.QQ_MUSIC.createPlaylist(flowQq, "清空后新建", ""), JAVA_CREATE_AFTER_CLEAR, "clear 后新建 id");
  return "序号 1003 → 1004";
});
check("6.8 序号跨会话、跨平台共享；音乐库按 (session, provider) 隔离", () => {
  const s2 = emptyDemoStoreState();
  const p2 = createDemoProviders(s2);
  const cross = p2.QQ_MUSIC.connectDemo("cross-1");
  const crossA = p2.APPLE_MUSIC.connectDemo("cross-1");
  eq(p2.QQ_MUSIC.createPlaylist(cross, "n", "").id, "demo-1001", "QQ 首建");
  eq(p2.APPLE_MUSIC.createPlaylist(crossA, "n", "").id, "demo-1002", "Apple 次建");
  eq(p2.QQ_MUSIC.createPlaylist(cross, "只在QQ", "").id, "demo-1003", "QQ 三建");
  eq(p2.APPLE_MUSIC.listPlaylists(crossA).map((r) => r.id), JAVA_APPLE_LIST_AFTER_QQ, "Apple 侧只看到自己的");
  const blank = p2.QQ_MUSIC.createPlaylist(cross, "", "");
  eq(blank.id, JAVA_BLANK_NAME_CREATE.id, "空名字也允许建");
  eq(blank.name, JAVA_BLANK_NAME_CREATE.name, "空名字保持为空");
  const store2 = createDemoStore(s2);
  const before = store2.list("cross-1", "QQ_MUSIC").length;
  p2.QQ_MUSIC.createPlaylist(cross, "之后新建", "");
  const after = store2.list("cross-1", "QQ_MUSIC").length;
  eq({ sizeBefore: before, sizeAfter: after }, JAVA_LIST_SNAPSHOT, "list 是快照");
  const made = p2.QQ_MUSIC.createPlaylist(cross, "顺序", "");
  p2.QQ_MUSIC.addTracks(cross, made, [trackOf("b1", "B1", "", "", 1), trackOf("b2", "B2", "", "", 2)]);
  p2.QQ_MUSIC.addTracks(cross, made, [trackOf("b3", "B3", "", "", 3)]);
  p2.QQ_MUSIC.addTracks(cross, made, [trackOf("b1", "B1-dup", "", "", 9)]);
  eq(store2.find("cross-1", "QQ_MUSIC", made.id).tracks.map((t) => t.providerTrackId),
    JAVA_ADDTRACKS_ORDER, "追加顺序 + 允许重复 id");
  // Java 探针在这里还建了一张重名歌单（demo-1007），保留同样的顺序，后面跨会话序号才对得上。
  const dup = p2.QQ_MUSIC.createPlaylist(cross, "dup", "");
  eq(p2.QQ_MUSIC.createPlaylist(p2.QQ_MUSIC.connectDemo("session-A"), "A", "").id, JAVA_CROSS_SESSION_IDS[0], "会话 A");
  eq(p2.QQ_MUSIC.createPlaylist(p2.QQ_MUSIC.connectDemo("session-B"), "B", "").id, JAVA_CROSS_SESSION_IDS[1], "会话 B");
  eq(p2.APPLE_MUSIC.createPlaylist(p2.APPLE_MUSIC.connectDemo("session-C"), "C", "").id,
    JAVA_CROSS_SESSION_IDS[2], "会话 C（Apple）");
  eq(dup.id, "demo-1007", "序号不因 clear/跨会话而重置");
  return "1001..1010 全序一致";
});
check("6.9 未注入状态时明确失败，绝不静默", () => {
  const readonlyChannel = createDemoProvider("QQ_MUSIC", null);
  const conn = readonlyChannel.connectDemo("s");
  for (const [label, fn] of [
    ["createPlaylist", () => readonlyChannel.createPlaylist(conn, "n", "d")],
    ["addTracks", () => readonlyChannel.addTracks(conn, createdPlaylistOf("x", "n", "u", 0), [])],
    ["listPlaylists", () => readonlyChannel.listPlaylists(conn)],
    ["fetch library url", () => readonlyChannel.fetchPlaylist(conn, `${DEMO_LIBRARY_PREFIX}demo-1001`)],
    ["store.clear", () => createDemoStore(null).clear("s")],
  ]) {
    const error = throws(fn);
    if (!(error instanceof ProviderApiError) || error.status !== 503 || error.code !== "NOT_CONFIGURED"
        || !/未注入/.test(error.message)) {
      throw new Error(`${label} 期望 503 NOT_CONFIGURED 且提示未注入，实际 ${error.status} ${error.code} ${error.message}`);
    }
  }
  // 纯查表的动作不需要任何状态，仍然可用。
  eq(readonlyChannel.searchTracks(conn, "晴天", "周杰伦", 6).length, 21, "无状态仍可搜索");
  eq(readonlyChannel.fetchPlaylist(conn, DEMO_BUILTIN_URL).id, "demo-qq-builtin", "无状态仍可取内置歌单");
  return "5 个写入口 503 + 2 个读入口可用";
});

/* ================= 7. /api/demo/library 与 PlaylistView 响应体 ================= */

check("7.1 PlaylistView 字段顺序与截断规则", () => {
  const store = createDemoStore(emptyDemoStoreState());
  const builtin = demoBuiltin("QQ_MUSIC");
  const view = demoPlaylistView(builtin, Number.MAX_SAFE_INTEGER);
  eq(Object.keys(view), JAVA_VIEW_KEYS, "PlaylistView 字段顺序");
  eq(Object.keys(view.tracks[0]), JAVA_VIEW_TRACK_KEYS, "TrackView 字段顺序");
  const { tracks, ...head } = view;
  eq(head, JAVA_VIEW_QQ_HEAD, "QQ 头部字段");
  eq(Object.keys(demoPlaylistView(demoBuiltin("APPLE_MUSIC"), Number.MAX_SAFE_INTEGER)), JAVA_VIEW_KEYS, "Apple");
  eq({ ...demoPlaylistView(builtin, 3), tracks: demoPlaylistView(builtin, 3).tracks.map((t) => t.id) },
    JAVA_VIEW_LIMITED, "maxTracks=3 → truncated=true");
  eq({ ...demoPlaylistView(builtin, 0), tracks: demoPlaylistView(builtin, 0).tracks.length },
    JAVA_VIEW_ZERO, "maxTracks=0 → 不截断");
  return `${view.totalTracks} 首，truncated=${view.truncated}`;
});
check("7.2 建库 + 写歌后的 /api/demo/library 响应体（含 artworkUrl / songType 透传）", () => {
  const state = emptyDemoStoreState();
  const channel = createDemoProvider("QQ_MUSIC", state);
  const conn = channel.connectDemo("view-1");
  const created = channel.createPlaylist(conn, "夏夜加歌", "由演示创建");
  eq(created, JAVA_CREATED_SHAPE, "CreatedPlaylist 形状");
  channel.addTracks(conn, created, [
    trackOf("t-a", "A", "B", "C", 100),
    newTrack("t-b", "D", "E", "F", 200, "https://img/x.png", 3),
  ]);
  channel.addTracks(conn, created, [trackOf("t-c", "G", "H", "I", 300)]);
  const library = demoLibraryView("QQ_MUSIC", conn, state);
  eq(library.length, 1, "库内歌单数");
  eq(library[0], JAVA_VIEW_CREATED, "响应体全等");
  eq(demoPlaylistRefs(createDemoStore(state), "QQ_MUSIC", "view-1")[1].trackCount, 3, "ref 曲目数同步");
  eq(rowsOf(createDemoStore(state).find("view-1", "QQ_MUSIC", created.id).tracks)[1],
    ["t-b", "D", "E", "F", 200, "https://img/x.png", 3], "artworkUrl/songType 不被丢");
  return "1 张 · 3 首";
});
check("7.3 未连接 / 非演示连接 → 空数组（Java ApiController.demoLibrary）", () => {
  eq(demoLibraryView("APPLE_MUSIC", null, emptyDemoStoreState()), [], "null 连接");
  eq(demoLibraryView("APPLE_MUSIC",
    { provider: "APPLE_MUSIC", mode: "REAL", accountName: "x", credentials: {} }, emptyDemoStoreState()),
  [], "REAL 连接");
  return "2 种";
});
check("7.4 demoSessionId 必须与 HttpSession id 同源，否则看不见自己建的库", () => {
  const state = emptyDemoStoreState();
  const channel = createDemoProvider("APPLE_MUSIC", state);
  channel.createPlaylist(channel.connectDemo("session-A"), "A 的歌单", "");
  eq(demoLibraryView("APPLE_MUSIC", channel.connectDemo("session-B"), state).length, 0, "跨 session 看不到");
  eq(demoLibraryView("APPLE_MUSIC", channel.connectDemo("session-A"), state).length, 1, "本 session 看得到");
  return "按 sessionId 隔离";
});

/* ================= 8. record 归一化（Java 紧凑构造器） ================= */

check("8.1 null → 空串、负曲目数夹到 0、字段顺序", () => {
  eq({ ...newTrack(null, null, null, null, 42, null, 7) }, JAVA_NULL_NORMALIZATION.track, "Track 归一化");
  eq(dumpPlaylist(newPlaylist(null, null, null, null, null, null, null)),
    JAVA_NULL_NORMALIZATION.playlist, "Playlist 归一化");
  eq(createdPlaylistOf("i", "n", "u", 3), JAVA_NULL_NORMALIZATION.created, "CreatedPlaylist");
  eq(newPlaylistRef("i", "n", "u", "c", -5), JAVA_NULL_NORMALIZATION.refNegative, "PlaylistRef 负数夹到 0");
  eq({ ...trackOf("id1", "标题", "歌手", "专辑", 12) }, JAVA_NULL_NORMALIZATION.trackOf, "Track.of 等价物");
  return "5 个构造入口";
});

/* ================= 9. 边缘运行时的硬约束（静态自检） ================= */

check("9.1 demo.ts 只用 WebCrypto 级 API、相对导入带 .ts、无网络与平台 SDK", () => {
  const src = fs.readFileSync(new URL("../site/functions/demo.ts", import.meta.url), "utf8");
  for (const banned of ["fetch(", "Deno.", "jsr:", "Node.js", "require(", "process.", "localStorage", "crypto."]) {
    if (src.includes(banned)) throw new Error(`demo.ts 里出现了 ${banned}`);
  }
  for (const m of src.matchAll(/from\s+"([^"]+)"/g)) {
    if (m[1].startsWith(".") && !m[1].endsWith(".ts")) throw new Error(`相对导入缺少 .ts 后缀：${m[1]}`);
  }
  if (!src.includes('from "./errors.ts"')) throw new Error("没有复用 errors.ts 的错误类型");
  if (/\benum\b|\bnamespace\b/.test(src)) throw new Error("用了 Node 类型剥离不支持的 enum/namespace");
  return "仅依赖 ./errors.ts";
});

/* ================================ 汇总 ================================ */

console.log("");
console.log(`演示通道对拍：${passed} 项通过，${failures.length} 项不一致`);
if (failures.length > 0) {
  for (const f of failures) console.log(` - ${f.name}: ${f.message.split("\n")[0]}`);
  console.log("曲库/行为与 Java 不一致，禁止上线");
  process.exit(1);
}
console.log("曲库数据与 DEMO 行为逐条对齐 Java 实现（含 provider×mode 的不对称现状）");
