/**
 * contacts/chain.ts — 核心链路编排 (2026-09-19, Phase 7)
 *
 * 这条链就是整个能力的价值所在:
 *   绑定 → 受约束调用 → 结果进长期任务 → 等待回复/人工确认 → Supervisor 恢复 → 证据可回放
 *
 * 与既有地基的接线 (不新造轮子):
 *   - 等待/唤醒: `external-events.ts` 的 bindExternalWait / deliverExternalEvent / expireExternalWaits
 *     (source 用新加的 `contact`) —— 所以"回复只唤醒对应 Goal""重启后仍知道在等谁"直接继承既有实现。
 *   - Goal: `goal-store.ts` (status=awaiting_external, continuation.external, unresolvedItems)
 *   - Run:  `run-store.ts` 的 addRunEvidence / recordStep —— 通信事实进 Run 证据
 *   - 审批:  `consent.ts` (同 payment-approval 的形状)
 *
 * 硬约束 (逐条落地):
 *   - 发送失败 ≠ 任务完成 (只记 contact.failed, 不动 Goal 完成判据)
 *   - 发送成功但没回复 ≠ 目标完成 (Goal 停在 awaiting_external, 由回复/超时决定)
 *   - 回复来源不可信 → 不写证据、不唤醒 (contact.reply_untrusted)
 *   - 联系人撤销后不允许重试 (revoke 时清等待 + 记 unresolved)
 *   - 同一 requestId 不重复发送 (policy 的 duplicate_request + sent.json)
 */

import { addEvidence, readGoal, setUnresolved, updateGoal } from '../goal-store.js';
import { addRunEvidence } from '../run-store.js';
import { bindExternalWait, clearExternalWait, deliverExternalEvent, expireExternalWaits, newContinuationId, defaultWaitExpiry } from '../external-events.js';
import { ContactsStore } from './store.js';
import { ContactConsentStore, setConsentExecutor, type ContactConsent } from './consent.js';
import { decideContactAction, renderPreview, type PolicyDecision } from './policy.js';
import { OtpStore, getProvider, listProviders } from './providers.js';
import {
  DEFAULT_LIMITS, displayFor, maskEmail, maskPhone, newContactId, newRequestId, newThreadToken,
  normalizeEmail, normalizePhone, redactForEvidence, type ContactActivity, type ContactKind,
  type SendRecord, type VerifiedContact,
} from './types.js';

export interface ChainDeps {
  /** 隔离 HOME (测试/验收用); 不传 = 默认 HOME */
  home?: string;
  ownerDid: string;
  displayName?: string;
  now?: () => number;
  /** 唤醒回调 (默认走 Supervisor 语义的 no-op; 单测/验收可注入真 supervisor) */
  wake?: (goalId: string) => Promise<boolean>;
}

export class ContactChain {
  readonly store: ContactsStore;
  readonly otp: OtpStore;
  readonly consents: ContactConsentStore;

  constructor(private deps: ChainDeps) {
    this.store = new ContactsStore(deps.home);
    this.otp = new OtpStore(this.store.dir);
    this.consents = new ContactConsentStore(this.store.dir);
    // 批准 → 真发送 (policy 会在发送前**再判一次**, 批准不等于免检)
    setConsentExecutor(async (c) => {
      const r = await this.performSend({
        contactId: c.contactId, goalId: c.goalId, runId: c.runId, requestId: c.requestId,
        subject: c.subject, body: '', // body 由 pending 里的 loadBody 装载 (见下)
        approvedConsentId: c.consentId,
      }, /* bodyOverride */ undefined);
      return { ok: r.status === 'sent' || r.status === 'awaiting_reply', result: JSON.stringify({ status: r.status, evidenceRef: r.evidenceRef }).slice(0, 200), error: r.reason };
    });
  }

  private now(): number { return this.deps.now ? this.deps.now() : Date.now(); }

