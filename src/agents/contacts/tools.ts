/**
 * contacts/tools.ts — 暴露给 Agent 的联系工具 (2026-09-19, Phase 8)
 *
 * 设计铁律:
 *   - Agent **拿不到**手机号/邮箱原文, 只能拿 `contactId` + 脱敏 displayValue。
 *   - Agent **不能**指定任意收件人地址 —— 只能指定已授权 contactId (或已在别名表里的名字)。
 *   - 每个工具都经 policy 判定, 返回里带 blockKind / requiresApproval, 不吞掉拒绝原因。
 *
 * 六个工具: contact.list_authorized / preview / request_consent / send / await_reply / revoke
 */

import { ContactChain } from './chain.js';

export const CONTACT_TOOL_NAMES = [
  'contact.list_authorized',
  'contact.preview',
  'contact.request_consent',
  'contact.send',
  'contact.await_reply',
  'contact.revoke',
] as const;

export interface ToolCtx {
  /** 真实类型是 ToolRegistryContext['tools'] (Map<string, ToolDefinition>); 这里只用到 set() */
  tools: Map<string, any>;
}

function text(v: unknown): string { return String(v ?? '').trim(); }

export function registerContactTools(ctx: ToolCtx, chain: ContactChain): string[] {
  const registered: string[] = [];

  ctx.tools.set('contact.list_authorized', {
    name: 'contact.list_authorized',
    description: '列出已授权可联系的联系方式 (只返回脱敏值: 联系人不给完整手机号/邮箱)。需要联系某人先调这个; 拿到的 contactId 才能用于发送。',
    parameters: {},
    execute: async () => {
      const list = await chain.listAuthorized();
      return {
        success: true,
        contacts: list,
        channels: chain.channels(),
        note: list.length ? '只能对这里列出的 contactId 发送; 未验证/已撤销的一律发不出去' : '还没有任何已绑定的联系方式 —— 需要用户在 CLI/桌面/手机上先绑定并验证',
      };
    },
  });

  ctx.tools.set('contact.preview', {
    name: 'contact.preview',
    description: '生成一份可审计的发送预览 (联系人/通道/收件人脱敏/任务/权限/是否需要人工批准), 不发送任何东西。',
    parameters: {
      contactId: '联系人 id (必填, 来自 contact.list_authorized)',
      body: '正文 (必填)',
      subject: '主题 (可选, 邮箱用)',
      goalId: '关联的长期任务 id (可选但强烈建议; 未绑定的任务联系人会被拒绝)',
    },
    execute: async (args: Record<string, unknown>) => {
      const contactId = text(args.contactId);
      if (!contactId) return { success: false, error: 'contactId 必填 (不允许按姓名直接发送)' };
      const { decision, text: rendered } = await chain.preview({
        contactId, body: text(args.body), subject: text(args.subject) || undefined, goalId: text(args.goalId) || undefined,
      });
      return {
        success: true,
        preview: rendered,
        allowed: decision.allowed,
        blockKind: decision.blockKind,
        reason: decision.reason,
        requiresApproval: decision.requiresApproval,
        reallySent: decision.reallySent,
      };
    },
  });

  const sendLike = (name: string, description: string) => async (args: Record<string, unknown>) => {
    const contactId = text(args.contactId);
    if (!contactId) return { success: false, error: 'contactId 必填 (不允许按姓名直接发送; 用 contact.list_authorized 拿 id)' };
    const res = await chain.send({
      contactId,
      goalId: text(args.goalId) || undefined,
      runId: text(args.runId) || undefined,
      taskKind: text(args.taskKind) || undefined,
      subject: text(args.subject) || undefined,
      body: text(args.body),
      requestId: text(args.requestId) || undefined,
      replyExpected: args.replyExpected !== false,
    });
    const ok = res.status === 'sent' || res.status === 'awaiting_reply';
    return {
      success: ok,
      status: res.status,
      reason: res.reason,
      blockKind: res.blockKind,
      requestId: res.requestId,
      consentId: res.consentId,
      preview: res.preview,
      evidenceRef: res.evidenceRef,
      goalStatus: res.goalStatus,
      // 让 Agent 说人话: 被拒/等批准时必须如实转述, 不许假装已发送
      note: res.status === 'awaiting_approval'
        ? '已生成待批准请求: 需要用户在 CLI/桌面/手机点批准后才会真正发送 (首次联系/敏感内容/策略要求时必然如此)'
        : res.status === 'denied' ? `被策略拒绝 (${res.blockKind}): ${res.reason}` : undefined,
    };
  };

  const sendParams = {
    contactId: '联系人 id (必填)',
    body: '正文 (必填)',
    subject: '主题 (可选)',
    goalId: '长期任务 id (任务绑定联系人必须给)',
    runId: '当前 Run id (可选; 通信证据会写进这个 Run)',
    requestId: '幂等 id (可选; 同一个 requestId 绝不会重复发送)',
    replyExpected: '是否等待回复 (默认 true; goalId 存在时会绑定外部等待)',
  };

  ctx.tools.set('contact.send', {
    name: 'contact.send',
    description: '联系一个人 (手机号/邮箱): 经策略判定 —— 首次联系/敏感内容需要用户批准, 批量永远禁止, 未验证/已撤销一律拒绝。发送成功后若等待回复, 任务会进入 awaiting_external。',
    parameters: sendParams,
    execute: sendLike('contact.send', ''),
  });

  ctx.tools.set('contact.request_consent', {
    name: 'contact.request_consent',
    description: '就某次联系向用户请求授权 (不发送): 生成待批准请求 + 可审计预览, 用户批准后才发送。',
    parameters: sendParams,
    execute: sendLike('contact.request_consent', ''),
  });

  ctx.tools.set('contact.await_reply', {
    name: 'contact.await_reply',
    description: '查看某次联系是否在等待回复 / 是否已收到回复 / 是否超时 (只读)。',
    parameters: { requestId: '发送时拿到的 requestId (必填)' },
    execute: async (args: Record<string, unknown>) => {
      const requestId = text(args.requestId);
      if (!requestId) return { success: false, error: 'requestId 必填' };
      const rec = await chain.store.findSend(requestId);
      if (!rec) return { success: false, error: `没有 requestId=${requestId} 的发送记录` };
      const ledger = await chain.store.readLedger({ limit: 200 });
      const mine = ledger.filter((l) => l.detail.includes(requestId) || (l.contactId === rec.contactId && l.goalId === rec.goalId));
      return {
        success: true,
        status: rec.status,
        goalId: rec.goalId,
        sentAt: rec.sentAt,
        replied: mine.some((l) => l.activity === 'contact.reply_received'),
        timedOut: mine.some((l) => l.activity === 'contact.wait_expired'),
        provider: rec.provider,
        evidence: mine.slice(-5).map((l) => ({ activity: l.activity, ts: l.ts, detail: l.detail, evidenceRef: l.evidenceRef })),
      };
    },
  });

  ctx.tools.set('contact.revoke', {
    name: 'contact.revoke',
    description: '撤销某个联系方式的授权 (用户级动作; 撤销后历史证据保留但后续调用一律拒绝)。',
    parameters: { contactId: '联系人 id (必填)', reason: '撤销原因 (可选)' },
    execute: async (args: Record<string, unknown>) => {
      const contactId = text(args.contactId);
      if (!contactId) return { success: false, error: 'contactId 必填' };
      const r = await chain.revoke({ contactId, by: 'agent_request', reason: text(args.reason) || undefined });
      return { success: r.ok, error: r.error, affectedGoals: r.affectedGoals, evidenceRef: r.evidenceRef };
    },
  });

  registered.push(...CONTACT_TOOL_NAMES);
  return registered;
}
