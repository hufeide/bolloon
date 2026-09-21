/**
 * tasks.ts — P3 `bolloon task send|list|status|cancel|retry|result|inbox|accept|reject|run|complete`
 *
 * **今天真能包的** (薄包装, 不重实现):
 *   list     → `x402/transaction-store.listTransactions()` + `goal-store.listGoals()` (只给状态, 不给任务正文)
 *   status   → `readTransaction` / `findByRequestId` / `task-runner.decideTaskRecovery()` (goalId 路径)
 *   retry    → `x402/payment-recovery.planTransactionRecovery()` (**只出计划, 绝不代付款**)
 *   result   → `readTransaction` + `settlement-state.verifyDelivery()` (只给哈希/字节数, **正文不进 stdout**)
 *   run      → `task/task-runner.runTask()` (M1 唯一入口的同一条路径)
 *
 * **今天真没有的** (契约层已冻结, P2P 任务帧未做 → 如实报 `C_NOT_IMPLEMENTED`, 绝不假装发送成功):
 *   send / inbox / accept / reject / complete / cancel
 *
 * 红线 (P1 §5): local-dev 永远不许被输出成链上结算; 有支付证据不许重付 (计划里 `mustNotRepay` 原样透出)。
 */

import * as os from 'os';
import {
  type CliFlags, type CommandResult, type Code, type Envelope, type NextAction,
  okEnvelope, failEnvelope, notImplemented, envelopeForState,
  line, title, hint, plain, opt, failHuman,
  publicStatusForTask, publicStatusForTrade, settlementLabel, isTradeSuccessful,
} from '../protocol-envelope.js';

export const TASK_USAGE = `
${title('bolloon task')}
  bolloon task "<任务>" --budget 0.05      M1 唯一入口: 买能力 + 执行 + 报告卡 (推荐)
  bolloon task run "<任务>" [--budget 0.05] [--request-id <id>]   同上, 显式走信封输出
  bolloon task list [--json]               本地任务/交易一览 (状态 + 支付事实, 不含任务正文)
  bolloon task status <transactionId|requestId|goalId> [--json]
  bolloon task result <transactionId> [--json]   交付证据 (哈希/字节数; 正文留在本机, 不进 stdout)
  bolloon task retry <id> [--json]         恢复计划 (planTransactionRecovery; 只出计划, 不代付款)
  bolloon task send|inbox|accept|reject|complete|cancel   未实现 → 如实报 C_NOT_IMPLEMENTED

选项: --json · --quiet · --request-id <id> · --timeout <ms> · --resume <goalId> (同 bolloon task)
`;

type Rec = import('../../agents/x402/transaction-protocol.js').TransactionRecord;

/** 交易记录判定 (P1 §5.1 红线: local-dev 永不 verified; 成功判据见 §7.1) */
function judge(rec: Rec): { code: Code; ok: boolean; next: NextAction } {
  const fact = String(rec.settlementFact || '');
  const status = String(rec.status);
  // 红线: local-dev 的记录出现 verified → 就是红线被破坏, 如实报 (绝不顺着说成功)
  if (rec.paymentMode === 'local-dev' && status === 'verified') {
    return { code: 'LOCAL_DEV_NOT_CHAIN', ok: false, next: null };
  }
  if (isTradeSuccessful(rec)) return { code: 'TASK_VERIFIED', ok: true, next: null };
  switch (status) {
    case 'verified': return { code: 'RESULT_UNVERIFIED', ok: false, next: 'needs_human' };   // verified 了但支付事实不够链上口径
    case 'delivered': return { code: 'TASK_COMPLETED', ok: true, next: 'verify_result' };
    case 'paying': return { code: 'PAYMENT_PENDING', ok: false, next: 'reconcile' };
    case 'payment_required': return { code: 'PAYMENT_REQUIRED', ok: false, next: 'approve_payment' };
    case 'policy_denied': return { code: 'POLICY_DENIED', ok: false, next: 'needs_human' };
    case 'delivery_failed': return { code: 'DELIVERY_FAILED', ok: false, next: 'needs_human' };
    case 'verification_failed': return { code: 'RESULT_UNVERIFIED', ok: false, next: 'needs_human' };
    case 'disputed': return { code: 'DISPUTE_OPEN', ok: false, next: 'needs_human' };
    default:
      if (fact === 'unknown') return { code: 'PAYMENT_UNCERTAIN', ok: false, next: 'reconcile' };
      if (status === 'failed') return { code: 'TASK_FAILED', ok: false, next: 'needs_human' };
      return { code: 'OK', ok: true, next: 'wait' };      // discovered/quoted/settled: 还在走
  }
}

