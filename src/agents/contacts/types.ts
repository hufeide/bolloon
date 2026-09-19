/**
 * contacts/types.ts — 社交身份模型 (2026-09-19, Phase 0/1)
 *
 * 核心定义 (leo 冻结):
 *   Bolloon 的社交身份 = **DID 主身份 + 已验证联系方式 + 联系能力 Skill + 调用权限 + 可恢复任务证据**,
 *   不是"公开手机号/邮箱"。外部只看到四类状态: 已验证 / 可联系 / 不可联系 / 需要重新授权。
 *
 * 硬规则 (贯穿本目录所有文件):
 *   1. 明文手机号/邮箱**不进**普通 Run step、不进 prompt、不进 Git; 只有 displayValue(脱敏) 可以。
 *   2. 密钥 (API key / OAuth refresh / SMTP 密码) 只存 Secret Store, 记录里只留 secretRef。
 *   3. Goal/Run 只保存 contactId / provider / 动作 / 状态 / 证据引用。
 *   4. 未验证的联系方式**任何情况下**不能被用于真实发送。
 *   5. 撤销后历史证据保留, 但后续调用一律拒绝。
 */

// ── 基础枚举 ────────────────────────────────────────────────────────────────

export type ContactKind = 'phone' | 'email';

/** 内部完整状态 (Phase 1) */
export type VerificationStatus =
  | 'unbound'
  | 'pending_verification'
  | 'verified'
  | 'revoked'
  | 'expired'
  | 'blocked';

/** 外部只允许看到这四类 (不泄露完整值, 也不泄露内部细节) */
export type ExternalContactStatus =
  | 'verified'          // 已验证联系方式
  | 'contactable'       // 可联系
  | 'not_contactable'   // 不可联系
  | 'reauth_required';  // 需要重新授权

/** 邮箱权限分级 (Phase 3) */
export type SendPolicy = 'draft_only' | 'send_after_approval' | 'auto_send';

export interface ContactLimits {
  /** 每天最多发几条 (按 contact 计) */
  dailyMax: number;
  /** 单个任务最多发几条 */
  perTaskMax: number;
  /** true = 每次发送都要人工批准 (即使已授权任务) */
  requireApprovalEachTime: boolean;
}

export const DEFAULT_LIMITS: ContactLimits = { dailyMax: 5, perTaskMax: 3, requireApprovalEachTime: false };

/** 联系动作台账类型 (Phase 7) —— 全部写进 Run 证据 */
export type ContactActivity =
  | 'contact.discovered'
  | 'contact.authorization_requested'
  | 'contact.approved'
  | 'contact.rejected'
  | 'contact.denied'
  | 'contact.sent'
  | 'contact.delivery_confirmed'
  | 'contact.reply_received'
  | 'contact.reply_untrusted'
  | 'contact.failed'
  | 'contact.revoked'
  | 'contact.wait_expired'
  // 2026-09-19 (持久授权): 长期能力授权的生命周期
  | 'contact.grant_created'
  | 'contact.grant_synced'
  | 'contact.grant_paused'
  | 'contact.grant_resumed'
  | 'contact.grant_revoked'
  | 'contact.grant_sync_rejected';

// ── 记录形态 ────────────────────────────────────────────────────────────────

export interface SocialIdentity {
  identityId: string;
  ownerDid: string;
  displayName: string;
  /** 只放 contactId (不放明文) */
  verifiedContacts: string[];
  privacyPolicy: {
    /** 明文联系方式是否可被 Agent 看到 (第一版恒为 false) */
    plaintextVisibleToAgent: false;
    /** 是否允许批量发送 (第一版恒为 false) */
    batchAllowed: false;
    note: string;
  };
  createdAt: string;
  updatedAt: string;
}

