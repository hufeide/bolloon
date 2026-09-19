/**
 * contacts/providers.ts — 通道适配器 + 验证码挑战 (2026-09-19, Phase 2/3)
 *
 * 三种通道, 各自**如实**：
 *   local-sink     本地落盘 (outbox/*.json) —— 真写文件, 但**没有真外发**; 预览/证据里必须
 *                  标成"本地落盘(非真实外发)", 不许让用户以为对方收到了。
 *   http-webhook   真 HTTP POST (短信网关/自建服务), 需要 secretRef (Bearer token)
 *   smtp           真 SMTP 会话 (net/tls, AUTH LOGIN), 需要 secretRef (host/port/user/pass/from)
 *
 * 未配置 = 明确报 `provider_not_configured` 并拒绝发送, **绝不假装成功**。
 *
 * 验证码挑战 (Phase 2/3):
 *   验证码只以 sha256(salt+code) 落盘, 明文只在"投递那一刻"存在; 有次数上限、有过期、一次性。
 */

import * as fsp from 'fs/promises';
import * as net from 'net';
import * as tls from 'tls';
import * as path from 'path';
import * as crypto from 'crypto';
import { type ContactErrorClass, type ContactKind } from './types.js';
import { type ContactsStore } from './store.js';

export interface OutboundMessage {
  /** 明文收件人 (只在 provider 内部用; 绝不进证据) */
  to: string;
  kind: ContactKind;
  subject?: string;
  body: string;
  /** 回信关联令牌 (邮件放 X-Bolloon-Thread, 短信放尾部标记) */
  threadToken: string;
  requestId: string;
  fromName?: string;
}

export interface DeliverResult {
  ok: boolean;
  providerMessageId?: string;
  /** 是否真的外发 (本地落盘 = false) */
  reallySent: boolean;
  error?: string;
  errorClass?: ContactErrorClass;
}

export interface ContactProvider {
  id: string;
  kind: ContactKind;
  /** 本地落盘 = false (证据里要说清) */
  emulatesRealSend: boolean;
  configured(store: ContactsStore, secretRef: string): Promise<boolean>;
  deliver(msg: OutboundMessage, ctx: { store: ContactsStore; secretRef: string }): Promise<DeliverResult>;
}

// ── 本地落盘 (真写文件, 但明确不是真外发) ────────────────────────────────────

export const localSinkProvider: ContactProvider = {
  id: 'local-sink',
  kind: 'phone', // kind 仅作声明; 实际两种都能落
  emulatesRealSend: false,
  async configured() { return true; },
  async deliver(msg, ctx) {
    const file = path.join(ctx.store.dir, 'outbox', `${msg.requestId}.json`);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify({
      // 明文收件人只落在这个本地文件里 (它就是"发件箱"), 不进 evidence/ledger
      to: msg.to, kind: msg.kind, subject: msg.subject, body: msg.body,
      threadToken: msg.threadToken, requestId: msg.requestId, at: new Date().toISOString(),
      channel: 'local-sink', note: '本地落盘通道: 未真实外发 (仅供开发/验收)',
    }, null, 2), 'utf8');
    return { ok: true, providerMessageId: `local-${msg.requestId}`, reallySent: false };
  },
};

// ── HTTP 网关 (真外发, 需要 secret) ─────────────────────────────────────────

export const httpWebhookProvider: ContactProvider = {
  id: 'http-webhook',
  kind: 'phone',
  emulatesRealSend: true,
  async configured(store, secretRef) { return !!(secretRef && await store.secrets.has(secretRef)); },
  async deliver(msg, ctx) {
    const secret = await ctx.store.secrets.get(ctx.secretRef);
    if (!secret) return { ok: false, reallySent: false, error: `provider_not_configured: 缺少 secretRef=${ctx.secretRef}`, errorClass: 'provider_not_configured' };
    let cfg: any;
    try { cfg = JSON.parse(secret.value); } catch { return { ok: false, reallySent: false, error: 'secret 不是合法 JSON', errorClass: 'provider_not_configured' }; }
    if (!cfg?.endpoint) return { ok: false, reallySent: false, error: 'secret 缺 endpoint', errorClass: 'provider_not_configured' };
    try {
      const res = await fetch(cfg.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}) },
        body: JSON.stringify({ to: msg.to, text: msg.body, threadToken: msg.threadToken, requestId: msg.requestId }),
      });
      const text = await res.text().catch(() => '');
      if (!res.ok) {
        const cls: ContactErrorClass = res.status === 401 || res.status === 403 ? 'provider_auth_failed' : 'provider_rejected';
        return { ok: false, reallySent: false, error: `HTTP ${res.status}: ${text.slice(0, 120)}`, errorClass: cls };
      }
      let id = '';
      try { id = String(JSON.parse(text)?.id || JSON.parse(text)?.sid || ''); } catch { /* 网关没给 id 就不编 */ }
      return { ok: true, reallySent: true, providerMessageId: id || `http-${msg.requestId}` };
    } catch (err: any) {
      return { ok: false, reallySent: false, error: String(err?.message || err), errorClass: 'provider_unreachable' };
    }
  },
};

