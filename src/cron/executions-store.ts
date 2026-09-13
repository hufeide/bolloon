/**
 * executions-store.ts — job 执行记录 (追加写 + 读时归并)
 *
 * 存储: ~/.bolloon/cron/executions.jsonl, 每行一条 JSON 事件.
 *
 * 【策略: 事件追加 + 读时归并】
 *   - 每次写只 append/重写文件, 从不原地改某一行 (崩溃安全, 写放大恒定)
 *   - markStarted 追加一条 ev:'start' 事件 (status:'running')
 *   - markFinished 追加一条 ev:'finish' 事件 (带 runId + 终态), 读时按 runId 归并:
 *     start 事件提供底稿, 后续事件覆盖同名已定义字段 → 得到一条完整 ExecutionRecord
 *   - 因此 markFinished 不需要读改写文件, 也不需要知道行号
 *
 * 幂等: 同一 (jobId + scheduledFor) 不允许出现两条 running/ok 记录.
 *   hasRun() 归并后判断是否存在 running/ok; 调度器在开跑前调用, 命中则跳过该触发点.
 *   failed / timeout / skipped / missed / deferred 可以重复 (允许重试与多次说明).
 *
 * 截断: 文件行数 > 2000 → 归并后重写, 只保留最近 1000 行.
 *   读改写在同一进程内由互斥链串行化; 跨进程由 tick 锁保证只有一个 ticker 在写.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { cronDir } from './tick-lock.js';

/** 执行终态 + 中间态 */
export type ExecutionStatus =
  | 'running'
  | 'ok'
  | 'failed'
  | 'timeout'
  | 'skipped'
  | 'missed'
  | 'deferred';

/** 事件类型: start(开跑) / finish(落终态) / note(单点事件, 如 missed / deferred / skipped) */
export type ExecutionEventKind = 'start' | 'finish' | 'note';

export interface ExecutionRecord {
  runId: string;
  jobId: string;
  jobName: string;
  /** 本次触发点 (ISO) — 幂等键的一半 */
  scheduledFor: string;
  startedAt: string;
  finishedAt?: string;
  status: ExecutionStatus;
  attempt: number;
  error?: string;
  outputSummary?: string;
  durationMs?: number;
  /** 归并用事件类型 (仅落盘行携带, 对外记录也保留便于诊断) */
  ev?: ExecutionEventKind;
}

export interface ExecutionsFileOptions {
  home?: string;
}

export const MAX_LINES = 2000;
export const KEEP_LINES = 1000;

export function executionsPath(home: string = os.homedir()): string {
  return path.join(cronDir(home), 'executions.jsonl');
}

/** 行数超限即触发截断 */
export function shouldTruncate(lineCount: number): boolean {
  return lineCount > MAX_LINES;
}

// ---------------------------------------------------------------- 纯函数

/** 一条记录 → 一行 JSON (单行, 无换行) */
export function serializeExecution(rec: ExecutionRecord): string {
  return JSON.stringify(rec);
}

/** 一行 → 记录; 不可解析 / 缺关键字段 → null (坏行直接丢弃, 不让日志毒化整库) */
export function parseExecution(line: string): ExecutionRecord | null {
  const raw = (line || '').trim();
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<ExecutionRecord>;
    if (typeof p?.runId !== 'string' || typeof p?.jobId !== 'string') return null;
    if (typeof p?.status !== 'string') return null;
    return {
      runId: p.runId,
      jobId: p.jobId,
      jobName: typeof p.jobName === 'string' ? p.jobName : '',
      scheduledFor: typeof p.scheduledFor === 'string' ? p.scheduledFor : '',
      startedAt: typeof p.startedAt === 'string' ? p.startedAt : '',
      finishedAt: typeof p.finishedAt === 'string' ? p.finishedAt : undefined,
      status: p.status as ExecutionStatus,
      attempt: typeof p.attempt === 'number' ? p.attempt : 1,
      error: typeof p.error === 'string' ? p.error : undefined,
      outputSummary: typeof p.outputSummary === 'string' ? p.outputSummary : undefined,
      durationMs: typeof p.durationMs === 'number' ? p.durationMs : undefined,
      ev: (p.ev as ExecutionEventKind) ?? undefined,
    };
  } catch {
    return null;
  }
}

