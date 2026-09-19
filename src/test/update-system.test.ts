/**
 * update-system.test.ts — 更新系统的单测 (2026-09-19)
 *
 * 覆盖"更新体验收敛"的四条主干 (纯函数 + 临时 HOME, 不打外网, 不装包):
 *   ① 版本身份: 安装方式识别 / 三份输出读同一份 VersionInfo
 *   ② 检查结论: 7 个状态都在该出现的时候出现 (尤其"网络失败 ≠ 已是最新")
 *   ③ 开关与锁: 默认只通知不安装 / 环境变量只临时覆盖 / 陈旧锁可回收
 *   ④ 计划与执行: 阻塞项拦住更新 / 执行失败保留旧版本并回滚
 *
 * 真跑的端到端 (真杀进程/真断网/真无权限/真安装失败) 见 `scripts/verify-update-system.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  parseVersion, compareVersions, isKnownVersion, classifyRegistryError, checkForUpdate, parseJsonFromStdout,
  buildUpdatePlan, renderUpdatePlan, applyUpdate, installedVersionOnDisk, validateStagedPackage,
  readUpdateStatus, renderHistory,
  type RegistryResult,
} from '../utils/update-manager.js';
import {
  emptyUpdateState, readUpdateState, writeUpdateState, readUpdatePrefs, ensureUpdatePrefsInConfig,
  appendUpdateHistory, readUpdateHistory, acquireUpdateLock, releaseUpdateLock, readUpdateLock,
  lockIsStale, reclaimStaleLockIfAny, updateStatePath, updateHistoryPath, updateLockPath,
} from '../utils/update-state.js';
import {
  detectInstallation, collectVersionInfo, renderVersionText, renderVersionJson, describeUpdateLine,
  resolveUpdateChannel, distTagForChannel, packageRootFrom, readPackageAt, buildTimeOf,
  type InstallationInfo,
} from '../utils/version-info.js';
import { gradeOfItems, renderHealth, renderDoctor, runDoctor, type HealthItem } from '../utils/update-health.js';

// ── 临时环境 ────────────────────────────────────────────────────────────────

let tmpHome: string;        // 隔离的用户 home (RunStore/TransactionStore 认它)
let tmpBolloon: string;     // 隔离的 ~/.bolloon
let realHome: string;

beforeEach(() => {
  realHome = os.homedir();
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-update-test-'));
  tmpBolloon = path.join(tmpHome, '.bolloon');
  fs.mkdirSync(tmpBolloon, { recursive: true });
  process.env.HOME = tmpHome;
});

afterEach(() => {
  process.env.HOME = realHome;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

/** 造一个假安装: 指定安装方式/目录, 里面放一个 package.json。 */
function fakeInstall(version: string, opts: { method?: InstallationInfo['method']; root?: string } = {}): InstallationInfo {
  const root = opts.root || fs.mkdtempSync(path.join(tmpHome, 'pkg-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@bolloon/bolloon-agent', version }, null, 2));
  const method = opts.method || 'npm-global';
  return {
    method,
    packageRoot: root,
    installDir: root,
    binPath: null,
    entryPath: path.join(root, 'dist', 'cli-entry.js'),
    writable: true,
    linked: false,
    linkTarget: null,
    updateSource: method === 'npm-global' ? 'npm' : 'git',
    autoUpdatable: method === 'npm-global',
    reason: `测试夹具 (${method})`,
  };
}

function registryOk(latest: string, versions: string[], gitHeads: Record<string, string> = {}): RegistryResult {
  return { ok: true, doc: { latest, distTags: { latest }, versions, gitHeads } };
}

const threeItems: HealthItem[] = [
  { id: 'a', label: 'A', grade: 'ok', detail: '' },
  { id: 'b', label: 'B', grade: 'degraded', detail: '' },
  { id: 'c', label: 'C', grade: 'ok', detail: '' },
];

// ── ① 版本身份 ──────────────────────────────────────────────────────────────

describe('版本解析 (唯一一份)', () => {
  it('compareVersions 按数值段比较, 忽略 v 前缀与预发布标签', () => {
    expect(compareVersions('0.4.28', '0.4.29')).toBe(-1);
    expect(compareVersions('v0.4.28', '0.4.28')).toBe(0);
    expect(compareVersions('0.4.9', '0.4.10')).toBe(-1);
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1);
    expect(compareVersions('0.4.28-beta.1', '0.4.28')).toBe(0);
  });

  it('parseVersion / isKnownVersion 不把 unknown 当版本', () => {
    expect(parseVersion('v1.2.3')).toEqual([1, 2, 3]);
    expect(isKnownVersion('0.4.28')).toBe(true);
    expect(isKnownVersion('unknown')).toBe(false);
    expect(isKnownVersion(null)).toBe(false);
    expect(isKnownVersion('')).toBe(false);
  });

  it('通道 → dist-tag 映射是显式的 (beta 暂与 stable 同源, 不假装有独立通道)', () => {
    expect(distTagForChannel('stable')).toBe('latest');
    expect(distTagForChannel('beta')).toBe('beta');
    expect(resolveUpdateChannel('dev')).toBe('dev');
    expect(resolveUpdateChannel('nonsense')).toBe('stable');
  });
});

