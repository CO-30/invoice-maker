// node tests/run.mjs  — 依存パッケージなし
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {extractFns, extractWith} from "./extract.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const load = name => JSON.parse(fs.readFileSync(path.join(here, "fixtures", name+".json"), "utf8"));

let passed=0, failed=0;
function eq(a,b,msg){ const A=JSON.stringify(a), B=JSON.stringify(b); if(A!==B) throw new Error((msg?msg+": ":"")+"\n  expected "+B+"\n  actual   "+A); }
function test(name, fn){ try{ fn(); passed++; console.log("ok   "+name); }catch(e){ failed++; console.log("FAIL "+name+"\n     "+String(e.message).replace(/\n/g,"\n     ")); } }

const {calc, parseInvoicePdfText, parseIssuerPdfText} = extractFns(["calc","parseInvoicePdfText","parseIssuerPdfText"]);

test("calc 税抜 floor", ()=> eq(calc({items:[{qty:2,price:30000},{qty:1,price:40000}],taxRate:"10",rounding:"floor"}), {sub:100000,tax:10000,total:110000}));

test("calc 税込 floor", ()=> eq(calc({items:[{qty:1,price:400000},{qty:1,price:500000},{qty:1,price:42100}],taxRate:"10",rounding:"floor",taxIn:true}), {sub:856455,tax:85645,total:942100}));
test("calc 税込 round/ceil", ()=>{ const d={items:[{qty:1,price:1002}],taxRate:"10",taxIn:true}; // 1002×10/110=91.09…
  eq(calc({...d,rounding:"round"}),{sub:911,tax:91,total:1002}); eq(calc({...d,rounding:"ceil"}),{sub:910,tax:92,total:1002}); });
test("calc 税込 税率0", ()=> eq(calc({items:[{qty:1,price:5000}],taxRate:"0",rounding:"floor",taxIn:true}), {sub:5000,tax:0,total:5000}));
test("calc taxIn未設定は税抜", ()=> eq(calc({items:[{qty:1,price:1000}],taxRate:"10",rounding:"floor"}), {sub:1000,tax:100,total:1100}));

test("app-invoice 回帰", ()=>{ const p=parseInvoicePdfText(load("app-invoice"));
  eq([p.type,p.client,p.honor,p.contact,p.no,p.date,p.subject,p.taxRate],["invoice","テスト工務店","御中","山田","I2610-001","2026-10-16","ハウスクリーニング一式","10"]);
  eq(p.items,[{date:"",desc:"エアコン清掃",qty:2,unit:"台",price:30000},{date:"",desc:"キッチン清掃",qty:1,unit:"式",price:40000}]); });

test("app-estimate 回帰", ()=>{ const p=parseInvoicePdfText(load("app-estimate"));
  eq([p.type,p.client,p.contact,p.no,p.date,p.subject,p.validText],["estimate","株式会社サンプル","佐藤","Q2610-002","2026-10-20","定期清掃","御見積後1カ月"]);
  eq(p.items,[{date:"",desc:"窓清掃",qty:5,unit:"箇所",price:10000}]); });


// iOS系請求書アプリの書式
test("ios-invoice 取り込み", ()=>{ const p=parseInvoicePdfText(load("ios-invoice"));
  eq([p.type,p.client,p.honor,p.date,p.subject,p.taxRate,p.taxIn],["invoice","株式会社サンプル商事 那覇支店","様","2026-10-16","〇〇 新築工事","10",true]);
  eq(p.items,[{date:"",desc:"下水道工事",qty:1,unit:"式",price:400000},{date:"",desc:"内部配管器具付け",qty:1,unit:"式",price:500000},{date:"",desc:"水道メーター加入金",qty:1,unit:"個",price:42100}]);
  eq(calc({...p,rounding:"floor"}),{sub:856455,tax:85645,total:942100}); });
test("数量と単位が1文字片", ()=>{ const f=load("app-invoice").filter(i=>!(i.y===309.5&&(i.str==="2"||i.str==="台"))); f.push({str:"2台",x:297,y:309.5,w:12});
  const p=parseInvoicePdfText(f); eq([p.items[0].qty,p.items[0].unit],[2,"台"]); });
test("税込表記なしでも合計一致なら税込", ()=>{ const f=load("ios-invoice").filter(i=>i.str!=="税込"&&i.str!=="("&&i.str!==")");
  eq(parseInvoicePdfText(f).taxIn,true); });
test("既存書式は税抜のまま", ()=>{ eq(parseInvoicePdfText(load("app-invoice")).taxIn,false); eq(parseInvoicePdfText(load("app-estimate")).taxIn,false); });
test("明細の月日列", ()=>{ const f=load("ios-invoice"); f.push({str:"10",x:68,y:266,w:10},{str:"16",x:80,y:266,w:10});
  eq(parseInvoicePdfText(f).items[0].date,"2026-10-16"); });

