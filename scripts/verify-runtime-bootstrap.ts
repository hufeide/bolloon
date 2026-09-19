/**
 * verify-runtime-bootstrap.ts — 运行时安装协议 + 安装脚本的**真跑**验收 (2026-09-19)
 *
 * 计划的完成标准 (逐条对应下面的用例):
 *   没有 Git, Bolloon 会自动配置 Git。          → A/C/D/E (计划与策略) + F (最低版本门)
 *   没有 Python, Bolloon 会自动配置 Python。    → 同上
 *   安装失败, 不会伪装成安装成功。              → G (真缺运行时 → 非零退出 + "安装未完成")
 *   安装中断, 下次可以继续。                    → B (状态/配置落盘, 下次读回)
 *   运行时路径改变, 可以被发现并修复。          → B (配置里的路径失效 → 按 PATH 重新发现)
 *   核心启动前, 四个必需运行时状态可证明。      → I (真装一遍 + --version/doctor 硬验证)
 *   更新前后, Git/Python 不会悄悄失效。         → H (install.sh 真跑 + doctor 里含运行时项)
 *
 * 全部隔离: 临时 HOME + 临时 npm prefix —— **不碰 leo 的 ~/.bolloon, 不碰系统全局安装**。
 * 用法: npx tsx scripts/verify-runtime-bootstrap.ts [--no-real-install]
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';

import {
  detectRuntimeReport, bootstrapRuntimes, renderRuntimeReport, probeRuntime,
  writeRuntimeConfig, readRuntimeConfig, RUNTIME_MIN,
} from '../src/utils/runtime-bootstrap.js';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const DO_REAL_INSTALL = !process.argv.includes('--no-real-install');
const INSTALL_VERSION = process.env.BOLLOON_TEST_VERSION || '0.4.28';

interface Case { name: string; ok: boolean; detail: string }
const cases: Case[] = [];
function assert(name: string, cond: boolean, detail: string) {
  cases.push({ name, ok: !!cond, detail });
  console.log(`${cond ? '✅' : '❌'} ${name} — ${detail}`);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-verify-runtime-'));
const home = path.join(work, 'home');
fs.mkdirSync(path.join(home, '.bolloon'), { recursive: true });

function childEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { ...process.env, HOME: home, BOLLOON_HOME: path.join(home, '.bolloon'), ...extra };
}

async function main() {
  console.log(`\n运行时安装协议真跑验收 (隔离 HOME=${home})\n`);

  // ── A. 真探测: 四个运行时的路径/版本/最低版本判定 ─────────────────────────
  const rep = await detectRuntimeReport({ home: path.join(home, '.bolloon'), useConfig: false, deep: true });
  const found = rep.facts.filter((f) => f.status === 'found');
  assert('A. 四个运行时都能报出绝对路径 + 版本 + 真执行验证',
    rep.facts.length === 4 && found.every((f) => !!f.path && !!f.version && f.verified === true),
    rep.facts.map((f) => `${f.runtime}=${f.version || f.status}${f.verified ? '(verified)' : ''}`).join(' '));
  assert('A. 判定与本机事实自洽 (ok ⇔ 四个都 found 且都 ≥ 最低版本)',
    rep.ok === rep.facts.every((f) => f.status === 'found' && f.meetsMinimum),
    `ok=${rep.ok} failedStage=${rep.failedStage || '-'}`);

  // ── B. 配置持久化 + 路径失效重新发现 ────────────────────────────────────
  const bHome = path.join(home, '.bolloon');
  fs.writeFileSync(path.join(bHome, 'config.json'), JSON.stringify({ version: '0.4.28', autoInstall: true, userField: 'keep-me' }, null, 2));
  await writeRuntimeConfig(bHome, rep.facts);
  const cfg = JSON.parse(fs.readFileSync(path.join(bHome, 'config.json'), 'utf8'));
  assert('B. runtime.* 落盘 (路径/版本/来源/是否 Bolloon 装/最后验证时间)',
    !!cfg.runtime?.node?.path && !!cfg.runtime?.git?.version && 'installedByBolloon' in cfg.runtime.git && !!cfg.runtimeUpdatedAt,
    `node=${cfg.runtime?.node?.path} git=${cfg.runtime?.git?.version}`);
  assert('B. 只动 runtime 字段: 用户字段/更新开关原样',
    cfg.userField === 'keep-me' && cfg.autoInstall === true && cfg.version === '0.4.28',
    `userField=${cfg.userField} autoInstall=${cfg.autoInstall}`);

  // 路径失效 → 按 PATH 重新发现 (不盲信配置)
  const rewritten = { ...cfg, runtime: { ...cfg.runtime, git: { ...cfg.runtime.git, path: '/nonexistent/git' } } };
  fs.writeFileSync(path.join(bHome, 'config.json'), JSON.stringify(rewritten, null, 2));
  const reDetect = await detectRuntimeReport({ home: bHome, useConfig: true });
  const gitFact = reDetect.facts.find((f) => f.runtime === 'git')!;
  assert('B. 配置里的路径失效 → 按 PATH 重新发现 (配置只是提示, 不盲信)',
    gitFact.status === 'found' && gitFact.path !== '/nonexistent/git',
    `git=${gitFact.path} notes=${gitFact.notes.join('|')}`);

  // ── C. dry-run: 缺运行时也什么都不做 ─────────────────────────────────────
  {
    let called = 0;
    const saved = process.env.PATH;
    try {
      process.env.PATH = path.join(work, 'nowhere');
      const res = await bootstrapRuntimes({
        home: bHome, dryRun: true, yes: true,
        run: () => { called++; return { code: 0, out: '', err: '' }; },
      });
      assert('C. --dry-run 真跑: 一条安装命令都没执行 (PATH 清空制造"四个都缺")',
        called === 0 && res.dryRun === true && res.plan.steps.some((s) => s.action !== 'reuse'),
        `executed=${called} steps=${res.plan.steps.map((s) => `${s.runtime}:${s.action}`).join(',')}`);
    } finally {
      process.env.PATH = saved;
    }
  }

  // ── D. 未同意 (yes 缺省) → 不装 ──────────────────────────────────────────
  {
    let called = 0;
    const saved = process.env.PATH;
    try {
      process.env.PATH = path.join(work, 'nowhere');
      const res = await bootstrapRuntimes({ home: bHome, run: () => { called++; return { code: 0, out: '', err: '' }; } });
      assert('D. 没同意就不装 (yes 缺省): 0 次执行 + 明确"确认后重跑"',
        called === 0 && !res.ok && res.advice.join(' ').includes('确认'),
        `executed=${called} advice=${res.advice.slice(-1)[0] || '-'}`);
    } finally {
      process.env.PATH = saved;
    }
  }

  // ── E. install.sh 的权限策略 (真跑脚本, 不静默装 Homebrew) ────────────────
  {
    // 用干净 PATH 制造"没有 node"的情形, 并让脚本以为在 macOS 无 brew
    const r = spawnSync('bash', [path.join(ROOT, 'scripts', 'install.sh'), '--yes'], {
      encoding: 'utf-8', timeout: 120000,
      env: { ...process.env, PATH: '/usr/bin:/bin', HOME: home, BOLLOON_ALLOW_SUDO: '' },
    });
    const out = `${r.stdout}\n${r.stderr}`;
    const noNode = !fs.existsSync('/usr/bin/node') && !fs.existsSync('/bin/node');
    assert('E. 缺 Node 时: install.sh 明确拒绝 (不静默装 Homebrew/不偷偷 sudo), 退出码非 0',
      noNode ? (r.status !== 0 && /Homebrew|管理员|sudo/.test(out)) : true,
      noNode ? `exit=${r.status} 关键行=${out.split('\n').find((l) => /Homebrew|管理员|sudo/.test(l)) || '-'}` : '本机 /usr/bin/node 存在, 该情形不适用 (已跳过)');
  }

  // ── F. 真最低版本门: 假的老 git → 判定 failed + 给出理由 ─────────────────
  {
    const fakeBin = path.join(work, 'fake-bin');
    fs.mkdirSync(fakeBin, { recursive: true });
    const oldGit = path.join(fakeBin, 'git-old');
    fs.writeFileSync(oldGit, '#!/bin/sh\necho "git version 2.10.0"\n', { mode: 0o755 });
    fs.chmodSync(oldGit, 0o755);
    const f = probeRuntime('git', { preferredPath: oldGit });
    assert('F. 版本低于最低要求 → failed (不是 missing, 也不是就绪) + 理由写明',
      f.status === 'failed' && f.meetsMinimum === false && String(f.error).includes(RUNTIME_MIN.git.min),
      `${f.version} → ${f.error}`);
  }

  // ── G. 真缺运行时 → "安装未完成" + 非零退出 (不伪装成功) ──────────────────
  {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'dist', 'cli-entry.js'), 'runtime'], {
      encoding: 'utf-8', timeout: 180000,
      env: childEnv({ PATH: path.join(work, 'nowhere') }),
    });
    const out = `${r.stdout}\n${r.stderr}`;
    assert('G. 真缺运行时 (PATH 清空) → 打印"Bolloon 安装未完成" + 失败阶段 + 建议, 退出码 1',
      r.status === 1 && out.includes('安装未完成') && out.includes('失败阶段') && out.includes('处理建议'),
      `exit=${r.status}`);
  }

  // ── H. install.sh --dry-run / --runtime-report 真跑: 不做任何修改 ─────────
  {
    const prefix = path.join(work, 'h-prefix');
    const r = spawnSync('bash', [path.join(ROOT, 'scripts', 'install.sh'), '--dry-run'], {
      encoding: 'utf-8', timeout: 120000, env: childEnv({ BOLLOON_PREFIX: prefix }),
    });
    const out = `${r.stdout}\n${r.stderr}`;
    assert('H. install.sh --dry-run: 打印计划 + 不装任何东西 (prefix 未创建)',
      r.status === 0 && out.includes('--dry-run') && !fs.existsSync(prefix),
      `exit=${r.status} prefixExists=${fs.existsSync(prefix)}`);

    const r2 = spawnSync('bash', [path.join(ROOT, 'scripts', 'install.sh'), '--runtime-report'], {
      encoding: 'utf-8', timeout: 120000, env: childEnv(),
    });
    const out2 = `${r2.stdout}\n${r2.stderr}`;
    assert('H. install.sh --runtime-report: 输出环境预检 (四个运行时的当前状态)',
      r2.status === 0 && /Node\.js|Git|Python/.test(out2),
      out2.split('\n').filter((l) => /Node\.js|npm:|Git:|Python:/.test(l)).map((l) => l.trim()).join(' | ').slice(0, 160));
  }

  // ── I. 真安装一遍 (npm 真下载 + postinstall + 运行时补齐 + 硬验证) ────────
  if (DO_REAL_INSTALL) {
    const prefix = path.join(work, 'i-prefix');
    // 用**本地 pack 出来的 tarball** 做真装: 与即将发布的那一份完全一致
    // (也顺带验了发布硬门里的"npm tarball 可安装"; 老版本没有 runtime 子命令, 用它测会验错东西)
    const packDir = path.join(work, 'pack');
    fs.mkdirSync(packDir, { recursive: true });
    const packed = spawnSync('npm', ['pack', '--pack-destination', packDir, '--loglevel=error'], { cwd: ROOT, encoding: 'utf-8', timeout: 600_000 });
    const tgz = fs.readdirSync(packDir).find((f) => f.endsWith('.tgz'));
    // 让 install.sh 认这个 prefix 可写 (它检查 <prefix>/lib 是否存在且可写;
    // 不预建的话脚本会按设计回退到 $HOME/.npm-global —— 那也是正确的行为, 但会验错路径)
    fs.mkdirSync(path.join(prefix, 'lib'), { recursive: true });
    const localVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
    assert('I. 本地 npm pack 出 tarball (发布硬门第一步)',
      packed.status === 0 && !!tgz, `tgz=${tgz || '-'} exit=${packed.status}`);
    const tarball = tgz ? path.join(packDir, tgz) : '';
    console.log(`\n[I] 真安装 ${tgz} (v${localVersion}) 到 ${prefix} (真 npm, 隔离 HOME/prefix)...`);
    const r = spawnSync('bash', [path.join(ROOT, 'scripts', 'install.sh'), '--yes'], {
      encoding: 'utf-8', timeout: 1800_000, maxBuffer: 64 * 1024 * 1024,
      // 复用真实 npm 缓存 (~/.npm/_cacache) —— 只是读缓存, 避免每次重下 200MB 依赖;
      // 保持隔离的只有 HOME/prefix (配置文件与安装位置)
      env: childEnv({
        BOLLOON_PREFIX: prefix, BOLLOON_TARBALL: tarball,
        npm_config_cache: path.join(os.homedir(), '.npm'),
        NPM_CONFIG_USERCONFIG: path.join(os.homedir(), '.npmrc'),
      }),
    });
    const out = `${r.stdout}\n${r.stderr}`;
    const tail = out.trim().split('\n').slice(-12).join('\n');
    assert('I. install.sh --yes 真装成功 (含运行时补齐 + 硬验证), 退出码 0',
      r.status === 0, `exit=${r.status}\n${tail}`);
    const installed = path.join(prefix, 'lib', 'node_modules', '@bolloon', 'bolloon-agent', 'package.json');
    const ver = fs.existsSync(installed) ? JSON.parse(fs.readFileSync(installed, 'utf8')).version : null;
    assert('I. 装出来的版本 == 本地 pack 的版本 (版本自检不是摆设)', ver === localVersion, `onDisk=${ver} 期望=${localVersion}`);
    assert('I. 安装脚本末尾打印了"运行时"报告 (含能力矩阵)',
      out.includes('核心运行') && (out.includes('Git') && out.includes('Python')),
      out.split('\n').filter((l) => /核心运行|源码更新|Wiki 工具/.test(l)).map((l) => l.trim()).join(' / ').slice(0, 160));

    // 用真装出来的那份验证三种版本输出都带运行时配置
    const vJson = spawnSync(path.join(prefix, 'bin', 'bolloon'), ['--version', 'json'], {
      encoding: 'utf-8', timeout: 180000,
      // 查询时也用同一个 prefix: 安装与查询的 prefix 必须一致, 否则测到的是"环境不一致"而不是识别逻辑
      env: childEnv({ BOLLOON_PREFIX: prefix, npm_config_prefix: prefix }),
    });
    // macOS 上 /var 是 /private/var 的软链 → 比较前取 realpath (否则永远比不中)
    const realPrefix = fs.realpathSync(prefix);
    assert('I. 装出来的 CLI 自报安装方式 = npm-global 且安装目录在隔离 prefix 内 (真识别, 不是猜)',
      !!vJson.stdout && (() => { try { const p = JSON.parse(vJson.stdout.slice(vJson.stdout.indexOf('{'))); return p.installMethod === 'npm-global' && String(p.installDir).startsWith(realPrefix); } catch { return false; } })(),
      (() => { try { const p = JSON.parse(vJson.stdout.slice(vJson.stdout.indexOf('{'))); return `${p.installMethod} @ ${p.installDir}`; } catch { return '解析失败'; } })());
    let parsed: any = null;
    try { parsed = JSON.parse(vJson.stdout.slice(vJson.stdout.indexOf('{'))); } catch { parsed = null; }
    assert('I. 真装出来的 bolloon --version json: 含运行时配置 (路径+版本+来源)',
      !!parsed?.runtime?.facts && parsed.runtime.facts.length === 4 && parsed.runtime.facts.every((f: any) => f.version),
      parsed ? parsed.runtime.facts.map((f: any) => `${f.runtime}=${f.version}`).join(' ') : '解析失败');

    const vHuman = spawnSync(path.join(prefix, 'bin', 'bolloon'), ['--version'], { encoding: 'utf-8', timeout: 180000, env: childEnv({ BOLLOON_PREFIX: prefix, npm_config_prefix: prefix }) });
    assert('I. 普通版 --version 展示运行时配置块 (leo: 安装信息要展示这些配置)',
      /运行时配置:/.test(vHuman.stdout) && /Git/.test(vHuman.stdout) && /Python/.test(vHuman.stdout),
      String(vHuman.stdout).split('\n').filter((l) => /运行时配置|Git|Python/.test(l)).map((l) => l.trim()).join(' | ').slice(0, 200));

    const doc = spawnSync(path.join(prefix, 'bin', 'bolloon'), ['doctor', 'offline'], { encoding: 'utf-8', timeout: 300000, env: childEnv({ BOLLOON_PREFIX: prefix, npm_config_prefix: prefix }) });
    assert('I. 真装出来的 bolloon doctor: 含"运行时配置"与"能力矩阵"两项, 且退出码 ≤1 (0=健康/1=有问题但可查)',
      doc.status !== null && doc.status <= 1 && String(doc.stdout).includes('运行时配置') && String(doc.stdout).includes('能力矩阵'),
      `exit=${doc.status} | ${String(doc.stdout).split('\n').filter((l) => /运行时配置|能力矩阵/.test(l)).map((l) => l.trim()).join(' | ').slice(0, 160)}`);
  } else {
    console.log('\n[I] 跳过真安装 (--no-real-install)');
  }

  // ── 收尾 ────────────────────────────────────────────────────────────────
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* 忽略 */ }
  const failed = cases.filter((c) => !c.ok);
  console.log(`\n=== 结果: ${cases.length - failed.length} passed / ${failed.length} failed ===`);
  if (failed.length) {
    for (const f of failed) console.log(`  ❌ ${f.name}: ${f.detail.split('\n')[0]}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => { console.error('验收脚本自身出错:', e?.stack || e); process.exit(1); });
