/**
 * trade.ts — P3 `bolloon trade list|show|events|reconcile`
 *
 * 薄包装 (P1 §4.4 说的 /tx 面 —— 今天是 HTTP 接口, 这里包同一份落盘记录):
 *   list     → `x402/transaction-store.listTransactions()`
 *   show     → `readTransaction()` / `findByRequestId()`
 *   events   → `replayTransaction()` (审计回放, 事件链)
 *   reconcile→ 单笔: `x402/payment-recovery.planTransactionRecovery()` (**唯一决策点**, 只出计划)
 *              全部: `x402/transaction-store.reconcilePendingTransactions()` (重启对账的同一实现, 只钉事实/不放钱)
 *
 * 红线: 不绕过交易状态机、不重实现恢复逻辑、**绝不代付款**; `local-dev` 一律标 `local-dev` (不冒充链上)。
 */

import * as os from 'os';
import {
  type CliFlags, type CommandResult, okEnvelope, failEnvelope, envelopeForState,
  line, title, hint, plain,
} from '../protocol-envelope.js';
import { transactionSummary, judgeTransaction } from './tasks.js';

export const TRADE_USAGE = `
${title('bolloon trade')}
  bolloon trade list [--json]                  交易一览 (状态 + 结算事实 + 结算口径)
  bolloon trade show <transactionId|requestId> [--json]   单笔交易原文 (链上/联调口径分开写)
  bolloon trade events <transactionId> [--json]           事件链 (审计回放)
  bolloon trade reconcile [<transactionId>] [--json]      恢复计划 / 重启对账 (不付款)

选项: --json · --quiet · --request-id <id> · --timeout <ms>
`;

export async function tradeCommand(flags: CliFlags): Promise<CommandResult> {
  const sub = flags.positionals[0];
  switch (sub) {
    case 'list': return tradeList(flags);
    case 'show': return tradeShow(flags);
    case 'events': return tradeEvents(flags);
    case 'reconcile': return tradeReconcile(flags);
    default:
      return {
        envelope: failEnvelope('INVALID_ARGUMENT', sub ? `未知 trade 子命令: ${sub}` : '缺少 trade 子命令', { usage: plain(TRADE_USAGE.trim()) }, [], 'needs_human'),
        human: TRADE_USAGE,
      };
  }
}

async function loadAll() {
  const { listTransactions } = await import('../../agents/x402/transaction-store.js');
  return await listTransactions(os.homedir());
}

async function tradeList(flags: CliFlags): Promise<CommandResult> {
  const all = await loadAll();
  const filtered = flags.requestId ? all.filter((t) => t.requestId === flags.requestId) : all;
  const data = {
    count: filtered.length,
    trades: filtered.map(transactionSummary),
    dir: '~/.bolloon/transactions',
    settlementNote: 'settlement: chain = 链上真结算 · local-dev = 本机联调 (链上一分钱没动) · none = 没到结算',
  };
  const human = [
    title('bolloon trade list'),
    line('交易数', `${filtered.length}${flags.requestId ? ` (requestId=${flags.requestId})` : ''}`),
    ...filtered.slice(0, 25).map((t) => {
      const s = transactionSummary(t);
      return `\n   ${s.transactionId}  [${s.lifecycle}/${s.settlementFact}]  ${s.settlement}${s.success ? '  ✓成功' : ''}\n     ${s.publicStatus} · requestId ${s.requestId}${s.txHash ? `\n     txHash ${s.txHash}` : ''}`;
    }),
    filtered.length ? '' : `\n  还没有交易记录`,
  ].filter(Boolean).join('\n');
  return {
    envelope: okEnvelope('OK', `交易 ${filtered.length} 笔`, data, filtered.map((t) => t.transactionId), null),
    human,
  };
}

async function resolveOne(flags: CliFlags): Promise<{ id: string; rec: import('../../agents/x402/transaction-protocol.js').TransactionRecord | null }> {
  const id = flags.positionals[1] || flags.requestId;
  if (!id) return { id: '', rec: null };
  const { readTransaction, findByRequestId } = await import('../../agents/x402/transaction-store.js');
  const home = os.homedir();
  // tx- 前缀 → 直接当 transactionId; 其它先当 requestId 查 (任意 requestId 都能命中), 再退回 transactionId
  const rec = /^tx-/.test(id)
    ? await readTransaction(id, home)
    : ((await findByRequestId(id, home)) ?? (await readTransaction(id, home)));
  return { id, rec };
}

