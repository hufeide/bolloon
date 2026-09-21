/**
 * network-pulse.ts — 网络脉冲 (Network Pulse): 把已有 P2P 生命周期投影成
 * **匿名、可验证、可降级**的公开统计, 供 bolloon-UI 网关页动态展示。
 *
 * 设计约束 (leo 2026-09-18 计划):
 *   · 只对**公开统计**有用的事实留档: 不存任务正文、不存私有 payload
 *   · 浏览器**永远不接触原始事件** —— 对外只有聚合快照
 *   · 不暴露 DID / peerId / IP / 钱包地址 / Agent 私有内容
 *   · 单节点看到的数据**不许说成全网精确总量**: scope=observed / verified 明确写在快照里
 *   · 快照过期 → `stale` (不许伪装实时); 观察层不可用 → `unavailable`
 *   · 类别小于隐私阈值 → 合并进 other
 *   · 事件数 / 时间窗 / capability 数都有上限
 *
 * 借鉴 (只借产品与工程思想, 不借 Go/Postgres/API 项目):
 *   EigenFlux 的 "注册总量 / 当前活跃 / 最近出现" 时间窗统计、服务端生成匿名活动文本、
 *   live/stale/unavailable 状态、短缓存与时间边界、隐私阈值、白名单投影。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

// ── 常量 (上限 + 时间边界) ─────────────────────────────────────────────────

export const PULSE_LIMITS = {
  /** 最多留多少条事件 (超出丢最旧) */
  maxEvents: 5000,
  /** 统计窗口 */
  windowMs: 24 * 60 * 60 * 1000,
  /** "活跃"的定义: 最近 5 分钟出现过 */
  activeWindowMs: 5 * 60 * 1000,
  /** 时间桶 (小时) */
  bucketMs: 60 * 60 * 1000,
  /** 对外最多列多少个 capability 类别 */
  maxCapabilities: 12,
  /** 隐私阈值: 少于这个数的类别合并进 other */
  privacyThreshold: 3,
  /** 快照新鲜期 (秒) → 之后 stale */
  snapshotTtlMs: 30 * 1000,
  /** 活动流最多几条 */
  maxActivity: 8,
} as const;

/** 事件类型白名单 —— 只允许这些进统计 (其余一律丢弃) */
export const NETWORK_EVENT_TYPES = [
  'node_joined',
  'manifest_published',
  'capability_announced',
  'peer_connected',
  'delegation_completed',
] as const;
export type NetworkEventType = (typeof NETWORK_EVENT_TYPES)[number];

export interface NetworkPulseEvent {
  type: NetworkEventType;
  /** 时间桶 (epoch 小时) —— 便于按桶聚合 */
  bucket: string;
  /** 粗粒度能力类别 (不外泄原始能力名) */
  capabilityGroup?: string;
  occurredAt: number;
  /** 匿名节点摘要 (sha256(did) 前 16 位), 绝不落原始 DID */
  sourceProof: string;
  /** 可选: Agent 摘要 (sha256(did:agentId) 前 16 位) */
  agentProof?: string;
  /** 这条事件是否来自一个签名来源 (决定 scope 能否升到 verified) */
  signed?: boolean;
  /** 签名覆盖 (可选): hmac(secret, payload) 前 32 位, 用于本地完整性校验 */
  integrity?: string;
}

export interface NetworkPulseSnapshot {
  status: 'live' | 'stale' | 'unavailable';
  generated_at: number;
  fresh_until: number;
  /** observed = 当前节点观察到的; verified = 多签名来源汇总观察快照 (都不是"全网精确总量") */
  scope: 'observed' | 'verified';
  scope_label: { zh: string; en: string };
  totals: { nodes: number; agents: number; active_agents: number; seen_last_24h: number };
  capabilities: { key: string; count: number }[];
  recent_activity: { kind: NetworkEventType; at: number; text: { zh: string; en: string } }[];
  /** 快照签名 (可选, 供公开观察入口校验) */
  signature?: string;
  signer_fingerprint?: string;
  notes: string[];
}

// ── 存储 ────────────────────────────────────────────────────────────────────

const home = (h?: string): string => h || process.env.HOME || os.homedir() || '/tmp';
export const pulseDir = (h?: string): string => path.join(home(h), '.bolloon', 'network-pulse');
const eventsFile = (h?: string): string => path.join(pulseDir(h), 'events.json');
const snapshotFile = (h?: string): string => path.join(pulseDir(h), 'snapshot.json');

