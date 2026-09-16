/**
 * run-store.ts — 持久化 run harness (2026-09-16)
 *
 * 问题 (leo 2026-09-16): web / cli 页面只是**单次执行** —— 一条消息进来跑一遍 agent 循环,
 * 跑完就没了。进程重载 / 刷新页面 / 崩一次, 这次运行的全部状态 (做了什么、做到哪、为什么停)
 * 都不留痕, 也没有任何常驻闸门约束它 (现有 reactHarness 只在单次 prompt 内存里活着)。
 *
 * 这一层补的就是"持久化 + 约束":
 *   ① 每次 agent 运行 = 一条落盘记录 ~/.bolloon/runs/<runId>.json (跨进程/跨重载可读)
 *   ② 每次工具调用追加一步 (原子写: 临时文件 + rename), 崩了也能看到做到哪一步
 *   ③ 预算闸门: maxSteps / deadlineMs 到点必须**如实**结束 (failed/aborted), 不许静默算完成
 *   ④ 孤儿对账: 进程启动时把 pid 已死的 running 记录改判 interrupted (不假装还在跑)
 *   ⑤ 失速巡检: 常驻巡检把长时间没更新的 running 标 stalled (给 UI/CLI 一个诚实的说法)
 *
 * 记录是**事实**层: 只写实际发生的步骤与结果, 不写"预期/希望"。
 */

import * as fs from 'fs/promises';
import * as fssync from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

export type RunSurface = 'cli' | 'web' | 'mobile' | 'cron' | 'delegate';

/**
 * 统一运行状态 (2026-09-16 Phase 0, 对齐 Durable Pi Agent Runtime 协议):
 *   queued 排队 → running 执行 → done 完成 / failed 失败 / aborted 主动中止
 *   recovering 恢复中 · paused 暂停 · awaiting_external 等外部 · needs_human 等人
 *   interrupted 进程中断 (对账判的) · stalled 失速 (巡检判的)
 */
export type RunStatus =
  | 'queued'
  | 'running'
  | 'recovering'
  | 'paused'
  | 'awaiting_external'
  | 'done'
  | 'failed'
  | 'aborted'
  | 'interrupted'
  | 'stalled'
  | 'needs_human';

/** 合法状态迁移 (协议的一部分: 非法迁移一律拒绝, 防止"偷偷回到 running"这类假状态) */
export const RUN_TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  queued: ['running', 'aborted', 'interrupted'],
  running: ['recovering', 'paused', 'awaiting_external', 'done', 'failed', 'aborted', 'interrupted', 'stalled', 'needs_human'],
  recovering: ['running', 'failed', 'aborted', 'needs_human', 'interrupted', 'stalled'],
  paused: ['running', 'aborted', 'interrupted'],
  awaiting_external: ['running', 'failed', 'aborted', 'interrupted', 'stalled'],
  done: [],
  failed: [],
  aborted: [],
  interrupted: ['recovering', 'aborted'],   // 允许"从 checkpoint 恢复"
  stalled: ['recovering', 'aborted', 'needs_human'],
  needs_human: ['running', 'aborted'],
};

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  if (from === to) return true;
  return (RUN_TRANSITIONS[from] || []).includes(to);
}

/** 错误分类 → 默认恢复动作 (Phase 3 协议表; 只是**决策记录**, 执行在 Recovery Engine) */
export type ErrorClass =
  | 'transient'        // 网络抖动 / 429 / 5xx → 指数退避重试
  | 'auth'             // 鉴权失败 → 不重试, 交人 (needs_human)
  | 'bad_args'         // 工具参数错 → 修正重试一次
  | 'no_such_tool'     // 工具不存在/能力不匹配 → 换工具或重规划
  | 'policy_denied'    // 权限/安全 gate 拒绝 → 不重试, 走策略分支
  | 'external_no_reply'// 外部节点无响应 → awaiting_external
  | 'unparsable'       // 模型输出不可解析 → 重提示一次再暂停
  | 'repeat_failure'   // 重复失败 → 熔断 needs_human
  | 'crash'            // 进程崩溃 → 从最近 checkpoint 恢复
  | 'corrupt_state'    // 状态文件损坏 → 用最后有效 checkpoint + 记数据修复事件
  | 'unknown';