  /** policy 上下文: store + 首次联系判定 + 待批准幂等判定 */
  private policyCtx() {
    return {
      store: this.store,
      now: this.deps.now,
      hasPendingConsent: async (requestId: string) =>
        (await this.consents.list('pending')).some((c) => c.requestId === requestId),
    };
  }

  // ── 身份 ──────────────────────────────────────────────────────────────────
  async ensureIdentity() {
    return this.store.ensureIdentity(this.deps.ownerDid, this.deps.displayName || '');
  }

  // ── 台账 → Run/Goal 证据 (脱敏后) ──────────────────────────────────────────
  private async ledger(opts: {
    activity: ContactActivity; contactId?: string; goalId?: string; runId?: string;
    eventId?: string; detail: string; evidenceRef?: string;
  }) {
    const ts = new Date(this.now()).toISOString();
    const entry = await this.store.appendLedger({ ts, ...opts });
    const line = `[contact] ${opts.activity} ${opts.detail} (evidence=${entry.evidenceRef})`.slice(0, 300);
    if (opts.runId) { try { await addRunEvidence(opts.runId, [line]); } catch { /* Run 不在就当外部事实 */ } }
    if (opts.goalId) { try { await addEvidence(opts.goalId, [line]); } catch { /* 同上 */ } }
    return entry;
  }

  // ── 绑定 (Phase 2/3): 规范化 → 隐私展示 → 发一次验证码 → pending ────────────
  async bind(opts: {
    kind: ContactKind; value: string; region?: string; provider?: string; secretRef?: string;
    aliases?: string[]; note?: string; source?: VerifiedContact['source']; peerDid?: string;
    policy?: VerifiedContact['policy']; deliverOtp?: boolean;
  }): Promise<{ ok: boolean; error?: string; contact?: VerifiedContact; challengeId?: string; channelLabel?: string; otpForLocalSink?: string }> {
    await this.store.ensureDirs();
    const id = await this.ensureIdentity();
    const norm = opts.kind === 'phone' ? normalizePhone(opts.value, opts.region || '') : normalizeEmail(opts.value);
    if (!norm.ok) return { ok: false, error: `联系方式不合法: ${norm.error}` };

    const provider = opts.provider || (opts.kind === 'phone' ? 'local-sink' : 'local-sink');
    const contact: VerifiedContact = {
      contactId: newContactId(opts.kind),
      identityId: id.identityId,
      ownerDid: this.deps.ownerDid,
      kind: opts.kind,
      normalizedValue: norm.value,
      displayValue: displayFor(opts.kind, norm.value),
      verificationStatus: 'pending_verification',
      provider,
      capabilities: [],
      consentScope: { kinds: [], taskRefs: [], grantedAt: '', grantedBy: '' },
      secretRef: opts.secretRef || '',
      limits: { ...DEFAULT_LIMITS },
      policy: opts.policy || 'send_after_approval',
      verifiedAt: null,
      lastUsedAt: null,
      revokedAt: null,
      source: opts.source || 'user_input',
      trust: opts.source === 'agent_card' ? 'unverified' : 'unverified',
      aliases: opts.aliases || [],
      peerDid: opts.peerDid,
      note: opts.note,
      createdAt: new Date(this.now()).toISOString(),
      updatedAt: new Date(this.now()).toISOString(),
    };
    await this.store.putContact(contact);
    await this.ledger({
      activity: 'contact.discovered', contactId: contact.contactId,
      detail: `${opts.kind} ${contact.displayValue} 已登记 (待验证, 通道 ${provider})`,
    });

    const { challenge, code } = await this.otp.issue({ contactId: contact.contactId, kind: opts.kind, provider, now: this.now() });
    if (opts.deliverOtp === false) return { ok: true, contact, challengeId: challenge.challengeId };

    const p = getProvider(provider);
    const channelLabel = p?.id === 'smtp' ? 'SMTP 邮件 (真实外发)' : p?.id === 'http-webhook' ? '短信网关 HTTP (真实外发)' : '本地落盘 (未真实外发)';
    const msg = {
      to: norm.value, kind: opts.kind, subject: 'Bolloon 验证码',
      body: `Bolloon 验证码: ${code} (10 分钟内有效, 请勿转发)`, threadToken: newThreadToken(), requestId: `otp-${challenge.challengeId}`,
    };
    const delivered = p ? await p.deliver(msg, { store: this.store, secretRef: contact.secretRef }) : { ok: false, reallySent: false, error: 'unknown_provider' };
    if (!delivered.ok) {
      await this.ledger({ activity: 'contact.failed', contactId: contact.contactId, detail: `验证码投递失败 (${provider}): ${String(delivered.error || '').slice(0, 120)}` });
      return { ok: false, error: `验证码投递失败: ${delivered.error}`, contact, challengeId: challenge.challengeId };
    }
    // local-sink 是本地落盘, 用户/验收要看得到码才能继续 (真外发通道不回显)
    return {
      ok: true, contact, challengeId: challenge.challengeId, channelLabel,
      otpForLocalSink: p?.emulatesRealSend === false ? code : undefined,
    };
  }

