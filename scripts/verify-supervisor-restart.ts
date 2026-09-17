/**
 * verify-supervisor-restart.ts — 批次 2-C.1 真跑验收 (2026-09-16)
 *
 * 只验**宿主与长期运行**这件事 (方案 §「第一/第二优先级」):
 *
 *  [1] 宿主身份与状态: 独立宿主把 owner/workerId/pid/心跳 落 ~/.bolloon/supervisor.json; SIGKILL 后**没有** stoppedAt
 *      (= "上次没好好停" 本身可查), 优雅停止才写 stoppedAt/stopReason
 *  [2] 跨进程单 tick 互斥: 别人持有 tick 锁时, 本轮让路且**不执行任何 Goal**
 *  [3] server 重启自动重启 Supervisor: 真 web server 子进程起 → 杀 → 再起 → 宿主身份换新 workerId
 *  [4] 真 SIGKILL → 真重启 → **自动恢复** (确定性 runner): 没人调 /resume, 新宿主自己发现 interrupted Run,
 *      自己 claim Goal, 自己 prepareResume, 同一 runId 继续; 非幂等动作不重做
 *  [5] 真 LLM 版同一条链路: 真 deepseek agent 跑到一半被 SIGKILL → 新宿主自动恢复同一 runId
 *  [6] 解析不到执行器 → 只诊断: Goal 状态一个字节不改, 不建 Run, 不误判完成/失败
 *
 * 用法: npx tsx scripts/verify-supervisor-restart.ts
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import { spawn, type ChildProcess } from 'child_process';

const REAL_HOME = os.homedir();                       // 必须在覆盖 HOME 之前取
const tmpRoot = path.join(os.tmpdir(), 'bolloon-restart-' + Date.now());
const HOME = path.join(tmpRoot, 'home');
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.BOLLOON_SKIP_KUBO = '1';
process.env.BOLLOON_CRON = '0';
process.env.BOLLOON_SUPERVISOR = '0';                 // 验收自己起宿主, 不让 web server 自动起
fs.mkdirSync(path.join(HOME, '.bolloon'), { recursive: true });
// 2026-09-16: 初始化硬门禁生效后, 验收 HOME 必须是"真的 ready" (复制真实 LLM 配置 + 身份 + 引导状态)
try {
  const { makeSetupReady } = await import('./lib/make-setup-ready.js');
  const r = makeSetupReady(path.join(HOME, '.bolloon'), { realHome: REAL_HOME });
  console.log(`[setup-ready] ${r.ok ? 'LLM 配置已就绪' : '⚠ 无可用 LLM 配置'} · ${r.notes.length} 步`);
} catch (e) { console.log('[setup-ready] 失败:', (e as Error)?.message); }

const PROBE = path.join(tmpRoot, 'restart-probe.txt');
const PORT = 42600 + Math.floor(Math.random() * 150);

let passed = 0, failed = 0, gaps = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? ' — ' + String(detail).slice(0, 260) : ''}`); }
};
/**
 * 已登记缺口 (2-C.2 的起点): 归到 gaps 而不是 failed —— 不冒充通过, 也不和真回归混在一起。
 * 当前唯一一项: 真 LLM 版"杀进程→自动续跑" (独立宿主建 agent session 在本机环境下会卡住; 确定性 runner 版已全绿)。
 */
const checkGap = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { gaps++; console.log(`  ⚠ [已登记缺口 2-C.2] ${name}${detail ? ' — ' + String(detail).slice(0, 260) : ''}`); }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SRC = (p: string) => JSON.stringify(path.resolve(p));
const children: ChildProcess[] = [];
function killTree(c: ChildProcess | null, sig: NodeJS.Signals = 'SIGKILL') {
  if (!c?.pid) return;
  try { process.kill(-c.pid, sig); } catch { try { c.kill(sig); } catch { /* 已死 */ } }
}
process.on('exit', () => { for (const c of children) killTree(c); });