describe('安装方式识别 (开发目录不能误判成全局安装)', () => {
  it('带 .git 的源码树 → source-git (不是 npm-global)', () => {
    const root = fs.mkdtempSync(path.join(tmpHome, 'srcrepo-'));
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@bolloon/bolloon-agent', version: '0.4.28' }));
    const inst = detectInstallation({ packageRoot: root });
    expect(inst.method).toBe('source-git');
    expect(inst.updateSource).toBe('git');
    expect(inst.autoUpdatable).toBe(false);
  });

  it('带 RELEASE.json 的解压包 → release-binary', () => {
    const root = fs.mkdtempSync(path.join(tmpHome, 'rel-'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@bolloon/bolloon-agent', version: '0.4.28' }));
    fs.writeFileSync(path.join(root, 'RELEASE.json'), JSON.stringify({ version: '0.4.28' }));
    expect(detectInstallation({ packageRoot: root }).method).toBe('release-binary');
  });

  it('符合 npm 全局布局 <prefix>/lib/node_modules/... → npm-global (即使 npm root -g 不一致)', () => {
    const prefix = fs.mkdtempSync(path.join(tmpHome, 'pfx-'));
    const root = path.join(prefix, 'lib', 'node_modules', '@bolloon', 'bolloon-agent');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@bolloon/bolloon-agent', version: '0.4.29' }));
    const inst = detectInstallation({ packageRoot: root });
    expect(inst.method).toBe('npm-global');
    expect(inst.updateSource).toBe('npm');
    expect(inst.reason).toContain('npm 全局布局');
  });

  it('项目内的局部依赖 <proj>/node_modules/... → npm-local (不误判成全局)', () => {
    const proj = fs.mkdtempSync(path.join(tmpHome, 'proj-'));
    const root = path.join(proj, 'node_modules', '@bolloon', 'bolloon-agent');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@bolloon/bolloon-agent', version: '0.4.29' }));
    expect(detectInstallation({ packageRoot: root }).method).toBe('npm-local');
  });

  it('认不出来的目录 → unknown (并明确不自动更新)', () => {
    const root = fs.mkdtempSync(path.join(tmpHome, 'mystery-'));
    const inst = detectInstallation({ packageRoot: root });
    expect(inst.method).toBe('unknown');
    expect(inst.updateSource).toBe('unknown');
    expect(inst.autoUpdatable).toBe(false);
    expect(inst.reason).toContain('无法');
  });

  it('npm 全局目录里是**软链**且指向 git 检出 → development (npm link 场景)', () => {
    // 模拟: <npm root -g>/@bolloon/bolloon-agent -> 源码树。用临时前缀 + 环境变量让 npm 认它
    const fakePrefix = path.join(tmpHome, 'npm-global');
    const globalPkgDir = path.join(fakePrefix, 'lib', 'node_modules', '@bolloon');
    const src = fs.mkdtempSync(path.join(tmpHome, 'linked-src-'));
    fs.mkdirSync(path.join(src, '.git'), { recursive: true });
    fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: '@bolloon/bolloon-agent', version: '0.4.28' }));
    fs.mkdirSync(globalPkgDir, { recursive: true });
    try {
      fs.symlinkSync(src, path.join(globalPkgDir, 'bolloon-agent'), 'dir');
    } catch {
      return; // 无权限建软链的环境直接跳过
    }
    const oldPrefix = process.env.npm_config_prefix;
    process.env.npm_config_prefix = fakePrefix;
    try {
      // 注意: npm root -g 会优先读 npm_config_prefix; 拿不到就退回真实全局根 —— 那种情况下
      // 这个断言只验证"源码树不会被判成 npm-global"这一半, 仍是有效断言。
      const inst = detectInstallation({ packageRoot: src });
      expect(inst.method).not.toBe('npm-global');
      expect(['development', 'source-git']).toContain(inst.method);
      expect(inst.autoUpdatable).toBe(false);
    } finally {
      if (oldPrefix === undefined) delete process.env.npm_config_prefix; else process.env.npm_config_prefix = oldPrefix;
    }
  });
});

