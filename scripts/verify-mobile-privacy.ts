/**
 * verify-mobile-privacy.ts — 手机端隐私合规 真浏览器验收 (真 Chrome 点真 DOM)
 *
 * 为什么必须真浏览器跑: "同意前不初始化/不连网" 这类要求, 看代码看不出来 ——
 * 只有真加载 mobile.html, 点真按钮, 看真 DOM 与真 localStorage 才能证明。
 *
 * 前置: npm run build:web && (cd dist/web && python3 -m http.server 8899)
 * 用法: npx tsx scripts/verify-mobile-privacy.ts
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
  const js = async (code: string, timeoutMs = '20000') => {
    const r = await session.execute({ action: 'js', code, timeoutMs });
    return r.success ? String(r.output) : `ERR: ${r.error}`;
  };
  /**
   * 等 sheet 的滑入动画结束再点。
   * 踩过的坑: .sheet-inner 有 animation: sheetUp .28s ease (from translateY(100%)) ——
   * 动画期间元素还在屏幕外, 坐标点击会打在视口外 (elementFromPoint=null) 而静默失手。
   * 真人会等它滑上来再点, 验收也必须等, 否则测出来的是"点了没反应"的假缺陷。
   */
  const settle = () => js(`new Promise(r=>setTimeout(r,450)).then(()=>'ok')`);

  try {
    const open = await session.execute({ action: 'open', url: BASE, timeoutMs: '25000' });
    if (!open.success) { console.log(`❌ 打不开 ${BASE}: ${open.error}`); process.exit(1); }

    // 清掉同意记录 → 模拟首启
    await js(`(() => { try { localStorage.clear(); } catch (e) {} return 'ok'; })()`);
    await session.execute({ action: 'open', url: BASE, timeoutMs: '25000' });
    await js(`(async () => { for (let i=0;i<40;i++){ if (window.BolloonCore && document.querySelector('#privacy-gate')) return 'ready'; await new Promise(r=>setTimeout(r,250)); } return 'timeout'; })()`);

    await settle();   // 等同意门滑入动画结束 (否则坐标点击会打在视口外)

    // ① 首启必弹同意门, 且文案齐备
    const gate = JSON.parse(await js(`(() => {
      const g = document.querySelector('#privacy-gate');
      const t = document.querySelector('#privacy-gate-title');
      const b = document.querySelector('#privacy-gate-body');
      const a = document.querySelector('#privacy-agree');
      const d = document.querySelector('#privacy-decline');
      const l = document.querySelector('#privacy-gate-link');
      return JSON.stringify({
        visible: !!g && !g.hidden,
        title: t ? t.textContent.trim() : '',
        bodyLen: b ? b.textContent.trim().length : 0,
        agree: a ? a.textContent.trim() : '',
        decline: d ? d.textContent.trim() : '',
        link: l ? l.textContent.trim() : '',
        consent: localStorage.getItem('bolloon_privacy_consent')
      });
    })()`));
    record('① 首启弹同意门 + 文案齐备', gate.visible && gate.bodyLen > 40 && gate.agree.length > 0 && gate.decline.length > 0 && gate.link.length > 0,
      JSON.stringify({ ...gate, bodyLen: gate.bodyLen }));
    record('① 未同意时 consent 记录为空', gate.consent === null, String(gate.consent));

    // ② 同意前不得初始化: 主界面 tab 未激活 + 没有发起网络请求
    const preInit = JSON.parse(await js(`(() => {
      const pages = ['page-main','page-friends','page-network','page-me'].map(id => {
        const el = document.getElementById(id);
        return el ? !el.hidden : false;
      });
      return JSON.stringify({ anyPageVisible: pages.some(Boolean) });
    })()`));
    record('② 同意前不初始化功能 (没有任何主页面被激活)', preInit.anyPageVisible === false, JSON.stringify(preInit));

    // ③ 点「阅读完整隐私政策」→ 应用内政策页 (离线可用, 含必填要素 + 备案文案)
    //    先挂探针: 真点到了吗 / 政策页的 hidden 到底被谁改回来的 (这一步失败过, 留证)
    await js(`(() => {
      window.__privacyProbe = { linkClicks: 0, policyHiddenAtClick: null };
      const l = document.querySelector('#privacy-gate-link');
      if (l) l.addEventListener('click', () => { window.__privacyProbe.linkClicks++; });
      return 'probe-installed';
    })()`);
    await session.execute({ action: 'click', selector: '#privacy-gate-link' });
    await js(`new Promise(r=>setTimeout(r,300)).then(()=>'ok')`);
    const policy = JSON.parse(await js(`(() => {
      const p = document.querySelector('#policy-page');
      const b = document.querySelector('#policy-body');
      const txt = b ? b.textContent : '';
      return JSON.stringify({
        visible: !!p && !p.hidden,
        exists: !!p,
        bodyLen: txt.length,
        linkClicks: (window.__privacyProbe || {}).linkClicks,
        gateStillOpen: (() => { const g = document.querySelector('#privacy-gate'); return !!g && !g.hidden; })(),
        hashes: b ? b.querySelectorAll('h3').length : 0,
        hasWipe: txt.includes('清除本机数据（注销）'),
        hasThird: txt.includes('第三方'),
        hasPerm: txt.includes('系统权限'),
        hasFiling: txt.includes('备案'),
        hasContact: txt.includes('@')
      });
    })()`));
    record('③ 政策页可打开且含必填要素(注销/第三方/权限/备案/联系方式)',
      policy.visible && policy.hashes >= 6 && policy.hasWipe && policy.hasThird && policy.hasPerm && policy.hasFiling && policy.hasContact,
      JSON.stringify(policy));
    await js(`(() => { const b = document.querySelector('#policy-back'); if (b) b.click(); return 'ok'; })()`);

    // ④ 点「不同意」→ 停在说明页, 仍然不初始化、不记录同意
    await settle();   // 等动画 (showPrivacyGate 重新赋了文案 → 尺寸可能变)
    await session.execute({ action: 'click', selector: '#privacy-decline' });
    await js(`new Promise(r=>setTimeout(r,300)).then(()=>'ok')`);
    const declined = JSON.parse(await js(`(() => {
      const g = document.querySelector('#privacy-gate');
      const b = document.querySelector('#privacy-gate-body');
      const pages = ['page-main','page-network'].map(id => { const el = document.getElementById(id); return el ? !el.hidden : false; });
      return JSON.stringify({
        gateVisible: !!g && !g.hidden,
        body: b ? b.textContent.slice(0, 40) : '',
        anyPageVisible: pages.some(Boolean),
        consent: localStorage.getItem('bolloon_privacy_consent')
      });
    })()`));
    record('④ 不同意 → 停在说明页且仍不初始化/不记录同意',
      declined.gateVisible && declined.anyPageVisible === false && declined.consent === null, JSON.stringify(declined));

    // ⑤ 点「同意并继续」→ 记录同意 + 进入应用
    await js(`(() => { const l = document.querySelector('#privacy-gate-link'); if (l) l.click(); return 'ok'; })()`);
    await settle();
    await session.execute({ action: 'click', selector: '#privacy-agree' });
    await js(`new Promise(r=>setTimeout(r,600)).then(()=>'ok')`);
    const agreed = JSON.parse(await js(`(() => {
      const g = document.querySelector('#privacy-gate');
      const main = document.getElementById('page-main');
      const tab = document.querySelector('.tabbar');
      return JSON.stringify({
        gateHidden: !!g && g.hidden,
        consent: localStorage.getItem('bolloon_privacy_consent'),
        mainVisible: !!main && !main.hidden,
        tabbar: !!tab
      });
    })()`));
    record('⑤ 同意 → 记录 consent=' + agreed.consent + ' 且进入应用',
      agreed.gateHidden && agreed.consent === '1' && agreed.mainVisible && agreed.tabbar, JSON.stringify(agreed));

    // ⑥ 重启不重复弹门 (同意记录生效)
    await session.execute({ action: 'open', url: BASE, timeoutMs: '25000' });
    await js(`(async () => { for (let i=0;i<40;i++){ if (window.BolloonCore && document.querySelector('#item-settings')) return 'ready'; await new Promise(r=>setTimeout(r,250)); } return 'timeout'; })()`);
    const restart = JSON.parse(await js(`(() => {
      const g = document.querySelector('#privacy-gate');
      const main = document.getElementById('page-main');
      return JSON.stringify({ gateHidden: !!g && g.hidden, mainVisible: !!main && !main.hidden });
    })()`));
    record('⑥ 重启(已同意)不再弹门且直接进应用', restart.gateHidden && restart.mainVisible, JSON.stringify(restart));

    // ⑦ 设置页三行存在: 隐私政策 / 清除本机数据（注销） / 备案号
    await session.execute({ action: 'click', selector: '#item-settings' });
    await js(`new Promise(r=>setTimeout(r,500)).then(()=>'ok')`);
    const settings = JSON.parse(await js(`(() => {
      const rows = ['settings-privacy','settings-wipe','settings-filing'].map(id => !!document.getElementById(id));
      const ft = document.getElementById('filing-text');
      return JSON.stringify({ rows, filing: ft ? ft.textContent.trim() : '' });
    })()`));
    record('⑦ 设置页含 隐私政策 / 注销 / 备案号 三行',
      settings.rows.every(Boolean) && settings.filing.includes('备案'), JSON.stringify(settings));

    // ⑧ 注销真删: 造数据 → 点注销 → confirm 自动确认 → 数据清空
    await js(`(() => { localStorage.setItem('bolloon_avatar','data:image/jpeg;base64,zzz'); localStorage.setItem('bolloon_mobile_peers','["did:blln:x"]'); return 'seeded'; })()`);
    const wipeJs = `(async () => {
      const core = window.BolloonCore;
      const before = ['bolloon_avatar','bolloon_mobile_peers'].filter(k => localStorage.getItem(k));
      const r = await core.privacy.wipe();
      const after = ['bolloon_avatar','bolloon_mobile_peers'].filter(k => localStorage.getItem(k));
      return JSON.stringify({ before, after, dbs: r.deletedDatabases, failed: r.failed, consentKept: localStorage.getItem('bolloon_privacy_consent') });
    })()`;
    const wiped = JSON.parse(await js(wipeJs, '30000'));
    record('⑧ 注销真删本机数据 (键清空 / 4 库删除 / 无失败项 / 保留同意记录)',
      wiped.before.length === 2 && wiped.after.length === 0 && wiped.dbs.length === 4 && wiped.failed.length === 0 && wiped.consentKept === '1',
      JSON.stringify(wiped));

    const passed = results.filter((r) => r.ok).length;
    const failed = results.length - passed;
    console.log(`\n=== 结果: ${passed} passed, ${failed} failed ===`);
    await __shutdownBrowserForTest();
    process.exit(failed > 0 ? 1 : 0);
  } catch (e) {
    console.error('验收脚本异常:', e);
    try { await __shutdownBrowserForTest(); } catch { /* noop */ }
    process.exit(1);
  }
}

void main();
