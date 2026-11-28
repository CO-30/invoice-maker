// GAS のコード（gas/*.gs）を Node の vm で動かすための模擬環境。依存なし
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import {fileURLToPath} from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const GAS_DIR = path.join(here, "..", "gas");

function fakeSheet(name){
  const rows = [];
  const sh = {
    name, rows,
    appendRow(r){ rows.push(r.slice()); },
    setFrozenRows(){},
    getLastRow(){ return rows.length; },
    getDataRange(){ return {getValues:()=>rows.map(r=>r.slice())}; },
    getRange(row, col, nr, nc){
      return {
        setValues(vals){ for(let i=0;i<vals.length;i++){ const r = rows[row-1+i] || (rows[row-1+i]=[]); for(let j=0;j<vals[i].length;j++) r[col-1+j]=vals[i][j]; } },
        setValue(v){ const r = rows[row-1] || (rows[row-1]=[]); r[col-1]=v; }
      };
    }
  };
  return sh;
}

// files: 読み込む .gs（既定は Code.gs＋AiShared.gs＋Ai.gs）。src を渡すとその文字列を使う
export function loadGas({files=["Code.gs","AiShared.gs","Ai.gs","Api.gs"], src=null, now=null, props={}, lockBusy=false, lockCalls=null, apiKey=null} = {}){
  const sheets = {};
  const ss = {
    getSheetByName: n => sheets[n] || null,
    insertSheet: n => (sheets[n] = fakeSheet(n)),
    getId: () => "ss1"
  };
  const store = Object.assign({}, props);
  const RealDate = Date;
  const clock = {t: now};
  class FakeDate extends RealDate {
    constructor(...a){ if(a.length===0 && clock.t!=null) super(clock.t); else super(...a); }
    static now(){ return clock.t!=null ? clock.t : RealDate.now(); }
  }
  const ctx = {
    console,
    JSON, Math, Number, String, Array, Object, Set, Map, RegExp, Error, Boolean, isNaN, parseInt, parseFloat,
    Date: FakeDate,
    SpreadsheetApp: {getActiveSpreadsheet: () => ss},
    LockService: {getScriptLock: () => ({waitLock(){ if(lockBusy) throw new Error("Lock timeout"); }, tryLock(){ if(lockCalls) lockCalls.n++; return !lockBusy; }, releaseLock(){}})},
    ContentService: {
      MimeType: {JSON: "application/json"},
      createTextOutput: s => ({content: s, mime: null, setMimeType(m){ this.mime = m; return this; }})
    },
    PropertiesService: {getScriptProperties: () => ({
      getProperty: k => (k in store ? store[k] : null),
      setProperty: (k, v) => { store[k] = String(v); },
      deleteProperty: k => { delete store[k]; }
    })},
    ScriptApp: {getService: () => ({getUrl: () => "https://script.google.com/macros/s/TEST/exec"})},
    Logger: {log(){}},
    Utilities: {
      getUuid: (() => { let n = 0; return () => "1234abcd-1234-1234-1234-" + String(123456789000 + (++n)); })(),
      formatDate(d, tz, fmt){
        // Asia/Tokyo（+9時間）だけ対応
        const t = new RealDate(d.getTime() + 9*3600e3);
        const p = n => String(n).padStart(2, "0");
        return fmt.replace("yyyy", t.getUTCFullYear()).replace("MM", p(t.getUTCMonth()+1)).replace("dd", p(t.getUTCDate()));
      }
    }
  };
  vm.createContext(ctx);
  let code = src != null ? src : files.map(f => fs.readFileSync(path.join(GAS_DIR, f), "utf8")).join("\n");
  // apiKey：利用者が同期の合言葉を書き換えた状態を再現する
  if(apiKey != null) code = code.replace(/^const API_KEY = "[^"]*";/m, () => "const API_KEY = " + JSON.stringify(apiKey) + ";");
  const api = vm.runInContext(code + "\n;({doGet, doPost, setupAI: typeof setupAI==='function'?setupAI:null, resetAIKey: typeof resetAIKey==='function'?resetAIKey:null, disableAI: typeof disableAI==='function'?disableAI:null, setupApi: typeof setupApi==='function'?setupApi:null, upsertDoc_, putSettings_, listDocs_})", ctx);

  // JSON-RPC を送る（GAS のウェブアプリへの POST を模擬）
  function post(body, params={}){
    const out = api.doPost({postData: {contents: typeof body === "string" ? body : JSON.stringify(body)}, parameter: params});
    return out.content === "" ? null : JSON.parse(out.content);
  }
  return {api, sheets, store, clock, post};
}
