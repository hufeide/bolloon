/**
 * report-card.ts — M1 薄层 ③: 报告卡
 *
 * M1 **唯一面向人的主出口**。用户只看到这里的东西:
 *   任务 / 结论 / 本次使用(Skill·版本·花费·来源) / 三项校验 / 状态(4 态) / 证据指针 / 卡在哪。
 *
 * 两条硬门 (leo 定, 任一不满足 → M1 失败):
 *   买到 Skill 但没有执行        → 卡片必须"需要你处理", 不许变绿
 *   执行成功但没有报告/证据      → 卡片必须"需要你处理", 不许变绿
 *
 * 内部 10 态生命周期 / 8 态结算事实**只在这里被映射成 4 个人类状态**, 不外泄术语。
 */

/** 用户能理解的 4 个状态 (外面只有这 4 个) */
export type HumanStatus = '准备中' | '正在获取能力' | '正在执行' | '已完成' | '需要你处理';

/** Task Runner 的内部阶段 (不外泄) */
export type TaskStage = 'prepare' | 'acquire' | 'execute' | 'report';

export interface ReportCard {
  task: string;
  conclusion: string;
  conclusionDetail?: string;
  skill?: { name: string; version?: string; dir?: string };
  cost?: { amount: string; currency: string; network: string };
  /** 支付模式与信任分档 (M3): 用户必须看得到"这是本机联调, 不是链上已验证" */
  payment?: { mode: string; chainSettled: boolean; trust: string; txHash?: string };
  sources?: string[];
  checks: {
    outputContract: '通过' | '未通过' | '未执行';
    resourceVerified: '通过' | '未通过' | '未执行';
    taskEvidence: '完整' | '不完整';
  };
  status: HumanStatus;
  executed: boolean;
  paid: boolean;
  durationMs?: number;
  evidenceRef: { goalId?: string; runId?: string; transactionId?: string };
  blocker?: string;
  /** 命中硬门 (M1 验收用) */
  hardGate?: 'bought_not_executed' | 'executed_without_evidence';
  budgetLines?: string[];
}

/** 内部生命周期 → 人类 4 态 (术语不外泄) */
export function humanStatusFrom(opts: { stage?: TaskStage; lifecycle?: string; verdict?: 'ok' | 'blocked' }): HumanStatus {
  if (opts.verdict === 'blocked') return '需要你处理';
  const lc = String(opts.lifecycle || '');
  switch (lc) {
    case 'verified':
      return '已完成';
    case 'settled':
    case 'delivered':
      return '正在执行';
    case 'discovered':
    case 'quoted':
    case 'payment_required':
    case 'paying':
      return '正在获取能力';
    case 'policy_denied':
    case 'delivery_failed':
    case 'verification_failed':
    case 'disputed':
    case 'failed':
      return '需要你处理';
    default:
      break;
  }
  switch (opts.stage) {
    case 'prepare':
      return '准备中';
    case 'acquire':
      return '正在获取能力';
    case 'execute':
      return '正在执行';
    default:
      return '已完成';
  }
}

export interface BuildCardInput {
  task: string;
  conclusion?: string;
  conclusionDetail?: string;
  skill?: { name: string; version?: string; dir?: string };
  cost?: { amount: string; currency: string; network: string };
  payment?: { mode: string; chainSettled: boolean; trust: string; txHash?: string };
  sources?: string[];
  outputContract?: '通过' | '未通过' | '未执行';
  resourceVerified?: '通过' | '未通过' | '未执行';
  evidenceComplete?: boolean;
  executed: boolean;
  paid: boolean;
  lifecycle?: string;
  stage?: TaskStage;
  durationMs?: number;
  evidenceRef: { goalId?: string; runId?: string; transactionId?: string };
  blocker?: string;
  budgetLines?: string[];
}

/**
 * 组装报告卡。两条硬门在这里落地 (不是靠调用方记得检查):
 * 只要"付了没执行"或"执行了没证据", 一律 `需要你处理` + 结论降级为"证据不足"。
 */
