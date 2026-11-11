// node tests/feedback.mjs — 共通の要望受付（feedback/Code.gs）を、Googleのサービスを模して検証
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import {fileURLToPath} from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "feedback", "Code.gs"), "utf8");

let passed=0, failed=0;
function ok(c,msg){ if(!c) throw new Error(msg||"assert"); }
function test(name, fn){ try{ fn(); passed++; console.log("ok   "+name); }catch(e){ failed++; console.log("FAIL "+name+"\n     "+e.message); } }

function env(){
  const rows=[], mails=[], cache={}, props={};
  const sh={ appendRow:r=>rows.push(r), setFrozenRows(){}, getRange:()=>({setFontWeight(){return this},setBackground(){return this},setDataValidation(){return this}}), setColumnWidth(){},
    getDataRange:()=>({getValues:()=>rows.map(r=>r.slice())}) };
  const ss={ getSheetByName:()=>rows.length?sh:null, insertSheet:()=>sh, getUrl:()=>"https://sheet" };
  const dv={ requireValueInList(){return this}, setAllowInvalid(){return this}, build(){return {}} };
  const ctx={
    SpreadsheetApp:{ getActiveSpreadsheet:()=>ss, newDataValidation:()=>dv },
    MailApp:{ sendEmail:(to,sub,body)=>mails.push({to,sub,body}) },
    Session:{ getEffectiveUser:()=>({getEmail:()=>"me@example.com"}), getScriptTimeZone:()=>"Asia/Tokyo" },
    LockService:{ getScriptLock:()=>({waitLock(){},releaseLock(){}}) },
    CacheService:{ getScriptCache:()=>({get:k=>cache[k]??null, put:(k,v)=>{cache[k]=v;}}) },
    PropertiesService:{ getScriptProperties:()=>({getProperty:k=>props[k]??null, setProperty:(k,v)=>{props[k]=v;}}) },
    ScriptApp:{ WeekDay:{MONDAY:"MONDAY"}, getProjectTriggers:()=>[] },
    Utilities:{ formatDate:(d,tz,f)=>f==="yyyyMMdd"?"20261112":(d.getMonth()+1)+"/"+d.getDate() },
    ContentService:{ createTextOutput:t=>({t,setMimeType(){return this}}), MimeType:{JSON:"json"} },
    console, Date, JSON, String, Array, Object, Math
  };
  vm.createContext(ctx); vm.runInContext(src, ctx);
  return {ctx, rows, mails, cache, props};
}
const sample={app:"REDSEAL",version:"1.14.0",kind:"不具合",text:"同期できない",reply:"",deviceId:"d1",
  env:{device:"iPhone 18.1",standalone:true,screen:"390x844",path:"/invoice-maker/"},
  log:[{t:"08:20:01",a:"押した: ⚙設定"},{t:"08:20:05",a:"押した: 接続テスト #btnSyncTest"}],
  errors:[{t:"08:20:06",m:"表示: 接続できません: Load failed"}], context:{同期:"設定済み"}};

test("受け付けるとシートに1行・通知メール1通", ()=>{ const E=env(); const r=E.ctx.receive_(sample);
  ok(r.ok,"ok"); ok(E.rows.length===2,"header+1 row: "+E.rows.length); const row=E.rows[1];
  ok(row[1]==="REDSEAL"&&row[3]==="不具合"&&row[4]==="同期できない"&&row[10]==="未対応","row "+JSON.stringify(row.slice(1,11)));
  ok(/接続テスト/.test(row[7])&&/Load failed/.test(row[8]),"log/err columns");
  ok(E.mails.length===1&&/【REDSEAL】不具合：同期できない/.test(E.mails[0].sub)&&E.mails[0].to==="me@example.com","mail "+JSON.stringify(E.mails[0]&&E.mails[0].sub));
  ok(/直前の操作/.test(E.mails[0].body)&&/Load failed/.test(E.mails[0].body),"mail body"); });
