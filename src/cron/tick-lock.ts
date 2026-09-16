/**
 * tick-lock.ts — 调度器心跳的跨进程互斥锁 (进程间文件锁)
 *
 * 语义:
 *   - 锁文件 ~/.bolloon/cron/.tick.lock, 内容 JSON { pid, host, startedAt, tickId }
 *   - acquire(): 用 fs.open(path,'wx') 原子创建 (O_CREAT|O_EXCL), 创建成功即持有
 *   - 已被占用 → 读内容判定: 持锁进程仍存活 且 startedAt 未超 staleMs (默认 10min)
 *       → 返回 { acquired:false, holder } (本轮心跳直接跳过: 不阻塞、不重试、不排队)
 *     否则视为陈旧锁 (进程已死 / 超时) → 回收 (删文件) 后重试一次, 回收动作记日志
 *   - release(): 只有自己的 tickId 与锁文件内容一致时才删除 (防止误删他人持有的锁)
 *   - 进程退出/异常路径: try/finally + process.on('exit') 双保险 (exit 内只做 best-effort 同步删除)
 *
 * 纯函数 (可单测): isLockStale / serializeLock / parseLock
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

/** 默认陈旧阈值: 10 分钟 (超过即认为持锁进程已卡死/消失) */
export const DEFAULT_STALE_MS = 600_000;

export interface TickLockInfo {
  pid: number;
  host: string;
  /** ISO 时间: 持锁开始时刻 */
  startedAt: string;
  tickId: string;
}

export type TickLockLogLevel = 'info' | 'warn' | 'error';

/** 日志出口: 默认丢弃 (调度器/监视器不得写 stdout/stderr), 由调用方注入 sink 决定落盘与转发 */
export type TickLockLogger = (level: TickLockLogLevel, message: string, detail?: Record<string, unknown>) => void;

const noopLogger: TickLockLogger = () => {};

/** cron 数据目录 ~/.bolloon/cron */
export function cronDir(home: string = os.homedir()): string {
  return path.join(home, '.bolloon', 'cron');
}

/** 锁文件绝对路径 */
export function tickLockPath(home: string = os.homedir()): string {
  return path.join(cronDir(home), '.tick.lock');
}

// ---------------------------------------------------------------- 纯函数

/**
 * 判定锁是否陈旧 (可回收). 纯函数: 进程存活判定通过 isAlive 注入, 便于确定性单测.
 * 规则: 持锁进程不存活 → 陈旧; 存活但 startedAt 已超 staleMs → 陈旧; 否则有效.
 */
export function isLockStale(
  lock: TickLockInfo | null,
  now: Date,
  staleMs: number = DEFAULT_STALE_MS,
  isAlive: (pid: number) => boolean = isProcessAlive,
): boolean {
  if (!lock) return true; // 内容不可读 = 不可信 = 视为陈旧
  if (!Number.isFinite(lock.pid) || lock.pid <= 0) return true;
  if (!isAlive(lock.pid)) return true;
  const started = Date.parse(lock.startedAt);
  if (!Number.isFinite(started)) return true; // 时间不可解析 = 不可信
  return now.getTime() - started > staleMs;
}

/** 锁信息 → 文件内容 (固定字段顺序, 便于人读) */
export function serializeLock(lock: TickLockInfo): string {
  return JSON.stringify(
    { pid: lock.pid, host: lock.host, startedAt: lock.startedAt, tickId: lock.tickId },
    null,
    2,
  );
}

/** 文件内容 → 锁信息; 不可解析 / 字段缺失 → null (调用方按陈旧处理) */
export function parseLock(raw: string): TickLockInfo | null {
  try {
    const p = JSON.parse(raw) as Partial<TickLockInfo>;
    if (typeof p?.tickId !== 'string' || typeof p?.pid !== 'number' || typeof p?.startedAt !== 'string') {
      return null;
    }
    return {
      pid: p.pid,
      host: typeof p.host === 'string' ? p.host : '',
      startedAt: p.startedAt,
      tickId: p.tickId,
    };
  } catch {
    return null;
  }
}

/** 进程是否存活: kill(pid,0) 不抛 = 存活; EPERM = 存在但无权限 (仍算存活); ESRCH = 不存在 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

// ---------------------------------------------------------------- 持有句柄

export interface TickLockHandle {
  acquired: true;
  tickId: string;
  lock: TickLockInfo;
  /** 释放锁 (幂等; 仅当锁文件仍属自己时删除) */
  release: () => Promise<void>;
}

export interface TickLockBusy {
  acquired: false;
  holder: TickLockInfo | null;
}

export type TickLockResult = TickLockHandle | TickLockBusy;

