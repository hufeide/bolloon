/**
 * goal-store.test.ts — GoalStore (目标事实来源) 单测 (2026-09-16 Milestone 2/4)
 *
 * 验证目标侧的协议规则:
 *   ① Goal 不会因为一次 prompt 结束而消失 (Run 结束 ≠ Goal 完成)
 *   ② Run → Goal 反查链 (attachRun 幂等, 记录 runs + currentRunId)
 *   ③ 完成门是**确定性**判定: 判据全满足 + 有证据 + 无未解决项, 缺一不可
 *   ④ 未声明 successCriteria 的目标永不自动完成 ("模型说完成" ≠ 完成)
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

const tmpHome = path.join(os.tmpdir(), 'bolloon-goalstore-' + Date.now());
let G: typeof import('../agents/goal-store.js');

beforeAll(async () => {
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  await fs.mkdir(path.join(tmpHome, '.bolloon'), { recursive: true });
  G = await import('../agents/goal-store.js');
});

beforeEach(async () => {
  await fs.rm(path.join(tmpHome, '.bolloon', 'goals'), { recursive: true, force: true }).catch(() => {});
});

afterAll(async () => {
  await fs.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
});

describe('GoalStore 基础', () => {
  it('创建/读取/列出, 落盘到 ~/.bolloon/goals/<goalId>.json', async () => {
    const g = await G.createGoal({ objective: '写一个 P2P 模块', channelId: 'ch-1', agentId: 'a-1' });
    expect(g.goalId).toMatch(/^g-/);
    expect(g.status).toBe('open');
    const read = await G.readGoal(g.goalId);
    expect(read?.objective).toBe('写一个 P2P 模块');
    const all = await G.listGoals();
    expect(all.map((x) => x.goalId)).toEqual([g.goalId]);
    // 真落盘 (不是内存)
    await expect(fs.access(path.join(tmpHome, '.bolloon', 'goals', `${g.goalId}.json`))).resolves.toBeUndefined();
  });

  it('attachRun: 幂等 + 置 currentRunId + open → active', async () => {
    const g = await G.createGoal({ objective: 'x' });
    await G.attachRun(g.goalId, 'run-1');
    await G.attachRun(g.goalId, 'run-1');            // 重复挂不产生重复
    const after = await G.attachRun(g.goalId, 'run-2');
    expect(after!.runs).toEqual(['run-1', 'run-2']);
    expect(after!.currentRunId).toBe('run-2');
    expect(after!.status).toBe('active');
  });

  it('findActiveGoal 按 channel/agent 过滤, 不串目标', async () => {
    await G.createGoal({ objective: 'A 的任务', channelId: 'ch-a', agentId: 'ag-1' });
    const other = await G.createGoal({ objective: 'B 的任务', channelId: 'ch-b', agentId: 'ag-1' });
    const found = await G.findActiveGoal({ channelId: 'ch-b', agentId: 'ag-1' });
    expect(found?.goalId).toBe(other.goalId);
  });

  it('完成的目标不再算"进行中" (不会被下一次 prompt 续上)', async () => {
    const g = await G.createGoal({ objective: 'done 掉', successCriteria: ['c1'], channelId: 'ch-x' });
    await G.markCriterion(g.goalId, 0, true, '证据: 测试通过');
    const r = await G.completeGoalIfEligible(g.goalId);
    expect(r.ok).toBe(true);
    expect((await G.readGoal(g.goalId))!.status).toBe('completed');
    expect(await G.findActiveGoal({ channelId: 'ch-x' })).toBeNull();
  });
});

describe('完成门 (确定性判定, 不看模型怎么说)', () => {
  it('未声明 successCriteria → 永不自动完成', async () => {
    const g = await G.createGoal({ objective: '模糊目标' });
    await G.addEvidence(g.goalId, ['read_file: 读了点东西']);
    const v = G.evaluateGoalCompletion((await G.readGoal(g.goalId))!);
    expect(v.complete).toBe(false);
    expect(v.reason).toContain('successCriteria');
    const r = await G.completeGoalIfEligible(g.goalId);
    expect(r.ok).toBe(false);
  });

  it('判据未满足 → 不完成, 并列出缺失项', async () => {
    const g = await G.createGoal({ objective: '三个判据', successCriteria: ['c1', 'c2', 'c3'] });
    await G.markCriterion(g.goalId, 0, true, 'e1');
    const v = G.evaluateGoalCompletion((await G.readGoal(g.goalId))!);
    expect(v.complete).toBe(false);
    expect(v.missing.length).toBe(2);
    expect(v.missing.join()).toContain('c2');
  });

  it('判据全满足但**没有证据** → 仍不完成', async () => {
    const g = await G.createGoal({ objective: '没证据', successCriteria: ['c1'] });
    await G.markCriterion(g.goalId, 0, true);   // 不传证据
    const v = G.evaluateGoalCompletion((await G.readGoal(g.goalId))!);
    expect(v.complete).toBe(false);
    expect(v.reason).toContain('证据');
  });

  it('判据全满足 + 有证据, 但有未解决项 → 不完成', async () => {
    const g = await G.createGoal({ objective: '有遗留', successCriteria: ['c1'] });
    await G.markCriterion(g.goalId, 0, true, 'e1');
    await G.setUnresolved(g.goalId, ['写文件失败未处理']);
    const v = G.evaluateGoalCompletion((await G.readGoal(g.goalId))!);
    expect(v.complete).toBe(false);
    expect(v.reason).toContain('未解决');
  });

  it('判据全满足 + 有证据 + 无未解决 → 完成, 且落 resolution', async () => {
    const g = await G.createGoal({ objective: '正经目标', successCriteria: ['接口通了', '测试过了'] });
    await G.markCriterion(g.goalId, 0, true, 'curl 200');
    await G.markCriterion(g.goalId, 1, true, 'vitest 全绿');
    const v = G.evaluateGoalCompletion((await G.readGoal(g.goalId))!);
    expect(v.complete).toBe(true);
    const r = await G.completeGoalIfEligible(g.goalId);
    expect(r.ok).toBe(true);
    const done = (await G.readGoal(g.goalId))!;
    expect(done.status).toBe('completed');
    expect(done.resolution?.reason).toContain('判据满足');
    expect(done.evidence.length).toBe(2);
  });

  it('markCriterion 反向可撤销 (判据不再满足 → 回到未完成)', async () => {
    const g = await G.createGoal({ objective: '撤销', successCriteria: ['c1'] });
    await G.markCriterion(g.goalId, 0, true, 'e');
    await G.markCriterion(g.goalId, 0, false);
    const v = G.evaluateGoalCompletion((await G.readGoal(g.goalId))!);
    expect(v.complete).toBe(false);
  });

  it('并发写判据/证据不丢 (锁)', async () => {
    const g = await G.createGoal({ objective: '并发', successCriteria: ['c1', 'c2', 'c3', 'c4'] });
    await Promise.all([
      G.markCriterion(g.goalId, 0, true, 'e0'),
      G.markCriterion(g.goalId, 1, true, 'e1'),
      G.markCriterion(g.goalId, 2, true, 'e2'),
      G.addEvidence(g.goalId, ['e3']),
    ]);
    const after = (await G.readGoal(g.goalId))!;
    expect(after.completedCriteria).toEqual([0, 1, 2]);
    expect(after.evidence.length).toBe(4);
  });

  it('formatGoalLine 给出状态与判据进度 (CLI/Web 共用)', async () => {
    const g = await G.createGoal({ objective: '格式化', successCriteria: ['a', 'b'] });
    await G.markCriterion(g.goalId, 0, true, 'e');
    const line = G.formatGoalLine((await G.readGoal(g.goalId))!);
    expect(line).toContain(g.goalId);
    expect(line).toContain('1/2');
  });
});
