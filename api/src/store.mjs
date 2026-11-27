// 永続データ（APIキー・Idempotency-Key・Webhook・差分の控え）と回数制限。
// storage は Durable Object の ctx.storage（get / put / delete / list）。
import { sha256, randomToken, iso } from "./util.mjs";

export const SCOPES = { read: ["documents:read"], write: ["documents:read", "documents:write"] };
export const EVENTS = ["document.created", "document.updated", "document.deleted"];
const MAX_KEYS = 20, MAX_HOOKS = 5, MAX_ATTEMPTS = 6, IDEM_TTL = 24 * 3600e3, LEASE = 120e3, PENDING_TTL = 3 * 60e3;

const publicKey = k => ({ id: k.id, name: k.name, scope: k.scope, prefix: k.prefix, created_at: iso(k.createdAt),
  updated_at: iso(k.updatedAt), last_used_at: iso(k.lastUsedAt), revoked_at: iso(k.revokedAt) });
const publicHook = h => ({ id: h.id, url: h.url, events: h.events, created_at: iso(h.createdAt), updated_at: iso(h.updatedAt),
  last_status: h.lastStatus ?? null, last_delivery_at: iso(h.lastDeliveryAt) });

export class Store {
  constructor(storage, now = () => Date.now()) { this.s = storage; this.now = now; this.buckets = new Map(); this.tail = Promise.resolve(); }
  // 読んでから書く処理を直列にする
  lock(fn) { const r = this.tail.then(fn, fn); this.tail = r.catch(() => {}); return r; }
  async values(prefix) { return [...(await this.s.list({ prefix })).values()]; }

  /* ---- 回数制限（1分の固定枠・メモリ内） ---- */
  async hit(bucket, limit, windowMs = 60e3) {
    const t = this.now(), start = t - (t % windowMs);
    if (this.buckets.size > 5000) for (const [k, v] of this.buckets) if (v.start !== start) this.buckets.delete(k);
    let b = this.buckets.get(bucket);
    if (!b || b.start !== start) { b = { start, n: 0 }; this.buckets.set(bucket, b); }
    b.n++;
    return { ok: b.n <= limit, limit, remaining: Math.max(0, limit - b.n), reset: Math.ceil((start + windowMs - t) / 1000) };
  }

  /* ---- APIキー ---- */
  async listKeys() { return (await this.values("key:")).sort((a, b) => a.createdAt - b.createdAt).map(publicKey); }
  async newSecret(rec) {
    const secret = randomToken("rsk_");
    rec.hash = await sha256(secret); rec.prefix = secret.slice(0, 9); rec.updatedAt = this.now();
    return secret;
  }
  createKey(name, scope) {
    return this.lock(async () => {
      const active = (await this.values("key:")).filter(k => !k.revokedAt);
      if (active.length >= MAX_KEYS) return { error: "limit" };
      const rec = { id: randomToken("key_", 9), name, scope, createdAt: this.now(), lastUsedAt: 0, revokedAt: 0 };
      const secret = await this.newSecret(rec);
      await this.s.put("key:" + rec.id, rec);
      await this.s.put("hash:" + rec.hash, rec.id);
      return { ...publicKey(rec), key: secret };
    });
  }
  rotateKey(id) {
    return this.lock(async () => {
      const rec = await this.s.get("key:" + id);
      if (!rec || rec.revokedAt) return null;
      await this.s.delete("hash:" + rec.hash);
      const secret = await this.newSecret(rec);
      await this.s.put("key:" + id, rec);
      await this.s.put("hash:" + rec.hash, id);
      return { ...publicKey(rec), key: secret };
    });
  }
  revokeKey(id) {
    return this.lock(async () => {
      const rec = await this.s.get("key:" + id);
      if (!rec) return null;
      if (!rec.revokedAt) { await this.s.delete("hash:" + rec.hash); rec.revokedAt = rec.updatedAt = this.now(); await this.s.put("key:" + id, rec); }
      return publicKey(rec);
    });
  }
  verifyKey(secret) {
    return this.lock(async () => {
      const hash = await sha256(secret);
      const id = await this.s.get("hash:" + hash);
      const rec = id && (await this.s.get("key:" + id));
      if (!rec || rec.revokedAt || rec.hash !== hash) return null;
      const t = this.now();
      if (t - rec.lastUsedAt > 3600e3) { rec.lastUsedAt = t; await this.s.put("key:" + id, rec); } // 書き込みは1時間に1回まで
      return { type: "api_key", id: rec.id, name: rec.name, scopes: SCOPES[rec.scope] };
    });
  }