export interface AcquireTickLockOptions {
  home?: string;
  /**
   * 2026-09-16: 自定义锁文件路径 (默认 cron 的 ~/.bolloon/cron/.tick.lock)。
   * Supervisor 用同一套锁语义 (`~/.bolloon/supervisor/.tick.lock`), 但**不与 cron 共用一个文件** ——
   * 两种 tick 的陈旧阈值与语义不同, 共文件会让一方把另一方判成陈旧。
   */
  lockPath?: string;
  /** 陈旧阈值 (ms), 默认 10min */
  staleMs?: number;
  now?: () => Date;
  log?: TickLockLogger;
  /** 注入存活判定 (测试用), 默认 process.kill(pid,0) */
  isAlive?: (pid: number) => boolean;
  /** 注入 tickId (测试用) */
  tickId?: string;
}

/** 本进程当前持有的 tick 锁 (供应急退出钩子 best-effort 释放) */
const heldLocks = new Map<string, string>(); // lockPath -> tickId
let exitHookInstalled = false;

/** 进程退出兜底: 只做同步 best-effort 删除, 不抛异常 (唯一出口, 不污染 stdout) */
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const [lockPath, tickId] of heldLocks) {
      try {
        const raw = fsSync.readFileSync(lockPath, 'utf-8');
        const lock = parseLock(raw);
        if (lock && lock.tickId === tickId && lock.pid === process.pid) {
          fsSync.unlinkSync(lockPath);
        }
      } catch {
        /* best-effort: 退出阶段静默 */
      }
    }
    heldLocks.clear();
  });
}

async function readLockFile(lockPath: string): Promise<TickLockInfo | null> {
  try {
    return parseLock(await fs.readFile(lockPath, 'utf-8'));
  } catch {
    return null; // 已被他人删除 / 不可读 → 视为陈旧
  }
}

async function reclaim(lockPath: string, log: TickLockLogger, holder: TickLockInfo | null, reason: string): Promise<void> {
  log('warn', '回收陈旧 tick 锁', { lockPath, reason, holder });
  try {
    await fs.rm(lockPath, { force: true });
  } catch {
    /* 竞态下已被删除, 忽略 */
  }
}

/**
 * 尝试获取 tick 锁.
 * 已被有效持锁者占用 → 立即返回 { acquired:false, holder } (不阻塞、不重试 —— 本轮心跳跳过).
 * 陈旧 → 回收一次并重试一次.
 */
export async function acquireTickLock(opts: AcquireTickLockOptions = {}): Promise<TickLockResult> {
  const home = opts.home ?? os.homedir();
  const lockPath = opts.lockPath ?? tickLockPath(home);
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const now = (opts.now ?? (() => new Date()))();
  const log = opts.log ?? noopLogger;
  const isAlive = opts.isAlive ?? isProcessAlive;
  const tickId = opts.tickId ?? crypto.randomUUID();
  const lock: TickLockInfo = {
    pid: process.pid,
    host: os.hostname(),
    startedAt: now.toISOString(),
    tickId,
  };

  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    let fh: fs.FileHandle | null = null;
    try {
      // 'wx' = O_CREAT | O_EXCL: 原子创建, 已存在则抛 EEXIST
      fh = await fs.open(lockPath, 'wx');
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        log('error', 'tick 锁创建失败 (非竞争性错误)', { lockPath, error: String((e as Error)?.message ?? e) });
        throw e;
      }
      const holder = await readLockFile(lockPath);
      if (!isLockStale(holder, now, staleMs, isAlive)) {
        log('info', 'tick 锁被占用, 本轮跳过', { lockPath, holder });
        return { acquired: false, holder };
      }
      await reclaim(lockPath, log, holder, holder ? '进程已死或持锁超时' : '内容不可读');
      continue; // 回收后重试一次
    }

    try {
      await fh.writeFile(serializeLock(lock), 'utf-8');
      await fh.close();
    } catch (e) {
      try { await fh.close(); } catch { /* ignore */ }
      try { await fs.rm(lockPath, { force: true }); } catch { /* ignore */ }
      throw e;
    }

    heldLocks.set(lockPath, tickId);
    installExitHook();
    let released = false;
    return {
      acquired: true,
      tickId,
      lock,
      release: async () => {
        if (released) return; // 幂等
        released = true;
        heldLocks.delete(lockPath);
        try {
          const current = await readLockFile(lockPath);
          if (!current || current.tickId !== tickId) {
            log('warn', '释放 tick 锁时发现 tickId 不匹配, 不删除 (防误删)', { lockPath, holder: current });
            return;
          }
          await fs.rm(lockPath, { force: true });
        } catch {
          /* best-effort 释放 */
        }
      },
    };
  }

  // 两次都没抢到: 把当前持锁者信息带回 (调用方只需知道"被别人占了")
  return { acquired: false, holder: await readLockFile(lockPath) };
}

