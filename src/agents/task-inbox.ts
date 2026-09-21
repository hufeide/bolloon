/**
 * task-inbox.ts — bolloon-task/1 收件箱 + 本机任务台账 + 结果落盘 (P3, 2026-09-21)
 *
 * 落盘布局 (全部在 `~/.bolloon/tasks/` 下, 与 M3.2 的 `<task-id>.yaml` 计划状态机同目录不冲突):
 *   inbox/<requestId>.json     收到的 TaskRequest (+ 本机的接单状态) —— 待处理收件箱
 *   local/<requestId>.json     本机**发出**的任务台账 (状态推进 / 对端回执 / 收到结果)
 *   results/<taskId>.json      已存的 TaskResult 信封 (内容哈希/CID + 签名)
 *   bodies/<taskId>.txt        **交付正文** —— 私有一层: 只在本地落盘, 绝不进公开投影/stdout
 *
 * 纪律:
 *   · 幂等: 同一个 requestId 只落一次 (`dedupeInbox` 契约层去重), 重复到达 → 返回既有事实, 不覆盖;
 *   · 任务正文 (instruction) 只在**本地**文件里, 公开投影 / Pulse / registry 里永远没有它;
 *   · 不绕过任何状态机: 本模块只做落盘/读盘, 状态合法性由 `task-contract.checkTaskMove` 判 (调用方);
 *   · 任何落盘失败都不静默吞掉事实: 返回值里带 `{ok:false, error}`。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  dedupeInbox,
  type TaskRequest, type TaskAccept, type TaskReject, type TaskResult,
  type TaskBudget, type PaymentMode, type TaskState,
} from './task-contract.js';

// ── 路径 ────────────────────────────────────────────────────────────────────

const homeOf = (home?: string): string => home || process.env.HOME || os.homedir();
export const tasksRoot = (home?: string): string => path.join(homeOf(home), '.bolloon', 'tasks');
export const inboxDir = (home?: string): string => path.join(tasksRoot(home), 'inbox');
export const localDir = (home?: string): string => path.join(tasksRoot(home), 'local');
export const resultsDir = (home?: string): string => path.join(tasksRoot(home), 'results');
export const bodiesDir = (home?: string): string => path.join(tasksRoot(home), 'bodies');

function ensure(dir: string): boolean {
  try { fs.mkdirSync(dir, { recursive: true }); return true; } catch { return false; }
}

function writeJson(file: string, value: unknown): { ok: boolean; error?: string } {
  try {
    ensure(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

function readJson<T>(file: string): T | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch { return null; }
}

/** 只允许 requestId 当文件名 (防路径穿越); 非法 → null */
function safeId(id: string): string | null {
  const s = String(id || '').trim();
  return /^[A-Za-z0-9._-]{4,128}$/.test(s) ? s : null;
}

// ── 收件箱 ──────────────────────────────────────────────────────────────────

export type InboxState = 'pending' | 'accepted' | 'rejected' | 'delivered' | 'failed';

export interface InboxItem {
  protocol: 'bolloon-task/1';
  requestId: string;
  taskId: string;
  capability: string;
  /** 任务正文 (私有一层: 只在本机文件里) */
  instruction: string;
  buyerDid: string;
  providerDid: string;
  budget?: TaskBudget;
  deadline?: number;
  paymentMode: PaymentMode;
  state: InboxState;
  receivedAt: number;
  updatedAt: number;
  /** 收到时那个请求信封的签名 (base64) —— 验签结果如实记在 requestSignatureVerified */
  requestSignature: string;
  /** true=验过且通过 · false=验过但不过 · null=没验 (绝不假装验过) */
  requestSignatureVerified: boolean | null;
  /** 发送方公钥 hex (帧里带来的公开材料; 用来验签) */
  buyerPublicKeyHex?: string | null;
  /** 提供方公钥 hex (回执/结果帧里带来的公开材料; 用来现场重验结果签名) */
  providerPublicKeyHex?: string | null;
  /** 发送方留下的回执端点 (对方自己的 task frame server), 用于把 accept/reject/result 发回去 */
  replyTo?: string | null;
  accept?: TaskAccept;
  reject?: TaskReject;
  result?: TaskResult;
  resultVerified?: boolean | null;
  note?: string;
}

