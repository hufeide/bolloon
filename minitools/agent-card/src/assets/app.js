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

  /** 执行轨迹: 记"真实发生过的动作与结果"(失败也记, 且带原因) */
  function trace(kind, detail, ok) {
    S.appendTrace({ kind: kind, detail: detail, ok: ok !== false });
    refreshTrace();
  }

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
    var views = ['view-profile', 'view-card', 'view-social', 'view-trace'];
    var tabs = { 'view-profile': 'tab-profile', 'view-card': 'tab-card', 'view-social': 'tab-social', 'view-trace': 'tab-trace' };
    for (var i = 0; i < views.length; i++) {
      var v = $(views[i]);
      if (v) v.className = 'view' + (views[i] === id ? ' on' : '');
      var t = $(tabs[views[i]]);
      if (t) t.className = 'tab' + (views[i] === id ? ' on' : '');
    }
    if (id === 'view-card') redrawCard();
    if (id === 'view-social') refreshHandover();
    if (id === 'view-trace') { refreshTrace(); refreshTraceText(); }
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
    $('in-peerid').value = profile.p2p.peerId;
    $('in-multiaddr').value = profile.p2p.multiaddr;
    $('in-relay').value = profile.p2p.relay;
    renderAvatarSlot();
  }

  /** 头像槽: 有图显示图 (避免空 src 出现"裂图"占位), 无图显示昵称首字。
   *  占位字写在独立的 #avatar-ph —— 不要用 slot.textContent, 那会删掉 <img> 节点。 */
  function renderAvatarSlot() {
    var slot = $('avatar-slot');
    var img = $('avatar-img');
    var ph = $('avatar-ph');
    if (!slot || !img || !ph) return;
    if (profile.avatar) {
      slot.className = 'avatar-slot has-img';
      img.src = profile.avatar;
    } else {
      slot.className = 'avatar-slot';
      img.removeAttribute('src');
      ph.textContent = String(profile.name || '智').slice(0, 1);
    }
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
      },
      p2p: {
        peerId: String($('in-peerid').value || '').trim(),
        multiaddr: String($('in-multiaddr').value || '').trim(),
        relay: String($('in-relay').value || '').trim()
      }
    };
  }

  function saveProfile(silent) {
    var next = readForm();
    if (!next.name) { msg('msg-profile', '昵称必填 (名片上要显示)', 'bad'); return null; }
    var res = S.saveProfile(next);
    profile = res.profile;
    $('in-agentid').value = profile.agentId;
    renderAvatarSlot();
    if (!silent) {
      msg('msg-profile', res.persisted
        ? '已保存 · 标识 ' + profile.agentId
        : '保存失败: 本机存储不可用 (容器可能禁用了 localStorage) — 请用交接串自行备份', res.persisted ? 'ok' : 'bad');
    }
    trace('保存身份', '昵称=' + profile.name + ' · 标签 ' + profile.tags.length + ' 个 · 标识=' + profile.agentId, res.persisted);
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
    trace('保存接入点', (profile.endpoint.baseUrl || '(空)') + ' · 模型 ' + (profile.endpoint.model || '(默认)') + ' · key ' + (profile.endpoint.key ? '有(****' + profile.endpoint.key.slice(-4) + ')' : '无'), res.persisted);
    return profile;
  }

  /** 保存 P2P 连接信息: 先做格式校验 (不假装"能连上", 只判断格式像不像) */
  function saveP2p(silent) {
    var pid = S.checkPeerId($('in-peerid').value);
    var maddr = S.checkMultiaddr($('in-multiaddr').value);
    var notes = [];
    if (pid.level === 'suspect') notes.push('peerId: ' + pid.msg);
    if (maddr.level === 'bad') notes.push('地址: ' + maddr.msg);
    if (!pid.ok && !maddr.ok && pid.level !== 'empty') {
      var reason = notes.join(' / ') || 'P2P 信息不完整';
      msg('msg-p2p', '格式有问题, 未保存: ' + reason, 'bad');
      trace('保存 P2P', '校验失败: ' + reason, false);
      return null;
    }
    var next = readForm();
    var res = S.saveProfile(next);
    profile = res.profile;
    if (!silent) {
      var line = 'peerId ' + (profile.p2p.peerId ? profile.p2p.peerId.slice(0, 12) + '…' : '(空)') +
        ' · 地址 ' + (maddr.level === 'ok' ? maddr.msg : (profile.p2p.multiaddr ? '已存(未校验)' : '(空)'));
      msg('msg-p2p', res.persisted ? '已保存 · ' + line : '保存失败: 本机存储不可用', res.persisted ? (notes.length ? 'warn' : 'ok') : 'bad');
    }
    trace('保存 P2P', 'peerId=' + (profile.p2p.peerId || '(空)') + ' · addr=' + (maddr.level === 'ok' ? maddr.msg : '未通过校验') + (notes.length ? ' · 提示: ' + notes.join('; ') : ''), res.persisted);
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
          renderAvatarSlot();
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
      .then(function () { msg('msg-card', '已存入相册', 'ok'); trace('存相册', 'writeTempFile + saveImageToPhotosAlbum 成功', true); })
      .catch(function (e) { msg('msg-card', '存相册失败: ' + fmtErr(e), 'bad'); trace('存相册', '失败: ' + fmtErr(e), false); });
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
      .then(function () { msg('msg-card', '已发布 (标题 + 名片图 + 正文已带入)', 'ok'); trace('发布笔记', 'postNote 成功 · 标题「' + title + '」· 图 ' + Math.round(dataUri.length / 1024) + 'KB', true); })
      .catch(function (e) { msg('msg-card', '发布失败: ' + fmtErr(e), 'bad'); trace('发布笔记', '失败: ' + fmtErr(e), false); });
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
      .then(function () { msg('msg-card', '已跳转 (type=' + type + ')', 'ok'); trace('跳转 App 页', 'openRedPage 成功 · type=' + type + ' · keyword=' + keyword, true); })
      .catch(function (e) {
        msg('msg-card', '跳转失败: ' + fmtErr(e) + ' — type 必须命中客户端规则表, 换个 type 再试', 'bad');
        trace('跳转 App 页', '失败: ' + fmtErr(e) + ' (type=' + type + ')', false);
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
    if (!res.ok) { msg('msg-import', res.error, 'bad'); trace('导入交接串', '解析失败: ' + res.error, false); return; }
    var c = res.card;
    S.upsertContact({
      name: String(c.name || ''),
      bio: String(c.bio || ''),
      tags: Array.isArray(c.tags) ? c.tags : [],
      agentId: String(c.agentId || ''),
      endpoint: { baseUrl: String((c.endpoint && c.endpoint.baseUrl) || ''), model: String((c.endpoint && c.endpoint.model) || ''), keyTail: String((c.endpoint && c.endpoint.keyTail) || '') },
      p2p: { peerId: String((c.p2p && c.p2p.peerId) || ''), multiaddr: String((c.p2p && c.p2p.multiaddr) || ''), relay: String((c.p2p && c.p2p.relay) || '') },
      importedAt: new Date().toISOString()
    });
    $('in-import').value = '';
    msg('msg-import', '已加入联系人: ' + (c.name || c.agentId || '(无名)'), 'ok');
    trace('导入交接串', '来自 ' + (c.name || c.agentId || '(无名)') + ' · p2p ' + (((c.p2p && c.p2p.peerId) || '(未带)')), true);
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
        trace('删除联系人', String(id), true);
        renderContacts();
      });
      row.appendChild(n);
      row.appendChild(m);
      row.appendChild(del);
      box.appendChild(row);
    }
  }


  // ── 执行轨迹: 渲染 / 导出 / 导入 ────────────────────────────────────────
  function refreshTrace() {
    var list = S.loadTrace();
    var box = $('trace-list');
    var count = $('trace-count');
    if (count) count.textContent = list.length ? '(' + list.length + ' / ' + S.TRACE_MAX + ')' : '(空)';
    if (!box) return;
    box.innerHTML = '';
    if (!list.length) {
      var empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = '还没有轨迹。随便做点什么(保存身份/生成名片/导入联系人)就会出现。';
      box.appendChild(empty);
      return;
    }
    for (var i = list.length - 1; i >= 0; i--) {
      var e = list[i];
      var row = document.createElement('div');
      row.className = 'item';
      var head = document.createElement('div');
      head.className = 'n';
      head.innerHTML = '';
      var tag = document.createElement('span');
      tag.className = e.ok ? 'ok' : 'bad';
      tag.textContent = (e.ok ? '✓ ' : '✗ ') + e.kind + ' ';
      var when = document.createElement('span');
      when.className = 'tiny';
      when.textContent = String(e.t).replace('T', ' ').slice(0, 19);
      head.appendChild(tag);
      head.appendChild(when);
      var body = document.createElement('div');
      body.className = 'm';
      body.textContent = e.detail;
      row.appendChild(head);
      row.appendChild(body);
      box.appendChild(row);
    }
  }

  function refreshTraceText() {
    var el = $('trace-text');
    if (!el) return;
    var list = S.loadTrace();
    el.textContent = list.length ? S.traceToText() : '(还没有轨迹)';
  }

  /** 解析别人给的轨迹文本 → 预览 (只读, 不混进本机轨迹) */
  function parseTraceText(text) {
    var lines = String(text || '').split('\n');
    var out = [];
    // 格式: "<n>. [ok|fail] <无空格时间戳> <动作/工具名> — <细节>"
    //   (Bolloon 侧 trace-export.ts 用同一格式; 时间戳与工具名都不能含空格)
    var re = /^\s*(\d+)\.\s*\[(ok|fail)\]\s*(\S+)\s*(\S+)\s*(?:—\s*)?([\s\S]*)$/;
    for (var i = 0; i < lines.length; i++) {
      var m = re.exec(lines[i]);
      if (!m) continue;
      out.push({
        n: Number(m[1]),
        ok: m[2] === 'ok',
        t: m[3],
        kind: m[4],
        detail: String(m[5] || '').trim()
      });
    }
    return out;
  }

  function importTrace() {
    var text = String($('in-trace-import').value || '');
    var parsed = parseTraceText(text);
    var box = $('trace-import-view');
    if (box) box.innerHTML = '';
    if (!parsed.length) {
      msg('msg-trace-import', '没解析出任何步骤 (格式应为「1. [ok] 时间 kind — detail」)', 'bad');
      trace('导入轨迹', '解析失败: 没有可识别的步骤', false);
      return;
    }
    var okCount = 0;
    var failCount = 0;
    for (var i = 0; i < parsed.length; i++) {
      var e = parsed[i];
      if (e.ok) okCount++; else failCount++;
      if (!box) continue;
      var row = document.createElement('div');
      row.className = 'item';
      var head = document.createElement('div');
      head.className = 'n';
      var tag = document.createElement('span');
      tag.className = e.ok ? 'ok' : 'bad';
      tag.textContent = (e.ok ? '✓ ' : '✗ ') + e.kind;
      head.appendChild(tag);
      var when = document.createElement('span');
      when.className = 'tiny';
      when.textContent = ' ' + e.t + ' · 第 ' + e.n + ' 步';
      head.appendChild(when);
      var body = document.createElement('div');
      body.className = 'm';
      body.textContent = e.detail;
      row.appendChild(head);
      row.appendChild(body);
      box.appendChild(row);
    }
    msg('msg-trace-import', '解析到 ' + parsed.length + ' 步 (成功 ' + okCount + ' / 失败 ' + failCount + ')', 'ok');
    trace('导入轨迹', '来自对方的轨迹文本 · ' + parsed.length + ' 步 (成功 ' + okCount + ' / 失败 ' + failCount + ')', true);
  }

  // ── 初始化 ──────────────────────────────────────────────────────────────
  function bindTabs() {
    var map = { 'tab-profile': 'view-profile', 'tab-card': 'view-card', 'tab-social': 'view-social', 'tab-trace': 'view-trace' };
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
    $('btn-save-p2p').addEventListener('click', function () { saveP2p(); });
    $('btn-trace-refresh').addEventListener('click', function () { refreshTrace(); refreshTraceText(); });
    $('btn-trace-clear').addEventListener('click', function () {
      S.clearTrace();
      trace('清空轨迹', '用户清空了本机轨迹', true);
      refreshTraceText();
    });
    $('btn-trace-export').addEventListener('click', function () { refreshTraceText(); msg('msg-trace-import', '轨迹文本已刷新', 'ok'); });
    $('btn-trace-import').addEventListener('click', importTrace);
  }

  function init() {
    fillForm();
    bindTabs();
    bindButtons();
    bindAvatar();
    renderBridgeState();
    renderContacts();
    refreshHandover();
    refreshTrace();
    refreshTraceText();
    loadAvatarImage().then(function () { redrawCard(); });

    trace('打开工具', '视图初始化完成 · 桥=' + (bridge() ? '可用' : '未注入') + ' · 已有联系人 ' + S.loadContacts().length + ' 条', true);

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
