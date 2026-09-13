/**
 * jobs-store.ts — 定时任务 (schedule jobs) 持久化
 *
 * 心智:
 *   - 每条 job 有: id / name / schedule (cron 或 every N) / prompt (执行体) / enabled
 *   - 记录 lastRunAt / runCount / lastStatus / lastDurationMs / continuousFailures / pausedReason
 *   - 落盘 ~/.bolloon/cron-jobs.json, 进程内互斥链序列化 + 临时文件原子写
 *   - 不建数据库, 不引入外部调度系统 —— 单文件 + 内存互斥
 *
 * 向后兼容: version:1 的老文件没有新字段, 读盘时统一补默认值 (老文件照常可读可写).
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

/** 单次执行超时默认 10min */
export const DEFAULT_JOB_TIMEOUT_MS = 600_000;
/** 连续失败熔断阈值默认 5 次 */
export const DEFAULT_FAILURE_LIMIT = 5;

export interface CronJob {
  id: string;
  name: string;
  /** e.g. "0 8 * * *" / "every 30m" / "1h" */
  schedule: string;
  /** 要投给 agent 的执行指令 (LLM prompt) */
  prompt: string;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  runCount: number;
  /** 单次执行超时 (ms) */
  timeoutMs?: number;
  /** 连续失败熔断阈值 */
  failureLimit?: number;
  /** 连续失败计数 (成功清零) */
  continuousFailures?: number;
  /** 最近一次执行状态 */
  lastStatus?: 'ok' | 'failed' | 'timeout' | 'skipped' | 'missed' | 'deferred';
  lastError?: string;
  lastDurationMs?: number;
  /** 下一次应跑时刻 (ISO) */
  nextRunAt?: string;
  /** 人工暂停原因 (如 'continuous-failure'); 有值 = 不再自动执行 */
  pausedReason?: string;
}

export type LastStatus = NonNullable<CronJob['lastStatus']>;

interface JobsFile {
  version: 1;
  jobs: CronJob[];
}

function getJobsPath(home: string = os.homedir()): string {
  return path.join(home, '.bolloon', 'cron-jobs.json');
}

let jobsLock: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = jobsLock.then(fn);
  jobsLock = run.then(() => undefined, () => undefined);
  return run;
}

/** 老文件兼容: 缺字段补默认值 (不改动已有值) */
export function normalizeJob(raw: Partial<CronJob> & { id: string; name?: string }): CronJob {
  return {
    id: String(raw.id),
    name: typeof raw.name === 'string' ? raw.name : '',
    schedule: typeof raw.schedule === 'string' ? raw.schedule : '',
    prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
    enabled: raw.enabled !== false,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date(0).toISOString(),
    lastRunAt: typeof raw.lastRunAt === 'string' ? raw.lastRunAt : undefined,
    runCount: typeof raw.runCount === 'number' ? raw.runCount : 0,
    timeoutMs: typeof raw.timeoutMs === 'number' ? raw.timeoutMs : DEFAULT_JOB_TIMEOUT_MS,
    failureLimit: typeof raw.failureLimit === 'number' ? raw.failureLimit : DEFAULT_FAILURE_LIMIT,
    continuousFailures: typeof raw.continuousFailures === 'number' ? raw.continuousFailures : 0,
    lastStatus: raw.lastStatus,
    lastError: typeof raw.lastError === 'string' ? raw.lastError : undefined,
    lastDurationMs: typeof raw.lastDurationMs === 'number' ? raw.lastDurationMs : undefined,
    nextRunAt: typeof raw.nextRunAt === 'string' ? raw.nextRunAt : undefined,
    pausedReason: typeof raw.pausedReason === 'string' ? raw.pausedReason : undefined,
  };
}

async function readAll(home: string): Promise<JobsFile> {
  try {
    const raw = await fs.readFile(getJobsPath(home), 'utf-8');
    const p = JSON.parse(raw) as Partial<JobsFile>;
    if (p?.version === 1 && Array.isArray(p.jobs)) {
      return { version: 1, jobs: p.jobs.map((j) => normalizeJob(j as CronJob)) };
    }
    return { version: 1, jobs: [] };
  } catch {
    return { version: 1, jobs: [] };
  }
}

async function writeAll(file: JobsFile, home: string): Promise<void> {
  const p = getJobsPath(home);
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(file, null, 2), 'utf-8');
  await fs.rename(tmp, p);
}