const inboxFile = (requestId: string, home?: string): string | null => {
  const id = safeId(requestId);
  return id ? path.join(inboxDir(home), `${id}.json`) : null;
};

export function listInbox(home?: string): InboxItem[] {
  try {
    const dir = inboxDir(home);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => readJson<InboxItem>(path.join(dir, f)))
      .filter((x): x is InboxItem => !!x?.requestId)
      .sort((a, b) => b.receivedAt - a.receivedAt);
  } catch { return []; }
}

export function readInboxItem(requestId: string, home?: string): InboxItem | null {
  const f = inboxFile(requestId, home);
  return f ? readJson<InboxItem>(f) : null;
}

export function writeInboxItem(item: InboxItem, home?: string): { ok: boolean; error?: string } {
  const f = inboxFile(item.requestId, home);
  if (!f) return { ok: false, error: `requestId 非法 (不能当文件名): ${item.requestId}` };
  return writeJson(f, item);
}

/**
 * 收到一个 TaskRequest → 落盘到收件箱。
 * **幂等**: 同一 requestId 已在箱里 → `{dup:true}` 并返回既有条目 (不覆盖、不重复执行、不重复收费)。
 */
export function saveIncomingRequest(
  req: TaskRequest,
  opts: { home?: string; requestVerified?: boolean | null; buyerPublicKeyHex?: string | null; replyTo?: string | null; now?: number } = {},
): { ok: boolean; dup: boolean; item?: InboxItem; reason?: string; error?: string } {
  const existing = readInboxItem(req.requestId, opts.home);
  if (existing) {
    const d = dedupeInbox<{ requestId: string }>([{ requestId: existing.requestId }], { requestId: req.requestId });
    return { ok: true, dup: true, item: existing, reason: d.reason || 'requestId 已在收件箱 (幂等)' };
  }
  const now = opts.now ?? Date.now();
  const item: InboxItem = {
    protocol: 'bolloon-task/1',
    requestId: req.requestId,
    taskId: req.taskId,
    capability: req.capability,
    instruction: String(req.instruction || ''),
    buyerDid: req.buyerDid,
    providerDid: req.providerDid,
    budget: req.budget,
    deadline: req.deadline,
    paymentMode: req.paymentMode,
    state: 'pending',
    receivedAt: now,
    updatedAt: now,
    requestSignature: String(req.signature || ''),
    requestSignatureVerified: opts.requestVerified ?? null,
    buyerPublicKeyHex: opts.buyerPublicKeyHex ?? null,
    replyTo: opts.replyTo ?? null,
  };
  const w = writeInboxItem(item, opts.home);
  if (!w.ok) return { ok: false, dup: false, error: w.error };
  return { ok: true, dup: false, item };
}

/** 只改已知字段 (state/accept/reject/result/...); 不存在 → `{ok:false}` */
export function patchInboxItem(
  requestId: string,
  patch: Partial<Pick<InboxItem, 'state' | 'accept' | 'reject' | 'result' | 'resultVerified' | 'note' | 'replyTo' | 'providerPublicKeyHex'>>,
  home?: string,
): { ok: boolean; item?: InboxItem; error?: string } {
  const cur = readInboxItem(requestId, home);
  if (!cur) return { ok: false, error: `收件箱里没有 ${requestId}` };
  const next: InboxItem = { ...cur, ...patch, updatedAt: Date.now() };
  const w = writeInboxItem(next, home);
  return w.ok ? { ok: true, item: next } : { ok: false, error: w.error };
}

export function findInboxByTaskId(taskId: string, home?: string): InboxItem | null {
  return listInbox(home).find((i) => i.taskId === taskId) || null;
}

// ── 本机发出的任务台账 ──────────────────────────────────────────────────────

