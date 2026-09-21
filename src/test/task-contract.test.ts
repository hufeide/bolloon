import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as TC from '../agents/task-contract.js';
import { SETTLEMENT_FACTS, LOCAL_DEV_MAX_FACT, CHAIN_BACKED_FACTS } from '../agents/x402/settlement-state.js';

const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-task-contract-'));

const baseReq = (over: Partial<TC.TaskRequest> = {}): TC.TaskRequest => ({
  protocol: TC.TASK_PROTOCOL,
  taskId: 'task-1',
  requestId: 'treq-abc',
  capability: 'cross-border-market-research',
  instruction: '判断这款厨房用品是否适合进入日本市场',
  budget: { maxAmount: '20000', currency: 'USDC', network: 'base-sepolia' },
  paymentMode: 'policy',
  deadline: Date.now() + 60_000,
  buyerDid: 'did:key:zBuyer',
  providerDid: 'did:key:zProvider',
  signature: 'sig-placeholder',
  ...over,
});

describe('任务状态机: 非法迁移一律拒绝', () => {
  it('合法迁移通过', () => {
    const legal: [TC.TaskState, TC.TaskState][] = [
      ['discovered', 'quoted'], ['quoted', 'submitted'], ['submitted', 'accepted'],
      ['accepted', 'payment_required'], ['payment_required', 'paying'], ['paying', 'paid'],
      ['paid', 'running'], ['running', 'delivered'], ['delivered', 'verified'],
    ];
    for (const [a, b] of legal) expect(TC.checkTaskMove(a, b), `${a}→${b}`).toMatchObject({ ok: true });
  });

  it('非法迁移被拒绝且给出原因 (不静默修正)', () => {
    const illegal: [TC.TaskState, TC.TaskState][] = [
      ['discovered', 'paid'], ['quoted', 'verified'], ['paying', 'verified'],
      ['delivered', 'paid'], ['verified', 'running'], ['policy_denied', 'quoted'],
      ['rejected', 'accepted'], ['cancelled', 'submitted'], ['failed', 'running'],
    ];
    for (const [a, b] of illegal) {
      const r = TC.checkTaskMove(a, b);
      expect(r.ok, `${a}→${b} 应被拒`).toBe(false);
      expect(r.reason).toMatch(/非法任务迁移/);
    }
  });

  it('终态没有出边; 自迁移是空操作', () => {
    for (const s of TC.TASK_TERMINAL_STATES) expect(TC.TASK_TRANSITIONS[s]).toEqual([]);
    for (const s of TC.TASK_STATES) expect(TC.checkTaskMove(s, s).ok).toBe(true);
  });

  it('付款不确定 → 允许回到 payment_required (不当失败), 但 paying→verified 不允许', () => {
    expect(TC.checkTaskMove('paying', 'payment_required').ok).toBe(true);
    expect(TC.checkTaskMove('paying', 'verified').ok).toBe(false);
  });
});

describe('支付事实: 与 settlement-state 同一套 + local-dev 红线', () => {
  it('事实集合与 settlement-state 完全一致 (防两套口径漂移)', () => {
    expect([...TC.TASK_PAYMENT_FACTS].sort()).toEqual([...SETTLEMENT_FACTS].sort());
  });

  it('maxFactForMode 与 settlement-state 的常量对齐', () => {
    expect(TC.maxFactForMode('local-dev')).toBe(LOCAL_DEV_MAX_FACT);
    expect(CHAIN_BACKED_FACTS).toContain(TC.maxFactForMode('facilitator'));
    expect(TC.maxFactForMode('none')).toBe('unpaid');
  });

  it('local-dev 永远不算任务成功; 链上结算 + verified 才算', () => {
    expect(TC.isTaskSuccessful({ state: 'verified', paymentFact: 'payment_submitted' })).toBe(false);
    expect(TC.isTaskSuccessful({ state: 'verified', paymentFact: 'fully_settled' })).toBe(true);
    expect(TC.isTaskSuccessful({ state: 'verified', paymentFact: 'unpaid' })).toBe(false);
    expect(TC.isTaskSuccessful({ state: 'delivered', paymentFact: 'fully_settled' })).toBe(false);
  });
});

describe('幂等 id: 重发不产生第二笔付款', () => {
  it('同 (正文, 能力, 买方) → 同一个 requestId; 任一变化 → 不同', () => {
    const a = TC.taskRequestId({ instruction: ' 判断日本市场 ', capability: 'research', buyerDid: 'did:key:zBuyer' });
    const b = TC.taskRequestId({ instruction: '判断日本市场', capability: 'research', buyerDid: 'did:key:zBuyer' });
    const c = TC.taskRequestId({ instruction: '判断日本市场', capability: 'research', buyerDid: 'did:key:zOther' });
    expect(a).toBe(b);
    expect(c).not.toBe(b);
    expect(b.startsWith('treq-')).toBe(true);
  });

  it('收件箱按 requestId 去重', () => {
    const inbox = [{ requestId: 'treq-1' }, { requestId: 'treq-2' }];
    expect(TC.dedupeInbox(inbox, { requestId: 'treq-1' }).dup).toBe(true);
    expect(TC.dedupeInbox(inbox, { requestId: 'treq-3' }).dup).toBe(false);
  });
});

