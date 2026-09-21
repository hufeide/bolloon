/**
 * task-frame-server.ts — bolloon-task/1 任务帧接收端 (P3, 2026-09-21)
 *
 * 把 `task-transport` 发来的帧 (request / accept / reject / result) 接到**本机收件箱与台账**:
 *   · 每个信封都**必须过验签** (`verifyTaskEnvelope` + 帧里带来的公钥), 验不过 → 如实拒, 不落盘;
 *   · `task_request` 只落**待处理收件箱** (`~/.bolloon/tasks/inbox/`): 不执行、不付款、不自动接单;
 *   · 状态推进一律走 `task-contract.checkTaskMove` (非法迁移拒绝, 不静默修正);
 *   · 与 `agent-delegate-server` 同一套 express + JSON 形状 (薄; 不含业务判断)。
 *
 * 起法 (E2E / 长跑节点):
 *   npx tsx scripts/task-frame-node.ts --port 54901 --home /tmp/nodeA
 *
 * 安全口径 (如实): 收帧端点**不设身份认证** —— 它就是一个"信箱": 收到的东西一律先验签, 再只能落
 * 待处理收件箱 (没有任何执行/付款副作用)。要不要接单是**本机用户**用 `bolloon task accept` 决定的事。
 */

import express from 'express';
import {
  validateTaskRequest, verifyTaskEnvelope,
  checkTaskMove, type TaskRequest, type TaskAccept, type TaskReject, type TaskResult, type TaskState,
} from '../agents/task-contract.js';
import { verifierFor } from '../agents/local-signer.js';
import {
  saveIncomingRequest, readInboxItem, patchInboxItem,
  readLocalTask, patchLocalTask, saveLocalTask, saveResult, saveBody, listInbox,
} from '../agents/task-inbox.js';
import { parseTaskFrame, type TaskFrame } from '../agents/task-transport.js';

export interface TaskFrameHandlerOptions {
  /** 隔离 HOME (验收/多进程 E2E 用); 缺省 = 真实 HOME */
  home?: string;
  /** 本节点 DID (公开; 只用于回执/诊断, 不参与验签) */
  selfDid?: string;
  /** 本节点能声明的能力 (只影响"能力未知"这个提示, 不影响落盘) */
  capabilities?: string[];
}

export interface FrameReply {
  ok: boolean;
  /** 如实说明这次到底发生了什么 (收下了什么 / 为什么拒) */
  note?: string;
  error?: string;
  detail?: string;
  duplicate?: boolean;
  /** 对端可用的机器事实 */
  facts?: Record<string, unknown>;
}

/** 校验一帧的信封签名 (帧里带的是公钥 hex; 这是公开材料, 不涉及任何私钥) */
async function verifyFrame(frame: TaskFrame): Promise<boolean> {
  const v = verifierFor(frame.signer?.publicKeyHex || '');
  if (!v) return false;
  return await verifyTaskEnvelope(frame.envelope as any, v as any);
}

/** 按 14 态状态机逐步推进 (非法就停, 返回停在哪一步) */
function advance(state: TaskState, steps: TaskState[]): { state: TaskState; applied: TaskState[]; rejected?: string } {
  let cur = state;
  const applied: TaskState[] = [];
  for (const to of steps) {
    if (cur === to) continue;
    const mv = checkTaskMove(cur, to);
    if (!mv.ok) return { state: cur, applied, rejected: mv.reason };
    cur = to;
    applied.push(to);
  }
  return { state: cur, applied };
}

/**
 * 处理一帧 —— 唯一入口 (HTTP / iroh / 测试都走这里, 语义只有一套)。
 */