  /** 验证码校验 → verified (未验证不许用于真实发送) */
  async verify(opts: { contactId: string; challengeId: string; code: string }): Promise<{ ok: boolean; error?: string; contact?: VerifiedContact }> {
    const r = await this.otp.verify(opts.challengeId, opts.code, this.now());
    if (!r.ok) return { ok: false, error: r.reason };
    const c = await this.store.getContact(opts.contactId);
    if (!c) return { ok: false, error: 'contact_not_found' };
    c.verificationStatus = 'verified';
    c.capabilities = ['send', 'await_reply'];
    c.verifiedAt = new Date(this.now()).toISOString();
    await this.store.putContact(c);
    await this.ledger({ activity: 'contact.approved', contactId: c.contactId, detail: `${c.kind} ${c.displayValue} 验证通过 (通道 ${c.provider})` });
    return { ok: true, contact: c };
  }

  /** 任务级授权: 把某个联系方式授权给某个 Goal (Phase 7 的"任务绑定联系人") */
  async authorizeForTask(opts: { contactId: string; goalId: string; kinds?: string[]; by: string }): Promise<{ ok: boolean; error?: string; contact?: VerifiedContact }> {
    const c = await this.store.getContact(opts.contactId);
    if (!c) return { ok: false, error: 'contact_not_found' };
    if (c.verificationStatus !== 'verified') return { ok: false, error: 'unverified_contact' };
    const taskRefs = new Set(c.consentScope?.taskRefs || []);
    taskRefs.add(opts.goalId);
    c.consentScope = {
      kinds: opts.kinds || c.consentScope?.kinds || [],
      taskRefs: [...taskRefs],
      grantedAt: new Date(this.now()).toISOString(),
      grantedBy: opts.by,
    };
    await this.store.putContact(c);
    return { ok: true, contact: c };
  }

  // ── 预览 ──────────────────────────────────────────────────────────────────
  async preview(opts: { contactId: string; goalId?: string; taskKind?: string; subject?: string; body: string }): Promise<{ decision: PolicyDecision; text: string }> {
    const decision = await decideContactAction({ action: 'preview', ...opts }, this.policyCtx());
    return { decision, text: decision.preview ? renderPreview(decision.preview) : (decision.reason || '') };
  }

