// node tests/bridge.mjs — mcp/redseal-mcp.mjs を、GASと同じくリダイレクトで返す模擬サーバーにつないで検証
import http from "node:http";
import path from "node:path";
import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
import {loadGas} from "./gas-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const g = loadGas({props:{AI_KEY:"k1"}});
const pending = new Map(); let seq = 0;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if(u.pathname === "/exec" && req.method === "POST"){
    let body = ""; req.on("data", c => body += c); req.on("end", () => {
      const out = g.api.doPost({postData:{contents:body}, parameter:Object.fromEntries(u.searchParams)});
      const id = String(++seq); pending.set(id, out.content);
      res.writeHead(302, {Location: "/echo?r=" + id}); res.end(); // GAS と同じく 302 で別URLへ
    });
  } else if(u.pathname === "/echo" && req.method === "GET"){
    res.writeHead(200, {"Content-Type":"application/json"}); res.end(pending.get(u.searchParams.get("r")) || "");
  } else { res.writeHead(404); res.end(); }
});
server.listen(0, async () => {
  const port = server.address().port;
  const run = (url, lines) => new Promise(resolve => {
    const p = spawn(process.execPath, [path.join(here, "..", "mcp", "redseal-mcp.mjs")], {env:{...process.env, REDSEAL_URL:url}});
    let out = ""; p.stdout.on("data", c => out += c);
    p.on("exit", code => resolve({code, lines: out.trim() ? out.trim().split("\n").map(l => JSON.parse(l)) : []}));
    for(const l of lines) p.stdin.write(l + "\n");
    p.stdin.end();
  });
  let failed = 0;
  const check = (name, cond) => { console.log((cond ? "ok   " : "FAIL ") + name); if(!cond) failed++; };
  const base = `http://127.0.0.1:${port}/exec?ai=`;
  const r = await run(base + "k1", [
    JSON.stringify({jsonrpc:"2.0", id:1, method:"initialize", params:{protocolVersion:"2025-06-18"}}),
    JSON.stringify({jsonrpc:"2.0", method:"notifications/initialized"}),
    JSON.stringify({jsonrpc:"2.0", id:2, method:"tools/list"}),
    "not json",
    JSON.stringify({jsonrpc:"2.0", id:3, method:"tools/call", params:{name:"create_document", arguments:{type:"invoice", client:"中継テスト", items:[{desc:"a", price:1000}]}}})
  ]);
  check("4件の返事（通知には返さない）", r.lines.length === 4);
  check("順番どおり", r.lines[0].id === 1 && r.lines[1].id === 2 && r.lines[2].id === null && r.lines[3].id === 3);
  check("initialize", r.lines[0].result && r.lines[0].result.serverInfo.name === "redseal");
  check("tools/list", r.lines[1].result && r.lines[1].result.tools.length === 10);
  check("parse error", r.lines[2].error && r.lines[2].error.code === -32700);
  check("作成できる", r.lines[3].result && !r.lines[3].result.isError);
  const bad = await run(base + "wrong", [JSON.stringify({jsonrpc:"2.0", id:9, method:"tools/list"})]);
  check("キー違いはエラー", bad.lines[0].error && bad.lines[0].error.code === -32001);
  const down = await run(`http://127.0.0.1:${port}/nothing?ai=k1`, [JSON.stringify({jsonrpc:"2.0", id:7, method:"ping"})]);
  check("つながらないときは -32603", down.lines[0].error && down.lines[0].error.code === -32603 && down.lines[0].id === 7);
  const nourl = await run("", []);
  check("URLなしは終了コード1", nourl.code === 1);
  server.close();
  console.log(failed ? `\n${failed} failed` : "\nall passed");
  process.exit(failed ? 1 : 0);
});
