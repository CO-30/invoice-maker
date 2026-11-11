/**
 * 共通の要望受付（REDSEAL・左官見積・水道見積 など、どのアプリからでも受け付ける）
 *
 * 設置手順（1回だけ・パソコン推奨）
 * 1. Googleスプレッドシートを新規作成（名前は任意。例「要望受付」）
 * 2. 拡張機能 → Apps Script を開き、このコードを全て貼り付けて保存
 * 3. 下の NOTIFY_EMAIL に通知を受け取るメールアドレスを入れる（空なら自分のGmail）
 * 4. 関数の選択で「setup」を選んで ▶実行 → 権限を承認（詳細 → 安全ではないページに移動 → 許可）
 *    → シートが作られ、毎週月曜の朝に「まとめ」メールが届くよう予約されます
 * 5. デプロイ → 新しいデプロイ → 種類「ウェブアプリ」
 *      実行ユーザー：自分 ／ アクセスできるユーザー：全員
 *    → 表示された「ウェブアプリのURL（…/exec）」を各アプリの FEEDBACK_URL に入れる
 * 6. コードを変えたら「デプロイを管理 → 鉛筆 → 新バージョン → デプロイ」
 *
 * 届いた要望は「要望」シートに1行ずつたまります。状態の列は 未対応／対応中／完了／見送り などを自由に書いてOK。
 */
const NOTIFY_EMAIL = "";            // 通知先。空なら このスクリプトの持ち主のGmail
const NOTIFY_EACH = true;           // 1件ごとにメールで知らせる
const DIGEST_WEEKDAY = ScriptApp.WeekDay.MONDAY; // 週1回のまとめを送る曜日
const DIGEST_HOUR = 8;              // 何時ごろに送るか（0〜23）
const MAX_PER_DEVICE_PER_DAY = 20;  // 1台から受け付ける上限（荒らし対策。約6時間ごとにリセット）
const MAX_TOTAL = 200;              // 全体で受け付ける上限（約6時間あたり。端末IDを偽る荒らし対策）
const MAX_MAILS_PER_DAY = 50;       // 1件ごとの通知メールの上限（Gmailの送信枠を週のまとめ用に残す）
const SHEET = "要望";
const COLS = ["受信日時","アプリ","版","種類","内容","返信先","端末","操作の記録","エラー","その他","状態","メモ","端末ID"];

function doGet(){ return out_({ok:true, service:"feedback"}); }

function doPost(e){
  let r;
  try{ r = JSON.parse((e && e.postData && e.postData.contents) || "{}"); }
  catch(err){ return out_({ok:false, error:"bad json"}); }
  try{ return out_(receive_(r)); }
  catch(err){ console.error(err); return out_({ok:false, error:"server busy"}); }
}

/** 受け付け本体（テストしやすいよう doPost から分離） */
function receive_(r){
  const text = clip_(r.text, 2000).trim();
  const app = clip_(r.app, 40).trim();
  if(!app) return {ok:false, error:"app required"};
  if(!text) return {ok:false, error:"text required"};
  const dev = clip_(r.deviceId, 40) || "unknown";
  if(!allow_("all", MAX_TOTAL) || !allow_("n_" + dev, MAX_PER_DEVICE_PER_DAY)) return {ok:false, error:"too many"};
  const env = r.env || {};
  const row = [
    new Date(), safe_(app), safe_(clip_(r.version, 20)), safe_(clip_(r.kind, 10) || "要望"), safe_(text), safe_(clip_(r.reply, 120)),
    safe_(clip_([env.device, env.standalone ? "ホーム画面" : "ブラウザ", env.screen, env.path].filter(Boolean).join(" / "), 200)),
    safe_(clip_(fmtLog_(r.log), 5000)), safe_(clip_(fmtErr_(r.errors), 3000)), safe_(clip_(r.context ? JSON.stringify(r.context) : "", 1000)),
    "未対応", "", safe_(dev)
  ];
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try{ sheet_().appendRow(row); } finally{ lock.releaseLock(); }
  if(NOTIFY_EACH && mailBudget_()){
    try{ notify_(row); }catch(err){ console.warn("notify failed: " + err); }
  }
  return {ok:true};
}

function notify_(row){
  const [at, app, ver, kind, text, reply, dev, log, errs] = row;
  const subject = "【" + app + "】" + kind + "：" + text.replace(/\s+/g," ").slice(0, 30);
  const body = [
    app + "（" + (ver || "版不明") + "）に" + kind + "が届きました。", "",
    text, "",
    "返信先：" + (reply || "なし"),
    "端末：" + dev,
    errs ? "\n▼ エラー\n" + errs : "",
    log ? "\n▼ 直前の操作（新しい順）\n" + log.split("\n").slice(-15).reverse().join("\n") : "",
    "", "一覧：" + SpreadsheetApp.getActiveSpreadsheet().getUrl()
  ].join("\n");
  MailApp.sendEmail(notifyTo_(), subject, body);
}

