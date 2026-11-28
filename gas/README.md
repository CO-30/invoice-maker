# 自動デプロイの初期設定（1回だけ）

1. Googleスプレッドシート「見積請求データ」を作り、拡張機能 → Apps Script を開く
2. プロジェクトの設定（歯車）→「スクリプト ID」をコピー
3. 一度だけ手動デプロイ：デプロイ → 新しいデプロイ → ウェブアプリ（自分／全員）→ デプロイ
   → デプロイを管理 に出る「デプロイ ID」をコピー（ウェブアプリURLの /s/ の後ろ）
4. Googleアカウントの設定で Apps Script API をON：https://script.google.com/home/usersettings
5. パソコンで `npm i -g @google/clasp && clasp login` → `~/.clasprc.json` の中身をコピー
6. GitHub のリポジトリ → Settings → Secrets and variables → Actions に3つ登録
   - `CLASPRC_JSON` … 5 の中身
   - `SCRIPT_ID` … 2
   - `DEPLOYMENT_ID` … 3
以後、gas/ を変更して push すると自動で反映されます（Actions タブで結果確認）。
Code.generic.gs（配布用）は .claspignore で送らない設定です。

**注意（v1.16.1）**：自動デプロイはリポジトリの `API_KEY`（初期値）をそのまま送ります。初期値の合言葉は拒否されるので、
自動デプロイのウェブアプリURLでは**アプリの同期は使えません**（外部連携API・AI連携は別のキーなので使えます）。
アプリの同期には、`API_KEY` を書き換えて手動で作ったデプロイを使います。このリポジトリは公開なので、合言葉をコミットしないでください。
手動のデプロイを「新バージョン」に更新すると最新コードの初期値になり、同期が止まります。

AIから操作する設定は mcp/README.md を参照（エディタで setupAI を1回実行）。
