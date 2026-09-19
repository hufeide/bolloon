/**
 * contacts.test.ts — 社交身份/联系方式链路单测 (2026-09-19)
 *
 * 对齐 leo 的验收矩阵里**可单测**的部分:
 *   身份: 绑定/验证/撤销 · 明文秘密不进记录 · 撤销后不可调用
 *   Skill: 未验证不能发 · 通道未配置不假装可用 · provider 失败有明确分类 · 同 requestId 不重复 · 超频拒绝
 *   任务: 已授权联系人可选 · 首次联系要批 · 发送后 awaiting_external · 回复只唤醒对应 Goal · 来源不可信不计证据
 *   双端: 配对只同步 capability · 同步载荷含明文/密钥 → 拒绝
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ContactChain } from '../agents/contacts/chain.js';
import { ContactsStore, maskContact, resetContactsStore, secretsFileMode } from '../agents/contacts/store.js';
import { decideContactAction, renderPreview } from '../agents/contacts/policy.js';
import {
  displayFor, externalStatusOf, maskEmail, maskPhone, normalizeEmail, normalizePhone,
  redactForEvidence, scanSensitive, DEFAULT_LIMITS,
} from '../agents/contacts/types.js';
import { OtpStore, generateOtp, hashCode } from '../agents/contacts/providers.js';
import { looksLikePlaintextSecret } from '../web/routes-contacts.js';
import { createGoal, readGoal } from '../agents/goal-store.js';
import { readRun, startRun } from '../agents/run-store.js';

const OWNER = 'did:key:zTestOwner';
let tmp: string;
let prevHome: string | undefined;

function chain(extra: Partial<ConstructorParameters<typeof ContactChain>[0]> = {}) {
  return new ContactChain({ home: tmp, ownerDid: OWNER, displayName: '测试用户', ...extra });
}

beforeEach(() => {
  prevHome = process.env.HOME;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-contacts-'));
  process.env.HOME = tmp;
  resetContactsStore();
});

afterEach(() => {
  if (prevHome !== undefined) process.env.HOME = prevHome;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清不掉也不影响断言 */ }
});

// ── 规范化 / 脱敏 ───────────────────────────────────────────────────────────

describe('规范化与脱敏', () => {
  it('手机号: 带 + 的 E.164 原样规范化', () => {
    expect(normalizePhone('+86 138-1234-5678')).toEqual({ ok: true, value: '+8613812345678' });
  });
  it('手机号: 无 + 时必须有 region, 否则报 region_required (不猜国家)', () => {
    expect(normalizePhone('13812345678').ok).toBe(false);
    expect(normalizePhone('13812345678', 'CN')).toEqual({ ok: true, value: '+8613812345678' });
  });
  it('手机号: 长度越界被拒', () => {
    expect(normalizePhone('+123').ok).toBe(false);
    expect(normalizePhone('+12345678901234567890').ok).toBe(false);
  });
  it('邮箱: 小写化 + 基本格式校验', () => {
    expect(normalizeEmail('  Alice@Example.COM ')).toEqual({ ok: true, value: 'alice@example.com' });
    expect(normalizeEmail('a@b').ok).toBe(false);
    expect(normalizeEmail('a b@c.com').ok).toBe(false);
  });
  it('脱敏: 手机号只留国家码与末四位', () => {
    expect(maskPhone('+8613812345678')).toBe('+86******5678');
  });
  it('脱敏: 邮箱只留首字母', () => {
    expect(maskEmail('alice@example.com')).toBe('a****@example.com');
  });
  it('displayFor 与 mask* 一致 (唯一允许外泄的形态)', () => {
    expect(displayFor('phone', '+8613812345678')).toBe(maskPhone('+8613812345678'));
    expect(displayFor('email', 'alice@example.com')).toBe(maskEmail('alice@example.com'));
  });
  it('外部状态映射: 已撤销 → 需要重新授权 (不是"不可联系")', () => {
    const mk = (v: any) => ({ verificationStatus: v, policy: 'send_after_approval', capabilities: ['send'], revokedAt: null } as any);
    expect(externalStatusOf(mk('verified'))).toBe('contactable');
    expect(externalStatusOf(mk('revoked'))).toBe('reauth_required');
    expect(externalStatusOf(mk('expired'))).toBe('not_contactable');
    expect(externalStatusOf(mk('pending_verification'))).toBe('not_contactable');
    expect(externalStatusOf({ ...mk('verified'), policy: 'draft_only' } as any)).toBe('verified');
  });
  it('脱敏记录不含明文 (maskContact 丢掉 normalizedValue/secretRef)', () => {
    const masked = maskContact({
      contactId: 'ct-1', identityId: 'i', ownerDid: OWNER, kind: 'phone',
      normalizedValue: '+8613812345678', displayValue: '+86******5678',
      verificationStatus: 'verified', provider: 'local-sink', capabilities: ['send'],
      consentScope: { kinds: [], taskRefs: [], grantedAt: '', grantedBy: '' }, secretRef: 'sec-1',
      limits: DEFAULT_LIMITS, policy: 'send_after_approval', verifiedAt: null, lastUsedAt: null,
      revokedAt: null, source: 'user_input', trust: 'unverified', aliases: [], createdAt: '', updatedAt: '',
    } as any);
    expect(JSON.stringify(masked)).not.toContain('+8613812345678');
    expect(JSON.stringify(masked)).not.toContain('sec-1');
  });
});

