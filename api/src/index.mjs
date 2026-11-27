// Cloudflare Workers の入口。保存は Durable Object（SQLite・無料枠）1個
import { DurableObject } from "cloudflare:workers";
import spec from "../openapi.json";
import { Store } from "./store.mjs";
import { handle } from "./app.mjs";
import { makeGas } from "./gas.mjs";
import { syncAndDeliver } from "./webhooks.mjs";

export class RedsealStore extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.store = new Store(ctx.storage); }
  call(method, args) { return this.store[method](...args); }
}
function storeClient(env) {
  const stub = env.STORE.get(env.STORE.idFromName("main"));
  return new Proxy({}, { get: (_, m) => (...args) => stub.call(m, args) });
}
const fetcher = (url, init) => fetch(url, init);

export default {
  fetch(request, env, ctx) {
    return handle(request, { env, store: storeClient(env), fetcher, spec, waitUntil: p => ctx.waitUntil(p) });
  },
  async scheduled(_event, env, ctx) {
    const store = storeClient(env);
    ctx.waitUntil((async () => { await store.cleanup(); await syncAndDeliver({ store, gas: makeGas(env, fetcher), fetcher }); })());
  },
};
