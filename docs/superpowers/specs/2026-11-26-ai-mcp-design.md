# REDSEAL AI連携（MCP）設計（v1.15.0・2026-11-26）

## 目的
Claude などのAIに「先月の〇〇様の見積を請求書にして」「未入金を教えて」と頼むと、AIが REDSEAL のデータを直接読み書きできるようにする。販売時の売りにもする。
本人の指示：細かいことは聞かず、Superpowers で最終段階まで仕上げる（判断はすべて Claude）。

## 目標／目標外／してはいけないこと
- 目標：書類の検索・詳細、見積／請求／領収の新規作成、変換（見積→請求→領収）、改訂版、入金済み・失注の記録、売上集計（前年同月比・未入金・受注率）、送付文面の作成
- 目標外：PDF作成・送信（PDFは端末のアプリで作る。AIは「アプリで確認して送ってください」と案内）、設定の変更、社判
- してはいけない：AIが書類を消す／本人が作った書類の中身を書き換える／確認なしで客に届く
  → 削除ツールは作らない。AIが作った書類には `aiDraft:true` を付け、アプリで「AI下書き」と表示。中身の変更は AI下書きだけ。本人がアプリで保存すると印が外れる

## 方式（検討した案）
| 案 | 内容 | 判断 |
|---|---|---|
| A. GAS に MCP の入口を追加 | 既存の同期用 GAS（スプレッドシート）に JSON-RPC（MCP Streamable HTTP・状態なし）を足す。URL に `?ai=キー` | **採用**。サーバー追加なし・無料・既存の同期データをそのまま使える |
| B. Cloudflare Workers 等に MCP サーバー | 別サーバーから GAS を呼ぶ | 不採用。アカウント・保守が増える |
| C. パソコン用 MCP（stdio）だけ | Claude デスクトップ用 | A の補助として採用：`mcp/redseal-mcp.mjs` は A に中継するだけ（ロジックは GAS に一本化） |

GAS のウェブアプリは応答を別URLへリダイレクトで返す。claude.ai のカスタムコネクタで接続できない場合は C の中継を使う（README に明記）。

## 仕組み
- `gas/Ai.gs`：MCP 本体。`handle_` の先頭で JSON-RPC（`jsonrpc:"2.0"` または配列）なら `mcpHandle_` へ
- `gas/AiShared.gs`：index.html の集計用の純粋関数（calc・salesStats・receivables など）を `tools/build-gas.mjs` で自動コピー。手で直さない（テストで一致を確認）
- 認証：スクリプトプロパティ `AI_KEY`（公開リポジトリにキーを置かない）。エディタで `setupAI()` を1回実行するとキーを作り、接続用URLをログに出す。`resetAIKey()` で作り直し、`disableAI()` で停止。同期用 API_KEY とは別
- 対応メソッド：initialize（2025-06-18／2025-03-26／2024-11-05）、ping、tools/list、tools/call、通知は空応答。一括（配列）対応。tools/call は LockService で排他
- ツール：list_documents、get_document、create_document、update_draft、convert_document、revise_document、set_status、sales_report、message_text、get_issuer_info
- 番号：アプリと同じ規則（案件番号 YYMM-NNN を月内連番。削除済みも含めて最大＋1、書類No.＝頭文字＋案件番号＋改訂 -2…、頭文字は同期済み設定 prefixEst/Inv/Rcp）
- 日付：Asia/Tokyo。期限は設定 estDays/invDays（既定30日）
- 書き込みは upsertDoc_ と同じ行形式。updatedAt＝現在時刻なので、アプリは次の同期で取り込む

## アプリ側（index.html）
- 一覧に「AI下書き」札、編集画面に案内（保存すると印が外れる）。複製・変換・改訂の写しには付けない
- 使い方画面に「AIから操作する」の説明
- 埋め込みの GAS コード（コピー用）＝ Code.generic.gs ＋ AiShared.gs ＋ Ai.gs（ビルドで生成）
- `gas/.claspignore` で Code.generic.gs を自動デプロイから除外（同じ定数が2回宣言されてエラーになるのを防ぐ）

## Claude の判断（本人未確認）
ツール名・項目名、AI下書きの扱い、削除ツールなし、PDFは作らない、明細は21行まで、金額は数値チェックのみ、取り込み書類（imp_）も変換元にできる（アプリと同じ）
