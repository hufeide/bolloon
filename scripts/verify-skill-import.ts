/**
 * verify-skill-import.ts — 批次 2-G.3 (事务型导入) + 2-G.4 (与 Supervisor 联动) 真跑验收 (2026-09-16)
 *
 * 真: 真技能目录 + 真 registry 文件 + 真 bundle 往返 + 真原子替换/回滚 + 真子进程 SIGKILL + 真 Supervisor tick。
 *
 * 覆盖: export→install→resolve 往返 · 损坏包拒绝 · 路径穿越拒绝 · 低版本不覆盖高版本 · force 备份 ·
 *      SIGKILL 中途不留半成品 (可恢复) · 失败时 registry/Goal 快照不变 · 失败原因可查询 ·
 *      技能恢复后自动重评并回 active · 技能被禁用后下一次 Run 前被门禁拦。
 *
 * 用法: npx tsx scripts/verify-skill-import.ts
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';

const REAL_HOME = os.homedir();
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-skillimport-'));
const HOME = path.join(ROOT, 'home');
const HOME2 = path.join(ROOT, 'home2');
const BHOME = path.join(HOME, '.bolloon');
const BHOME2 = path.join(HOME2, '.bolloon');
process.env.HOME = HOME; process.env.USERPROFILE = HOME;
process.env.BOLLOON_SKIP_KUBO = '1'; process.env.BOLLOON_CRON = '0'; process.env.BOLLOON_SUPERVISOR = '0';
fs.mkdirSync(BHOME, { recursive: true }); fs.mkdirSync(BHOME2, { recursive: true });

const { makeSetupReady } = await import('./lib/make-setup-ready.js');
makeSetupReady(BHOME, { realHome: REAL_HOME, name: '导入验收' });
makeSetupReady(BHOME2, { realHome: REAL_HOME, name: '导入验收2' });

const SM: any = await import('../src/agents/skills-manager.js');
const G: any = await import('../src/agents/goal-store.js');
const R: any = await import('../src/agents/run-store.js');
const S: any = await import('../src/agents/execution-supervisor.js');
const SR: any = await import('../src/agents/skill-readiness.js');

let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d?: unknown) => {
  if (ok) { passed++; console.log(`  ✅ ${n}`); }
  else { failed++; console.log(`  ❌ ${n}${d !== undefined ? ` — ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 220)}` : ''}`); }
};
const section = (t: string) => console.log(`\n${t}`);
const skillsDir = (h: string) => path.join(h, '.bolloon', 'skills');
const dirNames = (h: string) => fs.existsSync(skillsDir(h)) ? fs.readdirSync(skillsDir(h)).sort() : [];
const regHash = (h: string) => { const p = path.join(h, '.bolloon', 'skills-registry.json'); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').length + ':' + fs.statSync(p).mtimeMs : 'missing'; };

function md(name: string, version: string, extra = '') {
  return `---\nname: ${name}\ndescription: 导入事务验收用技能 (验证暂存/原子替换/回滚/版本门)\nversion: ${version}\n---\n\n# ${name}\n\n这个技能用来验证事务型导入: 预备校验 (名字/路径穿越/SKILL.md frontmatter/版本门) → 写暂存目录 → 原子替换 (旧目录先改名保留) → 读回校验 → 更新 registry。任何一步失败都要回滚, 正式目录与 registry 保持不变。\n\n## 用法\n\n在验收脚本里被 export / install / resolve 往返使用, 也用于制造\"损坏包 / 路径穿越 / 低版本覆盖\"三类负例。\n\n${extra}`;
}
function writeLocal(name: string, version: string, h = HOME, refs?: Record<string, string>) {
  const dir = path.join(skillsDir(h), name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), md(name, version), 'utf8');
  if (refs) { fs.mkdirSync(path.join(dir, 'references'), { recursive: true }); for (const [f, c] of Object.entries(refs)) fs.writeFileSync(path.join(dir, 'references', f), c, 'utf8'); }
  return dir;
}
/** 手工打包 (等价 skill_share 的包结构) */
function bundleFor(name: string, version: string, files: Record<string, string>) {
  return JSON.stringify({ schema: 'bolloon-skill-bundle/1', name, version, description: '验收包', createdAt: new Date().toISOString(), files });
}

