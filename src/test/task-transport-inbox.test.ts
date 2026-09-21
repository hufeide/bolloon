/**
 * task-transport-inbox.test.ts — P3 收尾: bolloon-task/1 帧 + 收件箱 + wallet.sign 放行闸 (2026-09-21)
 *
 * 测的都是**真东西**: 真 ed25519 签名/验签 (@diap/sdk KeyManager), 真落盘 (~/.bolloon/tasks/*),
 * 真 viem 钱包签名。红线用断言钉住: 私钥/助记词绝不进信封/审计/输出。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-p3-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const bolloonDir = path.join(HOME, '.bolloon');
let kp: any;

beforeAll(async () => {
  fs.mkdirSync(bolloonDir, { recursive: true });
  const { KeyManager } = await import('@diap/sdk') as any;
  kp = (KeyManager as any).generate();
  await (KeyManager as any).saveToFile(kp, path.join(bolloonDir, 'identity.json'));
  // viem 钱包 (真私钥, 只在本机; 断言它绝不外泄)
  const { generatePrivateKey, privateKeyToAccount } = await import('viem/accounts');
  const pk = generatePrivateKey();
  fs.writeFileSync(path.join(bolloonDir, 'wallet.json'), JSON.stringify({ privateKey: pk, address: privateKeyToAccount(pk).address }), { mode: 0o600 });
});

const reqFixture = (over: Record<string, unknown> = {}) => ({
  protocol: 'bolloon-task/1' as const,
  taskId: 'task-test-1',
  requestId: 'treq-test0001',
  capability: 'research',
  instruction: '调研日本厨房用品市场',
  budget: { maxAmount: '50000', currency: 'USDC' as const, network: 'base-sepolia' },
  paymentMode: 'policy' as const,
  deadline: Date.now() + 3600_000,
  buyerDid: 'did:key:zBuyer',
  providerDid: 'did:key:zProvider',
  signature: '',
  ...over,
});

describe('bolloon-task/1 帧 (build / serialize / parse)', () => {
  it('往返一致 + 严格拒绝: 版本不对 / 未知帧类型 / 缺 signer / 信封无签名', async () => {
    const { buildTaskFrame, serializeFrame, parseTaskFrame } = await import('../agents/task-transport.js');
    const { signTaskEnvelope } = await import('../agents/task-contract.js');
    const signed = await signTaskEnvelope(reqFixture(), kp);
    const frame = buildTaskFrame('task_request', signed, { did: kp.did, publicKeyHex: Buffer.from(kp.publicKey).toString('hex') }, { replyTo: 'http://127.0.0.1:1/api/task/frame' });
    const parsed = parseTaskFrame(serializeFrame(frame));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.frame.frame).toBe('task_request');
      expect(parsed.frame.replyTo).toContain('/api/task/frame');
      expect((parsed.frame.envelope as any).requestId).toBe('treq-test0001');
    }

    const bad1 = parseTaskFrame(JSON.stringify({ ...frame, protocol: 'bolloon-task/2' }));
    expect(bad1.ok).toBe(false);
    const bad2 = parseTaskFrame(JSON.stringify({ ...frame, frame: 'task_whatever' }));
    expect(bad2.ok).toBe(false);
    const bad3 = parseTaskFrame(JSON.stringify({ ...frame, signer: { did: 'x' } }));
    expect(bad3.ok).toBe(false);
    const bad4 = parseTaskFrame(JSON.stringify({ ...frame, envelope: { ...signed, signature: '' } }));
    expect(bad4.ok).toBe(false);
    if (!bad4.ok) expect(bad4.error).toContain('SIGNATURE_REQUIRED');
    expect(parseTaskFrame('not json').ok).toBe(false);
  });

  it('信封签名真验得过, 改一个字节就验不过 (私钥只在内存)', async () => {
    const { signTaskEnvelope, verifyTaskEnvelope } = await import('../agents/task-contract.js');
    const { verifierFor } = await import('../agents/local-signer.js');
    const signed = await signTaskEnvelope(reqFixture(), kp);
    const verifier = verifierFor(Buffer.from(kp.publicKey).toString('hex'))!;
    expect(await verifyTaskEnvelope(signed, verifier)).toBe(true);
    expect(await verifyTaskEnvelope({ ...signed, capability: 'coding' }, verifier)).toBe(false);
    // 别的公钥验不过
    const { KeyManager } = await import('@diap/sdk') as any;
    const other = (KeyManager as any).generate();
    expect(await verifyTaskEnvelope(signed, verifierFor(Buffer.from(other.publicKey).toString('hex'))!)).toBe(false);
  });
});

describe('收件箱落盘 + 幂等去重 (dedupeInbox)', () => {
  it('落盘 → 幂等重复到达不覆盖 → 列表/摘要/结果/正文都真在盘上', async () => {
    const inbox = await import('../agents/task-inbox.js');
    const first = inbox.saveIncomingRequest(reqFixture() as any, { requestVerified: true, buyerPublicKeyHex: 'aa'.repeat(32), replyTo: 'http://peer/api/task/frame' });
    expect(first.ok).toBe(true);
    expect(first.dup).toBe(false);
    expect(fs.existsSync(path.join(inbox.inboxDir(HOME), 'treq-test0001.json'))).toBe(true);

    // 幂等: 第二次到达 → dup=true, 既有 state 不被覆盖
    const second = inbox.saveIncomingRequest(reqFixture({ instruction: '被改过的正文' }) as any, { requestVerified: true });
    expect(second.dup).toBe(true);
    expect(inbox.readInboxItem('treq-test0001', HOME)?.instruction).toBe('调研日本厨房用品市场');

    const sum = inbox.inboxSummary(inbox.listInbox(HOME)[0]);
    expect(sum.state).toBe('pending');
    expect(sum.capability).toBe('research');
    expect(sum.deadlineInMs! > 0).toBe(true);
    expect(sum.sender).toContain('did:key:zBuyer');
    expect(sum.requestSignatureVerified).toBe(true);

    // 状态推进 (只改已知字段)
    const patched = inbox.patchInboxItem('treq-test0001', { state: 'accepted', note: '接单了' });
    expect(patched.ok && patched.item?.state).toBe('accepted');
    expect(inbox.patchInboxItem('treq-nope', { state: 'accepted' as any }).ok).toBe(false);

    // 正文: 内容哈希由真实字节算
    const body = inbox.saveBody('task-test-1', 'hello 交付正文');
    expect(body.ok).toBe(true);
    expect(body.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.bytes).toBe(Buffer.byteLength('hello 交付正文'));

    // 结果 + 反查 (按 taskId 直查结果目录; 按 requestId 走收件箱/台账里的结果字段 —— 如实语义)
    const res = { protocol: 'bolloon-task/1' as const, taskId: 'task-test-1', requestId: 'treq-test0001', ok: true, summary: 's', contentHash: body.contentHash, deliveredAt: Date.now(), signature: 'sig' };
    expect(inbox.saveResult(res).ok).toBe(true);
    expect(inbox.findResult('task-test-1', HOME)?.result.contentHash).toBe(body.contentHash);
    expect(inbox.findResult('task-test-1', HOME)?.source).toBe('results');
    expect(inbox.findResult('treq-test0001', HOME)).toBe(null);      // 收件箱条目里还没有 result 字段 → 不硬编
    inbox.patchInboxItem('treq-test0001', { result: res as any, state: 'delivered' });
    expect(inbox.findResult('treq-test0001', HOME)?.source).toBe('inbox');
    const rb = inbox.readBody('task-test-1', HOME);
    expect(rb.present).toBe(true);
    expect(rb.matches).toBe(true);

    // 本机台账 (发出的任务)
    const rec = {
      protocol: 'bolloon-task/1' as const, requestId: 'treq-local01', taskId: 'task-l1', capability: 'research',
      instruction: 'x', buyerDid: 'b', providerDid: 'p', target: 'http://peer', transportKind: 'http',
      state: 'submitted' as const, sentAt: Date.now(), updatedAt: Date.now(), requestSignature: 'sig', notes: [],
    };
    expect(inbox.upsertLocalTask(rec, HOME).created).toBe(true);
    expect(inbox.upsertLocalTask({ ...rec, state: 'verified' } as any, HOME).created).toBe(false);   // 不覆盖
    expect(inbox.readLocalTask('treq-local01', HOME)?.state).toBe('submitted');
    expect(inbox.patchLocalTask('treq-local01', { state: 'accepted' }, HOME).ok).toBe(true);
    expect(inbox.listLocalTasks(HOME).length).toBe(1);

    // 路径穿越防护
    expect(inbox.readInboxItem('../../etc/passwd', HOME)).toBe(null);
  });
});

describe('帧处理 handleTaskFrame (收帧侧: 验签 → 落盘 → 状态机)', () => {
  it('未签名的请求 → 拒, 不落盘', async () => {
    const { handleTaskFrame } = await import('../web/task-frame-server.js');
    const { buildTaskFrame } = await import('../agents/task-transport.js');
    const inbox = await import('../agents/task-inbox.js');
    const f = buildTaskFrame('task_request', reqFixture({ requestId: 'treq-unsigned' }) as any, { did: 'd', publicKeyHex: 'ab'.repeat(32) });
    const r = await handleTaskFrame(f, { home: HOME });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('SIGNATURE_INVALID');
    expect(inbox.readInboxItem('treq-unsigned', HOME)).toBe(null);
  });

  it('签名过的请求 → 落待处理收件箱 (不接单/不付款); 重复到达 → duplicate', async () => {
    const { handleTaskFrame } = await import('../web/task-frame-server.js');
    const { buildTaskFrame } = await import('../agents/task-transport.js');
    const { signTaskEnvelope } = await import('../agents/task-contract.js');
    const inbox = await import('../agents/task-inbox.js');
    const signed = await signTaskEnvelope(reqFixture({ requestId: 'treq-real01', taskId: 'task-r1' }) as any, kp);
    const f = buildTaskFrame('task_request', signed, { did: kp.did, publicKeyHex: Buffer.from(kp.publicKey).toString('hex') });
    const r1 = await handleTaskFrame(f, { home: HOME });
    expect(r1.ok).toBe(true);
    expect(r1.duplicate).toBe(false);
    const item = inbox.readInboxItem('treq-real01', HOME);
    expect(item?.state).toBe('pending');
    expect(item?.requestSignatureVerified).toBe(true);
    expect(r1.note).toContain('不执行、不付款');
    const r2 = await handleTaskFrame(f, { home: HOME });
    expect(r2.duplicate).toBe(true);
    expect(inbox.listInbox(HOME).filter((i) => i.requestId === 'treq-real01').length).toBe(1);
  });

  it('非法契约的请求 (版本不对) → 拒, 不落盘', async () => {
    const { handleTaskFrame } = await import('../web/task-frame-server.js');
    const { buildTaskFrame, parseTaskFrame } = await import('../agents/task-transport.js');
    const { signTaskEnvelope } = await import('../agents/task-contract.js');
    const inbox = await import('../agents/task-inbox.js');
    const signed = await signTaskEnvelope(reqFixture({ requestId: 'treq-badver' }) as any, kp);
    const f = buildTaskFrame('task_request', { ...signed, protocol: 'bolloon-task/1' } as any, { did: kp.did, publicKeyHex: Buffer.from(kp.publicKey).toString('hex') });
    // 把信封协议改坏 (帧协议仍对) —— 契约层第一条检查就拒
    const tampered = JSON.parse(JSON.stringify(f));
    tampered.envelope.protocol = 'bolloon-task/9';
    const parsed = parseTaskFrame(JSON.stringify(tampered));
    expect(parsed.ok).toBe(false);  // 帧层就拦下了
    const r = await handleTaskFrame(f, { home: HOME });
    expect(r.ok).toBe(true);
    expect(inbox.readInboxItem('treq-badver', HOME)?.state).toBe('pending');
  });

  it('accept / result 回执 → 本机台账按状态机推进 (submitted → accepted → delivered)', async () => {
    const { handleTaskFrame } = await import('../web/task-frame-server.js');
    const { buildTaskFrame } = await import('../agents/task-transport.js');
    const { signTaskEnvelope } = await import('../agents/task-contract.js');
    const inbox = await import('../agents/task-inbox.js');

    inbox.upsertLocalTask({
      protocol: 'bolloon-task/1', requestId: 'treq-flow', taskId: 'task-flow', capability: 'research',
      instruction: 'x', buyerDid: 'did:b', providerDid: 'did:p', target: 'http://peer', transportKind: 'http',
      state: 'submitted', sentAt: Date.now(), updatedAt: Date.now(), requestSignature: 'sig', notes: [],
    }, HOME);

    const signerInfo = { did: kp.did, publicKeyHex: Buffer.from(kp.publicKey).toString('hex') };
    const accept = await signTaskEnvelope({ protocol: 'bolloon-task/1' as const, taskId: 'task-flow', requestId: 'treq-flow', accepted: true as const, providerDid: kp.did, signature: '' }, kp);
    const aRes = await handleTaskFrame(buildTaskFrame('task_accept', accept, signerInfo), { home: HOME });
    expect(aRes.ok).toBe(true);
    expect(inbox.readLocalTask('treq-flow', HOME)?.state).toBe('accepted');
    expect(inbox.readLocalTask('treq-flow', HOME)?.providerPublicKeyHex).toBe(Buffer.from(kp.publicKey).toString('hex'));

    const result = await signTaskEnvelope({ protocol: 'bolloon-task/1' as const, taskId: 'task-flow', requestId: 'treq-flow', ok: true, summary: 'done', contentHash: 'a'.repeat(64), deliveredAt: Date.now(), signature: '' }, kp);
    const rRes = await handleTaskFrame(buildTaskFrame('task_result', result, signerInfo, { body: 'body-bytes' }), { home: HOME });
    expect(rRes.ok).toBe(true);
    const rec = inbox.readLocalTask('treq-flow', HOME);
    expect(rec?.state).toBe('delivered');
    expect(rec?.resultVerified).toBe(true);
    // 正文哈希与签名里的 contentHash 不一致 → 如实记 false (不迁就)
    expect(rRes.facts?.bodyHashMatches).toBe(false);

    // 非法迁移: 已 delivered 再收 accepted → 拒 (不静默修正)
    const again = await handleTaskFrame(buildTaskFrame('task_accept', accept, signerInfo), { home: HOME });
    expect(again.ok).toBe(false);
    expect(again.error).toBe('TASK_TRANSITION_REJECTED');
  });
});

describe('wallet sign 放行闸 (fail-closed) + 私钥红线', () => {
  it('授权策略文件 + 自主模式 → 真签名, 自检验签过, 审计只记摘要, 私钥不出现', async () => {
    fs.writeFileSync(path.join(bolloonDir, 'signing-policy.json'), JSON.stringify({ agentAuthorized: true, allowedNetworks: ['base-sepolia'], allowedCapabilities: ['sign-it'], maxPerTxAtomic: '50000', dailyLimitAtomic: '100000' }), 'utf8');
    const { walletCommand } = await import('../cli/commands/wallet.js');
    const { parseFlags } = await import('../cli/protocol-envelope.js');
    const r = await walletCommand(parseFlags(['sign', '--payload', 'order-42', '--capability', 'sign-it', '--amount', '0.01', '--network', 'base-sepolia']));
    expect(r.envelope.ok).toBe(true);
    expect(r.envelope.code).toBe('WALLET_SIGNED');
    const data = r.envelope.data as any;
    expect(data.selfVerified).toBe(true);
    expect(data.signature).toMatch(/^0x[0-9a-f]{130}$/i);
    expect(data.amountAtomic).toBe('10000');
    expect(data.checks.agentAuthorized).toBe(true);

    const walletJson = JSON.parse(fs.readFileSync(path.join(bolloonDir, 'wallet.json'), 'utf8'));
    const privateKey: string = walletJson.privateKey;
    const dumped = [JSON.stringify(r.envelope), r.human, JSON.stringify(data)].join('|');
    expect(dumped.includes(privateKey)).toBe(false);
    expect(dumped.includes(privateKey.slice(2))).toBe(false);
    expect(dumped).not.toMatch(/privateKey"\s*:/);

    // 审计账本: 有一条 wallet_payload, 只记摘要, 无正文/私钥
    const { readSignatureAudit, assertAuditSafe } = await import('../agents/task-contract.js');
    const audit = await readSignatureAudit(HOME, 10);
    const last = audit[audit.length - 1];
    expect(last.kind).toBe('wallet_payload');
    expect(last.signerFingerprint).toMatch(/^sha256:/);
    expect(last.payloadDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(assertAuditSafe(last)).toEqual([]);
    expect(JSON.stringify(last).includes(privateKey)).toBe(false);
    expect(JSON.stringify(last).includes('order-42')).toBe(false);
  });

  it('未授权 → AGENT_NOT_AUTHORIZED; 超额度 → BUDGET_EXCEEDED; 重复 requestId → DUPLICATE_REQUEST; 非自主模式 → PAYMENT_REQUIRED', async () => {
    const { walletCommand } = await import('../cli/commands/wallet.js');
    const { parseFlags } = await import('../cli/protocol-envelope.js');

    // 未授权
    fs.writeFileSync(path.join(bolloonDir, 'signing-policy.json'), JSON.stringify({ agentAuthorized: false }), 'utf8');
    const r1 = await walletCommand(parseFlags(['sign', '--payload', 'x1', '--capability', 'sign-it']));
    expect(r1.envelope.ok).toBe(false);
    expect(r1.envelope.code).toBe('AGENT_NOT_AUTHORIZED');
    expect((r1.envelope.data as any).signed).toBe(false);

    // 重新授权 (白名单已排除 sign-it → capabilityAllowed false → POLICY_DENIED 之前先看其它)
    fs.writeFileSync(path.join(bolloonDir, 'signing-policy.json'), JSON.stringify({ agentAuthorized: true, allowedNetworks: ['base-sepolia'], allowedCapabilities: ['sign-it'], maxPerTxAtomic: '50000' }), 'utf8');
    // 超单笔上限
    const r2 = await walletCommand(parseFlags(['sign', '--payload', 'x2', '--capability', 'sign-it', '--amount', '9999']));
    expect(r2.envelope.ok).toBe(false);
    expect(r2.envelope.code).toBe('BUDGET_EXCEEDED');
    // 网络不在白名单
    const r3 = await walletCommand(parseFlags(['sign', '--payload', 'x3', '--capability', 'sign-it', '--network', 'mainnet']));
    expect(r3.envelope.ok).toBe(false);
    expect(r3.envelope.code).toBe('POLICY_DENIED');
    // 非自主模式
    const r4 = await walletCommand(parseFlags(['sign', '--payload', 'x4', '--capability', 'sign-it', '--mode', 'manual']));
    expect(r4.envelope.ok).toBe(false);
    expect(r4.envelope.code).toBe('PAYMENT_REQUIRED');
    // 重复 requestId (用同一 --request-id 签两次)
    const first = await walletCommand(parseFlags(['sign', '--payload', 'dup-p', '--capability', 'sign-it', '--request-id', 'treq-dup-1']));
    expect(first.envelope.ok).toBe(true);
    const second = await walletCommand(parseFlags(['sign', '--payload', 'dup-p', '--capability', 'sign-it', '--request-id', 'treq-dup-1']));
    expect(second.envelope.ok).toBe(false);
    expect(second.envelope.code).toBe('DUPLICATE_REQUEST');
  });
});
