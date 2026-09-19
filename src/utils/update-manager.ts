/**
 * update-manager.ts — 更新系统的**唯一决策者** (Phase 2/4/5, 2026-09-19)
 *
 * 职责只有三件 (不多做):
 *   ① 识别当前安装 (`detectInstallation`)
 *   ② 查询目标版本 (npm registry, 唯一稳定渠道)
 *   ③ 形成更新计划 (`buildUpdatePlan`) / 执行更新 (`applyUpdate`)
 *
 * 它**不**直接改用户配置, **不**默认自动安装, **不**碰 `~/.bolloon` 的用户数据
 * (goals / runs / transactions / skills / config 一律不动)。
 *
 * 渠道决定 (2026-09-19, 冻结): **npm 是唯一稳定发行渠道**; GitHub 只作为源码与发布记录。
 *   因此安装脚本不再优先查 GitHub Releases, 版本解析也只有一份 (本模块)。
 *
 * 与计划的刻意偏差 (如实记录, 见 docs/wiki/update-protocol.md §5):
 *   "安装到临时位置 → 原子切换" 落成 **"临时位置下载并校验 tarball → 交给 npm 完成替换 → 验证可启动 → 失败回滚"**。
 *   理由: 手工把整棵 node_modules (949 个包) 复制/切换一遍, 比 npm 自己的替换更危险也更容易半更新;
 *   真正要保的性质 ("不能删掉旧版本后才发现新版本起不来") 由**切换后验证 + 失败回滚**保证, 这两步是真跑的。
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as https from 'https';
import * as http from 'http';
import { spawnSync, execFileSync } from 'child_process';
import {
  PKG_NAME, CONSTRAINT_PKG_NAME, NPM_REGISTRY_BASE, resolveUpdateChannel, distTagForChannel,
  detectInstallation, collectVersionInfo, readPackageAt, packageRootFrom, npmGlobalRoot,
  type InstallMethod, type UpdateSource, type UpdateChannel, type InstallationInfo, type VersionUpdateSummary,
} from './version-info.js';
import {
  type CheckStatus, type UpdateRunStatus, type UpdateRecord, type UpdatePrefs, type UpdateState,
  readUpdateState, writeUpdateState, appendUpdateHistory, readUpdateHistory,
  acquireUpdateLock, releaseUpdateLock, readUpdateLock, lockIsStale, readUpdatePrefs,
} from './update-state.js';

export type { CheckStatus, UpdateRunStatus, UpdateRecord, UpdatePrefs, UpdateState };

// ── 版本比较 (唯一一份) ─────────────────────────────────────────────────────

/**
 * 从子进程 stdout 里取 JSON —— **不要**按"行首是否 { "过滤:
 * `JSON.stringify(x, null, 2)` 是**多行**的, 只留第一行 `{` 会解析失败
 * (真跑抓到过: 更新后验证永远判失败 → 每次都"回滚").
 */
export function parseJsonFromStdout(stdout: string): any | null {
  const s = String(stdout || '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  try {
    return JSON.parse(s.slice(start));
  } catch {
    // 尾部可能有非 JSON 输出: 退一步只取到最后一个 }
    const end = s.lastIndexOf('}');
    if (end > start) {
      try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
    }
    return null;
  }
}

export function parseVersion(v: string): number[] {
  const clean = String(v || '').trim().replace(/^v/, '').split('-')[0];
  const parts = clean.split('.').map((p) => parseInt(p.replace(/\D.*$/, ''), 10));
  return parts.map((n) => (Number.isFinite(n) ? n : 0));
}

/** -1 = a<b, 0 = 相等, 1 = a>b (只比数值段, 忽略预发布标签) */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseVersion(a); const pb = parseVersion(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0; const y = pb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

export function isKnownVersion(v: string | null | undefined): boolean {
  return !!v && v !== 'unknown' && /^\d/.test(String(v).trim().replace(/^v/, ''));
}

// ── registry 查询 (错误分类是本模块的核心价值之一) ──────────────────────────

export interface RegistryDoc { latest: string; distTags: Record<string, string>; versions: string[]; gitHeads: Record<string, string> }
export type RegistryResult =
  | { ok: true; doc: RegistryDoc }
  | { ok: false; kind: 'offline' | 'registry_unavailable'; detail: string };

function httpGetJson(url: string, timeoutMs = 10000): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: timeoutMs, headers: { Accept: 'application/json' } }, (res: any) => {
      let data = '';
      res.on('data', (c: any) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
  });
}

const OFFLINE_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EAI_FAIL', 'UND_ERR_CONNECT_TIMEOUT']);

/** 网络类错误 → offline; 其它 (HTTP 5xx / 解析失败 / 包不存在) → registry_unavailable。 */
export function classifyRegistryError(err: any, httpStatus?: number): { kind: 'offline' | 'registry_unavailable'; detail: string } {
  const code = String(err?.code || '');
  if (OFFLINE_CODES.has(code) || /timeout|timed out|ENOTFOUND|getaddrinfo|network|socket hang up|超时/i.test(String(err?.message || ''))) {
    return { kind: 'offline', detail: `${code || err?.message || '网络不可达'}` };
  }
  if (httpStatus && httpStatus >= 500) return { kind: 'registry_unavailable', detail: `registry 返回 HTTP ${httpStatus}` };
  if (httpStatus === 404) return { kind: 'registry_unavailable', detail: `registry 上没有 ${PKG_NAME} (HTTP 404)` };
  if (httpStatus && httpStatus >= 400) return { kind: 'registry_unavailable', detail: `registry 返回 HTTP ${httpStatus}` };
  return { kind: 'registry_unavailable', detail: code || err?.message || '未知错误' };
}

