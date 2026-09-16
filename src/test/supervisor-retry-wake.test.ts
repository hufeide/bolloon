/**
 * supervisor-retry-wake 单测 (2026-09-16, 批次 2-C.3)
 *
 * retry_wait 的**真自动唤醒**语义 (全部走真 Supervisor tick + 真 Goal/Run 落盘, 不直接调 reducer):
 *  - 未来 wakeAt → tick 跳过, 且 wakeReport 说清"还剩多久、已自动继续几次"
 *  - 到点 → tick 自动认领并开新 Run, 旧 wakeAt/wakeReason 被清掉
 *  - 退避序列真实生效 (0 → 15s → 60s → 5min)
 *  - 第 3 次失败 → needs_human (autoContinue=false), 不再自动续跑
 *  - 成功一次 → 自动继续计数清零
 *  - **重启后仍认旧 wakeAt** (新 supervisor 实例 = 新进程; 只读盘上的事实)
 *  - 到点唤醒不需要 /wake, 也不需要人工 tick
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
  TMP = path.join(os.tmpdir(), `bolloon-rw-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  await fs.mkdir(TMP, { recursive: true });
  process.env.HOME = TMP;
  process.env.USERPROFILE = TMP;
  delete process.env.BOLLOON_GOAL_MAX_RETRIES;
});

afterEach(async () => {
  process.env.HOME = OLD_HOME;
  process.env.USERPROFILE = OLD_UP;
  delete process.env.BOLLOON_GOAL_MAX_RETRIES;
  await fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

async function mods() {
  return {
    gs: await import('../agents/goal-store.js'),
    rs: await import('../agents/run-store.js'),
    sup: await import('../agents/execution-supervisor.js'),
  };
}

/** 一个"这次执行失败 (transient)"的 runner: 真落 Run 事实, 不用假数据 */
function failingRunner(rs: any, gs: any, err = '网络抖动 (ECONNRESET)') {
  return (async (req: any) => {
    const rec = await rs.startRun({ channelId: 'ch-rw', goalId: req.goal.goalId, goal: req.goal.objective });
    await rs.recordStep(rec.runId, { tool: 'shell_exec', ok: false, error: err });
    await rs.finishRun(rec.runId, { status: 'failed', error: err });
    await gs.attachRun(req.goal.goalId, rec.runId);
    return { runId: rec.runId, status: 'failed' };
  }) as any;
}

function okRunner(rs: any, gs: any) {
  return (async (req: any) => {
    const rec = await rs.startRun({ channelId: 'ch-rw', goalId: req.goal.goalId, goal: req.goal.objective });
    await rs.recordStep(rec.runId, { tool: 'read_file', ok: true, summary: '读了 X' });
    await rs.finishRun(rec.runId, { status: 'done', summary: '一段完成' });
    await gs.attachRun(req.goal.goalId, rec.runId);
    return { runId: rec.runId, status: 'done' };
  }) as any;
}

/** 造一条"刚失败、已进入 retry_wait"的事实 (等价于上一轮执行的结果) */
async function seedFailed(gs: any, rs: any, opts: { attempts?: number; wakeAt?: string; err?: string } = {}) {
  const g = await gs.createGoal({ objective: 'retry_wake 目标', channelId: 'ch-rw', successCriteria: [] });
  await gs.updateGoal(g.goalId, { status: 'retry_wait' });
  const err = opts.err ?? '网络抖动 (ECONNRESET)';
  const rec = await rs.startRun({ channelId: 'ch-rw', goalId: g.goalId, goal: g.objective });
  await rs.recordStep(rec.runId, { tool: 'shell_exec', ok: false, error: err });
  await rs.finishRun(rec.runId, { status: 'failed', error: err });
  await gs.attachRun(g.goalId, rec.runId);
  await gs.setContinuation(g.goalId, {
    autoContinue: true, wakeReason: 'retry_wait',
    wakeAt: opts.wakeAt ?? new Date(Date.now() + 60_000).toISOString(),
    attempts: opts.attempts ?? 1,
  });
  return { goalId: g.goalId, runId: rec.runId };
}