export async function handleTaskFrame(frame: TaskFrame, opts: TaskFrameHandlerOptions = {}): Promise<FrameReply> {
  const home = opts.home;
  const env: any = frame.envelope;
  const verified = await verifyFrame(frame);

  switch (frame.frame) {
    case 'task_request': {
      if (!verified) {
        return { ok: false, error: 'SIGNATURE_INVALID', detail: '任务请求信封验签不过 (用帧里 signer.publicKeyHex 验的), 不落盘' };
      }
      const req = env as TaskRequest;
      const v = validateTaskRequest(req, { now: Date.now() });
      if (!v.ok) {
        // 契约层说不行 → 如实拒 (版本/字段/预算/deadline/签名逐条在 issues 里)
        return { ok: false, error: 'INVALID_REQUEST', detail: v.issues.join('; ').slice(0, 400) };
      }
      const saved = saveIncomingRequest(req, {
        home,
        requestVerified: true,
        buyerPublicKeyHex: frame.signer.publicKeyHex,
        replyTo: frame.replyTo || null,
      });
      if (!saved.ok) return { ok: false, error: 'INBOX_WRITE_FAILED', detail: saved.error };
      const known = !opts.capabilities?.length || opts.capabilities.includes(req.capability);
      return {
        ok: true,
        duplicate: saved.dup,
        note: saved.dup
          ? `同一 requestId 已在收件箱 (幂等: 不重复接受/不重复执行/不重复收费) — ${saved.reason}`
          : `已落待处理收件箱 (不执行、不付款、不自动接单)${known ? '' : ` · 本机没有声明能力 '${req.capability}' (接单时会被拒)`}`,
        facts: { requestId: req.requestId, taskId: req.taskId, state: saved.item?.state ?? 'pending', receivedAt: saved.item?.receivedAt },
      };
    }

    case 'task_accept': {
      if (!verified) return { ok: false, error: 'SIGNATURE_INVALID', detail: '接受回执验签不过' };
      const acc = env as TaskAccept;
      const cur = readLocalTask(acc.requestId, home);
      if (!cur) {
        // 没有本地台账: 只存回执本身, 并如实标注"没有对应台账"
        const rec = {
          protocol: 'bolloon-task/1' as const,
          requestId: acc.requestId,
          taskId: acc.taskId,
          capability: '',
          instruction: '',
          buyerDid: '',
          providerDid: acc.providerDid,
          target: frame.signer.did,
          transportKind: 'inbound',
          state: 'accepted' as TaskState,
          sentAt: frame.sentAt,
          updatedAt: Date.now(),
          requestSignature: '',
          accept: acc,
          notes: ['本机没有对应的本地任务台账 (只存了对端回执; 不伪造本地发送记录)'],
        };
        saveLocalTask(rec, home);
        return { ok: true, note: '已存对端接受回执 (本机没有对应的本地台账)', facts: { requestId: acc.requestId, state: 'accepted' } };
      }
      const mv = advance(cur.state, ['accepted']);
      if (mv.rejected) {
        return { ok: false, error: 'TASK_TRANSITION_REJECTED', detail: `对端回执 accepted 与本机状态 ${cur.state} 不合: ${mv.rejected}` };
      }
      patchLocalTask(acc.requestId, { state: mv.state, accept: acc, providerPublicKeyHex: frame.signer.publicKeyHex, notes: [...cur.notes, `收到接受回执 ${new Date(frame.sentAt).toISOString()}`] }, home);
      const inb = readInboxItem(acc.requestId, home);
      if (inb) patchInboxItem(acc.requestId, { state: 'accepted', accept: acc, providerPublicKeyHex: frame.signer.publicKeyHex }, home);
      return { ok: true, note: `接受回执已入库 (state=${mv.state})`, facts: { requestId: acc.requestId, state: mv.state } };
    }

    case 'task_reject': {
      if (!verified) return { ok: false, error: 'SIGNATURE_INVALID', detail: '拒绝回执验签不过' };
      const rej = env as TaskReject;
      const cur = readLocalTask(rej.requestId, home);
      if (!cur) {
        return { ok: true, note: '收到拒绝对端回执, 本机没有对应台账 (不伪造)', facts: { requestId: rej.requestId, state: 'rejected', reason: rej.reason } };
      }
      const mv = advance(cur.state, ['rejected']);
      if (mv.rejected) return { ok: false, error: 'TASK_TRANSITION_REJECTED', detail: `对端回执 rejected 与本机状态 ${cur.state} 不合: ${mv.rejected}` };
      patchLocalTask(rej.requestId, { state: mv.state, reject: rej, notes: [...cur.notes, `被拒: ${String(rej.reason).slice(0, 200)}`] }, home);
      const inb = readInboxItem(rej.requestId, home);
      if (inb) patchInboxItem(rej.requestId, { state: 'rejected', reject: rej }, home);
      return { ok: true, note: `拒绝回执已入库 (state=${mv.state})`, facts: { requestId: rej.requestId, state: mv.state, reason: rej.reason } };
    }

    case 'task_result': {
      if (!verified) return { ok: false, error: 'SIGNATURE_INVALID', detail: '结果信封验签不过 (不落地未验签的结果)' };
      const res = env as TaskResult;
      // ① 存结果信封 (真实内容哈希/CID + 签名)
      const w = saveResult(res, home);
      if (!w.ok) return { ok: false, error: 'RESULT_WRITE_FAILED', detail: w.error };
      // ② 正文 (若随帧带来): 落**私有一层**, 并用签名里的 contentHash 复核
      let bodyFacts: Record<string, unknown> = { bodyPresent: false };
      if (typeof frame.body === 'string' && frame.body.length) {
        const saved = saveBody(res.taskId, frame.body, home);
        const matches = !!saved.contentHash && !!res.contentHash && saved.contentHash === res.contentHash;
        bodyFacts = {
          bodyPresent: true,
          bodyBytes: saved.bytes,
          bodyHashMatches: matches,
          bodyNote: matches ? '正文哈希与签名里的 contentHash 一致' : '正文哈希与签名里的 contentHash **不一致** (如实记录)',
        };
      }
      // ③ 状态推进: submitted/accepted → running → delivered (逐条过 checkTaskMove)
      const cur = readLocalTask(res.requestId, home);
      if (cur) {
        const mv = advance(cur.state, ['accepted', 'running', 'delivered']);
        if (mv.rejected) return { ok: false, error: 'TASK_TRANSITION_REJECTED', detail: `结果回执与本机状态 ${cur.state} 不合: ${mv.rejected}` };
        patchLocalTask(res.requestId, {
          state: mv.state, result: res, resultVerified: verified,
          providerPublicKeyHex: frame.signer.publicKeyHex,
          notes: [...cur.notes, `收到结果 ${new Date(frame.sentAt).toISOString()} (contentHash=${(res.contentHash || '').slice(0, 12)}…)`],
        }, home);
        const inb = readInboxItem(res.requestId, home);
        if (inb) patchInboxItem(res.requestId, { state: 'delivered', result: res, resultVerified: verified, providerPublicKeyHex: frame.signer.publicKeyHex }, home);
        return { ok: true, note: `结果已入库 (state=${mv.state}, 签名验过=${verified})`, facts: { requestId: res.requestId, taskId: res.taskId, state: mv.state, protocolVerified: verified, ...bodyFacts } };
      }
      const inb = readInboxItem(res.requestId, home);
      if (inb) {
        patchInboxItem(res.requestId, { state: 'delivered', result: res, resultVerified: verified, providerPublicKeyHex: frame.signer.publicKeyHex }, home);
        return { ok: true, note: `结果已入库到收件箱条目 (state=delivered)`, facts: { requestId: res.requestId, taskId: res.taskId, protocolVerified: verified, ...bodyFacts } };
      }
      return { ok: true, note: '结果信封已存, 但本机没有对应的请求/台账 (不伪造状态)', facts: { taskId: res.taskId, protocolVerified: verified, ...bodyFacts } };
    }

    default:
      return { ok: false, error: 'UNKNOWN_FRAME', detail: `未知帧类型: ${String((frame as any).frame)}` };
  }
}