export async function queryRegistryDoc(pkg: string = PKG_NAME, timeoutMs = 10000): Promise<RegistryResult> {
  const url = `${NPM_REGISTRY_BASE}/${encodeURIComponent(pkg).replace('%40', '@')}`;
  try {
    const { status, body } = await httpGetJson(url, timeoutMs);
    if (status < 200 || status >= 300) return { ok: false, ...classifyRegistryError(null, status) };
    let raw: any;
    try {
      raw = JSON.parse(body);
    } catch (e: any) {
      return { ok: false, kind: 'registry_unavailable', detail: 'registry 返回了无法解析的内容' };
    }
    const distTags = (raw?.['dist-tags'] || {}) as Record<string, string>;
    const versions = Object.keys(raw?.versions || {});
    if (!distTags.latest && versions.length === 0) {
      return { ok: false, kind: 'registry_unavailable', detail: 'registry 上没有可用版本' };
    }
    const gitHeads: Record<string, string> = {};
    for (const v of versions) {
      const gh = raw.versions[v]?.gitHead;
      if (typeof gh === 'string' && gh) gitHeads[v] = gh;
    }
    return { ok: true, doc: { latest: distTags.latest || versions[versions.length - 1], distTags, versions, gitHeads } };
  } catch (e: any) {
    return { ok: false, ...classifyRegistryError(e) };
  }
}

// ── 检查 ────────────────────────────────────────────────────────────────────

export interface CheckResult {
  status: CheckStatus;
  currentVersion: string;
  latestVersion: string | null;
  channel: UpdateChannel;
  source: UpdateSource;
  installMethod: InstallMethod;
  checkedAt: string;
  /** 结论来自缓存 (本次没打网络) */
  fromCache: boolean;
  /** 缓存里那条结论 (status='check_skipped' 时才有意义) */
  cachedStatus?: CheckStatus | null;
  /** 非致命附加说明 (unsupported_installation 时说明为什么) */
  reason?: string;
  /** 目标版本在 registry 上真实存在 + 当前版本在 registry 上存在 (回滚可行性) */
  targetPublished?: boolean;
  rollbackSupported?: boolean;
}

export interface CheckOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** 忽略节流 */
  force?: boolean;
  /** 完全不打网络 (用缓存/状态) */
  offline?: boolean;
  /** 覆盖更新通道 */
  channel?: string;
  /** 覆盖安装识别 (测试) */
  installation?: InstallationInfo;
  /** 注入 registry 结果 (测试) */
  registry?: RegistryResult;
  /** 不写状态 (测试 / 只读命令) */
  persist?: boolean;
}

/**
 * 检查更新。**这是唯一的检查入口** —— CLI / 启动后台 / Python 检查器 / 安装脚本都走它。
 *
 * 结论优先级 (刻意定死, 防"模糊行为"):
 *   1. 读不到本地版本               → local_version_unknown (绝不默认 0.0.0 后继续)
 *   2. 安装方式不支持自动更新       → unsupported_installation (仍会带出 latestVersion)
 *   3. 显式跳过 / 节流              → check_skipped (结论来自缓存)
 *   4. 网络不可达                   → offline  (绝不显示"已是最新")
 *   5. registry 不可用 / 包不存在   → registry_unavailable
 *   6. latest > current             → update_available
 *   7. 否则                         → up_to_date
 */
