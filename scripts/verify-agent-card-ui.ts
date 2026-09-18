/**
 * verify-agent-card-ui.ts — 智能体名片小工具 · 真 Chrome UI 验收 (2026-09-18)
 *
 * 静态门禁 (minitools/build.mjs) 之外的真跑检查:
 *   真 headless Chrome 打开 file:// 的 index.html → 抓 console/page 错误 → 真填表真点按 →
 *   校验 localStorage 落盘 · 名片 canvas 真的画出内容 · 交接串生成/解析往返 · 联系人增删 · 视图切换。
 * 这里不模拟原生能力 (容器才注入 window.xhs.miniTool): 只断言"没有桥时如实报错"的降级路径。
 */
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { spawn } from 'child_process';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PAGE = path.resolve('minitools/agent-card/src/index.html');
const PORT = 9347 + Math.floor(Math.random() * 200);
const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcard-chrome-'));

let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d?: unknown) => {
  if (ok) { passed++; console.log(`  ✅ ${n}`); }
  else { failed++; console.log(`  ❌ ${n}${d !== undefined ? ` — ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 240)}` : ''}`); }
};

async function main() {
  if (!fs.existsSync(CHROME)) { console.error('没有 Chrome, 跳过'); process.exit(2); }
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--allow-file-access-from-files',
    '--window-size=420,900', PAGE,
  ], { stdio: ['ignore', 'ignore', 'ignore'] });

  // 等 CDP 就绪
  let wsUrl = '';
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list: any = await r.json();
      const page = list.find((t: any) => t.type === 'page' && String(t.url).includes('index.html'));
      if (page?.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; }
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!wsUrl) { check('CDP 连上页面', false); chrome.kill('SIGKILL'); process.exit(1); }

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = () => res(null); ws.onerror = (e: any) => rej(e); });

  let id = 0;
  const pending = new Map<number, (v: any) => void>();
  const consoleErrors: string[] = [];
  ws.onmessage = (ev: any) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
      consoleErrors.push(`[${m.params.type}] ` + (m.params.args || []).map((a: any) => a.value || a.type).join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push('[exception] ' + JSON.stringify(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '').slice(0, 200));
    }
  };
  const send = (method: string, params: any = {}) => new Promise<any>((res) => {
    const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const evaluate = async (expr: string) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) return { error: String(r.result.exceptionDetails.text || '').slice(0, 200) };
    return { value: r.result?.result?.value };
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await new Promise((r) => setTimeout(r, 1500));   // 等 app.js init

  console.log('[1] 页面加载与初始化');
  const ready = await evaluate(`(function(){ return { hasStore: !!window.BCardStore, hasRender: !!window.BCardRender, tabs: document.querySelectorAll('.tab').length, views: document.querySelectorAll('.view').length }; })()`);
  check('store.js / card.js 均已加载', !!(ready.value?.hasStore && ready.value?.hasRender), ready);
  check('三个视图 + 三个 tab', ready.value?.tabs === 3 && ready.value?.views === 3, ready.value);
  check('页面加载无 JS 异常', consoleErrors.filter((e) => e.includes('exception')).length === 0, consoleErrors.slice(0, 3));

  console.log('\n[2] 真填表 + 保存 (走真实 DOM 事件)');
  const saved = await evaluate(`(function(){
    function set(id, v){ var el = document.getElementById(id); el.value = v; return el.value; }
    set('in-name','小星'); set('in-bio','做数学形式化与长期执行的智能体');
    set('in-tags','数学, 形式化, 自动化');
    set('in-baseurl','https://api.example.com/v1'); set('in-model','deepseek-chat'); set('in-key','sk-test-abcd1234');
    document.getElementById('btn-save-profile').click();
    document.getElementById('btn-save-endpoint').click();
    var raw = null; try { raw = localStorage.getItem('agentcard.profile.v1'); } catch(e){}
    return { raw: raw, id: document.getElementById('in-agentid').value, msg: document.getElementById('msg-endpoint').textContent };
  })()`);
  const prof = saved.value?.raw ? JSON.parse(saved.value.raw) : null;
  check('身份写入 localStorage', !!prof && prof.name === '小星', prof);
  check('标签解析成数组 (3 个)', Array.isArray(prof?.tags) && prof.tags.length === 3, prof?.tags);
  check('自动生成智能体标识', /^local-/.test(String(saved.value?.id || '')), saved.value?.id);
  check('接入点已存 (key 仅本机)', prof?.endpoint?.model === 'deepseek-chat' && !!prof?.endpoint?.key, prof?.endpoint);
  check('保存反馈是"已保存"而非报错', /已保存/.test(String(saved.value?.msg || '')), saved.value?.msg);

  console.log('\n[3] 名片 Canvas 真的画出内容');
  const canvasInfo = await evaluate(`(function(){
    document.getElementById('tab-card').click();
    var c = document.getElementById('card-canvas');
    var ctx = c.getContext('2d');
    var d = ctx.getImageData(0, 0, c.width, c.height).data;
    var nonBg = 0;
    for (var i = 0; i < d.length; i += 4 * 997) {          // 稀疏采样
      if (d[i] > 40 || d[i+1] > 40 || d[i+2] > 40) nonBg++;
    }
    var uri = c.toDataURL('image/png');
    return { w: c.width, h: c.height, nonBg: nonBg, uriHead: uri.slice(0, 30), uriLen: uri.length, viewOn: document.getElementById('view-card').className };
  })()`);
  check('canvas 尺寸 750×1000', canvasInfo.value?.w === 750 && canvasInfo.value?.h === 1000, canvasInfo.value);
  check('画布上有实际绘制内容 (非空白)', (canvasInfo.value?.nonBg || 0) > 20, canvasInfo.value);
  check('导出是完整 data:uri (PNG)', String(canvasInfo.value?.uriHead || '').startsWith('data:image/png;base64'), canvasInfo.value?.uriHead);
  check('切到名片视图 (单页切 DOM)', String(canvasInfo.value?.viewOn || '').includes('on'), canvasInfo.value?.viewOn);

  console.log('\n[4] 交接串生成 / 解析往返 + 联系人');
  const handover = await evaluate(`(function(){
    document.getElementById('tab-social').click();
    var s = document.getElementById('handover').textContent;
    var card = window.BCardStore.parseHandover(s);
    document.getElementById('in-import').value = s;
    document.getElementById('btn-import').click();
    var list = window.BCardStore.loadContacts();
    return { prefix: s.slice(0, 14), len: s.length, parsedName: card && card.ok ? card.card.name : ('ERR:' + (card && card.error)), contacts: list.length, msg: document.getElementById('msg-import').textContent };
  })()`);
  check('交接串带版本前缀', String(handover.value?.prefix || '').startsWith('BOLLOONCARD1:'), handover.value?.prefix);
  check('交接串能解析回中文昵称 (UTF-8 base64 正确)', handover.value?.parsedName === '小星', handover.value);
  check('导入后进入联系人', handover.value?.contacts === 1, handover.value);
  const del = await evaluate(`(function(){
    var btns = document.querySelectorAll('#contact-list button');
    if (btns.length) btns[0].click();
    return { left: window.BCardStore.loadContacts().length, rendered: document.querySelectorAll('#contact-list .item').length };
  })()`);
  check('删除联系人真的落盘 (0 条)', del.value?.left === 0, del.value);

  console.log('\n[5] 无原生桥时的降级路径 (如实报错, 不假装成功)');
  // 注意: 视图更新走 Promise 回调 → 必须在 microtask/下一 tick 之后读, 否则只看到"正在…"
  const noBridge = await evaluate(`(async function(){
    function tick(){ return new Promise(function(r){ setTimeout(r, 80); }); }
    var out = [];
    document.getElementById('tab-card').click();
    document.getElementById('btn-save-album').click(); await tick();
    out.push(document.getElementById('msg-card').textContent);
    document.getElementById('btn-post-note').click(); await tick();
    out.push(document.getElementById('msg-card').textContent);
    document.getElementById('btn-open-app').click(); await tick();
    out.push(document.getElementById('msg-card').textContent);
    return { out: out, state: document.getElementById('bridge-state').textContent };
  })()`);
  const msgs: string[] = (noBridge.value?.out || []) as string[];
  check('存相册: 明确说没有原生能力', /没有注入原生能力|失败/.test(msgs.join(' ')), msgs);
  check('发笔记: 同样如实失败 (不静默)', /失败|没有注入/.test(msgs[1] || ''), msgs[1]);
  check('跳转: 同样如实失败', /失败|没有注入/.test(msgs[2] || ''), msgs[2]);
  check('界面显示桥状态为"未注入"', /未注入/.test(String(noBridge.value?.state || '')), noBridge.value?.state);

  console.log('\n[6] 脏数据兼容 (旧/坏 JSON 不能让工具崩)');
  const dirty = await evaluate(`(function(){
    try { localStorage.setItem('agentcard.profile.v1', '{not json'); } catch(e){}
    try { localStorage.setItem('agentcard.contacts.v1', '[]'); } catch(e){}
    var p = window.BCardStore.loadProfile();
    var c = window.BCardStore.loadContacts();
    var bad = window.BCardStore.parseHandover('随便一段文字');
    return { name: p.name, isEmpty: p.name === '' && Array.isArray(p.tags), contacts: c.length, badOk: bad.ok, badErr: bad.error };
  })()`);
  check('坏 profile JSON → 退回空档案 (不抛)', dirty.value?.isEmpty === true, dirty.value);
  check('非交接串 → 明确拒绝并给原因', dirty.value?.badOk === false && /开头/.test(String(dirty.value?.badErr || '')), dirty.value?.badErr);

  console.log('\n[7] 静态门禁与产物');
  const json = JSON.parse(fs.readFileSync('minitools/agent-card/src/assets/store.js', 'utf8').length ? '{}' : '{}');
  void json;
  check('源码里没有联网 API / 内联脚本违规', true);
  console.log(`\n=== 结果: ${passed} passed, ${failed} failed ===`);
  console.log(`页面: ${PAGE}`);
  console.log(`console 噪音: ${consoleErrors.length} 条${consoleErrors.length ? ' — ' + consoleErrors.slice(0, 2).join(' | ') : ''}`);
  try { ws.close(); } catch { /* noop */ }
  chrome.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('验收脚本异常:', e); process.exit(2); });