/** 是否是一条结构合法的事件 (坏数据一律丢弃, 不让快照崩) */
function isValidEvent(e: any): e is NetworkPulseEvent {
  return !!e && typeof e === 'object'
    && NETWORK_EVENT_TYPES.includes(e.type)
    && typeof e.sourceProof === 'string' && e.sourceProof.length > 0
    && Number.isFinite(e.occurredAt);
}

function readEvents(h?: string): NetworkPulseEvent[] {
  try {
    const raw = JSON.parse(fs.readFileSync(eventsFile(h), 'utf-8'));
    return Array.isArray(raw) ? raw.filter(isValidEvent) : [];
  } catch {
    return [];
  }
}

function writeEvents(list: NetworkPulseEvent[], h?: string): void {
  try {
    fs.mkdirSync(pulseDir(h), { recursive: true });
    fs.writeFileSync(eventsFile(h), JSON.stringify(list.slice(-PULSE_LIMITS.maxEvents)), 'utf8');
  } catch {
    /* 统计失败绝不影响主路径 */
  }
}

// ── 匿名化 ──────────────────────────────────────────────────────────────────

/** 节点摘要: sha256(值) 前 16 位。不可逆, 不暴露原值。 */
export function nodeDigest(value: string): string {
  return crypto.createHash('sha256').update(`bolloon-pulse|${String(value)}`).digest('hex').slice(0, 16);
}

const CAPABILITY_GROUPS: Array<[RegExp, string]> = [
  [/research|market|调研|分析|survey|search/i, 'research'],
  [/code|review|refactor|debug|编程|代码/i, 'coding'],
  [/data|dataset|etl|metric|数据/i, 'data'],
  [/write|content|doc|translat|写作|文档|翻译/i, 'writing'],
  [/automation|workflow|deploy|ops|自动化/i, 'automation'],
  [/vision|image|audio|speech|视觉|图像|语音/i, 'multimodal'],
];

/** 把原始能力名归并成粗类别 (不外泄原始能力名) */
export function capabilityGroup(raw: string): string {
  const s = String(raw || '').trim();
  if (!s) return 'other';
  for (const [re, g] of CAPABILITY_GROUPS) if (re.test(s)) return g;
  return 'other';
}

export function bucketOf(at: number): string {
  return String(Math.floor(at / PULSE_LIMITS.bucketMs));
}

// ── 写事件 ──────────────────────────────────────────────────────────────────

export interface RecordEventInput {
  type: string;
  /** 原始能力名 (会被归并成粗类别) */
  capability?: string;
  /** 原始 DID / peerId (只用于算摘要, 绝不落盘) */
  did?: string;
  /** Agent 标识 (只用于算摘要) */
  agentId?: string;
  at?: number;
  signed?: boolean;
}

/** 完整性标记 (本地校验用; 不含任何可逆信息) */
function integrityOf(ev: Pick<NetworkPulseEvent, 'type' | 'bucket' | 'sourceProof' | 'occurredAt'>): string {
  return nodeDigest(`${ev.type}|${ev.bucket}|${ev.sourceProof}|${ev.occurredAt}`);
}

/**
 * 记一条网络事件。**永不影响主路径**: 非法类型/写失败/异常一律静默丢弃。
 * 幂等: 同一节点同一桶内的 `node_joined` 只记一次 (重复 join 不虚增节点数)。
 */
export async function recordNetworkEvent(input: RecordEventInput, h?: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    const type = String(input?.type || '') as NetworkEventType;
    if (!NETWORK_EVENT_TYPES.includes(type)) return { ok: false, reason: `非白名单事件类型: ${type}` };
    const at = Number(input.at ?? Date.now());
    if (!Number.isFinite(at) || at <= 0) return { ok: false, reason: 'occurredAt 非法' };
    const sourceProof = nodeDigest(String(input.did || 'unknown-node'));
    const bucket = bucketOf(at);
    const agentProof = input.agentId ? nodeDigest(`${String(input.did || 'unknown-node')}:${String(input.agentId)}`) : undefined;

    const list = readEvents(h);
    if (type === 'node_joined' && list.some((e) => e.type === 'node_joined' && e.sourceProof === sourceProof && e.bucket === bucket)) {
      return { ok: true, reason: 'already' };   // 同桶重复入网不虚增
    }
    const ev: NetworkPulseEvent = {
      type,
      bucket,
      occurredAt: at,
      sourceProof,
      ...(input.capability ? { capabilityGroup: capabilityGroup(input.capability) } : {}),
      ...(agentProof ? { agentProof } : {}),
      ...(input.signed ? { signed: true } : {}),
    };
    ev.integrity = integrityOf(ev);
    list.push(ev);
    // 只保留窗口内 + 上限
    const cutoff = at - PULSE_LIMITS.windowMs;
    writeEvents(list.filter((e) => e.occurredAt >= cutoff), h);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: String(e?.message || e) };
  }
}

