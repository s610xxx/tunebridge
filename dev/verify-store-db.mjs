/**
 * 平台数据库适配器回归：用最小 SDK 形状模拟线上库。
 * 重点覆盖平台对缺失逻辑表只回 { code: "database_request_failed", status: 404 }、
 * 没有 message 的真实错误形态，确保仍会回退到 tb_ 前缀，而不是直接 503。
 */
import { dbStore } from "../site/functions/store-db.ts";

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : " — " + detail}`);
  if (!ok) failed++;
};

const KNOWN = new Set(["tb_connections", "tb_jobs", "tb_demo_state"]);
const tables = new Map([...KNOWN].map(name => [name, []]));
const hits = [];
const forced = new Map();

function execute(query) {
  hits.push(query.table);
  if (forced.has(query.table)) {
    return { data: null, error: forced.get(query.table) };
  }
  if (!KNOWN.has(query.table)) {
    return { data: null, error: { code: "database_request_failed", status: 404 } };
  }
  let rows = tables.get(query.table) ?? [];
  const match = (row) => query.filters.every(([column, value]) => row[column] === value);

  if (query.op?.kind === "update") {
    const updated = [];
    rows.forEach((row, index) => {
      if (!match(row)) return;
      const next = { ...row, ...query.op.patch };
      rows[index] = next;
      updated.push(next);
    });
    return { data: updated };
  }
  if (query.op?.kind === "insert") {
    const keys = String(query.op.onConflict ?? "").split(",").map(item => item.trim()).filter(Boolean);
    if (rows.some(row => keys.every(key => row[key] === query.op.row[key]))) return { data: [] };
    rows.push({ ...query.op.row });
    return { data: [{ ...query.op.row }] };
  }
  if (query.op?.kind === "delete") {
    const removed = rows.filter(match);
    tables.set(query.table, rows.filter(row => !match(row)));
    return { data: removed };
  }

  let selected = rows.filter(match);
  if (query.order) {
    const { column, descending } = query.order;
    selected = [...selected].sort((a, b) => {
      const left = a[column], right = b[column];
      return (left < right ? -1 : left > right ? 1 : 0) * (descending ? -1 : 1);
    });
  }
  if (query.range) selected = selected.slice(query.range[0], query.range[1] + 1);
  if (query.limit !== null) selected = selected.slice(0, query.limit);
  return { data: selected.map(row => ({ ...row })) };
}

function chain(table) {
  const query = { table, filters: [], op: null, order: null, range: null, limit: null };
  const api = {
    select: () => api,
    eq: (column, value) => { query.filters.push([column, value]); return api; },
    order: (column, options) => {
      query.order = { column, descending: options?.ascending !== true };
      return api;
    },
    limit: (value) => { query.limit = value; return api; },
    range: (start, end) => { query.range = [start, end]; return api; },
    update: (patch) => { query.op = { kind: "update", patch }; return api; },
    insertIfAbsent: (row, options) => {
      query.op = { kind: "insert", row, onConflict: options?.onConflict };
      return api;
    },
    delete: () => { query.op = { kind: "delete" }; return api; },
    then: (resolve, reject) => {
      try { resolve(execute(query)); } catch (error) { reject(error); }
    },
  };
  return api;
}

const db = { from: chain };

/* ---- 1. 非 404 的真错误不能吞成回退 ---- */
forced.set("connections", { code: "database_request_failed", status: 500 });
const store = dbStore(db);
let unavailable = null;
try { await store.loadConnection("u1", "QQ_MUSIC"); }
catch (error) { unavailable = error; }
check("数据库 500 直接报数据服务不可用", unavailable?.status === 503
  && unavailable?.code === "database_unavailable");
check("数据库 500 不尝试 tb_ 回退", hits.join(",") === "connections", hits.join(","));

/* ---- 2. 平台 404 错误形态驱动 tb_ 回退 ---- */
forced.delete("connections");
hits.length = 0;
const empty = await store.loadConnection("u1", "QQ_MUSIC");
check("连接读取回退到 tb_connections", empty === null
  && hits.join(",") === "connections,tb_connections", hits.join(","));

const credential = { blob: "cipher", expiresAt: Date.now() + 60_000 };
await store.saveConnection({ userId: "u1", provider: "QQ_MUSIC", mode: "REAL",
  label: "QQ 音乐 · 12****89", credential, createdAt: 1234 });
const loaded = await store.loadConnection("u1", "QQ_MUSIC");
check("连接保存后可按账号读回", loaded?.mode === "REAL" && loaded?.label === "QQ 音乐 · 12****89"
  && loaded?.credential?.blob === "cipher" && loaded?.createdAt === 1234, JSON.stringify(loaded));

/* ---- 3. 任务 job JSON 与 active_slot ---- */
hits.length = 0;
const missingJob = await store.loadJob("u1", "j1");
check("任务读取回退到 tb_jobs", missingJob === null
  && hits.join(",") === "jobs,tb_jobs", hits.join(","));

const job = {
  id: "j1", userId: "u1", status: "RUNNING", sourceProvider: "QQ_MUSIC",
  targetProvider: "NETEASE_MUSIC", matches: [], logs: [], createdAt: 1000,
};
await store.saveJob(job);
const jobRow = tables.get("tb_jobs")[0];
check("新任务占住 active_slot", jobRow?.active_slot === "u1" && jobRow?.status === "RUNNING",
  JSON.stringify({ active_slot: jobRow?.active_slot, status: jobRow?.status }));
check("任务 JSON 快照可读回", (await store.loadJob("u1", "j1"))?.id === "j1");
check("活动任务可按 active_slot 查询", (await store.findRunningJob("u1"))?.id === "j1");

job.status = "COMPLETED";
await store.saveJob(job);
check("终态任务释放 active_slot", tables.get("tb_jobs")[0]?.active_slot === null);

/* ---- 4. 演示库状态读写 ---- */
const state = { sessions: {}, sequence: 7 };
await store.saveDemoState("u1", state);
check("演示库状态可读写", JSON.stringify(await store.loadDemoState("u1")) === JSON.stringify(state));

/* ---- 5. 历史筛选在内存层生效 ---- */
const page = await store.listJobs("u1", { offset: 0, limit: 20,
  source: null, target: null, status: null, from: null, to: null });
check("历史列表返回已存任务", page.items.length === 1 && page.items[0].id === "j1"
  && page.hasMore === false, JSON.stringify({ items: page.items.length, hasMore: page.hasMore }));

if (failed > 0) {
  console.error(`${failed} STORE DB CHECK(S) FAILED`);
  process.exit(1);
}
console.log("STORE DB ALL PASS");