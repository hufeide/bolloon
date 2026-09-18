/**
 * settlement-state.test.ts — 交易两层状态 / 结算事实 / 迁移 / 责任候选 (Phase 0, 2026-09-18)
 *
 * 覆盖 leo 的 Phase 0 验收:
 *   - 所有旧状态仍可读
 *   - local-dev 永远不能产生 fully_settled
 *   - chainSettled !== true 永远不能 verified
 *   - 旧交易可迁移, 不丢事件与 evidence
 *   - 非法迁移拒绝, 不静默修正
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  LIFECYCLE_STATUSES, SETTLEMENT_FACTS, RESPONSIBILITY_TYPES,
  canTransitionLifecycle, checkLifecycleMove, canTransitionSettlement, deriveSettlementFact,
  hasPaymentEvidence, checkVerifiedPreconditions, deriveResponsibility, migrateTransactionRecord,
  writeDeliveryContent, readDeliveryContent, verifyDelivery, evaluateVerifiedGate, CURRENT_SCHEMA_VERSION,
} from '../agents/x402/settlement-state.js';
import { IllegalTransactionTransition, readTransaction, updateTransaction, setSettlementFact, beginTransaction, replayTransaction } from '../agents/x402/transaction-store.js';
import type { TransactionRecord } from '../agents/x402/transaction-protocol.js';

let HOME: string;
beforeEach(() => { HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-tx-')); });
afterEach(() => { fs.rmSync(HOME, { recursive: true, force: true }); });

const rec = (over: Partial<TransactionRecord> = {}): TransactionRecord => ({
  transactionId: 'tx-1',
  requestId: 'req-1',
  itemId: 'item-1',
  buyerDid: 'did:key:zBuyer',
  providerDid: 'did:key:zSeller',
  paymentMode: 'none',
  chainSettled: false,
  status: 'discovered',
  startedAt: new Date().toISOString(),
  events: [{ at: new Date().toISOString(), kind: 'discovered' }],
  ...over,
} as TransactionRecord);

describe('Phase 0 · 生命周期迁移表', () => {
  it('合法路径通过, 同状态是无操作', () => {
    expect(canTransitionLifecycle('discovered', 'quoted').ok).toBe(true);
    expect(canTransitionLifecycle('quoted', 'paying').ok).toBe(true);
    expect(canTransitionLifecycle('paying', 'payment_required').ok).toBe(true);   // 对账回退
    expect(canTransitionLifecycle('paying', 'delivery_failed').ok).toBe(true);
    expect(canTransitionLifecycle('delivered', 'verified').ok).toBe(true);
    expect(canTransitionLifecycle('discovered', 'delivered').ok).toBe(true);      // 免费资源
    expect(canTransitionLifecycle('paying', 'paying').noop).toBe(true);
  });

  it('非法路径被拒 (含终态不许再变)', () => {
    expect(canTransitionLifecycle('verified', 'paying').ok).toBe(false);
    expect(canTransitionLifecycle('delivery_failed', 'paying').ok).toBe(false);
    expect(canTransitionLifecycle('verification_failed', 'delivered').ok).toBe(false);
    expect(canTransitionLifecycle('policy_denied', 'paying').ok).toBe(false);
    expect(canTransitionLifecycle('discovered', 'verified').ok).toBe(false);
    expect(canTransitionLifecycle('discovered', '不存在').ok).toBe(false);
  });

  it('已经付过钱的交易不许标成普通 failed', () => {
    const paid = rec({ status: 'paying', txHash: '0xabc', settlementFact: 'payment_submitted' });
    const chk = checkLifecycleMove(paid, 'failed');
    expect(chk.ok).toBe(false);
    expect(String(chk.reason)).toContain('已有支付证据');
    // 没付过钱的失败仍然允许
    expect(checkLifecycleMove(rec({ status: 'quoted' }), 'failed').ok).toBe(true);
  });

  it('verified 必须过链上硬证据子集', () => {
    const localDev = rec({ status: 'paying', chainSettled: false, protocolVerified: true, contentHash: 'a', deliveryHash: 'a', receiptHash: 'r' });
    const chk = checkLifecycleMove(localDev, 'verified');
    expect(chk.ok).toBe(false);
    expect(String(chk.reason)).toContain('chainSettled');

    const noReceipt = rec({ status: 'paying', chainSettled: true, protocolVerified: true, contentHash: 'a', deliveryHash: 'a', settlementFact: 'fully_settled' });
    expect(checkLifecycleMove(noReceipt, 'verified').ok).toBe(false);       // 缺回执哈希

    const good = rec({ status: 'paying', chainSettled: true, protocolVerified: true, contentHash: 'a', deliveryHash: 'a', receiptHash: 'r', settlementFact: 'fully_settled' });
    expect(checkLifecycleMove(good, 'verified').ok).toBe(true);
  });

  it('状态集合与 leo 的规格一致', () => {
    expect([...LIFECYCLE_STATUSES]).toEqual([
      'discovered', 'quoted', 'policy_denied', 'payment_required', 'paying',
      'settled', 'delivered', 'verified', 'delivery_failed', 'verification_failed',
    ]);
    expect([...SETTLEMENT_FACTS]).toEqual([
      'unpaid', 'payment_submitted', 'payment_verified', 'partially_settled', 'fully_settled', 'refund_pending', 'refunded', 'unknown',
    ]);
    expect([...RESPONSIBILITY_TYPES]).toEqual([
      'provider_fault', 'buyer_fault', 'agent_fault', 'platform_fault', 'payment_infrastructure_fault', 'undetermined',
    ]);
  });
});

describe('Phase 0 · 结算事实', () => {
  it('local-dev 永远到不了链上结算事实', () => {
    for (const to of ['payment_verified', 'partially_settled', 'fully_settled']) {
      const chk = canTransitionSettlement('payment_submitted', to, { paymentMode: 'local-dev' });
      expect(chk.ok).toBe(false);
      expect(String(chk.reason)).toContain('local-dev');
    }
    expect(canTransitionSettlement('unpaid', 'payment_submitted', { paymentMode: 'local-dev' }).ok).toBe(true);
  });

  it('facilitator 可以推进到 fully_settled, 终态 refunded 不再后退', () => {
    expect(canTransitionSettlement('payment_submitted', 'payment_verified', { paymentMode: 'facilitator' }).ok).toBe(true);
    expect(canTransitionSettlement('payment_verified', 'fully_settled', { paymentMode: 'facilitator' }).ok).toBe(true);
    expect(canTransitionSettlement('fully_settled', 'refund_pending', { paymentMode: 'facilitator' }).ok).toBe(true);
    expect(canTransitionSettlement('refund_pending', 'refunded', { paymentMode: 'facilitator' }).ok).toBe(true);
    expect(canTransitionSettlement('refunded', 'fully_settled', { paymentMode: 'facilitator' }).ok).toBe(false);
    expect(canTransitionSettlement('unpaid', 'fully_settled', { paymentMode: 'facilitator' }).ok).toBe(false);   // 不能跳级
  });

  it('老记录按既有证据推导 (不猜没有证据的事)', () => {
    expect(deriveSettlementFact({ status: 'paying', paymentMode: 'facilitator' })).toBe('unknown');              // 付没付不知道
    expect(deriveSettlementFact({ status: 'delivered', paymentMode: 'facilitator', txHash: '0x1', chainSettled: true })).toBe('payment_verified');
    expect(deriveSettlementFact({ status: 'verified', paymentMode: 'facilitator', chainSettled: true })).toBe('fully_settled');
    expect(deriveSettlementFact({ status: 'discovered', paymentMode: 'none' })).toBe('unpaid');
    expect(deriveSettlementFact({ status: 'delivered', paymentMode: 'local-dev', paymentReceipt: 'r' })).toBe('payment_submitted');
    expect(deriveSettlementFact({ status: 'paying', paymentMode: 'local-dev' })).toBe('unknown');
  });

  it('hasPaymentEvidence 认得三种支付证据', () => {
    expect(hasPaymentEvidence({ txHash: '0x1' })).toBe(true);
    expect(hasPaymentEvidence({ chainSettled: true })).toBe(true);
    expect(hasPaymentEvidence({ settlementFact: 'payment_verified' })).toBe(true);
    expect(hasPaymentEvidence({ settlementFact: 'unpaid' })).toBe(false);
    expect(hasPaymentEvidence({ status: 'paying' })).toBe(false);
  });
});

describe('Phase 0 · 迁移 (不丢事件与证据)', () => {
  it('老记录补两层字段, 事件一个不少并追加 migrate-v2', () => {
    const legacy = rec({ status: 'delivery_failed', paymentMode: 'facilitator', txHash: '0xzz', chainSettled: true, events: [{ at: 't1', kind: 'discovered' }, { at: 't2', kind: 'settled' }] });
    const { record, changed } = migrateTransactionRecord(legacy);
    expect(changed).toBe(true);
    expect(record.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(record.settlementFact).toBe('payment_verified');
    expect(record.status).toBe('delivery_failed');
    expect(record.events.slice(0, 2)).toEqual(legacy.events);
    expect(record.events[record.events.length - 1].kind).toBe('migrate-v2');
  });

  it('迁移幂等 (第二次不再改)', () => {
    const first = migrateTransactionRecord(rec({ status: 'quoted' })).record;
    const second = migrateTransactionRecord(first);
    expect(second.changed).toBe(false);
  });

  it('旧状态 failed 仍可读', () => {
    const { record } = migrateTransactionRecord(rec({ status: 'failed' } as any));
    expect(record.status).toBe('failed');
    expect(record.settlementFact).toBe('unpaid');
  });
});

describe('Phase 0 · 正文实体与 verified 门', () => {
  it('盘上正文重算哈希; 被改过就检出', () => {
    const r = rec({ transactionId: 'tx-d1' });
    const w = writeDeliveryContent('tx-d1', '跨境调研报告正文', HOME);
    const r2 = { ...r, deliveryBytesHash: w.hash, contentHash: 'x', deliveryHash: 'x' } as TransactionRecord;
    expect(verifyDelivery(r2, HOME).matchesRecorded).toBe(true);
    expect(readDeliveryContent('tx-d1', HOME)).toContain('跨境调研');
    fs.writeFileSync(path.join(HOME, '.bolloon', 'x402', 'deliveries', 'tx-d1.txt'), '被换过的内容', 'utf8');
    const v = verifyDelivery(r2, HOME);
    expect(v.present).toBe(true);
    expect(v.matchesRecorded).toBe(false);
  });

  it('八项缺一不可', () => {
    const base: TransactionRecord = rec({
      transactionId: 'tx-g', status: 'delivered', chainSettled: true, protocolVerified: true,
      contentHash: 'H', deliveryHash: 'H', receiptHash: 'R', settlementFact: 'fully_settled',
    });
    writeDeliveryContent('tx-g', '正文', HOME);
    const bytesHash = verifyDelivery({ ...base, deliveryBytesHash: undefined } as any, HOME).bytesHash!;
    const good = { ...base, deliveryBytesHash: bytesHash } as TransactionRecord;
    const ex = { ok: true, schemaOk: true, tool: 'skill_run' };
    expect(evaluateVerifiedGate({ rec: good, home: HOME, execution: ex, goalCriteriaMet: true }).verified).toBe(true);

    // 缺正文: 用另一个 transactionId (盘上没有它的正文文件)
    const noBody = { ...good, transactionId: 'tx-no-body' } as TransactionRecord;
    const cases: [string, TransactionRecord, any, boolean][] = [
      ['chainSettled', { ...good, chainSettled: false } as any, ex, true],
      ['protocolVerified', { ...good, protocolVerified: false } as any, ex, true],
      ['缺正文', noBody, ex, true],
      ['缺回执哈希', { ...good, receiptHash: undefined } as any, ex, true],
      ['缺执行证据', good, null, true],
      ['执行失败', good, { ok: false, schemaOk: true, reason: '工具报错' }, true],
      ['输出不合 schema', good, { ok: true, schemaOk: false }, true],
      ['判据未命中', good, ex, false],
    ];
    for (const [label, r, execution, goalCriteria] of cases) {
      const res = evaluateVerifiedGate({ rec: r as TransactionRecord, home: HOME, execution, goalCriteriaMet: goalCriteria });
      expect(res.verified, label).toBe(false);
      expect(res.missing.length, label).toBeGreaterThan(0);
    }
  });
});

describe('Phase 0 · 责任候选', () => {
  it('按证据给候选 (证据不足不硬归责)', () => {
    expect(deriveResponsibility({ deliveryHashMismatch: true }).type).toBe('provider_fault');
    expect(deriveResponsibility({ signatureInvalid: true }).type).toBe('provider_fault');
    expect(deriveResponsibility({ outputSchemaViolation: true }).type).toBe('provider_fault');
    expect(deriveResponsibility({ inputSchemaViolation: true }).type).toBe('buyer_fault');
    expect(deriveResponsibility({ policyBypassed: true }).type).toBe('agent_fault');
    expect(deriveResponsibility({ ledgerLostOrDoubleCharged: true }).type).toBe('platform_fault');
    expect(deriveResponsibility({ providerInfrastructureUnhealthy: true }).type).toBe('payment_infrastructure_fault');
    expect(deriveResponsibility({ receiptMissing: true }).type).toBe('payment_infrastructure_fault');
    expect(deriveResponsibility({ deliveryMissing: true }).type).toBe('undetermined');
    expect(deriveResponsibility({}).type).toBe('undetermined');
  });
});

describe('Phase 0 · 存储层拒绝非法迁移', () => {
  it('非法迁移抛错, 且记录没被改', async () => {
    const { record } = await beginTransaction({ requestId: 'r-1', metadata: { itemId: 'i-1' } as any, buyerDid: 'did:b', providerDid: 'did:p' }, HOME);
    expect(record.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(record.settlementFact).toBe('unpaid');
    await expect(updateTransaction(record.transactionId, { status: 'verified' }, HOME)).rejects.toBeInstanceOf(IllegalTransactionTransition);
    const back = await readTransaction(record.transactionId, HOME);
    expect(back?.status).toBe('discovered');
  });

  it('local-dev 想写 fully_settled 被拒', async () => {
    const { record } = await beginTransaction({ requestId: 'r-2', metadata: { itemId: 'i-2' } as any, buyerDid: 'did:b', providerDid: 'did:p' }, HOME);
    await updateTransaction(record.transactionId, { status: 'quoted', paymentMode: 'local-dev' }, HOME);
    await updateTransaction(record.transactionId, { status: 'paying', settlementFact: 'payment_submitted' }, HOME);
    await expect(setSettlementFact(record.transactionId, 'fully_settled', '联调想冒充链上', HOME)).rejects.toBeInstanceOf(IllegalTransactionTransition);
    const back = await readTransaction(record.transactionId, HOME);
    expect(back?.settlementFact).toBe('payment_submitted');
  });


  it('并发: 同 requestId 真并发 → 只有一条交易记录, 两个进程复用同一个 id', async () => {
    const req = 'r-conc-1';
    const [a, b] = await Promise.all([
      beginTransaction({ requestId: req, metadata: { itemId: 'i' } as any, buyerDid: 'b', providerDid: 'p' }, HOME),
      beginTransaction({ requestId: req, metadata: { itemId: 'i' } as any, buyerDid: 'b', providerDid: 'p' }, HOME),
    ]);
    expect(a.record.transactionId).toBe(b.record.transactionId);          // 确定性 id: 物理上同一个
    expect([a.reused, b.reused].filter((r) => r === false).length).toBeLessThanOrEqual(1);   // 最多一个真创建
    const files = fs.readdirSync(path.join(HOME, '.bolloon', 'transactions')).filter((f) => f.startsWith('tx-') && f.endsWith('.json'));
    expect(files.length).toBe(1);                                          // 只有一条记录
  });

  it('确定性 id: 同 requestId 永远映射同一个交易 id', async () => {
    const r1 = await beginTransaction({ requestId: 'r-same', metadata: { itemId: 'i' } as any, buyerDid: 'b', providerDid: 'p' }, HOME);
    const r2 = await beginTransaction({ requestId: 'r-same', metadata: { itemId: 'i' } as any, buyerDid: 'b', providerDid: 'p' }, HOME);
    expect(r1.record.transactionId).toBe(r2.record.transactionId);
    expect(r2.reused).toBe(true);
  });

  it('结算事实变化自动留痕 (调用方忘给 event 也不丢审计)', async () => {
    const { record } = await beginTransaction({ requestId: 'r-audit', metadata: { itemId: 'i' } as any, buyerDid: 'b', providerDid: 'p' }, HOME);
    await updateTransaction(record.transactionId, { status: 'quoted', paymentMode: 'facilitator' }, HOME);
    await updateTransaction(record.transactionId, { status: 'paying' }, HOME);
    await updateTransaction(record.transactionId, { settlementFact: 'payment_submitted' } as any, HOME);   // 故意不给 event
    const lines = await replayTransaction(record.transactionId, HOME);
    expect(lines.some((l) => l.includes('settlement:payment_submitted'))).toBe(true);
  });

  it('读旧格式记录 → 就地迁移 + 保留备份 + 事件不丢', async () => {
    const dir = path.join(HOME, '.bolloon', 'transactions');
    fs.mkdirSync(dir, { recursive: true });
    const legacy = {
      transactionId: 'tx-legacy', requestId: 'r-legacy', itemId: 'i-legacy',
      buyerDid: 'did:b', providerDid: 'did:p', paymentMode: 'facilitator', chainSettled: true, txHash: '0xlegacy',
      status: 'delivery_failed', startedAt: '2026-09-01T00:00:00.000Z',
      events: [{ at: 'a', kind: 'discovered' }, { at: 'b', kind: 'settled' }],
    };
    fs.writeFileSync(path.join(dir, 'tx-legacy.json'), JSON.stringify(legacy), 'utf8');
    const got = await readTransaction('tx-legacy', HOME);
    expect(got?.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(got?.settlementFact).toBe('payment_verified');
    expect(got?.events.map((e) => e.kind)).toEqual(['discovered', 'settled', 'migrate-v2']);
    expect(fs.existsSync(path.join(dir, 'tx-legacy.json.bak-v1'))).toBe(true);
    // 迁移后仍可继续往前走 (结算推进), 但不能再回付款
    await expect(updateTransaction('tx-legacy', { status: 'paying' }, HOME)).rejects.toBeInstanceOf(IllegalTransactionTransition);
    const settled = await setSettlementFact('tx-legacy', 'fully_settled', '对账确认链上已结算', HOME);
    expect(settled?.settlementFact).toBe('fully_settled');
  });
});
