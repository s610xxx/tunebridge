import { createDatabaseClient } from "./_qoder/backend.mjs";
import { createApp } from "./app.ts";
import { dbStore } from "./store-db.ts";

/**
 * 站点运行时的唯一入口。`_qoder/backend.mjs` 由平台在发布时注入，绝不能提交到仓库；
 * 业务逻辑全部在 app.ts，本地验证用内存 Store，线上用平台数据库适配器。
 */
declare const Deno: {
  serve(handler: (request: Request) => Response | Promise<Response>): unknown;
};

const app = createApp({ store: dbStore(createDatabaseClient()) });

Deno.serve(app.handler);