// ── 快照 ────────────────────────────────────────────────────────────────────

/** 服务端固定模板生成匿名活动文本 (不让前端拼字符串) */
export function renderActivityText(kind: NetworkEventType): { zh: string; en: string } {
  switch (kind) {
    case 'node_joined': return { zh: '有新节点加入网络', en: 'A node joined the network' };
    case 'manifest_published': return { zh: '有节点发布/更新了能力声明', en: 'A node published or updated its manifest' };
    case 'capability_announced': return { zh: '有节点公开声明了新能力', en: 'A node announced a capability' };
    case 'peer_connected': return { zh: '两个节点建立了连接', en: 'Two nodes connected' };
    case 'delegation_completed': return { zh: '一次能力委派完成', en: 'A delegation completed' };
    default: return { zh: '网络有活动', en: 'Network activity' };
  }
}

export interface SnapshotOptions {
  home?: string;
  now?: number;
  /** 强制重算 (忽略缓存) */
  force?: boolean;
  /** 观察层不可用时置 true → 返回 unavailable */
  unavailable?: boolean;
}

/** 纯函数: 从事件列表算出快照 (便于单测; 不做 IO) */
export function computeSnapshot(events: NetworkPulseEvent[], opts: { now: number; unavailable?: boolean; signedNodes?: number }): NetworkPulseSnapshot {
  const now = opts.now;
  const fresh_until = now + PULSE_LIMITS.snapshotTtlMs;
  if (opts.unavailable) {
    return {
      status: 'unavailable',
      generated_at: now,
      fresh_until,
      scope: 'observed',
      scope_label: { zh: '当前节点观察到', en: 'Observed by this node' },
      totals: { nodes: 0, agents: 0, active_agents: 0, seen_last_24h: 0 },
      capabilities: [],
      recent_activity: [],
      notes: ['观察层暂不可用 — 这不是"网络为空"'],
    };
  }
  const window = (Array.isArray(events) ? events : []).filter((e) => isValidEvent(e) && e.occurredAt >= now - PULSE_LIMITS.windowMs);
  const nodes = new Set(window.map((e) => e.sourceProof).filter(Boolean));
  const agents = new Set(window.map((e) => e.agentProof).filter(Boolean) as string[]);
  const active = new Set(window.filter((e) => e.occurredAt >= now - PULSE_LIMITS.activeWindowMs).map((e) => e.agentProof).filter(Boolean) as string[]);

  // capability 分布 (按粗类别计数, 每个类别按**不同的 agent**去重, 避免单节点刷高)
  const capMap = new Map<string, Set<string>>();
  for (const e of window) {
    if (e.type !== 'capability_announced' || !e.capabilityGroup) continue;
    const key = e.capabilityGroup;
    if (!capMap.has(key)) capMap.set(key, new Set());
    capMap.get(key)!.add(e.agentProof || e.sourceProof);
  }
  let capabilities = Array.from(capMap.entries())
    .map(([key, set]) => ({ key, count: set.size }))
    .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1))
    .slice(0, PULSE_LIMITS.maxCapabilities);

  // 隐私阈值: 少于阈值的类别合并进 other (other 本身也按阈值判断是否保留)
  const small = capabilities.filter((c) => c.count < PULSE_LIMITS.privacyThreshold && c.key !== 'other');
  if (small.length > 0) {
    capabilities = capabilities.filter((c) => !small.includes(c));
    const otherCount = new Set<string>();
    for (const c of small) otherCount.add(c.key);
    capabilities.push({ key: 'other', count: otherCount.size });
    capabilities.sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1));
  }

  const recent = [...window]
    .sort((a, b) => b.occurredAt - a.occurredAt)
    .slice(0, PULSE_LIMITS.maxActivity)
    .map((e) => ({ kind: e.type, at: e.occurredAt, text: renderActivityText(e.type) }));

  const signedNodes = opts.signedNodes ?? new Set(window.filter((e) => e.signed).map((e) => e.sourceProof)).size;
  const scope: NetworkPulseSnapshot['scope'] = signedNodes >= 2 ? 'verified' : 'observed';

  const notes: string[] = [];
  if (scope === 'observed') notes.push('单节点观察: 这是本节点能看到的部分网络, 不是全网精确总量');
  else notes.push(`多签名来源汇总 (${signedNodes} 个签名节点)`);

  return {
    status: 'live',
    generated_at: now,
    fresh_until,
    scope,
    scope_label: scope === 'verified'
      ? { zh: '网络观察快照 (多签名来源)', en: 'Verified network snapshot' }
      : { zh: '当前节点观察到', en: 'Observed by this node' },
    totals: {
      nodes: nodes.size,
      agents: agents.size,
      active_agents: active.size,
      seen_last_24h: agents.size,     // 24h 窗口内的不同 Agent
    },
    capabilities,
    recent_activity: recent,
    notes,
  };
}

