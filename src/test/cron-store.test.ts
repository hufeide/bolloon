import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { addJob, listJobs, updateJob, resetFailures, markRun } from '../cron/jobs-store.js';
import { parseClock, isWithinQuietHours, resolveDndFrom, enterMainTask, exitMainTask, isMainTaskBusy, mainTaskLockPath, dndConfigPath, resolveDnd, DEFAULT_MAIN_TASK_STALE_MS } from '../cron/dnd.js';
import { cronDir, tickLockPath, serializeLock, parseLock } from '../cron/tick-lock.js';
import {
  listExecutions,
  markStarted,
  markFinished,
  mergeExecutions,
  serializeExecution,
  parseExecution,
  hasRun,
  executionsPath,
  MAX_LINES,
  KEEP_LINES,
} from '../cron/executions-store.js';
import { cronLog, readMonitorEvents, parseMonitorLine, formatMonitorLine, monitorLogPath, setCronLogSink, getCronHealth, detectStuckTick } from '../cron/monitor.js';
import { startCronScheduler } from '../cron/index.js';

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'bolloon-cron-store-'));
});

afterEach(async () => {
  setCronLogSink(null);
  await fs.rm(home, { recursive: true, force: true });
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('DND: 纯函数三态 + 主任务闸门', () => {
  it('parseClock / isWithinQuietHours (含跨夜)', () => {
    expect(parseClock('23:00')).toBe(1380);
    expect(parseClock('00:00')).toBe(0);
    expect(parseClock('24:00')).toBeNull();
    expect(parseClock('7:5')).toBeNull();
    expect(parseClock('')).toBeNull();
    const at = (h: number, m = 0) => new Date(2026, 2, 1, h, m, 0, 0);
    expect(isWithinQuietHours({ from: '23:00', to: '07:00' }, at(1))).toBe(true); // 跨夜
    expect(isWithinQuietHours({ from: '23:00', to: '07:00' }, at(23, 30))).toBe(true);
    expect(isWithinQuietHours({ from: '23:00', to: '07:00' }, at(12))).toBe(false);
    expect(isWithinQuietHours({ from: '11:00', to: '13:00' }, at(12))).toBe(true);
    expect(isWithinQuietHours({ from: '11:00', to: '13:00' }, at(13))).toBe(false); // 左闭右开
    expect(isWithinQuietHours({ from: '00:00', to: '00:00' }, at(5))).toBe(true); // 相同 = 全天
    expect(isWithinQuietHours({ from: 'bad', to: '13:00' }, at(12))).toBe(false);
  });

  it('resolveDndFrom: config-off / main-task / quiet-hours / none 四态', () => {
    const noon = new Date(2026, 2, 1, 12, 0, 0, 0);
    const night = new Date(2026, 2, 1, 2, 0, 0, 0);
    const quiet = [{ from: '23:00', to: '07:00' }];

    expect(resolveDndFrom(false, null, noon)).toMatchObject({ dnd: false, reason: 'none' });
    expect(resolveDndFrom(true, {}, noon)).toMatchObject({ dnd: true, reason: 'main-task' });
    expect(resolveDndFrom(true, { duringMainTask: false }, noon)).toMatchObject({ dnd: false, reason: 'none' });
    expect(resolveDndFrom(false, { quietHours: quiet }, night)).toMatchObject({ dnd: true, reason: 'quiet-hours' });
    // config-off 优先级最高: 即使主任务在跑 + 命中静默时段也不勿扰
    expect(resolveDndFrom(true, { enabled: false, quietHours: quiet }, night)).toMatchObject({
      dnd: false,
      reason: 'config-off',
    });
    // main-task 优先于 quiet-hours
    expect(resolveDndFrom(true, { quietHours: quiet }, night)).toMatchObject({ dnd: true, reason: 'main-task' });
  });

  it('enterMainTask/exitMainTask: 跨进程可见 + 幂等 + 陈旧回收', async () => {
    expect((await isMainTaskBusy(home)).busy).toBe(false);

    const release = await enterMainTask('主任务 A', home);
    const busy = await isMainTaskBusy(home);
    expect(busy.busy).toBe(true);
    expect(busy.lock?.label).toBe('主任务 A');
    expect(busy.lock?.pid).toBe(process.pid);
    // 重入 (幂等): 第二次 enter 不覆盖 startedAt
    const startedAt = busy.lock!.startedAt;
    const release2 = await enterMainTask('主任务 B', home);
    expect((await isMainTaskBusy(home)).lock?.startedAt).toBe(startedAt);
    await release2();
    expect((await isMainTaskBusy(home)).busy).toBe(true); // 还有外层持有
    await release();
    expect((await isMainTaskBusy(home)).busy).toBe(false);
    expect(await isMainTaskBusy(home).then((r) => r.reclaimed)).toBe(false); // 干净释放, 没什么可回收

    // 陈旧锁 (pid 不存在) → 不算忙, 且被回收
    await fs.mkdir(cronDir(home), { recursive: true });
    await fs.writeFile(
      mainTaskLockPath(home),
      JSON.stringify({ pid: 999_999, startedAt: new Date().toISOString(), label: 'ghost' }),
      'utf-8',
    );
    const stale = await isMainTaskBusy(home);
    expect(stale.busy).toBe(false);
    expect(stale.reclaimed).toBe(true);
    await expect(fs.readFile(mainTaskLockPath(home), 'utf-8')).rejects.toBeTruthy();

    // 超时锁 (进程活着但太久) → 也按陈旧回收
    await fs.writeFile(
      mainTaskLockPath(home),
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date(Date.now() - DEFAULT_MAIN_TASK_STALE_MS - 1000).toISOString(),
        label: 'too-old',
      }),
      'utf-8',
    );
    const old = await isMainTaskBusy(home);
    expect(old.busy).toBe(false);
    expect(old.reclaimed).toBe(true);
  });

  it('resolveDnd: 读 dnd.json + 主任务锁合成结论', async () => {
    await fs.mkdir(cronDir(home), { recursive: true });
    // 无配置 + 无锁 → none
    expect(await resolveDnd(home)).toMatchObject({ dnd: false, reason: 'none' });
    // duringMainTask=false → 主任务在跑也不勿扰
    await fs.writeFile(dndConfigPath(home), JSON.stringify({ duringMainTask: false }), 'utf-8');
    const release = await enterMainTask('主任务', home);
    expect(await resolveDnd(home)).toMatchObject({ dnd: false, reason: 'none' });
    await release();
    // enabled=false → config-off
    await fs.writeFile(dndConfigPath(home), JSON.stringify({ enabled: false }), 'utf-8');
    expect(await resolveDnd(home)).toMatchObject({ dnd: false, reason: 'config-off' });
    // 坏配置 → 当默认 (none)
    await fs.writeFile(dndConfigPath(home), '{ broken', 'utf-8');
    expect(await resolveDnd(home)).toMatchObject({ dnd: false, reason: 'none' });
  });
});

