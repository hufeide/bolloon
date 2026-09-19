/**
 * contacts/consent.ts — 人工批准 (授权) 流程 (2026-09-19, Phase 6/7)
 *
 * 与 payment-approval.ts 同构: 首次联系/敏感内容/每次确认/策略要求时,
 * 先落一条 pending 授权请求 → 人批准后才真正发送 (executor 由 chain 注入)。
 *
 * 落盘: ~/.bolloon/contacts/consents.json
 * 关键纪律: 批准后**不绕过** policy —— executor 里会再判一次 (批准 ≠ 免检)。
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import { type ContactKind } from './types.js';

export type ConsentStatus = 'pending' | 'approved' | 'rejected' | 'executed' | 'failed' | 'expired';

export interface ContactConsent {
  consentId: string;
  requestId: string;
  contactId: string;
  /** 脱敏名 (证据里只留这个) */
  contactName: string;
  channel: ContactKind;
  provider: string;
  reallySent: boolean;
  subject?: string;
  /** 脱敏正文预览 */
  bodyPreview: string;
  goalId?: string;
  runId?: string;
  taskRef?: string;
  /** 为什么要人批: first_contact / sensitive_content / policy / each_time */
  reason: string;
  status: ConsentStatus;
  createdAt: number;
  expiresAt: number;
  decidedAt?: number;
  decidedBy?: string;
  decidedVia?: 'cli' | 'web' | 'mobile';
  result?: string;
}

export type ConsentExecutor = (c: ContactConsent) => Promise<{ ok: boolean; result?: string; error?: string }>;

let _executor: ConsentExecutor | null = null;
export function setConsentExecutor(fn: ConsentExecutor | null): void { _executor = fn; }

const DEFAULT_TTL_MS = 24 * 60 * 60_000;

export class ContactConsentStore {
  private file: string;
  private items: ContactConsent[] = [];
  private loaded = false;

  constructor(dir: string, private ttlMs = DEFAULT_TTL_MS) {
    this.file = path.join(dir, 'consents.json');
  }

  private async ensure(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = JSON.parse(await fsp.readFile(this.file, 'utf8'));
      this.items = Array.isArray(raw) ? raw : [];
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw new Error(`授权存储损坏 (${this.file}): ${err?.message || err}`);
      this.items = [];
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const tmp = `${this.file}.tmp-${process.pid}`;
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    await fsp.writeFile(tmp, JSON.stringify(this.items.slice(-300), null, 2), 'utf8');
    await fsp.rename(tmp, this.file);
  }

  async request(input: Omit<ContactConsent, 'consentId' | 'status' | 'createdAt' | 'expiresAt'> & { now?: number }): Promise<ContactConsent> {
    await this.ensure();
    const now = input.now ?? Date.now();
    const c: ContactConsent = {
      ...input,
      consentId: `cc-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      status: 'pending',
      createdAt: now,
      expiresAt: now + this.ttlMs,
    } as ContactConsent;
    this.items.push(c);
    await this.persist();
    return c;
  }

  async get(consentId: string): Promise<ContactConsent | null> {
    await this.ensure();
    return this.items.find((x) => x.consentId === consentId) || null;
  }

  async list(status?: ConsentStatus): Promise<ContactConsent[]> {
    await this.ensure();
    return status ? this.items.filter((x) => x.status === status) : [...this.items];
  }

  /** 批准 → 立刻执行 (executor 里再判 policy) */
  async approve(consentId: string, opts: { by?: string; via?: ContactConsent['decidedVia']; now?: number } = {}): Promise<{ ok: boolean; error?: string; consent?: ContactConsent }> {
    await this.ensure();
    const c = await this.get(consentId);
    if (!c) return { ok: false, error: 'consent_not_found' };
    if (c.status !== 'pending') return { ok: false, error: `授权 ${consentId} 状态 ${c.status}, 不可批准` };
    const now = opts.now ?? Date.now();
    if (c.expiresAt < now) { c.status = 'expired'; await this.persist(); return { ok: false, error: 'consent_expired' }; }
    c.status = 'approved';
    c.decidedAt = now;
    c.decidedBy = opts.by || 'user';
    c.decidedVia = opts.via || 'cli';
    await this.persist();
    if (!_executor) return { ok: true, consent: c, error: 'no_executor: 已批准但没有执行器 (调用方未注入)' };
    const r = await _executor(c);
    const fresh = await this.get(consentId);
    if (fresh) {
      fresh.status = r.ok ? 'executed' : 'failed';
      fresh.result = r.ok ? r.result : r.error;
      await this.persist();
    }
    return { ok: r.ok, error: r.ok ? undefined : r.error, consent: fresh || c };
  }

  async reject(consentId: string, opts: { by?: string; reason?: string; now?: number } = {}): Promise<{ ok: boolean; error?: string; consent?: ContactConsent }> {
    await this.ensure();
    const c = await this.get(consentId);
    if (!c) return { ok: false, error: 'consent_not_found' };
    if (c.status !== 'pending') return { ok: false, error: `授权 ${consentId} 状态 ${c.status}, 不可拒绝` };
    c.status = 'rejected';
    c.decidedAt = opts.now ?? Date.now();
    c.decidedBy = opts.by || 'user';
    c.result = opts.reason;
    await this.persist();
    return { ok: true, consent: c };
  }

  /** 过期的 pending 授权 → expired (不静默留在 pending) */
  async expireStale(now = Date.now()): Promise<ContactConsent[]> {
    await this.ensure();
    const out: ContactConsent[] = [];
    for (const c of this.items) {
      if (c.status === 'pending' && c.expiresAt < now) { c.status = 'expired'; out.push(c); }
    }
    if (out.length) await this.persist();
    return out;
  }
}
