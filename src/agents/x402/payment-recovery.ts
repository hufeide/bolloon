/**
 * payment-recovery.ts — 支付中断恢复 (Phase 3, 2026-09-18)
 *
 * leo 的硬规则, 决定了这一层的全部逻辑:
 *   `payment uncertain ≠ payment failed`   —— 不确定时不许当失败处理
 *   `payment failed ≠ safe to retry`       —— 失败也不等于可以重付
 *   先 reconcile, 再决定 retry
 *
 * 五个 SIGKILL 时点 (恢复后必须各自走对路):
 *   ① 付款前               → 状态仍是 quoted/payment_required, 可安全付款, 不重复付
 *   ② 拿到付款权后         → 旧 claim 因进程死亡可回收, 新 worker 接管, 不会两个 worker 同时付
 *   ③ facilitator settle 后→ 重启用**真实 txHash/结算事实**续上, 禁止重付, 继续交付与验真
 *   ④ 支付成功、交付前     → 只执行 delivery; 正文缺失 → delivery_failed, 不重付
 *   ⑤ 交付后、验真前       → 只执行 verification; 成功 → verified, 失败 → verification_failed, 不重付
 *
 * 两个附加场景:
 *   · 支付状态未知 → 先进 unknown, 先对账, **不自动重付**
 *   · facilitator 返回成功但**没有 txHash** → 不能认定链上结算完成 (链上事实需要 txHash)
 */

import type { TransactionRecord } from './transaction-protocol.js';
import { deriveSettlementFact, hasPaymentEvidence, isSettlementFact, type SettlementFact } from './settlement-state.js';

export type RecoveryAction =
  | 'retry_payment'      // 明确没付过 → 可以安全重试
  | 'reconcile'          // 付没付不知道 → 先对账 (绝不重付)
  | 'deliver'            // 已付款 → 继续交付
  | 'verify'             // 已交付 → 继续验真
  | 'complete'           // 已 verified → 无事可做
  | 'closed'             // 终态 (失败/拒绝/纠纷) → 不重付, 交人/追责
  | 'wait';              // 有别的 worker 正持有付款权 → 等, 不动手

export interface RecoveryPlan {
  transactionId: string;
  action: RecoveryAction;
  /** 绝对不能重新付款 (有支付证据或结算事实非 unpaid) */
  mustNotRepay: boolean;
  /** 结算事实 (决策依据, 审计要用) */
  settlementFact: SettlementFact;
  /** 是不是"付过钱但没交付"这类要追责的情形 */
  needsResponsibility: boolean;
  reason: string;
}

/** 只有这些状态才允许自动重试付款 */
const RETRYABLE_STATUSES = ['quoted', 'payment_required'];

/**
 * 纯函数: 从交易记录的两层状态推出"下一步该干什么"。
 * 这是整个恢复逻辑的唯一决策点 —— Supervisor / CLI / 恢复脚本都走它, 不许各自 if-else。
 */