describe('monitor: 事件日志 / 看门狗 / 健康摘要', () => {
  it('monitor.log 一行一条 (ISO 时间), 可读回; sink 可替换且默认是文件', async () => {
    cronLog('warn', 'job', '示例事件', { foo: 1 }, home);
    await wait(120);
    const raw = await fs.readFile(monitorLogPath(home), 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim());
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('\twarn\tjob\t示例事件\t');
    expect(lines[0].startsWith('20')).toBe(true);
    const parsed = parseMonitorLine(lines[0]);
    expect(parsed?.kind).toBe('job');
    expect(parsed?.detail?.foo).toBe(1);
    expect(formatMonitorLine(parsed!)).toBe(lines[0]);
    expect(parseMonitorLine('乱码')).toBeNull();

    expect((await readMonitorEvents({ home })).map((e) => e.kind)).toEqual(['job']);

    // 换 sink: 事件不再落文件, 而是进内存 (server 可借此转 SSE)
    const captured: string[] = [];
    setCronLogSink((ev) => captured.push(ev.kind));
    cronLog('info', 'tick', '被转发', {}, home);
    expect(captured).toEqual(['tick']);
    await wait(80);
    expect((await fs.readFile(monitorLogPath(home), 'utf-8')).split('\n').filter((l) => l.trim())).toHaveLength(1);
    // 坏 sink 不得炸掉调用方
    setCronLogSink(() => {
      throw new Error('sink 坏了');
    });
    expect(() => cronLog('info', 'tick', 'x', {}, home)).not.toThrow();
  });

  it('detectStuckTick: 超预算 + 进程已死 → 回收并记事件; 活着或未超时 → 不动', async () => {
    const tickTimeoutMs = 1000;
    // 新鲜锁 → 不回收
    await fs.mkdir(cronDir(home), { recursive: true });
    await fs.writeFile(
      tickLockPath(home),
      serializeLock({ pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString(), tickId: 'fresh' }),
      'utf-8',
    );
    let rep = await detectStuckTick({ home, tickTimeoutMs });
    expect(rep.reclaimed).toBe(false);
    expect(parseLock(await fs.readFile(tickLockPath(home), 'utf-8'))?.tickId).toBe('fresh');

    // 超预算但进程活着 → 只报告, 不回收
    await fs.writeFile(
      tickLockPath(home),
      serializeLock({
        pid: process.pid,
        host: os.hostname(),
        startedAt: new Date(Date.now() - 10_000).toISOString(),
        tickId: 'alive-slow',
      }),
      'utf-8',
    );
    rep = await detectStuckTick({ home, tickTimeoutMs });
    expect(rep.reclaimed).toBe(false);
    expect(rep.ageMs).toBeGreaterThan(2000);

    // 超预算 + 进程已死 → 回收 + 记事件
    await fs.writeFile(
      tickLockPath(home),
      serializeLock({
        pid: 999_999,
        host: 'ghost',
        startedAt: new Date(Date.now() - 10_000).toISOString(),
        tickId: 'stuck',
      }),
      'utf-8',
    );
    rep = await detectStuckTick({ home, tickTimeoutMs });
    expect(rep.reclaimed).toBe(true);
    expect(rep.reason).toContain('不响应');
    await expect(fs.readFile(tickLockPath(home), 'utf-8')).rejects.toBeTruthy();
    await wait(100);
    const events = await readMonitorEvents({ home, kind: 'monitor' });
    expect(events.some((e) => e.message.includes('卡死'))).toBe(true);
  });

  it('getCronHealth: 锁状态 + 最近心跳 + 最近执行 + 失败 job', async () => {
    const job = await addJob({ name: 'sick', schedule: '1m', prompt: 'p' }, home);
    await updateJob(job.id, { continuousFailures: 3, lastError: 'boom' }, home);
    await markStarted({ runId: 'h1', jobId: job.id, jobName: job.name, scheduledFor: '2026-03-01T00:00:00.000Z' }, home);
    cronLog('info', 'tick', 'tick 完成: 跑 1, 跳过 0, 失败 0', { ran: 1, skipped: 0, failed: 0 }, home);
    await wait(120);

    const health = await getCronHealth(home);
    expect(health.lockHeld).toBe(false);
    expect(health.lockAgeMs).toBeNull();
    expect(health.lastTick?.ran).toBe(1);
    expect(health.lastExecutions).toHaveLength(1);
    expect(health.lastExecutions[0].runId).toBe('h1');
    expect(health.failingJobs).toHaveLength(1);
    expect(health.failingJobs[0].name).toBe('sick');
    expect(health.failingJobs[0].continuousFailures).toBe(3);
    expect(health.failingJobs[0].failureLimit).toBe(5);
    expect(health.dnd?.dnd).toBe(false);

    // 持锁 → lockHeld true + age 可读
    const { acquireTickLock } = await import('../cron/tick-lock.js');
    const lock = await acquireTickLock({ home });
    const health2 = await getCronHealth(home);
    expect(health2.lockHeld).toBe(true);
    expect(health2.lockAgeMs).toBeGreaterThanOrEqual(0);
    if (lock.acquired) await lock.release();
  });
});

