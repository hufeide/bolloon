import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Scheduler } from '../cron/scheduler.js';
import { addJob, listJobs, updateJob, resetFailures } from '../cron/jobs-store.js';
import {
  acquireTickLock,
  tickLockPath,
  cronDir,
  isLockStale,
  serializeLock,
  parseLock,
  type TickLockInfo,
} from '../cron/tick-lock.js';
import { listExecutions, markFinished, markStarted } from '../cron/executions-store.js';
import { enterMainTask, isMainTaskBusy, dndConfigPath } from '../cron/dnd.js';

let home: string;
/** 注入时钟: 本地 12:00 起步 (quietHours 用例与时区无关) */
let clock: Date;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'bolloon-cron-sched-'));
  clock = new Date(2026, 2, 1, 12, 0, 0, 0);
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

const nowFn = () => new Date(clock.getTime());
const step = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};

describe('cron tick 锁 (进程间互斥)', () => {
  it('① 锁竞争: 已持锁时第二个 tickOnce 返回 skipped + holder, 且不执行', async () => {
    await addJob({ name: '竞争', schedule: '1m', prompt: 'x' }, home);
    let called = 0;
    const sched = new Scheduler({
      exec: async () => {
        called += 1;
      },
      home,
      now: nowFn,
    });

    const held = await acquireTickLock({ home, now: nowFn });
    expect(held.acquired).toBe(true);
    expect(await fs.readFile(tickLockPath(home), 'utf-8')).toContain(process.pid.toString());

    const res = await sched.tickOnce();
    expect(res.reason).toBe('locked');
    expect(res.skipped).toBeTruthy();
    expect(res.ran).toBe(0);
    expect(res.lock.acquired).toBe(false);
    expect(res.holder?.pid).toBe(process.pid);
    expect(res.skippedRound).toBe(true);
    expect(called).toBe(0);

    if (held.acquired) await held.release();
    // 释放后同一实例能正常跑
    const res2 = await sched.tickOnce();
    expect(res2.lock.acquired).toBe(true);
    expect(res2.ran).toBe(1);
    expect(called).toBe(1);
  });

  it('② 陈旧锁回收: pid 不存在 / 时间过旧 → 下一次心跳能拿到锁', async () => {
    await fs.mkdir(cronDir(home), { recursive: true });
    const sched = new Scheduler({
      exec: async () => {},
      home,
      now: nowFn,
    });

    // 情况 A: pid 不存在 (僵尸锁)
    const dead: TickLockInfo = {
      pid: 999_999,
      host: 'gone',
      startedAt: new Date(clock.getTime() - 1000).toISOString(),
      tickId: 'dead-pid',
    };
    await fs.writeFile(tickLockPath(home), serializeLock(dead), 'utf-8');
    expect(parseLock(await fs.readFile(tickLockPath(home), 'utf-8'))?.tickId).toBe('dead-pid');
    let res = await sched.tickOnce();
    expect(res.lock.acquired).toBe(true);
    expect(res.ran).toBe(0); // 还没有 job

    // 情况 B: 进程还活着 (本进程) 但开始时间早于 stale 阈值
    const ancient: TickLockInfo = {
      pid: process.pid,
      host: os.hostname(),
      startedAt: new Date(clock.getTime() - 60 * 60_000).toISOString(),
      tickId: 'ancient',
    };
    expect(isLockStale(ancient, clock, 600_000)).toBe(true); // 纯函数: 超时即陈旧
    await fs.writeFile(tickLockPath(home), serializeLock(ancient), 'utf-8');
    res = await sched.tickOnce();
    expect(res.lock.acquired).toBe(true);

    // 反例: 新鲜的活锁不算陈旧
    const fresh: TickLockInfo = {
      pid: process.pid,
      host: os.hostname(),
      startedAt: clock.toISOString(),
      tickId: 'fresh',
    };
    expect(isLockStale(fresh, clock, 600_000)).toBe(false);
    await fs.writeFile(tickLockPath(home), serializeLock(fresh), 'utf-8');
    res = await sched.tickOnce();
    expect(res.lock.acquired).toBe(false);
    expect(res.holder?.tickId).toBe('fresh'); // 别人的锁没被误删
    expect(parseLock(await fs.readFile(tickLockPath(home), 'utf-8'))?.tickId).toBe('fresh');
  });

  it('release: 只删自己的锁 (tickId 不匹配时不误删)', async () => {
    const a = await acquireTickLock({ home, now: nowFn, tickId: 'tick-a' });
    expect(a.acquired).toBe(true);
    // 模拟锁被他人接管
    const b: TickLockInfo = {
      pid: process.pid,
      host: os.hostname(),
      startedAt: clock.toISOString(),
      tickId: 'tick-b',
    };
    await fs.writeFile(tickLockPath(home), serializeLock(b), 'utf-8');
    if (a.acquired) await a.release();
    expect(parseLock(await fs.readFile(tickLockPath(home), 'utf-8'))?.tickId).toBe('tick-b');
  });
});

