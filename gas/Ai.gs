/**
 * REDSEAL AI連携（MCP）
 *
 * Claude などのAIから、書類の検索・作成・変換・入金記録・売上集計ができるようにする入口です。
 * 仕組み：同じウェブアプリのURLに「?ai=キー」を付けたものを、AIの接続先（MCPサーバー）として登録します。
 *
 * 設置（1回だけ）
 * 1. このファイルを Code.gs と同じ Apps Script プロジェクトに入れる（自動デプロイなら gas/ に入っているので不要）
 * 2. Apps Script のエディタで関数「setupAI」を選んで実行 → 実行ログに「AI接続用URL」が出る
 * 3. そのURLを Claude のカスタムコネクタ（またはパソコン用の中継 mcp/redseal-mcp.mjs）に登録
 *    ※ キーはスクリプトのプロパティに保存されます（コードには書かないので、公開リポジトリでも安全）
 * 作り直し：resetAIKey（古いURLは使えなくなります）／停止：disableAI
 *
 * AIにできないこと：書類の削除、本人が作った書類の中身の書き換え、PDFの作成・送信、設定の変更
 * AIが作った書類には「AI下書き」の印が付き、アプリで確認して保存すると印が外れます。
 */
const AI_VERSION = "1.15.0";
const AI_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const AI_MAX_ROWS = 21; // 帳票の明細行数（index.html の ROWS）
const AI_DEFAULTS = {company:"", rep:"", tel:"", email:"", bank:"", bankType:"", bankNo:"", bankName:"",
  taxRate:"10", taxIn:"0", estDays:30, invDays:30, estValid:"御見積後1カ月", prefixEst:"Q", prefixInv:"I", prefixRcp:"R", fyStart:"1", salesGoal:"", presets:""};
// 送付文面の既定（index.html の DEFAULT_SETTINGS と同じ。設定が同期されていればそちらを使う）
const AI_TEMPLATES = {
  lineEst:"{宛名}{敬称}\nお世話になっております。{会社名}の{代表}です。\n{件名}のお見積書をお送りします。\n\n合計：{金額}（税込）\n有効期限：{期限}\n\nご不明な点があればお気軽にご連絡ください。\nよろしくお願いいたします。",
  lineInv:"{宛名}{敬称}\nお世話になっております。{会社名}の{代表}です。\n{件名}の請求書をお送りします。\n\nご請求額：{金額}（税込）\nお支払期限：{期限}\n\n{振込先}\n\nご確認のほどよろしくお願いいたします。",
  lineRcp:"{宛名}{敬称}\nお世話になっております。{会社名}の{代表}です。\n{件名}の領収書をお送りします。\n\n領収額：{金額}（税込）\n\nこのたびはありがとうございました。今後ともよろしくお願いいたします。",
  mailEst:"【お見積書】{件名}（{会社名}）\n{宛名} {敬称}\n\nいつもお世話になっております。\n{会社名}の{代表}です。\n\n{件名}のお見積書を添付にてお送りいたします。\n\n　見積No.：{No}\n　合計金額：{金額}（税込）\n　有効期限：{期限}\n\nご検討のほど、よろしくお願いいたします。\n\n{会社名}　{代表}\nTEL：{電話}",
  mailInv:"【ご請求書】{件名}（{会社名}）\n{宛名} {敬称}\n\nいつもお世話になっております。\n{会社名}の{代表}です。\n\n{件名}のご請求書を添付にてお送りいたします。\n\n　請求No.：{No}\n　ご請求額：{金額}（税込）\n　お支払期限：{期限}\n\n{振込先}\n\nご確認のほど、よろしくお願いいたします。\n\n{会社名}　{代表}\nTEL：{電話}",
  mailRcp:"【領収書】{件名}（{会社名}）\n{宛名} {敬称}\n\nいつもお世話になっております。\n{会社名}の{代表}です。\n\n{件名}の領収書を添付にてお送りいたします。\n\n　領収No.：{No}\n　領収額：{金額}（税込）\n\nこのたびはご利用いただきありがとうございました。\n今後ともよろしくお願いいたします。\n\n{会社名}　{代表}\nTEL：{電話}",
  lineRem:"{宛名}{敬称}\nお世話になっております。{会社名}の{代表}です。\n{日付}にお送りした{件名}のご請求（{金額}）につきまして、ご入金の確認がまだ取れておりませんでしたのでご連絡いたしました。\n\n{振込先}\n\n行き違いでお支払い済みの場合はご容赦ください。\nご確認のほどよろしくお願いいたします。",
  mailRem:"【お支払いのご確認】{件名}（{会社名}）\n{宛名} {敬称}\n\nいつもお世話になっております。\n{会社名}の{代表}です。\n\n下記のご請求につきまして、ご入金の確認がまだ取れておりませんでしたので、ご確認をお願いいたします。\n\n　請求No.：{No}\n　請求日：{日付}\n　ご請求額：{金額}（税込）\n　お支払期限：{期限}\n\n{振込先}\n\n行き違いでお支払い済みの場合は、ご容赦ください。\n何卒よろしくお願いいたします。\n\n{会社名}　{代表}\nTEL：{電話}"
};
const AI_TYPE_NAME = {estimate:"見積書", invoice:"請求書", receipt:"領収書"};
const AI_STATUS_NAME = {old:"旧版", paid:"入金済", unpaid:"未入金", overdue:"期限超過", won:"受注", lost:"失注", open:"検討中"};