async function tradeShow(flags: CliFlags): Promise<CommandResult> {
  const { id, rec } = await resolveOne(flags);
  if (!id) {
    return {
      envelope: failEnvelope('INVALID_ARGUMENT', '缺少 transactionId (或 --request-id)', { usage: plain(TRADE_USAGE.trim()) }, [], 'needs_human'),
      human: TRADE_USAGE,
    };
  }
  if (!rec) {
    return {
      envelope: failEnvelope('NOT_FOUND', `找不到交易: ${id}`, { id, dir: '~/.bolloon/transactions' }, [], 'retry_same_request'),
      human: `${title(`bolloon trade show ${id}`)}\n  没找到 (落盘目录 ~/.bolloon/transactions)\n\n${hint('下一步: bolloon trade list 看本地有哪些交易')}`,
    };
  }
  const s = transactionSummary(rec);
  const j = judgeTransaction(rec);
  const data = {
    ...s,
    events: (rec.events || []).map((e) => ({ at: e.at, kind: e.kind, detail: e.detail || null })),
    responsibility: rec.responsibility || null,
    dispute: rec.dispute || null,
    policyDecision: rec.policyDecision || null,
    resourceOutcome: rec.resourceOutcome || null,
    verificationTrust: rec.verificationTrust || null,
    protocolVerified: rec.protocolVerified === true,
    paymentReceiptPresent: !!rec.paymentReceipt,
    receiptHash: rec.receiptHash || null,
    failureReason: rec.failureReason || null,
    bodyPrinted: false,
    note: '交付正文/私钥不在交易记录里 (也不进 stdout); txHash 是公开链上数据',
  };
  const human = [
    title(`bolloon trade show ${rec.transactionId}`),
    line('生命周期', `${s.lifecycle} (对外: ${s.publicStatus})`),
    line('结算事实', s.settlementFact),
    line('结算口径', s.settlement + (s.settlement === 'local-dev' ? ' —— 链上没动钱 (协议闭环通过, 不是支付成功)' : '')),
    line('链上结算', s.chainSettled ? '是' : '否'),
    line('算不算成功', s.success ? '算' : '不算'),
    line('付款模式', s.paymentMode),
    line('金额/网络', `${s.amount || '?'} ${s.currency || ''} @ ${s.network || '?'}`),
    line('requestId', s.requestId),
    ...(s.txHash ? [line('txHash', s.txHash)] : []),
    line('验真分档', data.verificationTrust || 'unverified'),
    ...(rec.responsibility ? [line('责任候选', `${rec.responsibility.type} — ${rec.responsibility.reason}`)] : []),
    ...(rec.failureReason ? [line('失败原因', rec.failureReason)] : []),
    `\n  事件链 (${data.events.length} 条):`,
    ...data.events.slice(-12).map((e) => `    ${e.at} ${e.kind}${e.detail ? ` — ${e.detail.slice(0, 90)}` : ''}`),
  ].join('\n');
  return {
    envelope: envelopeForState(j.ok, j.code, `交易 ${rec.transactionId}: ${s.lifecycle}/${s.settlementFact} (${s.settlement})`, data, [rec.transactionId, rec.requestId, ...(rec.txHash ? [rec.txHash] : [])], j.next),
    human,
  };
}

async function tradeEvents(flags: CliFlags): Promise<CommandResult> {
  const { id, rec } = await resolveOne(flags);
  if (!id) {
    return {
      envelope: failEnvelope('INVALID_ARGUMENT', '缺少 transactionId', { usage: plain(TRADE_USAGE.trim()) }, [], 'needs_human'),
      human: TRADE_USAGE,
    };
  }
  if (!rec) {
    return {
      envelope: failEnvelope('NOT_FOUND', `找不到交易: ${id}`, { id }, [], 'retry_same_request'),
      human: `${title(`bolloon trade events ${id}`)}\n  没找到`,
    };
  }
  const { replayTransaction } = await import('../../agents/x402/transaction-store.js');
  const lines = await replayTransaction(rec.transactionId, os.homedir());
  const data = { transactionId: rec.transactionId, count: lines.length, events: lines, settlementFact: String(rec.settlementFact || ''), settlement: transactionSummary(rec).settlement };
  return {
    envelope: okEnvelope('OK', `交易 ${rec.transactionId} 的事件链 ${lines.length} 条`, data, [rec.transactionId], null),
    human: `${title(`bolloon trade events ${rec.transactionId}`)}\n${lines.map((l) => `  ${l}`).join('\n')}`,
  };
}

