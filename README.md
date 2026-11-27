# REDSEAL（見積・請求・領収）

旧名：見積・請求書メーカー

スマホ（iPhone）から見積書・請求書・領収書を作成し、PDFをLINE・メールで送れる単体HTMLアプリ。

- `index.html` … アプリ本体（これ1ファイルで動作。外部ライブラリはCDNから読込）
- データは端末のブラウザ内（localStorage）に保存。設定画面からJSONでバックアップ可能
- 発行者情報・振込先・社判・税率・定型明細は設定画面で変更可
- 税抜／税込（内税）どちらの入力方法にも対応（書類ごとに切替、既定は設定画面）
- 他のアプリで作った請求書PDFからの書類作成、自分のPDFからの発行者情報取り込みに対応
- テスト：`node tests/run.mjs`（依存パッケージなし）

## 使い方
1. GitHub Pages で公開した URL を iPhone の Safari で開く
2. 共有ボタン →「ホーム画面に追加」でアプリ化
3. 設定画面で発行者情報と社判を確認 → 作成画面で書類を作る → 「PDFを作成して共有」

## クラウド同期（Googleスプレッドシート）
`gas/Code.gs` をスプレッドシートの Apps Script に貼り付けてウェブアプリとしてデプロイし、
そのURLとAPIキーをアプリの設定画面に入れると、書類がスプレッドシートにも保存されます。
詳しい手順は `gas/Code.gs` 冒頭のコメントを参照。

## 外部連携

Muse などの外部AIが、REST API（または MCP）で見積・請求・領収を扱うための入口です。
構成：外部AI → **Cloudflare Workers（`api/`）** → GAS（`gas/Api.gs`）→ スプレッドシート ←同期→ アプリ。どちらも無料枠で使えます。

### ベースURL
`https://redseal-api.<あなたのサブドメイン>.workers.dev`（API は `/api/v1`、仕様書は `/openapi.json`、MCP は `/mcp`）。
**設置するまでこのURLは存在しません。** 下の手順で設置すると決まります。

### 設置手順（1回だけ）
1. **GAS**：`gas/` を最新にする（Code.gs・AiShared.gs・Ai.gs・**Api.gs**）。貼り付け運用なら、アプリの「使い方」→プログラムをコピー（4つまとめて入ります）。**自分の API_KEY・PDF_FOLDERS・IMPORT_FOLDER_IDS の値は、貼る前に控えて入れ直してください。** 保存後「デプロイを管理 → 編集 → 新バージョン」。
2. Apps Script のエディタで **setupApi** を実行 → ログのキーを控える（`GAS_BRIDGE_KEY`）。
3. **Cloudflare**（無料アカウント）：
   ```sh
   cd api
   npx wrangler@4 login
   npx wrangler@4 deploy
   npx wrangler@4 secret put GAS_URL          # …/exec
   npx wrangler@4 secret put GAS_BRIDGE_KEY   # 2 のキー
   npx wrangler@4 secret put ADMIN_TOKEN      # 必ず openssl rand -base64 32 などの乱数（32文字以上）。覚えやすい言葉は使わない
   ```
   GitHub から自動で反映する場合は、リポジトリの Secrets に `CLOUDFLARE_API_TOKEN`（テンプレート「Edit Cloudflare Workers」）と `CLOUDFLARE_ACCOUNT_ID` を登録して、Actions の「Deploy API」を実行します。秘密の3つは Cloudflare の画面（Worker → Settings → Variables and Secrets、種類は Secret）でも登録できます。
4. アプリを別の場所で公開している場合は、`api/wrangler.toml` の `ALLOWED_ORIGINS` を直す。

秘密はコードに書きません。項目は `api/.env.example`（手元で試すときは `.dev.vars` にコピー）。

### 認証方法
APIキーを `Authorization: Bearer <キー>` か `X-API-Key: <キー>` で送ります。https のみ。URL に載せると 400 になります。
- 読み取り専用（`documents:read`）／読み書き（`documents:read`・`documents:write`）
- パスワードや Cookie は使いません。OAuth 2.0 は `api/src/app.mjs` の `authenticate()` にトークン検証を足せば、同じスコープで追加できます

### キー発行手順
アプリの **設定 → 外部連携（APIキー）** で、ベースURLと管理トークンを入れる → 名前と権限を選んで「キーを発行」→ 表示されたキーをコピー（**この時だけ表示**）。再発行・無効化も同じ画面です。保存されるのはハッシュだけです。

curl で行う場合：
```sh
curl -X POST "$BASE/api/v1/keys" -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" -d '{"name":"Muse","scope":"write"}'
```

