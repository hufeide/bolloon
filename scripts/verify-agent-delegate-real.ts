/**
 * verify-agent-delegate-real.ts — 被委派端「真执行」闭环验证 (2026-09-15)
 *
 * 背景: agent_delegate 的处理此前是占位 —— 匹配到 agent 就回 `resultCid: mock-<ts>` +
 * `summary:'已处理任务: <指令前 30 字>'`, 收到委派的一方其实什么都没干 (假签收)。
 * 现在: 严格按 capability + active 匹配 → 宿主注入的真执行器干活 → 结果带真实内容寻址值;
 * 无匹配 / 无执行器 / 执行失败 一律如实 ok:false。
 *
 * 真跑 (不 mock 传输): 进程内两个真 libp2p 节点 (仓库自己的 P2PNetwork) — A 拨 B 建联,
 * 帧走真 `/agent/message` 协议; 两端各起真 express (createAgentDelegateApp),
 * A 用真 HTTP POST /api/agent/delegate 发起, 全链路 = HTTP → 帧 → 真 wire → B 匹配+执行 → 回帧 → HTTP 响应。
 *
 * 用法: npx tsx scripts/verify-agent-delegate-real.ts
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { P2PNetwork } from '../src/network/p2p.js';
import { createAgentDelegateApp, type DelegateTransport } from '../src/web/agent-delegate-server.js';

const tmpRoot = path.join(os.tmpdir(), 'bolloon-delegate-real-' + Date.now());
process.env.HOME = path.join(tmpRoot, 'home');
process.env.USERPROFILE = process.env.HOME;

let passed = 0, failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 用真 libp2p 节点实现 DelegateTransport: sendToNode → 发 'delegate_frame' 并等 'delegate_reply' */
function makeLibp2pTransport(net: P2PNetwork) {
  const pending = new Map<string, (v: string | null) => void>();
  net.onMessage('delegate_reply', (msg) => {
    const text = new TextDecoder().decode(msg);
    const body = text.slice(text.indexOf(':') + 1);            // 去掉 'delegate_reply:' 前缀
    let parsed: any = null;
    try { parsed = JSON.parse(body); } catch { /* 坏包 */ }
    const rid = parsed?._reqId;
    const resolve = rid ? pending.get(rid) : undefined;
    if (resolve && rid) { pending.delete(rid); resolve(String(parsed.raw ?? '')); }
  });
  const transport: DelegateTransport = {
    sendToNode: async (publicKey, frame, timeoutMs = 30000) => {
      const reqId = `r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      return new Promise<string | null>(async (resolve) => {
        const timer = setTimeout(() => { pending.delete(reqId); resolve(null); }, timeoutMs);
        pending.set(reqId, (v) => { clearTimeout(timer); resolve(v); });
        try {
          await net.sendMessage(publicKey, 'delegate_frame', JSON.stringify({ raw: frame, _reqId: reqId }));
        } catch {
          clearTimeout(timer); pending.delete(reqId); resolve(null);
        }
      });
    },
    onIncomingFrame: (handler) => { (transport as any)._handler = handler; },
  };
  return { transport, getHandler: () => (transport as any)._handler as ((from: string, frame: string) => Promise<string | null>) | undefined };
}

/** 把 app 注册进 transport 的 handler 接到真 libp2p 入站帧上, 并把返回值发回对端 */
function wireInbound(net: P2PNetwork, transport: { getHandler: () => any }) {
  net.onMessage('delegate_frame', async (msg, from) => {
    const text = new TextDecoder().decode(msg);
    const body = text.slice(text.indexOf(':') + 1);
    let parsed: any = null;
    try { parsed = JSON.parse(body); } catch { return; }
    const handler = transport.getHandler();
    if (!handler) return;
    const reply = await handler(from, String(parsed.raw ?? '')).catch(() => null);
    if (reply) {
      await net.sendMessage(from, 'delegate_reply', JSON.stringify({ raw: reply, _reqId: parsed._reqId })).catch(() => {});
    }
  });
}

async function listenApp(app: any, port: number): Promise<void> {
  await new Promise<void>((resolve) => { app.listen(port, () => resolve()); });
  await sleep(120);
}

async function main() {
  await fs.mkdir(process.env.HOME as string, { recursive: true });
  console.log('=== 被委派端「真执行」闭环验证 (真 libp2p 传输 + 真 HTTP) ===\n');

  // ---------- [1] 两个真节点 + 真连接 ----------
  const netA = new P2PNetwork();
  const netB = new P2PNetwork();
  const nodeA = await netA.createNode({ enableRelay: false, enableRelayServer: false, enableAutoNat: false, enableUPnP: false });
  const nodeB = await netB.createNode({ enableRelay: false, enableRelayServer: false, enableAutoNat: false, enableUPnP: false });
  console.log(`[1] 真 libp2p: A=${nodeA.peerId.slice(0, 12)}… B=${nodeB.peerId.slice(0, 12)}…`);
  const bWs = nodeB.multiaddrs.find((a) => a.includes('/ws')) || nodeB.multiaddrs[0];
  const { multiaddr } = await import('@multiformats/multiaddr');
  await (netA as any).node.dial(multiaddr(bWs));
  await sleep(900);
  check('A 已连上 B (真 libp2p 连接)', netA.getConnectedPeers().some((p) => p.peerId === nodeB.peerId), JSON.stringify(netA.getConnectedPeers()).slice(0, 160));

  // ---------- [2] B 侧真 app (真执行器) ----------
  const tB = makeLibp2pTransport(netB);
  let executorCalls = 0;
  const appB = createAgentDelegateApp(tB.transport, {
    execute: async (req) => {
      executorCalls++;
      const product = `已按能力 ${req.capability} 完成: ${req.instruction} [产物 ${req.instruction.length} 字节输入]`;
      const cid = 'sha256-' + crypto.createHash('sha256').update(product).digest('hex').slice(0, 32);
      return { ok: true, summary: product, resultCid: cid };
    },
  });
  wireInbound(netB, tB);
  const PB = 54211;
  await listenApp(appB, PB);
  // B 通过真 HTTP 声明自己的能力 (文档 §3)
  const regRes = await fetch(`http://127.0.0.1:${PB}/api/agent/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ownerName: 'node-B', ownerPublicKey: 'did:key:nodeB', agents: [
      { id: 'b-writer', name: 'B 写作 agent', capabilities: ['writing'], status: 'active' },
      { id: 'b-idle', name: 'B 空闲 agent', capabilities: ['writing'], status: 'idle' },
    ] }),
  });
  check('B 真 HTTP POST /api/agent/register 200', regRes.status === 200, `status=${regRes.status}`);

  // ---------- [3] A 侧真 app (HTTP /api/agent/delegate → 真 wire → B) ----------
  const tA = makeLibp2pTransport(netA);
  const appA = createAgentDelegateApp(tA.transport, { execute: undefined });
  wireInbound(netA, tA);
  const PA = 54212;
  await listenApp(appA, PA);
  const delegate = async (body: any) => {
    const r = await fetch(`http://127.0.0.1:${PA}/api/agent/delegate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  // 正向: 能力匹配 → 真执行
  const ok = await delegate({ toPublicKey: nodeB.peerId, capability: 'writing', instruction: '写一段 100 字的入网说明简介', fromAgentId: 'a-main' });
  check('正向委派 HTTP 200', ok.status === 200, `status=${ok.status} ${JSON.stringify(ok.body).slice(0, 160)}`);
  const okResp: any = ok.body?.response;
  check('回包 ok=true (真执行, 不是假签收)', okResp?.ok === true, JSON.stringify(okResp || {}).slice(0, 200));
  check('回包 delegatedTo=b-writer (active 那个)', okResp?.delegatedTo === 'b-writer', String(okResp?.delegatedTo));
  check('回包 resultCid 是真实内容寻址值 (不再有 mock- 前缀)', typeof okResp?.resultCid === 'string' && !String(okResp.resultCid).startsWith('mock-'), String(okResp?.resultCid));
  check('resultCid 与产物可复算一致 (sha256 前缀)', (() => {
    const expect = 'sha256-' + crypto.createHash('sha256').update(String(okResp?.summary || '')).digest('hex').slice(0, 32);
    return okResp?.resultCid === expect;
  })(), String(okResp?.resultCid));
  check('B 的执行器真被调用 1 次', executorCalls === 1, `calls=${executorCalls}`);
  check('summary 是真实产物 (含委托指令)', String(okResp?.summary || '').includes('写一段 100 字的入网说明简介'), String(okResp?.summary || '').slice(0, 140));
  check('idle agent 未被选中', !String(okResp?.delegatedTo).includes('b-idle'));

  // 负例 1: 能力不匹配 → 如实失败, 不兜底给任意本地 agent
  const bad = await delegate({ toPublicKey: nodeB.peerId, capability: 'no-such-capability', instruction: '谁来干?', fromAgentId: 'a-main' });
  const badResp: any = bad.body?.response;
  check('能力不匹配 → response.ok=false', badResp?.ok === false, JSON.stringify(badResp || {}).slice(0, 200));
  check('能力不匹配 → error=no-capability-match', badResp?.error === 'no-capability-match', String(badResp?.error));
  check('能力不匹配 → delegatedTo=none (不塞给别的 agent)', badResp?.delegatedTo === 'none', String(badResp?.delegatedTo));
  check('能力不匹配 → 执行器未被多调', executorCalls === 1, `calls=${executorCalls}`);

  // 负例 2: 本节点没接执行器 → 如实报 no-executor (不假签收)
  const tB2 = makeLibp2pTransport(netB);
  const appB2 = createAgentDelegateApp(tB2.transport);   // 无 execute
  wireInbound(netB, tB2);
  const PB2 = 54213;
  await listenApp(appB2, PB2);
  await fetch(`http://127.0.0.1:${PB2}/api/agent/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ownerName: 'node-B2', ownerPublicKey: 'did:key:nodeB2', agents: [
      { id: 'b2-writer', name: 'B2 writer', capabilities: ['writing'], status: 'active' }] }),
  });
  const noExec = await delegate({ toPublicKey: nodeB.peerId, capability: 'writing', instruction: '再写一段', fromAgentId: 'a-main' });
  const noExecResp: any = noExec.body?.response;
  check('无执行器 → ok=false', noExecResp?.ok === false, JSON.stringify(noExecResp || {}).slice(0, 200));
  check('无执行器 → error=no-executor', noExecResp?.error === 'no-executor', String(noExecResp?.error));
  check('无执行器 → 不返回 resultCid (不编造)', noExecResp?.resultCid === undefined, String(noExecResp?.resultCid));

  // ---------- [4] 超时: 对端不回 → 504 (不假装成功) ----------
  const tDead = makeLibp2pTransport(netA);
  void tDead;
  const appA2 = createAgentDelegateApp({
    sendToNode: async () => null,
    onIncomingFrame: () => {},
  });
  const PA2 = 54214;
  await listenApp(appA2, PA2);
  const r504 = await fetch(`http://127.0.0.1:${PA2}/api/agent/delegate`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ toPublicKey: 'nobody', capability: 'writing', instruction: 'x' }),
  });
  check('对端无响应 → HTTP 504 (不假装成功)', r504.status === 504, `status=${r504.status}`);

  console.log(`\n=== 结果: ${passed} passed, ${failed} failed ===`);
  await netA.shutdown().catch(() => {});
  await netB.shutdown().catch(() => {});
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('验证脚本异常:', e); process.exit(1); });
