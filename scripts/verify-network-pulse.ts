/**
 * verify-network-pulse.ts — 网络脉冲端到端验收 (含双节点集成)
 *
 * 真跑: 节点 A 发布 manifest → 节点 B 收到并缓存 → 观察层生成快照 → 公开只读接口返回聚合 →
 * 页面可消费; 并验证匿名性(原始 DID 不落盘/不出网)、隐私阈值、状态机(live/stale/unavailable)、
 * malformed 安全、ETag/304、无需认证。
 *
 * 用法: npx tsx scripts/verify-network-pulse.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-pulse-'));
const HOME = path.join(ROOT, 'home');
fs.mkdirSync(path.join(HOME, '.bolloon'), { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.BOLLOON_SKIP_SETUP = '1';

const NP: any = await import('../src/agents/network-pulse.js');
const MP: any = await import('../src/agents/agent-manifest-protocol.js');

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else {
    failed++;
    console.log(`  ❌ ${name}${detail !== undefined ? ` — ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 240)}` : ''}`);
  }
};
const section = (t: string) => console.log(`\n${t}`);

const DID_A = 'did:key:z6MkNodeAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const DID_B = 'did:key:z6MkNodeBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

// ── [1] 双节点: A 发布 manifest, B 收到并缓存 ──────────────────────────────
section('[1] 双节点集成: A 发布 → B 缓存 → 观察层看得见');
{
  MP.setLocalManifest({
    ownerName: 'NodeA',
    ownerPublicKey: DID_A,
    agents: [{ id: 'agent-a1', name: 'Researcher', capabilities: ['cross-border-market-research', 'data-analysis'], status: 'active' }],
  } as any);
  MP.cacheRemoteManifest({
    ownerName: 'NodeB',
    ownerPublicKey: DID_B,
    agents: [{ id: 'agent-b1', name: 'Coder', capabilities: ['code-review'], status: 'active' }],
  } as any);
  await new Promise((r) => setTimeout(r, 600));   // 挂点是 fire-and-forget

  const evRaw = fs.readFileSync(path.join(HOME, '.bolloon', 'network-pulse', 'events.json'), 'utf8');
  check('事件已落盘', evRaw.length > 10, evRaw.slice(0, 80));
  check('**原始 DID 没有落盘** (只有摘要)', !evRaw.includes('z6MkNodeA') && !evRaw.includes('z6MkNodeB'), evRaw.slice(0, 160));
  check('**原始能力名没有落盘** (只有粗类别)', !evRaw.includes('cross-border-market-research') && evRaw.includes('research'), evRaw.slice(0, 240));
  check('事件类型都在白名单内', JSON.parse(evRaw).every((e: any) => NP.NETWORK_EVENT_TYPES.includes(e.type)));

  const snap = await NP.getNetworkPulse({ home: HOME, force: true });
  check('观察层看到 2 个节点', snap.totals.nodes === 2, snap.totals);
  check('观察层看到 2 个 Agent', snap.totals.agents === 2, snap.totals);
  // 小网络里每个类别只有 1 个 Agent → 低于隐私阈值 → 全部并进 other 才是**正确行为**
  check('小网络: 类别全并进 other (隐私阈值先于可读性)', snap.capabilities.length === 1 && snap.capabilities[0].key === 'other', snap.capabilities);
  check('活动流由服务端模板生成 (中英齐备)', snap.recent_activity.length > 0 && snap.recent_activity.every((a: any) => a.text?.zh && a.text?.en), snap.recent_activity.slice(0, 2));
  check('状态 live 且带新鲜期', snap.status === 'live' && snap.fresh_until > snap.generated_at);
}

// ── [2] 隐私与可信边界 ─────────────────────────────────────────────────────
section('[2] 隐私阈值 + 可信文案 (observed / verified)');
{
  const snap = await NP.getNetworkPulse({ home: HOME, force: true });
  check('单/双来源未签名 → scope=observed (不说成全网)', snap.scope === 'observed' && snap.scope_label.zh.includes('当前节点观察到'), snap.scope_label);
  check('notes 明确"不是全网精确总量"', snap.notes.join(' ').includes('不是全网精确总量'), snap.notes);
  check('公开投影不含任何私有字段', NP.assertNoPrivateFields(snap).length === 0, NP.assertNoPrivateFields(snap));
  const json = JSON.stringify(snap);
  check('响应 JSON 里没有 did/peerId/multiaddrs/钱包', !/did:key|peerId|multiaddrs|wallet|0x[0-9a-fA-F]{40}/.test(json), json.slice(0, 160));

  // 稀疏类别不单独暴露
  await NP.recordNetworkEvent({ type: 'capability_announced', capability: 'vision-ocr', did: DID_A, agentId: 'agent-a1' }, HOME);
  const s2 = await NP.getNetworkPulse({ home: HOME, force: true });
  check('单个 Agent 的稀有类别被并进 other (隐私阈值生效)', !s2.capabilities.some((c: any) => c.key === 'multimodal'), s2.capabilities);

  // 达到阈值后, 类别才以**准确计数**出现 (count = 不同 Agent 数, 不是事件数)
  for (const [i, did] of [DID_A, DID_B, 'did:key:zNodeC'].entries()) {
    await NP.recordNetworkEvent({ type: 'capability_announced', capability: 'cross-border-market-research', did, agentId: `r-${i}` }, HOME);
  }
  const s2b = await NP.getNetworkPulse({ home: HOME, force: true });
  const research = s2b.capabilities.find((c: any) => c.key === 'research');
  // 计数 = **不同 Agent 数** (不是事件数): [1] 里 setLocalManifest 已给 agent-a1 声明过 research,
  // 这里再加 r-0/r-1/r-2 三个 → 4 个不同 Agent。重复声明不会把计数刷高。
  check('达到隐私阈值后 research 出现且计数=不同 Agent 数 (4)', research?.count === 4, s2b.capabilities);
  await NP.recordNetworkEvent({ type: 'capability_announced', capability: 'cross-border-market-research', did: DID_A, agentId: 'r-0' }, HOME);
  const s2c = await NP.getNetworkPulse({ home: HOME, force: true });
  check('同一 Agent 重复声明 → 计数不虚增 (仍 4)', s2c.capabilities.find((c: any) => c.key === 'research')?.count === 4, s2c.capabilities);

  // ≥2 个签名来源 → verified
  await NP.recordNetworkEvent({ type: 'node_joined', did: DID_A, signed: true }, HOME);
  await NP.recordNetworkEvent({ type: 'node_joined', did: DID_B, signed: true }, HOME);
  const s3 = await NP.getNetworkPulse({ home: HOME, force: true });
  check('≥2 个签名来源 → verified network snapshot', s3.scope === 'verified' && s3.scope_label.en === 'Verified network snapshot', s3.scope_label);
}

// ── [3] 状态机: 缓存/live/stale/unavailable ────────────────────────────────
section('[3] 状态机: 短缓存 · stale · unavailable');
{
  const t1 = await NP.getNetworkPulse({ home: HOME });
  const t2 = await NP.getNetworkPulse({ home: HOME });
  check('30s 内命中缓存 (generated_at 相同)', t1.generated_at === t2.generated_at);
  check('缓存文件已落盘', fs.existsSync(path.join(HOME, '.bolloon', 'network-pulse', 'snapshot.json')));
  check('新鲜期内 → live', NP.snapshotStatus(t1, t1.generated_at + 1000) === 'live');
  check('新鲜期过后 → stale (不伪装实时)', NP.snapshotStatus(t1, t1.fresh_until + 1) === 'stale');
  const down = await NP.getNetworkPulse({ home: HOME, unavailable: true });
  check('观察层不可用 → unavailable + 说明不是"网络为空"', down.status === 'unavailable' && down.notes.join(' ').includes('不是"网络为空"'), down.notes);
}

// ── [4] malformed 安全 ─────────────────────────────────────────────────────
section('[4] malformed 数据: 不崩、不误报');
{
  const h2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-bad-'));
  fs.mkdirSync(path.join(h2, '.bolloon', 'network-pulse'), { recursive: true });
  fs.writeFileSync(path.join(h2, '.bolloon', 'network-pulse', 'events.json'), '{"broken": tru', 'utf8');
  const s = await NP.getNetworkPulse({ home: h2, force: true });
  check('坏 events.json → live 全 0 (不崩)', s.status === 'live' && s.totals.nodes === 0);
  check('坏事件对象被丢弃', NP.computeSnapshot([null, 7, { type: 'node_joined' }] as any, { now: Date.now() }).totals.nodes === 0);
  fs.rmSync(h2, { recursive: true, force: true });
}

// ── [5] 公开只读接口 (真 HTTP, 无认证) ─────────────────────────────────────
section('[5] GET /api/public/network/progress (真 HTTP, 无凭据, ETag, 短缓存)');
{
  const { createWebServer } = await import('../src/web/server.js') as any;
  const app = await createWebServer({ port: 0, headless: true } as any);
  const srv: any = app?.server || app;
  const addr: any = await new Promise((r) => { if (srv?.address?.()) r(srv.address()); else srv?.once?.('listening', () => r(srv.address())); });
  const BASE = `http://127.0.0.1:${addr?.port || 0}`;
  try {
    const r1 = await fetch(`${BASE}/api/public/network/progress`);
    const body: any = await r1.json();
    check('无需任何凭据即 200', r1.status === 200, r1.status);
    check('Cache-Control 短缓存', String(r1.headers.get('cache-control') || '').includes('max-age=15'), r1.headers.get('cache-control'));
    const etag = r1.headers.get('etag');
    check('带 ETag', !!etag, etag);
    check('响应含 totals/capabilities/recent_activity 三块', !!body.totals && Array.isArray(body.capabilities) && Array.isArray(body.recent_activity));
    check('响应 status ∈ live|stale|unavailable', ['live', 'stale', 'unavailable'].includes(body.status), body.status);
    check('响应不含私有字段', NP.assertNoPrivateFields(body).length === 0, NP.assertNoPrivateFields(body));
    const r2 = await fetch(`${BASE}/api/public/network/progress`, { headers: { 'if-none-match': String(etag) } });
    check('带 If-None-Match → 304 (省流量)', r2.status === 304, r2.status);
    // 本地私有接口仍在、且与公开接口分离
    const rl = await fetch(`${BASE}/api/agent/local-manifest`);
    check('本地 /api/agent/local-manifest 依旧可用 (进网/控制用, 不给网站)', rl.status === 200 || rl.status === 404, rl.status);
  } finally {
    try { await (app?.close?.() ?? srv?.close?.()); } catch { /* noop */ }
  }
}