export function planTransactionRecovery(
  rec: TransactionRecord,
  opts: { claimHeldByOther?: boolean } = {},
): RecoveryPlan {
  const fact: SettlementFact = isSettlementFact(rec.settlementFact) ? rec.settlementFact : deriveSettlementFact(rec);
  const status = String(rec.status);
  const evidence = hasPaymentEvidence({ ...rec, settlementFact: fact });
  const base = { transactionId: rec.transactionId, settlementFact: fact };

  // 终态: 不再动手 (钱的事已经定了)
  if (['verified', 'policy_denied', 'failed'].includes(status)) {
    return { ...base, action: status === 'verified' ? 'complete' : 'closed', mustNotRepay: evidence, needsResponsibility: false, reason: `终态 ${status}, 不再变化` };
  }
  if (status === 'delivery_failed' || status === 'verification_failed') {
    return {
      ...base, action: 'closed', mustNotRepay: true, needsResponsibility: true,
      reason: `${status}: 钱 ${fact === 'unpaid' ? '可能没付' : '已付/待确认'} 但交付/验真失败 → 不自动重付, 进追责/人工处理`,
    };
  }

  // 有别的 worker 拿着付款权 → 等 (同一个 requestId 只能有一个付款者)
  if (opts.claimHeldByOther) {
    return { ...base, action: 'wait', mustNotRepay: true, needsResponsibility: false, reason: '付款权被另一个进程持有 → 复用同一交易, 等它走完' };
  }

  // 支付状态未知 / 付款中但没有证据 → 先对账
  if (fact === 'unknown' || (status === 'paying' && !evidence)) {
    if (!evidence && status === 'paying') {
      // 付款中没有**任何**支付凭据 → 判定"没真发出去", 允许安全重试 (由 reconcile 落结论)
      return { ...base, action: 'reconcile', mustNotRepay: false, needsResponsibility: false, reason: '付款中但没有任何支付凭据 → 先对账确认(可安全重试)' };
    }
    return { ...base, action: 'reconcile', mustNotRepay: true, needsResponsibility: false, reason: `结算事实 ${fact} → 先对账, 绝不自动重付` };
  }

  // 明确没付过 + 还没走完 → 可以安全付款
  if (!evidence && RETRYABLE_STATUSES.includes(status)) {
    return { ...base, action: 'retry_payment', mustNotRepay: false, needsResponsibility: false, reason: `状态 ${status} 且结算事实 unpaid (确认没付过) → 可安全付款` };
  }

  // 有支付证据 → 继续推进交付/验真, 绝不重付
  if (evidence) {
    if (status === 'delivered') {
      return { ...base, action: 'verify', mustNotRepay: true, needsResponsibility: false, reason: '已交付 → 继续验真' };
    }
    if (['paying', 'settled', 'payment_required'].includes(status)) {
      return { ...base, action: 'deliver', mustNotRepay: true, needsResponsibility: false, reason: `结算事实 ${fact} → 付款事实在手, 继续交付 (不重付)` };
    }
  }

  return { ...base, action: 'closed', mustNotRepay: evidence, needsResponsibility: false, reason: `状态 ${status} + 结算事实 ${fact}: 没有可自动推进的动作 → 交人` };
}

// ── 执行器 (deps 注入, 便于用确定性适配器真跑) ─────────────────────────────

export interface RecoveryDeps {
  /** 对账: 查链上/facilitator 事实, 返回最新结算结论 */
  reconcile: (rec: TransactionRecord) => Promise<{ fact: SettlementFact; txHash?: string; note?: string }>;
  /** 付款 (只有计划说可以才调用) */
  pay: (rec: TransactionRecord) => Promise<{ ok: boolean; receipt?: string; txHash?: string; error?: string }>;
  /** 交付 (重复执行必须幂等) */
  deliver: (rec: TransactionRecord) => Promise<{ ok: boolean; reason?: string }>;
  /** 验真 (重复执行必须幂等) */
  verify: (rec: TransactionRecord) => Promise<{ ok: boolean; reason?: string }>;
  /** 落盘回调: 把状态变化/证据写进交易记录 (由调用方给 store 的写法) */
  persist: (transactionId: string, patch: Record<string, unknown>, event: { kind: string; detail?: string }) => Promise<void>;
  /**
   * 重读落盘记录。**验真前必须重读**: 交付步骤刚写下的 deliveryBytesHash 等事实只在盘上,
   * 用内存里的旧对象去验真会得出"正文没记过"的假结论 (真跑抓到过)。
   */
  read?: (transactionId: string) => Promise<TransactionRecord | null>;
}

export interface RecoveryOutcome {
  action: RecoveryAction;
  plan: RecoveryPlan;
  paid: boolean;              // 本次是否**真的**发起了付款
  steps: string[];
}

/**
 * 按计划执行一步恢复。**幂等**: 任何一步重复执行都不会造成第二次付款
 * (付款只有 plan.action === 'retry_payment' 时才可能发生)。
 */