/** 一条记录 → 对外可见摘要 (camelCase; 不含任务正文/私钥) */
function recSummary(rec: Rec) {
  const j = judge(rec);
  return {
    transactionId: rec.transactionId,
    requestId: rec.requestId,
    goalId: rec.goalId || null,
    runId: rec.runId || null,
    lifecycle: String(rec.status),
    settlementFact: String(rec.settlementFact || ''),
    paymentMode: String(rec.paymentMode),
    chainSettled: rec.chainSettled === true,
    settlement: settlementLabel(rec),                     // 'chain' | 'local-dev' | 'none' —— local-dev 永不冒充链上
    publicStatus: rec.status === 'verified' || rec.status === 'delivered'
      ? publicStatusForTask(String(rec.status), j.next)
      : publicStatusForTrade(String(rec.status), j.next),
    success: isTradeSuccessful(rec),
    txHash: rec.txHash || null,
    contentHash: rec.contentHash || null,
    deliveryHash: rec.deliveryHash || null,
    receiptHash: rec.receiptHash || null,
    amount: rec.amount || null,
    currency: rec.currency || null,
    network: rec.network || null,
    startedAt: rec.startedAt,
    code: j.code,
    next_action: j.next,
  };
}

async function loadRecords(): Promise<Rec[]> {
  const { listTransactions } = await import('../../agents/x402/transaction-store.js');
  return await listTransactions(os.homedir());
}

/** 解析一个 id: transactionId → requestId → goalId (goalId 走 decideTaskRecovery 找交易) */
async function resolveTarget(id: string): Promise<{ rec: Rec | null; goalId?: string; plan?: { action: string; reason: string; mustNotRepay: boolean; transactionId?: string } }> {
  const { readTransaction, findByRequestId } = await import('../../agents/x402/transaction-store.js');
  const home = os.homedir();
  if (/^tx-/.test(id)) {
    return { rec: await readTransaction(id, home) };
  }
  // 任意 requestId (不一定是 treq- 前缀) 也能直接查到交易
  const byReq = await findByRequestId(id, home);
  if (byReq) return { rec: byReq };
  // 其它一律当 goalId (M1 的 goal id 形如 g-xxxx)
  const { decideTaskRecovery } = await import('../../agents/task/task-runner.js');
  const d = await decideTaskRecovery({ goalId: id });
  const rec = d.transactionId ? await readTransaction(d.transactionId, home) : null;
  return { rec, goalId: id, plan: { action: d.action, reason: d.reason, mustNotRepay: d.mustNotRepay, transactionId: d.transactionId } };
}

export async function taskCommand(flags: CliFlags): Promise<CommandResult> {
  const sub = flags.positionals[0];
  switch (sub) {
    case 'list': return taskList(flags);
    case 'status': return taskStatus(flags);
    case 'result': return taskResult(flags);
    case 'retry': return taskRetry(flags);
    case 'run': return taskRun(flags);
    case 'send': return taskSend(flags);
    case 'inbox': return taskInbox(flags);
    case 'accept': return taskAccept(flags);
    case 'reject': return taskReject(flags);
    case 'complete': return taskComplete(flags);
    case 'cancel': return taskCancel(flags);
    default:
      return {
        envelope: failEnvelope('INVALID_ARGUMENT', sub ? `未知 task 子命令: ${sub}` : '缺少 task 子命令', { usage: plain(TASK_USAGE.trim()) }, [], 'needs_human'),
        human: TASK_USAGE,
      };
  }
}

