// node tests/ai.mjs — GAS の AI連携（MCP）を模擬環境で検証。依存なし
import fs from "node:fs";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {loadGas, GAS_DIR} from "./gas-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
let passed=0, failed=0;
function eq(a,b,msg){ const A=JSON.stringify(a), B=JSON.stringify(b); if(A!==B) throw new Error((msg?msg+": ":"")+"\n  expected "+B+"\n  actual   "+A); }
function ok(v,msg){ if(!v) throw new Error(msg||"not ok"); }
function test(name, fn){ try{ fn(); passed++; console.log("ok   "+name); }catch(e){ failed++; console.log("FAIL "+name+"\n     "+String(e.stack||e.message).replace(/\n/g,"\n     ")); } }

const KEY = "testkey123";
const NOW = Date.parse("2026-11-26T01:00:00Z"); // 日本時間 2026-11-26 10:00
function env(opts={}){
  const g = loadGas({now: NOW, props: {AI_KEY: KEY}, ...opts});
  let n = 0;
  g.rpc = (method, params, key=KEY) => g.post({jsonrpc:"2.0", id: ++n, method, params}, {ai: key});
  g.call = (name, args={}) => {
    const r = g.rpc("tools/call", {name, arguments: args});
    if(r.error) throw new Error("rpc error "+JSON.stringify(r.error));
    const res = r.result;
    return {isError: !!res.isError, text: res.content[0].text, data: res.structuredContent};
  };
  g.seed = d => g.api.upsertDoc_(Object.assign({createdAt: NOW-1000, updatedAt: NOW-1000}, d));
  g.doc = id => g.api.listDocs_(0).find(d => d.id === id);
  return g;
}
const item = (desc, price, qty=1, unit="式") => ({desc, qty, unit, price});

test("initialize：対応版を返す", ()=>{
  const g = env();
  const r = g.rpc("initialize", {protocolVersion:"2025-06-18", capabilities:{}, clientInfo:{name:"t",version:"1"}});
  eq(r.result.protocolVersion, "2025-06-18");
  eq(r.result.serverInfo.name, "redseal");
  ok(r.result.capabilities.tools, "tools capability");
  const r2 = g.rpc("initialize", {protocolVersion:"2099-01-01"});
  eq(r2.result.protocolVersion, "2025-06-18", "未知の版には最新を返す");
});

test("tools/list：全ツールに説明と inputSchema", ()=>{
  const g = env();
  const tools = g.rpc("tools/list", {}).result.tools;
  const names = tools.map(t => t.name).sort();
  eq(names, ["convert_document","create_document","get_document","get_issuer_info","list_documents","message_text","revise_document","sales_report","set_status","update_draft"]);
  for(const t of tools){ ok(t.description && t.description.length > 10, t.name+" description"); eq(t.inputSchema.type, "object", t.name); }
  ok(!tools.some(t => /delete/.test(t.name)), "削除ツールは無い");
});

test("認証：キー違い・キー未設定は拒否", ()=>{
  const g = env();
  const r = g.rpc("tools/list", {}, "wrong");
  eq(r.error.code, -32001);
  const g2 = loadGas({now: NOW});
  const r2 = g2.post({jsonrpc:"2.0", id:1, method:"tools/list"}, {ai: ""});
  eq(r2.error.code, -32001);
});

test("通知は空応答、一括は配列で返す", ()=>{
  const g = env();
  eq(g.post({jsonrpc:"2.0", method:"notifications/initialized"}, {ai: KEY}), null);
  const r = g.post([{jsonrpc:"2.0", id:1, method:"ping"}, {jsonrpc:"2.0", method:"notifications/initialized"}, {jsonrpc:"2.0", id:2, method:"nope"}], {ai: KEY});
  eq(r.length, 2); eq(r[0].result, {}); eq(r[1].error.code, -32601);
});

test("不正なJSONと不正なリクエスト", ()=>{
  const g = env();
  const r = g.post({jsonrpc:"2.0", id:5}, {ai: KEY});
  eq(r.error.code, -32600);
});

