/**
 * payment-recovery.test.ts — 支付中断恢复规划器 (Phase 3) 单测
 *
 * 核心断言: `payment uncertain ≠ payment failed`、`payment failed ≠ safe to retry`、先 reconcile 再决定 retry。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { planTransactionRecovery, runTransactionRecovery, reconciliationIsChainBacked, reconcileInterruptedPayments } from '../agents/x402/payment-recovery.js';
import { beginTransaction, updateTransaction, readTransaction } from '../agents/x402/transaction-store.js';
import type { TransactionRecord } from '../agents/x402/transaction-protocol.js';

let HOME: string;
beforeEach(() => { HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-rec-')); });
afterEach(() => { fs.rmSync(HOME, { recursive: true, force: true }); });

const rec = (over: Partial<TransactionRecord> = {}): TransactionRecord => ({
  transactionId: 'tx-1', requestId: 'req-1', itemId: 'i', buyerDid: 'b', providerDid: 'p',
  paymentMode: 'facilitator', chainSettled: false, status: 'quoted', settlementFact: 'unpaid',
  startedAt: new Date().toISOString(), events: [],
  ...over,
} as TransactionRecord);

describe('Phase 3 · 恢复计划 (纯函数)', () => {
  it('① 付款前 (unpaid) → 可安全付款', () => {
    expect(planTransactionRecovery(rec()).action).toBe('retry_payment');
    expect(planTransactionRecovery(rec()).mustNotRepay).toBe(false);
  });

  it('② 拿到付款权但没有凭据 → 先对账 (可安全重试), 但不许自动重付', () => {
    const p = planTransactionRecovery(rec({ status: 'paying' }));
    expect(p.action).toBe('reconcile');
    expect(p.reason).toContain('对账');
  });

  it('③ 有回执/txHash → 绝不重付, 继续交付', () => {
    const withReceipt = planTransactionRecovery(rec({ status: 'paying', settlementFact: 'payment_submitted', paymentReceipt: 'r' }));
    expect(withReceipt.action).toBe('deliver');
    expect(withReceipt.mustNotRepay).toBe(true);
    const withHash = planTransactionRecovery(rec({ status: 'settled', settlementFact: 'payment_verified', txHash: '0x1' }));
    expect(withHash.action).toBe('deliver');
    expect(withHash.mustNotRepay).toBe(true);
  });

  it('④ 已交付 → 只验真, 不重付', () => {
    const p = planTransactionRecovery(rec({ status: 'delivered', settlementFact: 'fully_settled', txHash: '0x1', chainSettled: true }));
    expect(p.action).toBe('verify');
    expect(p.mustNotRepay).toBe(true);
  });

  it('⑤ 付了钱但交付/验真失败 → 关闭 + 要追责, 不重付', () => {
    const p = planTransactionRecovery(rec({ status: 'delivery_failed', settlementFact: 'fully_settled', txHash: '0x1', chainSettled: true }));
    expect(p.action).toBe('closed');
    expect(p.needsResponsibility).toBe(true);
    expect(p.mustNotRepay).toBe(true);
    const v = planTransactionRecovery(rec({ status: 'verification_failed', settlementFact: 'payment_verified', txHash: '0x1' }));
    expect(v.action).toBe('closed');
    expect(v.needsResponsibility).toBe(true);
  });

  it('付款权被别人持有 → 等, 不动手', () => {
    const p = planTransactionRecovery(rec({ status: 'paying', paymentReceipt: 'r' }), { claimHeldByOther: true });
    expect(p.action).toBe('wait');
    expect(p.mustNotRepay).toBe(true);
  });

  it('结算事实 unknown → 先对账且不许重付 (不确定 ≠ 没付过)', () => {
    const p = planTransactionRecovery(rec({ status: 'paying', settlementFact: 'unknown', paymentReceipt: 'r' }));
    expect(p.action).toBe('reconcile');
    expect(p.mustNotRepay).toBe(true);
  });

  it('verified → complete; policy_denied/failed → closed', () => {
    expect(planTransactionRecovery(rec({ status: 'verified', settlementFact: 'fully_settled', chainSettled: true, txHash: '0x1' })).action).toBe('complete');
    expect(planTransactionRecovery(rec({ status: 'policy_denied' })).action).toBe('closed');
    expect(planTransactionRecovery(rec({ status: 'failed' })).action).toBe('closed');
  });

  it('对账结论: facilitator 说成功但没有 txHash 不算链上事实', () => {
    expect(reconciliationIsChainBacked({ fact: 'payment_verified' })).toBe(false);
    expect(reconciliationIsChainBacked({ fact: 'payment_verified', txHash: '0x1' })).toBe(true);
    expect(reconciliationIsChainBacked({ fact: 'unknown', txHash: '0x1' })).toBe(false);
  });
});

describe('Phase 3 · 执行器 (幂等, 只有计划允许才付款)', () => {
  const deps = (calls: string[], payOk = true) => ({
    reconcile: async (r: any) => { calls.push('reconcile'); return { fact: 'payment_verified' as const, txHash: '0xabc', note: '对账: 发现 txHash' }; },
    pay: async () => { calls.push('pay'); return { ok: payOk, receipt: 'rcpt', error: payOk ? undefined : '拒付' }; },
    deliver: async () => { calls.push('deliver'); return { ok: true }; },
    verify: async () => { calls.push('verify'); return { ok: true }; },
    persist: async () => { calls.push('persist'); },
    read: async () => null,
  });

  it('有支付证据 → 全程不付款 (只对账+交付+验真)', async () => {
    const calls: string[] = [];
    const out = await runTransactionRecovery(rec({ status: 'paying', settlementFact: 'payment_submitted', paymentReceipt: 'r' }), deps(calls) as any);
    expect(out.paid).toBe(false);
    expect(calls).not.toContain('pay');
    expect(calls).toContain('reconcile');
  });

  it('unpaid + quoted → 才会付款, 且只付一次', async () => {
    const calls: string[] = [];
    const out = await runTransactionRecovery(rec(), deps(calls) as any);
    expect(out.paid).toBe(true);
    expect(calls.filter((c) => c === 'pay')).toHaveLength(1);
  });

  it('终态/关闭态 → 什么都不做 (绝不付款)', async () => {
    const calls: string[] = [];
    await runTransactionRecovery(rec({ status: 'verified', settlementFact: 'fully_settled', chainSettled: true, txHash: '0x1' }), deps(calls) as any);
    await runTransactionRecovery(rec({ status: 'delivery_failed', settlementFact: 'fully_settled', chainSettled: true, txHash: '0x1' }), deps(calls) as any);
    expect(calls).not.toContain('pay');
  });

  it('对账后发现"没付过" → 允许补付一次', async () => {
    const calls: string[] = [];
    const d: any = {
      reconcile: async () => { calls.push('reconcile'); return { fact: 'unpaid', note: '没有支付凭据' }; },
      pay: async () => { calls.push('pay'); return { ok: true, receipt: 'r' }; },
      deliver: async () => { calls.push('deliver'); return { ok: true }; },
      verify: async () => { calls.push('verify'); return { ok: true }; },
      persist: async () => { calls.push('persist'); },
      read: async () => null,
    };
    const out = await runTransactionRecovery(rec({ status: 'paying' }), d);
    expect(calls).toContain('reconcile');
    expect(calls.filter((c) => c === 'pay')).toHaveLength(1);
    expect(out.paid).toBe(true);
  });

  it('真 store 集成: 恢复写下的结算事实能被读回', async () => {
    const { record } = await beginTransaction({ requestId: 'r-rec', metadata: { itemId: 'i' } as any, buyerDid: 'b', providerDid: 'p' }, HOME);
    await updateTransaction(record.transactionId, { status: 'quoted', paymentMode: 'facilitator' }, HOME);
    await updateTransaction(record.transactionId, { status: 'paying' }, HOME);
    await updateTransaction(record.transactionId, { settlementFact: 'payment_submitted', paymentReceipt: 'r' } as any, HOME);
    const cur = await readTransaction(record.transactionId, HOME);
    const plan = planTransactionRecovery(cur!);
    expect(plan.mustNotRepay).toBe(true);
    const calls: string[] = [];
    const d: any = {
      reconcile: async () => { calls.push('reconcile'); return { fact: 'fully_settled', txHash: '0xzz' }; },
      pay: async () => { calls.push('pay'); return { ok: true }; },
      deliver: async () => { calls.push('deliver'); return { ok: true }; },
      verify: async () => { calls.push('verify'); return { ok: true }; },
      persist: async (id: string, patch: Record<string, unknown>, ev: { kind: string; detail?: string }) => { await updateTransaction(id, { ...patch, event: ev } as any, HOME); },
      read: async (id: string) => readTransaction(id, HOME),
    };
    await runTransactionRecovery(cur!, d);
    const after = await readTransaction(record.transactionId, HOME);
    expect(calls).not.toContain('pay');
    expect(after?.settlementFact).toBe('fully_settled');
    expect(after?.chainSettled).toBe(true);
    expect((after?.events || []).some((e) => e.kind === 'recovery_reconciled')).toBe(true);
  });
});

describe('Phase 3 · Supervisor 对账入口 (只对账, 绝不代替付款方花钱)', () => {
  it('没有凭据的"付款中" → 钉成 unpaid + payment_required, 并列为"等付款方决定"', async () => {
    const { record } = await beginTransaction({ requestId: 'r-sup-1', metadata: { itemId: 'i' } as any, buyerDid: 'b', providerDid: 'p' }, HOME);
    await updateTransaction(record.transactionId, { status: 'quoted', paymentMode: 'facilitator' }, HOME);
    await updateTransaction(record.transactionId, { status: 'paying' }, HOME);

    const persisted: string[] = [];
    const rep = await reconcileInterruptedPayments({
      home: HOME,
      reconcile: async () => ({ fact: 'unpaid', note: '没有任何支付凭据' }),
      persist: async (id, patch, ev) => { persisted.push(ev.kind); await updateTransaction(id, { ...patch, event: ev } as any, HOME); },
    });
    expect(rep.scanned).toBeGreaterThanOrEqual(1);
    expect(rep.reconciled).toContain(record.transactionId);
    expect(rep.awaitingPayment.map((x) => x.transactionId)).toContain(record.transactionId);
    expect(persisted).toContain('supervisor_payment_reconciled');
    const after = await readTransaction(record.transactionId, HOME);
    expect(after?.settlementFact).toBe('unpaid');
    expect(after?.status).toBe('payment_required');       // 推回可安全重试的状态
  });

  it('有凭据但无 txHash → 维持 unknown 且进 mustNotRepay (绝不重付)', async () => {
    const { record } = await beginTransaction({ requestId: 'r-sup-2', metadata: { itemId: 'i' } as any, buyerDid: 'b', providerDid: 'p' }, HOME);
    await updateTransaction(record.transactionId, { status: 'quoted', paymentMode: 'facilitator' }, HOME);
    await updateTransaction(record.transactionId, { status: 'paying' }, HOME);
    await updateTransaction(record.transactionId, { settlementFact: 'unknown', paymentReceipt: 'rcpt' } as any, HOME);

    const rep = await reconcileInterruptedPayments({
      home: HOME,
      reconcile: async () => ({ fact: 'unknown', note: '有凭据但无 txHash' }),
      persist: async (id, patch, ev) => { await updateTransaction(id, { ...patch, event: ev } as any, HOME); },
    });
    expect(rep.mustNotRepay).toContain(record.transactionId);
    expect(rep.awaitingPayment.map((x) => x.transactionId)).not.toContain(record.transactionId);
    const after = await readTransaction(record.transactionId, HOME);
    expect(after?.settlementFact).toBe('unknown');
  });

  it('真 tick 集成: Supervisor 的 tick 会做支付对账, 且报告里能看到', async () => {
    const prevHome = process.env.HOME;
    process.env.HOME = HOME;          // Supervisor 对账读 process.env.HOME
    try {
      const { record } = await beginTransaction({ requestId: 'r-sup-tick', metadata: { itemId: 'i' } as any, buyerDid: 'b', providerDid: 'p' }, HOME);
      await updateTransaction(record.transactionId, { status: 'quoted', paymentMode: 'facilitator' }, HOME);
      await updateTransaction(record.transactionId, { status: 'paying' }, HOME);

      const { ExecutionSupervisor } = await import('../agents/execution-supervisor.js');
      const sup = new ExecutionSupervisor({ owner: 'test-owner', tickIntervalMs: 999_999 } as any);
      const report = await (sup as any).tickOnce();
      expect(report.payments).toBeTruthy();
      expect(report.payments.scanned).toBeGreaterThanOrEqual(1);
      expect(report.payments.reconciled).toContain(record.transactionId);
      const after = await readTransaction(record.transactionId, HOME);
      expect(after?.status).toBe('payment_required');
      expect(report.payments.errors).toEqual([]);
    } finally { process.env.HOME = prevHome; }
  });
});
