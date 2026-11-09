# 内税モード・他社書式PDF取り込み・発行者情報取り込み 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 見積・請求書メーカー v1.8.2 に「税込で入力」モードを追加し、iOS系請求書アプリのPDF（明細が税込・見出しの文字がバラける書式）を「既存のPDFから作成」で読めるようにし、設定画面に「自分のPDFから発行者情報を取り込む」を付けて v1.10.0 とする。

**Architecture:** 単体 `index.html` の既存関数（`calc`／`parseInvoicePdfText`／`renderSheet`／`renderEstimate`／設定画面）を拡張する。書類に `taxIn` フラグを足して計算関数で分岐、PDF解析は汎用パーサを強化。GAS は `calc_` のみ同じロジックに揃える。純粋関数（calc・2つのパーサ）は `index.html` から正規表現で切り出して node で回帰テストする。

**Tech Stack:** 素のHTML/JS（単体ファイル）、pdf.js 3.11.174（CDN、既存）、Google Apps Script、node 22（テスト実行のみ、依存パッケージなし）

**Spec:** `docs/superpowers/specs/2026-11-09-tax-inclusive-and-pdf-import-design.md`

## Global Constraints

- ベースは GitHub の v1.8.2（`APP_VERSION="1.8.2"`）。完成時 `APP_VERSION="1.10.0"`、`version.txt` も `1.10.0`。
- 帳票の座標・罫線・塗り・社判処理は変更しない。
- GAS の `DOC_COLS` は変更しない。`gas/Code.gs` と `gas/Code.generic.gs` の `calc_` は同一コードにする。
- 書類 `taxIn` は boolean（未設定＝false）。設定 `taxIn` は既存 `SKEYS` の流儀に合わせて文字列 `"0"`／`"1"`（既定 `"0"`）。
- 公開リポジトリに実在の第三者情報（社名・住所・電話・口座）を入れない。fixture はダミー値のみ。
- コミットは作業ブランチ `feature/tax-in-pdf-import` で行う（main へのマージ・push は本人確認後）。
- 作業ディレクトリ：`/home/claude/repo`。実PDFの文字片（ダミー化前）は `/home/claude/pdftest/items.json`（リポジトリ外・コミットしない）。

## Review Focus

1. 数量と単位が1つの文字片「2台」で来るPDF → qty 2・unit 台 に分かれること（Task 5 のテストで固定）。
2. 税率 0（非課税）で税込入力 → 消費税 0・小計＝合計（Task 2 のテストで固定）。
3. 明細に「税込」表記はないが Σ明細＝税込合計 となるPDF → `taxIn=true`（Task 5 のテストで固定）。
4. 発行者情報が読み取れないPDF（宛名しか無い等）→ 入力欄を一切触らず「読み取れませんでした」（Task 6 のテストで `{}` を返すことを固定、UI は空オブジェクトなら何もしない）。
5. 旧版で作った `taxIn` 未設定の書類と設定 → 税抜として従来通り計算される（Task 2 のテストで固定）。

---

### Task 1: テスト基盤と回帰用 fixture

**Files:**
- Create: `tests/run.mjs`
- Create: `tests/extract.mjs`
- Create: `tests/fixtures/app-invoice.json`
- Create: `tests/fixtures/app-estimate.json`
- Create: `tests/fixtures/ios-invoice.json`

**Interfaces:**
- Produces: `extractFns(names: string[]): Record<string, Function>` in `tests/extract.mjs` — `index.html` から `function <name>(...){ ... }\n}` ブロック（行頭 `function name(` から、行頭 `}` 単独行まで）を取り出し、`new Function` で評価して返す。`calc` は `const yen`等に依存しないので単独で評価できる。パーサも同様。
- Produces: `tests/run.mjs` — `node tests/run.mjs` で全テストを実行し、失敗があれば exit 1。簡易 `test(name, fn)`／`eq(a,b,msg)`（`JSON.stringify` 比較）を自前で持つ。依存パッケージなし。

- [ ] **Step 1: ブランチを切る**

Run: `cd /home/claude/repo && git checkout -b feature/tax-in-pdf-import`

- [ ] **Step 2: `tests/extract.mjs` を書く**

