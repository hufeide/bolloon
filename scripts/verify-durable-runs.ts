/**
 * verify-durable-runs.ts — 持久化 run harness 真跑验收 (2026-09-16)
 *
 * 验的就是 leo 指出的那条: "web / cli 只是单次执行, 没有持久化 harness 来约束"。
 * 四件事各拿真证据:
 *   ① 崩了留痕      —— 真起一个子进程跑 agent 运行 → 记录 2 步 → SIGKILL 杀掉 →
 *                       盘上仍是 running + 2 步 (事实活过了进程死亡)
 *   ② 孤儿对账      —— 新进程启动 reconcileOrphans() → 该记录改判 interrupted (不留幽灵)
 *   ③ 预算闸门      —— 步数/时间预算到点 → budgetVerdict 判 exceeded, 必须如实结束
 *   ④ 失速巡检      —— running 但长时间没更新 → superviseRuns() 标 stalled
 *   ⑤ 真 LLM 在环   —— 真 agent 跑一次 (真 deepseek) → 落盘记录 surface=web + steps>=1 + done
 *
 * 用法: npx tsx scripts/verify-durable-runs.ts
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import { spawn } from 'child_process';

// 必须在覆盖 HOME 之前取真家目录: os.homedir() 在 POSIX 上读 $HOME, 覆盖后再取只会拿到隔离目录
// → 复制配置那步静默复制不到任何东西 → agent 退化成默认 provider (openai, 无 key), "真 LLM 在环" 恒红。
const REAL_HOME = os.homedir();
const tmpRoot = path.join(os.tmpdir(), 'bolloon-durable-' + Date.now());
const HOME = path.join(tmpRoot, 'home');
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
fs.mkdirSync(HOME, { recursive: true });
// 真 LLM 用用户本机配置: 把真 ~/.bolloon 里的 key 复制到隔离 HOME (不打印)
process.env.BOLLOON_SKIP_KUBO = '1';
process.env.BOLLOON_CRON = '0';

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? ' — ' + String(detail).slice(0, 220) : ''}`); }
};

const RUNS_DIR = () => path.join(HOME, '.bolloon', 'runs');

/** 子进程: 起一次"运行", 记 2 步, 然后一直挂着 (模拟长任务) */
const CHILD_SRC = `
const os = require('os');
const path = require('path');
(async () => {
  const { startRun, recordStep } = await import(${JSON.stringify(path.resolve('src/agents/run-store.ts'))});
  const rec = await startRun({ surface: 'web', goal: '崩了也要留痕 (子进程测试)', channelId: 'test-ch' });
  await recordStep(rec.runId, { tool: 'read_file', ok: true, ms: 12, args: { path: '/tmp/x' }, summary: '读了文件' });
  await recordStep(rec.runId, { tool: 'shell_exec', ok: false, ms: 30, args: { command: 'echo hi' }, error: '模拟失败' });
  console.log(rec.runId);
  setInterval(() => {}, 1000);   // 挂着不结束
})();
`;

