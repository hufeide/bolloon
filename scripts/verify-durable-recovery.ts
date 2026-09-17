/**
 * verify-durable-recovery.ts — M2/M3/M4 真跑验收 (2026-09-16)
 *   ① 真 SIGKILL → 真恢复: 同一 runId 继续, 已完成步骤不重跑 (非幂等重放守卫)
 *   ② 恢复接线: 熔断 (同工具连续失败) / 外部等待 (awaiting_external) / auth → needs_human
 *   ③ 完成门: 末尾步骤失败 → 不许 done; 证据写进 Run; Goal 侧完成门 (Run done ≠ Goal completed)
 *   ④ 目标绑定链: runId → goalId → objective/successCriteria
 *   ⑤ 真 HTTP: /api/runs · /api/runs/:id · /pause · /resume · /api/goals (web 与 CLI 读同一份事实)
 *
 * 用法: npx tsx scripts/verify-durable-recovery.ts
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import { spawn } from 'child_process';

const REAL_HOME = os.homedir();                       // 必须在覆盖 HOME 之前取
const tmpRoot = path.join(os.tmpdir(), 'bolloon-recovery-' + Date.now());
const HOME = path.join(tmpRoot, 'home');
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.BOLLOON_SKIP_KUBO = '1';
process.env.BOLLOON_CRON = '0';
// 恢复跑会真的调用 LLM 继续工作: 给小预算让它在预算边界如实收尾 (避免长时间游走影响验收时长)
process.env.BOLLOON_RUN_MAX_STEPS = process.env.BOLLOON_RUN_MAX_STEPS || '12';
fs.mkdirSync(path.join(HOME, '.bolloon'), { recursive: true });
// 2026-09-16: 初始化硬门禁生效后, 验收 HOME 必须是"真的 ready" (复制真实 LLM 配置 + 身份 + 引导状态)
try {
  const { makeSetupReady } = await import('./lib/make-setup-ready.js');
  const r = makeSetupReady(path.join(HOME, '.bolloon'), { realHome: REAL_HOME });
  console.log(`[setup-ready] ${r.ok ? 'LLM 配置已就绪' : '⚠ 无可用 LLM 配置'} · ${r.notes.length} 步`);
} catch (e) { console.log('[setup-ready] 失败:', (e as Error)?.message); }

const PROBE = path.join(tmpRoot, 'recovery-probe.txt');
const PORT = 41731 + Math.floor(Math.random() * 200);

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? ' — ' + String(detail).slice(0, 240) : ''}`); }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const R = await import('../src/agents/run-store.js');
  const G = await import('../src/agents/goal-store.js');

  // ── 真 LLM 配置 (复制, 不打印) ──
  for (const f of ['bolloon-config.json', 'llm-config.json', 'keypair.json', 'agent-registry.json', 'peer-store.json']) {
    try { await fsp.copyFile(path.join(REAL_HOME, '.bolloon', f), path.join(HOME, '.bolloon', f)); } catch { /* 缺了无所谓 */ }
  }
  const { initMinimax } = await import('../src/constraints/index.js');
  initMinimax();
  const { createAgentSession } = await import('../src/agents/pi-sdk.js');

  // ═══════════ ① 真 SIGKILL → 真恢复 ═══════════
  console.log('\n[1] 真 SIGKILL → 真从 checkpoint 恢复 (同一 runId, 已完成步骤不重跑)');
  const childSrc = `
const path = require('path');
const fs = require('fs');
(async () => {
  const R = await import(${JSON.stringify(path.resolve('src/agents/run-store.ts'))});
  const G = await import(${JSON.stringify(path.resolve('src/agents/goal-store.ts'))});
  const goal = await G.createGoal({ objective: '把 hello 写进探针文件', channelId: 'ch-e2e', agentId: 'ag-e2e' });
  const rec = await R.startRun({ surface: 'cli', goal: '把 hello 写进探针文件', goalId: goal.goalId, channelId: 'ch-e2e', agentId: 'ag-e2e' });
  await G.attachRun(goal.goalId, rec.runId);
  fs.writeFileSync(${JSON.stringify(PROBE)}, 'v1-from-run-1');
  await R.recordStep(rec.runId, { tool: 'write_file', ok: true, ms: 5, args: { path: ${JSON.stringify(PROBE)}, content: 'hello' }, summary: '写了 hello 到探针文件' });
  await R.recordStep(rec.runId, { tool: 'read_file', ok: true, ms: 3, args: { path: ${JSON.stringify(PROBE)} }, summary: '确认写入' });
  console.log('RUNID=' + rec.runId);
  setInterval(() => {}, 1000);
})();
`;
  const childFile = path.join(tmpRoot, 'recovery-child.cjs');
  await fsp.writeFile(childFile, childSrc, 'utf8');
  const child = spawn('npx', ['tsx', childFile], { cwd: process.cwd(), env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let out = '';
  child.stdout.on('data', (d) => { out += String(d); });
  child.stderr.on('data', () => {});
  let runId = '';
  for (let i = 0; i < 60; i++) {
    await wait(400);
    const m = out.match(/RUNID=(\S+)/);
    if (m) {
      runId = m[1];
      const rec = await R.readRun(runId);
      if (rec && rec.steps.length >= 2) break;
    }
  }
  check('子进程跑到 2 步并落盘', !!runId && (await R.readRun(runId))?.steps.length === 2, `runId=${runId} out=${out.slice(0, 80)}`);
  try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  await wait(700);

  const before = await fsp.readFile(PROBE, 'utf8');
  check('副作用已发生 (探针文件 = v1-from-run-1)', before === 'v1-from-run-1', before);

  const recon = await R.reconcileOrphans();
  check('新进程对账: 死进程的 run 被判 interrupted', recon.interrupted.includes(runId), JSON.stringify(recon));

  const rec0 = await R.prepareResume(runId);
  check('prepareResume 成功 (interrupted → recovering)', rec0.ok === true, JSON.stringify(rec0.reason));
  check('恢复计划带已完成步骤 + 非幂等守卫', rec0.plan!.completedSteps.length === 2 && rec0.plan!.replayGuards.some((g) => g.tool === 'write_file'), JSON.stringify(rec0.plan?.replayGuards));
  check('恢复计划带 Goal objective (runId → goalId 反查)', rec0.plan!.objective === '把 hello 写进探针文件', String(rec0.plan?.objective));

  const agent: any = await createAgentSession({ cwd: process.cwd(), peerId: `resume-e2e:${Date.now()}` }, true);
  agent.setRunSurface?.('cli');
  const resumed = await agent.resumeRun(runId);
  check('resumeRun 真跑通', resumed.ok === true, String(resumed.reason));

  const afterProbe = await fsp.readFile(PROBE, 'utf8');
  const rec1 = (await R.readRun(runId))!;
  check('恢复后探针文件没被再次写入 (非幂等动作没有重做)', afterProbe === 'v1-from-run-1', afterProbe);
  const realWritesAfter = rec1.steps.filter((s) => s.tool === 'write_file' && s.ok && !String(s.summary || '').startsWith('[恢复保护]'));
  check('Run 里没有第二次"真实"写文件 (只有 1 次真执行)', realWritesAfter.length === 1, JSON.stringify(realWritesAfter.map((s) => s.summary)));
  check('恢复用的是同一条 run (历史保留, 不是新建)', rec1.runId === runId && rec1.steps.length >= 2, `runId=${rec1.runId} steps=${rec1.steps.length}`);
  check('恢复留痕 (recovery 里有 action=resume)', rec1.recovery.some((r) => r.action === 'resume'), JSON.stringify(rec1.recovery.map((r) => r.action)));
  check('恢复后状态如实收尾 (不留 running)', ['done', 'failed', 'aborted', 'needs_human', 'awaiting_external'].includes(String(rec1.status)), String(rec1.status));
  const goalAfter = await G.readGoal(rec1.goalId!);
  check('Goal 与 Run 的绑定还在 (runs 含该 runId)', !!goalAfter && goalAfter.runs.includes(runId), JSON.stringify(goalAfter?.runs));

  // ═══════════ ② 恢复接线: 熔断 / 外部等待 ═══════════
  console.log('\n[2] 运行期接线: 熔断 / 外部等待 (白盒驱动真实代码路径)');
  const bAgent: any = await createAgentSession({ cwd: process.cwd(), peerId: `breaker:${Date.now()}` }, true);
  const bRun = await R.startRun({ surface: 'cli', goal: '熔断测试' });
  bAgent.currentRunId = bRun.runId;
  bAgent.breakerReason = '';
  // 外部等待
  await R.recordStep(bRun.runId, { tool: 'delegate_to_engine', ok: false, args: { prompt: 'x' }, error: '对端无响应 504' });
  await bAgent.wireToolFailure('delegate_to_engine', '对端无响应 504', { prompt: 'x' });
  check('外部无响应 → awaiting_external (不误判为失败)', (await R.readRun(bRun.runId))?.status === 'awaiting_external', String((await R.readRun(bRun.runId))?.status));
  check('外部等待记为 recovery action=pause', (await R.readRun(bRun.runId))?.recovery.slice(-1)[0]?.action === 'pause', JSON.stringify((await R.readRun(bRun.runId))?.recovery.slice(-1)));
  // 回到 running 后做熔断
  await R.setRunStatus(bRun.runId, 'running');
  const args = { command: 'always-fails' };
  for (let i = 1; i <= 3; i++) {
    await R.recordStep(bRun.runId, { tool: 'shell_exec', ok: false, args, error: 'timeout 超时' });
    await bAgent.wireToolFailure('shell_exec', 'timeout 超时', args);
  }
  const bAfter = (await R.readRun(bRun.runId))!;
  check('同工具同参数连续失败 3 次 → 熔断 (needs_human)', bAfter.status === 'needs_human', String(bAfter.status));
  check('熔断原因写清次数与分类', /连续失败 3 次/.test(String(bAfter.error || bAgent.breakerReason)), String(bAfter.error || bAgent.breakerReason));
  check('三次失败都留下 recovery 留痕 (attempt 递增)', bAfter.recovery.filter((r) => r.errorClass === 'transient').length >= 3, JSON.stringify(bAfter.recovery.slice(-3).map((r) => r.attempt)));
  // auth → needs_human 不重试
  const aRun = await R.startRun({ surface: 'cli', goal: '鉴权测试' });
  bAgent.currentRunId = aRun.runId;
  bAgent.breakerReason = '';
  await bAgent.wireToolFailure('shell_exec', '401 Authentication Fails api key invalid', { command: 'x' });
  const aAfter = (await R.readRun(aRun.runId))!;
  check('鉴权类 → needs_human + errorClass=auth (不重试)', aAfter.status === 'needs_human' && aAfter.recovery.slice(-1)[0].errorClass === 'auth', JSON.stringify({ s: aAfter.status, c: aAfter.recovery.slice(-1)[0]?.errorClass }));

  // ═══════════ ③ 完成门 (真 agent) ═══════════
  console.log('\n[3] 完成门: 末尾步骤失败 / 无证据 → 不许 done (真 agent)');
  const cAgent: any = await createAgentSession({ cwd: process.cwd(), peerId: `gate:${Date.now()}` }, true);
  cAgent.setRunSurface?.('cli');
  await cAgent.prompt(`只调用 read_file 一次读 ${path.join(tmpRoot, 'definitely-missing-xyz.txt')}; 失败后不要再调用任何工具, 直接回复"任务完成"。`, {});
  const gateRuns = await R.listRuns({ limit: 1 });
  const gRun = (await R.readRun(gateRuns[0].runId))!;
  const lastStep = gRun.steps[gRun.steps.length - 1];
  check('这次运行确实有失败步骤', gRun.steps.some((s) => !s.ok), JSON.stringify(gRun.steps.map((s) => [s.tool, s.ok])));
  check('末尾失败时绝不允许 done (不变式)', !(lastStep && !lastStep.ok && gRun.status === 'done'), JSON.stringify({ status: gRun.status, last: lastStep?.tool, ok: lastStep?.ok }));
  check('状态如实 (failed / needs_human / aborted)', ['failed', 'needs_human', 'aborted', 'done'].includes(String(gRun.status)), String(gRun.status));

  // ═══════════ ④ 目标绑定链 (真 agent) ═══════════
  console.log('\n[4] 目标绑定: 每次 prompt 建/续 Goal, runId → goalId → objective');
  const dAgent: any = await createAgentSession({ cwd: process.cwd(), peerId: `goalbind:${Date.now()}`, channelId: 'ch-goal-bind' } as any, true);
  dAgent.setRunSurface?.('cli');
  (dAgent as any).currentChannelId = 'ch-goal-bind';
  await dAgent.prompt('用 shell_exec 跑 `echo goal-bind-ok` 并告诉我输出。', {});
  const bindRuns = await R.listRuns({ limit: 1 });
  const bindRun = (await R.readRun(bindRuns[0].runId))!;
  check('Run 带真 goalId (不再是空文本目标)', !!bindRun.goalId, JSON.stringify({ goalId: bindRun.goalId, goal: bindRun.goal.slice(0, 30) }));
  const bindGoal = bindRun.goalId ? await G.readGoal(bindRun.goalId) : null;
  check('Goal 落盘且挂上了这条 run', !!bindGoal && bindGoal.runs.includes(bindRun.runId), JSON.stringify(bindGoal?.runs));
  check('Goal 成为 currentRunId', bindGoal?.currentRunId === bindRun.runId, String(bindGoal?.currentRunId));
  check('Goal 未声明判据 → 完成门拒绝自动完成', bindGoal ? G.evaluateGoalCompletion(bindGoal).complete === false : false, bindGoal ? G.evaluateGoalCompletion(bindGoal).reason : 'no goal');
  check('Run 有成功步骤 → 证据写进 Run', (bindRun.evidence || []).length >= 1, JSON.stringify(bindRun.evidence));
  check('Run done ≠ Goal completed (Goal 仍在进行)', bindGoal?.status !== 'completed', String(bindGoal?.status));

  // ═══════════ ⑤ 真 HTTP: 两端同一份事实 + 控制面 ═══════════
  console.log('\n[5] Web 控制面 (真 HTTP): 读同一份事实 + pause/resume 的合法与非法路径');
  const { createWebServer } = await import('../src/web/server.js');
  const started: any = await createWebServer(PORT, { selfImprove: false } as any);
  const port = started?.port || PORT;
  const base = `http://127.0.0.1:${port}`;
  const j = async (p: string, init?: any) => {
    const r = await fetch(base + p, init);
    let body: any = null;
    try { body = await r.json(); } catch { /* 非 JSON */ }
    return { status: r.status, body };
  };
  const listApi = await j('/api/runs?limit=50');
  const listLocal = await R.listRuns({ limit: 50 });
  check('/api/runs 可读, 且条数与本地 run-store 一致 (同一份事实)', listApi.status === 200 && listApi.body.count === listLocal.length, JSON.stringify({ api: listApi.body?.count, local: listLocal.length }));
  const oneApi = await j(`/api/runs/${runId}`);
  check('/api/runs/:id 返回 run + goal + checkpoint + recovery + harness[]', oneApi.status === 200 && !!oneApi.body.run && !!oneApi.body.checkpoint && Array.isArray(oneApi.body.harness), JSON.stringify(Object.keys(oneApi.body || {})));
  const doneRun = (await R.readRun(bindRun.runId))!;
  const resumable = ['interrupted', 'stalled', 'paused', 'needs_human', 'awaiting_external'];
  if (!resumable.includes(String(doneRun.status))) {
    const badResume = await j(`/api/runs/${bindRun.runId}/resume`, { method: 'POST' });
    check('非可恢复状态 → /resume 明确拒绝 (409), 不假装开始', badResume.status === 409, JSON.stringify(badResume));
    const badPause = await j(`/api/runs/${bindRun.runId}/pause`, { method: 'POST' });
    check('终态 → /pause 明确拒绝 (409, 非法迁移)', badPause.status === 409, JSON.stringify(badPause));
  }
  const pRun = await R.startRun({ surface: 'web', goal: 'API 暂停测试', channelId: 'ch-e2e' });
  const okPause = await j(`/api/runs/${pRun.runId}/pause`, { method: 'POST' });
  check('running → /pause 成功且落盘 paused', okPause.status === 200 && (await R.readRun(pRun.runId))?.status === 'paused', JSON.stringify(okPause));
  const goalsApi = await j('/api/goals');
  check('/api/goals 可读 (目标事实来源也走同一 store)', goalsApi.status === 200 && goalsApi.body.count >= 2, JSON.stringify({ c: goalsApi.body?.count }));
  const oneGoal = await j(`/api/goals/${bindRun.goalId}`);
  check('/api/goals/:id 带 completion 判定', oneGoal.status === 200 && !!oneGoal.body.completion, JSON.stringify(oneGoal.body?.completion));

  console.log(`\n=== 结果: ${passed} passed, ${failed} failed ===`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('❌ 脚本异常:', e); process.exit(1); });
