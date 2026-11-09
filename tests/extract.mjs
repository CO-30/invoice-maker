// index.html から純粋関数（calc / parseInvoicePdfText / parseIssuerPdfText など）を切り出して評価する
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(here, "..", "index.html");

export function extractFns(names){
  const src = fs.readFileSync(INDEX, "utf8");
  const out = {};
  for(const name of names){
    const re = new RegExp("^function "+name+"\\([^)]*\\)\\{[\\s\\S]*?^\\}$", "m");
    const m = src.match(re);
    if(!m) throw new Error("not found: "+name);
    out[name] = new Function(m[0]+"\nreturn "+name+";")();
  }
  return out;
}

// 帳票描画など、周辺の定義に依存する関数をスタブ付きで切り出す
export function extractWith(names, prelude){
  const src = fs.readFileSync(INDEX, "utf8");
  let body = prelude+"\n";
  for(const name of names){
    const re = new RegExp("^function "+name+"\\([^)]*\\)\\{[\\s\\S]*?^\\}$", "m");
    const m = src.match(re);
    if(!m) throw new Error("not found: "+name);
    body += m[0]+"\n";
  }
  return new Function(body+"\nreturn {"+names.join(",")+"};")();
}