// ── SMTP (真外发, 需要 secret) ──────────────────────────────────────────────

interface SmtpCfg { host: string; port: number; secure?: boolean; user?: string; pass?: string; from: string; tlsServername?: string }

class SmtpSession {
  private sock: net.Socket | tls.TLSSocket;
  private buf = '';
  /** 已收但还没被读走的完整行 —— 必须排队, 不能"没人等就丢" */
  private lines: string[] = [];
  private waiters: Array<(line: string) => void> = [];
  private closed = false;

  constructor(sock: net.Socket | tls.TLSSocket) {
    this.sock = sock;
    sock.setEncoding('utf8');
    sock.on('data', (d: string) => {
      this.buf += d;
      let idx: number;
      while ((idx = this.buf.indexOf('\r\n')) >= 0) {
        const line = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 2);
        const w = this.waiters.shift();
        if (w) w(line); else this.lines.push(line);   // 2026-09-19: 排队而不是丢弃
      }
    });
    sock.on('error', (err: any) => this.fail(new Error(err?.message || 'smtp_socket_error')));
    sock.on('close', () => this.fail(new Error('smtp_connection_closed')));
  }

  private fail(err: Error): void {
    this.closed = true;
    const ws = this.waiters; this.waiters = [];
    for (const w of ws) w(`__ERROR__${err.message}`);
  }

  /**
   * 读一条"完整"应答 (SMTP 多行应答: `250-续行` 到 `250 最后一行` 才算完)。
   * 2026-09-19 真跑抓到: 一条 chunk 里带多行时, 早先的实现只喂第一个等待者、**其余行被丢掉** →
   *   客户端死等超时 (表现就是"一发 EHLO 就 smtp_timeout")。
   */
  async readReply(timeoutMs = 15000): Promise<string> {
    const lines: string[] = [];
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const line = await this.nextLine(deadline - Date.now());
      if (line.startsWith('__ERROR__')) throw new Error(line.slice('__ERROR__'.length));
      lines.push(line);
      if (/^\d{3} /.test(line)) break;   // 空格 = 最后一行
    }
    return lines.join('\n');
  }

  private nextLine(timeoutMs: number): Promise<string> {
    if (this.lines.length) return Promise.resolve(this.lines.shift()!);
    if (this.closed) return Promise.reject(new Error('smtp_connection_closed'));
    return new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== fn);
        reject(new Error('smtp_timeout'));
      }, Math.max(1, timeoutMs));
      const fn = (l: string) => { clearTimeout(t); resolve(l); };
      this.waiters.push(fn);
    });
  }

  async cmd(text: string): Promise<string> {
    this.sock.write(text + '\r\n');
    return this.readReply();
  }

  write(text: string): void { this.sock.write(text); }
  end(): void { try { this.sock.end(); } catch { /* 已断 */ } }
}

function classifySmtpError(err: any, code?: string): ContactErrorClass {
  const msg = String(err?.message || err || '').toLowerCase();
  if (msg.includes('smtp_timeout')) return 'provider_unreachable';
  if (msg.includes('econnrefused') || msg.includes('etimedout') || msg.includes('enotfound') || code === 'ECONNREFUSED') return 'provider_unreachable';
  return 'unknown';
}

