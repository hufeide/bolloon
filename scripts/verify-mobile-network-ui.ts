/**
 * verify-mobile-network-ui.ts — 手机端「网络」页点按式交互 真浏览器验证
 *
 * 用仓库自己的 browser 模块 (headless Chrome CDP) 打开 dist/web/mobile.html,
 * 真的点 加入网络 / 连接好友 / 附近设备, 断言弹出的 sheet 可见, 并存截图。
 *
 * 前置: npm run build:web && (cd dist/web && python3 -m http.server 8899)
 * 用法: npx tsx scripts/verify-mobile-network-ui.ts
 */

import { BrowserCdpSession, __shutdownBrowserForTest } from '../src/agents/browser-cdp.js';

const BASE = process.env.MOBILE_UI_BASE || 'http://127.0.0.1:8899/mobile.html';

async function main() {
  const session = new BrowserCdpSession({ headless: true });
  const results: Array<{ name: string; ok: boolean; note: string }> = [];
  const record = (name: string, ok: boolean, note = '') => {
    results.push({ name, ok, note });
    console.log(`${ok ? '✅' : '❌'} ${name}${note ? ` — ${note}` : ''}`);
  };

  try {
    const open = await session.execute({ action: 'open', url: BASE, timeoutMs: '25000' });
    if (!open.success) {
      console.log(`❌ 打不开 ${BASE}: ${open.error}`);
      process.exit(1);
    }

    // 等内核脚本就绪 (mobile-core.js 2MB+, 首次加载慢)
    const ready = await session.execute({
      action: 'js',
      code: `(async () => { for (let i=0;i<40;i++){ if (window.BolloonCore && document.querySelector('#item-join-net')) return 'ready'; await new Promise(r=>setTimeout(r,250)); } return 'timeout'; })()`,
      timeoutMs: '25000',
    });
    record('① mobile.html 加载 + BolloonCore 就绪', String(ready.output).includes('ready'), String(ready.output).slice(0, 60));

    // 点「加入网络」→ 应弹 sheet (三个点按选项), 不再是 prompt 输入网址
    await session.execute({ action: 'click', selector: '#item-join-net' });
    const joinSheet = await session.execute({
      action: 'js',
      code: `(() => { const s=document.querySelector('#network-sheet'); return JSON.stringify({ visible: !!s && !s.hidden, choices: ['#choice-join-nearby','#choice-join-scan','#choice-join-manual'].map(x=>!!document.querySelector(x)) }); })()`,
    });
    const js1 = JSON.parse(String(joinSheet.output));
    record('② 点「加入网络」→ 弹出点按选项 (附近/扫码/粘贴兜底)', js1.visible && js1.choices.every(Boolean), JSON.stringify(js1));

    // 关闭后点「连接好友」→ addfriend sheet (附近/扫码/待处理申请/手动兜底)
    await session.execute({ action: 'js', code: `document.querySelector('#choice-join-cancel').click(); 'ok'` });
    await session.execute({ action: 'click', selector: '#item-add-friend' });
    const friendSheet = await session.execute({
      action: 'js',
      code: `(() => { const s=document.querySelector('#addfriend-sheet'); return JSON.stringify({ visible: !!s && !s.hidden, choices: ['#choice-nearby','#choice-scan','#choice-requests','#choice-manual'].map(x=>!!document.querySelector(x)) }); })()`,
    });
    const js2 = JSON.parse(String(friendSheet.output));
    record('③ 点「连接好友」→ 弹出点按选项 (附近/扫码/待处理/手动)', js2.visible && js2.choices.every(Boolean), JSON.stringify(js2));

    // 点「附近的设备」→ nearby sheet 弹出并渲染列表或大白话空态
    await session.execute({ action: 'js', code: `document.querySelector('#choice-nearby').click(); 'ok'` });
    await session.execute({ action: 'js', code: `new Promise(r=>setTimeout(r,800)).then(()=>'ok')` });
    const nearby = await session.execute({
      action: 'js',
      code: `(() => { const s=document.querySelector('#nearby-sheet'); return JSON.stringify({ visible: !!s && !s.hidden, title: (document.querySelector('#nearby-title')||{}).textContent, hint: (document.querySelector('#nearby-hint')||{}).textContent, rows: (document.querySelectorAll('#nearby-list .list-item')||[]).length }); })()`,
    });
    const js3 = JSON.parse(String(nearby.output));
    record('④ 「附近的设备」面板可点 + 有文案反馈', js3.visible && !!js3.hint, JSON.stringify(js3));

    // ⑤ 一键入网 (全球智能体网络): 点一下 → 默认 prompt 发给智能体 (真点真断言)
    //    页面里打桩 /channels 与 /message, 断言发出的正文就是网关入网默认 prompt
    const stub = await session.execute({
      action: 'js',
      code: `(() => {
        const core = window.BolloonCore;
        window.__sent = [];
        const origGet = core.resolve && core.resolve.bind(core);
        const origPost = core.resolvePost && core.resolvePost.bind(core);
        // 注意: mobile 的 resolve()/resolvePost() 返回的是 thunk (要被 api.get/post 再调一次)
        core.resolve = (path) => {
          if (path === '/channels') return () => Promise.resolve([{ id: 'ch-verify', name: '验证智能体' }]);
          return origGet ? origGet(path) : null;
        };
        core.resolvePost = (path, body) => {
          if (path === '/message') return () => { window.__sent.push(body); return Promise.resolve({ ok: true }); };
          return origPost ? origPost(path, body) : null;
        };
        return 'stubbed';
      })()`,
    });
    record('⑤ 打桩 /channels + /message 成功', String(stub.output).includes('stubbed'), String(stub.output).slice(0, 40));

    await session.execute({ action: 'click', selector: '#item-join-global' });
    await session.execute({ action: 'js', code: `new Promise(r=>setTimeout(r,1200)).then(()=>'ok')` });
    const joined = await session.execute({
      action: 'js',
      code: `(() => {
        const s = (window.__sent || [])[0] || {};
        const bubbles = Array.from(document.querySelectorAll('#chat-messages .bubble.user')).map(b=>b.textContent);
        return JSON.stringify({ text: s.text || '', channelId: s.channelId || '', chatOpen: !!document.querySelector('#chat-messages'), bubbles });
      })()`,
    });
    const j5 = JSON.parse(String(joined.output));
    const EXPECT = 'read https://bolloon.cn/bolloon-gateway-join.md';
    record(
      '⑥ 点「一键入网」→ 发出默认 prompt 并落到会话',
      j5.text === EXPECT && j5.channelId === 'ch-verify' && j5.chatOpen && j5.bubbles.includes(EXPECT),
      JSON.stringify(j5).slice(0, 220),
    );

    // 截图存证 (browser 模块返回字段是 screenshotPath)
    const shot = await session.execute({ action: 'screenshot' });
    const shotPath = shot.screenshotPath || shot.path;
    record('⑦ 截图存证', !!shotPath, String(shotPath || ''));

    await session.execute({ action: 'close' });
  } catch (e: any) {
    console.log(`❌ 异常: ${String(e?.message || e).slice(0, 200)}`);
    results.push({ name: '异常', ok: false, note: String(e?.message || e) });
  } finally {
    await __shutdownBrowserForTest();
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n──────────────────────────────');
  console.log(`结果: ${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

void main();
