/**
 * task-transport.ts — bolloon-task/1 帧 + **现成传输** (P3, 2026-09-21)
 *
 * 任务书要求: `task.send` 必须经**现成传输**把签名请求真发出去, 传输不可用 → 结构化诚实失败。
 * 本模块把三种现存传输包成同一个 `TaskTransport`:
 *
 *   ① `http`    —— POST `<peer>/api/task/frame` (对端 = `src/web/task-frame-server.ts` 起的节点端点;
 *                  与 `agent-delegate-server` 同一套 express + JSON 形状, 真跨进程/跨机 TCP)。
 *   ② `iroh`    —— `src/network/iroh-transport.ts` 的 `requestResponse` (P2P, 与 `iroh-delegate-transport` 同一条链路;
 *                  需要本机 iroh 端点已就绪, 未就绪 → 如实 `TRANSPORT_UNAVAILABLE`)。
 *   ③ `gateway` —— `agent-gateway.gatewayCallAgent` 的发现/协商链 (**刻意不传 privateKey**:
 *                  这条路径在物理上无法发起任何 x402 付款)。
 *
 * 纪律:
 *   · 帧里的信封 (TaskRequest/…) 是**签名过**的; 传输层只加 `signer{ did, publicKeyHex }` (公开材料)
 *     与 `replyTo` / `body` (私有正文, 只走这条直连任务通道)。
 *   · 解析严格: protocol 精确相等 + frame 在白名单 + taskId/requestId 与信封一致, 否则拒。
 *   · **绝不发起付款**: 本模块没有任何付款调用; 传输失败就是失败, 不重试到"看起来成功"。
 */

import {
  TASK_PROTOCOL,
  type TaskRequest, type TaskAccept, type TaskReject, type TaskResult,
} from './task-contract.js';

export const TASK_FRAME_TYPES = ['task_request', 'task_accept', 'task_reject', 'task_result'] as const;
export type TaskFrameType = (typeof TASK_FRAME_TYPES)[number];

/** 对端节点接收任务帧的路径 (与 `task-frame-server` 约定) */
export const TASK_FRAME_PATH = '/api/task/frame';

export interface TaskFrameSigner {
  /** 公开: did:key:z... */
  did: string;
  /** 公开: 32 字节 ed25519 公钥 hex (对端验信封签名用) */
  publicKeyHex: string;
}

export interface TaskFrame {
  protocol: typeof TASK_PROTOCOL;
  frame: TaskFrameType;
  sentAt: number;
  signer: TaskFrameSigner;
  /** 发送方自己的 task frame 端点 —— 对端据此把 accept/reject/result 发回来 */
  replyTo?: string | null;
  /** 交付正文 (只在直连任务通道里; 哈希在签名的信封里, 正文本身不进任何公开层) */
  body?: string | null;
  envelope: TaskRequest | TaskAccept | TaskReject | TaskResult;
}

export function buildTaskFrame(
  frame: TaskFrameType,
  envelope: TaskRequest | TaskAccept | TaskReject | TaskResult,
  signer: TaskFrameSigner,
  opts: { replyTo?: string | null; body?: string | null; now?: number } = {},
): TaskFrame {
  return {
    protocol: TASK_PROTOCOL,
    frame,
    sentAt: opts.now ?? Date.now(),
    signer: { did: String(signer.did || ''), publicKeyHex: String(signer.publicKeyHex || '') },
    ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
    ...(opts.body ? { body: opts.body } : {}),
    envelope,
  };
}

export function serializeFrame(f: TaskFrame): string {
  return JSON.stringify(f);
}

