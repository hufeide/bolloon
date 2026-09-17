/**
 * goal-event-bridge.ts — 把"真实入站的签名消息"翻译成 Goal 外部事件 (批次 2-C.4)
 *
 * 只有签名已通过校验的消息才进到这里 (来源 = 对端 DID)。这里只做解析 + 投递,
 * 启动执行由 Supervisor 决定 —— 事件处理器不碰 agent。
 *
 * 识别的两种真实来源:
 *   · delegate 回包: type 含 `delegate` 或 payload 里有 delegateId/resultCid → source='delegate'
 *   · P2P 协作回复: 其它带 goalId/requestId/continuationId 的消息 → source='p2p'
 */

import { deliverExternalEvent, type ExternalEventInput } from '../agents/external-events.js';

interface SignedLike { type: string; from: string; payload: string; name?: string }

export interface BridgeOutcome { matched: boolean; reason?: string; goalId?: string }

function parsePayload(raw: unknown): any {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw)); } catch { return null; }
}

/** 从 payload 里提取目标关联字段 (支持 goalEvent 包裹或平铺两种写法) */
export function extractGoalEvent(signed: SignedLike, fromDid: string): ExternalEventInput | null {
  const body = parsePayload(signed.payload);
  if (!body || typeof body !== 'object') return null;
  const env = (body.goalEvent && typeof body.goalEvent === 'object') ? body.goalEvent : body;
  const goalId = env.goalId || env.goal_id;
  const requestId = env.requestId || env.request_id || env.correlationId;
  const continuationId = env.continuationId || env.continuation_id;
  const eventId = env.eventId || env.event_id;
  if (!goalId && !requestId && !continuationId) return null;      // 与 Goal 无关 → 普通消息
  if (!eventId) return null;                                      // 没有 eventId 无法去重 → 不当事件处理
  const isDelegate = /delegate/i.test(String(signed.type)) || !!(env.delegateId || env.resultCid);
  return {
    source: isDelegate ? 'delegate' : 'p2p',
    eventId: String(eventId),
    requestId: requestId ? String(requestId) : undefined,
    continuationId: continuationId ? String(continuationId) : undefined,
    goalId: goalId ? String(goalId) : undefined,
    fromDid: fromDid || signed.from,
    eventName: env.event || env.eventName || env.kind,
    payload: env.result ?? env.payload ?? body,
  };
}

/** 投递 (未匹配/不合法 → 返回 matched:false, 调用方继续走普通消息处理) */
export async function tryDeliverGoalEvent(signed: SignedLike, fromDid: string): Promise<BridgeOutcome> {
  const event = extractGoalEvent(signed, fromDid);
  if (!event) return { matched: false };
  const res = await deliverExternalEvent(event);
  return { matched: res.ok, reason: res.reason, goalId: res.goalId };
}