/** 真 SMTP 发送 (net / tls, AUTH LOGIN)。信封里的收件人只在这里出现。 */
export async function smtpDeliver(cfg: SmtpCfg, msg: OutboundMessage): Promise<DeliverResult> {
  let sock: net.Socket | tls.TLSSocket;
  let s: SmtpSession;
  try {
    sock = cfg.secure
      ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.tlsServername || cfg.host })
      : net.connect({ host: cfg.host, port: cfg.port });
    // 2026-09-19: **先挂监听再等连接** —— 服务器可能在 TCP 建好那一刻就把 "220 ..." 发过来,
    //   监听器挂晚了会丢问候语, 表现是"客户端干等到超时"(真跑 SMTP 时抓到过)。
    s = new SmtpSession(sock);
    await new Promise<void>((resolve, reject) => {
      const onErr = (e: any) => reject(e);
      if ((sock as any).connecting === false) { resolve(); return; }
      sock.once('error', onErr);
      const ev = cfg.secure ? 'secureConnect' : 'connect';
      sock.once(ev as any, () => { sock.off('error', onErr); resolve(); });
      setTimeout(() => reject(new Error('connect_timeout')), 12000).unref?.();
    });
  } catch (err: any) {
    return { ok: false, reallySent: false, error: String(err?.message || err), errorClass: 'provider_unreachable' };
  }

  try {
    const greet = await s.readReply();
    if (!/^220/.test(greet)) return { ok: false, reallySent: false, error: `SMTP 问候异常: ${greet.slice(0, 80)}`, errorClass: 'provider_rejected' };

    const ehlo = await s.cmd(`EHLO bolloon.local`);
    if (!/^250/.test(ehlo)) return { ok: false, reallySent: false, error: `EHLO 被拒: ${ehlo.slice(0, 80)}`, errorClass: 'provider_rejected' };

    if (cfg.user && cfg.pass) {
      const a1 = await s.cmd('AUTH LOGIN');
      if (!/^334/.test(a1)) return { ok: false, reallySent: false, error: `AUTH LOGIN 不支持: ${a1.slice(0, 80)}`, errorClass: 'provider_auth_failed' };
      const a2 = await s.cmd(Buffer.from(cfg.user).toString('base64'));
      if (!/^334/.test(a2)) return { ok: false, reallySent: false, error: `用户名被拒: ${a2.slice(0, 80)}`, errorClass: 'provider_auth_failed' };
      const a3 = await s.cmd(Buffer.from(cfg.pass).toString('base64'));
      if (!/^235/.test(a3)) return { ok: false, reallySent: false, error: `认证失败: ${a3.slice(0, 80)}`, errorClass: 'provider_auth_failed' };
    }

    const mf = await s.cmd(`MAIL FROM:<${cfg.from}>`);
    if (!/^250/.test(mf)) return { ok: false, reallySent: false, error: `MAIL FROM 被拒: ${mf.slice(0, 80)}`, errorClass: 'provider_rejected' };
    const rc = await s.cmd(`RCPT TO:<${msg.to}>`);
    if (!/^250/.test(rc)) return { ok: false, reallySent: false, error: `RCPT TO 被拒: ${rc.slice(0, 80)}`, errorClass: 'invalid_recipient' };
    const dt = await s.cmd('DATA');
    if (!/^354/.test(dt)) return { ok: false, reallySent: false, error: `DATA 被拒: ${dt.slice(0, 80)}`, errorClass: 'provider_rejected' };

    const body = msg.body.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
    const headers = [
      `From: ${msg.fromName ? `"${msg.fromName}" <${cfg.from}>` : cfg.from}`,
      `To: <${msg.to}>`,
      `Subject: ${msg.subject || '(无主题)'}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${msg.requestId}@bolloon>`,
      `X-Bolloon-Thread: ${msg.threadToken}`,
      `X-Bolloon-Request: ${msg.requestId}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
    ].join('\r\n');
    const sent = await s.cmd(`${headers}\r\n\r\n${body}\r\n.`);
    if (!/^250/.test(sent)) return { ok: false, reallySent: false, error: `发送被拒: ${sent.slice(0, 120)}`, errorClass: 'provider_rejected' };
    s.cmd('QUIT').catch(() => { /* 关掉就行 */ });
    const id = (sent.match(/250[ -](?:2\.0\.0\s+)?(?:Ok\s+)?(?:queued as\s+)?(\S+)/i)?.[1]) || `smtp-${msg.requestId}`;
    return { ok: true, reallySent: true, providerMessageId: id };
  } catch (err: any) {
    return { ok: false, reallySent: false, error: String(err?.message || err), errorClass: classifySmtpError(err, err?.code) };
  } finally {
    s.end();
  }
}

export const smtpProvider: ContactProvider = {
  id: 'smtp',
  kind: 'email',
  emulatesRealSend: true,
  async configured(store, secretRef) { return !!(secretRef && await store.secrets.has(secretRef)); },
  async deliver(msg, ctx) {
    const secret = await ctx.store.secrets.get(ctx.secretRef);
    if (!secret) return { ok: false, reallySent: false, error: `provider_not_configured: 缺少 secretRef=${ctx.secretRef}`, errorClass: 'provider_not_configured' };
    let cfg: SmtpCfg;
    try { cfg = JSON.parse(secret.value); } catch { return { ok: false, reallySent: false, error: 'secret 不是合法 JSON', errorClass: 'provider_not_configured' }; }
    if (!cfg?.host || !cfg?.from) return { ok: false, reallySent: false, error: 'secret 缺 host/from', errorClass: 'provider_not_configured' };
    return smtpDeliver({ ...cfg, port: cfg.port || 587 }, msg);
  },
};

const PROVIDERS: Record<string, ContactProvider> = {
  'local-sink': localSinkProvider,
  'http-webhook': httpWebhookProvider,
  smtp: smtpProvider,
};

export function getProvider(id: string): ContactProvider | null {
  return PROVIDERS[id] || null;
}
export function listProviders(): Array<{ id: string; kind: ContactKind; reallySent: boolean }> {
  return Object.values(PROVIDERS).map((p) => ({ id: p.id, kind: p.kind, reallySent: p.emulatesRealSend }));
}

// ── 验证码挑战 ──────────────────────────────────────────────────────────────

export interface OtpChallenge {
  challengeId: string;
  contactId: string;
  kind: ContactKind;
  provider: string;
  salt: string;
  codeHash: string;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
}

const OTP_TTL_MS = 10 * 60_000;
const OTP_MAX_ATTEMPTS = 5;

export function generateOtp(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

export function hashCode(code: string, salt: string): string {
  return crypto.createHash('sha256').update(`${salt}:${code}`).digest('hex');
}

export class OtpStore {
  private file: string;
  constructor(private dir: string) { this.file = path.join(dir, 'otp.json'); }

  async list(): Promise<OtpChallenge[]> {
    try { return JSON.parse(await fsp.readFile(this.file, 'utf8')) as OtpChallenge[]; }
    catch (err: any) { if (err?.code === 'ENOENT') return []; throw err; }
  }

  private async write(all: OtpChallenge[]): Promise<void> {
    const tmp = `${this.file}.tmp-${process.pid}`;
    await fsp.mkdir(this.dir, { recursive: true });
    await fsp.writeFile(tmp, JSON.stringify(all.slice(-200), null, 2), 'utf8');
    await fsp.rename(tmp, this.file);
  }

  /** 生成挑战 —— 返回明文 once (调用方马上投递, 不落盘) */
  async issue(opts: { contactId: string; kind: ContactKind; provider: string; now?: number }): Promise<{ challenge: OtpChallenge; code: string }> {
    const now = opts.now ?? Date.now();
    const code = generateOtp();
    const salt = crypto.randomBytes(8).toString('hex');
    const challenge: OtpChallenge = {
      challengeId: `otp-${now.toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
      contactId: opts.contactId, kind: opts.kind, provider: opts.provider,
      salt, codeHash: hashCode(code, salt), attempts: 0, maxAttempts: OTP_MAX_ATTEMPTS,
      createdAt: new Date(now).toISOString(), expiresAt: new Date(now + OTP_TTL_MS).toISOString(),
    };
    const all = await this.list();
    all.push(challenge);
    await this.write(all);
    return { challenge, code };
  }

  async verify(challengeId: string, code: string, now = Date.now()): Promise<{ ok: boolean; reason?: string }> {
    const all = await this.list();
    const c = all.find((x) => x.challengeId === challengeId);
    if (!c) return { ok: false, reason: 'challenge_not_found' };
    if (c.usedAt) return { ok: false, reason: 'already_used' };
    if (Date.parse(c.expiresAt) < now) return { ok: false, reason: 'expired' };
    if (c.attempts >= c.maxAttempts) return { ok: false, reason: 'too_many_attempts' };
    c.attempts += 1;
    if (hashCode(String(code).trim(), c.salt) !== c.codeHash) {
      await this.write(all);
      return { ok: false, reason: 'wrong_code' };
    }
    c.usedAt = new Date(now).toISOString();
    await this.write(all);
    return { ok: true };
  }
}