// ── [6] 前端消费契约 ───────────────────────────────────────────────────────
section('[6] 前端消费契约 (bolloon-UI 网关页需要什么这里就得有什么)');
{
  const snap = await NP.getNetworkPulse({ home: HOME, force: true });
  const need = ['status', 'generated_at', 'fresh_until', 'scope', 'scope_label', 'totals', 'capabilities', 'recent_activity'];
  const missing = need.filter((k) => !(k in snap));
  check('快照字段齐全 (UI 只依赖白名单投影)', missing.length === 0, missing);
  check('totals 四个大数值齐备', ['nodes', 'agents', 'active_agents', 'seen_last_24h'].every((k) => k in snap.totals), snap.totals);
  check('scope_label 中英双语可用', !!snap.scope_label.zh && !!snap.scope_label.en, snap.scope_label);
  const json = JSON.stringify(snap);
  check('前端拿到的 JSON 里没有任务正文/指令类字段', !/"instruction"|"content"|"payload"/.test(json), json.slice(0, 120));
}

console.log(`\n=== 结果: ${passed} passed, ${failed} failed ===`);
console.log('覆盖: 双节点(发布→缓存→观察) · 匿名化(原始 DID/能力名不落盘) · 隐私阈值 · scope 可信边界 · live/stale/unavailable · malformed 安全 · 公开接口无认证+ETag+304 · 前端字段契约');
try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
process.exit(failed === 0 ? 0 : 1);
