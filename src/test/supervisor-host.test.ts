/**
 * supervisor-host 单测 (2026-09-16, 批次 2-C.1)
 *
 * 覆盖宿主分离的硬语义:
 *  - resolver 解析不出来 → 只诊断不执行, **Goal 状态一个字节都不改**, 也不产生新 Run
 *  - resolver 抛错 → 同样按解析失败处理 (不执行、不改状态)
 *  - 跨进程单 tick 互斥: 别人拿着 tick 锁 → 本轮让路 (不阻塞), 原因落宿主状态
 *  - 宿主身份/心跳落 ~/.bolloon/supervisor.json; 优雅停止写 stoppedAt/stopReason
 *  - once 模式只跑一个周期
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

let TMP = '';
const OLD_HOME = process.env.HOME;
const OLD_UP = process.env.USERPROFILE;

beforeEach(async () => {
  TMP = path.join(os.tmpdir(), `bolloon-host-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  await fs.mkdir(TMP, { recursive: true });
  process.env.HOME = TMP;
  process.env.USERPROFILE = TMP;
});

afterEach(async () => {
  process.env.HOME = OLD_HOME;
  process.env.USERPROFILE = OLD_UP;
  await fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

async function mods() {
  return {
    gs: await import('../agents/goal-store.js'),
    rs: await import('../agents/run-store.js'),
    sup: await import('../agents/execution-supervisor.js'),
    host: await import('../agents/supervisor-host.js'),
  };
}

describe('执行器解析 (runnerResolver)', () => {
  it('解析不出来 → 只诊断: 不执行、不建 Run、Goal 状态不变', async () => {
    const { gs, rs, sup } = await mods();
    const g = await gs.createGoal({ objective: '没人能执行的目标', channelId: 'ch-x' });
    await gs.updateGoal(g.goalId, { status: 'active' });
    const before = await gs.readGoal(g.goalId);

    let runnerCalled = 0;
    const s = new sup.ExecutionSupervisor({
      resolver: () => ({ ok: false, kind: 'none', reason: '测试: 没有可用执行器' }),
      maxPerTick: 5,
    });
    const rep = await s.tickOnce();
    void runnerCalled;

    expect(rep.executed.find((e) => e.goalId === g.goalId)?.status).toBe('unresolved');
    expect(rep.skipped.some((x) => x.goalId === g.goalId && x.reason.includes('无执行器'))).toBe(true);
    // 关键: 状态与 Run 列表都没动 (不能把"没人执行"当成"失败"或"完成")
    const after = await gs.readGoal(g.goalId);
    expect(after!.status).toBe(before!.status);
    expect(after!.runs.length).toBe(0);
    expect(after!.currentRunId).toBeUndefined();
    const runs = await rs.listRuns({ limit: 10 });
    expect(runs.filter((r) => r.goalId === g.goalId).length).toBe(0);
  });

  it('resolver 抛错 → 按解析失败处理 (不执行、不改状态)', async () => {
    const { gs, sup } = await mods();
    const g = await gs.createGoal({ objective: 'resolver 抛错', channelId: 'ch-x' });
    await gs.updateGoal(g.goalId, { status: 'active' });
    const s = new sup.ExecutionSupervisor({
      resolver: () => { throw new Error('boom'); },
      maxPerTick: 5,
    });
    const rep = await s.tickOnce();
    const entry = rep.executed.find((e) => e.goalId === g.goalId);
    expect(entry?.status).toBe('unresolved');
    expect(String(entry?.error)).toContain('resolver 抛错');
    expect((await gs.readGoal(g.goalId))!.runs.length).toBe(0);
  });

  it('resolver 给出 runner → 正常执行并按 reducer 决策', async () => {
    const { gs, rs, sup } = await mods();
    const g = await gs.createGoal({ objective: '能执行的目标', channelId: 'ch-x' });
    await gs.updateGoal(g.goalId, { status: 'active' });
    const s = new sup.ExecutionSupervisor({
      resolver: () => ({
        ok: true, kind: 'fake',
        runner: async (req) => {
          const rec = await rs.startRun({ channelId: 'ch-x', goalId: req.goal.goalId, goal: req.goal.objective });
          await rs.recordStep(rec.runId, { tool: 'read_file', ok: true, summary: '读了 X' });
          await rs.finishRun(rec.runId, { status: 'done', summary: '一段完成' });
          await gs.attachRun(req.goal.goalId, rec.runId);
          return { runId: rec.runId, status: 'done' };
        },
      }),
      maxPerTick: 5,
    });
    const rep = await s.tickOnce();
    const entry = rep.executed.find((e) => e.goalId === g.goalId);
    expect(entry?.status).toBe('done');
    const after = await gs.readGoal(g.goalId);
    expect(after!.runs.length).toBe(1);
    expect(after!.status).toBe('active');     // 判据未声明 → 不许自动完成
    expect(after!.continuation?.lastRunId).toBe(entry!.runId);
  });
});

describe('宿主: tick 互斥 · 状态落盘 · 优雅停止', () => {
  it('别人持有 tick 锁 → 本轮让路 (不执行), 原因写进宿主状态', async () => {
    const { gs, sup, host } = await mods();
    const g = await gs.createGoal({ objective: '被锁挡住的目标', channelId: 'ch-x' });
    await gs.updateGoal(g.goalId, { status: 'active' });
    // 手工写一把"活锁" (pid 用本进程 → 不会被判陈旧)
    const lockPath = host.supervisorTickLockPath(TMP);
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, host: 'test', startedAt: new Date().toISOString(), tickId: 'held-by-someone' }));

    let executed = 0;
    const s = new sup.ExecutionSupervisor({ runner: (async () => { executed++; return { status: 'done' }; }) as any, maxPerTick: 5 });
    await host.runSupervisorHost({
      supervisor: s as any, mode: 'once', home: TMP, log: () => {},
    });
    expect(executed).toBe(0);
    const st = await host.readSupervisorState(TMP);
    expect(String(st?.lastSummary)).toContain('让路');
  });

  it('宿主身份/心跳落盘, 优雅停止写 stoppedAt/stopReason', async () => {
    const { sup, host } = await mods();
    const s = new sup.ExecutionSupervisor({ runner: (async () => ({ status: 'done' })) as any });
    const h = await host.runSupervisorHost({
      supervisor: s as any, mode: 'interval', tickIntervalMs: 60_000, home: TMP, log: () => {},
    });
    const started = await host.readSupervisorState(TMP);
    expect(started?.pid).toBe(process.pid);
    expect(started?.owner).toBe(s.owner);
    expect(started?.workerId).toBeTruthy();
    expect(started?.runnerKind).toBe('injected');
    expect(started?.dryRun).toBe(false);
    expect(started?.stoppedAt).toBeUndefined();      // 还没停: 没有"好好停"的标记

    await h.stop('test');
    const stopped = await host.readSupervisorState(TMP);
    expect(stopped?.stoppedAt).toBeTruthy();
    expect(stopped?.stopReason).toBe('test');
    expect(stopped?.ticks).toBeGreaterThanOrEqual(1);  // 启动即跑一轮
  });

  it('once 模式只跑一个周期并落盘 (便于验收/CI)', async () => {
    const { sup, host } = await mods();
    let ticks = 0;
    const s = new sup.ExecutionSupervisor({ runner: (async () => { ticks++; return { status: 'done' }; }) as any });
    const res = await host.runStandaloneSupervisorHost({ once: true, dryRun: true, home: TMP, log: () => {} });
    expect(res.ticks).toBe(1);
    expect(res.state.stoppedAt).toBeTruthy();
    expect(res.state.stopReason).toBe('once');
    expect(ticks).toBe(0);                            // dry-run 不执行
  });

  it('独立宿主的本地解析器: 没有 channelId → ok:false (只诊断, 卡在 resolve_agent)', async () => {
    const { host, gs } = await mods();
    // 用真 Goal (2-C.2 起解析第一阶段会校验 Goal 确实存在)
    const g = await gs.createGoal({ objective: '没有 channel 的目标' });
    const r = host.createLocalAgentResolver({ createAgent: () => ({}) as any });
    const res: any = await r({ goal: g, kind: 'first_run', instruction: 'x', guards: [] } as any);
    expect(res.ok).toBe(false);
    expect(res.failedStage).toBe('resolve_agent');
    expect(String(res.reason)).toContain('channelId');
  });

  it('独立宿主的本地解析器: 显式关闭 → ok:false (不偷偷执行)', async () => {
    const { host, gs } = await mods();
    const g = await gs.createGoal({ objective: 'x', channelId: 'ch-1' });
    const r = host.createLocalAgentResolver({ allow: false, createAgent: () => ({}) as any });
    const res: any = await r({ goal: g, kind: 'first_run', instruction: 'x', guards: [] } as any);
    expect(res.ok).toBe(false);
    expect(String(res.reason)).toContain('关闭');
  });
});