export function buildReportCard(input: BuildCardInput): ReportCard {
  const checks = {
    outputContract: input.outputContract ?? '未执行',
    resourceVerified: input.resourceVerified ?? '未执行',
    taskEvidence: input.evidenceComplete ? '完整' : '不完整',
  } as ReportCard['checks'];

  let status = humanStatusFrom({ stage: input.stage, lifecycle: input.lifecycle, verdict: input.blocker ? 'blocked' : 'ok' });
  let hardGate: ReportCard['hardGate'];
  let conclusion = input.conclusion ?? (status === '已完成' ? '证据不足' : '证据不足');
  let blocker = input.blocker;

  if (input.paid && !input.executed) {
    hardGate = 'bought_not_executed';
    status = '需要你处理';
    conclusion = '证据不足';
    blocker = blocker || '买到了 Skill 但没有执行 —— 这一次不算完成任务 (M1 硬门)';
  } else if (input.executed && !input.evidenceComplete) {
    hardGate = 'executed_without_evidence';
    status = '需要你处理';
    conclusion = '证据不足';
    blocker = blocker || '执行了但没有留下完整证据 —— 这一次不算完成任务 (M1 硬门)';
  } else if (input.outputContract === '未通过') {
    status = '需要你处理';
    conclusion = '证据不足';
    blocker = blocker || '输出不符合资源契约 —— 不计成功 (M1 硬门)';
  }

  if (status === '已完成' && (checks.taskEvidence !== '完整' || checks.resourceVerified !== '通过' || checks.outputContract !== '通过')) {
    // 三项校验没全过就不许显示"已完成" (防假绿)
    status = '需要你处理';
    hardGate = hardGate || 'executed_without_evidence';
    conclusion = '证据不足';
    blocker = blocker || `三项校验未全过 (输出契约=${checks.outputContract} · 资源验证=${checks.resourceVerified} · 证据=${checks.taskEvidence})`;
  }

  return {
    task: input.task,
    conclusion,
    conclusionDetail: input.conclusionDetail,
    skill: input.skill,
    cost: input.cost,
    payment: input.payment,
    sources: input.sources,
    checks,
    status,
    executed: input.executed,
    paid: input.paid,
    durationMs: input.durationMs,
    evidenceRef: input.evidenceRef,
    blocker,
    hardGate,
    budgetLines: input.budgetLines,
  };
}

/** CLI 文本渲染 —— M1 的唯一主出口形状 */
export function renderReportCard(card: ReportCard): string {
  const L: string[] = [];
  L.push(`任务: ${card.task}`);
  L.push('');
  L.push(`结论: ${card.conclusion}${card.conclusionDetail ? ` (${card.conclusionDetail})` : ''}`);
  L.push('');
  L.push('本次使用:');
  if (card.skill) L.push(`- Skill: ${card.skill.name}${card.skill.version ? ` @ ${card.skill.version}` : ''}`);
  if (card.cost) L.push(`- 花费: ${card.cost.amount} ${card.cost.currency} (${card.cost.network})`);
  if (card.payment) {
    const modeZh = card.payment.mode === 'local-dev' ? '本机联调 (local-dev)' : card.payment.mode === 'facilitator' ? 'facilitator' : card.payment.mode;
    L.push(`- 支付方式: ${modeZh}`);
    L.push(`- 链上已验证: ${card.payment.chainSettled ? '是' : '否'}${card.payment.chainSettled ? '' : ' (本机联调不冒充链上结算)'}`);
  }
  if (card.sources) L.push(`- 来源: ${card.sources.length} 个${card.sources.length ? ` (${card.sources.slice(0, 3).join(', ')}${card.sources.length > 3 ? ', …' : ''})` : ''}`);
  L.push(`- 输出契约: ${card.checks.outputContract}`);
  L.push(`- 资源验证: ${card.checks.resourceVerified}`);
  L.push(`- 任务证据: ${card.checks.taskEvidence}`);
  if (typeof card.durationMs === 'number') L.push(`- 耗时: ${(card.durationMs / 1000).toFixed(1)} 秒`);
  L.push(`- 状态: ${card.status}`);
  if (card.blocker) {
    L.push('');
    L.push(`卡在哪: ${card.blocker}`);
  }
  if (card.budgetLines && card.budgetLines.length) {
    L.push('');
    L.push('预算:');
    for (const b of card.budgetLines) L.push(`- ${b}`);
  }
  L.push('');
  const ref = card.evidenceRef;
  const parts = [ref.goalId ? `Goal ${ref.goalId}` : null, ref.runId ? `Run ${ref.runId}` : null, ref.transactionId ? `交易 ${ref.transactionId}` : null].filter(Boolean);
  L.push(parts.length ? `查看完整证据: ${parts.join(' · ')}` : '查看完整证据: (无)');
  return L.join('\n');
}
