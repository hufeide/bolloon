/**
 * verify-settlement-responsibility.ts — Phase 4 验收 (2026-09-18)
 *
 * leo 的 Phase 4: 里程碑结算 / 争议 / 责任 + 交易审计。
 * 真: 真落盘交易记录 · 真写路径拒绝 · 真 HTTP 审计接口。
 *
 * 用法: npx tsx scripts/verify-settlement-responsibility.ts
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

const REAL_HOME = os.homedir();
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-phase4-'));
const HOME = path.join(ROOT, 'home');
const BHOME = path.join(HOME, '.bolloon');
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.BOLLOON_SUPERVISOR = '0';
fs.mkdirSync(BHOME, { recursive: true });

const { makeSetupReady } = await import('./lib/make-setup-ready.js');
makeSetupReady(BHOME, { realHome: REAL_HOME, name: '里程碑/争议验收' });

const TXS: any = await import('../src/agents/x402/transaction-store.js');
const MILE: any = await import('../src/agents/x402/milestone-settlement.js');
const SS: any = await import('../src/agents/x402/settlement-state.js');
const BRIDGE: any = await import('../src/agents/x402/goal-run-bridge.js');
const GS: any = await import('../src/agents/goal-store.js');
const RS: any = await import('../src/agents/run-store.js');

let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d?: unknown) => {
  if (ok) { passed++; console.log(`  ✅ ${n}`); }
  else { failed++; console.log(`  ❌ ${n}${d !== undefined ? ` — ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 240)}` : ''}`); }
};
const reject = (n: string, ok: boolean, d?: unknown) => {
  if (ok) { passed++; console.log(`  ⛔ ${n} (已拒绝)`); }
  else { failed++; console.log(`  ❌ ${n} — 期望被拒绝但没有: ${String(typeof d === 'string' ? d : JSON.stringify(d ?? null)).slice(0, 200)}`); }
};
const section = (t: string) => console.log(`\n${t}`);

const mkTx = async (reqId: string, amount = '1000') => {
  const { record } = await TXS.beginTransaction({ requestId: reqId, metadata: { itemId: 'skill-res' }, buyerDid: 'did:b', providerDid: 'did:key:zSeller' }, HOME);
  await TXS.updateTransaction(record.transactionId, { status: 'quoted', paymentMode: 'facilitator', amount, currency: 'USDC', network: 'base-sepolia', payTo: '0xpay', contentHash: 'sha256:content' }, HOME);
  return record.transactionId;
};

// ── [1] 里程碑契约 ─────────────────────────────────────────────────────────
section('[1] 里程碑: 金额整数、合计与交易金额一致');
{
  const m1 = MILE.makeMilestone({ milestoneId: 'milestone_1', title: '报告骨架交付', amount: '300' });
  const m2 = MILE.makeMilestone({ milestoneId: 'milestone_2', title: '数据和来源交付', amount: '400' });
  const m3 = MILE.makeMilestone({ milestoneId: 'milestone_3', title: 'Skill 执行结果交付', amount: '300' });
  check('三个里程碑建得起来', [m1, m2, m3].every((m) => m.paymentStatus === 'unpaid'));
  check('合计与交易金额一致 (300+400+300=1000)', MILE.milestonesMatchAmount([m1, m2, m3], '1000').ok === true, MILE.milestonesMatchAmount([m1, m2, m3], '1000'));
  check('合计不等于交易金额 → 拒绝 (账不平)', MILE.milestonesMatchAmount([m1, m2, m3], '999').ok === false);
  let threw = false;
  try { MILE.makeMilestone({ milestoneId: 'm', title: 'x', amount: '0.3' }); } catch { threw = true; }
  check('浮点金额 → 拒绝 (原子单位字符串)', threw);
}

// ── [2] 部分完成 → partially_settled, 且不进 Goal 成功证据 ─────────────────
section('[2] 部分里程碑完成 → partially_settled (不算完成, 不进 Goal 成功证据)');
let partialTxId = '';
{
  partialTxId = await mkTx(`phase4-partial-${Date.now().toString(36)}`);
  const ms = [MILE.makeMilestone({ milestoneId: 'milestone_1', title: '报告骨架', amount: '300' }),
              MILE.makeMilestone({ milestoneId: 'milestone_2', title: '数据来源', amount: '400' }),
              MILE.makeMilestone({ milestoneId: 'milestone_3', title: '执行结果', amount: '300' })];
  let cur = ms;
  cur = MILE.applyMilestoneResult(cur, 'milestone_1', { paymentStatus: 'paid', deliveryStatus: 'delivered', verificationStatus: 'verified', evidence: ['骨架已交付'] }).milestones;
  const agg = MILE.aggregateMilestones(cur);
  check('聚合: 1/3 完成 → partially_settled', agg.settlementFact === 'partially_settled' && agg.verified === 1 && agg.total === 3, agg);
  check('下一个该做的里程碑明确', agg.nextMilestoneId === 'milestone_2', agg.nextMilestoneId);
  const after = await TXS.updateTransaction(partialTxId, { status: 'paying', milestones: cur } as any, HOME);
  const withFact = await TXS.updateTransaction(partialTxId, { settlementFact: 'payment_submitted' } as any, HOME);
  const partial = await TXS.updateTransaction(partialTxId, { settlementFact: 'partially_settled', status: 'settled' } as any, HOME);
  check('落盘: 结算事实 = partially_settled', partial?.settlementFact === 'partially_settled', partial?.settlementFact);
  const elig = MILE.milestoneGoalEligibility(partial, { executionOk: true, goalCriteriaHit: true });
  check('partially_settled → 永不计入 Goal 成功证据', elig.eligible === false && elig.reason.includes('partially_settled'), elig);
  reject('partially_settled 的交易也不许直接标 verified (链上没结算)', (await (async () => {
    try { await TXS.updateTransaction(partialTxId, { status: 'verified' }, HOME); return false; } catch { return true; }
  })()));
  reject('partially_settled 不许退回 unpaid', (await (async () => {
    try { await TXS.setSettlementFact(partialTxId, 'unpaid', '乱写', HOME); return false; } catch { return true; }
  })()));
}

// ── [3] 全部完成 + 链上 → verified + fully_settled → 计入成功证据 ───────────
section('[3] 全部里程碑完成 + 链上结算 → verified, 才计入 Goal 成功证据');
{
  const txId = await mkTx(`phase4-full-${Date.now().toString(36)}`);
  let cur = [MILE.makeMilestone({ milestoneId: 'milestone_1', title: '骨架', amount: '300' }),
             MILE.makeMilestone({ milestoneId: 'milestone_2', title: '数据', amount: '700' })];
  for (const id of ['milestone_1', 'milestone_2']) {
    cur = MILE.applyMilestoneResult(cur, id, { paymentStatus: 'paid', deliveryStatus: 'delivered', verificationStatus: 'verified', evidence: [`${id} 完成`] }).milestones;
  }
  const agg = MILE.aggregateMilestones(cur);
  check('全部完成 → allComplete + fully_settled', agg.allComplete === true && agg.settlementFact === 'fully_settled', agg);
  await TXS.updateTransaction(txId, { status: 'paying', milestones: cur } as any, HOME);
  await TXS.updateTransaction(txId, { settlementFact: 'payment_submitted', paymentReceipt: 'rcpt', txHash: '0xfull' } as any, HOME);
  await TXS.updateTransaction(txId, { chainSettled: true, settlementFact: 'payment_verified' } as any, HOME);
  const w = SS.writeDeliveryContent(txId, '全部交付物正文', HOME);
  await TXS.updateTransaction(txId, { status: 'delivered', deliveryHash: 'sha256:content', deliveryBytesHash: w.hash, receiptHash: 'rh', protocolVerified: true } as any, HOME);
  const verified = await TXS.updateTransaction(txId, { status: 'verified', settlementFact: 'fully_settled', execution: { ok: true, schemaOk: true, tool: 'skill_exec' }, goalCriteriaMet: true } as any, HOME);
  check('落盘: verified + fully_settled', verified?.status === 'verified' && verified?.settlementFact === 'fully_settled', { s: verified?.status, f: verified?.settlementFact });
  const elig = MILE.milestoneGoalEligibility(verified, { executionOk: true, goalCriteriaHit: true });
  check('全部完成 + 链上 + 执行成功 + 命中判据 → 计入成功证据', elig.eligible === true, elig);

  const goal = await GS.createGoal({ title: '按里程碑交付调研', channelId: 'verify', requiredSkills: [], criteria: ['三个里程碑全部验真'], criteriaSource: 'user', criteriaConfirmed: true } as any);
  const goalId = goal.goalId || goal.id;
  const bridged = await BRIDGE.bridgeTransactionToRunGoal(verified, { goalId, executionOk: true, goalCriteriaHit: true, summary: '跨境电商调研' });
  const g = await GS.readGoal(goalId);
  check('桥接: 成功证据已计入 Goal', bridged.goalEvidenceWritten === true && (g?.evidence || []).join(' ').includes('已执行并命中判据'), (g?.evidence || []).length);
  check('Goal 证据里能看到里程碑进度', (g?.evidence || []).join(' ').includes('milestones=2/2'), (g?.evidence || []).slice(-1));
  console.log(`  ${' '.repeat(2)}· 交易 ${txId} · 状态 ${verified?.status} · 结算 ${verified?.settlementFact}`);
}

// ── [4] 任一里程碑交付失败 → 争议 (不许静默) ───────────────────────────────
section('[4] 里程碑交付失败 → 进争议 (不静默关闭)');
let disputeTxId = '';
{
  disputeTxId = await mkTx(`phase4-dispute-${Date.now().toString(36)}`);
  let cur = [MILE.makeMilestone({ milestoneId: 'milestone_1', title: '骨架', amount: '400' }),
             MILE.makeMilestone({ milestoneId: 'milestone_2', title: '数据来源', amount: '600' })];
  cur = MILE.applyMilestoneResult(cur, 'milestone_1', { paymentStatus: 'paid', deliveryStatus: 'delivered', verificationStatus: 'verified', evidence: ['骨架 ok'] }).milestones;
  cur = MILE.applyMilestoneResult(cur, 'milestone_2', { paymentStatus: 'paid', deliveryStatus: 'failed', evidence: ['卖方未交付数据包'] }).milestones;
  const agg = MILE.aggregateMilestones(cur);
  check('有失败项 → shouldDispute', agg.shouldDispute === true && agg.failed === 1, agg);

  await TXS.updateTransaction(disputeTxId, { status: 'paying', milestones: cur } as any, HOME);
  await TXS.updateTransaction(disputeTxId, { settlementFact: 'payment_submitted', paymentReceipt: 'rcpt-d', txHash: '0xdispute' } as any, HOME);
  await TXS.updateTransaction(disputeTxId, { chainSettled: true, settlementFact: 'payment_verified' } as any, HOME);
  await TXS.updateTransaction(disputeTxId, { status: 'delivery_failed', responsibility: SS.deriveResponsibility({ deliveryMissing: true }) } as any, HOME);

  const dispute = MILE.buildDispute({
    reason: 'milestone_2 (数据来源) 未交付, 但该阶段款项已付',
    evidence: {
      quote: { payTo: '0xpay', amount: '1000', currency: 'USDC', network: 'base-sepolia', itemId: 'skill-res' },
      paymentHeaderDigest: 'sha256:header', facilitatorResponse: 'settle=success',
      txHash: '0xdispute', contentHash: 'sha256:content', envelopeDigest: 'sha256:env',
      runId: 'run-x', runStep: 'x402_transaction', goalId: 'goal-x', goalEvidence: ['付费资源未达门槛'],
      failurePoint: 'milestone_2.delivery',
    },
    responsibilityEvidence: { deliveryMissing: true },
  });
  check('争议记录带责任候选 (undetermined + 理由)', dispute.evidence.responsibility?.type === 'undetermined', dispute.evidence.responsibility);
  check('证据齐全 → missingEvidence 为空', dispute.missingEvidence.length === 0, dispute.missingEvidence);
  const thin = MILE.buildDispute({ reason: '缺证据的争议', evidence: { failurePoint: 'x' } });
  check('缺证据时**显式列出**缺口 (不假装证据齐)', thin.missingEvidence.includes('quote') && thin.missingEvidence.includes('txHash'), thin.missingEvidence);

  const disputed = await TXS.updateTransaction(disputeTxId, { status: 'disputed', dispute, mustNotRepay: true } as any, HOME);
  check('落盘: 状态 disputed', disputed?.status === 'disputed', disputed?.status);

  section('[5] 争议三条禁令 (写路径真拒绝)');
  const forbid1 = SS.disputeForbids(await TXS.readTransaction(disputeTxId, HOME), 'payment_required');
  check('禁令 1 由纯函数实现 (原因明确: 不能自动重付)', forbid1.ok === false && String(forbid1.reason).includes('不能自动重付'), forbid1);
  reject('禁令 1: 争议期间不许重新付款 (写路径真拒绝)', (await (async () => {
    try { await TXS.updateTransaction(disputeTxId, { status: 'payment_required' }, HOME); return false; }
    catch (e: any) { const r = String(e?.reason || ''); return r.includes('不能自动重付') || r.includes('终态'); }
  })()));
  const forbid2 = SS.disputeForbids(await TXS.readTransaction(disputeTxId, HOME), 'verified');
  check('禁令 2 由纯函数实现 (原因明确: 不能标成功)', forbid2.ok === false && String(forbid2.reason).includes('不能标成功'), forbid2);
  reject('禁令 2: 争议期间不许标 verified (写路径真拒绝)', (await (async () => {
    try { await TXS.updateTransaction(disputeTxId, { status: 'verified' }, HOME); return false; } catch (e: any) { const r = String(e?.reason || ''); return r.includes('不能标成功') || r.includes('终态') || r.includes('chainSettled'); }
  })()));
  reject('禁令 3: 不许静默关闭 (无收尾就改状态)', (await (async () => {
    try { await TXS.updateTransaction(disputeTxId, { status: 'delivered' }, HOME); return false; } catch { return true; }
  })()));
  const eligInDispute = MILE.milestoneGoalEligibility((await TXS.readTransaction(disputeTxId, HOME)), { executionOk: true, goalCriteriaHit: true });
  check('争议期间不计入 Goal 成功证据', eligInDispute.eligible === false && eligInDispute.reason.includes('争议'), eligInDispute);

  section('[6] 争议收尾 (必须带证据) + 退款状态机');
  let noEvidence = false;
  try { MILE.resolveDispute(await TXS.readTransaction(disputeTxId, HOME), { decision: 'refund', by: 'leo', reason: '卖方未交付', evidence: [] }); } catch { noEvidence = true; }
  check('收尾不带证据 → 拒绝', noEvidence);
  const resolved = MILE.resolveDispute(await TXS.readTransaction(disputeTxId, HOME), { decision: 'refund', by: 'leo', reason: 'milestone_2 未交付且无证据', evidence: ['卖方在 48h 内未交付', '链上回执 txHash=0xdispute'] });
  await TXS.updateTransaction(disputeTxId, { dispute: resolved, event: { kind: 'dispute_resolved', detail: `decision=${resolved.resolution?.decision} by=${resolved.resolution?.by}` } } as any, HOME);
  const afterResolve = await TXS.readTransaction(disputeTxId, HOME);
  check('收尾记录可读 (决定 + 依据 + 证据)', afterResolve?.dispute?.resolution?.decision === 'refund' && (afterResolve?.dispute?.resolution?.evidence || []).length >= 2, afterResolve?.dispute?.resolution);
  const refundPending = await TXS.setSettlementFact(disputeTxId, 'refund_pending', '争议决定: 退款', HOME);
  check('结算事实 → refund_pending', refundPending?.settlementFact === 'refund_pending', refundPending?.settlementFact);
  const refunded = await TXS.setSettlementFact(disputeTxId, 'refunded', '退款已发出 (txHash 另存)', HOME);
  check('结算事实 → refunded (终态)', refunded?.settlementFact === 'refunded', refunded?.settlementFact);
  reject('refunded 不许回到 fully_settled (钱退出去不能又算结算)', (await (async () => {
    try { await TXS.setSettlementFact(disputeTxId, 'fully_settled', '乱写', HOME); return false; } catch { return true; }
  })()));
}

// ── [7] 责任候选 (证据 → 候选) ─────────────────────────────────────────────
section('[7] 责任候选可由证据解释, 并落进交易与 Run 证据');
{
  const cases: Array<[string, any, string]> = [
    ['内容哈希错 → provider_fault', { deliveryHashMismatch: true }, 'provider_fault'],
    ['卖方签名错 → provider_fault', { signatureInvalid: true }, 'provider_fault'],
    ['输出不符契约 → provider_fault', { outputSchemaViolation: true }, 'provider_fault'],
    ['输入不符 schema → buyer_fault', { inputSchemaViolation: true }, 'buyer_fault'],
    ['越过 Policy → agent_fault', { policyBypassed: true }, 'agent_fault'],
    ['记录丢失/重复扣款 → platform_fault', { ledgerLostOrDoubleCharged: true }, 'platform_fault'],
    ['缺回执 → payment_infrastructure_fault', { receiptMissing: true }, 'payment_infrastructure_fault'],
    ['证据不足 → undetermined', {}, 'undetermined'],
  ];
  for (const [label, ev, expect] of cases) {
    const cand = SS.deriveResponsibility(ev);
    check(label, cand.type === expect, cand);
  }
  const run = await RS.startRun({ surface: 'cli', goal: '里程碑交付验收', agent: 'verify' } as any);
  const rec = await TXS.readTransaction(disputeTxId, HOME);
  const bridged = await BRIDGE.bridgeTransactionToRunGoal(rec, { runId: run.runId, executionOk: false, goalCriteriaHit: false, summary: '跨境电商调研' });
  const rr = await RS.readRun(run.runId);
  const ev = (rr.evidence || []).join(' ');
  check('Run 证据带责任候选', bridged.evidenceWritten === true && /responsibility=/.test(ev), ev.slice(0, 200));
  check('Run 证据带争议状态与收尾', /dispute=opened/.test(ev) && /disputeResolved=refund/.test(ev), ev.slice(0, 260));
  check('Run 证据带里程碑进度', /milestones=/.test(ev), ev.slice(0, 200));
}

// ── [8] 真 HTTP 审计接口 ───────────────────────────────────────────────────
section('[8] 交易审计 API (里程碑/争议/责任/资格/回放)');
{
  const { createWebServer } = await import('../src/web/server.js') as any;
  const app = await createWebServer({ port: 0, headless: true } as any);
  const server: any = app?.server || app;
  const addr: any = await new Promise((r) => { if (server?.address?.()) r(server.address()); else server?.once?.('listening', () => r(server.address())); });
  const BASE = `http://127.0.0.1:${addr?.port || 0}`;
  try {
    const r1 = await fetch(`${BASE}/api/x402/transactions`);
    const list: any = await r1.json();
    check('列表接口: 交易都在 + 争议/部分结算可见', r1.status === 200 && list.count >= 3 && list.transactions.some((t: any) => t.disputed === true), { count: list.count });
    check('列表接口: partially_settled 标出来 (partial=true)', list.transactions.some((t: any) => t.partial === true), list.transactions.filter((t: any) => t.partial).length);

    const r2 = await fetch(`${BASE}/api/x402/transactions/${disputeTxId}`);
    const one: any = await r2.json();
    check('明细接口: 里程碑列表 + 聚合', one.milestones?.list?.length === 2 && one.milestones?.aggregate?.failed === 1, one.milestones?.aggregate);
    check('明细接口: 争议 + 收尾决定', one.dispute?.resolution?.decision === 'refund' && one.dispute?.missingEvidence?.length === 0, one.dispute?.resolution);
    check('明细接口: 责任候选', one.responsibility?.type === 'undetermined', one.responsibility);
    check('明细接口: Goal 资格判定 (争议 → 不合格)', one.goalEligibility?.eligible === false, one.goalEligibility);
    check('明细接口: 证据链可回放 (≥5 条事件)', Array.isArray(one.replay) && one.replay.length >= 5, one.replay?.length);

    const r3 = await fetch(`${BASE}/api/x402/transactions/tx-does-not-exist`);
    check('不存在的交易 → 404 (不返回空壳)', r3.status === 404, r3.status);
  } catch (err: any) {
    check('审计 API 可达', false, String(err?.message || err).slice(0, 160));
  } finally { try { server?.close?.(); } catch { /* ignore */ } }
}

// ── 汇总 ───────────────────────────────────────────────────────────────────
console.log(`\n=== 结果: ${passed} passed, ${failed} failed ===`);
console.log(`隔离 HOME: ${HOME}`);
console.log('结论: 部分结算不误判为完成 · 争议不自动重付/不标 verified/不静默关闭 · 责任候选由证据解释 · 审计可回放');
process.exit(failed === 0 ? 0 : 1);
