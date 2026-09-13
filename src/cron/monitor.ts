/**
 * monitor.ts — 时钟看门狗 + 事件日志 (背景安静: 只落文件, 不写 stdout/stderr)
 *
 * 职责:
 *   1. 检测"卡死的 tick": .tick.lock 里的 startedAt 超过 tickTimeoutMs*2 且持锁进程已不响应
 *      → 记一条 monitor 事件并回收锁 (让下一轮心跳能继续)
 *   2. 事件日志 ~/.bolloon/cron/monitor.log: 纯文本, 一行一条, 带 ISO 时间
 *      格式: <ISO时间>\t<level>\t<kind>\t<message>\t<detail-json>
 *   3. 健康摘要 getCronHealth(home)
 *   4. 日志出口钩子 setCronLogSink(fn): 默认 sink 写文件; 调用方 (server) 可换成转发 SSE
 *
 * 安静性约定: 本模块与其调用方一律不往 stdout/stderr 输出. 想让人看到, 就设 sink.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { cronDir, tickLockPath, parseLock, isProcessAlive, type TickLockInfo } from './tick-lock.js';
import { listExecutions, type ExecutionRecord } from './executions-store.js';
import { listJobs } from './jobs-store.js';
import { resolveDnd } from './dnd.js';

export type CronLogLevel = 'info' | 'warn' | 'error';

export interface CronLogEvent {
  /** ISO 时间 */
  at: string;
  level: CronLogLevel;
  /** 事件类别: tick / tick-lock / monitor / job */
  kind: string;
  message: string;
  detail?: Record<string, unknown>;
}

/** 日志出口: 调用方提供 (可转 SSE); 抛异常会被吞掉, 不影响调度 */
export type CronLogSink = (event: CronLogEvent) => void;

export function monitorLogPath(home: string = os.homedir()): string {
  return path.join(cronDir(home), 'monitor.log');
}

/** 默认 sink: 写 ~/.bolloon/cron/monitor.log (异步 append, 失败静默) */
function fileSink(event: CronLogEvent): void {
  const home = (event.detail?.home as string) ?? os.homedir();
  const line = formatMonitorLine(event);
  void fs
    .mkdir(cronDir(home), { recursive: true })
    .then(() => fs.appendFile(monitorLogPath(home), line + '\n', 'utf-8'))
    .catch(() => {});
}

let sink: CronLogSink = fileSink;

/** 设置事件出口. 传 null 恢复默认 (文件). 幂等, 随时可换. */
export function setCronLogSink(fn: CronLogSink | null): void {
  sink = fn ?? fileSink;
}

/** 当前出口 (测试用) */
export function getCronLogSink(): CronLogSink {
  return sink;
}

export function formatMonitorLine(event: CronLogEvent): string {
  const detail = event.detail ? JSON.stringify(event.detail) : '';
  return [event.at, event.level, event.kind, event.message, detail].join('\t');
}

/** 一行 → 事件; 不可解析 → null */
export function parseMonitorLine(line: string): CronLogEvent | null {
  const raw = (line || '').trimEnd();
  if (!raw) return null;
  const parts = raw.split('\t');
  if (parts.length < 4) return null;
  const [at, level, kind, message, detailRaw] = parts;
  let detail: Record<string, unknown> | undefined;
  if (detailRaw) {
    try {
      detail = JSON.parse(detailRaw) as Record<string, unknown>;
    } catch {
      detail = undefined;
    }
  }
  return { at, level: level as CronLogLevel, kind, message, detail };
}

/** 记一条事件 (唯一出口: 绝不 stdout/stderr) */
export function cronLog(
  level: CronLogLevel,
  kind: string,
  message: string,
  detail?: Record<string, unknown>,
  home: string = os.homedir(),
): void {
  const event: CronLogEvent = {
    at: new Date().toISOString(),
    level,
    kind,
    message,
    detail: { ...(detail ?? {}), home },
  };
  try {
    sink(event);
  } catch {
    /* sink 故障不影响调度 */
  }
}

/** 便捷: 追加一条纯文本 monitor 事件 (等价于 cronLog('info','monitor',...)) */
export async function appendMonitorEvent(
  message: string,
  detail: Record<string, unknown> = {},
  home: string = os.homedir(),
): Promise<void> {
  cronLog('info', 'monitor', message, detail, home);
}

/** 读回最近的事件 (倒序, 便于诊断/看板) */
export async function readMonitorEvents(
  opts: { home?: string; limit?: number; kind?: string } = {},
): Promise<CronLogEvent[]> {
  const home = opts.home ?? os.homedir();
  let lines: string[];
  try {
    lines = (await fs.readFile(monitorLogPath(home), 'utf-8')).split('\n');
  } catch {
    return [];
  }
  const events: CronLogEvent[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const ev = parseMonitorLine(lines[i]);
    if (!ev) continue;
    if (opts.kind && ev.kind !== opts.kind) continue;
    events.push(ev);
    if (opts.limit != null && events.length >= opts.limit) break;
  }
  return events;
}

// ---------------------------------------------------------------- 看门狗

