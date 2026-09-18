/**
 * goal-run-bridge.ts — 交易证据接入 Run / Goal (Phase 3, 2026-09-16)
 *
 * 支付不能只是工具副作用: 一次 Run 必须能回答 —— 为什么付款、买了什么、花了多少、
 * 是否真结算、拿到什么、资源是否验证通过、结果对 Goal 有没有帮助。
 *
 * 事件映射 (与 leo 的规格一致):
 *   discovered → transaction.discovered · quoted → transaction.quoted · policy_denied → transaction.policy_denied
 *   paying → transaction.paying · settled → transaction.settled · delivered → transaction.delivered
 *   verified → transaction.verified · delivery_failed/verification_failed → 同名
 *
 * Goal 侧只在 **交易 verified + 资源执行成功 + 命中判据** 时累计成功证据;
 * 仅付款成功或仅拿到内容 **不能**满足 Goal 判据。
 */

import { recordStep, readRun, addRunEvidence } from '../run-store.js';
import { addEvidence as addGoalEvidenceViaStore } from '../goal-store.js';
import type { TransactionRecord } from './transaction-protocol.js';

export type BridgeEvent =
  | 'transaction.discovered' | 'transaction.quoted' | 'transaction.policy_denied'
  | 'transaction.paying' | 'transaction.settled' | 'transaction.delivered'
  | 'transaction.verified' | 'transaction.delivery_failed' | 'transaction.verification_failed';

export function bridgeEventFor(status: TransactionRecord['status']): BridgeEvent {
  switch (status) {
    case 'discovered': return 'transaction.discovered';
    case 'quoted': return 'transaction.quoted';
    case 'policy_denied': return 'transaction.policy_denied';
    case 'paying': case 'payment_required': return 'transaction.paying';
    case 'settled': return 'transaction.settled';
    case 'delivered': return 'transaction.delivered';
    case 'verified': return 'transaction.verified';
    case 'delivery_failed': return 'transaction.delivery_failed';
    case 'verification_failed': return 'transaction.verification_failed';
    default: return 'transaction.quoted';
  }
}

/** 一次交易的证据行 (写进 Run evidence / Goal evidence 的同一组字段) */
export function transactionEvidenceLines(rec: TransactionRecord): string[] {
  return [
    `transactionId=${rec.transactionId}`,
    `itemId=${rec.itemId}`,
    `paymentMode=${rec.paymentMode}`,
    `chainSettled=${rec.chainSettled}`,
    `txHash=${rec.txHash || '(none)'}`,
    `receiptHash=${rec.receiptHash || '(none)'}`,
    `contentHash=${rec.contentHash || '(none)'}`,
    `verificationTrust=${rec.verificationTrust || 'unverified'}`,
    `transactionStatus=${rec.status}`,
  ];
}

export interface BridgeResult { runId?: string; goalId?: string; stepWritten: boolean; evidenceWritten: boolean; goalEvidenceWritten: boolean }

/**
 * 把一笔交易写进 Run (step + evidence) 与 Goal (仅在满足条件时)。
 * @param opts.goalCriteriaHit 资源执行结果是否命中 Goal 判据 (由调用方判定, 默认 false)
 * @param opts.executionOk 资源是否被实际执行且符合契约
 */
export async function bridgeTransactionToRunGoal(
  rec: TransactionRecord,
  opts: { runId?: string; goalId?: string; executionOk?: boolean; goalCriteriaHit?: boolean; summary?: string } = {},
): Promise<BridgeResult> {
  const out: BridgeResult = { runId: opts.runId, goalId: opts.goalId, stepWritten: false, evidenceWritten: false, goalEvidenceWritten: false };
  const lines = transactionEvidenceLines(rec);
  const ok = rec.status === 'verified' || rec.status === 'delivered';

  if (opts.runId) {
    try {
      const step = {
        tool: 'x402_transaction',
        ok,
        summary: `${bridgeEventFor(rec.status)} · ${opts.summary || rec.itemId} (${rec.amount || rec.price || '?'} ${rec.currency || ''} via ${rec.paymentMode})`,
        error: ok ? undefined : (rec.failureReason || rec.status),
        args: { itemId: rec.itemId, amount: rec.amount, currency: rec.currency, network: rec.network, requestId: rec.requestId },
      };
      await recordStep(opts.runId, step as any);
      out.stepWritten = true;
      await addRunEvidence(opts.runId, lines);
      out.evidenceWritten = true;
    } catch { /* 记账失败不改变交易事实, 但上面会让 out.* 保持 false (调用方可见) */ }
  }

  // Goal 侧: 只有 verified + 执行成功 + 命中判据 才计入成功证据
  if (opts.goalId) {
    const eligible = rec.status === 'verified' && opts.executionOk === true && opts.goalCriteriaHit === true;
    try {
      if (eligible) {
        await addGoalEvidenceViaStore(opts.goalId, [
          `付费资源已执行并命中判据: ${lines.join(' ')}`,
        ]);
        out.goalEvidenceWritten = true;
      } else if (rec.status === 'verified') {
        await addGoalEvidenceViaStore(opts.goalId, [
          `付费资源已验证但未命中判据 (不满足完成条件): ${lines.join(' ')}`,
        ]);
      } else {
        await addGoalEvidenceViaStore(opts.goalId, [
          `交易未成立 (${rec.status}): ${lines.join(' ')}`,
        ]);
      }
    } catch { /* 同上 */ }
  }
  return out;
}
