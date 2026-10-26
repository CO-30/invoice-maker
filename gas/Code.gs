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
// PDFの保存先（種別ごと）。IDを空にするとスプレッドシートと同じ場所に自動でフォルダを作ります
const PDF_FOLDERS = {
  estimate: "1eh0_UxpRyQfE1uUSZK5DtXhldbhYW-dg", // 見積
  invoice:  "1fwWjgv4k2GfkLi4AXHZnuzQ_XYkwO-V_", // 請求書
  receipt:  ""                                   // 領収書（空なら「領収書」フォルダを自動作成）
};
const PDF_FOLDER_NAMES = {estimate:"見積", invoice:"請求書", receipt:"領収書"};
// 既存のExcel（お見積書.xlsx／請求書.xlsx など）が入っているGoogleドライブのフォルダID
// フォルダを開いたときのURL https://drive.google.com/drive/folders/【ここ】 の部分
const IMPORT_FOLDER_IDS = [
  "1eh0_UxpRyQfE1uUSZK5DtXhldbhYW-dg", // 見積
  "1fwWjgv4k2GfkLi4AXHZnuzQ_XYkwO-V_"  // 請求書
];

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
      case "import":      return out_(importFromDrive_());
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

function pdfFolder_(type){
  const id = PDF_FOLDERS[type];
  if(id){ try{ return DriveApp.getFolderById(id); }catch(e){} }
  // 指定なし／開けない → スプレッドシートと同じ場所に種別名のフォルダを作る
  const file = DriveApp.getFileById(ss_().getId());
  const parents = file.getParents(); const parent = parents.hasNext()?parents.next():DriveApp.getRootFolder();
  const name = PDF_FOLDER_NAMES[type] || "書類PDF";
  const it = parent.getFoldersByName(name);
  return it.hasNext()?it.next():parent.createFolder(name);
}
function savePdf_(req){
  const bytes = Utilities.base64Decode(req.data);
  const blob = Utilities.newBlob(bytes, "application/pdf", req.name||"document.pdf");
  const folder = pdfFolder_(req.type || "invoice");
  // 同名ファイルがあれば上書き相当（古いものをゴミ箱へ）
  const old = folder.getFilesByName(blob.getName()); while(old.hasNext()) old.next().setTrashed(true);
  const f = folder.createFile(blob);
  if(req.id){ const ex = readAll_().find(r=>r.id===req.id); if(ex) docsSheet_().getRange(ex._row, DOC_COLS.indexOf("pdfUrl")+1).setValue(f.getUrl()); }
  return f.getUrl();
}


/* ===================== 既存Excelの取り込み ===================== */
/**
 * IMPORT_FOLDER_IDS 内の .xlsx を読み、シートごとに1書類として docs に追加する。
 * 一度取り込んだシートは imports シートに記録し、二重取り込みしない。
 * Apps Script エディタから importFromDrive_ を直接実行しても、アプリの「ドライブから取り込み」からでも動く。
 * 毎日自動で取り込みたい場合は、トリガー（時計アイコン）で importFromDrive_ を日次に設定。
 */