/** 每次恢复必须留下的记录 (Phase 3: 分类/次数/策略/前后 checkpoint/是否改计划/是否成功) */
export interface RecoveryAttempt {
  ts: string;
  errorClass: ErrorClass;
  message: string;
  action: 'retry' | 'backoff' | 'resume' | 'fallback' | 'pause' | 'escalate' | 'fail' | 'none';
  attempt: number;
  checkpointBefore?: number;
  checkpointAfter?: number;
  changedPlan?: boolean;
  recovered?: boolean;
}

export interface RunStep {
  n: number;
  ts: string;
  tool: string;
  /** 参数摘要 (截断 + 去换行), 只做定位用, 不留敏感全文 */
  argsDigest?: string;
  ok: boolean;
  ms?: number;
  summary?: string;
  error?: string;
}

export interface RunCheckpoint {
  /** 已完成动作数 (步号) */
  completedActions: number;
  /** 正在做的那一步 */
  pendingAction?: string;
  /** 下一步该做什么 (恢复时的入口) */
  nextAction?: string;
  /** 上下文引用 (session key / channel / 文件路径等) */
  contextRef?: string;
  ts: string;
}

export interface RunRecord {
  runId: string;
  /** Phase 2: 与 Goal 强绑定 (Goal 不因一次 prompt 结束而消失) */
  goalId?: string;
  surface: RunSurface;
  goal: string;
  channelId?: string;
  agentId?: string;
  sessionKey?: string;
  pid: number;
  host: string;
  startedAt: string;
  updatedAt: string;
  status: RunStatus;
  steps: RunStep[];
  /** 约束: 到点必须如实结束 */
  budget: { maxSteps: number; deadlineMs: number };
  /** 最近一次 checkpoint (恢复入口) */
  checkpoint?: RunCheckpoint;
  /** Phase 3: 每次恢复尝试的留痕 */
  recovery: RecoveryAttempt[];
  summary?: string;
  error?: string;
  errorClass?: ErrorClass;
  evidence?: string[];
}

export interface HarnessConfig {
  /** 单次运行最多工具步数 */
  maxSteps: number;
  /** 单次运行最长墙钟时间 (ms) */
  deadlineMs: number;
  /** running 超过这个时间没更新 → 判失速 (ms) */
  staleMs: number;
}

const DEFAULT_HARNESS: HarnessConfig = {
  maxSteps: Number(process.env.BOLLOON_RUN_MAX_STEPS || 60),
  deadlineMs: Number(process.env.BOLLOON_RUN_DEADLINE_MS || 30 * 60_000),
  staleMs: Number(process.env.BOLLOON_RUN_STALE_MS || 120_000),
};

export function runsDir(): string {
  return path.join(os.homedir(), '.bolloon', 'runs');
}

/** 单次运行的预算 (可从 ~/.bolloon/harness.json 覆盖) */
export async function readHarnessConfig(): Promise<HarnessConfig> {
  try {
    const raw = await fs.readFile(path.join(os.homedir(), '.bolloon', 'harness.json'), 'utf8');
    const j = JSON.parse(raw);
    return {
      maxSteps: Number(j.maxSteps) > 0 ? Number(j.maxSteps) : DEFAULT_HARNESS.maxSteps,
      deadlineMs: Number(j.deadlineMs) > 0 ? Number(j.deadlineMs) : DEFAULT_HARNESS.deadlineMs,
      staleMs: Number(j.staleMs) > 0 ? Number(j.staleMs) : DEFAULT_HARNESS.staleMs,
    };
  } catch {
    return { ...DEFAULT_HARNESS };
  }
}

function runPath(runId: string): string {
  return path.join(runsDir(), `${runId}.json`);
}

