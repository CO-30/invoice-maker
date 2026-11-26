# REDSEAL をAIから操作する（MCP）

Claude などのAIに頼むと、REDSEAL の書類を探す・作る・変換する・入金を記録する・売上を集計する、ができます。

例：
- 「先月の〇〇様の見積を請求書にして」
- 「未入金の請求書を、期限が過ぎている順に教えて」
- 「今年の売上を去年と月ごとに比べて」
- 「〇〇工務店にエアコン清掃2台、1台8,000円で見積を作って。LINEで送る文面も」
- 「I2611-003 は今日入金があったので入金済みにして」

## 前提
クラウド同期（Googleスプレッドシート＋GAS）を使っていること。AIはスプレッドシートのデータを読み書きし、スマホのアプリには次の同期（アプリを開いたとき）で出てきます。発行者情報・番号の頭文字などは、アプリで「設定を保存」したときに同期された設定を使います。

## 設置（1回だけ・5分）
1. **GASを最新にする**
   - 自動デプロイ（GitHub Actions）を使っている場合：このリポジトリを push すれば `gas/Ai.gs`・`gas/AiShared.gs` も反映されます
   - 貼り付けで使っている場合：アプリの「使い方」→ **プログラムをコピー（Code.gs）** で全部をコピーし、Apps Script に貼り直して保存 → 「デプロイを管理 → 編集 → 新バージョン → デプロイ」
2. **AIのキーを作る**：Apps Script のエディタで関数 **setupAI** を選んで ▶実行（初回は権限の確認が出ます）→ 実行ログに出る **AI接続用URL**（`…/exec?ai=…`）をコピー
   - キーはスクリプトのプロパティに保存され、コードには書かれません（公開リポジトリでも安全）
3. **AIに登録する**（どちらか）
   - **Claude（Web・アプリ）**：設定のコネクタで「カスタムコネクタを追加」→ 名前「REDSEAL」、URL に 2 のURL を貼る（スマホからも使えるようになります）
   - **Claude デスクトップ・Claude Code（パソコン）**：中継 `mcp/redseal-mcp.mjs` を使う（Node.js 18以上）。Claude デスクトップの設定ファイル（claude_desktop_config.json）に：
     ```json
     {
       "mcpServers": {
         "redseal": {
           "command": "node",
           "args": ["/保存した場所/redseal-mcp.mjs"],
           "env": { "REDSEAL_URL": "https://script.google.com/macros/s/…/exec?ai=…" }
         }
       }
     }
     ```
     Claude Code なら：`claude mcp add redseal -e REDSEAL_URL="https://…/exec?ai=…" -- node /保存した場所/redseal-mcp.mjs`
4. 確認：ブラウザで 2 のURLを開き `{"ok":true,"server":"redseal",…}` と出ればOK

> GAS のウェブアプリは、返事を別のURLへ転送（リダイレクト）して返す仕組みです。カスタムコネクタでうまくつながらない場合は、パソコンの中継（3の下）を使ってください。

## AIができること（ツール）
| ツール | 内容 |
|---|---|
| list_documents | 書類を探す（種類・期間・キーワード・未入金／期限超過／受注／失注／AI下書き） |
| get_document | 1件の詳細（明細・金額・状況・同じ案件の書類）。ID か 書類No. |
| create_document | 見積書・請求書・領収書を作る（番号・期限は自動） |
| update_draft | AIが作った下書きを直す |
| convert_document | 見積→請求、請求→領収（案件番号を引き継ぐ） |
| revise_document | 再見積・再発行（改訂版 -2…） |
| set_status | 請求書の入金済み・入金日、見積書の失注 |
| sales_report | 月別売上と前年同月比・年間合計・目標・未入金・取引先別・品目別・受注率 |
| message_text | LINE用・メール用の送付文面、入金確認の文面 |
| get_issuer_info | 発行者情報・定型の明細・既定の税率と日数 |

## 安全のための決まり
- AIが作った書類は **AI下書き**。アプリの一覧に札が出て、本人が確認して「保存」すると外れます
- AIは **削除できません**。本人が作った書類の **中身は変更できません**（改訂版を作るか、入金済み・失注の記録だけ）
- AIは **PDFを作らず、送りません**。PDFの作成・送付はこれまでどおりアプリで
- URL は合言葉と同じです。人に教えない。漏れたら **resetAIKey**（URLが変わる）、やめるときは **disableAI** を実行

## 開発メモ
- 本体は `gas/Ai.gs`（MCP Streamable HTTP・状態なし・JSON応答、protocol 2025-06-18／2025-03-26／2024-11-05）。`Code.gs` の `handle_` で JSON-RPC を振り分け
- `gas/AiShared.gs` は index.html の計算関数の自動コピー：index.html を直したら `node tools/build-gas.mjs`（埋め込みGASも作り直す）
- テスト：`node tests/ai.mjs`（GASの模擬実行）、`node tests/bridge.mjs`（中継）