`export function extractFns(names)`：`fs.readFileSync("index.html")` → 各 name について正規表現 `new RegExp("^function "+name+"\\([^)]*\\)\\{[\\s\\S]*?^\\}$","m")` で切り出し、`new Function(src+"\nreturn "+name+";")()` で関数化。見つからなければ `throw new Error("not found: "+name)`。

- [ ] **Step 3: fixture `app-invoice.json` を書く（アプリの請求書書式を模した文字片）**

`renderSheet` の座標を使う。全要素 `{str,x,y,w}`（w は文字数×6 程度で可）：
```
請　求　書(200,40) テスト工務店(19,89) 御中(229,90) ご担当：(58,114) 山田(98,114) 様(201,115)
請求No.(344,90) I2610-001(422,90) 請求日(344,114) 2026/10/16(418,114)
件名：(47,158) ハウスクリーニング一式(87,159)
合計金額(43,263) ¥110,000(130,263) （税込）(229,263) お支払期限：(308,263) 2026/11/15(372,263)
日付(19.3,293) 摘要(55.4,293) 数量(284.8,293) 単価(341.9,293) 金額(427.6,293)
エアコン清掃(58,309.5) 2(297,309.5) 台(305,309.5) 30,000(343,309.5) ¥60,000(429,309.5)
キッチン清掃(58,324.6) 1(297,324.6) 式(305,324.6) 40,000(343,324.6) ¥40,000(429,324.6)
小計(284.8,627) ¥100,000(429,627) 消費税（10％）(284.8,643.5) ¥10,000(429,642) 合計(284.8,657) ¥110,000(429,657)
```

- [ ] **Step 4: fixture `app-estimate.json` を書く（お見積書.xlsx 準拠の見積書を模した文字片）**

`renderEstimate` の座標：
```
御　見　積　書(250,56) 株式会社サンプル(66,94) 御中(266,95) ご担当：(96,125) 佐藤(140,125) 様(238,125)
見積No.(359,97) Q2610-002(420,98) 見積日(359,125) 2026/10/20(420,126)
件名：(83,158) 定期清掃(124,160) 有効期限：(71,275) 御見積後1カ月(124,274)
合計金額(83,324) ¥55,000(150,325) （税込）(266,325)
No.(66.4,361) 摘要(94.8,360) 数量(321.9,360) 単価(358.1,360) 金額(443.3,360)
1(66.4,381) 窓清掃(99,381) 5(326,381) 箇所(334,381) 10,000(360,381) ¥50,000(446,381)
小計(321.9,607) ¥50,000(446,608) 消費税(321.9,626) ¥5,000(446,627) 合計(321.9,644) ¥55,000(446,646)
```

- [ ] **Step 5: fixture `ios-invoice.json` を作る（実PDFの座標構造をダミー化）**

`/home/claude/pdftest/items.json` を読み、次の置換を `str` に適用して保存するワンオフ node コマンドを実行する（置換後に実データが残っていないことを `grep` で確認）：

| 元 | 置換 |
|---|---|
| 株式会社スタジオ・チッタ | 株式会社サンプル商事 |
| 沖縄支店 | 那覇支店 |
| 楚辺 | 〇〇 |
| 夢→テ、設→ス、備→ト（1文字ずつの文字片） | |
| 901-0146 | 900-0000 |
| 那覇市具志３丁目 | 那覇市泉崎１丁目 |
| 18-9 | 1-1 |
| まるよしハイツ | サンプルビル |
| 301 | 101 |
| 090-8290-9202 | 090-0000-0000 |
| 琉球銀行　田原支店 | サンプル銀行　中央支店 |
| 443809 | 1234567 |
| ユメセツビタマキジュン | テストセツビ |

金額（400,000／500,000／42,100／856,455／85,645／942,100）と品名（下水道工事／内部配管器具付け／水道メーター加入金）はそのまま。
Run: `grep -c "スタジオ\|楚辺\|8290\|443809\|具志\|まるよし\|タマキ" tests/fixtures/ios-invoice.json` → Expected: `0`

- [ ] **Step 6: `tests/run.mjs` に現状で通る回帰テストを書く**

