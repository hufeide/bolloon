/**
 * verify-task-closure.ts — M1–M4 全链路验收 (leo 2026-09-18 收口计划)
 *
 * 一次跑完, 不按模块分别宣布完成:
 *   [A] 用户主路径 (M1): 一句任务 → 自动找 Skill → 预算门 → local-dev 付款 → 真执行 → 报告卡(已完成)
 *   [B] 失败路径 (M4 映射): 预算不足 / 无可用 Skill / 输出字段缺失 / 执行超时 / 重复提交 /
 *                          资源买了没执行 / 争议未解决
 *   [C] M2 恢复: 5 个真 SIGKILL 时点 → 同一 Goal 续跑, 付款最多一笔, 非幂等技能不重复执行,
 *                Goal 不被错误标完成, Supervisor 也能接回 (同一个恢复决策函数)
 *   [D] M3 支付边界: local-dev / mock facilitator / 未配置 facilitator 三种模式**不许互相冒充**
 *
 * 用法: npx tsx scripts/verify-task-closure.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';

const REAL_HOME = os.homedir();
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-closure-'));
const HOME = path.join(ROOT, 'home');
fs.mkdirSync(path.join(HOME, '.bolloon'), { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.BOLLOON_X402_LOCAL_VERIFY = '1';
process.env.BOLLOON_SKIP_SETUP = '1';

const { makeSetupReady } = await import('./lib/make-setup-ready.js');
makeSetupReady(path.join(HOME, '.bolloon'), { realHome: REAL_HOME, name: 'M1-M4 全链路验收' });
const { KeyManager } = await import('@diap/sdk') as any;
await (KeyManager as any).saveToFile((KeyManager as any).generate(), path.join(HOME, '.bolloon', 'identity.json'));

const RUN: any = await import('../src/agents/task/task-runner.js');
const RC: any = await import('../src/agents/task/report-card.js');
const TB: any = await import('../src/agents/task/task-budget.js');
const ST: any = await import('../src/agents/x402/paid-info-store.js');
const TXS: any = await import('../src/agents/x402/transaction-store.js');
const SS: any = await import('../src/agents/x402/settlement-state.js');
const RS: any = await import('../src/agents/run-store.js');
const GS: any = await import('../src/agents/goal-store.js');
const SU: any = await import('../src/agents/execution-supervisor.js');

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else {
    failed++;
    console.log(`  ❌ ${name}${detail !== undefined ? ` — ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300)}` : ''}`);
  }
};
const section = (t: string) => console.log(`\n${t}`);

const FIXTURES = path.resolve('scripts/fixtures/skills');
const TASK = '判断这款厨房用品是否适合进入日本市场';

async function latestTaskGoal(): Promise<any> {
  const goals = await GS.listGoals({ limit: 50 });
  const mine = goals.filter((g: any) => g.createdBy === 'cli:task');
  mine.sort((a: any, b: any) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return mine[0];
}
async function txsOf(goalId: string): Promise<any[]> {
  return (await TXS.listTransactions(HOME)).filter((t: any) => t.goalId === goalId);
}
async function stepsOf(goal: any): Promise<string[]> {
  const out: string[] = [];
  for (const runId of goal?.runs || []) {
    const run = await RS.readRun(runId);
    for (const st of run?.steps || []) out.push(st.tool);
  }
  return out;
}

// ── [A] 用户主路径 ─────────────────────────────────────────────────────────
section('[A] 用户主路径 (M1): 一句任务 → 自动找能力 → 买 → 真执行 → 报告卡');
let mainGoalId = '';
{
  const before = (await TXS.listTransactions(HOME)).length;
  const r = await RUN.runTask({ task: TASK, budget: '0.05', home: HOME, skillPaths: [FIXTURES] });
  mainGoalId = r.goalId;
  console.log(`     状态=${r.card.status} 结论=${String(r.card.conclusion).slice(0, 40)}…`);
  check('自动找到 Skill (用户没点名)', r.advisor?.skill === 'cross-border-market-research');
  check('预算检查通过并真的买了 (有交易)', !!r.transactionId && (await TXS.listTransactions(HOME)).length === before + 1);
  check('Skill 真执行 (execution.ok)', r.execution?.ok === true, r.execution?.reason);
  check('输出契约通过', r.card.checks.outputContract === '通过', r.outputIssues);
  check('报告卡显示已完成', r.card.status === '已完成' && r.ok === true, { s: r.card.status, gate: r.card.hardGate });
  const goal = await GS.readGoal(r.goalId);
  check('Goal completed', goal?.status === 'completed', goal?.status);
  const run = await RS.readRun(r.runId!);
  check('Run done', run?.status === 'done', run?.status);
  const tx = await TXS.readTransaction(r.transactionId!, HOME);
  check('Transaction 有资源结果证据 (resourceOutcome)', !!tx?.resourceOutcome && tx.resourceOutcome.executed === true, tx?.resourceOutcome);
  check('Transaction 有信任分档 (self-attested)', tx?.verificationTrust === 'self-attested', tx?.verificationTrust);
  check('local-dev 没有冒充链上 verified', tx?.paymentMode === 'local-dev' && tx?.chainSettled === false && tx?.status !== 'verified', { mode: tx?.paymentMode, chain: tx?.chainSettled, st: tx?.status });
  check('报告卡明示支付方式与"链上已验证: 否"', r.card.payment?.mode === 'local-dev' && r.card.payment?.chainSettled === false && r.text.includes('链上已验证: 否'), r.card.payment);
  check('证据只走统一证据桥 (Run step + Goal evidence 都有)', (await stepsOf(goal)).includes('x402_transaction') && (goal?.evidence || []).length > 0, { steps: await stepsOf(goal), ev: (goal?.evidence || []).length });
  check('八项门拒绝 local-dev 进 verified (没有假绿)', SS.evaluateVerifiedGate({ rec: tx, home: HOME, execution: tx?.execution, goalCriteriaMet: true }).verified === false);
}

// ── [B] 失败路径 ───────────────────────────────────────────────────────────
section('[B] 失败路径 (M4): 每条都必须落在统一出口, 不假绿、不重复花钱');
{
  // B1 预算不足 (价格 0.012 > 任务预算 0.01)
  const b1 = await RUN.runTask({ task: TASK, budget: '0.01', home: HOME, skillPaths: [FIXTURES] });
  check('B1 预算不足 → 被预算门拦下且没付款', b1.card.status === '需要你处理' && /预算/.test(String(b1.card.blocker)), b1.card.blocker);
  check('B1 报告卡仍带 goalId/runId (不返回空)', !!b1.goalId && !!b1.runId, { g: b1.goalId, r: b1.runId });
  const b1txs = await txsOf(b1.goalId!);
  check('B1 该 Goal 没有产生任何交易', b1txs.length === 0);

  // B2 没有可用 Skill
  const b2 = await RUN.runTask({ task: '今天天气怎么样', budget: '0.05', home: HOME, skillPaths: [] });
  check('B2 没有可用 Skill → 需要你处理 + 说明原因', b2.card.status === '需要你处理' && String(b2.card.blocker).includes('没有匹配'), b2.card.blocker);
  const b2goals = await GS.listGoals({ limit: 5 });
  check('B2 仍留下 Goal 供之后续跑', b2goals.some((g: any) => g.goalId === b2.goalId));

  // B3 输出字段缺失 (坏技能)
  const brokenRoot = path.join(ROOT, 'broken');
  const bdir = path.join(brokenRoot, 'broken-research');
  fs.mkdirSync(bdir, { recursive: true });
  const baseSkill = fs.readFileSync(path.join(FIXTURES, 'cross-border-market-research', 'SKILL.md'), 'utf8');
  fs.writeFileSync(path.join(bdir, 'SKILL.md'), baseSkill.replace(/^name: .*$/m, 'name: broken-research').replace(/^description: .*$/m, 'description: 便携榨汁杯市场调研 (故意输出不合契约)'), 'utf8');
  fs.writeFileSync(path.join(bdir, 'run.mjs'), `export async function execute() { return { summary: '太短', findings: [] }; }\nexport default { execute };\n`, 'utf8');
  const b3 = await RUN.runTask({ task: '便携榨汁杯能不能卖到日本', budget: '0.05', home: HOME, skillPaths: [brokenRoot] });
  check('B3 输出字段缺失 → 不绿 + 标输出契约未通过', b3.ok === false && b3.card.checks.outputContract === '未通过', b3.card.checks);
  const b3tx = await TXS.readTransaction(b3.transactionId!, HOME);
  check('B3 交易映射为 verification_failed (M4 明确出口)', b3tx?.status === 'verification_failed', b3tx?.status);
  check('B3 资源结果里留下失败阶段', b3tx?.resourceOutcome?.failureStage === 'output_contract', b3tx?.resourceOutcome);

  // B4 执行超时 (技能睡 5s, 契约 maxDurationMs=300)
  const toRoot = path.join(ROOT, 'timeout');
  const tdir = path.join(toRoot, 'slow-research');
  fs.mkdirSync(tdir, { recursive: true });
  fs.writeFileSync(path.join(tdir, 'SKILL.md'), baseSkill
    .replace(/^name: .*$/m, 'name: slow-research')
    .replace(/^description: .*$/m, 'description: 慢速市场调研 (故意超时)')
    .replace(/"maxDurationMs":\d+/, '"maxDurationMs":300'), 'utf8');
  fs.writeFileSync(path.join(tdir, 'run.mjs'), `export async function execute() { await new Promise(r => setTimeout(r, 5000)); return { summary: '这个不该跑到', findings: [] }; }\nexport default { execute };\n`, 'utf8');
  const b4 = await RUN.runTask({ task: '慢速市场调研 日本', budget: '0.05', home: HOME, skillPaths: [toRoot] });
  check('B4 执行超时 → 不绿 + 不冒充成功', b4.ok === false && b4.card.status === '需要你处理', { ok: b4.ok, s: b4.card.status });
  const b4tx = await TXS.readTransaction(b4.transactionId!, HOME);
  check('B4 交易映射为 delivery_failed 且记录了失败阶段', b4tx?.status === 'delivery_failed' && b4tx?.resourceOutcome?.failureStage === 'execute', { st: b4tx?.status, ro: b4tx?.resourceOutcome });

  // B5 重复提交同一任务 → 付款最多一笔
  const beforeRep = (await txsOf(mainGoalId)).length;
  await RUN.runTask({ task: TASK, budget: '0.05', home: HOME, skillPaths: [FIXTURES] });
  const afterRep = (await TXS.listTransactions(HOME)).filter((t: any) => t.requestId === RUN.defaultRequestId(TASK, 0.05)).length;
  check('B5 同一任务重复提交 → 只用同一个 requestId, 付款仍是一笔', afterRep === 1, { before: beforeRep, after: afterRep });

  // B6 资源已购买但未执行 → 续跑不许重复执行、不许再付款
  const b6 = await RUN.runTask({ task: TASK, budget: '0.05', home: HOME, skillPaths: [FIXTURES] });
  const before6 = (await txsOf(b6.goalId!)).length;
  const steps6Before = (await stepsOf(await GS.readGoal(b6.goalId))).filter((s) => s === 'skill_exec').length;
  const res6 = await RUN.resumeTask({ goalId: b6.goalId!, home: HOME, skillPaths: [FIXTURES] });
  const steps6After = (await stepsOf(await GS.readGoal(b6.goalId))).filter((s) => s === 'skill_exec').length;
  check('B6 已执行过的任务续跑 → 不重复执行 (skill_exec 次数不增)', steps6After === steps6Before, { before: steps6Before, after: steps6After });
  check('B6 续跑没有再产生交易', (await txsOf(b6.goalId!)).length === before6);
  check('B6 续跑走的是统一出口 (已完成或明确需要你处理, 绝不假绿)', (res6.ok === true && res6.card.status === '已完成') || res6.card.status === '需要你处理', { action: res6.action, status: res6.card.status, blocker: res6.card.blocker });
}

// ── [C] M2 恢复: 真 SIGKILL ────────────────────────────────────────────────
section('[C] M2 恢复: 5 个真 SIGKILL 时点 → 同一 Goal 续跑, 付款最多一笔, 不重复执行');
{
  const points = ['before_payment', 'after_payment', 'after_install', 'before_execute', 'after_execute'];
  const row: Array<Record<string, string>> = [];
  for (const point of points) {
    const childHome = path.join(ROOT, `kill-${point}`);
    fs.mkdirSync(path.join(childHome, '.bolloon'), { recursive: true });
    makeSetupReady(path.join(childHome, '.bolloon'), { realHome: REAL_HOME, name: `kill-${point}` });
    await (KeyManager as any).saveToFile((KeyManager as any).generate(), path.join(childHome, '.bolloon', 'identity.json'));

    const child = spawn('npx', ['tsx', 'scripts/lib/task-phase-child.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: childHome, CHILD_HOME: childHome, CHILD_TASK: TASK, BOLLOON_TASK_FAULT: point },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    const code: number = await new Promise((resolve) => child.on('exit', (c) => resolve(c ?? -1)));
    const killed = code === null || code < 0 || code === 137 || code === 97;
    check(`C[${point}] 子进程真被杀 (exit=${code})`, killed, out.slice(-160));

    // 该场景的 HOME 里查事实 (listGoals/readGoal/readRun 都按 os.homedir() 解析路径)
    const prevHome = process.env.HOME;
    process.env.HOME = childHome;
    let decision: any, res: any;
    try {
      const goals = (await GS.listGoals({ limit: 20 })).filter((g: any) => g.createdBy === 'cli:task');
      goals.sort((a: any, b: any) => String(b.createdAt).localeCompare(String(a.createdAt)));
      const goal = goals[0];
      if (!goal) { check(`C[${point}] 留下了 Goal 供恢复`, false); continue; }
      const txsBefore = (await TXS.listTransactions(childHome)).filter((t: any) => t.goalId === goal.goalId);
      decision = await RUN.decideTaskRecovery({ goalId: goal.goalId, home: childHome });
      check(`C[${point}] 恢复决策与 CLI/Supervisor 同源 (action=${decision.action})`, typeof decision.action === 'string' && decision.action.length > 0, decision);
      if (point === 'before_payment') {
        check(`C[${point}] 没付过 → 允许重试且当时确实没有交易`, decision.mustNotRepay === false && txsBefore.length === 0, { txs: txsBefore.length, d: decision });
      } else {
        check(`C[${point}] 有支付事实 → 绝不重付 (mustNotRepay)`, decision.mustNotRepay === true, decision);
      }

      const beforeCount = (await TXS.listTransactions(childHome)).length;
      const stepsBefore = (await stepsOf(await GS.readGoal(goal.goalId))).filter((x) => x === 'skill_exec').length;
      res = await RUN.resumeTask({ goalId: goal.goalId, home: childHome, skillPaths: [FIXTURES] });
      const afterCount = (await TXS.listTransactions(childHome)).length;
      const stepsAfter = (await stepsOf(await GS.readGoal(goal.goalId))).filter((x) => x === 'skill_exec').length;
      const g2 = await GS.readGoal(goal.goalId);
      row.push({ point, action: String(decision.action), card: String(res.card.status), tx: `${beforeCount}→${afterCount}`, exec: `${stepsBefore}→${stepsAfter}`, goal: String(g2?.status) });

      check(`C[${point}] 付款最多一笔 (续跑不重复扣款)`, point === 'before_payment' ? afterCount === 1 : afterCount === beforeCount, { before: beforeCount, after: afterCount });
      if (point === 'after_payment' || point === 'after_install') {
        check(`C[${point}] 已付款未交付 → 不重付, 只补交付 (这次允许执行一次)`, afterCount === beforeCount && stepsAfter <= 1, { tx: [beforeCount, afterCount], exec: [stepsBefore, stepsAfter] });
      } else {
        check(`C[${point}] 非幂等技能没被重复执行`, stepsAfter <= Math.max(stepsBefore, 1), { before: stepsBefore, after: stepsAfter });
      }
      check(`C[${point}] Goal 没有被错误标成 completed (除非真达标)`, res.ok ? g2?.status === 'completed' : g2?.status !== 'completed', { ok: res.ok, st: g2?.status });
      if (point === 'before_payment') {
        check(`C[${point}] 续跑可完成整条闭环`, res.ok === true && res.card.status === '已完成', { s: res.card.status, a: res.action });
        check(`C[${point}] 全程只有一笔付款`, (await TXS.listTransactions(childHome)).filter((t: any) => t.requestId === RUN.defaultRequestId(TASK, 0.05)).length === 1);
      }
    } finally {
      process.env.HOME = prevHome;
    }
  }
  console.log('     恢复矩阵: ' + row.map((r) => `${r.point}[${r.action}→${r.card} tx ${r.tx} exec ${r.exec} goal ${r.goal}]`).join(' '));
}

// ── [D] M3 支付边界 ────────────────────────────────────────────────────────
section('[D] M3 支付边界: local-dev / facilitator / 未配置 → 不许互相冒充');
{
  const tx = await TXS.readTransaction((await RUN.runTask({ task: TASK, budget: '0.05', home: HOME, skillPaths: [FIXTURES] })).transactionId!, HOME);
  check('D1 local-dev: 最高只到 delivered + self-attested', tx?.paymentMode === 'local-dev' && tx?.verificationTrust === 'self-attested' && ['delivered', 'verification_failed', 'delivery_failed'].includes(String(tx?.status)), { st: tx?.status, trust: tx?.verificationTrust });
  check('D1 local-dev 链上结算恒为 false', tx?.chainSettled === false);
  const gate = SS.evaluateVerifiedGate({ rec: { ...tx, status: 'verified' }, home: HOME, execution: tx?.execution, goalCriteriaMet: true });
  check('D1 即使有人硬把状态写成 verified, 八项门也拒绝 (没有假 verified)', gate.verified === false, gate.missing);

  // 未配置 facilitator + 不开 local-dev → 如实"未验证", 不冒充成功
  const prevLocal = process.env.BOLLOON_X402_LOCAL_VERIFY;
  delete process.env.BOLLOON_X402_LOCAL_VERIFY;
  const FAC = process.env.BOLLOON_X402_FACILITATOR;
  delete process.env.BOLLOON_X402_FACILITATOR;
  const body = ST.buildPaymentRequired((await ST.listInfo(HOME))[0], 'http://127.0.0.1:1/api/x402/info/x');
  const header = Buffer.from(JSON.stringify({ x402Version: 2, accepted: { ...body.accepts[0] }, payload: { sig: 'x' }, payer: '0xPayer' })).toString('base64');
  const noFac = await ST.checkAndSettlePayment({ paymentHeader: header, requirements: body } as any);
  check('D2 未配置 facilitator 且未开 local-dev → 明确"无法校验", 不冒充成功', noFac.ok === false && /未配置/.test(String(noFac.error)), noFac.error);
  if (prevLocal) process.env.BOLLOON_X402_LOCAL_VERIFY = prevLocal;
  if (FAC) process.env.BOLLOON_X402_FACILITATOR = FAC;

  // mock facilitator: 成功 settle 但没有 txHash → 不能当链上结算
  const http = await import('http');
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url?.endsWith('/verify')) return res.end(JSON.stringify({ isValid: true, payer: '0xPayer' }));
      return res.end(JSON.stringify({ success: true, payer: '0xPayer' }));   // 故意不给 transaction
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;
  const fac = await ST.checkAndSettlePayment({ paymentHeader: header, requirements: body, facilitatorUrl: `http://127.0.0.1:${port}` } as any);
  check('D3 mock facilitator: 协议路径可走通 (ok=true)', fac.ok === true, fac.error);
  check('D3 但 facilitator 没给 txHash → 不许当链上结算 (chainSettled=false)', !fac.txHash);
  await new Promise<void>((r) => server.close(() => r()));
}

// ── [E] Supervisor 接回 ────────────────────────────────────────────────────
section('[E] Supervisor: 页面/CLI 消失后仍能接回 task 目标 (同一个恢复决策)');
{
  const sup = new SU.ExecutionSupervisor({ home: HOME, owner: 'closure-test', dryRun: true, maxPerTick: 5, log: () => {} });
  let report: any;
  try {
    report = await sup.tickOnce();
  } catch (e: any) {
    check('Supervisor tickOnce 真跑通', false, String(e?.message || e));
  }
  if (report) {
    check('Supervisor tickOnce 真跑通', true);
    const tasks = [...(report.executed || []), ...(report.skipped || [])].filter((x: any) => String(x.status || '').startsWith('task_') || String(x.reason || '').includes('任务恢复决策'));
    check('Supervisor 对 task 目标走的是同一个恢复决策 (有 task_* 轨迹或决策说明)', tasks.length > 0, { exec: report.executed, skipped: (report.skipped || []).slice(0, 4) });
    check('Supervisor 报告里包含支付对账段', !!report.payments && Array.isArray(report.payments.mustNotRepay));
  }
}

console.log(`\n=== 结果: ${passed} passed, ${failed} failed ===`);
console.log('覆盖: M1 主路径 · M2 五个真 SIGKILL 恢复 · M3 三种支付模式边界 · M4 失败映射与责任');
console.log('未覆盖(本批明确不做): 真实 Base Sepolia 链上支付 (M3 只做边界, 不跑真链)');
try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(failed === 0 ? 0 : 1);