// 発行者情報の取り込み
test("issuer ios-invoice", ()=> eq(parseIssuerPdfText(load("ios-invoice")),
  {company:"テスト",zip:"900-0000",addr1:"那覇市泉崎1丁目 1-1",addr2:"サンプルビル 101",tel:"090-0000-0000",bank:"サンプル銀行 中央支店",bankType:"普通",bankNo:"1234567",bankName:"テストセツビ"}));
test("issuer 宛名だけ", ()=> eq(parseIssuerPdfText([{str:"テスト工務店",x:19,y:89,w:60},{str:"御中",x:229,y:90,w:12}]), {}));
test("issuer メール・登録番号", ()=>{ const f=load("ios-invoice"); f.push({str:"info@example.com",x:327,y:166,w:80},{str:"登録番号 T1234567890123",x:327,y:176,w:100});
  const r=parseIssuerPdfText(f); eq([r.email,r.regno],["info@example.com","T1234567890123"]); });

// レビュー指摘：アプリ自身の請求書レイアウトでの発行者情報（会社名の行に代表が並ぶ／振込先が合計欄の横／FAXがTELの上／7桁入りNo.）
const F=(str,x,y)=>({str,x,y,w:Math.max(6,str.length*6)});
const appIssuer=()=>load("app-invoice").map(i=>i.str==="I2610-001"?{...i,str:"I20261016-1"}:i).concat([
  F("テスト商会",317,138),F("代表：山田",363,141),F("〒900-0001",316,177),F("那覇市1-1",316,191),F("ビル2F",316,206),
  F("FAX:050-000-0000",316,215),F("TEL:098-000-0000",316,222),F("E-Mail：a@b.jp",316,237),
  F("お振込先",22,643),F("サンプル銀行　中央支店",58,657),F("普通",60,673),F("1234567",58,687),F("テスト商会",58,703)]);
test("issuer アプリ書式（会社名・振込先・FAX・7桁No.）", ()=> eq(parseIssuerPdfText(appIssuer()),
  {company:"テスト商会",zip:"900-0001",addr1:"那覇市1-1",addr2:"ビル2F",tel:"098-000-0000",email:"a@b.jp",bank:"サンプル銀行 中央支店",bankType:"普通",bankNo:"1234567",bankName:"テスト商会"}));
test("issuer 宛名が銀行でも振込先を優先", ()=>{ const f=appIssuer().map(i=>i.str==="テスト工務店"?{...i,str:"サンプル信用金庫"}:i); eq(parseIssuerPdfText(f).bank,"サンプル銀行 中央支店"); });
const payLabel=f=>f.map(i=>(i.str==="合計金額"||(i.str==="合計"&&i.y===657))?{...i,str:"お支払金額"}:i); // 「合計」の語を総額行から外す
test("税抜の合計行があっても税込にしない", ()=>{ const f=payLabel(load("app-invoice")).concat([F("合計(税抜)",284.8,680),F("¥100,000",429,680)]);
  const p=parseInvoicePdfText(f); eq([p.taxIn,p.items.length],[false,2]); });
test("税額が内税計算と合わなければ税込にしない", ()=>{ const f=payLabel(load("app-invoice")).map(i=>i.str==="¥110,000"?{...i,str:"¥100,000"}:i).map(i=>i.str==="お支払金額"?{...i,str:"合計"}:i);
  eq(parseInvoicePdfText(f).taxIn,false); });

// 帳票のラベル（税込時）
const SHEET_STUBS=`const settings={company:"",rep:"",zip:"",addr1:"",addr2:"",tel:"",email:"",regno:"",bank:"",bankNo:""};
const TYPES={invoice:{title:"請求書",noLbl:"請求No.",dateLbl:"請求日",dueLbl:"お支払期限",greet:""},estimate:{title:"見積書",noLbl:"見積No.",dateLbl:"見積日",dueLbl:"",greet:""},receipt:{title:"領収書",noLbl:"",dateLbl:"",dueLbl:"",greet:""}};
const esc=s=>String(s??""); const yen=n=>"¥"+Math.round(n); const num=n=>String(Math.round(n)); const fmtDate=d=>d||""; const stampImg=()=>""; const ROWS=21; const EST_ROWS=12;
function renderReceiptSimple(){return "";}`;
const {renderSheet, renderEstimate} = extractWith(["calc","renderSheet","renderEstimate"], SHEET_STUBS);
const docBase={type:"invoice",no:"I1",date:"2026-10-16",due:"",client:"c",honor:"御中",contact:"",subject:"s",items:[{desc:"a",qty:1,unit:"式",price:1100}],taxRate:"10",rounding:"floor"};
test("請求書 税込ラベル", ()=>{ const h=renderSheet({...docBase,taxIn:true}); eq([/単価\(税込\)/.test(h),/金額\(税込\)/.test(h),/小計\(税抜\)/.test(h),/内消費税（10％）/.test(h)],[true,true,true,true]); });
test("請求書 税抜は従来ラベル", ()=>{ const h=renderSheet(docBase); eq([/税込\)/.test(h),/小計\(税抜\)/.test(h),/>消費税（10％）</.test(h)],[false,false,true]); });
test("見積書 税込ラベル", ()=>{ const h=renderEstimate({...docBase,type:"estimate",taxIn:true}); eq([/単価\(税込\)/.test(h),/小計\(税抜\)/.test(h),/内消費税/.test(h)],[true,true,true]); });
test("見積書 税抜は従来ラベル", ()=>{ const h=renderEstimate({...docBase,type:"estimate"}); eq([/税込\)/.test(h),/内消費税/.test(h)],[false,false]); });

