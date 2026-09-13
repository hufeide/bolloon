/**
 * index.ts — 时钟结构的对外单一出口
 *
 * 调用方 (server / CLI) 只需要 import 这一个文件:
 *   - startCronScheduler(deps): 拉起调度器 (幂等; BOLLOON_CRON=0 → noop)
 *   - 查询: getCronHealth / listExecutions / readMonitorEvents / isMainTaskBusy / resolveDnd
 *   - 操作: addJob / listJobs / updateJob / resetFailures / ...
 *   - 勿扰: enterMainTask / exitMainTask (主任务执行期间把后台调成静音)
 *
 * 约定: 本模块不写 stdout/stderr. 事件全部走 monitor 的日志出口 (默认落
 * ~/.bolloon/cron/monitor.log), 需要转 SSE/前端时调用 setCronLogSink(fn).
 */

import * as os from 'os';
import { Scheduler, type SchedulerOptions, type TickResult } from './scheduler.js';
import { detectStuckTick, cronLog } from './monitor.js';
import { DEFAULT_STALE_MS } from './tick-lock.js';

export interface StartCronDeps {
  exec: SchedulerOptions['exec'];
  home?: string;
  /** 心跳间隔 (默认 60s) */
  intervalMs?: number;
  /** 单轮心跳预算 (默认 5min); 同时决定看门狗的"卡死"阈值 */
  tickTimeoutMs?: number;
  /** 注入当前时间 (测试用) */
  now?: () => Date;
}

export interface CronHandle {
  /** 停止心跳 (幂等) */
  stop: () => void;
  scheduler: Scheduler;
  /** true = 因 BOLLOON_CRON=0 未启动 */
  disabled: boolean;
  /** 手动触发一轮 (测试/CLI 用) */
  tickOnce: () => Promise<TickResult>;
}

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_TICK_TIMEOUT_MS = 300_000;

/** 幂等键 = home (同一 home 只允许一个调度器实例) */
const instances = new Map<string, CronHandle>();

/** 进程退出时停止心跳 (best-effort; 定时器本身已 unref) */
let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const h of instances.values()) {
      try {
        h.stop();
      } catch {
        /* best-effort */
      }
    }
  });
}

/**
 * 拉起调度器. 幂等: 同一 home 重复调用返回同一个实例.
 * BOLLOON_CRON=0 → 不启动, 返回 noop 句柄 (stop/tickOnce 都安全).
 */
export async function startCronScheduler(deps: StartCronDeps): Promise<CronHandle> {
  const home = deps.home ?? os.homedir();
  const existing = instances.get(home);
  if (existing) return existing;

  const scheduler = new Scheduler({
    exec: deps.exec,
    home,
    now: deps.now,
    lockStaleMs: DEFAULT_STALE_MS,
  });
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const tickTimeoutMs = deps.tickTimeoutMs ?? DEFAULT_TICK_TIMEOUT_MS;

  const disabled = process.env.BOLLOON_CRON === '0';
  if (disabled) {
    const noop: CronHandle = {
      stop: () => {},
      scheduler,
      disabled: true,
      tickOnce: () => scheduler.tickOnce(),
    };
    instances.set(home, noop);
    cronLog('info', 'monitor', '调度器未启动 (BOLLOON_CRON=0)', { home }, home);
    return noop;
  }

  // 看门狗: 启动前先回收可能残留的卡死锁
  try {
    await detectStuckTick({ home, tickTimeoutMs });
  } catch {
    /* 看门狗失败不该阻止启动 */
  }

  scheduler.start({ intervalMs, tickTimeoutMs });
  installExitHook();

  const handle: CronHandle = {
    stop: () => {
      scheduler.stop();
      instances.delete(home);
    },
    scheduler,
    disabled: false,
    tickOnce: () => scheduler.tickOnce(),
  };
  instances.set(home, handle);
  cronLog('info', 'monitor', '调度器已启动', { home, intervalMs, tickTimeoutMs }, home);
  return handle;
}

/** 当前已启动的调度器 (没有则 undefined) */
export function getRunningCronScheduler(home: string = os.homedir()): CronHandle | undefined {
  return instances.get(home);
}

// ---------------------------------------------------------------- 再导出

export { Scheduler, JobTimeoutError, withTimeout, nextStrictlyAfter, countMissedOccurrences } from './scheduler.js';
export type { SchedulerOptions, TickResult, JobRunSummary, StartOptions } from './scheduler.js';

export { parseSchedule, nextAfter } from './cron-parser.js';

export {
  addJob,
  listJobs,
  removeJob,
  setEnabled,
  updateJob,
  resetFailures,
  markRun,
  normalizeJob,
  jobsFile,
  DEFAULT_JOB_TIMEOUT_MS,
  DEFAULT_FAILURE_LIMIT,
} from './jobs-store.js';
export type { CronJob, NewJobInput, MarkRunExtra, LastStatus } from './jobs-store.js';

export {
  acquireTickLock,
  isLockStale,
  isProcessAlive,
  serializeLock,
  parseLock,
  tickLockPath,
  cronDir,
  DEFAULT_STALE_MS,
} from './tick-lock.js';
export type { TickLockInfo, TickLockHandle, TickLockBusy, TickLockResult } from './tick-lock.js';

export {
  markStarted,
  markFinished,
  recordNote,
  listExecutions,
  hasRun,
  clearExecutions,
  mergeExecutions,
  findBlockingRun,
  parseExecution,
  serializeExecution,
  executionsPath,
} from './executions-store.js';
export type { ExecutionRecord, ExecutionStatus, FinishedPatch, StartedInput, NoteInput } from './executions-store.js';

export {
  getCronHealth,
  detectStuckTick,
  setCronLogSink,
  cronLog,
  appendMonitorEvent,
  readMonitorEvents,
  monitorLogPath,
} from './monitor.js';
export type { CronHealth, CronLogEvent, CronLogSink, StuckTickReport } from './monitor.js';

export {
  enterMainTask,
  exitMainTask,
  isMainTaskBusy,
  resolveDnd,
  readDndConfig,
  mainTaskLockPath,
  dndConfigPath,
  resolveDndFrom,
  inQuietHours,
  isWithinQuietHours,
  parseClock,
  isMainTaskLockStale,
  parseMainTaskLock,
  serializeMainTaskLock,
  DEFAULT_MAIN_TASK_STALE_MS,
} from './dnd.js';
export type { MainTaskLock, DndConfig, DndReason, DndState, QuietRange } from './dnd.js';
