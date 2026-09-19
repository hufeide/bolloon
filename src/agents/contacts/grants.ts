/**
 * contacts/grants.ts — 持久化联系方式能力授权 (2026-09-19, Phase 0/1/4/8)
 *
 * 与 consents.json 的分工:
 *   consents.json = **一次性**批准请求 (某个 requestId 的这一次发送)
 *   grants.json   = **长期**能力授权 (以后 Agent 能不能自动用这个能力)
 *
 * 授权等级 (内部四级 / 用户只看三个选项):
 *   none                 不允许 Agent 使用
 *   task_once            只允许当前任务        ← 用户选"仅本次任务"
 *   persistent           以后自动使用          ← 用户选"长期使用"(推荐默认)
 *   full_contact_access  联系方式能力完全授权  ← 用户选"完全授权"
 *
 * "完全访问" = **只对 phone.contact / email.contact 完全授权**, 不等于绕过系统边界:
 *   仍然保留 单收件人 / 频率 / 任务关联 / requestId 幂等 / provider 检查 / 证据 / 撤销 / Harness 拦截 / 禁止群发。
 *   支付·转账·签署·法律承诺·密钥明文 这些**永不被联系方式 Grant 放行** (见 FORBIDDEN_CATEGORIES)。
 *
 * 手机→桌面同步: Grant 由**手机设备私钥签名**, 桌面用登记过的设备公钥验签才接受;
 *   规则: 撤销优先于授权 / 低版本不覆盖高版本 / 桌面不能自铸手机授权。
 */

import * as crypto from 'crypto';
import * as fsp from 'fs/promises';
import * as path from 'path';

export type GrantLevel = 'none' | 'task_once' | 'persistent' | 'full_contact_access';
export type GrantChannels = 'phone' | 'email' | 'both';
export type GrantContactScope = 'verified_contacts' | 'all_contacts';
export type GrantTaskScope = 'current_goal' | 'matching_goals' | 'all_future_goals';
export type GrantContentScope = 'normal' | 'sensitive';
export type GrantStatus = 'active' | 'revoked' | 'expired' | 'suspended';

export interface ContactGrant {
  grantId: string;
  identityId: string;
  ownerDid: string;
  level: GrantLevel;
  channels: GrantChannels;
  contactScope: GrantContactScope;
  taskScope: GrantTaskScope;
  contentScope: GrantContentScope;
  replyWakeAllowed: boolean;
  autoSend: boolean;
  sensitiveContentAllowed: boolean;
  newRecipientAllowed: boolean;
  grantedAt: string;
  grantedBy: string;
  grantedVia: 'cli' | 'web' | 'mobile' | 'onboard';
  deviceIds: string[];
  status: GrantStatus;
  revokedAt?: string;
  revokedBy?: string;
  revokedReason?: string;
  suspendedAt?: string;
  lastUsedAt?: string;
  /** 单调递增; 低版本不允许覆盖高版本 */
  grantVersion: number;
  /** 手机侧签名 (同步副本才有) */
  signature?: GrantSignature;
}

export interface GrantSignature {
  deviceId: string;
  alg: 'ed25519';
  payloadHash: string;
  sig: string;
}

/**
 * 联系方式 Grant **永远**不能放行的内容类别 (与"完全授权"无关 —— 它们属于另一类高风险能力:
 * 凭证 / 资金指令 / 合同承诺)。注意: 卡号与身份证号属于"敏感但可在完全授权下发送"。
 */
export const FORBIDDEN_CATEGORIES = ['api_key', 'password', 'bank_account', 'payment_instruction', 'contract_commitment'] as const;

