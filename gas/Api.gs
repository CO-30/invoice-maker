/**
 * REDSEAL 外部連携API の GAS 側窓口（api/ の Cloudflare Worker だけが呼びます）
 *
 * 呼び方：ウェブアプリのURL（…/exec）へ POST、本文 {"action":"api","aiKey":"キー","op":"…","args":{…}}
 * キーはURLに載せず本文で送ります。AI直結用の AI_KEY とは別の API_BRIDGE_KEY です。
 * 設置：エディタで setupApi を1回実行 → ログのキーを Worker の GAS_BRIDGE_KEY に登録
 * 作り直し：resetApiKey／停止：disableApi
 */
function setupApi(){
  const p = PropertiesService.getScriptProperties();
  let k = p.getProperty("API_BRIDGE_KEY");
  if(!k){ k = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ""); p.setProperty("API_BRIDGE_KEY", k); }
  Logger.log("Worker の GAS_BRIDGE_KEY（人に見せないでください）: " + k);
  return k;
}
function resetApiKey(){ PropertiesService.getScriptProperties().deleteProperty("API_BRIDGE_KEY"); return setupApi(); }
function disableApi(){ PropertiesService.getScriptProperties().deleteProperty("API_BRIDGE_KEY"); Logger.log("外部連携APIを止めました"); }

function apiHandle_(req){
  const k = PropertiesService.getScriptProperties().getProperty("API_BRIDGE_KEY");
  if(!k || typeof req.aiKey !== "string" || req.aiKey !== k) return out_({ok:false, code:"unauthorized", message:"GASの接続キーが違うか、停止しています"});
  const fn = Object.prototype.hasOwnProperty.call(API_OPS, req.op) ? API_OPS[req.op] : null;
  if(!fn) return out_({ok:false, code:"validation_error", message:"unknown op"});
  const lock = LockService.getScriptLock();
  if(!lock.tryLock(20000)) return out_({ok:false, code:"busy", message:"ほかの処理が混み合っています。少し待ってもう一度試してください"});
  try{
    return out_({ok:true, result:fn(req.args || {})});
  }catch(err){
    if(err instanceof AiError) return out_({ok:false, code:err.code, message:err.message});
    return out_({ok:false, code:"internal", message:String(err && err.message || err)});
  }finally{ lock.releaseLock(); }
}

