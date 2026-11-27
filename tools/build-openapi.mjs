// node tools/build-openapi.mjs          … api/openapi.json を作り直す
// node tools/build-openapi.mjs --check  … 作り直しが必要なら失敗
import fs from "node:fs";
import {API_VERSION} from "../api/src/app.mjs";
import {EVENTS} from "../api/src/store.mjs";

const OUT = new URL("../api/openapi.json", import.meta.url);
const ref = n => ({$ref:"#/components/schemas/"+n});
const str = (description, extra={}) => ({type:"string", ...(description?{description}:{}), ...extra});
const nul = (type, extra={}) => ({type:[type,"null"], ...extra});
const obj = (properties, required, extra={}) => ({type:"object", properties, ...(required?{required}:{}), ...extra});
const arr = items => ({type:"array", items});
const body = schema => ({required:true, content:{"application/json":{schema}}});
const jsonRes = (description, schema) => ({description, content:{"application/json":{schema}}});
const data = schema => obj({data:schema}, ["data"]);
const q = (name, schema, description) => ({name, in:"query", schema, description});
const TYPES = ["estimate","invoice","receipt"];
const STATUSES = ["unpaid","overdue","paid","open","won","lost","old","ai_draft"];

const docInput = {
  client:str("宛名"), honorific:str("敬称",{enum:["御中","様",""]}), contact:str("ご担当"), subject:str("件名"),
  date:str("書類の日付（日本時間の暦日）",{format:"date"}), due_date:str("見積の有効期限・請求の支払期限（暦日）",{format:"date"}),
  valid_text:str("見積書の有効期限の文言"), note:str("備考"), memo:str("社内メモ（帳票に出ない）"),
  items:{type:"array", minItems:1, maxItems:21, items:ref("ItemInput")},
  tax_rate:str("消費税率",{enum:["10","8","0"]}), tax_included:{type:"boolean", description:"単価が税込なら true"},
  rounding:str("消費税の端数",{enum:["floor","round","ceil"]}), layout:str("領収書の書式",{enum:["simple","detail"]})
};
const itemProps = {description:str("品名"), quantity:{type:["number","null"]}, unit:str("単位"), unit_price:{type:["number","null"], description:"単価（円）"}, date:str("月日など")};
const docProps = {
  id:str(), type:str(null,{enum:TYPES}), number:str("書類No."), case_number:str("案件番号 YYMM-NNN"),
  date:nul("string",{format:"date"}), due_date:nul("string",{format:"date"}), client:str(), honorific:str(), subject:str(),
  subtotal:{type:"number"}, tax:{type:"number"}, total:{type:"number", description:"税込（円）"},
  status:nul("string",{description:"請求書：unpaid/overdue/paid/old、見積書：open/won/lost/old"}), paid:nul("boolean"), paid_at:nul("string",{format:"date"}),
  ai_draft:{type:"boolean", description:"AI下書き（本人が未確認）。true の書類だけ変更・削除できる"}, pdf_url:nul("string"), deleted:{type:"boolean"},
  created_at:str("UTC",{format:"date-time"}), updated_at:str("UTC。アプリで保存した書類は端末で保存した時刻",{format:"date-time"})
};
const keyProps = {id:str(), name:str(), scope:str(null,{enum:["read","write"]}), prefix:str("キーの先頭（見分け用）"),
  created_at:str(null,{format:"date-time"}), updated_at:str(null,{format:"date-time"}), last_used_at:nul("string",{format:"date-time"}), revoked_at:nul("string",{format:"date-time"})};
const hookProps = {id:str(), url:str(null,{format:"uri"}), events:arr(str(null,{enum:EVENTS})), created_at:str(null,{format:"date-time"}),
  updated_at:str(null,{format:"date-time"}), last_status:nul("integer"), last_delivery_at:nul("string",{format:"date-time"})};

