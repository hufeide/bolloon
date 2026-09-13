/**
 * dnd.ts — 勿扰模式 (DND) 载体: 主任务忙闲闸门 + 静态勿扰配置
 *
 * 两种勿扰来源:
 *   1. 主任务忙: 主任务执行期间写 ~/.bolloon/cron/main-task.lock ({pid, startedAt, label}),
 *      跨进程可见 → 后台心跳读到就安静待命, 不打扰、不抢占
 *   2. 静态配置: ~/.bolloon/cron/dnd.json
 *      { enabled?: boolean, duringMainTask?: boolean (默认 true), quietHours?: [{from:'23:00', to:'07:00'}] }
 *
 * 优先级 (resolveDnd 的判定顺序):
 *   enabled === false         → { dnd:false, reason:'config-off' }
 *   duringMainTask && 主任务忙 → { dnd:true,  reason:'main-task' }
 *   命中 quietHours            → { dnd:true,  reason:'quiet-hours' }
 *   其余                       → { dnd:false, reason:'none' }
 *
 * 纯函数 (可单测): parseClock / isWithinQuietHours / resolveDndFrom / inQuietHours
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cronDir, isProcessAlive } from './tick-lock.js';

/** 主任务锁默认陈旧阈值: 30min */
export const DEFAULT_MAIN_TASK_STALE_MS = 1_800_000;

export interface MainTaskLock {
  pid: number;
  /** ISO 时间 */
  startedAt: string;
  label: string;
}

export interface QuietRange {
  from: string; // 'HH:MM'
  to: string; // 'HH:MM'
}

export interface DndConfig {
  enabled?: boolean;
  /** 主任务执行期间勿扰 (默认 true) */
  duringMainTask?: boolean;
  quietHours?: QuietRange[];
}

export type DndReason = 'config-off' | 'main-task' | 'quiet-hours' | 'none';

export interface DndState {
  dnd: boolean;
  reason: DndReason;
  /** 人类可读补充说明 */
  detail?: string;
}

export function mainTaskLockPath(home: string = os.homedir()): string {
  return path.join(cronDir(home), 'main-task.lock');
}

export function dndConfigPath(home: string = os.homedir()): string {
  return path.join(cronDir(home), 'dnd.json');
}

// ---------------------------------------------------------------- 纯函数

