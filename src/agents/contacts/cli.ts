/**
 * contacts/cli.ts — `/contacts` 统一入口 (2026-09-19, Phase 10)
 *
 * 刻意只有三个用户入口 (leo 要求不要再堆页面):
 *   /contacts                    看联系方式 + 授权状态 + 等待中的回复
 *   /contacts authorize [选项]   一次性授予 长期/完全 授权 (默认"长期使用")
 *   /contacts revoke [目标]      暂停/撤销授权
 *
 * 输出是纯行数组, 由调用方 (CLI/Web/手机) 决定怎么上色 —— 三端读同一份 Grant 事实。
 */

import { ContactChain } from './chain.js';
import { FORBIDDEN_CATEGORIES, presetForChoice, type ContactGrant } from './grants.js';

export interface ContactsCliResult { ok: boolean; lines: string[] }

const CHOICE_ALIAS: Record<string, 'task_once' | 'persistent' | 'full_contact_access'> = {
  once: 'task_once', task: 'task_once', 'task_once': 'task_once', '本次': 'task_once', '仅本次任务': 'task_once',
  long: 'persistent', persistent: 'persistent', '长期': 'persistent', '长期使用': 'persistent',
  full: 'full_contact_access', all: 'full_contact_access', 'full_contact_access': 'full_contact_access', '完全': 'full_contact_access', '完全授权': 'full_contact_access',
};

/** 统一授权卡 (Phase 3): 用户不需要理解 phone.contact / email.contact 是两个 Skill */
export function authorizationCard(): string[] {
  const p = presetForChoice('persistent');
  const f = presetForChoice('full_contact_access');
  return [
    '让 Bolloon 代表你联系外部的人',
    '',
    '将获得权限:',
    '  ✓ 使用已验证的手机号发送消息',
    '  ✓ 使用已验证的邮箱发送邮件',
    '  ✓ 自动等待回复, 回复到达后继续执行任务',
    '  ✓ 在未来任务中自动使用 (不再逐次打断你)',
    '',
    '不会获得权限:',
    '  × 读取全部邮箱 / 读取通讯录 / 短信历史',
    '  × 群发消息 (批量永远禁止)',
    '  × 自动支付或转账',
    '  × 代表你签署合同或做承诺',
    '  × 拿到手机号/邮箱明文 (只看得到脱敏值)',
    '',
    `选项: 仅本次任务 (task_once) · 长期使用 (persistent, 推荐) · 完全授权联系方式能力 (full_contact_access)`,
    `默认长期使用: channels=${p.channels} · contactScope=${p.contactScope} · taskScope=${p.taskScope} · contentScope=${p.contentScope}`,
    `完全授权额外带来: contactScope=${f.contactScope} (仍只覆盖**已验证**联系人) · contentScope=${f.contentScope} (身份信息/项目数据可直接发)`,
    `无论哪一档都不放行: ${FORBIDDEN_CATEGORIES.join(', ')} (凭证/资金指令/合同承诺属另一类高风险能力)`,
    `无论哪一档都保留: 单收件人 · 频率限制 · 任务关联 · requestId 幂等 · provider 检查 · 发送证据 · 随时撤销`,
  ];
}

function label(g: ContactGrant): string {
  return g.level === 'full_contact_access' ? '完全授权' : g.level === 'persistent' ? '长期自动使用' : g.level === 'task_once' ? '仅本次任务' : '不允许';
}

