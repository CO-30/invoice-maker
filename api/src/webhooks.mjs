// Webhook：差分の検出と配信。署名は X-Signature: sha256=<本文の HMAC-SHA256>
import { ApiError, hmacSha256 } from "./util.mjs";

export function checkWebhookUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new ApiError(422, "validation_error", "url が不正です"); }
  const h = u.hostname.toLowerCase().replace(/\.$/, "");
  // IPアドレス直書き・社内向けの名前は受け付けない
  const bad = u.protocol !== "https:" || u.username || u.password || !h.includes(".") || h.startsWith("[") ||
    /^[0-9.]+$/.test(h) || /(^|\.)(localhost|local|internal|home\.arpa)$/.test(h);
  if (bad || String(raw).length > 500) throw new ApiError(422, "validation_error", "url は公開されている https のホスト名で指定してください");
  return u.toString();
}

// 1件ずつ確保して送る（確保の期限 LEASE を超えないように）
export async function deliver(store, fetcher, max = 20) {
  for (let i = 0; i < max; i++) {
    const [d] = await store.claimDue(1);
    if (!d) return;
    const body = JSON.stringify(d.event);
    let status = 0;
    try {
      const res = await fetcher(d.url, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(10000), body,
        headers: { "Content-Type": "application/json", "User-Agent": "REDSEAL-Webhook/1.0", "X-Webhook-Id": d.event.id,
          "X-Webhook-Event": d.event.type, "X-Signature": "sha256=" + (await hmacSha256(d.secret, body)) } });
      status = res.status;
    } catch { status = 0; }
    await store.finishDelivery(d.key, status);
  }
}

export async function syncAndDeliver({ store, gas, fetcher, now = () => Date.now(), max = 20 }) {
  if (!(await store.hasHooks())) return;
  try {
    const at = now();
    const snap = await gas("snapshot");
    await store.applySnapshot(snap.documents, at);
  } catch (e) { console.error("webhook sync failed", e.code || e.message); }
  await deliver(store, fetcher, max);
}
