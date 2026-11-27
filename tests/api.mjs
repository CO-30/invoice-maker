// node tests/api.mjs — 外部連携API（REST・認証・Webhook・MCP）を通しで検証。依存なし
import {createHmac} from "node:crypto";
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {makeEnv, ADMIN, spec} from "./api-env.mjs";
import {ROUTES} from "../api/src/app.mjs";
import {deliver} from "../api/src/webhooks.mjs";

let passed=0, failed=0;
function eq(a,b,msg){ const A=JSON.stringify(a), B=JSON.stringify(b); if(A!==B) throw new Error((msg?msg+": ":"")+"expected "+B+" actual "+A); }
function ok(v,msg){ if(!v) throw new Error(msg||"not ok"); }
async function test(name, fn){ try{ await fn(); passed++; console.log("ok   "+name); }catch(e){ failed++; console.log("FAIL "+name+"\n     "+String(e.stack||e.message).replace(/\n/g,"\n     ")); } }
const NEW = {type:"estimate", client:"テスト工務店", subject:"清掃", items:[{description:"エアコン清掃", quantity:2, unit:"台", unit_price:8000}]};
async function setup(opts){ const t = makeEnv(opts); t.rw = (await t.issue("write")).key; t.ro = (await t.issue("read")).key; return t; }
const mk = async (t, extra={}) => (await t.req("POST","/api/v1/documents",{key:t.rw, body:{...NEW, ...extra}})).body.data;
const own = (t, d={}) => t.g.api.upsertDoc_({id:"own1", type:"invoice", base:"2611-050", rev:1, no:"I2611-050", date:"2026-11-01", client:"本人の客", items:[{desc:"x",qty:1,price:1000}], taxRate:"10", createdAt:1000, updatedAt:1000, ...d});