test("同期の合言葉が初期値・空のままなら、同期APIはすべて拒否する", ()=>{
  for(const base of ["Code.gs","Code.generic.gs"]){
    const files = [base,"AiShared.gs","Ai.gs","Api.gs"];
    for(const [apiKey, sent] of [[null,"change-me-1234"], ["",""]]){
      const g = env({files, apiKey});
      for(const action of ["ping","list","upsert","delete","getSettings","putSettings","savePdf","import"]){
        const r = g.post({key:sent, action});
        eq([r.ok, r.error], [false, "unauthorized"], base+" "+action);
      }
      eq(Object.keys(g.sheets), [], base+"：シートに触らない");
    }
    const g = env({files, apiKey:"sync-secret"});
    eq(g.post({key:"sync-secret", action:"ping"}).ok, true, base);
    eq(g.post({key:"change-me-1234", action:"ping"}).ok, false, base);
  }
});

test("案内どおりでなく全置換で合言葉を入れても同期できる", ()=>{
  for(const base of ["Code.gs","Code.generic.gs"]){
    const src = ["AiShared.gs","Ai.gs","Api.gs",base].map(f => fs.readFileSync(GAS_DIR+"/"+f, "utf8")).join("\n").split("change-me-1234").join("sync-secret");
    eq(env({src}).post({key:"sync-secret", action:"ping"}).ok, true, base);
  }
});

test("従来の同期API（action）はそのまま動く", ()=>{
  const g = env({apiKey:"sync-secret"});
  const r = g.post({key:"sync-secret", action:"ping"});
  eq(r.ok, true);
});

test("ブラウザで開く（GET ?ai=）と案内を返す", ()=>{
  const g = env();
  const out = JSON.parse(g.api.doGet({parameter: {ai: KEY}}).content);
  eq(out.ok, true); eq(out.server, "redseal");
  const bad = JSON.parse(g.api.doGet({parameter: {ai: "x"}}).content);
  eq(bad.ok, false);
});

test("create_document：番号・期限・AI下書き", ()=>{
  const g = env();
  const r = g.call("create_document", {type:"estimate", client:"株式会社テスト", subject:"エアコン清掃", items:[item("エアコン清掃", 8000, 2, "台")]});
  ok(!r.isError, r.text);
  const d = g.doc(r.data.document.id);
  eq([d.type, d.base, d.no, d.rev, d.date, d.due, d.honor, d.aiDraft, d.taxRate, d.rounding, d.validText], ["estimate","2611-001","Q2611-001",1,"2026-11-26","2026-12-26","御中",true,"10","floor","御見積後1カ月"]);
  eq(r.data.document.total, 17600);
  ok(/AI下書き/.test(r.text), "案内文");
  const r2 = g.call("create_document", {type:"invoice", client:"B様", honor:"様", date:"2026-11-03", items:[item("清掃", 10000)]});
  eq(g.doc(r2.data.document.id).no, "I2611-002", "同じ月は連番（種別共通）");
  eq(g.doc(r2.data.document.id).due, "2026-12-03");
});

test("create_document：既存（削除済み含む）の最大＋1、設定の頭文字と日数", ()=>{
  const g = env({apiKey:"sync-secret"});
  g.api.putSettings_({prefixEst:"M", prefixInv:"S", prefixRcp:"U", estDays:14, invDays:10, taxRate:"8", estValid:"2週間"});
  g.seed({id:"a1", type:"invoice", base:"2611-007", no:"S2611-007", date:"2026-11-01", client:"x", items:[]});
  g.seed({id:"a2", type:"invoice", base:"2611-009", no:"S2611-009", date:"2026-11-02", client:"y", items:[], deleted:true});
  g.api.doPost({postData:{contents:JSON.stringify({key:"sync-secret", action:"delete", id:"a2"})}, parameter:{}});
  const r = g.call("create_document", {type:"estimate", client:"z", items:[item("a", 1000)]});
  const d = g.doc(r.data.document.id);
  eq([d.base, d.no, d.due, d.taxRate, d.validText], ["2611-010","M2611-010","2026-12-10","8","2週間"]);
  const r2 = g.call("create_document", {type:"receipt", client:"z", items:[item("a", 1000)]});
  eq([g.doc(r2.data.document.id).no, g.doc(r2.data.document.id).due], ["U2611-011", ""]);
});