describe('勿扰 (DND) 闸门', () => {
  it('主任务在跑 → 本轮不执行, 记 deferred; 释放后第一个 tick 补跑', async () => {
    const job = await addJob({ name: 'quiet', schedule: '1m', prompt: 'x' }, home);
    let calls = 0;
    const sched = new Scheduler({
      exec: async () => {
        calls += 1;
      },
      home,
      now: nowFn,
    });

    const release = await enterMainTask('主任务', home);
    expect((await isMainTaskBusy(home, { now: new Date(clock.getTime()) })).busy).toBe(true);

    const r1 = await sched.tickOnce();
    expect(r1.reason).toBe('dnd');
    expect(r1.dndReason).toBe('main-task');
    expect(r1.skipped).toBeTruthy();
    expect(r1.ran).toBe(0);
    expect(r1.skippedRound).toBe(true);
    expect(calls).toBe(0);

    const deferred = (await listExecutions({ home })).filter((e) => e.status === 'deferred');
    expect(deferred).toHaveLength(1);
    expect(deferred[0].jobId).toBe(job.id);
    expect(deferred[0].scheduledFor).toBe(clock.toISOString());
    // 勿扰不累计失败、不推进 lastRunAt
    const during = (await listJobs(home)).find((j) => j.id === job.id)!;
    expect(during.continuousFailures).toBe(0);
    expect(during.lastRunAt).toBeUndefined();

    // 再一轮勿扰: 不重复记 deferred
    step(30_000);
    await sched.tickOnce();
    expect((await listExecutions({ home })).filter((e) => e.status === 'deferred')).toHaveLength(1);
    expect(calls).toBe(0);

    // 主任务结束 → 下一个 tick 把积压的 due job 跑掉
    await release();
    expect((await isMainTaskBusy(home, { now: new Date(clock.getTime()) })).busy).toBe(false);
    const r2 = await sched.tickOnce();
    expect(r2.reason).toBeUndefined();
    expect(r2.ran).toBe(1);
    expect(calls).toBe(1);
    expect((await listExecutions({ home })).some((e) => e.status === 'ok')).toBe(true);
  });

  it('quietHours 命中 → dnd (quiet-hours), 到点也不跑', async () => {
    await fs.mkdir(cronDir(home), { recursive: true });
    await fs.writeFile(
      dndConfigPath(home),
      JSON.stringify({ quietHours: [{ from: '11:00', to: '13:00' }] }),
      'utf-8',
    );
    await addJob({ name: 'night', schedule: '1m', prompt: 'x' }, home);
    let calls = 0;
    const sched = new Scheduler({
      exec: async () => {
        calls += 1;
      },
      home,
      now: nowFn,
    });

    const res = await sched.tickOnce();
    expect(res.reason).toBe('dnd');
    expect(res.dndReason).toBe('quiet-hours');
    expect(calls).toBe(0);

    // 走出静默时段 (本地 12:00 → 14:00)
    clock = new Date(2026, 2, 1, 14, 0, 0, 0);
    const res2 = await sched.tickOnce();
    expect(res2.dndReason).toBeUndefined();
    expect(res2.ran).toBe(1);
    expect(calls).toBe(1);
  });

  it('dnd.json enabled=false → config-off, 即使主任务在跑也照常执行', async () => {
    await fs.mkdir(cronDir(home), { recursive: true });
    await fs.writeFile(dndConfigPath(home), JSON.stringify({ enabled: false, quietHours: [{ from: '00:00', to: '23:59' }] }), 'utf-8');
    await addJob({ name: 'loud', schedule: '1m', prompt: 'x' }, home);
    let calls = 0;
    const sched = new Scheduler({
      exec: async () => {
        calls += 1;
      },
      home,
      now: nowFn,
    });

    const release = await enterMainTask('主任务', home);
    const res = await sched.tickOnce();
    expect(res.reason).toBeUndefined();
    expect(res.ran).toBe(1);
    expect(calls).toBe(1);
    await release();
  });
});


