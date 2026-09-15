/**
 * agent-delegate-executor.test.ts — 被委派端「真执行」语义 (2026-09-15)
 *
 * 覆盖 agent-delegate-server 的入站 agent_delegate 处理:
 *   ① 只认 capabilities 含该能力且 status==='active' 的 agent (不兜底给 agents[0]);
 *   ② 匹配到 + 有执行器 → 真调执行器, 用执行器给的 resultCid (不再编 mock-<ts>);
 *   ③ 匹配到 + 无执行器 → ok:false / error:'no-executor' (不假签收);
 *   ④ 执行器抛错 → ok:false / error:'executor-error';
 *   ⑤ 执行超时 → ok:false / error:'executor-timeout' (不返回半截结果)。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createAgentDelegateApp, type DelegateTransport } from '../web/agent-delegate-server.js';
import { setLocalManifest } from '../agents/agent-manifest-protocol.js';

type Handler = (from: string, frame: string) => Promise<string | null>;

function makeApp(options: Parameters<typeof createAgentDelegateApp>[1]) {
  let handler: Handler | undefined;
  const transport: DelegateTransport = {
    sendToNode: async () => null,
    onIncomingFrame: (h) => { handler = h as Handler; },
  };
  const app = createAgentDelegateApp(transport, options);
  return { app, call: (frame: any) => handler!('peer-from', JSON.stringify(frame)) };
}

const delegateFrame = (capability: string, instruction = '干活') => ({
  type: 'agent_delegate',
  payload: { capability, instruction, fromAgentId: 'a-main' },
  ts: Date.now(),
  fromDid: 'did:key:caller',
});

const parse = (reply: string | null) => JSON.parse(String(reply)).payload;

beforeEach(() => {
  setLocalManifest({
    ownerName: 'node-b',
    ownerPublicKey: 'did:key:nodeB',
    agents: [
      { id: 'b-writer', name: 'B writer', capabilities: ['writing'], status: 'active' },
      { id: 'b-idle', name: 'B idle', capabilities: ['writing'], status: 'idle' },
      { id: 'b-other', name: 'B other', capabilities: ['coding'], status: 'active' },
    ],
  });
});

describe('agent_delegate 入站处理 (真执行语义)', () => {
  it('能力匹配 → 真调执行器, 用执行器给的 resultCid', async () => {
    let calls = 0;
    const { call } = makeApp({
      execute: async (req) => {
        calls++;
        expect(req.capability).toBe('writing');
        expect(req.targetAgentId).toBe('b-writer');   // active 那个, 不是 idle
        expect(req.fromPublicKey).toBe('peer-from');
        return { ok: true, summary: `产物: ${req.instruction}`, resultCid: 'bafyREALCID' };
      },
    });
    const p = parse(await call(delegateFrame('writing', '写一段介绍')));
    expect(calls).toBe(1);
    expect(p.ok).toBe(true);
    expect(p.delegatedTo).toBe('b-writer');
    expect(p.resultCid).toBe('bafyREALCID');
    expect(String(p.resultCid).startsWith('mock-')).toBe(false);
    expect(p.summary).toContain('写一段介绍');
  });

  it('能力不匹配 → ok:false / no-capability-match, 且不兜底给其它 agent', async () => {
    let calls = 0;
    const { call } = makeApp({ execute: async () => { calls++; return { ok: true, summary: 'x' }; } });
    const p = parse(await call(delegateFrame('no-such-cap')));
    expect(p.ok).toBe(false);
    expect(p.error).toBe('no-capability-match');
    expect(p.delegatedTo).toBe('none');
    expect(calls).toBe(0);          // 不能把不匹配的活塞给任何 agent
  });

  it('只有 idle agent 匹配 → 也算不匹配 (status 必须 active)', async () => {
    setLocalManifest({
      ownerName: 'node-b', ownerPublicKey: 'did:key:nodeB',
      agents: [{ id: 'b-idle', name: 'B idle', capabilities: ['writing'], status: 'idle' }],
    });
    const { call } = makeApp({ execute: async () => ({ ok: true, summary: 'x' }) });
    const p = parse(await call(delegateFrame('writing')));
    expect(p.ok).toBe(false);
    expect(p.error).toBe('no-capability-match');
  });

  it('匹配到但本节点无执行器 → ok:false / no-executor, 不给 resultCid', async () => {
    const { call } = makeApp({});   // 无 execute
    const p = parse(await call(delegateFrame('writing')));
    expect(p.ok).toBe(false);
    expect(p.error).toBe('no-executor');
    expect(p.delegatedTo).toBe('b-writer');
    expect(p.resultCid).toBeUndefined();
  });

  it('执行器抛错 → ok:false / executor-error (错误如实回传)', async () => {
    const { call } = makeApp({ execute: async () => { throw new Error('boom-42'); } });
    const p = parse(await call(delegateFrame('writing')));
    expect(p.ok).toBe(false);
    expect(p.error).toBe('executor-error');
    expect(String(p.summary)).toContain('boom-42');
  });

  it('执行超时 → ok:false / executor-timeout (不返回半截结果)', async () => {
    const { call } = makeApp({
      executeTimeoutMs: 60,
      execute: async () => { await new Promise((r) => setTimeout(r, 500)); return { ok: true, summary: '太晚了' }; },
    });
    const p = parse(await call(delegateFrame('writing')));
    expect(p.ok).toBe(false);
    expect(p.error).toBe('executor-timeout');
    expect(String(p.summary)).not.toContain('太晚了');
  });
});