  // ── 发送 (唯一入口) ────────────────────────────────────────────────────────
  async send(opts: {
    contactId: string; goalId?: string; runId?: string; taskKind?: string;
    subject?: string; body: string; requestId?: string; replyExpected?: boolean;
    /** 回复等待窗口 (毫秒), 默认 48h */
    replyWindowMs?: number;
  }): Promise<{ status: 'sent' | 'awaiting_reply' | 'awaiting_approval' | 'denied' | 'failed'; reason?: string; blockKind?: string; consentId?: string; preview?: string; requestId: string; evidenceRef?: string; goalStatus?: string }> {
    const requestId = opts.requestId || newRequestId();
    const decision = await decideContactAction({ action: 'send', ...opts, requestId }, this.policyCtx());

    if (!decision.allowed) {
      await this.ledger({
        activity: 'contact.denied', contactId: opts.contactId, goalId: opts.goalId, runId: opts.runId,
        detail: `拒绝发送 (${decision.blockKind}): ${decision.reason}`,
      });
      return { status: 'denied', reason: decision.reason, blockKind: decision.blockKind, requestId, preview: decision.preview ? renderPreview(decision.preview) : undefined };
    }

    if (decision.requiresApproval) {
      const contact = await this.store.getContact(opts.contactId);
      const c = await this.consents.request({
        requestId, contactId: opts.contactId,
        contactName: (contact?.aliases?.[0]) || contact?.displayValue || opts.contactId,
        channel: contact!.kind, provider: contact!.provider, reallySent: decision.reallySent,
        subject: opts.subject, bodyPreview: redactForEvidence(opts.body).slice(0, 200),
        goalId: opts.goalId, runId: opts.runId, taskRef: opts.taskKind,
        reason: decision.approvalReason || 'policy', now: this.now(),
      });
      await this.ledger({
        activity: 'contact.authorization_requested', contactId: opts.contactId, goalId: opts.goalId, runId: opts.runId,
        detail: `等待人工批准 (${decision.approvalReason}): ${c.contactName} · 通道 ${c.provider} · requestId=${requestId}`,
      });
      // 真实正文暂存到 pending/<requestId>.json (0600, 发完即删) —— consents.json / 预览里只有脱敏内容
      await this.store.putPendingBody(requestId, opts.body, opts.subject, { replyExpected: opts.replyExpected !== false, replyWindowMs: opts.replyWindowMs });
      // 刻意**不写** sent.json 占位: 占位会让"批准后复检"把自己判成 duplicate_request。
      // 幂等改由 consent (requestId 唯一) 保证 —— 见 policy 的 hasPendingConsent。
      return { status: 'awaiting_approval', consentId: c.consentId, requestId, preview: decision.preview ? renderPreview(decision.preview) : undefined };
    }

    const r = await this.performSend({ ...opts, requestId }, undefined, decision);
    return r;
  }

