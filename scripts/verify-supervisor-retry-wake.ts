/**
 * verify-supervisor-retry-wake.ts — 批次 2-C.3 真跑验收 (2026-09-16)
 *
 * retry_wait 的**真自动唤醒**: 全程真宿主 tick (没有 /wake, 没有人工 tick)。
 *  [1] 未来 wakeAt → 宿主 tick 跳过 (真时间), wakeReport 说清还剩多久/已自动继续几次
 *  [2] 到点 → 宿主**自己**认领并开新 Run; 旧 wakeAt/wakeReason 被清; 不重复非幂等动作
 *  [3] 杀掉宿主 → 重启 (新进程) 仍认盘上的 wakeAt, 到点继续跑; attempts 跨进程保留
 *  [4] 退避序列真生效 (0 → 15s → 60s → 5min): 注入时钟推进 (生产用真实时间), 走真 tick
 *  [5] 第 3 次失败 → needs_human (不再自动续跑), 等人 approve
 *
 * 用法: npx tsx scripts/verify-supervisor-retry-wake.ts
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import { spawn, type ChildProcess } from 'child_process';

const tmpRoot = path.join(os.tmpdir(), 'bolloon-retrywake-' + Date.now());
const HOME = path.join(tmpRoot, 'home');
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.BOLLOON_SKIP_KUBO = '1';
process.env.BOLLOON_CRON = '0';
process.env.BOLLOON_SUPERVISOR = '0';
fs.mkdirSync(path.join(HOME, '.bolloon'), { recursive: true });
// 2026-09-16: 初始化硬门禁生效后, 验收 HOME 必须是"真的 ready" (复制真实 LLM 配置 + 身份 + 引导状态)
try {
  const { makeSetupReady } = await import('./lib/make-setup-ready.js');
  const r = makeSetupReady(path.join(HOME, '.bolloon'), { realHome: REAL_HOME });
  console.log(`[setup-ready] ${r.ok ? 'LLM 配置已就绪' : '⚠ 无可用 LLM 配置'} · ${r.notes.length} 步`);
} catch (e) { console.log('[setup-ready] 失败:', (e as Error)?.message); }

const PROBE = path.join(tmpRoot, 'retry-probe.txt');
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? ' — ' + String(detail).slice(0, 260) : ''}`); }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const children: ChildProcess[] = [];
function killTree(c: ChildProcess | null) {
  if (!c?.pid) return;
  try { process.kill(-c.pid, 'SIGKILL'); } catch { try { c.kill('SIGKILL'); } catch { /* 已死 */ } }
}
process.on('exit', () => { for (const c of children) killTree(c); });

const SRC = (p: string) => JSON.stringify(path.resolve(p));