describe('retry_wait: 未到点不执行, 到点自动执行', () => {
  it('未来 wakeAt → tick 跳过 (不需要人工判断), wakeReport 说清还剩多久与已继续次数', async () => {
    const { gs, rs, sup } = await mods();
    const { goalId } = await seedFailed(gs, rs, { wakeAt: new Date(Date.now() + 600_000).toISOString(), attempts: 1 });
    let ran = 0;
    const s = new sup.ExecutionSupervisor({ runner: (async () => { ran++; return { status: 'done' }; }) as any, maxPerTick: 5 });
    const rep = await s.tickOnce();
    expect(ran).toBe(0);
    expect(rep.claimed.length).toBe(0);
    expect(rep.skipped.some((x) => x.goalId === goalId && /retry_wait|等时间/.test(x.reason))).toBe(true);
    const row = (await gs.wakeReport()).find((r) => r.goalId === goalId)!;
    expect(row.wake).toContain('还剩');
    expect(row.wake).toContain('已自动继续 1 次');
  });

  it('到点 → 同一次 tick 自动认领并开新 Run; 旧 wakeAt/wakeReason 被清掉', async () => {
    const { gs, rs, sup } = await mods();
    const { goalId, runId: firstRun } = await seedFailed(gs, rs, { wakeAt: new Date(Date.now() - 1000).toISOString() });
    const s = new sup.ExecutionSupervisor({ runner: okRunner(rs, gs), maxPerTick: 5 });
    const rep = await s.tickOnce();
    expect(rep.claimed).toContain(goalId);
    const entry = rep.executed.find((e) => e.goalId === goalId)!;
    expect(entry.status).toBe('done');
    expect(rep.skipped.some((x) => /到点唤醒/.test(x.reason))).toBe(true);
    const after = await gs.readGoal(goalId);
    expect(after!.runs).toContain(firstRun);
    expect(after!.runs.length).toBe(2);                       // 自动开了新 Run (同 Goal)
    expect(after!.continuation?.wakeAt).toBeUndefined();      // 旧等待事实被清掉
    expect(after!.continuation?.wakeReason).toBe('active');
    expect(after!.continuation?.attempts).toBe(0);            // 这次成功 → 计数清零
  });

  it('**重启** (新 supervisor 实例) 仍认盘上的旧 wakeAt: 未到不跑, 到点才跑', async () => {
    const { gs, rs, sup } = await mods();
    const due = Date.now() + 5000;
    const { goalId } = await seedFailed(gs, rs, { wakeAt: new Date(due).toISOString(), attempts: 2 });
    // 第一次"进程": 只有盘上的事实, 未到点 → 不跑 (用假时钟代表"现在")
    const before = new sup.ExecutionSupervisor({ runner: (async () => ({ status: 'done' })) as any, maxPerTick: 5, now: () => due - 3000 });
    expect((await before.tickOnce()).claimed.length).toBe(0);
    // "重启"后的新实例: 只读盘上的 wakeAt, 时钟过了点 → 自动跑 (没有人工 /wake)
    const after = new sup.ExecutionSupervisor({ runner: okRunner(rs, gs), maxPerTick: 5, now: () => due + 1000 });
    const rep = await after.tickOnce();
    expect(rep.claimed).toContain(goalId);
    expect((await gs.readGoal(goalId))!.runs.length).toBe(2);
  });
});

