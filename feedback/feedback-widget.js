/*!
 * 共通の要望欄（feedback-widget.js）
 * どのアプリにも同じ形で入れられる「要望・不具合の送信欄」と「直前の操作の記録」。
 *
 * 使い方（各アプリの HTML）
 *   <div id="feedback"></div>
 *   <script src="feedback-widget.js"></script>
 *   <script>
 *     FeedbackWidget.init({ app:"左官見積", version:"1.0.0", endpoint:"https://script.google.com/macros/s/…/exec" });
 *     FeedbackWidget.render("#feedback");
 *   </script>
 *
 * 記録するもの：押したボタン・タブの名前、開いた画面、アプリ内のエラー、版・端末の種類
 * 記録しないもの：入力欄の中身（文字・金額など）。入力欄を触ったことも記録しない
 * ボタン名に個人情報が入るおそれがある要素には data-fb-skip を付けると記録しない。
 * 記録名を指定したい要素には data-fb="名前" を付ける。
 */
(function(){
  "use strict";
  var MAX_LOG = 30, MAX_ERR = 5, DAY_LIMIT = 5;
  var cfg = { app:"", version:"", endpoint:"", getContext:null, title:"ご要望・不具合の報告" };
  var started = false;

  function key(k){ return "fbw_" + k + "_" + (cfg.app || "app"); }
  function load(k, d){ try{ var v = localStorage.getItem(key(k)); return v ? JSON.parse(v) : d; }catch(e){ return d; } }
  function save(k, v){ try{ localStorage.setItem(key(k), JSON.stringify(v)); }catch(e){} }
  function p2(n){ return ("0"+n).slice(-2); }
  function hm(){ var d = new Date(); return p2(d.getMonth()+1) + "/" + p2(d.getDate()) + " " + p2(d.getHours()) + ":" + p2(d.getMinutes()) + ":" + p2(d.getSeconds()); }
  function localDay(){ var d = new Date(); return d.getFullYear() + "-" + p2(d.getMonth()+1) + "-" + p2(d.getDate()); }
  function clean(s, n){ return String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n || 40); }

  /** 操作を1件記録（アプリから直接呼んでもよい：FeedbackWidget.log("PDF作成") ） */
  function log(a){
    a = clean(a, 80); if(!a) return;
    var l = load("log", []); l.push({ t: hm(), a: a }); if(l.length > MAX_LOG) l = l.slice(-MAX_LOG); save("log", l);
  }
  function logError(m){
    m = clean(m, 400); if(!m) return;
    var l = load("err", []); l.push({ t: hm(), m: m }); if(l.length > MAX_ERR) l = l.slice(-MAX_ERR); save("err", l);
    log("エラー: " + m.slice(0, 60));
  }

  /** クリックされた要素から「名前」を作る。入力欄・自由入力の文字は使わない */
  function labelOf(el){
    var t = el && el.closest && el.closest("button,a,[role=button],[role=tab],[data-fb],summary,label");
    if(!t || t.closest("[data-fb-skip]") || t.closest(".fbw")) return "";
    if(t.matches("label")) return ""; // チェックボックス等は change で記録（切り替え後の状態）
    var name = t.getAttribute("data-fb") || t.getAttribute("aria-label") || clean(t.textContent, 30) || t.getAttribute("title") || "";
    var id = t.id ? "#" + t.id : "";
    if(!name && !id) return "";
    return "押した: " + clean(name, 30) + (id ? " " + id : "");
  }

  function start(){
    if(started) return; started = true;
    document.addEventListener("click", function(e){ var l = labelOf(e.target); if(l) log(l); }, true);
    document.addEventListener("change", function(e){ // 選択肢の変更だけ（値は選択肢の表示名）
      var s = e.target; if(!s || s.closest("[data-fb-skip]") || s.closest(".fbw")) return;
      if(/^(checkbox|radio)$/.test(s.type || "")){
        var lb = s.closest("label") || (s.id && document.querySelector('label[for="' + s.id + '"]'));
        log("切替: " + clean(s.getAttribute("data-fb") || (lb && lb.textContent) || s.id || s.type, 30) + (s.checked ? "（ON）" : "（OFF）")); return;
      }
      if(s.tagName === "SELECT") log("選択: " + clean(s.getAttribute("data-fb") || s.id || "リスト", 20) + " → " + clean(s.options[s.selectedIndex] && s.options[s.selectedIndex].text, 20));
    }, true);
    window.addEventListener("error", function(e){ logError((e.message || "エラー") + (e.filename ? " @" + String(e.filename).split("/").pop() + ":" + e.lineno : "")); });
    window.addEventListener("unhandledrejection", function(e){ var r = e.reason; logError("Promise: " + (r && r.message ? r.message : String(r))); });
    window.addEventListener("hashchange", function(){ log("画面: " + clean(location.hash, 30)); });
    log("起動 " + (cfg.version || ""));
  }

  function env(){
    var ua = navigator.userAgent || "";
    var device = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "その他";
    var m = ua.match(/OS (\d+)_(\d+)/) || ua.match(/Android (\d+)/); if(m) device += " " + m[1] + (m[2] ? "." + m[2] : "");
    return { device: device, standalone: !!(window.navigator.standalone || (window.matchMedia && matchMedia("(display-mode: standalone)").matches)),
      screen: screen.width + "x" + screen.height, path: location.pathname };
  }
  function deviceId(){ var d = load("dev", ""); if(!d){ d = Math.random().toString(36).slice(2, 10) + Date.now().toString(36); save("dev", d); } return d; }

  /** 送信する中身（テスト・確認用に公開） */
  function payload(text, kind, reply){
    var ctx = null;
    try{ ctx = cfg.getContext ? cfg.getContext() : null; }catch(e){ ctx = { contextError: String(e && e.message || e) }; }
    return { app: cfg.app, version: cfg.version, kind: kind || "要望", text: String(text || "").slice(0, 2000), reply: String(reply || "").slice(0, 120),
      deviceId: deviceId(), env: env(), log: load("log", []), errors: load("err", []), context: ctx };
  }

  function send(text, kind, reply){
    if(!cfg.endpoint) return Promise.reject(new Error("受付先が設定されていません"));
    var today = localDay(), cnt = load("cnt", {});
    if(cnt.d === today && cnt.n >= DAY_LIMIT) return Promise.reject(new Error("今日はこれ以上送れません（1日" + DAY_LIMIT + "件まで）"));
    var body = JSON.stringify(payload(text, kind, reply));
    return fetch(cfg.endpoint, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: body })
      .then(function(r){ return r.text(); })
      .then(function(t){ try{ return JSON.parse(t); }catch(e){ throw new Error("受付が混み合っています。少し時間をおいて送ってください"); } })
      .then(function(j){
        if(!j || !j.ok) throw new Error(j && (j.error === "too many" || j.error === "server busy") ? "送信が多すぎます。時間をおいて送ってください" : "送信できませんでした（" + (j && j.error || "不明") + "）");
        save("cnt", { d: today, n: (cnt.d === today ? cnt.n : 0) + 1 }); save("err", []);
        return j;
      });
  }

  var CSS = ".fbw{border:1px solid rgba(0,0,0,.12);border-radius:14px;padding:14px;background:#fff;color:#1b1d22;font:inherit}" +
    ".fbw h3{margin:0 0 8px;font-size:16px}.fbw p{margin:0 0 8px;font-size:13px;color:#555;line-height:1.6}" +
    ".fbw .k{display:flex;gap:6px;margin-bottom:8px}.fbw .k button{flex:1;padding:8px 4px;border:1px solid #ccd;border-radius:10px;background:#f6f7f9;font:inherit;font-size:14px;color:inherit}" +
    ".fbw .k button.on{background:#1b1d22;color:#fff;border-color:#1b1d22}" +
    ".fbw textarea,.fbw input{width:100%;box-sizing:border-box;border:1px solid #ccd;border-radius:10px;padding:10px;font:inherit;font-size:16px;margin-bottom:8px;background:#fff;color:inherit}" +
    ".fbw textarea{min-height:110px;resize:vertical}.fbw .go{width:100%;padding:12px;border:0;border-radius:12px;background:#1b1d22;color:#fff;font:inherit;font-size:16px;font-weight:700}" +
    ".fbw .go:disabled{opacity:.5}.fbw .note{font-size:11.5px;color:#777;margin:8px 0 0}.fbw .msg{font-size:13px;margin-top:8px;min-height:1em}";

  /** 送信欄を表示する */
  function render(target){
    var host = typeof target === "string" ? document.querySelector(target) : target; if(!host) return;
    if(!document.getElementById("fbw-css")){ var st = document.createElement("style"); st.id = "fbw-css"; st.textContent = CSS; document.head.appendChild(st); }
    host.innerHTML = '<div class="fbw" data-fb-skip><h3></h3><p>使いにくい所・ほしい機能・おかしな動きを、何でも気軽に送ってください。</p>' +
      '<div class="k"><button type="button" data-k="要望" class="on">要望</button><button type="button" data-k="不具合">不具合</button><button type="button" data-k="その他">その他</button></div>' +
      '<textarea maxlength="2000" placeholder="例）○○の画面で△△を押すと、××になる"></textarea>' +
      '<input type="email" placeholder="返信がほしい場合だけメールアドレス（任意）">' +
      '<button type="button" class="go">送信する</button><div class="msg" role="status"></div>' +
      '<p class="note">送信時に、不具合調査のため直前の操作（画面名・ボタン名）とアプリの版も送られます。入力した書類の内容は送られません。個人情報は書かないでください。</p></div>';
    var box = host.querySelector(".fbw"); box.querySelector("h3").textContent = cfg.title;
    var kind = "要望", ta = box.querySelector("textarea"), em = box.querySelector("input"), go = box.querySelector(".go"), msg = box.querySelector(".msg");
    box.querySelectorAll(".k button").forEach(function(b){ b.onclick = function(){ kind = b.getAttribute("data-k"); box.querySelectorAll(".k button").forEach(function(x){ x.classList.toggle("on", x === b); }); }; });
    if(!cfg.endpoint){ go.disabled = true; msg.textContent = "（受付先がまだ設定されていません）"; }
    go.onclick = function(){
      var t = ta.value.trim(); if(!t){ msg.textContent = "内容を書いてください"; ta.focus(); return; }
      go.disabled = true; msg.textContent = "送信中…";
      send(t, kind, em.value.trim()).then(function(){ ta.value = ""; msg.textContent = "送信しました。ありがとうございます！"; })
        .catch(function(e){ msg.textContent = (e && e.message === "Load failed" || e instanceof TypeError) ? "通信できませんでした。電波の良い所でもう一度お試しください" : (e && e.message || "送信できませんでした"); })
        .then(function(){ go.disabled = false; });
    };
  }

  function init(o){ for(var k in o) if(Object.prototype.hasOwnProperty.call(o, k)) cfg[k] = o[k]; start(); return api; }

  var api = { init: init, render: render, log: log, logError: logError, payload: payload, send: send, _labelOf: labelOf };
  window.FeedbackWidget = api;
})();