const ERR = {400:"BadRequest",401:"Unauthorized",403:"Forbidden",404:"NotFound",405:"MethodNotAllowed",409:"Conflict",413:"TooLarge",422:"Invalid",429:"RateLimited",500:"Internal",502:"BadGateway",503:"Unavailable",504:"Timeout"};
const errs = codes => Object.fromEntries(codes.map(c => [c, {$ref:"#/components/responses/"+ERR[c]}]));
const idParam = {name:"id", in:"path", required:true, schema:{type:"string"}};
const idem = {name:"Idempotency-Key", in:"header", required:false, schema:{type:"string", maxLength:200}, description:"任意（推奨）。24時間、同じキー・同じ内容の再送には前の応答を返す"};

const paths = {};
function op(method, path, {id, summary, scope, admin, open, params=[], req, ok, status=200, write}){
  const p = (paths[path] ||= path.includes("{id}") ? {parameters:[idParam]} : {});
  const codes = open ? [400,403,429,500] : [400,401,403,429,500,503];
  if(!open && !admin && !/\/me$/.test(path)) codes.push(502,504);
  if(path.includes("{id}")) codes.push(404);
  if(path === "/api/v1/webhooks" && method === "post") codes.push(502,504);
  if(req) codes.push(413,422);
  if(!open && !req && params.length) codes.push(422);
  if(write || admin) codes.push(409);
  if(write) codes.push(422);
  p[method] = {operationId:id, summary, description: admin ? "管理トークン（ADMIN_TOKEN）が必要" : scope ? "必要なスコープ："+scope : "認証不要",
    security: open ? [] : admin ? [{adminToken:[]}] : [{bearerAuth:[]},{apiKeyAuth:[]}],
    ...(scope?{"x-required-scope":scope}:{}),
    ...(params.length||write?{parameters:[...params, ...(write?[idem]:[])]}:{}),
    ...(req?{requestBody:req}:{}),
    responses:{[status]:jsonRes("成功", ok), ...errs([...new Set(codes)].sort())}};
}
const R="documents:read", W="documents:write";
const one = data(ref("Document"));
op("get","/api/v1/health",{id:"getHealth",summary:"稼働確認",open:true,ok:data(obj({status:str(),version:str(),time:str(null,{format:"date-time"}),data_source_configured:{type:"boolean"}}))});
op("get","/api/v1/me",{id:"getMe",summary:"認証確認",scope:R,ok:data(obj({auth_type:str(),key_id:str(),name:str(),scopes:arr(str())}))});
op("get","/api/v1/documents",{id:"listDocuments",summary:"書類の一覧・検索・差分取得",scope:R,params:[
  q("type",str(null,{enum:TYPES})), q("q",str(),"宛名・件名・書類No.・案件番号の部分一致"), q("status",str(null,{enum:STATUSES}),"unpaid は期限超過を含む"),
  q("from",str(null,{format:"date"}),"書類の日付の始め"), q("to",str(null,{format:"date"}),"書類の日付の終わり"),
  q("updated_since",str(null,{format:"date-time"}),"これより後に更新された書類（updated_at の古い順）。圏外で保存した書類は古い時刻で届くため、重ねて取得し、ときどき全件を確認する"),
  q("include_deleted",{type:"boolean"},"削除済み（deleted:true）も返す。updated_since があるときの既定は true"),
  q("limit",{type:"integer",minimum:1,maximum:200,default:30}), q("offset",{type:"integer",minimum:0,default:0})],
  ok:obj({data:arr(ref("Document")),pagination:obj({limit:{type:"integer"},offset:{type:"integer"},total:{type:"integer"}})},["data","pagination"])});