export async function checkForUpdate(opts: CheckOptions = {}): Promise<CheckResult> {
  const home = opts.home ?? (await import('../setup/setup-store.js')).resolveBolloonHome();
  const prefs = await readUpdatePrefs({ home, env: opts.env });
  const channel = resolveUpdateChannel(opts.channel || prefs.channel);
  const install = opts.installation || detectInstallation({ home });
  const pkg = readPackageAt(install.packageRoot);
  const current = isKnownVersion(pkg?.version) ? String(pkg?.version) : 'unknown';
  const now = new Date().toISOString();
  const state = await readUpdateState(home);
  const persist = opts.persist !== false;

  const base = {
    currentVersion: current,
    channel,
    source: install.updateSource,
    installMethod: install.method,
    checkedAt: now,
    fromCache: false,
  } as const;

  const commit = async (r: CheckResult): Promise<CheckResult> => {
    if (persist) {
      await writeUpdateState({
        currentVersion: r.currentVersion,
        latestVersion: r.latestVersion,
        channel: r.channel,
        installMethod: r.installMethod,
        installDir: install.installDir,
        entryPath: install.entryPath,
        nodeVersion: process.version.replace(/^v/, ''),
        platform: os.platform(),
        arch: os.arch(),
        lastCheckAt: r.checkedAt,
        lastCheckStatus: r.status,
        lastCheckReason: r.reason,
      }, home);
    }
    return r;
  };

  // 1. 本地版本读不到 —— 不猜
  if (!isKnownVersion(current)) {
    return commit({ ...base, status: 'local_version_unknown', latestVersion: null, reason: `读不到 ${install.packageRoot}/package.json 的版本` });
  }

  // 3. 显式跳过 / 节流
  const throttled = !opts.force && state.lastCheckAt
    ? (Date.now() - Date.parse(state.lastCheckAt)) < prefs.checkIntervalHours * 3600_000
    : false;
  const useCache = !!opts.offline || throttled;

  if (useCache && state.lastCheckStatus) {
    // 语义: 本次**没有真的检查** → 结论就是 check_skipped, 上次的结论原样带出来
    // (绝不把缓存里的 update_available/up_to_date 冒充成"刚查出来的")
    const cached = state.lastCheckStatus;
    const r = await commit({
      ...base, fromCache: true,
      status: 'check_skipped',
      cachedStatus: cached,
      latestVersion: state.latestVersion,
      reason: opts.offline
        ? `离线模式: 使用缓存结论 (${cached})`
        : `距上次检查不足 ${prefs.checkIntervalHours}h, 使用缓存结论 (${cached})`,
      checkedAt: state.lastCheckAt || now,
    });
    if (persist) await writeUpdateState({ lastCheckReason: r.reason }, home);
    return r;
  }

  // 2. 安装方式不支持自动更新 —— 仍把 latest / 可回滚性带出来, 但结论就是"不支持"
  const registry = opts.registry || await queryRegistryDoc(PKG_NAME);
  const latest = registry.ok ? (registry.doc.distTags[distTagForChannel(channel)] || registry.doc.latest) : null;
  const targetPublishedOf = (v: string | null | undefined): boolean | undefined =>
    v && registry.ok ? registry.doc.versions.includes(v) : undefined;
  const rollbackSupportedOf = registry.ok ? registry.doc.versions.includes(current) : undefined;

  if (install.method === 'development' || install.method === 'unknown' || install.method === 'release-binary') {
    return commit({
      ...base, status: 'unsupported_installation', latestVersion: latest,
      reason: `${install.reason}; 这种安装方式不支持自动更新`,
      targetPublished: targetPublishedOf(latest),
      rollbackSupported: rollbackSupportedOf,
    });
  }

  // 4/5. registry 拿不到 —— 绝不显示"已是最新"
  if (!registry.ok) {
    return commit({
      ...base,
      status: registry.kind === 'offline' ? 'offline' : 'registry_unavailable',
      latestVersion: null,
      reason: registry.detail,
    });
  }

  const targetPublished = !!latest && registry.doc.versions.includes(latest);
  const rollbackSupported = rollbackSupportedOf === true;

  // 6/7. 比较
  if (latest && compareVersions(current, latest) < 0) {
    return commit({
      ...base, status: 'update_available', latestVersion: latest, targetPublished, rollbackSupported,
      reason: `当前 ${current} → 目标 ${latest}`,
    });
  }

  return commit({ ...base, status: 'up_to_date', latestVersion: latest, targetPublished, rollbackSupported });
}

// ── 计划 ────────────────────────────────────────────────────────────────────

export interface RiskCheck {
  id: string;
  label: string;
  ok: boolean;
  /** 阻塞 = 不能更新; 非阻塞 = 只是提醒/建议延迟 */
  blocking: boolean;
  detail: string;
  /** 需要人工看一眼的信号 (Supervisor/Goal/支付) */
  advisory?: boolean;
}

export interface UpdatePlan {
  ok: boolean;
  currentVersion: string;
  targetVersion: string | null;
  channel: UpdateChannel;
  installMethod: InstallMethod;
  source: UpdateSource;
  installDir: string;
  needsRestart: boolean;
  willUpdate: string[];
  willNotTouch: string[];
  risk: RiskCheck[];
  blockers: string[];
  advisories: string[];
  strategies: ('now' | 'wait' | 'cancel')[];
  defaultStrategy: 'now' | 'wait';
  check: CheckResult;
}

const WILL_NOT_TOUCH = [
  '~/.bolloon/config.json',
  '~/.bolloon/goals/',
  '~/.bolloon/runs/',
  '~/.bolloon/transactions/',
  '~/.bolloon/skills/',
  '~/.bolloon/sessions/',
  '~/.bolloon/identity/',
];