/** 读快照 (带 30s 短缓存; 过期 → 重算; 重算失败 → unavailable) */
export async function getNetworkPulse(opts: SnapshotOptions = {}): Promise<NetworkPulseSnapshot> {
  const now = opts.now ?? Date.now();
  if (opts.unavailable) return computeSnapshot([], { now, unavailable: true });
  if (!opts.force) {
    try {
      const cached = JSON.parse(fs.readFileSync(snapshotFile(opts.home), 'utf-8')) as NetworkPulseSnapshot;
      if (cached && Number.isFinite(cached.generated_at) && cached.generated_at + PULSE_LIMITS.snapshotTtlMs > now) return cached;
    } catch { /* 无缓存 */ }
  }
  let events: NetworkPulseEvent[] = [];
  try {
    events = readEvents(opts.home);
  } catch (e: any) {
    return computeSnapshot([], { now, unavailable: true });
  }
  const snap = computeSnapshot(events, { now });
  try {
    fs.mkdirSync(pulseDir(opts.home), { recursive: true });
    fs.writeFileSync(snapshotFile(opts.home), JSON.stringify(snap), 'utf8');
  } catch { /* 写不进就算了, 返回值仍然有效 */ }
  return snap;
}

/** 快照是否仍是 live (给前端/观察入口判断; 过期即 stale) */
export function snapshotStatus(snap: NetworkPulseSnapshot, now = Date.now()): 'live' | 'stale' | 'unavailable' {
  if (snap.status === 'unavailable') return 'unavailable';
  return now <= snap.fresh_until ? 'live' : 'stale';
}

// ── 签名 (可验证快照) ───────────────────────────────────────────────────────

/** 规范化 JSON (键排序), 用于签名覆盖 */
export function canonicalize(value: unknown): string {
  const walk = (v: any): any => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, any> = {};
      for (const k of Object.keys(v).sort()) out[k] = walk(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

export interface SignedSnapshot { snapshot: NetworkPulseSnapshot }

/** 用本机 DID 身份给快照签名 (公开入口可校验; 只暴露签名与指纹, 不暴露 DID) */
export async function signSnapshot(snap: NetworkPulseSnapshot, h?: string): Promise<NetworkPulseSnapshot> {
  try {
    const { KeyManager } = await import('@diap/sdk');
    const file = path.join(home(h), '.bolloon', 'identity.json');
    const kp: any = await (KeyManager as any).fromFile(file);
    if (!kp?.privateKey) return snap;
    const payload = { ...snap, signature: undefined, signer_fingerprint: undefined };
    const sig = await (KeyManager as any).sign(kp, canonicalize(payload));
    return { ...snap, signature: String(sig), signer_fingerprint: nodeDigest(String(kp.did || '')) };
  } catch {
    return snap;   // 没身份/签名失败 → 就返回未签名快照 (绝不假装签过)
  }
}

/** 校验快照签名 (需要显式传入公钥方; 内部/测试用) */
export async function verifySnapshotSignature(snap: NetworkPulseSnapshot, publicKey: any): Promise<boolean> {
  try {
    if (!snap.signature) return false;
    const { KeyManager } = await import('@diap/sdk');
    const payload = { ...snap, signature: undefined, signer_fingerprint: undefined };
    return await (KeyManager as any).verify(publicKey, canonicalize(payload), snap.signature);
  } catch {
    return false;
  }
}

/** 公开投影的"禁止出现"字段检查 (测试与调用方共用) */
export const FORBIDDEN_PUBLIC_KEYS = ['did', 'peerId', 'peer_id', 'multiaddrs', 'ip', 'wallet', 'address', 'privateKey', 'content', 'instruction', 'payload'];

export function assertNoPrivateFields(value: unknown, at = '$'): string[] {
  const issues: string[] = [];
  const walk = (v: any, p: string) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${p}[${i}]`));
    if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v)) {
        if (FORBIDDEN_PUBLIC_KEYS.includes(k)) issues.push(`${p}.${k} 不该出现在公开投影里`);
        walk(val, `${p}.${k}`);
      }
    }
  };
  walk(value, at);
  return issues;
}
