/**
 * ExecutionSupervisor — 长期执行层 (2026-09-16, M2-B / 计划 §13 2-A+2-B)
 *
 * 职责边界 (刻意与 Harness 分开):
 *   Harness 只管「这一段能不能安全执行」
 *   Supervisor 才管「这个目标还要不要继续执行」
 *
 * 它是一个常驻 worker: 扫描可执行的 Goal → 抢 lease → 开新 Run 或恢复旧 Run → 执行 →
 * 按结果决策 Goal 状态 → 写下一次唤醒信息 → 释放 lease → 换下一个 Goal。
 *
 * 它不塞进 Web request, 也不依赖浏览器是否打开。触发器可以复用 cron/heartbeat 的 tick,
 * 但**事实来源永远是持久化记录** (GoalStore / RunStore / lease 文件), 不是内存状态。
 */

import * as os from 'os';
import {
  listRunnableGoals,
  claimGoal,
  heartbeatGoal,
  releaseGoal,
  readGoal,
  setContinuation,
  bumpContinuationAttempts,
  evaluateGoalCompletion,
  completeGoalIfEligible,
  addEvidence,
  type GoalRecord,
  type GoalContinuation,
  type GoalStatus,
} from './goal-store.js';
import {
  readRun,
  reconcileOrphans,
  superviseRuns,
  buildContinuationPlan,
  RESUMABLE_STATUSES,
  type RunRecord,
} from './run-store.js';

// ─────────────────────────────────────────────────────────────────────────────
// 2-D: Run 结束 → Goal 状态决策 (确定性 reducer, 纯函数, 可单测)
// ─────────────────────────────────────────────────────────────────────────────

export interface GoalDecision {
  goalStatus: GoalStatus;
  continuation: Partial<GoalContinuation>;
  reason: string;
}

/** 自动继续的退避 (attempts → 等待毫秒)。0 次 = 立刻。 */
export function continuationBackoffMs(attempts: number): number {
  const steps = [0, 15_000, 60_000, 5 * 60_000, 15 * 60_000];
  return steps[Math.min(Math.max(attempts, 0), steps.length - 1)];
}

/**
 * Run 结果 → Goal 下一步。**Run done ≠ Goal completed** 是这里的核心不变式:
 * Run 结束从来不自动等于目标完成, 必须过 evaluateGoalCompletion。
 */
