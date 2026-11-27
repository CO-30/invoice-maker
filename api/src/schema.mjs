// REST の入力（snake_case）を検査して、GAS の項目名に直す。値の細かい検査は GAS 側
import { ApiError, isPlainObject } from "./util.mjs";

const DOC = { client: "client", honorific: "honor", contact: "contact", subject: "subject", date: "date", due_date: "due",
  valid_text: "validText", note: "note", memo: "memo", items: "items", tax_rate: "taxRate", tax_included: "taxIn",
  rounding: "rounding", layout: "layout" };
const ITEM = { description: "desc", quantity: "qty", unit: "unit", unit_price: "price", date: "date" };

export const BODY = {
  create: { type: "type", ...DOC }, update: DOC, revise: DOC,
  convert: { to: "to", date: "date" }, status: { paid: "paid", paid_at: "paidAt", lost: "lost" },
};
const bad = m => { throw new ApiError(422, "validation_error", m); };

function rename(obj, map, where) {
  if (!isPlainObject(obj)) bad(where + " はJSONのオブジェクトで指定してください");
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!Object.hasOwn(map, k)) bad("使えない項目です: " + k.slice(0, 40));
    out[map[k]] = v;
  }
  return out;
}
export function toArgs(kind, body) {
  const a = rename(body, BODY[kind], "本文");
  if (a.items !== undefined) {
    if (!Array.isArray(a.items)) bad("items は配列で指定してください");
    a.items = a.items.map(x => rename(x, ITEM, "items の各行"));
  }
  if ((kind === "update" || kind === "status") && !Object.keys(a).length) bad("変更する項目がありません");
  return a;
}

// アプリで作った書類は数量・単価が文字列のことがある
const num = v => { if (v === "" || v === null || v === undefined) return null; const n = Number(String(v).replace(/[,，¥円\s]/g, "")); return Number.isFinite(n) ? n : null; };

export function toDoc(d) {
  const out = { id: d.id, type: d.type, number: d.no, case_number: d.base, date: d.date || null, due_date: d.due || null,
    client: d.client, honorific: d.honor, subject: d.subject, subtotal: d.sub, tax: d.tax, total: d.total,
    status: d.status || null, paid: d.type === "invoice" ? !!d.paid : null, paid_at: d.paidAt || null,
    ai_draft: !!d.aiDraft, pdf_url: d.pdfUrl || null, deleted: !!d.deleted,
    created_at: new Date(d.createdAt || 0).toISOString(), updated_at: new Date(d.updatedAt || 0).toISOString() };
  if (d.items) Object.assign(out, { contact: d.contact || "", valid_text: d.validText || "", note: d.note || "", memo: d.memo || "",
    tax_rate: String(d.taxRate || ""), tax_included: !!d.taxIn, rounding: d.rounding || "floor", layout: d.layout || null,
    revision: d.rev, source_id: d.fromId || null,
    items: d.items.map(x => ({ description: x.desc || "", quantity: num(x.qty), unit: x.unit || "",
      unit_price: num(x.price), date: x.date || "" })) });
  if (d.related) out.related = d.related.map(toDoc);
  return out;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
export const LIST_PARAMS = ["type", "q", "status", "from", "to", "updated_since", "include_deleted", "limit", "offset"];
export function listArgs(params) {
  for (const k of params.keys()) if (!LIST_PARAMS.includes(k)) bad("使えない検索条件です: " + k.slice(0, 40));
  const int = (k, def, min, max) => {
    const v = params.get(k); if (v === null) return def;
    if (!/^\d{1,7}$/.test(v) || +v < min || +v > max) bad(`${k} は ${min}〜${max} の整数です`);
    return +v;
  };
  const a = { limit: int("limit", 30, 1, 200), offset: int("offset", 0, 0, 1000000) };
  const oneOf = (k, list) => { const v = params.get(k); if (v === null) return; if (!list.includes(v)) bad(k + " が不正です"); a[k] = v; };
  oneOf("type", ["estimate", "invoice", "receipt"]);
  oneOf("status", ["unpaid", "overdue", "paid", "open", "won", "lost", "old", "ai_draft"]);
  for (const k of ["from", "to"]) { const v = params.get(k); if (v !== null) { if (!DAY.test(v)) bad(k + " は YYYY-MM-DD です"); a[k] = v; } }
  if (params.has("q")) a.query = params.get("q").slice(0, 100);
  const since = params.get("updated_since");
  if (since !== null) {
    if (!DATETIME.test(since) || Number.isNaN(Date.parse(since))) bad("updated_since は ISO 8601（例 2026-11-01T00:00:00Z。+09:00 は %2B09:00）で指定してください");
    a.updatedSince = Date.parse(since);
  }
  const inc = params.get("include_deleted");
  if (inc !== null && inc !== "true" && inc !== "false") bad("include_deleted は true/false です");
  a.includeDeleted = inc === null ? since !== null : inc === "true";
  return a;
}