export interface LocalTaskRecord {
  protocol: 'bolloon-task/1';
  requestId: string;
  taskId: string;
  capability: string;
  /** 任务正文 (私有一层, 只在本机文件里) */
  instruction: string;
  buyerDid: string;
  providerDid: string;
  /** 目标 (endpoint URL 或 iroh nodeId) */
  target: string;
  transportKind: string;
  /** 任务 14 态 (task-contract.TaskState) —— 发送方视角 */
  state: TaskState;
  sentAt: number;
  updatedAt: number;
  requestSignature: string;
  /** 发送回执 (对端传输层回的"收到/重复"事实) */
  receipt?: { at: number; ok: boolean; duplicate?: boolean; error?: string | null };
  accept?: TaskAccept;
  reject?: TaskReject;
  result?: TaskResult;
  resultVerified?: boolean | null;
  /** 提供方公钥 hex (接受/结果回执里带来的公开材料; 用来现场重验结果签名) */
  providerPublicKeyHex?: string | null;
  /** 结算事实 (来自交易层的记录, 若存在同一 requestId 的交易; 本 CLI **不发起付款**) */
  transactionId?: string | null;
  notes: string[];
}

const localFile = (requestId: string, home?: string): string | null => {
  const id = safeId(requestId);
  return id ? path.join(localDir(home), `${id}.json`) : null;
};

export function listLocalTasks(home?: string): LocalTaskRecord[] {
  try {
    const dir = localDir(home);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => readJson<LocalTaskRecord>(path.join(dir, f)))
      .filter((x): x is LocalTaskRecord => !!x?.requestId)
      .sort((a, b) => b.sentAt - a.sentAt);
  } catch { return []; }
}

export function readLocalTask(requestId: string, home?: string): LocalTaskRecord | null {
  const f = localFile(requestId, home);
  return f ? readJson<LocalTaskRecord>(f) : null;
}

export function saveLocalTask(rec: LocalTaskRecord, home?: string): { ok: boolean; error?: string } {
  const f = localFile(rec.requestId, home);
  if (!f) return { ok: false, error: `requestId 非法: ${rec.requestId}` };
  return writeJson(f, rec);
}

/** 幂等: 同一 requestId 已经有台账 → 返回既有记录 (不覆盖已推进的状态) */
export function upsertLocalTask(rec: LocalTaskRecord, home?: string): { ok: boolean; created: boolean; record?: LocalTaskRecord; error?: string } {
  const cur = readLocalTask(rec.requestId, home);
  if (cur) return { ok: true, created: false, record: cur };
  const w = saveLocalTask(rec, home);
  return w.ok ? { ok: true, created: true, record: rec } : { ok: false, created: false, error: w.error };
}

export function patchLocalTask(
  requestId: string,
  patch: Partial<Pick<LocalTaskRecord, 'state' | 'receipt' | 'accept' | 'reject' | 'result' | 'resultVerified' | 'notes' | 'transactionId' | 'providerPublicKeyHex'>>,
  home?: string,
): { ok: boolean; record?: LocalTaskRecord; error?: string } {
  const cur = readLocalTask(requestId, home);
  if (!cur) return { ok: false, error: `本机台账里没有 ${requestId}` };
  const next: LocalTaskRecord = { ...cur, ...patch, updatedAt: Date.now() };
  const w = saveLocalTask(next, home);
  return w.ok ? { ok: true, record: next } : { ok: false, error: w.error };
}

// ── 结果 (信封 + 正文分开存) ────────────────────────────────────────────────

const resultFile = (taskId: string, home?: string): string | null => {
  const id = safeId(taskId);
  return id ? path.join(resultsDir(home), `${id}.json`) : null;
};

export function saveResult(result: TaskResult, home?: string): { ok: boolean; error?: string } {
  const f = resultFile(result.taskId, home);
  if (!f) return { ok: false, error: `taskId 非法: ${result.taskId}` };
  return writeJson(f, result);
}

export function readResult(taskId: string, home?: string): TaskResult | null {
  const f = resultFile(taskId, home);
  return f ? readJson<TaskResult>(f) : null;
}

