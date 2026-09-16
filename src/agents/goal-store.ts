/**
 * goal-store.ts — GoalStore: **目标事实来源** (2026-09-16 Milestone 2)
 *
 * 与既有模型的关系 (leo 2026-09-16: 先明确唯一关系, 不急着删旧模块):
 *   GoalStore (本文件, `~/.bolloon/goals/<goalId>.json`)  = 目标的**唯一事实来源**
 *   RunStore  (`~/.bolloon/runs/<runId>.json`)              = 一次执行的**唯一事实来源**
 *   SessionStore                                            = 对话上下文来源
 *   Task/Plan                                               = Goal 的执行辅助结构 (不承载目标状态)
 *   旧模型保留但降级为"入口/草稿": `pi-ecosystem-goals` 的 queue.json (目标队列) 与
 *   `goal-resume` 的 park/resume (双栖接力) 仍是生产者, 迁移留待后续批次 —— 不删。
 *
 * 关键规则 (协议 §「关键规则」):
 *   - Goal 永远不能因为一次 prompt 结束就自动消失
 *   - Run 结束 ≠ Goal 完成; 只有 successCriteria 全部满足 (且有证据) 才能 completed
 *   - 不允许"done 但目标没达成"伪装成功
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

export type GoalStatus = 'open' | 'active' | 'paused' | 'completed' | 'failed' | 'abandoned';

/** Goal 的持久化形态 */
export interface GoalRecord {
  goalId: string;
  objective: string;
  /** 完成判据 (可判定条目; 空数组 = 未声明判据, 一律不许自动判完成) */
  successCriteria: string[];
  constraints: string[];
  budget?: { maxRuns?: number; deadlineMs?: number };
  status: GoalStatus;
  channelId?: string;
  agentId?: string;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  /** 当前/最近一次执行 */
  currentRunId?: string;
  /** 该目标下所有执行 (历史保留) */
  runs: string[];
  /** 已满足的判据下标 */
  completedCriteria: number[];
  /** 未解决项 (失败步骤/待人工确认) —— 非空则不许判完成 */
  unresolvedItems: string[];
  /** 目标级证据 (成功步骤的事实摘要) */
  evidence: string[];
  resolution?: { reason: string; at: string };
}

export interface CreateGoalOptions {
  objective: string;
  successCriteria?: string[];
  constraints?: string[];
  budget?: GoalRecord['budget'];
  channelId?: string;
  agentId?: string;
  createdBy?: string;
}

export function goalsDir(): string {
  return path.join(os.homedir(), '.bolloon', 'goals');
}

function goalPath(goalId: string): string {
  return path.join(goalsDir(), `${goalId}.json`);
}

