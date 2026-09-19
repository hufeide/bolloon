/**
 * task-budget.ts — M1 预算闸 (leo 2026-09-18 冻结规则 ③)
 *
 *   单任务 0.05 USDC / 单次购买 0.02 USDC / 单日测试 0.10 USDC, **所有层取最小值**。
 *   用户只在开始时给一次; 执行过程中**不许被 Agent 自动扩大** (assertNoExpansion 是那条红线)。
 *
 * 与 policy 的关系: `economic-policy.ts` 的 `单笔 $1 / 每日 $10` 是系统级闸门,
 * 这里是**任务级**的第二道闸, 两层都过才放行 (trade.ts 的 taskBudget 参数即为此闸)。
 */

/** M1 硬上限 (leo 定) */
export const M1_BUDGET_LIMITS = { task: 0.05, perPurchase: 0.02, daily: 0.10 } as const;

export type BudgetLayer = 'perPurchase' | 'taskBudget' | 'daily';

export interface TaskBudgetPlan {
  /** 这笔任务最多花多少 (任务级闸) */
  taskBudget: number;
  /** 单次购买上限 (取 min(M1 上限, 任务预算)) */
  perPurchase: number;
  /** 当日测试预算 */
  daily: number;
  requested: { task?: number; perPurchase?: number; daily?: number };
  /** 哪些值被 M1 硬上限收紧了 (诚实留痕, 不静默) */
  clamped: { task: boolean; perPurchase: boolean; daily: boolean };
  why: string[];
}

export interface ResolveResult {
  ok: boolean;
  plan?: TaskBudgetPlan;
  error?: string;
}

function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(String(v));
  if (!Number.isFinite(n)) return undefined;
  return n;
}

/**
 * 解析任务预算。缺省 → M1 默认值; 给多了 → **取 min 并显式记录被收紧** (不静默改成别的数)。
 * 非法输入 → ok:false (不猜)。
 */
export function resolveTaskBudget(
  opts: { taskBudget?: string | number; perPurchase?: string | number; daily?: string | number; limits?: { task: number; perPurchase: number; daily: number } } = {},
): ResolveResult {
  const lim = opts.limits ?? M1_BUDGET_LIMITS;
  const reqTask = num(opts.taskBudget);
  const reqPer = num(opts.perPurchase);
  const reqDaily = num(opts.daily);

  for (const [k, v] of [['taskBudget', opts.taskBudget], ['perPurchase', opts.perPurchase], ['daily', opts.daily]] as const) {
    if (v !== undefined && v !== null && String(v) !== '' && num(v) === undefined) {
      return { ok: false, error: `${k} 不是合法数字: ${String(v)}` };
    }
    const n = num(v);
    if (n !== undefined && n <= 0) return { ok: false, error: `${k} 必须为正数: ${String(v)}` };
  }

  const taskBudget = Math.min(reqTask ?? lim.task, lim.task);
  const perPurchase = Math.min(reqPer ?? lim.perPurchase, lim.perPurchase, taskBudget);
  const daily = Math.min(reqDaily ?? lim.daily, lim.daily);

  const why: string[] = [];
  why.push(`任务预算 ${taskBudget} USDC (M1 硬上限 ${lim.task}${reqTask !== undefined ? `, 你给的 ${reqTask}` : ''})`);
  why.push(`单次购买上限 ${perPurchase} USDC (M1 硬上限 ${lim.perPurchase}${reqPer !== undefined ? `, 你给的 ${reqPer}` : ''})`);
  why.push(`当日预算 ${daily} USDC (M1 硬上限 ${lim.daily}${reqDaily !== undefined ? `, 你给的 ${reqDaily}` : ''})`);
  const clamped = {
    task: reqTask !== undefined && reqTask > lim.task,
    perPurchase: reqPer !== undefined && reqPer > Math.min(lim.perPurchase, taskBudget),
    daily: reqDaily !== undefined && reqDaily > lim.daily,
  };
  if (clamped.task) why.push(`⚠️ 你给的任务预算 ${reqTask} 超过 M1 上限 ${lim.task} → 实际按 ${taskBudget} 执行 (不是 Agent 改的, 是 M1 规则)`);
  if (clamped.perPurchase) why.push(`⚠️ 你给的购买上限 ${reqPer} 被收紧到 ${perPurchase}`);
  if (clamped.daily) why.push(`⚠️ 你给的当日预算 ${reqDaily} 被收紧到 ${daily}`);

  return { ok: true, plan: { taskBudget, perPurchase, daily, requested: { task: reqTask, perPurchase: reqPer, daily: reqDaily }, clamped, why } };
}