/* ===================== キーの管理（エディタから実行） ===================== */
function setupAI(){
  const p = PropertiesService.getScriptProperties();
  let k = p.getProperty("AI_KEY");
  if(!k){ k = Utilities.getUuid().replace(/-/g, ""); p.setProperty("AI_KEY", k); }
  const url = ScriptApp.getService().getUrl() + "?ai=" + k;
  Logger.log("AI接続用URL（人に見せないでください）: " + url);
  return url;
}
function resetAIKey(){ PropertiesService.getScriptProperties().deleteProperty("AI_KEY"); return setupAI(); }
function disableAI(){ PropertiesService.getScriptProperties().deleteProperty("AI_KEY"); Logger.log("AI連携を止めました"); }
function aiAuthed_(e){
  const k = PropertiesService.getScriptProperties().getProperty("AI_KEY");
  const given = e && e.parameter && e.parameter.ai;
  return !!k && typeof given === "string" && given === k;
}

/* ===================== MCP（JSON-RPC 2.0） ===================== */
function isMcp_(req){ return Array.isArray(req) || !!(req && req.jsonrpc); }
function mcpInfo_(e){ // ブラウザでURLを開いたときの確認用
  if(!aiAuthed_(e)) return out_({ok:false, error:"AIキーが違うか、AI連携が止まっています（setupAI を実行してください）"});
  return out_({ok:true, server:"redseal", version:AI_VERSION, note:"このURLをAIの接続先（MCP）に登録してください"});
}
function mcpHandle_(req, e){
  const authed = aiAuthed_(e);
  const batch = Array.isArray(req);
  const msgs = batch ? req : [req];
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  let res;
  try{ res = msgs.map(m => mcpOne_(m, authed)).filter(r => r); }
  finally{ lock.releaseLock(); }
  if(!res.length) return ContentService.createTextOutput("").setMimeType(ContentService.MimeType.JSON);
  return out_(batch ? res : res[0]);
}
function rpcErr_(id, code, message){ return {jsonrpc:"2.0", id:id, error:{code:code, message:message}}; }
function mcpOne_(m, authed){
  const id = m && m.id !== undefined ? m.id : null;
  if(!m || typeof m !== "object" || m.jsonrpc !== "2.0" || typeof m.method !== "string") return rpcErr_(id, -32600, "Invalid Request");
  const isNote = m.id === undefined;
  if(!authed) return isNote ? null : rpcErr_(id, -32001, "AIキーが違うか、AI連携が止まっています（GASで setupAI を実行し、表示されたURLを登録してください）");
  const p = m.params || {};
  let result;
  switch(m.method){
    case "initialize":
      result = {protocolVersion: AI_PROTOCOLS.indexOf(p.protocolVersion) >= 0 ? p.protocolVersion : AI_PROTOCOLS[0],
        capabilities:{tools:{listChanged:false}}, serverInfo:{name:"redseal", title:"REDSEAL 見積・請求・領収", version:AI_VERSION},
        instructions: AI_INSTRUCTIONS};
      break;
    case "ping": result = {}; break;
    case "tools/list": result = {tools: AI_TOOLS}; break;
    case "tools/call": result = aiCallTool_(p.name, p.arguments || {}); break;
    default:
      if(isNote) return null;
      return rpcErr_(id, -32601, "Method not found: " + m.method);
  }
  return isNote ? null : {jsonrpc:"2.0", id:id, result:result};
}

