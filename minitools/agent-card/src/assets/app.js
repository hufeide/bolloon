/* app.js — 视图/事件/原生能力调用 (经典脚本; 最后加载, 依赖 store.js 与 card.js)
 *
 * 容器约束 (改前先读 .skill/minitool-zip-builder/references/*):
 *   · 事件全部 addEventListener; 不用内联 onclick
 *   · 不联网: 无 fetch/XHR; 不 window.open / 不 location.href 跳转
 *   · 原生只调 window.xhs.miniTool.{postNote,saveImageToPhotosAlbum,openRedPage,writeTempFile}
 *   · 不用剪贴板 API: 只展示可选中文本, 引导用户长按复制
 *   · ES2017: 无可选链 / 无空值合并 / 无对象展开
 */
(function (global) {
  'use strict';

  var S = global.BCardStore;
  var R = global.BCardRender;

  var profile = S.loadProfile();
  var avatarImage = null;      // 已 onload 的 Image
  var avatarBlobUrl = '';      // 预览用对象 URL (用完 revoke)

  // ── 小工具: DOM 与消息 ─────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }

  function msg(el, text, kind) {
    var node = typeof el === 'string' ? $(el) : el;
    if (!node) return;
    node.className = 'msg hint' + (kind ? ' ' + kind : '');
    node.textContent = String(text || '');
  }

  function fmtErr(e) {
    if (!e) return '未知错误';
    if (typeof e === 'string') return e;
    return String(e.errMsg || e.message || e);
  }

  // ── 原生能力封装: 不存在就如实说"这个环境没有", 调用失败原样报错 ────────
  function bridge() {
    return (global.xhs && global.xhs.miniTool) ? global.xhs.miniTool : null;
  }

  function callBridge(name, options) {
    var b = bridge();
    if (!b || typeof b[name] !== 'function') {
      return Promise.reject({ errMsg: name + ':fail 当前环境没有注入原生能力 (浏览器/PC 预览里正常,真机上才有)' });
    }
    try {
      var ret = b[name](options);
      return ret && typeof ret.then === 'function' ? ret : Promise.resolve({ errMsg: name + ':ok' });
    } catch (e) {
      return Promise.reject(e);
    }
  }

  function renderBridgeState() {
    var el = $('bridge-state');
    if (!el) return;
    var b = bridge();
    var names = ['postNote', 'saveImageToPhotosAlbum', 'openRedPage', 'writeTempFile'];
    var have = [];
    var miss = [];
    for (var i = 0; i < names.length; i++) {
      if (b && typeof b[names[i]] === 'function') have.push(names[i]);
      else miss.push(names[i]);
    }
    el.textContent = have.length
      ? '原生能力可用: ' + have.join(' / ') + (miss.length ? '（缺少 ' + miss.join(' / ') + '）' : '')
      : '当前环境未注入原生能力 —— 存相册/发笔记/跳 App 页只在真机容器里可用';
  }

  // ── 视图切换 (单页, 不跳转) ─────────────────────────────────────────────
  function showView(id) {
    var views = ['view-profile', 'view-card', 'view-social'];
    var tabs = { 'view-profile': 'tab-profile', 'view-card': 'tab-card', 'view-social': 'tab-social' };
    for (var i = 0; i < views.length; i++) {
      var v = $(views[i]);
      if (v) v.className = 'view' + (views[i] === id ? ' on' : '');
      var t = $(tabs[views[i]]);
      if (t) t.className = 'tab' + (views[i] === id ? ' on' : '');
    }
    if (id === 'view-card') redrawCard();
    if (id === 'view-social') refreshHandover();
  }

  // ── 身份表单 ────────────────────────────────────────────────────────────
  function fillForm() {
    $('in-name').value = profile.name;
    $('in-bio').value = profile.bio;
    $('in-tags').value = profile.tags.join(', ');
    $('in-agentid').value = profile.agentId;
    $('in-baseurl').value = profile.endpoint.baseUrl;
    $('in-model').value = profile.endpoint.model;
    $('in-key').value = profile.endpoint.key;
    $('avatar-img').src = profile.avatar || '';
  }

  function readForm() {
    var tags = String($('in-tags').value || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    return {
      name: String($('in-name').value || '').trim(),
      bio: String($('in-bio').value || '').trim(),
      tags: tags,
      avatar: profile.avatar,
      agentId: String($('in-agentid').value || '').trim(),
      endpoint: {
        baseUrl: String($('in-baseurl').value || '').trim(),
        model: String($('in-model').value || '').trim(),
        key: String($('in-key').value || '').trim()
      }
    };
  }

  function saveProfile(silent) {
    var next = readForm();
    if (!next.name) { msg('msg-profile', '昵称必填 (名片上要显示)', 'bad'); return null; }
    var res = S.saveProfile(next);
    profile = res.profile;
    $('in-agentid').value = profile.agentId;
    if (!silent) {
      msg('msg-profile', res.persisted
        ? '已保存 · 标识 ' + profile.agentId
        : '保存失败: 本机存储不可用 (容器可能禁用了 localStorage) — 请用交接串自行备份', res.persisted ? 'ok' : 'bad');
    }
    return profile;
  }

  function saveEndpoint(silent) {
    var next = readForm();
    if (!next.name) { msg('msg-endpoint', '先填昵称再保存接入点', 'bad'); return null; }
    var res = S.saveProfile(next);
    profile = res.profile;
    if (!silent) {
      msg('msg-endpoint', res.persisted
        ? '接入点已保存 (含 Key, 仅本机;名片上只显示尾 4 位)'
        : '保存失败: 本机存储不可用', res.persisted ? 'ok' : 'bad');
    }
    return profile;
  }

  // ── 头像: 本地缩放后存 data:uri, 避免大 Base64 塞进存储 ────────────────
  function bindAvatar() {
    var input = $('avatar-input');
    if (!input) return;
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      if (!file) return;
      if (avatarBlobUrl) { try { URL.revokeObjectURL(avatarBlobUrl); } catch (e) { /* noop */ } }
      avatarBlobUrl = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        avatarImage = img;
        var data = R.downscaleImage(img, 256, 0.85);
        var kb = Math.round(data.length / 1024);
        if (data) {
          profile.avatar = data;
          $('avatar-img').src = data;
          var res = S.saveProfile(profile);
          profile = res.profile;
          msg('msg-profile', '头像已本地压缩并保存 (约 ' + kb + ' KB)', kb > 120 ? 'warn' : 'ok');
        } else {
          msg('msg-profile', '头像处理失败 (Canvas 不可用)', 'bad');
        }
        redrawCard();
      };
      img.onerror = function () { msg('msg-profile', '这个文件读不出图像', 'bad'); };
      img.src = avatarBlobUrl;
    });
  }

  function loadAvatarImage() {
    return new Promise(function (resolve) {
      if (!profile.avatar) { resolve(null); return; }
      var img = new Image();
      img.onload = function () { avatarImage = img; resolve(img); };
      img.onerror = function () { resolve(null); };
      img.src = profile.avatar;
    });
  }

  // ── 名片 ────────────────────────────────────────────────────────────────
  function redrawCard() {
    var canvas = $('card-canvas');
    if (!canvas) return;
    var res = R.render(canvas, profile, avatarImage);
    if (!res.ok) msg('msg-card', res.error, 'bad');
  }

  function guardProfile() {
    if (!profile.name) { msg('msg-card', '先到「身份」填昵称并保存', 'bad'); showView('view-profile'); return false; }
    return true;
  }

  function saveToAlbum() {
    if (!guardProfile()) return;
    var dataUri = R.toDataUri($('card-canvas'));
    if (!dataUri) { msg('msg-card', '导出图片失败 (Canvas 不可用)', 'bad'); return; }
    msg('msg-card', '正在存相册…');
    callBridge('writeTempFile', { data: dataUri })
      .then(function (r) {
        // writeTempFile 返回 filePath; 没有就直接用 data:uri (两个都符合规范)
        var filePath = (r && r.filePath) ? r.filePath : dataUri;
        return callBridge('saveImageToPhotosAlbum', { filePath: filePath });
      })
      .then(function () { msg('msg-card', '已存入相册', 'ok'); })
      .catch(function (e) { msg('msg-card', '存相册失败: ' + fmtErr(e), 'bad'); });
  }

  function postNote() {
    if (!guardProfile()) return;
    var dataUri = R.toDataUri($('card-canvas'));
    if (!dataUri) { msg('msg-card', '导出图片失败 (Canvas 不可用)', 'bad'); return; }
    var title = (profile.name + ' 的智能体名片').slice(0, 20);
    var content = (profile.bio ? profile.bio + '\n' : '') +
      '智能体标识: ' + (profile.agentId || '(未填)') + '\n' +
      '标签: ' + (profile.tags.length ? profile.tags.join(' / ') : '(无)') + '\n' +
      '接入点: ' + (profile.endpoint.baseUrl || '(在 App 里接入)') + '\n' +
      '—— 想和我的智能体建联,把这张卡发我,或让我把「交接串」发你。';
    msg('msg-card', '正在发布笔记…');
    callBridge('postNote', {
      title: title,
      content: content.slice(0, 1000),
      pageType: 'photo_publish',
      mediaInfo: { image_resources: [{ url: dataUri }] },
      tags: profile.tags.join(',')
    })
      .then(function () { msg('msg-card', '已发布 (标题 + 名片图 + 正文已带入)', 'ok'); })
      .catch(function (e) { msg('msg-card', '发布失败: ' + fmtErr(e), 'bad'); });
  }

  function openAppPage() {
    // 跳转会离开当前小工具页面 → 先确认本地状态已落盘 (规范要求)
    if (profile.name) { var r = S.saveProfile(profile); profile = r.profile; }
    var typeEl = $('in-open-type');
    var kwEl = $('in-open-keyword');
    var type = String((typeEl && typeEl.value) || 'search').trim() || 'search';
    var keyword = String((kwEl && kwEl.value) || '').trim();
    if (!keyword) keyword = profile.tags.length ? profile.tags[0] : (profile.name || '智能体');
    msg('msg-card', '正在跳转 App 页 (type=' + type + ', keyword=' + keyword + ')…');
    // 规则表由客户端维护, 未命中白名单会失败 → 如实报错并提示换 type, 不假装成功
    callBridge('openRedPage', { type: type, params: { keyword: String(keyword) } })
      .then(function () { msg('msg-card', '已跳转 (type=' + type + ')', 'ok'); })
      .catch(function (e) {
        msg('msg-card', '跳转失败: ' + fmtErr(e) + ' — type 必须命中客户端规则表, 换个 type 再试', 'bad');
      });
  }

  // ── 社交: 交接串 + 联系人 ──────────────────────────────────────────────
  function refreshHandover() {
    var el = $('handover');
    if (!el) return;
    if (!profile.name) { el.textContent = '(先保存身份)'; return; }
    el.textContent = S.toHandover(profile);
  }

  function importHandover() {
    var text = String($('in-import').value || '');
    var res = S.parseHandover(text);
    if (!res.ok) { msg('msg-import', res.error, 'bad'); return; }
    var c = res.card;
    S.upsertContact({
      name: String(c.name || ''),
      bio: String(c.bio || ''),
      tags: Array.isArray(c.tags) ? c.tags : [],
      agentId: String(c.agentId || ''),
      endpoint: { baseUrl: String((c.endpoint && c.endpoint.baseUrl) || ''), model: String((c.endpoint && c.endpoint.model) || ''), keyTail: String((c.endpoint && c.endpoint.keyTail) || '') },
      importedAt: new Date().toISOString()
    });
    $('in-import').value = '';
    msg('msg-import', '已加入联系人: ' + (c.name || c.agentId || '(无名)'), 'ok');
    renderContacts();
  }

  function renderContacts() {
    var list = S.loadContacts();
    var box = $('contact-list');
    var count = $('contact-count');
    if (count) count.textContent = list.length ? '(' + list.length + ')' : '(空)';
    if (!box) return;
    box.innerHTML = '';
    if (!list.length) {
      var empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = '还没有联系人。把对方给的交接串粘到上面即可。';
      box.appendChild(empty);
      return;
    }
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      var row = document.createElement('div');
      row.className = 'item';
      var n = document.createElement('div');
      n.className = 'n';
      n.textContent = (c.name || '(无名)') + (c.tags && c.tags.length ? ' · ' + c.tags.join(' / ') : '');
      var m = document.createElement('div');
      m.className = 'm';
      m.textContent = '标识 ' + (c.agentId || '(无)') + ' · 接入 ' + ((c.endpoint && c.endpoint.baseUrl) || '(无)') +
        (c.endpoint && c.endpoint.keyTail ? ' · Key ****' + c.endpoint.keyTail : '');
      var del = document.createElement('button');
      del.className = 'btn line';
      del.type = 'button';
      del.style.marginTop = '6px';
      del.textContent = '删除';
      del.setAttribute('data-agent', String(c.agentId || c.name || ''));
      del.addEventListener('click', function (ev) {
        var id = ev.currentTarget.getAttribute('data-agent');
        S.removeContact(id);
        renderContacts();
      });
      row.appendChild(n);
      row.appendChild(m);
      row.appendChild(del);
      box.appendChild(row);
    }
  }

  // ── 初始化 ──────────────────────────────────────────────────────────────
  function bindTabs() {
    var map = { 'tab-profile': 'view-profile', 'tab-card': 'view-card', 'tab-social': 'view-social' };
    var keys = Object.keys(map);
    for (var i = 0; i < keys.length; i++) {
      (function (k) {
        var el = $(k);
        if (el) el.addEventListener('click', function () { showView(map[k]); });
      })(keys[i]);
    }
  }

  function bindButtons() {
    $('btn-save-profile').addEventListener('click', function () { if (saveProfile()) { msg('msg-profile', '已保存 · 标识 ' + profile.agentId, 'ok'); } });
    $('btn-save-endpoint').addEventListener('click', function () { saveEndpoint(); });
    $('btn-save-album').addEventListener('click', saveToAlbum);
    $('btn-post-note').addEventListener('click', postNote);
    $('btn-open-app').addEventListener('click', openAppPage);
    $('btn-refresh-handover').addEventListener('click', refreshHandover);
    $('btn-import').addEventListener('click', importHandover);
  }

  function init() {
    fillForm();
    bindTabs();
    bindButtons();
    bindAvatar();
    renderBridgeState();
    renderContacts();
    refreshHandover();
    loadAvatarImage().then(function () { redrawCard(); });

    // 页面隐藏: 停掉可能的耗时循环 (这里没有长任务, 但保留规范要求的钩子)
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { /* 无长任务; 若有动画/定时器应在此暂停 */ }
    });

    // 离开前兜底: 释放预览对象 URL
    global.addEventListener('pagehide', function () {
      if (avatarBlobUrl) { try { URL.revokeObjectURL(avatarBlobUrl); } catch (e) { /* noop */ } }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window);