/** 磁盘余量 (字节)。statfs 不可用时返回 null (不假装知道)。 */
export function freeBytesAt(dir: string): number | null {
  try {
    const st: any = (fs as any).statfsSync?.(dir);
    if (!st) return null;
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}

export const MIN_FREE_BYTES = 300 * 1024 * 1024;

/** 安装类风险: 与"机器上有没有在跑的任务"无关, 任何计划都要评估 (测试也不许跳过)。 */
async function collectInstallRisk(install: InstallationInfo): Promise<RiskCheck[]> {
  const out: RiskCheck[] = [];

  out.push({
    id: 'install_method', label: '安装方式支持自动更新', ok: install.method === 'npm-global', blocking: true,
    detail: install.method === 'npm-global'
      ? `npm 全局安装 (${install.installDir})`
      : `${install.method}: ${install.reason} (请用对应方式更新: git pull + npm run build:all / 项目的包管理)`,
  });

  out.push({
    id: 'install_dir_writable', label: '安装目录可写', ok: install.writable, blocking: true,
    detail: install.writable ? install.installDir : `${install.installDir} 不可写 (需要 sudo 或改 npm prefix)`,
  });

  const free = freeBytesAt(install.installDir);
  out.push({
    id: 'disk_space', label: '磁盘空间充足', ok: free === null ? true : free >= MIN_FREE_BYTES,
    blocking: free === null ? false : free < MIN_FREE_BYTES,
    detail: free === null ? '无法读取磁盘余量 (跳过)' : `${(free / 1024 / 1024 / 1024).toFixed(2)} GiB 可用 (需 ≥ ${(MIN_FREE_BYTES / 1024 / 1024).toFixed(0)} MiB)`,
  });

  const lock = readUpdateLock();
  out.push({
    id: 'update_lock', label: '没有其它更新进程', ok: !lock || lockIsStale(lock), blocking: !!lock && !lockIsStale(lock),
    detail: !lock ? '无更新锁'
      : lockIsStale(lock) ? `存在陈旧锁 (pid ${lock.pid}, ${lock.at}) — 可回收`
        : `另一个更新进程持有锁 (pid ${lock.pid}, ${lock.at})`,
  });

  return out;
}

/** 负载类风险: Supervisor / Goal / Run / 支付 (非阻塞提醒, 但会把默认策略变成"等 Run 结束")。 */
async function collectWorkloadRisk(): Promise<RiskCheck[]> {
  const out: RiskCheck[] = [];
  try {
    const { supervisorStatePath } = await import('../agents/supervisor-host.js');
    let sup: any = null;
    try { sup = JSON.parse(await fsp.readFile(supervisorStatePath(), 'utf8')); } catch { sup = null; }
    const alive = sup && typeof sup.pid === 'number' ? (() => { try { process.kill(sup.pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; } })() : false;
    const running = !!sup && alive && !sup.stoppedAt;
    out.push({
      id: 'supervisor_running', label: 'Supervisor 未在运行', ok: !running, blocking: false, advisory: true,
      detail: running ? `Supervisor 正在运行 (pid ${sup.pid}, owner ${sup.owner}, 最近 tick ${sup.lastTickAt || '未知'})` : '无运行中的 Supervisor 宿主',
    });
  } catch {
    out.push({ id: 'supervisor_running', label: 'Supervisor 未在运行', ok: true, blocking: false, advisory: true, detail: '无法读取 supervisor.json (按未运行处理)' });
  }

  try {
    const { listGoals } = await import('../agents/goal-store.js');
    const goals = await listGoals({ status: ['open', 'active', 'recovering', 'retry_wait', 'awaiting_external', 'stalled'], limit: 50 });
    out.push({
      id: 'active_goals', label: '没有进行中的 Goal', ok: goals.length === 0, blocking: false, advisory: true,
      detail: goals.length === 0 ? '无进行中 Goal' : `${goals.length} 个未收尾 Goal (${goals.slice(0, 3).map((g: any) => `${g.goalId}:${g.status}`).join(', ')}${goals.length > 3 ? ', …' : ''})`,
    });
  } catch {
    out.push({ id: 'active_goals', label: '没有进行中的 Goal', ok: true, blocking: false, advisory: true, detail: '无法读取 goals (按无处理)' });
  }

  try {
    const { listRuns } = await import('../agents/run-store.js');
    const runs = await listRuns({ status: ['queued', 'running', 'recovering', 'paused', 'awaiting_external', 'interrupted', 'stalled'], limit: 50 });
    out.push({
      id: 'active_runs', label: '没有进行中的 Run', ok: runs.length === 0, blocking: false, advisory: true,
      detail: runs.length === 0 ? '无进行中 Run' : `${runs.length} 个未收尾 Run (${runs.slice(0, 3).map((r: any) => `${r.runId}:${r.status}`).join(', ')}${runs.length > 3 ? ', …' : ''})`,
    });
  } catch {
    out.push({ id: 'active_runs', label: '没有进行中的 Run', ok: true, blocking: false, advisory: true, detail: '无法读取 runs (按无处理)' });
  }

  try {
    const { pendingTransactions } = await import('../agents/x402/transaction-store.js');
    const pend = await pendingTransactions();
    const paying = pend.filter((t: any) => ['paying', 'payment_required'].includes(t.status));
    out.push({
      id: 'payment_in_flight', label: '没有支付中的交易', ok: paying.length === 0, blocking: false, advisory: true,
      detail: paying.length === 0
        ? (pend.length ? `${pend.length} 笔待收尾交易 (无支付中, 可继续)` : '无待收尾交易')
        : `${paying.length} 笔支付中/待付交易 (${paying.slice(0, 3).map((t: any) => t.id || t.transactionId).join(', ')}) — 更新前应先对账`,
    });
  } catch {
    out.push({ id: 'payment_in_flight', label: '没有支付中的交易', ok: true, blocking: false, advisory: true, detail: '无法读取 transactions (按无处理)' });
  }

  return out;
}

export interface PlanOptions extends CheckOptions {
  installation?: InstallationInfo;
  /** 跳过 registry (离线计划: 只显示本地可判定的部分) */
  skipRegistry?: boolean;
  /** 测试注入: 覆盖**负载类**风险探测 (不动真实 supervisor/goals/runs/transactions);
   *  安装类风险 (安装方式/可写/磁盘/锁) 永远真实评估, 不许被注入跳过。 */
  workloadRiskOverride?: RiskCheck[];
}

export async function buildUpdatePlan(opts: PlanOptions = {}): Promise<UpdatePlan> {
  const home = opts.home ?? (await import('../setup/setup-store.js')).resolveBolloonHome();
  const install = opts.installation || detectInstallation({ home });
  const check = await checkForUpdate({ ...opts, home, persist: false, installation: install });

  const risk = [
    ...await collectInstallRisk(install),
    ...(opts.workloadRiskOverride || await collectWorkloadRisk()),
  ];

  // registry 侧风险项来自检查结论
  risk.push({
    id: 'registry_reachable',
    label: 'registry 可达',
    ok: check.status !== 'offline' && check.status !== 'registry_unavailable',
    blocking: check.status === 'offline' || check.status === 'registry_unavailable' || check.status === 'local_version_unknown',
    detail: check.status === 'offline' ? `离线: ${check.reason}`
      : check.status === 'registry_unavailable' ? `registry 不可用: ${check.reason}`
        : 'npm registry 可达',
  });
  risk.push({
    id: 'target_published',
    label: '目标版本真实存在',
    ok: check.targetPublished !== false,
    blocking: !!check.latestVersion && check.targetPublished === false,
    detail: check.targetPublished === false
      ? `registry 上没有 ${PKG_NAME}@${check.latestVersion} — 不执行更新`
      : check.targetPublished === true ? `已确认 ${check.latestVersion} 可下载` : '未检查 (离线)',
  });
  risk.push({
    id: 'rollback_supported',
    label: '当前版本可回滚',
    ok: check.rollbackSupported !== false,
    blocking: false,
    detail: check.rollbackSupported === false
      ? `registry 上找不到当前版本 ${check.currentVersion} — 更新失败将无法用 npm 回滚`
      : check.rollbackSupported === true ? `registry 上存在 ${check.currentVersion} (可回滚)` : '未检查 (离线)',
  });

  const blockers = risk.filter((r) => !r.ok && r.blocking).map((r) => `${r.label}: ${r.detail}`);
  const advisories = risk.filter((r) => !r.ok && !r.blocking).map((r) => `${r.label}: ${r.detail}`);

  const target = check.latestVersion && compareVersions(check.currentVersion, check.latestVersion) < 0
    ? check.latestVersion
    : null;

  return {
    ok: blockers.length === 0 && !!target,
    currentVersion: check.currentVersion,
    targetVersion: target,
    channel: check.channel,
    installMethod: check.installMethod,
    source: check.source,
    installDir: install.installDir,
    needsRestart: !!target,
    willUpdate: target && install.method === 'npm-global' ? [PKG_NAME, CONSTRAINT_PKG_NAME] : [],
    willNotTouch: WILL_NOT_TOUCH,
    risk, blockers, advisories,
    strategies: ['now', 'wait', 'cancel'],
    defaultStrategy: advisories.length > 0 ? 'wait' : 'now',
    check,
  };
}

export function renderUpdatePlan(plan: UpdatePlan): string {
  const L: string[] = [];
  L.push(`当前版本: ${plan.currentVersion}`);
  L.push(`目标版本: ${plan.targetVersion || '(无可用更新)'}`);
  L.push(`安装方式: ${plan.installMethod}`);
  L.push(`更新通道: ${plan.channel} (来源: ${plan.source})`);
  L.push(`安装目录: ${plan.installDir}`);
  L.push('');
  L.push('将更新:');
  if (plan.willUpdate.length === 0) L.push('  (无 — 当前没有可执行的更新)');
  for (const p of plan.willUpdate) L.push(`  ${p}`);
  L.push('');
  L.push('不会修改:');
  for (const p of plan.willNotTouch) L.push(`  ${p}`);
  L.push('');
  L.push(`需要重启: ${plan.needsRestart ? '是' : '否'}`);
  L.push(`风险检查: ${plan.blockers.length === 0 ? '通过' : `未通过 (${plan.blockers.length} 项阻塞)`}`);
  for (const r of plan.risk) L.push(`  ${r.ok ? '✓' : r.blocking ? '✗' : '!'} ${r.label}: ${r.detail}`);
  if (plan.blockers.length) {
    L.push('');
    L.push('阻塞项 (修好才能更新):');
    for (const b of plan.blockers) L.push(`  - ${b}`);
  }
  if (plan.advisories.length) {
    L.push('');
    L.push('提醒 (不阻塞, 但建议先处理):');
    for (const a of plan.advisories) L.push(`  - ${a}`);
    L.push(`  建议策略: 等当前 Run 结束后更新 (bolloon update --now --wait)`);
  }
  L.push('');
  L.push('可选: 立即更新 (bolloon update --now) / 等当前 Run 结束 (bolloon update --now --wait) / 取消');
  L.push(`默认: ${plan.defaultStrategy === 'wait' ? '等待当前 Run 结束后更新' : '立即更新'}`);
  return L.join('\n');
}

// ── 执行 ────────────────────────────────────────────────────────────────────

export type UpdateStage = 'planned' | 'downloading' | 'staged' | 'switching' | 'verifying' | 'succeeded' | 'failed' | 'rolled_back' | 'blocked';

/** 进行中的阶段 (落盘时看到它 = 上次更新被中断; 与 update-state 的 IN_FLIGHT_RUN_STATUSES 同义) */
export const IN_FLIGHT_STAGES: UpdateStage[] = ['planned', 'downloading', 'staged', 'switching', 'verifying'];

export interface ApplyOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  strategy?: 'now' | 'wait';
  /** 强制: 即使有提醒项也继续 (阻塞项仍然阻塞) */
  force?: boolean;
  /** 注入安装命令执行器 (测试) */
  runNpm?: (args: string[], cwd: string) => { code: number; stdout: string; stderr: string };
  /** 注入切换后验证 (测试) */
  verifyInstall?: (target: string, home: string) => Promise<boolean>;
  onStage?: (stage: UpdateStage, detail: string) => void;
  installation?: InstallationInfo;
  registry?: RegistryResult;
  /** 测试注入: 覆盖负载类风险探测 (见 PlanOptions.workloadRiskOverride) */
  workloadRiskOverride?: RiskCheck[];
}

export interface ApplyOutcome {
  stage: UpdateStage;
  /** 失败发生在哪一步 (stage 是最终结果, 例如 failed/rolled_back) */
  failedAt?: UpdateStage;
  ok: boolean;
  from: string;
  to: string;
  durationMs: number;
  reason?: string;
  needsRestart: boolean;
  stagedTarball?: string | null;
  health?: { grade: string; detail: string } | null;
}

/** npm 默认只重试 2 次/10s —— 真网络抖动会让一次干净安装失败 (本机 ECONNRESET 实测)。 */
export const NPM_FETCH_RETRY_FLAGS = [
  '--fetch-retries=5', '--fetch-retry-mintimeout=10000', '--fetch-retry-maxtimeout=120000',
];

function defaultRunNpm(args: string[], cwd: string) {
  const finalArgs = args[0] === 'pack' || args[0] === 'install' ? [...args, ...NPM_FETCH_RETRY_FLAGS] : args;
  const r = spawnSync('npm', finalArgs, { cwd, encoding: 'utf-8', timeout: 900_000, maxBuffer: 32 * 1024 * 1024 });
  return { code: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/** 校验一个解压后的包目录: 版本对得上 + 入口存在。 */
export function validateStagedPackage(dir: string, target: string): { ok: boolean; detail: string } {
  const pkg = readPackageAt(dir);
  if (!pkg) return { ok: false, detail: `${dir}/package.json 读不到` };
  if (pkg.version !== target) return { ok: false, detail: `临时目录版本 ${pkg.version} ≠ 目标 ${target}` };
  const entry = path.join(dir, 'dist', 'cli-entry.js');
  if (!fs.existsSync(entry)) return { ok: false, detail: '包内缺少 dist/cli-entry.js' };
  return { ok: true, detail: `版本 ${pkg.version} + 入口存在` };
}

/** 读"磁盘上真的装了什么版本" (不看进程内存), 供切换后验证。 */
export function installedVersionOnDisk(installRoot: string): string | null {
  return readPackageAt(installRoot)?.version ?? null;
}

/**
 * 执行更新。
 *
 * 流水线: 计划(检查+锁) → 下载 tarball 到临时目录并校验 → 切换(npm 替换) → 验证 → 成功/回滚。
 * 任何一步失败: 清理临时目录、保留旧版本、写失败原因、释放锁、用户继续用旧版本。
 */
export async function applyUpdate(opts: ApplyOptions = {}): Promise<ApplyOutcome> {
  const started = Date.now();
  const home = opts.home ?? (await import('../setup/setup-store.js')).resolveBolloonHome();
  const install = opts.installation || detectInstallation({ home });
  /** 落盘"进行中"的阶段 —— 这样进程被 SIGKILL 时盘上会留下证据 (doctor 报"上次更新异常中断") */
  const markInFlight = async (s: UpdateStage, detail: string) => {
    if (!(IN_FLIGHT_STAGES as string[]).includes(s)) return;
    try {
      await writeUpdateState({
        lastUpdate: { at: new Date().toISOString(), from, to, status: s as UpdateRunStatus, reason: detail },
      }, home);
    } catch { /* 阶段留痕写失败不能影响更新本身 */ }
  };
  /**
   * 报阶段 —— **必须 await**: 先在盘上落下"进行中"的阶段, 再去做那件危险的事
   * (否则进程在写状态之前被杀, 盘上就没有"上次更新中断"的证据)。
   */
  const stage = async (s: UpdateStage, detail: string) => {
    try { opts.onStage?.(s, detail); } catch { /* 回调失败不影响流程 */ }
    await markInFlight(s, detail);
  };

  const plan = await buildUpdatePlan({
    home, env: opts.env, force: true, installation: install, registry: opts.registry,
    workloadRiskOverride: opts.workloadRiskOverride,
  });
  const from = plan.currentVersion;
  const to = plan.targetVersion || plan.currentVersion;


  const record = async (r: ApplyOutcome, historyStatus: UpdateRunStatus) => {
    const rec: UpdateRecord = { at: new Date().toISOString(), from: r.from, to: r.to, status: historyStatus, durationMs: r.durationMs, reason: r.reason };
    // 记账失败**不能**把"更新其实成功了"变成向上抛异常 (真被测试 teardown 竞态抓到过:
    // HOME 在写到一半时消失 → rename ENOENT)。失败就如实记进 reason, 结果照常返回。
    try {
      await appendUpdateHistory(rec, home);
      await writeUpdateState({
        lastUpdate: rec,
        lastFailure: r.ok ? null : { at: rec.at, stage: r.failedAt || r.stage, reason: r.reason || '未知原因' },
        needsRestart: r.ok ? r.needsRestart : false,
        currentVersion: r.from,
      }, home);
    } catch (e: any) {
      const note = `状态记录写入失败: ${e?.message || e}`;
      return { ...r, reason: r.reason ? `${r.reason}; ${note}` : note };
    }
    return r;
  };

  if (!plan.targetVersion) {
    await stage('blocked', '没有可执行的更新');
    return record({ stage: 'blocked', ok: false, from, to, durationMs: Date.now() - started, reason: plan.blockers[0] || '已是最新, 无需更新', needsRestart: false }, 'blocked');
  }

  if (plan.blockers.length > 0) {
    await stage('blocked', plan.blockers.join('; '));
    return record({ stage: 'blocked', ok: false, from, to, durationMs: Date.now() - started, reason: `阻塞: ${plan.blockers.join('; ')}`, needsRestart: false }, 'blocked');
  }

  if (opts.strategy === 'wait' && plan.advisories.length > 0) {
    await stage('blocked', '按策略等待当前 Run 结束');
    const reason = `等待当前 Run 结束后更新 (${plan.advisories.length} 项提醒); 待收尾后重新执行 bolloon update --now`;
    await appendUpdateHistory({ at: new Date().toISOString(), from, to, status: 'planned', reason }, home);
    return { stage: 'blocked', ok: false, from, to, durationMs: Date.now() - started, reason, needsRestart: false };
  }

  // 锁 (第二个进程不许同时更新)
  const lock = await acquireUpdateLock({ home, reason: `${from} → ${to}` });
  if (!lock.ok) {
    const held = lock.heldBy;
    await stage('blocked', `已有更新进程 (pid ${held?.pid})`);
    return record({ stage: 'blocked', ok: false, from, to, durationMs: Date.now() - started, reason: `已有更新进程持有锁 (pid ${held?.pid}, ${held?.at})`, needsRestart: false }, 'blocked');
  }

  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'bolloon-update-'));
  const runNpm = opts.runNpm || defaultRunNpm;
  let stagedTarball: string | null = null;

  try {
    // 1. 下载 tarball 到临时目录 (不动现有安装)
    await stage('downloading', `npm pack ${PKG_NAME}@${to}`);
    const packed = runNpm(['pack', `${PKG_NAME}@${to}`, '--pack-destination', tmpRoot, '--loglevel=error'], tmpRoot);
    if (packed.code !== 0) {
      throw Object.assign(new Error(`下载 ${PKG_NAME}@${to} 失败: ${(packed.stderr || packed.stdout).trim().slice(0, 400)}`), { stage: 'downloading' as UpdateStage });
    }
    const tarballs = (await fsp.readdir(tmpRoot)).filter((f) => f.endsWith('.tgz'));
    if (tarballs.length === 0) throw Object.assign(new Error('npm pack 没有产出 tarball'), { stage: 'downloading' as UpdateStage });
    stagedTarball = path.join(tmpRoot, tarballs[0]);

    // 2. 解压 + 校验包内容 (版本 + 入口)
    await stage('staged', `解压并校验 ${path.basename(stagedTarball)}`);
    const extractDir = path.join(tmpRoot, 'extract');
    await fsp.mkdir(extractDir, { recursive: true });
    const tar = spawnSync('tar', ['-xzf', stagedTarball, '-C', extractDir], { encoding: 'utf-8', timeout: 120_000 });
    if (tar.status !== 0) throw Object.assign(new Error(`解压失败: ${(tar.stderr || '').slice(0, 300)}`), { stage: 'staged' as UpdateStage });
    const stagedCheck = validateStagedPackage(path.join(extractDir, 'package'), to);
    if (!stagedCheck.ok) throw Object.assign(new Error(`目标包校验失败: ${stagedCheck.detail}`), { stage: 'staged' as UpdateStage });

    // 3. 切换 (npm 完成替换; 旧版本在替换成功前不会消失)
    await stage('switching', `npm install -g ${PKG_NAME}@${to}`);
    const installed = runNpm(['install', '-g', `${PKG_NAME}@${to}`, '--no-fund', '--no-audit', '--loglevel=error'], os.tmpdir());
    if (installed.code !== 0) {
      throw Object.assign(new Error(`npm 安装失败: ${(installed.stderr || installed.stdout).trim().slice(0, 400)}`), { stage: 'switching' as UpdateStage });
    }

    // 4. 验证: 磁盘版本 + 新入口真能启动 + 健康检查
    await stage('verifying', '核对磁盘版本并试启新入口');
    const verify = opts.verifyInstall || defaultVerifyInstall;
    const ok = await verify(to, home);
    if (!ok) throw Object.assign(new Error(`切换后验证失败: 新版本 ${to} 未能正确启动`), { stage: 'verifying' as UpdateStage });

    await stage('succeeded', `已更新到 ${to}`);
    const out: ApplyOutcome = {
      stage: 'succeeded', ok: true, from, to, durationMs: Date.now() - started, needsRestart: true, stagedTarball,
    };
    await record(out, 'succeeded');
    return out;
  } catch (e: any) {
    const failureStage: UpdateStage = (e?.stage as UpdateStage) || 'failed';
    const reason: string = e?.message || String(e);
    await stage(failureStage, reason);

    // 失败处理: 保留旧版本 → 能回滚就回滚 → 写原因 → 释放锁
    let finalStage: UpdateStage = 'failed';
    let finalReason = reason;
    try {
      const nowVersion = installedVersionOnDisk(install.packageRoot);
      if (install.method === 'npm-global' && nowVersion && nowVersion !== from && nowVersion !== to) {
        await stage('rolled_back', `检测到半更新 (磁盘版本 ${nowVersion}), 回滚到 ${from}`);
        const rb = runNpm(['install', '-g', `${PKG_NAME}@${from}`, '--no-fund', '--no-audit', '--loglevel=error'], os.tmpdir());
        const after = installedVersionOnDisk(install.packageRoot);
        if (rb.code === 0 && after === from) {
          finalStage = 'rolled_back';
          finalReason = `${reason}; 已回滚到 ${from}`;
        } else {
          finalReason = `${reason}; 回滚也未成功 (磁盘版本 ${after || 'unknown'}) — 请手动: npm install -g ${PKG_NAME}@${from}`;
        }
      } else if (nowVersion === to && failureStage === 'verifying') {
        // 装上了但验证没过: 保留新版本但如实报失败, 并给出回滚指令
        finalReason = `${reason}; 磁盘版本已是 ${to}, 如需回退: npm install -g ${PKG_NAME}@${from}`;
      }
    } catch (e2: any) {
      finalReason = `${reason}; 回滚过程出错: ${e2?.message || e2}`;
    }

    const out: ApplyOutcome = {
      stage: finalStage, failedAt: failureStage, ok: false, from, to, durationMs: Date.now() - started,
      reason: finalReason, needsRestart: false, stagedTarball,
    };
    await record(out, finalStage === 'rolled_back' ? 'rolled_back' : 'failed');
    return out;
  } finally {
    // 临时目录清理 (成功/失败都清)
    try { await fsp.rm(tmpRoot, { recursive: true, force: true }); } catch { /* 忽略 */ }
    await releaseUpdateLock(home);
  }
}

async function defaultVerifyInstall(target: string, home: string): Promise<boolean> {
  const install = detectInstallation({ home });
  const onDisk = installedVersionOnDisk(install.packageRoot);
  if (onDisk !== target) return false;
  const entry = path.join(install.packageRoot, 'dist', 'cli-entry.js');
  if (!fs.existsSync(entry)) return false;
  const r = spawnSync(process.execPath, [entry, '--version', '--json'], { encoding: 'utf-8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  if (r.status !== 0) return false;
  const parsed = parseJsonFromStdout(String(r.stdout || ''));
  return parsed?.packageVersion === target;
}

// ── 状态 / 历史 / 摘要 ──────────────────────────────────────────────────────

export interface UpdateStatusReport {
  currentVersion: string;
  latestVersion: string | null;
  channel: string;
  installMethod: string;
  installDir: string;
  entryPath: string;
  lastCheckAt: string | null;
  lastCheckStatus: CheckStatus | null;
  lastCheckReason?: string;
  lastUpdate: UpdateRecord | null;
  lastFailure: { at: string; stage: string; reason: string } | null;
  needsRestart: boolean;
  prefs: UpdatePrefs;
  lock: { pid: number; at: string; by: string; stale: boolean } | null;
}

export async function readUpdateStatus(opts: { home?: string; env?: NodeJS.ProcessEnv } = {}): Promise<UpdateStatusReport> {
  const home = opts.home ?? (await import('../setup/setup-store.js')).resolveBolloonHome();
  const st = await readUpdateState(home);
  const prefs = await readUpdatePrefs({ home, env: opts.env });
  const lock = readUpdateLock(home);
  const install = detectInstallation({ home });
  const pkg = readPackageAt(install.packageRoot);
  return {
    currentVersion: isKnownVersion(pkg?.version) ? String(pkg?.version) : st.currentVersion,
    latestVersion: st.latestVersion,
    channel: prefs.channel,
    installMethod: install.method,
    installDir: install.installDir,
    entryPath: install.entryPath,
    lastCheckAt: st.lastCheckAt,
    lastCheckStatus: st.lastCheckStatus,
    lastCheckReason: st.lastCheckReason,
    lastUpdate: st.lastUpdate,
    lastFailure: st.lastFailure,
    needsRestart: st.needsRestart,
    prefs,
    lock: lock ? { ...lock, stale: lockIsStale(lock) } : null,
  };
}

export async function readHistory(limit = 10, home?: string): Promise<UpdateRecord[]> {
  const h = home ?? (await import('../setup/setup-store.js')).resolveBolloonHome();
  return readUpdateHistory(limit, h);
}

export function renderHistory(records: UpdateRecord[]): string {
  if (records.length === 0) return '没有更新历史记录。';
  const L = ['时间 · 当前版本 → 目标版本 · 结果 · 耗时 · 原因'];
  for (const r of records) {
    const ms = r.durationMs != null ? `${(r.durationMs / 1000).toFixed(1)}s` : '-';
    L.push(`${r.at} · ${r.from} → ${r.to} · ${r.status} · ${ms}${r.reason ? ` · ${r.reason}` : ''}`);
  }
  return L.join('\n');
}

/** 启动后台检查用的摘要 (供 --version 显示)。 */
export async function updateSummaryFor(home?: string): Promise<VersionUpdateSummary> {
  const h = home ?? (await import('../setup/setup-store.js')).resolveBolloonHome();
  const st = await readUpdateState(h);
  return {
    lastCheckAt: st.lastCheckAt,
    lastCheckStatus: st.lastCheckStatus,
    lastCheckReason: st.lastCheckReason,
    latestVersion: st.latestVersion,
    lastUpdate: st.lastUpdate ? { at: st.lastUpdate.at, from: st.lastUpdate.from, to: st.lastUpdate.to, status: st.lastUpdate.status, reason: st.lastUpdate.reason } : null,
    needsRestart: st.needsRestart,
  };
}
