/**
 * bridge.ts — P4 MCP 适配层的**唯一**调用通道
 *
 * 硬约束 (leo 2026-09-21 / `docs/wiki/agent-access-layer.md` §1):
 *   **MCP 不复制业务逻辑。** 所有 tool / resource 都只有一条路:
 *     构造 P3 命令的 argv → `parseFlags` → `GROUP_COMMANDS[group]` (P3 命令函数) → 信封原样返回
 *   这里**没有**任何业务判断 (不判断成败、不算钱、不发付款、不写交易记录)。
 *
 * 三条映射规矩:
 *   ① 信封**原样**返回: `{ok, code, message, data, evidence, next_action}` 一个字段都不改
 *      (`ok:false` 不许被 MCP 层改写成成功 —— 失败也走 MCP 的 isError=true, 见 server.ts)
 *   ② 输出前过 H 层防护: 私钥/助记词类字段一律剥离 (P1 §5.5) + 付款回执原文一律剥离 (§5.6 私有层)
 *   ③ 超时与异常兜底**复用** P3 的 `commandResult` (同一条实现, 不许第二套语义)
 */

import {
  parseFlags, commandResult, finalizeEnvelope, redactSecrets,
  type Envelope, type CliFlags,
} from '../protocol-envelope.js';
import { GROUP_COMMANDS, type ServiceGroup } from '../commands/index.js';

/** 一次 P3 调用的选项 (全部来自 MCP tool 的入参, 已在 tools.ts 里逐项白名单校验) */
export interface BridgeOptions {
  /** 调用超时 (ms): 直接进 P3 的 `--timeout` → 超时给 `code=TIMEOUT` 的结构化失败 */
  timeoutMs?: number;
  /** 幂等键: 进 P3 的 `--request-id` (真实做幂等查找/回显的命令才用它) */
  requestId?: string;
}

/**
 * 付款回执 / 原始 HTTP 回执字段: **绝不出本机** (P1 §5.6 私有层)。
 * P3 的信封今天本来就不带它们 (例如 trade show 只给 `paymentReceiptPresent: boolean`),
 * 这里是**兜底**: 万一将来某个服务把原文塞进了 data, MCP 层也必须在出口拦掉。
 */
const RECEIPT_FIELDS = ['paymentReceipt', 'paymentReceiptRaw', 'rawReceipt', 'rawHeader', 'receiptRaw'];

/** 允许出现在 tool 入参里的时间上限 (防止把一个数字写成天荒地老) */
const MAX_TIMEOUT_MS = 30 * 60 * 1000;

export function defaultTimeoutMs(): number | undefined {
  const raw = process.env.BOLLOON_MCP_TIMEOUT_MS;
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), MAX_TIMEOUT_MS) : undefined;
}

export interface BridgeCall {
  group: ServiceGroup;
  argv: string[];
  opts?: BridgeOptions;
}

/**
 * 调一次 P3 命令组, 拿**原样**信封 (只做出口防护, 不做任何解释)。
 * 注意: 这里绝不写 stdout —— MCP 的 stdout 是 JSON-RPC 流 (`commandResult` 不打印)。
 */
export async function callP3(call: BridgeCall): Promise<Envelope> {
  const flags: CliFlags = parseFlags(call.argv);
  const timeoutMs = call.opts?.timeoutMs ?? defaultTimeoutMs();
  if (timeoutMs) flags.timeoutMs = timeoutMs;
  if (call.opts?.requestId) flags.requestId = call.opts.requestId;

  const fn = GROUP_COMMANDS[call.group];
  if (!fn) {
    // 不可能发生 (group 由 tools.ts 写死); 但绝不静默
    return {
      ok: false,
      code: 'INTERNAL_ERROR',
      message: `MCP 适配层不知道命令组 '${String(call.group)}'`,
      data: { group: String(call.group) },
      evidence: [],
      next_action: 'needs_human',
    };
  }
  // ★ 唯一调用点: P3 命令函数 (薄包装; 超时/异常兜底也走 P3 的 commandResult)
  const result = await commandResult(flags, fn);
  // 收敛成冻结字段顺序 + 私钥类字段剥离 (finalizeEnvelope 与 CLI --json 是同一个出口)
  return mcpSafeEnvelope(finalizeEnvelope(result.envelope, flags));
}

/**
 * 出口防护 (MCP 特有的**加严**, 不改 P3 语义):
 *   · 整封 (含 evidence) 深扫 `AUDIT_FORBIDDEN_KEYS`: privateKey / secret / instruction / taskText / mnemonic / seed
 *     → 命中即替成 `[redacted]` 并在 data 里记 `redacted_fields` (不静默)
 *   · 付款回执原文类字段 → 替成 `[stripped]` 并记 `receipt_stripped: true`
 * 注意: 这里只**删减**输出, 从不改 `ok`/`code`/`next_action` (不许把失败洗成成功)。
 */
export function mcpSafeEnvelope(env: Envelope): Envelope {
  const hits: string[] = [];
  const redacted = redactSecrets(env, hits) as Envelope;
  const stripped: string[] = [];
  const data = (stripReceipts(redacted.data, stripped, '$') as Record<string, unknown>) || {};

  const out: Envelope = {
    ok: env.ok,
    code: env.code,
    message: env.message,
    data,
    evidence: Array.isArray(redacted.evidence) ? redacted.evidence : [],
    next_action: env.next_action ?? null,
  };
  if (hits.length) out.data.redacted_fields = hits;
  if (stripped.length) {
    out.data.receipt_stripped = true;
    out.data.receipt_stripped_fields = stripped;
    out.data.receipt_note = '付款回执原文属于私有层 (P1 §5.6), 绝不出本机 —— MCP 出口已剥离';
  }
  return out;
}

function stripReceipts(value: unknown, hits: string[], path: string): unknown {
  if (Array.isArray(value)) return value.map((v, i) => stripReceipts(v, hits, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (RECEIPT_FIELDS.includes(k) && v !== null && v !== undefined) {
        hits.push(`${path}.${k}`);
        out[k] = '[stripped]';
        continue;
      }
      out[k] = stripReceipts(v, hits, `${path}.${k}`);
    }
    return out;
  }
  return value;
}