// ── 敏感内容 ────────────────────────────────────────────────────────────────

describe('敏感内容扫描', () => {
  it('卡号被识别', () => {
    expect(scanSensitive('请打款到 6212 3456 7890 1234').some((f) => f.kind === 'card_number')).toBe(true);
  });
  it('密钥被识别', () => {
    expect(scanSensitive('token=sk-abcdefghijklmnop').some((f) => f.kind === 'api_key')).toBe(true);
  });
  it('普通商务邮件不误报', () => {
    expect(scanSensitive('您好, 想确认一下日本市场的供货周期和 MOQ, 谢谢')).toHaveLength(0);
  });
  it('证据正文里的卡号会被打码', () => {
    expect(redactForEvidence('卡号 6212345678901234')).toContain('卡号已打码');
  });
});

// ── 绑定 / 验证 / 撤销 ──────────────────────────────────────────────────────

describe('绑定与验证 (Phase 2/3)', () => {
  it('绑定后是 pending_verification, 且拿到脱敏展示值', async () => {
    const c = chain();
    const r = await c.bind({ kind: 'phone', value: '+8613812345678' });
    expect(r.ok).toBe(true);
    expect(r.contact!.verificationStatus).toBe('pending_verification');
    expect(r.contact!.displayValue).toBe('+86******5678');
    expect(r.challengeId).toBeTruthy();
  });
  it('非法联系方式直接拒绝', async () => {
    const c = chain();
    expect((await c.bind({ kind: 'email', value: 'not-an-email' })).ok).toBe(false);
    expect((await c.bind({ kind: 'phone', value: '13812345678' })).ok).toBe(false); // 缺 region
  });
  it('验证码错误 → 不算验证通过', async () => {
    const c = chain();
    const b = await c.bind({ kind: 'email', value: 'alice@example.com' });
    expect((await c.verify({ contactId: b.contact!.contactId, challengeId: b.challengeId!, code: '000000' })).ok).toBe(false);
    expect((await c.store.getContact(b.contact!.contactId))!.verificationStatus).toBe('pending_verification');
  });
  it('验证码正确 → verified + 拿到 send 能力', async () => {
    const c = chain();
    const b = await c.bind({ kind: 'email', value: 'alice@example.com' });
    const v = await c.verify({ contactId: b.contact!.contactId, challengeId: b.challengeId!, code: b.otpForLocalSink! });
    expect(v.ok).toBe(true);
    expect(v.contact!.verificationStatus).toBe('verified');
    expect(v.contact!.capabilities).toContain('send');
  });
  it('同一验证码不能二次使用', async () => {
    const c = chain();
    const b = await c.bind({ kind: 'email', value: 'alice@example.com' });
    await c.verify({ contactId: b.contact!.contactId, challengeId: b.challengeId!, code: b.otpForLocalSink! });
    const again = await c.verify({ contactId: b.contact!.contactId, challengeId: b.challengeId!, code: b.otpForLocalSink! });
    expect(again.ok).toBe(false);
    expect(again.error).toBe('already_used');
  });
  it('验证码挑战次数用尽 → too_many_attempts', async () => {
    const otp = new OtpStore(tmp);
    const { challenge, code } = await otp.issue({ contactId: 'ct-x', kind: 'email', provider: 'local-sink' });
    for (let i = 0; i < 5; i++) await otp.verify(challenge.challengeId, '111111');
    const r = await otp.verify(challenge.challengeId, code);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('too_many_attempts');
  });
  it('验证码只以 sha256 落盘, 不存明文', async () => {
    const c = chain();
    const b = await c.bind({ kind: 'phone', value: '+8613812345678' });
    const raw = fs.readFileSync(path.join(c.store.dir, 'otp.json'), 'utf8');
    expect(raw).not.toContain(b.otpForLocalSink!);
    expect(raw).toContain(hashCode(b.otpForLocalSink!, JSON.parse(raw)[0].salt).slice(0, 16));
  });
  it('绑定失败 (通道未配置) 如实报错, 不假装成功', async () => {
    const c = chain();
    const r = await c.bind({ kind: 'phone', value: '+8613812345678', provider: 'http-webhook', secretRef: 'missing-secret' });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('验证码投递失败');
  });
});