describe('cron 执行记录 (ok / failed / timeout)', () => {
  it('③ 成功 → ok, 失败 → failed, 超时 → timeout', async () => {
    const ok = await addJob({ name: 'ok-job', schedule: '1m', prompt: 'x' }, home);
    const bad = await addJob({ name: 'bad-job', schedule: '1m', prompt: 'x' }, home);
    const slow = await addJob({ name: 'slow-job', schedule: '1m', prompt: 'x', timeoutMs: 30 }, home);

    const sched = new Scheduler({
      exec: async (job) => {
        if (job.id === bad.id) throw new Error('模拟失败');
        if (job.id === slow.id) await new Promise((r) => setTimeout(r, 300));
      },
      home,
      now: nowFn,
    });

    const res = await sched.tickOnce();
    expect(res.ran).toBe(1);
    expect(res.failed).toBe(2);

    const runs = await listExecutions({ home });
    const byId = (id: string) => runs.find((r) => r.jobId === id)!;
    expect(byId(ok.id).status).toBe('ok');
    expect(byId(ok.id).scheduledFor).toBe(clock.toISOString());
    expect(byId(ok.id).durationMs).toBeGreaterThanOrEqual(0);
    expect(byId(ok.id).finishedAt).toBeTruthy();

    expect(byId(bad.id).status).toBe('failed');
    expect(byId(bad.id).error).toContain('模拟失败');

    expect(byId(slow.id).status).toBe('timeout');
    expect(byId(slow.id).error).toContain('超时');

    // job 状态回写
    const jobs = await listJobs(home);
    expect(jobs.find((j) => j.id === ok.id)!.lastStatus).toBe('ok');
    expect(jobs.find((j) => j.id === ok.id)!.runCount).toBe(1);
    expect(jobs.find((j) => j.id === bad.id)!.lastStatus).toBe('failed');
    expect(jobs.find((j) => j.id === bad.id)!.continuousFailures).toBe(1);
    expect(jobs.find((j) => j.id === slow.id)!.lastStatus).toBe('timeout');
    expect(jobs.find((j) => j.id === slow.id)!.lastDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('④ 熔断: 连续失败达 failureLimit 后不再执行, resetFailures 后恢复', async () => {
    const job = await addJob({ name: 'flaky', schedule: '1m', prompt: 'x', failureLimit: 2 }, home);
    let calls = 0;
    const sched = new Scheduler({
      exec: async () => {
        calls += 1;
        throw new Error('boom');
      },
      home,
      now: nowFn,
    });

    expect((await sched.tickOnce()).failed).toBe(1);
    step(90_000);
    expect((await sched.tickOnce()).failed).toBe(1);
    expect(calls).toBe(2);

    let cur = (await listJobs(home)).find((j) => j.id === job.id)!;
    expect(cur.continuousFailures).toBe(2);
    expect(cur.pausedReason).toBe('continuous-failure');
    expect(cur.lastStatus).toBe('failed');
    expect(cur.lastError).toContain('boom');

    // 熔断后 → 到点也不执行 (需人工 resume)
    step(90_000);
    const r3 = await sched.tickOnce();
    expect(calls).toBe(2);
    expect(r3.ran).toBe(0);
    expect(r3.jobs.some((j) => j.reason === 'paused')).toBe(true);

    // 人工恢复
    await resetFailures(job.id, home);
    cur = (await listJobs(home)).find((j) => j.id === job.id)!;
    expect(cur.pausedReason).toBeUndefined();
    expect(cur.continuousFailures).toBe(0);
    step(90_000);
    await sched.tickOnce();
    expect(calls).toBe(3);
    expect(sched.failureCounts().size).toBeGreaterThanOrEqual(0);
  });

  it('⑤ misfire: 错过多个周期只补跑 1 次, 并记一条 missed', async () => {
    const job = await addJob({ name: 'lagger', schedule: '1m', prompt: 'x' }, home);
    // 上次运行在 10 分钟前 → 错过多个周期
    const last = new Date(clock.getTime() - 10 * 60_000);
    await updateJob(job.id, { lastRunAt: last.toISOString() }, home);

    let calls = 0;
    const sched = new Scheduler({
      exec: async () => {
        calls += 1;
      },
      home,
      now: nowFn,
    });

    const res = await sched.tickOnce();
    expect(calls).toBe(1); // 只补跑 1 次, 不挨个补
    expect(res.ran).toBe(1);

    const runs = await listExecutions({ home });
    const missed = runs.filter((r) => r.status === 'missed');
    expect(missed).toHaveLength(1);
    expect(missed[0].scheduledFor).toBe(new Date(last.getTime() + 60_000).toISOString());
    expect(missed[0].outputSummary).toMatch(/错过 \d+ 个触发点/);
    expect(runs.filter((r) => r.status === 'ok')).toHaveLength(1);
    expect(res.jobs.filter((j) => j.status === 'missed')[0]?.missedOccurrences).toBeGreaterThanOrEqual(1);

    // 同一触发点不重复记 missed
    step(90_000);
    await updateJob(job.id, { lastRunAt: last.toISOString(), continuousFailures: 0 }, home);
    await sched.tickOnce();
    expect((await listExecutions({ home })).filter((r) => r.status === 'missed')).toHaveLength(1);
  });

  it('⑥ 幂等: 同一触发点重复 tick 不重复执行', async () => {
    const job = await addJob({ name: 'once', schedule: '1m', prompt: 'x' }, home);
    let calls = 0;
    const sched = new Scheduler({
      exec: async () => {
        calls += 1;
      },
      home,
      now: nowFn,
    });

    expect((await sched.tickOnce()).ran).toBe(1);
    expect((await sched.tickOnce()).ran).toBe(0); // 同一 now: 未到点
    expect(calls).toBe(1);

    // 直接构造"同一触发点已有 ok 记录": 把 lastRunAt 拨回一个周期前
    await updateJob(job.id, { lastRunAt: new Date(clock.getTime() - 60_000).toISOString() }, home);
    const r3 = await sched.tickOnce();
    expect(calls).toBe(1); // 幂等拦截
    expect(r3.jobs.some((j) => j.reason === 'already-ran')).toBe(true);

    // 预置一条 ok 记录 (模拟另一进程已跑过) → 同样不执行
    await updateJob(job.id, { lastRunAt: new Date(clock.getTime() - 120_000).toISOString() }, home);
    const forkId = 'fork-tick:' + job.id;
    await markStarted(
      {
        runId: forkId,
        jobId: job.id,
        jobName: job.name,
        scheduledFor: new Date(clock.getTime() - 60_000).toISOString(),
      },
      home,
    );
    await markFinished(forkId, { status: 'ok', durationMs: 5, jobId: job.id, scheduledFor: new Date(clock.getTime() - 60_000).toISOString() }, home);
    const r4 = await sched.tickOnce();
    expect(calls).toBe(1);
    expect(r4.jobs.some((j) => j.reason === 'already-ran')).toBe(true);
  });
});

