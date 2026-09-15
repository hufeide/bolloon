/**
 * verify-mobile-join-e2e.ts — 手机端「一键入网」真闭环 (真 bundle + 真浏览器 + 真桌面 registry)
 *
 * 全链路真跑, 不 mock:
 *   ① 起**真** bolloon web server (createWebServer, 真 HTTP + 真 OrbitDB registry)
 *   ② 真 headless Chrome 打开**该 server 自己托管**的 dist/web/mobile.html (真 mobile-core 内核)
 *   ③ 在页面里把桌面基址写进 localStorage (与设置页同一 key) → 点「一键入网」真按钮
 *   ④ 手机端本地执行: 真 fetch 线上入网说明 → 校验 frontmatter → 本机 DID → 真 POST 桌面
 *      /api/registry/register → 落盘入网态
 *   ⑤ 断言: 聊天里出现入网报告 (含 DID/版本/步骤) + 本机入网态 + **桌面 registry 真含手机 DID**
 *   ⑥ 负例: 桌面基址不可达 → 仍完成本机入网, 但「服务登记」如实标失败 (不假装)
 *
 * 用法: npx tsx scripts/verify-mobile-join-e2e.ts
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { BrowserCdpSession, __shutdownBrowserForTest } from '../src/agents/browser-cdp.js';

const tmpRoot = path.join(os.tmpdir(), 'bolloon-mobile-join-e2e-' + Date.now());
process.env.HOME = path.join(tmpRoot, 'home');
process.env.USERPROFILE = process.env.HOME;
process.env.BOLLOON_SKIP_KUBO = '1';
process.env.BOLLOON_CRON = '0';
process.env.BOLLOON_AGENT_HEARTBEAT_SOCIAL = '0';

const PORT = Number(process.env.E2E_PORT || 54310);
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0, failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await fs.mkdir(process.env.HOME as string, { recursive: true });
  console.log('=== 手机端「一键入网」真闭环 (真 bundle + 真浏览器 + 真桌面 registry) ===\n');

  // ---------- ① 真桌面 server ----------
  const { createWebServer } = await import('../src/web/server.js');
  console.log('[1] 起真 web server…');
  const started: any = await createWebServer(PORT, { selfImprove: false } as any);
  const port = started?.port || PORT;
  const base = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  // 等 mobile.html 可服务
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${base}/mobile.html`); if (r.ok) break; } catch { /* 还没起 */ }
    await sleep(500);
  }
  console.log(`    server ${base} 就绪 (${Date.now() - t0}ms)`);

  // ---------- ② 真浏览器 + 真页面 ----------
  const session = new BrowserCdpSession({ headless: true });
  const open = await session.execute({ action: 'open', url: `${base}/mobile.html`, timeoutMs: '30000' });
  if (!open.success) { console.log('❌ 打不开 mobile.html: ' + open.error); process.exit(1); }
  const ready = await session.execute({
    action: 'js',
    code: `(async () => { for (let i=0;i<60;i++){ if (window.BolloonCore && document.querySelector('#item-join-global')) return 'ready'; await new Promise(r=>setTimeout(r,250)); } return 'timeout'; })()`,
    timeoutMs: '30000',
  });
  check('mobile.html 真加载 + 内核就绪', String(ready.output).includes('ready'), String(ready.output).slice(0, 60));

  // 桌面基址写进 localStorage (与设置页同一 key), 再刷新让内核读到
  await session.execute({
    action: 'js',
    code: `localStorage.setItem('bolloon_desktop_base_url', ${JSON.stringify(base)}); 'ok'`,
  });
  await session.execute({ action: 'open', url: `${base}/mobile.html`, timeoutMs: '30000' });
  await session.execute({
    action: 'js',
    code: `(async () => { for (let i=0;i<60;i++){ if (window.BolloonCore && document.querySelector('#item-join-global')) return 'ready'; await new Promise(r=>setTimeout(r,250)); } return 'timeout'; })()`,
    timeoutMs: '30000',
  });
  const storedBase = await session.execute({ action: 'js', code: `localStorage.getItem('bolloon_desktop_base_url')` });
  check('桌面基址已持久化 (localStorage)', String(storedBase.output).includes(`:${port}`), String(storedBase.output));

  // ---------- ③ 点「一键入网」 ----------
  await session.execute({ action: 'click', selector: '#item-join-global' });
  // 等手机端本地执行完成 (真 fetch 文档 + 真 POST registry)
  const report = await session.execute({
    action: 'js',
    code: `(async () => {
      const pick = () => Array.from(document.querySelectorAll('.bubble.ai')).map(e => e.textContent).join('\\n↔\\n');
      for (let i=0;i<120;i++){ const t = pick(); if (t && (t.includes('入网') || t.includes('失败'))) return t; await new Promise(r=>setTimeout(r,500)); }
      return pick();
    })()`,
    timeoutMs: '70000',
  });
  const aiText = String(report.output || '');
  console.log('\n[2] 手机端回复 (前 700 字):');
  console.log('---------------------------------------------');
  console.log(aiText.slice(0, 700));
  console.log('---------------------------------------------');
  check('聊天里出现入网结果 (不是空转兜底)', aiText.includes('已加入全球智能体网络'), aiText.slice(0, 120));
  check('回复含入网说明版本 v1.2.0', aiText.includes('v1.2.0'), aiText.slice(0, 200));
  check('回复含手机端本机 DID', /did:blln:[a-f0-9]{8}/.test(aiText), aiText.slice(0, 200));
  check('回复含「已登记进电脑端网络 registry」', aiText.includes('电脑端网络 registry'), aiText.slice(0, 300));
  check('不再出现旧的空转兜底文案', !aiText.includes('这是手机端 Agent 功能层的本地执行'), aiText.slice(0, 120));

  // ---------- ④ 本机入网态 ----------
  const stateRaw = await session.execute({ action: 'js', code: `localStorage.getItem('bolloon_gateway_join')` });
  let state: any = null;
  try { state = JSON.parse(String(stateRaw.output)); } catch { /* 未落盘 */ }
  check('本机入网态已落盘 (bolloon_gateway_join)', !!state?.did, String(stateRaw.output).slice(0, 160));
  check('入网态含 docVersion/registeredOn', state?.docVersion === '1.2.0' && state?.registeredOn === 'desktop', JSON.stringify(state || {}).slice(0, 200));

  // ---------- ⑤ 桌面 registry 真含手机 DID ----------
  const reg = await (await fetch(`${base}/api/registry`)).json().catch(() => null as any);
  const services: any[] = Array.isArray(reg?.services) ? reg.services : [];
  const phoneDid = String(state?.did || '');
  const found = services.find((s) => String(s.agentId) === phoneDid);
  check('桌面 registry 真含手机端 DID (跨节点成员可见)', !!found, `did=${phoneDid} services=${services.length}`);
  if (found) check('registry 里能力含 gateway-join', Array.isArray(found.capabilities) && found.capabilities.includes('gateway-join'), JSON.stringify(found.capabilities));

  await session.execute({ action: 'screenshot', path: path.join(tmpRoot, 'mobile-join.png') }).catch(() => {});

  // ---------- ⑥ 负例: 桌面不可达 → 本机入网成功但如实标失败 ----------
  //   注意: 必须换 URL 真重载 (?neg=1) —— 同一 URL 的导航可能被浏览器当成 no-op,
  //   那样聊天区还留着上一轮的气泡, 断言会读到旧回复 (第一次跑就踩了这个坑)。
  console.log('\n[3] 负例: 桌面基址不可达 (http://127.0.0.1:1)');
  await session.execute({ action: 'js', code: `localStorage.setItem('bolloon_desktop_base_url', 'http://127.0.0.1:1'); localStorage.removeItem('bolloon_gateway_join'); 'ok'` });
  await session.execute({ action: 'open', url: `${base}/mobile.html?neg=1`, timeoutMs: '30000' });
  await session.execute({
    action: 'js',
    code: `(async () => { for (let i=0;i<60;i++){ if (window.BolloonCore && document.querySelector('#item-join-global') && document.querySelectorAll('.bubble').length === 0) return 'ready'; await new Promise(r=>setTimeout(r,250)); } return 'timeout'; })()`,
    timeoutMs: '30000',
  });
  const negBase = await session.execute({ action: 'js', code: `localStorage.getItem('bolloon_desktop_base_url')` });
  check('负例环境就绪 (桌面基址=死端口, 聊天区已清空)', String(negBase.output).includes('127.0.0.1:1'), String(negBase.output));
  await session.execute({ action: 'click', selector: '#item-join-global' });
  const report2 = await session.execute({
    action: 'js',
    code: `(async () => {
      const pick = () => Array.from(document.querySelectorAll('.bubble.ai')).map(e => e.textContent).join('\\n↔\\n');
      for (let i=0;i<120;i++){ const t = pick(); if (t && t.includes('入网')) return t; await new Promise(r=>setTimeout(r,500)); }
      return pick();
    })()`,
    timeoutMs: '70000',
  });
  const ai2 = String(report2.output || '');
  check('桌面不可达: 仍完成本机入网 (手机自治)', ai2.includes('已加入全球智能体网络'), ai2.slice(0, 160));
  check('桌面不可达: 服务登记如实标 ✗ 不可达 (不假装)', ai2.includes('✗ 服务登记') && ai2.includes('不可达'), ai2.slice(0, 400));

  console.log(`\n=== 结果: ${passed} passed, ${failed} failed ===`);
  console.log(`(截图: ${tmpRoot}/mobile-join.png)`);
  try { await __shutdownBrowserForTest(); } catch { /* noop */ }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('验证脚本异常:', e); process.exit(1); });
