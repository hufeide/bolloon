/**
 * verify-supervisor.ts — 批次 1 (2-A + 2-B) 真跑验收  (2026-09-16)
 *
 *   [1] 跨进程 lease 排他: 两个真进程抢同一个 Goal → 只有一个成功
 *   [2] worker 崩溃接管: SIGKILL 后 lease 可回收 (死进程即时回收 + TTL 到点回收)
 *   [3] 被接管者不能写: 旧 leaseId 续租/释放一律失败, 持有者不被顶掉
 *   [4] 跨预算继续 (真 LLM + 真 Supervisor): 一个 Goal 跨 ≥2 个 Run, 新 Run 挂在同一 Goal,
 *       非幂等守卫从上一个 Run 传进下一个 Run
 *   [5] 两个 Supervisor 同时 tick → 严格单 worker 执行
 *   [6] 唤醒表: paused / awaiting_external 不自动跑; 外部事件到达才唤醒
 *   [7] 长期执行诊断 (wakeReport) 能说清每个 Goal 为什么在/不在跑
 *
 * 用法: npx tsx scripts/verify-supervisor.ts
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import { spawn } from 'child_process';

const REAL_HOME = os.homedir();                       // 必须在覆盖 HOME 之前取
const tmpRoot = path.join(os.tmpdir(), 'bolloon-sup-e2e-' + Date.now());
const HOME = path.join(tmpRoot, 'home');
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.BOLLOON_SKIP_KUBO = '1';
process.env.BOLLOON_CRON = '0';
process.env.BOLLOON_SUPERVISOR = '0';                 // 验收自己控制 tick, 不靠后台定时器
process.env.BOLLOON_RUN_MAX_STEPS = process.env.BOLLOON_RUN_MAX_STEPS || '3';   // 小预算 → 逼出"跨 Run 继续"
fs.mkdirSync(path.join(HOME, '.bolloon'), { recursive: true });
// 2026-09-16: 初始化硬门禁生效后, 验收 HOME 必须是"真的 ready" (复制真实 LLM 配置 + 身份 + 引导状态)
try {
  const { makeSetupReady } = await import('./lib/make-setup-ready.js');
  const r = makeSetupReady(path.join(HOME, '.bolloon'), { realHome: REAL_HOME });
  console.log(`[setup-ready] ${r.ok ? 'LLM 配置已就绪' : '⚠ 无可用 LLM 配置'} · ${r.notes.length} 步`);
} catch (e) { console.log('[setup-ready] 失败:', (e as Error)?.message); }

const PROBE = path.join(tmpRoot, 'sup-probe.txt');
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? ' — ' + String(detail).slice(0, 240) : ''}`); }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const R = await import('../src/agents/run-store.js');
  const G = await import('../src/agents/goal-store.js');
  const S = await import('../src/agents/execution-supervisor.js');

  for (const f of ['bolloon-config.json', 'llm-config.json', 'keypair.json', 'agent-registry.json', 'peer-store.json']) {
    try { await fsp.copyFile(path.join(REAL_HOME, '.bolloon', f), path.join(HOME, '.bolloon', f)); } catch { /* 缺了无所谓 */ }
  }
  const { initMinimax } = await import('../src/constraints/index.js');
  initMinimax();
  const { createAgentSession } = await import('../src/agents/pi-sdk.js');

  const goal = await G.createGoal({
    objective: `把字符串 hello-batch1 写进文件 ${PROBE}`,
    channelId: 'ch-sup', agentId: 'ag-sup', createdBy: 'verify-supervisor',
  });

  // ═══════════ [1] 跨进程 lease 排他 (真两个进程) ═══════════
  console.log('\n[1] 跨进程 lease 排他: 两个真进程抢同一个 Goal');
  const holderSrc = `
(async () => {
  const G = await import(${JSON.stringify(path.resolve('src/agents/goal-store.ts'))});
  const r = await G.claimGoal(${JSON.stringify(goal.goalId)}, { owner: 'proc-A', ttlMs: 60000 });
  if (r.ok) { console.log('CLAIM_OK=' + r.lease.leaseId); }
  else { console.log('CLAIM_FAIL=' + r.reason); }
  setInterval(() => {}, 1000);   // 持有住, 不退出
})();
`;
  const holderFile = path.join(tmpRoot, 'holder-A.cjs');
  await fsp.writeFile(holderFile, holderSrc, 'utf8');
  const holder = spawn('npx', ['tsx', holderFile], { cwd: process.cwd(), env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let hOut = '';
  holder.stdout.on('data', (d) => { hOut += String(d); });
  holder.stderr.on('data', () => {});
  let leaseIdA = '';
  for (let i = 0; i < 60; i++) {
    await wait(300);
    const m = hOut.match(/CLAIM_OK=(\S+)/);
    if (m) { leaseIdA = m[1]; break; }
  }
  check('进程 A 抢到 lease', !!leaseIdA, hOut.slice(0, 120));
  check('盘上持有者是 proc-A', (await G.readLease(goal.goalId))?.owner === 'proc-A');

  const contenderSrc = `
(async () => {
  const G = await import(${JSON.stringify(path.resolve('src/agents/goal-store.ts'))});
  const r = await G.claimGoal(${JSON.stringify(goal.goalId)}, { owner: 'proc-B' });
  console.log(r.ok ? 'CLAIM_OK=' + r.lease.leaseId : 'CLAIM_FAIL=' + r.reason);
})();
`;
  const contenderFile = path.join(tmpRoot, 'contender-B.cjs');
  await fsp.writeFile(contenderFile, contenderSrc, 'utf8');
  const contenderOut = await new Promise<string>((resolve) => {
    const c = spawn('npx', ['tsx', contenderFile], { cwd: process.cwd(), env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '';
    c.stdout.on('data', (d) => { o += String(d); });
    c.on('exit', () => resolve(o));
    setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* ignore */ } resolve(o); }, 45_000);
  });
  check('进程 B 被明确拒绝 (不静默成功)', contenderOut.includes('CLAIM_FAIL'), contenderOut.slice(0, 160));
  check('B 的拒绝理由带持有者信息', /lease 被占用/.test(contenderOut), contenderOut.slice(0, 160));
  check('lease 仍属 proc-A (没被顶掉)', (await G.readLease(goal.goalId))?.owner === 'proc-A');

  // ═══════════ [2] worker 崩溃 → lease 回收 ═══════════
  console.log('\n[2] worker 崩溃接管');
  try { process.kill(-holder.pid!, 'SIGKILL'); } catch { holder.kill('SIGKILL'); }
  await wait(800);
  const afterKill = await G.claimGoal(goal.goalId, { owner: 'proc-C' });
  check('持有者进程死了 → 新 worker 能接管 (不等满 TTL)', afterKill.ok, afterKill.reason);
  check('接管后持有者是 proc-C', (await G.readLease(goal.goalId))?.owner === 'proc-C');

  // ═══════════ [3] 被接管者不能再写 ═══════════
  console.log('\n[3] 被接管者不能再写');
  const staleHb = await G.heartbeatGoal(goal.goalId, leaseIdA);
  check('旧 leaseId 续租失败 (被接管后不能再写)', !staleHb.ok && /已被接管/.test(String(staleHb.reason)), String(staleHb.reason));
  const staleRel = await G.releaseGoal(goal.goalId, leaseIdA);
  check('旧 leaseId 释放失败 (不能解锁别人的锁)', !staleRel.ok, String(staleRel.reason));
  check('持有者仍是 proc-C', (await G.readLease(goal.goalId))?.owner === 'proc-C');

  // TTL 到点回收
  const now = Date.now();
  await fsp.writeFile(path.join(HOME, '.bolloon', 'goals', `${goal.goalId}.lease`), JSON.stringify({
    owner: 'proc-D', leaseId: 'ttl-1', claimedAt: new Date(now).toISOString(),
    lastHeartbeat: new Date(now).toISOString(), leaseUntil: new Date(now + 30_000).toISOString(),
    pid: process.pid, host: 'test',
  }));
  const live = await G.claimGoal(goal.goalId, { owner: 'proc-E', now });
  check('未过期的活锁 → 拒 (严格单 worker)', !live.ok);
  const expired = await G.claimGoal(goal.goalId, { owner: 'proc-E', now: now + 31_000 });
  check('TTL 到点 → 可接管', expired.ok);
  if (expired.ok) await G.releaseGoal(goal.goalId, expired.lease!.leaseId);

  // ═══════════ [4] 跨预算继续 (真 LLM + 真 Supervisor) ═══════════
  console.log('\n[4] 跨预算继续 (真 LLM): 一个 Goal 跨 ≥2 个 Run');
  const agent: any = await createAgentSession({ cwd: process.cwd(), peerId: `sup-e2e:${Date.now()}`, channelId: 'ch-sup' } as any, true);
  (agent as any).setGoalId?.(goal.goalId);
  const first = await (agent as any).prompt(`请把字符串 hello-batch1 写进文件 ${PROBE} (用 write_file), 然后用 read_file 读回确认。`);
  // prompt 收尾会清空 currentRunId → 用 getLastRunId 拿"刚才跑的是哪条 run"
  const run1Id = (agent as any).getLastRunId?.() || (agent as any).getRunId?.();
  const run1 = run1Id ? await R.readRun(run1Id) : null;
  check('第一次执行产生 Run 并挂在目标上', !!run1 && run1.goalId === goal.goalId, `run1=${run1Id} status=${run1?.status} goalId=${run1?.goalId}`);
  const g1 = await G.readGoal(goal.goalId);
  check('目标仍存活 (Run 结束 ≠ Goal 失败)', !!g1 && g1.runs.includes(run1Id), `status=${g1?.status} runs=${g1?.runs?.length}`);

  // 注入捕获: 记录 supervisor 交给新 Run 的非幂等守卫
  let sawGuards: any[] = [];
  let sawKind = '';
  const runner = async (req: any) => {
    sawKind = req.kind;
    sawGuards = req.guards || [];
    if (req.kind === 'resume' && req.prevRunId) {
      const r = await (agent as any).resumeRun(req.prevRunId);
      return { runId: req.prevRunId, status: r?.ok ? 'done' : 'failed', error: r?.ok ? undefined : r?.reason };
    }
    (agent as any).setGoalId?.(req.goal.goalId);
    (agent as any).setContinuationGuards?.(req.guards || []);
    await (agent as any).prompt(req.instruction);
    return { runId: (agent as any).getLastRunId?.() || (agent as any).getRunId?.(), status: 'done' };
  };
  const supA = new S.ExecutionSupervisor({ runner: runner as any, owner: 'sup-A', maxPerTick: 1, log: (m: string) => console.log(`    ${m}`) });
  const rep1 = await supA.tickOnce();
  check('Supervisor 认领了这个 Goal', rep1.claimed.includes(goal.goalId), JSON.stringify(rep1.claimed));
  check('tick 里没有错误', rep1.errors.length === 0, JSON.stringify(rep1.errors).slice(0, 200));
  const exec1 = rep1.executed[0];
  check('同一 Goal 下出现了第二个 Run', !!exec1 && exec1.runId !== run1Id, `run2=${exec1?.runId} run1=${run1Id}`);
  const run2 = exec1?.runId ? await R.readRun(exec1.runId) : null;
  check('新 Run 挂在同一个 Goal 上 (不是新目标)', !!run2 && run2.goalId === goal.goalId, `run2.goalId=${run2?.goalId}`);
  const g2 = await G.readGoal(goal.goalId);
  check('Goal 上累积了 ≥2 条 Run (历史保留, 不是替换)', !!g2 && g2.runs.length >= 2 && g2.runs.includes(run1Id) && g2.runs.includes(run2?.runId || ''), `runs=${g2?.runs?.length}`);
  check('continuation 写下"下一次何时/因为什么"', !!g2?.continuation?.wakeReason, JSON.stringify(g2?.continuation || {}).slice(0, 200));
  check('Run done 没有让 Goal 装作完成 (判据未声明)', g2?.status !== 'completed', `status=${g2?.status}`);
  check('非幂等守卫从上一个 Run 传进下一个 Run', sawGuards.length > 0 || (run1?.steps.filter((s) => s.ok).length === 0), `kind=${sawKind} guards=${JSON.stringify(sawGuards).slice(0, 160)}`);

  // 探针副作用只发生一次 (跨 Run 不许重做非幂等动作)
  let probeWrites = 0;
  for (const rid of (g2?.runs || [])) {
    const rec = await R.readRun(rid);
    probeWrites += (rec?.steps || []).filter((s) => s.ok && s.tool === 'write_file' && String(s.argsDigest || '').length > 0).length;
  }
  const probeExists = fs.existsSync(PROBE);
  check('非幂等写只真发生一次 (跨 Run 无重复副作用)', probeWrites <= 1 || !probeExists, `write_steps=${probeWrites} probe=${probeExists ? fs.readFileSync(PROBE, 'utf8').slice(0, 40) : '(未创建)'}`);

  // ═══════════ [5] 两个 Supervisor 同时 tick → 单 worker ═══════════
  console.log('\n[5] 两个 Supervisor 同时 tick → 严格单 worker');
  // 清空调度池: [4] 的目标已完成本轮推进, 设为 paused 免得干扰排他性测量
  await G.updateGoal(goal.goalId, { status: 'paused' });
  await G.setContinuation(goal.goalId, { autoContinue: false, wakeReason: 'paused' });
  const goal2 = await G.createGoal({ objective: '并发排他测试', channelId: 'ch-sup', agentId: 'ag-sup' });
  await G.updateGoal(goal2.goalId, { status: 'active' });
  const runs: string[] = [];
  const slowRunner = async (req: any) => { runs.push(req.goal.goalId); await wait(250); return { status: 'done' as const }; };
  const s1 = new S.ExecutionSupervisor({ runner: slowRunner as any, owner: 'w1', maxPerTick: 5 });
  const s2 = new S.ExecutionSupervisor({ runner: slowRunner as any, owner: 'w2', maxPerTick: 5 });
  const [r1, r2] = await Promise.all([s1.tickOnce(), s2.tickOnce()]);
  const execGoal2 = runs.filter((id) => id === goal2.goalId).length;
  check('并发 tick 只执行一次 (lease 挡住第二个)', execGoal2 === 1, `executed=${execGoal2} all=${JSON.stringify(runs)}`);
  const loser = r1.claimed.includes(goal2.goalId) ? r2 : r1;
  check('被挡的一方如实报告原因 (不是静默跳过)', loser.skipped.some((s) => s.goalId === goal2.goalId && /lease|claim|乐观并发/.test(s.reason)), JSON.stringify(loser.skipped).slice(0, 200));
  check('tick 结束后 lease 已归还', (await G.readLease(goal2.goalId)) === null);

  // ═══════════ [6] 唤醒表 ═══════════
  console.log('\n[6] 唤醒表: 等人/等事件的目标不会被自动唤醒');
  const goalPaused = await G.createGoal({ objective: '暂停中的目标', channelId: 'ch-sup' });
  await G.updateGoal(goalPaused.goalId, { status: 'paused' });
  await G.setContinuation(goalPaused.goalId, { autoContinue: false, wakeReason: 'paused' });
  // 清空气他目标, 只留这条 paused 的 (计数按 goalId 精确到目标, 不受别的目标干扰)
  await G.updateGoal(goal2.goalId, { status: 'paused' });
  await G.setContinuation(goal2.goalId, { autoContinue: false, wakeReason: 'paused' });
  const ranGoals: string[] = [];
  const supP = new S.ExecutionSupervisor({ runner: (async (req: any) => { ranGoals.push(req.goal.goalId); return { status: 'done' }; }) as any });
  await supP.tickOnce();
  check('paused 的目标不被自动执行 (没有隐式恢复)', !ranGoals.includes(goalPaused.goalId), JSON.stringify(ranGoals));
  check('paused 的跳过理由写清 (transparency)', (await G.wakeReport()).find((r) => r.goalId === goalPaused.goalId)?.wake.includes('等人') === true, JSON.stringify((await G.wakeReport()).find((r) => r.goalId === goalPaused.goalId)));

  const goalExt = await G.createGoal({ objective: '等外部节点回复的目标', channelId: 'ch-sup' });
  await G.updateGoal(goalExt.goalId, { status: 'awaiting_external' });
  await G.setContinuation(goalExt.goalId, { autoContinue: true, wakeReason: 'awaiting_external', needsExternal: 'peer 回复' });
  ranGoals.length = 0;
  const supE = new S.ExecutionSupervisor({ runner: (async (req: any) => { ranGoals.push(req.goal.goalId); return { status: 'done' }; }) as any });
  await supE.tickOnce();
  check('awaiting_external 不被自动重跑 (等事件, 不重发请求)', !ranGoals.includes(goalExt.goalId), JSON.stringify(ranGoals));
  check('外部事件到达 → 唤醒成 active', await supE.notifyExternal(goalExt.goalId));
  const goalExtAfter = await G.readGoal(goalExt.goalId);
  check('唤醒后状态可推进 (wakeReason=active, 清掉等外部)', goalExtAfter?.continuation?.wakeReason === 'active' && !goalExtAfter?.continuation?.needsExternal, JSON.stringify(goalExtAfter?.continuation));

  // ═══════════ [7] 诊断可读 ═══════════
  console.log('\n[7] 长期执行诊断 (wakeReport)');
  const rows = await G.wakeReport();
  check('每个目标都能回答"何时因何被唤醒"', rows.length > 0 && rows.every((r) => typeof r.wake === 'string' && r.wake.length > 0), JSON.stringify(rows.slice(0, 3)));
  const runnable = await G.listRunnableGoals({ now: Date.now() });
  check('可推进/跳过都有明确归属 (不漏不重)', runnable.runnable.length + runnable.skipped.length >= 3, `runnable=${runnable.runnable.length} skipped=${runnable.skipped.length}`);

  // ═══════════ [8] 预算硬中止 → Goal 不失败 → Supervisor 接着跑 ═══════════
  console.log('\n[8] 预算耗尽: Run 如实 aborted, Goal 不失败, 新 Run 继续');
  const goalBudget = await G.createGoal({ objective: `预算测试: 把 budget-probe 写进 ${PROBE}`, channelId: 'ch-sup', agentId: 'ag-sup', successCriteria: ['写出文件'] });
  await G.updateGoal(goalBudget.goalId, { status: 'active' });
  const budgetAgent: any = await createAgentSession({ cwd: process.cwd(), peerId: `sup-budget:${Date.now()}`, channelId: 'sup-budget' } as any, true);
  process.env.BOLLOON_RUN_MAX_STEPS = '1';                       // 只给 1 步 → 必然撞预算
  budgetAgent.setGoalId?.(goalBudget.goalId);
  await budgetAgent.prompt(`请把 budget-probe 写进文件 ${PROBE} 并读回确认。`);
  const bRunId = budgetAgent.getLastRunId?.() || budgetAgent.getRunId?.();
  const bRun = bRunId ? await R.readRun(bRunId) : null;
  process.env.BOLLOON_RUN_MAX_STEPS = '3';
  check('预算耗尽时 Run 如实 aborted (不装 done)', bRun?.status === 'aborted', `status=${bRun?.status} err=${String(bRun?.error || '').slice(0, 80)}`);
  const gBudget1 = await G.readGoal(goalBudget.goalId);
  check('预算耗尽没让 Goal 失败 (Goal 不是 Run 的下属)', gBudget1?.status !== 'failed' && gBudget1?.status !== 'abandoned', `status=${gBudget1?.status}`);

  const supB = new S.ExecutionSupervisor({
    owner: 'sup-B', maxPerTick: 1,
    runner: (async (req: any) => {
      budgetAgent.setGoalId?.(req.goal.goalId);
      budgetAgent.setContinuationGuards?.(req.guards || []);
      await budgetAgent.prompt(req.instruction);
      return { runId: budgetAgent.getLastRunId?.(), status: 'done' };
    }) as any,
  });
  const repB = await supB.tickOnce();
  const gBudget2 = await G.readGoal(goalBudget.goalId);
  check('Supervisor 在预算中止后自动开了下一个 Run', (gBudget2?.runs.length || 0) >= 2 && gBudget2!.runs.includes(bRunId), `runs=${gBudget2?.runs.length} rep=${JSON.stringify(repB.executed).slice(0, 160)}`);
  check('新 Run 仍属于同一个 Goal (目标贯通)', !!gBudget2?.currentRunId && gBudget2.runs.includes(gBudget2.currentRunId), `current=${gBudget2?.currentRunId}`);

  console.log(`\n=== 结果: ${passed} passed, ${failed} failed ===`);
  console.log(`(隔离 HOME: ${HOME})`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('验收脚本异常:', err);
  process.exit(1);
});
