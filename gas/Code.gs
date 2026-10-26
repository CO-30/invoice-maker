/**
 * 見積・請求書メーカー 同期用 Google Apps Script
 *
 * 設置手順
 * 1. Googleスプレッドシートを新規作成（名前は任意。例「見積請求データ」）
 * 2. 拡張機能 → Apps Script を開き、このコードを全て貼り付けて保存
 * 3. 下の API_KEY を好きな文字列に変える（アプリの設定画面に同じものを入れる）
 * 4. デプロイ → 新しいデプロイ → 種類「ウェブアプリ」
 *      実行ユーザー：自分 ／ アクセスできるユーザー：全員
 *    → デプロイ → 表示された「ウェブアプリのURL」をアプリの設定画面に貼る
 * 5. コードを変えたら「デプロイを管理 → 編集 → 新バージョン」で更新
 *
 * シートは自動で作られます：docs（書類）、settings（設定）
 * PDFはスプレッドシートと同じフォルダ内の「見積請求PDF」フォルダに保存されます
 */
const API_KEY = "change-me-1234";
const PDF_FOLDER_NAME = "見積請求PDF";

const DOC_COLS = ["id","type","base","no","date","due","client","honor","contact","subject","taxRate","rounding","layout","memo","sub","tax","total","createdAt","updatedAt","deleted","pdfUrl","json"];

function doGet(e){ return handle_(e); }
function doPost(e){ return handle_(e); }

function handle_(e){
  let req = {};
  try{
    if(e.postData && e.postData.contents) req = JSON.parse(e.postData.contents);
    else req = e.parameter || {};
  }catch(err){ return out_({ok:false,error:"bad json"}); }
  if(req.key !== API_KEY) return out_({ok:false,error:"unauthorized"});
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try{
    switch(req.action){
      case "ping":        return out_({ok:true, time:new Date().toISOString()});
      case "list":        return out_({ok:true, docs:listDocs_(req.since)});
      case "upsert":      return out_({ok:true, saved:(req.docs||[]).map(upsertDoc_)});
      case "delete":      return out_({ok:true, saved:deleteDoc_(req.id)});
      case "getSettings": return out_({ok:true, settings:getSettings_()});
      case "putSettings": putSettings_(req.settings||{}); return out_({ok:true});
      case "savePdf":     return out_({ok:true, url:savePdf_(req)});
      default:            return out_({ok:false,error:"unknown action"});
    }
  }catch(err){ return out_({ok:false,error:String(err)}); }
  finally{ lock.releaseLock(); }
}

function out_(obj){ return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }

function ss_(){ return SpreadsheetApp.getActiveSpreadsheet(); }
function sheet_(name, header){
  let sh = ss_().getSheetByName(name);
  if(!sh){ sh = ss_().insertSheet(name); sh.appendRow(header); sh.setFrozenRows(1); }
  return sh;
}
function docsSheet_(){ return sheet_("docs", DOC_COLS); }

function readAll_(){
  const sh = docsSheet_(); const vals = sh.getDataRange().getValues();
  const rows = []; for(let i=1;i<vals.length;i++){ const r={}; DOC_COLS.forEach((c,j)=>r[c]=vals[i][j]); r._row=i+1; rows.push(r); }
  return rows;
}
function listDocs_(since){
  since = Number(since||0);
  return readAll_().filter(r=>r.id && Number(r.updatedAt||0)>since).map(r=>{
    let d = {}; try{ d = JSON.parse(r.json||"{}"); }catch(e){}
    d.id = r.id; d.updatedAt = Number(r.updatedAt||0); d.deleted = r.deleted===true || r.deleted==="TRUE" || r.deleted===1;
    if(r.pdfUrl) d.pdfUrl = r.pdfUrl;
    return d;
  });
}
function rowOf_(d, existing){
  const c = calc_(d);
  return DOC_COLS.map(k=>{
    if(k==="json") return JSON.stringify(d);
    if(k==="sub") return c.sub; if(k==="tax") return c.tax; if(k==="total") return c.total;
    if(k==="deleted") return !!d.deleted;
    if(k==="pdfUrl") return d.pdfUrl || (existing&&existing.pdfUrl) || "";
    return d[k]===undefined||d[k]===null ? "" : d[k];
  });
}
function upsertDoc_(d){
  if(!d || !d.id) return null;
  const sh = docsSheet_(); const all = readAll_();
  const ex = all.find(r=>r.id===d.id);
  if(ex && Number(ex.updatedAt||0) > Number(d.updatedAt||0)) return {id:d.id, skipped:true}; // サーバー側が新しい
  const row = rowOf_(d, ex);
  if(ex) sh.getRange(ex._row,1,1,DOC_COLS.length).setValues([row]); else sh.appendRow(row);
  return {id:d.id, updatedAt:d.updatedAt};
}
function deleteDoc_(id){
  const sh = docsSheet_(); const ex = readAll_().find(r=>r.id===id); if(!ex) return null;
  const now = Date.now();
  sh.getRange(ex._row, DOC_COLS.indexOf("deleted")+1).setValue(true);
  sh.getRange(ex._row, DOC_COLS.indexOf("updatedAt")+1).setValue(now);
  return {id:id, updatedAt:now};
}
function calc_(d){
  const items = d.items||[]; const sub = items.reduce((a,i)=>a+(Number(i.qty)||0)*(Number(i.price)||0),0);
  const raw = sub*(Number(d.taxRate)||0)/100;
  const tax = d.rounding==="ceil"?Math.ceil(raw):d.rounding==="round"?Math.round(raw):Math.floor(raw);
  return {sub:sub,tax:tax,total:sub+tax};
}

function getSettings_(){
  const sh = sheet_("settings",["key","value","updatedAt"]); const vals = sh.getDataRange().getValues();
  if(vals.length<2) return null;
  try{ return JSON.parse(vals[1][1]); }catch(e){ return null; }
}
function putSettings_(s){
  const sh = sheet_("settings",["key","value","updatedAt"]);
  const row = ["settings", JSON.stringify(s), Date.now()];
  if(sh.getLastRow()>=2) sh.getRange(2,1,1,3).setValues([row]); else sh.appendRow(row);
}

function pdfFolder_(){
  const file = DriveApp.getFileById(ss_().getId());
  const parents = file.getParents(); const parent = parents.hasNext()?parents.next():DriveApp.getRootFolder();
  const it = parent.getFoldersByName(PDF_FOLDER_NAME);
  return it.hasNext()?it.next():parent.createFolder(PDF_FOLDER_NAME);
}
function savePdf_(req){
  const bytes = Utilities.base64Decode(req.data);
  const blob = Utilities.newBlob(bytes, "application/pdf", req.name||"document.pdf");
  const folder = pdfFolder_();
  // 同名ファイルがあれば上書き相当（古いものをゴミ箱へ）
  const old = folder.getFilesByName(blob.getName()); while(old.hasNext()) old.next().setTrashed(true);
  const f = folder.createFile(blob);
  if(req.id){ const ex = readAll_().find(r=>r.id===req.id); if(ex) docsSheet_().getRange(ex._row, DOC_COLS.indexOf("pdfUrl")+1).setValue(f.getUrl()); }
  return f.getUrl();
}