test("create_document：入力チェック", ()=>{
  const g = env();
  ok(g.call("create_document", {type:"bill", client:"a", items:[item("a",1)]}).isError, "種別");
  ok(g.call("create_document", {type:"invoice", client:"", items:[item("a",1)]}).isError, "宛名");
  ok(g.call("create_document", {type:"invoice", client:"a", items:[]}).isError, "明細なし");
  ok(g.call("create_document", {type:"invoice", client:"a", items:[{desc:"a", price:"千円"}]}).isError, "金額が数字でない");
  ok(g.call("create_document", {type:"invoice", client:"a", items:Array.from({length:22},()=>item("a",1))}).isError, "22行");
  ok(g.call("create_document", {type:"invoice", client:"a", date:"11/26", items:[item("a",1)]}).isError, "日付形式");
  eq(g.api.listDocs_(0).length, 0, "何も作られない");
});

test("create_document：税込入力", ()=>{
  const g = env();
  const r = g.call("create_document", {type:"invoice", client:"a", taxIn:true, items:[item("a", 11000)]});
  eq([r.data.document.sub, r.data.document.tax, r.data.document.total], [10000, 1000, 11000]);
});

test("convert_document：見積→請求→領収", ()=>{
  const g = env();
  g.seed({id:"e1", type:"estimate", base:"2610-004", rev:1, no:"Q2610-004", date:"2026-10-20", due:"2026-11-19", client:"C社", subject:"窓", items:[item("窓清掃", 10000, 5, "箇所")], taxRate:"10", rounding:"floor", lost:true, pdfUrl:"u"});
  const r = g.call("convert_document", {id:"e1"});
  ok(!r.isError, r.text);
  const inv = g.doc(r.data.document.id);
  eq([inv.type, inv.base, inv.no, inv.rev, inv.fromId, inv.date, inv.due, inv.aiDraft, inv.lost, inv.pdfUrl, inv.client], ["invoice","2610-004","I2610-004",1,"e1","2026-11-26","2026-12-26",true,undefined,undefined,"C社"]);
  const r2 = g.call("convert_document", {id: inv.id});
  const rc = g.doc(r2.data.document.id);
  eq([rc.type, rc.no, rc.due, rc.fromId], ["receipt","R2610-004","",inv.id]);
  ok(g.call("convert_document", {id: rc.id}).isError, "領収書は変換できない");
  ok(g.call("convert_document", {id:"e1", to:"estimate"}).isError, "見積への変換は不可");
  const r3 = g.call("convert_document", {id:"e1"});
  eq(g.doc(r3.data.document.id).no, "I2610-004-2", "2回目は改訂番号");
});

test("revise_document：改訂版（変更を反映）", ()=>{
  const g = env();
  g.seed({id:"e1", type:"estimate", base:"2610-004", rev:1, no:"Q2610-004", date:"2026-10-20", client:"C社", items:[item("窓清掃", 10000)], taxRate:"10", rounding:"floor"});
  const r = g.call("revise_document", {id:"e1", items:[item("窓清掃", 9000)], subject:"値引き版"});
  const d = g.doc(r.data.document.id);
  eq([d.no, d.rev, d.fromId, d.subject, d.items[0].price, d.aiDraft], ["Q2610-004-2", 2, "e1", "値引き版", 9000, true]);
  eq(g.doc("e1").items[0].price, 10000, "元は変わらない");
});