/** 週1回のまとめ（setup で予約。手動で実行してもOK） */
function weeklyDigest(){
  const props = PropertiesService.getScriptProperties();
  const since = new Date(+props.getProperty("lastDigest") || (Date.now() - 7*864e5));
  const rows = sheet_().getDataRange().getValues().slice(1).filter(r => r[0] instanceof Date && r[0] > since);
  const now = new Date();
  const open = sheet_().getDataRange().getValues().slice(1).filter(r => String(r[10]||"") === "未対応").length;
  const body = digestText_(rows, since, open);
  if(rows.length || open) MailApp.sendEmail(notifyTo_(), "【要望まとめ】今週 " + rows.length + "件（未対応 合計" + open + "件）", body);
  props.setProperty("lastDigest", String(now.getTime())); // 送れた後に記録（送信失敗なら次回に持ち越し）
}

function digestText_(rows, since, openCount){
  const tz = Session.getScriptTimeZone();
  const by = {};
  rows.forEach(r => { (by[r[1]] = by[r[1]] || []).push(r); });
  const apps = Object.keys(by).sort();
  const lines = ["期間：" + Utilities.formatDate(since, tz, "M/d") + "〜", "今週届いた件数：" + rows.length + "件　／　未対応の合計：" + openCount + "件", ""];
  lines.push(apps.length ? apps.map(a => a + " " + by[a].length + "件").join("、") : "今週の新しい要望はありません");
  apps.forEach(a => {
    lines.push("", "■ " + a);
    by[a].forEach(r => lines.push("・[" + r[3] + "] " + String(r[4]).replace(/\s+/g," ") + "（" + Utilities.formatDate(r[0], tz, "M/d") + "・" + (r[2]||"") + (r[8] ? "・エラーあり" : "") + "）"));
  });
  if(rows.length){
    lines.push("", "────────────", "▼ AIに渡す用（ここから下をコピーしてClaudeに貼り付け）", "",
      "以下は自作アプリに届いた利用者の要望・不具合報告です。",
      "1) アプリごとに「不具合」「改善要望」「新機能」「その他」に分類",
      "2) 同じ内容はまとめて件数を付ける",
      "3) 影響の大きさと手間から優先順位（高・中・低）を付ける",
      "4) 不具合はエラーと操作の記録から原因の見当を書く",
      "を表にしてください。", "");
    rows.forEach((r, i) => {
      lines.push("--- " + (i+1) + " ---", "アプリ：" + r[1] + "（" + r[2] + "）", "種類：" + r[3], "内容：" + r[4]);
      if(r[8]) lines.push("エラー：" + String(r[8]).slice(0, 500));
      if(r[7]) lines.push("直前の操作：" + String(r[7]).split("\n").slice(-10).join(" → "));
    });
  }
  lines.push("", "一覧：" + SpreadsheetApp.getActiveSpreadsheet().getUrl());
  return lines.join("\n");
}

/** 最初に1回実行：シート作成と週1回の予約 */
function setup(){
  sheet_();
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === "weeklyDigest").forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("weeklyDigest").timeBased().onWeekDay(DIGEST_WEEKDAY).atHour(DIGEST_HOUR).inTimezone("Asia/Tokyo").create();
  MailApp.sendEmail(notifyTo_(), "【要望受付】設定が完了しました", "このアドレスに要望の通知と、毎週のまとめが届きます。\n" + SpreadsheetApp.getActiveSpreadsheet().getUrl());
}

/* ---------- 補助 ---------- */
function sheet_(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET);
  if(!sh){
    sh = ss.insertSheet(SHEET); sh.appendRow(COLS); sh.setFrozenRows(1);
    sh.getRange(1,1,1,COLS.length).setFontWeight("bold").setBackground("#eef0f3");
    sh.setColumnWidth(5, 360); sh.setColumnWidth(8, 260);
    sh.getRange("K2:K").setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(["未対応","対応中","完了","見送り"], true).setAllowInvalid(true).build());
  }
  return sh;
}
function notifyTo_(){ return NOTIFY_EMAIL || Session.getEffectiveUser().getEmail(); }
function allow_(k, max){
  const c = CacheService.getScriptCache(), n = +(c.get(k) || 0);
  if(n >= max) return false;
  c.put(k, String(n + 1), 21600); // 6時間（キャッシュの上限）ごとにリセット
  return true;
}
function mailBudget_(){ // 今日の通知メール数を数え、上限内なら true
  const p = PropertiesService.getScriptProperties(), d = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyyMMdd");
  const m = (p.getProperty("mailDay") === d) ? +(p.getProperty("mailN") || 0) : 0;
  if(m >= MAX_MAILS_PER_DAY) return false;
  p.setProperty("mailDay", d); p.setProperty("mailN", String(m + 1)); return true;
}
// シートが数式として扱わないよう、= + - @ で始まる文字には ' を付ける
function safe_(v){ v = String(v == null ? "" : v); return /^[=+\-@]/.test(v) ? "'" + v : v; }
function clip_(v, n){ return String(v == null ? "" : v).slice(0, n); }
function fmtLog_(log){
  if(!Array.isArray(log)) return "";
  return log.slice(-30).map(x => clip_(x && x.t, 8) + " " + clip_(x && x.a, 80)).join("\n");
}
function fmtErr_(errs){
  if(!Array.isArray(errs)) return "";
  return errs.slice(-5).map(x => clip_(x && x.t, 8) + " " + clip_(x && x.m, 400)).join("\n");
}
function out_(o){ return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
