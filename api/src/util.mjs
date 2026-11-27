// 共通の小道具（Workers と Node の両方で動く。依存なし）
export class ApiError extends Error {
  constructor(status, code, message, headers = {}) { super(message); this.status = status; this.code = code; this.headers = headers; }
}
const enc = new TextEncoder();
export const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
export const sha256 = async s => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
export async function hmacSha256(secret, body) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
}
export function randomToken(prefix, bytes = 32) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return prefix + btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export const iso = ms => (ms ? new Date(ms).toISOString() : null);
export function isPlainObject(v) { return !!v && typeof v === "object" && !Array.isArray(v); }
