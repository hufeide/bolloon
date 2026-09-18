/* app.js — 经典脚本 (无 import/export), 面向 Chrome 61 / ES2017 基线
 *
 * 容器约束速查 (改动前先读 .skill/minitool-zip-builder/references/*):
 *   · 不许联网: 没有 fetch / XHR / WebSocket; 资源全部包内相对路径
 *   · 不许内联脚本与行内事件: 只用 addEventListener
 *   · 不许 eval / new Function / WASM / Worker / iframe
 *   · 不许 window.open / location.href 跳转 / target="_blank" / <a download>
 *   · 不许定位 / 剪贴板 API / 传感器 / 全屏 API / 设备信息
 *   · 可用: DOM/CSS/Canvas2D/WebGL、localStorage/IndexedDB、<input type="file">、
 *           getUserMedia(用户手势+授权)、alert/confirm、window.xhs.miniTool.*(JSBridge)
 */
(function () {
  'use strict';

  var STORE_KEY = 'starter.counter';

  // ── 单页视图切换 (规范要求: 不新建页面, 不用 <base>) ──────────────────────
  function showPage(id) {
    var pages = document.querySelectorAll('.page');
    for (var i = 0; i < pages.length; i++) {
      pages[i].className = pages[i].className.replace(/\s*active\b/, '');
    }
    var el = document.getElementById(id);
    if (el) el.className += ' active';
  }

  // ── 本地存储 (按小工具隔离, 不保证永久) ─────────────────────────────────
  function readCount() {
    var raw = null;
    try { raw = window.localStorage.getItem(STORE_KEY); } catch (e) { raw = null; }
    var n = parseInt(raw, 10);
    return isFinite(n) && n > 0 ? n : 0;
  }

  function writeCount(n) {
    try { window.localStorage.setItem(STORE_KEY, String(n)); } catch (e) { /* 存储不可用不影响功能 */ }
    var el = document.getElementById('counter');
    if (el) el.textContent = String(n);
  }

  // ── 选图预览: blob: 对象 URL, 用完 revoke (不要转长 Base64 写回源码) ─────
  function bindFilePreview() {
    var input = document.getElementById('file-input');
    var img = document.getElementById('preview');
    if (!input || !img) return;
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      if (!file) return;
      if (img.dataset && img.dataset.objectUrl) {
        try { URL.revokeObjectURL(img.dataset.objectUrl); } catch (e) { /* noop */ }
      }
      var url = URL.createObjectURL(file);
      if (img.dataset) img.dataset.objectUrl = url;
      img.src = url;
      img.style.display = 'block';
    });
  }

  // ── JSBridge: 只在容器注入时调用; 不在文档里的 API 一律不碰 ──────────────
  function bridgeAvailable() {
    return !!(window.xhs && window.xhs.miniTool);
  }

  function renderBridgeHint() {
    var el = document.getElementById('bridge-hint');
    if (!el) return;
    el.textContent = bridgeAvailable()
      ? 'JSBridge 可用 (window.xhs.miniTool) — 需要发笔记/存相册时先读 references/jsbridge-api.md 的参数表'
      : '当前环境没有注入 JSBridge (浏览器/PC 里正常) — 真机上 window.xhs.miniTool 才会存在';
  }

  // ── TODO: 核心功能放这里 ────────────────────────────────────────────────
  // 约定: 数据与视图分离; 首屏只做必要工作; 长列表分页/虚拟滚动;
  //       大文件解析分批并让出主线程; 若用 WebGL 必须受 DPR/纹理预算并有降级路径。

  function init() {
    var c = readCount();
    writeCount(c);

    var inc = document.getElementById('btn-inc');
    if (inc) inc.addEventListener('click', function () { c += 1; writeCount(c); });

    var reset = document.getElementById('btn-reset');
    if (reset) reset.addEventListener('click', function () { c = 0; writeCount(c); });

    var goto = document.getElementById('btn-goto-about');
    if (goto) goto.addEventListener('click', function () { showPage('page-about'); });

    var back = document.getElementById('btn-back');
    if (back) back.addEventListener('click', function () { showPage('page-home'); });

    bindFilePreview();
    renderBridgeHint();

    // 页面隐藏时停掉定时器/动画/媒体; 恢复时重置时间差 (performance-budget §4)
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { /* TODO: 暂停耗时循环 */ }
      else { /* TODO: 恢复并重置时间基准, 不补算 */ }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