// ── Secret Store ────────────────────────────────────────────────────────────

describe('Secret Store', () => {
  it('secret 落盘权限是 0600', async () => {
    const c = chain();
    await c.store.secrets.put('sec-smtp', 'smtp', JSON.stringify({ host: 'localhost', port: 2525, from: 'a@b.com' }));
    const mode = await secretsFileMode(tmp);
    expect(mode.ok).toBe(true);
    expect(mode.mode).toBe('600');
  });
  it('联系方式记录里只有 secretRef, 没有秘密值', async () => {
    const c = chain();
    await c.store.secrets.put('sec-smtp', 'smtp', JSON.stringify({ host: 'localhost', from: 'a@b.com', pass: 'super-secret-pass' }));
    const b = await c.bind({ kind: 'email', value: 'alice@example.com', provider: 'smtp', secretRef: 'sec-smtp' });
    const raw = fs.readFileSync(path.join(c.store.dir, 'contacts.json'), 'utf8');
    expect(raw).toContain('sec-smtp');
    expect(raw).not.toContain('super-secret-pass');
  });
  it('ledger 里不出现秘密值', async () => {
    const c = chain();
    await c.store.secrets.put('sec-smtp', 'smtp', JSON.stringify({ host: 'localhost', from: 'a@b.com', pass: 'super-secret-pass' }));
    const b = await c.bind({ kind: 'email', value: 'alice@example.com', provider: 'smtp', secretRef: 'sec-smtp' });
    const raw = fs.readFileSync(path.join(c.store.dir, 'ledger.jsonl'), 'utf8');
    expect(raw).not.toContain('super-secret-pass');
    expect(raw).toContain(b.contact!.displayValue);
  });
});

// ── 策略门 (Phase 6) ────────────────────────────────────────────────────────