/** 用户可见的三个选项 → 内部等级 + 默认范围 */
export function presetForChoice(choice: 'task_once' | 'persistent' | 'full_contact_access'): Pick<ContactGrant,
  'level' | 'channels' | 'contactScope' | 'taskScope' | 'contentScope' | 'replyWakeAllowed' | 'autoSend' | 'sensitiveContentAllowed' | 'newRecipientAllowed'> {
  const base = {
    channels: 'both' as GrantChannels,
    replyWakeAllowed: true,
    autoSend: true,
    newRecipientAllowed: false,      // 新收件人永远要单独授权 (即使完全授权)
  };
  switch (choice) {
    case 'task_once':
      return { ...base, level: 'task_once', contactScope: 'verified_contacts', taskScope: 'current_goal', contentScope: 'normal', autoSend: false, sensitiveContentAllowed: false };
    case 'persistent':
      return { ...base, level: 'persistent', contactScope: 'verified_contacts', taskScope: 'all_future_goals', contentScope: 'normal', sensitiveContentAllowed: false };
    case 'full_contact_access':
      return { ...base, level: 'full_contact_access', contactScope: 'all_contacts', taskScope: 'all_future_goals', contentScope: 'sensitive', sensitiveContentAllowed: true };
  }
}

// ── 设备密钥 (Ed25519) ──────────────────────────────────────────────────────

export interface DeviceKey { deviceId: string; publicKeyPem: string; label?: string; registeredAt: string }