  /* ---- Idempotency-Key ---- */
  idemBegin(k, fingerprint) {
    return this.lock(async () => {
      const r = await this.s.get("idem:" + k);
      if (r && this.now() - r.at < IDEM_TTL) {
        if (r.fingerprint !== fingerprint) return { state: "mismatch" };
        // 中断して pending のまま残ったものは、結果不明にする
        return { state: r.state === "pending" && this.now() - r.at > PENDING_TTL ? "unknown" : r.state, response: r.response };
      }
      await this.s.put("idem:" + k, { fingerprint, state: "pending", at: this.now() });
      return { state: "new" };
    });
  }
  idemEnd(k, outcome, response) {
    return this.lock(async () => {
      const r = await this.s.get("idem:" + k);
      if (!r) return;
      if (outcome === "release") await this.s.delete("idem:" + k);
      else await this.s.put("idem:" + k, { ...r, state: outcome, response: response || null });
    });
  }

  /* ---- Webhook ---- */
  async listHooks() { return (await this.values("hook:")).sort((a, b) => a.createdAt - b.createdAt).map(publicHook); }
  async hasHooks() { return (await this.s.list({ prefix: "hook:", limit: 1 })).size > 0; }
  createHook(url, events) {
    return this.lock(async () => {
      if ((await this.values("hook:")).length >= MAX_HOOKS) return { error: "limit" };
      const t = this.now();
      const h = { id: randomToken("wh_", 9), url, events, secret: randomToken("whsec_"), createdAt: t, updatedAt: t };
      await this.s.put("hook:" + h.id, h);
      return { ...publicHook(h), secret: h.secret };
    });
  }
  deleteHook(id) {
    return this.lock(async () => {
      if (!(await this.s.get("hook:" + id))) return false;
      await this.s.delete("hook:" + id);
      for (const [k, v] of await this.s.list({ prefix: "out:" })) if (v.hookId === id) await this.s.delete(k);
      if (!(await this.s.list({ prefix: "hook:", limit: 1 })).size) { // 全部なくなったら控えも捨てる
        for (const k of (await this.s.list({ prefix: "snap:" })).keys()) await this.s.delete(k);
        await this.s.delete("snapMeta");
      }
      return true;
    });
  }
  // 全書類の控えと比べて、変化をイベントにして送信待ちに積む。fetchedAt が古い結果は捨てる
  applySnapshot(docs, fetchedAt) {
    return this.lock(async () => {
      const hooks = await this.values("hook:");
      if (!hooks.length) return 0;
      const meta = await this.s.get("snapMeta");
      if (meta && fetchedAt <= meta.fetchedAt) return 0;
      const prev = await this.s.list({ prefix: "snap:" });
      let count = 0;
      for (const d of docs) {
        const p = prev.get("snap:" + d.id);
        let type = null;
        if (!p) type = d.deleted ? null : "document.created";
        else if (d.deleted && !p.deleted) type = "document.deleted";
        else if (!d.deleted && (p.updatedAt !== d.updatedAt || p.deleted)) type = "document.updated";
        if (meta && type) {
          const event = { id: randomToken("evt_", 12), type, occurred_at: iso(this.now()),
            data: { id: d.id, type: d.type, number: d.no, updated_at: iso(d.updatedAt), deleted: !!d.deleted } };
          for (const h of hooks) if (h.events.includes(type)) {
            await this.s.put("out:" + event.id + ":" + h.id, { hookId: h.id, event, attempts: 0, nextAt: this.now() });
            count++;
          }
        }
        if (!p || p.updatedAt !== d.updatedAt || p.deleted !== d.deleted) await this.s.put("snap:" + d.id, { updatedAt: d.updatedAt, deleted: d.deleted });
      }
      await this.s.put("snapMeta", { fetchedAt });
      return count;
    });
  }
  claimDue(max) {
    return this.lock(async () => {
      const t = this.now(), out = [];
      const all = [...(await this.s.list({ prefix: "out:" }))].filter(([, v]) => v.nextAt <= t)
        .sort((a, b) => a[1].nextAt - b[1].nextAt).slice(0, max);
      for (const [k, v] of all) {
        const h = await this.s.get("hook:" + v.hookId);
        if (!h) { await this.s.delete(k); continue; }
        await this.s.put(k, { ...v, nextAt: t + LEASE });
        out.push({ key: k, url: h.url, secret: h.secret, event: v.event });
      }
      return out;
    });
  }
  finishDelivery(key, status) {
    return this.lock(async () => {
      const v = await this.s.get(key);
      if (!v) return;
      const h = await this.s.get("hook:" + v.hookId);
      if (h) await this.s.put("hook:" + h.id, { ...h, lastStatus: status, lastDeliveryAt: this.now() });
      const attempts = v.attempts + 1;
      if ((status >= 200 && status < 300) || attempts >= MAX_ATTEMPTS) await this.s.delete(key);
      else await this.s.put(key, { ...v, attempts, nextAt: this.now() + 5 * 60e3 * 2 ** (attempts - 1) });
    });
  }
  cleanup() {
    return this.lock(async () => {
      for (const [k, v] of await this.s.list({ prefix: "idem:" })) if (this.now() - v.at >= IDEM_TTL) await this.s.delete(k);
    });
  }
}