op("post","/api/v1/documents",{id:"createDocument",summary:"書類を作る（AI下書き）",scope:W,write:true,req:body(ref("DocumentCreate")),ok:one,status:201});
op("get","/api/v1/documents/{id}",{id:"getDocument",summary:"書類の詳細（明細・同じ案件の書類）",scope:R,ok:one});
op("patch","/api/v1/documents/{id}",{id:"updateDocument",summary:"AI下書きを直す（本人の書類は 409）",scope:W,write:true,req:body(ref("DocumentUpdate")),ok:one});
op("delete","/api/v1/documents/{id}",{id:"deleteDocument",summary:"AI下書きを削除（本人の書類・入金や失注の記録・PDFがある下書きは 409）",scope:W,write:true,ok:data(obj({id:str(),deleted:{type:"boolean"},updated_at:str(null,{format:"date-time"})}))});
op("post","/api/v1/documents/{id}/convert",{id:"convertDocument",summary:"見積→請求・領収、請求→領収（本文は {} でも可）",scope:W,write:true,req:{...body(obj({to:str(null,{enum:["invoice","receipt"]}),date:str(null,{format:"date"})},null,{additionalProperties:false})),required:false},ok:one,status:201});
op("post","/api/v1/documents/{id}/revise",{id:"reviseDocument",summary:"改訂版を作る（渡した項目だけ変える）",scope:W,write:true,req:body(ref("DocumentUpdate")),ok:one,status:201});
op("post","/api/v1/documents/{id}/status",{id:"setDocumentStatus",summary:"入金済み（請求書）・失注（見積書）の記録",scope:W,write:true,req:body(obj({paid:{type:"boolean"},paid_at:str(null,{format:"date"}),lost:{type:"boolean"}},null,{additionalProperties:false,minProperties:1})),ok:one});
op("get","/api/v1/documents/{id}/message",{id:"getMessageText",summary:"送付文面（LINE・メール）",scope:R,params:[q("channel",str(null,{enum:["line","mail"],default:"line"})),q("reminder",{type:"boolean"},"請求書の入金確認の文面")],ok:data(obj({channel:str(),text:str(),subject:str(),body:str()}))});
op("get","/api/v1/reports/sales",{id:"getSalesReport",summary:"売上集計（前年同月比・未入金・受注率）",scope:R,params:[q("year",{type:"integer",minimum:2000,maximum:2100}),q("basis",str(null,{enum:["total","sub"]}))],ok:data({type:"object",additionalProperties:true})});
op("get","/api/v1/issuer",{id:"getIssuer",summary:"発行者情報（振込先を含む）と定型明細",scope:R,ok:data({type:"object",additionalProperties:true})});
op("get","/api/v1/keys",{id:"listApiKeys",summary:"APIキーの一覧",admin:true,ok:data(arr(ref("ApiKey")))});
op("post","/api/v1/keys",{id:"createApiKey",summary:"APIキーを発行（key は今回だけ表示）",admin:true,req:body(obj({name:str(null,{minLength:1,maxLength:60}),scope:str(null,{enum:["read","write"]})},["name","scope"])),ok:data(ref("ApiKeyWithSecret")),status:201});
op("post","/api/v1/keys/{id}/rotate",{id:"rotateApiKey",summary:"再発行（古いキーは即時無効）",admin:true,ok:data(ref("ApiKeyWithSecret"))});
op("delete","/api/v1/keys/{id}",{id:"revokeApiKey",summary:"無効化",admin:true,ok:data(ref("ApiKey"))});
op("get","/api/v1/webhooks",{id:"listWebhooks",summary:"Webhook の一覧",admin:true,ok:data(arr(ref("Webhook")))});
op("post","/api/v1/webhooks",{id:"createWebhook",summary:"Webhook を登録（secret は今回だけ表示）",admin:true,req:body(obj({url:str(null,{format:"uri"}),events:arr(str(null,{enum:EVENTS}))},["url"])),ok:data({allOf:[ref("Webhook"),obj({secret:str()},["secret"])]}),status:201});
op("delete","/api/v1/webhooks/{id}",{id:"deleteWebhook",summary:"Webhook を削除",admin:true,ok:data(obj({id:str(),deleted:{type:"boolean"}}))});
paths["/mcp"] = {post:{operationId:"mcp",summary:"MCP（Streamable HTTP・状態なし。JSON-RPC 2.0）",description:"REST と同じ APIキーを使う。read キーには参照ツールだけが見える。Idempotency-Key は非対応。",
  security:[{bearerAuth:[]},{apiKeyAuth:[]}], requestBody:body({type:["object","array"]}),
  responses:{200:jsonRes("JSON-RPC の応答",{type:["object","array"]}),202:{description:"通知のみ（本文なし）"},400:{description:"JSON-RPC のエラー"},...errs([401,403,405,413,429,500])}}};