export async function runTransactionRecovery(rec: TransactionRecord, deps: RecoveryDeps): Promise<RecoveryOutcome> {
  const plan = planTransactionRecovery(rec);
  const steps: string[] = [];
  let paid = false;

  if (plan.action === 'retry_payment') {
    const res = await deps.pay(rec);
    paid = true;
    if (res.ok) {
      await deps.persist(rec.transactionId, { settlementFact: 'payment_submitted', paymentReceipt: res.receipt, ...(res.txHash ? { txHash: res.txHash } : {}) }, {
        kind: 'recovery_paid', detail: `恢复后重新付款 (对账结论: 没付过) receipt=${String(res.receipt || '').slice(0, 20)}…`,
      });
      steps.push('retry_payment:已付');
    } else {
      await deps.persist(rec.transactionId, { failureReason: res.error }, { kind: 'recovery_pay_failed', detail: String(res.error || '').slice(0, 120) });
      steps.push('retry_payment:失败');
    }
    return { action: plan.action, plan, paid, steps };
  }

  if (plan.action === 'reconcile') {
    const r = await deps.reconcile(rec);
    const patch: Record<string, unknown> = { settlementFact: r.fact };
    if (r.txHash) { patch.txHash = r.txHash; patch.chainSettled = true; }
    // 对账确认"没付过"时, 状态也要从 paying 退回 payment_required —— 否则下一步永远还是"先对账", 推不动
    const backToRetry = r.fact === 'unpaid' && String(rec.status) === 'paying';
    if (backToRetry) patch.status = 'payment_required';
    await deps.persist(rec.transactionId, patch, { kind: 'recovery_reconciled', detail: r.note || `对账结论: ${r.fact}${r.txHash ? ` (txHash=${r.txHash.slice(0, 12)}…)` : ''}${backToRetry ? ' → 状态退回 payment_required (可安全重试)' : ''}` });
    steps.push(`reconcile:${r.fact}`);
    // 对账结论若是"明确没付过" → 下一步可以安全付款; 若是链上事实 → 继续交付
    // 本地视图必须与刚落盘的一致 (少带字段会让下一步判断回到旧状态 —— 真跑抓到过)
    const after: TransactionRecord = { ...rec, ...patch } as TransactionRecord;
    const nextPlan = planTransactionRecovery(after);
    if (nextPlan.action === 'deliver') {
      const d = await deps.deliver(after);
      steps.push(`deliver:${d.ok ? 'ok' : 'fail'}`);
      if (!d.ok) {
        await deps.persist(rec.transactionId, {}, { kind: 'recovery_delivery_failed', detail: String(d.reason || '').slice(0, 120) });
      } else {
        const persisted = (deps.read ? await deps.read(rec.transactionId) : null) ?? after;
        const v = await deps.verify(persisted);
        steps.push(`verify:${v.ok ? 'ok' : 'fail'}`);
      }
    } else if (nextPlan.action === 'retry_payment' && r.fact === 'unpaid') {
      const pay = await deps.pay(after);
      paid = true;
      if (pay.ok) await deps.persist(rec.transactionId, { settlementFact: 'payment_submitted', paymentReceipt: pay.receipt }, { kind: 'recovery_paid_after_reconcile', detail: '对账确认没付过 → 重新付款' });
      steps.push(`retry_after_reconcile:${pay.ok ? '已付' : '失败'}`);
    }
    return { action: plan.action, plan, paid, steps };
  }

  if (plan.action === 'deliver') {
    // ★ 先对账: 结算事实还停在 payment_submitted/unknown 时, 不许直接往下走 (要拿到 txHash 或确认无链上事实)
    if (!['payment_verified', 'partially_settled', 'fully_settled'].includes(plan.settlementFact)) {
      const r = await deps.reconcile(rec);
      const patch: Record<string, unknown> = { settlementFact: r.fact };
      if (r.txHash) { patch.txHash = r.txHash; patch.chainSettled = true; }
      await deps.persist(rec.transactionId, patch, { kind: 'recovery_reconciled', detail: `交付前对账: ${r.note || r.fact}${r.txHash ? ` (txHash=${r.txHash.slice(0, 12)}…)` : ' (无 txHash: 不能认定链上结算)'}` });
      steps.push(`reconcile:${r.fact}`);
      rec = { ...rec, ...patch } as TransactionRecord;
      const recheck = planTransactionRecovery(rec);
      if (recheck.mustNotRepay) plan.mustNotRepay = true;
    }
    const d = await deps.deliver(rec);
    steps.push(`deliver:${d.ok ? 'ok' : 'fail'}`);
    if (d.ok) {
      const persisted = (deps.read ? await deps.read(rec.transactionId) : null) ?? ({ ...rec, status: 'delivered' } as TransactionRecord);
      const v = await deps.verify(persisted);
      steps.push(`verify:${v.ok ? 'ok' : 'fail'}`);
    } else {
      await deps.persist(rec.transactionId, {}, { kind: 'recovery_delivery_failed', detail: String(d.reason || '').slice(0, 120) });
    }
    return { action: plan.action, plan, paid, steps };
  }

  if (plan.action === 'verify') {
    const v = await deps.verify(rec);
    steps.push(`verify:${v.ok ? 'ok' : 'fail'}`);
    return { action: plan.action, plan, paid, steps };
  }

  // complete / closed / wait: 什么都不做 (尤其是绝不付款)
  steps.push(`${plan.action}:noop`);
  return { action: plan.action, plan, paid, steps };
}