// ── list ────────────────────────────────────────────────────────────────────

async function taskList(flags: CliFlags): Promise<CommandResult> {
  const all = await loadRecords();
  const filtered = flags.requestId ? all.filter((r) => r.requestId === flags.requestId) : all;
  let goals: Array<{ goalId: string; status: string; hasTransaction: boolean }> = [];
  try {
    const { listGoals } = await import('../../agents/goal-store.js');
    const gs = await listGoals({ limit: 20 });
    const ids = new Set(all.map((r) => r.goalId).filter(Boolean) as string[]);
    // 只给 id 与状态: goal.objective 是任务正文, **不进 stdout** (P1 §5.6)
    goals = gs.map((g) => ({ goalId: g.goalId, status: String(g.status), hasTransaction: ids.has(g.goalId) }));
  } catch { /* 没有 goal 目录也能列交易 */ }

  const data = {
    count: filtered.length,
    tasks: filtered.map(recSummary),
    goals,
    source: 'transactions (~/.bolloon/transactions) + goals (~/.bolloon/goals)',
    note: 'bolloon-task/1 的收件箱/P2P 任务帧尚未实现 (task-protocol.md §9 Phase 2); 这里列的是本地有交易记录的任务 + 本地 Goal (只给 id/状态, 不含任务正文)',
  };
  const human = [
    title('bolloon task list'),
    line('交易记录', `${filtered.length} 笔${flags.requestId ? ` (requestId=${flags.requestId})` : ''}`),
    ...filtered.slice(0, 20).map((r) => `\n   ${r.transactionId}  [${r.status}/${r.settlementFact}]  ${settlementLabel(r)}  ${isTradeSuccessful(r) ? '✓成功' : ''}\n     requestId: ${r.requestId}${r.goalId ? `\n     goalId:    ${r.goalId}` : ''}`),
    line('本地 Goal', `${goals.length} 个 (只给 id/状态, 不含任务正文)`),
    ...goals.slice(0, 10).map((g) => `      · ${g.goalId} [${g.status}]${g.hasTransaction ? ' (已有交易)' : ''}`),
    `\n  ${data.note}`,
  ].join('\n');
  return { envelope: okEnvelope('OK', `本地任务/交易: ${filtered.length} 笔交易, ${goals.length} 个 Goal`, data, filtered.map((r) => r.transactionId), null), human };
}

// ── status ──────────────────────────────────────────────────────────────────

