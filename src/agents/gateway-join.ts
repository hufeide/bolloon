/**
 * gateway-join.ts — 文档驱动的「加入全球智能体网络」编排 (2026-09-15)
 *
 * 背景: 手机端 / PC 端的人类入口只有一句话 —— `read https://bolloon.cn/bolloon-gateway-join.md`
 * (默认 prompt, 见 src/web/mobile.js DEFAULT_JOIN_PROMPT)。文档本身是 SKILL.md 形状的入网说明,
 * 但文档第 1-8 节写的是 SDK 伪码 (KeyManager / p2pNetwork.createNode / buildManifestRequest),
 * 智能体手里只有工具, 照抄不了 → 需要一个工具把整条链路真正串起来。
 *
 * 本模块把「读文档 → 入网」收成一个可验证的闭环:
 *   ① 读入网说明 (http(s), 校验 frontmatter 是 bolloon-gateway-join)
 *   ② 确保 DID 身份
 *   ③ 确保 P2P 节点 (拿 peerId)
 *   ④ 注册本地 manifest (文档第 3 节 /api/agent/register 的等效物: setLocalManifest)
 *   ⑤ 建成可分享的网络 (orbitdb registry 链接) + 登记到本机 Agent 服务注册表
 *   ⑥ 落盘入网态 (幂等: 同 url 重复入网 → already)
 *
 * 诚实原则: 每一步都记 step.note; 拿不到的 (文档不可达 / 非入网说明 / 节点未就绪 / registry 离线)
 * 一律如实报 ok=false 或 step.ok=false, 不假装入网成功。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const DEFAULT_GATEWAY_JOIN_DOC = 'https://bolloon.cn/bolloon-gateway-join.md';
/** 入网说明文档的识别名 (frontmatter name) / 能力标记 */
export const GATEWAY_JOIN_DOC_NAME = 'bolloon-gateway-join';
export const GATEWAY_JOIN_CAPABILITY = 'gateway-join';

const home = (): string => process.env.HOME || os.homedir() || '/tmp';
const STATE_FILE = () => path.join(home(), '.bolloon', 'gateway-join.json');

// ============ 文档读取 ============

export interface GatewaySkillDoc {
  ok: boolean;
  url: string;
  name?: string;
  version?: string;
  capabilities?: string[];
  body?: string;
  error?: string;
}

