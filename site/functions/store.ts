import type { Job } from "./job.ts";
import type { DemoStoreState } from "./demo.ts";

/**
 * 运行时依赖的注入接缝。边缘函数不能依赖进程内单例，所以任务与连接状态都由上层给出：
 * 本地验证用内存适配器，第 4 阶段换成平台库适配器，业务代码两边一模一样。
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

export type Store = {
  saveJob(job: Job): Promise<void>;
  loadJob(userId: string, jobId: string): Promise<Job | null>;
  findRunningJob(userId: string): Promise<Job | null>;
  listJobs(userId: string, limit: number): Promise<Job[]>;
  saveConnection(connection: Connection): Promise<void>;
  loadConnection(userId: string, provider: string): Promise<Connection | null>;
  dropConnection(userId: string, provider: string): Promise<void>;
  /** 演示模式的可序列化状态（决策：按 user_id 绑定，不再用自证 sessionId）。 */
  loadDemoState(userId: string): Promise<DemoStoreState | null>;
  saveDemoState(userId: string, state: DemoStoreState): Promise<void>;
};

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
    async listJobs(userId, limit) {
      return [...jobs.values()].filter(job => job.userId === userId)
        .sort((a, b) => b.createdAt - a.createdAt).slice(0, limit).map(job => clone(job));
    },
    async saveConnection(connection) { connections.set(connection.userId + "/" + connection.provider, clone(connection)); },
    async loadConnection(userId, provider) { return clone(connections.get(userId + "/" + provider) ?? null); },
    async dropConnection(userId, provider) { connections.delete(userId + "/" + provider); },
    async loadDemoState(userId) { return clone(demo.get(userId) ?? null); },
    async saveDemoState(userId, state) { demo.set(userId, clone(state)); },
  };
}
