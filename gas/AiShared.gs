/**
 * REDSEAL AI連携の共通計算（自動生成：node tools/build-gas.mjs）
 * index.html の同名関数のコピーです。ここは直接直さず、index.html を直してから作り直してください。
 */
function calc(d){
  // taxIn=true（税込で入力）：明細の合計が税込、消費税は内税として逆算
  const amount=d.items.reduce((a,i)=>a+(+i.qty||0)*(+i.price||0),0);
  const rate=+d.taxRate||0;
  const rd=v=>d.rounding==="ceil"?Math.ceil(v):d.rounding==="round"?Math.round(v):Math.floor(v);
  if(d.taxIn===true){ const tax=rd(amount*rate/(100+rate)); return {sub:amount-tax,tax,total:amount}; }
  const tax=rd(amount*rate/100);
  return {sub:amount,tax,total:amount+tax};
}
function fyMonths(fy,fyStart){ // 年度の12か月 ["YYYY-MM",…]
  const st=(+fyStart||1)-1, out=[];
  for(let i=0;i<12;i++){ const m=st+i, y=fy+Math.floor(m/12); out.push(y+"-"+String(m%12+1).padStart(2,"0")); }
  return out;
}
function caseKey(d){ // 案件のまとまり。Googleドライブ取り込み（id が imp_）は No. から作った仮の案件番号なので使わない
  return d&&d.base&&!String(d.id||"").startsWith("imp_")?d.base:"";
}
function linked(a,b){ // b が a と同じ案件、または a から変換・改訂して作られた
  return !!(a&&b&&a.id!==b.id&&((caseKey(a)&&caseKey(a)===caseKey(b))||b.fromId===a.id));
}
function superseded(d,docs){ // 同じ案件・同じ種別に、より新しい改訂版がある
  const k=caseKey(d);
  return !!k&&docs.some(x=>x&&!x.deleted&&x.id!==d.id&&x.type===d.type&&caseKey(x)===k&&(+x.rev||1)>(+d.rev||1));
}
function latestDocs(docs){ // 削除を除き、同じ案件・同じ種別は改訂番号が最大の1件だけ
  const best=new Map();
  for(const d of docs){
    if(!d||d.deleted) continue;
    const k=caseKey(d)?d.type+"|"+caseKey(d):"id|"+d.id;
    const b=best.get(k);
    if(!b||(+d.rev||1)>(+b.rev||1)||((+d.rev||1)===(+b.rev||1)&&(+d.updatedAt||0)>(+b.updatedAt||0))) best.set(k,d);
  }
  return [...best.values()];
}
function salesDocs(docs){ // 売上の対象：請求書＋（対応する請求書が無い）領収書
  const inv=docs.filter(x=>x&&!x.deleted&&x.type==="invoice");
  return latestDocs(docs).filter(d=>d.type==="invoice"||(d.type==="receipt"&&!inv.some(i=>linked(i,d)||linked(d,i))));
}
function docStatus(d,docs,today){ // invoice: paid/overdue/unpaid/old　estimate: won/lost/open/old
  if(d.type!=="invoice"&&d.type!=="estimate") return "";
  if(superseded(d,docs)) return "old";
  const has=t=>docs.some(x=>x&&!x.deleted&&t.includes(x.type)&&linked(d,x));
  if(d.type==="invoice"){
    if(d.paid||has(["receipt"])) return "paid";
    return d.due&&d.due<today?"overdue":"unpaid";
  }
  if(has(["invoice","receipt"])) return "won";
  return d.lost?"lost":"open";
}
function salesStats(docs,opt){
  const o=Object.assign({fyStart:1,basis:"total",manual:{},defRate:10,today:"",goal:0},opt||{});
  const rate=+o.defRate||0, key=o.basis==="sub"?"sub":"total";
  const conv=v=>{ v=+v||0; return key==="sub"?Math.floor(v*100/(100+rate)):v; };
  const curK=fyMonths(o.fy,o.fyStart), prevK=fyMonths(o.fy-1,o.fyStart);
  const by={}, sd=salesDocs(docs).filter(d=>d.date&&/^\d{4}-\d{2}/.test(d.date));
  for(const d of sd){ const k=d.date.slice(0,7); const c=calc(d); (by[k]=by[k]||{amt:0,count:0}); by[k].amt+=c[key]; by[k].count++; }
  const man=o.manual||{};
  const months=curK.map((k,i)=>{ const pk=prevK[i];
    const cur=(by[k]?by[k].amt:0)+conv(man[k]), prev=(by[pk]?by[pk].amt:0)+conv(man[pk]);
    return {key:k,prevKey:pk,label:(+k.slice(5))+"月",cur,prev,count:by[k]?by[k].count:0,prevCount:by[pk]?by[pk].count:0,manual:+man[k]||0,prevManual:+man[pk]||0,ratio:prev>0?cur/prev:null}; });
  const sum=(a,f)=>a.reduce((t,x)=>t+f(x),0);
  const tc=sum(months,m=>m.cur), tp=sum(months,m=>m.prev);
  const tm=(o.today||"").slice(0,7); let el=0;
  if(tm){ const i=curK.indexOf(tm); el=i>=0?i+1:(tm>curK[11]?12:0); }
  const yc=sum(months.slice(0,el),m=>m.cur), yp=sum(months.slice(0,el),m=>m.prev);
  const target=conv(o.goal);
  const inFy=sd.filter(d=>curK.includes(d.date.slice(0,7)));
  const cl={}, it={};
  for(const d of inFy){ const n=d.client||"（宛名なし）"; (cl[n]=cl[n]||{name:n,amt:0,count:0}); cl[n].amt+=calc(d)[key]; cl[n].count++;
    for(const x of d.items||[]){ const n2=String(x.desc||"").trim(); if(!n2) continue; const a=(+x.qty||0)*(+x.price||0); (it[n2]=it[n2]||{name:n2,amt:0,qty:0}); it[n2].amt+=a; it[n2].qty+=(+x.qty||0); } }
  const top=m=>Object.values(m).sort((a,b)=>b.amt-a.amt||a.name.localeCompare(b.name)).slice(0,10);
  return {months,total:{cur:tc,prev:tp,ratio:tp>0?tc/tp:null},ytd:{months:el,cur:yc,prev:yp,ratio:yp>0?yc/yp:null},
    goal:{target,ratio:target>0?tc/target:null},clients:top(cl),items:top(it)};
}
function receivables(docs,today){ // 未入金の請求書（全期間）
  const list=salesDocs(docs).map(d=>[d,docStatus(d,docs,today)]).filter(([d,st])=>d.type==="invoice"&&(st==="unpaid"||st==="overdue"))
    .map(([d,st])=>({id:d.id,no:d.no,client:d.client,subject:d.subject,due:d.due||"",total:calc(d).total,overdue:st==="overdue"}))
    .sort((a,b)=>(a.due||"9999").localeCompare(b.due||"9999"));
  const od=list.filter(x=>x.overdue);
  return {count:list.length,amount:list.reduce((t,x)=>t+x.total,0),overdueCount:od.length,overdueAmount:od.reduce((t,x)=>t+x.total,0),list};
}
function estimateStats(docs,fy,fyStart){ // 年度内の見積（各案件の最新版）の受注率
  const ks=fyMonths(fy,fyStart);
  const es=latestDocs(docs).filter(d=>d.type==="estimate"&&d.date&&ks.includes(d.date.slice(0,7)));
  const r={count:es.length,won:0,lost:0,open:0,rate:null};
  for(const d of es) r[docStatus(d,docs,"")]++;
  r.rate=r.count?r.won/r.count:null;
  return r;
}
