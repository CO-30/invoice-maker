# v1.11.0 実装計画（売上集計・入金管理）

設計書：`docs/superpowers/specs/2026-11-11-sales-report-and-payments-design.md`
実行方法：インライン実行（executing-plans）。テスト：`node tests/run.mjs`

## Task 1 集計ロジック（TDD）
- [ ] tests/run.mjs に docStatus / salesStats / receivables / estimateStats のテストを先に書き、失敗を確認
- [ ] index.html「集計」節に純粋関数を実装（`^function 名前(...){ ... ^}` 形式＝extract.mjs で切り出せる形。外部変数を使わず引数だけで完結）
  - `latestDocs(docs)`：削除除外＋案件×種別ごとの最新版
  - `salesDocs(docs)`：請求書＋（請求書の無い案件の）領収書
  - `docStatus(d, docs, today)`：invoice→paid/overdue/unpaid、estimate→won/lost/open、receipt→""
  - `salesStats(docs, opt)`：opt={fy, fyStart, basis, manual, defRate, today, goal}
  - `receivables(docs, today)`、`estimateStats(docs, fy, fyStart)`
- [ ] テストが通ることを確認

## Task 2 画面
- [ ] 下部タブ「集計」＋ view-report（KPI、SVGグラフ、月別表、ランキング、未入金一覧、手入力モーダル、CSV）
- [ ] 編集画面：入金欄（請求書）、見積状況欄、入金確認ボタン。readEdit/bindEdit に追加、変換・改訂・複製で paid/paidAt/lost を消す
- [ ] 一覧：札と「未入金」絞り込み
- [ ] 設定：fyStart・salesGoal・lineRem・mailRem（SKEYS 追加、DEFAULT_SETTINGS に既定文面）
- [ ] CSV に「入金日」「状況」列
- [ ] 使い方に「売上の集計」「入金管理」節、gasSrc を Code.generic.gs と同期
- [ ] APP_VERSION / version.txt を 1.11.0

## Task 3 検証
- [ ] node tests/run.mjs 全件成功
- [ ] Playwright（ヘッドレス Chromium）で集計・編集・一覧のスクリーンショット確認、コンソールエラーなし
- [ ] 独立監査（別エージェント、設計書と差分のみを渡す）→ 指摘の検証と修正
