/**
 * contacts/grant-payload.ts — Grant 载荷的**单一规范** (2026-09-19)
 *
 * 为什么单独一个文件: 手机端 (WebCrypto) 与桌面端 (Node crypto) 必须对"同一条授权"算出**同一个字节串**,
 * 否则签名永远验不过。这里只放纯函数 (无 node: 导入), 所以 browser bundle 与 Node 都能用。
 *
 * 铁律: 字段顺序固定 · 不含 signature 自身 · 不含 lastUsedAt (每次用都会变, 不该让签名失效)。
 */

export type GrantLevel = 'none' | 'task_once' | 'persistent' | 'full_contact_access';
export type GrantChannels = 'phone' | 'email' | 'both';
export type GrantContactScope = 'verified_contacts' | 'all_contacts';
export type GrantTaskScope = 'current_goal' | 'matching_goals' | 'all_future_goals';
export type GrantContentScope = 'normal' | 'sensitive';
export type GrantStatus = 'active' | 'revoked' | 'expired' | 'suspended';

/** 参与签名的字段 (顺序即规范顺序, 改动等于换协议版本) */
export const GRANT_SIGNED_FIELDS = [
  'grantId', 'identityId', 'ownerDid', 'level', 'channels', 'contactScope', 'taskScope', 'contentScope',
  'replyWakeAllowed', 'autoSend', 'sensitiveContentAllowed', 'newRecipientAllowed',
  'grantedAt', 'grantedBy', 'grantedVia', 'deviceIds', 'status', 'revokedAt', 'grantVersion',
] as const;

export interface SignableGrant {
  grantId: string; identityId: string; ownerDid: string; level: GrantLevel;
  channels: GrantChannels; contactScope: GrantContactScope; taskScope: GrantTaskScope; contentScope: GrantContentScope;
  replyWakeAllowed: boolean; autoSend: boolean; sensitiveContentAllowed: boolean; newRecipientAllowed: boolean;
  grantedAt: string; grantedBy: string; grantedVia: string; deviceIds: string[];
  status: GrantStatus; revokedAt?: string; grantVersion: number;
}

export function canonicalGrantPayload(g: SignableGrant): string {
  return JSON.stringify({
    grantId: g.grantId, identityId: g.identityId, ownerDid: g.ownerDid, level: g.level,
    channels: g.channels, contactScope: g.contactScope, taskScope: g.taskScope, contentScope: g.contentScope,
    replyWakeAllowed: g.replyWakeAllowed, autoSend: g.autoSend, sensitiveContentAllowed: g.sensitiveContentAllowed,
    newRecipientAllowed: g.newRecipientAllowed, grantedAt: g.grantedAt, grantedBy: g.grantedBy,
    grantedVia: g.grantedVia, deviceIds: [...g.deviceIds].sort(), status: g.status,
    revokedAt: g.revokedAt || '', grantVersion: g.grantVersion,
  });
}

/** 手机撤销也要签名 (否则任何本地进程都能冒充手机收回/伪造撤销) */
export interface SignableRevocation { grantId: string; grantVersion: number; revokedAt: string; by: string }

export function canonicalRevocationPayload(r: SignableRevocation): string {
  return JSON.stringify({ grantId: r.grantId, grantVersion: r.grantVersion, revokedAt: r.revokedAt, by: r.by });
}

/** 用户可见的三个选项 → 内部等级 + 默认范围 (手机端与 CLI 共用同一份, 避免两端范围不一致) */
export function presetForChoice(choice: 'task_once' | 'persistent' | 'full_contact_access'): Pick<SignableGrant,
  'level' | 'channels' | 'contactScope' | 'taskScope' | 'contentScope' | 'replyWakeAllowed' | 'autoSend' | 'sensitiveContentAllowed' | 'newRecipientAllowed'> {
  const base = { channels: 'both' as GrantChannels, replyWakeAllowed: true, autoSend: true, newRecipientAllowed: false };
  switch (choice) {
    case 'task_once':
      return { ...base, level: 'task_once', contactScope: 'verified_contacts', taskScope: 'current_goal', contentScope: 'normal', autoSend: false, sensitiveContentAllowed: false };
    case 'persistent':
      return { ...base, level: 'persistent', contactScope: 'verified_contacts', taskScope: 'all_future_goals', contentScope: 'normal', sensitiveContentAllowed: false };
    case 'full_contact_access':
      return { ...base, level: 'full_contact_access', contactScope: 'all_contacts', taskScope: 'all_future_goals', contentScope: 'sensitive', sensitiveContentAllowed: true };
  }
}

export const GRANT_LEVEL_LABEL: Record<GrantLevel, string> = {
  none: '不允许使用',
  task_once: '本次任务',
  persistent: '长期自动使用',
  full_contact_access: '完全授权联系方式能力',
};
