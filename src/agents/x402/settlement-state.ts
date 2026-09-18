/**
 * settlement-state.ts — 交易的两层状态 + 结算事实 + 责任候选 (Phase 0 冻结, 2026-09-18)
 *
 * leo 的规格 (`docs/design-layer2.md` + 2026-09-18 交易闭环完成批次):
 *   生命周期 (这笔交易走到哪一步) 与 **结算事实** (钱到底动没动) 必须**分开记**,
 *   否则表达不了这些真实组合:
 *     `paying + payment_submitted`       → 发出去了, 还没有回执
 *     `settled + fully_settled`          → 钱真到了, 但正文还没验
 *     `settled + unknown`                → facilitator 说成了, 链上还没确认
 *     `delivery_failed + fully_settled`  → 钱付了, 正文没交 → 不能重付, 只能追责
 *
 * 三条不可混淆的红线:
 *   ① `local-dev` 永远不能产生 `fully_settled` (链上没动过钱)
 *   ② `chainSettled !== true` 永远不能 `verified`
 *   ③ 非法状态迁移**拒绝**并给出原因, **不静默修正**
 */

import * as fs from 'fs';
import * as path from 'path';
import { sha256Hex } from './paid-info-protocol.js';
import type { TransactionRecord } from './transaction-protocol.js';

// ── ① 生命周期 (10 态; 与 transaction-protocol 的 status 同一层) ─────────────

export const LIFECYCLE_STATUSES = [
  'discovered',
  'quoted',
  'policy_denied',
  'payment_required',
  'paying',
  'settled',
  'delivered',
  'verified',
  'delivery_failed',
  'verification_failed',
] as const;
export type LifecycleStatus = typeof LIFECYCLE_STATUSES[number];

/** 旧记录里可能存在、仍必须可读的状态 (迁移时保留原值, 不假装它从没出现过) */
export const LEGACY_STATUSES = ['failed'] as const;
export type LegacyStatus = typeof LEGACY_STATUSES[number];

export function isLifecycleStatus(v: unknown): v is LifecycleStatus {
  return typeof v === 'string' && (LIFECYCLE_STATUSES as readonly string[]).includes(v);
}
export function isKnownStatus(v: unknown): boolean {
  return isLifecycleStatus(v) || (typeof v === 'string' && (LEGACY_STATUSES as readonly string[]).includes(v));
}

/** 终态: 走进去就不再自动变化 (delivery_failed 不是"还能重付"的意思) */
export const TERMINAL_LIFECYCLE: LifecycleStatus[] = ['verified', 'delivery_failed', 'verification_failed', 'policy_denied'];

/**
 * 允许的迁移表。没列出来的**一律拒绝**。
 * 特别注意两条容易走错的:
 *   - `paying → payment_required` 只在对账确认"没有支付证据"时允许 (回退重试的唯一合法路径)
 *   - `delivery_failed`/`verification_failed` 不能回到 `paying` (钱已经付过了)
 */
const LIFECYCLE_TRANSITIONS: Record<string, string[]> = {
  // 免费资源没有付款环节 → discovered 可直接 delivered (但永远不会 verified)
  discovered: ['quoted', 'delivered', 'failed', 'policy_denied'],
  quoted: ['paying', 'payment_required', 'delivered', 'failed', 'policy_denied'],
  policy_denied: [],
  payment_required: ['paying', 'failed', 'policy_denied'],
  // 付款中 → 结算/交付/验真各结果, 或"对账发现没付过"退回 payment_required
  paying: ['settled', 'delivered', 'verified', 'delivery_failed', 'verification_failed', 'payment_required', 'failed'],
  settled: ['delivered', 'verified', 'delivery_failed', 'verification_failed'],
  delivered: ['verified', 'delivery_failed', 'verification_failed'],
  verified: [],
  delivery_failed: [],
  verification_failed: [],
  failed: [],           // 旧状态: 终态
};

export interface TransitionCheck { ok: boolean; reason?: string; noop?: boolean }

export function canTransitionLifecycle(from: string, to: string): TransitionCheck {
  if (!isKnownStatus(from)) return { ok: false, reason: `当前状态不可识别: ${from}` };
  if (!isKnownStatus(to)) return { ok: false, reason: `目标状态不可识别: ${to}` };
  if (from === to) return { ok: true, noop: true };
  const allowed = LIFECYCLE_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    const why = TERMINAL_LIFECYCLE.includes(from as LifecycleStatus) ? ` (${from} 是终态, 不许再变)` : '';
    return { ok: false, reason: `非法迁移 ${from} → ${to}${why}; 允许: ${allowed.length ? allowed.join(', ') : '(无, 终态)'}` };
  }
  return { ok: true };
}