/**
 * 归并: 按 runId 折叠事件. 第一条 start/note 提供底稿, 之后的事件覆盖"已定义"字段.
 * @returns 按 startedAt 倒序的记录数组 (同一 startedAt 时 finish 更晚的排前)
 */
export function mergeExecutions(lines: (string | ExecutionRecord)[]): ExecutionRecord[] {
  const byRun = new Map<string, ExecutionRecord>();
  for (const item of lines) {
    const rec = typeof item === 'string' ? parseExecution(item) : item;
    if (!rec) continue;
    const prev = byRun.get(rec.runId);
    if (!prev) {
      byRun.set(rec.runId, { ...rec });
      continue;
    }
    const merged: ExecutionRecord = { ...prev };
    for (const [k, v] of Object.entries(rec)) {
      if (v !== undefined && v !== null && v !== '') (merged as unknown as Record<string, unknown>)[k] = v;
    }
    byRun.set(rec.runId, merged);
  }
  return [...byRun.values()].sort((a, b) => {
    const ta = Date.parse(a.startedAt) || 0;
    const tb = Date.parse(b.startedAt) || 0;
    if (ta !== tb) return tb - ta;
    return a.runId < b.runId ? 1 : -1;
  });
}

/** 幂等键: jobId + 触发点 */
export function occurrenceKey(jobId: string, scheduledFor: string): string {
  return `${jobId}@${scheduledFor}`;
}

/** 已占用的触发点 (running/ok) — hasRun 的纯逻辑部分 */
export function findBlockingRun(
  records: ExecutionRecord[],
  jobId: string,
  scheduledFor: string,
): ExecutionRecord | null {
  for (const r of records) {
    if (r.jobId !== jobId) continue;
    if (r.scheduledFor !== scheduledFor) continue;
    if (r.status === 'running' || r.status === 'ok') return r;
  }
  return null;
}

// ---------------------------------------------------------------- 读写 (互斥链内)

let chain: Promise<unknown> = Promise.resolve();

/** 进程内互斥链: executions.jsonl 的 append + 截断串行化 */
function withChain<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn);
  chain = run.then(() => undefined, () => undefined);
  return run;
}

async function readLines(file: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(file, 'utf-8');
    return raw.split('\n').filter((l) => l.trim().length > 0);
  } catch {
    return [];
  }
}

/** 原子写 (临时文件 + rename) */
async function writeLinesAtomic(file: string, lines: string[]): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, lines.length ? lines.join('\n') + '\n' : '', 'utf-8');
  await fs.rename(tmp, file);
}

/**
 * 追加事件 (必要时截断). 同一互斥链内完成读-写, 行数 > 2000 时保留最近 1000 行.
 * @returns 落盘后的行数
 */
async function appendEvents(events: ExecutionRecord[], home: string): Promise<number> {
  const file = executionsPath(home);
  const lines = await readLines(file);
  for (const ev of events) lines.push(serializeExecution(ev));
  if (shouldTruncate(lines.length)) {
    const kept = lines.slice(lines.length - KEEP_LINES);
    await writeLinesAtomic(file, kept);
    return kept.length;
  }
  // 行数有界 (<= MAX_LINES): 直接整文件原子重写, 语义等价于 append
  await writeLinesAtomic(file, lines);
  return lines.length;
}

// ---------------------------------------------------------------- 公共 API

export interface StartedInput {
  runId: string;
  jobId: string;
  jobName: string;
  scheduledFor: string;
  /** 默认当前时间 */
  startedAt?: string;
  attempt?: number;
  /** 开跑时点备注 (如 misfire 追赶说明) */
  outputSummary?: string;
}