/** express app: POST /api/task/frame + GET /api/task/health */
export function createTaskFrameApp(opts: TaskFrameHandlerOptions = {}): express.Express {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/task/health', (_req, res) => {
    res.json({
      ok: true,
      schema: 'bolloon-task-frame/1',
      selfDid: opts.selfDid || null,
      capabilities: opts.capabilities || [],
      inboxPending: listInbox(opts.home).filter((i) => i.state === 'pending').length,
      note: '任务帧端点 (只落待处理收件箱; 不执行、不付款)',
    });
  });

  app.post('/api/task/frame', async (req, res) => {
    const raw = (req.body as any)?.frame;
    if (!raw) return res.status(400).json({ ok: false, error: 'BAD_FRAME', detail: '缺 frame' });
    const parsed = parseTaskFrame(typeof raw === 'string' ? raw : JSON.stringify(raw));
    if (!parsed.ok) return res.status(400).json({ ok: false, error: 'BAD_FRAME', detail: parsed.error });
    try {
      const reply = await handleTaskFrame(parsed.frame, opts);
      // 帧级失败用 200 + ok:false 表达 (与 CLI 信封同一条纪律: 失败也结构化, 不靠 HTTP 状态猜)
      return res.status(200).json({ ok: reply.ok, ...(reply.duplicate !== undefined ? { duplicate: reply.duplicate } : {}), ...(reply.note ? { note: reply.note } : {}), ...(reply.error ? { error: reply.error } : {}), ...(reply.detail ? { detail: reply.detail } : {}), ...(reply.facts ? { facts: reply.facts } : {}) });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: 'HANDLER_THREW', detail: String(e?.message || e).slice(0, 300) });
    }
  });

  return app;
}
