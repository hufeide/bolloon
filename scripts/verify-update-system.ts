/**
 * verify-update-system.ts — 更新系统的**真跑**验收 (2026-09-19)
 *
 * 为什么不能只靠单测: 单测能证明"逻辑分支对", 证明不了
 * "真断网时不会显示已是最新 / 真安装失败时旧版本还在 / 真被 kill 之后能恢复"。
 *
 * 本脚本用**真的** npm + 真的 HTTP registry (本地起一个受控 fake registry) + 真的 SIGKILL,
 * 全部隔离在临时 HOME 与临时 npm prefix 里 —— **不触碰本机全局安装, 不触碰 ~/.bolloon**。
 *
 * 用法: npx tsx scripts/verify-update-system.ts
 * 退出码: 0 = 全过, 1 = 有失败
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import * as crypto from 'crypto';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';

import { checkForUpdate, applyUpdate, installedVersionOnDisk } from '../src/utils/update-manager.js';
import { detectInstallation, collectVersionInfo } from '../src/utils/version-info.js';
import { readUpdateState, readUpdateLock, lockIsStale, releaseUpdateLock } from '../src/utils/update-state.js';
import {
  readPackageAt, PKG_NAME,
} from '../src/utils/version-info.js';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const TARGET_VERSION = '0.4.29';
const OLD_VERSION = '0.4.28';

// ── 结果记账 ────────────────────────────────────────────────────────────────

interface CaseResult { name: string; ok: boolean; detail: string }
const results: CaseResult[] = [];
function record(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name} — ${detail}`);
}
function assert(name: string, cond: boolean, detail: string) {
  record(name, !!cond, detail);
}

// ── 受控 fake registry (真 HTTP) ────────────────────────────────────────────

interface FakeRegistry {
  port: number;
  url: string;
  tarball: Buffer;
  shasum: string;
  integrity: string;
  close: () => Promise<void>;
  /** 记录收到的 tarball 请求次数 (用来证明真的下了/真的卡在这) */
  tarballHits: () => number;
  mode: { tarball: 'served' | 'stall' | 'error' };
}

/** 造一个"0.4.29 的包 tarball" —— 里面真的有可执行的 dist/cli-entry.js。 */
function buildFakeTarball(dir: string): { file: string; buffer: Buffer; shasum: string; integrity: string } {
  const pkgDir = path.join(dir, 'package');
  fs.mkdirSync(path.join(pkgDir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
    name: PKG_NAME, version: TARGET_VERSION, type: 'module', bin: { bolloon: './dist/cli-entry.js' },
  }, null, 2));
  fs.writeFileSync(path.join(pkgDir, 'dist', 'cli-entry.js'), `
const argv = process.argv.slice(2);
if (argv.includes('--version') && argv.includes('--json')) {
  process.stdout.write(JSON.stringify({ packageVersion: '${TARGET_VERSION}', installMethod: 'npm-global' }, null, 2) + '\\n');
  process.exit(0);
}
process.stdout.write('Bolloon Agent v${TARGET_VERSION}\\n');
`);
  const file = path.join(dir, `bolloon-agent-${TARGET_VERSION}.tgz`);
  const r = spawnSync('tar', ['-czf', file, '-C', dir, 'package'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`造夹具 tarball 失败: ${r.stderr}`);
  const buffer = fs.readFileSync(file);
  return {
    file,
    buffer,
    shasum: crypto.createHash('sha1').update(buffer).digest('hex'),
    integrity: 'sha512-' + crypto.createHash('sha512').update(buffer).digest('base64'),
  };
}

async function startFakeRegistry(tarball: { buffer: Buffer; shasum: string; integrity: string }): Promise<FakeRegistry> {
  const state = { mode: { tarball: 'served' as 'served' | 'stall' | 'error' }, hits: 0 };
  const server = http.createServer((req, res) => {
    const url = req.url || '';
    if (url.includes('/tarball/')) {
      state.hits++;
      if (state.mode.tarball === 'error') { res.writeHead(500); res.end('boom'); return; }
      if (state.mode.tarball === 'stall') {
        // 故意不回 body: 客户端会一直等 → 给父进程时间 kill -9
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(tarball.buffer.length) });
        return; // 不 end
      }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(tarball.buffer);
      return;
    }
    if (url.includes('bolloon-agent') || url.includes('@bolloon%2Fbolloon-agent')) {
      const versionOf = (v: string) => ({
        name: PKG_NAME, version: v,
        dist: {
          tarball: `http://127.0.0.1:${(server.address() as any).port}/tarball/bolloon-agent-${v}.tgz`,
          shasum: tarball.shasum, integrity: tarball.integrity,
        },
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        name: PKG_NAME,
        'dist-tags': { latest: TARGET_VERSION },
        versions: { [OLD_VERSION]: versionOf(OLD_VERSION), [TARGET_VERSION]: versionOf(TARGET_VERSION) },
      }));
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    tarball: tarball.buffer,
    shasum: tarball.shasum,
    integrity: tarball.integrity,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    tarballHits: () => state.hits,
    mode: state.mode,
  };
}

