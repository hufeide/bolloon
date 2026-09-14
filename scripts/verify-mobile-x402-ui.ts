/**
 * verify-mobile-x402-ui.ts — 手机端「微信息 (x402 付费信息)」点按式交互 真浏览器验证
 *
 * 用仓库自己的 browser 模块 (headless Chrome CDP) 打开 dist/web/mobile.html, 在真 DOM 上:
 *   浏览付费信息列表 → 点一条看详情 (价格/类别/哈希/来源) → 「只看元数据」→ 「购买并验真」
 * 同时验证诚实性分支: 桌面不可达时必须显示"需要电脑端在线", 空列表时必须显示"还没发布"。
 *
 * 本地真服务:
 *   · express + registerX402InfoRoutes(app)  ← 扮演"电脑端" (代付/验真都在这里)
 *   · node http + fs 静态服务 dist/web      ← 扮演"手机里装的那个页面"
 * 两个端口都随机取 (避开 8899), 关掉即清理。
 *
 * 前置: npm run build:web
 * 用法: npx tsx scripts/verify-mobile-x402-ui.ts
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as http from 'node:http';
import express from 'express';
import { BrowserCdpSession, __shutdownBrowserForTest } from '../src/agents/browser-cdp.js';
import { registerX402InfoRoutes } from '../src/web/routes-x402-info.js';
import { removeInfo } from '../src/agents/x402/paid-info-store.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const WEB_DIR = path.join(ROOT, 'dist', 'web');
const TITLE = 'VERIFY_X402_MOBILE 气象实测数据包';
const PAY_TO = '0x000000000000000000000000000000000000dEaD';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const results: Array<{ name: string; ok: boolean; note: string }> = [];
function record(name: string, ok: boolean, note = '') {
  results.push({ name, ok, note });
  console.log(`${ok ? '✅' : '❌'} ${name}${note ? ` — ${note}` : ''}`);
}

/** 静态服务 (扮演手机页面): dist/web + no-store (免得 SW 缓存骗过验证) */
async function startStatic(root: string): Promise<{ url: string; server: http.Server }> {
  const server = http.createServer(async (req, res) => {
    try {
      let p = decodeURIComponent((req.url || '/').split('?')[0]);
      if (p === '/' || p === '') p = '/mobile.html';
      const file = path.join(root, p);
      if (!file.startsWith(root)) { res.writeHead(403).end('forbidden'); return; }
      const data = await fs.readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;
  return { url: `http://127.0.0.1:${port}`, server };
}

/** 电脑端 (扮演): 真 express + registerX402InfoRoutes, CORS 与桌面 web server 同款 */
async function startDesktopApi(): Promise<{ url: string; server: http.Server }> {
  const app: any = express();
  app.use(express.json({ limit: '4mb' }));
  app.use((req: any, res: any, next: any) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    next();
  });
  registerX402InfoRoutes(app);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;
  return { url: `http://127.0.0.1:${port}`, server };
}

/** 长内容 (验证"内容前 2000 字"截断) */
function testContent(): string {
  const head = 'VERIFY_X402_MOBILE-CONTENT 本机联调测试内容 (非真实气象数据)。';
  const body = '观测点 #000 温度 21.3C 湿度 48% 气压 1012hPa。'.repeat(90);
  return head + body;
}

async function main() {
  // 电脑端"无钱包私钥时的本机联调付款"是**服务端 env 门控**的 (sell 路由只认
  // BOLLOON_X402_LOCAL_VERIFY=1 或 facilitator)。测试进程内起 express → 这里设上,
  // 才能真跑通"代付 → 信封 → 验真"全链路 (真机上由 facilitator 走链上结算)。
  process.env.BOLLOON_X402_LOCAL_VERIFY = '1';

  const staticSrv = await startStatic(WEB_DIR);
  const apiSrv = await startDesktopApi();
  const apiBase = apiSrv.url;
  console.log(`[verify] 静态端点 (手机页面): ${staticSrv.url}`);
  console.log(`[verify] 电脑端 (x402 接口): ${apiBase}`);

  let publishedId = '';
  let session: BrowserCdpSession | null = null;

  const js = async (code: string, timeoutMs = '30000') => session!.execute({ action: 'js', code, timeoutMs });
  const wait = async (ms: number) => { await js(`(async () => { await new Promise(r=>setTimeout(r,${ms})); return 'ok'; })()`); };

  try {
    // ── ① 电脑端发布一条测试信息 (真 HTTP, 与桌面同一条路由) ──────────────
    const publishBody = {
      title: TITLE,
      category: 'data',
      content: testContent(),
      description: '由 verify-mobile-x402-ui.ts 发布的测试条目 (价格 0.002 USDC)',
      price: { amount: '0.002', currency: 'USDC', network: 'base-sepolia', payTo: PAY_TO },
      source: { kind: 'measured', refs: ['https://example.com/x402-verify-ref-1', 'cid:verifyref2'], note: '自测口径, 非第三方核验' },
      providerName: 'VERIFY_X402_MOBILE 提供方',
    };
    let pubNote = '';
    try {
      const r = await fetch(`${apiBase}/api/x402/info`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(publishBody),
      });
      const j: any = await r.json().catch(() => null);
      if (r.ok && j?.ok && j.item?.id) { publishedId = j.item.id; pubNote = `id=${publishedId}, did=${String(j.item.provider?.did).slice(0, 24)}…`; }
      else pubNote = `HTTP ${r.status}: ${JSON.stringify(j).slice(0, 160)}`;
    } catch (e: any) { pubNote = String(e?.message || e).slice(0, 160); }
    record('① 电脑端发布测试信息 (POST /api/x402/info)', !!publishedId, pubNote);
    if (!publishedId) throw new Error('发布失败 → 后面无从验证, 终止');

    // 免费列表能读到 (手机端渲染就靠它)
    const listRes = await (await fetch(`${apiBase}/api/x402/info`)).json() as any;
    const listed = (listRes.items || []).find((i: any) => i.id === publishedId);
    record('② GET /api/x402/info 免费元数据可见', !!listed && listed.price?.amount === '0.002',
      listed ? `title=${listed.title}, price=${listed.price.amount} ${listed.price.currency}, hash=${String(listed.contentHash).slice(0, 18)}…` : '未列出');

    // ── ③ 开真浏览器, 等内核就绪 ────────────────────────────────────────
    session = new BrowserCdpSession({ headless: true });
    const open = await session.execute({ action: 'open', url: `${staticSrv.url}/mobile.html`, timeoutMs: '30000' });
    if (!open.success) throw new Error(`打不开页面: ${open.error}`);
    const ready = await js(`(async () => { for (let i=0;i<80;i++){ if (window.BolloonCore && document.querySelector('#x402-info-list')) return 'ready'; await new Promise(r=>setTimeout(r,250)); } return 'timeout'; })()`, '40000');
    record('③ mobile.html 加载 + BolloonCore 就绪 + 微信息区域存在', String(ready.output).includes('ready'), String(ready.output).slice(0, 60));
    if (!String(ready.output).includes('ready')) throw new Error('内核未就绪');

    // ── ④ 设桌面基址 (与 mobile-sync setDesktopUrl 同一个 key) + 拦截 alert ─
    const cfg = await js(`(() => {
      localStorage.setItem('bolloon_desktop_base_url', ${JSON.stringify(apiBase)});
      window.__x402Alerts = [];
      window.alert = (m) => { window.__x402Alerts.push(String(m)); };
      return JSON.stringify({ base: localStorage.getItem('bolloon_desktop_base_url') });
    })()`);
    record('④ 设置桌面地址 (localStorage bolloon_desktop_base_url)', String(cfg.output).includes(apiBase), String(cfg.output).slice(0, 80));

    // ── ⑤ 切到网络 tab → 微信息列表渲染 (标题 + 价格) ────────────────────
    await js(`(() => { document.querySelector('.tab[data-tab="network"]').click(); return 'ok'; })()`);
    const listState = await js(`(async () => {
      for (let i=0;i<40;i++){
        const rows = [...document.querySelectorAll('#x402-info-list .list-item')];
        if (rows.some(r => r.innerText.includes('VERIFY_X402_MOBILE'))) return JSON.stringify({ rows: rows.length, text: rows.map(r=>r.innerText).join(' || ') });
        await new Promise(r=>setTimeout(r,250));
      }
      const rows = [...document.querySelectorAll('#x402-info-list .list-item')];
      return JSON.stringify({ rows: rows.length, text: rows.map(r=>r.innerText).join(' || ') });
    })()`, '20000');
    const listJson = JSON.parse(String(listState.output || '{}'));
    record('⑤ 网络 tab 渲染微信息列表 (标题 + 价格 + 类别)',
      String(listJson.text || '').includes('VERIFY_X402_MOBILE') && String(listJson.text || '').includes('0.002 USDC') && String(listJson.text || '').includes('data'),
      String(listJson.text || '').slice(0, 160));
    await wait(400);   // 等列表渲染稳一点再截图
    const shotList = await session.execute({ action: 'screenshot' });
    record('⑥ 截图: 微信息列表', !!shotList.screenshotPath, String(shotList.screenshotPath || ''));

    // ── ⑦ 点一条 → 详情 sheet (价格/类别/哈希/来源/提供方 + 付款按钮) ──────
    const clickRow = await js(`(() => {
      const row = [...document.querySelectorAll('#x402-info-list .list-item')].find(r => r.innerText.includes('VERIFY_X402_MOBILE'));
      if (!row) return 'not-found';
      row.click();
      return 'clicked';
    })()`);
    const detail = await js(`(() => {
      const s = document.querySelector('#x402-sheet');
      const buy = document.querySelector('#x402-buy');
      return JSON.stringify({
        clicked: ${JSON.stringify(String(clickRow.output))},
        visible: !!s && !s.hidden,
        title: (document.querySelector('#x402-title')||{}).textContent || '',
        body: (document.querySelector('#x402-body')||{}).textContent || '',
        hasBuy: !!buy, buyDisabled: !!(buy && buy.disabled),
        hasVerify: !!document.querySelector('#x402-verify'),
        hasClose: !!document.querySelector('#x402-close'),
      });
    })()`);
    const d = JSON.parse(String(detail.output || '{}'));
    const bodyTxt = String(d.body || '');
    record('⑦ 点一条 → 详情 sheet 可见', d.visible === true, `title=${d.title}`);
    record('⑧ 详情含 价格/网络 · 类别 · 哈希 · 来源 · 提供方',
      bodyTxt.includes('价格: 0.002 USDC') && bodyTxt.includes('base-sepolia') && bodyTxt.includes('类别: data')
        && bodyTxt.includes('内容哈希: sha256:') && bodyTxt.includes('来源声明: measured') && bodyTxt.includes('提供方:')
        && bodyTxt.includes('https://example.com/x402-verify-ref-1'),
      bodyTxt.split('\n').slice(0, 5).join(' / ').slice(0, 180));
    record('⑨ 详情有付款按钮 (且可点) + 关闭按钮', d.hasBuy && d.hasVerify && d.hasClose && d.buyDisabled === false, JSON.stringify({ buy: d.hasBuy, disabled: d.buyDisabled }));

    // 布局: sheet 必须完整落在视口内 (按钮不能被顶出屏幕) — 手机上是"点按式"界面, 按钮必须看得见
    await wait(700);   // 等滑入动画结束再量 (动画中量会误判)
    const layout = await js(`(() => {
      const inner = document.querySelector('#x402-sheet .sheet-inner');
      const r = inner.getBoundingClientRect();
      const btns = ['#x402-buy', '#x402-verify', '#x402-close'].map((s) => {
        const b = document.querySelector(s).getBoundingClientRect();
        return { s, top: Math.round(b.top), bottom: Math.round(b.bottom) };
      });
      return JSON.stringify({ vh: window.innerHeight, top: Math.round(r.top), bottom: Math.round(r.bottom), btns });
    })()`);
    const ly = JSON.parse(String(layout.output || '{}'));
    record('⑨b 详情 sheet 与三个按钮都在视口内 (可见可点)',
      ly.top >= 0 && ly.bottom <= (ly.vh || 0) + 1 && (ly.btns || []).every((x: any) => x.top >= 0 && x.bottom <= (ly.vh || 0) + 1),
      `viewport=${ly.vh} sheet=[${ly.top},${ly.bottom}] btns=${JSON.stringify(ly.btns)}`);
    const shotDetail = await session.execute({ action: 'screenshot' });
    record('⑩ 截图: 详情 sheet', !!shotDetail.screenshotPath, String(shotDetail.screenshotPath || ''));

    // ── ⑪ 「只看元数据」: 没付款 → 如实显示 402 付款要求, 不谎称验真通过 ────
    await js(`(() => { document.querySelector('#x402-verify').click(); return 'ok'; })()`);
    const verifyState = await js(`(async () => {
      for (let i=0;i<60;i++){
        const s = document.querySelector('#x402-result-sheet');
        if (s && !s.hidden) break;
        await new Promise(r=>setTimeout(r,250));
      }
      const s = document.querySelector('#x402-result-sheet');
      return JSON.stringify({
        visible: !!s && !s.hidden,
        title: (document.querySelector('#x402-result-title')||{}).textContent || '',
        body: ((document.querySelector('#x402-result-body')||{}).textContent || ''),
      });
    })()`, '30000');
    const v = JSON.parse(String(verifyState.output || '{}'));
    const vBody = String(v.body || '');
    record('⑪ 「只看元数据」→ 结果 sheet 弹出', v.visible === true, `title=${v.title}`);
    record('⑫ 未付款时如实给 402 付款要求 (不谎称验真通过)',
      vBody.includes('402') && (vBody.includes('付款要求') || vBody.includes('还拿不到')) && vBody.includes('内容哈希: sha256:'),
      vBody.split('\n').slice(0, 3).join(' / ').slice(0, 200));
    await wait(600);
    const shotVerify = await session.execute({ action: 'screenshot' });
    record('⑬ 截图: 只看元数据结果', !!shotVerify.screenshotPath, String(shotVerify.screenshotPath || ''));

    // ── ⑭ 「购买并验真」: 经电脑端代付 → 内容 + 验真分档 ──────────────────
    await js(`(() => { document.querySelector('#x402-result-close').click(); document.querySelector('#x402-buy').click(); return 'ok'; })()`);
    const buyState = await js(`(async () => {
      for (let i=0;i<120;i++){
        const s = document.querySelector('#x402-result-sheet');
        const t = (document.querySelector('#x402-result-title')||{}).textContent || '';
        if ((s && !s.hidden && t === '已购买并验真') || (window.__x402Alerts||[]).length) break;
        await new Promise(r=>setTimeout(r,250));
      }
      const s = document.querySelector('#x402-result-sheet');
      return JSON.stringify({
        visible: !!s && !s.hidden,
        title: (document.querySelector('#x402-result-title')||{}).textContent || '',
        body: ((document.querySelector('#x402-result-body')||{}).textContent || '').slice(0, 900),
        alerts: window.__x402Alerts || [],
        buyLabel: (document.querySelector('#x402-buy')||{}).textContent || '',
        buyDisabled: !!(document.querySelector('#x402-buy')||{}).disabled,
      });
    })()`, '60000');
    const b = JSON.parse(String(buyState.output || '{}'));
    const bBody = String(b.body || '');
    const bought = b.title === '已购买并验真' && /(verified|self-attested|content-only|unverified)/.test(bBody);
    const honestFail = Array.isArray(b.alerts) && b.alerts.length > 0 && String(b.alerts[0]).includes('购买失败');
    record('⑭ 「购买并验真」真跑 → 拿到内容 + 验真分档 (或如实报后端错)',
      bought || honestFail,
      bought
        ? `验真结论: ${String(bBody).split('\n')[0].slice(0, 120)} | 内容含测试标记=${bBody.includes('VERIFY_X402_MOBILE-CONTENT')}`
        : `如实失败: ${String((b.alerts || [])[0] || '').slice(0, 160)}`);
    record('⑮ 按钮状态已复位 (不是卡在"付款中...")', b.buyDisabled === false && String(b.buyLabel).includes('购买并验真'), `label=${b.buyLabel}, disabled=${b.buyDisabled}`);
    await wait(600);
    const shotBuy = await session.execute({ action: 'screenshot' });
    record('⑯ 截图: 购买并验真结果', !!shotBuy.screenshotPath, String(shotBuy.screenshotPath || ''));

    // ── ⑰ 诚实性分支: 没配桌面地址 → 大白话"需要电脑端在线" ───────────────
    await js(`(() => {
      document.querySelector('#x402-result-close').click();
      document.querySelector('#x402-close').click();
      localStorage.removeItem('bolloon_desktop_base_url');
      document.querySelector('.tab[data-tab="main"]').click();
      document.querySelector('.tab[data-tab="network"]').click();
      return 'ok';
    })()`);
    const noBase = await js(`(async () => {
      for (let i=0;i<40;i++){
        const t = (document.querySelector('#x402-info-list')||{}).innerText || '';
        if (t.includes('需要电脑端在线')) return JSON.stringify({ text: t });
        await new Promise(r=>setTimeout(r,250));
      }
      return JSON.stringify({ text: (document.querySelector('#x402-info-list')||{}).innerText || '' });
    })()`, '20000');
    const nb = JSON.parse(String(noBase.output || '{}'));
    record('⑰ 没配桌面地址 → "需要电脑端在线" (不假装有数据)',
      String(nb.text || '').includes('需要电脑端在线') && !String(nb.text || '').includes('VERIFY_X402_MOBILE'),
      String(nb.text || '').slice(0, 120));

    // ── ⑱ 诚实性分支: 电脑端在线但空列表 → "还没发布任何付费信息" ─────────
    await removeInfo(publishedId);
    const emptyState = await js(`(async () => {
      localStorage.setItem('bolloon_desktop_base_url', ${JSON.stringify(apiBase)});
      document.querySelector('.tab[data-tab="main"]').click();
      document.querySelector('.tab[data-tab="network"]').click();
      for (let i=0;i<40;i++){
        const t = (document.querySelector('#x402-info-list')||{}).innerText || '';
        if (t.includes('还没发布')) return JSON.stringify({ text: t });
        await new Promise(r=>setTimeout(r,250));
      }
      return JSON.stringify({ text: (document.querySelector('#x402-info-list')||{}).innerText || '' });
    })()`, '20000');
    const es = JSON.parse(String(emptyState.output || '{}'));
    record('⑱ 电脑端在线但没发布 → "电脑端还没发布任何付费信息"',
      String(es.text || '').includes('还没发布') && !String(es.text || '').includes('VERIFY_X402_MOBILE'),
      String(es.text || '').slice(0, 120));
    publishedId = '';   // 已删, finally 不再重复删

    await session.execute({ action: 'close' });
  } catch (e: any) {
    record('异常', false, String(e?.message || e).slice(0, 200));
  } finally {
    // 清掉测试条目 (不污染 ~/.bolloon/x402-info)
    if (publishedId) await removeInfo(publishedId).catch(() => {});
    try { await __shutdownBrowserForTest(); } catch { /* 忽略 */ }
    await new Promise<void>((r) => staticSrv.server.close(() => r()));
    await new Promise<void>((r) => apiSrv.server.close(() => r()));
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n──────────────────────────────');
  console.log(`结果: ${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) console.log('未过: ' + failed.map((f) => f.name).join(' | '));
  process.exit(failed.length ? 1 : 0);
}

void main();
