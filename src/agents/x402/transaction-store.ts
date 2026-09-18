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

/** 开始/复用一笔交易 (幂等: 命中已有 requestId → 原样返回, reused=true) */
export async function beginTransaction(input: BeginInput, home: string = os.homedir()): Promise<{ record: TransactionRecord; reused: boolean }> {
  const existing = await findByRequestId(input.requestId, home);
  if (existing) return { record: existing, reused: true };
  const rec: TransactionRecord = {
    transactionId: newTransactionId(),
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

/** 花钱汇总 (供 policy / 审计对账) */
export async function spentSummary(home: string = os.homedir()): Promise<{ count: number; total: number; byMode: Record<string, number> }> {
  const all = await listTransactions(home);
  let total = 0; const byMode: Record<string, number> = {};
  let count = 0;
  for (const t of all) {
    if (!['settled', 'delivered', 'verified', 'delivery_failed', 'verification_failed'].includes(t.status)) continue;
    const amt = Number(t.amount || t.price || 0) || 0;
    total += amt; count++;
    byMode[t.paymentMode] = (byMode[t.paymentMode] || 0) + amt;
  }
  return { count, total, byMode };
}
