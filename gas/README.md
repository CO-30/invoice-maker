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
