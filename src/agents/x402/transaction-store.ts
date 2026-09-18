/**
 * transaction-store.ts — 交易记录与审计 (Phase 5, 2026-09-16)
 *
 * 位置: `~/.bolloon/transactions/<transactionId>.json` (原子写)。
 * 为什么必须有: 支付不能只是工具内部副作用 —— 进程被杀、买方重试、Supervisor 重启后,
 * 必须能回答"这笔钱到底付了没有、拿到东西没有、算不算成功"。
 *
 * 幂等: `beginTransaction({requestId})` 命中已有记录 → 直接复用 (不重复付款)。
 */

import * as os from 'os';
import * as path from 'path';
import * as fsp from 'fs/promises';
import {
  newTransactionId, event, type TransactionRecord, type TransactionStatus, type InfoItemMetadata,
} from './transaction-protocol.js';

export function transactionsDir(home: string = os.homedir()): string {
  return path.join(home, '.bolloon', 'transactions');
}

function txPath(id: string, home: string): string {
  return path.join(transactionsDir(home), `${id}.json`);
}

export async function saveTransaction(rec: TransactionRecord, home: string = os.homedir()): Promise<TransactionRecord> {
  await fsp.mkdir(transactionsDir(home), { recursive: true });
  const p = txPath(rec.transactionId, home);
  const tmp = `${p}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(rec, null, 2), 'utf8');
  await fsp.rename(tmp, p);
  return rec;
}

export async function readTransaction(id: string, home: string = os.homedir()): Promise<TransactionRecord | null> {
  try { return JSON.parse(await fsp.readFile(txPath(id, home), 'utf8')) as TransactionRecord; } catch { return null; }
}

export async function listTransactions(home: string = os.homedir()): Promise<TransactionRecord[]> {
  try {
    const files = (await fsp.readdir(transactionsDir(home))).filter((f) => f.startsWith('tx-') && f.endsWith('.json'));
    const out: TransactionRecord[] = [];
    for (const f of files) {
      try { out.push(JSON.parse(await fsp.readFile(path.join(transactionsDir(home), f), 'utf8'))); } catch { /* 跳过坏文件 */ }
    }
    return out.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  } catch { return []; }
}

/** 幂等键查找: 同一个 requestId 只允许一笔交易 */
export async function findByRequestId(requestId: string, home: string = os.homedir()): Promise<TransactionRecord | null> {
  const all = await listTransactions(home);
  return all.find((t) => t.requestId === requestId) || null;
}

export interface BeginInput {
  requestId: string;
  metadata: Partial<InfoItemMetadata>;
  buyerDid: string;
  providerDid?: string;
  goalId?: string;
  runId?: string;
}

function reqMarkerPath(requestId: string, home: string): string {
  const safe = String(requestId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  return path.join(transactionsDir(home), `.req-${safe}`);
}

/**
 * 开始/复用一笔交易 (幂等 + **原子认领**)。
 *
 * 2026-09-16 修: 旧实现是"先查再写" —— 两个并发进程会同时看不到记录, 各写一条,
 * 同一个 requestId 出现两笔交易 (真跑并发用例逼出来的)。现在用 O_EXCL 标记文件认领:
 * 只有一个进程能创建记录, 另一个读它的 transactionId 复用。
 */
export async function beginTransaction(input: BeginInput, home: string = os.homedir()): Promise<{ record: TransactionRecord; reused: boolean }> {
  await fsp.mkdir(transactionsDir(home), { recursive: true });
  const existing = await findByRequestId(input.requestId, home);
  if (existing) return { record: existing, reused: true };

  const marker = reqMarkerPath(input.requestId, home);
  const candidateId = newTransactionId();
  let winnerId: string | null = null;
  try {
    const fh = await fsp.open(marker, 'wx');                 // ★ 独占认领
    await fh.writeFile(candidateId, 'utf8');
    await fh.close();
    winnerId = candidateId;
  } catch {
    // 别人先认领了 → 用它的 transactionId (不再新建)
    try { winnerId = (await fsp.readFile(marker, 'utf8')).trim() || null; } catch { winnerId = null; }
  }
  if (winnerId && winnerId !== candidateId) {
    const other = await readTransaction(winnerId, home);
    if (other) return { record: other, reused: true };
  }

  const rec: TransactionRecord = {
    transactionId: winnerId || candidateId,
    requestId: input.requestId,
    itemId: String(input.metadata.itemId || ''),
    buyerDid: input.buyerDid,
    providerDid: input.providerDid || String(input.metadata.providerDid || ''),
    price: input.metadata.price,
    currency: input.metadata.currency,
    network: input.metadata.network,
    payTo: input.metadata.payTo,
    paymentMode: 'none',
    chainSettled: false,
    status: 'discovered',
    goalId: input.goalId,
    runId: input.runId,
    startedAt: new Date().toISOString(),
    events: [event('discovered', `item=${input.metadata.itemId || '?'} requestId=${input.requestId}`)],
  };
  return { record: await saveTransaction(rec, home), reused: false };
}

/** 追加事件 + 更新状态 (唯一写路径, 保证 events 有序可回放) */
export async function updateTransaction(
  transactionId: string,
  patch: Partial<TransactionRecord> & { event?: { kind: string; detail?: string } },
  home: string = os.homedir(),
): Promise<TransactionRecord | null> {
  const rec = await readTransaction(transactionId, home);
  if (!rec) return null;
  const { event: ev, ...rest } = patch;
  const next: TransactionRecord = {
    ...rec,
    ...rest,
    events: ev ? [...(rec.events || []), event(ev.kind, ev.detail)] : (rec.events || []),
  };
  return await saveTransaction(next, home);
}

export async function setTransactionStatus(transactionId: string, status: TransactionStatus, detail?: string, home: string = os.homedir()): Promise<TransactionRecord | null> {
  return updateTransaction(transactionId, { status, ...(status === 'settled' ? { settledAt: new Date().toISOString() } : {}), ...(status === 'delivered' ? { deliveredAt: new Date().toISOString() } : {}), ...(status === 'verified' ? { verifiedAt: new Date().toISOString() } : {}), event: { kind: `status:${status}`, detail } }, home);
}

/** 审计回放 (CLI/Web 用): 一笔交易按时间顺序的完整事件链 */
export async function replayTransaction(transactionId: string, home: string = os.homedir()): Promise<string[]> {
  const rec = await readTransaction(transactionId, home);
  if (!rec) return [];
  return (rec.events || []).map((e) => `${e.at} ${e.kind}${e.detail ? ` — ${e.detail}` : ''}`);
}

/** 未完成交易 (付了钱但没交付/没验真) —— 重启后要能查出来, 不许静静丢掉 */
export async function pendingTransactions(home: string = os.homedir()): Promise<TransactionRecord[]> {
  const all = await listTransactions(home);
  return all.filter((t) => ['payment_required', 'paying', 'settled', 'delivery_failed', 'verification_failed'].includes(t.status));
}

// ── Phase 1: 支付阶段 claim (并发/重启安全) ────────────────────────────────

/** 已经付过钱的终态: **绝不允许**重新进入付款流程 (必须先对账) */
export const PAID_STATUSES = ['paying', 'settled', 'delivered', 'verified', 'delivery_failed', 'verification_failed'] as const;

function claimPath(requestId: string, home: string): string {
  const safe = requestId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  return path.join(transactionsDir(home), `.claim-${safe}`);
}

export interface ClaimResult { ok: boolean; reason?: string; holder?: string; record?: TransactionRecord }

/**
 * 抢"这笔 requestId 的付款权" —— 用 O_EXCL 独占创建 claim 文件, 天然跨进程互斥。
 * 两个进程同时用同一个 requestId 时: 只有一个能进入 paying, 另一个复用同一 transactionId。
 */
export async function claimPayment(requestId: string, transactionId: string, home: string = os.homedir()): Promise<ClaimResult> {
  await fsp.mkdir(transactionsDir(home), { recursive: true });
  const existing = await findByRequestId(requestId, home);
  if (existing && (PAID_STATUSES as readonly string[]).includes(existing.status)) {
    // 已经付过 (或正在付/已交付) → 不允许再付一次, 复用同一交易
    return { ok: false, reason: `该 requestId 已有交易处于 ${existing.status} (不允许重复付款)`, record: existing };
  }
  const cp = claimPath(requestId, home);
  try {
    const fh = await fsp.open(cp, 'wx');                      // ★ 独占: 并发只有一个成功
    await fh.writeFile(JSON.stringify({ holder: transactionId, pid: process.pid, at: new Date().toISOString() }), 'utf8');
    await fh.close();
    return { ok: true, holder: transactionId, record: existing || undefined };
  } catch (err: any) {
    // 已被别人持有 → 看看持有者是否还活着 (死了就接管)
    try {
      const info = JSON.parse(await fsp.readFile(cp, 'utf8'));
      const alive = Number(info?.pid) ? isPidAlive(Number(info.pid)) : true;
      if (!alive) {
        await fsp.rm(cp, { force: true });
        const fh = await fsp.open(cp, 'wx');
        await fh.writeFile(JSON.stringify({ holder: transactionId, pid: process.pid, at: new Date().toISOString() }), 'utf8');
        await fh.close();
        return { ok: true, holder: transactionId, record: existing || undefined };
      }
      return { ok: false, reason: `付款权被另一个进程持有 (holder=${info?.holder}, pid=${info?.pid}) → 复用同一交易, 不重复付款`, record: existing || undefined };
    } catch {
      return { ok: false, reason: `无法取得付款权: ${String(err?.message || err).slice(0, 120)}`, record: existing || undefined };
    }
  }
}

export async function releasePaymentClaim(requestId: string, home: string = os.homedir()): Promise<void> {
  await fsp.rm(claimPath(requestId, home), { force: true }).catch(() => {});
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * 对账: SIGKILL 之后重启必须先看"钱到底付了没有", 再决定能不能重付。
 *   paying + 无 txHash  → payment_pending (可安全重试: 没证据证明付过)
 *   settled/delivered/verified → 绝不重付, 只恢复交付/验真
 */
export async function reconcilePendingTransactions(home: string = os.homedir()): Promise<{ requeued: string[]; mustNotRepay: string[] }> {
  const all = await listTransactions(home);
  const requeued: string[] = []; const mustNotRepay: string[] = [];
  for (const t of all) {
    if (t.status === 'paying' && !t.txHash && !t.chainSettled) {
      await updateTransaction(t.transactionId, { status: 'payment_required', event: { kind: 'reconcile', detail: '重启对账: 没有支付证据 → 允许安全重试' } }, home);
      await releasePaymentClaim(t.requestId, home);
      requeued.push(t.transactionId);
    } else if ((PAID_STATUSES as readonly string[]).includes(t.status) && t.status !== 'paying') {
      mustNotRepay.push(t.transactionId);
    }
  }
  return { requeued, mustNotRepay };
}

/** 花钱汇总 (供 policy / 审计对账) */
export async function spentSummary(home: string = os.homedir()): Promise<{ count: number; total: number; byMode: Record<string, number> }> {
  const all = await listTransactions(home);
  let total = 0; const byMode: Record<string, number> = {};
  let count = 0;
  for (const t of all) {
    if (!['settled', 'delivered', 'verified', 'delivery_failed', 'verification_failed'].includes(t.status)) continue;
    // 金额只认 amount (原子单位/十进制字符串), 绝不 Number(price 对象)
    const rawAmount = typeof t.amount === 'string' || typeof t.amount === 'number' ? t.amount : undefined;
    const amt = Number(rawAmount ?? 0) || 0;
    total += amt; count++;
    byMode[t.paymentMode] = (byMode[t.paymentMode] || 0) + amt;
  }
  return { count, total, byMode };
}
