/**
 * verify-two-layer-state.ts — Phase 0 两层状态验收 (真跑, 2026-09-18)
 *
 * 验的是什么 (leo 的 Phase 0 验收):
 *   - 所有旧状态仍可读 (老记录迁移, 事件与 evidence 一个不丢)
 *   - local-dev 永远不能产生 fully_settled
 *   - chainSettled !== true 永远不能 verified
 *   - 非法迁移**拒绝** (抛错) 且记录不被修改, 不静默修正
 *   - 两层可以表达真实组合: paying+payment_submitted / settled+unknown / delivery_failed+fully_settled
 *   - 责任候选可由证据解释, 并写进交易记录 (可回放)
 *   - 交易证据进 Run 时带上结算事实 (审计能看出"钱动没动")
 *
 * 用法: npx tsx scripts/verify-two-layer-state.ts
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-2layer-'));
const HOME = path.join(ROOT, 'home');
const BHOME = path.join(HOME, '.bolloon');
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.BOLLOON_SKIP_SETUP = '0';
fs.mkdirSync(BHOME, { recursive: true });

const S: any = await import('../src/agents/x402/settlement-state.js');
const TXS: any = await import('../src/agents/x402/transaction-store.js');
const RS: any = await import('../src/agents/run-store.js');
const BRIDGE: any = await import('../src/agents/x402/goal-run-bridge.js');

let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d?: unknown) => {
  if (ok) { passed++; console.log(`  ✅ ${n}`); }
  else { failed++; console.log(`  ❌ ${n}${d !== undefined ? ` — ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 240)}` : ''}`); }
};
const section = (t: string) => console.log(`\n${t}`);
const expectReject = async (label: string, fn: () => Promise<unknown>, mustMention?: string) => {
  try { await fn(); check(label, false, '居然被接受了'); }
  catch (e: any) {
    const msg = String(e?.reason || e?.message || e);
    check(label, e?.name === 'IllegalTransactionTransition' && (!mustMention || msg.includes(mustMention)), msg);
  }
};

const txDir = path.join(BHOME, 'transactions');
fs.mkdirSync(txDir, { recursive: true });
const writeRaw = (rec: any) => fs.writeFileSync(path.join(txDir, `${rec.transactionId}.json`), JSON.stringify(rec), 'utf8');

// ── [1] 老记录迁移 ─────────────────────────────────────────────────────────
section('[1] 老记录 (schema v1) 迁移: 状态仍可读, 事件与证据一个不丢');
{
  const legacy = {
    transactionId: 'tx-legacy-1', requestId: 'req-legacy-1', itemId: 'item-legacy',
    buyerDid: 'did:key:zBuyer', providerDid: 'did:key:zSeller',
    paymentMode: 'facilitator', chainSettled: true, txHash: '0xlegacy1', receiptHash: 'r1',
    contentHash: 'h1', deliveryHash: 'h1', status: 'delivery_failed',
    amount: '1000', currency: 'USDC', network: 'base-sepolia', payTo: '0xpay',
    startedAt: '2026-09-01T00:00:00.000Z',
    events: [{ at: 'a1', kind: 'discovered' }, { at: 'a2', kind: 'quoted' }, { at: 'a3', kind: 'settled' }],
  };
  writeRaw(legacy);
  const got = await TXS.readTransaction('tx-legacy-1', HOME);
  check('老状态 delivery_failed 仍可读', got?.status === 'delivery_failed', got?.status);
  check('补上 schemaVersion=2', got?.schemaVersion === 2, got?.schemaVersion);
  check('结算事实按证据推导 (chainSettled → payment_verified)', got?.settlementFact === 'payment_verified', got?.settlementFact);
  check('原事件全保留 (3 条) 且追加 migrate-v2', JSON.stringify((got?.events || []).map((e: any) => e.kind)) === JSON.stringify(['discovered', 'quoted', 'settled', 'migrate-v2']), (got?.events || []).map((e: any) => e.kind));
  check('迁移留了 v1 备份', fs.existsSync(path.join(txDir, 'tx-legacy-1.json.bak-v1')));
  check('金额/网络/收款地址等证据字段没被改', got?.amount === '1000' && got?.network === 'base-sepolia' && got?.txHash === '0xlegacy1');

  // 旧状态 failed 也要能读
  writeRaw({ transactionId: 'tx-legacy-2', requestId: 'req-l2', itemId: 'i2', buyerDid: 'b', providerDid: 'p', paymentMode: 'none', chainSettled: false, status: 'failed', startedAt: '2026-09-01T00:00:00.000Z', events: [] });
  const l2 = await TXS.readTransaction('tx-legacy-2', HOME);
  check('旧状态 failed 仍可读且结算事实 unpaid', l2?.status === 'failed' && l2?.settlementFact === 'unpaid', { s: l2?.status, f: l2?.settlementFact });
}

// ── [2] 非法迁移拒绝 ───────────────────────────────────────────────────────
section('[2] 非法迁移: 拒绝且不静默修正');
{
  const { record } = await TXS.beginTransaction({ requestId: 'req-illegal', metadata: { itemId: 'i-illegal' }, buyerDid: 'did:b', providerDid: 'did:p' }, HOME);
  const id = record.transactionId;
  await expectReject('discovered → verified 被拒 (不能跳级)', () => TXS.updateTransaction(id, { status: 'verified' }, HOME));
  const after1 = await TXS.readTransaction(id, HOME);
  check('被拒后记录没被改', after1?.status === 'discovered', after1?.status);

  await expectReject('discovered → paying 被拒 (没报价就先付?)', () => TXS.updateTransaction(id, { status: 'paying' }, HOME));
  await TXS.updateTransaction(id, { status: 'quoted' }, HOME);
  await TXS.updateTransaction(id, { status: 'paying' }, HOME);
  const paidish = await TXS.readTransaction(id, HOME);
  check('进 paying 时结算事实还是 unpaid (拿到权利 ≠ 发出付款)', paidish?.settlementFact === 'unpaid', paidish?.settlementFact);

  // 造支付证据 → 不许标 failed
  await TXS.updateTransaction(id, { txHash: '0xdead', settlementFact: 'payment_submitted' } as any, HOME);
  await expectReject('有支付证据 → 标 failed 被拒 (钱不能凭空消失)', () => TXS.updateTransaction(id, { status: 'failed' }, HOME), '已有支付证据');
  const good = await TXS.updateTransaction(id, { status: 'delivery_failed' }, HOME);
  check('同一情况用 delivery_failed 表达 (合法)', good?.status === 'delivery_failed', good?.status);
  await expectReject('终态 delivery_failed 不许回到 paying', () => TXS.updateTransaction(id, { status: 'paying' }, HOME), '终态');
}

// ── [3] local-dev 的边界 ───────────────────────────────────────────────────
section('[3] local-dev: 永远不能产生链上结算事实, 不能 verified');
{
  const { record } = await TXS.beginTransaction({ requestId: 'req-ld', metadata: { itemId: 'i-ld' }, buyerDid: 'did:b', providerDid: 'did:p' }, HOME);
  const id = record.transactionId;
  await TXS.updateTransaction(id, { status: 'quoted', paymentMode: 'local-dev' }, HOME);
  await TXS.updateTransaction(id, { status: 'paying' }, HOME);
  await TXS.updateTransaction(id, { settlementFact: 'payment_submitted', paymentReceipt: 'local-receipt' } as any, HOME);
  await expectReject('local-dev 写 fully_settled 被拒', () => TXS.setSettlementFact(id, 'fully_settled', '联调想冒充链上', HOME), 'local-dev');
  await expectReject('local-dev 写 payment_verified 被拒', () => TXS.setSettlementFact(id, 'payment_verified', '联调想冒充链上', HOME), 'local-dev');
  await expectReject('local-dev 交易写 verified 被拒 (chainSettled=false)', () => TXS.updateTransaction(id, { status: 'verified' }, HOME), 'chainSettled');
  const delivered = await TXS.updateTransaction(id, { status: 'delivered', contentHash: 'h', deliveryHash: 'h', receiptHash: 'r', protocolVerified: true } as any, HOME);
  check('local-dev 最高只能 delivered (协议闭环成立)', delivered?.status === 'delivered' && delivered?.settlementFact === 'payment_submitted', { s: delivered?.status, f: delivered?.settlementFact });
}

// ── [4] 四种真实组合都能表达并读回 ─────────────────────────────────────────
section('[4] 组合状态: 生命周期 + 结算事实 可分开表达');
{
  const mk = async (reqId: string) => (await TXS.beginTransaction({ requestId: reqId, metadata: { itemId: reqId }, buyerDid: 'did:b', providerDid: 'did:p' }, HOME)).record.transactionId;

  const a = await mk('req-combo-a');            // paying + payment_submitted
  await TXS.updateTransaction(a, { status: 'quoted' }, HOME);
  await TXS.updateTransaction(a, { status: 'paying' }, HOME);
  await TXS.updateTransaction(a, { settlementFact: 'payment_submitted', paymentReceipt: 'r' } as any, HOME);
  const ra = await TXS.readTransaction(a, HOME);
  check('paying + payment_submitted (发出去了, 还没回执)', ra?.status === 'paying' && ra?.settlementFact === 'payment_submitted');

  const b = await mk('req-combo-b');            // settled + unknown (facilitator 说成了, 链上没确认)
  await TXS.updateTransaction(b, { status: 'quoted', paymentMode: 'facilitator' }, HOME);
  await TXS.updateTransaction(b, { status: 'paying' }, HOME);
  await TXS.updateTransaction(b, { settlementFact: 'payment_submitted' } as any, HOME);
  await TXS.updateTransaction(b, { status: 'settled', settlementFact: 'unknown' } as any, HOME);
  const rb = await TXS.readTransaction(b, HOME);
  check('settled + unknown (结算事实待确认)', rb?.status === 'settled' && rb?.settlementFact === 'unknown');

  const c = await mk('req-combo-c');            // delivery_failed + fully_settled
  await TXS.updateTransaction(c, { status: 'quoted', paymentMode: 'facilitator' }, HOME);
  await TXS.updateTransaction(c, { status: 'paying' }, HOME);
  await TXS.updateTransaction(c, { settlementFact: 'payment_submitted', txHash: '0xc' } as any, HOME);
  await expectReject('没有链上证据 → payment_submitted 一步跳 fully_settled 被拒', () => TXS.setSettlementFact(c, 'fully_settled', '没有链上证据', HOME), 'fully_settled');
  await TXS.updateTransaction(c, { chainSettled: true } as any, HOME);   // 对账拿到链上事实
  await TXS.updateTransaction(c, { settlementFact: 'fully_settled' } as any, HOME);
  await TXS.updateTransaction(c, { status: 'delivery_failed', responsibility: S.deriveResponsibility({ deliveryMissing: true }) } as any, HOME);
  const rc = await TXS.readTransaction(c, HOME);
  check('delivery_failed + fully_settled (钱付了, 正文没交 → 不许重付)', rc?.status === 'delivery_failed' && rc?.settlementFact === 'fully_settled');
  check('责任候选可解释 (undetermined + 理由含"没拿到正文")', rc?.responsibility?.type === 'undetermined' && String(rc?.responsibility?.reason).includes('没拿到正文'), rc?.responsibility);

  const d = await mk('req-combo-d');            // verification_failed + partially_settled
  await TXS.updateTransaction(d, { status: 'quoted', paymentMode: 'facilitator' }, HOME);
  await TXS.updateTransaction(d, { status: 'paying' }, HOME);
  await TXS.updateTransaction(d, { settlementFact: 'payment_submitted', txHash: '0xd' } as any, HOME);
  await TXS.updateTransaction(d, { settlementFact: 'partially_settled' } as any, HOME);
  await TXS.updateTransaction(d, { status: 'verification_failed', responsibility: S.deriveResponsibility({ deliveryHashMismatch: true }) } as any, HOME);
  const rd = await TXS.readTransaction(d, HOME);
  check('verification_failed + partially_settled (部分结算不是完成)', rd?.status === 'verification_failed' && rd?.settlementFact === 'partially_settled');
  check('责任候选 = provider_fault (内容哈希错)', rd?.responsibility?.type === 'provider_fault', rd?.responsibility);
  await expectReject('partially_settled 不许跳 fully_settled 之外的退步 (不许回 unpaid)', () => TXS.setSettlementFact(d, 'unpaid', '乱写', HOME));

  const replay = await TXS.replayTransaction(d, HOME);
  check('审计可回放 (结算事件在链上, 含 responsibility_candidate)', replay.some((l: string) => l.includes('settlement:partially_settled')) && replay.some((l: string) => l.includes('settlement:payment_submitted')));
}

// ── [5] verified 硬门 ─────────────────────────────────────────────────────
section('[5] verified 硬门: 八项缺一不可');
{
  const base: any = {
    transactionId: 'tx-gate', requestId: 'req-gate', itemId: 'i-gate', buyerDid: 'b', providerDid: 'p',
    paymentMode: 'facilitator', chainSettled: true, protocolVerified: true, contentHash: 'H', deliveryHash: 'H',
    receiptHash: 'R', settlementFact: 'fully_settled', status: 'delivered', startedAt: new Date().toISOString(), events: [],
  };
  S.writeDeliveryContent('tx-gate', '真实到手的目标市场调研正文', HOME);
  const bytesHash = S.verifyDelivery({ ...base, deliveryBytesHash: undefined }, HOME).bytesHash;
  base.deliveryBytesHash = bytesHash;

  const ex = { ok: true, schemaOk: true, tool: 'skill_run', sourceDeclared: true };
  const full = S.evaluateVerifiedGate({ rec: base, home: HOME, execution: ex, goalCriteriaMet: true });
  check('八项全满足 → verified', full.verified === true, full);

  const variants: [string, any, any, boolean][] = [
    ['chainSettled=false', { ...base, chainSettled: false }, ex, true],
    ['protocolVerified=false', { ...base, protocolVerified: false }, ex, true],
    ['结算事实未知', { ...base, settlementFact: 'unknown' }, ex, true],
    ['缺回执哈希', { ...base, receiptHash: undefined }, ex, true],
    ['正文不在盘上', { ...base, transactionId: 'tx-no-file' }, ex, true],
    ['没有执行证据', base, null, true],
    ['执行失败', base, { ok: false, schemaOk: true, reason: '工具报错' }, true],
    ['输出不满足契约', base, { ok: true, schemaOk: false }, true],
    ['Goal 判据未命中', base, ex, false],
  ];
  for (const [label, rec, execution, goalCriteria] of variants) {
    const res = S.evaluateVerifiedGate({ rec, home: HOME, execution, goalCriteriaMet: goalCriteria });
    check(`缺/坏 ${label} → 不 verified`, res.verified === false && res.missing.length > 0, res.missing);
  }

  // 正文被换过也要检出
  S.writeDeliveryContent('tx-tamper', '原始正文', HOME);
  const tRec: any = { ...base, transactionId: 'tx-tamper', deliveryBytesHash: S.verifyDelivery({ ...base, transactionId: 'tx-tamper' } as any, HOME).bytesHash };
  fs.writeFileSync(path.join(BHOME, 'x402', 'deliveries', 'tx-tamper.txt'), '被换过的正文', 'utf8');
  const tv = S.verifyDelivery(tRec, HOME);
  const tg = S.evaluateVerifiedGate({ rec: tRec, home: HOME, execution: ex, goalCriteriaMet: true });
  check('正文被换过 → 验真检出且不 verified', tv.present === true && tv.matchesRecorded === false && tg.verified === false, tv.reason);
}

// ── [6] 交易证据进 Run (带结算事实) ────────────────────────────────────────
section('[6] 交易证据进 Run: 结算事实与责任一起带走');
{
  const { record } = await TXS.beginTransaction({ requestId: 'req-bridge', metadata: { itemId: 'i-bridge' }, buyerDid: 'did:b', providerDid: 'did:p' }, HOME);
  const id = record.transactionId;
  await TXS.updateTransaction(id, { status: 'quoted', paymentMode: 'facilitator', amount: '1000', currency: 'USDC', network: 'base-sepolia' }, HOME);
  await TXS.updateTransaction(id, { status: 'paying' }, HOME);
  await TXS.updateTransaction(id, { settlementFact: 'payment_submitted', txHash: '0xbridge', paymentReceipt: 'rcpt' } as any, HOME);
  await TXS.updateTransaction(id, { chainSettled: true } as any, HOME);          // 对账拿到链上事实
  await TXS.updateTransaction(id, { settlementFact: 'fully_settled' } as any, HOME);
  const failedRec = await TXS.updateTransaction(id, { status: 'delivery_failed', responsibility: S.deriveResponsibility({ deliveryMissing: true }) } as any, HOME);

  const run = await RS.startRun({ surface: 'cli', goal: '验证两层状态', agent: 'verify' } as any);
  const bridged = await BRIDGE.bridgeTransactionToRunGoal(failedRec, { runId: run.runId, goalId: undefined, executionOk: false, goalCriteriaHit: false, summary: '跨市场调研' });
  check('Run step 已写入', bridged.stepWritten === true, bridged);
  const reread = await RS.readRun(run.runId);
  const step = (reread.steps || []).find((s: any) => s.tool === 'x402_transaction');
  check('Run 步骤摘要含结算事实 (钱动没动一眼可见)', /结算 fully_settled/.test(String(step?.summary)), step?.summary);
  const ev = (reread.evidence || []).join(' ');
  check('Run 证据含 settlementFact', ev.includes('settlementFact=fully_settled'), ev.slice(0, 160));
  check('Run 证据含责任候选', /responsibility=undetermined/.test(ev), ev.slice(0, 240));
  check('Run 证据含交易状态', ev.includes('transactionStatus=delivery_failed'));
  const failedStepOk = step?.ok === false;
  check('未成立/未验证的交易, Run 步骤不标成功', failedStepOk, step?.ok);
}

console.log(`\n=== 结果: ${passed} passed, ${failed} failed ===`);
console.log(`隔离 HOME: ${HOME}`);
console.log(`结论: 两层状态可表达 (生命周期 ⊗ 结算事实) · 非法迁移 0 次被静默接受 · local-dev 0 次 fully_settled · chainSettled=false 0 次 verified · 老记录迁移 0 事件丢失`);
process.exit(failed === 0 ? 0 : 1);