async function tradeReconcile(flags: CliFlags): Promise<CommandResult> {
  const id = flags.positionals[1] || flags.requestId;
  if (!id) {
    // 全部对账: 用重启对账的同一实现 (只钉事实 + 释放死掉的付款权, 一分钱不放)
    const { reconcilePendingTransactions } = await import('../../agents/x402/transaction-store.js');
    const r = await reconcilePendingTransactions(os.homedir());
    const data = {
      scope: 'all',
      requeued: r.requeued,
      mustNotRepay: r.mustNotRepay,
      notes: r.notes,
      source: 'x402/transaction-store.reconcilePendingTransactions (重启对账的同一实现)',
      paid: false,
      note: '对账只钉事实/清死锁, **不付款**; 有支付证据的一律进 mustNotRepay',
    };
    return {
      envelope: okEnvelope('RECOVERY_PLANNED', `对账完成: 可安全重试 ${r.requeued.length} 笔, 绝不重付 ${r.mustNotRepay.length} 笔`, data, [...r.requeued, ...r.mustNotRepay], r.requeued.length ? 'approve_payment' : null),
      human: [
        title('bolloon trade reconcile (全部)'),
        line('可安全重试', `${r.requeued.length} 笔${r.requeued.length ? ': ' + r.requeued.join(', ') : ''}`),
        line('绝不重付', `${r.mustNotRepay.length} 笔${r.mustNotRepay.length ? ': ' + r.mustNotRepay.join(', ') : ''}`),
        line('本次付款', '没有 (对账不放钱)'),
        ...r.notes.slice(0, 12).map((n) => `    · ${n}`),
        `\n  ${data.note}`,
      ].join('\n'),
    };
  }
  const { readTransaction, findByRequestId } = await import('../../agents/x402/transaction-store.js');
  const home = os.homedir();
  const rec = /^tx-/.test(id)
    ? await readTransaction(id, home)
    : ((await findByRequestId(id, home)) ?? (await readTransaction(id, home)));
  if (!rec) {
    return {
      envelope: failEnvelope('NOT_FOUND', `找不到交易: ${id}`, { id }, [], 'retry_same_request'),
      human: `${title(`bolloon trade reconcile ${id}`)}\n  没找到`,
    };
  }
  // ★ 唯一决策点: planTransactionRecovery (不自己 if-else, 也不绕过去付款)
  const { planTransactionRecovery } = await import('../../agents/x402/payment-recovery.js');
  const p = planTransactionRecovery(rec);
  const next = p.action === 'reconcile' ? 'reconcile'
    : p.action === 'retry_payment' ? (p.mustNotRepay ? `x402_payment_retry:${rec.transactionId}` : 'approve_payment')
      : p.action === 'deliver' || p.action === 'verify' ? `x402_continue:${rec.transactionId}`
        : p.action === 'wait' ? 'wait'
          : p.action === 'complete' ? null : 'needs_human';
  const data = {
    scope: 'single',
    transactionId: rec.transactionId,
    requestId: rec.requestId,
    action: p.action,
    mustNotRepay: p.mustNotRepay,
    needsResponsibility: p.needsResponsibility,
    settlementFact: p.settlementFact,
    settlement: transactionSummary(rec).settlement,
    chainSettled: rec.chainSettled === true,
    txHash: rec.txHash || null,
    reason: p.reason,
    lifecycle: String(rec.status),
    decisionSource: 'x402/payment-recovery.planTransactionRecovery',
    paid: false,
    note: '先 reconcile, 再决定 retry (顺序不许颠倒); 付款只能由持钱包的一方走同一 requestId 的幂等路径',
  };
  return {
    envelope: envelopeForState(p.action === 'complete', 'RECOVERY_PLANNED', `对账计划: ${p.action}${p.mustNotRepay ? ' (绝不重付)' : ''}`, data, [rec.transactionId, rec.requestId, ...(rec.txHash ? [rec.txHash] : [])], next as any),
    human: [
      title(`bolloon trade reconcile ${rec.transactionId}`),
      line('动作', p.action),
      line('原因', p.reason),
      line('结算事实', p.settlementFact),
      line('结算口径', data.settlement),
      line('绝不重付', p.mustNotRepay ? 'true (已有支付证据 → 只继续交付/验真)' : 'false (确认没付过, 可从同一 requestId 安全重发)'),
      line('本次付款', '没有 (只出计划)'),
      `\n  ${hint('下一步: ' + String(next ?? '无需额外动作'))}`,
    ].join('\n'),
  };
}