/** 原子写 (tmp + rename): 读到的永远是完整 JSON */
async function writeGoal(rec: GoalRecord): Promise<void> {
  await fs.mkdir(goalsDir(), { recursive: true });
  const p = goalPath(rec.goalId);
  const tmp = `${p}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(rec, null, 2), 'utf8');
  await fs.rename(tmp, p);
}

/** 同 goal 的进程内串行化 (并发写不覆盖判据/证据) */
const goalLocks = new Map<string, Promise<unknown>>();
async function withGoalLock<T>(goalId: string, fn: () => Promise<T>): Promise<T> {
  const prev = goalLocks.get(goalId) || Promise.resolve();
  const mine = prev.catch(() => {}).then(fn);
  const tail = mine.catch(() => {});
  goalLocks.set(goalId, tail);
  try { return await mine; }
  finally { if (goalLocks.get(goalId) === tail) goalLocks.delete(goalId); }
}

export function newGoalId(): string {
  return `g-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

export async function createGoal(opts: CreateGoalOptions): Promise<GoalRecord> {
  const now = new Date().toISOString();
  const rec: GoalRecord = {
    goalId: newGoalId(),
    objective: String(opts.objective || '').slice(0, 500),
    successCriteria: (opts.successCriteria || []).map((c) => String(c).slice(0, 200)).slice(0, 20),
    constraints: (opts.constraints || []).map((c) => String(c).slice(0, 200)).slice(0, 20),
    budget: opts.budget,
    status: 'open',
    channelId: opts.channelId,
    agentId: opts.agentId,
    createdBy: opts.createdBy,
    createdAt: now,
    updatedAt: now,
    runs: [],
    completedCriteria: [],
    unresolvedItems: [],
    evidence: [],
  };
  await writeGoal(rec);
  return rec;
}

export async function readGoal(goalId: string): Promise<GoalRecord | null> {
  if (!goalId) return null;
  try {
    return JSON.parse(await fs.readFile(goalPath(goalId), 'utf8')) as GoalRecord;
  } catch {
    return null;
  }
}

export async function listGoals(opts: { status?: GoalStatus | GoalStatus[]; limit?: number } = {}): Promise<GoalRecord[]> {
  let files: string[] = [];
  try { files = await fs.readdir(goalsDir()); } catch { return []; }
  const out: GoalRecord[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const g = await readGoal(f.replace(/\.json$/, ''));
    if (!g) continue;
    if (opts.status) {
      const want = Array.isArray(opts.status) ? opts.status : [opts.status];
      if (!want.includes(g.status)) continue;
    }
    out.push(g);
  }
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return typeof opts.limit === 'number' ? out.slice(0, opts.limit) : out;
}

export async function updateGoal(goalId: string, patch: Partial<GoalRecord>): Promise<GoalRecord | null> {
  return withGoalLock(goalId, async () => {
    const rec = await readGoal(goalId);
    if (!rec) return null;
    const next: GoalRecord = { ...rec, ...patch, goalId: rec.goalId, updatedAt: new Date().toISOString() };
    await writeGoal(next);
    return next;
  });
}

/**
 * 把一次 Run 挂到 Goal 上 (Run 反查 Goal 的入口)。
 * 幂等: 同一 runId 重复挂不会产生重复条目。
 */
export async function attachRun(goalId: string, runId: string, opts: { makeCurrent?: boolean } = {}): Promise<GoalRecord | null> {
  return withGoalLock(goalId, async () => {
    const rec = await readGoal(goalId);
    if (!rec) return null;
    if (!rec.runs.includes(runId)) rec.runs.push(runId);
    if (opts.makeCurrent !== false) rec.currentRunId = runId;
    if (rec.status === 'open') rec.status = 'active';
    rec.updatedAt = new Date().toISOString();
    await writeGoal(rec);
    return rec;
  });
}

/** 标记某条判据已满足 (+可选证据) */
export async function markCriterion(goalId: string, index: number, satisfied: boolean, evidence?: string): Promise<GoalRecord | null> {
  return withGoalLock(goalId, async () => {
    const rec = await readGoal(goalId);
    if (!rec) return null;
    if (index < 0 || index >= rec.successCriteria.length) return rec;
    const set = new Set(rec.completedCriteria);
    if (satisfied) set.add(index); else set.delete(index);
    rec.completedCriteria = Array.from(set).sort((a, b) => a - b);
    if (evidence) rec.evidence = [...rec.evidence, String(evidence).slice(0, 300)].slice(-50);
    rec.updatedAt = new Date().toISOString();
    await writeGoal(rec);
    return rec;
  });
}

/** 记录未解决项 (失败步骤 / 待人工确认) —— 有未解决项就不许判完成 */
export async function setUnresolved(goalId: string, items: string[]): Promise<GoalRecord | null> {
  return updateGoal(goalId, { unresolvedItems: items.map((i) => String(i).slice(0, 300)).slice(0, 30) });
}

export async function addEvidence(goalId: string, evidence: string[]): Promise<GoalRecord | null> {
  return withGoalLock(goalId, async () => {
    const rec = await readGoal(goalId);
    if (!rec) return null;
    rec.evidence = [...rec.evidence, ...evidence.map((e) => String(e).slice(0, 300))].slice(-50);
    rec.updatedAt = new Date().toISOString();
    await writeGoal(rec);
    return rec;
  });
}

/**
 * 完成门 (Milestone 4): **确定性**判定, 不看模型怎么说。
 *   全部必要判据满足 + 有证据 + 无未解决项 → 才允许 completed。
 *   未声明 successCriteria 的目标**永不**自动完成 (需要人显式确认) —— 否则"模型说完成"就变成了完成。
 */
export function evaluateGoalCompletion(goal: GoalRecord): { complete: boolean; reason: string; missing: string[] } {
  if (!goal.successCriteria.length) {
    return { complete: false, reason: '未声明 successCriteria: 不允许自动判完成 (需人工确认)', missing: [] };
  }
  const missing = goal.successCriteria
    .map((c, i) => ({ c, i }))
    .filter(({ i }) => !goal.completedCriteria.includes(i))
    .map(({ c, i }) => `[${i}] ${c}`);
  if (missing.length) {
    return { complete: false, reason: `还有 ${missing.length} 条判据未满足`, missing };
  }
  if (!goal.evidence.length) {
    return { complete: false, reason: '没有证据 (evidence 为空): 不许判完成', missing: [] };
  }
  if (goal.unresolvedItems.length) {
    return { complete: false, reason: `还有 ${goal.unresolvedItems.length} 项未解决`, missing: goal.unresolvedItems };
  }
  return { complete: true, reason: '全部判据满足 + 有证据 + 无未解决项', missing: [] };
}

/** 通过完成门就落 completed, 否则保持原状态并回传原因 (不静默) */
export async function completeGoalIfEligible(goalId: string): Promise<{ ok: boolean; reason: string; goal: GoalRecord | null; missing?: string[] }> {
  const goal = await readGoal(goalId);
  if (!goal) return { ok: false, reason: `goal 不存在: ${goalId}`, goal: null };
  const verdict = evaluateGoalCompletion(goal);
  if (!verdict.complete) return { ok: false, reason: verdict.reason, goal, missing: verdict.missing };
  const next = await updateGoal(goalId, {
    status: 'completed',
    resolution: { reason: verdict.reason, at: new Date().toISOString() },
  });
  return { ok: true, reason: verdict.reason, goal: next };
}

/**
 * 找一个"还在进行中"的目标 (供 prompt 入口判断"继续还是新建")。
 * 只看 open/active, 且限定 channel+agent (不同智能体的目标不混)。
 */
export async function findActiveGoal(opts: { channelId?: string; agentId?: string }): Promise<GoalRecord | null> {
  const all = await listGoals({ status: ['open', 'active'] });
  for (const g of all) {
    if (opts.channelId && g.channelId && g.channelId !== opts.channelId) continue;
    if (opts.agentId && g.agentId && g.agentId !== opts.agentId) continue;
    return g;
  }
  return null;
}

/** 给 CLI/Web 的一行摘要 */
export function formatGoalLine(g: GoalRecord): string {
  const done = `${g.completedCriteria.length}/${g.successCriteria.length || 0}`;
  return `${g.goalId}  [${g.status.padEnd(9)}] 判据 ${done.padStart(4)}  run=${(g.currentRunId || '-').slice(0, 12)}  ${g.objective.slice(0, 44)}`;
}