describe('VersionInfo: 三种输出读同一份事实', () => {
  it('collectVersionInfo 的字段与 --json 输出一致, 普通/诊断文本都含关键身份', () => {
    const root = fakeInstall('0.4.28').packageRoot;
    const info = collectVersionInfo({ packageRoot: root, home: tmpBolloon, light: true, update: null });

    expect(info.schema).toBe('bolloon-version/1');
    expect(info.packageVersion).toBe('0.4.28');
    expect(info.packageName).toBe('@bolloon/bolloon-agent');
    expect(info.platform).toBe(os.platform());
    expect(info.arch).toBe(os.arch());
    expect(info.nodeVersion).toBe(process.version.replace(/^v/, ''));

    const parsed = JSON.parse(renderVersionJson(info));
    expect(parsed.packageVersion).toBe(info.packageVersion);
    expect(parsed.installDir).toBe(info.installDir);
    expect(parsed.channel).toBe(info.channel);

    const normal = renderVersionText(info);
    for (const key of ['Bolloon Agent v0.4.28', '安装方式:', '安装目录:', '运行入口:', '更新通道:', 'Node.js:', '平台:', '上游提交:', '更新检查:', '上次检查:']) {
      expect(normal).toContain(key);
    }

    const verbose = renderVersionText(info, { verbose: true });
    for (const key of ['包名:', '构建时间:', 'Git commit:', 'npm:', 'Python:', '配置目录:', 'registry:', '上游地址:']) {
      expect(verbose).toContain(key);
    }
    // 诊断版必须比普通版信息更多, 而不是另一套说法
    expect(verbose.length).toBeGreaterThan(normal.length);
  });

  it('读不到 package.json 时版本是 unknown, 不编造 0.0.0', () => {
    const empty = fs.mkdtempSync(path.join(tmpHome, 'empty-'));
    const info = collectVersionInfo({ packageRoot: empty, home: tmpBolloon, light: true });
    expect(info.packageVersion).toBe('unknown');
  });

  it('更新结论的人话是唯一一份 (普通版与 verbose 共用)', () => {
    const info = collectVersionInfo({
      packageRoot: fakeInstall('0.4.28').packageRoot, home: tmpBolloon, light: true,
      update: { lastCheckAt: new Date().toISOString(), lastCheckStatus: 'offline', lastCheckReason: 'ENOTFOUND', latestVersion: null, lastUpdate: null, needsRestart: false },
    });
    const line = describeUpdateLine(info);
    expect(line).toContain('离线');
    expect(line).toContain('不等于最新');
    expect(line).not.toContain('已是最新');
  });

  it('packageRootFrom 从模块 URL 定位到包根', () => {
    expect(readPackageAt(packageRootFrom(import.meta.url))?.name).toBe('@bolloon/bolloon-agent');
    expect(buildTimeOf(import.meta.filename || null)).toBeTruthy();
  });
});

// ── ② 检查结论 ──────────────────────────────────────────────────────────────

describe('checkForUpdate: 7 个结论各自何时出现', () => {
  it('registry 有新版本 → update_available (带目标/回滚可行性)', async () => {
    const inst = fakeInstall('0.4.28');
    const r = await checkForUpdate({ home: tmpBolloon, installation: inst, registry: registryOk('0.4.29', ['0.4.28', '0.4.29']), force: true });
    expect(r.status).toBe('update_available');
    expect(r.latestVersion).toBe('0.4.29');
    expect(r.targetPublished).toBe(true);
    expect(r.rollbackSupported).toBe(true);
  });

  it('同版本 → up_to_date', async () => {
    const inst = fakeInstall('0.4.28');
    const r = await checkForUpdate({ home: tmpBolloon, installation: inst, registry: registryOk('0.4.28', ['0.4.27', '0.4.28']), force: true });
    expect(r.status).toBe('up_to_date');
  });

  it('网络不可达 → offline, **绝不**显示已是最新', async () => {
    const inst = fakeInstall('0.4.28');
    const r = await checkForUpdate({
      home: tmpBolloon, installation: inst, force: true,
      registry: { ok: false, kind: 'offline', detail: 'ENOTFOUND' },
    });
    expect(r.status).toBe('offline');
    expect(r.status).not.toBe('up_to_date');
    expect(r.latestVersion).toBeNull();
  });

  it('registry 5xx / 包不存在 → registry_unavailable (≠ 最新)', async () => {
    const inst = fakeInstall('0.4.28');
    const r = await checkForUpdate({
      home: tmpBolloon, installation: inst, force: true,
      registry: { ok: false, kind: 'registry_unavailable', detail: 'registry 上没有 @bolloon/bolloon-agent (HTTP 404)' },
    });
    expect(r.status).toBe('registry_unavailable');
    expect(r.reason).toContain('404');
  });

  it('读不到本地版本 → local_version_unknown (不默认 0.0.0 继续更新)', async () => {
    const empty = fs.mkdtempSync(path.join(tmpHome, 'noversion-'));
    const inst = fakeInstall('0.0.0', { root: empty });
    fs.rmSync(path.join(empty, 'package.json'));
    const r = await checkForUpdate({ home: tmpBolloon, installation: inst, registry: registryOk('0.4.29', ['0.4.29']), force: true });
    expect(r.status).toBe('local_version_unknown');
    expect(r.latestVersion).toBeNull();
  });

  it('开发目录 → unsupported_installation (但仍告诉你最新是多少)', async () => {
    const inst = fakeInstall('0.4.28', { method: 'development' });
    const r = await checkForUpdate({ home: tmpBolloon, installation: inst, registry: registryOk('0.4.29', ['0.4.28', '0.4.29']), force: true });
    expect(r.status).toBe('unsupported_installation');
    expect(r.latestVersion).toBe('0.4.29');
    expect(r.reason).toContain('不支持自动更新');
  });

  it('节流: 距上次检查不足间隔 → check_skipped (结论来自缓存, 不打网络)', async () => {
    await writeUpdateState({
      lastCheckAt: new Date().toISOString(),
      lastCheckStatus: 'update_available',
      latestVersion: '0.4.29',
      currentVersion: '0.4.28',
    }, tmpBolloon);
    const inst = fakeInstall('0.4.28');
    const r = await checkForUpdate({
      home: tmpBolloon, installation: inst, force: false,
      // 故意给一个"离线"的 registry: 节流生效时它根本不该被用到
      registry: { ok: false, kind: 'offline', detail: '不应该被调用' },
    });
    expect(r.status).toBe('check_skipped');
    expect(r.fromCache).toBe(true);
    expect(r.cachedStatus).toBe('update_available');
    expect(r.latestVersion).toBe('0.4.29');
  });

  it('检查写盘后状态文件与结论自洽 (lastCheckStatus/latestVersion)', async () => {
    const inst = fakeInstall('0.4.28');
    await checkForUpdate({ home: tmpBolloon, installation: inst, registry: registryOk('0.4.29', ['0.4.29']), force: true });
    const st = await readUpdateState(tmpBolloon);
    expect(st.lastCheckStatus).toBe('update_available');
    expect(st.latestVersion).toBe('0.4.29');
    expect(st.currentVersion).toBe('0.4.28');
    expect(st.schema).toBe('bolloon-update/1');
  });

  it('offline 检查也会写盘 (下次 doctor 能看到"上次是离线", 不是最新)', async () => {
    const inst = fakeInstall('0.4.28');
    await checkForUpdate({ home: tmpBolloon, installation: inst, force: true, registry: { ok: false, kind: 'offline', detail: 'ETIMEDOUT' } });
    const st = await readUpdateState(tmpBolloon);
    expect(st.lastCheckStatus).toBe('offline');
    expect(st.lastCheckReason).toContain('ETIMEDOUT');
  });
});

