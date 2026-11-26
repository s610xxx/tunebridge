import { ProviderApiError } from "./errors.ts";
import type { Job } from "./job.ts";
import type { DemoStoreState } from "./demo.ts";
import { paginateJobs, type Connection, type JobPage, type JobListQuery, type Store } from "./store.ts";

/**
 * 平台数据库适配器。平台注入的 SDK 是链式查询对象，这里只依赖它的最小形状：
 * from(table) → select/insert/insertIfAbsent/update/delete → eq/order/range/limit。
 * 表名先按逻辑名访问；若平台报「表不存在」再自动改用 tb_ 前缀，并缓存命中的名字。
 * 线上历史任务就是 Job 的 JSON 快照，因此旧数据无需迁移即可读出。
 */

type DbClient = { from(table: string): any };
type DbReply = { data?: unknown; error?: unknown };

const tableNames = new Map<string, string>();
const MISSING_TABLE = /(no such table|does not exist|unknown table|relation .* does not exist|table .* not found|42P01)/i;

function replyError(reply: unknown): unknown {
  if (!reply || typeof reply !== "object" || Array.isArray(reply)) return null;
  const error = (reply as DbReply).error;
  return error === undefined || error === null ? null : error;
}

function errorText(error: unknown): string {
  if (error === null || error === undefined) return "";
  if (typeof error === "string") return error;
  const value = error as { message?: unknown; code?: unknown };
  if (typeof value.message === "string") return String(value.code ?? "") + " " + value.message;
  try { return JSON.stringify(error); } catch { return String(error); }
}

function databaseFailure(error: unknown): ProviderApiError {
  console.error("database operation failed", error);
  return new ProviderApiError(503, "database_unavailable", "数据服务暂时不可用，请稍后重试");
}

async function withTable<T>(logical: string, run: (table: string) => Promise<T> | T): Promise<T> {
  const cached = tableNames.get(logical);
  const candidates = cached ? [cached] : [logical, "tb_" + logical];
  let last: unknown = null;
  for (let i = 0; i < candidates.length; i++) {
    const hasFallback = i + 1 < candidates.length;
    try {
      const reply = await run(candidates[i]);
      const error = replyError(reply);
      if (error !== null) {
        last = error;
        if (hasFallback && MISSING_TABLE.test(errorText(error))) continue;
        throw databaseFailure(error);
      }
      tableNames.set(logical, candidates[i]);
      return reply;
    } catch (error) {
      if (error instanceof ProviderApiError) throw error;
      last = error;
      if (hasFallback && MISSING_TABLE.test(errorText(error))) continue;
      throw databaseFailure(error);
    }
  }
  throw databaseFailure(last);
}

/** SDK 正常返回 { data, error }，也容忍直接返回数组的实现。 */
function rowsOf(reply: unknown): Record<string, any>[] {
  const data = Array.isArray(reply) ? reply
    : reply && typeof reply === "object" ? (reply as DbReply).data : null;
  return Array.isArray(data) ? data as Record<string, any>[] : [];
}

function jsonColumn<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    try { return JSON.parse(value) as T; } catch { return null; }
  }
  return typeof value === "object" ? value as T : null;
}

function decodeJob(value: unknown): Job | null {
  const job = jsonColumn<Job>(value);
  if (!job || typeof job.id !== "string" || typeof job.userId !== "string"
      || typeof job.status !== "string" || !Array.isArray(job.matches) || !Array.isArray(job.logs)) {
    return null;
  }
  return job;
}

function credentialOf(value: unknown): Connection["credential"] {
  const parsed = jsonColumn<{ blob?: unknown; expiresAt?: unknown }>(value);
  if (!parsed || typeof parsed.blob !== "string" || !Number.isFinite(Number(parsed.expiresAt))) return null;
  return { blob: parsed.blob, expiresAt: Number(parsed.expiresAt) };
}

function demoStateOf(value: unknown): DemoStoreState | null {
  const parsed = jsonColumn<DemoStoreState>(value);
  if (!parsed || typeof parsed !== "object" || !parsed.sessions || typeof parsed.sessions !== "object"
      || !Number.isFinite(Number(parsed.sequence))) return null;
  return { sessions: parsed.sessions, sequence: Number(parsed.sequence) };
}

