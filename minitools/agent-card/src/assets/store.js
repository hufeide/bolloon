/* store.js — 本地数据层 (经典脚本; 挂在 window.BCardStore)
 *
 * 约束 (改前先读 .skill/minitool-zip-builder/references/*):
 *   · 不联网: 没有任何 fetch/XHR; 数据只在 localStorage 与本机内存
 *   · ES2017 基线 (Chrome 61): 不用可选链/空值合并/对象展开;用 Object.assign
 *   · localStorage 按小工具隔离, 但不保证永久保留 → 重要数据靠"交接串"备份
 */
(function (global) {
  'use strict';

  var PROFILE_KEY = 'agentcard.profile.v1';
  var CONTACTS_KEY = 'agentcard.contacts.v1';
  var PREFIX = 'BOLLOONCARD1:';

  function safeGet(key) {
    try { return global.localStorage.getItem(key); } catch (e) { return null; }
  }

  function safeSet(key, val) {
    try { global.localStorage.setItem(key, val); return true; } catch (e) { return false; }
  }

  function readJson(key, fallback) {
    var raw = safeGet(key);
    if (!raw) return fallback;
    try {
      var v = JSON.parse(raw);
      return v === null || v === undefined ? fallback : v;
    } catch (e) { return fallback; }
  }

  // ── UTF-8 safe base64 (btoa 只吃 latin1, 中文会炸) ───────────────────────
  function utf8ToBase64(str) {
    var bytes = new global.TextEncoder().encode(str);
    var chunk = '';
    for (var i = 0; i < bytes.length; i++) chunk += String.fromCharCode(bytes[i]);
    return global.btoa(chunk);
  }

  function base64ToUtf8(b64) {
    var bin = global.atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new global.TextDecoder('utf-8').decode(bytes);
  }

  // ── 本地短码 (离线可算; 不是密码学身份, 明说"本地码") ────────────────────
  function localCode(name) {
    var seed = String(name || '') + '|' + String(Date.now()) + '|' + String(Math.random());
    var h1 = 2166136261;   // FNV-1a 32
    var h2 = 5381;         // djb2
    for (var i = 0; i < seed.length; i++) {
      var c = seed.charCodeAt(i);
      h1 = (h1 ^ c) * 16777619 >>> 0;
      h2 = ((h2 << 5) + h2 + c) >>> 0;
    }
    var a = h1.toString(36);
    var b = h2.toString(36);
    return 'local-' + (a + b).slice(0, 12);
  }

  function emptyProfile() {
    return {
      name: '', bio: '', tags: [], avatar: '', agentId: '',
      endpoint: { baseUrl: '', model: '', key: '' },
      updatedAt: ''
    };
  }

  function loadProfile() {
    var p = readJson(PROFILE_KEY, null);
    if (!p || typeof p !== 'object') return emptyProfile();
    var base = emptyProfile();
    return {
      name: String(p.name || ''),
      bio: String(p.bio || ''),
      tags: Array.isArray(p.tags) ? p.tags.slice(0, 5) : [],
      avatar: String(p.avatar || ''),
      agentId: String(p.agentId || ''),
      endpoint: {
        baseUrl: String((p.endpoint && p.endpoint.baseUrl) || ''),
        model: String((p.endpoint && p.endpoint.model) || ''),
        key: String((p.endpoint && p.endpoint.key) || '')
      },
      updatedAt: String(p.updatedAt || '')
    };
  }

  function saveProfile(p) {
    var next = loadProfile();
    next.name = String(p.name || '').slice(0, 20);
    next.bio = String(p.bio || '').slice(0, 60);
    next.tags = (Array.isArray(p.tags) ? p.tags : []).map(function (t) {
      return String(t).trim();
    }).filter(Boolean).slice(0, 5);
    next.avatar = String(p.avatar || '');
    next.agentId = String(p.agentId || '').slice(0, 80);
    next.endpoint = {
      baseUrl: String((p.endpoint && p.endpoint.baseUrl) || '').slice(0, 200),
      model: String((p.endpoint && p.endpoint.model) || '').slice(0, 60),
      key: String((p.endpoint && p.endpoint.key) || '').slice(0, 200)
    };
    if (!next.agentId && next.name) next.agentId = localCode(next.name);   // 没填就用本地码
    next.updatedAt = new Date().toISOString();
    var ok = safeSet(PROFILE_KEY, JSON.stringify(next));
    return { profile: next, persisted: ok };
  }

  function loadContacts() {
    var arr = readJson(CONTACTS_KEY, []);
    return Array.isArray(arr) ? arr : [];
  }

  function saveContacts(list) {
    return safeSet(CONTACTS_KEY, JSON.stringify((list || []).slice(0, 200)));
  }

  function upsertContact(c) {
    var list = loadContacts();
    var id = String(c.agentId || c.name || '');
    var out = [];
    var replaced = false;
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].agentId || list[i].name || '') === id) { out.push(c); replaced = true; }
      else out.push(list[i]);
    }
    if (!replaced) out.push(c);
    saveContacts(out);
    return out;
  }

  function removeContact(agentId) {
    var list = loadContacts().filter(function (c) {
      return String(c.agentId || c.name || '') !== String(agentId);
    });
    saveContacts(list);
    return list;
  }

  // ── 交接串: 明确带版本前缀, 方便 App 侧识别 ─────────────────────────────
  function toHandover(profile) {
    var payload = {
      v: 1,
      kind: 'bolloon-agent-card',
      name: profile.name,
      bio: profile.bio,
      tags: profile.tags,
      agentId: profile.agentId,
      endpoint: {
        baseUrl: profile.endpoint.baseUrl,
        model: profile.endpoint.model,
        keyTail: profile.endpoint.key ? String(profile.endpoint.key).slice(-4) : ''
      },
      issuedAt: new Date().toISOString()
    };
    return PREFIX + utf8ToBase64(JSON.stringify(payload));
  }

  function parseHandover(text) {
    var s = String(text || '').trim();
    if (s.indexOf(PREFIX) !== 0) return { ok: false, error: '不是本工具的交接串 (应以 ' + PREFIX + ' 开头)' };
    try {
      var json = base64ToUtf8(s.slice(PREFIX.length));
      var obj = JSON.parse(json);
      if (!obj || obj.kind !== 'bolloon-agent-card') return { ok: false, error: '内容不是智能体名片' };
      return { ok: true, card: obj };
    } catch (e) {
      return { ok: false, error: '解析失败: ' + String((e && e.message) || e) };
    }
  }

  global.BCardStore = {
    PROFILE_KEY: PROFILE_KEY,
    CONTACTS_KEY: CONTACTS_KEY,
    PREFIX: PREFIX,
    loadProfile: loadProfile,
    saveProfile: saveProfile,
    loadContacts: loadContacts,
    saveContacts: saveContacts,
    upsertContact: upsertContact,
    removeContact: removeContact,
    toHandover: toHandover,
    parseHandover: parseHandover,
    localCode: localCode,
    utf8ToBase64: utf8ToBase64,
    base64ToUtf8: base64ToUtf8
  };
})(window);