describe('registry 错误分类', () => {
  it('网络类错误 → offline', () => {
    expect(classifyRegistryError({ code: 'ENOTFOUND' }).kind).toBe('offline');
    expect(classifyRegistryError({ message: '请求超时' }).kind).toBe('offline');
    expect(classifyRegistryError({ code: 'ECONNREFUSED' }).kind).toBe('offline');
  });

  it('HTTP 5xx / 404 → registry_unavailable (区分"网络不通"与"服务有问题")', () => {
    expect(classifyRegistryError(null, 503).kind).toBe('registry_unavailable');
    expect(classifyRegistryError(null, 404).detail).toContain('404');
  });
});

// ── ③ 开关与锁 ──────────────────────────────────────────────────────────────

describe('更新开关: 默认只通知, 显式才自动装', () => {
  it('没有 config.json 时默认: 检查开 / 自动装关 / 自动重启关', async () => {
    const prefs = await readUpdatePrefs({ home: tmpBolloon, env: {} });
    expect(prefs.checkUpdates).toBe(true);
    expect(prefs.autoInstall).toBe(false);
    expect(prefs.autoRestart).toBe(false);
    expect(prefs.sources.autoInstall).toBe('default');
  });

  it('旧字段 autoUpdate 只映射到 checkUpdates, **不**映射成 autoInstall', async () => {
    fs.writeFileSync(path.join(tmpBolloon, 'config.json'), JSON.stringify({ autoUpdate: true }));
    const prefs = await readUpdatePrefs({ home: tmpBolloon, env: {} });
    expect(prefs.checkUpdates).toBe(true);
    expect(prefs.autoInstall).toBe(false);
    expect(prefs.sources.checkUpdates).toBe('config');
    expect(prefs.sources.autoInstall).toBe('default');
  });

  it('config.json 显式打开 autoInstall 才真的打开', async () => {
    fs.writeFileSync(path.join(tmpBolloon, 'config.json'), JSON.stringify({ autoInstall: true, autoRestart: true, updateChannel: 'beta' }));
    const prefs = await readUpdatePrefs({ home: tmpBolloon, env: {} });
    expect(prefs.autoInstall).toBe(true);
    expect(prefs.autoRestart).toBe(true);
    expect(prefs.channel).toBe('beta');
  });

  it('环境变量只作临时覆盖 (BOLLOON_SKIP_UPDATE / BOLLOON_AUTO_UPDATE / 通道)', async () => {
    const off = await readUpdatePrefs({ home: tmpBolloon, env: { BOLLOON_SKIP_UPDATE: '1' } });
    expect(off.checkUpdates).toBe(false);
    expect(off.sources.checkUpdates).toBe('env');

    const on = await readUpdatePrefs({ home: tmpBolloon, env: { BOLLOON_AUTO_UPDATE: '1', BOLLOON_UPDATE_CHANNEL: 'dev' } });
    expect(on.autoInstall).toBe(true);
    expect(on.channel).toBe('dev');
    // 环境变量不落盘
    expect(fs.existsSync(path.join(tmpBolloon, 'config.json'))).toBe(false);
  });

  it('ensureUpdatePrefsInConfig 只补缺失字段, 不改用户已有值', async () => {
    fs.writeFileSync(path.join(tmpBolloon, 'config.json'), JSON.stringify({ autoInstall: true, defaults: { port: 1 } }));
    const r = await ensureUpdatePrefsInConfig(tmpBolloon);
    expect(r.changed).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(path.join(tmpBolloon, 'config.json'), 'utf8'));
    expect(cfg.autoInstall).toBe(true);       // 用户值保留
    expect(cfg.checkUpdates).toBe(true);      // 补齐
    expect(cfg.autoRestart).toBe(false);      // 补齐 = 新默认
    expect(cfg.defaults.port).toBe(1);        // 其它字段原样
  });
});

