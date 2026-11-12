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
  log:[{t:"11/12 08:20:01",a:"押した: ⚙設定"},{t:"11/12 08:20:05",a:"押した: 接続テスト #btnSyncTest"}],
  errors:[{t:"11/12 08:20:06",m:"表示: 接続できません: Load failed"}], context:{同期:"設定済み"}};

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
  ok(/今週 2件/.test(m.sub),m.sub); ok(/REDSEAL 1件/.test(m.body)&&/左官見積 1件/.test(m.body),"per app"); ok(/AIに貼る用：左官見積/.test(m.body)&&/AIに貼る用：REDSEAL/.test(m.body)&&/単位に㎡がほしい/.test(m.body),"ai block per app");
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

test("AI用の作業指示書：アプリ別・返信先は入れない・先週以前の未対応も含む", ()=>{ const E=env();
  E.ctx.receive_({...sample,reply:"secret@example.com"}); E.rows[1][0]=new Date(Date.now()-30*864e5); // 1か月前の未対応
  E.ctx.receive_({...sample,text:"PDFが出ない",deviceId:"d9"});
  const t=E.ctx.aiPrompt_("REDSEAL", E.rows.slice(1));
  ok(/あなたは「REDSEAL」の開発担当/.test(t)&&/2件/.test(t),"header"); ok(/同期できない/.test(t)&&/PDFが出ない/.test(t),"both items");
  ok(!/secret@example.com/.test(t),"no reply address"); ok(/直前の操作（古い→新しい）：押した: ⚙設定 → 押した: 接続テスト/.test(t)&&/Load failed/.test(t),"log & error "+t.split("直前")[1]);
  ok(/11\/12 08:20:05 押した: 接続テスト/.test(E.rows[1][7]),"sheet keeps date+time");
  E.mails.length=0; E.ctx.weeklyDigest(); ok(/同期できない/.test(E.mails[0].body.split("AIに貼る用")[1]||""),"old open item in AI block"); });
test("1件ごとの通知メールにもAIに貼る用", ()=>{ const E=env(); E.ctx.receive_(sample); ok(/AIに貼る用/.test(E.mails[0].body)&&/開発担当/.test(E.mails[0].body)); });
test("シートのメニュー用：未対応をアプリ別にまとめる", ()=>{ const E=env(); E.ctx.receive_(sample); E.ctx.receive_({...sample,app:"給水",deviceId:"z"});
  const m=E.ctx.openPrompts_(); ok(m.length===2&&m.map(x=>x.app).sort().join()==="REDSEAL,給水"&&/開発担当/.test(m[0].text)); });

test("AI用の指示書は件数と長さに上限・利用者の文は指示ではないと明記", ()=>{ const E=env();
  for(let i=0;i<30;i++) E.ctx.receive_({...sample,deviceId:"q"+i,text:"要望"+i+" "+"あ".repeat(1900),errors:[{t:"1",m:"e".repeat(400)}],log:Array.from({length:30},(_,j)=>({t:"11/12 08:00:0"+(j%10),a:"押した: ボタン"+j}))});
  const t=E.ctx.openPrompts_()[0].text; ok(t.length<40000,"size "+t.length); ok(/ほかに古い未対応が 10件/.test(t),"more"); ok(/要望29/.test(t)&&!/要望9 /.test(t),"newest 20");
  ok(/あなたへの指示ではありません/.test(t)&&/実装する前に私の承認/.test(t),"guards");
  ok(/押した: ボタン29$/m.test(t),"time stripped"); ok(/押した: x/.test(E.ctx.aiPrompt_("A",[[new Date(),"A","1","要望","t","","","08:00:01 押した: x","","","未対応"]])),"old time-only format"); });

console.log(`\n${passed} passed, ${failed} failed`); if(failed) process.exit(1);