export function dbStore(db: DbClient): Store {
  const nowIso = () => new Date().toISOString();

  async function loadJobRow(userId: string, jobId: string): Promise<Job | null> {
    const found = rowsOf(await withTable("jobs", t => db.from(t)
      .select("job").eq("id", jobId).eq("user_id", userId).limit(1)));
    if (found.length === 0) return null;
    const job = decodeJob(found[0].job);
    if (!job) throw databaseFailure("任务报告无法读取");
    return job;
  }

  async function writeJobRow(job: Job): Promise<number> {
    const terminal = job.status === "COMPLETED" || job.status === "FAILED" || job.status === "INTERRUPTED";
    const patch = {
      status: job.status,
      active_slot: terminal ? null : job.userId,
      source_provider: job.sourceProvider,
      target_provider: job.targetProvider,
      updated_at: nowIso(),
      job: JSON.stringify(job),
    };
    const updated = rowsOf(await withTable("jobs", t => db.from(t).update(patch)
      .eq("id", job.id).eq("user_id", job.userId).select("id")));
    return updated.length;
  }

  async function findActiveJob(userId: string): Promise<Job | null> {
    const found = rowsOf(await withTable("jobs", t => db.from(t)
      .select("job").eq("user_id", userId).eq("active_slot", userId).limit(1)));
    if (found.length === 0) return null;
    return decodeJob(found[0].job);
  }

  return {
    async saveJob(job) {
      if (await writeJobRow(job) === 1) return;
      const terminal = job.status === "COMPLETED" || job.status === "FAILED" || job.status === "INTERRUPTED";
      try {
        const inserted = rowsOf(await withTable("jobs", t => db.from(t).insertIfAbsent({
          id: job.id,
          user_id: job.userId,
          status: job.status,
          active_slot: terminal ? null : job.userId,
          source_provider: job.sourceProvider,
          target_provider: job.targetProvider,
          created_at: new Date(job.createdAt).toISOString(),
          updated_at: nowIso(),
          job: JSON.stringify(job),
        }, { onConflict: "id" }).select("id")));
        if (inserted.length === 1) return;
      } catch (error) {
        const existing = await loadJobRow(job.userId, job.id).catch(() => null);
        if (existing) {
          if (await writeJobRow(job) === 1) return;
          throw databaseFailure(error);
        }
        const active = await findActiveJob(job.userId).catch(() => null);
        if (active && active.id !== job.id) {
          throw new ProviderApiError(409, "ACTIVE_JOB", "已有未完成的迁移任务，请先完成或放弃");
        }
        throw databaseFailure(error);
      }
      // 并发下另一请求可能刚插入同一 id，回写一次即可。
      if (await writeJobRow(job) === 1) return;
      throw new ProviderApiError(503, "database_unavailable", "任务保存失败，请稍后重试");
    },

    async loadJob(userId, jobId) {
      return loadJobRow(userId, jobId);
    },

    async findRunningJob(userId) {
      return findActiveJob(userId);
    },

    async listJobs(userId, query: JobListQuery): Promise<JobPage> {
      const fetched: Job[] = [];
      const pageSize = 100;
      const scanLimit = 1000;
      for (let start = 0; start < scanLimit; start += pageSize) {
        const page = rowsOf(await withTable("jobs", t => db.from(t)
          .select("job").eq("user_id", userId)
          .order("created_at", { ascending: false })
          .range(start, start + pageSize - 1)));
        for (const row of page) {
          const job = decodeJob(row.job);
          if (job) fetched.push(job);
        }
        if (page.length < pageSize) break;
      }
      return paginateJobs(fetched, query);
    },

    async saveConnection(connection) {
      const patch = {
        mode: connection.mode,
        label: connection.label,
        credential: connection.credential ? JSON.stringify(connection.credential) : null,
        created_at: connection.createdAt,
      };
      const updated = rowsOf(await withTable("connections", t => db.from(t).update(patch)
        .eq("user_id", connection.userId).eq("provider", connection.provider).select("provider")));
      if (updated.length === 1) return;
      try {
        const inserted = rowsOf(await withTable("connections", t => db.from(t).insertIfAbsent({
          user_id: connection.userId,
          provider: connection.provider,
          ...patch,
        }, { onConflict: "user_id,provider" }).select("provider")));
        if (inserted.length === 1) return;
      } catch (error) {
        // 冲突时走一次更新；仍失败再把数据库错误暴露出去。
        console.error("connection insert conflict", error);
      }
      const reconciled = rowsOf(await withTable("connections", t => db.from(t).update(patch)
        .eq("user_id", connection.userId).eq("provider", connection.provider).select("provider")));
      if (reconciled.length === 1) return;
      throw new ProviderApiError(503, "database_unavailable", "连接状态保存失败，请稍后重试");
    },

    async loadConnection(userId, provider) {
      const found = rowsOf(await withTable("connections", t => db.from(t)
        .select("mode,label,credential,created_at")
        .eq("user_id", userId).eq("provider", provider).limit(1)));
      if (found.length === 0) return null;
      const row = found[0];
      return {
        userId,
        provider,
        mode: String(row.mode ?? ""),
        label: String(row.label ?? ""),
        credential: credentialOf(row.credential),
        createdAt: Number(row.created_at) || 0,
      };
    },

    async dropConnection(userId, provider) {
      await withTable("connections", t => db.from(t).delete()
        .eq("user_id", userId).eq("provider", provider).select("provider"));
    },

    async loadDemoState(userId) {
      const found = rowsOf(await withTable("demo_state", t => db.from(t)
        .select("state").eq("user_id", userId).limit(1)));
      if (found.length === 0) return null;
      return demoStateOf(found[0].state);
    },

    async saveDemoState(userId, state) {
      const patch = { state: JSON.stringify(state), updated_at: nowIso() };
      const updated = rowsOf(await withTable("demo_state", t => db.from(t).update(patch)
        .eq("user_id", userId).select("user_id")));
      if (updated.length === 1) return;
      try {
        const inserted = rowsOf(await withTable("demo_state", t => db.from(t).insertIfAbsent({
          user_id: userId,
          ...patch,
        }, { onConflict: "user_id" }).select("user_id")));
        if (inserted.length === 1) return;
      } catch (error) {
        console.error("demo state insert conflict", error);
      }
      const reconciled = rowsOf(await withTable("demo_state", t => db.from(t).update(patch)
        .eq("user_id", userId).select("user_id")));
      if (reconciled.length === 1) return;
      throw new ProviderApiError(503, "database_unavailable", "演示音乐库保存失败，请稍后重试");
    },
  };
}