describe('更新锁: 不许两个进程同时更新', () => {
  it('抢锁 → 第二个进程抢不到 → 释放后可以再抢', async () => {
    const first = await acquireUpdateLock({ home: tmpBolloon, reason: 'a' });
    expect(first.ok).toBe(true);
    expect(readUpdateLock(tmpBolloon)?.pid).toBe(process.pid);

    // 伪造"另一个活着的进程"
    fs.writeFileSync(updateLockPath(tmpBolloon), JSON.stringify({ pid: 1, at: new Date().toISOString(), by: 'other' }));
    const second = await acquireUpdateLock({ home: tmpBolloon, reason: 'b' });
    expect(second.ok).toBe(false);
    expect(second.heldBy?.pid).toBe(1);

    await fs.promises.rm(updateLockPath(tmpBolloon));
    const third = await acquireUpdateLock({ home: tmpBolloon, reason: 'c' });
    expect(third.ok).toBe(true);
    await releaseUpdateLock(tmpBolloon);
    expect(readUpdateLock(tmpBolloon)).toBeNull();
  });

  it('陈旧锁 (进程已死) 会被回收, 并留下 staleReclaimed 痕迹', async () => {
    fs.writeFileSync(updateLockPath(tmpBolloon), JSON.stringify({ pid: 999999, at: new Date(Date.now() - 3600_000).toISOString(), by: 'ghost' }));
    expect(lockIsStale(readUpdateLock(tmpBolloon)!)).toBe(true);
    const lock = await acquireUpdateLock({ home: tmpBolloon, reason: 'after-ghost' });
    expect(lock.ok).toBe(true);
    expect(lock.staleReclaimed).toBe(true);
    await releaseUpdateLock(tmpBolloon);
  });

  it('reclaimStaleLockIfAny 不动活着的锁', async () => {
    await acquireUpdateLock({ home: tmpBolloon, reason: 'live' });
    const r = await reclaimStaleLockIfAny(tmpBolloon);
    expect(r.reclaimed).toBe(false);
    expect(readUpdateLock(tmpBolloon)).not.toBeNull();
    await releaseUpdateLock(tmpBolloon);
  });
});

describe('更新历史 (append-only)', () => {
  it('追加后按时间倒序读取, 半行 (被 kill) 不炸', async () => {
    await appendUpdateHistory({ at: '2026-09-01T00:00:00.000Z', from: '0.4.26', to: '0.4.27', status: 'succeeded', durationMs: 1000 }, tmpBolloon);
    await appendUpdateHistory({ at: '2026-09-02T00:00:00.000Z', from: '0.4.27', to: '0.4.28', status: 'failed', reason: '网络' }, tmpBolloon);
    fs.appendFileSync(updateHistoryPath(tmpBolloon), '{"at":"2026-09-03T00:00:00.000Z","from":"0.4.28"');
    const recs = await readUpdateHistory(10, tmpBolloon);
    expect(recs.length).toBe(2);
    expect(recs[0].to).toBe('0.4.28');
    expect(recs[1].to).toBe('0.4.27');
    const text = renderHistory(recs);
    expect(text).toContain('0.4.27 → 0.4.28');
    expect(text).toContain('failed');
    expect(renderHistory([])).toContain('没有更新历史');
  });

  it('状态文件原子写: 临时文件不留残渣', async () => {
    await writeUpdateState({ lastCheckAt: new Date().toISOString() }, tmpBolloon);
    const leftovers = fs.readdirSync(tmpBolloon).filter((f) => f.includes('.tmp-'));
    expect(leftovers).toEqual([]);
    expect(fs.existsSync(updateStatePath(tmpBolloon))).toBe(true);
  });

  it('空状态是可用的 (不做 undefined 崩溃)', () => {
    const st = emptyUpdateState();
    expect(st.checkUpdates).toBe(true);
    expect(st.autoInstall).toBe(false);
    expect(st.needsRestart).toBe(false);
    expect(st.lastUpdate).toBeNull();
  });
});

// ── ④ 计划与执行 ────────────────────────────────────────────────────────────

