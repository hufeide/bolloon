/**
 * ExecutionSupervisor + Goal lease 单测 (2026-09-16, M2-A/M2-B)
 *
 * 覆盖:
 *  - lease 原子性 (claim 排他 / 归还 / 续租 / 被接管后旧 worker 不能再写)
 *  - TTL 过期与"持有者进程已死"回收
 *  - 唤醒表 (2-C): 哪些状态可自动推进, 哪些必须等人/等事件
 *  - Goal 决策 reducer (2-D): Run done ≠ Goal completed, 预算中止继续, 崩溃→recovering, 熔断→needs_human
 *  - Supervisor tick 的排他性 (两个实例同时 tick, 只有一个认领) 与 dry-run 诚实性
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
  TMP = path.join(os.tmpdir(), `bolloon-sup-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  await fs.mkdir(TMP, { recursive: true });
  process.env.HOME = TMP;
  process.env.USERPROFILE = TMP;
  process.env.BOLLOON_RUN_PERSIST = 'strict';
});

afterEach(async () => {
  process.env.HOME = OLD_HOME;
  process.env.USERPROFILE = OLD_UP;
  await fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

async function fresh() {
  const gs = await import('../agents/goal-store.js');
  const rs = await import('../agents/run-store.js');
  const sup = await import('../agents/execution-supervisor.js');
  return { gs, rs, sup };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('Goal lease — 执行权排他 (2-B)', () => {
  it('第一个认领成功, 第二个被拒 (同进程也不会双跑)', async () => {
    const { gs } = await fresh();
    const g = await gs.createGoal({ objective: 'lease 测试' });
    const a = await gs.claimGoal(g.goalId, { owner: 'worker-A' });
    expect(a.ok).toBe(true);
    const b = await gs.claimGoal(g.goalId, { owner: 'worker-B' });
    expect(b.ok).toBe(false);
    expect(b.holder?.owner).toBe('worker-A');
    expect(b.reason).toContain('lease 被占用');
  });

  it('归还后别人才能认领; 归还者不能再续租', async () => {
    const { gs } = await fresh();
    const g = await gs.createGoal({ objective: 'lease 归还' });
    const a = await gs.claimGoal(g.goalId, { owner: 'A' });
    const rel = await gs.releaseGoal(g.goalId, a.lease!.leaseId);
    expect(rel.ok).toBe(true);
    const b = await gs.claimGoal(g.goalId, { owner: 'B' });
    expect(b.ok).toBe(true);
    // A 拿着旧 leaseId 续租 → 必须失败 (被接管后不能再写)
    const hb = await gs.heartbeatGoal(g.goalId, a.lease!.leaseId);
    expect(hb.ok).toBe(false);
    expect(hb.reason).toContain('已被接管');
    // 也不能释放别人的锁
    const relWrong = await gs.releaseGoal(g.goalId, a.lease!.leaseId);
    expect(relWrong.ok).toBe(false);
    expect((await gs.readLease(g.goalId))?.owner).toBe('B');
  });

  it('TTL 过期 → 可回收 (worker 崩溃后无需人工清锁)', async () => {
    const { gs } = await fresh();
    const g = await gs.createGoal({ objective: 'lease 过期' });
    const now = Date.now();
    // 手工写一把"活锁但马上要过期"的 lease (pid 用本进程, 排除死进程回收路径)
    const leaseFile = path.join(TMP, '.bolloon', 'goals', `${g.goalId}.lease`);
    await fs.writeFile(leaseFile, JSON.stringify({
      owner: 'zombie', leaseId: 'z-1', claimedAt: new Date(now - 10_000).toISOString(),
      lastHeartbeat: new Date(now - 10_000).toISOString(), leaseUntil: new Date(now + 60_000).toISOString(),
      pid: process.pid, host: 'test',
    }));
    // 未到期的活锁 → 拒
    const notYet = await gs.claimGoal(g.goalId, { owner: 'B', now });
    expect(notYet.ok).toBe(false);
    // 过期后 → 可抢
    const after = await gs.claimGoal(g.goalId, { owner: 'B', now: now + 61_000 });
    expect(after.ok).toBe(true);
    expect(after.lease!.owner).toBe('B');
  });

  it('持有者进程已死 → 更早回收 (不必等满 TTL)', async () => {
    const { gs } = await fresh();
    const g = await gs.createGoal({ objective: 'lease 死进程' });
    const now = Date.now();
    const leaseFile = path.join(TMP, '.bolloon', 'goals', `${g.goalId}.lease`);
    await fs.writeFile(leaseFile, JSON.stringify({
      owner: 'dead', leaseId: 'd-1', claimedAt: new Date(now).toISOString(),
      lastHeartbeat: new Date(now).toISOString(), leaseUntil: new Date(now + 60_000).toISOString(),
      pid: 999_999, host: 'test',   // 不存在的 pid
    }));
    const r = await gs.claimGoal(g.goalId, { owner: 'B', now });
    expect(r.ok).toBe(true);
    expect(r.lease!.owner).toBe('B');
  });

  it('续租会延长 leaseUntil (长任务不会因为跑太久丢锁)', async () => {
    const { gs } = await fresh();
    const g = await gs.createGoal({ objective: 'lease 续租' });
    const now = Date.now();
    const a = await gs.claimGoal(g.goalId, { owner: 'A', ttlMs: 10_000, now });
    const hb = await gs.heartbeatGoal(g.goalId, a.lease!.leaseId, 10_000, now + 5000);
    expect(hb.ok).toBe(true);
    expect(Date.parse(hb.lease!.leaseUntil)).toBe(now + 15_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('唤醒表 (2-C) — 谁能自动跑, 谁必须等人', () => {
  async function mk(status: any, continuation?: any) {
    const { gs } = await fresh();
    const g = await gs.createGoal({ objective: `wake-${status}` });
    await gs.updateGoal(g.goalId, { status });
    if (continuation) await gs.setContinuation(g.goalId, continuation);
    return g.goalId;
  }

  it('active/recovering → 可推进', async () => {
    const { gs } = await fresh();
    const a = await mk('active');
    const r = await mk('recovering');
    const { runnable } = await gs.listRunnableGoals({ now: Date.now() });
    const ids = runnable.map((g) => g.goalId);
    expect(ids).toContain(a);
    expect(ids).toContain(r);
  });

  it('paused / needs_human / awaiting_external / completed → 绝不自动推进', async () => {
    const { gs } = await fresh();
    const p = await mk('paused');
    const n = await mk('needs_human', { autoContinue: false, wakeReason: 'needs_human' });
    const e = await mk('awaiting_external', { autoContinue: true, wakeReason: 'awaiting_external', needsExternal: 'peer 回复' });
    const c = await mk('completed');
    const { runnable, skipped } = await gs.listRunnableGoals({ now: Date.now() });
    const ids = runnable.map((g) => g.goalId);
    for (const id of [p, n, e, c]) expect(ids).not.toContain(id);
    // 跳过原因必须写清 (不静默)
    expect(skipped.find((s) => s.goalId === p)?.reason).toContain('paused');
    expect(skipped.find((s) => s.goalId === n)?.reason).toContain('needs_human');
    expect(skipped.find((s) => s.goalId === e)?.reason).toContain('awaiting_external');
  });

  it('retry_wait: 时间未到不跑, 到了才跑', async () => {
    const { gs } = await fresh();
    const now = Date.now();
    const future = await mk('retry_wait', { autoContinue: true, wakeReason: 'retry_wait', wakeAt: new Date(now + 60_000).toISOString() });
    const past = await mk('retry_wait', { autoContinue: true, wakeReason: 'retry_wait', wakeAt: new Date(now - 1000).toISOString() });
    const r1 = await gs.listRunnableGoals({ now });
    expect(r1.runnable.map((g) => g.goalId)).not.toContain(future);
    expect(r1.runnable.map((g) => g.goalId)).toContain(past);
  });

  it('被活租约持有的 Goal 不会被再次认领', async () => {
    const { gs } = await fresh();
    const id = await mk('active');
    await gs.claimGoal(id, { owner: 'some-worker', ttlMs: 60_000 });
    const { runnable, skipped } = await gs.listRunnableGoals({ now: Date.now() });
    expect(runnable.map((g) => g.goalId)).not.toContain(id);
    expect(skipped.find((s) => s.goalId === id)?.reason).toContain('lease');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Goal 决策 reducer (2-D) — Run done ≠ Goal completed', () => {
  async function goalWithCriteria() {
    const { gs } = await fresh();
    return gs.createGoal({ objective: 'reducer 测试', successCriteria: ['产出文件 X', '验证通过'] });
  }
  const fakeRun = (over: any = {}) => ({
    runId: 'run-x', goalId: 'g1', status: 'done', steps: [], checkpoint: { nextAction: '收尾' },
    ...over,
  }) as any;

  it('Run done + 判据未满足 → Goal 仍 active (不许装完成)', async () => {
    const { sup } = await fresh();
    const g = await goalWithCriteria();
    const d = sup.decideGoalOutcome(g, fakeRun());
    expect(d.goalStatus).toBe('active');
    expect(d.reason).toContain('未达成');
  });

  it('Run done + 判据全满足 → completed (唯一出口)', async () => {
    const { sup, gs } = await fresh();
    const g = await goalWithCriteria();
    await gs.markCriterion(g.goalId, 0, true, '文件已产出');
    await gs.markCriterion(g.goalId, 1, true, '验证通过');
    const fresh2 = await gs.readGoal(g.goalId);
    const d = sup.decideGoalOutcome(fresh2!, fakeRun());
    expect(d.goalStatus).toBe('completed');
  });

  it('预算中止 (aborted) → Goal 保持 active, 交给下一个 Run (目标不失败)', async () => {
    const { sup } = await fresh();
    const g = await goalWithCriteria();
    const d = sup.decideGoalOutcome(g, fakeRun({ status: 'aborted', errorClass: 'budget', error: '步数超限' }));
    expect(d.goalStatus).toBe('active');
    expect(d.continuation.autoContinue).toBe(true);
  });

  it('崩溃 (interrupted) → recovering', async () => {
    const { sup } = await fresh();
    const g = await goalWithCriteria();
    const d = sup.decideGoalOutcome(g, fakeRun({ status: 'interrupted' }));
    expect(d.goalStatus).toBe('recovering');
  });

  it('外部无响应 → awaiting_external (不是 failed)', async () => {
    const { sup } = await fresh();
    const g = await goalWithCriteria();
    const d = sup.decideGoalOutcome(g, fakeRun({ status: 'awaiting_external', error: 'peer 超时' }));
    expect(d.goalStatus).toBe('awaiting_external');
    expect(d.continuation.needsExternal).toContain('peer');
  });

  it('可恢复错误 → retry_wait + wakeAt (退避)', async () => {
    const { sup } = await fresh();
    const g = await goalWithCriteria();
    const t0 = Date.parse('2026-09-16T00:00:00Z');
    const d = sup.decideGoalOutcome(g, fakeRun({ status: 'failed', errorClass: 'transient' }), { now: t0 });
    expect(d.goalStatus).toBe('retry_wait');
    expect(Date.parse(d.continuation.wakeAt!)).toBe(t0 + sup.continuationBackoffMs(0));
  });

  it('熔断/鉴权类 → needs_human 且 autoContinue=false', async () => {
    const { sup } = await fresh();
    const g = await goalWithCriteria();
    for (const cls of ['repeat_failure', 'auth']) {
      const d = sup.decideGoalOutcome(g, fakeRun({ status: 'failed', errorClass: cls }));
      expect(d.goalStatus).toBe('needs_human');
      expect(d.continuation.autoContinue).toBe(false);
    }
  });

  it('尝试次数超上限 → needs_human (不让它无限自动续跑)', async () => {
    const { sup } = await fresh();
    const g = await goalWithCriteria();
    const withAttempts = { ...g, continuation: { autoContinue: true, attempts: 5 } };
    const d = sup.decideGoalOutcome(withAttempts as any, fakeRun({ status: 'failed', errorClass: 'transient' }));
    expect(d.goalStatus).toBe('needs_human');
  });

  it('人定的 paused 优先, 不被自动决策覆盖', async () => {
    const { sup } = await fresh();
    const g = await goalWithCriteria();
    const d = sup.decideGoalOutcome(g, fakeRun({ status: 'paused' }));
    expect(d.goalStatus).toBe('paused');
    expect(d.continuation.autoContinue).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('ExecutionSupervisor — 调度周期', () => {
  it('dry-run (无 runner): 不执行, report 如实标 dryRun', async () => {
    const { sup, gs } = await fresh();
    await gs.createGoal({ objective: 'dry-run 目标', status: 'active' } as any);
    const s = new sup.ExecutionSupervisor({ maxPerTick: 3 });
    const rep = await s.tickOnce();
    expect(rep.dryRun).toBe(true);
    expect(rep.executed[0]?.status).toBe('dry_run');
    expect(rep.errors.length).toBe(0);
  });

  it('注入 runner: 执行后按 reducer 落 Goal 状态 + 写 continuation', async () => {
    const { sup, gs, rs } = await fresh();
    const g = await gs.createGoal({ objective: '真执行一次', successCriteria: ['做完'] });
    await gs.updateGoal(g.goalId, { status: 'active' });
    const runner = async (req: any) => {
      // 模拟 agent: 建一条 done 的 run 并挂上 Goal
      const rec = await rs.startRun({ channelId: 'ch-1', goalId: req.goal.goalId, goal: req.goal.objective });
      await rs.recordStep(rec.runId, { tool: 'read_file', ok: true, summary: '读了 X' });
      await rs.finishRun(rec.runId, { status: 'done', summary: '第一段完成' });
      await gs.attachRun(req.goal.goalId, rec.runId);
      return { runId: rec.runId, status: 'done' };
    };
    const s = new sup.ExecutionSupervisor({ runner, maxPerTick: 1 });
    const rep = await s.tickOnce();
    expect(rep.claimed).toContain(g.goalId);
    expect(rep.executed[0]?.status).toBe('done');
    const after = await gs.readGoal(g.goalId);
    expect(after!.currentRunId).toBe(rep.executed[0].runId);
    // Run done 但判据没满足 → Goal 仍 active, 且被安排继续
    expect(after!.status).toBe('active');
    expect(after!.continuation?.lastRunId).toBe(rep.executed[0].runId);
    // 证据同步到 Goal
    expect(after!.evidence.join(' ')).toContain('read_file');
    // lease 必须归还 (不能自己锁死自己)
    expect(await gs.readLease(g.goalId)).toBeNull();
  });

  it('两个 supervisor 同时 tick: 只有一个认领, 另一个如实报告 lease 占用', async () => {
    const { sup, gs } = await fresh();
    const g = await gs.createGoal({ objective: '抢占测试' });
    await gs.updateGoal(g.goalId, { status: 'active' });
    let started = 0;
    const slowRunner = async () => {
      started++;
      await new Promise((r) => setTimeout(r, 150));
      return { status: 'done' as const };
    };
    const s1 = new sup.ExecutionSupervisor({ runner: slowRunner as any, owner: 'w1', maxPerTick: 1 });
    const s2 = new sup.ExecutionSupervisor({ runner: slowRunner as any, owner: 'w2', maxPerTick: 1 });
    const [r1, r2] = await Promise.all([s1.tickOnce(), s2.tickOnce()]);
    expect(started).toBe(1);
    const claimedTotal = r1.claimed.length + r2.claimed.length;
    expect(claimedTotal).toBe(1);
    const loser = r1.claimed.length ? r2 : r1;
    expect(loser.skipped.some((s) => /lease|claim|乐观并发/.test(s.reason))).toBe(true);
  });

  it('乐观并发: 快照被别的 worker 推进过 → 本周期让路, 不重复跑同一状态版本', async () => {
    const { sup, gs } = await fresh();
    const A = await gs.createGoal({ objective: 'A (先跑)', channelId: 'ch-1' });
    await gs.updateGoal(A.goalId, { status: 'active' });
    await new Promise((r) => setTimeout(r, 15));   // 让 A 的 updatedAt 更早 → 排序在前面
    const B = await gs.createGoal({ objective: 'B (会被别人动)', channelId: 'ch-1' });
    await gs.updateGoal(B.goalId, { status: 'active' });
    const executed: string[] = [];
    const s = new sup.ExecutionSupervisor({
      maxPerTick: 5,
      runner: (async (req: any) => {
        executed.push(req.goal.goalId);
        // 模拟"另一个 worker 在 A 执行期间推进了 B"
        await gs.setContinuation(req.goal.goalId === A.goalId ? B.goalId : A.goalId, { wakeReason: 'stalled' });
        return { status: 'done' };
      }) as any,
    });
    const rep = await s.tickOnce();
    expect(executed).toContain(A.goalId);
    expect(executed).not.toContain(B.goalId);            // B 的快照已过期 → 让路
    expect(rep.skipped.some((x) => x.goalId === B.goalId && /乐观并发/.test(x.reason))).toBe(true);
  });

  it('awaiting_external 的 Goal: tick 不会自动重跑 (等事件)', async () => {
    const { sup, gs } = await fresh();
    const g = await gs.createGoal({ objective: '等外部事件' });
    await gs.updateGoal(g.goalId, { status: 'awaiting_external' });
    await gs.setContinuation(g.goalId, { autoContinue: true, wakeReason: 'awaiting_external', needsExternal: 'peer 回复' });
    let ran = 0;
    const s = new sup.ExecutionSupervisor({ runner: (async () => { ran++; return { status: 'done' }; }) as any });
    const rep = await s.tickOnce();
    expect(ran).toBe(0);
    expect(rep.claimed.length).toBe(0);
  });

  it('外部事件到达 → notifyExternal 唤醒 (状态转 active, 下次 tick 才跑)', async () => {
    const { sup, gs } = await fresh();
    const g = await gs.createGoal({ objective: '事件唤醒' });
    await gs.updateGoal(g.goalId, { status: 'awaiting_external' });
    await gs.setContinuation(g.goalId, { autoContinue: true, wakeReason: 'awaiting_external', needsExternal: 'peer 回复' });
    const s = new sup.ExecutionSupervisor({});
    expect(await s.notifyExternal(g.goalId)).toBe(true);
    const after = await gs.readGoal(g.goalId);
    expect(after!.continuation?.wakeReason).toBe('active');
    expect(after!.continuation?.needsExternal).toBeUndefined();
    // 不在等外部事件的 Goal → 不误唤醒
    const g2 = await gs.createGoal({ objective: '普通目标' });
    expect(await s.notifyExternal(g2.goalId)).toBe(false);
  });
});
