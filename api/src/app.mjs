// HTTP の入口。Workers に依存しないので Node でそのままテストできる
import { ApiError, sha256, iso, isPlainObject } from "./util.mjs";
import { SCOPES, EVENTS } from "./store.mjs";
import { makeGas } from "./gas.mjs";
import { toArgs, toDoc, listArgs } from "./schema.mjs";
import { checkWebhookUrl, syncAndDeliver } from "./webhooks.mjs";
import { mcpMessage } from "./mcp.mjs";

export const API_VERSION = "1.16.0";
const MAX_BODY = 100_000;
const R = "documents:read", W = "documents:write";

// auth：null=不要、"admin"=管理トークン、それ以外=必要なスコープ
export const ROUTES = [
  ["GET", "/api/v1/health", null, "health"],
  ["GET", "/api/v1/me", R, "me"],
  ["GET", "/api/v1/documents", R, "list"],
  ["POST", "/api/v1/documents", W, "create"],
  ["GET", "/api/v1/documents/{id}", R, "get"],
  ["PATCH", "/api/v1/documents/{id}", W, "update"],
  ["DELETE", "/api/v1/documents/{id}", W, "delete"],
  ["POST", "/api/v1/documents/{id}/convert", W, "convert"],
  ["POST", "/api/v1/documents/{id}/revise", W, "revise"],
  ["POST", "/api/v1/documents/{id}/status", W, "status"],
  ["GET", "/api/v1/documents/{id}/message", R, "message"],
  ["GET", "/api/v1/reports/sales", R, "report"],
  ["GET", "/api/v1/issuer", R, "issuer"],
  ["GET", "/api/v1/keys", "admin", "keyList"],
  ["POST", "/api/v1/keys", "admin", "keyCreate"],
  ["POST", "/api/v1/keys/{id}/rotate", "admin", "keyRotate"],
  ["DELETE", "/api/v1/keys/{id}", "admin", "keyRevoke"],
  ["GET", "/api/v1/webhooks", "admin", "hookList"],
  ["POST", "/api/v1/webhooks", "admin", "hookCreate"],
  ["DELETE", "/api/v1/webhooks/{id}", "admin", "hookDelete"],
];
const compiled = ROUTES.map(([method, path, auth, name]) => ({ method, auth, name, re: new RegExp("^" + path.replace("{id}", "([A-Za-z0-9_=-]{1,80})") + "$") }));

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers } });
const errorRes = e => json(e.status, { error: { code: e.code, message: e.message } }, e.headers);

function credential(req) {
  const a = req.headers.get("Authorization");
  if (a) { const m = a.match(/^Bearer[ ]+(\S+)$/i); return m ? m[1] : ""; }
  return req.headers.get("X-API-Key") || "";
}
const unauthorized = msg => new ApiError(401, "unauthorized", msg, { "WWW-Authenticate": 'Bearer realm="redseal"' });

async function limit(store, bucket, max) {
  const r = await store.hit(bucket, max);
  const headers = { "X-RateLimit-Limit": String(r.limit), "X-RateLimit-Remaining": String(r.remaining), "X-RateLimit-Reset": String(r.reset) };
  if (!r.ok) throw new ApiError(429, "rate_limited", "回数の上限を超えました。少し待ってください", { ...headers, "Retry-After": String(r.reset) });
  return headers;
}

// 認証。OAuth 2.0 を足すときは、ここでアクセストークンを検証して同じ形（type・id・scopes）を返す
async function authenticate(req, route, ctx) {
  const { env, store, ip } = ctx;
  const cred = credential(req);
  const fail = async msg => { await limit(store, "authfail:" + ip, Number(env.AUTH_FAIL_LIMIT_PER_MIN) || 20); throw unauthorized(msg); };
  if (route.auth === "admin") {
    const t = env.ADMIN_TOKEN || "";
    if (t.length < 32) throw new ApiError(503, "admin_disabled", "ADMIN_TOKEN（ランダムな32文字以上）が未設定です");
    if (!cred || (await sha256(cred)) !== (await sha256(t))) await fail("管理トークンが違います");
    return { type: "admin", id: "admin", scopes: [] };
  }
  if (!cred) await fail("APIキーを Authorization: Bearer <キー> か X-API-Key で送ってください");
  const p = cred.startsWith("rsk_") && cred.length < 200 ? await store.verifyKey(cred) : null;
  if (!p) await fail("APIキーが違うか、無効になっています");
  return p;
}