await test("health は認証不要、me は認証が必要", async()=>{
  const t = await setup();
  const h = await t.req("GET","/api/v1/health"); eq(h.status,200); eq(h.body.data.status,"ok");
  const n = await t.req("GET","/api/v1/me"); eq(n.status,401); eq(n.body.error.code,"unauthorized");
  ok(n.headers.get("WWW-Authenticate"));
  const m = await t.req("GET","/api/v1/me",{key:t.rw}); eq(m.body.data.scopes,["documents:read","documents:write"]);
  const x = await t.req("GET","/api/v1/me",{headers:{"X-API-Key":t.ro}}); eq(x.body.data.scopes,["documents:read"]);
  eq(t.gasCalls.length,0);
});
await test("キーはハッシュで保存し、再発行・無効化で古いキーは使えない", async()=>{
  const t = makeEnv(); const k = await t.issue("write");
  ok(!JSON.stringify([...t.storage.map]).includes(k.key), "平文が保存されている");
  const list = (await t.req("GET","/api/v1/keys",{key:ADMIN})).body.data; ok(!("key" in list[0]) && !("hash" in list[0]));
  const r = (await t.req("POST",`/api/v1/keys/${k.id}/rotate`,{key:ADMIN})).body.data;
  eq((await t.req("GET","/api/v1/me",{key:k.key})).status,401);
  eq((await t.req("GET","/api/v1/me",{key:r.key})).status,200);
  eq((await t.req("DELETE",`/api/v1/keys/${k.id}`,{key:ADMIN})).status,200);
  eq((await t.req("GET","/api/v1/me",{key:r.key})).status,401);
  eq((await t.req("POST",`/api/v1/keys/${k.id}/rotate`,{key:ADMIN})).status,404);
});
await test("管理はAPIキーでは不可。ADMIN_TOKEN が短ければ無効", async()=>{
  const t = await setup();
  eq((await t.req("GET","/api/v1/keys",{key:t.rw})).status,401);
  eq((await t.req("GET","/api/v1/me",{key:ADMIN})).status,401);
  const u = makeEnv({env:{ADMIN_TOKEN:"short"}}); eq((await u.req("GET","/api/v1/keys",{key:"short"})).status,503);
});
await test("read キーは書き込めない（403）", async()=>{
  const t = await setup();
  const r = await t.req("POST","/api/v1/documents",{key:t.ro, body:NEW}); eq(r.status,403); eq(r.body.error.code,"insufficient_scope");
  eq((await t.req("GET","/api/v1/documents",{key:t.ro})).status,200);
});
await test("作成→参照→更新→削除。時刻は ISO 8601 UTC、キーはGASのURLに出ない", async()=>{
  const t = await setup();
  const d = await mk(t); eq(d.total,17600); eq(d.ai_draft,true); eq(d.created_at,"2026-11-27T01:00:00.000Z"); eq(d.items[0].unit_price,8000);
  eq((await t.req("GET",`/api/v1/documents/${d.id}`,{key:t.ro})).body.data.number, d.number);
  t.clock.t += 1000;
  const p = await t.req("PATCH",`/api/v1/documents/${d.id}`,{key:t.rw, body:{subject:"清掃（追加）"}}); eq(p.status,200); eq(p.body.data.subject,"清掃（追加）");
  const del = await t.req("DELETE",`/api/v1/documents/${d.id}`,{key:t.rw}); eq(del.status,200); eq(del.body.data.deleted,true);
  eq((await t.req("GET",`/api/v1/documents/${d.id}`,{key:t.rw})).status,404);
  ok(t.gasCalls.every(c => !c.url.includes("?")));
});
await test("本人の書類は変更も削除もできない（409）。入金記録のある下書きも削除不可", async()=>{
  const t = await setup(); own(t);
  for(const [m,b] of [["PATCH",{subject:"x"}],["DELETE",undefined]]){ const r = await t.req(m,"/api/v1/documents/own1",{key:t.rw, body:b}); eq(r.status,409); eq(r.body.error.code,"not_editable"); }
  const d = await mk(t,{type:"invoice"});
  await t.req("POST",`/api/v1/documents/${d.id}/status`,{key:t.rw, body:{paid:true}});
  eq((await t.req("DELETE",`/api/v1/documents/${d.id}`,{key:t.rw})).status,409);
});
await test("変換・改訂・入金・文面・集計・発行者", async()=>{
  const t = await setup(); const e = await mk(t);
  const i = await t.req("POST",`/api/v1/documents/${e.id}/convert`,{key:t.rw, body:{}}); eq(i.status,201); eq(i.body.data.type,"invoice"); eq(i.body.data.case_number,e.case_number);
  const v = await t.req("POST",`/api/v1/documents/${e.id}/revise`,{key:t.rw, body:{subject:"再見積"}}); eq(v.body.data.revision,2);
  const s = await t.req("POST",`/api/v1/documents/${i.body.data.id}/status`,{key:t.rw, body:{paid:true, paid_at:"2026-11-27"}}); eq(s.body.data.status,"paid");
  ok((await t.req("GET",`/api/v1/documents/${e.id}/message?channel=mail`,{key:t.ro})).body.data.subject);
  eq((await t.req("GET","/api/v1/reports/sales?year=2026",{key:t.ro})).status,200);
  eq((await t.req("GET","/api/v1/issuer",{key:t.ro})).status,200);
});
await test("一覧：検索・絞り込み・ページ・差分（削除の印を含む）", async()=>{
  const t = await setup(); const a = await mk(t); await mk(t,{client:"別の客", type:"invoice"}); await mk(t,{client:"三人目"});
  const p = (await t.req("GET","/api/v1/documents?limit=2&offset=2",{key:t.ro})).body; eq(p.pagination,{limit:2,offset:2,total:3}); eq(p.data.length,1);
  eq((await t.req("GET","/api/v1/documents?q="+encodeURIComponent("別の"),{key:t.ro})).body.pagination.total,1);
  eq((await t.req("GET","/api/v1/documents?type=estimate",{key:t.ro})).body.pagination.total,2);
  t.clock.t += 60000; await t.req("DELETE",`/api/v1/documents/${a.id}`,{key:t.rw});
  const s = (await t.req("GET","/api/v1/documents?updated_since=2026-11-27T01:00:30Z",{key:t.ro})).body;
  eq(s.data.map(d=>[d.id,d.deleted]),[[a.id,true]]);
  eq((await t.req("GET","/api/v1/documents",{key:t.ro})).body.pagination.total,2);
  for(const bad of ["limit=0","limit=201","offset=-1","type=x","updated_since=yesterday","foo=1","from=2026/1/1"]) eq((await t.req("GET","/api/v1/documents?"+bad,{key:t.ro})).status,422,bad);
});
await test("エラー形式：404・405・400・422・413・502・503", async()=>{
  const t = await setup();
  const c = async (r, s, code) => { eq(r.status,s); eq(r.body.error.code,code); ok(r.body.error.message); };
  await c(await t.req("GET","/api/v1/nope",{key:t.rw}),404,"not_found");
  await c(await t.req("PUT","/api/v1/documents",{key:t.rw}),405,"method_not_allowed");
  await c(await t.req("POST","/api/v1/documents",{key:t.rw, body:"{"}),400,"invalid_json");
  await c(await t.req("POST","/api/v1/documents",{key:t.rw, body:{...NEW, aiDraft:false}}),422,"validation_error");
  await c(await t.req("POST","/api/v1/documents",{key:t.rw, body:{...NEW, items:[{desc:"x"}]}}),422,"validation_error");
  await c(await t.req("POST","/api/v1/documents",{key:t.rw, body:"x".repeat(100001)}),413,"payload_too_large");
  await c(await t.req("GET","/api/v1/documents/zzz",{key:t.rw}),404,"not_found");
  t.gasFail="before"; await c(await t.req("GET","/api/v1/documents",{key:t.rw}),502,"upstream_error");
  const b = await setup({lockBusy:true}); await c(await b.req("GET","/api/v1/documents",{key:b.rw}),503,"busy");
});
await test("https 必須・URLのキーは拒否", async()=>{
  const t = await setup();
  eq((await t.req("GET","/api/v1/me",{key:t.rw, base:"http://api.example.com"})).status,403);
  eq((await t.req("GET","/api/v1/me?api_key="+t.rw)).body.error.code,"key_in_url");
});
await test("GASの窓口：キー違い・GETは拒否", async()=>{
  const t = makeEnv();
  eq(t.g.post({action:"api", aiKey:"wrong", op:"list"}).code,"unauthorized");
  const r = JSON.parse(t.g.api.doGet({parameter:{action:"api", aiKey:"bridge-key", op:"list"}}).content); eq(r.ok,false);
  eq(t.g.post({action:"api", aiKey:"bridge-key", op:"constructor"}).ok,false);
});
await test("回数制限：429 と Retry-After（キーごと・認証失敗はIPごと）", async()=>{
  const t = makeEnv({env:{RATE_LIMIT_PER_MIN:"3", AUTH_FAIL_LIMIT_PER_MIN:"2"}}); const k = (await t.issue("read")).key;
  for(let i=0;i<3;i++) eq((await t.req("GET","/api/v1/me",{key:k})).status,200);
  const r = await t.req("GET","/api/v1/me",{key:k}); eq(r.status,429); eq(r.body.error.code,"rate_limited"); ok(+r.headers.get("Retry-After")>0);
  eq((await t.req("GET","/api/v1/me",{key:"rsk_bad"})).status,401);
  eq((await t.req("GET","/api/v1/me",{key:"rsk_bad"})).status,401);
  eq((await t.req("GET","/api/v1/me",{key:"rsk_bad"})).status,429);
  t.clock.t += 60000; eq((await t.req("GET","/api/v1/me",{key:k})).status,200);
});
await test("Idempotency-Key：再送は二重に作らない・内容違いは422・結果不明は409", async()=>{
  const t = await setup(); const send = (k, b=NEW) => t.req("POST","/api/v1/documents",{key:t.rw, body:b, headers:{"Idempotency-Key":k}});
  const a = await send("k1"), b = await send("k1"); eq(b.status,201); eq(b.body,a.body); eq(b.headers.get("Idempotency-Replayed"),"true");
  eq((await t.req("GET","/api/v1/documents",{key:t.rw})).body.pagination.total,1);
  eq((await send("k1",{...NEW, subject:"違う"})).body.error.code,"idempotency_key_reuse");
  // 1件目をGAS呼び出しで止めている間に、同じキーで2件目を送る
  let release; const gate = new Promise(r => release = r); let entered; const started = new Promise(r => entered = r);
  t.gate = async () => { entered(); await gate; };
  const first = send("k2"); await started; t.gate = null;
  const second = await send("k2"); eq(second.body.error.code,"idempotency_in_progress");
  release(); eq((await first).status,201);
  eq((await t.req("GET","/api/v1/documents",{key:t.rw})).body.pagination.total,2);
  t.gasFail="after"; eq((await send("k3")).status,502); t.gasFail=null;
  eq((await send("k3")).body.error.code,"idempotency_unknown");
  t.env.GAS_URL = ""; eq((await send("k4")).status,503);
});
await test("Webhook：登録前の分は通知せず、作成・更新・削除を署名付きで通知", async()=>{
  const t = await setup(); await mk(t);
  const h = (await t.req("POST","/api/v1/webhooks",{key:ADMIN, body:{url:"https://hooks.example.org/r"}})).body.data;
  ok(h.secret); eq(t.hooks.length,0);
  t.clock.t+=1000; const d = await mk(t);
  t.clock.t+=1000; await t.req("PATCH",`/api/v1/documents/${d.id}`,{key:t.rw, body:{subject:"y"}});
  t.clock.t+=1000; await t.req("DELETE",`/api/v1/documents/${d.id}`,{key:t.rw});
  const ev = t.hooks.map(x => JSON.parse(x.init.body)); eq(ev.map(e=>e.type),["document.created","document.updated","document.deleted"]);
  ok(!t.hooks[0].init.body.includes("テスト工務店"), "宛名は送らない");
  for(const x of t.hooks) eq(x.init.headers["X-Signature"], "sha256="+createHmac("sha256",h.secret).update(x.init.body).digest("hex"));
  ok(!("secret" in (await t.req("GET","/api/v1/webhooks",{key:ADMIN})).body.data[0]));
});
await test("Webhook：失敗は時間をおいて再送し、6回で打ち切る", async()=>{
  const t = await setup(); await t.req("POST","/api/v1/webhooks",{key:ADMIN, body:{url:"https://hooks.example.org/r", events:["document.created"]}});
  t.hookStatus = 500; t.clock.t+=1000; await mk(t); eq(t.hooks.length,1);
  await deliver(t.store, t.fetcher); eq(t.hooks.length,1);
  for(let i=0;i<10;i++){ t.clock.t += 6*3600e3; await deliver(t.store, t.fetcher); }
  eq(t.hooks.length,6); eq(new Set(t.hooks.map(x=>JSON.parse(x.init.body).id)).size,1);
});
await test("Webhook：危ないURLは拒否", async()=>{
  const t = makeEnv();
  for(const url of ["http://example.org/a","https://localhost/a","https://127.0.0.1/a","https://[::1]/a","https://192.168.0.1/","https://2130706433/","https://nas.local/","https://u:p@example.org/","x"])
    eq((await t.req("POST","/api/v1/webhooks",{key:ADMIN, body:{url}})).status,422,url);
});
await test("MCP：認証・ツール一覧・呼び出し・read キーの制限", async()=>{
  const t = await setup(); const rpc = (key, method, params, id=1) => t.req("POST","/mcp",{key, body:{jsonrpc:"2.0", id, method, params}});
  eq((await rpc(null,"tools/list")).status,401);
  eq((await rpc(t.rw,"initialize",{protocolVersion:"2025-06-18"})).body.result.serverInfo.name,"redseal");
  const rw = (await rpc(t.rw,"tools/list")).body.result.tools.map(x=>x.name); eq(rw.length,11); ok(rw.includes("delete_draft"));
  const ro = (await rpc(t.ro,"tools/list")).body.result.tools.map(x=>x.name); ok(!ro.includes("create_document") && !ro.includes("delete_draft"));
  const no = await rpc(t.ro,"tools/call",{name:"create_document", arguments:{type:"estimate", client:"a", items:[{desc:"x",price:1}]}}); eq(no.body.result.isError,true);
  const c = await rpc(t.rw,"tools/call",{name:"create_document", arguments:{type:"estimate", client:"a", items:[{desc:"x",price:1}]}}); ok(!c.body.result.isError);
  const id = c.body.result.structuredContent.document.id;
  eq((await rpc(t.rw,"tools/call",{name:"delete_draft", arguments:{id}})).body.result.structuredContent.deleted,true);
  eq((await t.req("POST","/mcp",{key:t.rw, body:{jsonrpc:"2.0", method:"notifications/initialized"}})).status,202);
  eq((await t.req("GET","/mcp",{key:t.rw})).status,405);
  eq((await t.req("POST","/mcp",{key:t.rw, headers:{Origin:"https://evil.example"}, body:{}})).status,403);
});
await test("CORS は許可した Origin だけ", async()=>{
  const t = makeEnv();
  const a = await t.req("OPTIONS","/api/v1/keys",{headers:{Origin:"https://co-30.github.io"}}); eq(a.headers.get("Access-Control-Allow-Origin"),"https://co-30.github.io");
  const b = await t.req("OPTIONS","/api/v1/keys",{headers:{Origin:"https://evil.example"}}); eq(b.headers.get("Access-Control-Allow-Origin"),null);
});
await test("openapi.json：3.1・全ルートを記載・参照切れなし・生成物が最新", async()=>{
  const t = makeEnv(); const r = await t.req("GET","/openapi.json"); eq(r.status,200); eq(r.body.openapi,"3.1.0"); eq(r.body.servers[0].url,"https://api.example.com");
  for(const [m,p] of ROUTES) ok(spec.paths[p]?.[m.toLowerCase()], m+" "+p);
  ok(spec.paths["/mcp"].post);
  for(const [,ref] of JSON.stringify(spec).matchAll(/"\$ref":"#\/([^"]+)"/g)) ok(ref.split("/").reduce((o,k)=>o?.[k], spec), ref);
  execFileSync(process.execPath, [fileURLToPath(new URL("../tools/build-openapi.mjs", import.meta.url)), "--check"], {stdio:"pipe"});
});