async function main() {
  const { reconcileOrphans, budgetVerdict, superviseRuns, listRuns, readRun, finishRun, recordStep, startRun, listDegradations } =
    await import('../src/agents/run-store.js');

  console.log(`\n隔离 HOME: ${HOME}`);

  // ---------- ① 崩了留痕 ----------
  console.log('\n[1] 真崩: 子进程跑运行 → SIGKILL → 盘上事实还在?');
  const childFile = path.join(tmpRoot, 'run-child.cjs');
  await fsp.writeFile(childFile, CHILD_SRC, 'utf8');
  const child = spawn('npx', ['tsx', childFile], { cwd: process.cwd(), env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let childOut = '';
  child.stdout.on('data', (d) => { childOut += String(d); });
  child.stderr.on('data', () => {});
  let runId = '';
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    runId = (childOut.match(/[0-9a-z]{6,}-[0-9a-f]{6}/) || [''])[0];
    if (runId) {
      const rec = await readRun(runId);
      if (rec && rec.steps.length >= 2) break;
    }
  }
  check('子进程把运行记到盘上 (2 步)', !!runId && (await readRun(runId))?.steps.length === 2, `runId=${runId} out=${childOut.slice(0, 80)}`);
  // npx 会再 fork 一层: 必须杀整个进程组 (detached 起, 负 pid 杀), 只杀 wrapper 的话
  // 真正持有这次运行的 node 进程还活着, 对账会(正确地)判它 stillRunning。
  try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  await new Promise((r) => setTimeout(r, 800));
  const afterKill = await readRun(runId);
  check('SIGKILL 后记录仍在盘上 (status=running, 2 步)', !!afterKill && afterKill.status === 'running' && afterKill.steps.length === 2, JSON.stringify(afterKill && { status: afterKill.status, steps: afterKill.steps.length }));
  check('步骤内容是真事实 (工具名/成败/耗时)', !!afterKill && afterKill.steps[1].tool === 'shell_exec' && afterKill.steps[1].ok === false && afterKill.steps[1].ms === 30, JSON.stringify(afterKill?.steps?.[1]));

  // ---------- ② 孤儿对账 ----------
  console.log('\n[2] 新进程对账: 幽灵 running 必须改判 interrupted');
  const rec2 = await reconcileOrphans();
  const reconciled = await readRun(runId);
  check('对账把死进程的运行标 interrupted', !!reconciled && reconciled.status === 'interrupted', JSON.stringify(reconciled && { status: reconciled.status, err: reconciled.error }));
  check('对账原因写清"进程已不在"', !!reconciled && /进程 \d+ 已不在/.test(String(reconciled.error)), String(reconciled?.error));
  check('对账没动步骤 (事实层不变)', !!reconciled && reconciled.steps.length === 2, String(reconciled?.steps.length));
  check('reconcileOrphans 返回了被改判的 runId', rec2.interrupted.includes(runId), JSON.stringify(rec2));

  // ---------- ③ 预算闸门 ----------
  console.log('\n[3] 预算闸门: 到点必须如实结束 (不许静默算完成)');
  const r3 = await startRun({ surface: 'cli', goal: '预算测试' });
  for (let i = 0; i < r3.budget.maxSteps; i++) await recordStep(r3.runId, { tool: 'noop', ok: true });
  const full = await readRun(r3.runId);
  const v1 = budgetVerdict(full!);
  check(`步数用尽 → exceeded (maxSteps=${r3.budget.maxSteps})`, v1.exceeded === true && /步数预算用尽/.test(String(v1.reason)), JSON.stringify(v1));
  // 时间预算: 另起一条干净运行 (0 步) 且 startedAt 改成很久以前 → 只可能命中时间预算
  const r3b = await startRun({ surface: 'cli', goal: '时间预算测试' });
  const p3b = path.join(RUNS_DIR(), `${r3b.runId}.json`);
  const j3b = JSON.parse(await fsp.readFile(p3b, 'utf8'));
  j3b.startedAt = new Date(Date.now() - j3b.budget.deadlineMs - 60_000).toISOString();
  await fsp.writeFile(p3b, JSON.stringify(j3b, null, 2), 'utf8');
  const v2 = budgetVerdict((await readRun(r3b.runId))!);
  check('时间用尽 → exceeded (带原因)', v2.exceeded === true && /时间预算用尽/.test(String(v2.reason)), JSON.stringify(v2));

  // ---------- ④ 失速巡检 ----------
  console.log('\n[4] 失速巡检: 长时间没进展 → stalled');
  const r4 = await startRun({ surface: 'cron', goal: '失速测试' });
  const p4 = path.join(RUNS_DIR(), `${r4.runId}.json`);
  const j4 = JSON.parse(await fsp.readFile(p4, 'utf8'));
  j4.updatedAt = new Date(Date.now() - 10 * 60_000).toISOString();  // 假装 10 分钟没动 (pid 仍是本进程 → 活着)
  await fsp.writeFile(p4, JSON.stringify(j4, null, 2), 'utf8');
  const sup = await superviseRuns();
  const stalled = await readRun(r4.runId);
  check('判失速并写回原因', stalled?.status === 'stalled' && /没有新进展/.test(String(stalled.error)), JSON.stringify(stalled && { s: stalled.status, e: stalled.error }));
  check('superviseRuns 返回被标 stalled 的 runId', sup.stalled.includes(r4.runId), JSON.stringify(sup));
  check('活着的进程不会被误判成孤儿', !(await reconcileOrphans()).interrupted.includes(r4.runId));

  // ---------- ⑤ 真 LLM 在环: 真 agent 跑一次, 记录真的写出来 ----------
  console.log('\n[5] 真 agent (真 deepseek) 跑一次 → 落盘记录 + 状态 done');
  try {
    // 把真 HOME 的 LLM 配置/凭证复制到隔离 HOME (只复制, 不打印)
    await fsp.mkdir(path.join(HOME, '.bolloon'), { recursive: true });
    for (const f of ['bolloon-config.json', 'llm-config.json', 'keypair.json', 'agent-registry.json', 'peer-store.json']) {
      try { await fsp.copyFile(path.join(REAL_HOME, '.bolloon', f), path.join(HOME, '.bolloon', f)); } catch { /* 缺了也无所谓 */ }
    }
    const { initMinimax } = await import('../src/constraints/index.js');
    initMinimax();
    const { createAgentSession } = await import('../src/agents/pi-sdk.js');
    const agent: any = await createAgentSession({ cwd: process.cwd(), peerId: `durable-test:${Date.now()}` }, true);
    agent.setRunSurface?.('web');
    const before = (await listRuns()).length;
    const reply = await agent.prompt('用 shell_exec 跑 `echo bolloon-durable-ok` 然后把输出原样告诉我, 一句话即可。', {});
    const runs = await listRuns({ limit: 5 });
    const newest = runs[0];
    check('真 agent 运行写出一条新记录', runs.length > before && !!newest, `before=${before} after=${runs.length}`);
    check('记录 surface=web (表面注入生效)', newest?.surface === 'web', JSON.stringify(newest && { surface: newest.surface }));
    check('记录里留了工具步骤 (facts, 不是摘要)', (newest?.steps?.length || 0) >= 1, JSON.stringify(newest?.steps?.map((s) => s.tool)));
    check('运行结束后状态如实 (done/failed/needs_human, 不留 running)', ['done', 'failed', 'aborted', 'needs_human'].includes(String(newest?.status)), String(newest?.status));
    if (String(newest?.status) === 'needs_human') {
      check('鉴权类错误按协议落 needs_human + errorClass=auth (不重试)', newest?.errorClass === 'auth', JSON.stringify({ status: newest?.status, errorClass: newest?.errorClass }));
    }
    check('真 agent 回复非空', String(reply || '').length > 0, String(reply || '').slice(0, 80));
  } catch (e: any) {
    check('真 LLM 在环跑通 (可失败: key/网络)', false, String(e?.message || e).slice(0, 220));
  }

  // ---------- ⑥ 状态机 + 错误分类 (协议层, 纯函数, 确定性) ----------
  console.log('\n[6] 状态机 + 错误分类 (协议约束)');
  const { canTransition, classifyError, setRunStatus, saveCheckpoint, recordRecovery } = await import('../src/agents/run-store.js');
  check('running → done 合法', canTransition('running', 'done') === true);
  check('done → running 非法 (不许"复活"成运行中)', canTransition('done', 'running') === false);
  check('failed → running 非法', canTransition('failed', 'running') === false);
  check('interrupted → recovering 合法 (从 checkpoint 恢复)', canTransition('interrupted', 'recovering') === true);
  check('stalled → needs_human 合法', canTransition('stalled', 'needs_human') === true);

  const r6 = await startRun({ surface: 'cli', goal: '状态机测试' });
  const badMove = await setRunStatus(r6.runId, 'done');
  await finishRun(r6.runId, { status: 'aborted', error: '正常收尾' });
  const revive = await setRunStatus(r6.runId, 'running');
  check('setRunStatus 允许 running → done', badMove.ok === true, JSON.stringify(badMove));
  check('setRunStatus 拒绝 done → running (非法迁移)', revive.ok === false && /非法状态迁移/.test(String(revive.reason)), JSON.stringify(revive));

  check('classifyError: 401 → auth (不重试交人)', classifyError('401 Authentication Fails, api key invalid') === 'auth');
  check('classifyError: 429 → transient', classifyError('429 rate limit exceeded') === 'transient');
  check('classifyError: 无响应 → external_no_reply', classifyError('对端无响应 504') === 'external_no_reply');
  check('classifyError: 未知 → unknown', classifyError('something else') === 'unknown');

  const r6b = await startRun({ surface: 'cli', goal: 'checkpoint 测试' });
  await recordStep(r6b.runId, { tool: 'read_file', ok: true, args: { path: 'a' } });
  const cp = (await readRun(r6b.runId))?.checkpoint;
  check('每步自动写 checkpoint (做到哪 + 下一步)', cp?.completedActions === 1 && !!cp?.pendingAction && !!cp?.nextAction, JSON.stringify(cp));
  await recordRecovery(r6b.runId, { errorClass: 'transient', message: 'timeout', action: 'backoff', attempt: 1, recovered: true });
  const rec6 = await readRun(r6b.runId);
  check('recovery 留痕 (分类/策略/是否恢复)', rec6?.recovery?.[0]?.errorClass === 'transient' && rec6?.recovery?.[0]?.recovered === true, JSON.stringify(rec6?.recovery));
  check('errorClass 写进记录 (auth 落 needs_human 的依据)', (await finishRun(r6b.runId, { status: 'needs_human', error: '401 invalid api key' }))?.errorClass === 'auth');

  // ---------- ⑦ 持久化失败 → agent 必须停 (Milestone 1 硬约束) ----------
  console.log('\n[7] 持久化失败: agent 必须停在 needs_human, 不许无记录继续执行');
  try {
    const runsDir = path.join(HOME, '.bolloon', 'runs');
    await fsp.mkdir(runsDir, { recursive: true });
    await fsp.chmod(runsDir, 0o500);   // 只读: 运行记录必然写不进去
    const { createAgentSession } = await import('../src/agents/pi-sdk.js');
    const goal = `持久化失败停止测试 ${Date.now()}`;
    const agent: any = await createAgentSession({ cwd: process.cwd(), peerId: `persist-fail:${Date.now()}` }, true);
    agent.setRunSurface?.('cli');
    const before = (await listRuns()).length;
    let reply = '';
    try {
      reply = await agent.prompt(goal, {});
    } finally {
      await fsp.chmod(runsDir, 0o700);
    }
    check('返回的是"已停止"而不是正常回复', /运行已停止|无法创建运行记录/.test(String(reply)), String(reply).slice(0, 140));
    const after = await listRuns();
    check('没有为这次运行留下"假装在跑"的记录 (盘上没有该目标)', !after.some((r) => String(r.goal).includes('持久化失败停止测试')), JSON.stringify(after.map((r) => [r.goal.slice(0, 20), r.status])));
    check('其它记录没被牵连 (数量不倒退)', after.length >= before, `before=${before} after=${after.length}`);
    const degs = await listDegradations(5);
    check('核心写失败在降级日志里留痕', degs.some((d) => d.op === 'startRun' || d.op === 'acquireFileLock' || d.op === 'withRunLock'), JSON.stringify(degs.slice(0, 2)));
  } catch (e: any) {
    check('持久化失败时 agent 停止 (真 agent 在环)', false, String(e?.message || e).slice(0, 220));
  }

  // ---------- 收尾 ----------
  const all = await listRuns();
  console.log(`\n盘上运行记录: ${all.length} 条 — ${all.map((r) => `${r.surface}:${r.status}`).join(', ')}`);
  console.log(`\n=== 结果: ${passed} passed, ${failed} failed ===`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('❌ 脚本异常:', e); process.exit(1); });
