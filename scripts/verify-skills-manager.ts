/**
 * verify-skills-manager.ts — 批次 2-G.1 真跑验收 (2026-09-16)
 *
 * 验的是"统一"这件事本身:
 *  [1] 真目录 (user 层 + project 层 + 坏目录) → 统一视图, 来源/状态/指纹都有
 *  [2] **三方同一份事实**: manager 视图 == CLI 渲染所用记录 == Web `/api/skills` (逐字段比对)
 *  [3] disable → 三方同时变; enable 回来
 *  [4] 改 SKILL.md → health 检出内容漂移 (跨进程重启仍记得基线)
 *  [5] 坏技能 → invalid + issues (Web 也看得到)
 *  [6] export → 另一个 HOME install → 新进程能解析 (真文件系统往返, 不经 IPFS)
 *  [7] resolve/snapshot: 缺技能 / 未启用分别说清; snapshot 固定版本+hash
 *  [8] Web `/api/skills/health` 与本地 manager.health() 一致
 *
 * 用法: npx tsx scripts/verify-skills-manager.ts
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as fsp from 'fs/promises';

const tmpRoot = path.join(os.tmpdir(), 'bolloon-sm-e2e-' + Date.now());
const HOME = path.join(tmpRoot, 'home');
const CWD = path.join(tmpRoot, 'proj');
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.BOLLOON_SKIP_KUBO = '1';
process.env.BOLLOON_CRON = '0';
process.env.BOLLOON_SUPERVISOR = '0';
fs.mkdirSync(path.join(HOME, '.bolloon'), { recursive: true });
fs.mkdirSync(CWD, { recursive: true });

const PORT = 43100 + Math.floor(Math.random() * 150);
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? ' — ' + String(detail).slice(0, 260) : ''}`); }
};

function skillMd(name: string, opts: { description?: string; version?: string; body?: string } = {}): string {
  return `---
name: ${name}
description: ${opts.description ?? `${name} 的说明`}
version: ${opts.version ?? '1.0.0'}
triggers: [e2e]
---

# ${name}

这是 ${name} 的正文, 内容足够长以通过最小长度校验。

## 用法

按说明执行。
`;
}

async function writeSkill(layer: 'user' | 'project', name: string, opts: Parameters<typeof skillMd>[1] = {}, extra: Record<string, string> = {}) {
  const base = layer === 'user' ? path.join(HOME, '.bolloon', 'skills') : path.join(CWD, '.bolloon', 'skills');
  const dir = path.join(base, name);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'SKILL.md'), skillMd(name, opts), 'utf8');
  for (const [rel, content] of Object.entries(extra)) {
    const p = path.join(dir, rel);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, content, 'utf8');
  }
  return dir;
}

async function main() {
  const M = await import('../src/agents/skills-manager.js');

  await writeSkill('user', 'alpha-skill', { version: '1.2.3' }, { 'references/api.md': '细节 v1' });
  await writeSkill('user', 'beta-skill');
  await writeSkill('project', 'gamma-skill', { version: '2.0.0' });
  await fsp.mkdir(path.join(HOME, '.bolloon', 'skills', 'broken-skill'), { recursive: true });   // 目录在, 缺 SKILL.md

  // ═══════════ [1] 统一视图 ═══════════
  console.log('\n[1] 统一事实模型: 真目录 → 一条记录/技能 (来源/状态/指纹)');
  const sm = new M.SkillsManager({ home: HOME, cwd: CWD });
  const view = await sm.view();
  const names = view.map((s) => s.name).sort();
  check('四个技能都在视图里 (含坏目录, 不静默消失)', JSON.stringify(names) === JSON.stringify(['alpha-skill', 'beta-skill', 'broken-skill', 'gamma-skill']), JSON.stringify(names));
  check('来源标注正确 (user / project)', view.find((s) => s.name === 'alpha-skill')?.source === 'user' && view.find((s) => s.name === 'gamma-skill')?.source === 'project');
  check('坏目录 → invalid 且给出原因', view.find((s) => s.name === 'broken-skill')?.status === 'invalid' && (view.find((s) => s.name === 'broken-skill')?.issues || []).length > 0);
  check('内容指纹覆盖整个目录 (32 位)', view.every((s) => (s.contentHash || '').length === 32));

  // ═══════════ [2] 三方同一份事实 ═══════════
  console.log('\n[2] 三方同一份事实: manager == CLI 渲染 == Web /api/skills');
  const { createWebServer } = await import('../src/web/server.js');
  const started: any = await createWebServer(PORT, { selfImprove: false } as any);
  const base = `http://127.0.0.1:${started?.port || PORT}`;
  const j = async (p: string, init?: any) => {
    const r = await fetch(base + p, init);
    let body: any = null;
    try { body = await r.json(); } catch { /* 非 JSON */ }
    return { status: r.status, body };
  };

  // 与 Web 侧比对必须用**同一个 cwd** (server 的默认 cwd = 进程 cwd; [1] 用的是隔离 proj 目录)
  const viewSameCwd = await new M.SkillsManager({ home: HOME, cwd: process.cwd() }).view();
  const api = await j('/api/skills');
  check('GET /api/skills 可用', api.status === 200 && api.body.count === viewSameCwd.length, JSON.stringify({ status: api.status, count: api.body?.count, local: viewSameCwd.length }));
  const sig = (s: any) => `${s.name}|${s.status}|${s.source}|${s.version}|${s.contentHash}|${s.trust}`;
  const apiSet = new Set((api.body.skills || []).map(sig));
  const localSet = new Set(viewSameCwd.map(sig as any));
  const same = apiSet.size === localSet.size && [...localSet].every((x) => apiSet.has(x));
  check('Web 与本地逐字段一致 (name/status/source/version/hash/trust)', same, JSON.stringify({ api: [...apiSet].slice(0, 2), local: [...localSet].slice(0, 2) }));
  // CLI 渲染用的就是 view() 的记录 → 断言渲染函数能覆盖全部记录 (同一份对象, 不是再扫一遍目录)
  const cliLines = viewSameCwd.map(M.formatSkillLine);
  check('CLI 渲染与视图同源 (每行含同一 hash 前缀)', cliLines.length === viewSameCwd.length && viewSameCwd.every((s, i) => cliLines[i].includes(s.contentHash.slice(0, 10))));

  // ═══════════ [3] disable/enable 三方同步 ═══════════
  console.log('\n[3] disable → 三方同时变 (不是各存一份状态)');
  const dis = await j('/api/skills/beta-skill/disable', { method: 'POST' });
  check('Web 侧 disable 成功', dis.status === 200 && dis.body?.skill?.status === 'disabled', JSON.stringify(dis).slice(0, 200));
  const afterDisable = await new M.SkillsManager({ home: HOME, cwd: CWD }).view();
  check('CLI/manager 侧看到 disabled', afterDisable.find((s) => s.name === 'beta-skill')?.status === 'disabled');
  const api2 = await j('/api/skills');
  check('Web 列表也看到 disabled (同一份 registry)', (api2.body.skills || []).find((s: any) => s.name === 'beta-skill')?.status === 'disabled');
  const en = await j('/api/skills/beta-skill/enable', { method: 'POST' });
  check('enable 能回来', en.status === 200 && (await new M.SkillsManager({ home: HOME, cwd: CWD }).view()).find((s) => s.name === 'beta-skill')?.status === 'enabled');

  // ═══════════ [4] 内容漂移检出 ═══════════
  console.log('\n[4] 改 SKILL.md → 漂移被检出 (registry 基线跨进程有效)');
  const alphaDir = path.join(HOME, '.bolloon', 'skills', 'alpha-skill');
  const h0 = await new M.SkillsManager({ home: HOME, cwd: CWD }).health();
  check('先无漂移', h0.drifted.length === 0, JSON.stringify(h0.drifted));
  await fsp.writeFile(path.join(alphaDir, 'SKILL.md'), skillMd('alpha-skill', { version: '9.9.9' }), 'utf8');
  const h1 = await new M.SkillsManager({ home: HOME, cwd: CWD }).health();
  check('改内容 → 检出 alpha-skill 漂移', h1.drifted.some((d) => d.name === 'alpha-skill'), JSON.stringify(h1.drifted));
  await fsp.writeFile(path.join(alphaDir, 'references/api.md'), '细节 v2', 'utf8');
  const h2 = await new M.SkillsManager({ home: HOME, cwd: CWD }).health();
  check('只改 references 也算漂移 (指纹覆盖整目录)', h2.drifted.some((d) => d.name === 'alpha-skill'));

  // ═══════════ [5] 坏技能不允许启用 ═══════════
  console.log('\n[5] 坏技能: 状态 invalid, 不允许 enable');
  const bad = await j('/api/skills/broken-skill/enable', { method: 'POST' });
  check('Web enable 坏技能被拒 (带原因)', bad.status === 409 || bad.body?.ok === false, JSON.stringify(bad).slice(0, 200));
  const hBad = await new M.SkillsManager({ home: HOME, cwd: CWD }).health();
  check('health 里列出不合格技能与原因', hBad.invalid.some((i) => i.name === 'broken-skill' && i.issues.length > 0), JSON.stringify(hBad.invalid));

  // ═══════════ [6] export → 另一个 HOME 安装 ═══════════
  console.log('\n[6] export → 另一个 HOME install → 新进程能解析 (真文件系统往返)');
  const sm2 = new M.SkillsManager({ home: HOME, cwd: CWD });
  const exp = await sm2.export('gamma-skill');
  check('导出技能包含全部文件', exp.ok && Object.keys(exp.bundle!.files).includes('SKILL.md'), JSON.stringify(exp.error));
  const OTHER = path.join(tmpRoot, 'home2');
  await fsp.mkdir(OTHER, { recursive: true });
  const smOther = new M.SkillsManager({ home: OTHER, cwd: path.join(tmpRoot, 'proj2') });
  const inst = await smOther.install(JSON.stringify(exp.bundle), { source: 'imported', sourceRef: 'e2e-local-bundle' });
  check('安装成功 (落到注入的 HOME, 不污染别处)', inst.ok && !inst.error, String(inst.error));
  const otherView = await new M.SkillsManager({ home: OTHER, cwd: path.join(tmpRoot, 'proj2') }).view();
  const installed = otherView.find((s) => s.name === 'gamma-skill');
  check('新 manager 能解析到, 状态 installed / 信任 unverified', installed?.status === 'installed' && installed?.trust === 'unverified', JSON.stringify(installed));
  check('内容指纹与来源一致 (可复算)', installed?.contentHash === (await sm2.inspect('gamma-skill'))?.contentHash);
  check('另一个 HOME 的技能目录真的被写了', fs.existsSync(path.join(OTHER, '.bolloon', 'skills', 'gamma-skill', 'SKILL.md')));

  // ═══════════ [7] resolve / snapshot ═══════════
  console.log('\n[7] resolve / snapshot: 缺技能与未启用分别说清; 快照固定版本+hash');
  const sm3 = new M.SkillsManager({ home: HOME, cwd: CWD });
  await sm3.disable('beta-skill');
  const r = await sm3.resolve(['alpha-skill', 'beta-skill', 'ghost-skill']);
  check('缺失技能列在 missing', r.missing.includes('ghost-skill'));
  check('被停用的列在 notEnabled', r.notEnabled.includes('beta-skill'));
  check('可用的解析出来了', r.resolved.some((s) => s.name === 'alpha-skill'));
  const snap = await sm3.snapshot(['alpha-skill']);
  check('快照含版本/指纹/来源/解析时刻', !!snap.entries[0] && snap.entries[0].contentHash.length === 32 && snap.entries[0].source === 'user' && Date.parse(snap.entries[0].resolvedAt) > 0, JSON.stringify(snap.entries[0]));

  // ═══════════ [8] health 两端一致 ═══════════
  console.log('\n[8] Web /api/skills/health 与本地一致');
  const localH = await new M.SkillsManager({ home: HOME, cwd: process.cwd() }).health();
  const apiH = await j('/api/skills/health');
  check('总数一致', apiH.status === 200 && apiH.body.total === localH.total, JSON.stringify({ api: apiH.body?.total, local: localH.total }));
  check('漂移清单一致', JSON.stringify((apiH.body.drifted || []).map((d: any) => d.name).sort()) === JSON.stringify(localH.drifted.map((d) => d.name).sort()), JSON.stringify(apiH.body?.drifted));
  check('不合格清单一致', JSON.stringify((apiH.body.invalid || []).map((i: any) => i.name).sort()) === JSON.stringify(localH.invalid.map((i) => i.name).sort()));

  console.log(`\n=== 结果: ${passed} passed, ${failed} failed ===`);
  console.log(`(隔离 HOME: ${HOME})`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('验收脚本异常:', err);
  process.exit(1);
});