/** VerifiedContact (Phase 1) —— 落盘形态, 不含任何明文密钥 */
export interface VerifiedContact {
  contactId: string;
  identityId: string;
  ownerDid: string;
  kind: ContactKind;
  /** 规范化后的完整值 —— 只在 store 内部用, 绝不进 prompt / evidence / 日志 */
  normalizedValue: string;
  /** 脱敏展示值 (唯一允许外泄的形态) */
  displayValue: string;
  verificationStatus: VerificationStatus;
  /** 'smtp' | 'local-sink' | 'http-webhook' ... */
  provider: string;
  /** 该联系方式允许的动作: ['send','await_reply'] 这类 */
  capabilities: string[];
  /** 授权范围: 允许联系的任务类型/白名单任务 id */
  consentScope: { kinds: string[]; taskRefs: string[]; grantedAt: string; grantedBy: string };
  /** 密钥引用 —— 真值在 Secret Store, 这里只有引用 */
  secretRef: string;
  limits: ContactLimits;
  policy: SendPolicy;
  verifiedAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  /** 联系人来源: 'user_input' | 'agent_card' | 'paired_device' */
  source: 'user_input' | 'agent_card' | 'paired_device';
  /** 可信等级 —— 从联系人卡片导入时为 'unverified' (导入 ≠ 已验证) */
  trust: 'verified' | 'unverified';
  /** 用户在任务里的称呼 (匹配优先级最低, 禁止只按模糊姓名发送) */
  aliases: string[];
  /** 关联的对方 DID (从 Agent Card 导入时有) */
  peerDid?: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

/** 发送台账 (同一 requestId 不得重复发送) */
export interface SendRecord {
  requestId: string;
  contactId: string;
  goalId?: string;
  runId?: string;
  kind: ContactKind;
  provider: string;
  status: 'sent' | 'failed' | 'delivery_confirmed';
  providerMessageId?: string;
  /** 回信关联令牌 (回信必须带对) */
  threadToken: string;
  subject?: string;
  /** 脱敏后的一句话摘要 —— 证据用 */
  summary: string;
  sentAt: string;
  failureReason?: string;
  errorClass?: ContactErrorClass;
  /** 这次发送依据的授权 (Phase 7: 以后能回答"这条消息为什么不用再问我") */
  grantId?: string;
  grantVersion?: number;
  authorizationMode?: 'one_time' | 'persistent' | 'full_contact_access';
  approvalSkipped?: boolean;
  policyDecision?: string;
}

export type ContactErrorClass =
  | 'provider_not_configured'
  | 'provider_auth_failed'
  | 'provider_unreachable'
  | 'provider_rejected'
  | 'invalid_recipient'
  | 'policy_denied'
  | 'rate_limited'
  | 'duplicate_request'
  | 'unknown';

export interface LedgerEntry {
  ts: string;
  activity: ContactActivity;
  contactId?: string;
  goalId?: string;
  runId?: string;
  /** 事件 id (去重用) */
  eventId?: string;
  /** 只允许脱敏信息 */
  detail: string;
  /** 证据引用 (可回放): contact:<contactId>@<ts>#<activity> */
  evidenceRef: string;
}

// ── 规范化 ──────────────────────────────────────────────────────────────────

const CC: Record<string, string> = {
  CN: '86', US: '1', CA: '1', JP: '81', GB: '44', DE: '49', FR: '33', IN: '91', AU: '61', SG: '65', KR: '82', RU: '7',
};

export function normalizePhone(input: string, defaultRegion = ''): { ok: true; value: string } | { ok: false; error: string } {
  const raw = String(input || '').trim();
  if (!raw) return { ok: false, error: 'empty' };
  const plus = raw.startsWith('+');
  const digits = raw.replace(/[^\d]/g, '');
  if (digits.length < 4) return { ok: false, error: 'too_short' };
  let e164: string;
  if (plus) {
    e164 = `+${digits}`;
  } else {
    const cc = CC[(defaultRegion || '').toUpperCase()];
    if (!cc) return { ok: false, error: 'region_required' };
    const local = digits.replace(/^0+/, '');
    e164 = `+${cc}${local}`;
  }
  const numDigits = e164.length - 1;
  if (numDigits < 8 || numDigits > 15) return { ok: false, error: 'invalid_length' };
  return { ok: true, value: e164 };
}

export function normalizeEmail(input: string): { ok: true; value: string } | { ok: false; error: string } {
  const raw = String(input || '').trim().toLowerCase();
  if (!raw) return { ok: false, error: 'empty' };
  if (/\s/.test(raw)) return { ok: false, error: 'contains_space' };
  const m = raw.match(/^([^@]+)@([^@]+\.[^@.]+)$/);
  if (!m) return { ok: false, error: 'invalid_format' };
  if (m[1].length > 64) return { ok: false, error: 'local_part_too_long' };
  return { ok: true, value: `${m[1]}@${m[2]}` };
}

/** 脱敏展示值 —— 唯一允许出现在 prompt / evidence / Web UI 的形态 */
export function maskPhone(e164: string): string {
  const digits = e164.replace(/[^\d]/g, '');
  if (digits.length <= 6) return `+${'*'.repeat(Math.max(0, digits.length - 2))}${digits.slice(-2)}`;
  return `+${digits.slice(0, 2)}******${digits.slice(-4)}`;
}

export function maskEmail(email: string): string {
  const [local, domain] = String(email).split('@');
  if (!domain) return '***';
  const head = local.slice(0, 1);
  return `${head}${'*'.repeat(Math.max(1, Math.min(6, local.length - 1)))}@${domain}`;
}

export function displayFor(kind: ContactKind, normalized: string): string {
  return kind === 'phone' ? maskPhone(normalized) : maskEmail(normalized);
}

/** 内部状态 → 外部四类状态 (Phase 0: 外部只看到这四个) */
export function externalStatusOf(c: Pick<VerifiedContact, 'verificationStatus' | 'policy' | 'capabilities' | 'revokedAt'>): ExternalContactStatus {
  if (c.revokedAt || c.verificationStatus === 'revoked') return 'reauth_required';
  if (c.verificationStatus === 'blocked' || c.verificationStatus === 'expired') return 'not_contactable';
  if (c.verificationStatus === 'verified') {
    return c.capabilities.includes('send') && c.policy !== 'draft_only' ? 'contactable' : 'verified';
  }
  return 'not_contactable';
}

// ── 敏感内容扫描 (Phase 6: 发送敏感信息 → 必须人工批准) ──────────────────────

export interface SensitiveFinding {
  kind: 'card_number' | 'id_number_cn' | 'api_key' | 'password' | 'otp_code' | 'bank_account';
  hint: string;
}

export function scanSensitive(text: string): SensitiveFinding[] {
  const out: SensitiveFinding[] = [];
  const s = String(text || '');
  const push = (kind: SensitiveFinding['kind'], hint: string) => {
    if (!out.some((f) => f.kind === kind && f.hint === hint)) out.push({ kind, hint });
  };
  // 卡号: 13-19 位连续数字 (允许空格/横线分隔)
  for (const m of s.matchAll(/\b(?:\d[ -]?){13,19}\b/g)) {
    const digits = m[0].replace(/[^\d]/g, '');
    if (digits.length >= 13 && digits.length <= 19) push('card_number', `${digits.slice(0, 4)}…${digits.slice(-4)}`);
  }
  // 中国大陆身份证: 17 位 + 数字/X
  for (const m of s.matchAll(/\b\d{17}[\dXx]\b/g)) push('id_number_cn', `${m[0].slice(0, 4)}…${m[0].slice(-2)}`);
  // API key / token
  for (const m of s.matchAll(/\b(sk-[A-Za-z0-9]{12,}|AKIA[0-9A-Z]{12,}|ghp_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{20,})\b/g)) {
    push('api_key', `${m[0].slice(0, 6)}…`);
  }
  if (/(密码|password|passwd|pwd)\s*[:：=]\s*\S+/i.test(s)) push('password', '疑似密码明文');
  // 一次性验证码: 只在出现"验证码/otp/code"上下文时才算
  if (/(验证码|动态码|one[-\s]?time|otp)\D{0,8}\d{4,8}/i.test(s)) push('otp_code', '疑似一次性验证码');
  // 银行账号: 10-17 位且上下文含"账号/account"
  if (/(账号|账户|account|iban)\D{0,6}\d{10,17}/i.test(s)) push('bank_account', '疑似银行账号');
  return out;
}

/**
 * 永不由联系方式授权放行的内容类别 (2026-09-19, Phase 6):
 *   凭证 / 资金指令 / 合同承诺 —— 即使 full_contact_access 也拒绝, 它们属于另一类高风险能力。
 */
export function scanForbidden(text: string): string[] {
  const s = String(text || '');
  const out = new Set<string>();
  if (/\b(sk-[A-Za-z0-9]{12,}|AKIA[0-9A-Z]{12,}|ghp_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{20,})\b/.test(s)) out.add('api_key');
  if (/(密码|password|passwd|pwd)\s*[:：=]\s*\S+/i.test(s)) out.add('password');
  if (/(账号|账户|account|iban)\D{0,6}\d{10,17}/i.test(s)) out.add('bank_account');
  if (/(转账|打款|汇款|付款指令|支付授权|remit|wire transfer|pay\s+to|send\s+funds)/i.test(s)) out.add('payment_instruction');
  if (/(签署合同|签订合同|签合同|同意采购|承诺下单|sign\s+(the\s+)?(contract|agreement)|binding\s+commitment)/i.test(s)) out.add('contract_commitment');
  return [...out];
}

/** 发送前把正文里明显的口令类内容打码 (预览与证据都走这个) */
export function redactForEvidence(text: string): string {
  let s = String(text || '');
  s = s.replace(/\b\d[ -]?(?:\d[ -]?){12,18}\d\b/g, (m) => `${m.replace(/[^\d]/g, '').slice(0, 4)}…<卡号已打码>`);
  s = s.replace(/\b(sk-|AKIA|ghp_|npm_)[A-Za-z0-9_-]{8,}\b/g, '<密钥已打码>');
  s = s.replace(/\b\d{17}[\dXx]\b/g, '<身份证已打码>');
  return s;
}

// ── id 生成 ─────────────────────────────────────────────────────────────────

const rid = (n = 8) => Math.random().toString(36).slice(2, 2 + n);

export const newContactId = (kind: ContactKind) => `ct-${kind}-${Date.now().toString(36)}-${rid(4)}`;
export const newIdentityId = () => `sid-${Date.now().toString(36)}-${rid(4)}`;
export const newRequestId = () => `creq-${Date.now().toString(36)}-${rid(6)}`;
export const newThreadToken = () => `thr-${rid(20)}`;
export const newEventId = () => `cev-${Date.now().toString(36)}-${rid(6)}`;