```js
import {extractFns} from "./extract.mjs";
const {calc, parseInvoicePdfText} = extractFns(["calc","parseInvoicePdfText"]);
test("calc 税抜 floor", ()=> eq(calc({items:[{qty:2,price:30000},{qty:1,price:40000}],taxRate:"10",rounding:"floor"}), {sub:100000,tax:10000,total:110000}));
test("app-invoice 回帰", ()=>{ const p=parseInvoicePdfText(load("app-invoice"));
  eq([p.type,p.client,p.honor,p.contact,p.no,p.date,p.subject,p.taxRate],["invoice","テスト工務店","御中","山田","I2610-001","2026-10-16","ハウスクリーニング一式","10"]);
  eq(p.items,[{date:"",desc:"エアコン清掃",qty:2,unit:"台",price:30000},{date:"",desc:"キッチン清掃",qty:1,unit:"式",price:40000}]); });
test("app-estimate 回帰", ()=>{ const p=parseInvoicePdfText(load("app-estimate"));
  eq([p.type,p.client,p.contact,p.no,p.date,p.subject,p.validText],["estimate","株式会社サンプル","佐藤","Q2610-002","2026-10-20","定期清掃","御見積後1カ月"]);
  eq(p.items,[{date:"",desc:"窓清掃",qty:5,unit:"箇所",price:10000}]); });
```
`load(name)` は `tests/fixtures/<name>.json` を読む。

- [ ] **Step 7: 実行して3件とも通ることを確認**

Run: `cd /home/claude/repo && node tests/run.mjs`
Expected: `3 passed, 0 failed`（通らない場合は fixture の座標がパーサの前提とずれている。パーサではなく fixture を直す——このタスクは現状の挙動を固定するのが目的）

- [ ] **Step 8: Commit**

```bash
git add tests/ && git commit -m "test: parser/calc regression harness and dummy fixtures"
```

---

### Task 2: 計算関数の税込対応（index.html と GAS）

**Files:**
- Modify: `index.html` `function calc(d)`（777行付近）
- Modify: `gas/Code.gs` `function calc_(d)`（111行付近）、`gas/Code.generic.gs` 同（110行付近）
- Test: `tests/run.mjs`

**Interfaces:**
- Produces: `calc(d)` は従来の `{sub,tax,total}` を返す。`d.taxIn===true` のとき：`total=Σqty×price`、`tax=round_by(total×rate/(100+rate))`、`sub=total−tax`。`d.taxIn` が未設定／false なら従来通り。

- [ ] **Step 1: 失敗するテストを追加**

```js
test("calc 税込 floor", ()=> eq(calc({items:[{qty:1,price:400000},{qty:1,price:500000},{qty:1,price:42100}],taxRate:"10",rounding:"floor",taxIn:true}), {sub:856455,tax:85645,total:942100}));
test("calc 税込 round/ceil", ()=>{ const d={items:[{qty:1,price:1001}],taxRate:"10",taxIn:true};
  eq(calc({...d,rounding:"round"}),{sub:910,tax:91,total:1001}); eq(calc({...d,rounding:"ceil"}),{sub:909,tax:92,total:1001}); });
test("calc 税込 税率0", ()=> eq(calc({items:[{qty:1,price:5000}],taxRate:"0",rounding:"floor",taxIn:true}), {sub:5000,tax:0,total:5000}));
test("calc taxIn未設定は税抜", ()=> eq(calc({items:[{qty:1,price:1000}],taxRate:"10",rounding:"floor"}), {sub:1000,tax:100,total:1100}));
```

- [ ] **Step 2: 実行して「税込」3件が失敗することを確認**

Run: `node tests/run.mjs` → Expected: 税込の3件 FAIL、他は PASS

- [ ] **Step 3: `calc` を実装**

`index.html` の `calc(d)` を spec §2 のアルゴリズムに書き換える。端数処理は既存の三項演算を `const rd=v=>d.rounding==="ceil"?Math.ceil(v):d.rounding==="round"?Math.round(v):Math.floor(v);` にまとめる。

- [ ] **Step 4: GAS の `calc_` を同じロジックに（2ファイル）**

`gas/Code.gs` と `gas/Code.generic.gs` の `calc_` を `calc` と同じ本体に置き換える（`Number()` で数値化する既存の書き方は維持）。
Run: `diff <(sed -n '/^function calc_/,/^}/p' gas/Code.gs) <(sed -n '/^function calc_/,/^}/p' gas/Code.generic.gs)` → Expected: 差分なし

- [ ] **Step 5: テスト実行**

Run: `node tests/run.mjs` → Expected: `7 passed, 0 failed`