describe('startCronScheduler (单一出口)', () => {
  it('BOLLOON_CRON=0 → noop 句柄, stop/tickOnce 都安全', async () => {
    const old = process.env.BOLLOON_CRON;
    process.env.BOLLOON_CRON = '0';
    try {
      const handle = await startCronScheduler({ exec: async () => {}, home, intervalMs: 20 });
      expect(handle.disabled).toBe(true);
      expect(() => handle.stop()).not.toThrow();
      const res = await handle.tickOnce(); // 仍然可手动触发一次
      expect(res.tickId).toBeTruthy();
    } finally {
      if (old === undefined) delete process.env.BOLLOON_CRON;
      else process.env.BOLLOON_CRON = old;
    }
  });

  it('幂等: 同一 home 重复调用返回同一实例; stop 后可重新启动', async () => {
    const h1 = await startCronScheduler({ exec: async () => {}, home, intervalMs: 60_000 });
    const h2 = await startCronScheduler({ exec: async () => {}, home, intervalMs: 60_000 });
    expect(h2).toBe(h1);
    expect(h1.disabled).toBe(false);
    expect(h1.scheduler.getIntervalMs()).toBe(60_000);
    h1.stop();
    const h3 = await startCronScheduler({ exec: async () => {}, home, intervalMs: 60_000 });
    expect(h3).not.toBe(h1); // 已停止 → 新实例
    h3.stop();
  });

  it('start()/stop(): 定时器真的在心跳, stop 后停下', async () => {
    const { Scheduler } = await import('../cron/scheduler.js');
    await addJob({ name: 'hb', schedule: '1m', prompt: 'p' }, home);
    let calls = 0;
    const sched = new Scheduler({
      exec: async () => {
        calls += 1;
      },
      home,
    });
    sched.start({ intervalMs: 25, tickTimeoutMs: 1000 });
    sched.start({ intervalMs: 25 }); // 幂等: 不会起第二个定时器
    await wait(200);
    sched.stop();
    await wait(50); // 等最后一条事件落盘

    const ticks1 = (await readMonitorEvents({ home, kind: 'tick' })).length;
    expect(ticks1).toBeGreaterThanOrEqual(1);
    expect(calls).toBeGreaterThanOrEqual(1); // 首个心跳就把 due job 跑了

    sched.stop(); // 幂等
    await wait(150);
    const ticks2 = (await readMonitorEvents({ home, kind: 'tick' })).length;
    expect(ticks2).toBe(ticks1); // 停止后不再有新心跳
  });
});