const AI_INSTRUCTIONS = "REDSEAL（日本の見積書・請求書・領収書アプリ）のデータです。金額は円・整数。日付は YYYY-MM-DD（日本時間）。" +
  "書類の種類：estimate=見積書、invoice=請求書、receipt=領収書。案件番号（base）は見積・請求・領収で共通、書類No.は頭文字＋案件番号（改訂は -2…）。" +
  "流れ：見積→convert_document で請求書→入金後に set_status(paid) か convert_document で領収書。作り直しは revise_document。" +
  "AIが作った書類は『AI下書き』になり、本人がアプリで確認・保存してからPDFを送ります。AIはPDFを作れず、送信もしません。作成後は必ず本人に『アプリで確認してから送ってください』と伝えてください。" +
  "削除はできません。本人が作った書類の中身は変更できません（変更したいときは revise_document で改訂版を作る）。";

const AI_ITEMS_SCHEMA = {type:"array", minItems:1, maxItems:AI_MAX_ROWS, description:"明細（最大21行）",
  items:{type:"object", required:["desc","price"], properties:{
    desc:{type:"string", description:"品名"}, qty:{type:"number", description:"数量（既定1）"}, unit:{type:"string", description:"単位（式・台・箇所など）"},
    price:{type:"number", description:"単価（円）。taxIn=true なら税込の単価"}, date:{type:"string", description:"月日など（任意）"}}}};
const AI_DOC_PROPS = {
  client:{type:"string", description:"宛名（会社名・氏名）"}, honor:{type:"string", enum:["御中","様",""], description:"敬称（会社は御中、個人は様）"},
  contact:{type:"string", description:"ご担当（任意）"}, subject:{type:"string", description:"件名"},
  date:{type:"string", description:"書類の日付 YYYY-MM-DD（既定は今日）"}, due:{type:"string", description:"期限 YYYY-MM-DD（見積は有効期限、請求はお支払期限。既定は設定の日数後）"},
  validText:{type:"string", description:"見積書の有効期限の文言（例：御見積後1カ月）"}, note:{type:"string", description:"見積書の備考"},
  items:AI_ITEMS_SCHEMA, taxRate:{type:"string", enum:["10","8","0"], description:"消費税率（既定は設定）"},
  taxIn:{type:"boolean", description:"true=単価を税込で入力"}, rounding:{type:"string", enum:["floor","round","ceil"], description:"消費税の端数（既定 切り捨て）"},
  layout:{type:"string", enum:["simple","detail"], description:"領収書の書式（simple=金額のみ、detail=明細あり）"}, memo:{type:"string", description:"社内メモ（帳票には出ない）"}
};
function aiProps_(extra){ const o = {}; Object.keys(extra).forEach(k => o[k] = extra[k]); Object.keys(AI_DOC_PROPS).forEach(k => o[k] = AI_DOC_PROPS[k]); return o; }
const AI_RO = {readOnlyHint:true, destructiveHint:false, openWorldHint:false};
const AI_RW = {readOnlyHint:false, destructiveHint:false, openWorldHint:false};
const AI_TOOLS = [
  {name:"list_documents", title:"書類を探す", annotations:AI_RO,
    description:"見積書・請求書・領収書の一覧（新しい順）。種類・期間・キーワード（宛名・件名・書類No.・案件番号）・状況で絞り込めます。金額は税込。",
    inputSchema:{type:"object", properties:{
      type:{type:"string", enum:["estimate","invoice","receipt"]}, query:{type:"string"},
      status:{type:"string", enum:["unpaid","overdue","paid","open","won","lost","old","ai_draft"], description:"unpaid=未入金（期限超過を含む）、overdue=期限超過、paid=入金済、open=見積検討中、won=受注、lost=失注、old=旧版、ai_draft=AI下書き"},
      from:{type:"string", description:"日付の始め YYYY-MM-DD"}, to:{type:"string", description:"日付の終わり YYYY-MM-DD"},
      limit:{type:"number", description:"最大件数（既定30、最大200）"}}}},
  {name:"get_document", title:"書類の詳細", annotations:AI_RO,
    description:"1件の書類の詳細（明細・金額・状況・同じ案件の書類）。id か 書類No.（例 I2611-003）で指定。",
    inputSchema:{type:"object", properties:{id:{type:"string"}, no:{type:"string"}}}},
  {name:"create_document", title:"書類を作る", annotations:AI_RW,
    description:"見積書・請求書・領収書を新しく作ります（AI下書き）。番号・期限は自動。作った後は本人がアプリで確認・保存してからPDFを送ります。",
    inputSchema:{type:"object", required:["type","client","items"], properties:aiProps_({type:{type:"string", enum:["estimate","invoice","receipt"]}})}},
  {name:"update_draft", title:"AI下書きを直す", annotations:AI_RW,
    description:"AIが作った下書き（まだ本人が保存していないもの）の内容を変更します。渡した項目だけ変わります。本人の書類は変更できません（revise_document を使う）。",
    inputSchema:{type:"object", required:["id"], properties:aiProps_({id:{type:"string"}})}},
  {name:"convert_document", title:"請求書・領収書に変換", annotations:AI_RW,
    description:"見積書→請求書、請求書→領収書に変換した新しい書類（AI下書き）を作ります。案件番号を引き継ぎ、日付は今日（date で変更可）。",
    inputSchema:{type:"object", required:["id"], properties:{id:{type:"string"}, to:{type:"string", enum:["invoice","receipt"], description:"省略時は見積→請求、請求→領収"}, date:{type:"string"}}}},
  {name:"revise_document", title:"改訂版を作る", annotations:AI_RW,
    description:"再見積・再発行。元の書類を残したまま、同じ案件の改訂版（No.に -2 など）をAI下書きで作り、渡した項目を変更します。",
    inputSchema:{type:"object", required:["id"], properties:aiProps_({id:{type:"string"}})}},
  {name:"set_status", title:"入金済み・失注を記録", annotations:AI_RW,
    description:"請求書の入金済み（paid、入金日 paidAt は既定で今日）、見積書の失注（lost）を記録します。ほかの内容は変わりません。",
    inputSchema:{type:"object", required:["id"], properties:{id:{type:"string"}, paid:{type:"boolean"}, paidAt:{type:"string", description:"入金日 YYYY-MM-DD"}, lost:{type:"boolean"}}}},
  {name:"sales_report", title:"売上集計", annotations:AI_RO,
    description:"年度の月別売上と前年同月比、年間合計、目標達成率、未入金、取引先別・品目別上位、見積の受注率。請求日で計上（改訂は最新版のみ、請求書の無い領収書も売上）。",
    inputSchema:{type:"object", properties:{year:{type:"number", description:"年度（既定は今年度）"}, basis:{type:"string", enum:["total","sub"], description:"total=税込（既定）、sub=税抜"}}}},
  {name:"message_text", title:"送付文面を作る", annotations:AI_RO,
    description:"書類を送るときの LINE 用・メール用の文面（本人の設定のひな形）。reminder=true で請求書の入金確認の文面。",
    inputSchema:{type:"object", required:["id","channel"], properties:{id:{type:"string"}, channel:{type:"string", enum:["line","mail"]}, reminder:{type:"boolean"}}}},
  {name:"get_issuer_info", title:"発行者情報", annotations:AI_RO,
    description:"発行者（本人）の会社名・連絡先・振込先、税率や期限日数の既定、定型の明細（品名と単価）。",
    inputSchema:{type:"object", properties:{}}}
];