describe('策略门', () => {
  async function verifiedContact(opts: { policy?: any; limits?: any; provider?: string } = {}) {
    const c = chain();
    const b = await c.bind({ kind: 'email', value: 'alice@example.com', provider: opts.provider || 'local-sink' });
    await c.verify({ contactId: b.contact!.contactId, challengeId: b.challengeId!, code: b.otpForLocalSink! });
    const contact = (await c.store.getContact(b.contact!.contactId))!;
    contact.policy = opts.policy || contact.policy;
    if (opts.limits) contact.limits = opts.limits;
    await c.store.putContact(contact);
    return { c, contactId: contact.contactId };
  }

  it('未验证联系方式: 不能发送 (unverified_contact)', async () => {
    const c = chain();
    const b = await c.bind({ kind: 'email', value: 'alice@example.com' });
    const d = await decideContactAction({ action: 'send', contactId: b.contact!.contactId, body: 'hi' }, { store: c.store });
    expect(d.allowed).toBe(false);
    expect(d.blockKind).toBe('unverified_contact');
  });
  it('批量发送永远禁止', async () => {
    const { c, contactId } = await verifiedContact();
    const d = await decideContactAction({ action: 'send', contactId, body: 'hi', recipients: [contactId, 'ct-2'] }, { store: c.store });
    expect(d.blockKind).toBe('batch_forbidden');
  });
  it('draft_only 不允许发送', async () => {
    const { c, contactId } = await verifiedContact({ policy: 'draft_only' });
    const d = await decideContactAction({ action: 'send', contactId, body: 'hi' }, { store: c.store });
    expect(d.blockKind).toBe('policy_draft_only');
  });
  it('未绑定任务 → not_bound_to_task', async () => {
    const { c, contactId } = await verifiedContact();
    const g = await createGoal({ objective: '跨境调研' });
    const d = await decideContactAction({ action: 'send', contactId, goalId: g.goalId, body: 'hi' }, { store: c.store });
    expect(d.blockKind).toBe('not_bound_to_task');
  });
  it('任务已结束 → goal_closed', async () => {
    const { c, contactId } = await verifiedContact();
    const g = await createGoal({ objective: '已完成的任务' });
    await c.authorizeForTask({ contactId, goalId: g.goalId, by: 'user' });
    const { updateGoal } = await import('../agents/goal-store.js');
    await updateGoal(g.goalId, { status: 'completed' });
    const d = await decideContactAction({ action: 'send', contactId, goalId: g.goalId, body: 'hi' }, { store: c.store });
    expect(d.blockKind).toBe('goal_closed');
  });
  it('首次联系必须人工批准', async () => {
    const { c, contactId } = await verifiedContact();
    const d = await decideContactAction({ action: 'preview', contactId, body: 'hi' }, { store: c.store });
    expect(d.allowed).toBe(true);
    expect(d.requiresApproval).toBe(true);
    expect(d.approvalReason).toBe('first_contact');
  });
  it('敏感内容必须人工批准', async () => {
    const { c, contactId } = await verifiedContact();
    // 造一条历史成功发送 → 不再是首次联系
    await c.store.recordSend({ requestId: 'r0', contactId, kind: 'email', provider: 'local-sink', status: 'sent', threadToken: 't0', summary: 'x', sentAt: new Date().toISOString() });
    const d = await decideContactAction({ action: 'preview', contactId, body: '请打款到 6212 3456 7890 1234' }, { store: c.store });
    expect(d.requiresApproval).toBe(true);
    expect(d.approvalReason).toBe('sensitive_content');
  });
  it('每天频率上限会拒绝 (rate_limited)', async () => {
    const { c, contactId } = await verifiedContact({ limits: { dailyMax: 1, perTaskMax: 5, requireApprovalEachTime: false } });
    await c.store.recordSend({ requestId: 'r1', contactId, kind: 'email', provider: 'local-sink', status: 'sent', threadToken: 't1', summary: 'x', sentAt: new Date().toISOString() });
    const d = await decideContactAction({ action: 'send', contactId, body: 'hi' }, { store: c.store });
    expect(d.blockKind).toBe('rate_limited');
  });
  it('同一 requestId 不重复发送', async () => {
    const { c, contactId } = await verifiedContact();
    const g = await createGoal({ objective: '任务' });
    await c.authorizeForTask({ contactId, goalId: g.goalId, by: 'user' });
    await c.store.recordSend({ requestId: 'dup-1', contactId, goalId: g.goalId, kind: 'email', provider: 'local-sink', status: 'sent', threadToken: 't', summary: 'x', sentAt: new Date().toISOString() });
    const d = await decideContactAction({ action: 'send', contactId, goalId: g.goalId, body: 'hi', requestId: 'dup-1' }, { store: c.store });
    expect(d.blockKind).toBe('duplicate_request');
  });
  it('通道未配置 (需要 secret 但没有) → provider_not_configured', async () => {
    // 真实验证流程走 local-sink (否则验证码都发不出去), 之后把通道换成 smtp 但不配 secret
    const { c, contactId } = await verifiedContact();
    const contact = (await c.store.getContact(contactId))!;
    contact.provider = 'smtp'; contact.secretRef = 'not-configured';
    await c.store.putContact(contact);
    const d = await decideContactAction({ action: 'preview', contactId, body: 'hi' }, { store: c.store });
    expect(d.blockKind).toBe('provider_not_configured');
  });
  it('预览里只有脱敏收件人, 并标明通道是否真外发', async () => {
    const { c, contactId } = await verifiedContact();
    const d = await decideContactAction({ action: 'preview', contactId, body: 'hello' }, { store: c.store });
    const text = renderPreview(d.preview!);
    expect(text).toContain('a****@example.com');
    expect(text).toContain('本地落盘 (未真实外发)');
    expect(text).not.toContain('alice@example.com');
  });
});