test("update_draft：AI下書きだけ変更できる", ()=>{
  const g = env();
  g.seed({id:"u1", type:"invoice", base:"2611-001", no:"I2611-001", date:"2026-11-01", client:"本人作成", items:[item("a", 1)]});
  ok(g.call("update_draft", {id:"u1", client:"x"}).isError, "本人の書類は不可");
  eq(g.doc("u1").client, "本人作成");
  const c = g.call("create_document", {type:"invoice", client:"a", items:[item("a", 1000)]});
  const r = g.call("update_draft", {id:c.data.document.id, client:"変更後", items:[item("b", 2000)], memo:"メモ"});
  ok(!r.isError, r.text);
  const d = g.doc(c.data.document.id);
  eq([d.client, d.items[0].desc, d.memo, d.no, d.aiDraft], ["変更後","b","メモ","I2611-002",true]);
  ok(g.call("update_draft", {id:"nope"}).isError, "見つからない");
});

test("set_status：入金済み・失注、種別違いは拒否", ()=>{
  const g = env();
  g.seed({id:"i1", type:"invoice", base:"2611-001", no:"I2611-001", date:"2026-11-01", due:"2026-11-20", client:"a", items:[item("a", 1000)], taxRate:"10", memo:"そのまま"});
  g.seed({id:"e1", type:"estimate", base:"2611-002", no:"Q2611-002", date:"2026-11-01", client:"b", items:[item("a", 1000)]});
  const r = g.call("set_status", {id:"i1", paid:true});
  ok(!r.isError, r.text);
  eq([g.doc("i1").paid, g.doc("i1").paidAt, g.doc("i1").memo, g.doc("i1").aiDraft], [true, "2026-11-26", "そのまま", undefined]);
  g.call("set_status", {id:"i1", paid:false});
  eq([g.doc("i1").paid, g.doc("i1").paidAt], [false, ""]);
  g.call("set_status", {id:"e1", lost:true});
  eq(g.doc("e1").lost, true);
  ok(g.call("set_status", {id:"e1", paid:true}).isError, "見積に入金は不可");
  ok(g.call("set_status", {id:"i1", lost:true}).isError, "請求に失注は不可");
  ok(g.doc("i1").updatedAt === NOW, "更新時刻");
});

test("list_documents：絞り込み・検索・状態", ()=>{
  const g = env();
  g.seed({id:"i1", type:"invoice", base:"2611-001", no:"I2611-001", date:"2026-11-01", due:"2026-11-20", client:"山田商店", subject:"清掃", items:[item("a", 1000)], taxRate:"10"});
  g.seed({id:"i2", type:"invoice", base:"2611-002", no:"I2611-002", date:"2026-11-02", due:"2026-12-20", client:"佐藤", items:[item("a", 2000)], taxRate:"10"});
  g.seed({id:"i3", type:"invoice", base:"2610-001", no:"I2610-001", date:"2026-10-02", due:"2026-10-30", client:"佐藤", items:[item("a", 3000)], taxRate:"10", paid:true});
  g.seed({id:"e1", type:"estimate", base:"2611-002", no:"Q2611-002", date:"2026-11-01", client:"佐藤", items:[item("a", 2000)], taxRate:"10"});
  g.seed({id:"x", type:"invoice", base:"2611-009", no:"I2611-009", date:"2026-11-02", client:"消した", items:[item("a", 1)], deleted:true});
  const all = g.call("list_documents", {}).data;
  eq(all.count, 4, "削除済みは出ない");
  eq(g.call("list_documents", {type:"invoice"}).data.count, 3);
  eq(g.call("list_documents", {query:"山田"}).data.documents.map(d=>d.id), ["i1"]);
  eq(g.call("list_documents", {query:"i2611-002"}).data.documents.map(d=>d.id).sort(), ["i2"]);
  eq(g.call("list_documents", {status:"overdue"}).data.documents.map(d=>d.id), ["i1"]);
  eq(g.call("list_documents", {status:"unpaid"}).data.documents.map(d=>d.id).sort(), ["i1","i2"], "未入金は期限超過も含む");
  eq(g.call("list_documents", {status:"won"}).data.documents.map(d=>d.id), ["e1"]);
  eq(g.call("list_documents", {from:"2026-11-01", to:"2026-11-01"}).data.documents.map(d=>d.id).sort(), ["e1","i1"]);
  eq(g.call("list_documents", {limit:1}).data.documents.length, 1);
  eq(g.call("list_documents", {limit:1}).data.count, 4, "count は絞り込み後の総数");
  const one = all.documents.find(d=>d.id==="i1");
  eq([one.no, one.total, one.status], ["I2611-001", 1100, "overdue"]);
  ok(g.call("list_documents", {status:"bad"}).isError);
});