await test("監査対応：文字列の数量は数値で返す・失注の下書きは削除不可", async()=>{
  const t = await setup(); own(t,{items:[{desc:"x",qty:"2",price:"1,000"}]});
  const d = (await t.req("GET","/api/v1/documents/own1",{key:t.ro})).body.data; eq([d.items[0].quantity,d.items[0].unit_price],[2,1000]);
  const e = await mk(t); await t.req("POST",`/api/v1/documents/${e.id}/status`,{key:t.rw, body:{lost:true}});
  eq((await t.req("DELETE",`/api/v1/documents/${e.id}`,{key:t.rw})).status,409);
});
await test("監査対応：MCPの結果不明は再実行を止める・控えに失敗したWebhookは登録しない・古いpendingは結果不明", async()=>{
  const t = await setup(); t.gasFail="before";
  eq((await t.req("POST","/api/v1/webhooks",{key:ADMIN, body:{url:"https://hooks.example.org/r"}})).status,502);
  eq((await t.store.listHooks()).length,0);
  t.gasFail=null; await t.req("POST","/mcp",{key:t.rw, body:{jsonrpc:"2.0",id:1,method:"tools/list"}});
  const real = t.env.GAS_URL;
  let calls = 0; t.gate = async()=>{ if(++calls===2) throw new Error("timeout"); };
  const r = await t.req("POST","/mcp",{key:t.rw, body:{jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"create_document",arguments:{type:"estimate",client:"a",items:[{desc:"x",price:1}]}}}});
  ok(r.body.result.content[0].text.includes("やり直さないで"), r.body.result.content[0].text); ok(real);
  await t.store.idemBegin("p","f"); t.clock.t += 4*60e3; eq((await t.store.idemBegin("p","f")).state,"unknown");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed?1:0);