/** 极简 frontmatter 解析 (只认 name/version/capabilities 三个键, 够用且不引 yaml 依赖) */
export function parseSkillFrontmatter(text: string): { name?: string; version?: string; capabilities?: string[]; body: string } {
  const raw = String(text || '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return { body: raw };
  const head = m[1];
  const body = raw.slice(m[0].length);
  const out: { name?: string; version?: string; capabilities?: string[] } = {};
  for (const line of head.split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const val = kv[2].trim();
    if (key === 'name') out.name = val.replace(/^["']|["']$/g, '');
    else if (key === 'version') out.version = val.replace(/^["']|["']$/g, '');
    else if (key === 'capabilities') {
      out.capabilities = val.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    }
  }
  return { ...out, body };
}

/** 从文档文本判定「这是不是入网说明」 */
export function isGatewayJoinDoc(text: string): boolean {
  const fm = parseSkillFrontmatter(text);
  if (fm.name === GATEWAY_JOIN_DOC_NAME) return true;
  if (fm.capabilities?.includes(GATEWAY_JOIN_CAPABILITY)) return true;
  // 没有 frontmatter 也允许 (纯正文版本): 标题 + 关键步骤同时出现才算
  return /加入网关|加入 Bolloon|bolloon-gateway-join/.test(text) && /api\/agent\/register/.test(text);
}

export async function readGatewaySkillDoc(
  url: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; text?: string } = {},
): Promise<GatewaySkillDoc> {
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) return { ok: false, url: u, error: `url 必须以 http(s):// 开头 (收到: ${u.slice(0, 60)})` };
  let text = opts.text;
  if (text === undefined) {
    const f = opts.fetchImpl || fetch;
    try {
      const r = await f(u, { signal: AbortSignal.timeout(opts.timeoutMs ?? 15000) } as any);
      if (!r.ok) return { ok: false, url: u, error: `文档不可达 (HTTP ${r.status})` };
      text = await r.text();
    } catch (e: any) {
      return { ok: false, url: u, error: `文档不可达: ${String(e?.message || e).slice(0, 140)}` };
    }
  }
  const raw = String(text || '');
  if (!raw.trim()) return { ok: false, url: u, error: '文档为空' };
  const fm = parseSkillFrontmatter(raw);
  if (!isGatewayJoinDoc(raw)) {
    return { ok: false, url: u, name: fm.name, error: '这不是 Bolloon 网关入网说明 (缺 name: bolloon-gateway-join), 拒绝据此入网' };
  }
  return { ok: true, url: u, name: fm.name, version: fm.version, capabilities: fm.capabilities, body: fm.body };
}

// ============ 入网态 (持久化 + 幂等) ============

export interface GatewayJoinState {
  url: string;
  did: string;
  name?: string;
  capabilities?: string[];
  peerId?: string;
  networkLink?: string;
  networkId?: string;
  joinedAt: string;
}

export async function getGatewayJoinState(): Promise<GatewayJoinState | null> {
  try {
    const raw = fs.readFileSync(STATE_FILE(), 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as GatewayJoinState) : null;
  } catch {
    return null;
  }
}

export function writeGatewayJoinState(state: GatewayJoinState): void {
  try {
    const f = STATE_FILE();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch { /* 落盘失败不影响本次入网, 只影响幂等/重启恢复 */ }
}

// ============ 入网编排 ============

export interface JoinStep {
  step: string;
  ok: boolean;
  note: string;
}

export interface GlobalJoinResult {
  ok: boolean;
  already?: boolean;
  url: string;
  did?: string;
  peerId?: string;
  networkLink?: string;
  networkId?: string;
  docVersion?: string;
  steps: JoinStep[];
  error?: string;
}

export interface JoinGlobalDeps {
  fetchImpl?: typeof fetch;
  /** 注入文档正文 (离线/测试用; 给了就不走网络) */
  docText?: string;
  /** 注入 DID (不给则读 ~/.bolloon/identity/user.json) */
  did?: string;
  /** 注入 peerId (不给则问本机 P2P 节点) */
  peerId?: string;
  /** 注入 manifest 注册 (不给则用本机 agent-manifest-protocol) */
  registerManifest?: (m: { ownerName: string; ownerPublicKey: string; agents: any[] }) => void;
  /** 注入网络链接生成 (不给则用 gateway-network.shareNetworkLink) */
  shareLink?: (opts: { name: string }) => Promise<{ ok: boolean; link?: string; error?: string }>;
  /** 注入服务注册 (不给则用 agent-gateway.gatewayRegisterAgent) */
  registerService?: (agent: any) => Promise<{ ok: boolean; error?: string }>;
  /** 节点初始化开关 (默认: 中继开, UPnP/autoNAT 关 —— 个人机默认不开网络侧自动穿透) */
  enableUPnP?: boolean;
  enableAutoNat?: boolean;
  /** 节点初始化超时 (默认 25s) */
  nodeTimeoutMs?: number;
}

/** 节点初始化并发去重 (同一进程内只起一次 libp2p 节点) */
let nodeInitPromise: Promise<{ ok: boolean; peerId?: string; multiaddrs?: string[]; error?: string }> | null = null;

/**
 * 确保本机 libp2p 节点在跑 (文档第 2 节 p2pNetwork.createNode 的等价物)。
 * p2pNetwork.createNode 不是幂等的, 所以先用 getNodePeerId() 探测 + 单飞 promise 兜住并发。
 */
export async function ensureGatewayNode(deps: JoinGlobalDeps = {}): Promise<{ ok: boolean; peerId?: string; multiaddrs?: string[]; started?: boolean; error?: string }> {
  if (deps.peerId) return { ok: true, peerId: deps.peerId, started: false };
  try {
    const { p2pNetwork } = await import('../network/p2p.js');
    const existing = String((p2pNetwork as any).getNodePeerId?.() || '');
    if (existing) return { ok: true, peerId: existing, multiaddrs: (p2pNetwork as any).getWsMultiaddrs?.() || [], started: false };
    if (!nodeInitPromise) {
      const timeoutMs = deps.nodeTimeoutMs ?? 25_000;
      nodeInitPromise = (async () => {
        try {
          const info = await Promise.race([
            p2pNetwork.createNode({
              enableRelay: true,
              enableRelayServer: true,
              enableAutoNat: deps.enableAutoNat ?? false,
              enableUPnP: deps.enableUPnP ?? false,
            } as any),
            new Promise((_, rej) => setTimeout(() => rej(new Error(`节点初始化超时 (${timeoutMs}ms)`)), timeoutMs)),
          ]) as any;
          const peerId = String(info?.peerId || (p2pNetwork as any).getNodePeerId?.() || '');
          return peerId
            ? { ok: true, peerId, multiaddrs: (info?.multiaddrs || []) as string[] }
            : { ok: false, error: '节点起来了但拿不到 peerId' };
        } catch (e: any) {
          return { ok: false, error: String(e?.message || e).slice(0, 160) };
        } finally {
          // 失败也允许下次重试 (成功时后续调用被 getNodePeerId 分支短路)
          setTimeout(() => { nodeInitPromise = null; }, 1000);
        }
      })();
    }
    const r = await nodeInitPromise;
    return { ...r, started: !!r.ok };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 160) };
  }
}

function readUserDid(): string {
  try {
    const f = path.join(home(), '.bolloon', 'identity', 'user.json');
    const parsed = JSON.parse(fs.readFileSync(f, 'utf-8'));
    return String(parsed?.did || '');
  } catch {
    return '';
  }
}

/**
 * 文档驱动入网: 读说明 → DID → 节点 → manifest → 建网 → 落盘。
 * 核心三步 (文档/DID/manifest) 任一失败 → ok=false; 网络/服务登记失败只记 note (部分成功不谎报)。
 */
export async function joinGlobalGateway(opts: JoinGlobalOpts = {}): Promise<GlobalJoinResult> {
  const url = String(opts.url || DEFAULT_GATEWAY_JOIN_DOC).trim();
  const deps: JoinGlobalDeps = opts.deps || {};
  const steps: JoinStep[] = [];

  // 幂等: 已经按同一文档入过网 → already (不重复建, 但仍返回既有信息)
  const prev = await getGatewayJoinState();
  if (prev && prev.url === url && prev.did && !opts.force) {
    return {
      ok: true, already: true, url, did: prev.did, peerId: prev.peerId,
      networkLink: prev.networkLink, networkId: prev.networkId,
      steps: [{ step: '幂等', ok: true, note: `已于 ${prev.joinedAt} 入网 (${prev.did.slice(0, 24)}…)` }],
    };
  }

  // ① 读入网说明
  const doc = await readGatewaySkillDoc(url, { fetchImpl: deps.fetchImpl, text: deps.docText });
  steps.push({ step: '读入网说明', ok: doc.ok, note: doc.ok ? `${doc.name || 'doc'} v${doc.version || '?'} (${(doc.body || '').length} 字符)` : (doc.error || '') });
  if (!doc.ok) return { ok: false, url, error: doc.error, steps };

  // ② DID 身份
  const did = String(opts.did || deps.did || readUserDid() || '');
  steps.push({ step: 'DID 身份', ok: !!did, note: did ? `${did.slice(0, 30)}…` : '本机无 DID (先运行 bolloon 让 server 生成 ~/.bolloon/identity/user.json)' });
  if (!did) return { ok: false, url, error: '缺少 DID 身份, 无法入网', steps };

  const name = String(opts.name || 'bolloon-agent');

  // ③ P2P 节点 (文档第 2 节: p2pNetwork.createNode) — 起不来的话如实在 note 里说
  const node = await ensureGatewayNode(deps);
  const peerId = String(node.peerId || '');
  const multiaddrs = node.multiaddrs || [];
  steps.push({
    step: 'P2P 节点',
    ok: !!peerId,
    note: peerId ? `peerId=${peerId.slice(0, 16)}…${node.started ? ' (本次启动)' : ' (已在跑)'}` : `节点未就绪: ${node.error || '未知原因'}`,
  });

  // ③b 登记节点端点 + 广播地址 (文档第 2/7 节) — 非致命
  if (peerId) {
    try {
      const { initializeAgentNetwork, broadcastOwnAddress } = await import('../network/agent-network.js');
      await initializeAgentNetwork(did, name, peerId, multiaddrs);
      await broadcastOwnAddress().catch(() => { /* 无对端时广播无意义, 不算失败 */ });
      steps.push({ step: '登记节点端点 + 广播地址', ok: true, note: `multiaddrs=${multiaddrs.length} 条` });
    } catch (e: any) {
      steps.push({ step: '登记节点端点 + 广播地址', ok: false, note: `失败: ${String(e?.message || e).slice(0, 120)}` });
    }
  }

  // ④ 注册本地 manifest (文档第 3 节)
  const capabilities = (opts.capabilities && opts.capabilities.length ? opts.capabilities : ['chat', 'gateway-join']).map(String);
  const entry = { id: `${name}-main`.replace(/\s+/g, '-'), name, capabilities, status: 'active' as const, ...(peerId ? { peerId } : {}) };
  let registered = false;
  try {
    if (deps.registerManifest) {
      deps.registerManifest({ ownerName: name, ownerPublicKey: did, agents: [entry] });
      registered = true;
    } else {
      const { setLocalManifest, getLocalManifest } = await import('./agent-manifest-protocol.js');
      setLocalManifest({ ownerName: name, ownerPublicKey: did, agents: [entry] });
      registered = (getLocalManifest().agents || []).some((a) => a.id === entry.id);
    }
  } catch (e: any) {
    steps.push({ step: '注册 manifest', ok: false, note: `注册失败: ${String(e?.message || e).slice(0, 120)}` });
    return { ok: false, url, did, error: 'manifest 注册失败', steps };
  }
  steps.push({ step: '注册 manifest', ok: registered, note: registered ? `agents=[${entry.id}] capabilities=[${capabilities.join(',')}]` : 'register 后读回为空' });
  if (!registered) return { ok: false, url, did, error: 'manifest 注册后读回为空', steps };

  // ⑤ 建网 (可分享的 orbitdb 网络链接) — 离线/registry 未就绪时如实记 note
  let networkLink: string | undefined;
  let networkId: string | undefined;
  try {
    const share = deps.shareLink
      ? await deps.shareLink({ name })
      : await (await import('./gateway-network.js')).shareNetworkLink({ name });
    if (share.ok && share.link) {
      networkLink = share.link;
      networkId = new URLSearchParams(share.link.split('?')[1] || '').get('name') || undefined;
      steps.push({ step: '建成网络 (可分享链接)', ok: true, note: share.link.slice(0, 72) });
    } else {
      steps.push({ step: '建成网络 (可分享链接)', ok: false, note: `未建成: ${share.error || 'registry 未就绪 (离线模式)'}` });
    }
  } catch (e: any) {
    steps.push({ step: '建成网络 (可分享链接)', ok: false, note: `异常: ${String(e?.message || e).slice(0, 120)}` });
  }

  // ⑥ 登记到本机 Agent 服务注册表 (让他方按能力发现/委派)
  try {
    const r = deps.registerService
      ? await deps.registerService({ capability: capabilities[0], did, name })
      : await (await import('./agent-gateway.js')).gatewayRegisterAgent(
        { capability: capabilities[0], description: `${name} 入网节点`, price: '0', per: 'task' },
        { did, name, wallet: '' },
      );
    steps.push({ step: '服务登记 (可被发现)', ok: !!r?.ok, note: r?.ok ? '已写入本机 registry' : (r?.error || '未写入') });
  } catch (e: any) {
    steps.push({ step: '服务登记 (可被发现)', ok: false, note: `异常: ${String(e?.message || e).slice(0, 120)}` });
  }

  // ⑦ 落盘入网态 (幂等 + 重启恢复)
  writeGatewayJoinState({ url, did, name, capabilities, peerId: peerId || undefined, networkLink, networkId, joinedAt: new Date().toISOString() });
  steps.push({ step: '落盘入网态', ok: (await getGatewayJoinState())?.url === url, note: STATE_FILE() });

  return { ok: true, url, did, peerId: peerId || undefined, networkLink, networkId, docVersion: doc.version, steps };
}

export interface JoinGlobalOpts {
  url?: string;
  did?: string;
  name?: string;
  capabilities?: string[];
  /** 强制重新入网 (忽略幂等) */
  force?: boolean;
  deps?: JoinGlobalDeps;
}

export default { DEFAULT_GATEWAY_JOIN_DOC, readGatewaySkillDoc, isGatewayJoinDoc, parseSkillFrontmatter, joinGlobalGateway, getGatewayJoinState, writeGatewayJoinState };