// ===== v1.11.0 売上集計・入金管理 =====
const R = extractWith(["calc","fyMonths","latestDocs","salesDocs","docStatus","salesStats","receivables","estimateStats"], "");
const D=(o)=>Object.assign({id:Math.random().toString(36).slice(2),type:"invoice",base:"",rev:1,date:"2026-01-10",due:"",client:"A社",items:[{desc:"清掃",qty:1,price:10000}],taxRate:"10",rounding:"floor",updatedAt:1},o);

test("fyMonths 1月始まり／4月始まり", ()=>{ eq(R.fyMonths(2026,1).slice(0,2),["2026-01","2026-02"]); eq(R.fyMonths(2026,4)[0],"2026-04"); eq(R.fyMonths(2026,4)[11],"2027-03"); eq(R.fyMonths(2026,4).length,12); });
test("latestDocs 改訂は最新版だけ・削除除外", ()=>{
  const a=D({id:"a",base:"2601-001",rev:1}), b=D({id:"b",base:"2601-001",rev:2}), c=D({id:"c",base:"2601-002",deleted:true}), e=D({id:"e",type:"estimate",base:"2601-001"});
  eq(R.latestDocs([a,b,c,e]).map(d=>d.id).sort(),["b","e"]); });
test("salesDocs 請求書のある案件の領収書は数えない", ()=>{
  const i=D({id:"i",base:"2601-001"}), r1=D({id:"r1",type:"receipt",base:"2601-001"}), r2=D({id:"r2",type:"receipt",base:"2601-002"}), r3=D({id:"r3",type:"receipt",base:""}), q=D({id:"q",type:"estimate",base:"2601-003"});
  eq(R.salesDocs([i,r1,r2,r3,q]).map(d=>d.id).sort(),["i","r2","r3"]); });
test("docStatus 請求書", ()=>{ eq(R.docStatus(D({paid:true,due:"2026-01-01"}),[],"2026-02-01"),"paid"); eq(R.docStatus(D({due:"2026-01-31"}),[],"2026-02-01"),"overdue"); eq(R.docStatus(D({due:"2026-02-01"}),[],"2026-02-01"),"unpaid"); eq(R.docStatus(D({due:""}),[],"2026-02-01"),"unpaid"); });
test("docStatus 見積", ()=>{ const q=D({type:"estimate",base:"2601-001"});
  eq(R.docStatus(q,[q],"2026-02-01"),"open"); eq(R.docStatus({...q,lost:true},[q],"2026-02-01"),"lost");
  eq(R.docStatus({...q,lost:true},[q,D({base:"2601-001"})],"2026-02-01"),"won");
  eq(R.docStatus(q,[q,D({base:"2601-001",deleted:true})],"2026-02-01"),"open"); eq(R.docStatus(D({type:"receipt"}),[],"x"),""); });

const yearDocs=[
  D({id:"p1",date:"2025-01-05",client:"A社",items:[{desc:"清掃",qty:1,price:10000}]}),            // 前年1月 11,000
  D({id:"p2",date:"2025-03-20",client:"B社",items:[{desc:"窓",qty:2,price:5000}]}),               // 前年3月 11,000
  D({id:"c1",date:"2026-01-15",client:"A社",items:[{desc:"清掃",qty:2,price:10000}]}),            // 今年1月 22,000
  D({id:"c2",date:"2026-01-31",client:"B社",items:[{desc:"清掃",qty:1,price:10000}],taxIn:true}), // 今年1月 10,000（税込入力）
  D({id:"c3",date:"2026-02-01",client:"A社",base:"2602-001",rev:1,items:[{desc:"窓",qty:1,price:99999}]}), // 改訂前（除外）
  D({id:"c4",date:"2026-02-03",client:"A社",base:"2602-001",rev:2,items:[{desc:"窓",qty:1,price:30000}]}), // 今年2月 33,000
  D({id:"q1",type:"estimate",date:"2026-02-01",items:[{desc:"x",qty:1,price:777777}]}),             // 見積は数えない
];
test("salesStats 月別・合計・前年比", ()=>{ const s=R.salesStats(yearDocs,{fy:2026,fyStart:1,basis:"total",manual:{},defRate:10,today:"2026-02-15"});
  eq(s.months.slice(0,3).map(m=>[m.key,m.cur,m.prev,m.count]),[["2026-01",32000,11000,2],["2026-02",33000,0,1],["2026-03",0,11000,0]]);
  eq([s.total.cur,s.total.prev],[65000,22000]); eq(s.months[1].ratio,null); eq(Math.round(s.months[0].ratio*1000),2909); });
