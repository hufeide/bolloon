/**
 * trade.ts — 最小交易闭环编排 (Phase 1/2/4/5, 2026-09-16)
 *
 * 顺序固定 (不可颠倒):
 *   发现报价 → Policy.check → 允许后才解密钱包 → 允许后才签名 → 发起 x402 支付
 *    → 交付 → 验真 → 记录
 *
 * 任何一步失败都不许"看起来成功": 策略拒绝 → policy_denied (无签名/无链上交易/无扣预算/无交付);
 * 付了钱但交付不合格 → delivery_failed; 交付了但验真不过 → verification_failed。
 */

import * as os from 'os';
import {
  validatePaymentRequirements, evaluateTransactionSuccess, computeReceiptHash,
  type TransactionRecord, type InfoItemMetadata,
} from './transaction-protocol.js';
import { beginTransaction, updateTransaction, setTransactionStatus, readTransaction, findByRequestId } from './transaction-store.js';

export interface TradeParams {
  url: string;
  requestId: string;
  buyerDid: string;
  /** 钱包私钥 (真实支付); 不传则只能 local-dev */
  privateKey?: string;
  allowLocalDev?: boolean;
  maxPaymentAmount?: string;
  network?: string;
  rpcUrl?: string;
  expectItemId?: string;
  expectNetworks?: string[];
  /** 任务预算 (人给的这笔任务最多花多少; 与 policy 的单笔/日限额相互独立) */
  taskBudget?: string;
  goalId?: string;
  runId?: string;
  /** 服务名 (供 policy 服务白名单) */
  service?: string;
  resolveDid?: import('./paid-info-protocol.js').DidKeyResolver;
  fetchImpl?: typeof fetch;
  home?: string;
  /** 注入用: 自定义策略检查 (默认取 getEconomicPolicy) */
  policyCheck?: (intent: { payTo: string; amount: number; service: string }) => Promise<{ allowed: boolean; reason?: string; dailySpent?: number }>;
}

export interface TradeResult {
  ok: boolean;
  status: TransactionRecord['status'];
  transactionId: string;
  record: TransactionRecord;
  verify?: any;
  envelope?: any;
  error?: string;
  /** 是否复用了已有交易 (幂等命中, 没有再付一次钱) */
  reused?: boolean;
}