- [ ] **Step 6: Commit**

```bash
git add index.html gas/Code.gs gas/Code.generic.gs tests/run.mjs && git commit -m "feat: tax-inclusive (内税) calculation in calc/calc_"
```

---

### Task 3: 書類・設定の `taxIn` と編集画面の切替

**Files:**
- Modify: `index.html`
  - `DEFAULT_SETTINGS`（722行付近）に `taxIn:"0"`
  - `SKEYS`（1399行付近）に `"taxIn"`
  - 設定画面：`<select id="s_taxRate">`（423行）の隣に `<label class="f">新規作成時の入力方法</label><select id="s_taxIn"><option value="0">税抜で入力</option><option value="1">税込で入力</option></select>`
  - `newDoc()`（756行付近）に `taxIn: settings.taxIn==="1"`
  - 編集画面：税率・端数の `.row`（175-176行）に `<div><label class="f">入力方法</label><select id="taxIn"><option value="0">税抜で入力</option><option value="1">税込で入力</option></select></div>`
  - `bindEdit`／`readEdit`／入力イベント配列（798・843・845行付近）
  - `renderTotals`（835行付近）、`renderItems`（単価 placeholder・金額ラベル）

**Interfaces:**
- Consumes: Task 2 の `calc`。
- Produces: `cur.taxIn` boolean。`readEdit` は `cur.taxIn=$("#taxIn").value==="1"`、`bindEdit` は `$("#taxIn").value=cur.taxIn?"1":"0"`。

- [ ] **Step 1: 設定とデータ**

`DEFAULT_SETTINGS.taxIn="0"`、`SKEYS` 末尾に `"taxIn"`、設定画面の select を追加、`newDoc` に `taxIn`。`bindSettings`／`btnSaveSettings` は `SKEYS` ループで自動対応。

- [ ] **Step 2: 編集画面の select とバインド**

`bindEdit`・`readEdit`・イベント配列に `#taxIn` を加える。`#taxIn` の `change` で `toast("金額はそのまま、計算方法だけ変わります")` し、`renderItems(); renderTotals();` を呼ぶ。

- [ ] **Step 3: ラベル切替**

- `renderTotals`：`$("#tSub")` の隣のラベル要素に id `tSubLbl` を付け、税込時「小計（税抜）」／税抜時「小計」。`#tTaxLbl` は税込時 `内消費税（${rate}%）`／税抜時 `消費税（${rate}%）`。
- `renderItems`：単価 input の placeholder を税込時「単価（税込）」、`.amt` の文言を税込時「金額（税込）」。

- [ ] **Step 4: 構文チェック**

`index.html` の最後の `<script>…</script>` の中身を切り出して `node --check`：
Run: `node -e 'const s=require("fs").readFileSync("index.html","utf8");const m=[...s.matchAll(/<script>([\s\S]*?)<\/script>/g)];require("fs").writeFileSync("/tmp/app.js",m[m.length-1][1])' && node --check /tmp/app.js && echo OK` → Expected: `OK`

- [ ] **Step 5: 回帰テスト**

Run: `node tests/run.mjs` → Expected: `7 passed, 0 failed`（`newDoc` 等は切り出していないので影響なし）

- [ ] **Step 6: Commit**

```bash
git add index.html && git commit -m "feat: taxIn flag on docs/settings and 税込で入力 switch in editor"
```

---

### Task 4: 帳票の見出し・合計欄ラベル（請求書・明細型領収書・見積書）

**Files:**
- Modify: `index.html` `renderSheet`（1101-1115行付近）、`renderEstimate`（1143行・1163-1165行付近）

**Interfaces:**
- Consumes: `calc(d)`、`d.taxIn`。
- Produces: なし（出力HTMLのみ）。

- [ ] **Step 1: `renderSheet`**

`const TI=!!d.taxIn;` を先頭に置き、
- 見出し：`"単価"`→`TI?"単価(税込)":"単価"`、`"金額"`→`TI?"金額(税込)":"金額"`（同じ `A(...)` 呼び出し。税込時は `ex` に `font-size:8.5px` を渡して枠に収める）
- 合計欄：`"小計"`→`TI?"小計(税抜)":"小計"`（税込時 `font-size:8.5px`）、`` `消費税（${d.taxRate}％）` ``→`` `${TI?"内消費税":"消費税"}（${d.taxRate}％）` ``