export interface PurchaseDecision {
  allowed: boolean;
  reason?: string;
  layer?: BudgetLayer;
  remainingTask?: number;
  remainingDaily?: number;
}

/** 逐层检查一次购买; 哪一层拦住就说清哪一层 (绝不合并成"预算不足"这种糊话)。 */
export function checkPurchaseAllowed(opts: {
  amount: string | number;
  plan: TaskBudgetPlan;
  spentInTask?: number;
  spentToday?: number;
}): PurchaseDecision {
  const amount = num(opts.amount);
  if (amount === undefined) return { allowed: false, layer: undefined, reason: `金额不是合法数字: ${String(opts.amount)}` };
  const spentInTask = opts.spentInTask ?? 0;
  const spentToday = opts.spentToday ?? 0;
  const remainingTask = round6(opts.plan.taskBudget - spentInTask);
  const remainingDaily = round6(opts.plan.daily - spentToday);

  if (amount > opts.plan.perPurchase) {
    const capSource = opts.plan.perPurchase < opts.plan.requested.perPurchase!
      ? `来自任务预算 ${opts.plan.taskBudget}`
      : opts.plan.clamped.perPurchase ? '被 M1 上限收紧后的值' : '你给的上限';
    return { allowed: false, layer: 'perPurchase', reason: `单次购买上限 ${opts.plan.perPurchase} USDC (${capSource}); 这次要 ${amount} USDC`, remainingTask, remainingDaily };
  }
  if (amount > remainingTask) {
    return { allowed: false, layer: 'taskBudget', reason: `任务预算只剩 ${remainingTask} USDC; 这次要 ${amount} USDC`, remainingTask, remainingDaily };
  }
  if (amount > remainingDaily) {
    return { allowed: false, layer: 'daily', reason: `今日预算只剩 ${remainingDaily} USDC; 这次要 ${amount} USDC`, remainingTask, remainingDaily };
  }
  return { allowed: true, remainingTask, remainingDaily };
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** 购买前的"价格与预算影响"预览 (M1 验收第 5 项: 付款前必须看得到) */
export function previewPurchaseImpact(plan: TaskBudgetPlan, amount: string | number, spentToday = 0): string[] {
  const a = num(amount);
  if (a === undefined) return [`金额非法: ${String(amount)}`];
  const pctTask = plan.taskBudget > 0 ? Math.round((a / plan.taskBudget) * 100) : 100;
  return [
    `价格 ${a} USDC · 占任务预算 ${pctTask}%`,
    `购买后: 任务剩余 ${round6(plan.taskBudget - a)} USDC · 今日剩余 ${round6(plan.daily - spentToday - a)} USDC`,
  ];
}

/** 执行中不许扩大预算 (M1 红线: 用户只给一次) */
export function assertNoExpansion(prev: TaskBudgetPlan, next: TaskBudgetPlan): { ok: boolean; reason?: string } {
  if (next.taskBudget > prev.taskBudget + 1e-9) return { ok: false, reason: `任务预算被扩大: ${prev.taskBudget} → ${next.taskBudget} (M1 不允许)` };
  if (next.perPurchase > prev.perPurchase + 1e-9) return { ok: false, reason: `单次上限被扩大: ${prev.perPurchase} → ${next.perPurchase} (M1 不允许)` };
  if (next.daily > prev.daily + 1e-9) return { ok: false, reason: `当日预算被扩大: ${prev.daily} → ${next.daily} (M1 不允许)` };
  return { ok: true };
}