async function readBody(req) {
  if (Number(req.headers.get("Content-Length") || 0) > MAX_BODY) throw new ApiError(413, "payload_too_large", "本文が大きすぎます");
  const chunks = []; let size = 0;
  if (req.body) for await (const c of req.body) {
    size += c.byteLength;
    if (size > MAX_BODY) throw new ApiError(413, "payload_too_large", "本文が大きすぎます");
    chunks.push(c);
  }
  const buf = new Uint8Array(size); let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.byteLength; }
  return new TextDecoder().decode(buf);
}
function parseJson(text) {
  try { return JSON.parse(text); } catch { throw new ApiError(400, "invalid_json", "本文が正しいJSONではありません"); }
}
const objectBody = text => { const b = text.trim() ? parseJson(text) : {}; if (!isPlainObject(b)) throw new ApiError(422, "validation_error", "本文はJSONのオブジェクトです"); return b; };

const doc = r => ({ data: toDoc(r.document) });
const must = (v, what) => { if (!v) throw new ApiError(404, "not_found", what + "が見つかりません"); return v; };

const HANDLERS = {
  me: async c => ({ data: { auth_type: c.principal.type, key_id: c.principal.id, name: c.principal.name, scopes: c.principal.scopes } }),
  list: async c => {
    const a = listArgs(c.url.searchParams), r = await c.gas("list", a);
    return { data: r.documents.map(toDoc), pagination: { limit: a.limit, offset: a.offset, total: r.total } };
  },
  get: async c => doc(await c.gas("get", { id: c.id })),
  create: async c => [201, doc(await c.gas("create", toArgs("create", objectBody(c.text))))],
  update: async c => doc(await c.gas("update", { ...toArgs("update", objectBody(c.text)), id: c.id })),
  convert: async c => [201, doc(await c.gas("convert", { ...toArgs("convert", objectBody(c.text)), id: c.id }))],
  revise: async c => [201, doc(await c.gas("revise", { ...toArgs("revise", objectBody(c.text)), id: c.id }))],
  status: async c => doc(await c.gas("status", { ...toArgs("status", objectBody(c.text)), id: c.id })),
  delete: async c => { const r = await c.gas("delete", { id: c.id }); return { data: { id: r.id, deleted: true, updated_at: iso(r.updatedAt) } }; },
  message: async c => {
    const q = c.url.searchParams;
    return { data: await c.gas("message", { id: c.id, channel: q.get("channel") || "line", reminder: q.get("reminder") === "true" }) };
  },
  report: async c => {
    const q = c.url.searchParams, a = {};
    if (q.has("year")) a.year = Number(q.get("year"));
    if (q.has("basis")) { if (!["total", "sub"].includes(q.get("basis"))) throw new ApiError(422, "validation_error", "basis は total か sub です"); a.basis = q.get("basis"); }
    return { data: await c.gas("report", a) };
  },
  issuer: async c => ({ data: await c.gas("issuer") }),

  keyList: async c => ({ data: await c.store.listKeys() }),
  keyCreate: async c => {
    const b = objectBody(c.text), name = typeof b.name === "string" ? b.name.trim() : "";
    if (!name || name.length > 60) throw new ApiError(422, "validation_error", "name は1〜60文字です");
    if (!Object.hasOwn(SCOPES, b.scope)) throw new ApiError(422, "validation_error", "scope は read か write です");
    const k = await c.store.createKey(name, b.scope);
    if (k.error) throw new ApiError(409, "limit_reached", "有効なキーが上限（20）です。使っていないキーを無効化してください");
    return [201, { data: k }];
  },
  keyRotate: async c => ({ data: must(await c.store.rotateKey(c.id), "有効なキー") }),
  keyRevoke: async c => ({ data: must(await c.store.revokeKey(c.id), "キー") }),
  hookList: async c => ({ data: await c.store.listHooks() }),
  hookCreate: async c => {
    const b = objectBody(c.text), url = checkWebhookUrl(b.url), events = b.events === undefined ? EVENTS : b.events;
    if (!Array.isArray(events) || !events.length || events.some(e => !EVENTS.includes(e))) throw new ApiError(422, "validation_error", "events は " + EVENTS.join(" / ") + " の配列です");
    const first = !(await c.store.hasHooks());
    const h = await c.store.createHook(url, [...new Set(events)]);
    if (h.error) throw new ApiError(409, "limit_reached", "Webhook は5件までです");
    if (first) { // 今ある書類を控える（この分は通知しない）。控えられなければ登録しない
      try { const at = c.now(); const snap = await c.gas("snapshot"); await c.store.applySnapshot(snap.documents, at); }
      catch (e) { await c.store.deleteHook(h.id); throw e; }
    }
    return [201, { data: h }];
  },
  hookDelete: async c => { must(await c.store.deleteHook(c.id), "Webhook "); return { data: { id: c.id, deleted: true } }; },
};

