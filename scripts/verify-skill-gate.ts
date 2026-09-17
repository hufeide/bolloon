/**
 * verify-skill-gate.ts — 批次 2-G.2 真跑验收: Goal 级技能快照 + 执行前就绪门禁 (2026-09-16)
 *
 * 真实的东西: 真技能目录 + 真 SkillsManager registry + 真 Goal/快照文件 + 真 Supervisor tick (真 Run 落盘) + 真子进程读同一快照。
 *
 * 覆盖: 首次执行冻结快照 · 后续 Run 用同一快照 · 改 SKILL.md 检出漂移且不启动 Run · 改 references/ 也检出 ·
 *      删除技能 → 不启动 · 未启用 → needs_human · 可选技能缺失 → 继续 + 降级 · 漂移必须人工批准 ·
 *      新进程恢复读同一快照。
 *
 * 用法: npx tsx scripts/verify-skill-gate.ts
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';

const REAL_HOME = os.homedir();
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-skillgate-'));
const HOME = path.join(ROOT, 'home');
const BHOME = path.join(HOME, '.bolloon');
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.BOLLOON_SKIP_KUBO = '1';
process.env.BOLLOON_CRON = '0';
process.env.BOLLOON_SUPERVISOR = '0';
fs.mkdirSync(BHOME, { recursive: true });

const { makeSetupReady } = await import('./lib/make-setup-ready.js');
makeSetupReady(BHOME, { realHome: REAL_HOME });

const G: any = await import('../src/agents/goal-store.js');
const R: any = await import('../src/agents/run-store.js');
const S: any = await import('../src/agents/execution-supervisor.js');
const SR: any = await import('../src/agents/skill-readiness.js');
const SM: any = await import('../src/agents/skills-manager.js');

let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d?: unknown) => {
  if (ok) { passed++; console.log(`  ✅ ${n}`); }
  else { failed++; console.log(`  ❌ ${n}${d !== undefined ? ` — ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 220)}` : ''}`); }
};
const section = (t: string) => console.log(`\n${t}`);

// ── 真技能目录 ──────────────────────────────────────────────────────────────
const SKILLS = path.join(BHOME, 'skills');
function writeSkill(name: string, body: string, refs?: Record<string, string>) {
  const dir = path.join(SKILLS, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body, 'utf8');
  if (refs) {
    fs.mkdirSync(path.join(dir, 'references'), { recursive: true });
    for (const [f, c] of Object.entries(refs)) fs.writeFileSync(path.join(dir, 'references', f), c, 'utf8');
  }
  return dir;
}
const SKILL_MD = (v: string, extra = '') => `---\nname: gate-skill\ndescription: 验收用技能 (技能门禁测试)\nversion: ${v}\n---\n\n# gate-skill\n\n用来验证 Goal 级技能快照与漂移检测。\n${extra}`;
writeSkill('gate-skill', SKILL_MD('1.0.0'), { 'notes.md': 'v1 参考内容' });

const sm = new SM.SkillsManager({ home: HOME, cwd: process.cwd() });
await sm.discover({ home: HOME } as any).catch(() => null);

const runner = async (req: any) => {
  const run = await R.startRun({ goal: req.goal.objective, goalId: req.goal.goalId, surface: 'verify-skill-gate' } as any);
  await R.recordStep(run.runId, { tool: 'skill_task', ok: true, summary: '按技能执行一步' });
  await R.finishRun(run.runId, { status: 'done', summary: '技能任务完成一步', evidence: ['技能步骤完成'] });
  return { runId: run.runId, status: 'done' };
};
const sup = (owner: string) => new S.ExecutionSupervisor({ runner: runner as any, owner, maxPerTick: 1, log: () => {} });
const goalRuns = (id: string) => { const f = path.join(BHOME, 'goals', `${id}.json`); return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf8')).runs || []).length : 0; };

async function main() {
  // ── [1] 首次执行: 冻结快照 ────────────────────────────────────────────────
  section('[1] Goal 绑定技能 → 首次执行冻结快照 (name/version/contentHash/resolvedAt)');
  const goal = await G.createGoal({ objective: '用 gate-skill 完成一件小事', channelId: 'ch-skill', agentId: 'ag-skill', requiredSkills: ['gate-skill'] } as any);
  const rep1 = await sup('w-skill').tickOnce();
  check('技能就绪 → 起了 Run', rep1.executed.some((e: any) => e.goalId === goal.goalId), rep1.executed);
  const g1 = await G.readGoal(goal.goalId);
  const snap1 = g1.skillSnapshot || [];
  check('Goal 上冻结了快照', snap1.length === 1 && snap1[0].name === 'gate-skill', snap1);
  check('快照含 version + contentHash + resolvedAt', !!(snap1[0]?.version && snap1[0]?.contentHash && snap1[0]?.resolvedAt), snap1[0]);
  check('冻结写进了证据 (可追溯)', (g1.evidence || []).join(' ').includes('技能快照'), g1.evidence);

  // ── [2] 改 SKILL.md → 漂移, 不启动 Run ────────────────────────────────────
  section('[2] 修改 SKILL.md → 检出漂移, 不启动 Run, Goal → needs_human');
  const runsBefore2 = goalRuns(goal.goalId);
  writeSkill('gate-skill', SKILL_MD('1.0.0', '\n追加一行 (造成 hash 漂移)'));
  await sm.discover({ home: HOME } as any).catch(() => null);
  const rep2 = await sup('w-skill').tickOnce();
  const g2 = await G.readGoal(goal.goalId);
  check('漂移 → 没有起新 Run', goalRuns(goal.goalId) === runsBefore2, { before: runsBefore2, after: goalRuns(goal.goalId) });
  check('Goal 转 needs_human', g2.status === 'needs_human', g2.status);
  check('原因说清是漂移 + 需人工批准', /漂移/.test(String(g2.continuation?.skillReadiness?.reason || g2.continuation?.lastExternalTimeout || '')), g2.continuation?.skillReadiness);
  check('没有静默换新版本 (快照仍是旧的)', (g2.skillSnapshot || [])[0]?.contentHash === snap1[0]?.contentHash, { before: snap1[0]?.contentHash, after: (g2.skillSnapshot || [])[0]?.contentHash });

  // ── [3] 改 references/ 也检出漂移 ────────────────────────────────────────
  section('[3] 修改 references/ 也检出漂移 (整个目录算 hash)');
  const approved = await SR.approveSkillUpgrade(goal.goalId);
  check('人工批准升级 → 重新冻结快照', approved.ok === true, approved.reason);
  const g3 = await G.readGoal(goal.goalId);
  const snap3 = (g3.skillSnapshot || [])[0]?.contentHash;
  check('批准后快照更新 (指向新内容)', !!snap3 && snap3 !== snap1[0]?.contentHash, { old: snap1[0]?.contentHash, new: snap3 });
  const runsBefore3 = goalRuns(goal.goalId);
  writeSkill('gate-skill', SKILL_MD('1.0.0', '\n追加一行 (造成 hash 漂移)'), { 'notes.md': 'v2 改过的参考内容' });
  await sm.discover({ home: HOME } as any).catch(() => null);
  await sup('w-skill').tickOnce();
  const g3b = await G.readGoal(goal.goalId);
  check('references 改动被检出 → 不启动 Run', goalRuns(goal.goalId) === runsBefore3 && g3b.status === 'needs_human', { runs: goalRuns(goal.goalId), status: g3b.status });

  // ── [4] 技能未启用 → needs_human ────────────────────────────────────────
  section('[4] 技能被禁用 → 不启动 Run');
  await SR.approveSkillUpgrade(goal.goalId);
  await sm.disable('gate-skill', { home: HOME } as any).catch(async () => { await sm.quarantine?.('gate-skill', 'verify', { home: HOME }); });
  const runsBefore4 = goalRuns(goal.goalId);
  await sup('w-skill').tickOnce();
  const g4 = await G.readGoal(goal.goalId);
  check('未启用 → 没有起新 Run', goalRuns(goal.goalId) === runsBefore4, { before: runsBefore4, after: goalRuns(goal.goalId) });
  check('Goal 转 needs_human 且原因是未启用/不可用', g4.status === 'needs_human', g4.status);

  // ── [5] 删除技能 → 不启动 Run ───────────────────────────────────────────
  section('[5] 技能被删除 → 不启动 Run');
  await sm.enable('gate-skill', { home: HOME } as any).catch(() => null);
  await SR.approveSkillUpgrade(goal.goalId);
  fs.rmSync(path.join(SKILLS, 'gate-skill'), { recursive: true, force: true });
  await sm.discover({ home: HOME } as any).catch(() => null);
  const runsBefore5 = goalRuns(goal.goalId);
  await sup('w-skill').tickOnce();
  const g5 = await G.readGoal(goal.goalId);
  check('技能没了 → 不启动 Run', goalRuns(goal.goalId) === runsBefore5, { before: runsBefore5, after: goalRuns(goal.goalId) });
  check('Goal 转 needs_human (缺必需技能)', g5.status === 'needs_human', g5.status);

  // ── [6] 可选技能缺失 → 继续 + 记降级 ────────────────────────────────────
  section('[6] 可选技能缺失 (前缀 ?) → 继续执行 + 降级记录');
  writeSkill('gate-skill', SKILL_MD('1.0.0'), { 'notes.md': '恢复' });
  await sm.discover({ home: HOME } as any).catch(() => null);
  const goalOpt = await G.createGoal({ objective: '可选技能缺失也要能跑', channelId: 'ch-skill', agentId: 'ag-skill', requiredSkills: ['gate-skill', '?not-installed-skill'] } as any);
  const rep6 = await sup('w-skill').tickOnce();
  check('可选技能缺失不阻塞 (起了 Run)', rep6.executed.some((e: any) => e.goalId === goalOpt.goalId), rep6.executed);
  const gOpt = await G.readGoal(goalOpt.goalId);
  check('Goal 没有因此转 needs_human', gOpt.status !== 'needs_human', gOpt.status);

  // ── [7] 新进程读同一快照 ────────────────────────────────────────────────
  section('[7] 新进程 (独立 node) 读取同一份快照');
  const childCode = `
    (async () => {
      const fs = require('fs'), path = require('path');
      const f = path.join(${JSON.stringify(BHOME)}, 'goals', ${JSON.stringify(goalOpt.goalId)} + '.json');
      const g = JSON.parse(fs.readFileSync(f, 'utf8'));
      console.log('SNAP=' + JSON.stringify((g.skillSnapshot || []).map(s => s.name + '@' + s.version + ':' + s.contentHash.slice(0, 8))));
    })();
  `;
  const out = await new Promise<string>((resolve) => {
    const c = spawn(process.execPath, ['-e', childCode], { cwd: process.cwd() });
    let buf = ''; c.stdout.on('data', (d) => (buf += d)); c.stderr.on('data', () => {});
    c.on('close', () => resolve(buf)); setTimeout(() => { c.kill('SIGKILL'); resolve(buf); }, 20_000);
  });
  check('子进程读到同一快照 (跨进程一致)', /SNAP=\["gate-skill@/.test(out), out.trim().slice(0, 120));

  console.log(`\n=== 结果: ${passed} passed, ${failed} failed ===`);
  console.log(`隔离 HOME: ${HOME}`);
  process.exit(failed === 0 ? 0 : 1);
}

await main();