/** 对账结论是否可以升级为链上事实 (必须有 txHash —— facilitator 说成功不算) */
export function reconciliationIsChainBacked(r: { fact: SettlementFact; txHash?: string }): boolean {
  if (!r.txHash) return false;
  return ['payment_verified', 'partially_settled', 'fully_settled'].includes(r.fact);
}

// ── Supervisor 接入点: 只对账事实, 绝不付款 ────────────────────────────────

export interface PaymentReconcileReport {
  scanned: number;
  reconciled: string[];                 // 对账过 (结算事实被钉死或确认没付过)
  awaitingPayment: { transactionId: string; reason: string }[];   // 可安全重试付款, 但付款由持有钱包的一方做
  mustNotRepay: string[];               // 有支付证据/结算事实 → 绝不重付
  closed: { transactionId: string; reason: string }[];
  /** 已唤醒的 Goal (付款/交付/验真交回 Goal 的执行器去走幂等路径) */
  goalsWoken: { goalId: string; transactionId: string; action: string; nextAction: string }[];
  /** 需要人介入的 Goal (争议等) */
  goalsFlagged: { goalId: string; why: string }[];
  errors: string[];
}

/**
 * 供 Supervisor 的 tick 调用: 扫描未完结交易, **只做对账** (安全、无副作用),
 * 把结论钉在结算事实上, 并把"该继续做的事"交回**对应的 Goal** (挂在 `rec.goalId` 上的长期目标)。
 *
 * 为什么这里**不付款**: Supervisor 不持有钱包/私钥。让它替人花钱是把"恢复"变成"自己决定花第二笔钱",
 * 违反 `payment failed ≠ safe to retry` 的边界 —— 付款必须由能对账、能签名的那一方显式执行。
 *
 * 2026-09-18 补: `awaitingPayment` 不再只是"列出来", 而是**唤醒对应的 Goal** (写 continuation.nextAction +
 * 立即可跑), 由 Goal 的执行器 (持有钱包/上下文的那一方) 去走幂等付款路径; 有争议或必须人等的, 一律不唤醒。
 */