- [ ] **Step 2: `renderEstimate`**

同様に見出し（`A(358.1,360,"単価",…)`・`A(443.3,360,"金額",…)`）と合計欄（`"小計"`・`"消費税"`）。見積書の小計枠は幅 36.2px なので税込時は `"小計(税抜)"` を `font-size:7.5px` にする。

- [ ] **Step 3: 目視確認用の静的ページを作って確認**

`/tmp/preview.html` を作る：`index.html` をそのまま読み込み、`localStorage` に税込書類（Task 2 のテスト値）を仕込んでプレビューを開く手順は実機でよい。ここでは `node --check`（Task 3 Step 4 と同じコマンド）が通ることと、`grep -c "内消費税" index.html` が 3 以上（簡易領収書の既存1＋請求書1＋見積書1）であることを確認。
Run: 上記 → Expected: `OK` と `3` 以上

- [ ] **Step 4: Commit**

```bash
git add index.html && git commit -m "feat: 税込 labels on invoice/receipt/estimate sheets"
```

---

### Task 5: PDF解析の強化（`parseInvoicePdfText`）

**Files:**
- Modify: `index.html` `function parseInvoicePdfText(items)`（1259-1323行）、`importPdf`（1343行付近に `d.taxIn=!!p.taxIn`）
- Test: `tests/run.mjs`

**Interfaces:**
- Consumes: 文字片 `{str,x,y,w}[]`（従来通り）。
- Produces: 戻り値に `taxIn:boolean` を追加。それ以外のキーは従来通り。
- 内部ヘルパー（同関数内）：`lines[i].joined`（文字片を空白なしで連結した文字列）。

- [ ] **Step 1: 失敗するテストを追加**

```js
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
```

- [ ] **Step 2: 実行して新規5件が失敗することを確認**

Run: `node tests/run.mjs` → Expected: 新規5件 FAIL（「既存書式は税抜のまま」は `taxIn` が undefined なので `false` と不一致で FAIL）

- [ ] **Step 3: 実装（spec §5 の 1〜8）**

同関数内に閉じて実装する。決めごと：
- 行の `joined`：`l.items.map(i=>i.s).join("")`。
- 日付正規表現：`/(\d{4})\s*[年\/\-.]\s*(\d{1,2})\s*[月\/\-.]\s*(\d{1,2})/`（ラベル付き優先は従来通り）。`all` は行 `text` の連結なので空白が入る——`\s*` で吸収。
- 見出し行：`/(摘要|品名)/.test(joined) && /金額/.test(joined)`。列 x：見出し語の**先頭文字片**の x。`joined` 上の語と文字片の対応は、文字片を順に連結しながら語の開始位置を含む文字片を探す（ヘルパー `colX(word)`）。右端の備考列は、品名列と別に「摘要」が**金額より右**にある場合のみ `xNote` とする。「月日」「日付」があれば `xDate`。
- 件名フォールバック：`/^(CL|現場名?|工事名|物件名|案件名)$/` に一致する文字片で始まる行（見出し行より上）の残りを `join(" ")`。
- 小計行の検索（`si`）も `joined` で行う（iOS書式は「小 計」と離れている）。
- 明細行：`¥`／`\`／`円` 単独は無視。`/^(\d+(?:\.\d+)?)\s*(個|式|…)$/`（既存の単位リスト）で数量＋単位の1文字片を分ける。数値の次の文字片が単位なら結合。日付列：見出しは中央寄せなので x 範囲では判定せず、`xDate!=null && it.x < xDesc && /^\d{1,2}(\/\d{1,2})?$/.test(s)` の文字片だけを日付部品とし（`m/d` 1片、または `m` `d` 2片）、書類日付の年で `YYYY-MM-DD`。それ以外の左側の文字片は従来通り desc。`xNote` 列の文字は `desc` 末尾に `" "` 区切りで連結。「(税込)」「税込」文字片は desc に入れず `sawTaxIn=true`。
- `taxIn` 判定：`sawTaxIn`、または 「合計」「税込合計」「請求金額」「御請求」を含む行の最大金額 `T` について `Math.abs(T − Σqty×price) <= 1` かつ 消費税行の金額 `≠0`。
- 税率：既存に加えて `/(\d{1,2})\s*[%％]\s*対象/`。
- 戻り値の `out` 初期値に `taxIn:false` を追加。`importPdf` で `d.taxIn=!!p.taxIn`。

- [ ] **Step 4: 全テスト**

Run: `node tests/run.mjs` → Expected: `12 passed, 0 failed`（回帰3件が壊れていないこと）

- [ ] **Step 5: 実PDFで確認（リポジトリ外）**

Run: `node -e 'import("./tests/extract.mjs").then(({extractFns})=>{const {parseInvoicePdfText}=extractFns(["parseInvoicePdfText"]);console.log(JSON.stringify(parseInvoicePdfText(JSON.parse(require("fs").readFileSync("/home/claude/pdftest/items.json"))),null,1))})'`
Expected: 実データでも client／date／subject／items 3行／taxIn true が取れる（出力はチャットに貼らない）。

- [ ] **Step 6: Commit**

```bash
git add index.html tests/run.mjs && git commit -m "feat: parse iOS-style invoice PDFs (spaced headers, 税込 items, CL subject)"
```

---

### Task 6: 発行者情報の取り込み（`parseIssuerPdfText` と設定画面）

**Files:**
- Modify: `index.html`
  - 新関数 `function parseIssuerPdfText(items)`（`parseInvoicePdfText` の直後）
  - `importPdf` から文字片の取得部分を `async function pdfTextItems(file)` に切り出し（`loadPdfJs`→`getDocument`→`getTextContent`＋Widget注釈。`importPdf` はこれを呼ぶ）
  - 設定画面の発行者情報カード（392行付近の上）に `<label class="btn ghost" style="cursor:pointer">📄 自分のPDFから発行者情報を取り込む<input type="file" id="s_issuerPdf" accept="application/pdf,.pdf" hidden></label>`
  - `#s_issuerPdf` の `change` ハンドラ（設定系ハンドラの並び、1416行付近）