paths["/openapi.json"] = {get:{operationId:"getOpenApi",summary:"この仕様書",security:[],responses:{200:jsonRes("OpenAPI 3.1",{type:"object"}),...errs([429])}}};

const eventSchema = obj({id:str("イベントid（重複の除去に使う）"),type:str(null,{enum:EVENTS}),occurred_at:str("検出した時刻",{format:"date-time"}),
  data:obj({id:str(),type:str(),number:str(),updated_at:str(null,{format:"date-time"}),deleted:{type:"boolean"}})},["id","type","occurred_at","data"]);
const responses = Object.fromEntries(Object.entries(ERR).map(([c,n]) => [n, {...jsonRes({400:"不正な要求（invalid_json / key_in_url）",401:"認証失敗",403:"権限不足・https 必須",404:"見つからない",405:"メソッド違い",409:"変更できない・競合・Idempotency",413:"本文が大きすぎる",422:"入力の誤り",429:"回数の上限（Retry-After 秒待つ）",500:"内部エラー",502:"GAS のエラー",503:"混雑・未設定",504:"GAS の時間切れ"}[c], ref("Error")),
  ...(c==="429"?{headers:{"Retry-After":{schema:{type:"integer"}}}}:{})}]));

const spec = {openapi:"3.1.0",
  info:{title:"REDSEAL 外部連携API",version:API_VERSION,description:"見積書・請求書・領収書の API。金額は円、書類の日付は日本時間の暦日（YYYY-MM-DD）、時刻は ISO 8601（UTC）。AI が作った書類は AI下書きになり、本人がアプリで確認してから送る。API は PDF の作成・送付をしない。"},
  servers:[{url:"https://redseal-api.example.workers.dev",description:"配信時は実際のURLに置き換わる"}],
  paths,
  webhooks:{documentEvent:{post:{summary:"書類の作成・更新・削除の通知",description:"X-Signature: sha256=<生の本文を secret で HMAC-SHA256 した16進>。ほかに X-Webhook-Id・X-Webhook-Event。2xx 以外は最大6回まで再送。重複はあり得る。",
    parameters:[{name:"X-Signature",in:"header",required:true,schema:{type:"string"}}],requestBody:body(eventSchema),responses:{200:{description:"受け取った"}}}}},
  components:{
    securitySchemes:{
      bearerAuth:{type:"http",scheme:"bearer",description:"APIキー（rsk_…）。将来の OAuth 2.0 でも同じヘッダーとスコープ（documents:read / documents:write）を使う"},
      apiKeyAuth:{type:"apiKey",in:"header",name:"X-API-Key"},
      adminToken:{type:"http",scheme:"bearer",description:"キーと Webhook の管理用（ADMIN_TOKEN）"}},
    schemas:{
      Error:obj({error:obj({code:str(),message:str()},["code","message"])},["error"]),
      ItemInput:obj(itemProps,null,{additionalProperties:false}),
      DocumentCreate:obj({type:str(null,{enum:TYPES}),...docInput},["type","client","items"],{additionalProperties:false}),
      DocumentUpdate:obj(docInput,null,{additionalProperties:false}),
      Document:obj({...docProps, contact:str(), valid_text:str(), note:str(), memo:str(), tax_rate:str(), tax_included:{type:"boolean"}, rounding:str(), layout:nul("string"),
        revision:{type:"integer"}, source_id:nul("string"), items:arr(obj(itemProps)), related:arr(ref("Document"))}, Object.keys(docProps),
        {description:"contact 以降の項目は一覧と related には含まれない"}),
      ApiKey:obj(keyProps,["id","name","scope"]),
      ApiKeyWithSecret:{allOf:[ref("ApiKey"),obj({key:str("この応答でしか表示されない")},["key"])]},
      Webhook:obj(hookProps,["id","url","events"]),
      WebhookEvent:eventSchema},
    responses}};

const text = JSON.stringify(spec, null, 2) + "\n";
const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
if(process.argv.includes("--check")){ if(cur !== text){ console.error("api/openapi.json の作り直しが必要です"); process.exit(1); } console.log("ok: openapi.json は最新です"); }
else { fs.writeFileSync(OUT, text); console.log("api/openapi.json を作りました"); }