test("get_document：IDか書類No.で、関連書類つき", ()=>{
  const g = env();
  g.seed({id:"e1", type:"estimate", base:"2611-002", no:"Q2611-002", date:"2026-11-01", client:"佐藤", items:[item("a", 2000)], taxRate:"10"});
  g.seed({id:"i2", type:"invoice", base:"2611-002", no:"I2611-002", date:"2026-11-02", client:"佐藤", items:[item("a", 2000)], taxRate:"10"});
  const r = g.call("get_document", {no:"q2611-002"});
  ok(!r.isError, r.text);
  eq([r.data.document.id, r.data.document.total, r.data.document.status], ["e1", 2200, "won"]);
  eq(r.data.related.map(x=>x.no), ["I2611-002"]);
  eq(g.call("get_document", {id:"i2"}).data.document.no, "I2611-002");
  ok(g.call("get_document", {id:"none"}).isError);
  ok(g.call("get_document", {}).isError);
});

test("sales_report：前年同月比・未入金・手入力", ()=>{
  const g = env();
  g.api.putSettings_({salesManual:{"2025-11":33000}, salesGoal:"1000000"});
  g.seed({id:"i1", type:"invoice", base:"2611-001", no:"I2611-001", date:"2026-11-01", due:"2026-11-20", client:"A", items:[item("a", 100000)], taxRate:"10"});
  g.seed({id:"i0", type:"invoice", base:"2511-001", no:"I2511-001", date:"2025-11-05", due:"2025-12-05", client:"A", items:[item("a", 50000)], taxRate:"10", paid:true});
  const r = g.call("sales_report", {year:2026});
  ok(!r.isError, r.text);
  const nov = r.data.months.find(m=>m.key==="2026-11");
  eq([nov.cur, nov.prev], [110000, 88000]);
  eq(r.data.receivables.count, 1); eq(r.data.receivables.overdueCount, 1);
  eq(r.data.goal.target, 1000000);
  eq(r.data.year, 2026);
  eq(g.call("sales_report", {}).data.year, 2026, "既定は今年度");
  eq(g.call("sales_report", {basis:"sub", year:2026}).data.months.find(m=>m.key==="2026-11").cur, 100000);
});

test("message_text：LINE・メール・入金確認", ()=>{
  const g = env();
  g.api.putSettings_({company:"OCS", rep:"新垣", tel:"098-000", bank:"琉球銀行", bankType:"普通", bankNo:"123", bankName:"アラカキ"});
  g.seed({id:"i1", type:"invoice", base:"2611-001", no:"I2611-001", date:"2026-11-01", due:"2026-11-20", client:"A社", honor:"御中", subject:"清掃", items:[item("a", 10000)], taxRate:"10"});
  const r = g.call("message_text", {id:"i1", channel:"line"});
  ok(!r.isError, r.text);
  ok(r.data.text.startsWith("A社御中\n"), r.data.text);
  ok(r.data.text.includes("¥11,000") && r.data.text.includes("2026/11/20") && r.data.text.includes("琉球銀行　普通　123　アラカキ"), r.data.text);
  const m = g.call("message_text", {id:"i1", channel:"mail"}).data;
  eq(m.subject, "【ご請求書】清掃（OCS）"); ok(!m.body.startsWith("【"), "本文は件名行を除く");
  const rem = g.call("message_text", {id:"i1", channel:"line", reminder:true}).data.text;
  ok(rem.includes("ご入金の確認"), rem);
  ok(g.call("message_text", {id:"i1", channel:"fax"}).isError);
});