- Test: `tests/run.mjs`

**Interfaces:**
- Produces: `parseIssuerPdfText(items) → {company?,zip?,addr1?,addr2?,tel?,email?,regno?,bank?,bankType?,bankNo?,bankName?}`。見つかったキーだけ入れる（空文字は入れない）。何も無ければ `{}`。
- Produces: `pdfTextItems(file) → Promise<{str,x,y,w}[]>`。

- [ ] **Step 1: 失敗するテストを追加**

```js
test("issuer ios-invoice", ()=> eq(parseIssuerPdfText(load("ios-invoice")),
  {company:"テスト",zip:"900-0000",addr1:"那覇市泉崎1丁目 1-1",addr2:"サンプルビル 101",tel:"090-0000-0000",bank:"サンプル銀行 中央支店",bankType:"普通",bankNo:"1234567",bankName:"テストセツビ"}));
test("issuer 宛名だけ", ()=> eq(parseIssuerPdfText([{str:"テスト工務店",x:19,y:89,w:60},{str:"御中",x:229,y:90,w:12}]), {}));
test("issuer メール・登録番号", ()=>{ const f=load("ios-invoice"); f.push({str:"info@example.com",x:327,y:166,w:80},{str:"登録番号 T1234567890123",x:327,y:176,w:100});
  const r=parseIssuerPdfText(f); eq([r.email,r.regno],["info@example.com","T1234567890123"]); });
```
`extractFns` の呼び出しに `"parseIssuerPdfText"` を加える。

- [ ] **Step 2: 実行して3件が失敗（not found）することを確認**

Run: `node tests/run.mjs` → Expected: `extractFns` が `not found: parseIssuerPdfText` で throw

- [ ] **Step 3: `parseIssuerPdfText` を実装（spec §6）**