async function taskStatus(flags: CliFlags): Promise<CommandResult> {
  const id = flags.positionals[1] || flags.requestId;
  if (!id) {
    return {
      envelope: failEnvelope('INVALID_ARGUMENT', '缺少 id (transactionId / requestId / goalId) 或 --request-id', { usage: plain(TASK_USAGE.trim()) }, [], 'needs_human'),
      human: TASK_USAGE,
    };
  }
  const { rec, goalId, plan } = await resolveTarget(id);
  if (!rec) {
    if (goalId && plan) {
      // goalId 路径: 走 decideTaskRecovery (Supervisor 与 CLI --resume 共用的唯一决策入口)
      const data = {
        goalId, hasTransaction: false, recoveryAction: plan.action, mustNotRepay: plan.mustNotRepay,
        reason: plan.reason, decisionSource: 'task-runner.decideTaskRecovery',
      };
      if (plan.action === 'closed') {
        // 目标压根不存在 (decideTaskRecovery 对找不到的 Goal 给 closed)
        return {
          envelope: failEnvelope('NOT_FOUND', `找不到这个 Goal: ${goalId}`, data, [goalId], 'needs_human'),
          human: `${title(`bolloon task status ${id}`)}\n  找不到这个 Goal\n${line('原因', plan.reason)}`,
        };
      }
      if (plan.action === 'retry_payment') {
        // 目标在, 但没有任何交易 → 还没付过钱 (真的没花钱, 不是失败)
        return {
          envelope: okEnvelope('OK', `Goal ${goalId} 还没有过交易 (没付过钱): ${plan.reason}`, data, [goalId], 'retry_same_request'),
          human: `${title(`bolloon task status ${id}`)}\n${line('goalId', goalId)}\n${line('交易', '还没有 (没付过钱)')}\n${line('恢复动作', plan.action)}\n${line('mustNotRepay', plan.mustNotRepay ? 'true' : 'false')}\n\n${hint('下一步: bolloon task --resume ' + goalId + ' (从头跑, 没有钱可重复付)')}`,
        };
      }
      return {
        envelope: failEnvelope('RESULT_UNVERIFIED', `Goal ${goalId} 不能自动继续: ${plan.reason}`, data, [goalId], 'needs_human'),
        human: failHuman(`bolloon task status ${id}`, { code: 'RESULT_UNVERIFIED', message: plan.reason, next_action: 'needs_human' }),
      };
    }
    return {
      envelope: failEnvelope('NOT_FOUND', `找不到这个 id 对应的任务/交易: ${id}`, { id }, [], 'retry_same_request'),
      human: `${title(`bolloon task status ${id}`)}\n  没找到\n\n${hint('下一步: bolloon task list 看本地有哪些交易/目标')}`,
    };
  }
  const s = recSummary(rec);
  const j = judge(rec);
  const human = [
    title(`bolloon task status ${rec.transactionId}`),
    line('对外状态', s.publicStatus),
    line('生命周期', s.lifecycle),
    line('结算事实', s.settlementFact),
    line('结算口径', s.settlement + (s.settlement === 'local-dev' ? ' (链上没动钱: 协议闭环通过, 不是支付成功)' : '')),
    line('链上结算', s.chainSettled ? '是' : '否'),
    line('算不算成功', s.success ? '算 (verified ∧ 链上口径事实)' : '不算'),
    line('requestId', s.requestId),
    ...(s.goalId ? [line('goalId', s.goalId)] : []),
    ...(s.txHash ? [line('txHash', s.txHash)] : []),
    line('事件', `${rec.events?.length || 0} 条 (bolloon trade events ${rec.transactionId})`),
    ...(goalId && plan ? [line('恢复动作', `${plan.action} — ${plan.reason}`)] : []),
  ].join('\n');
  return {
    envelope: envelopeForState(j.ok, j.code, `任务 ${rec.transactionId}: ${s.lifecycle}/${s.settlementFact} (${s.settlement})`, { ...s, goalRecovery: goalId && plan ? plan : null }, [rec.transactionId, rec.requestId, ...(rec.txHash ? [rec.txHash] : [])], j.next),
    human,
  };
}

// ── result ──────────────────────────────────────────────────────────────────

