/**
 * pi-harness.test.ts — 唯一 PiAgentHarness 门面单测 (2026-09-16 Milestone 1-B)
 *
 * 验的就是 leo 的验收重点:
 *   ① 所有工具调用都经过唯一 facade (决策顺序 deny-pipeline → validator → react-harness)
 *   ② 没有 pi-sdk 直连散落 gate (源码级断言: 六层里任何一层都不能被 pi-sdk 直接调用)
 *   ③ 失败分级: 核心约束失效 → 阻止执行 (fail-closed); 策略拒绝 → 返回 agent 可处理的拒绝结果;
 *      观测失败 → 降级留痕不中断; 目标审查失败 → 不许进 done
 *   ④ 事件带 runId / goalId
 *   ⑤ 事件记账失败绝不影响已做出的决策 (记录是账, 不是闸)
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { PiAgentHarness, type HarnessEvent } from '../agents/pi-harness.js';

const ctx = { runId: 'run-1', goalId: 'goal-1', agentId: 'agent-1', channelId: 'ch-1', surface: 'cli' };

function makeHarness(over: {
  deny?: any; pre?: any; reactPre?: any; reactPost?: any; routeHint?: any; events?: any; failClosed?: boolean;
} = {}) {
  const calls: string[] = [];
  const reactHarness: any = {
    onSessionStart: vi.fn(async () => { calls.push('sessionStart'); }),
    onSessionEnd: vi.fn(async () => { calls.push('sessionEnd'); }),
    preToolCall: over.reactPre || vi.fn(async () => { calls.push('react.pre'); return { allowed: true, details: { allowed: true, details: [] } }; }),
    postToolCall: over.reactPost || vi.fn(async () => { calls.push('react.post'); return { allowed: true, details: { allowed: true, details: [] } }; }),
    getLastRouteHint: () => over.routeHint,
    clearRouteHint: vi.fn(),
  };
  const denyPipeline: any = {
    check: over.deny || vi.fn(async () => { calls.push('deny'); return { denied: false }; }),
  };
  const hooks: any = {
    fire: vi.fn(async () => { calls.push('hooks'); return []; }),
    checkToolUse: vi.fn(async () => null),
  };
  const events: HarnessEvent[] = [];
  const preToolUse = over.pre || (async () => { calls.push('validator'); return { allowed: true }; });
  const h = new PiAgentHarness({
    reactHarness, denyPipeline, hooks, preToolUse,
    events: over.events || ((e) => { events.push(e); }),
    failClosed: over.failClosed,
  });
  return { h, events, calls, reactHarness, denyPipeline, hooks };
}

describe('PiAgentHarness — 唯一入口的决策链', () => {
  it('三层都放行 → allow, 且顺序是 deny-pipeline → validator → react-harness', async () => {
    const { h, calls } = makeHarness();
    const d = await h.beforeToolCall({ tool: 'read_file', args: { path: 'a' }, ctx });
    expect(d.allow).toBe(true);
    expect(calls).toEqual(['deny', 'validator', 'react.pre']);
  });

  it('deny-pipeline 拒绝 → source=deny-pipeline, 且不再问后两层 (第一层拒绝即止)', async () => {
    const { h, calls } = makeHarness({
      deny: async () => { calls.push('deny'); return { denied: true, reason: '黑名单', source: 'deny-list' }; },
    });
    const d = await h.beforeToolCall({ tool: 'shell_exec', args: { command: 'x' }, ctx });
    expect(d.allow).toBe(false);
    expect(d.source).toBe('deny-pipeline');
    expect(d.rejectedBy).toBe('deny-list');
    expect(d.reason).toBe('黑名单');
    expect(d.kind).toBe('policy_denied');
    expect(calls).toEqual(['deny']);          // validator / react.pre 没被调用
  });

  it('pre-tool-validator 拒绝 → source=pre-tool-validator', async () => {
    const { h } = makeHarness({ pre: async () => ({ allowed: false, reason: 'rm -rf / 危险' }) });
    const d = await h.beforeToolCall({ tool: 'shell_exec', args: { command: 'rm -rf /' }, ctx });
    expect(d.allow).toBe(false);
    expect(d.source).toBe('pre-tool-validator');
    expect(d.reason).toContain('危险');
  });

  it('react-harness 拒绝 → source=react-harness + 带 gate 名 (rejectedBy)', async () => {
    const { h } = makeHarness({
      reactPre: async () => ({ allowed: false, reason: '注入嫌疑', details: { allowed: false, rejectedBy: 'inject', details: [] } }),
    });
    const d = await h.beforeToolCall({ tool: 'write_file', args: {}, ctx });
    expect(d.allow).toBe(false);
    expect(d.source).toBe('react-harness');
    expect(d.rejectedBy).toBe('inject');
  });

  it('deny-pipeline 的 systemAddition 会透传 (放行时也要注入)', async () => {
    const { h } = makeHarness({ deny: async () => ({ denied: false, systemAddition: '[策略提醒] 别乱删' }) });
    const d = await h.beforeToolCall({ tool: 'read_file', args: {}, ctx });
    expect(d.allow).toBe(true);
    expect(d.systemAddition).toContain('策略别乱删'.replace('策略', ''));  // 只要带上原文
  });
});

describe('失败分级 — 核心约束失效不许 fail-open', () => {
  it('deny-pipeline 抛错 → 阻止执行 (fail-closed), kind=core_constraint', async () => {
    const { h, events } = makeHarness({ deny: async () => { throw new Error('pipeline 内部炸了'); } });
    const d = await h.beforeToolCall({ tool: 'shell_exec', args: { command: 'rm -rf x' }, ctx });
    expect(d.allow).toBe(false);
    expect(d.source).toBe('harness-error');
    expect(d.kind).toBe('core_constraint');
    expect(d.degraded).toBe(true);
    expect(events.some((e) => e.kind === 'error' && e.failureKind === 'core_constraint')).toBe(true);
  });

  it('react-harness 抛错 → 同样阻止执行 (旧行为是放行)', async () => {
    const { h } = makeHarness({ reactPre: async () => { throw new Error('8-gate 挂了'); } });
    const d = await h.beforeToolCall({ tool: 'write_file', args: {}, ctx });
    expect(d.allow).toBe(false);
    expect(d.kind).toBe('core_constraint');
    expect(String(d.reason)).toContain('fail-closed');
  });

  it('显式 failClosed:false 才是旧语义 (放行) — 仅作为可配置逃生门', async () => {
    const { h } = makeHarness({ reactPre: async () => { throw new Error('8-gate 挂了'); }, failClosed: false });
    const d = await h.beforeToolCall({ tool: 'write_file', args: {}, ctx });
    expect(d.allow).toBe(true);
  });

  it('输出 gate 抛错 → 不拦输出 (源头已产生), 但必须记为降级而不是"通过"', async () => {
    const { h, events } = makeHarness({ reactPost: async () => { throw new Error('output gate 挂了'); } });
    const after = await h.afterToolCall({ tool: 'shell_exec', output: 'some output', ctx });
    expect(after.outputBlocked).toBeUndefined();
    expect(after.degraded).toBe(true);
    expect(events.some((e) => e.event === 'afterToolCall' && e.kind === 'degrade')).toBe(true);
  });
});

describe('afterToolCall — 路由 hint + 输出 gate', () => {
  it('routeHint 透传并清理', async () => {
    const { h, reactHarness } = makeHarness({
      routeHint: { reason: '检测到代码任务', systemAddition: '建议先读文件' },
      reactPost: async () => ({ allowed: true, details: { allowed: true, details: [] } }),
    });
    const after = await h.afterToolCall({ tool: 'read_file', output: 'x', ctx });
    expect(after.routeHint?.reason).toBe('检测到代码任务');
    expect(reactHarness.clearRouteHint).toHaveBeenCalled();
  });

  it('输出被 gate 拒 → outputBlocked (调用方据此替换输出)', async () => {
    const { h } = makeHarness({ reactPost: async () => ({ allowed: false, reason: '含 API key', details: { allowed: false, details: [] } }) });
    const after = await h.afterToolCall({ tool: 'shell_exec', output: 'sk-xxx', ctx });
    expect(after.outputBlocked?.reason).toBe('含 API key');
  });
});

describe('目标审查 — 审查失效不许算完成', () => {
  it('正常: 未达上限继续审查, 达上限放行', () => {
    const { h } = makeHarness();
    const first = h.reviewFinal({ reviewsDone: 0, userIntent: '做个网站', completedTools: [] }, 2);
    expect(first.kind).toBe('continue-review');
    const last = h.reviewFinal({ reviewsDone: 2, userIntent: '做个网站', completedTools: [] }, 2);
    expect(last.kind).toBe('finish');
  });

  it('审查器失效 → 按"未确认完成"处理 (不许直接 done)', () => {
    const { h, events } = makeHarness();
    // 用非法入参触发内部异常 (actionLog 非数组 → buildReviewHint 抛)
    const bad: any = { reviewsDone: 0, userIntent: 'x', completedTools: null, actionLog: null };
    const d = h.reviewFinal(bad, 2);
    expect(d.kind).toBe('continue-review');
    expect(String((d as any).hint)).toContain('目标审查降级');
    expect(events.some((e) => e.event === 'review' && e.kind === 'error' && e.failureKind === 'goal_review')).toBe(true);
  });
});

describe('运行身份 + 事件记账', () => {
  it('事件都带 runId / goalId (Milestone 1-B 第 4 条)', async () => {
    const { h, events } = makeHarness();
    await h.sessionStart(ctx);
    await h.beforeToolCall({ tool: 'read_file', args: {}, ctx });
    h.beforeModelCall(ctx);
    await h.afterToolCall({ tool: 'read_file', output: 'ok', ctx });
    await h.sessionEnd(ctx);
    expect(events.length).toBeGreaterThanOrEqual(5);
    for (const e of events) {
      expect(e.runId).toBe('run-1');
      expect(e.goalId).toBe('goal-1');
    }
  });

  it('事件写入抛错不影响决策 (记录是账, 不是闸)', async () => {
    const { h } = makeHarness({ events: () => { throw new Error('写的不是盘'); } });
    const d = await h.beforeToolCall({ tool: 'read_file', args: {}, ctx });
    expect(d.allow).toBe(true);
    await expect(h.sessionStart(ctx)).resolves.toBeUndefined();
  });

  it('模型调用计数 (beforeModelCall/afterModelCall 是活的生命周期点)', () => {
    const { h } = makeHarness();
    expect(h.modelCallCount).toBe(0);
    h.beforeModelCall(ctx);
    h.afterModelCall(ctx, { ms: 12 });
    expect(h.modelCallCount).toBe(1);
  });
});

// ───────────────── 不能绕过 facade (源码级断言, 防回归) ─────────────────
describe('不绕过 facade', () => {
  const piSdk = fs.readFileSync(path.resolve('src/agents/pi-sdk.ts'), 'utf8');

  it('pi-sdk 不再直接调用 reactHarness / deny-pipeline / loop-review 的 gate', () => {
    expect(piSdk).not.toMatch(/this\.reactHarness\.(preToolCall|postToolCall|getLastRouteHint|clearRouteHint)/);
    expect(piSdk).not.toMatch(/this\._denyPipeline\.check\(/);
    expect(piSdk).not.toMatch(/\bdecideAfterReview\(/);
    expect(piSdk).not.toMatch(/\bvalidatePreToolUse\(/);
  });

  it('pi-sdk 的工具前/后与收尾确实走门面', () => {
    expect(piSdk).toMatch(/this\.piHarness\(\)\.beforeToolCall\(/);
    expect(piSdk).toMatch(/this\.piHarness\(\)\.afterToolCall\(/);
    expect(piSdk).toMatch(/this\.piHarness\(\)\.sessionStart\(/);
    expect(piSdk).toMatch(/this\.piHarness\(\)\.sessionEnd\(/);
    expect(piSdk).toMatch(/this\.piHarness\(\)\.reviewFinal\(/);
    expect(piSdk).toMatch(/this\.piHarness\(\)\.beforeModelCall\(/);
    expect(piSdk).toMatch(/this\.piHarness\(\)\.afterModelCall\(/);
  });

  it('那唯一一处对 pre-tool-validator 的引用在门面内部 (注入), 不在调用点', () => {
    // pi-sdk 里出现 onPreToolUse 必须是"构造门面时的注入"这一处
    const hits = piSdk.split('\n').filter((l) => /onPreToolUse\(/.test(l));
    expect(hits.length).toBe(1);
    expect(hits[0]).toContain('preToolUse:');
  });
});