  /** 真正落地的发送 (批准后也会再判一次 policy) */
  private async performSend(opts: {
    contactId: string; goalId?: string; runId?: string; taskKind?: string; subject?: string;
    body: string; requestId: string; replyExpected?: boolean; replyWindowMs?: number; approvedConsentId?: string;
  }, bodyOverride?: string, preset?: PolicyDecision): Promise<{ status: 'sent' | 'awaiting_reply' | 'denied' | 'failed'; reason?: string; blockKind?: string; requestId: string; evidenceRef?: string; goalStatus?: string; preview?: string }> {
    const body = bodyOverride ?? opts.body;
    const decision = preset && body ? preset : await decideContactAction({ action: 'send', contactId: opts.contactId, goalId: opts.goalId, taskKind: opts.taskKind, subject: opts.subject, body, requestId: opts.requestId }, this.policyCtx());
    if (!decision.allowed) {
      await this.ledger({ activity: 'contact.denied', contactId: opts.contactId, goalId: opts.goalId, runId: opts.runId, detail: `批准后复检仍被拒 (${decision.blockKind}): ${decision.reason}` });
      return { status: 'denied', reason: decision.reason, blockKind: decision.blockKind, requestId: opts.requestId };
    }

    const contact = await this.store.getContact(opts.contactId);
    if (!contact) return { status: 'denied', reason: 'contact_not_found', requestId: opts.requestId };
    const provider = getProvider(contact.provider);
    if (!provider) {
      await this.ledger({ activity: 'contact.failed', contactId: contact.contactId, goalId: opts.goalId, runId: opts.runId, detail: `未知通道 ${contact.provider}` });
      return { status: 'failed', reason: `unknown_provider:${contact.provider}`, requestId: opts.requestId };
    }

    const threadToken = newThreadToken();
    const deliver = await provider.deliver(
      { to: contact.normalizedValue, kind: contact.kind, subject: opts.subject, body, threadToken, requestId: opts.requestId },
      { store: this.store, secretRef: contact.secretRef },
    );

    const summary = redactForEvidence(body).replace(/\s+/g, ' ').slice(0, 120);
    if (!deliver.ok) {
      await this.store.patchSend(opts.requestId, { status: 'failed', failureReason: deliver.error, errorClass: deliver.errorClass });
      const ev = await this.ledger({
        activity: 'contact.failed', contactId: contact.contactId, goalId: opts.goalId, runId: opts.runId,
        detail: `发送失败 (${deliver.errorClass}): ${String(deliver.error || '').slice(0, 120)}`,
      });
      // 发送失败**不算**任务完成 —— 只记证据, 不动 Goal
      return { status: 'failed', reason: deliver.error, requestId: opts.requestId, evidenceRef: ev.evidenceRef };
    }

    const rec: SendRecord = {
      requestId: opts.requestId, contactId: contact.contactId, goalId: opts.goalId, runId: opts.runId,
      kind: contact.kind, provider: contact.provider, status: 'sent',
      providerMessageId: deliver.providerMessageId, threadToken, subject: opts.subject,
      summary, sentAt: new Date(this.now()).toISOString(),
    };
    // 批准路径已经预占了一条 failed 占位记录 (awaiting_approval) → 覆盖它
    const prior = await this.store.findSend(opts.requestId);
    if (prior) await this.store.patchSend(opts.requestId, rec); else await this.store.recordSend(rec);
    await this.store.markUsed(contact.contactId);

    const ev = await this.ledger({
      activity: 'contact.sent', contactId: contact.contactId, goalId: opts.goalId, runId: opts.runId,
      detail: `${deliver.reallySent ? '已真实外发' : '本地落盘(未真实外发)'} 通道 ${contact.provider} · 收件人 ${contact.displayValue} · ${summary}${opts.approvedConsentId ? ` · 批准 ${opts.approvedConsentId}` : ''}`,
    });
    await this.ledger({
      activity: 'contact.delivery_confirmed', contactId: contact.contactId, goalId: opts.goalId, runId: opts.runId,
      detail: `${deliver.reallySent ? '通道确认投递' : '本地落盘确认 (非真实投递)'} id=${deliver.providerMessageId || '-'}`,
    });

    // 等待回复 → 绑定外部等待 + Goal 进 awaiting_external (发送成功但没回复 ≠ 目标完成)
    if (opts.replyExpected && opts.goalId) {
      const expiresAt = new Date(this.now() + (opts.replyWindowMs ?? 48 * 60 * 60_000)).toISOString();
      const wait = {
        requestId: opts.requestId,
        continuationId: newContinuationId(opts.goalId),
        expectedSource: 'contact' as const,
        expectedEvent: 'reply',
        createdAt: new Date(this.now()).toISOString(),
        expiresAt,
        note: `等 ${contact.displayValue} 回复 (通道 ${contact.provider})`,
      };
      await bindExternalWait(opts.goalId, wait);
      await updateGoal(opts.goalId, { status: 'awaiting_external' });
      const g = await readGoal(opts.goalId);
      await this.ledger({
        activity: 'contact.authorization_requested', contactId: contact.contactId, goalId: opts.goalId, runId: opts.runId,
        detail: `等待回复绑定成功 (expiresAt=${expiresAt})`,
        evidenceRef: undefined,
      } as any).catch(() => null);
      return { status: 'awaiting_reply', requestId: opts.requestId, evidenceRef: ev.evidenceRef, goalStatus: g?.status };
    }
    return { status: 'sent', requestId: opts.requestId, evidenceRef: ev.evidenceRef, goalStatus: undefined };
  }