async function taskResult(flags: CliFlags): Promise<CommandResult> {
  const id = flags.positionals[1] || flags.requestId;
  if (!id) {
    return {
      envelope: failEnvelope('INVALID_ARGUMENT', '缺少 transactionId (或 --request-id)', { usage: plain(TASK_USAGE.trim()) }, [], 'needs_human'),
      human: TASK_USAGE,
    };
  }
  const { rec } = await resolveTarget(id);
  if (!rec) {
    return {
      envelope: failEnvelope('NOT_FOUND', `找不到交易: ${id}`, { id }, [], 'retry_same_request'),
      human: `${title(`bolloon task result ${id}`)}\n  没找到这笔交易`,
    };
  }
  const { verifyDelivery } = await import('../../agents/x402/settlement-state.js');
  const dv = verifyDelivery(rec, os.homedir());
  const s = recSummary(rec);
  const j = judge(rec);
  // ★ 交付正文**不进 stdout/日志** (P1 §5.6 私有一层): 只给字节数/哈希/在盘证据
  const data = {
    transactionId: rec.transactionId,
    requestId: rec.requestId,
    lifecycle: s.lifecycle,
    settlementFact: s.settlementFact,
    settlement: s.settlement,
    success: s.success,
    verificationTrust: rec.verificationTrust || 'unverified',
    protocolVerified: rec.protocolVerified === true,
    delivery: {
      present: dv.present,
      bytes: dv.bytes ?? null,
      bytesHash: dv.bytesHash || null,
      matchesRecorded: dv.matchesRecorded,
      reason: dv.reason || null,
      contentHash: rec.contentHash || null,
      deliveryHash: rec.deliveryHash || null,
      receiptHash: rec.receiptHash || null,
      storedAs: `~/.bolloon/x402/deliveries/${rec.transactionId}.txt`,
      bodyPrinted: false,
    },
    note: '正文留在本机交付目录 (公开层/日志永不输出正文); 需要正文请在本机直接读该文件',
  };
  const human = [
    title(`bolloon task result ${rec.transactionId}`),
    line('对外状态', s.publicStatus),
    line('结算口径', s.settlement),
    line('算不算成功', s.success ? '算' : '不算'),
    line('验真分档', data.verificationTrust),
    line('正文在盘', dv.present ? `是 (${dv.bytes ?? '?'} 字节, 哈希匹配=${dv.matchesRecorded})` : `否${dv.reason ? ` — ${dv.reason}` : ''}`),
    line('正文文件', data.delivery.storedAs),
    line('正文输出', '未输出 (私有层: 绝不进 stdout/日志)'),
    `\n  ${data.note}`,
  ].join('\n');
  return {
    envelope: envelopeForState(j.ok, j.code, `任务 ${rec.transactionId} 的交付证据 (正文未输出)`, data, [rec.transactionId, ...(dv.bytesHash ? [dv.bytesHash] : []), ...(rec.contentHash ? [rec.contentHash] : [])], j.next),
    human,
  };
}

// ── retry (只出计划, 绝不代付款) ─────────────────────────────────────────────

const PLAN_NEXT: Record<string, NextAction> = {
  retry_payment: 'approve_payment',
  reconcile: 'reconcile',
  deliver: 'needs_human',
  verify: 'needs_human',
  closed: 'needs_human',
  wait: 'wait',
  complete: null,
};