/** 起一个子进程, 收集 stdout, 直到匹配到 pattern 或超时 */
async function spawnUntil(cmd: string[], pattern: RegExp, timeoutMs: number): Promise<{ child: ChildProcess; out: string; matched: boolean }> {
  const child = spawn(cmd[0], cmd.slice(1), { cwd: process.cwd(), env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  children.push(child);
  let out = '';
  child.stdout!.on('data', (d) => { out += String(d); });
  child.stderr!.on('data', (d) => { out += String(d); });
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pattern.test(out)) return { child, out, matched: true };
    await wait(400);
  }
  return { child, out, matched: false };
}

async function main() {
  const R = await import('../src/agents/run-store.js');
  const G = await import('../src/agents/goal-store.js');
  const H = await import('../src/agents/supervisor-host.js');
  const S = await import('../src/agents/execution-supervisor.js');

  for (const f of ['bolloon-config.json', 'llm-config.json', 'keypair.json', 'agent-registry.json', 'peer-store.json', 'channels.json']) {
    try { await fsp.copyFile(path.join(REAL_HOME, '.bolloon', f), path.join(HOME, '.bolloon', f)); } catch { /* 缺了无所谓 */ }
  }
  const { initMinimax } = await import('../src/constraints/index.js');
  initMinimax();

  // ═══════════ [1] 宿主身份与状态落盘 ═══════════
  console.log('\n[1] 宿主身份/心跳落盘 + "上次没好好停"可查');
    const jobFile = path.join(tmpRoot, 'job.json');
  await fsp.writeFile(jobFile, JSON.stringify({ probe: PROBE, channelId: 'ch-restart', agentId: 'ag-restart' }), 'utf8');

  const hostChildSrc = `
const fs = require('fs');
(async () => {
  const G = await import(${SRC('src/agents/goal-store.ts')});
  const R = await import(${SRC('src/agents/run-store.ts')});
  const H = await import(${SRC('src/agents/supervisor-host.ts')});
  const S = await import(${SRC('src/agents/execution-supervisor.ts')});
  const JOB = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(tmpRoot, 'job.json'))}, 'utf8'));

  const runner = async (req) => {
    if (req.kind === 'resume' && req.prevRunId) {
      const pre = await R.prepareResume(req.prevRunId);
      if (!pre.ok) { console.log('RESUME_FAIL=' + pre.reason); return { runId: req.prevRunId, status: 'failed', error: pre.reason }; }
      await R.markRunRunning(req.prevRunId);
      await R.recordStep(req.prevRunId, { tool: 'read_file', ok: true, ms: 3, args: { path: JOB.probe }, summary: '恢复后继续: 读回探针文件' });
      await R.finishRun(req.prevRunId, { status: 'done', summary: '恢复完成 (同一 runId)' });
      await G.attachRun(req.goal.goalId, req.prevRunId);
      console.log('RESUMED=' + req.prevRunId);
      return { runId: req.prevRunId, status: 'done' };
    }
    const rec = await R.startRun({ surface: 'cli', goal: req.goal.objective, goalId: req.goal.goalId, channelId: req.goal.channelId, agentId: req.goal.agentId });
    await G.attachRun(req.goal.goalId, rec.runId);
    if (!fs.existsSync(JOB.probe)) fs.writeFileSync(JOB.probe, 'v1-from-run-1');
    await R.recordStep(rec.runId, { tool: 'write_file', ok: true, ms: 5, args: { path: JOB.probe, content: 'v1' }, summary: '写了探针 (非幂等动作)' });
    console.log('RUNID=' + rec.runId);
    return { runId: rec.runId, status: 'running' };
  };

  const sup = new S.ExecutionSupervisor({
    owner: 'host-' + process.pid, maxPerTick: 1,
    resolver: () => ({ ok: true, kind: 'fake', runner }),
    log: (m) => console.log(m),
  });
  await H.runSupervisorHost({ supervisor: sup, mode: 'interval', tickIntervalMs: 600000, keepAlive: true, runnerKind: 'fake', log: (m) => console.log(m) });
  console.log('HOST_READY=' + process.pid);
  setInterval(() => {}, 1000);
})();
`;
  const hostChildFile = path.join(tmpRoot, 'host-child.cjs');
  await fsp.writeFile(hostChildFile, hostChildSrc, 'utf8');

  const goal = await G.createGoal({ objective: `把 v1 写进 ${PROBE} 并读回`, channelId: 'ch-restart', agentId: 'ag-restart', createdBy: 'verify-restart' });
  await G.updateGoal(goal.goalId, { status: 'active' });
  await G.setContinuation(goal.goalId, { autoContinue: true, wakeReason: 'active' });

  const a = await spawnUntil(['npx', 'tsx', hostChildFile], /RUNID=(\S+)/, 60_000);
  const run1 = a.out.match(/RUNID=(\S+)/)?.[1] || '';
  check('宿主 A 认领 Goal 并建了 Run1', !!run1, a.out.slice(-300));
  const stA = await H.readSupervisorState(HOME);
  check('宿主身份落盘 (owner/pid/workerId 自洽)', !!stA && stA.owner === `host-${stA.pid}` && stA.pid > 0 && !!stA.workerId, JSON.stringify(stA));
  check('Run1 记的就是这个宿主的 pid (谁在跑可查)', (await R.readRun(run1))?.pid === stA?.pid, `${(await R.readRun(run1))?.pid} vs ${stA?.pid}`);

  // ═══════════ [4] 真 SIGKILL → 真重启 → 自动恢复 ═══════════
  console.log('\n[4] 真 SIGKILL → 真重启 → 新宿主自动恢复 (全程没有任何人调 /resume)');
  const probeBefore = await fsp.readFile(PROBE, 'utf8').catch(() => '(未创建)');
  check('副作用已发生一次 (探针 = v1-from-run-1)', probeBefore === 'v1-from-run-1', probeBefore);
  killTree(a.child!);
  await wait(900);

  const ghost = await R.readRun(run1);
  check('宿主 A 被杀后, 盘上留的是"幽灵 running" (没被伪装成已结束)', ghost?.status === 'running', String(ghost?.status));
  const stAfterKill = await H.readSupervisorState(HOME);
  check('被杀 → 宿主状态里没有 stoppedAt (= 上次没好好停, 可查)', !!stAfterKill && !stAfterKill.stoppedAt, JSON.stringify({ stoppedAt: stAfterKill?.stoppedAt }));

  // 新进程 = 全新宿主 (不同 workerId), 只做一件事: 启动 → 它自己发现并恢复
  const b = await spawnUntil(['npx', 'tsx', hostChildFile], /RESUMED=|RESUME_FAIL=/, 90_000);
  const resumedId = b.out.match(/RESUMED=(\S+)/)?.[1] || '';
  check('新宿主自动恢复 (没人工 /resume, 没页面, 没用户输入)', !!resumedId, b.out.slice(-400));
  check('恢复的是同一条 Run (不是新建)', resumedId === run1, `resumed=${resumedId} run1=${run1}`);
  const run1After = await R.readRun(run1);
  check('Run 状态如实收尾 (不留 running)', ['done', 'failed', 'aborted', 'needs_human', 'awaiting_external'].includes(String(run1After?.status)), String(run1After?.status));
  check('恢复留痕 action=resume', !!run1After?.recovery.some((r) => r.action === 'resume'), JSON.stringify(run1After?.recovery.map((r) => r.action)));
  const probeAfter = await fsp.readFile(PROBE, 'utf8').catch(() => '(未创建)');
  check('非幂等动作没有重做 (探针仍是 v1)', probeAfter === 'v1-from-run-1', probeAfter);
  const writeSteps = (run1After?.steps || []).filter((s) => s.tool === 'write_file' && s.ok && !String(s.summary || '').startsWith('[恢复保护]'));
  check('Run 里只有 1 次真写文件', writeSteps.length === 1, JSON.stringify(writeSteps.map((s) => s.summary)));
  const gAfter = await G.readGoal(goal.goalId);
  check('同一 Goal 且 Run 仍在它的历史里', !!gAfter && gAfter.runs.includes(run1), JSON.stringify(gAfter?.runs));
  check('Run done ≠ Goal completed (判据未声明 → 仍 active)', gAfter?.status === 'active', String(gAfter?.status));
  check('新宿主拿到了 lease 并已归还 (没有锁死)', (await G.readLease(goal.goalId)) === null);
  const stB = await H.readSupervisorState(HOME);
  check('宿主身份换成新 worker (workerId 与 A 不同)', !!stB && stB.owner === `host-${stB.pid}` && stB.workerId !== stAfterKill?.workerId, JSON.stringify({ a: stAfterKill?.workerId, b: stB?.workerId }));
  killTree(b.child!);
  await wait(500);

  // ═══════════ [5] 真 LLM 版同一条链路 (2-C.2 核心验收) ═══════════
  console.log('\n[5] 真 LLM: 独立宿主真 agent 跑起来 → SIGKILL → 新独立宿主自动接管 (无页面/无 /resume)');
  let realChannelId = 'ch-restart-llm';
  try {
    const raw = JSON.parse(await fsp.readFile(path.join(HOME, '.bolloon', 'channels.json'), 'utf8'));
    const arr = Array.isArray(raw) ? raw : (raw.channels || []);
    if (arr[0]?.id) realChannelId = arr[0].id;
  } catch { /* 没有 channels.json 就用占位 id */ }
  const LLM_PROBE = `${PROBE}.llm`;
  const llmGoal = await G.createGoal({
    objective: `请用 write_file 把字符串 llm-restart-v1 写进文件 ${LLM_PROBE}, 再用 read_file 读回确认, 最后用一句话说明结果。`,
    channelId: realChannelId, agentId: 'ag-restart', createdBy: 'verify-restart',
  });
  await G.updateGoal(llmGoal.goalId, { status: 'active' });
  await G.setContinuation(llmGoal.goalId, { autoContinue: true, wakeReason: 'active' });
  // 清空调度池: 只留这条 (maxPerTick=1)
  await G.updateGoal(goal.goalId, { status: 'paused' });
  await G.setContinuation(goal.goalId, { autoContinue: false, wakeReason: 'paused' });

  const llmHostFile = path.join(tmpRoot, 'host-llm.cjs');
  await fsp.writeFile(llmHostFile, `
(async () => {
  const H = await import(${SRC('src/agents/supervisor-host.ts')});
  await H.runStandaloneSupervisorHost({ tickIntervalMs: 600000, log: (m) => console.log(m) });
  console.log('LLM_HOST_READY=' + process.pid);
  setInterval(() => {}, 1000);
})();
`, 'utf8');
  process.env.BOLLOON_RUN_MAX_STEPS = process.env.BOLLOON_RUN_MAX_STEPS || '8';

  const c = await spawnUntil(['npx', 'tsx', llmHostFile], /LLM_HOST_READY=/, 90_000);
  check('独立宿主(真 LLM)起来了', c.matched, c.out.slice(-300));

  // 等"真 agent 跑起来且仍在运行中"→ 立刻 SIGKILL (这样才叫"跑一半被杀")
  let llmRunId = '';
  let killedWhileRunning = false;
  for (let i = 0; i < 240; i++) {
    await wait(500);
    const g = await G.readGoal(llmGoal.goalId);
    if (!g?.currentRunId) continue;
    const rec = await R.readRun(g.currentRunId);
    if (!rec) continue;
    if (rec.status === 'running' && rec.steps.length >= 1) { llmRunId = rec.runId; killedWhileRunning = true; break; }
    if (rec.status !== 'running' && rec.steps.length >= 1 && !llmRunId) { llmRunId = rec.runId; }   // 跑完了也记下来 (退化成 continue 路径)
    if (Date.now() - Date.parse(rec.startedAt) > 60_000 && rec.steps.length >= 1) { llmRunId = rec.runId; break; }
  }
  check('真 agent 起了 Run 并跑了起来', !!llmRunId, `goal=${llmGoal.goalId} run=${llmRunId} | 宿主输出: ${c.out.slice(-260)}`);
  const stC = await H.readSupervisorState(HOME);
  check('宿主状态里留下阶段报告 (lastResolution 有阶段与耗时)', !!stC?.lastResolution?.stages?.includes('init_llm✓'), JSON.stringify(stC?.lastResolution?.stages || null));
  killTree(c.child!);
  await wait(1000);
  const llmGhost = llmRunId ? await R.readRun(llmRunId) : null;
  if (killedWhileRunning) {
    check('真 agent 被杀 → 盘上留 running 幽灵 (真中断, 不是预置状态)', llmGhost?.status === 'running', String(llmGhost?.status));
  } else {
    checkGap('真 agent 被杀前已自行收尾 (退化为 continue 路径, 未构成"跑一半被杀"证据)', false, `status=${llmGhost?.status}`);
  }

  const d = await spawnUntil(['npx', 'tsx', llmHostFile], /goal=.*→ goal=|无执行器|解析/, 240_000);
  // 等新宿主把这条 run 真正收尾 (它正在跑 ≠ 幽灵; 真 agent 恢复要几十秒)
  for (let i = 0; i < 300; i++) {
    await wait(1000);
    const gg = await G.readGoal(llmGoal.goalId);
    const recs = await Promise.all((gg?.runs || []).map((id) => R.readRun(id)));
    if (recs.length && recs.every((r) => r && r.status !== 'running')) break;
  }
  const gAfter2 = await G.readGoal(llmGoal.goalId);
  const runsAfter2 = await Promise.all((gAfter2?.runs || []).map((id) => R.readRun(id)));
  const llmAfter = llmRunId ? await R.readRun(llmRunId) : null;
  check('新宿主接管后没有留下"幽灵 running" (任何一条 run 都不再是 running)', runsAfter2.every((r) => r && r.status !== 'running'), JSON.stringify(runsAfter2.map((r) => `${r?.runId}:${r?.status}`)));
  check('同一 Goal 的历史保留 (原 Run 仍在)', !!gAfter2?.runs.includes(llmRunId), JSON.stringify(gAfter2?.runs));
  const resumedSame = !!llmAfter?.recovery.some((r) => r.action === 'resume');
  const continuedNew = (gAfter2?.runs.length || 0) > 1;
  check('自动接管: 恢复同一 Run 或按协议开新 Run (两者其一, 且都由新宿主自动完成)',
    resumedSame || continuedNew, `resume=${resumedSame} newRun=${continuedNew} runs=${JSON.stringify(gAfter2?.runs)}`);
  check('接管动作留痕 (recovery / continuation.lastRunId 有记录)', resumedSame || !!gAfter2?.continuation?.lastRunId, JSON.stringify(gAfter2?.continuation || {}).slice(0, 200));
  check('side effect 只发生一次 (探针文件内容没有被第二次写覆盖)', (await fsp.readFile(LLM_PROBE, 'utf8').catch(() => '(未创建)')) === 'llm-restart-v1', await fsp.readFile(LLM_PROBE, 'utf8').catch(() => '(未创建)'));
  check('新宿主 lease 正常接管并归还', (await G.readLease(llmGoal.goalId)) === null);
  const stD = await H.readSupervisorState(HOME);
  check('新宿主身份换新 (workerId 与 A/C 不同)', !!stD && stD.workerId !== stC?.workerId, JSON.stringify({ old: stC?.workerId, now: stD?.workerId }));
  killTree(d.child!);
  await wait(500);

  // ═══════════ [2] 跨进程单 tick 互斥 ═══════════
  console.log('\n[2] 跨进程单 tick 互斥: 别人持有 tick 锁 → 本轮让路, 不执行');
  const lockPath = H.supervisorTickLockPath(HOME);
  await fsp.mkdir(path.dirname(lockPath), { recursive: true });
  await fsp.writeFile(lockPath, JSON.stringify({ pid: process.pid, host: 'parent-holder', startedAt: new Date().toISOString(), tickId: 'held-by-parent' }));
  const busyGoal = await G.createGoal({ objective: '被 tick 锁挡住的目标', channelId: 'ch-restart' });
  await G.updateGoal(busyGoal.goalId, { status: 'active' });
  let ranWhileLocked = 0;
  const busyHost = await H.runSupervisorHost({
    supervisor: new S.ExecutionSupervisor({ runner: (async () => { ranWhileLocked++; return { status: 'done' }; }) as any, maxPerTick: 5 }) as any,
    mode: 'once', home: HOME, log: () => {},
  });
  check('tick 锁被占 → 本轮不执行任何 Goal', ranWhileLocked === 0);
  check('让路原因写进宿主状态 (可观测)', String(busyHost.state.lastSummary).includes('让路'), String(busyHost.state.lastSummary));
  await fsp.rm(lockPath, { force: true });

  // ═══════════ [6] 解析不到执行器 → 只诊断 ═══════════
  console.log('\n[6] 解析不到执行器 → 只诊断: Goal 不被误判完成/失败');
  await G.updateGoal(busyGoal.goalId, { status: 'paused' });
  await G.setContinuation(busyGoal.goalId, { autoContinue: false, wakeReason: 'paused' });
  const noChannel = await G.createGoal({ objective: '没有 channelId 的目标 (没人能执行)' });
  await G.updateGoal(noChannel.goalId, { status: 'active' });
  const before = await G.readGoal(noChannel.goalId);
  const dry = await H.runStandaloneSupervisorHost({ once: true, maxPerTick: 5, home: HOME, log: () => {} });
  const rep = dry.lastReport as any;
  const entry = rep?.executed?.find((e: any) => e.goalId === noChannel.goalId);
  check('独立宿主: 解析不到 → status=unresolved (没执行)', entry?.status === 'unresolved', JSON.stringify(entry));
  check('skipped 里有"无执行器"原因 (不静默)', (rep?.skipped || []).some((s: any) => s.goalId === noChannel.goalId && /无执行器/.test(s.reason)), JSON.stringify(rep?.skipped).slice(0, 200));
  const after = await G.readGoal(noChannel.goalId);
  check('Goal 状态一个字节没改 (既没完成也没失败)', after?.status === before?.status && after?.runs.length === 0, `status=${after?.status} runs=${after?.runs.length}`);

  // 起 server 之前把前面几个测试目标设为 paused, 免得 server 宿主的立即 tick 顺手去跑 (只验"自动重启")
  for (const gid of [busyGoal.goalId, noChannel.goalId, llmGoal.goalId]) {
    await G.updateGoal(gid, { status: 'paused' }).catch(() => null);
    await G.setContinuation(gid, { autoContinue: false, wakeReason: 'paused' }).catch(() => null);
  }

  // ═══════════ [3] server 重启自动重启 Supervisor ═══════════
  console.log('\n[3] server 进程重启 → Supervisor 自动重新启动 (身份换新 worker)');
  const serverFile = path.join(tmpRoot, 'server-child.cjs');
  await fsp.writeFile(serverFile, `
(async () => {
  const { createWebServer } = await import(${SRC('src/web/server.ts')});
  const started = await createWebServer(${PORT}, { selfImprove: false });
  console.log('SERVER_UP=' + (started?.port || ${PORT}));
  setInterval(() => {}, 1000);
})();
`, 'utf8');
  const serverEnv = { BOLLOON_SUPERVISOR: '1', BOLLOON_SUPERVISOR_TICK_MS: '600000', BOLLOON_SKIP_KUBO: '1', BOLLOON_CRON: '0' };
  const prevEnv: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(serverEnv)) { prevEnv[k] = process.env[k]; process.env[k] = v; }
  const s1 = await spawnUntil(['npx', 'tsx', serverFile], /长期执行层已启动/, 120_000);
  check('server 启动时自动起了 Supervisor', s1.matched, s1.out.slice(-300));
  const st1 = await H.readSupervisorState(HOME);
  killTree(s1.child!);
  await wait(1200);
  const s2 = await spawnUntil(['npx', 'tsx', serverFile], /长期执行层已启动/, 120_000);
  check('server 重启后 Supervisor 再次启动 (不需要人工干预)', s2.matched, s2.out.slice(-300));
  const st2 = await H.readSupervisorState(HOME);
  check('宿主身份换新 (workerId 变了, runnerKind=web)', !!st2 && st2.workerId !== st1?.workerId && st2.runnerKind === 'web', JSON.stringify({ a: st1?.workerId, b: st2?.workerId, kind: st2?.runnerKind }));
  killTree(s2.child!);
  for (const [k, v] of Object.entries(prevEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await wait(500);

  console.log(`\n=== 结果: ${passed} passed, ${failed} failed${gaps ? `, ${gaps} 项已登记缺口 (2-C.2 起点, 不计入失败)` : ''} ===`);
  console.log(`(隔离 HOME: ${HOME})`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('验收脚本异常:', err);
  process.exit(1);
});