/** 严格解析 (版本/类型/身份/信封标识逐条查; 不合法就说哪一条不合法) */
export function parseTaskFrame(text: string): { ok: true; frame: TaskFrame } | { ok: false; error: string } {
  let raw: any;
  try { raw = JSON.parse(String(text)); } catch { return { ok: false, error: '不是 JSON' }; }
  if (!raw || typeof raw !== 'object') return { ok: false, error: '帧不是对象' };
  if (raw.protocol !== TASK_PROTOCOL) return { ok: false, error: `帧协议版本不对: ${String(raw.protocol)} (要 ${TASK_PROTOCOL})` };
  if (!(TASK_FRAME_TYPES as readonly string[]).includes(String(raw.frame))) {
    return { ok: false, error: `未知帧类型: ${String(raw.frame)}` };
  }
  const signer = raw.signer;
  if (!signer || typeof signer !== 'object') return { ok: false, error: '缺 signer (用来验信封签名)' };
  if (!/^[0-9a-f]{64}$/i.test(String(signer.publicKeyHex || ''))) return { ok: false, error: 'signer.publicKeyHex 不是 32 字节公钥 hex' };
  const env: any = raw.envelope;
  if (!env || typeof env !== 'object') return { ok: false, error: '缺 envelope' };
  if (env.protocol !== TASK_PROTOCOL) return { ok: false, error: `信封协议版本不对: ${String(env.protocol)}` };
  if (!String(env.taskId || '').trim() || !String(env.requestId || '').trim()) return { ok: false, error: '信封缺 taskId/requestId' };
  if (!String(env.signature || '').trim()) return { ok: false, error: '信封没有签名 (SIGNATURE_REQUIRED)' };
  return { ok: true, frame: raw as TaskFrame };
}

// ── 传输结果 ────────────────────────────────────────────────────────────────

export interface FrameTransfer {
  ok: boolean;
  kind: string;
  target: string;
  elapsedMs: number;
  /** 对端回的帧 (收到 accept/reject/result 时) */
  reply?: TaskFrame;
  /** 诚实失败原因 (永不吞) */
  error?: string;
  detail?: string;
  /** 对端说这是重复请求 (幂等; 不是错误) */
  duplicate?: boolean;
}

export interface TaskTransport {
  kind: 'http' | 'iroh' | 'gateway';
  /** 传输层自检 (比如 iroh 端点没起来) —— 不可用就如实说 */
  available(): Promise<{ ok: boolean; reason?: string }>;
  send(target: string, frame: TaskFrame, timeoutMs?: number): Promise<FrameTransfer>;
}

// ── ① HTTP (对端 = task-frame-server) ────────────────────────────────────────

function frameUrl(endpoint: string): string {
  const e = String(endpoint || '').trim().replace(/\/+$/, '');
  if (!e) return '';
  return e.endsWith(TASK_FRAME_PATH) ? e : `${e}${TASK_FRAME_PATH}`;
}

export function httpTaskTransport(opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}): TaskTransport {
  const defaultTimeout = opts.timeoutMs ?? 20_000;
  return {
    kind: 'http',
    async available() {
      const f = opts.fetchImpl ?? (globalThis as any).fetch;
      return typeof f === 'function'
        ? { ok: true }
        : { ok: false, reason: '本机没有 fetch 实现 (Node < 18?)' };
    },
    async send(target, frame, timeoutMs) {
      const t0 = Date.now();
      const url = frameUrl(target);
      if (!url) return { ok: false, kind: 'http', target, elapsedMs: 0, error: '目标端点为空 (要 http(s)://…)' };
      const f = opts.fetchImpl ?? fetch;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? defaultTimeout);
        const resp = await f(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ frame }),
          signal: ctrl.signal,
        }).finally(() => clearTimeout(timer));
        const text = await resp.text().catch(() => '');
        if (!resp.ok) {
          return { ok: false, kind: 'http', target: url, elapsedMs: Date.now() - t0, error: `对端 HTTP ${resp.status}`, detail: text.slice(0, 300) };
        }
        let body: any;
        try { body = JSON.parse(text); } catch { return { ok: false, kind: 'http', target: url, elapsedMs: Date.now() - t0, error: '对端回的不是 JSON', detail: text.slice(0, 300) }; }
        if (body?.ok === false) {
          return { ok: false, kind: 'http', target: url, elapsedMs: Date.now() - t0, error: String(body.error || '对端拒绝了这帧'), detail: body.detail ? String(body.detail).slice(0, 300) : undefined };
        }
        let reply: TaskFrame | undefined;
        if (body?.reply) {
          const p = parseTaskFrame(typeof body.reply === 'string' ? body.reply : JSON.stringify(body.reply));
          if (!p.ok) return { ok: false, kind: 'http', target: url, elapsedMs: Date.now() - t0, error: `对端回的帧不合法: ${p.error}` };
          reply = p.frame;
        }
        return { ok: true, kind: 'http', target: url, elapsedMs: Date.now() - t0, reply, duplicate: body?.duplicate === true, detail: body?.note ? String(body.note).slice(0, 300) : undefined };
      } catch (e: any) {
        const msg = String(e?.message || e);
        const kindHint = /abort/i.test(msg) ? `超时 (${timeoutMs ?? defaultTimeout}ms 内没回)` : msg;
        return { ok: false, kind: 'http', target: url, elapsedMs: Date.now() - t0, error: `对端不可达: ${kindHint.slice(0, 200)}` };
      }
    },
  };
}