test("salesStats 累計（今月まで）", ()=>{ const s=R.salesStats(yearDocs,{fy:2026,fyStart:1,basis:"total",manual:{},defRate:10,today:"2026-02-15"});
  eq([s.ytd.months,s.ytd.cur,s.ytd.prev],[2,65000,11000]);
  eq(R.salesStats(yearDocs,{fy:2025,fyStart:1,today:"2026-02-15"}).ytd.months,12); eq(R.salesStats(yearDocs,{fy:2027,fyStart:1,today:"2026-02-15"}).ytd.months,0); });
test("salesStats 税抜", ()=>{ const s=R.salesStats(yearDocs,{fy:2026,fyStart:1,basis:"sub",manual:{},defRate:10,today:"2026-02-15"});
  eq([s.months[0].cur,s.months[0].prev],[29091,10000]); }); // 20000+9091
test("salesStats 手入力の過去売上（税込で保存、税抜は換算）", ()=>{
  const m={"2025-02":55000,"2026-01":1100};
  const s=R.salesStats(yearDocs,{fy:2026,fyStart:1,basis:"total",manual:m,defRate:10,today:"2026-02-15"});
  eq([s.months[0].cur,s.months[1].prev,s.total.prev],[33100,55000,77000]);
  const t=R.salesStats(yearDocs,{fy:2026,fyStart:1,basis:"sub",manual:m,defRate:10,today:"2026-02-15"});
  eq([t.months[1].prev,t.months[0].cur],[50000,30091]); });
test("salesStats 4月始まりの年度", ()=>{ const s=R.salesStats(yearDocs,{fy:2025,fyStart:4,basis:"total",manual:{},defRate:10,today:"2026-02-15"});
  eq([s.months[0].key,s.total.cur,s.total.prev],["2025-04",65000,22000]); eq(s.ytd.months,11); });
test("salesStats 取引先・品目ランキングと目標", ()=>{ const s=R.salesStats(yearDocs,{fy:2026,fyStart:1,basis:"total",manual:{},defRate:10,today:"2026-02-15",goal:130000});
  eq(s.clients,[{name:"A社",amt:55000,count:2},{name:"B社",amt:10000,count:1}]);
  eq(s.items,[{name:"窓",amt:30000,qty:1},{name:"清掃",amt:30000,qty:3}].sort((a,b)=>b.amt-a.amt||a.name.localeCompare(b.name)));
  eq([s.goal.target,s.goal.ratio],[130000,0.5]); eq(R.salesStats(yearDocs,{fy:2026,today:"2026-02-15"}).goal.ratio,null); });
test("salesStats 日付のない書類は無視", ()=>{ const s=R.salesStats([D({date:""})],{fy:2026,today:"2026-02-15"}); eq(s.total.cur,0); });
test("receivables 未入金・期限超過", ()=>{
  const ds=[D({id:"u1",due:"2026-01-31",no:"I1"}),D({id:"u2",due:"2026-03-01",no:"I2",items:[{qty:1,price:20000}]}),D({id:"pd",paid:true,paidAt:"2026-01-20"}),D({id:"old",base:"2601-009",rev:1}),D({id:"new",base:"2601-009",rev:2,paid:true})];
  const r=R.receivables(ds,"2026-02-01");
  eq([r.count,r.amount,r.overdueCount,r.overdueAmount],[2,33000,1,11000]); eq(r.list.map(x=>x.id),["u1","u2"]); });
test("estimateStats 受注率", ()=>{
  const ds=[D({type:"estimate",base:"2601-001",date:"2026-01-05"}),D({base:"2601-001",date:"2026-01-20"}),
    D({type:"estimate",base:"2601-002",date:"2026-01-06",lost:true}),D({type:"estimate",base:"2601-003",date:"2026-02-06"}),
    D({type:"estimate",base:"2601-003",rev:2,date:"2026-02-07"}),D({type:"estimate",base:"2501-001",date:"2025-02-07"})];
  eq(R.estimateStats(ds,2026,1),{count:3,won:1,lost:1,open:1,rate:1/3}); eq(R.estimateStats([],2026,1).rate,null); });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed?1:0);