/** 这笔记录是否**已经有支付证据** (付过钱 / 可能付过钱) */
export function hasPaymentEvidence(rec: Partial<TransactionRecord>): boolean {
  if (rec.chainSettled === true) return true;
  if (rec.txHash || rec.paymentReceipt) return true;
  const fact = String(rec.settlementFact || '');
  if (isSettlementFact(fact) && fact !== 'unpaid' && fact !== 'unknown') return true;
  return false;
}

/** verified 的**硬证据**子集 (完整门见 evaluateVerifiedGate: 还要求正文在盘上 + 执行 + 判据) */
export function checkVerifiedPreconditions(rec: TransactionRecord): TransitionCheck {
  if (rec.chainSettled !== true) return { ok: false, reason: 'chainSettled !== true: 链上没有真实结算, 不能判 verified (联调最高 delivered)' };
  if (rec.protocolVerified !== true) return { ok: false, reason: 'protocolVerified !== true: 协议验真未通过' };
  if (!rec.contentHash || !rec.deliveryHash) return { ok: false, reason: '缺少内容哈希或交付哈希' };
  if (rec.contentHash !== rec.deliveryHash) return { ok: false, reason: '内容哈希与交付哈希不一致 (内容被换过)' };
  if (!rec.receiptHash) return { ok: false, reason: '缺少支付回执哈希 (回执与信封未绑定)' };
  const fact = String(rec.settlementFact || '');
  if (fact && fact !== 'fully_settled' && fact !== 'partially_settled') {
    return { ok: false, reason: `结算事实是 ${fact}, 不足以判 verified` };
  }
  return { ok: true };
}

/**
 * 记录级的迁移许可 (在 from→to 表之上再加两条安全规则):
 *   ① 已经有支付证据的交易**不许**被标成普通 `failed` (钱不能凭空消失) → 该记 delivery_failed / verification_failed, 或回 payment_required 走对账
 *   ② 目标 `verified` 必须过硬证据子集 (链上结算 + 协议验真 + 哈希 + 回执绑定)
 */
export function checkLifecycleMove(rec: TransactionRecord, to: string): TransitionCheck {
  const base = canTransitionLifecycle(String(rec.status), to);
  if (!base.ok) return base;
  if (base.noop) return base;
  if (to === 'failed' && hasPaymentEvidence(rec)) {
    return { ok: false, reason: '这笔交易已有支付证据 (txHash/回执/链上结算) → 不许标成普通 failed; 应付交付失败用 delivery_failed, 验真失败用 verification_failed, 状态不明先回 payment_required 对账' };
  }
  if (to === 'verified') {
    const pre = checkVerifiedPreconditions(rec);
    if (!pre.ok) return pre;
  }
  return { ok: true };
}

// ── ② 结算事实 (钱动没动; 与生命周期分开记) ──────────────────────────────────

export const SETTLEMENT_FACTS = [
  'unpaid',
  'payment_submitted',
  'payment_verified',
  'partially_settled',
  'fully_settled',
  'refund_pending',
  'refunded',
  'unknown',
] as const;
export type SettlementFact = typeof SETTLEMENT_FACTS[number];

export function isSettlementFact(v: unknown): v is SettlementFact {
  return typeof v === 'string' && (SETTLEMENT_FACTS as readonly string[]).includes(v);
}

const SETTLEMENT_TRANSITIONS: Record<string, string[]> = {
  unpaid: ['payment_submitted', 'unknown'],
  payment_submitted: ['payment_verified', 'partially_settled', 'unpaid', 'unknown'],
  payment_verified: ['fully_settled', 'partially_settled', 'refund_pending', 'unknown'],
  partially_settled: ['fully_settled', 'refund_pending', 'unknown'],
  fully_settled: ['refund_pending'],
  refund_pending: ['refunded', 'fully_settled'],
  refunded: [],
  unknown: ['unpaid', 'payment_submitted', 'payment_verified', 'partially_settled', 'fully_settled', 'refund_pending'],
};

/** 只有真链上/facilitator 确认过的结算事实 */
export const CHAIN_BACKED_FACTS: SettlementFact[] = ['payment_verified', 'partially_settled', 'fully_settled'];
/** local-dev 能到的最高结算事实 (模拟提交 ≠ 链上事实) */
export const LOCAL_DEV_MAX_FACT: SettlementFact = 'payment_submitted';