// Idempotency-Key：同じキーの再送には前の応答を返す
async function withIdempotency(req, ctx, run) {
  const key = req.headers.get("Idempotency-Key");
  if (key === null) return run();
  if (!/^[\x21-\x7e]{1,200}$/.test(key)) throw new ApiError(422, "validation_error", "Idempotency-Key は1〜200文字の半角英数記号です");
  const k = ctx.principal.id + ":" + key;
  const fp = await sha256(req.method + " " + ctx.url.pathname + "\n" + ctx.text);
  const b = await ctx.store.idemBegin(k, fp);
  if (b.state === "mismatch") throw new ApiError(422, "idempotency_key_reuse", "この Idempotency-Key は別の内容で使われています");
  if (b.state === "pending") throw new ApiError(409, "idempotency_in_progress", "同じ要求を処理中です", { "Retry-After": "5" });
  if (b.state === "unknown") throw new ApiError(409, "idempotency_unknown", "前の要求の結果が分かりません。一覧で書類を確認してから、必要なら新しいキーで送ってください");
  if (b.state === "done") return json(b.response.status, b.response.body, { "Idempotency-Replayed": "true" });
  let res;
  try { res = await run(); }
  catch (e) {
    if (!(e instanceof ApiError) || e.unknown) await ctx.store.idemEnd(k, "unknown");
    else if (e.status >= 500 || e.code === "conflict") await ctx.store.idemEnd(k, "release"); // 保存されていない
    else await ctx.store.idemEnd(k, "done", { status: e.status, body: { error: { code: e.code, message: e.message } } });
    throw e;
  }
  await ctx.store.idemEnd(k, "done", { status: res.status, body: await res.clone().json() });
  return res;
}

function corsHeaders(origin, env) {
  const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return null;
  return { "Access-Control-Allow-Origin": origin, "Vary": "Origin", "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, X-API-Key, Content-Type, Idempotency-Key, MCP-Protocol-Version",
    "Access-Control-Expose-Headers": "Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Idempotency-Replayed" };
}