/** 找结果: 先按 taskId, 再按收件箱/台账里的 requestId 反查 */
export function findResult(idOrTaskId: string, home?: string): { result: TaskResult; taskId: string; source: 'results' | 'inbox' | 'local' } | null {
  const direct = readResult(idOrTaskId, home);
  if (direct) return { result: direct, taskId: direct.taskId, source: 'results' };
  const inb = readInboxItem(idOrTaskId, home);
  if (inb?.result) return { result: inb.result, taskId: inb.taskId, source: 'inbox' };
  const loc = readLocalTask(idOrTaskId, home);
  if (loc?.result) return { result: loc.result, taskId: loc.taskId, source: 'local' };
  const byTask = listLocalTasks(home).find((t) => t.taskId === idOrTaskId);
  if (byTask?.result) return { result: byTask.result, taskId: byTask.taskId, source: 'local' };
  return null;
}

/**
 * 交付正文落盘 (**私有一层**)。返回真实内容哈希 —— 它就是 TaskResult.contentHash 的来源,
 * 绝不由调用方随口给。
 */
export function saveBody(taskId: string, text: string, home?: string): { ok: boolean; file?: string; contentHash?: string; bytes?: number; error?: string } {
  const id = safeId(taskId);
  if (!id) return { ok: false, error: `taskId 非法: ${taskId}` };
  try {
    const dir = bodiesDir(home);
    ensure(dir);
    const file = path.join(dir, `${id}.txt`);
    const buf = Buffer.from(text, 'utf8');
    fs.writeFileSync(file, buf);
    return { ok: true, file, contentHash: crypto.createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

/** 读交付正文 + 复核哈希 (正文**不进 stdout**; 调用方只报哈希/字节数) */
export function readBody(taskId: string, home?: string): { present: boolean; file: string; bytes: number; contentHash: string | null; matches: boolean | null; text?: string; reason?: string } {
  const id = safeId(taskId);
  const dir = bodiesDir(home);
  const file = id ? path.join(dir, `${id}.txt`) : path.join(dir, `${String(taskId)}.txt`);
  const recorded = readResult(taskId, home)?.contentHash || null;
  try {
    if (!id || !fs.existsSync(file)) return { present: false, file, bytes: 0, contentHash: null, matches: null, reason: '正文不在盘上' };
    const buf = fs.readFileSync(file);
    const h = crypto.createHash('sha256').update(buf).digest('hex');
    return { present: true, file, bytes: buf.length, contentHash: h, matches: recorded ? h === recorded : null, text: buf.toString('utf8') };
  } catch (e: any) {
    return { present: false, file, bytes: 0, contentHash: null, matches: null, reason: String(e?.message || e).slice(0, 120) };
  }
}

// ── 收件箱摘要 (给 `task inbox` / `task list` 用; 不含正文全文) ───────────────

export interface InboxSummary {
  requestId: string;
  taskId: string;
  capability: string;
  sender: string;              // 发送方摘要 (did 截断)
  state: InboxState;
  receivedAt: number;
  deadline: number | null;
  deadlineInMs: number | null; // 负数 = 已过期
  budget: TaskBudget | null;
  paymentMode: PaymentMode;
  requestSignatureVerified: boolean | null;
  instructionPreview: string;  // 本机 CLI 预览 (60 字); 公开投影里没有它
  hasResult: boolean;
}

export function inboxSummary(item: InboxItem, now = Date.now()): InboxSummary {
  return {
    requestId: item.requestId,
    taskId: item.taskId,
    capability: item.capability,
    sender: String(item.buyerDid || '').slice(0, 28),
    state: item.state,
    receivedAt: item.receivedAt,
    deadline: item.deadline ?? null,
    deadlineInMs: item.deadline ? item.deadline - now : null,
    budget: item.budget ?? null,
    paymentMode: item.paymentMode,
    requestSignatureVerified: item.requestSignatureVerified ?? null,
    instructionPreview: String(item.instruction || '').slice(0, 60) + (String(item.instruction || '').length > 60 ? '…' : ''),
    hasResult: !!item.result,
  };
}