describe('buildUpdatePlan: 先给计划再动手', () => {
  it('计划含"要更新什么 / 不会动什么 / 风险检查 / 三种策略"', async () => {
    const inst = fakeInstall('0.4.28');
    const plan = await buildUpdatePlan({
      home: tmpBolloon, installation: inst, registry: registryOk('0.4.29', ['0.4.28', '0.4.29']), force: true,
      workloadRiskOverride: [],
    });
    expect(plan.ok).toBe(true);
    expect(plan.targetVersion).toBe('0.4.29');
    expect(plan.willUpdate).toContain('@bolloon/bolloon-agent');
    expect(plan.willNotTouch).toContain('~/.bolloon/config.json');
    expect(plan.willNotTouch).toContain('~/.bolloon/transactions/');
    expect(plan.strategies).toEqual(['now', 'wait', 'cancel']);
    expect(plan.needsRestart).toBe(true);
    expect(plan.blockers).toEqual([]);

    const text = renderUpdatePlan(plan);
    expect(text).toContain('将更新:');
    expect(text).toContain('不会修改:');
    expect(text).toContain('风险检查: 通过');
    expect(text).toContain('需要重启: 是');
  });

  it('开发目录 → 计划被阻塞且写明为什么', async () => {
    const inst = fakeInstall('0.4.28', { method: 'development' });
    const plan = await buildUpdatePlan({
      home: tmpBolloon, installation: inst, registry: registryOk('0.4.29', ['0.4.29']), force: true, workloadRiskOverride: [],
    });
    expect(plan.ok).toBe(false);
    expect(plan.blockers.join(' ')).toContain('安装方式支持自动更新');
    expect(plan.willUpdate).toEqual([]);
  });

  it('离线 → 阻塞 (不会"计划通过"然后装不上)', async () => {
    const inst = fakeInstall('0.4.28');
    const plan = await buildUpdatePlan({
      home: tmpBolloon, installation: inst, force: true, workloadRiskOverride: [],
      registry: { ok: false, kind: 'offline', detail: 'ENOTFOUND' },
    });
    expect(plan.ok).toBe(false);
    expect(plan.blockers.join(' ')).toMatch(/registry 可达|离线/);
  });

  it('目标版本不在 registry → 阻塞 (不执行一个装不上的版本)', async () => {
    const inst = fakeInstall('0.4.28');
    const plan = await buildUpdatePlan({
      home: tmpBolloon, installation: inst, force: true, workloadRiskOverride: [],
      registry: registryOk('0.4.99', ['0.4.28']), // dist-tags 指向一个不存在的版本
    });
    expect(plan.ok).toBe(false);
    expect(plan.blockers.join(' ')).toContain('目标版本真实存在');
  });

  it('有长期任务 → 不阻塞但默认策略变成"等 Run 结束"', async () => {
    const inst = fakeInstall('0.4.28');
    const plan = await buildUpdatePlan({
      home: tmpBolloon, installation: inst, registry: registryOk('0.4.29', ['0.4.28', '0.4.29']), force: true,
      workloadRiskOverride: [{
        id: 'payment_in_flight', label: '没有支付中的交易', ok: false, blocking: false, advisory: true,
        detail: '1 笔支付中/待付交易',
      }],
    });
    expect(plan.ok).toBe(true);
    expect(plan.defaultStrategy).toBe('wait');
    expect(plan.advisories.length).toBe(1);
    expect(renderUpdatePlan(plan)).toContain('建议策略');
  });
});