async function taskRetry(flags: CliFlags): Promise<CommandResult> {
  const id = flags.positionals[1] || flags.requestId;
  if (!id) {
    return {
      envelope: failEnvelope('INVALID_ARGUMENT', '缺少 transactionId / requestId / goalId', { usage: plain(TASK_USAGE.trim()) }, [], 'needs_human'),
      human: TASK_USAGE,
    };
  }
  const { rec, goalId, plan } = await resolveTarget(id);
  if (!rec) {
    if (goalId && plan) {
      // goalId 路径: 走 decideTaskRecovery (Supervisor 与 CLI --resume 共用的唯一决策入口)
      const next: NextAction = plan.action === 'retry_payment'
        ? (plan.transactionId ? `x402_payment_retry:${plan.transactionId}` as NextAction : 'retry_same_request')
        : plan.action === 'already_executed' ? 'needs_human' : (PLAN_NEXT[plan.action] ?? 'needs_human');
      const data = {
        goalId, action: plan.action, reason: plan.reason, mustNotRepay: plan.mustNotRepay,
        transactionId: plan.transactionId ?? null, hasTransaction: !!plan.transactionId,
        decisionSource: 'task-runner.decideTaskRecovery (CLI --resume 与 Supervisor 同一入口)',
        paid: false,
      };
      return {
        envelope: envelopeForState(plan.action === 'complete', 'RECOVERY_PLANNED', `恢复计划: ${plan.action}${plan.mustNotRepay ? ' (绝不重付)' : ''}`, data, plan.transactionId ? [plan.transactionId, goalId] : [goalId], next),
        human: [
          title(`bolloon task retry ${goalId}`),
          line('动作', plan.action),
          line('原因', plan.reason),
          line('绝不重付', plan.mustNotRepay ? 'true (已有支付证据/不确定 → 先对账)' : 'false (确认没付过, 可从同一 requestId 幂等重发)'),
          line('交易', plan.transactionId || '(还没有)'),
          `\n  ${hint('这条命令只出计划, 不代付款 (Supervisor/CLI 都不持有钱包)。要继续: bolloon task --resume ' + goalId)}`,
        ].join('\n'),
      };
    }
    return {
      envelope: failEnvelope('NOT_FOUND', `找不到这个 id: ${id}`, { id }, [], 'retry_same_request'),
      human: `${title(`bolloon task retry ${id}`)}\n  没找到`,
    };
  }
  // 交易路径: 唯一决策点 planTransactionRecovery (绝不自己 if-else, 也绝不绕过去付款)
  const { planTransactionRecovery } = await import('../../agents/x402/payment-recovery.js');
  const p = planTransactionRecovery(rec);
  const next: NextAction = PLAN_NEXT[p.action] === 'approve_payment' && p.mustNotRepay
    ? `x402_payment_retry:${rec.transactionId}` as NextAction
    : (p.action === 'deliver' || p.action === 'verify' ? `x402_continue:${rec.transactionId}` as NextAction : PLAN_NEXT[p.action]);
  const data = {
    transactionId: rec.transactionId,
    requestId: rec.requestId,
    action: p.action,
    settlementFact: p.settlementFact,
    mustNotRepay: p.mustNotRepay,
    needsResponsibility: p.needsResponsibility,
    reason: p.reason,
    lifecycle: String(rec.status),
    settlement: settlementLabel(rec),
    decisionSource: 'x402/payment-recovery.planTransactionRecovery',
    paid: false,
    paidNote: 'CLI 只出计划, 不发付款: 付款必须由**持钱包的一方**走同一 requestId 的幂等路径',
  };
  const human = [
    title(`bolloon task retry ${rec.transactionId}`),
    line('动作', p.action),
    line('原因', p.reason),
    line('结算事实', p.settlementFact),
    line('绝不重付', p.mustNotRepay ? 'true' : 'false'),
    line('结算口径', settlementLabel(rec)),
    line('本次付款', '没有 (只出计划)'),
    `\n  ${hint('下一步: ' + (p.action === 'reconcile' ? '先对账 (trade reconcile) —— 付款不确定绝不当失败' : String(next)))}`,
  ].join('\n');
  return {
    envelope: envelopeForState(p.action === 'complete', 'RECOVERY_PLANNED', `恢复计划: ${p.action}${p.mustNotRepay ? ' (绝不重付)' : ''}`, data, [rec.transactionId, rep(rec)], next),
    human,
  };
}

function rep(rec: Rec): string { return rec.requestId; }

// ── run (M1 唯一入口的同一条路径) ────────────────────────────────────────────