test("get_issuer_info：秘密の項目は返さない", ()=>{
  const g = env();
  g.api.putSettings_({company:"OCS", gasKey:"secret", gasUrl:"https://x", stamp:"data:image/png;base64,AAA", presets:"清掃,35000\nエアコン,8000"});
  const r = g.call("get_issuer_info", {});
  eq(r.data.company, "OCS");
  ok(!("gasKey" in r.data) && !("gasUrl" in r.data) && !("stamp" in r.data), "秘密なし");
  eq(r.data.presets, [{desc:"清掃", price:35000}, {desc:"エアコン", price:8000}]);
  ok(!r.text.includes("secret"));
});

test("不明なツールは isError", ()=>{
  const g = env();
  const r = g.call("delete_document", {id:"x"});
  ok(r.isError);
});

test("AI_KEY の作成・作り直し・停止", ()=>{
  const g = loadGas({now: NOW});
  const url = g.api.setupAI();
  ok(/\?ai=[0-9a-f]{32}$/.test(url), url);
  const k = g.store.AI_KEY;
  eq(g.api.setupAI(), url, "2回目は同じ");
  g.api.resetAIKey(); ok(g.store.AI_KEY && g.store.AI_KEY !== k, "作り直し");
  g.api.disableAI(); eq(g.store.AI_KEY, undefined);
});

test("AiShared.gs は index.html と一致（tools/build-gas.mjs --check）", ()=>{
  execFileSync(process.execPath, [path.join(here, "..", "tools", "build-gas.mjs"), "--check"], {stdio:"pipe"});
});

test("埋め込みGAS（コピー用）は単体で動く", ()=>{
  const html = fs.readFileSync(path.join(here, "..", "index.html"), "utf8");
  const src = html.match(/<script type="text\/plain" id="gasSrc">([\s\S]*?)<\/script>/)[1];
  const g = loadGas({src, now: NOW, props:{AI_KEY: KEY}});
  const r = g.post({jsonrpc:"2.0", id:1, method:"tools/list"}, {ai: KEY});
  eq(r.result.tools.length, 10);
});

test("clasp は Code.generic.gs を送らない", ()=>{
  const ig = fs.readFileSync(path.join(GAS_DIR, "..", ".claspignore"), "utf8");
  ok(/Code\.generic\.gs/.test(ig));
  // Code.gs と AiShared.gs と Ai.gs を同時に読んでも定義の重複がない（上の各テストで確認済み）
});

// ===== 監査対応（v1.15.1） =====
test("頭文字・有効期限を空にした設定はそのまま使う（アプリと同じ）", ()=>{
  const g = env();
  g.api.putSettings_({prefixEst:"", prefixInv:"", estValid:""});
  const r = g.call("create_document", {type:"estimate", client:"a", items:[item("清掃", 1000)]});
  ok(!r.isError, r.text);
  eq(r.data.document.no, "2611-001");
  eq(g.doc(r.data.document.id).validText || "", "");
  const v = g.call("create_document", {type:"invoice", client:"b", items:[item("清掃", 1000)]});
  eq(v.data.document.no, "2611-002");
});
test("空の一括は Invalid Request", ()=>{
  const g = env();
  const r = g.post([], {ai: KEY});
  eq(r.error && r.error.code, -32600);
});
test("ロックが取れないときは JSON-RPC のエラー", ()=>{
  const g = env({lockBusy: true});
  const r = g.rpc("tools/list", {});
  eq(r.error && r.error.code, -32603);
});
test("認証されていない要求ではロックを取らない", ()=>{
  const calls = {n: 0};
  const g = env({lockCalls: calls});
  const r = g.rpc("tools/list", {}, "wrong");
  eq(r.error.code, -32001); eq(calls.n, 0);
  g.rpc("tools/list", {}); eq(calls.n, 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
