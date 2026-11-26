#!/usr/bin/env node
// REDSEAL のAI連携（パソコン用の中継）。Claude デスクトップ・Claude Code などの「stdio」型MCPとして登録します。
// 中身は、AIからのメッセージを GAS のAI接続用URL（…/exec?ai=キー）へそのまま送り、返事を返すだけです（依存パッケージなし、Node 18以上）。
// 使い方：REDSEAL_URL="https://script.google.com/macros/s/…/exec?ai=…" node redseal-mcp.mjs
//         または node redseal-mcp.mjs "https://script.google.com/macros/s/…/exec?ai=…"
import readline from "node:readline";

const URL_ = process.env.REDSEAL_URL || process.argv[2] || "";
const TIMEOUT = Number(process.env.REDSEAL_TIMEOUT_MS) || 60000;
const log = (...a) => process.stderr.write("[redseal-mcp] " + a.join(" ") + "\n");
if(!/^https?:\/\//.test(URL_)){ log("AI接続用URLがありません。REDSEAL_URL を設定してください（GASで setupAI を実行すると表示されます）"); process.exit(1); }

const send = obj => process.stdout.write(JSON.stringify(obj) + "\n");
const idsOf = msg => (Array.isArray(msg) ? msg : [msg]).filter(m => m && m.id !== undefined).map(m => m.id);
function fail(msg, text){
  const ids = idsOf(msg); if(!ids.length) return; // 通知には返事をしない
  const errs = ids.map(id => ({jsonrpc:"2.0", id, error:{code:-32603, message:"REDSEALにつながりません: " + text}}));
  if(Array.isArray(msg)) send(errs); else send(errs[0]);
}

async function forward(line){
  let msg;
  try{ msg = JSON.parse(line); }catch(e){ send({jsonrpc:"2.0", id:null, error:{code:-32700, message:"Parse error"}}); return; }
  try{
    // GAS は返事を別URLへのリダイレクトで返す。fetch は自動でたどる
    const r = await fetch(URL_, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(msg), redirect:"follow", signal:AbortSignal.timeout(TIMEOUT)});
    const text = (await r.text()).trim();
    if(!r.ok){ fail(msg, "HTTP " + r.status); return; }
    if(!text) return; // 通知への返事なし
    let out;
    try{ out = JSON.parse(text); }catch(e){ fail(msg, "応答がJSONではありません（URLやデプロイの設定、Googleのログイン画面になっていないか確認してください）"); return; }
    send(out);
  }catch(e){ fail(msg, String(e && e.message || e)); }
}

// 順番を守って1件ずつ送る
let chain = Promise.resolve();
const rl = readline.createInterface({input: process.stdin});
rl.on("line", line => { if(line.trim()) chain = chain.then(() => forward(line)); });
rl.on("close", () => { chain.then(() => process.exit(0)); });