/** 开一条 running 记录 (追加 ev:'start') */
export async function markStarted(input: StartedInput, home: string = os.homedir()): Promise<ExecutionRecord> {
  const rec: ExecutionRecord = {
    runId: input.runId,
    jobId: input.jobId,
    jobName: input.jobName,
    scheduledFor: input.scheduledFor,
    startedAt: input.startedAt ?? new Date().toISOString(),
    status: 'running',
    attempt: input.attempt ?? 1,
    outputSummary: input.outputSummary,
    ev: 'start',
  };
  return withChain(async () => {
    await appendEvents([rec], home);
    return rec;
  });
}

export interface FinishedPatch {
  status: Exclude<ExecutionStatus, 'running'>;
  /** 终态时间 (默认当前) */
  finishedAt?: string;
  error?: string;
  outputSummary?: string;
  durationMs?: number;
  /** 底稿被截断时的兜底字段 (建议带上) */
  jobId?: string;
  jobName?: string;
  scheduledFor?: string;
}

/** 落终态 (追加 ev:'finish', 读时按 runId 归并). 找不到底稿时用 patch 里的兜底字段建记录. */
export async function markFinished(
  runId: string,
  patch: FinishedPatch,
  home: string = os.homedir(),
): Promise<ExecutionRecord> {
  const fin: ExecutionRecord = {
    runId,
    jobId: patch.jobId ?? '',
    jobName: patch.jobName ?? '',
    scheduledFor: patch.scheduledFor ?? '',
    startedAt: '',
    finishedAt: patch.finishedAt ?? new Date().toISOString(),
    status: patch.status,
    attempt: 1,
    error: patch.error,
    outputSummary: patch.outputSummary,
    durationMs: patch.durationMs,
    ev: 'finish',
  };
  return withChain(async () => {
    await appendEvents([fin], home);
    return fin;
  });
}

export interface NoteInput {
  runId?: string;
  jobId: string;
  jobName: string;
  scheduledFor: string;
  status: Extract<ExecutionStatus, 'missed' | 'skipped' | 'deferred'>;
  at?: string;
  outputSummary?: string;
  error?: string;
  attempt?: number;
}

/**
 * 单点事件 (missed / skipped / deferred): 一条即完整记录, 无后续 finish.
 * runId 缺省时自动生成 (调用方可只关心"发生过什么").
 */
export async function recordNote(input: NoteInput, home: string = os.homedir()): Promise<ExecutionRecord> {
  const at = input.at ?? new Date().toISOString();
  const rec: ExecutionRecord = {
    runId: input.runId ?? `${input.status}:${input.jobId}:${input.scheduledFor}`,
    jobId: input.jobId,
    jobName: input.jobName,
    scheduledFor: input.scheduledFor,
    startedAt: at,
    finishedAt: at,
    status: input.status,
    attempt: input.attempt ?? 1,
    error: input.error,
    outputSummary: input.outputSummary,
    durationMs: 0,
    ev: 'note',
  };
  return withChain(async () => {
    await appendEvents([rec], home);
    return rec;
  });
}

/** 归并后的全部记录 (按 startedAt 倒序) */
export async function listExecutions(
  opts: { jobId?: string; limit?: number; home?: string } = {},
): Promise<ExecutionRecord[]> {
  const home = opts.home ?? os.homedir();
  return withChain(async () => {
    const lines = await readLines(executionsPath(home));
    let merged = mergeExecutions(lines);
    if (opts.jobId) merged = merged.filter((r) => r.jobId === opts.jobId);
    if (opts.limit != null && opts.limit >= 0) merged = merged.slice(0, opts.limit);
    return merged;
  });
}

/** 幂等判定: 同一 (jobId + scheduledFor) 是否已有 running/ok 记录 */
export async function hasRun(
  jobId: string,
  scheduledFor: string,
  home: string = os.homedir(),
): Promise<boolean> {
  const records = await listExecutions({ home });
  return findBlockingRun(records, jobId, scheduledFor) !== null;
}

/** 清空 (测试/运维用) */
export async function clearExecutions(home: string = os.homedir()): Promise<void> {
  return withChain(async () => {
    await fs.rm(executionsPath(home), { force: true });
  });
}

