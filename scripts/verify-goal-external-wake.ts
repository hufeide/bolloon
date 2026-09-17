/**
 * verify-goal-external-wake.ts — 批次 2-C.4 真跑验收: 真实外部事件唤醒 Goal (2026-09-16)
 *
 * 真实的东西: 真 Goal/continuation 文件 · 真 Supervisor tick (确定性 runner + 真 Run 落盘) ·
 *            真 Ed25519 签名消息走**真实入站路径** `AgentMessaging.dispatchSignedMessage`
 *            (签名校验 → goal event bridge → 来源/correlation/过期/去重 → 唤醒 → 下一轮继续)。
 *
 * 覆盖: 等待中不重发 · 错误来源/错误关联/过期不唤醒 · 真 delegate 回包唤醒并继续 · 重复事件不重复起 Run ·
 *      真 P2P 协作回复唤醒另一个 Goal · 超时转 needs_human 且不再自动跑。
 *
 * 用法: npx tsx scripts/verify-goal-external-wake.ts
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { KeyManager } from '@diap/sdk';

const REAL_HOME = os.homedir();                        // 必须在覆盖 HOME 之前取
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-extwake-'));
const HOME = path.join(ROOT, 'home');
const BHOME = path.join(HOME, '.bolloon');
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.BOLLOON_SKIP_KUBO = '1';
process.env.BOLLOON_CRON = '0';
process.env.BOLLOON_SUPERVISOR = '0';
fs.mkdirSync(BHOME, { recursive: true });

const { makeSetupReady } = await import('./lib/make-setup-ready.js');
const ready = makeSetupReady(BHOME, { realHome: REAL_HOME });
console.log(`[setup-ready] ${ready.ok ? 'LLM 配置已就绪' : '⚠ 无可用 LLM 配置'}`);

const G: any = await import('../src/agents/goal-store.js');
const R: any = await import('../src/agents/run-store.js');
const E: any = await import('../src/agents/external-events.js');
const S: any = await import('../src/agents/execution-supervisor.js');
const N: any = await import('../src/network/agent-network.js');

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail !== undefined ? ` — ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 220)}` : ''}`); }
};
const section = (t: string) => console.log(`\n${t}`);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── 真实入站: 用真 Ed25519 签名消息走真实 dispatchSignedMessage ───────────────
const peer = KeyManager.generate();
const peerPub = Buffer.from(peer.publicKey).toString('hex');
const reg: any = new N.AgentRegistry();
await reg.initialize();
reg.registerAgent({ did: peer.did, name: 'Peer-Verifier', peerId: '12D3KooWExtPeer', publicKey: peerPub, publicKeyHex: peerPub, capabilities: ['chat'], multiaddrs: [], canRelay: false } as any);
const messaging: any = new N.AgentMessaging(reg);

async function sendSigned(type: string, payloadObj: unknown) {
  const payload = JSON.stringify(payloadObj);
  const timestamp = Date.now();
  const messageData = JSON.stringify({ type, from: peer.did, name: 'Peer-Verifier', payload, timestamp });
  const sig = await KeyManager.sign(peer, new TextEncoder().encode(messageData));
  const signed = { type, from: peer.did, name: 'Peer-Verifier', payload, timestamp, signature: Buffer.from(sig).toString('hex') };
  return await messaging.dispatchSignedMessage(new TextEncoder().encode(JSON.stringify(signed)), '12D3KooWExtPeer');
}

// ── 确定性 runner: 真起 Run + 真落盘 + 消费外部结果 ──────────────────────────
const consumed: string[] = [];
const runner = async (req: any) => {
  const run = await R.startRun({ goal: req.goal.objective, goalId: req.goal.goalId, surface: 'verify-external-wake' } as any);
  await R.recordStep(run.runId, { tool: 'external_reply', ok: true, summary: `消费外部结果 (kind=${req.kind})` });
  await R.finishRun(run.runId, { status: 'done', summary: '外部事件已消费', evidence: [`外部事件已消费 (kind=${req.kind})`] });
  consumed.push(run.runId);
  return { runId: run.runId, status: 'done' };
};
function sup(owner: string) { return new S.ExecutionSupervisor({ runner: runner as any, owner, maxPerTick: 1, log: () => {} }); }
const runCount = () => (fs.existsSync(path.join(BHOME, 'runs')) ? fs.readdirSync(path.join(BHOME, 'runs')).filter((f) => f.endsWith('.json') && !f.endsWith('.json.bak')).length : 0);

// ═══════════════════════════════════════════════════════════════════════════
async function main() {
// ── [1] 等待中: Supervisor 不推进, 也不重复发送 ──────────────────────────────
section('[1] Goal 在等外部事件: Supervisor 跳过 (不重复发送)');
const goalD = await G.createGoal({ objective: '等 delegate 回包', channelId: 'ch-x', agentId: 'ag-x' });
await G.updateGoal(goalD.goalId, { status: 'awaiting_external' });
await E.bindExternalWait(goalD.goalId, {
  requestId: 'REQ-D1', continuationId: 'CONT-D1', expectedSource: 'delegate', expectedEvent: 'result',
  createdAt: new Date().toISOString(), expiresAt: E.defaultWaitExpiry(Date.now(), 60_000), note: 'delegate 回包等待中',
});
const runs0 = runCount();
const rep1 = await sup('w-ext').tickOnce();
const skip1 = rep1.skipped.find((s: any) => s.goalId === goalD.goalId);
check('等待中的 Goal 没有被执行', !rep1.executed.some((e: any) => e.goalId === goalD.goalId), rep1.executed);
check('跳过原因可读 (等外部事件 + 不重复发送)', !!skip1 && /awaiting_external|等外部事件/.test(skip1.reason), skip1?.reason);
check('没有新建 Run (等待期间不空跑)', runCount() === runs0, { before: runs0, after: runCount() });
const wr1 = (await G.wakeReport()).find((w: any) => w.goalId === goalD.goalId);
check('wakeReport 说清在等什么', !!wr1 && /等外部事件/.test(wr1.wake), wr1?.wake);

// ── [2] 错误来源 / 错误关联 / 过期 → 都不唤醒 ─────────────────────────────────
section('[2] 错误来源 / 错误 correlation / 过期 → 不唤醒');
const wrongSource = await E.deliverExternalEvent({ source: 'p2p', eventId: 'EV-wrong-src', requestId: 'REQ-D1' });
check('来源不符被拒 (source_mismatch)', wrongSource.reason === 'source_mismatch', wrongSource);
const wrongCorr = await E.deliverExternalEvent({ source: 'delegate', eventId: 'EV-wrong-corr', requestId: 'REQ-OTHER' });
check('requestId 不匹配被拒', wrongCorr.reason === 'correlation_mismatch', wrongCorr);
const noCorr = await E.deliverExternalEvent({ source: 'delegate', eventId: 'EV-no-corr' });
check('没有 correlation 被拒 (不能乱认亲)', noCorr.reason === 'correlation_mismatch', noCorr);
const gA = await G.readGoal(goalD.goalId);
check('拒绝后 Goal 仍在等待', gA.status === 'awaiting_external' && !!gA.continuation.external, gA.status);
const rep2 = await sup('w-ext').tickOnce();
check('被拒事件没有引发 Run', !rep2.executed.some((e: any) => e.goalId === goalD.goalId), rep2.executed);

// ── [3] 真 delegate 回包 (真签名 → 真入站路径) → 唤醒 + 下一轮继续 ───────────
section('[3] 真 delegate 回包: 真签名消息走真实入站 → 唤醒 → Supervisor 继续');
const delivered = await sendSigned('agent_delegate_result', {
  goalId: goalD.goalId, requestId: 'REQ-D1', continuationId: 'CONT-D1', eventId: 'EV-D1', event: 'result',
  delegateId: 'dlg-1', resultCid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
});
check('真签名消息被接受 (签名校验通过)', delivered === true, delivered);
const gB = await G.readGoal(goalD.goalId);
check('投递后 Goal 回到 active (不再等)', gB.status === 'active', gB.status);
check('等待事实已清 (不留下过期等待)', !gB.continuation.external, gB.continuation.external);
check('事件写入证据 (可追溯)', (gB.evidence || []).join(' ').includes('EV-D1'), gB.evidence);
check('eventId 进入去重表', (gB.continuation.deliveredEventIds || []).includes('EV-D1'), gB.continuation.deliveredEventIds);
const runsBefore3 = runCount();
const rep3 = await sup('w-ext').tickOnce();
const exec3 = rep3.executed.find((e: any) => e.goalId === goalD.goalId);
check('Supervisor 下一轮真的继续了这个 Goal (起了新 Run)', !!exec3, rep3.executed);
const runAfter3 = exec3?.runId ? await R.readRun(exec3.runId) : null;
check('新 Run 挂在同一个 Goal 上', !!runAfter3 && runAfter3.goalId === goalD.goalId, runAfter3?.goalId);
check('确实多了 1 条 Run', runCount() === runsBefore3 + 1, { before: runsBefore3, after: runCount() });
check('Run 里留下"消费外部结果"的步骤', JSON.stringify(runAfter3?.steps || []).includes('external_reply'), (runAfter3?.steps || []).map((s: any) => s.tool));

// ── [4] 重复事件: 同一 eventId 不再唤醒 ──────────────────────────────────────
section('[4] 重复回包 (同 eventId) → 不重复起 Run');
await G.updateGoal(goalD.goalId, { status: 'awaiting_external' });
await E.bindExternalWait(goalD.goalId, { requestId: 'REQ-D1', continuationId: 'CONT-D2', expectedSource: 'delegate', createdAt: new Date().toISOString(), expiresAt: E.defaultWaitExpiry(Date.now(), 60_000) });
const runsBefore4 = runCount();
await sendSigned('agent_delegate_result', { goalId: goalD.goalId, requestId: 'REQ-D1', continuationId: 'CONT-D2', eventId: 'EV-D1', event: 'result', resultCid: 'bafy-duplicate' });
const rep4 = await sup('w-ext').tickOnce();
check('重复事件没有产生新 Run', runCount() === runsBefore4 && !rep4.executed.some((e: any) => e.goalId === goalD.goalId), { before: runsBefore4, after: runCount(), exec: rep4.executed });

// ── [5] 真 P2P 协作回复 → 唤醒另一个 Goal ───────────────────────────────────
section('[5] 真 P2P 协作回复 → 唤醒对应 Goal');
const goalP = await G.createGoal({ objective: '等 P2P 同伴回复', channelId: 'ch-x', agentId: 'ag-x' });
await G.updateGoal(goalP.goalId, { status: 'awaiting_external' });
await E.bindExternalWait(goalP.goalId, { requestId: 'REQ-P1', continuationId: 'CONT-P1', expectedSource: 'p2p', expectedEvent: 'reply', createdAt: new Date().toISOString(), expiresAt: E.defaultWaitExpiry(Date.now(), 60_000), note: 'P2P 协作回复等待中' });
const runsBefore5 = runCount();
await sendSigned('agent_message', { goalEvent: { goalId: goalP.goalId, requestId: 'REQ-P1', continuationId: 'CONT-P1', eventId: 'EV-P1', event: 'reply', payload: { text: '我这边做完了' } } });
const gP = await G.readGoal(goalP.goalId);
check('P2P 回复被投递并唤醒 (active)', gP.status === 'active', gP.status);
const rep5 = await sup('w-ext').tickOnce();
check('Supervisor 继续了 P2P 那个 Goal', rep5.executed.some((e: any) => e.goalId === goalP.goalId), rep5.executed);
check('Run 数增加', runCount() === runsBefore5 + 1, { before: runsBefore5, after: runCount() });

// ── [6] 超时: 转 needs_human, 不再自动跑 ────────────────────────────────────
section('[6] 外部等待超时 → 明确转人工 (不无限等)');
const goalT = await G.createGoal({ objective: '等一个永远不会来的外部事件', channelId: 'ch-x', agentId: 'ag-x' });
await G.updateGoal(goalT.goalId, { status: 'awaiting_external' });
await E.bindExternalWait(goalT.goalId, { requestId: 'REQ-T1', continuationId: 'CONT-T1', expectedSource: 'delegate', createdAt: new Date(Date.now() - 90_000).toISOString(), expiresAt: new Date(Date.now() - 60_000).toISOString(), note: '故意过期' });
const exp = await E.expireExternalWaits();
const gT = await G.readGoal(goalT.goalId);
check('超时被识别', exp.some((x: any) => x.goalId === goalT.goalId), exp.map((x: any) => x.goalId));
check('Goal 转 needs_human (明确状态)', gT.status === 'needs_human', gT.status);
check('autoContinue=false (不会被人以外的力量放活)', gT.continuation.autoContinue === false, gT.continuation.autoContinue);
check('等待事实已清 + 留下超时原因', !gT.continuation.external && /超时/.test(String(gT.continuation.lastExternalTimeout)), gT.continuation.lastExternalTimeout);
const runsOfGoalT = () => ((fs.existsSync(path.join(BHOME, 'goals', `${goalT.goalId}.json`)) ? JSON.parse(fs.readFileSync(path.join(BHOME, 'goals', `${goalT.goalId}.json`), 'utf8')).runs : []) || []).length;
const tRunsBefore = runsOfGoalT();
const rep6 = await sup('w-ext').tickOnce();
check('超时后不再自动跑这个 Goal', !rep6.executed.some((e: any) => e.goalId === goalT.goalId), rep6.executed);
check('这个 Goal 没有新增 Run (其他 Goal 正常继续不算错)', runsOfGoalT() === tRunsBefore, { before: tRunsBefore, after: runsOfGoalT() });

// ── [7] 过期事件也不能唤醒 ─────────────────────────────────────────────────
section('[7] 过期事件即使刚好匹配也不唤醒 (expired)');
const goalE = await G.createGoal({ objective: '等待已过期', channelId: 'ch-x', agentId: 'ag-x' });
await G.updateGoal(goalE.goalId, { status: 'awaiting_external' });
await E.bindExternalWait(goalE.goalId, { requestId: 'REQ-E1', continuationId: 'CONT-E1', expectedSource: 'delegate', createdAt: new Date(Date.now() - 90_000).toISOString(), expiresAt: new Date(Date.now() - 1_000).toISOString() });
const lateRes = await E.deliverExternalEvent({ source: 'delegate', eventId: 'EV-LATE', requestId: 'REQ-E1' });
check('过期投递被拒 (expired)', lateRes.reason === 'expired', lateRes);
check('Goal 没有被唤醒', (await G.readGoal(goalE.goalId)).status === 'awaiting_external');

console.log(`\n=== 结果: ${passed} passed, ${failed} failed ===`);
console.log(`隔离 HOME: ${HOME}`);
process.exit(failed === 0 ? 0 : 1);
}

await main();