export async function reconcileInterruptedPayments(opts: {
  home: string;
  reconcile: (rec: TransactionRecord) => Promise<{ fact: SettlementFact; txHash?: string; note?: string }>;
  persist: (transactionId: string, patch: Record<string, unknown>, event: { kind: string; detail?: string }) => Promise<void>;
  /** 注入点: 唤醒 Goal (默认写 continuation.nextAction + autoContinue) */
  wakeGoal?: (goalId: string, nextAction: string, why: string) => Promise<string>;
  /** 注入点: 转人工 (默认 continuation.wakeReason = needs_human) */
  needsHuman?: (goalId: string, why: string) => Promise<string>;
  limit?: number;
}): Promise<PaymentReconcileReport> {
  const report: PaymentReconcileReport = { scanned: 0, reconciled: [], awaitingPayment: [], mustNotRepay: [], closed: [], errors: [], goalsWoken: [], goalsFlagged: [] };
  const { pendingTransactions, listTransactions } = await import('./transaction-store.js');
  let all: TransactionRecord[] = [];
  try {
    const pending = await pendingTransactions(opts.home);
    // 中途被杀的交易可能停在**任何非终态**: discovered(刚建) / quoted(拿到报价还没付) / delivered(该验真)…
    // 只扫 pending 会漏掉场景 ①(付款前被杀) 与 ⑤ 之后的推进 (真跑抓到过: quoted 的交易根本没被扫到)
    const IN_FLIGHT = ['discovered', 'quoted', 'payment_required', 'paying', 'settled', 'delivered', 'disputed'];
    const inFlight = (await listTransactions(opts.home)).filter((t) => IN_FLIGHT.includes(String(t.status)) || t.settlementFact === 'unknown');
    const seen = new Set<string>();
    all = [...pending, ...inFlight].filter((t) => { if (seen.has(t.transactionId)) return false; seen.add(t.transactionId); return true; });
  } catch (err: any) {
    report.errors.push(`读取未完结交易失败: ${String(err?.message || err).slice(0, 120)}`);
    return report;
  }
  const wakeGoal = opts.wakeGoal || (async (goalId: string, nextAction: string, why: string) => {
    const { setContinuation } = await import('../goal-store.js');
    await setContinuation(goalId, { nextAction, wakeReason: 'active', autoContinue: true, wakeAt: undefined, needsExternal: undefined });
    return why;
  });
  const humanNeeded = opts.needsHuman || (async (goalId: string, why: string) => {
    const { setContinuation } = await import('../goal-store.js');
    await setContinuation(goalId, { nextAction: undefined, wakeReason: 'needs_human', autoContinue: false, needsExternal: why });
    return why;
  });

  /** 有 Goal 且允许自动继续 → 唤醒它; 否则 (无 Goal / 已终态) 只报告 */
  const wakeOrFlag = async (before: TransactionRecord, after: TransactionRecord, plan: RecoveryPlan) => {
    const goalId = (before as any).goalId || (after as any).goalId;
    if (!goalId) return;
    if (after.dispute && !after.dispute.resolution) {
      report.goalsFlagged.push({ goalId, why: `交易 ${before.transactionId} 在争议中 → 交人` });
      try { await humanNeeded(goalId, `交易争议待处理: ${before.transactionId}`); } catch (e: any) { report.errors.push(`唤醒 Goal 失败: ${String(e?.message || e).slice(0, 100)}`); }
      return;
    }
    const nextAction = plan.action === 'retry_payment'
      ? `x402_payment_retry:${before.transactionId} (对账确认可安全付款, 走同一 requestId 的幂等路径)`
      : `x402_continue:${before.transactionId} (${plan.action}: ${plan.reason})`;
    try {
      await wakeGoal(goalId, nextAction, plan.reason);
      report.goalsWoken.push({ goalId, transactionId: before.transactionId, action: plan.action, nextAction });
    } catch (e: any) {
      report.errors.push(`唤醒 Goal ${goalId} 失败: ${String(e?.message || e).slice(0, 100)}`);
    }
  };

  for (const rec of all.slice(0, opts.limit ?? 50)) {
    report.scanned++;
    const plan = planTransactionRecovery(rec);
    try {
      if (plan.action === 'reconcile') {
        const r = await opts.reconcile(rec);
        const patch: Record<string, unknown> = { settlementFact: r.fact };
        if (r.txHash) { patch.txHash = r.txHash; patch.chainSettled = true; }
        const backToRetry = r.fact === 'unpaid' && String(rec.status) === 'paying';
        if (backToRetry) patch.status = 'payment_required';
        await opts.persist(rec.transactionId, patch, {
          kind: 'supervisor_payment_reconciled',
          detail: `${r.note || r.fact}${r.txHash ? ` (txHash=${r.txHash.slice(0, 12)}…)` : ''}${backToRetry ? ' → payment_required (可安全重试)' : ''}`,
        });
        report.reconciled.push(rec.transactionId);
        const after = { ...rec, ...patch } as TransactionRecord;
        const nextPlan = planTransactionRecovery(after);
        if (nextPlan.action === 'retry_payment') {
          report.awaitingPayment.push({ transactionId: rec.transactionId, reason: nextPlan.reason });
          await wakeOrFlag(rec, after, nextPlan);
        } else if (nextPlan.mustNotRepay) report.mustNotRepay.push(rec.transactionId);
        continue;
      }
      if (plan.action === 'retry_payment') {
        // 不需要对账就能确认"没付过" → 列出来 + 唤醒对应 Goal 去走幂等付款路径 (这里不动钱)
        report.awaitingPayment.push({ transactionId: rec.transactionId, reason: plan.reason });
        await wakeOrFlag(rec, rec, plan);
        continue;
      }
      if (plan.action === 'deliver' || plan.action === 'verify') {
        // 付款事实在手 → 唤醒 Goal 继续推进交付/验真 (同样不在这里动钱)
        await wakeOrFlag(rec, rec, plan);
        continue;
      }
      if (plan.mustNotRepay) report.mustNotRepay.push(rec.transactionId);
      if (plan.action === 'closed' || plan.action === 'complete' || plan.action === 'wait') {
        report.closed.push({ transactionId: rec.transactionId, reason: plan.reason });
        // 争议中的交易也要让对应 Goal **转人工** (不是让它继续跑, 而是明确交人)
        await wakeOrFlag(rec, rec, plan);
      }
    } catch (err: any) {
      report.errors.push(`${rec.transactionId}: ${String(err?.reason || err?.message || err).slice(0, 120)}`);
    }
  }
  return report;
}
