/**
 * milestone-settlement.ts — 里程碑结算 / 争议 / 责任落地 (Phase 4, 2026-09-18)
 *
 * leo 的 Phase 4:
 *   4.1 **PartiallySettled**: 分阶段服务按里程碑结算 (第一版只支持明确里程碑)
 *       每里程碑: milestoneId / amount / paymentStatus / deliveryStatus / verificationStatus / evidence
 *       规则: 部分成功 → partially_settled; 全部支付且全部交付验证 → verified; 任一交付失败 → disputed 或 delivery_failed
 *       ★ `partially_settled` **不许**直接进 Goal 成功证据
 *   4.2 **争议**: disputed / refund_pending / refunded; 争议必须绑定
 *       原始报价 · Payment Header · facilitator response · txHash · 内容哈希 · 签名信封 · Run step · Goal evidence · 失败时点 · 责任候选
 *       三条禁令: 不能自动重付 · 不能标 verified · **不能静默关闭**
 *   4.3 **责任判定**: 机器只给候选 (Phase 0 的 deriveResponsibility), 候选连同证据进交易记录 + Run/Goal 证据
 */

import type { TransactionRecord } from './transaction-protocol.js';
import { deriveResponsibility, type ResponsibilityCandidate, type ResponsibilityEvidence } from './settlement-state.js';

// ── 4.1 里程碑结算 ─────────────────────────────────────────────────────────

export type MilestonePaymentStatus = 'unpaid' | 'payment_submitted' | 'paid';
export type MilestoneDeliveryStatus = 'pending' | 'delivered' | 'failed';
export type MilestoneVerificationStatus = 'pending' | 'verified' | 'failed';

export interface TransactionMilestone {
  milestoneId: string;
  title: string;
  /** USDC 原子单位 (字符串, 避免浮点) */
  amount: string;
  paymentStatus: MilestonePaymentStatus;
  deliveryStatus: MilestoneDeliveryStatus;
  verificationStatus: MilestoneVerificationStatus;
  evidence: string[];
  updatedAt: string;
}

export interface MilestoneAggregate {
  total: number;
  paid: number;
  delivered: number;
  verified: number;
  failed: number;
  /** 全部里程碑都完成 (支付 + 交付 + 验真) */
  allComplete: boolean;
  /** 有完成但没全完成 */
  partiallyComplete: boolean;
  nextMilestoneId?: string;
  settlementFact: 'unpaid' | 'payment_submitted' | 'partially_settled' | 'fully_settled';
  /** 任一里程碑交付失败 → 该进争议 */
  shouldDispute: boolean;
  reason: string;
}

/** 里程碑的不变式: 金额必须是正整数原子单位字符串 (不许浮点/负数/空) */
export function validateMilestoneSpec(m: { milestoneId: string; title?: string; amount: string }): { ok: boolean; reason?: string } {
  if (!m.milestoneId) return { ok: false, reason: 'milestoneId 不能为空' };
  if (!/^\d+$/.test(String(m.amount))) return { ok: false, reason: `amount 必须是正整数原子单位字符串, 实际: ${m.amount}` };
  if (Number(m.amount) <= 0) return { ok: false, reason: 'amount 必须大于 0' };
  return { ok: true };
}

export function makeMilestone(m: { milestoneId: string; title: string; amount: string }): TransactionMilestone {
  const chk = validateMilestoneSpec(m);
  if (!chk.ok) throw new Error(chk.reason);
  return {
    milestoneId: m.milestoneId, title: m.title, amount: String(m.amount),
    paymentStatus: 'unpaid', deliveryStatus: 'pending', verificationStatus: 'pending',
    evidence: [], updatedAt: new Date().toISOString(),
  };
}

/** 里程碑总金额必须等于交易金额 (否则就是账不平) */
export function milestonesMatchAmount(ms: TransactionMilestone[], amount?: string): { ok: boolean; sum: string; reason?: string } {
  const sum = ms.reduce((a, m) => a + BigInt(m.amount || '0'), 0n).toString();
  if (amount && String(amount) !== sum) return { ok: false, sum, reason: `里程碑金额合计 ${sum} ≠ 交易金额 ${amount}` };
  return { ok: true, sum };
}

