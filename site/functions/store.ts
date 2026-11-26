import type { Job } from "./job.ts";
import type { DemoStoreState } from "./demo.ts";

/**
 * 运行时依赖的注入接缝。边缘函数不能依赖进程内单例，所以任务与连接状态都由上层给出：
 * 本地验证用内存适配器，线上用平台库适配器，业务代码两边一模一样。
 */

export type Connection = {
  userId: string;
  provider: string;
  mode: string;
  label: string;
  /** 加密后的平台凭据；明文从不离开函数进程。 */
  credential: { blob: string; expiresAt: number } | null;
  createdAt: number;
};

export type JobFilters = {
  source?: string | null;
  target?: string | null;
  status?: string | null;
  /** YYYY-MM-DD，按北京时间整天解释。 */
  from?: string | null;
  to?: string | null;
};

export type JobListQuery = JobFilters & {
  offset?: number;
  limit: number;
};

export type JobPage = { items: Job[]; hasMore: boolean };

export type Store = {
  saveJob(job: Job): Promise<void>;
  loadJob(userId: string, jobId: string): Promise<Job | null>;
  findRunningJob(userId: string): Promise<Job | null>;
  listJobs(userId: string, query: JobListQuery): Promise<JobPage>;
  saveConnection(connection: Connection): Promise<void>;
  loadConnection(userId: string, provider: string): Promise<Connection | null>;
  dropConnection(userId: string, provider: string): Promise<void>;
  /** 演示模式的可序列化状态（决策：按 user_id 绑定，不再用自证 sessionId）。 */
  loadDemoState(userId: string): Promise<DemoStoreState | null>;
  saveDemoState(userId: string, state: DemoStoreState): Promise<void>;
};

const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** 与 Java MigrationHistory.Filters 一致：日期按 UTC 整天，ISO 时间按其时区，上界始终不含。 */
export function historyBoundary(value: string, upper: boolean): number {
  if (DAY_ONLY.test(value)) {
    const start = Date.parse(value + "T00:00:00Z");
    return upper ? start + 24 * 3600 * 1000 : start;
  }
  return Date.parse(value);
}

export function jobMatchesFilters(job: Job, filters: JobFilters): boolean {
  const source = job.sourceLabel === null ? job.sourceProvider : "LOCAL_BACKUP";
  if (filters.source && source !== filters.source) return false;
  if (filters.target && job.targetProvider !== filters.target) return false;
  if (filters.status && job.status !== filters.status) return false;
  if (filters.from) {
    const from = historyBoundary(filters.from, false);
    if (Number.isFinite(from) && job.createdAt < from) return false;
  }
  if (filters.to) {
    const to = historyBoundary(filters.to, true);
    if (Number.isFinite(to) && job.createdAt >= to) return false;
  }
  return true;
}

export function emptyJobPage(): JobPage {
  return { items: [], hasMore: false };
}

export function paginateJobs(jobs: Job[], query: JobListQuery): JobPage {
  const offset = Math.max(0, Math.trunc(query.offset ?? 0));
  const limit = Math.max(1, Math.trunc(query.limit));
  const filtered = jobs.filter(job => jobMatchesFilters(job, query))
    .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  const items = filtered.slice(offset, offset + limit);
  return { items, hasMore: filtered.length > offset + limit };
}

export function memoryStore(): Store & { jobs: Map<string, Job>; connections: Map<string, Connection>; demo: Map<string, DemoStoreState> } {
  const jobs = new Map<string, Job>();
  const connections = new Map<string, Connection>();
  const demo = new Map<string, DemoStoreState>();
  const clone = <T,>(value: T): T => value === undefined || value === null ? value as T
    : JSON.parse(JSON.stringify(value)) as T;

  return {
    jobs, connections, demo,
    async saveJob(job) { jobs.set(job.userId + "/" + job.id, clone(job)); },
    async loadJob(userId, jobId) { return clone(jobs.get(userId + "/" + jobId) ?? null); },
    async findRunningJob(userId) {
      for (const job of jobs.values()) {
        if (job.userId === userId && (job.status === "QUEUED" || job.status === "RUNNING"
          || job.status === "AWAITING_CONFIRMATION")) return clone(job);
      }
      return null;
    },
    async listJobs(userId, query) {
      const own = [...jobs.values()].filter(job => job.userId === userId).map(job => clone(job));
      return paginateJobs(own, query);
    },
    async saveConnection(connection) { connections.set(connection.userId + "/" + connection.provider, clone(connection)); },
    async loadConnection(userId, provider) { return clone(connections.get(userId + "/" + provider) ?? null); },
    async dropConnection(userId, provider) { connections.delete(userId + "/" + provider); },
    async loadDemoState(userId) { return clone(demo.get(userId) ?? null); },
    async saveDemoState(userId, state) { demo.set(userId, clone(state)); },
  };
}