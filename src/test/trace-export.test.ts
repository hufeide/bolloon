/**
 * trace-export / p2p-info 单元测试 (2026-09-18)
 *
 * 覆盖: 轨迹文本格式与往返、JSON 聚合、空轨迹的诚实表达、
 *      P2P 信息的"地址补 /p2p/<peerId>"、拿不到信息时的如实说明、与小工具名片字段对齐。
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runToTraceText, runToTraceJson, parseTraceText, summarizeTrace, TRACE_HEADER_PREFIX } from '../agents/trace-export.js';
import { ensureDialable, formatP2pInfoJson, formatP2pInfoText, getLocalP2pInfo } from '../agents/p2p-info.js';
import type { RunRecord } from '../agents/run-store.js';

const fixture = (over: Partial<RunRecord> = {}): RunRecord => ({
  runId: 'r-demo-1',
  goalId: 'g-demo-1',
  surface: 'cli',
  status: 'done',
  goal: '在本机写一个探针文件并列出目录',
  startedAt: '2026-09-18T08:00:00.000Z',
  updatedAt: '2026-09-18T08:00:05.000Z',
  steps: [
    { n: 1, ts: '2026-09-18T08:00:01.000Z', tool: 'write_file', ok: true, ms: 12, summary: '写入 18 字节', argsDigest: 'a1b2c3d4e5f6' },
    { n: 2, ts: '2026-09-18T08:00:04.000Z', tool: 'shell_exec', ok: false, ms: 3, error: 'EACCES: permission denied', argsDigest: 'ffeeddccbbaa' },
  ],
  evidence: ['probe.txt 存在'],
  ...over,   // 放最后: 覆盖上面的默认值
} as any);

describe('trace-export · 文本轨迹', () => {
  it('表头 + 每步一行, 格式可被解析回来', () => {
    const text = runToTraceText(fixture());
    const lines = text.split('\n');
    expect(lines[0].startsWith(TRACE_HEADER_PREFIX)).toBe(true);
    expect(lines[0]).toContain('(2 步)');
    // 时间戳与工具名都不能含空格 (小工具侧靠空格切分)
    expect(lines.some((l) => /^1\. \[ok\] 2026-09-18T08:00:01\.000Z write_file — /.test(l))).toBe(true);
    expect(lines.some((l) => /^2\. \[fail\] 2026-09-18T08:00:04\.000Z shell_exec — EACCES/.test(l))).toBe(true);
    expect(text).toContain('(12ms)');
    expect(text).toContain('[args:');
  });

  it('往返: 解析回步数/工具/成败/耗时', () => {
    const parsed = parseTraceText(runToTraceText(fixture()));
    expect(parsed.steps.map((s) => s.n)).toEqual([1, 2]);
    expect(parsed.steps.map((s) => s.tool)).toEqual(['write_file', 'shell_exec']);
    expect(parsed.steps.map((s) => s.ok)).toEqual([true, false]);
    expect(parsed.steps[0].ms).toBe(12);
    expect(parsed.goal).toContain('探针文件');
    expect(parsed.status).toContain('done');
  });

  it('空轨迹不假装有步骤', () => {
    const text = runToTraceText(fixture({ steps: [] } as any));
    expect(text).toContain('(0 步)');
    expect(text).toContain('没有工具步骤');
    expect(parseTraceText(text).steps).toHaveLength(0);
  });

  it('双向: 小工具导出的轨迹文本, Bolloon 也能解析回来', () => {
    // 小工具 (minitools/agent-card) 导出格式: 它自己的表头 + 同一步骤行格式
    const fromMini = [
      '# Bolloon 智能体名片 · 执行轨迹 (2 步)',
      '1. [ok] 2026-09-18T08:00:01.000Z 保存P2P — peerId=12D3KooW… 含中继',
      '2. [fail] 2026-09-18T08:00:02.000Z 存相册 — 失败: 未授权',
    ].join('\n');
    const parsed = parseTraceText(fromMini);
    expect(parsed.steps).toHaveLength(2);
    expect(parsed.steps.map((s) => s.tool)).toEqual(['保存P2P', '存相册']);
    expect(parsed.steps.map((s) => s.ok)).toEqual([true, false]);
    expect(parsed.steps[0].ts).toBe('2026-09-18T08:00:01.000Z');
    expect(parsed.steps[1].summary).toContain('未授权');
  });

  it('解析器容错: 垃圾行被忽略, 合法行仍被读出', () => {
    const parsed = parseTraceText(['随便一行', '1. [ok] 2026-09-18T08:00:01.000Z shell_exec — ls', '', '# x'].join('\n'));
    expect(parsed.steps).toHaveLength(1);
    expect(parsed.steps[0].tool).toBe('shell_exec');
  });
});

describe('trace-export · JSON 轨迹', () => {
  it('counts 与 tools 聚合自洽', () => {
    const j = runToTraceJson(fixture());
    expect(j.schema).toBe('bolloon-agent-trace/1');
    expect(j.counts).toEqual({ total: 2, ok: 1, fail: 1, totalMs: 15 });
    expect(j.tools.map((t) => t.tool).sort()).toEqual(['shell_exec', 'write_file']);
    expect(j.tools.find((t) => t.tool === 'shell_exec')?.fail).toBe(1);
  });

  it('一行摘要含步数与成败', () => {
    expect(summarizeTrace(fixture())).toMatch(/2 步 \(✓1\/✗1, 15ms\)/);
  });
});

describe('p2p-info', () => {
  const tmp: string[] = [];
  const withHome = (files: Record<string, unknown>) => {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-p2p-'));
    tmp.push(h);
    fs.mkdirSync(path.join(h, '.bolloon'), { recursive: true });
    for (const [rel, body] of Object.entries(files)) {
      const p = path.join(h, '.bolloon', rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(body));
    }
    return h;
  };
  const oldHome = process.env.HOME;
  afterEach(() => { process.env.HOME = oldHome; for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

  it('地址必须带 /p2p/<peerId> 才叫可拨入', () => {
    expect(ensureDialable('/ip4/1.2.3.4/tcp/4001/ws', '12D3KooWabc')).toBe('/ip4/1.2.3.4/tcp/4001/ws/p2p/12D3KooWabc');
    const already = '/ip4/1.2.3.4/tcp/4001/ws/p2p/12D3KooWabc';
    expect(ensureDialable(already, '12D3KooWabc')).toBe(already);
    expect(ensureDialable('', 'x')).toBe('');
  });

  it('没有落盘记录时: ok=false + 说清下一步 (不编 peerId)', async () => {
    process.env.HOME = withHome({});
    const info = await getLocalP2pInfo();
    expect(info.ok).toBe(false);
    expect(info.peerId).toBeUndefined();
    expect(String(info.note)).toContain('bolloon p2p');
  });

  it('只有 peerId 时: source=persisted 且说明"没有可拨入地址"', async () => {
    process.env.HOME = withHome({ 'gateway-join.json': { did: 'did:key:zDemo', name: '演示', peerId: '12D3KooWDemoNodeAddrAAAA', capabilities: ['chat'], joinedAt: '2026-09-18T00:00:00Z' } });
    const info = await getLocalP2pInfo();
    expect(info.ok).toBe(true);
    expect(info.source).toBe('persisted');
    expect(info.peerId).toBe('12D3KooWDemoNodeAddrAAAA');
    expect(info.capabilities).toEqual(['chat']);
    expect(String(info.note)).toContain('可拨入地址');
  });

  it('JSON 里的 cardP2p 与小工具名片字段对齐', () => {
    const j = JSON.parse(formatP2pInfoJson({
      ok: true, source: 'live', did: 'did:key:zX', name: '小星', peerId: '12D3KooWX',
      multiaddrs: ['/ip4/127.0.0.1/tcp/4001/ws/p2p/12D3KooWX'], relayAddrs: [], isRelay: false,
    }));
    expect(j.schema).toBe('bolloon-p2p-info/1');
    expect(j.cardP2p).toEqual({ peerId: '12D3KooWX', multiaddr: '/ip4/127.0.0.1/tcp/4001/ws/p2p/12D3KooWX', relay: '' });
    expect(formatP2pInfoText({ ok: false, source: 'none', multiaddrs: [], relayAddrs: [], isRelay: false, note: '还没有本机 peerId' }))
      .toContain('说明: 还没有本机 peerId');
  });
});
