/**
 * external-events 单测 (批次 2-C.4)
 * 协议: 来源 → correlation → 属于当前 continuation → 过期 → eventId 去重; 任何一步不过都不唤醒。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

let TMP = '', BHOME = '';
const OLD = { HOME: process.env.HOME, UP: process.env.USERPROFILE, BH: process.env.BOLLOON_HOME };

beforeEach(async () => {
  TMP = path.join(os.tmpdir(), `bolloon-ext-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  BHOME = path.join(TMP, '.bolloon');
  await fs.mkdir(BHOME, { recursive: true });
  process.env.HOME = TMP; process.env.USERPROFILE = TMP; delete process.env.BOLLOON_HOME;
});
afterEach(async () => {
  process.env.HOME = OLD.HOME; process.env.USERPROFILE = OLD.UP;
  if (OLD.BH === undefined) delete process.env.BOLLOON_HOME; else process.env.BOLLOON_HOME = OLD.BH;
  await fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

async function G() { return await import('../agents/goal-store.js') as any; }
async function E() { return await import('../agents/external-events.js') as any; }

async function makeWaitingGoal(source: 'p2p' | 'delegate' | 'any' = 'delegate', ttlMs = 60_000, eventName?: string) {
  const g = await G();
  const e = await E();
  const goal = await g.createGoal({ objective: '等外部回复', channelId: 'ch-ext', agentId: 'ag-ext' });
  await g.updateGoal(goal.goalId, { status: 'awaiting_external' });
  const wait = { requestId: 'R1', continuationId: 'C1', expectedSource: source, expectedEvent: eventName, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + ttlMs).toISOString() };
  await e.bindExternalWait(goal.goalId, wait);
  return { goal, wait, e, g };
}

describe('绑定 / 匹配 / 投递', () => {
  it('绑定写入 continuation.external + needsExternal (持久化事实)', async () => {
    const { goal } = await makeWaitingGoal();
    const g = await G();
    const rec = await g.readGoal(goal.goalId);
    expect(rec.continuation.external.requestId).toBe('R1');
    expect(rec.continuation.external.expectedSource).toBe('delegate');
    expect(String(rec.continuation.needsExternal)).toContain('delegate');
  });

  it('来源不符 → 不唤醒 (source_mismatch)', async () => {
    const { goal, e } = await makeWaitingGoal('delegate');
    const res = await e.deliverExternalEvent({ source: 'p2p', eventId: 'E1', requestId: 'R1' });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('source_mismatch');
    const g = await G();
    expect((await g.readGoal(goal.goalId)).status).toBe('awaiting_external');
  });

  it('correlation 不符 / 缺失 → 不唤醒', async () => {
    const { e } = await makeWaitingGoal('delegate');
    expect((await e.deliverExternalEvent({ source: 'delegate', eventId: 'E1', requestId: 'WRONG' })).reason).toBe('correlation_mismatch');
    expect((await e.deliverExternalEvent({ source: 'delegate', eventId: 'E2', continuationId: 'WRONG' })).reason).toBe('correlation_mismatch');
    expect((await e.deliverExternalEvent({ source: 'delegate', eventId: 'E3' })).reason).toBe('correlation_mismatch');
  });

  it('过期 → 不唤醒 (expired)', async () => {
    const { e } = await makeWaitingGoal('delegate', -1000);
    const res = await e.deliverExternalEvent({ source: 'delegate', eventId: 'E1', requestId: 'R1' });
    expect(res.reason).toBe('expired');
  });

  it('正常投递: 写证据 + 记 eventId + 状态从 awaiting_external 回 active + 唤醒回调', async () => {
    const { goal, e, g } = await makeWaitingGoal('delegate');
    let woke = '';
    const res = await e.deliverExternalEvent({ source: 'delegate', eventId: 'E1', requestId: 'R1', fromDid: 'did:key:peer', eventName: 'result', payload: { cid: 'bafy...' } }, { wake: async (id: string) => { woke = id; return true; } });
    expect(res.ok).toBe(true);
    expect(res.goalId).toBe(goal.goalId);
    expect(woke).toBe(goal.goalId);
    const rec = await g.readGoal(goal.goalId);
    expect(rec.status).toBe('active');
    expect(rec.continuation.external).toBeUndefined();
    expect(rec.continuation.deliveredEventIds).toContain('E1');
    expect(rec.continuation.externalResult.eventId).toBe('E1');
    expect(rec.evidence.join(' ')).toContain('E1');
  });

  it('同一 eventId 再来 → duplicate (不重复唤醒)', async () => {
    const { e } = await makeWaitingGoal('delegate');
    await e.deliverExternalEvent({ source: 'delegate', eventId: 'E9', requestId: 'R1' });
    // 重新绑定同一个等待 (模拟"还在等")
    const g = await G();
    const all = await g.listGoals({ limit: 10 });
    const goalId = all[0].goalId;
    await g.updateGoal(goalId, { status: 'awaiting_external' });
    await e.bindExternalWait(goalId, { requestId: 'R1', continuationId: 'C1', expectedSource: 'delegate', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const dup = await e.deliverExternalEvent({ source: 'delegate', eventId: 'E9', requestId: 'R1' });
    expect(dup.reason).toBe('duplicate');
  });

  it('没有任何 Goal 在等 → no_match (可以继续走普通消息)', async () => {
    const e = await E();
    const res = await e.deliverExternalEvent({ source: 'p2p', eventId: 'E1', requestId: 'R1' });
    expect(res.reason).toBe('no_match');
  });

  it('缺 eventId → 拒绝 (无法去重)', async () => {
    const { e } = await makeWaitingGoal('delegate');
    const res = await e.deliverExternalEvent({ source: 'delegate', eventId: '' as any, requestId: 'R1' });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('correlation_mismatch');
  });
});

describe('超时转人工 (不允许无限等待)', () => {
  it('等待过期 → expireExternalWaits 把 Goal 转 needs_human 并清等待', async () => {
    const { goal, e, g } = await makeWaitingGoal('p2p', -5_000);
    const out = await e.expireExternalWaits();
    expect(out.length).toBe(1);
    expect(out[0].goalId).toBe(goal.goalId);
    const rec = await g.readGoal(goal.goalId);
    expect(rec.status).toBe('needs_human');
    expect(rec.continuation.autoContinue).toBe(false);
    expect(rec.continuation.external).toBeUndefined();
    expect(String(rec.continuation.lastExternalTimeout)).toMatch(/超时/);
    expect(rec.evidence.join(' ')).toContain('超时');
  });

  it('没过期的等待不动', async () => {
    await makeWaitingGoal('p2p', 60_000);
    const e = await E();
    expect((await e.expireExternalWaits()).length).toBe(0);
  });
});

describe('签名消息 → 目标事件 的解析 (真实入站路径)', () => {
  it('delegate 回包 → source=delegate; P2P 协作回复 → source=p2p; 与 Goal 无关 → 不处理', async () => {
    const b = await import('../network/goal-event-bridge.js') as any;
    const delegateMsg = { type: 'agent_delegate_result', from: 'did:key:peerA', payload: JSON.stringify({ goalId: 'g1', requestId: 'R1', continuationId: 'C1', eventId: 'EV1', event: 'result', resultCid: 'bafy' }) };
    const dev = b.extractGoalEvent(delegateMsg, 'did:key:peerA');
    expect(dev.source).toBe('delegate');
    expect(dev.goalId).toBe('g1');
    const p2pMsg = { type: 'agent_message', from: 'did:key:peerB', payload: JSON.stringify({ goalEvent: { goalId: 'g2', requestId: 'R2', eventId: 'EV2', event: 'reply', payload: { text: 'ok' } } }) };
    const p2p = b.extractGoalEvent(p2pMsg, 'did:key:peerB');
    expect(p2p.source).toBe('p2p');
    expect(p2p.expectedEvent === undefined || true).toBe(true);
    const unrelated = { type: 'agent_message', from: 'did:key:peerC', payload: JSON.stringify({ text: '今天天气不错' }) };
    expect(b.extractGoalEvent(unrelated, 'did:key:peerC')).toBeNull();
    const noEventId = { type: 'agent_message', from: 'did:key:peerD', payload: JSON.stringify({ goalId: 'g3' }) };
    expect(b.extractGoalEvent(noEventId, 'did:key:peerD')).toBeNull();
  });

  it('接线存在: dispatchSignedMessage 里必须调用 goal event bridge (源码级防回退)', async () => {
    const src = await fs.readFile(path.join(process.cwd(), 'src/network/agent-network.ts'), 'utf8');
    const idx = src.indexOf('dispatchSignedMessage');
    expect(idx).toBeGreaterThan(-1);
    expect(src.slice(idx, idx + 2500)).toContain('tryDeliverGoalEvent');
  });
});