export function canTransitionSettlement(
  from: string,
  to: string,
  opts: { paymentMode?: string; chainSettled?: boolean; txHash?: string } = {},
): TransitionCheck {
  if (!isSettlementFact(from)) return { ok: false, reason: `当前结算事实不可识别: ${from}` };
  if (!isSettlementFact(to)) return { ok: false, reason: `目标结算事实不可识别: ${to}` };
  if (from === to) return { ok: true, noop: true };
  if (opts.paymentMode === 'local-dev' && CHAIN_BACKED_FACTS.includes(to)) {
    return { ok: false, reason: `本机联调 (local-dev) 不能产生 ${to}: 链上没有真实结算, 联调最高只能是 ${LOCAL_DEV_MAX_FACT}` };
  }
  const allowed = SETTLEMENT_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    // 例外: 对账时拿到**链上事实** (txHash + chainSettled) 可以一步到位 fully_settled, 不必绕 payment_verified
    const chainProof = opts.chainSettled === true && !!opts.txHash;
    if (to === 'fully_settled' && chainProof && !CHAIN_BACKED_FACTS.includes(from as SettlementFact)) {
      return { ok: true };
    }
    return { ok: false, reason: `非法结算迁移 ${from} → ${to}; 允许: ${allowed.length ? allowed.join(', ') : '(无, 终态)'}${to === 'fully_settled' ? ' (一步到 fully_settled 需要链上证据: chainSettled=true + txHash)' : ''}` };
  }
  return { ok: true };
}

/**
 * 从记录既有证据**推导**结算事实 (给老记录迁移用; 不猜没有证据的事)。
 * 推导不出确定事实时给 `unknown` —— 诚实表达"不知道钱动没动"。
 */
export function deriveSettlementFact(rec: Partial<TransactionRecord>): SettlementFact {
  const paid = ['paying', 'settled', 'delivered', 'verified', 'delivery_failed', 'verification_failed'].includes(String(rec.status));
  if (rec.paymentMode === 'local-dev') {
    // 联调: 有付款动作 → 最高只认"提交过(模拟)"; 没有 → 未付
    return paid && (rec.paymentReceipt || rec.txHash) ? LOCAL_DEV_MAX_FACT : (paid ? 'unknown' : 'unpaid');
  }
  if (rec.chainSettled === true) return String(rec.status) === 'verified' ? 'fully_settled' : 'payment_verified';
  if (rec.txHash || rec.paymentReceipt) return 'payment_submitted';
  if (String(rec.status) === 'paying') return 'unknown';      // 付过没付过不知道 → 先对账
  return 'unpaid';
}

// ── ③ 责任候选 (机器只给候选, 不做最终赔偿判决) ─────────────────────────────

export const RESPONSIBILITY_TYPES = [
  'provider_fault',
  'buyer_fault',
  'agent_fault',
  'platform_fault',
  'payment_infrastructure_fault',
  'undetermined',
] as const;
export type ResponsibilityType = typeof RESPONSIBILITY_TYPES[number];

export interface ResponsibilityCandidate {
  type: ResponsibilityType;
  reason: string;
  /** 判据来自哪些证据 (审计要能回溯) */
  evidence: string[];
}

export interface ResponsibilityEvidence {
  /** 收到的正文哈希 vs 卖方声明 */
  deliveryHashMismatch?: boolean;
  /** 卖方签名/信封校验 */
  signatureInvalid?: boolean;
  /** 输入不符合 inputSchema (Schema 校验结果) */
  inputSchemaViolation?: boolean;
  /** agent 越过 Policy 就付款了 */
  policyBypassed?: boolean;
  /** 交易记录丢失 / 重复扣款 */
  ledgerLostOrDoubleCharged?: boolean;
  /** facilitator / RPC 状态异常 */
  providerInfrastructureUnhealthy?: boolean;
  /** 缺少支付回执 (回执与信封未绑定) → 支付基础设施侧证据缺失 */
  receiptMissing?: boolean;
  /** 付了钱但没拿到正文 (可能是传输, 也可能是卖方没交 → 证据不足, 不硬归责) */
  deliveryMissing?: boolean;
  /** 资源执行结果 */
  executionFailed?: boolean;
  /** 输出不符合资源契约 (卖方交付物本身不合格 → 卖方责任) */
  outputSchemaViolation?: boolean;
}

/**
 * 顺序即优先级: 先看"谁给的东西不对"(卖方), 再看"买方/agent 做错了什么",
 * 再看基础设施, 最后证据不足认 `undetermined` —— 不许在证据不足时随便归责。
 */