export async function buyInfoAsTransaction(params: TradeParams): Promise<TradeResult> {
  const home = params.home ?? os.homedir();
  const doFetch = params.fetchImpl ?? fetch;

  // 幂等: 同 requestId 已有交易 → 不再付第二次
  const existing = await findByRequestId(params.requestId, home);
  if (existing && ['settled', 'delivered', 'verified', 'delivery_failed', 'verification_failed'].includes(existing.status)) {
    return { ok: existing.status === 'verified' || existing.status === 'delivered', status: existing.status, transactionId: existing.transactionId, record: existing, reused: true, error: existing.failureReason };
  }

  // ① 免费元数据 (不泄露正文; 用来做 itemId/payTo/network/币种 的预期校验)
  let metadata: Partial<InfoItemMetadata> = {};
  let requirements: any = null;
  let status = 402;
  try {
    const res = await doFetch(params.url, { method: 'GET' });
    status = res.status;
    const body = await res.json().catch(() => null) as any;
    if (res.status === 402) {
      requirements = body?.accepts?.[0] || null;
      // 元数据来源: 显式 metadata/item, 或从 402 要求的 extra 推导 (itemId/providerDid/category)
      metadata = body?.metadata || body?.item || {
        itemId: requirements?.extra?.itemId,
        providerDid: requirements?.extra?.providerDid,
        category: requirements?.extra?.category,
        currency: requirements?.extra?.name,
        network: requirements?.network,
        payTo: requirements?.payTo,
        amount: String(requirements?.amount ?? ''),
      };
    } else if (body && (body.item || body.itemId)) {
      metadata = body.item || body;
    }
  } catch (e: any) {
    const { record } = await beginTransaction({ requestId: params.requestId, metadata: {}, buyerDid: params.buyerDid, goalId: params.goalId, runId: params.runId }, home);
    await setTransactionStatus(record.transactionId, 'failed', `请求失败: ${String(e?.message || e).slice(0, 120)}`, home);
    const rec = await readTransaction(record.transactionId, home);
    return { ok: false, status: 'failed', transactionId: record.transactionId, record: rec!, error: `请求失败: ${String(e?.message || e).slice(0, 160)}` };
  }

  const { record, reused } = await beginTransaction({
    requestId: params.requestId, metadata, buyerDid: params.buyerDid,
    providerDid: metadata.providerDid, goalId: params.goalId, runId: params.runId,
  }, home);
  let rec = record;

  if (status !== 402) {
    // 免费资源: 不算交易成功 (没有付款也就没有"结算")
    rec = (await updateTransaction(rec.transactionId, { status: 'delivered', event: { kind: 'free_resource', detail: `HTTP ${status}` } }, home))!;
    return { ok: true, status: 'delivered', transactionId: rec.transactionId, record: rec, reused };
  }

  // ② 报价自洽校验 (篡改 itemId/amount/payTo/network 一律拒绝)
  const consistency = validatePaymentRequirements({
    requirements,
    metadata,
    expected: { itemId: params.expectItemId, maxAmount: params.maxPaymentAmount, networks: params.expectNetworks },
  });
  if (!consistency.ok) {
    rec = (await setTransactionStatus(rec.transactionId, 'failed', consistency.reason, home))!;
    return { ok: false, status: 'failed', transactionId: rec.transactionId, record: rec, error: consistency.reason };
  }
  rec = (await updateTransaction(rec.transactionId, {
    status: 'quoted', payTo: requirements.payTo, amount: String(requirements.amount), currency: requirements.currency || metadata.currency,
    network: String(requirements.network), contentHash: metadata.contentHash, price: metadata.price,
    event: { kind: 'quoted', detail: `amount=${requirements.amount} payTo=${String(requirements.payTo).slice(0, 10)}…` },
  }, home))!;

  // ③ 策略门 (Phase 2): 必须在解密/签名之前
  const amountDecimal = Number(requirements.amount) / 1e6;
  const service = params.service || 'x402-info';
  let decision: { allowed: boolean; reason?: string; dailySpent?: number };
  try {
    const check = params.policyCheck || (async (intent: any) => {
      const { getEconomicPolicy } = await import('../economic-policy.js');
      return await getEconomicPolicy().check(intent);
    });
    decision = await check({ payTo: String(requirements.payTo), amount: amountDecimal, service });
  } catch (e: any) {
    decision = { allowed: false, reason: `策略引擎不可用 (fail-closed): ${String(e?.message || e).slice(0, 120)}` };
  }
  // 任务预算 (独立于 policy 的第二道闸)
  if (decision.allowed && params.taskBudget !== undefined) {
    const budget = Number(params.taskBudget);
    if (Number.isFinite(budget) && amountDecimal > budget) {
      decision = { allowed: false, reason: `支付金额 ${amountDecimal} 大于任务预算 ${budget}` };
    }
  }
  rec = (await updateTransaction(rec.transactionId, { policyDecision: decision, event: { kind: decision.allowed ? 'policy_allowed' : 'policy_denied', detail: decision.reason } }, home))!;
  if (!decision.allowed) {
    rec = (await setTransactionStatus(rec.transactionId, 'policy_denied', decision.reason, home))!;
    return { ok: false, status: 'policy_denied', transactionId: rec.transactionId, record: rec, error: decision.reason || '策略拒绝' };
  }

  // ④ 付款 + 交付 (仍然由 buyInfo 执行; 策略门已过才走到这里)
  const { buyInfo } = await import('./paid-info-store.js');
  const res = await buyInfo({
    url: params.url,
    privateKey: params.privateKey,
    maxPaymentAmount: params.maxPaymentAmount,
    network: params.network,
    rpcUrl: params.rpcUrl,
    allowLocalDev: params.allowLocalDev,
    resolveDid: params.resolveDid,
    expectItemId: params.expectItemId,
    fetchImpl: params.fetchImpl,
    prePayGuard: async () => ({ ok: true }),          // 已在上一步过门 (这里不再重复打分)
    onEvent: async (e) => {
      await updateTransaction(rec.transactionId, {
        ...(e.patch || {}),
        event: { kind: e.kind, detail: e.detail },
      } as any, home);
    },
  });

  rec = (await readTransaction(rec.transactionId, home))!;

  if (!res.ok) {
    const next = res.policyDenied ? 'policy_denied' : 'failed';
    rec = (await setTransactionStatus(rec.transactionId, next as any, res.error, home))!;
    return { ok: false, status: rec.status, transactionId: rec.transactionId, record: rec, error: res.error };
  }

  // ⑤ 交付与验真绑定 (支付成功 ≠ 交易成功)
  const envelope: any = res.envelope || null;
  const content = String(envelope?.content ?? envelope?.body ?? '');
  // 用协议同一套规范化哈希 (与卖方 contentHash 可比), 不是裸 sha256
  const { computeContentHash } = await import('./paid-info-protocol.js');
  const deliveryHash = computeContentHash(content);
  const receiptStr = res.payment?.receipt || '';
  rec = (await updateTransaction(rec.transactionId, {
    deliveryHash,
    contentHash: envelope?.contentHash || envelope?.proof?.payload?.contentHash || envelope?.proof?.contentHash || rec.contentHash,
    receiptHash: receiptStr ? computeReceiptHash(receiptStr) : undefined,
    verificationTrust: (res.verify?.trust as any) || 'unverified',
    protocolVerified: res.verify?.trust === 'verified',
    event: { kind: 'delivery_hash', detail: `deliveryHash=${deliveryHash.slice(0, 12)}… trust=${res.verify?.trust || 'unverified'}` },
  }, home))!;

  if (!content) {
    rec = (await setTransactionStatus(rec.transactionId, 'delivery_failed', '付了钱但没拿到正文', home))!;
    return { ok: false, status: 'delivery_failed', transactionId: rec.transactionId, record: rec, verify: res.verify, error: '付了钱但没拿到正文' };
  }
  if (rec.contentHash && deliveryHash !== rec.contentHash) {
    rec = (await setTransactionStatus(rec.transactionId, 'verification_failed', '内容哈希不匹配 (内容被换过)', home))!;
    return { ok: false, status: 'verification_failed', transactionId: rec.transactionId, record: rec, verify: res.verify, error: '内容哈希不匹配' };
  }
  if (!rec.receiptHash) {
    rec = (await setTransactionStatus(rec.transactionId, 'verification_failed', '缺少支付回执 (回执与信封未绑定)', home))!;
    return { ok: false, status: 'verification_failed', transactionId: rec.transactionId, record: rec, verify: res.verify, error: '缺少支付回执' };
  }
  if ((rec.verificationTrust || 'unverified') === 'unverified') {
    rec = (await setTransactionStatus(rec.transactionId, 'verification_failed', `验真不通过 (${res.verify?.trust})`, home))!;
    return { ok: false, status: 'verification_failed', transactionId: rec.transactionId, record: rec, verify: res.verify, error: `验真不通过: ${res.verify?.trust}` };
  }

  // ⑥ 终态: 链上结算 + 全部条件 → verified; 本机联调 → delivered (明确不许冒充 verified)
  const verdict = evaluateTransactionSuccess({ ...rec, status: 'delivered' });
  const finalStatus: TransactionRecord['status'] = verdict.success ? 'verified' : 'delivered';
  rec = (await setTransactionStatus(rec.transactionId, finalStatus, verdict.reason, home))!;
  return { ok: true, status: finalStatus, transactionId: rec.transactionId, record: rec, verify: res.verify, envelope, reused };
}