export async function contactsCli(chain: ContactChain, rest: string): Promise<ContactsCliResult> {
  const argv = rest.split(/\s+/).filter(Boolean);
  const sub = (argv[0] || '').toLowerCase();

  // ── /contacts authorize [...] ─────────────────────────────────────────────
  if (sub === 'authorize' || sub === 'grant') {
    const choice = CHOICE_ALIAS[(argv[1] || '').toLowerCase()] || 'persistent';
    const out = authorizationCard();
    const r = await chain.authorize({ choice, grantedBy: 'leo', grantedVia: 'cli' });
    out.push('');
    out.push(`已授权: ${r.userLabel} — grantId=${r.grant!.grantId} v${r.grant!.grantVersion}`);
    out.push(`范围: channels=${r.grant!.channels} · contactScope=${r.grant!.contactScope} · taskScope=${r.grant!.taskScope} · contentScope=${r.grant!.contentScope}`);
    out.push('之后 Agent 联系已验证的人不再逐次打断你; 仍然受频率/任务/幂等/证据/撤销约束');
    out.push('随时可用: /contacts revoke all  (撤销) · /contacts pause  (暂停, 保留配置)');
    return { ok: true, lines: out };
  }

  // ── /contacts revoke [...] ────────────────────────────────────────────────
  if (sub === 'revoke') {
    const target = (argv[1] || 'all').toLowerCase();
    if (target === 'all' || target === 'grant') {
      const r = await chain.revokeAllGrants({ by: 'leo', reason: 'CLI /contacts revoke all' });
      return {
        ok: true,
        lines: [
          `已撤销授权: ${r.revoked.length ? r.revoked.join(', ') : '(没有生效中的授权)'}`,
          r.affectedGoals.length ? `受影响任务 (转人工, 不再自动唤醒): ${r.affectedGoals.join(', ')}` : '没有正在等待回复的任务受影响',
          '历史 Run/Goal 证据保留; 旧授权不能重新启用 —— 需要就要重新 /contacts authorize',
        ],
      };
    }
    const g = await chain.grants.get(target);
    if (g) {
      const r = await chain.revokeGrant(target, { by: 'leo', reason: 'CLI' });
      return { ok: r.ok, lines: [`已撤销授权 ${target}`, r.affectedGoals.length ? `受影响任务: ${r.affectedGoals.join(', ')}` : '(无等待中的任务)'] };
    }
    const rc = await chain.revoke({ contactId: target, by: 'leo', reason: 'CLI /contacts revoke' });
    if (!rc.ok) return { ok: false, lines: [`没找到授权或联系方式: ${target}`, '用法: /contacts revoke all | <grantId> | <contactId>'] };
    return { ok: true, lines: [`已撤销联系方式 ${target} 的授权 (历史证据保留, 后续调用一律拒绝)`, rc.affectedGoals?.length ? `受影响任务: ${rc.affectedGoals.join(', ')}` : '(无等待中的任务)'] };
  }

  // ── /contacts pause | resume ──────────────────────────────────────────────
  if (sub === 'pause' || sub === 'resume') {
    const g = argv[1] ? await chain.grants.get(argv[1]) : await chain.grants.activeFor(chain.ownerDid);
    if (!g) return { ok: false, lines: ['没有找到可操作的授权 (用 /contacts 看当前状态)'] };
    const r = sub === 'pause' ? await chain.pauseGrant(g.grantId, { by: 'leo' }) : await chain.resumeGrant(g.grantId, { by: 'leo' });
    return { ok: r.ok, lines: [r.ok ? `${sub === 'pause' ? '已暂停' : '已恢复'}授权 ${g.grantId} (v${r.grant?.grantVersion})` : `失败: ${r.error}`] };
  }

  // ── /contacts bind phone|email <值> [别名] ────────────────────────────────
  if (sub === 'bind') {
    const kind = (argv[1] || '').toLowerCase();
    if (kind !== 'phone' && kind !== 'email') return { ok: false, lines: ['用法: /contacts bind phone|email <号码/邮箱> [别名]'] };
    const b = await chain.bind({ kind, value: argv[2] || '', aliases: argv[3] ? [argv[3]] : undefined });
    if (!b.ok) return { ok: false, lines: [`绑定失败: ${b.error}`] };
    const lines = [
      `已登记 ${kind} ${b.contact!.displayValue} (待验证, 通道 ${b.channelLabel || b.contact!.provider})`,
      '完整' + (kind === 'phone' ? '号码' : '邮箱') + '不会进入 prompt / Run / Git; 别人只看得到脱敏值',
    ];
    if (b.otpForLocalSink) lines.push(`本地落盘通道验证码 (未真实外发): ${b.otpForLocalSink} — 用 /contacts verify ${b.contact!.contactId} <码>`);
    else lines.push(`验证码已通过通道外发, 收到后用 /contacts verify ${b.contact!.contactId} <码> 完成验证`);
    return { ok: true, lines };
  }

  if (sub === 'verify') {
    const r = await chain.verify({ contactId: argv[1] || '', challengeId: argv[3] || '', code: argv[2] || '' });
    if (!r.ok) return { ok: false, lines: [`验证失败: ${r.error}`] };
    return { ok: true, lines: [`验证通过: ${r.contact!.displayValue} (能力 ${r.contact!.capabilities.join(', ')})`, '下一步: /contacts authorize  (给长期授权) —— 验证 ≠ 自动获得长期发送权限'] };
  }

  // ── /contacts (状态) ──────────────────────────────────────────────────────
  const summary = await chain.grantsSummary();
  const contacts = await chain.listAuthorized();
  const pending = await chain.consents.list('pending');
  const sends = await chain.store.listSends();
  const lines: string[] = [];
  lines.push('联系方式与授权');
  lines.push(`  授权状态: ${summary.effective}`);
  if (summary.grants.length) {
    for (const g of summary.grants) {
      lines.push(`  · ${g.grantId} ${label({ level: g.level } as any)} [${g.status}] channels=${g.channels} contactScope=${g.contactScope} taskScope=${g.taskScope} contentScope=${g.contentScope} v${g.grantVersion}${g.signed ? ` · 手机签名(${g.deviceId})` : ''}${g.lastUsedAt ? ` · 最近使用 ${g.lastUsedAt.slice(0, 16)}` : ''}`);
    }
  } else {
    lines.push('  (没有长期授权 —— 每次联系都会打断你一次; 用 /contacts authorize 授权一次即可长期使用)');
  }
  lines.push('  联系方式:');
  if (!contacts.length) lines.push('    (还没有绑定 —— /contacts bind email 你的邮箱 / /contacts bind phone +8613… )');
  for (const c of contacts) {
    lines.push(`    · ${c.displayValue} [${c.kind}] ${c.status} · 能力 ${c.capabilities.length ? c.capabilities.join(', ') : '无'} · 策略 ${c.policy} · ${c.capabilities.includes('send') ? '可联系' : '不可联系'}`);
  }
  if (pending.length) {
    lines.push(`  待你批准 (${pending.length}):`);
    for (const p of pending) lines.push(`    · ${p.consentId} ${p.contactName} [${p.channel}] ${p.reason} · requestId=${p.requestId}`);
  } else {
    lines.push('  待你批准: 无');
  }
  const waiting = sends.filter((s) => s.status === 'sent' && s.goalId);
  lines.push(`  正在等回复: ${waiting.length ? waiting.map((s) => `${s.goalId}(${s.contactId})`).join(', ') : '无'}`);
  const last = (await chain.store.readLedger({ limit: 5 })).slice(-5);
  if (last.length) {
    lines.push('  最近通信:');
    for (const l of last) lines.push(`    · ${l.ts.slice(0, 16)} ${l.activity} ${l.detail.slice(0, 80)}`);
  }
  lines.push('  用法: /contacts authorize [once|long|full] · /contacts revoke all|<grantId> · /contacts pause|resume · /contacts bind|verify');
  return { ok: true, lines };
}