/** 原子写: 先写 .tmp 再 rename, 避免读到半截文件 */
async function writeRun(rec: RunRecord): Promise<void> {
  await fs.mkdir(runsDir(), { recursive: true });
  const p = runPath(rec.runId);
  const tmp = `${p}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(rec, null, 2), 'utf8');
  await fs.rename(tmp, p);
}

export async function readRun(runId: string): Promise<RunRecord | null> {
  try {
    return JSON.parse(await fs.readFile(runPath(runId), 'utf8')) as RunRecord;
  } catch {
    return null;
  }
}

export async function listRuns(opts: { status?: RunStatus | RunStatus[]; limit?: number } = {}): Promise<RunRecord[]> {
  let files: string[] = [];
  try { files = await fs.readdir(runsDir()); } catch { return []; }
  const out: RunRecord[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const r = await readRun(f.replace(/\.json$/, ''));
    if (!r) continue;
    if (opts.status) {
      const want = Array.isArray(opts.status) ? opts.status : [opts.status];
      if (!want.includes(r.status)) continue;
    }
    out.push(r);
  }
  out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  return typeof opts.limit === 'number' ? out.slice(0, opts.limit) : out;
}

export interface StartRunOptions {
  surface: RunSurface;
  goal: string;
  goalId?: string;
  channelId?: string;
  agentId?: string;
  sessionKey?: string;
}

export async function startRun(opts: StartRunOptions): Promise<RunRecord> {
  const cfg = await readHarnessConfig();
  const now = new Date().toISOString();
  const rec: RunRecord = {
    runId: `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
    goalId: opts.goalId,
    surface: opts.surface,
    goal: String(opts.goal || '').slice(0, 500),
    channelId: opts.channelId,
    agentId: opts.agentId,
    sessionKey: opts.sessionKey,
    pid: process.pid,
    host: os.hostname(),
    startedAt: now,
    updatedAt: now,
    status: 'running',
    steps: [],
    budget: { maxSteps: cfg.maxSteps, deadlineMs: cfg.deadlineMs },
    recovery: [],
  };
  await writeRun(rec);
  return rec;
}

/** 错误分类 (Phase 3 表): 决定默认恢复动作, 是"决策的事实"而不是猜测 */
export function classifyError(message: string): ErrorClass {
  const m = String(message || '').toLowerCase();
  // 注意顺序: "无响应/504" 属外部等待 (awaiting_external), 不能先被 transient 吃掉
  if (/(external|no reply|无响应|对端|peer.*no|504)/.test(m)) return 'external_no_reply';
  if (/(401|403|402|unauthori[sz]ed|invalid api key|authentication fails|permission denied|鉴权|api.?key)/.test(m)) return 'auth';
  if (/(429|rate limit|timeout|timed out|econnreset|etimedout|temporarily|503|502|网络|抖动)/.test(m)) return 'transient';
  if (/(invalid argument|缺少参数|bad args|参数)/.test(m)) return 'bad_args';
  if (/(no such tool|unknown tool|not found|能力不匹配|no-capability-match)/.test(m)) return 'no_such_tool';
  if (/(denied|拒绝|blocked|denylist|policy|gate)/.test(m)) return 'policy_denied';
  if (/(unparsable|parse|解析失败|no tool call)/.test(m)) return 'unparsable';
  return 'unknown';
}

/** 状态迁移 (带校验): 非法迁移直接拒绝, 避免"偷偷回到 running"这种假状态 */
export async function setRunStatus(
  runId: string,
  to: RunStatus,
  patch: Partial<Pick<RunRecord, 'summary' | 'error' | 'evidence' | 'errorClass'>> = {},
): Promise<{ ok: boolean; reason?: string; record?: RunRecord }> {
  const rec = await readRun(runId);
  if (!rec) return { ok: false, reason: `run 不存在: ${runId}` };
  if (!canTransition(rec.status, to)) {
    return { ok: false, reason: `非法状态迁移 ${rec.status} → ${to}` };
  }
  rec.status = to;
  if (patch.summary) rec.summary = String(patch.summary).replace(/\s+/g, ' ').slice(0, 800);
  if (patch.error) {
    rec.error = String(patch.error).replace(/\s+/g, ' ').slice(0, 400);
    rec.errorClass = patch.errorClass || classifyError(patch.error);
  }
  if (patch.evidence) rec.evidence = patch.evidence.slice(0, 20);
  rec.updatedAt = new Date().toISOString();
  await writeRun(rec);
  return { ok: true, record: rec };
}