export interface StuckTickReport {
  /** 是否发现并回收了卡死的 tick 锁 */
  reclaimed: boolean;
  lock: TickLockInfo | null;
  ageMs: number | null;
  reason?: string;
}

/**
 * 检测卡死的 tick: 锁存在 且 age > tickTimeoutMs*2 且持锁进程已不响应 (不存活)
 * → 记 monitor 事件 + 回收锁. 未超阈值 / 进程仍存活 → 只报告, 不动锁.
 */
export async function detectStuckTick(
  opts: {
    home?: string;
    tickTimeoutMs?: number;
    now?: Date;
    isAlive?: (pid: number) => boolean;
    /** 只报告不回收 (干跑) */
    dryRun?: boolean;
  } = {},
): Promise<StuckTickReport> {
  const home = opts.home ?? os.homedir();
  const tickTimeoutMs = opts.tickTimeoutMs ?? 300_000;
  const now = opts.now ?? new Date();
  const isAlive = opts.isAlive ?? isProcessAlive;
  const lockPath = tickLockPath(home);

  let lock: TickLockInfo | null = null;
  try {
    lock = parseLock(await fs.readFile(lockPath, 'utf-8'));
  } catch {
    return { reclaimed: false, lock: null, ageMs: null }; // 没锁 = 健康
  }

  const ageMs = lock ? now.getTime() - (Date.parse(lock.startedAt) || 0) : null;
  const deadProcess = !lock || !isAlive(lock.pid);
  const overBudget = ageMs != null && ageMs > tickTimeoutMs * 2;
  if (!deadProcess || !overBudget) {
    return { reclaimed: false, lock, ageMs };
  }

  const reason = `${(ageMs! / 1000).toFixed(0)}s > 2×${(tickTimeoutMs / 1000).toFixed(0)}s 且 pid ${lock?.pid ?? '?'} 不响应`;
  cronLog('warn', 'monitor', '发现卡死的 tick, 回收锁', { lock, ageMs, reason, tickTimeoutMs }, home);
  if (!opts.dryRun) {
    try {
      await fs.rm(lockPath, { force: true });
    } catch {
      return { reclaimed: false, lock, ageMs, reason };
    }
  }
  return { reclaimed: true, lock, ageMs, reason };
}

// ---------------------------------------------------------------- 健康摘要

export interface CronHealth {
  lockHeld: boolean;
  lockAgeMs: number | null;
  lock?: TickLockInfo | null;
  lastTick?: { at: string; ran?: number; skipped?: number; failed?: number; detail?: Record<string, unknown> } | null;
  lastExecutions: ExecutionRecord[];
  failingJobs: Array<{
    id: string;
    name: string;
    continuousFailures: number;
    failureLimit: number;
    pausedReason?: string;
    lastError?: string;
    lastRunAt?: string;
  }>;
  dnd?: { dnd: boolean; reason: string; detail?: string };
}

/**
 * 健康摘要: 锁状态 + 最近一次心跳 + 最近 5 条执行 + 正在连续失败的 job.
 * 只读 (不回收锁, 不写文件), 可安全高频调用.
 */
export async function getCronHealth(
  home: string = os.homedir(),
  opts: { now?: Date; execLimit?: number } = {},
): Promise<CronHealth> {
  const now = opts.now ?? new Date();
  const lockPath = tickLockPath(home);
  let lock: TickLockInfo | null = null;
  try {
    lock = parseLock(await fs.readFile(lockPath, 'utf-8'));
  } catch {
    lock = null;
  }
  const lockAgeMs = lock ? now.getTime() - (Date.parse(lock.startedAt) || 0) : null;

  let lastTick: CronHealth['lastTick'] = null;
  const events = await readMonitorEvents({ home, limit: 50, kind: 'tick' });
  if (events.length) {
    const ev = events[0];
    lastTick = {
      at: ev.at,
      ran: Number(ev.detail?.ran ?? 0),
      skipped: Number(ev.detail?.skipped ?? 0),
      failed: Number(ev.detail?.failed ?? 0),
      detail: ev.detail,
    };
  }

  const lastExecutions = await listExecutions({ home, limit: opts.execLimit ?? 5 });

  const jobs = await listJobs(home);
  const failingJobs = jobs
    .filter((j) => (j.continuousFailures ?? 0) > 0 || !!j.pausedReason)
    .map((j) => ({
      id: j.id,
      name: j.name,
      continuousFailures: j.continuousFailures ?? 0,
      failureLimit: j.failureLimit ?? 5,
      pausedReason: j.pausedReason,
      lastError: j.lastError,
      lastRunAt: j.lastRunAt,
    }))
    .sort((a, b) => b.continuousFailures - a.continuousFailures);

  let dnd: CronHealth['dnd'];
  const state = await resolveDnd(home, { now });
  dnd = { dnd: state.dnd, reason: state.reason, detail: state.detail };

  return {
    lockHeld: lock !== null,
    lockAgeMs,
    lock,
    lastTick,
    lastExecutions,
    failingJobs,
    dnd,
  };
}