// ── 全链路: 发送 → 等待 → 回复唤醒 (Phase 7) ────────────────────────────────

describe('端到端链路 (发送/批准/回复/超时)', () => {
  async function setup() {
    const c = chain();
    const g = await createGoal({ objective: '跨境调研: 确认日本市场供货周期', successCriteria: ['拿到供应商回复'] });
    const run = await startRun({ surface: 'cli', goal: g.objective, goalId: g.goalId, agentId: 'pi' });
    const b = await c.bind({ kind: 'email', value: 'supplier@example.com', aliases: ['供应商A'], provider: 'local-sink' });
    await c.verify({ contactId: b.contact!.contactId, challengeId: b.challengeId!, code: b.otpForLocalSink! });
    const verified = (await c.store.getContact(b.contact!.contactId))!;
    verified.consentScope = { kinds: [], taskRefs: [g.goalId], grantedAt: new Date().toISOString(), grantedBy: 'user' };
    await c.store.putContact(verified);
    return { c, g, run, contactId: verified.contactId };
  }

  it('首次联系 → 生成待批准请求 (不发送) + 预览 + 台账', async () => {
    const { c, g, contactId } = await setup();
    const r = await c.send({ contactId, goalId: g.goalId, subject: '供货周期确认', body: '您好, 想确认日本市场供货周期' });
    expect(r.status).toBe('awaiting_approval');
    expect(r.consentId).toBeTruthy();
    expect(r.preview).toContain('首次联系: 是');
    const ledger = await c.store.readLedger();
    expect(ledger.some((l) => l.activity === 'contact.authorization_requested')).toBe(true);
    // 还没发出: 这次 requestId 的 outbox 文件不该存在 (outbox 里可能有验证码那次落盘)
    expect(fs.existsSync(path.join(c.store.dir, 'outbox', `${r.requestId}.json`))).toBe(false);
  });

  it('批准 → 真发送 (outbox 有文件) → Goal 进 awaiting_external + 证据入 Run', async () => {
    const { c, g, run, contactId } = await setup();
    const sent = await c.send({ contactId, goalId: g.goalId, runId: run.runId, subject: '供货周期确认', body: '您好, 想确认日本市场供货周期' });
    const ap = await c.approveAndSend(sent.consentId!, { by: 'leo', via: 'cli' });
    expect(ap.ok).toBe(true);
    const goal = (await readGoal(g.goalId))!;
    expect(goal.status).toBe('awaiting_external');
    expect(goal.continuation?.external?.expectedSource).toBe('contact');
    expect(goal.continuation?.external?.requestId).toBe(sent.requestId);
    // outbox 里应该有这一次发送的落盘文件 (验证码那次是另一个 requestId)
    expect(fs.existsSync(path.join(c.store.dir, 'outbox', `${sent.requestId}.json`))).toBe(true);
    const runRec = (await readRun(run.runId))!;
    expect(runRec.evidence!.join('\n')).toContain('contact.sent');
    // 明文绝不进 Run 证据; 只允许脱敏值 (maskEmail('supplier@example.com') = s******@example.com)
    expect(runRec.evidence!.join('\n')).not.toContain('supplier@example.com');
    expect(runRec.evidence!.join('\n')).toContain('s******@example.com');
  });

  it('对方回复 (来源正确) → 只唤醒对应 Goal + 记 reply_received', async () => {
    // wake 回调 = Supervisor.notifyExternal 的语义 (真正执行由 Supervisor 下一轮做)
    const wakes: string[] = [];
    const c = chain({ wake: async (goalId: string) => { wakes.push(goalId); return true; } });
    const g = await createGoal({ objective: '跨境调研: 确认日本市场供货周期' });
    const b = await c.bind({ kind: 'email', value: 'supplier@example.com', aliases: ['供应商A'] });
    await c.verify({ contactId: b.contact!.contactId, challengeId: b.challengeId!, code: b.otpForLocalSink! });
    const vc = (await c.store.getContact(b.contact!.contactId))!;
    vc.consentScope = { kinds: [], taskRefs: [g.goalId], grantedAt: new Date().toISOString(), grantedBy: 'user' };
    await c.store.putContact(vc);
    const contactId = vc.contactId;
    const sent = await c.send({ contactId, goalId: g.goalId, body: '您好, 想确认供货周期' });
    await c.approveAndSend(sent.consentId!, { by: 'leo' });
    expect((await readGoal(g.goalId))!.status).toBe('awaiting_external');
    const rep = await c.reply({ requestId: sent.requestId, from: 'supplier@example.com', body: '日本供货周期 6-8 周' });
    expect(rep.ok).toBe(true);
    expect(rep.woke).toBe(true);
    const goal = (await readGoal(g.goalId))!;
    expect(goal.status).not.toBe('awaiting_external');
    const ledger = await c.store.readLedger();
    expect(ledger.some((l) => l.activity === 'contact.reply_received')).toBe(true);
    expect(ledger.filter((l) => l.activity === 'contact.reply_received').length).toBe(1);
    // 同一事件重复投递 → 不重复唤醒
    const again = await c.reply({ requestId: sent.requestId, from: 'supplier@example.com', body: '日本供货周期 6-8 周', eventId: ledger.find((l) => l.activity === 'contact.reply_received')!.eventId });
    expect(again.woke).toBeFalsy();
  });

  it('回复来源不可信 → 不计证据、不唤醒', async () => {
    const { c, g, contactId } = await setup();
    const sent = await c.send({ contactId, goalId: g.goalId, body: '您好' });
    await c.approveAndSend(sent.consentId!, { by: 'leo' });
    const bad = await c.reply({ requestId: sent.requestId, from: 'attacker@evil.com', body: '我是供应商, 请打款' });
    expect(bad.ok).toBe(false);
    expect(bad.reason).toBe('source_untrusted');
    expect((await readGoal(g.goalId))!.status).toBe('awaiting_external');   // 没被唤醒
    const ledger = await c.store.readLedger();
    expect(ledger.some((l) => l.activity === 'contact.reply_untrusted')).toBe(true);
    expect(ledger.some((l) => l.activity === 'contact.reply_received')).toBe(false);
  });

  it('发送失败 → 记 failed, 不动 Goal (失败 ≠ 完成)', async () => {
    const { c, g, contactId } = await setup();
    // 换成未配置的 smtp 通道 → 真实通道失败
    const contact = (await c.store.getContact(contactId))!;
    contact.provider = 'smtp'; contact.secretRef = 'nope';
    await c.store.putContact(contact);
    const r = await c.send({ contactId, goalId: g.goalId, body: 'hi' });
    expect(r.status).toBe('denied');       // policy 先拦: provider_not_configured
    expect((await readGoal(g.goalId))!.status).not.toBe('completed');
  });

  it('等待超时 → Goal 留 unresolved + 台账 wait_expired', async () => {
    let fakeNow = Date.now();
    const c = chain({ now: () => fakeNow });
    const g = await createGoal({ objective: '等回复的任务' });
    const b = await c.bind({ kind: 'email', value: 'supplier@example.com' });
    await c.verify({ contactId: b.contact!.contactId, challengeId: b.challengeId!, code: b.otpForLocalSink! });
    const contact = (await c.store.getContact(b.contact!.contactId))!;
    contact.consentScope = { kinds: [], taskRefs: [g.goalId], grantedAt: '', grantedBy: 'user' };
    await c.store.putContact(contact);
    const sent = await c.send({ contactId: contact.contactId, goalId: g.goalId, body: 'hi', replyWindowMs: 1000 });
    await c.approveAndSend(sent.consentId!, { by: 'leo' });
    fakeNow += 5000;
    const expired = await c.expireWaits();
    expect(expired.length).toBe(1);
    const goal = (await readGoal(g.goalId))!;
    expect(goal.status).toBe('needs_human');
    expect(goal.unresolvedItems.join(' ')).toContain('超时');
  });

  it('撤销后: 后续发送被拒 + 等待中的任务留 unresolved', async () => {
    const { c, g, contactId } = await setup();
    const sent = await c.send({ contactId, goalId: g.goalId, body: 'hi' });
    await c.approveAndSend(sent.consentId!, { by: 'leo' });
    const rv = await c.revoke({ contactId, by: 'leo', reason: '不再合作' });
    expect(rv.ok).toBe(true);
    expect(rv.affectedGoals).toContain(g.goalId);
    expect((await readGoal(g.goalId))!.unresolvedItems.join(' ')).toContain('已撤销授权');
    const again = await c.send({ contactId, goalId: g.goalId, body: '再试一次' });
    expect(again.status).toBe('denied');
    expect(again.blockKind).toBe('consent_revoked');
  });
});

// ── 双端配对 (Phase 5) ──────────────────────────────────────────────────────

describe('手机—桌面配对载荷守卫', () => {
  it('明文手机号 → 拒绝', () => {
    expect(looksLikePlaintextSecret({ contacts: [{ value: '+8613812345678' }] })).toContain('疑似手机号明文');
  });
  it('明文邮箱 → 拒绝', () => {
    expect(looksLikePlaintextSecret({ contacts: [{ email: 'alice@example.com' }] })).toContain('疑似邮箱明文');
  });
  it('密钥字段 → 拒绝', () => {
    expect(looksLikePlaintextSecret({ smtp_pass: 'x' })).toContain('疑似秘密字段');
  });
  it('只传 capability 视图 → 放行', () => {
    expect(looksLikePlaintextSecret({
      contacts: [{ contactId: 'ct-1', kind: 'email', displayValue: 'a****@example.com', verificationStatus: 'verified', capabilities: ['send'], provider: 'smtp' }],
    })).toBeNull();
  });
});