describe('retry_wait: 退避序列与阈值', () => {
  it('首次失败立即重试, 之后按 0/15s/60s/5min 退避 (真实时间戳差值)', async () => {
    const { gs, rs, sup } = await mods();
    const backoff = sup.continuationBackoffMs;
    expect([0, 1, 2, 3, 4, 5].map(backoff)).toEqual([0, 15_000, 60_000, 300_000, 900_000, 900_000]);

    // 用假时钟走完整序列: 每次失败 → 读 wakeAt → 推进时钟到点 → 再跑
    let clock = Date.parse('2026-09-16T00:00:00Z');
    const goal = await gs.createGoal({ objective: '退避序列', channelId: 'ch-rw' });
    await gs.updateGoal(goal.goalId, { status: 'active' });
    const s = new sup.ExecutionSupervisor({ runner: failingRunner(rs, gs), maxPerTick: 5, now: () => clock, maxRetries: 5 });
    const waits: number[] = [];
    for (let i = 0; i < 3; i++) {
      await s.tickOnce();
      const g = await gs.readGoal(goal.goalId);
      expect(g!.status).toBe('retry_wait');
      const w = Date.parse(g!.continuation!.wakeAt!);
      waits.push(w - clock);
      clock = w;                                             // 到点
      if (i === 2) break;
      await gs.updateGoal(goal.goalId, { status: 'retry_wait' });
    }
    expect(waits).toEqual([0, 15_000, 60_000]);
    const final = await gs.readGoal(goal.goalId);
    expect(final!.continuation!.attempts).toBe(3);
    expect(final!.runs.length).toBe(3);                      // 三次失败 = 三条 Run 事实
  });

  it('连续失败达到阈值 (默认自动继续 2 次) → 第 3 次失败进 needs_human, 不再自动跑', async () => {
    const { gs, rs, sup } = await mods();
    let clock = Date.now();
    const goal = await gs.createGoal({ objective: '阈值', channelId: 'ch-rw' });
    await gs.updateGoal(goal.goalId, { status: 'active' });
    const s = new sup.ExecutionSupervisor({ runner: failingRunner(rs, gs), maxPerTick: 5, now: () => clock });
    for (let i = 0; i < 3; i++) {
      await s.tickOnce();
      const g = await gs.readGoal(goal.goalId);
      if (g!.continuation?.wakeAt) clock = Date.parse(g!.continuation.wakeAt);
      if (i < 2) await gs.updateGoal(goal.goalId, { status: 'retry_wait' });
    }
    const after = await gs.readGoal(goal.goalId);
    expect(after!.status).toBe('needs_human');
    expect(after!.continuation!.autoContinue).toBe(false);
    expect(after!.runs.length).toBe(3);
    // 再 tick 也不跑 (等人 approve)
    let ran = 0;
    const s2 = new sup.ExecutionSupervisor({ runner: (async () => { ran++; return { status: 'done' }; }) as any, maxPerTick: 5 });
    await s2.tickOnce();
    expect(ran).toBe(0);
    expect((await gs.wakeReport()).find((r) => r.goalId === goal.goalId)!.wake).toContain('等人');
  });

  it('maxRetries 可通过 env 调整 (BOLLOON_GOAL_MAX_RETRIES=0 → 首次失败就交人工)', async () => {
    const { gs, rs, sup } = await mods();
    process.env.BOLLOON_GOAL_MAX_RETRIES = '0';
    const goal = await gs.createGoal({ objective: '不自动续跑', channelId: 'ch-rw' });
    await gs.updateGoal(goal.goalId, { status: 'active' });
    const s = new sup.ExecutionSupervisor({ runner: failingRunner(rs, gs), maxPerTick: 5 });
    await s.tickOnce();
    const after = await gs.readGoal(goal.goalId);
    expect(after!.status).toBe('needs_human');
    delete process.env.BOLLOON_GOAL_MAX_RETRIES;
  });

  it('非可恢复错误 (auth) 不进退避: 直接 needs_human', async () => {
    const { gs, rs, sup } = await mods();
    const goal = await gs.createGoal({ objective: 'auth 失败', channelId: 'ch-rw' });
    await gs.updateGoal(goal.goalId, { status: 'active' });
    const s = new sup.ExecutionSupervisor({ runner: failingRunner(rs, gs, '鉴权失败 401 Unauthorized'), maxPerTick: 5 });
    await s.tickOnce();
    const after = await gs.readGoal(goal.goalId);
    expect(after!.status).toBe('needs_human');
    expect(after!.continuation!.wakeAt).toBeUndefined();
  });
});