/** 写 checkpoint (恢复入口: 做到哪、下一步是什么) */
export async function saveCheckpoint(
  runId: string,
  cp: Omit<RunCheckpoint, 'ts'>,
): Promise<RunRecord | null> {
  const rec = await readRun(runId);
  if (!rec) return null;
  rec.checkpoint = { ...cp, ts: new Date().toISOString() };
  rec.updatedAt = new Date().toISOString();
  await writeRun(rec);
  return rec;
}

/** 记一次恢复尝试 (Phase 3: 分类/策略/前后 checkpoint/是否改计划/是否恢复) */
export async function recordRecovery(
  runId: string,
  attempt: Omit<RecoveryAttempt, 'ts' | 'attempt'> & { attempt?: number },
): Promise<RunRecord | null> {
  const rec = await readRun(runId);
  if (!rec) return null;
  rec.recovery = rec.recovery || [];
  rec.recovery.push({
    ts: new Date().toISOString(),
    attempt: attempt.attempt ?? rec.recovery.length + 1,
    ...attempt,
  } as RecoveryAttempt);
  rec.updatedAt = new Date().toISOString();
  await writeRun(rec);
  return rec;
}

/** 防止"同一个工具 + 同一组参数"无限重试: 返回该指纹最近的连续失败次数 */
export function repeatedFailureCount(rec: RunRecord, tool: string, argsDigest?: string): number {
  let n = 0;
  for (let i = rec.steps.length - 1; i >= 0; i--) {
    const s = rec.steps[i];
    if (s.tool !== tool) break;
    if (argsDigest && s.argsDigest && s.argsDigest !== argsDigest) break;
    if (s.ok) break;
    n++;
  }
  return n;
}

function digest(v: unknown): string {
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return String(s || '').replace(/\s+/g, ' ').slice(0, 160);
  } catch {
    return '';
  }
}

/** 追加一步 (工具调用后立即落盘) —— 崩在这里也能看到做到哪一步 */
export async function recordStep(runId: string, step: { tool: string; ok: boolean; ms?: number; args?: unknown; summary?: string; error?: string }): Promise<RunRecord | null> {
  const rec = await readRun(runId);
  if (!rec) return null;
  rec.steps.push({
    n: rec.steps.length + 1,
    ts: new Date().toISOString(),
    tool: step.tool,
    argsDigest: step.args === undefined ? undefined : digest(step.args),
    ok: step.ok,
    ms: step.ms,
    summary: step.summary ? String(step.summary).replace(/\s+/g, ' ').slice(0, 200) : undefined,
    error: step.error ? String(step.error).replace(/\s+/g, ' ').slice(0, 200) : undefined,
  });
  rec.updatedAt = new Date().toISOString();
  // 每步自动写 checkpoint (恢复入口: 做到哪一步 + 下一步从哪接)
  rec.checkpoint = {
    completedActions: rec.steps.length,
    pendingAction: step.tool,
    nextAction: '由这一步的结果决定 (恢复时先读最近一步的 summary/error)',
    contextRef: rec.sessionKey || rec.channelId || rec.agentId,
    ts: rec.updatedAt,
  };
  await writeRun(rec);
  return rec;
}