決めごと：
- 行組み立ては `parseInvoicePdfText` と同じ（y 近傍 6.5、`norm` は NFKC＋空白圧縮。NFKC で全角数字・全角空白は半角になる——期待値もその前提）。
- 対象領域：見出し行（`/(摘要|品名)/ && /金額/`）より上で、行の最小 x ≥ 280 の行。無ければ見出し行より上の全行。
- `zip`：`/〒?\s*(\d{3})\s*-?\s*(\d{4})/` → `"900-0000"` 形式。
- `company`：zip 行の直前の行。文字片がすべて1文字なら `""` で、そうでなければ `" "` で連結。無ければ `/(株式会社|有限会社|合同会社)/` を含む行の text。
- `addr1`／`addr2`：zip 行の次から、`tel`／`email`／`regno` に一致する行の手前まで最大2行（`text` をそのまま）。
- `tel`：`/(?:TEL|電話)?\s*[:：]?\s*(0\d{1,4}-\d{1,4}-\d{3,4})/`。`email`：`/[\w.+-]+@[\w.-]+\.\w+/`。`regno`：`/T\d{13}/`。
- 振込先はページ全体の行から：`/(銀行|信用金庫|信用組合|信金|農協|JA|ゆうちょ)/` を含む最初の行の text → `bank`；`/(普通|当座|貯蓄)/` を含む行 → `bankType` にその語、同じ行の `/\d{5,8}/` → `bankNo`；`/(口座名義|名義|カナ)\s*[:：]?\s*(.+)/` → `bankName`。
- 空文字のキーは削除してから返す。

- [ ] **Step 4: `pdfTextItems` の切り出しと設定画面ハンドラ**

`#s_issuerPdf` の `change`：`const r=parseIssuerPdfText(await pdfTextItems(f));` → `const keys=Object.keys(r);` → `keys.length===0` なら `alert("発行者情報を読み取れませんでした（文字が選択できるPDFを選んでください）")`。それ以外は `keys.forEach(k=>$("#s_"+k).value=r[k])` して `toast(keys.length+"項目を入力欄に入れました。確認して保存してください")`。エラーは `alert("PDFを読み込めませんでした: "+err.message)`。`e.target.value=""` を忘れない。

- [ ] **Step 5: テストと構文チェック**

Run: `node tests/run.mjs` → Expected: `15 passed, 0 failed`
Run: Task 3 Step 4 のコマンド → Expected: `OK`

- [ ] **Step 6: Commit**

```bash
git add index.html tests/run.mjs && git commit -m "feat: import issuer info into settings from own PDF"
```

---

### Task 7: 使い方ページ・バージョン・仕上げ

**Files:**
- Modify: `index.html`（使い方「よくある操作」カード 377行付近、`APP_VERSION` 715行）
- Modify: `version.txt`
- Modify: `README.md`（機能一覧があれば1行ずつ追記）

- [ ] **Step 1: 使い方に3項目追加**

「既存のPDFから作りたい」の下に `<details>` を3つ：
- 「税込の金額で入力したい」：明細の下の「入力方法」で<b>税込で入力</b>。単価・金額が税込になり、帳票は 小計（税抜）／内消費税／合計。新規作成時の既定は設定画面。古い版のアプリで開くと税抜計算になるので端末ごとに更新する。
- 「他のアプリで作ったPDFを取り込む」：文字が選択できるPDFで、明細表に「数量」「金額」などの見出しがあれば読める。明細が税込の書式は自動で「税込で入力」になる。読めなかった項目は手で補う。
- 「設定を自分のPDFから取り込む」：設定画面の <span class="kbd">📄 自分のPDFから発行者情報を取り込む</span>。屋号・住所・電話・振込先が入力欄に入るので確認して保存。

- [ ] **Step 2: バージョン**

`APP_VERSION="1.10.0"`、`version.txt` を `1.10.0`。

- [ ] **Step 3: 全体確認**

Run: `node tests/run.mjs` → `15 passed, 0 failed`
Run: Task 3 Step 4 の構文チェック → `OK`
Run: `grep -n 'APP_VERSION=' index.html && cat version.txt` → 両方 1.10.0
Run: `git grep -n "スタジオ\|楚辺\|8290\|443809" -- tests` → 出力なし

- [ ] **Step 4: Commit**

```bash
git add index.html version.txt README.md && git commit -m "docs: how-to entries for 税込入力/他社PDF/発行者取込; bump to v1.10.0"
```

- [ ] **Step 5: 本人への引き渡し**

ブランチ `feature/tax-in-pdf-import` の状態で、`index.html` 全文を SendUserFile で渡し、main へのマージ・push の可否を確認する。実機確認項目：iPhone で実PDFを取り込み → 明細3行・税込・合計 ¥942,100 → プレビューで「単価(税込)」「小計(税抜)」「内消費税」→ PDF作成。設定画面で同PDFから発行者情報を取り込み（取り込んだ値は保存せず破棄してよい）。