/** 'HH:MM' → 自 00:00 起的分钟数; 非法返回 null */
export function parseClock(raw: string): number | null {
  const m = (raw || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

/** 当前时刻是否落在某个 quietHours 区间内 (支持跨夜: from > to 表示跨午夜) */
export function isWithinQuietHours(range: QuietRange, now: Date): boolean {
  const from = parseClock(range?.from ?? '');
  const to = parseClock(range?.to ?? '');
  if (from == null || to == null) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  if (from === to) return true; // 相同 = 全天勿扰
  if (from < to) return cur >= from && cur < to;
  return cur >= from || cur < to; // 跨夜
}

/** quietHours 中是否命中 (任一段命中即命中) */
export function inQuietHours(ranges: QuietRange[] | undefined, now: Date): QuietRange | null {
  if (!Array.isArray(ranges)) return null;
  for (const r of ranges) {
    if (r && isWithinQuietHours(r, now)) return r;
  }
  return null;
}

/** resolveDnd 的纯逻辑部分: 给定"主任务是否忙"与配置, 判断当前是否勿扰 */
export function resolveDndFrom(busy: boolean, cfg: DndConfig | null, now: Date): DndState {
  const conf = cfg ?? {};
  if (conf.enabled === false) return { dnd: false, reason: 'config-off', detail: 'dnd.json enabled=false' };
  if ((conf.duringMainTask ?? true) && busy) {
    return { dnd: true, reason: 'main-task', detail: '主任务执行中' };
  }
  const hit = inQuietHours(conf.quietHours, now);
  if (hit) return { dnd: true, reason: 'quiet-hours', detail: `${hit.from}-${hit.to}` };
  return { dnd: false, reason: 'none' };
}

/** 锁信息 ↔ 文件内容 (纯) */
export function serializeMainTaskLock(lock: MainTaskLock): string {
  return JSON.stringify({ pid: lock.pid, startedAt: lock.startedAt, label: lock.label }, null, 2);
}

export function parseMainTaskLock(raw: string): MainTaskLock | null {
  try {
    const p = JSON.parse(raw) as Partial<MainTaskLock>;
    if (typeof p?.pid !== 'number' || typeof p?.startedAt !== 'string') return null;
    return { pid: p.pid, startedAt: p.startedAt, label: typeof p.label === 'string' ? p.label : '' };
  } catch {
    return null;
  }
}

/** 主任务锁是否陈旧 (进程已死 / 超时 / 不可读) */
export function isMainTaskLockStale(
  lock: MainTaskLock | null,
  now: Date,
  staleMs: number = DEFAULT_MAIN_TASK_STALE_MS,
  isAlive: (pid: number) => boolean = isProcessAlive,
): boolean {
  if (!lock) return true;
  if (!isAlive(lock.pid)) return true;
  const started = Date.parse(lock.startedAt);
  if (!Number.isFinite(started)) return true;
  return now.getTime() - started > staleMs;
}

// ---------------------------------------------------------------- 主任务忙闲闸门

/** 本进程持有的主任务锁: home(lockPath) → { tickId 不可比, 用 label + 引用计数 } */
const heldMainTasks = new Map<string, { lock: MainTaskLock; depth: number }>();
let mainExitHookInstalled = false;

/** 进程退出兜底: best-effort 同步释放 (只删自己写的那个 pid) */
function installMainExitHook(): void {
  if (mainExitHookInstalled) return;
  mainExitHookInstalled = true;
  process.on('exit', () => {
    for (const [lockPath, held] of heldMainTasks) {
      try {
        const raw = fsSync.readFileSync(lockPath, 'utf-8');
        const cur = parseMainTaskLock(raw);
        if (cur && cur.pid === process.pid && cur.startedAt === held.lock.startedAt) {
          fsSync.unlinkSync(lockPath);
        }
      } catch {
        /* best-effort: 退出阶段静默 */
      }
    }
    heldMainTasks.clear();
  });
}

/**
 * 进入主任务 (写忙闸门). 幂等: 同进程重复调用只记引用深度, 不覆盖 startedAt.
 * @returns 释放函数 (幂等; try/finally 里调用即可)
 */
export async function enterMainTask(
  label: string = 'main-task',
  home: string = os.homedir(),
): Promise<() => Promise<void>> {
  const lockPath = mainTaskLockPath(home);
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  const held = heldMainTasks.get(lockPath);
  if (held) {
    held.depth += 1; // 重入: 复用同一把锁
  } else {
    const lock: MainTaskLock = { pid: process.pid, startedAt: new Date().toISOString(), label };
    await fs.writeFile(lockPath, serializeMainTaskLock(lock), 'utf-8');
    heldMainTasks.set(lockPath, { lock, depth: 1 });
    installMainExitHook();
  }

  let released = false;
  return async () => {
    if (released) return; // 幂等
    released = true;
    const cur = heldMainTasks.get(lockPath);
    if (cur) {
      cur.depth -= 1;
      if (cur.depth > 0) return; // 还有外层持有
    }
    await exitMainTask(home);
  };
}

/** 释放主任务闸门 (best-effort; 仅当锁文件仍属于本进程时删除) */
export async function exitMainTask(home: string = os.homedir()): Promise<void> {
  const lockPath = mainTaskLockPath(home);
  const held = heldMainTasks.get(lockPath);
  heldMainTasks.delete(lockPath);
  try {
    const cur = parseMainTaskLock(await fs.readFile(lockPath, 'utf-8'));
    const mine = held ? cur?.pid === process.pid && cur?.startedAt === held.lock.startedAt : cur?.pid === process.pid;
    if (!mine) return; // 别人的锁不动
    await fs.rm(lockPath, { force: true });
  } catch {
    /* best-effort 释放 */
  }
}

export interface MainTaskBusyResult {
  busy: boolean;
  lock: MainTaskLock | null;
  ageMs: number | null;
  /** 是否因陈旧被回收 */
  reclaimed: boolean;
}

/** 主任务是否在跑 (跨进程): 锁存在、进程存活、未超 staleMs → busy; 否则视为陈旧并回收 */
export async function isMainTaskBusy(
  home: string = os.homedir(),
  opts: { staleMs?: number; now?: Date; isAlive?: (pid: number) => boolean } = {},
): Promise<MainTaskBusyResult> {
  const lockPath = mainTaskLockPath(home);
  const now = opts.now ?? new Date();
  let lock: MainTaskLock | null = null;
  try {
    lock = parseMainTaskLock(await fs.readFile(lockPath, 'utf-8'));
  } catch {
    return { busy: false, lock: null, ageMs: null, reclaimed: false };
  }
  const ageMs = lock ? now.getTime() - (Date.parse(lock.startedAt) || 0) : null;
  if (!isMainTaskLockStale(lock, now, opts.staleMs ?? DEFAULT_MAIN_TASK_STALE_MS, opts.isAlive ?? isProcessAlive)) {
    return { busy: true, lock, ageMs, reclaimed: false };
  }
  // 陈旧: 回收, 不把残留锁当成"主任务在跑"
  try {
    await fs.rm(lockPath, { force: true });
  } catch {
    /* ignore */
  }
  return { busy: false, lock, ageMs, reclaimed: true };
}

// ---------------------------------------------------------------- 配置 + 合成判定

export async function readDndConfig(home: string = os.homedir()): Promise<DndConfig> {
  try {
    const raw = await fs.readFile(dndConfigPath(home), 'utf-8');
    const p = JSON.parse(raw) as DndConfig;
    return p && typeof p === 'object' ? p : {};
  } catch {
    return {}; // 无配置文件 = 默认行为 (enabled 未关闭, duringMainTask=true)
  }
}

/** 合成判定: 读主任务锁 + 读 dnd.json → DndState */
export async function resolveDnd(
  home: string = os.homedir(),
  opts: { now?: Date; staleMs?: number; isAlive?: (pid: number) => boolean; config?: DndConfig } = {},
): Promise<DndState> {
  const now = opts.now ?? new Date();
  const cfg = opts.config ?? (await readDndConfig(home));
  if (cfg.enabled === false) return resolveDndFrom(false, cfg, now); // 短路: 不必读锁
  const probe = await isMainTaskBusy(home, { now, staleMs: opts.staleMs, isAlive: opts.isAlive });
  return resolveDndFrom(probe.busy, cfg, now);
}