// 書類1件の外部向けの形（時刻はミリ秒。ISO 8601 への変換は Worker）
function apiDoc_(d, docs, today){
  const o = aiSummary_(d, docs, today);
  o.createdAt = Number(d.createdAt) || Number(d.updatedAt) || 0;
  o.updatedAt = Number(d.updatedAt) || 0;
  o.deleted = !!d.deleted;
  o.aiDraft = !!d.aiDraft;
  return o;
}
function apiFull_(d, docs, today){
  const o = apiDoc_(d, docs, today);
  ["contact","validText","note","memo","taxRate","rounding","layout","fromId"].forEach(k => o[k] = d[k] === undefined ? "" : d[k]);
  o.taxIn = d.taxIn === true;
  o.rev = Number(d.rev) || 1;
  o.items = (d.items || []).filter(x => x.desc || x.price !== "");
  return o;
}
function apiById_(id){
  const all = aiAllDocs_(), d = aiFind_(all.filter(x => !x.deleted), {id:id});
  return {all:all, d:d};
}
function apiOne_(id){
  const docs = aiDocs_(), d = aiFind_(docs, {id:id});
  return {document:apiFull_(d, docs, aiToday_())};
}
function apiList_(a){
  const all = aiAllDocs_(), docs = all.filter(d => !d.deleted), today = aiToday_();
  const since = a.updatedSince === undefined ? null : Number(a.updatedSince);
  const q = a.query ? String(a.query).trim().toLowerCase() : "";
  const list = (a.includeDeleted ? all : docs).map(d => apiDoc_(d, docs, today)).filter(s => {
    if(since !== null && !(s.updatedAt > since)) return false;
    if(a.type && s.type !== a.type) return false;
    if(a.from && !(s.date >= a.from)) return false;
    if(a.to && !(s.date && s.date <= a.to)) return false;
    if(q && [s.client, s.subject, s.no, s.base].join(" ").toLowerCase().indexOf(q) < 0) return false;
    if(a.status){
      if(s.deleted) return false;
      if(a.status === "ai_draft") return s.aiDraft;
      if(a.status === "unpaid") return s.status === "unpaid" || s.status === "overdue";
      return s.status === a.status;
    }
    return true;
  });
  const byId = (x, y) => String(x.id).localeCompare(String(y.id));
  if(since !== null) list.sort((x, y) => x.updatedAt - y.updatedAt || byId(x, y));
  else list.sort((x, y) => String(y.date || "").localeCompare(String(x.date || "")) || y.updatedAt - x.updatedAt || byId(x, y));
  const offset = Number(a.offset) || 0, limit = Number(a.limit) || 30;
  return {total:list.length, documents:list.slice(offset, offset + limit)};
}
// 「下書きまで」のキー用の制限。入金の状態を変える操作と、本人が記録を付けた下書きの変更を止める
function apiDraftGuard_(op, a){
  const deny = m => aiFail_(m + "。このキーは下書きの範囲だけです。アプリで本人が操作してください", "forbidden_for_scope");
  if(op === "status") deny("入金・失注は記録できません");
  const receipt = "領収書は扱えません（下書きでも元の請求書が入金済みになるため）";
  if(op === "create"){ if(a.type === "receipt") deny(receipt); return; }
  const docs = aiDocs_(), d = aiFind_(docs, {id:a.id});
  if(d.type === "receipt") deny(receipt);
  if(op === "convert" && (a.to === "receipt" || (!a.to && d.type === "invoice"))) deny(receipt);
  if(op === "convert" || op === "revise"){
    // 新しい版は同じ案件番号を引き継ぐ。旧版や取込書類も含めて、案件全体の記録を調べる
    const same = x => x.id === d.id || (!!d.base && x.base === d.base) || x.fromId === d.id;
    const group = docs.filter(same);
    const makesInvoice = op === "convert" ? d.type === "estimate" : d.type === "invoice";
    if(makesInvoice && group.some(x => x.type === "invoice" && (x.paid || docs.some(r => r.type === "receipt" && (linked(x, r) || linked(r, x))))))
      deny("入金済みの請求書がある案件には、請求書の版を追加できません");
    if(makesInvoice && group.some(x => x.type === "receipt")) deny("領収書がある案件には、請求書の版を追加できません");
    if(d.type === "estimate" && group.some(x => x.type === "estimate" && x.lost)) deny("失注にした見積は、変換・改訂できません");
  }
  if((op === "update" || op === "delete") && d.aiDraft && (d.paid || d.lost || d.pdfUrl)) deny("入金・失注の記録やPDFがある下書きは変えられません");
}
// 「下書きまで」のキーの要求は draft_ で始まる op で届く（この制限を知らない古いGASでは失敗する）
function apiGuarded_(op, fn){ return a => { apiDraftGuard_(op, a); return fn(a); }; }
const API_TOOL_OPS = {create_document:"create", update_draft:"update", convert_document:"convert", revise_document:"revise", set_status:"status"};
function apiCall_(a, draftOnly){
  const name = String(a.name || ""), args = a.arguments || {};
  if(draftOnly && Object.prototype.hasOwnProperty.call(API_TOOL_OPS, name)){
    try{ apiDraftGuard_(API_TOOL_OPS[name], args); }
    catch(err){ if(err instanceof AiError) return {content:[{type:"text", text:err.message}], isError:true}; throw err; }
  }
  return aiCallTool_(name, args);
}
function apiDelete_(a){
  const r = apiById_(a.id), d = r.d;
  if(!d.aiDraft) aiFail_("削除できるのはAI下書きだけです。本人が作った（または確認・保存した）書類はアプリで本人が削除してください", "not_editable");
  if(d.paid || d.lost || d.pdfUrl) aiFail_("入金・失注の記録やPDFがある下書きは削除できません。アプリで本人が確認してください", "not_editable");
  const x = JSON.parse(JSON.stringify(d));
  x.deleted = true;
  x.updatedAt = Math.max(Date.now(), (Number(d.updatedAt) || 0) + 1);
  const s = upsertDoc_(x);
  if(!s || s.skipped) aiFail_("削除できませんでした（同時に更新された可能性があります）", "conflict");
  return {id:x.id, deleted:true, updatedAt:x.updatedAt};
}
// ツール名で既存の処理を呼び、作成・変更した書類の全項目を返す
function apiWrite_(fn, args){
  const r = fn(args);
  return apiOne_(r.data.document.id);
}
const API_OPS = {
  ping: () => ({time:new Date().toISOString()}),
  list: apiList_,
  get: a => {
    const docs = aiDocs_(), today = aiToday_(), d = aiFind_(docs, {id:a.id});
    const o = apiFull_(d, docs, today);
    o.related = docs.filter(x => linked(d, x) || linked(x, d)).map(x => apiDoc_(x, docs, today));
    return {document:o};
  },
  create: a => apiWrite_(aiCreate_, a),
  update: a => apiWrite_(aiUpdateDraft_, a),
  convert: a => apiWrite_(aiConvert_, a),
  revise: a => apiWrite_(aiRevise_, a),
  status: a => apiWrite_(aiSetStatus_, a),
  delete: apiDelete_,
  report: a => aiReport_(a).data,
  message: a => aiMessage_(a).data,
  issuer: () => aiIssuer_().data,
  snapshot: () => ({documents:aiAllDocs_().map(d => ({id:d.id, type:d.type || "", no:d.no || "", updatedAt:Number(d.updatedAt) || 0, deleted:!!d.deleted}))}),
  tools: () => ({tools:AI_TOOLS, instructions:AI_INSTRUCTIONS, version:AI_VERSION}),
  call: a => apiCall_(a, false),
  draft_call: a => apiCall_(a, true)
};
["create","update","convert","revise","delete"].forEach(op => API_OPS["draft_" + op] = apiGuarded_(op, API_OPS[op]));