/* ===================== ツール本体 ===================== */
function AiError(msg){ this.message = msg; }
function aiFail_(msg){ throw new AiError(msg); }
function aiCallTool_(name, args){
  const fn = AI_TOOL_FNS[name];
  if(!fn) return {content:[{type:"text", text:"そのツールはありません: " + name}], isError:true};
  try{
    const r = fn(args || {});
    return {content:[{type:"text", text:(r.message ? r.message + "\n\n" : "") + JSON.stringify(r.data)}], structuredContent:r.data};
  }catch(err){
    const msg = err instanceof AiError ? err.message : "内部エラー: " + String(err && err.message || err);
    return {content:[{type:"text", text:msg}], isError:true};
  }
}
const AI_TOOL_FNS = {
  list_documents: aiList_, get_document: aiGet_, create_document: aiCreate_, update_draft: aiUpdateDraft_,
  convert_document: aiConvert_, revise_document: aiRevise_, set_status: aiSetStatus_, sales_report: aiReport_,
  message_text: aiMessage_, get_issuer_info: aiIssuer_
};

function aiToday_(){ return Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy-MM-dd"); }
function aiAddDays_(iso, n){ const p = iso.split("-").map(Number); const d = new Date(Date.UTC(p[0], p[1]-1, p[2] + (Number(n)||0))); return d.toISOString().slice(0, 10); }
function aiIsDate_(s){ if(!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false; return aiAddDays_(s, 0) === s; }
function aiSettings_(){ const s = getSettings_() || {}; const o = {}; Object.keys(AI_DEFAULTS).forEach(k => o[k] = AI_DEFAULTS[k]); Object.keys(s).forEach(k => { if(s[k] !== undefined && s[k] !== null && s[k] !== "") o[k] = s[k]; }); o.salesManual = s.salesManual || {}; return o; }
function aiAllDocs_(){ return listDocs_(0); }               // 削除済みを含む（番号の採番用）
function aiDocs_(){ return aiAllDocs_().filter(d => !d.deleted); }
function aiPrefix_(S, type){ return {estimate:S.prefixEst, invoice:S.prefixInv, receipt:S.prefixRcp}[type] || ""; }
function aiMakeNo_(S, type, base, rev){ return aiPrefix_(S, type) + base + (rev > 1 ? "-" + rev : ""); }
function aiNextBase_(all, dateISO){
  const ym = dateISO.slice(2, 4) + dateISO.slice(5, 7);
  const used = all.filter(d => d.base && String(d.base).indexOf(ym + "-") === 0).map(d => Number(String(d.base).split("-")[1]) || 0);
  const n = used.length ? Math.max.apply(null, used) + 1 : 1;
  return ym + "-" + String(n).padStart(3, "0");
}
function aiNextRev_(all, type, base){
  const r = all.filter(d => d.base === base && d.type === type).map(d => Number(d.rev) || 1);
  return r.length ? Math.max.apply(null, r) + 1 : 1;
}
function aiNewId_(){ return "ai" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function aiFind_(docs, args){
  let d = null;
  if(args.id) d = docs.find(x => x.id === String(args.id));
  else if(args.no){ const n = String(args.no).trim().toLowerCase(); d = docs.find(x => String(x.no || "").toLowerCase() === n); }
  else aiFail_("id か no を指定してください");
  if(!d) aiFail_("書類が見つかりません: " + (args.id || args.no));
  return d;
}
function aiSummary_(d, docs, today){
  const c = calc(d);
  const o = {id:d.id, type:d.type, typeName:AI_TYPE_NAME[d.type] || d.type, no:d.no || "", base:d.base || "", date:d.date || "", due:d.due || "",
    client:d.client || "", honor:d.honor || "", subject:d.subject || "", sub:c.sub, tax:c.tax, total:c.total};
  const st = docStatus(d, docs, today); if(st){ o.status = st; o.statusName = AI_STATUS_NAME[st]; }
  if(d.type === "invoice"){ o.paid = !!d.paid; if(d.paidAt) o.paidAt = d.paidAt; }
  if(d.aiDraft) o.aiDraft = true;
  if(d.pdfUrl) o.pdfUrl = d.pdfUrl;
  return o;
}
function aiSave_(d){ d.updatedAt = Date.now(); const r = upsertDoc_(d); if(!r || r.skipped) aiFail_("保存できませんでした（ほかの端末で同時に更新された可能性があります。もう一度試してください）"); return d; }

// 項目の確認と反映（create／update／revise 共通）。partial=true なら渡した項目だけ
function aiApply_(d, a, partial){
  const str = (k, max) => { if(a[k] === undefined) return; if(a[k] === null) a[k] = ""; if(typeof a[k] !== "string") aiFail_(k + " は文字で指定してください"); if(a[k].length > (max || 200)) aiFail_(k + " が長すぎます"); d[k] = a[k].trim(); };
  str("client"); str("contact"); str("subject"); str("validText"); str("note", 1000); str("memo", 1000);
  if(a.honor !== undefined){ if(["御中","様",""].indexOf(a.honor) < 0) aiFail_("honor は 御中・様・空 のどれかです"); d.honor = a.honor; }
  ["date","due"].forEach(k => { if(a[k] === undefined) return; if(k === "due" && (a[k] === "" || a[k] === null)){ d.due = ""; return; } if(typeof a[k] !== "string" || !aiIsDate_(a[k])) aiFail_(k + " は YYYY-MM-DD で指定してください"); d[k] = a[k]; });
  if(a.taxRate !== undefined){ const t = String(a.taxRate); if(["10","8","0"].indexOf(t) < 0) aiFail_("taxRate は 10・8・0 のどれかです"); d.taxRate = t; }
  if(a.taxIn !== undefined){ if(typeof a.taxIn !== "boolean") aiFail_("taxIn は true/false です"); d.taxIn = a.taxIn; }
  if(a.rounding !== undefined){ if(["floor","round","ceil"].indexOf(a.rounding) < 0) aiFail_("rounding は floor・round・ceil のどれかです"); d.rounding = a.rounding; }
  if(a.layout !== undefined){ if(["simple","detail"].indexOf(a.layout) < 0) aiFail_("layout は simple・detail のどちらかです"); d.layout = a.layout; }
  if(a.items !== undefined){
    if(!Array.isArray(a.items) || !a.items.length) aiFail_("明細（items）を1行以上指定してください");
    if(a.items.length > AI_MAX_ROWS) aiFail_("明細は" + AI_MAX_ROWS + "行までです");
    d.items = a.items.map((x, i) => {
      if(!x || typeof x !== "object") aiFail_((i+1) + "行目の明細が不正です");
      const n = (v, def) => { if(v === undefined || v === null || v === "") return def; const z = typeof v === "number" ? v : Number(String(v).replace(/[,，¥円\s]/g, "")); if(!isFinite(z)) aiFail_((i+1) + "行目の数量・単価は数字で指定してください"); return z; };
      const desc = x.desc == null ? "" : String(x.desc).trim();
      const price = n(x.price, null);
      if(!desc && price === null) aiFail_((i+1) + "行目に品名か単価を入れてください");
      return {date: x.date == null ? "" : String(x.date), desc: desc, qty: n(x.qty, 1), unit: x.unit == null ? "" : String(x.unit), price: price === null ? "" : price};
    });
  }
  if(!partial && !d.client) aiFail_("宛名（client）を入れてください");
  if(d.client === "" && !d.subject) aiFail_("宛名か件名を入れてください");
  return d;
}
function aiDone_(d, docs, verb){
  const today = aiToday_();
  return {message: AI_TYPE_NAME[d.type] + " " + d.no + " を" + verb + "（AI下書き）。アプリの一覧に「AI下書き」と表示されます。本人がアプリで内容を確認・保存してからPDFを作成・送付してください。",
    data:{document: aiSummary_(d, docs.concat([d]).filter((x, i, a) => a.findIndex(y => y.id === x.id) === i), today)}};
}
function aiFresh_(type, S){ // newDoc と同じ既定
  return {type:type, honor:"御中", contact:"", subject:"", items:[], taxRate:String(S.taxRate || "10"), taxIn:String(S.taxIn) === "1", rounding:"floor",
    memo:"", layout:"simple", validText: type === "estimate" ? S.estValid : "", note:""};
}
function aiStamp_(d, S, all, opt){ // 番号・期限・印
  const now = Date.now();
  d.id = aiNewId_(); d.createdAt = now; d.updatedAt = now; d.aiDraft = true; d.aiAt = new Date(now).toISOString();
  if(!d.date) d.date = aiToday_();
  if(opt.base){ d.base = opt.base; d.rev = aiNextRev_(all, d.type, d.base); } else { d.base = aiNextBase_(all, d.date); d.rev = 1; }
  d.no = aiMakeNo_(S, d.type, d.base, d.rev);
  if(d.type === "receipt") d.due = "";
  else if(!opt.keepDue || !d.due) d.due = aiAddDays_(d.date, d.type === "invoice" ? S.invDays : S.estDays);
  ["paid","paidAt","lost","pdfUrl","dupOk","imported","deleted"].forEach(k => delete d[k]);
  return d;
}

function aiList_(a){
  const docs = aiDocs_(), today = aiToday_();
  if(a.status && ["unpaid","overdue","paid","open","won","lost","old","ai_draft"].indexOf(a.status) < 0) aiFail_("status が不正です");
  if(a.type && !AI_TYPE_NAME[a.type]) aiFail_("type が不正です");
  const q = a.query ? String(a.query).trim().toLowerCase() : "";
  let list = docs.map(d => aiSummary_(d, docs, today)).filter(s => {
    if(a.type && s.type !== a.type) return false;
    if(a.from && s.date < a.from) return false;
    if(a.to && s.date > a.to) return false;
    if(q && [s.client, s.subject, s.no, s.base].join(" ").toLowerCase().indexOf(q) < 0) return false;
    if(a.status === "ai_draft") return !!s.aiDraft;
    if(a.status === "unpaid") return s.status === "unpaid" || s.status === "overdue";
    if(a.status) return s.status === a.status;
    return true;
  });
  const upd = {}; docs.forEach(d => upd[d.id] = Number(d.updatedAt) || 0);
  list.sort((x, y) => (y.date || "").localeCompare(x.date || "") || upd[y.id] - upd[x.id]);
  const limit = Math.min(200, Math.max(1, Number(a.limit) || 30));
  return {data:{count:list.length, documents:list.slice(0, limit)}};
}
function aiGet_(a){
  const docs = aiDocs_(), today = aiToday_(), d = aiFind_(docs, a);
  const s = aiSummary_(d, docs, today);
  ["contact","validText","note","memo","taxRate","taxIn","rounding","layout","rev","fromId"].forEach(k => { if(d[k] !== undefined && d[k] !== "") s[k] = d[k]; });
  s.items = (d.items || []).filter(x => x.desc || x.price !== "");
  const related = docs.filter(x => linked(d, x) || linked(x, d)).sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0)).map(x => aiSummary_(x, docs, today));
  return {data:{document:s, related:related}};
}
function aiCreate_(a){
  if(!AI_TYPE_NAME[a.type]) aiFail_("type は estimate・invoice・receipt のどれかです");
  if(a.items === undefined) aiFail_("明細（items）を1行以上指定してください");
  const S = aiSettings_(), all = aiAllDocs_();
  const d = aiApply_(aiFresh_(a.type, S), a, false);
  aiStamp_(d, S, all, {keepDue:a.due !== undefined});
  aiSave_(d);
  return aiDone_(d, aiDocs_(), "作りました");
}
function aiUpdateDraft_(a){
  const docs = aiDocs_(), d = aiFind_(docs, {id:a.id});
  if(!d.aiDraft) aiFail_("本人が作った（または確認・保存した）書類は変更できません。作り直す場合は revise_document で改訂版を作ってください");
  const x = JSON.parse(JSON.stringify(d)); const b = {}; Object.keys(a).forEach(k => { if(k !== "id") b[k] = a[k]; });
  aiApply_(x, b, true);
  if(b.date !== undefined && b.due === undefined && x.type !== "receipt"){ const S = aiSettings_(); x.due = aiAddDays_(x.date, x.type === "invoice" ? S.invDays : S.estDays); }
  aiSave_(x);
  return aiDone_(x, docs, "直しました");
}
function aiConvert_(a){
  const S = aiSettings_(), all = aiAllDocs_(), docs = all.filter(d => !d.deleted), src = aiFind_(docs, {id:a.id});
  const to = a.to || (src.type === "estimate" ? "invoice" : src.type === "invoice" ? "receipt" : "");
  if(!((src.type === "estimate" && (to === "invoice" || to === "receipt")) || (src.type === "invoice" && to === "receipt"))) aiFail_(AI_TYPE_NAME[src.type] + "から" + (AI_TYPE_NAME[to] || "その種類") + "には変換できません（見積→請求・領収、請求→領収）");
  if(a.date !== undefined && (typeof a.date !== "string" || !aiIsDate_(a.date))) aiFail_("date は YYYY-MM-DD で指定してください");
  const d = JSON.parse(JSON.stringify(src));
  d.type = to; d.date = a.date || aiToday_(); d.fromId = src.id;
  if(!d.base) d.base = aiNextBase_(all, d.date);
  aiStamp_(d, S, all, {base:d.base});
  aiSave_(d);
  return aiDone_(d, docs, "作りました");
}
function aiRevise_(a){
  const S = aiSettings_(), all = aiAllDocs_(), docs = all.filter(d => !d.deleted), src = aiFind_(docs, {id:a.id});
  const d = JSON.parse(JSON.stringify(src)); const b = {}; Object.keys(a).forEach(k => { if(k !== "id") b[k] = a[k]; });
  aiApply_(d, b, true);
  if(b.date === undefined) d.date = aiToday_();
  d.fromId = src.id;
  if(!d.base) d.base = aiNextBase_(all, d.date);
  aiStamp_(d, S, all, {base:d.base, keepDue:b.due !== undefined});
  aiSave_(d);
  return aiDone_(d, docs, "作りました（改訂版）");
}
function aiSetStatus_(a){
  const docs = aiDocs_(), d = aiFind_(docs, {id:a.id});
  if(a.paid === undefined && a.lost === undefined) aiFail_("paid か lost を指定してください");
  if((a.paid !== undefined || a.paidAt !== undefined) && d.type !== "invoice") aiFail_("入金済みにできるのは請求書だけです");
  if(a.lost !== undefined && d.type !== "estimate") aiFail_("失注にできるのは見積書だけです");
  const x = JSON.parse(JSON.stringify(d));
  if(a.paid !== undefined){
    if(typeof a.paid !== "boolean") aiFail_("paid は true/false です");
    x.paid = a.paid;
    if(a.paid){ if(a.paidAt !== undefined && (typeof a.paidAt !== "string" || !aiIsDate_(a.paidAt))) aiFail_("paidAt は YYYY-MM-DD で指定してください"); x.paidAt = a.paidAt || x.paidAt || aiToday_(); }
    else x.paidAt = "";
  }
  if(a.lost !== undefined){ if(typeof a.lost !== "boolean") aiFail_("lost は true/false です"); x.lost = a.lost; }
  aiSave_(x);
  const s = aiSummary_(x, docs.map(y => y.id === x.id ? x : y), aiToday_());
  return {message: AI_TYPE_NAME[x.type] + " " + x.no + " を「" + (s.statusName || "") + "」にしました。", data:{document:s}};
}
function aiReport_(a){
  const S = aiSettings_(), docs = aiDocs_(), today = aiToday_();
  const st = Number(S.fyStart) || 1, y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7));
  const fy = a.year !== undefined ? Number(a.year) : (m >= st ? y : y - 1);
  if(!isFinite(fy) || fy < 2000 || fy > 2100) aiFail_("year が不正です");
  const basis = a.basis === "sub" ? "sub" : "total";
  const s = salesStats(docs, {fy:fy, fyStart:st, basis:basis, manual:S.salesManual || {}, defRate:Number(S.taxRate) || 10, today:today, goal:Number(S.salesGoal) || 0});
  const months = s.months.map(x => ({key:x.key, label:x.label, cur:x.cur, prev:x.prev, count:x.count, ratio:x.ratio}));
  return {data:{year:fy, fyStart:st, basis:basis === "sub" ? "税抜" : "税込", months:months, total:s.total, ytd:s.ytd, goal:s.goal,
    clients:s.clients, items:s.items, receivables:receivables(docs, today), estimates:estimateStats(docs, fy, st)}};
}
function aiYen_(n){ return "¥" + String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
function aiFmtDate_(d){ if(!d) return ""; const p = String(d).split("-"); return p[0] + "/" + Number(p[1]) + "/" + Number(p[2]); }
function aiMessage_(a){
  const docs = aiDocs_(), d = aiFind_(docs, {id:a.id});
  if(a.channel !== "line" && a.channel !== "mail") aiFail_("channel は line か mail です");
  if(a.reminder && d.type !== "invoice") aiFail_("入金確認の文面は請求書だけです");
  const S = aiSettings_(), raw = getSettings_() || {};
  const key = a.channel + (a.reminder ? "Rem" : {estimate:"Est", invoice:"Inv", receipt:"Rcp"}[d.type]);
  const tpl = raw[key] || AI_TEMPLATES[key] || "";
  const c = calc(d);
  const bank = [S.bank, S.bankType, S.bankNo, S.bankName].filter(Boolean).join("　");
  const map = {"宛名":d.client, "敬称":d.honor, "件名":d.subject, "金額":aiYen_(c.total), "No":d.no, "日付":aiFmtDate_(d.date),
    "期限": d.type === "estimate" && d.validText ? d.validText : aiFmtDate_(d.due), "会社名":S.company, "代表":S.rep, "電話":S.tel,
    "振込先": bank ? "【お振込先】\n" + bank : "", "種別": {estimate:"見積", invoice:"請求", receipt:"領収"}[d.type] + "書"};
  const text = tpl.replace(/\{([^}]+)\}/g, (m0, k) => map[k] != null ? map[k] : m0);
  const data = {channel:a.channel, text:text};
  if(a.channel === "mail"){ const lines = text.split("\n"); data.subject = lines[0]; data.body = lines.slice(1).join("\n"); }
  return {data:data};
}
function aiIssuer_(){
  const S = aiSettings_();
  const presets = String(S.presets || "").split("\n").map(l => l.trim()).filter(Boolean).map(l => { const i = l.lastIndexOf(","); const p = i >= 0 ? Number(l.slice(i + 1)) : NaN; return isFinite(p) && i >= 0 ? {desc:l.slice(0, i).trim(), price:p} : {desc:l}; });
  const pick = ["company","rep","zip","addr1","addr2","tel","fax","email","regno","bank","bankType","bankNo","bankName","taxRate","estDays","invDays","estValid","prefixEst","prefixInv","prefixRcp","fyStart","salesGoal"];
  const raw = getSettings_() || {}; const o = {};
  pick.forEach(k => { const v = raw[k] !== undefined && raw[k] !== "" ? raw[k] : AI_DEFAULTS[k]; if(v !== undefined) o[k] = v; });
  o.taxIn = String(S.taxIn) === "1"; o.presets = presets; o.settingsSynced = !!getSettings_();
  return {data:o};
}