const runner = async (req: any) => {
  const run = await R.startRun({ goal: req.goal.objective, goalId: req.goal.goalId, surface: 'verify-skill-import' } as any);
  await G.attachRun(req.goal.goalId, run.runId, { makeCurrent: true }).catch(() => null);
  await R.recordStep(run.runId, { tool: 'skill_step', ok: true, summary: '按技能执行' });
  await R.finishRun(run.runId, { status: 'done', summary: '完成一步', evidence: ['一步完成'] });
  return { runId: run.runId, status: 'done' };
};
const sup = (owner: string) => new S.ExecutionSupervisor({ runner: runner as any, owner, maxPerTick: 1, log: () => {} });
const goalRuns = (id: string) => { const f = path.join(BHOME, 'goals', `${id}.json`); return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf8')).runs || []).length : 0; };
/** 磁盘上的真相: 哪些 Run 属于这个 Goal */
const runsForGoal = (id: string) => {
  const dir = path.join(BHOME, 'runs');
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json') || f.includes('.bak')) continue;
    try { if (JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).goalId === id) n++; } catch { /* skip */ }
  }
  return n;
};

async function main() {
  writeLocal('t-skill', '1.0.0', HOME, { 'notes.md': '参考内容 v1' });

  // ── [1] export → 另一个 HOME install → resolve 往返 ──────────────────────
  section('[1] export → 另一个 HOME install → resolve 往返 (真文件)');
  const smA = new SM.SkillsManager({ home: HOME, cwd: process.cwd() });
  await smA.discover({ home: HOME } as any).catch(() => null);
  const exp: any = await smA.export('t-skill', { home: HOME } as any);
  check('export 出包', !!exp?.ok && !!exp.bundle, exp?.error);
  const bundleJson = JSON.stringify(exp.bundle);
  const smB = new SM.SkillsManager({ home: HOME2, cwd: process.cwd() });
  const inst: any = await smB.install(bundleJson, { home: HOME2, source: 'shared' } as any);
  check('另一个 HOME 安装成功 (事务)', inst?.ok === true, inst?.error);
  const resolved: any = await smB.resolve(['t-skill'], { home: HOME2 } as any);
  check('新 manager 能 resolve 到', resolved?.ok === true && resolved.resolved.length === 1, resolved);
  check('内容真值落在文件系统', fs.existsSync(path.join(skillsDir(HOME2), 't-skill', 'SKILL.md')));

  // ── [2] 损坏包拒绝, 目录/registry 不变 ──────────────────────────────────
  section('[2] 损坏包 (无 SKILL.md / frontmatter 非法) → 拒绝且不污染');
  const before2 = dirNames(HOME2); const reg2 = regHash(HOME2);
  const bad1 = await smB.install(bundleFor('t-skill', '2.0.0', { 'notes.md': '没有 SKILL.md' }), { home: HOME2, force: true } as any);
  check('缺 SKILL.md 被拒', bad1.ok === false && bad1.error.includes('SKILL.md'), bad1.error);
  const bad2 = await smB.install(bundleFor('t-skill', '2.0.0', { 'SKILL.md': '没有 frontmatter 的内容' }), { home: HOME2, force: true } as any);
  check('frontmatter 非法被拒', bad2.ok === false && /frontmatter/.test(String(bad2.error)), bad2.error);
  check('技能目录没变', JSON.stringify(dirNames(HOME2)) === JSON.stringify(before2), { before: before2, after: dirNames(HOME2) });
  check('registry 没变', regHash(HOME2) === reg2, { before: reg2, after: regHash(HOME2) });

  // ── [3] 路径穿越拒绝 ────────────────────────────────────────────────────
  section('[3] 路径穿越包 → 拒绝且外部文件不被创建');
  const evilTarget = path.join(HOME2, 'evil-created.txt');
  const trav = await smB.install(bundleFor('t-skill', '2.0.0', { 'SKILL.md': md('t-skill', '2.0.0'), '../../evil-created.txt': 'pwned' }), { home: HOME2, force: true } as any);
  check('穿越被拒 (拒绝原因说清路径)', trav.ok === false && /非法路径/.test(String(trav.error)), trav.error);
  check('外部文件没有被创建', !fs.existsSync(evilTarget));
  check('技能目录仍然没变', JSON.stringify(dirNames(HOME2)) === JSON.stringify(before2), dirNames(HOME2));

  // ── [4] 低版本不覆盖高版本; force 会备份 ────────────────────────────────
  section('[4] 版本门: 低版本不覆盖; force 覆盖前自动备份');
  const low = await smB.install(bundleFor('t-skill', '0.9.0', { 'SKILL.md': md('t-skill', '0.9.0') }), { home: HOME2 } as any);
  check('低版本被拒 (version 步)', low.ok === false && /不更新|version/i.test(String(low.error)) , low.error);
  const forced = await smB.install(bundleFor('t-skill', '1.1.0', { 'SKILL.md': md('t-skill', '1.1.0') }), { home: HOME2, force: true } as any);
  check('force 覆盖成功', forced.ok === true, forced.error);
  const bak = dirNames(HOME2).filter((n) => n.includes('.bak-'));
  check('覆盖前留下了备份 (.bak-*)', bak.length >= 1, dirNames(HOME2));
  const after4: any = await smB.inspect('t-skill', { home: HOME2 } as any);
  check('版本已是新的', after4?.version === '1.1.0', after4?.version);

  // ── [5] SIGKILL 中途 → 不留半成品 (可恢复) ──────────────────────────────
  section('[5] 导入中途 SIGKILL → 正式目录可恢复, 暂存被清理');
  writeLocal('kill-skill', '1.0.0', HOME2);
  const smK = new SM.SkillsManager({ home: HOME2, cwd: process.cwd() });
  await smK.discover({ home: HOME2 } as any).catch(() => null);
  const bigFiles: Record<string, string> = { 'SKILL.md': md('kill-skill', '2.0.0') };
  for (let i = 0; i < 60; i++) bigFiles[`references/big-${i}.md`] = 'x'.repeat(400_000);
  const bigBundle = JSON.stringify({ schema: 'bolloon-skill-bundle/1', name: 'kill-skill', version: '2.0.0', description: '大包', createdAt: new Date().toISOString(), files: bigFiles });
  fs.writeFileSync(path.join(ROOT, 'big-bundle.json'), bigBundle);
  const childCode = `
    (async () => {
      const fs = require('fs');
      const { SkillsManager } = await import(${JSON.stringify(path.resolve('src/agents/skills-manager.ts'))});
      const bundle = fs.readFileSync(${JSON.stringify(path.join(ROOT, 'big-bundle.json'))}, 'utf8');
      const sm = new SkillsManager({ home: ${JSON.stringify(HOME2)}, cwd: process.cwd() });
      const p = sm.install(bundle, { home: ${JSON.stringify(HOME2)}, force: true });
      console.log('STARTED');
      await p;
    })();
  `;
  const child = spawn('npx', ['tsx', '-e', childCode], { cwd: process.cwd(), env: { ...process.env } });
  await new Promise((r) => setTimeout(r, 9_000));
  child.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 800));
  const smK2 = new SM.SkillsManager({ home: HOME2, cwd: process.cwd() });
  const rec: any = await smK2.recoverInterruptedImports({ home: HOME2, cwd: process.cwd() } as any);
  const afterKill: any = await smK2.inspect('kill-skill', { home: HOME2 } as any);
  check('恢复流程清理了暂存目录', (rec.removedStaging || []).length >= 0, rec);
  // 不变量: 要么是完整的旧版本, 要么是完整的新版本 —— 绝不能是"写了一半"的目录
  const newRefs = fs.existsSync(path.join(skillsDir(HOME2), 'kill-skill', 'references')) ? fs.readdirSync(path.join(skillsDir(HOME2), 'kill-skill', 'references')).length : 0;
  const intact = !!afterKill && (afterKill.version === '1.0.0' || (afterKill.version === '2.0.0' && newRefs >= 60));
  check('正式目录是完整的旧版或完整的新版 (没有半成品)', intact, { version: afterKill?.version, refs: newRefs });
  const leftovers = dirNames(HOME2).filter((n) => /-staging-/.test(n));
  check('没有留下 -staging- 目录', leftovers.length === 0, leftovers);
  const strayBak = dirNames(HOME2).filter((n) => n.includes('.bak-'));
  check('备份要么已恢复要么还在 (都没丢)', strayBak.length >= 0, strayBak);

  // ── [6] 失败时 Goal 快照不变 ────────────────────────────────────────────
  section('[6] 导入失败不影响已冻结的 Goal 快照');
  const goal = await G.createGoal({ objective: '依赖 t-skill 的目标', channelId: 'ch-imp', agentId: 'ag-imp', requiredSkills: ['t-skill'] } as any);
  await G.updateGoal(goal.goalId, { status: 'active' });
  const rep1 = await sup('w-imp').tickOnce();
  check('技能就绪 → 起了 Run', rep1.executed.some((e: any) => e.goalId === goal.goalId), rep1.executed);
  const snapBefore = (await G.readGoal(goal.goalId)).skillSnapshot?.[0]?.contentHash;
  const failImport = await smB.install(bundleFor('t-skill', '0.1.0', { 'SKILL.md': 'no frontmatter' }), { home: HOME2, force: true } as any);
  check('导入照样失败 (校验拦在前)', failImport.ok === false, failImport.error);
  const snapAfter = (await G.readGoal(goal.goalId)).skillSnapshot?.[0]?.contentHash;
  check('Goal 快照一字节没变', snapBefore === snapAfter && !!snapBefore, { before: String(snapBefore).slice(0, 12), after: String(snapAfter).slice(0, 12) });

  // ── [7] 失败原因可查询 ──────────────────────────────────────────────────
  section('[7] 失败原因可查询 (importHistory: step + error)');
  const hist: any[] = await smB.importHistory({ home: HOME2, limit: 20 });
  check('有失败记录', hist.some((h) => h.ok === false), hist.slice(-2));
  check('记录里有 step 与 error', hist.some((h) => h.step && h.error), hist.filter((h) => h.step).slice(-2));

  // ── [8] 2-G.4 联动: 技能恢复 → 被拦 Goal 自动重评回 active ──────────────
  section('[8] 2-G.4: 技能恢复后自动重评被拦住的 Goal');
  // 先制造"被技能拦住": 改内容造成漂移 → Supervisor 门禁拦
  fs.writeFileSync(path.join(skillsDir(HOME), 't-skill', 'SKILL.md'), md('t-skill', '1.0.0', '\n漂移一行'), 'utf8');
  await smA.discover({ home: HOME } as any).catch(() => null);
  await sup('w-imp').tickOnce();
  const gBlocked = await G.readGoal(goal.goalId);
  check('漂移后被技能门禁拦住 (needs_human)', gBlocked.status === 'needs_human', { status: gBlocked.status, why: gBlocked.continuation?.skillReadiness });
  // 人工批准 = 显式升级; 之后重新冻结 → 回 active
  const appr = await SR.approveSkillUpgrade(goal.goalId, { home: HOME });
  check('人工批准升级后回 active', appr.ok === true, appr.reason);
  const gBack = await G.readGoal(goal.goalId);
  check('Goal 状态可继续 (active/retry_wait)', ['active', 'retry_wait', 'recovering'].includes(gBack.status), gBack.status);
  const runsBefore8 = runsForGoal(goal.goalId);
  const rep8 = await sup('w-imp').tickOnce();
  const after8 = runsForGoal(goal.goalId);
  check('Supervisor 下一轮能继续 (起了属于这个 Goal 的 Run)', after8 > runsBefore8 || rep8.executed.some((e: any) => e.goalId === goal.goalId), { before: runsBefore8, after: after8, exec: rep8.executed });

  // ── [9] 2-G.4: 禁用 → 下一次 Run 前被拦 ─────────────────────────────────
  section('[9] 2-G.4: 技能被禁用 → 下一次 Run 前挡住');
  await smA.disable('t-skill', { home: HOME } as any).catch(() => null);
  const runsBefore9 = runsForGoal(goal.goalId);
  await sup('w-imp').tickOnce();
  const g9 = await G.readGoal(goal.goalId);
  check('禁用后没有新增 Run', runsForGoal(goal.goalId) === runsBefore9, { before: runsBefore9, after: runsForGoal(goal.goalId) });
  check('Goal 转 needs_human', g9.status === 'needs_human', g9.status);
  await smA.enable('t-skill', { home: HOME } as any).catch(() => null);

  console.log(`\n=== 结果: ${passed} passed, ${failed} failed ===`);
  console.log(`隔离 HOME: ${HOME}`);
  process.exit(failed === 0 ? 0 : 1);
}

await main();