async function spawnHost(file: string, pattern: RegExp, timeoutMs: number) {
  const child = spawn('npx', ['tsx', file], { cwd: process.cwd(), env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
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
  const S = await import('../src/agents/execution-supervisor.js');

  // 子宿主: 真 host 循环 (tick 1.5s) + 确定性 runner (真 run-store 事实, 首次成功写探针 → 随后 transient 失败)
  const hostFile = path.join(tmpRoot, 'retry-host.cjs');
  await fsp.writeFile(hostFile, `
const fs = require('fs'); const path = require('path');
(async () => {
  const G = await import(${SRC('src/agents/goal-store.ts')});
  const R = await import(${SRC('src/agents/run-store.ts')});
  const H = await import(${SRC('src/agents/supervisor-host.ts')});
  const S = await import(${SRC('src/agents/execution-supervisor.ts')});
  const PROBE = ${JSON.stringify(PROBE)};
  const FAIL = process.env.RW_MODE !== 'ok';

  const runner = async (req) => {
    const rec = await R.startRun({ surface: 'cli', goal: req.goal.objective, goalId: req.goal.goalId, channelId: 'ch-rw' });
    await G.attachRun(req.goal.goalId, rec.runId);
    // 非幂等动作: 遵守守卫 (与 pi-sdk 同语义 —— 已做过就不再做)
    const args = { path: PROBE, content: 'v1' };
    const digest = R.argsDigestOf(args);
    const hit = (req.guards || []).find((g) => g.tool === 'write_file' && g.argsDigest === digest);
    if (!hit) {
      fs.writeFileSync(PROBE, 'v1');
      await R.recordStep(rec.runId, { tool: 'write_file', ok: true, args, summary: '写探针 (非幂等动作)' });
    } else {
      await R.recordStep(rec.runId, { tool: 'write_file', ok: true, args, summary: '[守卫] 跳过重复写 (复用上次结果)' });
    }
    if (!FAIL) {
      await R.recordStep(rec.runId, { tool: 'read_file', ok: true, args: { path: PROBE }, summary: '读回确认' });
      await R.finishRun(rec.runId, { status: 'done', summary: '恢复后完成' });
      console.log('RUN_DONE=' + rec.runId);
    } else {
      await R.recordStep(rec.runId, { tool: 'shell_exec', ok: false, error: '网络抖动 (ECONNRESET)' });
      await R.finishRun(rec.runId, { status: 'failed', error: '网络抖动 (ECONNRESET)' });
      console.log('RUN_FAIL=' + rec.runId);
    }
    return { runId: rec.runId, status: FAIL ? 'failed' : 'done' };
  };

  const sup = new S.ExecutionSupervisor({
    owner: 'rw-host-' + process.pid, maxPerTick: 3,
    resolver: () => ({ ok: true, kind: 'fake', runner }),
    log: (m) => console.log(m),
  });
  await H.runSupervisorHost({ supervisor: sup, mode: 'interval', tickIntervalMs: 1500, keepAlive: true, runnerKind: 'fake', log: (m) => console.log(m) });
  console.log('RW_HOST_READY=' + process.pid);
  setInterval(() => {}, 1000);
})();
`, 'utf8');

  // ═══════════ [1] 未来 wakeAt → 跳过 (真时间) ═══════════
  console.log('\n[1] 未来 wakeAt: 宿主 tick 跳过, 原因可读');
  const g1 = await G.createGoal({ objective: 'retry_wake: 写探针并读回', channelId: 'ch-rw' });
  const due1 = Date.now() + 9_000;
  await G.updateGoal(g1.goalId, { status: 'retry_wait' });
  await G.setContinuation(g1.goalId, { autoContinue: true, wakeReason: 'retry_wait', wakeAt: new Date(due1).toISOString(), attempts: 1 });
  const h1 = await spawnHost(hostFile, /RW_HOST_READY=/, 60_000);
  check('宿主起来了', h1.matched, h1.out.slice(-200));
  await wait(4_000);
  const runsEarly = await R.listRuns({ limit: 20 });
  check('未到点: 一条 Run 都没建 (宿主没被"提前叫醒")', runsEarly.filter((r) => r.goalId === g1.goalId).length === 0, JSON.stringify(runsEarly.map((r) => `${r.runId}:${r.status}`)));
  const row1 = (await G.wakeReport()).find((r) => r.goalId === g1.goalId)!;
  check('wakeReport 说清还剩多久 + 已自动继续几次', /还剩 \d+s/.test(row1.wake) && row1.wake.includes('已自动继续 1 次'), row1.wake);

  // ═══════════ [2] 到点 → 自动执行 ═══════════
  console.log('\n[2] 到点: 宿主自己认领并开新 Run (无 /wake, 无人工 tick)');
  let autoRunId = '';
  for (let i = 0; i < 40; i++) {
    await wait(1000);
    const g = await G.readGoal(g1.goalId);
    const recs = await Promise.all((g?.runs || []).map((id) => R.readRun(id)));
    const failedRun = recs.find((r) => r?.status === 'failed');
    if (failedRun) { autoRunId = failedRun.runId; break; }
  }
  check('到点后宿主自动跑了一轮 (产生失败 Run 事实)', !!autoRunId, h1.out.slice(-300));
  const g1After = await G.readGoal(g1.goalId);
  const newWake = g1After?.continuation?.wakeAt ? Date.parse(g1After.continuation.wakeAt) : 0;
  check('旧 wakeAt 已被消费 (到点唤醒时清掉, 现在这轮是**新**退避, 晚于旧值)',
    !g1After?.continuation?.wakeAt || newWake > due1, `old=${new Date(due1).toISOString()} new=${g1After?.continuation?.wakeAt} (${JSON.stringify(g1After?.continuation?.wakeReason)})`);
  check('自动继续计数已累加 (attempts=2: 到点唤醒前是 1)', (g1After?.continuation?.attempts || 0) >= 2, String(g1After?.continuation?.attempts));
  const writes = (await R.readRun(autoRunId))!.steps.filter((s) => s.tool === 'write_file' && s.ok && !String(s.summary || '').startsWith('[守卫]'));
  check('非幂等动作只真做了一次 (本轮没重复写)', writes.length === 1, JSON.stringify((await R.readRun(autoRunId))!.steps.map((s) => s.summary)));
  check('探针文件内容没被覆盖', (await fsp.readFile(PROBE, 'utf8').catch(() => '(未创建)')) === 'v1');

  // ═══════════ [3] 杀宿主 → 重启仍认 wakeAt ═══════════
  console.log('\n[3] 杀掉宿主 → 重启 (新进程): 仍认盘上的 wakeAt, 到点继续; attempts 跨进程保留');
  const beforeKill = await G.readGoal(g1.goalId);
  const attemptsBefore = beforeKill?.continuation?.attempts || 0;
  const runsBefore = beforeKill!.runs.length;
  killTree(h1.child!);
  await wait(800);
  // 造一个"下一轮 8 秒后才该跑"的等待状态, 然后靠重启后的宿主自动推进
  await G.updateGoal(g1.goalId, { status: 'retry_wait' });
  await G.setContinuation(g1.goalId, { autoContinue: true, wakeReason: 'retry_wait', wakeAt: new Date(Date.now() + 9_000).toISOString(), attempts: attemptsBefore });
  const h2 = await spawnHost(hostFile, /RW_HOST_READY=/, 60_000);
  check('重启后的宿主起来了', h2.matched, h2.out.slice(-200));
  const stH2 = (await import('../src/agents/supervisor-host.js')).readSupervisorState(HOME);
  const wonAt = Date.now() + 30_000;
  let grew = false;
  while (Date.now() < wonAt) {
    await wait(1000);
    const g = await G.readGoal(g1.goalId);
    if ((g?.runs.length || 0) > runsBefore) { grew = true; break; }
  }
  check('重启后到点自动继续 (Run 数增加, 全程没人 /wake)', grew, `before=${runsBefore} now=${(await G.readGoal(g1.goalId))?.runs.length}`);
  const afterRestart = await G.readGoal(g1.goalId);
  check('attempts 跨进程保留 (重启不清零)',
    (afterRestart?.continuation?.attempts || 0) >= attemptsBefore, `${attemptsBefore} → ${afterRestart?.continuation?.attempts}`);
  check('达到阈值后如实转 needs_human (不是继续无限自动续跑)',
    ['needs_human', 'retry_wait'].includes(String(afterRestart?.status)), `${afterRestart?.status} attempts=${afterRestart?.continuation?.attempts}`);
  check('宿主身份换新 (确实是新进程)', !!stH2 && (await stH2).workerId !== undefined && stH2.pid !== h1.child!.pid);
  killTree(h2.child!);
  await wait(500);

  // ═══════════ [4][5] 退避序列 + 阈值 (注入时钟推进, 走真 tick) ═══════════
  console.log('\n[4] 退避序列 (注入时钟推进, 真 tick): 0 → 15s → 60s');
  const g4 = await G.createGoal({ objective: '退避序列', channelId: 'ch-rw' });
  await G.updateGoal(g4.goalId, { status: 'active' });
  let clock = Date.now();
  const failRunner = (async (req: any) => {
    const rec = await R.startRun({ goalId: req.goal.goalId, channelId: 'ch-rw', goal: req.goal.objective });
    await G.attachRun(req.goal.goalId, rec.runId);
    await R.recordStep(rec.runId, { tool: 'shell_exec', ok: false, error: '网络抖动 (ECONNRESET)' });
    await R.finishRun(rec.runId, { status: 'failed', error: '网络抖动 (ECONNRESET)' });
    return { runId: rec.runId, status: 'failed' };
  }) as any;
  const sup4 = new S.ExecutionSupervisor({ runner: failRunner, maxPerTick: 3, now: () => clock, maxRetries: 5 });
  const waits: number[] = [];
  for (let i = 0; i < 3; i++) {
    await sup4.tickOnce();
    const g = await G.readGoal(g4.goalId);
    const w = Date.parse(g!.continuation!.wakeAt!);
    waits.push(w - clock);
    clock = w;                                        // 到点 → 下一轮
    if (i < 2) await G.updateGoal(g4.goalId, { status: 'retry_wait' });
  }
  check('退避序列 = 0 / 15s / 60s (真实时间戳差值)', JSON.stringify(waits) === JSON.stringify([0, 15_000, 60_000]), JSON.stringify(waits));

  console.log('\n[5] 第 3 次失败 → needs_human (不再自动续跑)');
  const g5 = await G.createGoal({ objective: '阈值', channelId: 'ch-rw' });
  await G.updateGoal(g5.goalId, { status: 'active' });
  let clock5 = Date.now();
  const sup5 = new S.ExecutionSupervisor({ runner: failRunner, maxPerTick: 3, now: () => clock5 });
  for (let i = 0; i < 3; i++) {
    await sup5.tickOnce();
    const g = await G.readGoal(g5.goalId);
    if (g?.continuation?.wakeAt) clock5 = Date.parse(g.continuation.wakeAt);
    if (i < 2) await G.updateGoal(g5.goalId, { status: 'retry_wait' });
  }
  const g5After = await G.readGoal(g5.goalId);
  check('第 3 次失败 → needs_human', g5After?.status === 'needs_human', String(g5After?.status));
  check('autoContinue=false (不会被人以外的力量重新放活)', g5After?.continuation?.autoContinue === false);
  check('wakeReport 里显示"等人"', ((await G.wakeReport()).find((r) => r.goalId === g5.goalId)?.wake || '').includes('等人'));
  const ranGoals: string[] = [];
  const sup5b = new S.ExecutionSupervisor({ runner: (async (req: any) => { ranGoals.push(req.goal.goalId); return { status: 'done' }; }) as any, now: () => clock5 + 10 * 60_000, maxPerTick: 5 });
  await sup5b.tickOnce();
  check('等人状态下再 tick 也不跑 (时间过去多久都不会自己复活)', !ranGoals.includes(g5.goalId), JSON.stringify(ranGoals));

  console.log(`\n=== 结果: ${passed} passed, ${failed} failed ===`);
  console.log(`(隔离 HOME: ${HOME})`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('验收脚本异常:', err);
  process.exit(1);
});