// ── ② iroh (P2P; 与 iroh-delegate-transport 同一条链路) ──────────────────────

export function irohTaskTransport(opts: { startIfNeeded?: boolean; secret?: string } = {}): TaskTransport {
  return {
    kind: 'iroh',
    async available() {
      try {
        const mod: any = await import('../network/iroh-transport.js');
        const t = mod.irohTransport;
        if (!t || typeof t.requestResponse !== 'function') return { ok: false, reason: 'irohTransport 不可用' };
        if (typeof t.getNodeId === 'function' && t.getNodeId()) return { ok: true };
        if (!opts.startIfNeeded) return { ok: false, reason: '本机 iroh 端点没起来 (需要先起节点; 或用 --endpoint 走 HTTP 直连)' };
        // 起节点的 secretKey 从 ~/.bolloon/iroh-secret-default.json 来 (跨重启稳定 nodeId), 与既有启动路径一致
        const { loadOrCreateIrohSecret } = await import('./iroh-secret.js');
        const secret = opts.secret || loadOrCreateIrohSecret().secretKey;
        const r = await t.start(secret as any, false);
        return r?.nodeId ? { ok: true } : { ok: false, reason: 'iroh 端点启动失败 (本机没有可用 iroh 运行时)' };
      } catch (e: any) {
        return { ok: false, reason: `iroh 运行时不可用: ${String(e?.message || e).slice(0, 160)}` };
      }
    },
    async send(target, frame, timeoutMs) {
      const t0 = Date.now();
      const avail = await this.available();
      if (!avail.ok) return { ok: false, kind: 'iroh', target, elapsedMs: Date.now() - t0, error: `iroh 传输不可用: ${avail.reason}` };
      try {
        const mod: any = await import('../network/iroh-transport.js');
        const t = mod.irohTransport;
        const payload = new TextEncoder().encode(serializeFrame(frame));
        const resp = await t.requestResponse(target, 'task_frame', payload, timeoutMs ?? 20_000);
        if (!resp) return { ok: false, kind: 'iroh', target, elapsedMs: Date.now() - t0, error: '对端没回 (超时/连不上)' };
        const text = new TextDecoder().decode(resp);
        // 对端直接回一帧, 或回 {ok, reply}
        const direct = parseTaskFrame(text);
        if (direct.ok) return { ok: true, kind: 'iroh', target, elapsedMs: Date.now() - t0, reply: direct.frame };
        try {
          const body = JSON.parse(text);
          if (body?.ok === false) return { ok: false, kind: 'iroh', target, elapsedMs: Date.now() - t0, error: String(body.error || '对端拒绝') };
          if (body?.reply) {
            const p = parseTaskFrame(typeof body.reply === 'string' ? body.reply : JSON.stringify(body.reply));
            if (p.ok) return { ok: true, kind: 'iroh', target, elapsedMs: Date.now() - t0, reply: p.frame, duplicate: body?.duplicate === true };
          }
        } catch { /* 落到下面 */ }
        return { ok: false, kind: 'iroh', target, elapsedMs: Date.now() - t0, error: '对端回的内容不是合法帧', detail: text.slice(0, 200) };
      } catch (e: any) {
        return { ok: false, kind: 'iroh', target, elapsedMs: Date.now() - t0, error: `iroh 发送失败: ${String(e?.message || e).slice(0, 200)}` };
      }
    },
  };
}

// ── ③ gateway (agent-gateway 的既有发现/协商链; **不带私钥 → 不可能付款**) ────

