/**
 * milestone-settlement.test.ts — 里程碑结算 / 争议 / 责任 (Phase 4) 单测
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  makeMilestone, validateMilestoneSpec, milestonesMatchAmount, aggregateMilestones,
  applyMilestoneResult, buildDispute, resolveDispute, milestoneGoalEligibility,
} from '../agents/x402/milestone-settlement.js';
import { disputeForbids } from '../agents/x402/settlement-state.js';
import { beginTransaction, readTransaction, updateTransaction, setSettlementFact } from '../agents/x402/transaction-store.js';
import type { TransactionRecord } from '../agents/x402/transaction-protocol.js';

let HOME: string;
beforeEach(() => { HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-ms-')); });
afterEach(() => { fs.rmSync(HOME, { recursive: true, force: true }); });

const rec = (over: Partial<TransactionRecord> = {}): TransactionRecord => ({
  transactionId: 'tx-1', requestId: 'r', itemId: 'i', buyerDid: 'b', providerDid: 'p',
  paymentMode: 'facilitator', chainSettled: false, status: 'settled', settlementFact: 'payment_submitted',
  startedAt: new Date().toISOString(), events: [], ...over,
} as TransactionRecord);

const three = () => [
  makeMilestone({ milestoneId: 'milestone_1', title: '骨架', amount: '300' }),
  makeMilestone({ milestoneId: 'milestone_2', title: '数据', amount: '400' }),
  makeMilestone({ milestoneId: 'milestone_3', title: '执行', amount: '300' }),
];

describe('Phase 4 · 里程碑', () => {
  it('金额必须正整数原子单位; 合计必须等于交易金额', () => {
    expect(validateMilestoneSpec({ milestoneId: 'm', amount: '100' }).ok).toBe(true);
    expect(validateMilestoneSpec({ milestoneId: 'm', amount: '1.5' }).ok).toBe(false);
    expect(validateMilestoneSpec({ milestoneId: 'm', amount: '0' }).ok).toBe(false);
    expect(milestonesMatchAmount(three(), '1000').ok).toBe(true);
    expect(milestonesMatchAmount(three(), '999').ok).toBe(false);
  });

  it('1/3 完成 → partially_settled + 下一个里程碑明确', () => {
    const after = applyMilestoneResult(three(), 'milestone_1', { paymentStatus: 'paid', deliveryStatus: 'delivered', verificationStatus: 'verified' });
    expect(after.ok).toBe(true);
    const agg = after.aggregate;
    expect(agg.settlementFact).toBe('partially_settled');
    expect(agg.nextMilestoneId).toBe('milestone_2');
    expect(agg.reason).toContain('partially_settled');
  });

  it('全部完成 → fully_settled; 任一失败 → shouldDispute', () => {
    let ms = three();
    for (const id of ['milestone_1', 'milestone_2', 'milestone_3']) {
      ms = applyMilestoneResult(ms, id, { paymentStatus: 'paid', deliveryStatus: 'delivered', verificationStatus: 'verified' }).milestones;
    }
    expect(aggregateMilestones(ms).allComplete).toBe(true);
    expect(aggregateMilestones(ms).settlementFact).toBe('fully_settled');
    const failed = applyMilestoneResult(ms, 'milestone_2', { deliveryStatus: 'failed', verificationStatus: 'failed' }).aggregate;
    expect(failed.shouldDispute).toBe(true);
    expect(failed.failed).toBe(1);
  });

  it('不存在的里程碑 → ok=false (不静默通过)', () => {
    expect(applyMilestoneResult(three(), 'nope', { paymentStatus: 'paid' }).ok).toBe(false);
  });
});

describe('Phase 4 · 争议', () => {
  it('证据缺口被显式列出 (不假装证据齐)', () => {
    const d = buildDispute({ reason: 'x', evidence: { failurePoint: 'milestone_2.delivery' } });
    expect(d.missingEvidence).toContain('quote');
    expect(d.missingEvidence).toContain('txHash');
    expect(d.mustNotRepay).toBe(true);
  });

  it('证据齐全 → 无缺口; 责任候选按证据给', () => {
    const d = buildDispute({
      reason: 'y',
      evidence: { quote: { payTo: '0x', amount: '1000' }, txHash: '0x1', contentHash: 'sha256:c', envelopeDigest: 'sha256:e', failurePoint: 'milestone_2' },
      responsibilityEvidence: { deliveryHashMismatch: true },
    });
    expect(d.missingEvidence).toEqual([]);
    expect(d.evidence.responsibility?.type).toBe('provider_fault');
  });

  it('三条禁令 (纯函数): 不重付 / 不 verified / 不静默关闭', () => {
    const d = buildDispute({ reason: 'z', evidence: { failurePoint: 'p' } });
    const disputed = rec({ status: 'disputed', dispute: d } as any);
    expect(disputeForbids(disputed, 'payment_required').ok).toBe(false);
    expect(String(disputeForbids(disputed, 'payment_required').reason)).toContain('不能自动重付');
    expect(disputeForbids(disputed, 'verified').ok).toBe(false);
    expect(String(disputeForbids(disputed, 'verified').reason)).toContain('不能标成功');
    expect(disputeForbids(disputed, 'delivered').ok).toBe(false);
    expect(String(disputeForbids(disputed, 'delivered').reason)).toContain('不能静默关闭');
    // 已收尾 → 允许记录收尾决定 (但仍不许重付/verified)
    const resolved = rec({ status: 'disputed', dispute: resolveDispute(disputed, { decision: 'refund', by: 'leo', reason: 'r', evidence: ['e1'] }) } as any);
    expect(disputeForbids(resolved, 'delivered').ok).toBe(true);
    expect(disputeForbids(resolved, 'payment_required').ok).toBe(false);
  });

  it('收尾不带证据 → 抛错', () => {
    const d = buildDispute({ reason: 'z', evidence: { failurePoint: 'p' } });
    expect(() => resolveDispute(rec({ status: 'disputed', dispute: d } as any), { decision: 'refund', by: 'leo', reason: 'r', evidence: [] })).toThrow();
  });

  it('没有争议记录 → resolveDispute 抛错 (不能凭空收尾)', () => {
    expect(() => resolveDispute(rec(), { decision: 'release', by: 'leo', reason: 'r', evidence: ['e'] })).toThrow();
  });
});

describe('Phase 4 · Goal 成功证据门槛', () => {
  it('partially_settled 一律不算', () => {
    const r = rec({ status: 'verified', chainSettled: true, txHash: '0x1', settlementFact: 'partially_settled' });
    const e = milestoneGoalEligibility(r, { executionOk: true, goalCriteriaHit: true });
    expect(e.eligible).toBe(false);
    expect(e.reason).toContain('partially_settled');
  });

  it('争议中不算; 里程碑未全完成不算; 全完成 + 链上 + 执行成功 + 命中判据才算', () => {
    const d = buildDispute({ reason: 'q', evidence: { failurePoint: 'p' } });
    expect(milestoneGoalEligibility(rec({ status: 'disputed', dispute: d } as any), { executionOk: true, goalCriteriaHit: true }).eligible).toBe(false);

    const half = applyMilestoneResult(three(), 'milestone_1', { paymentStatus: 'paid', deliveryStatus: 'delivered', verificationStatus: 'verified' }).milestones;
    const rHalf = rec({ status: 'verified', chainSettled: true, txHash: '0x1', settlementFact: 'fully_settled', milestones: half } as any);
    expect(milestoneGoalEligibility(rHalf, { executionOk: true, goalCriteriaHit: true }).eligible).toBe(false);

    let all = three();
    for (const id of ['milestone_1', 'milestone_2', 'milestone_3']) {
      all = applyMilestoneResult(all, id, { paymentStatus: 'paid', deliveryStatus: 'delivered', verificationStatus: 'verified' }).milestones;
    }
    const good = rec({ status: 'verified', chainSettled: true, txHash: '0x1', settlementFact: 'fully_settled', milestones: all } as any);
    expect(milestoneGoalEligibility(good, { executionOk: true, goalCriteriaHit: true }).eligible).toBe(true);
    expect(milestoneGoalEligibility(good, { executionOk: false, goalCriteriaHit: true }).eligible).toBe(false);
    expect(milestoneGoalEligibility(good, { executionOk: true, goalCriteriaHit: false }).eligible).toBe(false);
  });
});

describe('Phase 4 · 退款路径与写路径', () => {
  it('disputed 落盘后: 不许重付/verified/静默关闭 (真 store 拒绝)', async () => {
    const { record } = await beginTransaction({ requestId: 'r-4', metadata: { itemId: 'i' } as any, buyerDid: 'b', providerDid: 'p' }, HOME);
    const id = record.transactionId;
    await updateTransaction(id, { status: 'quoted', paymentMode: 'facilitator' }, HOME);
    await updateTransaction(id, { status: 'paying' }, HOME);
    await updateTransaction(id, { settlementFact: 'payment_submitted', paymentReceipt: 'r', txHash: '0x4' } as any, HOME);
    await updateTransaction(id, { chainSettled: true, settlementFact: 'payment_verified' } as any, HOME);
    await updateTransaction(id, { status: 'delivery_failed' }, HOME);
    const d = buildDispute({ reason: '未交付', evidence: { quote: { payTo: '0x' }, txHash: '0x4', contentHash: 'sha256:c', envelopeDigest: 'sha256:e', failurePoint: 'delivery' } });
    await updateTransaction(id, { status: 'disputed', dispute: d } as any, HOME);

    await expect(updateTransaction(id, { status: 'payment_required' }, HOME)).rejects.toThrow();
    await expect(updateTransaction(id, { status: 'verified' }, HOME)).rejects.toThrow();
    await expect(updateTransaction(id, { status: 'delivered' }, HOME)).rejects.toThrow();

    // 退款: refund_pending → refunded, 且不许被"链上证据"绕回 fully_settled
    await setSettlementFact(id, 'refund_pending', '争议决定退款', HOME);
    await setSettlementFact(id, 'refunded', '退款已发出', HOME);
    await expect(setSettlementFact(id, 'fully_settled', '乱写', HOME)).rejects.toThrow();
    const back = await readTransaction(id, HOME);
    expect(back?.settlementFact).toBe('refunded');
    expect(back?.status).toBe('disputed');
  });
});
