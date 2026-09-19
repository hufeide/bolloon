/**
 * contacts/store.ts — 联系方式事实的唯一落盘层 (2026-09-19, Phase 1/4)
 *
 * 目录: ~/.bolloon/contacts/
 *   social-identity.json   SocialIdentity (DID 主身份 + 已验证 contactId 列表)
 *   contacts.json          VerifiedContact[]  (含 normalizedValue, 只在本层读写)
 *   secrets.json           Secret Store, **0600**; 记录里只引用 secretRef
 *   sent.json              SendRecord[]       (requestId 去重 + 回信关联)
 *   ledger.jsonl           只追加的通信台账 (脱敏, 可回放)
 *   outbox/                本地投递通道 (provider=local-sink) 的真落盘目录
 *
 * 纪律:
 *   - 所有写都是 tmp + rename (原子); secrets.json 额外 chmod 0600。
 *   - 读失败**不吞成空**: 解析损坏时抛/标记, 由调用方决定, 不许静默当成"没有联系方式"。
 *   - 任何对外返回值都先过 `maskContact()` —— 明文只在本层内部流转。
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  type ContactKind, type LedgerEntry, type SendRecord, type SocialIdentity, type VerifiedContact,
  displayFor, newIdentityId,
} from './types.js';

const home = () => process.env.HOME || os.homedir() || '/tmp';

export function contactsDir(homeDir?: string): string {
  return path.join(homeDir || home(), '.bolloon', 'contacts');
}
const f = (dir: string, name: string) => path.join(dir, name);

// ── 原子写 + 权限 ───────────────────────────────────────────────────────────

async function writeJsonAtomic(file: string, data: unknown, mode?: number): Promise<void> {
  // 目录可能还没建 (例如首个动作就是写 secret) → 先建, 否则 rename 必 ENOENT
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  if (mode) { try { await fsp.chmod(tmp, mode); } catch { /* 平台不支持就算了, 但要如实记 */ } }
  await fsp.rename(tmp, file);
  if (mode) { try { await fsp.chmod(file, mode); } catch { /* 同上 */ } }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as T;
  } catch (err: any) {
    if (err?.code === 'ENOENT') return null;
    // 损坏的文件绝不静默当空: 抛出去, 让上层报 degraded
    throw new Error(`联系方式存储损坏 (${file}): ${err?.message || err}`);
  }
}

// ── 对外脱敏视图 ────────────────────────────────────────────────────────────

export interface MaskedContact {
  contactId: string;
  kind: ContactKind;
  displayValue: string;
  verificationStatus: VerifiedContact['verificationStatus'];
  provider: string;
  capabilities: string[];
  policy: VerifiedContact['policy'];
  source: VerifiedContact['source'];
  trust: VerifiedContact['trust'];
  aliases: string[];
  peerDid?: string;
  verifiedAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  note?: string;
}

/** 任何离开 store 的联系方式都要走这里 (明文 → 脱敏) */
export function maskContact(c: VerifiedContact): MaskedContact {
  const { normalizedValue: _drop, consentScope: _scope, secretRef: _ref, ...rest } = c as any;
  return { ...rest, displayValue: c.displayValue || displayFor(c.kind, c.normalizedValue) } as MaskedContact;
}

// ── Secret Store ────────────────────────────────────────────────────────────

export interface SecretEntry {
  ref: string;
  provider: string;
  value: string;
  createdAt: string;
  lastVerifiedAt?: string;
}

export class SecretStore {
  private dir: string;
  constructor(dir: string) { this.dir = dir; }

  private file() { return f(this.dir, 'secrets.json'); }

  async list(): Promise<Array<Omit<SecretEntry, 'value'>>> {
    const all = (await readJson<SecretEntry[]>(this.file())) || [];
    return all.map(({ value: _v, ...rest }) => rest);
  }

  /** 真值只在这里出现; 调用方只能是 provider 适配器 */
  async get(ref: string): Promise<SecretEntry | null> {
    if (!ref) return null;
    const all = (await readJson<SecretEntry[]>(this.file())) || [];
    return all.find((s) => s.ref === ref) || null;
  }

