import { createApp } from "./app.ts";
import { memoryStore } from "./store.ts";

/**
 * 部署入口：站点运行时只认这一个 index.ts。
 * 第 4 阶段把 memoryStore 换成平台库适配器即可，业务代码（app.ts）不动。
 */
/** Deno 的全局声明，便于没有 deno 的环境也能对本入口做类型检查。 */
declare const Deno: {
  serve(options: { port: number }, handler: (request: Request) => Response | Promise<Response>): unknown;
  env: { get(key: string): string | undefined };
};

const app = createApp({ store: memoryStore() });

Deno.serve({ port: Number(Deno.env.get("PORT") ?? 8000) }, app.handler);