describe('executions-store: 归并 / 幂等 / 截断', () => {
  it('markStarted + markFinished 按 runId 归并成一条终态记录', async () => {
    await markStarted(
      { runId: 'r1', jobId: 'j1', jobName: '任务', scheduledFor: '2026-03-01T00:00:00.000Z', startedAt: '2026-03-01T00:00:00.000Z' },
      home,
    );
    let runs = await listExecutions({ home });
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('running');
    expect(await hasRun('j1', '2026-03-01T00:00:00.000Z', home)).toBe(true); // running 也算已占位

    await markFinished('r1', { status: 'ok', durationMs: 42, finishedAt: '2026-03-01T00:00:01.000Z' }, home);
    runs = await listExecutions({ home });
    expect(runs).toHaveLength(1); // 归并成一条
    expect(runs[0].status).toBe('ok');
    expect(runs[0].durationMs).toBe(42);
    expect(runs[0].jobId).toBe('j1'); // 底稿字段保留
    expect(runs[0].scheduledFor).toBe('2026-03-01T00:00:00.000Z');
    expect(runs[0].finishedAt).toBe('2026-03-01T00:00:01.000Z');
  });

  it('hasRun: ok/running 拦截, failed/timeout/missed/deferred 不拦截', async () => {
    const sf = '2026-03-01T01:00:00.000Z';
    expect(await hasRun('j2', sf, home)).toBe(false);
    await markStarted({ runId: 'r2', jobId: 'j2', jobName: 'n', scheduledFor: sf }, home);
    await markFinished('r2', { status: 'failed', error: 'x', finishedAt: '2026-03-01T01:00:01.000Z' }, home);
    expect(await hasRun('j2', sf, home)).toBe(false); // failed 可重试
    // 归并后仍是一条 (start + finish)
    const runs = await listExecutions({ jobId: 'j2', home });
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('failed');
    expect(runs[0].error).toBe('x');
  });

  it('listExecutions: 按 startedAt 倒序 + limit', async () => {
    for (let i = 0; i < 5; i++) {
      await markStarted(
        {
          runId: `run-${i}`,
          jobId: 'j3',
          jobName: 'n',
          scheduledFor: `2026-03-01T0${i}:00:00.000Z`,
          startedAt: `2026-03-01T0${i}:00:00.000Z`,
        },
        home,
      );
    }
    const all = await listExecutions({ home });
    expect(all).toHaveLength(5);
    expect(all[0].runId).toBe('run-4');
    expect(all[4].runId).toBe('run-0');
    expect((await listExecutions({ home, limit: 2 })).map((r) => r.runId)).toEqual(['run-4', 'run-3']);
    expect(await listExecutions({ jobId: 'nope', home })).toEqual([]);
  });

  it('文件超过 2000 行 → 截断保留最近 1000 行', async () => {
    const file = executionsPath(home);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < MAX_LINES + 5; i++) {
      lines.push(
        serializeExecution({
          runId: `old-${i}`,
          jobId: 'j9',
          jobName: 'n',
          scheduledFor: `2026-02-28T00:00:00.000Z`,
          startedAt: `2026-02-28T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
          status: 'ok',
          attempt: 1,
          ev: 'start',
        }),
      );
    }
    await fs.writeFile(file, lines.join('\n') + '\n', 'utf-8');

    await markStarted({ runId: 'fresh', jobId: 'j9', jobName: 'n', scheduledFor: '2026-03-01T00:00:00.000Z' }, home);
    const raw = await fs.readFile(file, 'utf-8');
    const lineCount = raw.split('\n').filter((l) => l.trim()).length;
    expect(lineCount).toBeLessThanOrEqual(KEEP_LINES + 1);
    expect(lineCount).toBeGreaterThanOrEqual(KEEP_LINES);
    expect(raw).toContain('"runId":"fresh"');
    // 老记录被丢掉, 最新一条还在
    const runs = await listExecutions({ home });
    expect(runs.some((r) => r.runId === 'fresh')).toBe(true);
    expect(runs.some((r) => r.runId === 'old-0')).toBe(false);
  });

  it('纯函数: parse / serialize / merge 容错', () => {
    expect(parseExecution('')).toBeNull();
    expect(parseExecution('{ broken')).toBeNull();
    expect(parseExecution('{"runId":"x"}')).toBeNull(); // 缺 jobId/status
    const rec = parseExecution('{"runId":"x","jobId":"j","status":"ok"}');
    expect(rec?.runId).toBe('x');
    expect(rec?.attempt).toBe(1); // 默认值
    const merged = mergeExecutions([
      '{"runId":"m","jobId":"j","jobName":"n","scheduledFor":"a","startedAt":"2026-03-01T00:00:00.000Z","status":"running","attempt":1,"ev":"start"}',
      '{"runId":"m","jobId":"j","status":"ok","durationMs":3,"finishedAt":"2026-03-01T00:00:02.000Z","attempt":1,"ev":"finish"}',
      '{ broken',
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].status).toBe('ok');
    expect(merged[0].durationMs).toBe(3);
    expect(merged[0].startedAt).toBe('2026-03-01T00:00:00.000Z');
  });
});


describe('jobs-store: 老文件兼容 + updateJob/resetFailures', () => {
  it('⑦ 读 version:1 老文件 (无新字段) → 补默认值, 不丢老字段', async () => {
    await fs.mkdir(path.join(home, '.bolloon'), { recursive: true });
    const legacy = {
      version: 1,
      jobs: [
        {
          id: 'old-1',
          name: '老任务',
          schedule: 'every 30m',
          prompt: '老 prompt',
          enabled: true,
          createdAt: '2026-01-01T00:00:00.000Z',
          lastRunAt: '2026-01-02T00:00:00.000Z',
          runCount: 3,
        },
      ],
    };
    await fs.writeFile(path.join(home, '.bolloon', 'cron-jobs.json'), JSON.stringify(legacy, null, 2), 'utf-8');

    const jobs = await listJobs(home);
    expect(jobs).toHaveLength(1);
    const j = jobs[0];
    expect(j.id).toBe('old-1');
    expect(j.name).toBe('老任务');
    expect(j.schedule).toBe('every 30m');
    expect(j.runCount).toBe(3);
    expect(j.lastRunAt).toBe('2026-01-02T00:00:00.000Z');
    // 新字段默认值
    expect(j.timeoutMs).toBe(600_000);
    expect(j.failureLimit).toBe(5);
    expect(j.continuousFailures).toBe(0);
    expect(j.lastStatus).toBeUndefined();
    expect(j.pausedReason).toBeUndefined();

    // 老文件还能被正常更新 (读-改-写)
    const updated = await updateJob('old-1', { lastStatus: 'ok', lastDurationMs: 12 }, home);
    expect(updated?.lastStatus).toBe('ok');
    expect(updated?.lastDurationMs).toBe(12);
    const re = (await listJobs(home))[0];
    expect(re.lastStatus).toBe('ok');
    expect(re.runCount).toBe(3); // 老字段没被抹掉
    expect(re.schedule).toBe('every 30m');
  });

  it('坏文件 / 空文件 → 空列表, 不抛异常', async () => {
    await fs.mkdir(path.join(home, '.bolloon'), { recursive: true });
    await fs.writeFile(path.join(home, '.bolloon', 'cron-jobs.json'), '{ 这不是 json', 'utf-8');
    expect(await listJobs(home)).toEqual([]);
    await fs.writeFile(path.join(home, '.bolloon', 'cron-jobs.json'), JSON.stringify({ version: 2, jobs: [] }), 'utf-8');
    expect(await listJobs(home)).toEqual([]);
  });

  it('updateJob: 显式 undefined 删除字段; 未知 id 返回 null', async () => {
    const job = await addJob({ name: 'x', schedule: '1m', prompt: 'p', timeoutMs: 1234, failureLimit: 3 }, home);
    expect((await listJobs(home))[0].timeoutMs).toBe(1234);
    expect((await listJobs(home))[0].failureLimit).toBe(3);

    await updateJob(job.id, { continuousFailures: 3, pausedReason: 'continuous-failure' }, home);
    let cur = (await listJobs(home)).find((j) => j.id === job.id)!;
    expect(cur.pausedReason).toBe('continuous-failure');

    await updateJob(job.id, { pausedReason: undefined }, home);
    cur = (await listJobs(home)).find((j) => j.id === job.id)!;
    expect(cur.pausedReason).toBeUndefined();
    expect(await updateJob('no-such-id', { name: 'x' }, home)).toBeNull();
  });

  it('resetFailures: 清零连续失败并解除熔断暂停', async () => {
    const job = await addJob({ name: 'y', schedule: '1m', prompt: 'p' }, home);
    await updateJob(
      job.id,
      { continuousFailures: 5, pausedReason: 'continuous-failure', lastError: 'boom', lastStatus: 'failed' },
      home,
    );
    const after = await resetFailures(job.id, home);
    expect(after?.continuousFailures).toBe(0);
    expect(after?.pausedReason).toBeUndefined();
    expect(after?.lastError).toBeUndefined();
    const re = (await listJobs(home)).find((j) => j.id === job.id)!;
    expect(re.continuousFailures).toBe(0);
    expect(re.pausedReason).toBeUndefined();
  });

  it('markRun 写 lastStatus/lastDurationMs; setEnabled 之外的老调用仍兼容', async () => {
    const job = await addJob({ name: 'z', schedule: '1m', prompt: 'p' }, home);
    await markRun(job.id, '2026-03-01T00:00:00.000Z', home, { status: 'timeout', durationMs: 77, error: 'too slow' });
    const cur = (await listJobs(home)).find((j) => j.id === job.id)!;
    expect(cur.runCount).toBe(1);
    expect(cur.lastRunAt).toBe('2026-03-01T00:00:00.000Z');
    expect(cur.lastStatus).toBe('timeout');
    expect(cur.lastDurationMs).toBe(77);
    expect(cur.lastError).toBe('too slow');
    // 旧签名 (3 参) 仍然可用, 默认 status='ok'
    const j2 = await addJob({ name: 'z2', schedule: '1m', prompt: 'p' }, home);
    await markRun(j2.id, '2026-03-01T00:00:00.000Z', home);
    expect((await listJobs(home)).find((j) => j.id === j2.id)!.lastStatus).toBe('ok');
  });
});

