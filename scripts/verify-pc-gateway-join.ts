/**
 * verify-pc-gateway-join.ts — PC 端「读入网说明 → 加入全球智能体网络」闭环验证
 *
 * 人类/手机只给一句话: `read https://bolloon.cn/bolloon-gateway-join.md`
 * 智能体应能: ① 读到文档 ② 确保 DID ③ 确保 P2P 节点 ④ 注册本地 manifest
 *            ⑤ 建成可分享的网络(入网态) ⑥ 幂等 ⑦ 重启恢复 ⑧ 不假成功
 *
 * 真跑: 进程内起真 web server (真 HTTP) + 真工具层 (LLM 实际会调的那些工具) + 真文档 URL。
 * 隔离 HOME 到 tmp, 不污染真实 ~/.bolloon。
 *
 * 用法: npx tsx scripts/verify-pc-gateway-join.ts
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

const tmpRoot = path.join(os.tmpdir(), 'bolloon-join-verify-' + Date.now());
process.env.HOME = path.join(tmpRoot, 'home');
process.env.USERPROFILE = process.env.HOME;
process.env.BOLLOON_SKIP_KUBO = '1';
process.env.BOLLOON_CRON = '0';

const DOC_URL = process.env.GATEWAY_JOIN_DOC || 'https://bolloon.cn/bolloon-gateway-join.md';
const PORT = Number(process.env.VERIFY_PORT || 54197);
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function main() {
  await fs.mkdir(process.env.HOME!, { recursive: true });

  console.log('=== PC 端「读入网说明 → 加入全球智能体网络」闭环验证 ===');
  console.log(`文档: ${DOC_URL}`);
  console.log(`隔离 HOME: ${process.env.HOME}\n`);

  const { createWebServer } = await import('../src/web/server.js');
  const { registerBuiltinTools } = await import('../src/agents/pi-sdk-tools.js');

  console.log('[0] 起真 web server (真 HTTP)…');
  const t0 = Date.now();
  const started = await createWebServer(PORT, { selfImprove: false } as any);
  const port = (started as any)?.port || PORT;
  const base = `http://127.0.0.1:${port}`;
  console.log(`    server 就绪: ${base} (${Date.now() - t0}ms)\n`);

  // 真工具层 (LLM 实际会调的那批工具的注册表)
  const tools = new Map<string, any>();
  registerBuiltinTools({
    tools,
    cwd: process.cwd(),
    identity: { did: 'did:blln:verify-pc', name: '验证智能体' },
    persona: null,
    minimaxAvailable: false,
    setPersona: () => {},
    sessionManager: { addFileContext: () => {}, getAllChannels: () => [] },
    constraintLayer: { getLogs: () => [] },
    _inboxMessages: [],
  } as any);

  // ---------- ① 读入网说明 (人类口令里的 "read <url>") ----------
  console.log('[1] 口令 "read <url>" → 工具层能读到文档');
  const readTool = tools.get('read_file');
  check('read_file 工具存在', !!readTool);
  let docText = '';
  if (readTool) {
    const r = await readTool.execute({ path: DOC_URL });
    docText = String(r.output || '');
    check('read_file 接受 http(s) URL 并读回正文', r.success === true && docText.includes('bolloon-gateway-join'), String(r.error || '').slice(0, 140));
    check('读回内容含 frontmatter (SKILL.md 头)', /name:\s*bolloon-gateway-join/.test(docText));
  }

  // ---------- ② 入网 (文档驱动, 单一入口) ----------
  console.log('\n[2] 入网编排 — 一个工具走完 DID/节点/manifest/建网');
  const joinTool = tools.get('join_global_gateway');
  check('join_global_gateway 工具存在 (文档驱动入网入口)', !!joinTool);
  let joinOut = '';
  if (joinTool) {
    const r = await joinTool.execute({ url: DOC_URL });
    joinOut = String(r.output || r.error || '');
    check('join_global_gateway 执行成功', r.success === true, String(r.error || '').slice(0, 200));
    check('输出含 DID 身份', /did:/i.test(joinOut), joinOut.slice(0, 200));
  }

  // ---------- ③ 真 HTTP: 本机 manifest 已注册 ----------
  console.log('\n[3] 真 HTTP 自检 — /api/agent/*');
  let manifest: any = null;
  try {
    const r = await fetch(`${base}/api/agent/local-manifest`);
    manifest = await r.json();
    check('GET /api/agent/local-manifest 200', r.status === 200, `status=${r.status}`);
    check('manifest 含 agents 数组且非空', Array.isArray(manifest?.agents) && manifest.agents.length > 0, JSON.stringify(manifest).slice(0, 160));
    check('manifest.ownerPublicKey 非空', !!manifest?.ownerPublicKey);
  } catch (e: any) {
    check('GET /api/agent/local-manifest 可达', false, String(e?.message).slice(0, 120));
  }

  try {
    const r = await fetch(`${base}/api/agent/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ownerName: 'verify', ownerPublicKey: 'did:blln:verify-pc', agents: [{ id: 'verify-1', name: '验证智能体', capabilities: ['verify'], status: 'active' }] }),
    });
    check('POST /api/agent/register 200 (文档第 3 节要求)', r.status === 200, `status=${r.status}`);
  } catch (e: any) {
    check('POST /api/agent/register 可达', false, String(e?.message).slice(0, 120));
  }

  try {
    // pickAgent 只在对端 (remote) manifest 里挑 — 先让一个对端 manifest 进缓存, 再按能力选
    const { cacheRemoteManifest } = await import('../src/agents/agent-manifest-protocol.js');
    cacheRemoteManifest({ ownerName: 'peer-x', ownerPublicKey: 'did:blln:peer-x', agents: [{ id: 'peer-x-1', name: '对端智能体', capabilities: ['verify'], status: 'active' }] } as any);
    const r = await fetch(`${base}/api/agent/pick`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capability: 'verify' }),
    });
    check('POST /api/agent/pick 能按能力选到对端 agent', r.status === 200, `status=${r.status}`);
  } catch (e: any) {
    check('POST /api/agent/pick 可达', false, String(e?.message).slice(0, 120));
  }

  try {
    // delegate 到不可达对端 → 必须 504 (不许假成功)
    const r = await fetch(`${base}/api/agent/delegate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toPublicKey: 'did:blln:nobody', capability: 'verify', instruction: 'never' }),
    });
    check('POST /api/agent/delegate 对不可达对端 → 504 (不假成功)', r.status === 504, `status=${r.status}`);
  } catch (e: any) {
    check('POST /api/agent/delegate 可达', false, String(e?.message).slice(0, 120));
  }

  // ---------- ④ 真 HTTP: 入网态可见 ----------
  console.log('\n[4] 真 HTTP 自检 — 入网态');
  try {
    const r = await fetch(`${base}/api/gateway/join-global`);
    const j: any = await r.json();
    check('GET /api/gateway/join-global 返回入网态', r.status === 200 && j?.joined === true, JSON.stringify(j).slice(0, 200));
  } catch (e: any) {
    check('GET /api/gateway/join-global 可达', false, String(e?.message).slice(0, 120));
  }

  try {
    const mc: any = await (await fetch(`${base}/api/p2p/mobile-connect`)).json();
    check('P2P 节点有 peerId (节点初始化)', !!mc?.peerId, JSON.stringify(mc).slice(0, 140));
  } catch (e: any) {
    check('GET /api/p2p/mobile-connect 可达', false, String(e?.message).slice(0, 120));
  }

  // ---------- ⑤ 幂等 + ⑥ 重启恢复 ----------
  console.log('\n[5] 幂等 + 重启恢复');
  const { joinGlobalGateway, getGatewayJoinState } = await import('../src/agents/gateway-join.js');
  const again = await joinGlobalGateway({ url: DOC_URL, did: 'did:blln:verify-pc', name: '验证智能体' });
  check('重复入网 → already (不重复建)', again.ok === true && again.already === true, JSON.stringify({ ok: again.ok, already: again.already }).slice(0, 140));
  const state1 = await getGatewayJoinState();
  check('入网状态已落盘 (url + did + ts)', !!state1?.url && !!state1?.did, JSON.stringify(state1).slice(0, 160));
  const { resetAgentRegistry } = await import('../src/agents/agent-registry.js');
  resetAgentRegistry();
  const restored = await getGatewayJoinState();
  check('重启后仍能读到入网态 (持久化)', restored?.url === state1?.url, JSON.stringify(restored).slice(0, 160));

  // ---------- ⑦ 不假成功 ----------
  console.log('\n[6] 假成功防护 (不可达文档 → 必须如实失败)');
  const bad = await joinGlobalGateway({ url: 'https://bolloon.cn/definitely-not-here-404.md', did: 'did:blln:verify-pc' });
  check('读不到文档 → ok=false 且带 error', bad.ok === false && !!bad.error, JSON.stringify(bad).slice(0, 180));
  const bad2 = await joinGlobalGateway({ url: 'https://example.com/not-a-gateway-doc.md', did: 'did:blln:verify-pc' });
  check('非入网说明文档 → 拒绝 (不假装入网)', bad2.ok === false && !!bad2.error, JSON.stringify(bad2).slice(0, 180));

  console.log(`\n=== 结果: ${passed} passed, ${failed} failed ===`);
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('验证脚本异常:', e);
  process.exit(1);
});