describe('applyUpdate: 失败必须保留旧版本', () => {
  it('有阻塞项 → blocked, 不调 npm', async () => {
    const inst = fakeInstall('0.4.28', { method: 'development' });
    let npmCalled = 0;
    const res = await applyUpdate({
      home: tmpBolloon, installation: inst, registry: registryOk('0.4.29', ['0.4.29']), force: true,
      runNpm: () => { npmCalled++; return { code: 0, stdout: '', stderr: '' }; },
    });
    expect(res.stage).toBe('blocked');
    expect(res.ok).toBe(false);
    expect(npmCalled).toBe(0);
    // 阻塞也要留痕 (改天再看得到)
    const st = await readUpdateState(tmpBolloon);
    expect(st.lastUpdate?.status).toBe('blocked');
    expect(st.lastFailure?.reason).toBeTruthy();
  });

  it('下载失败 → failed, 旧版本没被动过, 锁被释放', async () => {
    const inst = fakeInstall('0.4.28');
    const res = await applyUpdate({
      home: tmpBolloon, installation: inst, registry: registryOk('0.4.29', ['0.4.28', '0.4.29']), force: true,
      runNpm: (args) => args[0] === 'pack'
        ? { code: 1, stdout: '', stderr: 'EAI_AGAIN registry.npmjs.org' }
        : { code: 0, stdout: '', stderr: '' },
      verifyInstall: async () => true,
    });
    expect(res.ok).toBe(false);
    expect(res.stage).toBe('failed');
    expect(res.reason).toContain('EAI_AGAIN');
    expect(installedVersionOnDisk(inst.packageRoot)).toBe('0.4.28'); // 旧版本还在
    expect(readUpdateLock(tmpBolloon)).toBeNull();                  // 锁已释放
    const st = await readUpdateState(tmpBolloon);
    expect(st.lastFailure?.stage, `outcome=${JSON.stringify(res)}`).toBe('downloading');
    expect(st.needsRestart).toBe(false);
  });

  it('切换后验证失败 + 磁盘版本已是新版 → 报失败并给出回滚指令', async () => {
    const inst = fakeInstall('0.4.28');
    // 用真实 npm pack 太慢: 直接让 pack 成功产出一个 tarball, 再让 switch 把版本"写成"目标版本
    const res = await applyUpdate({
      home: tmpBolloon, installation: inst, registry: registryOk('0.4.29', ['0.4.28', '0.4.29']), force: true,
      runNpm: (args, cwd) => {
        if (args[0] === 'pack') {
          // 造一个能被解压 + 通过校验的最小包
          const stageDir = path.join(tmpHome, 'stage-pkg');
          fs.mkdirSync(path.join(stageDir, 'dist'), { recursive: true });
          fs.writeFileSync(path.join(stageDir, 'package.json'), JSON.stringify({ name: '@bolloon/bolloon-agent', version: '0.4.29' }));
          fs.writeFileSync(path.join(stageDir, 'dist', 'cli-entry.js'), '// entry');
          const tarName = 'bolloon-agent-0.4.29.tgz';
          const r = require('child_process').spawnSync('tar', ['-czf', path.join(cwd, tarName), '-C', tmpHome, 'stage-pkg'], { encoding: 'utf8' });
          // tar 内的目录名必须是 package/, 这里改造一下
          const r2 = require('child_process').spawnSync('bash', ['-c', `cd ${tmpHome} && mv stage-pkg package && tar -czf ${path.join(cwd, tarName)} package`], { encoding: 'utf8' });
          return { code: r.status === 0 && r2.status === 0 ? 0 : 1, stdout: '', stderr: 'ok' };
        }
        if (args[0] === 'install') {
          // 模拟"切换成功但验证不过": 磁盘上已换成新版
          fs.writeFileSync(path.join(inst.packageRoot, 'package.json'), JSON.stringify({ name: '@bolloon/bolloon-agent', version: '0.4.29' }));
          return { code: 0, stdout: '', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
      verifyInstall: async () => false, // 新版本起不来
    });
    expect(res.ok).toBe(false);
    expect(res.stage).toBe('failed');
    expect(res.reason).toContain('回退');
    expect(res.reason).toContain('npm install -g @bolloon/bolloon-agent@0.4.28');
  });

  it('成功路径: 产物校验通过 + 验证通过 → succeeded, 状态与历史都写下"需要重启"', async () => {
    const inst = fakeInstall('0.4.28');
    const res = await applyUpdate({
      home: tmpBolloon, installation: inst, registry: registryOk('0.4.29', ['0.4.28', '0.4.29']), force: true,
      runNpm: (args, cwd) => {
        if (args[0] === 'pack') {
          fs.mkdirSync(path.join(tmpHome, 'stage2', 'dist'), { recursive: true });
          fs.writeFileSync(path.join(tmpHome, 'stage2', 'package.json'), JSON.stringify({ name: '@bolloon/bolloon-agent', version: '0.4.29' }));
          fs.writeFileSync(path.join(tmpHome, 'stage2', 'dist', 'cli-entry.js'), '// entry');
          require('child_process').spawnSync('bash', ['-c', `cd ${tmpHome} && mv stage2 package2 && mkdir -p package && cp -r package2/* package/ && tar -czf ${path.join(cwd, 'bolloon-agent-0.4.29.tgz')} package`], { encoding: 'utf8' });
          return { code: 0, stdout: '', stderr: '' };
        }
        if (args[0] === 'install') {
          fs.writeFileSync(path.join(inst.packageRoot, 'package.json'), JSON.stringify({ name: '@bolloon/bolloon-agent', version: '0.4.29' }));
          return { code: 0, stdout: '', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
      verifyInstall: async () => true,
    });
    expect(res.ok).toBe(true);
    expect(res.stage).toBe('succeeded');
    expect(res.from).toBe('0.4.28');
    expect(res.to).toBe('0.4.29');
    expect(res.needsRestart).toBe(true);
    const st = await readUpdateState(tmpBolloon);
    expect(st.needsRestart).toBe(true);
    expect(st.lastFailure).toBeNull();
    const recs = await readUpdateHistory(5, tmpBolloon);
    expect(recs[0].status).toBe('succeeded');
    expect(readUpdateLock(tmpBolloon)).toBeNull();
  });

  it('执行中会落"进行中"的阶段 (被 kill 后盘上有证据, doctor 能报异常中断)', async () => {
    const inst = fakeInstall('0.4.28');
    let seenDuringPack: any = null;
    const res = await applyUpdate({
      home: tmpBolloon, installation: inst, registry: registryOk('0.4.29', ['0.4.28', '0.4.29']), force: true,
      runNpm: (args, cwd) => {
        if (args[0] === 'pack') {
          // 真读一次盘: 此刻状态里必须是"进行中", 而不是空
          seenDuringPack = JSON.parse(fs.readFileSync(updateStatePath(tmpBolloon), 'utf8'));
          return { code: 1, stdout: '', stderr: 'stop here' };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    expect(res.ok).toBe(false);
    expect(seenDuringPack?.lastUpdate?.status).toBe('downloading');
    expect(seenDuringPack?.lastUpdate?.from).toBe('0.4.28');
    // 收尾后是终态 (不会停在"进行中")
    const st = await readUpdateState(tmpBolloon);
    expect(st.lastUpdate?.status).toBe('failed');
  });

  it('已有另一个更新进程持锁 → blocked (不并行更新)', async () => {
    const inst = fakeInstall('0.4.28');
    fs.writeFileSync(updateLockPath(tmpBolloon), JSON.stringify({ pid: 1, at: new Date().toISOString(), by: 'other' }));
    const res = await applyUpdate({
      home: tmpBolloon, installation: inst, registry: registryOk('0.4.29', ['0.4.28', '0.4.29']), force: true,
      runNpm: () => ({ code: 0, stdout: '', stderr: '' }),
    });
    expect(res.stage).toBe('blocked');
    expect(res.reason).toContain('另一个更新进程');
  });

  it('--wait 策略在有提醒项时不执行, 只记录"等 Run 结束" (且不调 npm)', async () => {
    const inst = fakeInstall('0.4.28');
    let npmCalled = 0;
    const res = await applyUpdate({
      home: tmpBolloon, installation: inst, registry: registryOk('0.4.29', ['0.4.28', '0.4.29']),
      strategy: 'wait',
      workloadRiskOverride: [{
        id: 'active_goals', label: '没有进行中的 Goal', ok: false, blocking: false, advisory: true, detail: '1 个未收尾 Goal',
      }],
      runNpm: () => { npmCalled++; return { code: 0, stdout: '', stderr: '' }; },
    });
    expect(res.stage).toBe('blocked');
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('等待当前 Run 结束后更新');
    expect(npmCalled).toBe(0);
    // 记录在历史里 (用户改天看得到"我当时选了等一会儿")
    const recs = await readUpdateHistory(5, tmpBolloon);
    expect(recs[0].status).toBe('planned');
    expect(recs[0].reason).toContain('等待当前 Run 结束');
  });
});

describe('子进程 JSON 解析 (多行 pretty JSON 必须能读)', () => {
  it('多行 JSON 整体解析, 不是只看第一行 {', () => {
    const pretty = JSON.stringify({ packageVersion: '0.4.28', nested: { a: 1 } }, null, 2);
    expect(parseJsonFromStdout(pretty)?.packageVersion).toBe('0.4.28');
    expect(parseJsonFromStdout(`warning: something\n${pretty}\n` )?.packageVersion).toBe('0.4.28');
    expect(parseJsonFromStdout('')).toBeNull();
    expect(parseJsonFromStdout('not json')).toBeNull();
  });
});

describe('临时产物校验', () => {
  it('版本不符 / 缺入口 → 校验失败', () => {
    const dir = fs.mkdtempSync(path.join(tmpHome, 'staged-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.4.29' }));
    expect(validateStagedPackage(dir, '0.4.29').ok).toBe(false);          // 缺入口
    fs.mkdirSync(path.join(dir, 'dist'));
    fs.writeFileSync(path.join(dir, 'dist', 'cli-entry.js'), '');
    expect(validateStagedPackage(dir, '0.4.29').ok).toBe(true);
    expect(validateStagedPackage(dir, '0.4.30').detail).toContain('≠ 目标');
  });
});

// ── 状态 / doctor 渲染 ──────────────────────────────────────────────────────

describe('update --status 与 doctor 的输出', () => {
  it('doctor: ~/.bolloon 还不存在时是 degraded (可创建), 不是 failed —— 真跑抓到过的假阴性', async () => {
    const freshHome = path.join(tmpHome, 'fresh-home');
    fs.mkdirSync(freshHome, { recursive: true });
    const rep = await runDoctor({ bolloonHome: path.join(freshHome, '.bolloon'), userHome: freshHome, skipNetwork: true });
    const item = rep.checks.find((c) => c.id === 'home_writable')!;
    expect(item.grade).toBe('degraded');
    expect(item.detail).toContain('还不存在');
  }, 60_000);   // doctor 会真起 CLI + 真验证运行时 (git 建临时仓库/python 跑脚本), 全量并行下 20s 不够

  it('readUpdateStatus 报出当前版本/开关/锁/最近失败', async () => {
    await writeUpdateState({
      currentVersion: '0.4.28', latestVersion: '0.4.29', lastCheckAt: new Date().toISOString(),
      lastCheckStatus: 'update_available', lastFailure: { at: new Date().toISOString(), stage: 'switching', reason: 'EACCES' },
    }, tmpBolloon);
    const s = await readUpdateStatus({ home: tmpBolloon, env: {} });
    expect(s.currentVersion).toBeTruthy();
    expect(s.latestVersion).toBe('0.4.29');
    expect(s.lastCheckStatus).toBe('update_available');
    expect(s.lastFailure?.stage).toBe('switching');
    expect(s.prefs.autoInstall).toBe(false);
    expect(s.lock).toBeNull();
  });

  it('健康分级: 任一 failed → failed; 仅 degraded → degraded; 全过 → healthy', () => {
    expect(gradeOfItems(threeItems)).toBe('degraded');
    expect(gradeOfItems([{ ...threeItems[0] }])).toBe('healthy');
    expect(gradeOfItems([threeItems[0], { id: 'x', label: 'X', grade: 'failed', detail: '' }])).toBe('failed');
  });

  it('renderHealth / renderDoctor 打印每一项与结论', () => {
    const h = renderHealth({
      grade: 'degraded', version: '0.4.28', checkedAt: 'now',
      items: [{ id: 'skills_health', label: 'SkillsManager 健康', grade: 'degraded', detail: '漂移 1' }],
      failures: [], degradations: ['SkillsManager 健康: 漂移 1'],
    });
    expect(h).toContain('degraded');
    expect(h).toContain('SkillsManager 健康');

    const d = renderDoctor({
      grade: 'failed', version: '0.4.28', checkedAt: 'now',
      checks: [{ id: 'entry_point', label: '安装入口', grade: 'failed', detail: '指向别处', action: 'npm install -g @bolloon/bolloon-agent' }],
      health: { grade: 'failed', version: '0.4.28', checkedAt: 'now', items: [], failures: [], degradations: [] },
    });
    expect(d).toContain('❌ 安装入口');
    expect(d).toContain('→ npm install -g');
    expect(d).toContain('结论: 有阻塞性');
  });
});
