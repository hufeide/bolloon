/**
 * trace-export.ts — 智能体**工具执行轨迹**的导出/解析 (2026-09-18)
 *
 * 定位: Run 的 steps[] 就是这台机器上真实发生过的工具调用事实
 *   (n / ts / tool / argsDigest / ok / ms / summary / error)。
 * 这一层只做一件事: 把这份事实变成**可读、可交换、可再解析**的文本/JSON,
 * 好让 App、CLI、Web 与外部工具(如小红书小工具)看到同一份轨迹。
 *
 * 文本格式 (小工具侧解析器依赖, 改前先看 minitools/agent-card/src/assets/app.js 的 parseTraceText):
 *   # Bolloon 执行轨迹 · run <runId> (<N> 步)
 *   1. [ok] 2026-09-18T08:46:15.093Z shell_exec — ls -la /tmp (12ms)
 *   2. [fail] 2026-09-18T08:46:17.001Z write_file — EACCES: permission denied (3ms)
 *   规则: "<n>. [ok|fail] <无空格时间戳> <工具名> — <细节>" —— 时间戳与工具名不能含空格。
 */

import type { RunRecord, RunStep } from './run-store.js';

export const TRACE_HEADER_PREFIX = '# Bolloon 执行轨迹';

export interface TraceStep {
  n: number;
  ts: string;
  tool: string;
  ok: boolean;
  ms?: number;
  summary?: string;
  error?: string;
  argsDigest?: string;
}

export interface TraceJson {
  schema: 'bolloon-agent-trace/1';
  runId: string;
  goalId?: string;
  surface?: string;
  status: string;
  goal?: string;
  startedAt?: string;
  updatedAt?: string;
  steps: TraceStep[];
  counts: { total: number; ok: number; fail: number; totalMs: number };
  tools: { tool: string; count: number; fail: number }[];
  evidence?: string[];
  error?: string;
}

function stepDetail(s: RunStep): string {
  const base = String(s.summary || s.error || (s.ok ? '完成' : '失败')).replace(/\s+/g, ' ').trim();
  const ms = s.ms ? ` (${s.ms}ms)` : '';
  const args = s.argsDigest ? ` [args:${String(s.argsDigest).slice(0, 8)}]` : '';
  return `${base}${args}${ms}`.slice(0, 400);
}

/** Run → 轨迹 JSON (机器可读; 所有消费方都应基于这个结构, 而不是各自解析文本) */
export function runToTraceJson(run: RunRecord): TraceJson {
  const steps: TraceStep[] = (run.steps || []).map((s) => ({
    n: s.n,
    ts: s.ts,
    tool: s.tool,
    ok: !!s.ok,
    ms: s.ms,
    summary: s.summary,
    error: s.error,
    argsDigest: s.argsDigest,
  }));
  const ok = steps.filter((s) => s.ok).length;
  const byTool = new Map<string, { tool: string; count: number; fail: number }>();
  for (const s of steps) {
    const cur = byTool.get(s.tool) || { tool: s.tool, count: 0, fail: 0 };
    cur.count += 1;
    if (!s.ok) cur.fail += 1;
    byTool.set(s.tool, cur);
  }
  return {
    schema: 'bolloon-agent-trace/1',
    runId: run.runId,
    goalId: run.goalId,
    surface: run.surface,
    status: run.status,
    goal: run.goal,
    startedAt: (run as any).startedAt || (run.steps || [])[0]?.ts,
    updatedAt: run.updatedAt,
    steps,
    counts: { total: steps.length, ok, fail: steps.length - ok, totalMs: steps.reduce((a, s) => a + (s.ms || 0), 0) },
    tools: Array.from(byTool.values()).sort((a, b) => b.count - a.count),
    evidence: run.evidence,
    error: run.error,
  };
}

/** Run → 轨迹文本 (人可读 + 可被小工具解析; 供 CLI / 复制粘贴) */
export function runToTraceText(run: RunRecord, opts: { limit?: number } = {}): string {
  const steps = (run.steps || []).slice(opts.limit ? Math.max(0, (run.steps || []).length - opts.limit) : 0);
  const lines: string[] = [];
  lines.push(`${TRACE_HEADER_PREFIX} · run ${run.runId} (${(run.steps || []).length} 步)`);
  if (run.goal) lines.push(`# 目标: ${String(run.goal).replace(/\s+/g, ' ').slice(0, 160)}`);
  lines.push(`# 状态: ${run.status}${run.goalId ? ` · goal ${run.goalId}` : ''}${run.surface ? ` · surface ${run.surface}` : ''}`);
  if (!steps.length) lines.push('# (这次运行没有工具步骤)');
  for (const s of steps) {
    lines.push(`${s.n}. [${s.ok ? 'ok' : 'fail'}] ${s.ts} ${s.tool} — ${stepDetail(s)}`);
  }
  if (run.error) lines.push(`# 结束原因: ${String(run.error).replace(/\s+/g, ' ').slice(0, 200)}`);
  return lines.join('\n');
}

export interface ParsedTrace { header?: string; goal?: string; status?: string; steps: TraceStep[]; errorLine?: string }

/**
 * 解析轨迹文本 (容错: 只认 "<n>. [ok|fail] <ts> <tool> — <detail>" 这一行格式)。
 * 用于: 把别处(小工具/别的机器)的轨迹读回来, 以及本模块的自校验往返。
 */
export function parseTraceText(text: string): ParsedTrace {
  const out: ParsedTrace = { steps: [] };
  const lines = String(text || '').split('\n');
  const re = /^\s*(\d+)\.\s*\[(ok|fail)\]\s*(\S+)\s+(\S+)\s*(?:—\s*)?([\s\S]*)$/;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith(TRACE_HEADER_PREFIX)) { out.header = line; continue; }
    if (line.startsWith('# 目标:')) { out.goal = line.slice(5).trim(); continue; }
    if (line.startsWith('# 状态:')) { out.status = line.slice(5).trim(); continue; }
    if (line.startsWith('# 结束原因:')) { out.errorLine = line.slice(7).trim(); continue; }
    if (!line.trim() || line.startsWith('#')) continue;
    const m = re.exec(line);
    if (!m) continue;
    const detail = String(m[5] || '');
    const msMatch = /\s*\((\d+)ms\)\s*$/.exec(detail);
    out.steps.push({
      n: Number(m[1]),
      ok: m[2] === 'ok',
      ts: m[3],
      tool: m[4],
      ms: msMatch ? Number(msMatch[1]) : undefined,
      summary: msMatch ? detail.slice(0, msMatch.index).trim() : detail.trim(),
    });
  }
  return out;
}

/** 一行摘要 (CLI 列表/日志用) */
export function summarizeTrace(run: RunRecord): string {
  const j = runToTraceJson(run);
  const tools = j.tools.slice(0, 3).map((t) => `${t.tool}×${t.count}`).join(' ');
  return `${j.counts.total} 步 (✓${j.counts.ok}/✗${j.counts.fail}, ${j.counts.totalMs}ms)${tools ? ` · ${tools}` : ''}`;
}
