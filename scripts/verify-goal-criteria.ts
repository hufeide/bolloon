/**
 * verify-goal-criteria.ts — 批次 2-F (判据生成/确认/长期证据) + 2-H (Web 长期执行面板) 真跑验收 (2026-09-16)
 *
 * 真: 真 Goal/Run 文件 + 真 Supervisor tick + 真 web server (面板与 API) + 真跨 Run 证据汇总。
 *
 * 覆盖: 用户判据直接可用并完成 · 无判据 → agent 提候选但**未确认不许完成** · 确认后完成 ·
 *      模糊目标 → 交人 (不伪造判据) · 证据跨 Run 汇总 · unresolvedItems 阻塞完成 · 最近 Run 失败阻塞完成 ·
 *      Web /goals 面板 + 判据 API (与 CLI 同一份事实)。
 *
 * 用法: npx tsx scripts/verify-goal-criteria.ts
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

const REAL_HOME = os.homedir();
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-criteria-'));
const HOME = path.join(ROOT, 'home');
const BHOME = path.join(HOME, '.bolloon');
process.env.HOME = HOME; process.env.USERPROFILE = HOME;
process.env.BOLLOON_SKIP_KUBO = '1'; process.env.BOLLOON_CRON = '0'; process.env.BOLLOON_SUPERVISOR = '0';
fs.mkdirSync(BHOME, { recursive: true });
const { makeSetupReady } = await import('./lib/make-setup-ready.js');
makeSetupReady(BHOME, { realHome: REAL_HOME, name: '判据验收' });

const G: any = await import('../src/agents/goal-store.js');
const R: any = await import('../src/agents/run-store.js');
const S: any = await import('../src/agents/execution-supervisor.js');
const C: any = await import('../src/agents/goal-criteria.js');

let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d?: unknown) => {
  if (ok) { passed++; console.log(`  ✅ ${n}`); }
  else { failed++; console.log(`  ❌ ${n}${d !== undefined ? ` — ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 220)}` : ''}`); }
};
const section = (t: string) => console.log(`\n${t}`);

/** 确定性 runner: 起真 Run, 落证据, 按需满足判据 */
function makeRunner(opts: { satisfy?: boolean; fail?: boolean; evidence?: string } = {}) {
  return async (req: any) => {
    const run = await R.startRun({ goal: req.goal.objective, goalId: req.goal.goalId, surface: 'verify-criteria' } as any);
    // 真 runner 会把 Run 挂到 Goal 上 (pi-sdk 里做); 这里显式做同一件事, 否则 Goal.runs 永远为空
    await G.attachRun(req.goal.goalId, run.runId, { makeCurrent: true }).catch(() => null);
    await R.recordStep(run.runId, { tool: 'work_step', ok: true, summary: '干一步' });
    if (opts.fail) {
      await R.finishRun(run.runId, { status: 'failed', summary: '这一步失败了', error: '模拟失败', evidence: [] });
      return { runId: run.runId, status: 'failed' };
    }
    await R.finishRun(run.runId, { status: 'done', summary: '完成一步', evidence: [opts.evidence || `run ${run.runId.slice(0, 6)} 产出`] });
    if (opts.satisfy !== false) {
      const g = await G.readGoal(req.goal.goalId);
      for (let i = 0; i < (g.successCriteria || []).length; i++) await G.markCriterion(req.goal.goalId, i, true, `判据 ${i} 已满足`);
    }
    return { runId: run.runId, status: 'done' };
  };
}
const sup = (runner: any, owner = 'w-crit') => new S.ExecutionSupervisor({ runner: runner as any, owner, maxPerTick: 5, log: () => {} });
/** 建 Goal 并置 active (execution 只对 active 的 Goal 有兴趣); 其它 Goal 先暂停, 免得抢唯一的执行槽 */
async function mkGoal(opts: any) {
  const g = await G.createGoal(opts);
  await G.updateGoal(g.goalId, { status: 'active' });
  return g;
}
async function pauseOthers(keep: string) {
  for (const g of await G.listGoals({ limit: 50 })) {
    if (g.goalId === keep) continue;
    if (['completed', 'failed', 'abandoned', 'paused'].includes(g.status)) continue;
    await G.updateGoal(g.goalId, { status: 'paused' }).catch(() => null);
    await G.setContinuation(g.goalId, { autoContinue: false, wakeReason: 'paused' }).catch(() => null);
  }
}

