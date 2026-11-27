// GAS（gas/Api.gs）を呼ぶ。キーは本文で送る。書き込みの結果が分からない失敗は unknown=true
import { ApiError } from "./util.mjs";

const MAP = { not_found: 404, validation_error: 422, not_editable: 409, forbidden_for_scope: 403, conflict: 409, busy: 503 };

export function makeGas(env, fetcher) {
  return async function gas(op, args = {}) {
    if (!env.GAS_URL || !env.GAS_BRIDGE_KEY) throw new ApiError(503, "not_configured", "GAS_URL と GAS_BRIDGE_KEY が未設定です");
    let res, body;
    try {
      res = await fetcher(env.GAS_URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action: "api", aiKey: env.GAS_BRIDGE_KEY, op, args }), redirect: "follow",
        signal: AbortSignal.timeout(Number(env.GAS_TIMEOUT_MS) || 45000) });
      body = JSON.parse(await res.text());
    } catch (e) {
      const timeout = e && (e.name === "TimeoutError" || e.name === "AbortError");
      const err = new ApiError(timeout ? 504 : 502, timeout ? "upstream_timeout" : "upstream_error", "データ側（GAS）から正しい応答がありません");
      err.unknown = true;
      throw err;
    }
    if (body && body.ok === true && "result" in body) return body.result;
    const code = body && body.code;
    if (code === "unauthorized") throw new ApiError(502, "upstream_unauthorized", "GAS の接続キーが一致しません（GAS_BRIDGE_KEY を確認）");
    if (MAP[code]) {
      const err = new ApiError(MAP[code], code, String(body.message || code), code === "busy" ? { "Retry-After": "5" } : {});
      throw err;
    }
    console.error("GAS error", code, body && (body.message || body.error));
    const err = new ApiError(502, "upstream_error", "データ側（GAS）でエラーが起きました。GASが最新版か確認してください");
    err.unknown = true;
    throw err;
  };
}