  /** 批准 → 执行 (把 body 从预留记录里带回来) */
  async approveAndSend(consentId: string, opts: { by?: string; via?: ContactConsent['decidedVia']; body?: string } = {}): Promise<{ ok: boolean; error?: string; status?: string; requestId?: string }> {
    const c = await this.consents.get(consentId);
    if (!c) return { ok: false, error: 'consent_not_found' };
    const pending = await this.store.getPendingBody(c.requestId);
    const body = opts.body ?? pending?.body ?? '';
    if (!body.trim()) {
      // 正文找不回来就明确失败 —— 绝不发一封空邮件出去
      await this.consents.reject(consentId, { by: opts.by || 'system', reason: 'body_missing: 待批准正文丢失, 拒绝发送' });
      return { ok: false, error: 'body_missing: 待批准正文丢失 (pending 文件不存在), 已拒绝发送', requestId: c.requestId };
    }
    setConsentExecutor(async (cons) => {
      const r = await this.performSend({
        contactId: cons.contactId, goalId: cons.goalId, runId: cons.runId, taskKind: cons.taskRef,
        subject: cons.subject, body, requestId: cons.requestId,
        // 用待批准时记下的执行参数 (不是硬编码 true / 默认 48h)
        replyExpected: pending?.replyExpected !== false,
        replyWindowMs: pending?.replyWindowMs,
        approvedConsentId: cons.consentId,
      }, body);
      return { ok: r.status === 'sent' || r.status === 'awaiting_reply', result: JSON.stringify({ status: r.status, evidenceRef: r.evidenceRef }), error: r.reason };
    });
    const r = await this.consents.approve(consentId, { by: opts.by, via: opts.via, now: this.now() });
    await this.store.clearPendingBody(c.requestId);   // 正文使命完成, 不留在盘上
    if (!r.ok) return { ok: false, error: r.error, requestId: c.requestId };
    await this.ledger({
      activity: 'contact.approved', contactId: c.contactId, goalId: c.goalId, runId: c.runId,
      detail: `人工批准 (${opts.by || 'user'}, via ${opts.via || 'cli'}) · consent=${consentId}`,
    });
    // 批准 = 用户把这条联系方式授权给了这个任务
    if (c.goalId) await this.authorizeForTask({ contactId: c.contactId, goalId: c.goalId, by: opts.by || 'user' }).catch(() => null);
    return { ok: true, status: r.consent?.status, requestId: c.requestId };
  }