export function gatewayTaskTransport(): TaskTransport {
  return {
    kind: 'gateway',
    async available() {
      try {
        const { getAgentRegistry } = await import('./agent-registry.js');
        const reg = getAgentRegistry();
        return reg ? { ok: true } : { ok: false, reason: 'registry 不可用' };
      } catch (e: any) {
        return { ok: false, reason: String(e?.message || e).slice(0, 120) };
      }
    },
    async send(target, frame, timeoutMs) {
      const t0 = Date.now();
      try {
        const { gatewayCallAgent } = await import('./agent-gateway.js');
        let handled = false;
        // ★ 刻意不传 privateKey: 这条路径无法发起 x402 付款 (policy.recordSpend 也不执行)
        const r = await gatewayCallAgent({
          task: serializeFrame(frame),
          budget: Number.MAX_SAFE_INTEGER,   // 预算已由任务信封 (budget.maxAmount) 约束; 这里不另设闸
          capability: undefined,
          url: target,
        } as any);
        handled = true;
        if (!r.success) {
          return { ok: false, kind: 'gateway', target, elapsedMs: Date.now() - t0, error: r.error || 'gateway 调用失败', detail: `decision=${r.decision || 'n/a'} paid=false handled=${handled}` };
        }
        const out = String(r.output || '');
        try {
          const body = JSON.parse(out);
          // out = {ok, reply} 形状 (对端 task-frame-server) 或直接是帧
          if (body?.reply) {
            const p = parseTaskFrame(typeof body.reply === 'string' ? body.reply : JSON.stringify(body.reply));
            if (p.ok) return { ok: true, kind: 'gateway', target, elapsedMs: Date.now() - t0, reply: p.frame, duplicate: body?.duplicate === true };
          }
        } catch { /* 交给下面 */ }
        const direct = parseTaskFrame(out);
        if (direct.ok) return { ok: true, kind: 'gateway', target, elapsedMs: Date.now() - t0, reply: direct.frame };
        return { ok: false, kind: 'gateway', target, elapsedMs: Date.now() - t0, error: 'gateway 执行结果不是合法任务帧', detail: out.slice(0, 200) };
      } catch (e: any) {
        return { ok: false, kind: 'gateway', target, elapsedMs: Date.now() - t0, error: `gateway 传输异常: ${String(e?.message || e).slice(0, 200)}` };
      }
    },
  };
}

// ── 目标解析 (registry 发现) ────────────────────────────────────────────────

export interface TaskTarget {
  target: string;              // endpoint URL 或 iroh nodeId
  kind: 'http' | 'iroh' | 'gateway';
  agentId?: string;
  providerDid?: string;
  wallet?: string;
  priceAmount?: string;
  priceCurrency?: string;
  source: string;              // 目标是怎么来的 (如实)
}

/**
 * 不给 `--endpoint`/`--peer` 时: 用 registry 按 capability 找 provider 的 endpoint。
 * 找不到 → null (调用方如实报 CAPABILITY_NOT_FOUND / NETWORK_NOT_JOINED, 不猜地址)。
 */
export async function resolveTaskTarget(capability: string, opts: { registry?: any } = {}): Promise<{ target: TaskTarget | null; registryReady: boolean; candidates: number }> {
  let registry = opts.registry;
  if (!registry) {
    const { getAgentRegistry } = await import('./agent-registry.js');
    registry = getAgentRegistry();
  }
  const ready = registry?.ready === true;
  let services: any[] = [];
  try {
    services = capability ? await registry.discover(capability) : await registry.list();
  } catch { services = []; }
  const withEndpoint = services.find((s) => typeof s?.endpoint === 'string' && s.endpoint.trim());
  if (!withEndpoint) return { target: null, registryReady: ready, candidates: services.length };
  return {
    target: {
      target: String(withEndpoint.endpoint).trim(),
      kind: 'http',
      agentId: withEndpoint.agentId,
      providerDid: withEndpoint.agentId || undefined,
      wallet: withEndpoint.wallet,
      priceAmount: withEndpoint.service?.price?.amount,
      priceCurrency: withEndpoint.service?.price?.currency,
      source: 'registry.discover(capability) → service.endpoint',
    },
    registryReady: ready,
    candidates: services.length,
  };
}