export function decideGoalOutcome(
  goal: GoalRecord,
  run: RunRecord | null,
  opts: { now?: number; maxAttempts?: number } = {},
): GoalDecision {
  const now = opts.now ?? Date.now();
  const maxAttempts = opts.maxAttempts ?? 3;
  const attempts = (goal.continuation?.attempts || 0);
  const nextAction = run?.checkpoint?.nextAction;
  const base = { autoContinue: true, lastRunId: run?.runId, nextAction };

  if (!run) {
    return { goalStatus: 'active', continuation: { ...base, wakeReason: 'new_goal' }, reason: '还没有 Run' };
  }

  // 人定的状态优先, 不覆盖 (外部 pause/abort 是人的决定)
  if (run.status === 'paused') {
    return { goalStatus: 'paused', continuation: { ...base, autoContinue: false, wakeReason: 'paused' }, reason: '运行被人工暂停: 等 resume' };
  }

  switch (run.status) {
    case 'interrupted':
      return {
        goalStatus: 'recovering',
        continuation: { ...base, wakeReason: 'recovering' },
        reason: '进程中断 (crash): 从 checkpoint 恢复, 不重头开始',
      };

    case 'stalled':
      return {
        goalStatus: 'stalled',
        continuation: { ...base, wakeReason: 'stalled' },
        reason: '运行失速 (心跳过期): 交 Supervisor 决策恢复或转人工',
      };

    case 'awaiting_external':
      return {
        goalStatus: 'awaiting_external',
        continuation: {
          ...base,
          wakeReason: 'awaiting_external',
          needsExternal: String(run.error || '外部节点回复'),
        },
        reason: '在等外部事件: 不重发请求, 由事件唤醒',
      };

    case 'aborted':
      return {
        goalStatus: 'active',
        continuation: { ...base, wakeReason: 'active' },
        reason: `运行被中止 (${run.errorClass || run.error || '预算/人工'}): 目标仍 active, 交给下一个 Run 继续`,
      };

    case 'done': {
      const verdict = evaluateGoalCompletion(goal);
      if (verdict.complete) {
        return {
          goalStatus: 'completed',
          continuation: { ...base, autoContinue: false, wakeReason: 'completed' },
          reason: `判据全部满足: ${verdict.reason}`,
        };
      }
      // Run 说完成, 但 Goal 的判据/证据不足 → 不许装作完成
      return {
        goalStatus: 'active',
        continuation: { ...base, wakeReason: 'active' },
        reason: `Run 已 done 但目标未达成 (${verdict.reason}) → 继续下一个 Run`,
      };
    }

    case 'failed':
    case 'needs_human': {
      const cls = run.errorClass || 'unknown';
      const needsHuman = ['auth', 'persist_failed', 'corrupt_state', 'policy_denied', 'repeat_failure', 'bad_args', 'no_such_tool'].includes(cls)
        || attempts >= maxAttempts;
      if (needsHuman) {
        return {
          goalStatus: 'needs_human',
          continuation: { ...base, autoContinue: false, wakeReason: 'needs_human', attempts },
          reason: `${cls} 需要人工介入${attempts >= maxAttempts ? ` (自动继续已试 ${attempts} 次)` : ''}`,
        };
      }
      const wait = continuationBackoffMs(attempts);
      return {
        goalStatus: 'retry_wait',
        continuation: {
          ...base,
          wakeReason: 'retry_wait',
          wakeAt: new Date(now + wait).toISOString(),
          attempts: attempts + 1,
        },
        reason: `可恢复错误 ${cls}: 第 ${attempts + 1} 次自动继续, ${Math.round(wait / 1000)}s 后唤醒`,
      };
    }

    case 'recovering':
      return { goalStatus: 'recovering', continuation: { ...base, wakeReason: 'recovering' }, reason: '正在恢复' };

    default: { // queued / running
      return { goalStatus: 'active', continuation: { ...base, wakeReason: 'active' }, reason: `运行中 (${run.status})` };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 执行请求 / 执行器注入
// ─────────────────────────────────────────────────────────────────────────────

export interface GoalExecutionRequest {
  goal: GoalRecord;
  /** resume = 同一条 Run 继续; continue_new_run = 开新 Run 继续同一 Goal; first_run = 首次执行 */
  kind: 'resume' | 'continue_new_run' | 'first_run';
  prevRunId?: string;
  instruction: string;
  /** 上一个 Run 已成功的非幂等动作 (新 Run 也要守住, 不许重做) */
  guards: { tool: string; argsDigest?: string; summary: string }[];
}

export interface GoalExecutionResult {
  runId?: string;
  status?: string;
  reply?: string;
  error?: string;
}

/** 执行器由调用方注入 (Web 用 channel agent, CLI 用当前 agent, 测试用假的) —— 不提供默认实现, 避免暗中复制 agent loop */
export type GoalRunner = (req: GoalExecutionRequest) => Promise<GoalExecutionResult>;

// ── 宿主分离 (2-C.1): 执行器不再写死, 每次执行前由 resolver 解析 ──
export type RunnerKind = 'web' | 'cli' | 'standalone' | 'injected' | 'fake' | 'none';

export interface RunnerResolution {
  ok: boolean;
  runner?: GoalRunner;
  kind: RunnerKind;
  /** ok=false 时的人类可读原因 (进 skipped/诊断, 不静默) */
  reason?: string;
}

/**
 * 解析"这个 Goal 谁来执行"。可以是 web 的 channel agent / CLI 的会话 agent / 独立 agent / 测试假的;
 * 解析不出来必须是 `{ok:false}` —— Supervisor 会**只诊断不执行, 且不写任何 Goal 状态**
 * (绝不把"没人能执行"当成"执行失败"或"执行完成")。
 */
export type RunnerResolver = (req: GoalExecutionRequest) => Promise<RunnerResolution> | RunnerResolution;

export interface SupervisorOptions {
  owner?: string;
  tickIntervalMs?: number;
  leaseTtlMs?: number;
  /** 每个 tick 最多推进几个 Goal (默认 1, 长期执行要克制) */
  maxPerTick?: number;
  /** 固定执行器 (简单宿主/测试用) */
  runner?: GoalRunner;
  /** 动态执行器解析 (生产宿主用: web / CLI / 独立进程 各自解析) */
  resolver?: RunnerResolver;
  onEvent?: (e: { kind: string; goalId?: string; runId?: string; message: string }) => void;
  log?: (msg: string) => void;
}

export interface TickReport {
  at: string;
  owner: string;
  tick: number;
  reconciled: { interrupted: string[]; stillRunning: string[]; failed: string[] };
  supervised: { stalled: string[]; failed: string[] };
  claimed: string[];
  executed: { goalId: string; runId?: string; status?: string; error?: string }[];
  skipped: { goalId: string; reason: string }[];
  errors: string[];
  dryRun: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────

/** 调度上下文的时间戳 (不含 lease 镜像: 认领本身会写 lease, 不应把快照判成过期) */
function stampOf(g: GoalRecord): string {
  return [g.status, g.currentRunId || '', String(g.runs.length), g.continuation?.updatedAt || '', g.goalId].join('|');
}

export class ExecutionSupervisor {
  readonly owner: string;
  private readonly tickIntervalMs: number;
  private readonly leaseTtlMs: number;
  private readonly maxPerTick: number;
  private readonly runner?: GoalRunner;
  private readonly resolver?: RunnerResolver;
  private readonly onEvent?: SupervisorOptions['onEvent'];
  private readonly logFn?: (msg: string) => void;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private tickCount = 0;
  private reconciledOnce = false;
  private lastReport: TickReport | null = null;

  constructor(opts: SupervisorOptions = {}) {
    this.owner = opts.owner || `${os.hostname()}:${process.pid}`;
    this.tickIntervalMs = opts.tickIntervalMs ?? 30_000;
    this.leaseTtlMs = opts.leaseTtlMs ?? 90_000;
    this.maxPerTick = opts.maxPerTick ?? 1;
    this.runner = opts.runner;
    this.resolver = opts.resolver;
    this.onEvent = opts.onEvent;
    this.logFn = opts.log;
  }

  /** 有固定执行器或解析器 → 可以真执行; 都没有 → 只诊断 (dry-run) */
  get canExecute(): boolean { return !!(this.runner || this.resolver); }

  private log(msg: string): void {
    this.logFn?.(msg);
  }

  private emit(e: { kind: string; goalId?: string; runId?: string; message: string }): void {
    try { this.onEvent?.(e); } catch { /* 观测失败不影响调度 */ }
  }

  get running(): boolean { return this.timer !== null; }

  status() {
    return {
      owner: this.owner,
      running: this.running,
      tickIntervalMs: this.tickIntervalMs,
      leaseTtlMs: this.leaseTtlMs,
      maxPerTick: this.maxPerTick,
      ticks: this.tickCount,
      dryRun: !this.canExecute,
      hasResolver: !!this.resolver,
      lastReport: this.lastReport,
    };
  }

  start(): void {
    if (this.timer) return;
    if (!this.canExecute) this.log('[supervisor] 未注入 runner/resolver → 只诊断不执行 (dry-run)');
    this.timer = setInterval(() => { void this.tickOnce().catch((err) => this.log(`[supervisor] tick 失败: ${(err as Error)?.message}`)); }, this.tickIntervalMs);
    this.timer.unref?.();
    this.log(`[supervisor] 启动 owner=${this.owner} tick=${this.tickIntervalMs}ms leaseTtl=${this.leaseTtlMs}ms`);
    void this.tickOnce().catch(() => { /* 首次 tick 失败不抛 */ });
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; this.log('[supervisor] 停止'); }
  }

  /** 一个调度周期 (可单测/可手动触发)。所有决策基于持久化记录。 */
  async tickOnce(): Promise<TickReport> {
    if (this.ticking) return this.lastReport || this.emptyReport();
    this.ticking = true;
    this.tickCount++;
    const report: TickReport = { ...this.emptyReport(), tick: this.tickCount };

    try {
      // 1. 对账孤儿 (进程死了的 run) —— 只在启动后第一次做, 之后靠 tick 的常规巡检
      if (!this.reconciledOnce) {
        report.reconciled = await reconcileOrphans();
        this.reconciledOnce = true;
        if (report.reconciled.interrupted.length) this.log(`[supervisor] 对账: ${report.reconciled.interrupted.length} 条僵尸 run → interrupted`);
      }
      report.supervised = await superviseRuns();

      // 2. 扫描可执行 Goal
      const { runnable, skipped } = await listRunnableGoals({ now: Date.now(), owner: this.owner });
      report.skipped = skipped;

      // 3. 逐个推进 (每个 Goal: 抢 lease → 执行 → 决策 → 释放 lease)
      for (const goal of runnable.slice(0, this.maxPerTick)) {
        const claimed = await claimGoal(goal.goalId, { owner: this.owner, ttlMs: this.leaseTtlMs });
        if (!claimed.ok) {
          report.skipped.push({ goalId: goal.goalId, reason: claimed.reason || 'claim 失败' });
          continue;
        }
        report.claimed.push(goal.goalId);
        const leaseId = claimed.lease!.leaseId;
        try {
          const res = await this.runGoal(goal, leaseId, report);
          report.executed.push(res);
        } catch (err) {
          report.errors.push(`${goal.goalId}: ${(err as Error)?.message || err}`);
        } finally {
          const rel = await releaseGoal(goal.goalId, leaseId);
          if (!rel.ok) report.skipped.push({ goalId: goal.goalId, reason: rel.reason || 'release 失败' });
        }
      }
    } catch (err) {
      report.errors.push(`tick: ${(err as Error)?.message || err}`);
    } finally {
      this.ticking = false;
      this.lastReport = report;
    }
    return report;
  }

  private emptyReport(): TickReport {
    return {
      at: new Date().toISOString(), owner: this.owner, tick: this.tickCount,
      reconciled: { interrupted: [], stillRunning: [], failed: [] },
      supervised: { stalled: [], failed: [] },
      claimed: [], executed: [], skipped: [], errors: [], dryRun: !this.runner,
    };
  }

  /** 认领后执行一个 Goal: 决定 resume 还是开新 Run → 跑 → 决策 Goal 状态 */
  private async runGoal(goal: GoalRecord, leaseId: string, report: TickReport): Promise<{ goalId: string; runId?: string; status?: string; error?: string }> {
    // 乐观并发检查: 认领后重新读一次 —— 若这个 Goal 在我扫描之后已被别的 worker 推进
    //   (状态/当前 run/run 列表/continuation 变了), 就让路。否则同一个状态版本会被两个 worker 各跑一次。
    const freshGoal = await readGoal(goal.goalId);
    if (!freshGoal || stampOf(freshGoal) !== stampOf(goal)) {
      this.log(`[supervisor] goal=${goal.goalId} 扫描后状态已变 (别的 worker 推进过) → 让路`);
      report.skipped.push({ goalId: goal.goalId, reason: '状态在扫描后被其它 worker 推进 (乐观并发检查) → 本周期不重复执行' });
      return { goalId: goal.goalId, status: 'stale_skip' };
    }

    const prevRunId = goal.currentRunId;
    const prevRun = prevRunId ? await readRun(prevRunId) : null;
    const plan = prevRunId ? await buildContinuationPlan(prevRunId).catch(() => null) : null;
    const guards = plan?.replayGuards || [];
    const instruction = plan
      ? `继续这个目标 (不要重头开始):\n目标: ${plan.objective || goal.objective}\n已完成 ${plan.completedSteps.length} 步; 下一步: ${plan.nextAction}`
      : `开始执行这个目标:\n目标: ${goal.objective}${goal.successCriteria.length ? `\n完成判据: ${goal.successCriteria.join('; ')}` : ''}`;

    const kind: GoalExecutionRequest['kind'] =
      !prevRun ? 'first_run'
        : RESUMABLE_STATUSES.includes(prevRun.status) ? 'resume'
          : 'continue_new_run';

    if (!this.canExecute) {
      this.log(`[supervisor] (dry-run) 会执行 goal=${goal.goalId} kind=${kind} prevRun=${prevRunId || '-'}`);
      return { goalId: goal.goalId, runId: prevRunId, status: 'dry_run' };
    }

    // 执行器解析 (2-C.1): 解析不出来 → **只诊断, 不执行, 不写任何 Goal 状态**
    let runner = this.runner;
    if (!runner && this.resolver) {
      let res: RunnerResolution;
      try {
        res = await this.resolver({ goal, kind, prevRunId, instruction, guards });
      } catch (err) {
        res = { ok: false, kind: 'none', reason: `resolver 抛错: ${String((err as Error)?.message || err).slice(0, 140)}` };
      }
      if (!res.ok || !res.runner) {
        const why = res.reason || '解析不到执行器';
        report.skipped.push({ goalId: goal.goalId, reason: `无执行器: ${why} (Goal 状态未改动)` });
        this.emit({ kind: 'no_runner', goalId: goal.goalId, message: why });
        this.log(`[supervisor] goal=${goal.goalId} 无执行器 → 只诊断, 不执行也不改状态: ${why}`);
        return { goalId: goal.goalId, runId: prevRunId, status: 'unresolved', error: why };
      }
      runner = res.runner;
    }
    if (!runner) {
      report.skipped.push({ goalId: goal.goalId, reason: '无执行器 (Goal 状态未改动)' });
      return { goalId: goal.goalId, status: 'unresolved' };
    }

    // 执行期间持续续租: 续租失败 = 已被别人接管 → 记录 (不掩盖)
    const hb = setInterval(() => {
      void heartbeatGoal(goal.goalId, leaseId, this.leaseTtlMs).then((r) => {
        if (!r.ok) this.emit({ kind: 'lease_lost', goalId: goal.goalId, message: r.reason || '续租失败' });
      });
    }, Math.max(5_000, Math.floor(this.leaseTtlMs / 3)));
    hb.unref?.();

    let result: GoalExecutionResult;
    const t0 = Date.now();
    try {
      result = await runner({ goal, kind, prevRunId, instruction, guards });
    } catch (err) {
      result = { error: (err as Error)?.message || String(err) };
    } finally {
      clearInterval(hb);
    }

    // Run 结束 → Goal 决策 (确定性 reducer, 落盘)
    const finalRunId = result.runId || prevRunId;
    const finalRun = finalRunId ? await readRun(finalRunId) : null;
    if (kind !== 'resume' && finalRun && finalRun.goalId !== goal.goalId) {
      // 新 Run 必须挂在同一 Goal 下; 没挂上就是执行器没接住 goalId → 如实记, 不掩盖
      report.errors.push(`${goal.goalId}: 新 Run ${finalRunId} 未绑定本 Goal (goalId=${finalRun.goalId || '空'})`);
    }
    const decision = decideGoalOutcome(goal, finalRun, { now: Date.now() });
    await this.applyDecision(goal, decision, finalRun);
    this.emit({ kind: 'goal_decision', goalId: goal.goalId, runId: finalRunId, message: `${finalRun?.status || result.status || '?'} → ${decision.goalStatus}: ${decision.reason}` });
    this.log(`[supervisor] goal=${goal.goalId} run=${finalRunId || '-'} ${finalRun?.status || result.status || '?'} → goal=${decision.goalStatus} (${decision.reason}) ${Date.now() - t0}ms`);

    return { goalId: goal.goalId, runId: finalRunId, status: finalRun?.status || result.status, error: result.error };
  }

  /** 把决策写进 Goal (+ 证据同步 + 完成出口), 并写下一次唤醒信息 */
  private async applyDecision(goal: GoalRecord, decision: GoalDecision, run: RunRecord | null): Promise<void> {
    const { updateGoal } = await import('./goal-store.js');

    // 证据同步: Run 的成功步骤 → Goal 证据 (长期执行的判据要有据可依)
    if (run) {
      const ev = run.steps.filter((s) => s.ok).slice(-5).map((s) => `${run.runId}/${s.tool}: ${String(s.summary || '(完成)').slice(0, 120)}`);
      if (ev.length) await addEvidence(goal.goalId, ev).catch(() => null);
    }

    // 唯一完成出口: 只有经 completeGoalIfEligible 才能把 Goal 判成 completed
    if (decision.goalStatus === 'completed') {
      const r = await completeGoalIfEligible(goal.goalId);
      if (!r.ok) {
        // 完成门拒绝 → 如实退回 active, 并保留原因 (不许装作完成)
        await setContinuation(goal.goalId, { ...decision.continuation, wakeReason: 'active', autoContinue: true });
        await updateGoal(goal.goalId, { status: 'active' });
        this.log(`[supervisor] goal=${goal.goalId} 完成门拒绝: ${r.reason}`);
        return;
      }
      if (decision.continuation.wakeReason !== 'completed') await setContinuation(goal.goalId, decision.continuation);
      this.emit({ kind: 'goal_completed', goalId: goal.goalId, runId: run?.runId, message: decision.reason });
      return;
    }

    if (decision.goalStatus !== goal.status) await updateGoal(goal.goalId, { status: decision.goalStatus });
    await setContinuation(goal.goalId, decision.continuation);

    if (decision.continuation.wakeReason === 'needs_human') {
      this.emit({ kind: 'needs_human', goalId: goal.goalId, message: decision.reason });
    }
  }

  /** 外部事件到达 → 给对应 Goal 清除等待并加速唤醒 (2-E 第 4 类的入口) */
  async notifyExternal(goalId: string): Promise<boolean> {
    const g = await readGoal(goalId);
    if (!g) return false;
    if (g.continuation?.wakeReason !== 'awaiting_external' && !g.continuation?.needsExternal) return false;
    await setContinuation(goalId, { wakeReason: 'active', needsExternal: undefined, autoContinue: true, wakeAt: undefined });
    await bumpContinuationAttempts(goalId); // 记一次唤醒 (可观测)
    return true;
  }
}

/** 单例 (Web/CLI 共享同一个进程内调度器; 跨进程靠 lease 排他) */
let singleton: ExecutionSupervisor | null = null;

export function getSupervisor(opts?: SupervisorOptions): ExecutionSupervisor {
  if (!singleton) singleton = new ExecutionSupervisor(opts);
  return singleton;
}

export function resetSupervisorForTest(): void {
  singleton?.stop();
  singleton = null;
}
