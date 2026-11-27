// node tools/build-gas.mjs          … gas/AiShared.gs と index.html の埋め込みGAS（コピー用）を作り直す
// node tools/build-gas.mjs --check  … 作り直しが必要なら失敗（テスト用）
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = path.join(root, "index.html");
const SHARED = path.join(root, "gas", "AiShared.gs");
const check = process.argv.includes("--check");

// AI連携（gas/Ai.gs）が使う、アプリと同じ計算の関数。index.html が正本
const FNS = ["calc","fyMonths","caseKey","linked","superseded","latestDocs","salesDocs","docStatus","salesStats","receivables","estimateStats"];

const html = fs.readFileSync(INDEX, "utf8");
const parts = FNS.map(name => {
  const m = html.match(new RegExp("^function "+name+"\\([^)]*\\)\\{[\\s\\S]*?^\\}$", "m"));
  if(!m) throw new Error("index.html に見つかりません: "+name);
  return m[0];
});
const shared = "/**\n * REDSEAL AI連携の共通計算（自動生成：node tools/build-gas.mjs）\n * index.html の同名関数のコピーです。ここは直接直さず、index.html を直してから作り直してください。\n */\n" + parts.join("\n") + "\n";

const gasSrc = [fs.readFileSync(path.join(root, "gas", "Code.generic.gs"), "utf8"), shared, fs.readFileSync(path.join(root, "gas", "Ai.gs"), "utf8"), fs.readFileSync(path.join(root, "gas", "Api.gs"), "utf8")].join("\n");
if(/<\/script/i.test(gasSrc)) throw new Error("GASのコードに </script が含まれています");
const re = /(<script type="text\/plain" id="gasSrc">)([\s\S]*?)(<\/script>)/;
if(!re.test(html)) throw new Error("index.html に gasSrc がありません");
const html2 = html.replace(re, (m, a, b, c) => a + gasSrc + c);

const cur = fs.existsSync(SHARED) ? fs.readFileSync(SHARED, "utf8") : "";
const stale = [];
if(cur !== shared) stale.push("gas/AiShared.gs");
if(html2 !== html) stale.push("index.html（埋め込みGAS）");
if(check){
  if(stale.length){ console.error("作り直しが必要: "+stale.join("、")+" → node tools/build-gas.mjs"); process.exit(1); }
  console.log("ok: 最新です");
} else {
  fs.writeFileSync(SHARED, shared);
  fs.writeFileSync(INDEX, html2);
  console.log(stale.length ? "更新: "+stale.join("、") : "変更なし");
}