test("アプリ名・本文がなければ受け付けない", ()=>{ const E=env();
  ok(E.ctx.receive_({...sample,app:""}).error==="app required"); ok(E.ctx.receive_({...sample,text:"  "}).error==="text required"); ok(E.rows.length===0); });
test("1台からの送信回数に上限", ()=>{ const E=env(); let last;
  for(let i=0;i<21;i++) last=E.ctx.receive_(sample); ok(last.error==="too many","21件目は拒否"); ok(E.rows.length===21,"20件+見出し"); });
test("長すぎる本文・操作記録は切り詰め", ()=>{ const E=env(); E.ctx.receive_({...sample,text:"あ".repeat(5000),log:Array.from({length:100},(_,i)=>({t:"x",a:"押した "+i}))});
  ok(E.rows[1][4].length===2000,"text clipped"); ok(E.rows[1][7].split("\n").length===30,"log 30 lines"); });
test("壊れたJSONは bad json", ()=>{ const E=env(); const o=E.ctx.doPost({postData:{contents:"{"}}); ok(JSON.parse(o.t).error==="bad json"); });
test("週1まとめ：アプリ別の件数とAIに渡す用の文面", ()=>{ const E=env(); E.ctx.receive_(sample); E.ctx.receive_({...sample,app:"左官見積",kind:"要望",text:"単位に㎡がほしい",deviceId:"d2"});
  E.mails.length=0; E.ctx.weeklyDigest(); ok(E.mails.length===1,"1 mail"); const m=E.mails[0];
  ok(/今週 2件/.test(m.sub),m.sub); ok(/REDSEAL 1件/.test(m.body)&&/左官見積 1件/.test(m.body),"per app"); ok(/AIに渡す用/.test(m.body)&&/単位に㎡がほしい/.test(m.body),"ai block");
  E.mails.length=0; E.rows.forEach((r,i)=>{ if(i) r[10]="完了"; }); E.ctx.weeklyDigest(); ok(E.mails.length===0,"何もなければ送らない"); });

test("数式として扱われる文字は ' を付けて文字のまま保存", ()=>{ const E=env(); E.ctx.receive_({...sample,text:'=IMPORTDATA("https://x")',reply:"+81",version:"-1"});
  const r=E.rows[1]; ok(r[4]==="'=IMPORTDATA(\"https://x\")"&&r[5]==="'+81"&&r[2]==="'-1", JSON.stringify(r.slice(2,6))); });
test("端末IDを変えても全体の上限で止まる", ()=>{ const E=env(); let last;
  for(let i=0;i<201;i++) last=E.ctx.receive_({...sample,deviceId:"x"+i}); ok(last.error==="too many"); ok(E.rows.length===201); });
test("通知メールは1日の上限まで", ()=>{ const E=env(); for(let i=0;i<60;i++) E.ctx.receive_({...sample,deviceId:"y"+i}); ok(E.mails.length===50, "mails "+E.mails.length); });
test("まとめの送信に失敗したら次回に持ち越す", ()=>{ const E=env(); E.ctx.receive_(sample); E.mails.length=0;
  const orig=E.ctx.MailApp.sendEmail; E.ctx.MailApp.sendEmail=()=>{ throw new Error("quota"); };
  let threw=false; try{ E.ctx.weeklyDigest(); }catch(e){ threw=true; } ok(threw&&!E.props.lastDigest,"not recorded");
  E.ctx.MailApp.sendEmail=orig; E.ctx.weeklyDigest(); ok(E.mails.length===1&&/今週 1件/.test(E.mails[0].sub), "carried over"); });
test("受付内部のエラーは server busy を返す", ()=>{ const E=env(); E.ctx.LockService.getScriptLock=()=>({waitLock(){ throw new Error("timeout"); },releaseLock(){}});
  ok(JSON.parse(E.ctx.doPost({postData:{contents:JSON.stringify(sample)}}).t).error==="server busy"); });

console.log(`\n${passed} passed, ${failed} failed`); if(failed) process.exit(1);