export async function handle(req, deps) {
  const { env, store, fetcher, spec, waitUntil = () => {}, now = () => Date.now() } = deps;
  const url = new URL(req.url);
  const origin = req.headers.get("Origin");
  const cors = corsHeaders(origin, env);
  let extra = {};
  const finish = res => { const h = new Headers(res.headers); for (const [k, v] of Object.entries({ ...extra, ...(cors || {}) })) if (!h.has(k)) h.set(k, v); return new Response(res.body, { status: res.status, headers: h }); };
  try {
    const local = ["localhost", "127.0.0.1"].includes(url.hostname);
    if (url.protocol !== "https:" && !local) throw new ApiError(403, "https_required", "https で接続してください。http で送ったキーは無効化して作り直してください");
    for (const k of url.searchParams.keys()) if (/^(api_?key|key|token|access_token|authorization|ai)$/i.test(k))
      throw new ApiError(400, "key_in_url", "キーをURLに載せないでください。載せたキーは無効化して作り直してください");
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors || {} });
    const ip = req.headers.get("CF-Connecting-IP") || "local";
    const gas = makeGas(env, fetcher);
    const sync = () => syncAndDeliver({ store, gas, fetcher, now, max: 2 }); // 応答後の時間は短いので少数。残りは Cron
    const base = { env, store, gas, url, ip, sync, now };
    const perMin = Number(env.RATE_LIMIT_PER_MIN) || 60;

    if (url.pathname === "/openapi.json") {
      if (req.method !== "GET") throw new ApiError(405, "method_not_allowed", "GET を使ってください", { Allow: "GET" });
      extra = await limit(store, "pub:" + ip, perMin);
      return finish(json(200, { ...spec, servers: [{ url: url.origin }] }, { "Access-Control-Allow-Origin": "*" }));
    }

    if (url.pathname === "/mcp") {
      if (origin && origin !== url.origin && !cors) throw new ApiError(403, "forbidden_origin", "この Origin からは使えません");
      const principal = await authenticate(req, { auth: R }, base);
      if (req.method !== "POST") throw new ApiError(405, "method_not_allowed", "POST を使ってください", { Allow: "POST" });
      const text = await readBody(req);
      let body;
      try { body = JSON.parse(text); } catch { return finish(json(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })); }
      const batch = Array.isArray(body), msgs = batch ? body : [body];
      if (!msgs.length || msgs.length > 10) return finish(json(400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "一括は1〜10件です" } }));
      for (let i = 0; i < msgs.length; i++) extra = await limit(store, "key:" + principal.id, perMin);
      let cache, wrote = false;
      const out = [];
      for (const m of msgs) {
        const r = await mcpMessage(m, { gas, principal, meta: () => (cache ||= gas("tools")), onWrite: () => (wrote = true) });
        if (r) out.push(r);
      }
      if (wrote) waitUntil(sync());
      if (!out.length) return finish(new Response(null, { status: 202 }));
      return finish(json(200, batch ? out : out[0]));
    }

    const matches = compiled.filter(r => r.re.test(url.pathname));
    if (!matches.length) throw new ApiError(404, "not_found", "そのURLはありません");
    const route = matches.find(r => r.method === req.method);
    if (!route) throw new ApiError(405, "method_not_allowed", "そのメソッドは使えません", { Allow: matches.map(r => r.method).join(", ") });
    const id = url.pathname.match(route.re)[1];

    if (route.name === "health") {
      extra = await limit(store, "pub:" + ip, perMin);
      return finish(json(200, { data: { status: "ok", version: API_VERSION, time: iso(now()), data_source_configured: !!(env.GAS_URL && env.GAS_BRIDGE_KEY) } }));
    }
    const principal = await authenticate(req, route, base);
    extra = await limit(store, "key:" + principal.id, perMin);
    if (route.auth !== "admin" && !principal.scopes.includes(route.auth)) throw new ApiError(403, "insufficient_scope", "このキーは読み取り専用です（" + route.auth + " が必要）");

    const text = ["POST", "PATCH"].includes(req.method) ? await readBody(req) : "";
    const ctx = { ...base, id, principal, text };
    const run = async () => {
      const r = await HANDLERS[route.name](ctx);
      return Array.isArray(r) ? json(r[0], r[1]) : json(200, r);
    };
    const isDocWrite = route.auth === W;
    const res = isDocWrite ? await withIdempotency(req, ctx, run) : await run();
    if (isDocWrite && res.ok && !res.headers.has("Idempotency-Replayed")) waitUntil(sync());
    return finish(res);
  } catch (e) {
    if (e instanceof ApiError) return finish(errorRes(e));
    console.error(e && e.stack || e);
    return finish(errorRes(new ApiError(500, "internal_error", "サーバー内部でエラーが起きました")));
  }
}
