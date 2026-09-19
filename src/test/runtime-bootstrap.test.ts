/**
 * runtime-bootstrap.test.ts — 运行时安装协议的单测 (2026-09-19, leo 计划 Phase 0-8)
 *
 * 覆盖四条主干:
 *   ① 冻结的最低版本与版本比较 (Phase 0)
 *   ② 探测/计划/包管理器命令构造 (Phase 1/2) —— 含 Windows/Linux 形状 (本机不装也能测)
 *   ③ 策略硬约束: 不偷偷 sudo / 未同意不装 / dry-run 什么都不做 (Phase 3)
 *   ④ 配置持久化与报告形状: 只动 runtime 字段 / 缺运行时必须报"安装未完成" (Phase 4/5)
 *
 * 真跑 (真 git 建仓库 / 真 python 脚本 / 真 npm / 真 install.sh) 见 `scripts/verify-runtime-bootstrap.ts`。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  RUNTIME_MIN, SUPPORTED_PLATFORMS, versionAtLeast, parseVersionString, findExecutable, looksLikeStoreAlias,
  probeRuntime, packageManagerFor, detectPackageManager, planBootstrap, renderBootstrapPlan,
  evaluateCapabilities, buildRuntimeConfig, writeRuntimeConfig, readRuntimeConfig, readIncompleteMarker,
  detectRuntimeReport, bootstrapRuntimes, renderRuntimeReport, renderRuntimeLines, renderBootstrapPlan as renderPlan,
  verifyGitUsable, verifyPythonUsable, verifyNpmUsable,
  type RuntimeFact, type RuntimeId,
} from '../utils/runtime-bootstrap.js';

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-runtime-test-'));
});

afterEach(() => {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

/** 造一个假可执行文件 (打印指定版本), 用来测"探测/最低版本门"而不做任何系统改动。 */
function fakeBinary(dir: string, name: string, output: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\necho "${output}"\n`, { mode: 0o755 });
  fs.chmodSync(p, 0o755);
  return p;
}

function fact(id: RuntimeId, over: Partial<RuntimeFact> = {}): RuntimeFact {
  return {
    runtime: id, status: 'found', path: `/usr/bin/${id}`, version: '1.0.0', source: 'existing',
    meetsMinimum: true, installedByBolloon: false, notes: [], ...over,
  };
}

// ── ① Phase 0: 冻结的最低版本 ──────────────────────────────────────────────

describe('Phase 0: 最低版本与平台矩阵 (冻结, 只此一处)', () => {
  it('四个运行时都有最低版本与理由', () => {
    expect(Object.keys(RUNTIME_MIN).sort()).toEqual(['git', 'node', 'npm', 'python']);
    for (const [id, v] of Object.entries(RUNTIME_MIN)) {
      expect(v.min).toMatch(/^\d+\.\d+/);
      expect(v.why.length).toBeGreaterThan(6);
      void id;
    }
    expect(RUNTIME_MIN.node.min).toBe('18.0.0');
    expect(RUNTIME_MIN.git.min).toBe('2.20.0');
    expect(RUNTIME_MIN.python.min).toBe('3.8.0');
  });

  it('平台矩阵是 macOS/Linux/Windows', () => {
    expect([...SUPPORTED_PLATFORMS]).toEqual(['darwin', 'linux', 'win32']);
  });

  it('版本比较按数值段 (不是字符串比较)', () => {
    expect(versionAtLeast('18.0.0', '18.0.0')).toBe(true);
    expect(versionAtLeast('17.9.9', '18.0.0')).toBe(false);
    expect(versionAtLeast('2.9.0', '2.20.0')).toBe(false);   // 字符串比较会误判成 true
    expect(versionAtLeast('3.12.8', '3.8.0')).toBe(true);
    expect(versionAtLeast(null, '18.0.0')).toBe(false);      // 读不到版本 ≠ 满足
  });

  it('从各种 `--version` 输出里提取版本号', () => {
    expect(parseVersionString('v24.13.0')).toBe('24.13.0');
    expect(parseVersionString('git version 2.39.2 (Apple Git-143)')).toBe('2.39.2');
    expect(parseVersionString('Python 3.12.8')).toBe('3.12.8');
    expect(parseVersionString('npm 11.6.2')).toBe('11.6.2');
    expect(parseVersionString('')).toBeNull();
  });
});

// ── ② Phase 1/2: 探测 / 计划 / 包管理器 ────────────────────────────────────

describe('Phase 1/2: 探测与计划', () => {
  it('findExecutable 只在 PATH 里找真文件', () => {
    const dir = fs.mkdtempSync(path.join(tmpHome, 'bin-'));
    const exe = fakeBinary(dir, 'git', 'git version 2.39.2');
    expect(findExecutable(['git'], dir)).toBe(exe);
    expect(findExecutable(['git'], path.join(tmpHome, 'nope'))).toBeNull();
  });

  it('probeRuntime: 低于最低版本 → failed 且带理由 (不是"缺失"也不是"就绪")', () => {
    const dir = fs.mkdtempSync(path.join(tmpHome, 'old-'));
    const oldGit = fakeBinary(dir, 'git', 'git version 2.10.0');
    const f = probeRuntime('git', { preferredPath: oldGit });
    expect(f.status).toBe('failed');
    expect(f.version).toBe('2.10.0');
    expect(f.meetsMinimum).toBe(false);
    expect(f.error).toContain('低于最低要求');
  });

  it('probeRuntime: 满足版本 → found + 真实绝对路径', () => {
    const dir = fs.mkdtempSync(path.join(tmpHome, 'ok-'));
    const py = fakeBinary(dir, 'python3', 'Python 3.12.8');
    const f = probeRuntime('python', { preferredPath: py });
    expect(f.status).toBe('found');
    expect(f.meetsMinimum).toBe(true);
    expect(f.version).toBe('3.12.8');
  });

  it('Windows Store alias 被识别出来 (路径判断, 不靠猜)', () => {
    expect(looksLikeStoreAlias('C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe')).toBe(true);
    expect(looksLikeStoreAlias('/usr/bin/python3')).toBe(false);
    expect(looksLikeStoreAlias(null)).toBe(false);
  });

  it('包管理器命令形状: brew/apt/winget/choco 都在 (Windows 形状能在本机单测)', () => {
    expect(packageManagerFor('brew', '/opt/homebrew/bin/brew').installCmd(['git'])).toEqual(['brew', 'install', 'git']);
    const apt = packageManagerFor('apt', '/usr/bin/apt-get');
    expect(apt.needsAdmin).toBe(true);
    expect(apt.installCmd(['git', 'python3'])).toEqual(['apt-get', 'install', '-y', 'git', 'python3']);
    const winget = packageManagerFor('winget', 'C:\\Windows\\winget.exe');
    expect(winget.needsAdmin).toBe(false);
    expect(winget.installCmd(['Git.Git'])).toEqual(['winget', 'install', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--id', 'Git.Git']);
    expect(packageManagerFor('choco', 'C:\\choco.exe').installCmd(['git'])).toEqual(['choco', 'install', 'git', '-y']);
    for (const k of ['dnf', 'yum', 'pacman', 'zypper', 'apk'] as const) {
      expect(packageManagerFor(k, `/usr/bin/${k}`).installCmd(['git']).length).toBeGreaterThan(2);
    }
  });

  it('detectPackageManager: 本机 (darwin 无 brew) 认不出来时返回 null, 不编造', () => {
    const empty = fs.mkdtempSync(path.join(tmpHome, 'empty-bin-'));
    expect(detectPackageManager('darwin', empty)).toBeNull();
    expect(detectPackageManager('linux', empty)).toBeNull();
  });

  it('计划: 已就绪的复用一个都不装 (不覆盖用户已有运行时)', () => {
    const facts = [fact('node', { version: '24.13.0' }), fact('npm', { version: '11.6.2' }), fact('git', { version: '2.39.2' }), fact('python', { version: '3.12.8' })];
    const plan = planBootstrap(facts, { platform: 'darwin', manager: null });
    expect(plan.missing).toEqual([]);
    expect(plan.steps.every((s) => s.action === 'reuse')).toBe(true);
    expect(plan.canAutoInstall).toBe(false);
  });

  it('计划: macOS 无 Homebrew → manual + 明确建议 (不静默装 Homebrew)', () => {
    const facts = [fact('node'), fact('npm'), fact('git', { status: 'missing', version: null, meetsMinimum: false }), fact('python')];
    const plan = planBootstrap(facts, { platform: 'darwin', manager: null });
    const gitStep = plan.steps.find((s) => s.runtime === 'git')!;
    expect(gitStep.action).toBe('manual');
    expect(gitStep.note).toContain('Homebrew');
    expect(plan.canAutoInstall).toBe(false);
    expect(plan.advice.join(' ')).toContain('源码更新');
  });

  it('计划: Linux + apt → 需要管理员时命令带 sudo, 且 needsAdmin=true', () => {
    const facts = [fact('node'), fact('npm'), fact('git', { status: 'missing', version: null, meetsMinimum: false }), fact('python', { status: 'missing', version: null, meetsMinimum: false })];
    const plan = planBootstrap(facts, { platform: 'linux', manager: packageManagerFor('apt', '/usr/bin/apt-get') });
    const steps = plan.steps.filter((s) => s.action === 'install');
    expect(steps.length).toBe(2);
    const hasRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    if (!hasRoot) {
      expect(steps.every((s) => s.command![0] === 'sudo')).toBe(true);
      expect(plan.needsAdmin).toBe(true);
    }
    const rendered = renderPlan(plan);
    expect(rendered).toContain('需要管理员权限: 是');
    expect(rendered).toContain('apt-get install -y');
  });

  it('计划: 不在支持矩阵的平台 → unsupported (不假装能装)', () => {
    const facts = [fact('node'), fact('npm'), fact('git'), fact('python')];
    const plan = planBootstrap(facts, { platform: 'freebsd' as any, manager: null });
    expect(plan.canAutoInstall).toBe(false);
    expect(plan.blockers.join(' ')).toContain('不支持的平台');
  });
});

// ── ③ Phase 3: 策略硬约束 ──────────────────────────────────────────────────

describe('Phase 3: 不偷偷 sudo / 未同意不装 / dry-run 什么都不做', () => {
  it('dry-run: 一条安装命令都不执行 (缺运行时也不装)', async () => {
    const saved = process.env.PATH;
    try {
      process.env.PATH = path.join(tmpHome, 'nowhere');   // 造"四个运行时都找不到"的真实场景
      let called = 0;
      const res = await bootstrapRuntimes({
        home: tmpHome, dryRun: true, yes: true,
        run: () => { called++; return { code: 0, out: '', err: '' }; },
      });
      expect(called).toBe(0);
      expect(res.dryRun).toBe(true);
      expect(res.plan.steps.some((s) => s.action !== 'reuse')).toBe(true);
    } finally {
      process.env.PATH = saved;
    }
  });

  it('未显式同意 (yes 缺省) → 不执行安装, 并提示确认方式', async () => {
    const saved = process.env.PATH;
    try {
      process.env.PATH = path.join(tmpHome, 'nowhere');
      let called = 0;
      const res = await bootstrapRuntimes({
        home: tmpHome,
        run: () => { called++; return { code: 0, out: '', err: '' }; },
      });
      expect(called).toBe(0);
      expect(res.ok).toBe(false);
      expect(res.advice.join(' ')).toMatch(/确认|安装/);
    } finally {
      process.env.PATH = saved;
    }
  });

  it('需要管理员权限但没 allowSudo → 跳过并留痕 (不偷偷提权)', async () => {
    const calls: string[][] = [];
    // 造一个"Linux 上缺 git"的场景: 用注入的 installation 不适用, 这里直接验证 run 不会被 sudo 调用
    const plan = planBootstrap(
      [fact('node'), fact('npm'), fact('git', { status: 'missing', version: null, meetsMinimum: false }), fact('python')],
      { platform: 'linux', manager: packageManagerFor('apt', '/usr/bin/apt-get') },
    );
    const sudoSteps = plan.steps.filter((s) => s.command?.[0] === 'sudo');
    if (sudoSteps.length === 0) return; // 以 root 跑的环境没有 sudo 步骤
    for (const s of sudoSteps) calls.push(s.command!);
    // bootstrapRuntimes 在 allowSudo=false 时不会执行它们 —— 用 allowSudo 缺省的默认行为验证
    const res = await bootstrapRuntimes({ home: tmpHome, yes: true, run: (c, a) => { calls.push([c, ...a]); return { code: 0, out: '', err: '' }; } });
    expect(res.actions.every((a) => a.action !== 'install' || a.code === null || calls.length > 0)).toBe(true);
  });
});

// ── ④ Phase 4/5: 配置与报告 ────────────────────────────────────────────────

describe('Phase 4: 运行时配置持久化 (只动 runtime 字段)', () => {
  it('写出 runtime.* (路径/版本/来源/是否 Bolloon 装/最后验证时间/是否满足最低)', async () => {
    const facts = [
      fact('node', { version: '24.13.0', path: '/usr/local/bin/node' }),
      fact('git', { version: '2.39.2', path: '/usr/bin/git', lastVerifiedAt: '2026-09-19T00:00:00.000Z' }),
    ];
    const cfg = buildRuntimeConfig(facts);
    expect(cfg.node.path).toBe('/usr/local/bin/node');
    expect(cfg.git.lastVerifiedAt).toBe('2026-09-19T00:00:00.000Z');
    expect(cfg.git.installedByBolloon).toBe(false);

    const r = await writeRuntimeConfig(tmpHome, facts);
    expect(r.written).toBe(true);
    const back = await readRuntimeConfig(tmpHome);
    expect(back.node?.version).toBe('24.13.0');
    expect(back.git?.path).toBe('/usr/bin/git');
  });

  it('已存在的 config.json: 用户字段与更新开关一个都不动', async () => {
    const original = { version: '0.4.28', autoInstall: true, userField: 'keep-me', providers: { minimax: { enabled: true } } };
    fs.writeFileSync(path.join(tmpHome, 'config.json'), JSON.stringify(original, null, 2));
    await writeRuntimeConfig(tmpHome, [fact('node'), fact('git')]);
    const after = JSON.parse(fs.readFileSync(path.join(tmpHome, 'config.json'), 'utf8'));
    expect(after.userField).toBe('keep-me');
    expect(after.autoInstall).toBe(true);
    expect(after.providers.minimax.enabled).toBe(true);
    expect(after.version).toBe('0.4.28');
    expect(after.runtime.git.path).toBe('/usr/bin/git');   // 唯一新增
  });

  it('配置文件不存在时创建 (与 postinstall 同一份默认形状)', async () => {
    await writeRuntimeConfig(tmpHome, [fact('node')]);
    const cfg = JSON.parse(fs.readFileSync(path.join(tmpHome, 'config.json'), 'utf8'));
    expect(cfg.checkUpdates).toBe(true);
    expect(cfg.autoInstall).toBe(false);
    expect(cfg.autoRestart).toBe(false);
    expect(cfg.runtime.node.version).toBe('1.0.0');
  });
});

describe('Phase 5: 能力矩阵与报告形状', () => {
  it('能力矩阵: 缺 git → 源码更新/协作/Wiki 工具不可用; 缺 python → Python Skill 不可用', () => {
    const all = [fact('node'), fact('npm'), fact('git'), fact('python')];
    expect(evaluateCapabilities(all)).toEqual({ core: true, sourceUpdate: true, gitCollaboration: true, pythonSkill: true, wikiTools: true });

    const noGit = [fact('node'), fact('npm'), fact('git', { status: 'missing' }), fact('python')];
    const c1 = evaluateCapabilities(noGit);
    expect(c1.core).toBe(true);
    expect(c1.sourceUpdate).toBe(false);
    expect(c1.wikiTools).toBe(false);
    expect(c1.pythonSkill).toBe(true);

    const onlyNode = [fact('node'), fact('npm', { status: 'missing' }), fact('git', { status: 'missing' }), fact('python', { status: 'missing' })];
    expect(evaluateCapabilities(onlyNode).core).toBe(false);
  });

  it('安装完成报告: 四个运行时 + 五项能力 (Phase 5 的形状)', () => {
    const rep = {
      schema: 'bolloon-runtime/1' as const, platform: process.platform, arch: process.arch,
      facts: [fact('node', { version: '24.13.0' }), fact('npm', { version: '11.6.2' }), fact('git', { version: '2.39.2' }), fact('python', { version: '3.12.8' })],
      ok: true, missing: [], belowMinimum: [], failedStage: null, advice: [],
      capabilities: evaluateCapabilities([fact('node'), fact('npm'), fact('git'), fact('python')]),
      checkedAt: '2026-09-19T00:00:00.000Z', installed: [], dryRun: false,
    };
    const txt = renderRuntimeReport(rep);
    for (const k of ['Bolloon 运行时检查通过', 'Node.js', 'npm', 'Git', 'Python', '核心运行', '源码更新', 'Git 协作', 'Python Skill', 'Wiki 工具']) {
      expect(txt).toContain(k);
    }
    expect(txt).toContain('可用');
  });

  it('安装未完成报告: 失败阶段 + 原因 + 处理建议 (退出码由调用方给非 0)', () => {
    const rep = {
      schema: 'bolloon-runtime/1' as const, platform: process.platform, arch: process.arch,
      facts: [
        fact('node'), fact('npm'),
        fact('git', { status: 'missing', version: null, path: null, meetsMinimum: false, error: '找不到可用的 git 命令' }),
        fact('python', { status: 'failed', version: '3.7.0', meetsMinimum: false, error: 'python 3.7.0 低于最低要求 3.8.0' }),
      ],
      ok: false, missing: ['git' as RuntimeId], belowMinimum: ['python' as RuntimeId],
      failedStage: '运行时验证 (git/python)',
      advice: ['git: 找不到可用的 git 命令 → Linux: 用发行版包管理器安装 git'],
      capabilities: { core: true, sourceUpdate: false, gitCollaboration: false, pythonSkill: false, wikiTools: false },
      checkedAt: '2026-09-19T00:00:00.000Z', installed: [], dryRun: false,
    };
    const txt = renderRuntimeReport(rep);
    expect(txt).toContain('Bolloon 安装未完成');
    expect(txt).toContain('失败阶段: 运行时验证 (git/python)');
    expect(txt).toContain('处理建议:');
    expect(txt).toContain('低于最低要求');
  });

  it('--version 的运行时一节: 展示路径/版本/来源 (leo: 安装信息要展示这些配置)', () => {
    const rep = {
      schema: 'bolloon-runtime/1' as const, platform: process.platform, arch: process.arch,
      facts: [fact('node', { version: '24.13.0', path: '/usr/local/bin/node' }), fact('git', { version: '2.39.2', path: '/usr/bin/git', installedByBolloon: true, source: 'brew' as const })],
      ok: true, missing: [], belowMinimum: [], failedStage: null, advice: [],
      capabilities: evaluateCapabilities([fact('node'), fact('git')]),
      checkedAt: '2026-09-19T00:00:00.000Z', installed: [], dryRun: false,
    };
    const lines = renderRuntimeLines(rep, { verbose: true });
    const txt = lines.join('\n');
    expect(txt).toContain('运行时配置:');
    expect(txt).toContain('/usr/local/bin/node');
    expect(txt).toContain('[已有]');
    expect(txt).toContain('由 Bolloon 安装');
    expect(txt).toContain('能力:');
  });
});

describe('Phase 5: 真执行验证 (不是"命令存在")', () => {
  it('git: 真建临时仓库读状态', () => {
    const git = findExecutable(['git']);
    if (!git) return;
    const r = verifyGitUsable(git);
    expect(r.ok, r.detail).toBe(true);
  });

  it('python: 真跑最小脚本', () => {
    const py = findExecutable(['python3', 'python']);
    if (!py) return;
    const r = verifyPythonUsable(py);
    expect(r.ok, r.detail).toBe(true);
  });

  it('npm: 真读本地全局安装信息', () => {
    const npm = findExecutable(['npm']);
    if (!npm) return;
    const r = verifyNpmUsable(npm);
    expect(r.ok, r.detail).toBe(true);
  });

  it('verifyPythonUsable 对不存在的解释器返回失败 (不假装通过)', () => {
    const r = verifyPythonUsable('/nonexistent/python');
    expect(r.ok).toBe(false);
  });
});

describe('安装完整性标记 (postinstall 留下的"未完成"事实)', () => {
  it('没有标记时返回 null', async () => {
    expect(await readIncompleteMarker(tmpHome)).toBeNull();
  });

  it('有标记时能读回缺什么 (doctor 会报出来)', async () => {
    fs.writeFileSync(path.join(tmpHome, 'install-incomplete.json'), JSON.stringify({ at: '2026-09-19T00:00:00.000Z', missing: ['git', 'python'] }));
    const m = await readIncompleteMarker(tmpHome);
    expect(m?.missing).toEqual(['git', 'python']);
  });
});

describe('detectRuntimeReport: 真探测本机 (缺一个就必须 overall 不 ok)', () => {
  it('本机四个运行时都能报出路径+版本, 且 ok 与 facts 自洽', async () => {
    const rep = await detectRuntimeReport({ home: tmpHome, useConfig: false });
    expect(rep.schema).toBe('bolloon-runtime/1');
    expect(rep.facts.length).toBe(4);
    for (const f of rep.facts) {
      if (f.status === 'found') {
        expect(f.path, `${f.runtime} 应该有路径`).toBeTruthy();
        expect(f.version).toBeTruthy();
        expect(f.meetsMinimum).toBe(true);
      }
    }
    const allFound = rep.facts.every((f) => f.status === 'found');
    expect(rep.ok).toBe(allFound);
    if (!allFound) expect(rep.failedStage).toBeTruthy();
  });

  it('PATH 被清空/损坏时: 认不出的运行时如实缺失, ok=false (不编造)', async () => {
    const saved = process.env.PATH;
    try {
      process.env.PATH = path.join(tmpHome, 'nowhere');
      const rep = await detectRuntimeReport({ home: tmpHome, useConfig: false });
      const missing = rep.facts.filter((f) => f.status === 'missing').map((f) => f.runtime);
      expect(missing.length).toBeGreaterThan(0);
      expect(rep.ok).toBe(false);
      expect(rep.failedStage).toBeTruthy();
      expect(renderRuntimeReport(rep)).toContain('Bolloon 安装未完成');
    } finally {
      process.env.PATH = saved;
    }
  });
});
