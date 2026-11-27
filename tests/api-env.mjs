// 外部連携APIの試験環境：Worker の処理 ＋ 模擬ストレージ ＋ 模擬GAS（gas-harness）
import fs from "node:fs";
import {loadGas} from "./gas-harness.mjs";
import {Store} from "../api/src/store.mjs";
import {handle} from "../api/src/app.mjs";

export const spec = JSON.parse(fs.readFileSync(new URL("../api/openapi.json", import.meta.url), "utf8"));
export function memStorage(){
  const m = new Map(); const c = v => v === undefined ? undefined : structuredClone(v);
  return {map:m,
    async get(k){ return c(m.get(k)); }, async put(k,v){ m.set(k,c(v)); }, async delete(k){ return m.delete(k); },
    async list({prefix="", limit=Infinity}={}){ return new Map([...m.keys()].filter(k=>k.startsWith(prefix)).sort().slice(0,limit).map(k=>[k,c(m.get(k))])); }};
}
export const ADMIN = "admin-token-for-tests-0123456789abcdef";
export function makeEnv(opts={}){
  const clock = {t: Date.parse("2026-11-27T01:00:00Z")};
  const g = loadGas({now: clock.t, props:{API_BRIDGE_KEY:"bridge-key"}, lockBusy:opts.lockBusy});
  const storage = memStorage(), store = new Store(storage, () => clock.t);
  const hooks = [], gasCalls = [], pending = [];
  const t = {g, clock, storage, store, hooks, gasCalls, hookStatus:200, gasFail:null};
  const env = Object.assign({GAS_URL:"https://script.google.com/macros/s/TEST/exec", GAS_BRIDGE_KEY:"bridge-key", ADMIN_TOKEN:ADMIN,
    ALLOWED_ORIGINS:"https://co-30.github.io", RATE_LIMIT_PER_MIN:"1000"}, opts.env);
  const fetcher = async (url, init) => {
    if(url === env.GAS_URL){
      gasCalls.push({url, body:JSON.parse(init.body)});
      if(t.gate) await t.gate();
      if(t.gasFail === "before") throw new Error("network");
      g.clock.t = clock.t;
      const out = g.api.doPost({postData:{contents:init.body}, parameter:{}});
      if(t.gasFail === "after") return new Response("<html>error</html>");
      return new Response(out.content);
    }
    hooks.push({url, init});
    return new Response("", {status:t.hookStatus});
  };
  t.env = env; t.fetcher = fetcher;
  let seq = 0;
  t.req = async (method, path, {key, headers={}, body, base="https://api.example.com", noIdem}={}) => {
    const h = {...headers}; if(key) h.Authorization = "Bearer " + key;
    if(!noIdem && method !== "GET" && path.startsWith("/api/v1/documents") && !h["Idempotency-Key"]) h["Idempotency-Key"] = "auto-" + (++seq);
    const res = await handle(new Request(base + path, {method, headers:h, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body)}),
      {env, store, fetcher, spec, now:()=>clock.t, waitUntil:p=>pending.push(p)});
    while(pending.length) await pending.shift();
    const text = await res.text();
    return {status:res.status, headers:res.headers, body: text ? JSON.parse(text) : null};
  };
  t.issue = async scope => (await t.req("POST","/api/v1/keys",{key:ADMIN, body:{name:scope, scope}})).body.data;
  return t;
}