async function taskRun(flags: CliFlags): Promise<CommandResult> {
  const { runTask } = await import('../../agents/task/task-runner.js');
  const task = flags.positionals.slice(1).join(' ').trim();
  if (!task) {
    return {
      envelope: failEnvelope('INVALID_ARGUMENT', '缺少任务正文 (bolloon task run "<任务>" --budget 0.05)', { usage: plain(TASK_USAGE.trim()) }, [], 'needs_human'),
      human: TASK_USAGE,
    };
  }
  const r = await runTask({
    task,
    budget: opt(flags, '--budget'),
    perPurchase: opt(flags, '--per-purchase'),
    daily: opt(flags, '--daily'),
    requestId: flags.requestId,
    input: parseInput(opt(flags, '--input')),
    allowLocalDev: true,
  });
  const chainSettled = r.payment?.chainSettled === true;
  const settlement: 'chain' | 'local-dev' | 'none' = r.payment
    ? (chainSettled ? 'chain' : (r.payment.mode === 'local-dev' ? 'local-dev' : 'none'))
    : 'none';
  // ★ local-dev 最高到 delivered: 不许输出成 TASK_VERIFIED (P1 §5.1)
  const code: Code = r.ok ? (chainSettled ? 'TASK_VERIFIED' : 'TASK_COMPLETED') : (r.card.hardGate === 'bought_not_executed' ? 'DELIVERY_FAILED' : 'RESULT_UNVERIFIED');
  const next: NextAction = r.ok ? (chainSettled ? null : 'verify_result') : 'needs_human';
  const data = {
    goalId: r.goalId || null,
    runId: r.runId || null,
    transactionId: r.transactionId || null,
    publicStatus: r.card.status,
    conclusion: r.card.conclusion,
    executed: r.card.executed,
    paid: r.card.paid,
    checks: r.card.checks,
    hardGate: r.card.hardGate || null,
    payment: r.payment || null,
    settlement,
    success: !!(r.ok && chainSettled),
    budget: { taskBudget: r.budget.taskBudget, perPurchase: r.budget.perPurchase, daily: r.budget.daily, clamped: r.budget.clamped },
    outputIssues: r.outputIssues,
    stages: r.stages,
    note: settlement === 'chain'
      ? undefined
      : settlement === 'local-dev'
        ? '本机联调 (local-dev): 协议闭环通过, 链上没动钱 —— 不是"支付成功", 也不算任务成功'
        : '这次没有发生付款 (settlement=none): 没有链上也没有联调结算, 也没有花钱',
  };
  const human = [`${title('bolloon task run')}`, r.text, '', line('对外状态', r.card.status), line('结算口径', settlement)].join('\n');
  const env: Envelope = r.ok
    ? okEnvelope(code, `任务${chainSettled ? '已验真' : '已交付 (local-dev, 链上未结算)'}`, data, [r.goalId, r.runId, r.transactionId].filter(Boolean) as string[], next)
    : failEnvelope(code, `任务没走完: ${r.card.blocker || r.card.conclusion}`, data, [r.goalId, r.runId, r.transactionId].filter(Boolean) as string[], next);
  return { envelope: env, human };
}

function parseInput(raw?: string): unknown {
  if (raw === undefined) return undefined;
  try { return JSON.parse(raw); } catch { return undefined; }
}

// ── 未实现的一组 (契约层已冻结, 传输/收件箱未做) ──────────────────────────────

async function taskSend(flags: CliFlags): Promise<CommandResult> {
  // 幂等键是**确定性派生**的 (task-contract.taskRequestId) —— 这里把它算出来给调用方, 证明契约层是真在的
  let requestId: string | undefined;
  const instruction = opt(flags, '--instruction') || flags.positionals.slice(1).join(' ').trim();
  const capability = opt(flags, '--capability');
  if (instruction && capability) {
    try {
      const { taskRequestId } = await import('../../agents/task-contract.js');
      const { getUserOwnerDid } = await import('../../agents/agent-identity.js');
      requestId = taskRequestId({ instruction, capability, buyerDid: getUserOwnerDid() || 'did:local:unknown' });
    } catch { /* 派生失败不影响"未实现"这个事实 */ }
  }
  const env = notImplemented('task send 还没实现: bolloon-task/1 的契约层已落, 但 P2P 任务帧未做 (task-protocol.md §9 Phase 2)', {
    plannedCapability: 'task.send',
    contractLayer: 'src/agents/task-contract.ts (validateTaskRequest / signTaskEnvelope / dedupeInbox, 22/22 单测)',
    missingTransport: 'P2P 任务帧 (请求/报价/接受/拒绝/结果回传)',
    ...(requestId ? { requestId, requestIdSource: 'task-contract.taskRequestId (instruction|capability|buyerDid 确定性派生)' } : {}),
    alternative: 'bolloon task "<任务>" --budget 0.05   (M1 唯一入口, 今天真能跑)',
  });
  return { envelope: env, human: `${title('bolloon task send')}\n  未实现 (没有 P2P 任务帧)\n${requestId ? `  幂等键 (契约层派生): ${requestId}\n` : ''}\n${hint('现成可用: bolloon task "<任务>" --budget 0.05')}` };
}