export function deriveResponsibility(ev: ResponsibilityEvidence): ResponsibilityCandidate {
  const hits: string[] = [];
  if (ev.deliveryHashMismatch) { hits.push('deliveryHashMismatch'); }
  if (ev.signatureInvalid) { hits.push('signatureInvalid'); }
  if (ev.outputSchemaViolation) { hits.push('outputSchemaViolation'); }
  if (hits.length) {
    return {
      type: 'provider_fault',
      reason: `卖方交付物与声明不一致 (${hits.join(', ')})`,
      evidence: hits,
    };
  }
  if (ev.inputSchemaViolation) {
    return { type: 'buyer_fault', reason: '输入不符合资源 inputSchema', evidence: ['inputSchemaViolation'] };
  }
  if (ev.policyBypassed) {
    return { type: 'agent_fault', reason: 'agent 越过 Policy 付款/执行', evidence: ['policyBypassed'] };
  }
  if (ev.receiptMissing) {
    return { type: 'payment_infrastructure_fault', reason: '缺少支付回执 (回执与信封未绑定)', evidence: ['receiptMissing'] };
  }
  if (ev.ledgerLostOrDoubleCharged) {
    return { type: 'platform_fault', reason: '交易记录丢失或重复扣款', evidence: ['ledgerLostOrDoubleCharged'] };
  }
  if (ev.providerInfrastructureUnhealthy) {
    return { type: 'payment_infrastructure_fault', reason: 'facilitator / RPC 状态异常', evidence: ['providerInfrastructureUnhealthy'] };
  }
  if (ev.deliveryMissing) {
    return { type: 'undetermined', reason: '付了钱但没拿到正文: 传输或卖方未交付, 证据不足以定责', evidence: ['deliveryMissing'] };
  }
  if (ev.executionFailed) {
    // 执行失败但交付物本身合契约 → 不足以归责卖方, 给不确定
    return { type: 'undetermined', reason: '资源执行失败, 但证据不足以判归属', evidence: ['executionFailed'] };
  }
  return { type: 'undetermined', reason: '证据不足, 不做归责', evidence: [] };
}

// ── ④ 正文实体 (验真要能重新算哈希, 不是信一个布尔) ────────────────────────

export function deliveriesDir(home: string): string {
  return path.join(home, '.bolloon', 'x402', 'deliveries');
}
function deliveryPath(transactionId: string, home: string): string {
  return path.join(deliveriesDir(home), `${transactionId}.txt`);
}

/** 交付正文落盘 (验真时重算哈希; 正文不进交易记录, 只进哈希与路径) */
export function writeDeliveryContent(transactionId: string, content: string, home: string): { path: string; hash: string; bytes: number } {
  const dir = deliveriesDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const p = deliveryPath(transactionId, home);
  const body = String(content ?? '');
  fs.writeFileSync(p, body, 'utf8');
  return { path: p, hash: sha256Hex(body), bytes: Buffer.byteLength(body, 'utf8') };
}

export function readDeliveryContent(transactionId: string, home: string): string | null {
  try { return fs.readFileSync(deliveryPath(transactionId, home), 'utf8'); } catch { return null; }
}

export interface DeliveryVerification { present: boolean; bytes?: number; bytesHash?: string; matchesRecorded: boolean; reason?: string }

/**
 * 正文真的在盘上, 且与我们交付时记下的**字节哈希**一致 (验真时重算, 不信记录里的自述)。
 * 注意: 协议层的 contentHash/deliveryHash 是规范化哈希 (computeContentHash), 与字节哈希是两套,
 * 各自独立校验, 不互相冒充。
 */
export function verifyDelivery(rec: TransactionRecord, home: string): DeliveryVerification {
  const body = readDeliveryContent(rec.transactionId, home);
  if (body === null) return { present: false, matchesRecorded: false, reason: '交付正文不在盘上 (没交付, 或被删)' };
  const bytesHash = sha256Hex(body);
  const bytes = Buffer.byteLength(body, 'utf8');
  const recorded = (rec as any).deliveryBytesHash as string | undefined;
  if (!recorded) return { present: true, bytes, bytesHash, matchesRecorded: false, reason: '记录里没有交付字节哈希 (无法证明盘上正文就是当时交付的那份)' };
  if (recorded !== bytesHash) return { present: true, bytes, bytesHash, matchesRecorded: false, reason: `盘上正文哈希 ${bytesHash.slice(0, 12)}… ≠ 交付时记录 ${String(recorded).slice(0, 12)}…` };
  return { present: true, bytes, bytesHash, matchesRecorded: true };
}

// ── ⑤ 最终 verified 门 (八项全满足才算) ─────────────────────────────────────