describe('请求/报价校验', () => {
  it('合法请求通过', () => {
    const r = TC.validateTaskRequest(baseReq(), { allowedNetworks: ['base-sepolia'], maxAmountAtomic: '50000' });
    expect(r).toMatchObject({ ok: true });
  });

  it('逐条拒绝: 协议/缺字段/支付模式/浮点金额/币种/网络/超预算/过期/缺签名', () => {
    const cases: [Partial<TC.TaskRequest>, RegExp][] = [
      [{ protocol: 'bolloon-task/0' as any }, /协议版本不对/],
      [{ instruction: '' }, /缺字段 instruction/],
      [{ paymentMode: 'yolo' as any }, /支付模式非法/],
      [{ budget: { maxAmount: '0.02', currency: 'USDC', network: 'base-sepolia' } }, /正整数原子单位/],
      [{ budget: { maxAmount: '20000', currency: 'EUR' as any, network: 'base-sepolia' } }, /只支持 USDC\/ETH/],
      [{ budget: { maxAmount: '20000', currency: 'USDC', network: 'solana' } }, /网络不在允许列表/],
      [{ budget: { maxAmount: '999999', currency: 'USDC', network: 'base-sepolia' } }, /超过单笔上限/],
      [{ deadline: Date.now() - 1000 }, /deadline 已过期/],
      [{ signature: '' }, /缺签名/],
    ];
    for (const [over, re] of cases) {
      const r = TC.validateTaskRequest(baseReq(over), { allowedNetworks: ['base-sepolia'], maxAmountAtomic: '50000' });
      expect(r.ok, JSON.stringify(over)).toBe(false);
      expect(r.issues.join(' | ')).toMatch(re);
    }
  });

  it('报价与请求自洽: 篡改 taskId/requestId/capability/超预算/网络不符 → 全拒', () => {
    const req = baseReq();
    const good = { protocol: TC.TASK_PROTOCOL, taskId: 'task-1', requestId: 'treq-abc', capability: 'cross-border-market-research', amount: '12000', currency: 'USDC' as const, network: 'base-sepolia', providerDid: 'did:key:zProvider' };
    expect(TC.validateQuoteAgainstRequest(good, req).ok).toBe(true);
    const bad: [any, RegExp][] = [
      [{ ...good, taskId: 'task-9' }, /taskId 与请求不一致/],
      [{ ...good, requestId: 'treq-other' }, /回执不能跨请求复用/],
      [{ ...good, capability: 'other-capability' }, /能力与请求不一致/],
      [{ ...good, amount: '999999' }, /超过任务预算/],
      [{ ...good, network: 'base' }, /网络与预算不一致/],
      [{ ...good, amount: '0.012' }, /正整数原子单位/],
    ];
    for (const [q, re] of bad) {
      const r = TC.validateQuoteAgainstRequest(q, req);
      expect(r.ok).toBe(false);
      expect(r.issues.join(' | ')).toMatch(re);
    }
  });
});

describe('受控自主签名: 唯一放行闸 (fail-closed)', () => {
  const base: TC.WalletSignRequest = {
    mode: 'autonomous',
    agentAuthorized: true,
    amountAtomic: '12000',
    network: 'base-sepolia',
    capability: 'cross-border-market-research',
    requestId: 'treq-abc',
    signedRequestIds: [],
    allowedNetworks: ['base-sepolia'],
    allowedCapabilities: ['cross-border-market-research'],
    maxPerTxAtomic: '20000',
    spentTodayAtomic: '0',
    dailyLimitAtomic: '100000',
    walletAvailable: true,
  };

  it('受控自主签名可以放行', () => {
    expect(TC.authorizeWalletSignature(base)).toMatchObject({ allowed: true });
  });

  it('manual / policy 模式不在此闸放行 (走人工确认)', () => {
    for (const mode of ['manual', 'policy'] as const) {
      const d = TC.authorizeWalletSignature({ ...base, mode });
      expect(d.allowed).toBe(false);
      expect(d.reason).toMatch(/modeIsAutonomous/);
    }
  });

  it('未授权 / 无钱包 / 越链 / 越能力 / 越单笔 / 越日额 / 重复 requestId / 非整数金额 → 一律拒', () => {
    const bad: [Partial<TC.WalletSignRequest>, RegExp][] = [
      [{ agentAuthorized: false }, /agentAuthorized/],
      [{ walletAvailable: false }, /walletAvailable/],
      [{ network: 'ethereum' }, /networkAllowed/],
      [{ capability: 'unknown-cap' }, /capabilityAllowed/],
      [{ amountAtomic: '999999' }, /underPerTx/],
      [{ spentTodayAtomic: '95000', amountAtomic: '10000' }, /underDaily/],
      [{ signedRequestIds: ['treq-abc'] }, /notDuplicate/],
      [{ amountAtomic: '0.012' }, /amountIsInteger|underPerTx/],
    ];
    for (const [over, re] of bad) {
      const d = TC.authorizeWalletSignature({ ...base, ...over });
      expect(d.allowed, JSON.stringify(over)).toBe(false);
      expect(d.reason).toMatch(re);
    }
  });

  it('agent-authorized 模式同样受约束 (不是"随便签")', () => {
    expect(TC.authorizeWalletSignature({ ...base, mode: 'agent-authorized' }).allowed).toBe(true);
    expect(TC.authorizeWalletSignature({ ...base, mode: 'agent-authorized', agentAuthorized: false }).allowed).toBe(false);
  });
});