  // ── 回复 (Phase 7) ────────────────────────────────────────────────────────
  async reply(input: {
    requestId?: string; threadToken?: string; from: string; body: string; eventId?: string;
  }): Promise<{ ok: boolean; reason?: string; woke?: boolean; goalId?: string; evidenceRef?: string }> {
    const rec = input.threadToken ? await this.store.findSendByThread(input.threadToken) : (input.requestId ? await this.store.findSend(input.requestId) : null);
    if (!rec) return { ok: false, reason: 'no_matching_send' };
    const contact = await this.store.getContact(rec.contactId);
    if (!contact) return { ok: false, reason: 'contact_not_found' };

    // 来源校验: 发信地址必须与绑定的联系方式一致 (否则不算证据、不唤醒)
    const normFrom = contact.kind === 'phone' ? normalizePhone(input.from, 'CN') : normalizeEmail(input.from);
    const same = normFrom.ok && normFrom.value === contact.normalizedValue;
    if (!same) {
      const ev = await this.ledger({
        activity: 'contact.reply_untrusted', contactId: contact.contactId, goalId: rec.goalId, runId: rec.runId,
        detail: `回复来源不可信 (不等于绑定的 ${contact.displayValue}) → 不计入证据、不唤醒`,
      });
      return { ok: false, reason: 'source_untrusted', evidenceRef: ev.evidenceRef };
    }

    const eventId = input.eventId || `cev-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const ev = await this.ledger({
      activity: 'contact.reply_received', contactId: contact.contactId, goalId: rec.goalId, runId: rec.runId, eventId,
      detail: `收到回复 (通道 ${contact.provider}) · ${redactForEvidence(input.body).replace(/\s+/g, ' ').slice(0, 120)}`,
    });
    await this.store.patchSend(rec.requestId, { status: 'delivery_confirmed' });

    // 只唤醒**对应的那个** Goal (correlation 由 external-events 负责)
    const delivered = await deliverExternalEvent(
      { source: 'contact', eventId, requestId: rec.requestId, goalId: rec.goalId, eventName: 'reply', payload: { body: redactForEvidence(input.body).slice(0, 300), contactId: contact.contactId, from: contact.displayValue } },
      { wake: this.deps.wake, now: this.deps.now },
    );
    return { ok: delivered.ok, reason: delivered.reason, woke: delivered.woke, goalId: delivered.goalId || rec.goalId, evidenceRef: ev.evidenceRef };
  }

  /** 等待超时: 交给 external-events 判过期 → Goal 转 needs_human (人工接手) */
  async expireWaits(): Promise<Array<{ goalId: string; reason: string; evidenceRef?: string }>> {
    const expired = await expireExternalWaits({ now: this.now() });
    const out: Array<{ goalId: string; reason: string; evidenceRef?: string }> = [];
    for (const e of expired) {
      const g = await readGoal(e.goalId);
      const ev = await this.ledger({
        activity: 'contact.wait_expired', goalId: e.goalId,
        detail: `等待回复超时 (requestId=${e.wait.requestId}, 过期于 ${e.wait.expiresAt}) → 转人工`,
      });
      await setUnresolved(e.goalId, Array.from(new Set([...(g?.unresolvedItems || []), `等待联系回复超时: ${e.wait.note || e.wait.requestId}`])));
      out.push({ goalId: e.goalId, reason: e.reason, evidenceRef: ev.evidenceRef });
    }
    return out;
  }

  // ── 撤销 (Phase 1/6) ──────────────────────────────────────────────────────
  async revoke(opts: { contactId: string; by?: string; reason?: string }): Promise<{ ok: boolean; error?: string; evidenceRef?: string; affectedGoals?: string[] }> {
    const c = await this.store.getContact(opts.contactId);
    if (!c) return { ok: false, error: 'contact_not_found' };
    c.revokedAt = new Date(this.now()).toISOString();
    c.verificationStatus = 'revoked';
    c.capabilities = [];
    await this.store.putContact(c);
    const ev = await this.ledger({
      activity: 'contact.revoked', contactId: c.contactId,
      detail: `授权撤销 (by ${opts.by || 'user'}${opts.reason ? `, ${opts.reason}` : ''}) —— 历史证据保留, 后续调用一律拒绝`,
    });
    // 撤掉的联系人还在等待回复的任务 → 清等待 + 记 unresolved (不允许重试, 也不许当完成)
    const affected: string[] = [];
    for (const s of await this.store.listSends()) {
      if (s.contactId !== c.contactId || s.status !== 'sent' || !s.goalId) continue;
      await clearExternalWait(s.goalId);
      const g = await readGoal(s.goalId);
      await setUnresolved(s.goalId, Array.from(new Set([...(g?.unresolvedItems || []), `联系人 ${c.displayValue} 已撤销授权, 该联系不可重试`])));
      affected.push(s.goalId);
    }
    return { ok: true, evidenceRef: ev.evidenceRef, affectedGoals: affected };
  }

  // ── 查询 (只给脱敏视图) ────────────────────────────────────────────────────
  async listAuthorized(): Promise<Array<{ contactId: string; kind: ContactKind; displayValue: string; status: string; provider: string; capabilities: string[]; policy: string; aliases: string[] }>> {
    await this.ensureIdentity();
    const all = await this.store.listContacts();
    const { externalStatusOf } = await import('./types.js');
    return all.map((c) => ({
      contactId: c.contactId, kind: c.kind, displayValue: c.displayValue,
      status: externalStatusOf(c), provider: c.provider, capabilities: c.capabilities,
      policy: c.policy, aliases: c.aliases || [],
    }));
  }

  channels(): Array<{ id: string; kind: ContactKind; reallySent: boolean }> { return listProviders(); }
}

/** 便捷: 一次构造 */
export function contactChain(deps: ChainDeps): ContactChain { return new ContactChain(deps); }

export { maskEmail, maskPhone };