export function generateDeviceKeyPair(): { deviceId: string; publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    deviceId: `dev-${crypto.randomBytes(4).toString('hex')}`,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

/**
 * 规范化载荷 —— 签名/验签必须用同样的字段顺序 (否则"同一条 Grant"会算出不同 hash)。
 * 刻意**不含** signature 本身, 也不含 lastUsedAt (每次用都会变, 不该让签名失效)。
 */
export function canonicalGrantPayload(g: ContactGrant): string {
  const pick = {
    grantId: g.grantId, identityId: g.identityId, ownerDid: g.ownerDid, level: g.level,
    channels: g.channels, contactScope: g.contactScope, taskScope: g.taskScope, contentScope: g.contentScope,
    replyWakeAllowed: g.replyWakeAllowed, autoSend: g.autoSend, sensitiveContentAllowed: g.sensitiveContentAllowed,
    newRecipientAllowed: g.newRecipientAllowed, grantedAt: g.grantedAt, grantedBy: g.grantedBy,
    grantedVia: g.grantedVia, deviceIds: [...g.deviceIds].sort(), status: g.status, revokedAt: g.revokedAt || '',
    grantVersion: g.grantVersion,
  };
  return JSON.stringify(pick);
}

export function grantPayloadHash(g: ContactGrant): string {
  return crypto.createHash('sha256').update(canonicalGrantPayload(g)).digest('hex');
}

export function signGrant(g: ContactGrant, privateKeyPem: string, deviceId: string): GrantSignature {
  const payload = canonicalGrantPayload(g);
  const sig = crypto.sign(null, Buffer.from(payload, 'utf8'), crypto.createPrivateKey(privateKeyPem)).toString('base64');
  return { deviceId, alg: 'ed25519', payloadHash: grantPayloadHash(g), sig };
}

export function verifyGrantSignature(g: ContactGrant, pub: DeviceKey | null | undefined): { ok: boolean; reason?: string } {
  if (!g.signature) return { ok: false, reason: 'unsigned' };
  if (!pub) return { ok: false, reason: 'unknown_device' };
  if (pub.deviceId !== g.signature.deviceId) return { ok: false, reason: 'device_mismatch' };
  if (g.signature.payloadHash !== grantPayloadHash(g)) return { ok: false, reason: 'payload_tampered' };
  try {
    const ok = crypto.verify(null, Buffer.from(canonicalGrantPayload(g), 'utf8'), crypto.createPublicKey(pub.publicKeyPem), Buffer.from(g.signature.sig, 'base64'));
    return ok ? { ok: true } : { ok: false, reason: 'bad_signature' };
  } catch (err: any) {
    return { ok: false, reason: `verify_error:${err?.message || err}` };
  }
}

// ── Grant 判定 ──────────────────────────────────────────────────────────────

export type GrantBlockKind =
  | 'grant_missing' | 'grant_revoked' | 'grant_expired' | 'grant_suspended'
  | 'grant_channel_denied' | 'grant_recipient_denied' | 'grant_task_denied' | 'grant_sensitive_content_denied'
  | 'grant_device_untrusted' | 'grant_version_conflict' | 'grant_store_unreadable'
  | 'forbidden_content_category';

export interface GrantEvaluation {
  ok: boolean;
  /** 命中的 Grant (ok=true 时才有) */
  grant?: ContactGrant;
  level: GrantLevel;
  /** 是否需要退回一次性人工批准 (没有长期授权 / 授权不够) */
  needsHumanApproval: boolean;
  block?: GrantBlockKind;
  reason?: string;
  authorizationMode: 'one_time' | 'persistent' | 'full_contact_access';
  approvalSkipped: boolean;
  policyDecision: string;
}

export interface GrantCheckInput {
  ownerDid: string;
  channel: 'phone' | 'email';
  contactId: string;
  contactVerified: boolean;
  contactRevoked?: boolean;
  /** 该 contact 是否被任务级显式授权过 (老语义 taskRefs) */
  taskBoundToGoal?: boolean;
  goalId?: string;
  /** 该 Grant 的 taskScope 靠什么匹配 (matching_goals 用) */
  goalMatchesGrant?: (grant: ContactGrant, goalId: string) => boolean;
  sensitiveCategories?: string[];
  /** 内容里是否含永不放行类别 (支付/密钥/合同承诺…) */
  hasForbiddenContent?: boolean;
  deviceTrusted?: (deviceId: string) => boolean;
}

/** 内容类别 → 敏感类别名 (与 types.scanSensitive 对齐) */
export function categoriesOf(findings: Array<{ kind: string }>): string[] {
  return [...new Set(findings.map((f) => f.kind))];
}

export function evaluateGrant(grant: ContactGrant | null, input: GrantCheckInput, now = Date.now()): GrantEvaluation {
  const base = { level: 'none' as GrantLevel, needsHumanApproval: false, authorizationMode: 'one_time' as const, approvalSkipped: false, policyDecision: '' };

  // 永不放行的类别 → 直接拒绝, 与有没有 Grant 无关
  if (input.hasForbiddenContent) {
    return { ...base, ok: false, block: 'forbidden_content_category',
      reason: '内容含密码/密钥/银行账号/卡号/支付指令/合同承诺 —— 这些永不由联系方式授权放行 (属另一类高风险能力)' };
  }

  if (!grant) {
    return { ...base, ok: false, block: 'grant_missing', needsHumanApproval: true,
      reason: '没有长期联系方式授权 → 退回一次性人工批准 (批准一次不等于长期授权)', policyDecision: 'grant_missing→one_time_consent' };
  }

  const mode = grant.level === 'full_contact_access' ? 'full_contact_access' : grant.level === 'persistent' ? 'persistent' : 'one_time';

  if (grant.status === 'revoked') {
    return { ...base, level: grant.level, authorizationMode: mode, ok: false, block: 'grant_revoked',
      reason: `授权 ${grant.grantId} 已被撤销 (${grant.revokedAt || ''})`, policyDecision: `grant_revoked:${grant.grantId}` };
  }
  if (grant.status === 'expired') {
    return { ...base, level: grant.level, authorizationMode: mode, ok: false, block: 'grant_expired', reason: `授权 ${grant.grantId} 已过期`, policyDecision: `grant_expired:${grant.grantId}` };
  }
  if (grant.status === 'suspended') {
    return { ...base, level: grant.level, authorizationMode: mode, ok: false, block: 'grant_suspended', needsHumanApproval: true, reason: `授权 ${grant.grantId} 处于暂停状态`, policyDecision: `grant_suspended:${grant.grantId}` };
  }
  if (grant.level === 'none') {
    return { ...base, ok: false, block: 'grant_missing', needsHumanApproval: true, reason: '授权等级为 none (不允许 Agent 使用)', policyDecision: 'grant_none' };
  }

  // 设备可信: 同步来的 Grant 必须来自已登记设备
  if (grant.signature && input.deviceTrusted && !input.deviceTrusted(grant.signature.deviceId)) {
    return { ...base, level: grant.level, authorizationMode: mode, ok: false, block: 'grant_device_untrusted',
      reason: `授权来自未登记设备 ${grant.signature.deviceId} (桌面不认未签名/未知设备的授权)`, policyDecision: `grant_device_untrusted:${grant.signature.deviceId}` };
  }

  const channelsOk = grant.channels === 'both' || grant.channels === input.channel;
  if (!channelsOk) {
    return { ...base, level: grant.level, authorizationMode: mode, ok: false, block: 'grant_channel_denied',
      reason: `授权 ${grant.grantId} 只覆盖 ${grant.channels}, 不含 ${input.channel}`, policyDecision: `grant_channel_denied:${grant.channels}` };
  }

  if (grant.contactScope === 'verified_contacts' && !input.contactVerified) {
    return { ...base, level: grant.level, authorizationMode: mode, ok: false, block: 'grant_recipient_denied',
      reason: '授权范围是 verified_contacts, 但该联系方式未验证', policyDecision: 'grant_recipient_denied:unverified' };
  }
  // 明确点名的联系人 (经用户授权过) 永远在范围内
  if (!input.taskBoundToGoal && grant.contactScope === 'all_contacts' && !input.contactVerified) {
    return { ...base, level: grant.level, authorizationMode: mode, ok: false, block: 'grant_recipient_denied',
      reason: 'all_contacts 也只覆盖**已验证**联系人 (未验证一律不发)', policyDecision: 'grant_recipient_denied:unverified' };
  }

  const taskScopeOk =
    grant.taskScope === 'all_future_goals' ||
    (grant.taskScope === 'current_goal' && !!input.goalId && !!input.taskBoundToGoal) ||
    (grant.taskScope === 'matching_goals' && !!input.goalId && !!(input.goalMatchesGrant ? input.goalMatchesGrant(grant, input.goalId) : input.taskBoundToGoal));
  if (!taskScopeOk) {
    return { ...base, level: grant.level, authorizationMode: mode, ok: false, block: 'grant_task_denied',
      reason: `授权 ${grant.grantId} 的任务范围是 ${grant.taskScope}${input.goalId ? `, 当前任务 ${input.goalId} 不在范围内` : ' 且未指定任务'}`, policyDecision: `grant_task_denied:${grant.taskScope}` };
  }

  const sensitive = input.sensitiveCategories || [];
  if (sensitive.length > 0 && (grant.contentScope !== 'sensitive' || !grant.sensitiveContentAllowed)) {
    return { ...base, level: grant.level, authorizationMode: mode, ok: false, block: 'grant_sensitive_content_denied', needsHumanApproval: true,
      reason: `内容敏感 (${sensitive.join(', ')}) 但授权 ${grant.grantId} 的内容范围是 ${grant.contentScope} → 需要人工批准`, policyDecision: `grant_sensitive_content_denied:${sensitive.join('|')}` };
  }

  const autoOk = grant.autoSend && grant.level !== 'task_once';
  return {
    ok: true,
    grant,
    level: grant.level,
    needsHumanApproval: !autoOk,
    authorizationMode: mode,
    approvalSkipped: autoOk,
    policyDecision: `allowed:${grant.grantId}:v${grant.grantVersion}:${mode}`,
  };
}

// ── Grant Store ─────────────────────────────────────────────────────────────

export interface CreateGrantInput {
  identityId: string;
  ownerDid: string;
  choice?: 'task_once' | 'persistent' | 'full_contact_access';
  level?: GrantLevel;
  channels?: GrantChannels;
  contactScope?: GrantContactScope;
  taskScope?: GrantTaskScope;
  contentScope?: GrantContentScope;
  grantedBy: string;
  grantedVia: ContactGrant['grantedVia'];
  deviceIds?: string[];
  signature?: GrantSignature;
}

export interface SyncResult {
  ok: boolean;
  reason?: string;
  code?: GrantBlockKind;
  grant?: ContactGrant;
}

export class GrantStore {
  private dir: string;
  private grants: ContactGrant[] = [];
  private devices: DeviceKey[] = [];
  private loaded = false;
  /** 读盘失败时置位 —— 之后一切自动发送都必须 fail-closed */
  corrupt = false;

  constructor(dir: string) { this.dir = dir; }

  private grantsFile() { return path.join(this.dir, 'grants.json'); }
  private devicesFile() { return path.join(this.dir, 'devices.json'); }

  private async atomic(file: string, data: unknown, mode?: number): Promise<void> {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    if (mode) { try { await fsp.chmod(tmp, mode); } catch { /* 平台限制 */ } }
    await fsp.rename(tmp, file);
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = JSON.parse(await fsp.readFile(this.grantsFile(), 'utf8'));
      this.grants = Array.isArray(raw) ? raw : [];
      this.corrupt = false;
    } catch (err: any) {
      if (err?.code === 'ENOENT') { this.grants = []; this.corrupt = false; }
      // 损坏 → 明确置位, 绝不静默当成"没有授权"(那会变成"重新弹批准")或"已授权"
      else { this.grants = []; this.corrupt = true; }
    }
    try {
      const dev = JSON.parse(await fsp.readFile(this.devicesFile(), 'utf8'));
      this.devices = Array.isArray(dev) ? dev : [];
    } catch { this.devices = []; }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await this.atomic(this.grantsFile(), this.grants.slice(-200), 0o600);
    await this.atomic(this.devicesFile(), this.devices.slice(-50), 0o600);
  }

  // ── 设备 ──────────────────────────────────────────────────────────────────
  async registerDevice(deviceId: string, publicKeyPem: string, label?: string): Promise<DeviceKey> {
    await this.load();
    const i = this.devices.findIndex((d) => d.deviceId === deviceId);
    const entry: DeviceKey = { deviceId, publicKeyPem, label, registeredAt: new Date().toISOString() };
    if (i >= 0) this.devices[i] = entry; else this.devices.push(entry);
    await this.persist();
    return entry;
  }

  deviceTrusted(deviceId: string): boolean { return this.devices.some((d) => d.deviceId === deviceId); }
  getDevice(deviceId: string): DeviceKey | null { return this.devices.find((d) => d.deviceId === deviceId) || null; }
  async listDevices(): Promise<DeviceKey[]> { await this.load(); return [...this.devices]; }

  // ── Grant ─────────────────────────────────────────────────────────────────
  async list(): Promise<ContactGrant[]> { await this.load(); return [...this.grants]; }

  /** 当前生效的最高等级 Grant (撤销/暂停/过期的不算) */
  async activeFor(ownerDid: string, now = Date.now()): Promise<ContactGrant | null> {
    await this.load();
    if (this.corrupt) return null;
    const rank: Record<GrantLevel, number> = { none: 0, task_once: 1, persistent: 2, full_contact_access: 3 };
    const live = this.grants
      .filter((g) => g.ownerDid === ownerDid && g.status === 'active' && (!g.revokedAt))
      .sort((a, b) => (rank[b.level] - rank[a.level]) || (b.grantVersion - a.grantVersion));
    return live[0] || null;
  }

  /**
   * 最高的**管辖** Grant (不限状态) —— policy 用它区分"没有授权"与"授权被撤销/暂停/过期"。
   * 撤销/暂停的 Grant 不会再进 activeFor, 但必须能被识别出来, 否则用户只会看到含糊的"没授权"。
   */
  async latestFor(ownerDid: string): Promise<ContactGrant | null> {
    await this.load();
    if (this.corrupt) return null;
    const rank: Record<GrantLevel, number> = { none: 0, task_once: 1, persistent: 2, full_contact_access: 3 };
    const mine = this.grants.filter((g) => g.ownerDid === ownerDid);
    if (!mine.length) return null;
    return mine.sort((a, b) => (rank[b.level] - rank[a.level]) || (b.grantVersion - a.grantVersion))[0];
  }

  async get(grantId: string): Promise<ContactGrant | null> {
    await this.load();
    return this.grants.find((g) => g.grantId === grantId) || null;
  }

  async create(input: CreateGrantInput): Promise<ContactGrant> {
    await this.load();
    const preset = presetForChoice(input.choice || 'persistent');
    const now = new Date().toISOString();
    const grant: ContactGrant = {
      grantId: `gr-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
      identityId: input.identityId,
      ownerDid: input.ownerDid,
      level: input.level || preset.level,
      channels: input.channels || preset.channels,
      contactScope: input.contactScope || preset.contactScope,
      taskScope: input.taskScope || preset.taskScope,
      contentScope: input.contentScope || preset.contentScope,
      replyWakeAllowed: preset.replyWakeAllowed,
      autoSend: input.level && input.level !== 'task_once' ? true : preset.autoSend,
      sensitiveContentAllowed: input.contentScope === 'sensitive' || preset.sensitiveContentAllowed,
      newRecipientAllowed: preset.newRecipientAllowed,
      grantedAt: now,
      grantedBy: input.grantedBy,
      grantedVia: input.grantedVia,
      deviceIds: input.deviceIds || [],
      status: 'active',
      grantVersion: 1,
      signature: input.signature,
    };
    this.grants.push(grant);
    await this.persist();
    return grant;
  }

  /** 暂停 / 恢复 / 撤销 (撤销是终态: 版本 +1, 不允许重新启用同一 grantId) */
  async transition(grantId: string, action: 'pause' | 'resume' | 'revoke', opts: { by?: string; reason?: string } = {}): Promise<{ ok: boolean; error?: string; grant?: ContactGrant }> {
    await this.load();
    const g = this.grants.find((x) => x.grantId === grantId);
    if (!g) return { ok: false, error: 'grant_not_found' };
    if (g.status === 'revoked') return { ok: false, error: 'grant_already_revoked' };
    const now = new Date().toISOString();
    if (action === 'pause') { g.status = 'suspended'; g.suspendedAt = now; }
    if (action === 'resume') {
      if (g.status !== 'suspended') return { ok: false, error: `grant 状态 ${g.status}, 不能恢复` };
      g.status = 'active'; g.suspendedAt = undefined;
    }
    if (action === 'revoke') {
      g.status = 'revoked'; g.revokedAt = now; g.revokedBy = opts.by || 'user'; g.revokedReason = opts.reason;
    }
    g.grantVersion += 1;
    await this.persist();
    return { ok: true, grant: g };
  }

  async revokeAll(by: string, reason?: string): Promise<ContactGrant[]> {
    await this.load();
    const now = new Date().toISOString();
    const out: ContactGrant[] = [];
    for (const g of this.grants) {
      if (g.status === 'revoked') continue;
      g.status = 'revoked'; g.revokedAt = now; g.revokedBy = by; g.revokedReason = reason; g.grantVersion += 1;
      out.push(g);
    }
    await this.persist();
    return out;
  }

  async markUsed(grantId: string): Promise<void> {
    await this.load();
    const g = this.grants.find((x) => x.grantId === grantId);
    if (!g) return;
    g.lastUsedAt = new Date().toISOString();
    await this.persist();
  }

  /**
   * 接受手机同步来的 (已签名) Grant。
   * 规则: ① 设备必须已登记 ② 签名必须验过 ③ 撤销优先 (本地已撤销且版本 >= 来的版本 → 拒绝)
   *      ④ 低版本不覆盖高版本 ⑤ 同版本内容不同 → 冲突, 不覆盖
   */
  async applySignedSync(incoming: ContactGrant, opts: { requireSignature?: boolean } = {}): Promise<SyncResult> {
    await this.load();
    const requireSig = opts.requireSignature !== false;
    if (requireSig) {
      const dev = this.getDevice(incoming.signature?.deviceId || '');
      if (!dev) return { ok: false, code: 'grant_device_untrusted', reason: `设备 ${incoming.signature?.deviceId || '(无)'} 未登记, 拒绝接受该授权` };
      const v = verifyGrantSignature(incoming, dev);
      if (!v.ok) return { ok: false, code: 'grant_device_untrusted', reason: `签名校验失败: ${v.reason}` };
    }

    const local = this.grants.find((g) => g.grantId === incoming.grantId);
    if (!local) {
      this.grants.push({ ...incoming });
      await this.persist();
      return { ok: true, grant: incoming };
    }
    if (local.status === 'revoked' && incoming.status !== 'revoked' && incoming.grantVersion <= local.grantVersion) {
      return { ok: false, code: 'grant_version_conflict', reason: `本地 ${local.grantId} 已撤销 (v${local.grantVersion}) → 撤销优先于授权, 拒绝旧版复活` };
    }
    if (incoming.grantVersion < local.grantVersion) {
      return { ok: false, code: 'grant_version_conflict', reason: `来的版本 v${incoming.grantVersion} 低于本地 v${local.grantVersion}, 拒绝覆盖` };
    }
    if (incoming.grantVersion === local.grantVersion && canonicalGrantPayload(incoming) !== canonicalGrantPayload(local)) {
      return { ok: false, code: 'grant_version_conflict', reason: `同版本 v${incoming.grantVersion} 内容不一致, 拒绝覆盖 (撤销优先)` };
    }
    const i = this.grants.indexOf(local);
    this.grants[i] = { ...incoming };
    await this.persist();
    return { ok: true, grant: this.grants[i] };
  }

  /** 手机撤销 → 桌面收到后立即失效 (撤销事件可以带更高的版本) */
  async applyRevocation(grantId: string, opts: { by?: string; reason?: string; version?: number } = {}): Promise<SyncResult> {
    await this.load();
    const g = this.grants.find((x) => x.grantId === grantId);
    if (!g) return { ok: false, code: 'grant_missing', reason: `本地没有 ${grantId}` };
    if (g.status === 'revoked') return { ok: true, grant: g };
    g.status = 'revoked';
    g.revokedAt = new Date().toISOString();
    g.revokedBy = opts.by || 'mobile';
    g.revokedReason = opts.reason || '手机端撤销';
    g.grantVersion = Math.max(g.grantVersion + 1, opts.version || 0);
    await this.persist();
    return { ok: true, grant: g };
  }

  /** 用户可见摘要 (CLI/Web/手机同一份事实) */
  async summary(ownerDid: string): Promise<{
    grants: Array<{ grantId: string; level: GrantLevel; userLabel: string; channels: GrantChannels; contactScope: GrantContactScope;
      taskScope: GrantTaskScope; contentScope: GrantContentScope; status: GrantStatus; grantVersion: number;
      signed: boolean; deviceId?: string; grantedAt: string; grantedVia: string; lastUsedAt?: string }>;
    effective: string;
  }> {
    await this.load();
    const label: Record<GrantLevel, string> = {
      none: '不允许使用', task_once: '本次任务', persistent: '长期自动使用', full_contact_access: '完全授权联系方式能力',
    };
    const mine = this.grants.filter((g) => g.ownerDid === ownerDid);
    const active = await this.activeFor(ownerDid);
    return {
      grants: mine.map((g) => ({
        grantId: g.grantId, level: g.level, userLabel: label[g.level], channels: g.channels, contactScope: g.contactScope,
        taskScope: g.taskScope, contentScope: g.contentScope, status: g.status, grantVersion: g.grantVersion,
        signed: !!g.signature, deviceId: g.signature?.deviceId, grantedAt: g.grantedAt, grantedVia: g.grantedVia, lastUsedAt: g.lastUsedAt,
      })),
      effective: active ? `${label[active.level]} (${active.grantId} v${active.grantVersion})` : '无长期授权 (每次联系都需要人工批准)',
    };
  }
}