### エンドポイント一覧
| メソッド | パス | 内容 | 権限 |
|---|---|---|---|
| GET | /api/v1/health | 稼働確認 | 不要 |
| GET | /api/v1/me | 認証確認 | read |
| GET | /api/v1/documents | 一覧・検索・差分（type, q, status, from, to, updated_since, include_deleted, limit, offset） | read |
| POST | /api/v1/documents | 作成（AI下書き） | write |
| GET | /api/v1/documents/{id} | 詳細 | read |
| PATCH | /api/v1/documents/{id} | AI下書きを直す | write |
| DELETE | /api/v1/documents/{id} | AI下書きを削除 | write |
| POST | /api/v1/documents/{id}/convert | 見積→請求→領収 | write |
| POST | /api/v1/documents/{id}/revise | 改訂版 | write |
| POST | /api/v1/documents/{id}/status | 入金済み・失注 | write |
| GET | /api/v1/documents/{id}/message | 送付文面（channel, reminder） | read |
| GET | /api/v1/reports/sales | 売上集計（year, basis） | read |
| GET | /api/v1/issuer | 発行者情報（振込先を含む） | read |
| GET・POST | /api/v1/keys | キー一覧・発行 | 管理トークン |
| POST | /api/v1/keys/{id}/rotate | 再発行 | 管理トークン |
| DELETE | /api/v1/keys/{id} | 無効化 | 管理トークン |
| GET・POST | /api/v1/webhooks | Webhook 一覧・登録 | 管理トークン |
| DELETE | /api/v1/webhooks/{id} | Webhook 削除 | 管理トークン |
| POST | /mcp | MCP（同じAPIキー） | read／write |
| GET | /openapi.json | OpenAPI 3.1 | 不要 |

主要データは書類（見積書・請求書・領収書）です。**本人が作った（確認・保存した）書類は、変更も削除もできません。** AIが作った書類は「AI下書き」になり、本人がアプリで確認してから PDF を作って送ります。削除できるのは AI下書き（入金・失注の記録と PDF がないもの）だけです。印刷しただけの下書きは「未確認」のままなので、使う書類はアプリで保存してください。API で削除する機能は、全端末のアプリを v1.16.0 以上にしてから使ってください。

### curl の例
```sh
BASE=https://redseal-api.example.workers.dev; KEY=rsk_...

# 1. 認証確認
curl "$BASE/api/v1/me" -H "Authorization: Bearer $KEY"

# 2. 未入金の請求書を10件
curl "$BASE/api/v1/documents?type=invoice&status=unpaid&limit=10" -H "Authorization: Bearer $KEY"

# 3. 見積を作る（Idempotency-Key は依頼ごとに新しい値。再送は同じ値）
curl -X POST "$BASE/api/v1/documents" -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" -H "Idempotency-Key: 7f3c2a10-0001" \
  -d '{"type":"estimate","client":"テスト工務店","subject":"清掃","items":[{"description":"エアコン清掃","quantity":2,"unit":"台","unit_price":8000}]}'
```

### 形式
- 成功：`{"data":…}`（一覧は `pagination: {limit, offset, total}` 付き）。失敗：`{"error":{"code","message"}}`
- `created_at`・`updated_at` は ISO 8601（UTC）。`date`・`due_date`・`paid_at` は日本時間の暦日（YYYY-MM-DD）。金額は円
- 回数制限：キーごとに毎分60回、認証失敗はIPごとに毎分20回。超えると 429 と `Retry-After`。MCP の一括は1件ずつ数えます
- `Idempotency-Key`：書類の書き込み（REST）で任意。24時間。`409 idempotency_unknown` は結果不明なので、一覧で確認してから新しいキーで送る。MCP は非対応

### Webhook
`document.created`／`document.updated`／`document.deleted` を POST します。本文は id・種類・書類No.・時刻だけ（宛名や金額は含みません）。
`X-Signature: sha256=<生の本文を secret で HMAC-SHA256 した16進>` を、受け側で一定時間比較で確認してください。`X-Webhook-Id`（本文の id）で重複を除きます。`occurred_at` が古すぎるものは捨ててください。届く順は保証しません。
アプリで変えた分は、同期後に最大5分ほどで届きます（APIで書いた分はすぐ）。5分の間に何度も変えた場合は1回にまとまります（作ってすぐ消した書類は通知されないことがあります）。2xx 以外は間隔を空けて最大6回。

### 差分取得の注意
`updated_since` の `updated_at` は、スマホで保存した時刻です。圏外で保存した書類は後から古い時刻で届くので、少し前の時刻から重ねて取り、ときどき全件を取り直してください。ページ送り中に更新があると位置がずれることがあります。

### 制限・注意
- GAS を通るので1回の応答に数秒かかることがあります
- 以前からの GAS 直結 MCP（`…/exec?ai=キー`、`mcp/README.md`）はキーをURLに含みます。この API を使うなら、Apps Script で **disableAI** を実行して止めることをおすすめします（外部連携APIには影響しません）。ヘッダーでキーを送れないMCPクライアントは `/mcp` につなげません
- テスト：`node tests/api.mjs`／仕様書の作り直し：`node tools/build-openapi.mjs`

詳しい設計：`docs/superpowers/specs/2026-11-27-rest-api-design.md`
