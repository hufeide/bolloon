/**
 * mobile-join-doc.test.ts — 手机端「读入网说明 → 入网」本地执行 (2026-09-15)
 *
 * 背景: 手机端「一键入网」的口令是 `read https://bolloon.cn/bolloon-gateway-join.md`,
 * 但手机侧的本地 agent 此前只会回「已收到: …」的兜底文本 —— 口令在手机上空转。
 * 现在 joinGatewayFromDoc 在手机本地走完: 读说明(校验) → DID → 服务登记 → P2P 公告(尽力) → 落盘。
 *
 * 本测试: 注入 fetch / did / desktopBaseUrl, 用内存 localStorage, 不碰网络。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  detectJoinDocUrl, joinGatewayFromDoc, formatMobileJoinResult, getMobileJoinState,
} from '../web/mobile-agent.js';

const DOC = `---
name: bolloon-gateway-join
description: 把 agent 完整加入 Bolloon 本地优先 P2P 网关
capabilities: [gateway-join]
version: 1.2.0
---

# Bolloon Agent · 加入网关
`;

/** 内存 localStorage (node 环境没有 DOM) */
function installMemoryStorage() {
  const m = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => m.clear(),
  };
  return m;
}

function mockFetch(handler: (url: string, init?: any) => any) {
  return vi.fn(async (url: any, init?: any) => handler(String(url), init)) as unknown as typeof fetch;
}

const okText = (body: string) => ({ ok: true, status: 200, text: async () => body });
const errStatus = (status: number) => ({ ok: false, status, text: async () => '' });

beforeEach(() => { installMemoryStorage(); });

describe('手机端入网口令识别', () => {
  it('从默认 prompt 里取出文档地址', () => {
    expect(detectJoinDocUrl('read https://bolloon.cn/bolloon-gateway-join.md'))
      .toBe('https://bolloon.cn/bolloon-gateway-join.md');
  });

  it('普通消息不误判', () => {
    expect(detectJoinDocUrl('帮我看看这个 https://bolloon.cn/docs.html')).toBeNull();
    expect(detectJoinDocUrl('')).toBeNull();
  });
});

describe('手机端入网执行 (joinGatewayFromDoc)', () => {
  it('文档合法 → 读说明/DID/登记/落盘 全过, 并登记进电脑端 registry', async () => {
    const calls: Array<{ url: string; body?: any }> = [];
    const f = mockFetch((url, init) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
      if (url.endsWith('/bolloon-gateway-join.md')) return okText(DOC);
      if (url.endsWith('/api/registry/register')) return { ok: true, status: 200, json: async () => ({ ok: true }) };
      throw new Error('unexpected url ' + url);
    });
    const r = await joinGatewayFromDoc('https://bolloon.cn/bolloon-gateway-join.md', {
      fetchImpl: f, did: 'did:blln:phone0001', desktopBaseUrl: 'http://127.0.0.1:54188', name: '我的手机智能体',
    });
    expect(r.ok).toBe(true);
    expect(r.docVersion).toBe('1.2.0');
    expect(r.did).toBe('did:blln:phone0001');
    const step = (n: string) => r.steps.find((s) => s.step === n)!;
    expect(step('读入网说明').ok).toBe(true);
    expect(step('DID 身份').ok).toBe(true);
    expect(step('服务登记').ok).toBe(true);
    expect(step('服务登记').note).toContain('电脑端网络 registry');
    expect(step('落盘入网态').ok).toBe(true);
    // 真登记进电脑端 registry (含本机 DID)
    const reg = calls.find((c) => c.url.endsWith('/api/registry/register'));
    expect(reg).toBeTruthy();
    expect(reg!.body.agentId).toBe('did:blln:phone0001');
    expect(reg!.body.capabilities).toContain('gateway-join');
    // 落盘
    const st = await getMobileJoinState();
    expect(st?.did).toBe('did:blln:phone0001');
    expect(st?.url).toContain('bolloon-gateway-join.md');
    // 用户看到的回复
    const text = formatMobileJoinResult(r);
    expect(text).toContain('已加入全球智能体网络');
    expect(text).toContain('did:blln:phone0001');
  });

  it('电脑端不可达 → 仍完成本机入网, 但服务登记如实标失败 (不假装)', async () => {
    const f = mockFetch((url) => {
      if (url.endsWith('.md')) return okText(DOC);
      throw new Error('connect ECONNREFUSED');
    });
    const r = await joinGatewayFromDoc('https://bolloon.cn/bolloon-gateway-join.md', {
      fetchImpl: f, did: 'did:blln:phone0002', desktopBaseUrl: 'http://127.0.0.1:9',
    });
    expect(r.ok).toBe(true);                       // 手机是自治节点: 本机入网完成
    const reg = r.steps.find((s) => s.step === '服务登记')!;
    expect(reg.ok).toBe(false);
    expect(reg.note).toContain('不可达');
  });

  it('文档不可达 → 如实失败', async () => {
    const f = mockFetch(() => errStatus(404));
    const r = await joinGatewayFromDoc('https://bolloon.cn/bolloon-gateway-join.md', { fetchImpl: f, did: 'did:blln:x' });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('404');
    expect(formatMobileJoinResult(r)).toContain('❌');
  });

  it('不是入网说明的文档 → 拒绝据此入网', async () => {
    const f = mockFetch(() => okText('---\nname: something-else\n---\n普通文档'));
    const r = await joinGatewayFromDoc('https://example.com/other.md', { fetchImpl: f, did: 'did:blln:x' });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('不是 Bolloon 网关入网说明');
  });

  it('非 http(s) 地址 → 直接拒绝', async () => {
    const r = await joinGatewayFromDoc('file:///tmp/doc.md', { did: 'did:blln:x' });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('http(s)');
  });

  it('未配置电脑端 → 只在本机登记, 但明确说明', async () => {
    const f = mockFetch((url) => { if (url.endsWith('.md')) return okText(DOC); throw new Error('no'); });
    const r = await joinGatewayFromDoc('https://bolloon.cn/bolloon-gateway-join.md', { fetchImpl: f, did: 'did:blln:phone0003', desktopBaseUrl: '' });
    const reg = r.steps.find((s) => s.step === '服务登记')!;
    expect(reg.ok).toBe(true);
    expect(reg.note).toContain('本机登记');
  });
});