export function aggregateMilestones(ms: TransactionMilestone[] | undefined): MilestoneAggregate {
  const list = ms || [];
  const paid = list.filter((m) => m.paymentStatus === 'paid').length;
  const delivered = list.filter((m) => m.deliveryStatus === 'delivered').length;
  const verified = list.filter((m) => m.verificationStatus === 'verified').length;
  const failed = list.filter((m) => m.deliveryStatus === 'failed' || m.verificationStatus === 'failed').length;
  const allComplete = list.length > 0 && verified === list.length;
  const anyProgress = paid > 0 || delivered > 0 || verified > 0;
  const partiallyComplete = anyProgress && !allComplete && failed === 0;
  const next = list.find((m) => m.verificationStatus !== 'verified' && m.deliveryStatus !== 'failed');

  let settlementFact: MilestoneAggregate['settlementFact'] = 'unpaid';
  if (allComplete) settlementFact = 'fully_settled';
  else if (partiallyComplete) settlementFact = 'partially_settled';
  else if (paid > 0 || delivered > 0) settlementFact = 'payment_submitted';

  const shouldDispute = failed > 0;
  const reason = shouldDispute
    ? `${failed} 个里程碑交付/验真失败 → 进争议 (不许静默关闭)`
    : allComplete ? '全部里程碑支付+交付+验真完成'
    : partiallyComplete ? `${verified}/${list.length} 个里程碑完成 → partially_settled (不算完成, 也不进 Goal 成功证据)`
    : list.length === 0 ? '没有里程碑 (单笔交易)' : '还没有里程碑完成';

  return { total: list.length, paid, delivered, verified, failed, allComplete, partiallyComplete, nextMilestoneId: next?.milestoneId, settlementFact, shouldDispute, reason };
}

/** 应用一个里程碑结果并给出应落的结算事实 (纯函数; 落盘由调用方做, 保证可测) */
export function applyMilestoneResult(
  ms: TransactionMilestone[],
  milestoneId: string,
  result: { paymentStatus?: MilestonePaymentStatus; deliveryStatus?: MilestoneDeliveryStatus; verificationStatus?: MilestoneVerificationStatus; evidence?: string[] },
): { milestones: TransactionMilestone[]; aggregate: MilestoneAggregate; ok: boolean; reason?: string } {
  const list = (ms || []).map((m) => ({ ...m, evidence: [...(m.evidence || [])] }));
  const target = list.find((m) => m.milestoneId === milestoneId);
  if (!target) return { milestones: list, aggregate: aggregateMilestones(list), ok: false, reason: `没有这个里程碑: ${milestoneId}` };
  if (result.paymentStatus) target.paymentStatus = result.paymentStatus;
  if (result.deliveryStatus) target.deliveryStatus = result.deliveryStatus;
  if (result.verificationStatus) target.verificationStatus = result.verificationStatus;
  if (result.evidence?.length) target.evidence.push(...result.evidence);
  target.updatedAt = new Date().toISOString();
  return { milestones: list, aggregate: aggregateMilestones(list), ok: true };
}

// ── 4.2 争议 (绑定证据 + 三条禁令) ──────────────────────────────────────────

/** 争议必须绑定的证据 (缺哪项都要显式记下来, 不许"看着像争议就开") */
export interface DisputeEvidence {
  quote?: { payTo?: string; amount?: string; currency?: string; network?: string; itemId?: string };
  paymentHeaderDigest?: string;
  facilitatorResponse?: string;
  txHash?: string;
  contentHash?: string;
  envelopeDigest?: string;
  runId?: string;
  runStep?: string;
  goalId?: string;
  goalEvidence?: string[];
  failurePoint?: string;
  responsibility?: ResponsibilityCandidate;
}

export interface DisputeRecord {
  openedAt: string;
  reason: string;
  evidence: DisputeEvidence;
  /** 缺哪些证据 (不阻塞开争议, 但必须显式列出 —— 后续人工/仲裁要看到缺口) */
  missingEvidence: string[];
  /** 禁令审计: 争议期间必须为 true */
  mustNotRepay: true;
  resolution?: { decision: 'refund' | 'release'; at: string; by: string; reason: string; evidence: string[] };
}

