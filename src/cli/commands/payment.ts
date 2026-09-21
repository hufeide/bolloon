/**
 * payment.ts — P3 `bolloon payment pending|approve|reject`
 *
 * 薄包装: `agents/payment-approval.ts` 的 `PaymentApprovalStore` (pending/approve/reject, 落 ~/.bolloon/payment-approvals.json)
 *
 * 红线:
 *   · CLI **不代付款** —— 批准只改审批状态; 真正发起支付要由注入的 executor / 持钱包的一方做
 *     (与 payment-recovery 同源: "Supervisor 不代付款, 它没有私钥")
 *   · `approve` 之后**不许**把结果说成"已付款" (§2 硬规则 2)
 */

import {
  type CliFlags, type CommandResult, okEnvelope, failEnvelope,
  line, title, hint, plain,
} from '../protocol-envelope.js';

export const PAYMENT_USAGE = `
${title('bolloon payment')}
  bolloon payment pending [--json]             待人工放行的付款请求
  bolloon payment approve <审批id> [--json]     批准 (只改审批状态; CLI 不发付款)
  bolloon payment reject <审批id> [--json]      拒绝

选项: --json · --quiet · --timeout <ms>
`;

export async function paymentCommand(flags: CliFlags): Promise<CommandResult> {
  const sub = flags.positionals[0];
  switch (sub) {
    case 'pending': return paymentPending(flags);
    case 'approve': return paymentApprove(flags);
    case 'reject': return paymentReject(flags);
    default:
      return {
        envelope: failEnvelope('INVALID_ARGUMENT', sub ? `未知 payment 子命令: ${sub}` : '缺少 payment 子命令', { usage: plain(PAYMENT_USAGE.trim()) }, [], 'needs_human'),
        human: PAYMENT_USAGE,
      };
  }
}

function view(a: import('../../agents/payment-approval.js').PaymentApproval) {
  return {
    id: a.id, service: a.service, amount: a.amount, recipient: a.recipient,
    reason: a.reason, status: a.status, createdAt: new Date(a.createdAt).toISOString(),
    decidedAt: a.decidedAt ? new Date(a.decidedAt).toISOString() : null,
    result: a.result || null,
  };
}

async function paymentPending(flags: CliFlags): Promise<CommandResult> {
  const { getApprovalStore } = await import('../../agents/payment-approval.js');
  const store = getApprovalStore();
  const pending = await store.pending();
  const all = await store.list();
  const data = {
    count: pending.length,
    pending: pending.map(view),
    total: all.length,
    source: '~/.bolloon/payment-approvals.json',
    note: pending.length
      ? '这些付款在等你放行: ok:false + code=PAYMENT_REQUIRED 是**正确表达** (不是错误, 也不是重试信号)'
      : '没有待放行的付款',
  };
  const human = [
    title('bolloon payment pending'),
    line('待放行', `${pending.length} 笔 (历史共 ${all.length})`),
    ...pending.map((a) => `\n   ${a.id}\n     服务 ${a.service} · ${a.amount} → ${a.recipient}\n     原因: ${a.reason}`),
    pending.length ? '' : `\n  ${hint('没有待放行的付款')}`,
  ].filter(Boolean).join('\n');
  return {
    envelope: okEnvelope('OK', `待放行付款 ${pending.length} 笔`, data, pending.map((a) => a.id), pending.length ? 'approve_payment' : null),
    human,
  };
}

async function paymentApprove(flags: CliFlags): Promise<CommandResult> {
  const id = flags.positionals[1];
  if (!id) {
    return {
      envelope: failEnvelope('INVALID_ARGUMENT', '缺少审批 id (bolloon payment pending 列出)', { usage: plain(PAYMENT_USAGE.trim()) }, [], 'needs_human'),
      human: PAYMENT_USAGE,
    };
  }
  const { getApprovalStore } = await import('../../agents/payment-approval.js');
  const r = await getApprovalStore().approve(id);
  if (!r.ok || !r.approval) {
    const notFound = /不存在/.test(String(r.error || ''));
    return {
      envelope: failEnvelope(notFound ? 'NOT_FOUND' : 'TASK_TRANSITION_REJECTED', `批准失败: ${r.error}`, { approvalId: id }, [], 'needs_human'),
      human: `${title(`bolloon payment approve ${id}`)}\n  ✗ ${r.error}`,
    };
  }
  const executed = r.approval.status === 'executed';
  const data = {
    approval: view(r.approval),
    executed,
    paid: executed,
    note: executed
      ? 'executor 已执行'
      : '批准已记录; **没有发起付款** —— CLI 不持有钱包, 真正支付由持钱包的一方 (Runtime/executor) 执行',
  };
  return {
    envelope: okEnvelope('PAYMENT_APPROVED', executed ? `已批准并执行: ${id}` : `已批准: ${id} (未发起付款)`, data, [id], executed ? null : 'needs_human'),
    human: [
      title(`bolloon payment approve ${id}`),
      line('状态', r.approval.status),
      line('金额', `${r.approval.amount} → ${r.approval.recipient}`),
      line('服务', r.approval.service),
      line('是否已付款', executed ? '是 (executor 执行)' : '否 —— 只改了审批状态, CLI 不发付款'),
      `\n  ${data.note}`,
    ].join('\n'),
  };
}

async function paymentReject(flags: CliFlags): Promise<CommandResult> {
  const id = flags.positionals[1];
  if (!id) {
    return {
      envelope: failEnvelope('INVALID_ARGUMENT', '缺少审批 id', { usage: plain(PAYMENT_USAGE.trim()) }, [], 'needs_human'),
      human: PAYMENT_USAGE,
    };
  }
  const { getApprovalStore } = await import('../../agents/payment-approval.js');
  const r = await getApprovalStore().reject(id);
  if (!r.ok || !r.approval) {
    const notFound = /不存在/.test(String(r.error || ''));
    return {
      envelope: failEnvelope(notFound ? 'NOT_FOUND' : 'TASK_TRANSITION_REJECTED', `拒绝失败: ${r.error}`, { approvalId: id }, [], 'needs_human'),
      human: `${title(`bolloon payment reject ${id}`)}\n  ✗ ${r.error}`,
    };
  }
  return {
    envelope: okEnvelope('PAYMENT_REJECTED', `已拒绝: ${id}`, { approval: view(r.approval), paid: false }, [id], null),
    human: `${title(`bolloon payment reject ${id}`)}\n${line('状态', r.approval.status)}\n${line('金额', `${r.approval.amount} → ${r.approval.recipient}`)}\n\n  ${hint('拒绝后不会付款; 同一 requestId 的幂等保护仍在')}`,
  };
}
