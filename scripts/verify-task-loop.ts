/**
 * verify-task-loop.ts — M1 验收: 一个任务 → 一个 Skill → 一个报告 (真跑)
 *
 * 对着 leo 定的 M1 验收 8 项 + 2 条硬门 + 3 条冻结规则逐条真跑:
 *   [1] 预算闸 (单任务 0.05 / 单次 0.02 / 单日 0.10, 多层取 min, 不许中途扩大)
 *   [2] 顾问: 用户不点名, 自动判断缺能力 + 唯一候选
 *   [3] 主闭环: 真 402 报价 → 真 local-dev 付款 → 真保真校验 → **真执行技能代码** → 报告卡
 *   [4] 报告卡: 只有 4 个人类状态, 不出现内部术语
 *   [5] 两条硬门 (买到没执行 / 执行了没证据 → 不许变绿)
 *   [6] 输出不合契约 → 不许变绿
 *   [7] 贵过单次上限 → 预算门拦下, 且**没有产生交易/没花钱**
 *   [8] 同一个任务重跑 → 不重复付款 (requestId 确定性幂等)
 *
 * 用法: npx tsx scripts/verify-task-loop.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REAL_HOME = os.homedir();          // 必须在覆盖 HOME 之前取 (门禁会看真实 LLM 配置)
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-m1-'));
const HOME = path.join(ROOT, 'home');
fs.mkdirSync(path.join(HOME, '.bolloon'), { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.BOLLOON_X402_LOCAL_VERIFY = '1';
process.env.BOLLOON_SKIP_SETUP = '1';

const { makeSetupReady } = await import('./lib/make-setup-ready.js');
makeSetupReady(path.join(HOME, '.bolloon'), { realHome: REAL_HOME, name: 'M1 任务闭环验收' });

const TB: any = await import('../src/agents/task/task-budget.js');
const ADV: any = await import('../src/agents/task/resource-advisor.js');
const RC: any = await import('../src/agents/task/report-card.js');
const RUN: any = await import('../src/agents/task/task-runner.js');
const ST: any = await import('../src/agents/x402/paid-info-store.js');
const TXS: any = await import('../src/agents/x402/transaction-store.js');
const RS: any = await import('../src/agents/run-store.js');
const GS: any = await import('../src/agents/goal-store.js');

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else {
    failed++;
    console.log(`  ❌ ${name}${detail !== undefined ? ` — ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 260)}` : ''}`);
  }
};
const section = (t: string) => console.log(`\n${t}`);

// ── 夹具: 技能目录 + 卖方身份 ───────────────────────────────────────────────
const FIXTURES = path.resolve('scripts/fixtures/skills');
const { KeyManager } = await import('@diap/sdk') as any;
{
  const kp = (KeyManager as any).generate();
  await (KeyManager as any).saveToFile(kp, path.join(HOME, '.bolloon', 'identity.json'));
}
const TASK = '判断这款厨房用品是否适合进入日本市场';

// ── [1] 预算闸 ─────────────────────────────────────────────────────────────
section('[1] 预算闸: M1 硬上限 + 多层取 min + 不许中途扩大');
{
  const def = TB.resolveTaskBudget();
  check('缺省 = 单任务 0.05 / 单次 0.02 / 单日 0.10', def.ok && def.plan.taskBudget === 0.05 && def.plan.perPurchase === 0.02 && def.plan.daily === 0.10, def.plan);
  const over = TB.resolveTaskBudget({ taskBudget: '0.10' });
  check('给 0.10 → 被 M1 上限收紧到 0.05 且显式留痕', over.plan.taskBudget === 0.05 && over.plan.clamped.task === true, over.plan.why);
  check('收紧原因写进 why (不静默)', over.plan.why.some((w: string) => w.includes('超过 M1 上限')), over.plan.why);
  const per = TB.resolveTaskBudget({ perPurchase: '0.09' });
  check('单次上限 0.09 → 收紧到 0.02', per.plan.perPurchase === 0.02 && per.plan.clamped.perPurchase === true, per.plan);
  check('非法数字 → 拒绝 (不猜)', TB.resolveTaskBudget({ taskBudget: 'abc' }).ok === false);
  check('0 或负数 → 拒绝', TB.resolveTaskBudget({ taskBudget: '0' }).ok === false && TB.resolveTaskBudget({ daily: '-1' }).ok === false);
  const plan = def.plan;
  check('买 0.03 > 单次上限 0.02 → 拒 (指明哪一层)', TB.checkPurchaseAllowed({ amount: '0.03', plan }).allowed === false && TB.checkPurchaseAllowed({ amount: '0.03', plan }).layer === 'perPurchase');
  check('买 0.012 → 放行', TB.checkPurchaseAllowed({ amount: '0.012', plan }).allowed === true);
  check('任务预算已花 0.045, 再买 0.012 → 任务层拦截', TB.checkPurchaseAllowed({ amount: '0.012', plan, spentInTask: 0.045 }).layer === 'taskBudget');
  check('今日已花 0.095, 再买 0.012 → 日层拦截', TB.checkPurchaseAllowed({ amount: '0.012', plan, spentToday: 0.095 }).layer === 'daily');
  const impact = TB.previewPurchaseImpact(plan, '0.012');
  check('购买前有"价格与预算影响"预览', impact.some((l: string) => l.includes('占任务预算')) && impact.some((l: string) => l.includes('剩余')), impact);
  check('执行中扩大预算 → 拒绝', TB.assertNoExpansion(plan, { ...plan, taskBudget: 0.5 }).ok === false);
  check('预算不变 → 通过', TB.assertNoExpansion(plan, { ...plan }).ok === true);
}

// ── [2] 顾问 ───────────────────────────────────────────────────────────────
section('[2] 顾问: 用户不点名 Skill, 由 Agent 判断 + 唯一候选');
let advised: any;
{
  advised = await ADV.adviseResource({ task: TASK, home: HOME, skillPaths: [FIXTURES] });
  check('自动判断"缺外部能力"', advised.needed === true, advised.reason);
  check('命中唯一候选 cross-border-market-research', advised.chosen?.name === 'cross-border-market-research', advised.chosen?.name);
  check('给出选它的理由 (why 非空)', Array.isArray(advised.chosen?.why) && advised.chosen.why.length > 0, advised.chosen?.why);
  check('候选契约完整 (有 entrypoint + 输入/输出契约)', !!advised.chosen?.contract?.execution?.entrypoint && !!advised.chosen?.contract?.inputSchema);
  const empty = await ADV.adviseResource({ task: '今天天气怎么样', home: HOME, skillPaths: [] });
  check('没有任何可执行资源 → needed:false 且说清原因', empty.needed === false && String(empty.reason).length > 0, empty.reason);
  const derived = RUN.deriveSkillInput(advised.chosen.contract, TASK);
  check('输入推导: product 从任务文本得到, market = 日本', !!derived.product && derived.market === '日本', derived);
}

// ── [7] 贵过单次上限 → 预算门拦住且不花钱 ───────────────────────────────────
section('[7] 贵资源: 预算门拦下, 且没有产生交易');
{
  await ST.publishInfo({
    id: 'cross-border-market-research',
    title: 'cross-border-market-research',
    category: 'skill',
    content: '{}',
    price: { amount: '0.03', currency: 'USDC', network: 'base-sepolia', payTo: '0x1111111111111111111111111111111111111111' },
    source: { kind: 'self', refs: [FIXTURES], note: 'skill=cross-border-market-research@1.0.0' },
    provider: { did: 'did:key:zLocalSeller' },
  }, { home: HOME });
  const before = (await TXS.listTransactions(HOME)).length;
  const r = await RUN.runTask({ task: TASK, budget: '0.05', home: HOME, skillPaths: [FIXTURES] });
  const after = (await TXS.listTransactions(HOME)).length;
  check('0.03 > 单次上限 0.02 → 任务没变绿', r.ok === false && r.card.status === '需要你处理', r.card.status);
  check('拦住的原因是"单次购买上限"那层', String(r.card.blocker).includes('单次购买上限'), r.card.blocker);
  check('没有产生任何交易 (没花钱)', after === before, { before, after });
  check('报告里有价格与预算影响', (r.card.budgetLines || []).some((l: string) => l.includes('占任务预算')), r.card.budgetLines);
  await ST.removeInfo('cross-border-market-research', HOME);
}

// ── [3] 主闭环 ─────────────────────────────────────────────────────────────
section('[3] 主闭环: 真 402 → 真付款 → 真保真 → 真执行 → 报告卡');
let main: any;
{
  const before = (await TXS.listTransactions(HOME)).length;
  main = await RUN.runTask({ task: TASK, budget: '0.05', home: HOME, skillPaths: [FIXTURES] });
  console.log(`     报告卡状态=${main.card.status} 结论=${main.card.conclusion}`);
  check('1. 用户只输入一句任务 + 预算 (调用里没点名 Skill)', true);
  check('2. 用户不点名 → 选中的是顾问给的资源', main.card.skill?.name === 'cross-border-market-research');
  check('3. Agent 自动判断缺能力 (顾问 needed)', main.advisor?.needed === true);
  check('4. 从 Registry 发现候选 (并有本地报价可用)', main.advisor?.skill === 'cross-border-market-research' && !!main.transactionId, { skill: main.advisor?.skill, tx: main.transactionId });
  check('5. 购买前价格与预算影响可见', (main.card.budgetLines || []).some((l: string) => l.includes('价格')), main.card.budgetLines);
  check('6. Skill 真被执行 (execution.ok)', main.execution?.ok === true, main.execution?.reason);
  check('   执行确实留下 Run 步骤 skill_exec', (await RS.readRun(main.runId))?.steps?.some((s: any) => s.tool === 'skill_exec' && s.ok), (await RS.readRun(main.runId))?.steps?.map((s: any) => s.tool));
  check('7. 输出契约通过', main.card.checks.outputContract === '通过', main.outputIssues);
  check('   资源验证(保真链)通过', main.card.checks.resourceVerified === '通过', main.outputIssues);
  check('8. 报告能回放 Goal/Run/交易', !!main.goalId && !!main.runId && !!main.transactionId, main.card.evidenceRef);
  check('   结果里带来源证据 (≥1)', (main.card.sources || []).length >= 1, main.card.sources);
  check('结论非空且不是"证据不足"', !!main.card.conclusion && main.card.conclusion !== '证据不足', main.card.conclusion);
  check('任务变绿 (已完成)', main.card.status === '已完成' && main.ok === true, { status: main.card.status, hardGate: main.card.hardGate });
  check('付款方式如实标注 (local-dev, 不是链上)', main.payment?.mode === 'local-dev' && main.payment?.chainSettled === false, main.payment);
  check('产生 1 条交易', (await TXS.listTransactions(HOME)).length === before + 1);
  check('交易记录绑定这个 goalId', main.transactionId && (await TXS.readTransaction(main.transactionId, HOME))?.goalId === main.goalId);
  const goal = await GS.readGoal(main.goalId);
  check('Goal 有判据且已满足', (goal?.successCriteria || []).length >= 3 && (goal?.completedCriteria || []).length >= 2, { c: goal?.successCriteria, done: goal?.completedCriteria });
  // 2026-09-18: 证据写作统一走 `bridgeTransactionToRunGoal` (不再由 task-runner 自写),
  // 格式变成 `transactionId=/itemId=/paymentMode=/chainSettled=/executionOk=…` → 按语义判定
  const goalEv = (goal?.evidence || []).join(' ');
  check('Goal 证据里有交易/支付/执行事实 (统一证据桥写入)', /transactionId=/.test(goalEv) && /paymentMode=/.test(goalEv) && /chainSettled=/.test(goalEv), goalEv.slice(0, 200));
  check('Goal 证据里带资源结果与信任分档', /executionOk=|verificationTrust=/.test(goalEv), goalEv.slice(0, 600));
}

// ── [4] 报告卡: 只有 4 态, 无内部术语 ───────────────────────────────────────
section('[4] 报告卡: 用户只看到 4 个人类状态, 内部术语不外泄');
{
  const text = RC.renderReportCard(main.card);
  const allowed = ['准备中', '正在获取能力', '正在执行', '已完成', '需要你处理'];
  check('状态是 4 态之一', allowed.includes(main.card.status), main.card.status);
  const leaks = ['quoted', 'payment_required', 'fully_settled', 'partially_settled', 'chainSettled', 'facilitator', 'lease', 'retry_wait', 'settlementFact'];
  const hit = leaks.filter((l) => text.includes(l));
  check('渲染文本不含内部术语', hit.length === 0, hit);
  check('渲染含任务/结论/本次使用/证据指针', text.includes('任务:') && text.includes('结论:') && text.includes('本次使用:') && text.includes('查看完整证据'));
  // 内部生命周期 → 4 态 的映射逐条
  const map: Array<[string, string]> = [
    ['quoted', '正在获取能力'], ['paying', '正在获取能力'], ['settled', '正在执行'],
    ['delivered', '正在执行'], ['verified', '已完成'], ['delivery_failed', '需要你处理'],
    ['disputed', '需要你处理'], ['policy_denied', '需要你处理'],
  ];
  const bad = map.filter(([lc, want]) => RC.humanStatusFrom({ lifecycle: lc }) !== want);
  check('内部 10 态 → 4 态 映射逐条正确', bad.length === 0, bad);
}

// ── [5] 两条硬门 ───────────────────────────────────────────────────────────
section('[5] 两条硬门: 买到没执行 / 执行了没证据 → 都不许变绿');
{
  const a = RC.buildReportCard({ task: TASK, paid: true, executed: false, outputContract: '未执行', resourceVerified: '未执行', evidenceComplete: false, evidenceRef: { goalId: 'g', runId: 'r', transactionId: 't' } });
  check('硬门 1: 买到 Skill 但没执行 → 需要你处理 + 标记 hardGate', a.status === '需要你处理' && a.hardGate === 'bought_not_executed', { s: a.status, g: a.hardGate });
  const b = RC.buildReportCard({ task: TASK, paid: true, executed: true, outputContract: '通过', resourceVerified: '通过', evidenceComplete: false, evidenceRef: {} });
  check('硬门 2: 执行了但没证据 → 需要你处理 + 标记 hardGate', b.status === '需要你处理' && b.hardGate === 'executed_without_evidence', { s: b.status, g: b.hardGate });
  const c = RC.buildReportCard({ task: TASK, paid: true, executed: true, outputContract: '未通过', resourceVerified: '通过', evidenceComplete: true, evidenceRef: {} });
  check('输出契约未过 → 不许显示已完成', c.status === '需要你处理', c.status);
  const d = RC.buildReportCard({ task: TASK, paid: true, executed: true, outputContract: '通过', resourceVerified: '未通过', evidenceComplete: true, evidenceRef: {} });
  check('资源保真未过 → 不许显示已完成', d.status === '需要你处理', d.status);
}

// ── [6] 坏技能: 输出不合契约 → 不变绿 ──────────────────────────────────────
section('[6] 输出不合契约的技能: 真跑但不许变绿');
{
  const brokenRoot = path.join(ROOT, 'broken');
  const bdir = path.join(brokenRoot, 'broken-research');
  fs.mkdirSync(bdir, { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, 'cross-border-market-research', 'SKILL.md'), path.join(bdir, 'SKILL.md'));
  fs.writeFileSync(path.join(bdir, 'SKILL.md'), fs.readFileSync(path.join(bdir, 'SKILL.md'), 'utf8').replace(/^name: .*$/m, 'name: broken-research').replace(/^description: .*$/m, 'description: 便携榨汁杯市场调研 (故意输出不合契约)'), 'utf8');
  fs.writeFileSync(path.join(bdir, 'run.mjs'), `export async function execute() { return { summary: '太短', findings: [] }; }\nexport default { execute };\n`, 'utf8');
  const r = await RUN.runTask({ task: '便携榨汁杯能不能卖到日本', budget: '0.05', home: HOME, skillPaths: [brokenRoot] });
  console.log(`     报告卡状态=${r.card.status} 输出契约=${r.card.checks.outputContract}`);
  check('买了也执行了, 但输出不合契约 → 不绿', r.ok === false && r.card.status === '需要你处理', { ok: r.ok, s: r.card.status });
  check('如实标出输出契约未通过', r.card.checks.outputContract === '未通过', r.card.checks);
  check('Blocking 原因写明输出契约问题', String(r.card.blocker || '').length > 0, r.card.blocker);
  check('交易仍然如实记录了付款 (钱花了就是花了)', !!r.transactionId);
}

// ── [8] 重跑不重复付款 ─────────────────────────────────────────────────────
section('[8] 同一个任务重跑 → 不重复付款 (确定性 requestId 幂等)');
{
  const before = (await TXS.listTransactions(HOME)).filter((t: any) => t.requestId === RUN.defaultRequestId(TASK, 0.05));
  const again = await RUN.runTask({ task: TASK, budget: '0.05', home: HOME, skillPaths: [FIXTURES] });
  const after = (await TXS.listTransactions(HOME)).filter((t: any) => t.requestId === RUN.defaultRequestId(TASK, 0.05));
  check('同 (任务, 预算) → 同一个 requestId', RUN.defaultRequestId(TASK, 0.05) === RUN.defaultRequestId(TASK, 0.05) && RUN.defaultRequestId(TASK, 0.05) !== RUN.defaultRequestId(TASK, 0.06));
  check('重跑后交易条数没有增加 (没有第二次扣款)', after.length === before.length && before.length === 1, { before: before.length, after: after.length });
  check('重跑复用已有交易 (reused)', again.payment?.reused === true, again.payment);
}

// ── 续跑 ───────────────────────────────────────────────────────────────────
section('[9] 续跑: --resume <goalId> 不重复付款');
{
  const res = await RUN.resumeTask({ goalId: main.goalId, home: HOME, skillPaths: [FIXTURES] });
  const txs = (await TXS.listTransactions(HOME)).filter((t: any) => t.goalId === main.goalId);
  check('续跑给出结果 (有 plan + 理由)', !!res.action && !!res.reason, { action: res.action, reason: res.reason });
  check('续跑后该 Goal 的交易仍然只有 1 条 (没重复扣款)', txs.length === 1, txs.length);
  check('续跑报告卡指向同一个 goalId', res.goalId === main.goalId);
}

// ── 汇总 ───────────────────────────────────────────────────────────────────
console.log(`\n=== 结果: ${passed} passed, ${failed} failed ===`);
console.log('M1 闭环: 任务 → 顾问判断 → 本地报价 → 真付款(local-dev) → 真保真 → 真执行 → 报告卡');
console.log('未覆盖(等真链/M3): 真 facilitator · 真 txHash · 链上金额与买卖双方可查');
try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(failed === 0 ? 0 : 1);