const REQUIRED_EVIDENCE_FIELDS: Array<keyof DisputeEvidence> = [
  'quote', 'txHash', 'contentHash', 'envelopeDigest', 'failurePoint',
];

/** 开争议: 记录绑定的证据 + 缺口; 生命周期进 disputed (自动化到此为止) */
export function buildDispute(opts: {
  reason: string;
  evidence: DisputeEvidence;
  responsibilityEvidence?: ResponsibilityEvidence;
}): DisputeRecord {
  const missing = REQUIRED_EVIDENCE_FIELDS.filter((f) => {
    const v = (opts.evidence as any)[f];
    if (v === undefined || v === null) return true;
    if (typeof v === 'string') return v.trim().length === 0;
    if (Array.isArray(v)) return v.length === 0;
    if (typeof v === 'object') return Object.values(v).every((x) => x === undefined || x === null || x === '');
    return false;
  }) as string[];
  const responsibility = opts.evidence.responsibility
    || (opts.responsibilityEvidence ? deriveResponsibility(opts.responsibilityEvidence) : undefined);
  return {
    openedAt: new Date().toISOString(),
    reason: opts.reason,
    evidence: { ...opts.evidence, responsibility },
    missingEvidence: missing,
    mustNotRepay: true,
  };
}

/** 争议禁令的唯一实现在 settlement-state (`disputeForbids`), 这里只做转发, 避免两份判断漂移 */
export { disputeForbids } from './settlement-state.js';

/** 争议收尾: 必须带决定 + 依据 + 证据 (退款走结算层 refund_pending → refunded) */
export function resolveDispute(rec: TransactionRecord, opts: { decision: 'refund' | 'release'; by: string; reason: string; evidence: string[] }): DisputeRecord {
  if (!rec.dispute) throw new Error('这笔交易没有争议记录');
  if (!opts.evidence?.length) throw new Error('争议收尾必须带证据 (不许无凭据关闭)');
  return {
    ...rec.dispute,
    resolution: { decision: opts.decision, at: new Date().toISOString(), by: opts.by, reason: opts.reason, evidence: [...opts.evidence] },
  };
}

// ── 4.3 Goal 成功证据的额外门槛 (partially_settled 永远不算) ────────────────

export interface GoalEvidenceEligibility { eligible: boolean; reason: string }

/**
 * 里程碑/争议叠加后的 Goal 成功证据门槛:
 *   交易 verified 或 (全部里程碑完成 + 结算 fully_settled) ∧ 无争议 ∧ 执行成功 ∧ 命中判据
 *   —— `partially_settled` 一律不算 (leo: 不要让 partially_settled 直接进 Goal 成功证据)
 */
export function milestoneGoalEligibility(rec: TransactionRecord, opts: { executionOk?: boolean; goalCriteriaHit?: boolean } = {}): GoalEvidenceEligibility {
  if (rec.dispute && !rec.dispute.resolution) return { eligible: false, reason: '交易在争议中 (未收尾) → 不计入 Goal 成功证据' };
  const agg = aggregateMilestones(rec.milestones);
  if (agg.total > 0) {
    if (agg.shouldDispute) return { eligible: false, reason: '里程碑有失败项 → 需争议处理, 不计入成功证据' };
    if (!agg.allComplete) return { eligible: false, reason: `里程碑未全部完成 (${agg.verified}/${agg.total}) → partially_settled 不计入成功证据` };
  }
  if (rec.settlementFact === 'partially_settled') return { eligible: false, reason: '结算事实是 partially_settled → 不计入成功证据' };
  if (rec.status !== 'verified') return { eligible: false, reason: `交易状态是 ${rec.status}, 不是 verified` };
  if (rec.chainSettled !== true) return { eligible: false, reason: '链上没有真实结算' };
  if (opts.executionOk !== true) return { eligible: false, reason: '资源执行没成功 (买到 ≠ 用上)' };
  if (opts.goalCriteriaHit !== true) return { eligible: false, reason: '没有命中 Goal 判据' };
  return { eligible: true, reason: '链上结算 + 全部里程碑完成 + 无争议 + 执行成功 + 命中判据' };
}