// ── 子进程场景 (env 必须在 import 之前设置, 所以真检查只能放子进程里跑) ──────

interface ChildSpec {
  scenario: 'offline-check' | 'happy' | 'install-fail' | 'stall' | 'after-kill-recover';
  registryUrl: string;
  home: string;        // 隔离用户 home
  bolloonHome: string; // 隔离 ~/.bolloon
  prefix: string;      // 隔离的 npm prefix (假装是 npm-global 安装)
  target?: string;
}

function childInstallation(prefix: string) {
  const root = path.join(prefix, 'lib', 'node_modules', '@bolloon', 'bolloon-agent');
  return {
    method: 'npm-global' as const,
    packageRoot: root,
    installDir: root,
    binPath: path.join(prefix, 'bin', 'bolloon'),
    entryPath: path.join(root, 'dist', 'cli-entry.js'),
    writable: true,
    linked: false,
    linkTarget: null,
    updateSource: 'npm' as const,
    autoUpdatable: true,
    reason: 'verify-update-system 夹具: 临时 prefix 上的 npm-global',
  };
}

/** 在临时 prefix 里预置一个"已安装的旧版本"。 */
function seedOldInstall(prefix: string, version: string) {
  const root = path.join(prefix, 'lib', 'node_modules', '@bolloon', 'bolloon-agent');
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: PKG_NAME, version }, null, 2));
  fs.writeFileSync(path.join(root, 'dist', 'cli-entry.js'), `
const argv = process.argv.slice(2);
if (argv.includes('--json')) { process.stdout.write(JSON.stringify({ packageVersion: '${version}' }) + '\\n'); process.exit(0); }
process.stdout.write('Bolloon Agent v${version}\\n');
`);
  return root;
}