export async function finishRun(
  runId: string,
  patch: { status: Exclude<RunStatus, 'running'>; summary?: string; error?: string; evidence?: string[] },
): Promise<RunRecord | null> {
  const rec = await readRun(runId);
  if (!rec) return null;
  if (!canTransition(rec.status, patch.status)) return null;   // 非法迁移拒绝 (协议约束)
  rec.status = patch.status;
  rec.summary = patch.summary ? String(patch.summary).replace(/\s+/g, ' ').slice(0, 800) : rec.summary;
  if (patch.error) {
    rec.error = String(patch.error).replace(/\s+/g, ' ').slice(0, 400);
    rec.errorClass = classifyError(patch.error);
  }
  if (patch.evidence) rec.evidence = patch.evidence.slice(0, 20);
  rec.updatedAt = new Date().toISOString();
  await writeRun(rec);
  return rec;
}

/** 预算闸门: 超了必须如实结束 (调用方负责把结论写回去) */
export function budgetVerdict(rec: RunRecord, now = Date.now()): { exceeded: boolean; reason?: string } {
  if (rec.steps.length >= rec.budget.maxSteps) {
    return { exceeded: true, reason: `步数预算用尽 (${rec.steps.length}/${rec.budget.maxSteps})` };
  }
  const elapsed = now - Date.parse(rec.startedAt);
  if (elapsed > rec.budget.deadlineMs) {
    return { exceeded: true, reason: `时间预算用尽 (${Math.round(elapsed / 1000)}s/${Math.round(rec.budget.deadlineMs / 1000)}s)` };
  }
  return { exceeded: false };
}

function pidAlive(pid: number): boolean {
  if (!pid || pid === process.pid) return pid === process.pid;
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; }
}

/**
 * 孤儿对账: 启动时把 pid 已死的 running 记录改判 interrupted。
 * 不做这一层的话, 重载后 UI/CLI 会显示"还在跑"的幽灵运行 —— 那是最典型的假状态。
 */
export async function reconcileOrphans(): Promise<{ interrupted: string[]; stillRunning: string[] }> {
  const running = await listRuns({ status: 'running' });
  const interrupted: string[] = [];
  const stillRunning: string[] = [];
  for (const r of running) {
    if (pidAlive(r.pid)) { stillRunning.push(r.runId); continue; }
    await finishRun(r.runId, {
      status: 'interrupted',
      error: `进程 ${r.pid} 已不在 (刷新/重载/崩溃); 运行到此中断`,
    });
    interrupted.push(r.runId);
  }
  return { interrupted, stillRunning };
}

/**
 * 失速巡检: running 且 updatedAt 超过 staleMs 没动 → 标 stalled。
 * 只标状态不改步骤 (事实层): 让 UI 能说"这个运行卡住了", 而不是永远转圈。
 */
export async function superviseRuns(now = Date.now()): Promise<{ stalled: string[] }> {
  const cfg = await readHarnessConfig();
  const running = await listRuns({ status: 'running' });
  const stalled: string[] = [];
  for (const r of running) {
    if (!pidAlive(r.pid)) continue; // 交给 reconcileOrphans
    if (now - Date.parse(r.updatedAt) > cfg.staleMs) {
      await finishRun(r.runId, {
        status: 'stalled',
        error: `超过 ${Math.round(cfg.staleMs / 1000)}s 没有新进展 (可能是工具卡住或模型长时间无响应)`,
      });
      stalled.push(r.runId);
    }
  }
  return { stalled };
}

/** 给 CLI / GUI 的一行摘要 */
export function formatRunLine(r: RunRecord): string {
  const ago = Math.max(0, Math.round((Date.now() - Date.parse(r.updatedAt)) / 1000));
  const age = ago < 60 ? `${ago}s 前` : ago < 3600 ? `${Math.round(ago / 60)}m 前` : `${Math.round(ago / 3600)}h 前`;
  return `${r.runId}  [${r.surface}] ${r.status.padEnd(11)} steps=${String(r.steps.length).padStart(2)}  ${age}  ${r.goal.slice(0, 48)}`;
}

/** 测试用: 同步读 (避免 vitest 里额外的 await 噪音) */
export function readRunSync(runId: string): RunRecord | null {
  try {
    return JSON.parse(fssync.readFileSync(runPath(runId), 'utf8')) as RunRecord;
  } catch {
    return null;
  }
}