async function taskInbox(_flags: CliFlags): Promise<CommandResult> {
  const env = notImplemented('task inbox 还没实现: 没有收件箱存储 (dedupeInbox 只是契约层去重函数, 没有落盘收件箱)', {
    plannedCapability: 'task.inbox',
    contractLayer: 'src/agents/task-contract.ts dedupeInbox (:270-273)',
    alternative: '今天唯一的接单路径是**被委派**: POST /api/agent/delegate (agent-delegate-server.ts:109)',
  });
  return { envelope: env, human: `${title('bolloon task inbox')}\n  未实现 (没有收件箱)\n\n${hint('今天能接单的路: POST /api/agent/delegate')}` };
}

async function taskAccept(_flags: CliFlags): Promise<CommandResult> {
  const env = notImplemented('task accept 还没实现: TaskAccept 只是契约类型 (:153-161), 没有收件箱也没有发送方在等回执', {
    plannedCapability: 'task.accept',
    contractLayer: 'src/agents/task-contract.ts TaskAccept',
    alternative: '被委派路径由 Runtime 自动应答; CLI 今天没有可接受的请求',
  });
  return { envelope: env, human: `${title('bolloon task accept')}\n  未实现 (没有可接受的请求, 也没有回执通道)` };
}

async function taskReject(_flags: CliFlags): Promise<CommandResult> {
  const env = notImplemented('task reject 还没实现: TaskReject 只是契约类型 (:163-170), 没有收件箱可拒', {
    plannedCapability: 'task.reject',
    contractLayer: 'src/agents/task-contract.ts TaskReject',
    alternative: '契约要求"拒绝必须给 reason" —— 但今天没有收件箱, 没有东西可拒',
  });
  return { envelope: env, human: `${title('bolloon task reject')}\n  未实现 (没有收件箱可拒)` };
}

async function taskComplete(_flags: CliFlags): Promise<CommandResult> {
  const env = notImplemented('task complete 还没实现: 没有任务状态存储可写 (交易层有非法迁移保护, 不许绕过)', {
    plannedCapability: 'task.complete',
    contractLayer: 'src/agents/task-contract.ts checkTaskMove (:73-80) 非法迁移拒绝, 不静默修正',
    alternative: '点 M1 闭环的进展: bolloon task status <id> / bolloon task --resume <goalId>',
  });
  return { envelope: env, human: `${title('bolloon task complete')}\n  未实现 (没有可写的任务状态存储; 交易状态机有非法迁移保护, 不许绕过)` };
}

async function taskCancel(_flags: CliFlags): Promise<CommandResult> {
  const env = notImplemented('task cancel 还没实现: 交易层没有 cancelled 态, 也没有取消服务 (不许绕过状态机硬写)', {
    plannedCapability: 'task.cancel',
    contractLayer: '任务 14 态有 cancelled (:40) / 交易 11 态没有 cancelled (transaction-protocol.ts:39-51)',
    alternative: '付款不确定时**先对账**: bolloon trade reconcile <transactionId> (绝不重付)',
  });
  return { envelope: env, human: `${title('bolloon task cancel')}\n  未实现 (交易层没有 cancelled 态; 硬写会绕过状态机)\n\n${hint('付款不确定 → bolloon trade reconcile <transactionId> (先对账, 绝不重付)')}` };
}

export { judge as judgeTransaction, recSummary as transactionSummary };