  async put(ref: string, provider: string, value: string): Promise<void> {
    const all = (await readJson<SecretEntry[]>(this.file())) || [];
    const i = all.findIndex((s) => s.ref === ref);
    const entry: SecretEntry = { ref, provider, value, createdAt: all[i]?.createdAt || new Date().toISOString(), lastVerifiedAt: all[i]?.lastVerifiedAt };
    if (i >= 0) all[i] = entry; else all.push(entry);
    await writeJsonAtomic(this.file(), all, 0o600);
  }

  async remove(ref: string): Promise<void> {
    const all = (await readJson<SecretEntry[]>(this.file())) || [];
    await writeJsonAtomic(this.file(), all.filter((s) => s.ref !== ref), 0o600);
  }

  async has(ref: string): Promise<boolean> { return !!(await this.get(ref)); }
}

// ── 主 store ────────────────────────────────────────────────────────────────

export class ContactsStore {
  readonly dir: string;
  readonly secrets: SecretStore;

  constructor(homeDir?: string) {
    this.dir = contactsDir(homeDir);
    this.secrets = new SecretStore(this.dir);
  }

  async ensureDirs(): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true });
    await fsp.mkdir(f(this.dir, 'outbox'), { recursive: true });
  }

  // ── 身份 ──────────────────────────────────────────────────────────────────
  async getIdentity(ownerDid: string): Promise<SocialIdentity | null> {
    const ids = (await readJson<SocialIdentity[]>(f(this.dir, 'social-identity.json'))) || [];
    return ids.find((i) => i.ownerDid === ownerDid) || null;
  }

  async ensureIdentity(ownerDid: string, displayName = ''): Promise<SocialIdentity> {
    await this.ensureDirs();
    const file = f(this.dir, 'social-identity.json');
    const ids = (await readJson<SocialIdentity[]>(file)) || [];
    let id = ids.find((i) => i.ownerDid === ownerDid);
    if (!id) {
      id = {
        identityId: newIdentityId(),
        ownerDid,
        displayName,
        verifiedContacts: [],
        privacyPolicy: {
          plaintextVisibleToAgent: false,
          batchAllowed: false,
          note: '明文联系方式不进 prompt/Run/Git; 外部只看到 已验证/可联系/不可联系/需要重新授权',
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      ids.push(id);
    }
    await writeJsonAtomic(file, ids);
    return id;
  }

  // ── 联系方式 ──────────────────────────────────────────────────────────────
  async listContacts(opts: { identityId?: string } = {}): Promise<VerifiedContact[]> {
    const all = (await readJson<VerifiedContact[]>(f(this.dir, 'contacts.json'))) || [];
    return opts.identityId ? all.filter((c) => c.identityId === opts.identityId) : all;
  }

  async getContact(contactId: string): Promise<VerifiedContact | null> {
    return (await this.listContacts()).find((c) => c.contactId === contactId) || null;
  }

  /** 内部用 —— 拿明文值 (只有 provider / 回信校验该调) */
  async getNormalized(contactId: string): Promise<string | null> {
    const c = await this.getContact(contactId);
    return c ? c.normalizedValue : null;
  }

  async putContact(c: VerifiedContact): Promise<VerifiedContact> {
    await this.ensureDirs();
    const file = f(this.dir, 'contacts.json');
    const all = (await readJson<VerifiedContact[]>(file)) || [];
    const i = all.findIndex((x) => x.contactId === c.contactId);
    c.updatedAt = new Date().toISOString();
    if (i >= 0) all[i] = c; else all.push(c);
    // 2026-09-19: contacts.json 里存 normalizedValue (真发信要用它), 所以按 0600 落盘 ——
    //   明文联系方式不该有"随便能被别人读"的副本; Run/Goal/ledger 里永远只有脱敏值。
    await writeJsonAtomic(file, all, 0o600);
    // 身份里的 verifiedContacts 跟着走
    const sf = f(this.dir, 'social-identity.json');
    const ids = (await readJson<SocialIdentity[]>(sf)) || [];
    const idIdx = ids.findIndex((x) => x.identityId === c.identityId);
    if (idIdx >= 0) {
      const list = new Set(ids[idIdx].verifiedContacts);
      if (c.verificationStatus === 'verified' && !c.revokedAt) list.add(c.contactId); else list.delete(c.contactId);
      ids[idIdx].verifiedContacts = [...list];
      ids[idIdx].updatedAt = new Date().toISOString();
      await writeJsonAtomic(sf, ids);
    }
    return c;
  }

  /** 按 contactId → DID → 明确名称/别名 匹配 (禁止模糊姓名自动发送) */
  async resolve(opts: { identityId: string; contactId?: string; did?: string; name?: string }): Promise<{ contact: VerifiedContact | null; by: 'contactId' | 'did' | 'name' | 'none'; ambiguous?: boolean }> {
    const all = (await this.listContacts({ identityId: opts.identityId })).filter((c) => !c.revokedAt);
    if (opts.contactId) {
      const hit = all.find((c) => c.contactId === opts.contactId);
      return { contact: hit || null, by: hit ? 'contactId' : 'none' };
    }
    if (opts.did) {
      const hits = all.filter((c) => c.peerDid && c.peerDid === opts.did);
      if (hits.length === 1) return { contact: hits[0], by: 'did' };
      if (hits.length > 1) return { contact: null, by: 'none', ambiguous: true };
    }
    if (opts.name) {
      const n = opts.name.trim().toLowerCase();
      const hits = all.filter((c) => (c.aliases || []).some((a) => a.trim().toLowerCase() === n));
      if (hits.length === 1) return { contact: hits[0], by: 'name' };
      if (hits.length > 1) return { contact: null, by: 'none', ambiguous: true };
    }
    return { contact: null, by: 'none' };
  }

  // ── 发送台账 (去重 + 回信关联) ─────────────────────────────────────────────
  async listSends(): Promise<SendRecord[]> {
    return (await readJson<SendRecord[]>(f(this.dir, 'sent.json'))) || [];
  }

  /** 同一 requestId 已发过 → 返回旧记录 (调用方必须拒绝重复发送) */
  async findSend(requestId: string): Promise<SendRecord | null> {
    return (await this.listSends()).find((s) => s.requestId === requestId) || null;
  }

  async findSendByThread(threadToken: string): Promise<SendRecord | null> {
    return (await this.listSends()).find((s) => s.threadToken === threadToken) || null;
  }

  async recordSend(rec: SendRecord): Promise<void> {
    await this.ensureDirs();
    const file = f(this.dir, 'sent.json');
    const all = await this.listSends();
    all.push(rec);
    await writeJsonAtomic(file, all.slice(-500));
  }

  async patchSend(requestId: string, patch: Partial<SendRecord>): Promise<void> {
    const file = f(this.dir, 'sent.json');
    const all = await this.listSends();
    const i = all.findIndex((s) => s.requestId === requestId);
    if (i < 0) return;
    all[i] = { ...all[i], ...patch };
    await writeJsonAtomic(file, all.slice(-500));
  }

  /** 当天该 contact 的发送条数 (速率限制真值) */
  async countSentToday(contactId: string, now = Date.now()): Promise<number> {
    const day = new Date(now).toISOString().slice(0, 10);
    return (await this.listSends()).filter((s) => s.contactId === contactId && s.sentAt.slice(0, 10) === day && s.status === 'sent').length;
  }

  async countSentForGoal(goalId: string): Promise<number> {
    return (await this.listSends()).filter((s) => s.goalId === goalId && s.status === 'sent').length;
  }

  async markUsed(contactId: string): Promise<void> {
    const c = await this.getContact(contactId);
    if (!c) return;
    c.lastUsedAt = new Date().toISOString();
    await this.putContact(c);
  }

  // ── 待批准正文 (用户内容, 0600, 发完即删) ───────────────────────────────────
  /** 待批准时把真实正文暂存起来 —— consents.json 里只放脱敏预览 */
  async putPendingBody(requestId: string, body: string, subject?: string, exec?: { replyExpected?: boolean; replyWindowMs?: number }): Promise<void> {
    const file = path.join(this.dir, 'pending', `${requestId}.json`);
    // 2026-09-19: 执行参数 (是否等回复 / 等多久) 必须和正文一起留下来 ——
    //   否则"批准后执行"会退回默认 48h, 把用户/任务指定的等待窗口丢掉 (真跑抓到过)。
    await writeJsonAtomic(file, {
      requestId, body, subject, replyExpected: exec?.replyExpected, replyWindowMs: exec?.replyWindowMs,
      createdAt: new Date().toISOString(),
    }, 0o600);
  }

  async getPendingBody(requestId: string): Promise<{ body: string; subject?: string; replyExpected?: boolean; replyWindowMs?: number } | null> {
    try {
      const raw = JSON.parse(await fsp.readFile(path.join(this.dir, 'pending', `${requestId}.json`), 'utf8'));
      return { body: String(raw?.body || ''), subject: raw?.subject, replyExpected: raw?.replyExpected, replyWindowMs: raw?.replyWindowMs };
    } catch { return null; }
  }

  async clearPendingBody(requestId: string): Promise<void> {
    try { await fsp.unlink(path.join(this.dir, 'pending', `${requestId}.json`)); } catch { /* 没有就算了 */ }
  }

  // ── 台账 (只追加) ─────────────────────────────────────────────────────────
  evidenceRefFor(contactId: string, activity: string, ts: string): string {
    return `contact:${contactId}@${ts}#${activity}`;
  }

  async appendLedger(entry: Omit<LedgerEntry, 'evidenceRef'> & { evidenceRef?: string }): Promise<LedgerEntry> {
    await this.ensureDirs();
    const full: LedgerEntry = {
      ...entry,
      detail: String(entry.detail || '').slice(0, 300),
      evidenceRef: entry.evidenceRef || this.evidenceRefFor(entry.contactId || '-', entry.activity, entry.ts),
    };
    await fsp.appendFile(f(this.dir, 'ledger.jsonl'), JSON.stringify(full) + '\n', 'utf8');
    return full;
  }

  async readLedger(opts: { contactId?: string; goalId?: string; limit?: number } = {}): Promise<LedgerEntry[]> {
    try {
      const raw = await fsp.readFile(f(this.dir, 'ledger.jsonl'), 'utf8');
      let rows = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) as LedgerEntry; } catch { return null; } }).filter(Boolean) as LedgerEntry[];
      if (opts.contactId) rows = rows.filter((r) => r.contactId === opts.contactId);
      if (opts.goalId) rows = rows.filter((r) => r.goalId === opts.goalId);
      return opts.limit ? rows.slice(-opts.limit) : rows;
    } catch (err: any) {
      if (err?.code === 'ENOENT') return [];
      throw err;
    }
  }
}

/** 单例 (默认 HOME); 测试要隔离时直接 new ContactsStore(tmpHome) */
let _default: ContactsStore | null = null;
export function contactsStore(homeDir?: string): ContactsStore {
  if (homeDir) return new ContactsStore(homeDir);
  if (!_default) _default = new ContactsStore();
  return _default;
}
export function resetContactsStore(): void { _default = null; }

/** 文件权限自检 (doctor 用): secrets.json 必须 0600 */
export async function secretsFileMode(homeDir?: string): Promise<{ path: string; mode: string | null; ok: boolean }> {
  const p = f(contactsDir(homeDir), 'secrets.json');
  try {
    const st = fs.statSync(p);
    const mode = (st.mode & 0o777).toString(8);
    return { path: p, mode, ok: mode === '600' };
  } catch {
    return { path: p, mode: null, ok: true }; // 还没有 secret = 不算问题
  }
}
