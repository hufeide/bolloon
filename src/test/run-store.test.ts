/**
 * run-store.test.ts — 持久化 run harness 单测 (2026-09-16 Milestone 1)
 *
 * 覆盖 leo 点名的六项:
 *   ① 状态机 + 非法迁移拒绝
 *   ② 错误分类 (含 persist_failed)
 *   ③ checkpoint 原子性 (每步自动写, 写前不破坏旧内容)
 *   ④ 并发写入不覆盖步骤 (锁)
 *   ⑤ 文件损坏 → 回退最后有效备份 (.bak) + 记数据修复事件
 *   ⑥ 核心写失败 → strict 抛 RunPersistenceError (调用方必须停) / degraded 只降级留痕
 *   另加: 预算闸门 / recovery 留痕 / 陈旧锁回收 / 降级日志 / 对账与失速巡检
 *
 * 隔离 HOME: 全部记录写在临时目录, 不碰真 ~/.bolloon。
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

const tmpHome = path.join(os.tmpdir(), 'bolloon-runstore-' + Date.now());
const RUNS = path.join(tmpHome, '.bolloon', 'runs');
const HARNESS_JSON = path.join(tmpHome, '.bolloon', 'harness.json');

let S: typeof import('../agents/run-store.js');

beforeAll(async () => {
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  await fs.mkdir(path.join(tmpHome, '.bolloon'), { recursive: true });
  S = await import('../agents/run-store.js');
});

beforeEach(async () => {
  await fs.rm(RUNS, { recursive: true, force: true }).catch(() => {});
  await fs.rm(HARNESS_JSON, { force: true }).catch(() => {});
  process.env.BOLLOON_RUN_PERSIST = '';
  await fs.mkdir(path.join(tmpHome, '.bolloon'), { recursive: true });
});

afterAll(async () => {
  await fs.chmod(RUNS, 0o700).catch(() => {});
  await fs.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
});

async function newRun(goal = '测试目标', surface: any = 'cli') {
  return S.startRun({ surface, goal, channelId: 'ch-1', agentId: 'agent-1' });
}

// ───────────────────────── ① 状态机 ─────────────────────────
describe('状态机 (协议约束)', () => {
  it('合法迁移表: running→done / interrupted→recovering / stalled→needs_human', () => {
    expect(S.canTransition('running', 'done')).toBe(true);
    expect(S.canTransition('interrupted', 'recovering')).toBe(true);
    expect(S.canTransition('stalled', 'needs_human')).toBe(true);
    expect(S.canTransition('needs_human', 'running')).toBe(true);
  });

  it('终态不可复活: done/failed/aborted 不能回到 running', () => {
    expect(S.canTransition('done', 'running')).toBe(false);
    expect(S.canTransition('failed', 'running')).toBe(false);
    expect(S.canTransition('aborted', 'running')).toBe(false);
  });

  it('setRunStatus 拒绝非法迁移, 记录状态不变', async () => {
    const r = await newRun();
    const ok = await S.setRunStatus(r.runId, 'done');
    expect(ok.ok).toBe(true);
    const bad = await S.setRunStatus(r.runId, 'running');
    expect(bad.ok).toBe(false);
    expect(String(bad.reason)).toContain('非法状态迁移');
    expect((await S.readRun(r.runId))!.status).toBe('done');
  });

  it('finishRun 对非法迁移直接拒绝 (返回 null, 不写坏记录)', async () => {
    const r = await newRun();
    await S.finishRun(r.runId, { status: 'done' });
    expect(await S.finishRun(r.runId, { status: 'interrupted' })).toBeNull();
    expect((await S.readRun(r.runId))!.status).toBe('done');
  });
});

// ───────────────────────── ② 错误分类 ─────────────────────────
describe('classifyError', () => {
  it('鉴权 → auth (不重试交人)', () => {
    expect(S.classifyError('401 Authentication Fails, api key invalid')).toBe('auth');
  });
  it('429/超时 → transient', () => {
    expect(S.classifyError('429 rate limit exceeded')).toBe('transient');
  });
  it('对端无响应 → external_no_reply (优先于 transient)', () => {
    expect(S.classifyError('对端无响应 504')).toBe('external_no_reply');
  });
  it('持久化写失败 → persist_failed (处置是"停", 不是"重试")', () => {
    expect(S.classifyError('run-store recordStep 失败: EACCES')).toBe('persist_failed');
    expect(S.classifyError('run 记录损坏且无有效备份')).toBe('persist_failed');
  });
  it('未知 → unknown', () => {
    expect(S.classifyError('something else entirely')).toBe('unknown');
  });
});

// ───────────────────────── ③ checkpoint ─────────────────────────
describe('checkpoint', () => {
  it('每步自动写 checkpoint (步号 + 当前动作 + 下一步 + 上下文引用)', async () => {
    const r = await newRun();
    await S.recordStep(r.runId, { tool: 'read_file', ok: true, args: { path: 'a' } });
    const cp = (await S.readRun(r.runId))!.checkpoint!;
    expect(cp.completedActions).toBe(1);
    expect(cp.pendingAction).toBe('read_file');
    expect(cp.nextAction).toBeTruthy();
    expect(cp.contextRef).toBe('ch-1');
  });

  it('saveCheckpoint 覆盖为显式入口 (恢复时的 nextAction)', async () => {
    const r = await newRun();
    await S.recordStep(r.runId, { tool: 'shell_exec', ok: true });
    await S.saveCheckpoint(r.runId, { completedActions: 1, pendingAction: 'shell_exec', nextAction: '改跑 npm test', contextRef: 'ch-1' });
    expect((await S.readRun(r.runId))!.checkpoint!.nextAction).toBe('改跑 npm test');
  });
});

// ───────────────────────── ④ 并发写 ─────────────────────────
describe('并发写入', () => {
  it('20 个并发 recordStep 不丢步 (锁内读改写)', async () => {
    const r = await newRun('并发写测试');
    await Promise.all(Array.from({ length: 20 }, (_, i) => S.recordStep(r.runId, { tool: `tool_${i}`, ok: true })));
    const rec = (await S.readRun(r.runId))!;
    expect(rec.steps.length).toBe(20);
    expect(new Set(rec.steps.map((s) => s.tool)).size).toBe(20);   // 没有互相覆盖
    expect(rec.steps.map((s) => s.n)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('并发 状态迁移 + 步骤追加 不把状态写丢', async () => {
    const r = await newRun('并发状态测试');
    await Promise.all([
      S.recordStep(r.runId, { tool: 'read_file', ok: true }),
      S.recordRecovery(r.runId, { errorClass: 'transient', message: 'timeout', action: 'backoff', recovered: true }),
      S.recordStep(r.runId, { tool: 'shell_exec', ok: false, error: 'boom' }),
    ]);
    const rec = (await S.readRun(r.runId))!;
    expect(rec.status).toBe('running');
    expect(rec.steps.length).toBe(2);
    expect(rec.recovery.length).toBe(1);
  });

  it('陈旧锁 (持有进程已死) 会被回收, 不卡住写入', async () => {
    const r = await newRun('锁回收');
    await fs.mkdir(RUNS, { recursive: true });
    await fs.writeFile(path.join(RUNS, `${r.runId}.lock`), JSON.stringify({ pid: 999_999, ts: new Date().toISOString() }), 'utf8');
    await S.recordStep(r.runId, { tool: 'after_stale_lock', ok: true });
    expect((await S.readRun(r.runId))!.steps.length).toBe(1);
    await expect(fs.access(path.join(RUNS, `${r.runId}.lock`))).rejects.toThrow();   // 锁已释放
  });

  it('陈旧锁 (超 lockStaleMs) 同样可回收', async () => {
    await fs.writeFile(HARNESS_JSON, JSON.stringify({ lockStaleMs: 50 }), 'utf8');
    const r = await newRun('超时锁回收');
    await fs.mkdir(RUNS, { recursive: true });
    await fs.writeFile(path.join(RUNS, `${r.runId}.lock`), JSON.stringify({ pid: process.pid, ts: new Date(Date.now() - 60_000).toISOString() }), 'utf8');
    await S.recordStep(r.runId, { tool: 'after_timeout_lock', ok: true });
    expect((await S.readRun(r.runId))!.steps.length).toBe(1);
  });
});

// ───────────────────────── ⑤ 损坏回退 ─────────────────────────
describe('文件损坏回退', () => {
  it('主文件损坏 → 用 .bak 修复, 并记一条 corrupt_state 数据修复事件', async () => {
    const r = await newRun('损坏回退');
    await S.recordStep(r.runId, { tool: 'step_a', ok: true });
    await S.recordStep(r.runId, { tool: 'step_b', ok: true });     // 这时 .bak = 只有 step_a 的那版
    await fs.writeFile(path.join(RUNS, `${r.runId}.json`), '{ 半个 JSON', 'utf8');

    const rec = await S.readRun(r.runId);
    expect(rec).not.toBeNull();
    expect(rec!.steps.length).toBe(1);                             // 回到最后一份**有效**备份
    expect(rec!.recovery.some((a) => a.errorClass === 'corrupt_state' && a.recovered === true)).toBe(true);
    // 主文件已被修回来 (不再是坏 JSON)
    const onDisk = JSON.parse(await fs.readFile(path.join(RUNS, `${r.runId}.json`), 'utf8'));
    expect(onDisk.runId).toBe(r.runId);
  });

  it('损坏且无有效备份 → null (不是"假装成一条空运行")', async () => {
    const r = await newRun('无备份');
    await fs.writeFile(path.join(RUNS, `${r.runId}.json`), 'not json at all', 'utf8');
    expect(await S.readRun(r.runId)).toBeNull();
  });

  it('运行记录不存在 → null (ENOENT 不算损坏)', async () => {
    expect(await S.readRun('no-such-run')).toBeNull();
  });

  it('损坏会留下降级痕迹 (盘上可查)', async () => {
    const r = await newRun('损坏留痕');
    await S.recordStep(r.runId, { tool: 'x', ok: true });
    await S.recordStep(r.runId, { tool: 'y', ok: true });
    await fs.writeFile(path.join(RUNS, `${r.runId}.json`), 'bad', 'utf8');
    await S.readRun(r.runId);
    const degs = await S.listDegradations();
    expect(degs.some((d) => d.op.includes('readRun'))).toBe(true);
  });
});

// ───────────────────────── ⑥ 核心写失败的硬约束 ─────────────────────────
describe('核心写失败 (strict vs degraded)', () => {
  it('strict (默认): 写不进去 → 抛 RunPersistenceError, 调用方必须停', async () => {
    const r = await newRun('只读目录');
    await fs.chmod(RUNS, 0o500);                                   // 目录不可写 → 落盘必然失败
    try {
      let thrown: any = null;
      try {
        await S.recordStep(r.runId, { tool: 'no_disk', ok: true });
      } catch (e) { thrown = e; }
      expect(thrown).not.toBeNull();
      expect(thrown.name).toBe('RunPersistenceError');
      // 只读目录下最先失败的是拿锁 (锁文件也建不了) —— 这正是要的: 连锁都拿不到就别假装写成功了
      expect(['acquireFileLock', 'recordStep']).toContain(thrown.op);
      expect(String(thrown.message)).toMatch(/EACCES|permission denied|失败/);
      expect(S.classifyError(String(thrown.message))).toBe('persist_failed');
    } finally {
      await fs.chmod(RUNS, 0o700);
    }
  });

  it('startRun 写不进去同样抛 (没有记录就不许开始执行)', async () => {
    await fs.mkdir(RUNS, { recursive: true });
    await fs.chmod(RUNS, 0o500);
    try {
      let thrown: any = null;
      try { await S.startRun({ surface: 'cli', goal: 'x' }); } catch (e) { thrown = e; }
      expect(thrown?.name).toBe('RunPersistenceError');
      expect(thrown?.op).toBe('startRun');
    } finally {
      await fs.chmod(RUNS, 0o700);
    }
  });

  it('degraded 模式 (显式降级): 不抛, 只记降级', async () => {
    await fs.writeFile(HARNESS_JSON, JSON.stringify({ persistence: 'degraded' }), 'utf8');
    const r = await newRun('降级模式');
    await fs.chmod(RUNS, 0o500);
    try {
      const out = await S.recordStep(r.runId, { tool: 'no_disk_degraded', ok: true });
      expect(out).toBeNull();                                      // 明确"没写成", 不是静默成功
    } finally {
      await fs.chmod(RUNS, 0o700);
    }
  });

  it('降级日志可读回 (观测失败也必须留痕)', async () => {
    await S.recordDegradation({ kind: 'observational', op: 'sse.broadcast', runId: 'r-1', message: 'SSE 断了' });
    const degs = await S.listDegradations(5);
    expect(degs[0].op).toBe('sse.broadcast');
    expect(degs[0].kind).toBe('observational');
  });

  it('runs 目录写不进去时, 降级日志退到目录外 (最需要留痕的时刻不能没有痕迹)', async () => {
    await fs.mkdir(RUNS, { recursive: true });
    await fs.chmod(RUNS, 0o500);
    try {
      await S.recordDegradation({ kind: 'core', op: 'recordStep', runId: 'r-2', message: '盘写不进去' });
    } finally {
      await fs.chmod(RUNS, 0o700);
    }
    const fallback = path.join(tmpHome, '.bolloon', 'run-degradations.jsonl');
    const raw = await fs.readFile(fallback, 'utf8');
    expect(raw).toContain('盘写不进去');
    const degs = await S.listDegradations(5);
    expect(degs.some((d) => d.op === 'recordStep' && d.message === '盘写不进去')).toBe(true);
  });
});

// ───────────────────────── 预算 / 恢复留痕 / 巡护 ─────────────────────────
describe('预算闸门与巡护', () => {
  it('步数预算用尽 → exceeded + 原因', async () => {
    const r = await newRun('预算');
    for (let i = 0; i < r.budget.maxSteps; i++) await S.recordStep(r.runId, { tool: 'noop', ok: true });
    const v = S.budgetVerdict((await S.readRun(r.runId))!);
    expect(v.exceeded).toBe(true);
    expect(String(v.reason)).toContain('步数预算用尽');
  });

  it('时间预算用尽 → exceeded (单独命中, 步数为 0)', async () => {
    const r = await newRun('时间预算');
    const p = path.join(RUNS, `${r.runId}.json`);
    const j = JSON.parse(await fs.readFile(p, 'utf8'));
    j.startedAt = new Date(Date.now() - j.budget.deadlineMs - 1000).toISOString();
    await fs.writeFile(p, JSON.stringify(j, null, 2), 'utf8');
    const v = S.budgetVerdict((await S.readRun(r.runId))!);
    expect(v.exceeded).toBe(true);
    expect(String(v.reason)).toContain('时间预算用尽');
  });

  it('recovery 留痕完整 (分类/策略/尝试次数/前后 checkpoint/是否恢复)', async () => {
    const r = await newRun('恢复留痕');
    await S.recordRecovery(r.runId, { errorClass: 'transient', message: 'timeout', action: 'backoff', checkpointBefore: 0, checkpointAfter: 0, recovered: true });
    const a = (await S.readRun(r.runId))!.recovery[0];
    expect(a.errorClass).toBe('transient');
    expect(a.action).toBe('backoff');
    expect(a.attempt).toBe(1);
    expect(a.recovered).toBe(true);
  });

  it('repeatedFailureCount 数的是"连续"同工具同参数失败 (成功后归零)', async () => {
    const r = await newRun('重复失败');
    await S.recordStep(r.runId, { tool: 'shell_exec', ok: false, args: { command: 'x' } });
    await S.recordStep(r.runId, { tool: 'shell_exec', ok: false, args: { command: 'x' } });
    let rec = (await S.readRun(r.runId))!;
    expect(S.repeatedFailureCount(rec, 'shell_exec')).toBe(2);
    await S.recordStep(r.runId, { tool: 'shell_exec', ok: true, args: { command: 'x' } });
    rec = (await S.readRun(r.runId))!;
    expect(S.repeatedFailureCount(rec, 'shell_exec')).toBe(0);
  });

  it('孤儿对账: 死 pid → interrupted; 活 pid 不动', async () => {
    const dead = await newRun('死进程');
    const alive = await newRun('活进程');
    const p = path.join(RUNS, `${dead.runId}.json`);
    const j = JSON.parse(await fs.readFile(p, 'utf8'));
    j.pid = 999_999;
    await fs.writeFile(p, JSON.stringify(j, null, 2), 'utf8');

    const out = await S.reconcileOrphans();
    expect(out.interrupted).toContain(dead.runId);
    expect(out.stillRunning).toContain(alive.runId);
    expect((await S.readRun(dead.runId))!.status).toBe('interrupted');
    expect((await S.readRun(dead.runId))!.errorClass).toBe('crash');
    expect((await S.readRun(alive.runId))!.status).toBe('running');
  });

  it('失速巡检: 长时间没更新 → stalled (活进程也照判)', async () => {
    const r = await newRun('失速');
    const p = path.join(RUNS, `${r.runId}.json`);
    const j = JSON.parse(await fs.readFile(p, 'utf8'));
    j.updatedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    await fs.writeFile(p, JSON.stringify(j, null, 2), 'utf8');
    const out = await S.superviseRuns();
    expect(out.stalled).toContain(r.runId);
    expect((await S.readRun(r.runId))!.status).toBe('stalled');
  });

  it('listRuns 不把 .bak / .lock / 降级日志 当成运行记录', async () => {
    const r = await newRun('列表过滤');
    await S.recordStep(r.runId, { tool: 'x', ok: true });
    await S.recordStep(r.runId, { tool: 'y', ok: true });
    await S.recordDegradation({ kind: 'observational', op: 'noise', message: 'x' });
    const all = await S.listRuns();
    expect(all.map((x) => x.runId)).toEqual([r.runId]);
  });
});

// ───────────────── 2026-09-16 (M2): 恢复语义 ─────────────────
describe('恢复 (prepareResume / 重放守卫 / 恢复指令)', () => {
  it('幂等工具白名单: 只读工具幂等, 写/终端/发布类一律按非幂等保守处理', () => {
    expect(S.isNonIdempotentTool('read_file')).toBe(false);
    expect(S.isNonIdempotentTool('grep_files')).toBe(false);
    expect(S.isNonIdempotentTool('write_file')).toBe(true);
    expect(S.isNonIdempotentTool('terminal')).toBe(true);
    expect(S.isNonIdempotentTool('publish_did')).toBe(true);
    expect(S.isNonIdempotentTool('x402_info_buy')).toBe(true);
    expect(S.isNonIdempotentTool('未知新工具')).toBe(true);   // 保守: 不认识就当非幂等
  });

  it('终态不可恢复 (done/failed), 未知 run 不可恢复', async () => {
    const r = await newRun('终态');
    await S.finishRun(r.runId, { status: 'done' });
    const done = await S.prepareResume(r.runId);
    expect(done.ok).toBe(false);
    expect(String(done.reason)).toContain('不可恢复');
    const missing = await S.prepareResume('no-such-run');
    expect(missing.ok).toBe(false);
  });

  it('interrupted → recovering + 记 resume recovery + 计划带已完成步骤与非幂等守卫', async () => {
    const r = await newRun('中断恢复');
    await S.recordStep(r.runId, { tool: 'read_file', ok: true, args: { path: 'a' }, summary: '读了 a' });
    await S.recordStep(r.runId, { tool: 'write_file', ok: true, args: { path: 'b' }, summary: '写了 b' });
    await S.recordStep(r.runId, { tool: 'shell_exec', ok: false, args: { command: 'boom' }, error: '失败' });
    await S.finishRun(r.runId, { status: 'interrupted', error: '进程 123 已不在' });

    const prep = await S.prepareResume(r.runId);
    expect(prep.ok).toBe(true);
    expect(prep.plan!.completedSteps.map((s) => s.tool)).toEqual(['read_file', 'write_file']);
    expect(prep.plan!.replayGuards.map((g) => g.tool)).toEqual(['write_file']);   // 只挡非幂等
    expect(prep.plan!.nextAction).toBeTruthy();

    const rec = (await S.readRun(r.runId))!;
    expect(rec.status).toBe('recovering');
    expect(rec.pid).toBe(process.pid);                       // 归属当前进程 (否则对账又会判 interrupted)
    const last = rec.recovery[rec.recovery.length - 1];
    expect(last.action).toBe('resume');
    expect(last.errorClass).toBe('crash');
  });

  it('恢复指令: 带目标 + 已完成动作 + 非幂等禁止重做 + 下一步', async () => {
    const r = await newRun('指令检查');
    await S.recordStep(r.runId, { tool: 'write_file', ok: true, args: { path: 'b' }, summary: '写了 b' });
    await S.finishRun(r.runId, { status: 'stalled', error: '超过 120s 没有新进展' });
    const prep = await S.prepareResume(r.runId);
    const text = S.buildResumeInstruction(prep.plan!);
    expect(text).toContain('从 checkpoint 恢复');
    expect(text).toContain('不要重复执行');
    expect(text).toContain('write_file');
    expect(text).toContain('下一步');
  });

  it('markRunRunning: recovering → running', async () => {
    const r = await newRun('恢复中');
    await S.finishRun(r.runId, { status: 'interrupted', error: '进程 1 已不在' });
    await S.prepareResume(r.runId);
    expect(await S.markRunRunning(r.runId)).toBe(true);
    expect((await S.readRun(r.runId))!.status).toBe('running');
  });

  it('argsDigestOf 与 Step.argsDigest 同一算法 (守卫比对得上)', async () => {
    const r = await newRun('指纹');
    await S.recordStep(r.runId, { tool: 'write_file', ok: true, args: { path: 'x', content: 'hi' } });
    const step = (await S.readRun(r.runId))!.steps[0];
    expect(step.argsDigest).toBe(S.argsDigestOf({ path: 'x', content: 'hi' }));
    expect(step.argsDigest).not.toBe(S.argsDigestOf({ path: 'x', content: 'other' }));
  });
});