async function runChild(spec: ChildSpec): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: spec.home,
    BOLLOON_HOME: spec.bolloonHome,
    BOLLOON_NPM_REGISTRY: spec.registryUrl,
    npm_config_registry: spec.registryUrl,
    npm_config_prefix: spec.prefix,
    npm_config_cache: path.join(spec.home, '.npm-cache'),
    BOLLOON_UPDATE_VERBOSE: '1',
  };
  const child: ChildProcess = spawn(process.execPath, childArgv(__filename, ['--child', JSON.stringify(spec)]), {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = ''; let err = '';
  child.stdout!.on('data', (d) => { out += String(d); });
  child.stderr!.on('data', (d) => { err += String(d); });
  const res = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  return { ...res, stdout: out, stderr: err };
}

/**
 * 子进程必须**单进程**跑: `node_modules/.bin/tsx` 自己还会 fork 一个 node 跑真正的脚本,
 * 于是"kill 掉父进程"之后孙进程还活着、还持着更新锁 → 会把这个验收误判成"锁不可回收"。
 * `node --import tsx` 让脚本就在当前 node 进程里执行, pid 与锁里记的 pid 是同一个。
 */
function childArgv(script: string, extra: string[]): string[] {
  const tsxPkg = path.join(ROOT, 'node_modules', 'tsx');
  if (!fs.existsSync(tsxPkg)) throw new Error('找不到 node_modules/tsx (需要 devDependencies)');
  return ['--import', 'tsx', script, ...extra];
}

function parseChildResult(stdout: string): any | null {
  const line = stdout.split('\n').find((l) => l.startsWith('__RESULT__'));
  if (!line) return null;
  try { return JSON.parse(line.slice('__RESULT__'.length)); } catch { return null; }
}

/** 子进程主体 —— 只在带 --child 时执行。 */
async function childMain(spec: ChildSpec): Promise<void> {
  const install = childInstallation(spec.prefix);
  const emit = (o: any) => process.stdout.write(`__RESULT__${JSON.stringify(o)}\n`);

  if (spec.scenario === 'offline-check') {
    const r = await checkForUpdate({ home: spec.bolloonHome, force: true });
    emit({ status: r.status, latest: r.latestVersion, reason: r.reason });
    return;
  }
  if (spec.scenario === 'stall') {
    // 真 npm 会卡在下载 tarball 上 (fake registry 不回 body) → 等父进程 kill -9
    const res = await applyUpdate({
      home: spec.bolloonHome, installation: install, force: true, strategy: 'now',
      verifyInstall: async () => true,
    });
    emit({ stage: res.stage, ok: res.ok });
    return;
  }

  const before = fs.existsSync(path.join(spec.bolloonHome, 'config.json'))
    ? crypto.createHash('sha256').update(fs.readFileSync(path.join(spec.bolloonHome, 'config.json'))).digest('hex')
    : null;

  const res = await applyUpdate({
    home: spec.bolloonHome, installation: install, force: true, strategy: 'now',
    // 真 npm, 但强制 --prefix 到临时 prefix —— 绝不碰本机全局安装
    runNpm: (args, cwd) => {
      const finalArgs = args[0] === 'install' ? [...args, '--prefix', spec.prefix] : args;
      const r = spawnSync('npm', finalArgs, {
        cwd,
        encoding: 'utf8',
        timeout: 600_000,
        env: { ...process.env, npm_config_registry: spec.registryUrl, npm_config_prefix: spec.prefix },
      });
      return { code: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
    },
    // 真验证: 读临时 prefix 上的版本 + 真起一次新入口
    verifyInstall: async (target) => {
      const root = path.join(spec.prefix, 'lib', 'node_modules', '@bolloon', 'bolloon-agent');
      const onDisk = readPackageAt(root)?.version;
      if (onDisk !== target) return false;
      const r = spawnSync(process.execPath, [path.join(root, 'dist', 'cli-entry.js'), '--version', '--json'], { encoding: 'utf8', timeout: 60_000 });
      if (r.status !== 0) return false;
      try {
        const s = String(r.stdout);
        return JSON.parse(s.slice(s.indexOf('{'))).packageVersion === target;
      } catch { return false; }
    },
  });

  const after = fs.existsSync(path.join(spec.bolloonHome, 'config.json'))
    ? crypto.createHash('sha256').update(fs.readFileSync(path.join(spec.bolloonHome, 'config.json'))).digest('hex')
    : null;

  emit({
    stage: res.stage, ok: res.ok, failedAt: res.failedAt, reason: res.reason,
    from: res.from, to: res.to,
    onDisk: installedVersionOnDisk(path.join(spec.prefix, 'lib', 'node_modules', '@bolloon', 'bolloon-agent')),
    configUnchanged: before === after,
    lockAfter: fs.existsSync(path.join(spec.bolloonHome, 'update.lock')),
    state: await readUpdateState(spec.bolloonHome).then((s) => ({ lastStatus: s.lastUpdate?.status, failureStage: s.lastFailure?.stage, needsRestart: s.needsRestart })),
  });
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--child')) {
    const spec = JSON.parse(argv[argv.indexOf('--child') + 1]) as ChildSpec;
    try {
      await childMain(spec);
      process.exit(0);
    } catch (e: any) {
      process.stdout.write(`__RESULT__${JSON.stringify({ error: e?.message || String(e) })}\n`);
      process.exit(3);
    }
  }

  console.log(`\n更新系统真跑验收 (隔离 HOME + 隔离 npm prefix, 不碰本机全局安装)\n`);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-verify-update-'));
  const fixture = buildFakeTarball(work);
  const reg = await startFakeRegistry(fixture);

  // ── A. 离线: 连不上任何 registry ─────────────────────────────────────────
  {
    const home = path.join(work, 'a-home');
    const bolloonHome = path.join(home, '.bolloon');
    fs.mkdirSync(bolloonHome, { recursive: true });
    // 1:9 是保留端口, 连接必然被拒
    const child = await runChild({ scenario: 'offline-check', registryUrl: 'http://127.0.0.1:9', home, bolloonHome, prefix: path.join(work, 'a-prefix') });
    const r = parseChildResult(child.stdout);
    assert('A. 真断网 → 不报"已是最新"',
      r && (r.status === 'offline' || r.status === 'registry_unavailable'),
      `status=${r?.status} reason=${r?.reason}`);
    assert('A. 真断网时 latestVersion 为空 (不编造)',
      r?.latest === null,
      `latest=${JSON.stringify(r?.latest)}`);
  }

  // ── B. 真无权限: 安装目录不可写 → 计划阻塞 ───────────────────────────────
  {
    const ro = path.join(work, 'readonly-pkg');
    fs.mkdirSync(ro, { recursive: true });
    fs.writeFileSync(path.join(ro, 'package.json'), JSON.stringify({ name: PKG_NAME, version: OLD_VERSION }));
    fs.chmodSync(ro, 0o500); // r-x: 不可写
    const inst = detectInstallation({ packageRoot: ro });
    assert('B. 目录不可写 → writable=false', inst.writable === false, `writable=${inst.writable}`);
    assert('B. 目录不可写 → 不允许自动更新', inst.autoUpdatable === false, `autoUpdatable=${inst.autoUpdatable}`);
    fs.chmodSync(ro, 0o700);
  }

  // ── C. 全隔离的**成功**更新路径 (真 npm + 真 registry + 真起新入口) ──────
  const prefixC = path.join(work, 'c-prefix');
  seedOldInstall(prefixC, OLD_VERSION);
  const homeC = path.join(work, 'c-home');
  const bolloonC = path.join(homeC, '.bolloon');
  fs.mkdirSync(bolloonC, { recursive: true });
  fs.writeFileSync(path.join(bolloonC, 'config.json'), JSON.stringify({ autoInstall: true, userField: 'keep-me' }, null, 2));
  {
    const child = await runChild({ scenario: 'happy', registryUrl: reg.url, home: homeC, bolloonHome: bolloonC, prefix: prefixC });
    const r = parseChildResult(child.stdout);
    if (!r) {
      assert('C. 成功路径', false, `子进程无结果: ${child.stderr.slice(-300) || child.stdout.slice(-300)}`);
    } else {
      assert('C. 真 npm 更新成功 (succeeded)', r.stage === 'succeeded' && r.ok === true, `stage=${r.stage} ${r.reason || ''}`);
      assert('C. 磁盘上确实换成了目标版本', r.onDisk === TARGET_VERSION, `onDisk=${r.onDisk}`);
      assert('C. 用户配置字节未变 (自动安装没动用户数据)', r.configUnchanged === true, `configUnchanged=${r.configUnchanged}`);
      assert('C. 更新后锁已释放', r.lockAfter === false, `lock=${r.lockAfter}`);
      assert('C. 状态记录 succeeded + needsRestart', r.state?.lastStatus === 'succeeded' && r.state?.needsRestart === true,
        `lastStatus=${r.state?.lastStatus} needsRestart=${r.state?.needsRestart}`);
    }
  }

  // ── D. 真安装失败 (registry 对 tarball 返回 500) → 旧版本还在 ─────────────
  reg.mode.tarball = 'error';
  {
    const prefixD = path.join(work, 'd-prefix');
    seedOldInstall(prefixD, OLD_VERSION);
    const homeD = path.join(work, 'd-home');
    const bolloonD = path.join(homeD, '.bolloon');
    fs.mkdirSync(bolloonD, { recursive: true });
    fs.writeFileSync(path.join(bolloonD, 'config.json'), JSON.stringify({ userField: 'keep-me' }));
    const child = await runChild({ scenario: 'install-fail', registryUrl: reg.url, home: homeD, bolloonHome: bolloonD, prefix: prefixD });
    const r = parseChildResult(child.stdout);
    assert('D. 下载失败 → 更新失败 (不是"成功")', r?.ok === false && r?.stage === 'failed', `stage=${r?.stage} ${r?.reason?.slice(0, 80)}`);
    assert('D. 失败后旧版本仍在', r?.onDisk === OLD_VERSION, `onDisk=${r?.onDisk}`);
    assert('D. 失败原因落到状态里 (failedAt=downloading)', r?.state?.failureStage === 'downloading' || r?.state?.failureStage === 'staged',
      `failureStage=${r?.state?.failureStage}`);
    assert('D. 失败不丢用户配置', r?.configUnchanged === true, `configUnchanged=${r?.configUnchanged}`);
    assert('D. 失败后锁已释放 (不会卡死后续更新)', r?.lockAfter === false, `lock=${r?.lockAfter}`);
  }

  // ── E. 真 SIGKILL: 更新中途被杀 → 锁残留 + 未半更新 + 能恢复 ─────────────
  reg.mode.tarball = 'stall';
  const prefixE = path.join(work, 'e-prefix');
  seedOldInstall(prefixE, OLD_VERSION);
  const homeE = path.join(work, 'e-home');
  const bolloonE = path.join(homeE, '.bolloon');
  fs.mkdirSync(bolloonE, { recursive: true });
  {
    const spec: ChildSpec = { scenario: 'stall', registryUrl: reg.url, home: homeE, bolloonHome: bolloonE, prefix: prefixE };
    const env: NodeJS.ProcessEnv = {
      ...process.env, HOME: homeE, BOLLOON_HOME: bolloonE,
      BOLLOON_NPM_REGISTRY: reg.url, npm_config_registry: reg.url,
      npm_config_prefix: prefixE, npm_config_cache: path.join(homeE, '.npm-cache'),
    };
    const child = spawn(process.execPath, childArgv(__filename, ['--child', JSON.stringify(spec)]), { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });

    // 等它真的拿到锁 (最多 20s), 然后 SIGKILL
    let locked = false;
    for (let i = 0; i < 100; i++) {
      if (fs.existsSync(path.join(bolloonE, 'update.lock'))) { locked = true; break; }
      await new Promise((r) => setTimeout(r, 200));
    }
    await new Promise((r) => setTimeout(r, 1500)); // 让它走到下载那一步
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.on('exit', () => resolve()));

    const lock = readUpdateLock(bolloonE);
    const st = await readUpdateState(bolloonE);
    assert('E. kill 之前真的抢到了锁', locked && !!lock, `lock=${lock ? `pid ${lock.pid}` : 'none'}`);
    assert('E. SIGKILL 后锁留在盘上 (可被 next 识别)', !!lock, `pid=${lock?.pid}`);
    assert('E. 残留锁被判为陈旧 (进程已死)', !!lock && lockIsStale(lock), `stale=${!!lock && lockIsStale(lock)}`);
    assert('E. 被杀后旧版本仍然可用', installedVersionOnDisk(path.join(prefixE, 'lib', 'node_modules', '@bolloon', 'bolloon-agent')) === OLD_VERSION,
      `onDisk=${installedVersionOnDisk(path.join(prefixE, 'lib', 'node_modules', '@bolloon', 'bolloon-agent'))}`);
    assert('E. 状态里留下了"进行中"的痕迹 (doctor 能报异常中断)',
      ['planned', 'downloading', 'staged', 'switching', 'verifying'].includes(String(st.lastUpdate?.status)) || !!st.lastFailure,
      `lastUpdate.status=${st.lastUpdate?.status ?? 'none'}`);

    // 恢复: 下一次更新必须能回收陈旧锁并正常完成
    reg.mode.tarball = 'served';
    const child2 = await runChild({ scenario: 'after-kill-recover', registryUrl: reg.url, home: homeE, bolloonHome: bolloonE, prefix: prefixE });
    const r2 = parseChildResult(child2.stdout);
    assert('E. 被杀之后下一次更新能恢复并成功', r2?.ok === true && r2?.stage === 'succeeded', `stage=${r2?.stage} ${r2?.reason || ''}`);
    assert('E. 恢复后磁盘版本 = 目标版本', r2?.onDisk === TARGET_VERSION, `onDisk=${r2?.onDisk}`);
    assert('E. 恢复后锁已释放', r2?.lockAfter === false, `lock=${r2?.lockAfter}`);
  }
  await releaseUpdateLock(bolloonE).catch(() => { /* 忽略 */ });

  // ── F. 四个问题 (用户视角) 都能被回答 ────────────────────────────────────
  {
    const info = collectVersionInfo({ packageRoot: ROOT, home: path.join(work, 'f-home'), light: false });
    assert('F. "我是什么版本" 可回答', !!info.packageVersion && info.packageVersion !== 'unknown', `v${info.packageVersion}`);
    assert('F. "从哪装的" 可回答', !!info.installMethod && !!info.installDir, `${info.installMethod} @ ${info.installDir}`);
    const st = info.update?.lastCheckStatus ?? null;
    assert('F. "有没有更新" 可回答 (状态是 7 个枚举之一, 或"从未检查"= null)',
      st === null || ['up_to_date', 'update_available', 'check_skipped', 'offline', 'registry_unavailable', 'local_version_unknown', 'unsupported_installation'].includes(String(st)),
      `lastCheckStatus=${String(st)}`);
  }

  await reg.close();
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* 忽略 */ }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== 结果: ${results.length - failed.length} passed / ${failed.length} failed ===`);
  if (failed.length) {
    for (const f of failed) console.log(`  ❌ ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('验收脚本自身出错:', e?.stack || e);
  process.exit(1);
});