export interface ExecutionEvidence {
  ok: boolean;
  tool?: string;
  startedAt?: string;
  durationMs?: number;
  /** 执行输出的哈希 (可与交付正文不同: 执行产物是另一份东西) */
  outputHash?: string;
  /** 输出满足资源 outputSchema */
  schemaOk?: boolean;
  /** 来源/证据字段齐全 */
  sourceDeclared?: boolean;
  reason?: string;
}

export interface VerifiedGateResult { verified: boolean; missing: string[]; reason: string }

export interface VerifiedGateInput {
  rec: TransactionRecord;
  home: string;
  /** 资源是否被真实执行过 (Phase 2 的产物) */
  execution?: ExecutionEvidence | null;
  /** Goal 判据是否命中 (Phase 2 与 Goal 联动) */
  goalCriteriaMet?: boolean;
}

/**
 * leo 的最终门: chainSettled + protocolVerified + 正文在 + 哈希对 + 回执绑定
 *              + 资源执行成功 + 输出满足契约 + Goal 判据命中
 */
export function evaluateVerifiedGate(input: VerifiedGateInput): VerifiedGateResult {
  const { rec, home } = input;
  const missing: string[] = [];
  if (rec.chainSettled !== true) missing.push('chainSettled !== true (链上没有真实结算)');
  if (rec.protocolVerified !== true) missing.push('protocolVerified !== true (协议验真没过)');
  const delivery = verifyDelivery(rec, home);
  if (!delivery.present) missing.push('交付正文不存在');
  else if (!delivery.matchesRecorded) missing.push(`交付正文与交付时记录不一致 (${delivery.reason})`);
  if (!rec.receiptHash) missing.push('缺少支付回执哈希 (回执与信封未绑定)');
  if (rec.settlementFact && rec.settlementFact !== 'fully_settled' && rec.settlementFact !== 'partially_settled') {
    missing.push(`结算事实是 ${rec.settlementFact}, 不足以判 verified`);
  }
  // 显式传 null = 调用方明确说"这次没有执行证据"; 传 undefined = 用记录里已有的
  const ex = input.execution !== undefined ? input.execution : ((rec as any).execution ?? null);
  if (!ex) missing.push('没有资源执行证据');
  else {
    if (ex.ok !== true) missing.push(`资源执行失败${ex.reason ? ` (${ex.reason})` : ''}`);
    if (ex.schemaOk !== true) missing.push('资源输出不满足 outputSchema');
  }
  if (input.goalCriteriaMet !== true) missing.push('Goal 判据未命中');
  if (missing.length) return { verified: false, missing, reason: `未达 verified: ${missing[0]}` };
  return { verified: true, missing: [], reason: '链上结算 + 协议验真 + 正文匹配 + 回执绑定 + 资源执行成功 + 输出合契约 + Goal 判据命中' };
}

// ── ⑥ 迁移 (老记录 → 两层; 事件与证据一个不丢) ──────────────────────────────

export const CURRENT_SCHEMA_VERSION = 2;

export interface MigrationResult { record: TransactionRecord; changed: boolean; note?: string }

/**
 * 幂等迁移: 补齐 `settlementFact` / `responsibility` / `schemaVersion`,
 * 保留原 `status` 与**全部** events/evidence, 并追加一条 `migrate-v2` 事件说明推导来源。
 * 不覆盖任何已有字段 (除了补默认值)。
 */
export function migrateTransactionRecord(input: TransactionRecord): MigrationResult {
  const rec: any = { ...input, events: Array.isArray(input.events) ? [...input.events] : [] };
  const before = input.schemaVersion;
  if (before === CURRENT_SCHEMA_VERSION && isSettlementFact(rec.settlementFact)) {
    return { record: rec as TransactionRecord, changed: false };
  }
  const derived = isSettlementFact(rec.settlementFact) ? rec.settlementFact : deriveSettlementFact(rec);
  rec.settlementFact = derived;
  rec.schemaVersion = CURRENT_SCHEMA_VERSION;
  // 责任候选留空: 没有证据就不写归责 (迁移只补"结算事实"这一层)
  const detail = before === undefined
    ? `老记录迁移: 按既有证据推导结算事实 = ${derived} (status=${rec.status}, chainSettled=${rec.chainSettled === true}, mode=${rec.paymentMode})`
    : `schema ${before} → ${CURRENT_SCHEMA_VERSION}: 结算事实 = ${derived}`;
  rec.events.push({ at: new Date().toISOString(), kind: 'migrate-v2', detail });
  return { record: rec as TransactionRecord, changed: true, note: detail };
}