describe('签名与审计: 私钥不出本机, 正文不进审计', () => {
  it('签名可被同一密钥验证; 改动任一字段 → 验签失败', async () => {
    const { KeyManager } = await import('@diap/sdk') as any;
    const kp = await KeyManager.generate();
    const req = baseReq({ signature: undefined as any });
    const signed = await TC.signTaskEnvelope(req, kp);
    expect(signed.signature).toBeTruthy();
    expect(await TC.verifyTaskEnvelope(signed, kp)).toBe(true);
    expect(await TC.verifyTaskEnvelope({ ...signed, instruction: '被改过的正文' }, kp)).toBe(false);
    expect(await TC.verifyTaskEnvelope({ ...signed, budget: { maxAmount: '99999', currency: 'USDC', network: 'base-sepolia' } }, kp)).toBe(false);
    const kp2 = await KeyManager.generate();
    expect(await TC.verifyTaskEnvelope(signed, kp2)).toBe(false);
    // 编码往返: base64 解出来必须是 64 字节 (ed25519), 否则说明信封存了错东西
    expect(TC.decodeSignature(signed.signature).length).toBe(64);
    expect(await TC.verifyTaskEnvelope({}, kp)).toBe(false);
  });

  it('审计账本可写可读, 且**不含任务正文/私钥**', async () => {
    const home = mkTmp();
    await TC.recordSignatureAudit({
      kind: 'task_payment', mode: 'autonomous', requestId: 'treq-abc', taskId: 'task-1',
      amountAtomic: '12000', currency: 'USDC', network: 'base-sepolia',
      capability: 'cross-border-market-research', signerFingerprint: 'fp-1234', payloadDigest: 'sha256:deadbeef',
    }, home);
    const rows = await TC.readSignatureAudit(home, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ requestId: 'treq-abc', mode: 'autonomous', amountAtomic: '12000' });
    const raw = fs.readFileSync(path.join(home, '.bolloon', 'wallet-signatures.jsonl'), 'utf8');
    expect(raw).not.toMatch(/判断这款厨房用品/);
    expect(raw).not.toMatch(/privateKey|mnemonic|BEGIN .*PRIVATE KEY/);
    expect(TC.assertAuditSafe(rows[0])).toEqual([]);
  });

  it('assertAuditSafe 能抓出混进审计的敏感键', () => {
    expect(TC.assertAuditSafe({ ok: 1, privateKey: 'x' })).toContain('$.privateKey 不该出现在签名审计里');
    expect(TC.assertAuditSafe({ nested: { instruction: '任务正文' } })).toContain('$.nested.instruction 不该出现在签名审计里');
  });
});

describe('公开投影: 只给粗粒度, 不给私人信息', () => {
  it('金额只以区间出现', () => {
    expect(TC.amountBucket('9999')).toBe('tiny');
    expect(TC.amountBucket('12000')).toBe('small');
    expect(TC.amountBucket('500000')).toBe('medium');
    expect(TC.amountBucket('2000000')).toBe('large');
    expect(TC.amountBucket('abc')).toBe('tiny');
  });

  it('摘要含 capability 粗类别 + 区间 + 结算口径, 不含正文/DID/精确金额', () => {
    const s = TC.toPublicSummary(
      { state: 'verified', capability: 'cross-border-market-research', amountAtomic: '12000', paymentFact: 'fully_settled', paymentMode: 'facilitator' },
      { capabilityGroupOf: () => 'research' },
    );
    expect(s).toMatchObject({ kind: 'trade_verified', capabilityGroup: 'research', amountBucket: 'small', settlement: 'chain' });
    const json = JSON.stringify(s);
    expect(json).not.toMatch(/12000|did:|判断这款/);
  });

  it('local-dev 投影明确标 local-dev, 不冒充链上', () => {
    const s = TC.toPublicSummary({ state: 'delivered', capability: 'research', amountAtomic: '12000', paymentFact: 'payment_submitted', paymentMode: 'local-dev' });
    expect(s.settlement).toBe('local-dev');
    expect(s.kind).toBe('task_completed');
    const t = TC.toPublicSummary({ state: 'accepted', capability: 'research' });
    expect(t).toMatchObject({ kind: 'task_accepted', settlement: 'none' });
    expect(t.amountBucket).toBeUndefined();
  });
});