function importFromDrive_(){
  const log = sheet_("imports", ["sourceKey","file","sheet","docId","importedAt"]);
  const done = new Set(log.getDataRange().getValues().slice(1).map(r=>r[0]));
  let added = 0, files = 0, skipped = 0, errors = [];
  IMPORT_FOLDER_IDS.forEach(fid=>{
    let folder; try{ folder = DriveApp.getFolderById(fid); }catch(e){ errors.push("フォルダが開けません: "+fid); return; }
    const it = folder.getFilesByType(MimeType.MICROSOFT_EXCEL);
    while(it.hasNext()){
      const f = it.next(); files++;
      let tmpId = null;
      try{
        tmpId = convertToSheet_(f.getId());
        const ss = SpreadsheetApp.openById(tmpId);
        ss.getSheets().forEach(sh=>{
          const key = f.getId()+"#"+sh.getName();
          if(done.has(key)){ skipped++; return; }
          const d = parseSheet_(sh, f.getName());
          if(!d){ return; }
          upsertDoc_(d);
          log.appendRow([key, f.getName(), sh.getName(), d.id, new Date()]);
          done.add(key); added++;
        });
      }catch(e){ errors.push(f.getName()+": "+e); }
      finally{ if(tmpId){ try{ DriveApp.getFileById(tmpId).setTrashed(true); }catch(e){} } }
    }
  });
  return {ok:true, added:added, files:files, skipped:skipped, errors:errors};
}
// xlsx → 一時的なGoogleスプレッドシートに変換（Drive REST API）
function convertToSheet_(fileId){
  const res = UrlFetchApp.fetch("https://www.googleapis.com/drive/v3/files/"+fileId+"/copy", {
    method:"post", contentType:"application/json",
    headers:{Authorization:"Bearer "+ScriptApp.getOAuthToken()},
    payload: JSON.stringify({name:"_tmp_import", mimeType:"application/vnd.google-apps.spreadsheet"}),
    muteHttpExceptions:true
  });
  if(res.getResponseCode()>=300) throw new Error("変換失敗 "+res.getContentText());
  return JSON.parse(res.getContentText()).id;
}
// シート1枚 → 書類オブジェクト（お見積書.xlsx／請求書.xlsx のレイアウト）
function parseSheet_(sh, fileName){
  const v = sh.getRange("A1:O45").getValues();
  const cell = (a1)=>{ const m=a1.match(/([A-Z]+)(\d+)/); const col=m[1].split("").reduce((a,c)=>a*26+c.charCodeAt(0)-64,0)-1; return v[+m[2]-1][col]; };
  const title = String(cell("A1")||"").replace(/\s/g,"");
  let type;
  if(title.indexOf("見積")>=0) type="estimate"; else if(title.indexOf("請求")>=0) type="invoice"; else if(title.indexOf("領収")>=0) type="receipt"; else return null;
  const client = String(cell("A3")||"").trim(); if(!client) return null;
  const honor = String(cell("H3")||"御中").trim();
  const no = cell("N3"); const dateV = cell("N4");
  const contact = String(cell("D4")||"").trim();
  const subject = String(cell("C6")||"").trim();
  // 明細：見積は18行目から、請求は16行目から。「小計」の行まで
  const startRow = type==="estimate" ? 18 : 16;
  const items = [];
  for(let r=startRow; r<=startRow+24; r++){
    const row = v[r-1]; if(!row) break;
    if(String(row[9])==="小計") break;
    const desc = String(row[1]||"").trim(); const qty=row[9], unit=String(row[10]||"").trim(), price=row[11];
    if(!desc && !price) continue;
    items.push({date:"", desc:desc, qty: qty===""||qty==null ? 1 : Number(qty), unit:unit, price: price===""||price==null ? "" : Number(price)});
  }
  // 税率：小計と消費税から逆算（税抜版は0%）
  let taxRate = "10";
  const findTax = ()=>{ for(let r=28;r<=42;r++){ const row=v[r-1]; if(row && String(row[9]).indexOf("消費税")>=0) return row[11]; } return null; };
  const taxV = findTax(); if(taxV===""||taxV==null||Number(taxV)===0) taxRate="0";
  const date = dateV instanceof Date ? Utilities.formatDate(dateV,"Asia/Tokyo","yyyy-MM-dd") : "";
  const validText = type==="estimate" ? String(cell("C12")||"").trim() : "";
  const id = "imp_"+Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, fileName+"#"+sh.getName())).slice(0,12);
  const ym = date ? date.slice(2,4)+date.slice(5,7) : "0000";
  return {id:id, type:type, base: ym+"-"+String(no||"").slice(-3).padStart(3,"0"), rev:1, no: String(no||""),
    date:date, due:"", validText:validText, client:client, honor:honor, contact:contact, subject:subject,
    items:items.length?items:[{date:"",desc:"",qty:1,unit:"",price:""}], taxRate:taxRate, rounding:"floor", layout:"simple",
    memo:"Excelから取込："+fileName+" / "+sh.getName(), imported:true,
    createdAt: date ? new Date(date).getTime() : Date.now(), updatedAt: Date.now()};
}