async function main() {
  // ── [1] 用户给了判据 → 直接可用 → 满足即完成 ────────────────────────────
  section('[1] 用户明确给出判据 → criteriaSource=user / 已确认 → 满足即完成');
  const g1 = await mkGoal({ objective: '写出 verify.md 并验证内容', successCriteria: ['verify.md 存在', '内容被验证'], channelId: 'ch-c', agentId: 'ag-c' } as any);
  const rec1 = await G.readGoal(g1.goalId);
  check('criteriaSource=user', rec1.criteriaSource === 'user', rec1.criteriaSource);
  check('已确认 (用户给的就是确认的)', rec1.criteriaConfirmed === true, rec1.criteriaConfirmed);
  await pauseOthers(g1.goalId);
  await sup(makeRunner({ satisfy: true })).tickOnce();
  const after1 = await G.readGoal(g1.goalId);
  check('判据满足 + 有证据 → Goal completed', after1.status === 'completed', { status: after1.status, reason: after1.resolution?.reason });

  // ── [2] 没给判据 → agent 提候选 → 未确认不许完成 ────────────────────────
  section('[2] 没有判据 → agent 提候选判据 (未确认) → 不许完成; 确认后完成');
  const g2 = await mkGoal({ objective: '整理并汇总本月的数据文件', channelId: 'ch-c', agentId: 'ag-c' } as any);
  await pauseOthers(g2.goalId);
  await sup(makeRunner({ satisfy: false })).tickOnce();
  const rec2 = await G.readGoal(g2.goalId);
  check('已写入候选判据', (rec2.successCriteria || []).length > 0, rec2.successCriteria);
  check('criteriaSource=agent_proposed', rec2.criteriaSource === 'agent_proposed', rec2.criteriaSource);
  check('候选未确认', rec2.criteriaConfirmed !== true, rec2.criteriaConfirmed);
  check('未确认 → Goal 没有 completed', rec2.status !== 'completed', rec2.status);
  const lt2 = await C.longTermStatus(g2.goalId);
  check('长期完成门解释为"判据未确认"', lt2.canComplete === false && /确认/.test(lt2.reason), lt2.reason);
  // 满足判据但不确认 → 仍不能完成
  for (let i = 0; i < rec2.successCriteria.length; i++) await G.markCriterion(g2.goalId, i, true, '满足');
  await sup(makeRunner({ satisfy: false })).tickOnce();
  const rec2b = await G.readGoal(g2.goalId);
  check('即使判据都满足, 未确认仍不完成', rec2b.status !== 'completed', rec2b.status);
  const conf = await C.confirmCriteria(g2.goalId, { by: 'verify' });
  check('人工确认成功', conf.ok === true, conf.reason);
  await sup(makeRunner({ satisfy: true })).tickOnce();
  const rec2c = await G.readGoal(g2.goalId);
  check('确认后可以完成', rec2c.status === 'completed', { status: rec2c.status, why: rec2c.resolution?.reason });

  // ── [3] 模糊目标 → 交人, 不伪造判据 ────────────────────────────────────
  section('[3] 目标过于模糊 → 判据生成失败 → 交人 (不伪造)');
  const vague = C.proposeCriteria('优化一下');
  check('模糊目标被判为需要人', vague.ok === false && vague.needsHuman === true, vague);
  const g3 = await mkGoal({ objective: '优化一下', channelId: 'ch-c', agentId: 'ag-c' } as any);
  await pauseOthers(g3.goalId);
  await sup(makeRunner({ satisfy: false })).tickOnce();
  const rec3 = await G.readGoal(g3.goalId);
  check('模糊目标 → needs_human', rec3.status === 'needs_human', rec3.status);
  check('没有写假判据', (rec3.successCriteria || []).length === 0, rec3.successCriteria);
  check('也没有判完成', rec3.status !== 'completed');

  // ── [4] 证据跨 Run 汇总 ────────────────────────────────────────────────
  section('[4] 证据跨 Run 汇总 (3 条 Run 的证据都进 Goal)');
  const g4 = await mkGoal({ objective: '写出 a.txt 并验证', successCriteria: ['a.txt 存在'], channelId: 'ch-c', agentId: 'ag-c' } as any);
  for (let i = 0; i < 3; i++) {
    await G.updateGoal(g4.goalId, { status: 'active' });     // 每轮重新放活, 让它跨多 Run 累积
    await pauseOthers(g4.goalId);
    await sup(makeRunner({ satisfy: false, evidence: `第 ${i + 1} 轮证据` })).tickOnce();
  }
  const sum4 = await C.aggregateEvidence(g4.goalId);
  const rec4 = await G.readGoal(g4.goalId);
  check('至少 3 条 Run 被汇总', sum4.runs >= 3, sum4.runs);
  check('Goal 证据含每一轮的痕迹', (rec4.evidence || []).join(' ').includes('第 1 轮证据') && (rec4.evidence || []).join(' ').includes('第 3 轮证据'), (rec4.evidence || []).slice(-4));
  check('证据里带 runId+状态 (可追溯)', /\[[0-9a-z]{8} (done|failed|aborted)\]/.test((rec4.evidence || []).join(' ')));

  // ── [5] unresolvedItems 阻塞完成 ───────────────────────────────────────
  section('[5] unresolvedItems 阻塞完成; 清掉后可完成');
  const g5 = await mkGoal({ objective: '写出 b.txt 并验证', successCriteria: ['b.txt 存在'], channelId: 'ch-c', agentId: 'ag-c' } as any);
  await pauseOthers(g5.goalId);
  await sup(makeRunner({ satisfy: true })).tickOnce();
  const rec5 = await G.readGoal(g5.goalId);
  check('正常情况下能完成', rec5.status === 'completed', rec5.status);
  const g5b = await mkGoal({ objective: '写出 c.txt 并验证', successCriteria: ['c.txt 存在'], channelId: 'ch-c', agentId: 'ag-c' } as any);
  await G.setUnresolved(g5b.goalId, ['还有一个边界没处理']);
  await pauseOthers(g5b.goalId);
  await sup(makeRunner({ satisfy: true })).tickOnce();
  const rec5b = await G.readGoal(g5b.goalId);
  check('有未解决项 → 不完成', rec5b.status !== 'completed', rec5b.status);
  const lt5b = await C.longTermStatus(g5b.goalId);
  check('原因说清是未解决项', /未解决/.test(lt5b.reason), lt5b.reason);
  await G.setUnresolved(g5b.goalId, []);
  await G.updateGoal(g5b.goalId, { status: 'active' } as any);
  await pauseOthers(g5b.goalId);
  await sup(makeRunner({ satisfy: true })).tickOnce();
  check('清掉未解决项后可完成', (await G.readGoal(g5b.goalId)).status === 'completed');

  // ── [6] 最近一条 Run 失败 → 阻塞完成 ───────────────────────────────────
  section('[6] 最近一条 Run 是 failed → 不许判完成');
  const g6 = await mkGoal({ objective: '写出 d.txt 并验证', successCriteria: ['d.txt 存在'], channelId: 'ch-c', agentId: 'ag-c' } as any);
  await G.markCriterion(g6.goalId, 0, true, '判据满足');
  await G.addEvidence(g6.goalId, ['伪造的证据: 判据说满足了']);
  await pauseOthers(g6.goalId);
  await sup(makeRunner({ fail: true })).tickOnce();
  const lt6 = await C.longTermStatus(g6.goalId);
  check('长期完成门拒绝 (最近 Run 失败)', lt6.canComplete === false, lt6);
  const rec6 = await G.readGoal(g6.goalId);
  check('Goal 没有被判完成', rec6.status !== 'completed', rec6.status);

  // ── [7] Web 面板 + 判据 API (2-H) ──────────────────────────────────────
  section('[7] Web 长期执行面板 + 判据 API (与 CLI 同一份事实)');
  const { createWebServer } = await import('../src/web/server.js') as any;
  const app = await createWebServer({ port: 0, headless: true } as any);
  const server = app?.server || app;
  const addr: any = await new Promise((res) => { if (server?.address?.()) res(server.address()); else server?.once?.('listening', () => res(server.address())); });
  const base = `http://127.0.0.1:${addr?.port || 0}`;
  try {
    const page = await fetch(`${base}/goals`);
    const html = await page.text();
    check('GET /goals 是可用的面板页', page.status === 200 && html.includes('/api/goals') && html.includes('判据'), page.status);
    const crit = await (await fetch(`${base}/api/goals/${g2.goalId}/criteria`)).json() as any;
    check('判据 API 返回来源/确认/长期门', crit.criteriaSource === 'agent_proposed' && crit.criteriaConfirmed === true && !!crit.longTerm, { src: crit.criteriaSource, conf: crit.criteriaConfirmed });
    check('判据 API 与 CLI 同一份事实 (判据文本一致)', JSON.stringify(crit.successCriteria) === JSON.stringify((await G.readGoal(g2.goalId)).successCriteria), crit.successCriteria);
    const proposed = await (await fetch(`${base}/api/goals/${g3.goalId}/criteria`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ propose: true }) })).json() as any;
    check('POST propose 对模糊目标如实说需要人', proposed.ok === false && proposed.needsHuman === true, proposed);
    const g7 = await mkGoal({ objective: '写出 e.txt 并验证', channelId: 'ch-c', agentId: 'ag-c' } as any);
    const confResp = await (await fetch(`${base}/api/goals/${g7.goalId}/criteria`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ criteria: ['e.txt 存在'], }) })).json() as any;
    check('POST 确认判据成功 (Web 能改判据)', confResp.ok === true && confResp.criteriaVersion >= 1, confResp);
    const runsApi = await (await fetch(`${base}/api/runs`)).json() as any;
    check('/api/runs 面板数据可用', Array.isArray(runsApi.runs), Object.keys(runsApi));
  } catch (err: any) {
    check('Web 面板/API 可达', false, String(err?.message || err).slice(0, 140));
  } finally { try { server?.close?.(); } catch { /* ignore */ } }

  console.log(`\n=== 结果: ${passed} passed, ${failed} failed ===`);
  console.log(`隔离 HOME: ${HOME}`);
  process.exit(failed === 0 ? 0 : 1);
}

await main();
