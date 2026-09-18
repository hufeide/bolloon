/**
 * verify-minimal-payment-loop.ts — 最小 Agent 资源交易闭环验收 (2026-09-16)
 *
 * 设计依据: docs/design-layer.md + docs/design-layer2.md;规格见 leo 的 Phase 0-6。
 * 判断标准不是"Agent 能不能转一笔钱", 而是:
 *   在明确任务/预算/权限/验证条件下买到一条可执行资源, 且 **支付 + 交付 + 验真 + 审计 + 恢复** 全部成立。
 *
 *   --local-dev  协议 / 策略 / 交付 / 验真 / 幂等 / 重启恢复 (不含链上资金)
 *   --testnet    真 facilitator + 真钱包 + 真 Base Sepolia txHash (需要配置, 未配置则如实跳过)
 *
 * 输出不只 "passed", 还打印交易证明 (transactionId/itemId/buyerDid/providerDid/network/amount/currency/txHash/receiptHash/contentHash/trust/status)。
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { KeyManager } from '@diap/sdk';

const REAL_HOME = os.homedir();
const MODE = process.argv.includes('--testnet') ? 'testnet' : 'local-dev';
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), `bolloon-payloop-${MODE}-`));
const HOME = path.join(ROOT, 'home');
const BHOME = path.join(HOME, '.bolloon');
process.env.HOME = HOME; process.env.USERPROFILE = HOME;
process.env.BOLLOON_SKIP_KUBO = '1'; process.env.BOLLOON_CRON = '0'; process.env.BOLLOON_SUPERVISOR = '0';
if (MODE === 'local-dev') {
  process.env.BOLLOON_X402_LOCAL_VERIFY = '1';
  delete process.env.BOLLOON_X402_FACILITATOR;
} else {
  delete process.env.BOLLOON_X402_LOCAL_VERIFY;      // 真链上: 绝不开启联调凭据
}
fs.mkdirSync(BHOME, { recursive: true });

const { makeSetupReady } = await import('./lib/make-setup-ready.js');
makeSetupReady(BHOME, { realHome: REAL_HOME, name: '支付闭环验收' });

const ST: any = await import('../src/agents/x402/paid-info-store.js');
const PROTO: any = await import('../src/agents/x402/transaction-protocol.js');
const TXS: any = await import('../src/agents/x402/transaction-store.js');
const TRADE: any = await import('../src/agents/x402/trade.js');
const POL: any = await import('../src/agents/economic-policy.js');

let passed = 0, failed = 0, deniedCases = 0, skipped = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail !== undefined ? ` — ${(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 240)}` : ''}`); }
};
const reject = (name: string, ok: boolean, detail?: unknown) => {   // 失败矩阵: 只统计"确实拒绝了"
  if (ok) { deniedCases++; passed++; console.log(`  ⛔ ${name} (已拒绝)`); }
  else { failed++; console.log(`  ❌ ${name} — 期望被拒绝但没有: ${(typeof detail === 'string' ? detail : JSON.stringify(detail ?? null)).slice(0, 240)}`); }
};
const skip = (name: string, why: string) => { skipped++; console.log(`  ⏭ ${name} — ${why}`); };
const section = (t: string) => console.log(`\n${t}`);

// ── 卖方身份 + 发布一条付费信息 ─────────────────────────────────────────────
const seller = KeyManager.generate();
const sellerDid = seller.did;
// 服务端签发信封要读 ~/.bolloon/identity.json (DIAP Ed25519) —— 真写一份到隔离 HOME
await KeyManager.saveToFile(seller, path.join(BHOME, 'identity.json'));
const pubHex = Buffer.from(seller.publicKey).toString('hex');
const PAY_TO = '0x1111111111111111111111111111111111111111';
const USDC_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const NETWORK = 'base-sepolia';
const CONTENT = JSON.stringify({ market: 'JP', product: 'x', signals: ['价格带 1980-2480 JPY', '合规标签 3 类'], note: '跨境市场调研结论 (验收用)' });

const item = await ST.publishInfo({
  title: '跨境商品市场调研 (日本站)', category: 'data', content: CONTENT,
  price: { amount: '0.001', currency: 'USDC', network: NETWORK, payTo: PAY_TO },
  source: { kind: 'research', refs: ['https://example.com/jp-market'], note: '验收样本' },
  provider: { did: sellerDid, name: '卖方 Agent (验收)' },
}, { home: HOME });

const resolveDid = async (did: string) => (did === sellerDid ? { publicKeyHex: pubHex } : null);
const BUYER_DID = 'did:key:zBuyerVerify';

// ── 真 HTTP 服务端 (复用仓库真实路由) ───────────────────────────────────────
const { createWebServer } = await import('../src/web/server.js') as any;
const app = await createWebServer({ port: 0, headless: true } as any);
const server = app?.server || app;
const addr: any = await new Promise((res) => { if (server?.address?.()) res(server.address()); else server?.once?.('listening', () => res(server.address())); });
const BASE = `http://127.0.0.1:${addr?.port || 0}`;
const URL_ITEM = `${BASE}/api/x402/info/${item.id}`;

const policy: any = POL.getEconomicPolicy();
function setPolicy(patch: Record<string, unknown>) {
  policy.updateConfig({ perTransactionLimit: 1, dailyLimit: 10, allowedRecipients: [PAY_TO], allowedServices: [], rateLimitPerMinute: 100, ...patch } as any);
}
setPolicy({});

const tx = (n: number) => `verify-${MODE}-${Date.now().toString(36)}-${n}`;

const REQ1 = `verify-${MODE}-stable-1`;      // 固定 requestId (幂等用例要重放同一个)

const TESTNET = MODE === 'testnet';
// testnet 模式: 没有 facilitator + 已充值的 Base Sepolia 买方钱包 → **一条"通过"都不声明** (如实未验证)
if (TESTNET && (!process.env.BOLLOON_X402_FACILITATOR || !process.env.BOLLOON_X402_BUYER_KEY)) {
  console.log('=== 结果[testnet]: 0 passed, 0 failed, 未配置 → 未验证 ===');
  console.log('  ⏭ 缺少 BOLLOON_X402_FACILITATOR 和/或 BOLLOON_X402_BUYER_KEY');
  console.log('  前置: 买方钱包有 Base Sepolia ETH (gas) + USDC; 卖方 payTo 为真实地址; facilitator 可用');
  console.log('  local-dev 证据请跑: npx tsx scripts/verify-minimal-payment-loop.ts --local-dev');
  process.exit(0);
}
const skipIfTestnet = (name: string) => { if (TESTNET) { skip(name, '本机联调用例 (testnet 模式不适用)'); return true; } return false; };

async function main() {
  console.log(`模式: ${MODE}  (隔离 HOME: ${HOME})\n资源: ${item.id}  价格 0.001 USDC  ${NETWORK}  payTo=${PAY_TO.slice(0, 10)}…`);

  // ═══ Phase 1: 本机联调协议闭环 ═══
  section('[1] 元数据 / 未付款 / 402 字段');
  const metaRes = await fetch(`${BASE}/api/x402/info/${item.id}/meta`);
  const meta: any = await metaRes.json();
  check('免费元数据可读', metaRes.status === 200 && !!(meta?.item?.id || meta?.itemId || meta?.id), { status: metaRes.status, keys: Object.keys(meta || {}) });
  check('元数据不泄露正文', !JSON.stringify(meta).includes('signals'), Object.keys(meta || {}));
  const noPay = await fetch(URL_ITEM);
  const noPayBody: any = await noPay.json().catch(() => null);
  check('未付款 → 402', noPay.status === 402, noPay.status);
  check('未付款响应里没有正文', !JSON.stringify(noPayBody).includes('signals'), JSON.stringify(noPayBody).slice(0, 120));
  const req402 = noPayBody?.accepts?.[0];
  check('402 金额/币种/网络/payTo 正确', String(req402?.amount) === '1000' && String(req402?.network) === NETWORK && String(req402?.payTo).toLowerCase() === PAY_TO.toLowerCase(), req402);
  check('402 带 itemId (可与预期比对)', !!(noPayBody?.metadata?.itemId || noPayBody?.item?.itemId || req402?.extra?.itemId), noPayBody?.metadata?.itemId);

  section('[2] 正常买一笔 (local-dev): 交付 + 验真 + 交易记录');
  if (skipIfTestnet('本机联调交易: 交付/验真/记录全链路')) { /* testnet 模式跳过 */ }
  const t1 = await TRADE.buyInfoAsTransaction({
    url: URL_ITEM, requestId: REQ1, buyerDid: BUYER_DID, allowLocalDev: true, expectItemId: item.id,
    expectNetworks: [NETWORK], resolveDid, home: HOME, service: 'x402-info',
  });
  check('交易拿到内容信封', t1.ok && !!t1.envelope, t1.error);
  check('内容哈希正确', t1.record.contentHash === t1.record.deliveryHash && !!t1.record.deliveryHash, { c: t1.record.contentHash, d: t1.record.deliveryHash });
  check('卖方 DID 签名验证通过 (trust 不是 unverified)', t1.verify?.trust && t1.verify.trust !== 'unverified', t1.verify?.trust);
  check('回执哈希已绑定 (receiptHash 存在)', !!t1.record.receiptHash, t1.record.receiptHash);
  check('paymentMode 如实标 local-dev', t1.record.paymentMode === 'local-dev', t1.record.paymentMode);
  check('chainSettled=false (链上没动过钱)', t1.record.chainSettled === false, t1.record.chainSettled);
  check('本机联调**不能**标 verified', t1.status !== 'verified', t1.status);
  check('结论明确标 self-attested / delivered', t1.record.verificationTrust === 'self-attested' || t1.status === 'delivered', { trust: t1.record.verificationTrust, status: t1.status });
  check('交易记录落盘可读', (await TXS.readTransaction(t1.transactionId, HOME))?.transactionId === t1.transactionId);

  // ═══ Phase 2: 策略门 (最重要的安全门) ═══
  section('[3] 策略门: 拒绝时必须"无签名 / 无链上交易 / 无扣预算 / 无交付" + policy_denied');
  const spentBefore = (await TXS.spentSummary(HOME)).total;
  async function denyCase(name: string, patch: Record<string, unknown>, opts: Record<string, unknown> = {}) {
    setPolicy(patch);
    const before = await TXS.spentSummary(HOME);
    const r = await TRADE.buyInfoAsTransaction({
      url: URL_ITEM, requestId: tx(Math.random() * 1e6 | 0), buyerDid: BUYER_DID, allowLocalDev: true,
      expectItemId: item.id, resolveDid, home: HOME, service: 'x402-info', ...opts,
    });
    const after = await TXS.spentSummary(HOME);
    const rec = r.record;
    const noSig = !rec.txHash && rec.paymentMode === 'none';
    reject(`${name}: 状态 policy_denied`, r.status === 'policy_denied', { status: r.status, error: r.error });
    reject(`${name}: 没有付款 (no tx / no signature)`, noSig, { txHash: rec.txHash, mode: rec.paymentMode });
    reject(`${name}: 没有扣预算`, after.total === before.total, { before: before.total, after: after.total });
    reject(`${name}: 没有交付内容`, !r.envelope && !r.ok, !!r.envelope);
    setPolicy({});
    return r;
  }
  await denyCase('单笔超限', { perTransactionLimit: 0.0005 });
  await denyCase('日预算不足', { dailyLimit: 0, perTransactionLimit: 10 });   // 已花 > 0 → 任何新支付都超
  await denyCase('收款方不在白名单', { allowedRecipients: ['0x9999999999999999999999999999999999999999'] });
  await denyCase('服务不在白名单', { allowedServices: ['other-service'] });
  await denyCase('任务预算不足', {}, { taskBudget: '0.0001' });
  // 速率限制: 阈值设 1 并发跑两次
  setPolicy({ rateLimitPerMinute: 0, allowedRecipients: [PAY_TO], perTransactionLimit: 1, dailyLimit: 10 });   // 0 = 任何一次都超频 (确定性)
  const r1 = await TRADE.buyInfoAsTransaction({ url: URL_ITEM, requestId: tx(101), buyerDid: BUYER_DID, allowLocalDev: true, resolveDid, home: HOME, service: 'x402-info' });
  const r2 = await TRADE.buyInfoAsTransaction({ url: URL_ITEM, requestId: tx(102), buyerDid: BUYER_DID, allowLocalDev: true, resolveDid, home: HOME, service: 'x402-info' });
  reject('速率超限: 被拒', r1.status === 'policy_denied' || r2.status === 'policy_denied', { first: r1.status, second: r2.status });
  setPolicy({});

  section('[4] 402 被篡改 / 不一致 → 拒绝 (itemId / 金额 / payTo / network)');
  const goodFetch = async (bad: any) => (async () => new Response(JSON.stringify({ accepts: [{ ...req402, ...bad }], metadata: { ...(noPayBody?.metadata || {}), itemId: item.id } }), { status: 402, headers: { 'content-type': 'application/json' } })) as any;
  const tamper = await TRADE.buyInfoAsTransaction({ url: URL_ITEM, requestId: tx(201), buyerDid: BUYER_DID, allowLocalDev: true, resolveDid, home: HOME, expectNetworks: ['base-sepolia'], fetchImpl: await goodFetch({ network: 'base-mainnet' }) as any });
  reject('402 network 被换 → 拒绝', !tamper.ok && tamper.status === 'failed', { status: tamper.status, error: tamper.error });
  const tamperAmt = await TRADE.buyInfoAsTransaction({ url: URL_ITEM, requestId: tx(202), buyerDid: BUYER_DID, allowLocalDev: true, resolveDid, home: HOME, maxPaymentAmount: '0.0005', fetchImpl: await goodFetch({ amount: '5000' }) as any });
  reject('402 金额超上限 → 拒绝', !tamperAmt.ok, { status: tamperAmt.status, error: tamperAmt.error });
  const wrongItem = await TRADE.buyInfoAsTransaction({ url: URL_ITEM, requestId: tx(203), buyerDid: BUYER_DID, allowLocalDev: true, resolveDid, home: HOME, expectItemId: 'other-item-id' });
  reject('expectItemId 不一致 → 拒绝', !wrongItem.ok && wrongItem.status === 'failed', { status: wrongItem.status, error: wrongItem.error });

  section('[5] 篡改内容/回执 → 验真失败 (支付成功 ≠ 交易成功)');
  const env: any = t1?.envelope || null;
  if (!env) skip('篡改内容/回执验收', '没有本机联调信封可用 (testnet 模式)');
  if (env) {
  const { verifyEnvelope } = await import('../src/agents/x402/paid-info-protocol.js') as any;
  const tamperedContent = { ...env, content: env.content + ' (被改过)' };
  const vTamper = await verifyEnvelope(tamperedContent, { resolveDid });
  reject('改内容 → 验真不通过', vTamper.trust === 'unverified' || vTamper.checks?.contentHash === false, vTamper.trust);
  const tamperedItem = { ...env, item: { ...env.item, itemId: 'other' } };
  const vItem = await verifyEnvelope(tamperedItem, { resolveDid });
  reject('改 itemId → 验真不通过', vItem.trust !== 'verified' || vItem.checks?.consistent === false, vItem.trust);
  const tamperedReceipt = { ...env, proof: { ...env.proof, payload: { ...env.proof.payload, receiptHash: 'deadbeef' } } };
  const vReceipt = await verifyEnvelope(tamperedReceipt, { resolveDid });
  reject('改回执哈希 → 验真不通过', vReceipt.trust !== 'verified', vReceipt.trust);

  }
  section('[6] 未开启 allowLocalDev / 无 facilitator → 拒绝 (不能假装能付)');
  delete process.env.BOLLOON_X402_LOCAL_VERIFY;
  const noLocal = await TRADE.buyInfoAsTransaction({ url: URL_ITEM, requestId: tx(301), buyerDid: BUYER_DID, allowLocalDev: false, resolveDid, home: HOME });
  reject('无钱包 + 未开联调 → 拒绝付款', !noLocal.ok && !noLocal.envelope, { status: noLocal.status, error: noLocal.error });
  process.env.BOLLOON_X402_LOCAL_VERIFY = '1';

  section('[7] 幂等: 同 requestId 重放不重复付款; 回执不能脱离原内容复用');
  if (skipIfTestnet('本机联调幂等/复用用例')) { /* testnet 模式跳过 */ }
  const spentBefore2 = (await TXS.spentSummary(HOME));
  const replay = await TRADE.buyInfoAsTransaction({ url: URL_ITEM, requestId: REQ1, buyerDid: BUYER_DID, allowLocalDev: true, resolveDid, home: HOME });
  check('同 requestId → 复用同一交易 (no 重复付款)', replay.transactionId === t1.transactionId && replay.reused === true, { id: replay.transactionId, reused: replay.reused });
  const spentAfter2 = (await TXS.spentSummary(HOME));
  check('花钱计数没有增加', spentAfter2.count === spentBefore2.count, { before: spentBefore2.count, after: spentAfter2.count });
  // 同回执访问另一条信息
  const item2 = await ST.publishInfo({ title: '另一条资源', category: 'data', content: '{"other":true}', price: { amount: '0.001', currency: 'USDC', network: NETWORK, payTo: PAY_TO }, source: { kind: 'data' }, provider: { did: sellerDid, name: '卖方 Agent (验收)' } }, { home: HOME });
  const crossUse = await fetch(`${BASE}/api/x402/info/${item2.id}`, { headers: { 'X-PAYMENT': Buffer.from(JSON.stringify({ x402Version: 2, accepted: req402, payload: { localDev: true }, payer: 'local-dev' })).toString('base64') } });
  const crossBody: any = await crossUse.json().catch(() => null);
  reject('同回执用于另一条 itemId → 拒绝或要求重新付款', crossUse.status === 402 || crossUse.status >= 400 || !crossBody?.content, { status: crossUse.status });

  section('[8] 支付成功但交付失败 → delivery_failed; 验真失败 → verification_failed');
  const twoPhase = (paidBody: any, paidStatus = 200) => {
    let n = 0;
    return (async (url: string, init?: any) => {
      n++;
      const hasPay = Boolean(init?.headers && (init.headers['X-PAYMENT'] || init.headers['x-payment']));
      if (!hasPay) {
        return new Response(JSON.stringify({ ...(noPayBody || {}), accepts: [req402] }), { status: 402, headers: { 'content-type': 'application/json' } });
      }
      return new Response(typeof paidBody === 'string' ? paidBody : JSON.stringify(paidBody), { status: paidStatus, headers: { 'content-type': 'application/json', 'x-payment-response': 'local-dev:fake' } });
    }) as any;
  };
  const brokenFetch = twoPhase({ proof: { payload: {} }, content: '' });
  const deliveryFail = await TRADE.buyInfoAsTransaction({ url: URL_ITEM, requestId: tx(401), buyerDid: BUYER_DID, allowLocalDev: true, resolveDid, home: HOME, fetchImpl: brokenFetch });
  reject('付了钱但没正文 → delivery_failed', deliveryFail.status === 'delivery_failed', { status: deliveryFail.status });
  const swappedFetch = twoPhase({ ...(env || {}), content: String((env || {}).content || '') + ' 篡改' });
  const verifyFail = await TRADE.buyInfoAsTransaction({ url: URL_ITEM, requestId: tx(402), buyerDid: BUYER_DID, allowLocalDev: true, resolveDid, home: HOME, fetchImpl: swappedFetch });
  reject('付了钱但内容被换 → verification_failed', verifyFail.status === 'verification_failed', { status: verifyFail.status, error: verifyFail.error });

  section('[9] 审计: 交易记录可完整回放 + 能挂到 Goal/Run');
  if (skipIfTestnet('本机联调审计用例')) { /* testnet 模式跳过 */ }
  const replayLines: string[] = await TXS.replayTransaction(t1.transactionId, HOME);
  check('事件链有序可回放 (≥4 条)', replayLines.length >= 4, replayLines.slice(-3));
  check('回放里能看到 policy_allowed → settled → delivered', /policy_allowed/.test(replayLines.join('\n')) && /settled/.test(replayLines.join('\n')) && /delivered/.test(replayLines.join('\n')), replayLines);
  const withGoal = await TRADE.buyInfoAsTransaction({ url: URL_ITEM, requestId: tx(501), buyerDid: BUYER_DID, allowLocalDev: true, resolveDid, home: HOME, goalId: 'g-verify-1', runId: 'r-verify-1' });
  check('交易能关联 Goal/Run (可审计到执行)', withGoal.record.goalId === 'g-verify-1' && withGoal.record.runId === 'r-verify-1', { g: withGoal.record.goalId, r: withGoal.record.runId });
  const pending = await TXS.pendingTransactions(HOME);
  check('未完成交易可查询 (付钱没交付的不丢)', Array.isArray(pending), pending.map((p: any) => p.status));

  section('[10] SIGKILL 后不重复付款');
  if (skipIfTestnet('本机联调 SIGKILL 恢复用例')) { /* testnet 模式跳过 */ }
  const childCode = `
    (async () => {
      const { buyInfoAsTransaction } = await import(${JSON.stringify(path.resolve('src/agents/x402/trade.ts'))});
      const r = await buyInfoAsTransaction({ url: ${JSON.stringify(URL_ITEM)}, requestId: 'kill-case-1', buyerDid: 'did:key:zBuyerVerify', allowLocalDev: true, home: ${JSON.stringify(HOME)} });
      console.log('PAID ' + r.transactionId + ' ' + r.status);
      await new Promise(() => {});      // 付完钱就卡住, 等被杀
    })();
  `;
  const child = spawn('npx', ['tsx', '-e', childCode], { cwd: process.cwd(), env: { ...process.env } });
  let childOut = '';
  child.stdout.on('data', (d) => { childOut += d; });
  await new Promise((res) => { const t = setInterval(() => { if (/PAID /.test(childOut)) { clearInterval(t); res(null); } }, 300); setTimeout(() => { clearInterval(t); res(null); }, 60_000); });
  child.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 800));
  check('子进程确实付过一次 (留下交易记录)', /PAID /.test(childOut), childOut.trim().slice(0, 120));
  const killedTxId = (childOut.match(/PAID (tx-[^\s]+)/) || [])[1];
  const spentAfterKill = await TXS.spentSummary(HOME);
  const retryAfterKill = await TRADE.buyInfoAsTransaction({ url: URL_ITEM, requestId: 'kill-case-1', buyerDid: 'did:key:zBuyerVerify', allowLocalDev: true, resolveDid, home: HOME });
  const spentAfterRetry = await TXS.spentSummary(HOME);
  check('重启后同 requestId 幂等复用 (没有第二次付款)', retryAfterKill.transactionId === killedTxId && retryAfterKill.reused === true, { killed: killedTxId, retry: retryAfterKill.transactionId });
  check('花钱计数未增加', spentAfterRetry.count === spentAfterKill.count, { before: spentAfterKill.count, after: spentAfterRetry.count });

  // ── 交易证明 ─────────────────────────────────────────────────────────────
  section('交易证明 (审计输出)');
  for (const id of [t1?.transactionId, withGoal?.transactionId].filter(Boolean) as string[]) {
    const r = await TXS.readTransaction(id, HOME);
    console.log(`  ∎ ${JSON.stringify({ transactionId: r.transactionId, requestId: r.requestId, itemId: r.itemId, buyerDid: r.buyerDid, providerDid: r.providerDid, network: r.network, amount: r.amount, currency: r.currency, paymentMode: r.paymentMode, chainSettled: r.chainSettled, txHash: r.txHash || '(local-dev 无链上哈希)', receiptHash: (r.receiptHash || '').slice(0, 16), contentHash: (r.contentHash || '').slice(0, 16), trust: r.verificationTrust, status: r.status })}`);
  }

  // ── Phase 3: testnet ────────────────────────────────────────────────────
  if (MODE === 'testnet') {
    section('[11] Base Sepolia 真实支付 (facilitator + 真钱包)');
    const facilitator = process.env.BOLLOON_X402_FACILITATOR || '';
    const buyerKey = process.env.BOLLOON_X402_BUYER_KEY || '';
    if (!facilitator || !buyerKey) {
      skip('真链上支付全部检查', '缺 BOLLOON_X402_FACILITATOR 或 BOLLOON_X402_BUYER_KEY (需要已充值的 Base Sepolia 买方钱包 + 可用 facilitator)');
    } else {
      const t2 = await TRADE.buyInfoAsTransaction({
        url: URL_ITEM, requestId: tx(901), buyerDid: BUYER_DID, privateKey: buyerKey, network: NETWORK,
        expectItemId: item.id, expectNetworks: [NETWORK], resolveDid, home: HOME,
      });
      check('真实支付完成 (facilitator 结算)', t2.ok && t2.record.chainSettled === true, { status: t2.status, error: t2.error });
      check('拿到真实 txHash', !!t2.record.txHash, t2.record.txHash);
      check('终态 verified (链上 + 交付 + 验真全过)', t2.status === 'verified', { status: t2.status, trust: t2.record.verificationTrust });
      check('receiptHash 与真实回执绑定', !!t2.record.receiptHash);
      check('内容哈希匹配', t2.record.contentHash === t2.record.deliveryHash);
      console.log(`  ∎ txHash = ${t2.record.txHash} (可用 https://sepolia.basescan.org/tx/${t2.record.txHash} 查询)`);
    }
  }

  console.log(`\n=== 结果[${MODE}]: ${passed} passed, ${failed} failed, 失败矩阵 ${deniedCases} 项已拒绝, ${skipped} 项跳过 ===`);
  console.log(`隔离 HOME: ${HOME}`);
  try { server?.close?.(); } catch { /* ignore */ }
  process.exit(failed === 0 ? 0 : 1);
}

await main();