export interface NewJobInput {
  name: string;
  schedule: string;
  prompt: string;
  timeoutMs?: number;
  failureLimit?: number;
}

export async function addJob(input: NewJobInput, home: string = os.homedir()): Promise<CronJob> {
  return withLock(async () => {
    const file = await readAll(home);
    const job: CronJob = {
      id: crypto.randomUUID(),
      name: input.name,
      schedule: input.schedule,
      prompt: input.prompt,
      enabled: true,
      createdAt: new Date().toISOString(),
      runCount: 0,
      timeoutMs: input.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS,
      failureLimit: input.failureLimit ?? DEFAULT_FAILURE_LIMIT,
      continuousFailures: 0,
    };
    file.jobs.push(job);
    await writeAll(file, home);
    return job;
  });
}

export async function listJobs(home: string = os.homedir()): Promise<CronJob[]> {
  return withLock(async () => (await readAll(home)).jobs);
}

export async function removeJob(id: string, home: string = os.homedir()): Promise<boolean> {
  return withLock(async () => {
    const file = await readAll(home);
    const before = file.jobs.length;
    file.jobs = file.jobs.filter((j) => j.id !== id);
    if (file.jobs.length === before) return false;
    await writeAll(file, home);
    return true;
  });
}

export async function setEnabled(id: string, enabled: boolean, home: string = os.homedir()): Promise<CronJob | null> {
  return withLock(async () => {
    const file = await readAll(home);
    const job = file.jobs.find((j) => j.id === id);
    if (!job) return null;
    job.enabled = enabled;
    if (enabled && job.pausedReason) delete job.pausedReason; // 重新启用 = 解除暂停
    await writeAll(file, home);
    return job;
  });
}

/** 通用字段补丁 (白名单以外字段忽略); 返回更新后的 job, 不存在返回 null */
export async function updateJob(
  id: string,
  patch: Partial<Omit<CronJob, 'id'>>,
  home: string = os.homedir(),
): Promise<CronJob | null> {
  return withLock(async () => {
    const file = await readAll(home);
    const idx = file.jobs.findIndex((j) => j.id === id);
    if (idx < 0) return null;
    const job = file.jobs[idx];
    const next: CronJob = { ...job, ...patch, id: job.id } as CronJob;
    // 显式传入 undefined = 删除该字段 (例如清除 pausedReason / lastError)
    for (const k of ['lastRunAt', 'lastError', 'nextRunAt', 'pausedReason'] as const) {
      if (k in patch && patch[k] === undefined) delete (next as unknown as Record<string, unknown>)[k];
    }
    file.jobs[idx] = next; // 整体替换: 避免 Object.assign 留下"应被删除"的旧键
    await writeAll(file, home);
    return next;
  });
}

/** 清零连续失败并解除 'continuous-failure' 暂停 (人工 resume 入口) */
export async function resetFailures(id: string, home: string = os.homedir()): Promise<CronJob | null> {
  return updateJob(
    id,
    {
      continuousFailures: 0,
      pausedReason: undefined,
      lastError: undefined,
      lastStatus: undefined,
    },
    home,
  );
}

export interface MarkRunExtra {
  status?: LastStatus;
  durationMs?: number;
  error?: string;
  nextRunAt?: string;
}

/**
 * 标记已运行: 更新 lastRunAt + runCount (+ lastStatus/lastDurationMs/nextRunAt/error)
 * runCount 只在 status 为 ok/timeout/failed 时递增 —— missed/deferred/skipped 不算"跑过".
 */
export async function markRun(
  id: string,
  at: string,
  home: string = os.homedir(),
  extra: MarkRunExtra = {},
): Promise<CronJob | null> {
  return withLock(async () => {
    const file = await readAll(home);
    const job = file.jobs.find((j) => j.id === id);
    if (!job) return null;
    const status = extra.status ?? 'ok';
    job.lastRunAt = at;
    if (status === 'ok' || status === 'failed' || status === 'timeout') job.runCount += 1;
    job.lastStatus = status;
    if (extra.durationMs != null) job.lastDurationMs = extra.durationMs;
    if (extra.nextRunAt != null) job.nextRunAt = extra.nextRunAt;
    if (extra.error != null) job.lastError = extra.error;
    else if (status === 'ok') delete job.lastError;
    await writeAll(file, home);
    return job;
  });
}

/** 供测试/诊断: 直接读盘路径 */
export function jobsFile(home: string = os.homedir()): string {
  return getJobsPath(home);
}
