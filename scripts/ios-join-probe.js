/**
 * ios-join-probe.js — iOS 模拟器内的「一键入网」真机探针 (2026-09-15)
 *
 * 用途: 注入到**构建产物** build/.../App.app/public/index.html (只动产物, 不污染仓库),
 * 在真 iOS WebView 里真点「一键入网」, 等真回复, 再把结果渲染成大字号 overlay + document.title,
 * 供 `xcrun simctl io booted screenshot` 截图后人工/视觉核对。
 *
 * 关键: 模拟器与宿主机共享网络 → 桌面基址写 http://127.0.0.1:<真桌面端口>, 即**真的跨节点入网**。
 */
(function () {
  var DESKTOP = '__DESKTOP_BASE__';   // 由注入脚本替换
  var PROMPT = 'read https://bolloon.cn/bolloon-gateway-join.md';
  var log = function (m) { try { console.log('[probe] ' + m); } catch (e) {} };

  function overlay(title, body) {
    var el = document.getElementById('probe-overlay');
    if (!el) {
      el = document.createElement('pre');
      el.id = 'probe-overlay';
      el.style.cssText = 'position:fixed;inset:0;z-index:99999;margin:0;padding:16px;' +
        'background:#101010;color:#c4d640;font:12px/1.45 -apple-system,Menlo,monospace;' +
        'white-space:pre-wrap;overflow:auto;';
      document.body.appendChild(el);
    }
    el.textContent = title + '\n' + (body || '');
    document.title = 'PROBE:' + title;
  }

  function bubbles() {
    return Array.prototype.slice.call(document.querySelectorAll('.bubble.ai')).map(function (e) { return e.textContent || ''; }).join('\n---\n');
  }

  function netTabBtn() {
    return document.querySelector('button.tab[data-tab="network"]') || document.querySelector('[data-tab="network"]');
  }

  function joinItemVisible() {
    var item = document.querySelector('#item-join-global');
    if (!item) return false;
    var page = document.getElementById('page-network');
    if (page && page.hidden) return false;
    // offsetParent === null → 元素被 hidden 的祖先挡住 (点了也不会触发)
    return item.offsetParent !== null;
  }

  function clickJoin() {
    var item = document.querySelector('#item-join-global');
    if (!item) return false;
    item.click();
    return true;
  }

  function stage() {
    try {
      if (!window.BolloonCore) return 'wait-core';
      if (joinItemVisible()) return 'ready';
      var tab = netTabBtn();
      if (tab) { tab.click(); return 'switch-tab'; }
      return 'wait-item';
    } catch (e) { return 'err:' + e.message; }
  }

  function report(phase) {
    overlay('phase=' + phase + ' stage=' + stage(),
      'DESKTOP=' + DESKTOP +
      '\njoin_state=' + (localStorage.getItem('bolloon_gateway_join') || '(none)') +
      '\n\n--- AI 回复 ---\n' + (bubbles() || '(空)'));
  }

  var t0 = Date.now();
  var clicked = false;
  var iv = setInterval(function () {
    try {
      var s = stage();
      if (!clicked && s === 'ready') {
        // 写入桌面基址 (与设置页同一 key), 然后点入网
        localStorage.setItem('bolloon_desktop_base_url', DESKTOP);
        clicked = clickJoin();
        log('clicked=' + clicked);
        overlay('phase=clicked', 'DESKTOP=' + DESKTOP + '\nclicked=' + clicked + '\n等待入网结果…');
        return;
      }
      if (clicked) {
        var b = bubbles();
        if (b && (b.indexOf('入网') !== -1)) { report(b.indexOf('❌') === 0 ? 'done-fail' : 'done-ok'); clearInterval(iv); return; }
      }
      if (Date.now() - t0 > 90000) { report('timeout'); clearInterval(iv); }
    } catch (e) { overlay('probe-error', String(e && e.message || e)); }
  }, 700);

  log('probe installed, desktop=' + DESKTOP + ' prompt=' + PROMPT);
})();
