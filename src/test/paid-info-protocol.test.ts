/**
 * paid-info-protocol.test.ts — 微支付信息协议 (信封签名/验真) 单测
 *
 * 覆盖: 规范化序列化、内容哈希、真签名→验真分档、三类篡改 (内容/来源/支付回执)、
 *       缺签名降级 content-only、itemId 防掉包、金额原子单位、402 响应体、付款校验两模式。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  INFO_PROTOCOL, canonicalize, computeContentHash, sha256Hex,
  buildSignedEnvelope, verifyEnvelope, summarizeVerify, type PaidInfoItem,
} from '../agents/x402/paid-info-protocol.js';
import {
  toAtomicAmount, assetFor, buildPaymentRequired, decodePaymentHeader,
  encodePaymentResponse, checkAndSettlePayment,
} from '../agents/x402/paid-info-store.js';

let keypair: any;
const DID = 'did:key:zVerifyTestProvider';
const OTHER_PUB = 'f'.repeat(64);

beforeAll(async () => {
  const { KeyManager } = await import('@diap/sdk');
  keypair = KeyManager.generate();
});

afterAll(() => {
  delete process.env.BOLLOON_X402_LOCAL_VERIFY;
  delete process.env.BOLLOON_X402_FACILITATOR;
});

function makeItem(content: string, over: Partial<PaidInfoItem> = {}): PaidInfoItem {
  return {
    protocol: INFO_PROTOCOL,
    id: 'info_test_1',
    title: '杭州实时天气数据集',
    category: 'data',
    price: { amount: '0.002', currency: 'USDC', network: 'base-sepolia', payTo: '0x1111111111111111111111111111111111111111' },
    provider: { did: DID, name: 'weather-agent' },
    contentHash: computeContentHash(content),
    source: { kind: 'measured', refs: ['https://example.com/sensor-log.csv'] },
    createdAt: '2026-09-13T00:00:00.000Z',
    updatedAt: '2026-09-13T00:00:00.000Z',
    ...over,
  };
}

async function buildEnv(content = '{"temp":21.5}', paymentMode: 'facilitator' | 'local-dev' = 'facilitator') {
  const item = makeItem(content);
  const receipt = encodePaymentResponse({ success: true, transaction: '0xabc', network: 'base-sepolia' });
  return buildSignedEnvelope({
    item,
    content,
    keypair: { did: DID, publicKey: keypair.publicKey, privateKey: keypair.privateKey },
    payment: { mode: paymentMode, receipt, txHash: '0xabc', network: 'base-sepolia', amount: '0.002', currency: 'USDC' },
  });
}

const resolver = async (did: string) => (did === DID
  ? { publicKeyHex: Buffer.from(keypair.publicKey).toString('hex') }
  : null);

describe('paid-info 协议: 基础工具', () => {
  it('canonicalize 与键序无关 (两端签名一致的前提)', () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } }))
      .toBe(canonicalize({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 }));
  });

  it('computeContentHash 稳定且带前缀', () => {
    const h = computeContentHash('hello');
    expect(h).toBe(`sha256:${sha256Hex('hello')}`);
    expect(computeContentHash('hello')).toBe(h);
    expect(computeContentHash('hello!')).not.toBe(h);
  });

  it('toAtomicAmount: USDC 6 位 / ETH 18 位整数运算', () => {
    expect(toAtomicAmount('0.002', 'USDC')).toBe('2000');
    expect(toAtomicAmount('1', 'USDC')).toBe('1000000');
    expect(toAtomicAmount('0.000001', 'USDC')).toBe('1');
    expect(toAtomicAmount('0.5', 'ETH')).toBe('500000000000000000');
  });

  it('assetFor: USDC 按网络取地址, ETH 用零地址', () => {
    expect(assetFor('USDC', 'base-sepolia')).toBe('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
    expect(assetFor('ETH', 'base')).toBe('0x0000000000000000000000000000000000000000');
  });

  it('buildPaymentRequired 产出 x402 v2 结构 (accepts 带 itemId/类别)', () => {
    const body = buildPaymentRequired(makeItem('x'), 'http://127.0.0.1:54188/api/x402/info/info_test_1');
    expect(body.x402Version).toBe(2);
    expect(body.resource.url).toContain('/api/x402/info/info_test_1');
    const a = body.accepts[0] as any;
    expect(a.scheme).toBe('exact');
    expect(a.amount).toBe('2000');
    expect(a.payTo).toMatch(/^0x/);
    expect(a.extra.itemId).toBe('info_test_1');
  });

  it('X-PAYMENT 头 base64 往返', () => {
    const obj = { x402Version: 2, accepted: { amount: '2000' } };
    expect(decodePaymentHeader(encodePaymentResponse(obj))).toEqual(obj);
    expect(decodePaymentHeader('not-base64-json')).toBeNull();
  });
});

describe('paid-info 协议: 签名 → 验真', () => {
  it('真签名 + DID 可解析 + 链上模式 → verified 且全部检查通过', async () => {
    const env = await buildEnv();
    const report = await verifyEnvelope(env, { resolveDid: resolver, expectItemId: 'info_test_1' });
    expect(report.ok).toBe(true);
    expect(report.trust).toBe('verified');
    expect(report.checks.every((c) => c.ok)).toBe(true);
    expect(report.warnings).toHaveLength(0);
    expect(summarizeVerify(report)).toContain('verified');
  });

  it('篡改内容 → 内容哈希对不上 → unverified', async () => {
    const env = await buildEnv();
    env.content = env.content.replace('21.5', '99.9');
    const report = await verifyEnvelope(env, { resolveDid: resolver });
    expect(report.ok).toBe(false);
    expect(report.trust).toBe('unverified');
    expect(report.checks.find((c) => c.name === 'content-integrity')!.ok).toBe(false);
  });

  it('篡改信封外层来源声明 → 载荷自洽检查抓到 (签名只覆盖 payload, 必须比对)', async () => {
    const env = await buildEnv();
    env.item.source = { kind: 'quoted', refs: ['https://fake.example.com'] };
    const report = await verifyEnvelope(env, { resolveDid: resolver });
    // 签名本身仍然有效 (payload 没动), 但外层与签名载荷不符 → 判不可用
    expect(report.checks.find((c) => c.name === 'provider-signature')!.ok).toBe(true);
    const consistency = report.checks.find((c) => c.name === 'signed-payload-consistency')!;
    expect(consistency.ok).toBe(false);
    expect(consistency.detail).toContain('来源声明');
    expect(report.ok).toBe(false);
    expect(report.trust).not.toBe('verified');
  });

  it('换掉支付回执 → 支付绑定检查失败 (防拿别的回执冒充)', async () => {
    const env = await buildEnv();
    env.payment.receipt = encodePaymentResponse({ success: true, transaction: '0xdeadbeef' });
    const report = await verifyEnvelope(env, { resolveDid: resolver });
    expect(report.checks.find((c) => c.name === 'payment-binding')!.ok).toBe(false);
    expect(report.ok).toBe(false);
  });

  it('无签名 proof → 降级 content-only (只保证没被传输篡改)', async () => {
    const env: any = await buildEnv();
    delete env.proof;
    const report = await verifyEnvelope(env, { resolveDid: resolver });
    expect(report.trust).toBe('content-only');
    expect(report.ok).toBe(false);
  });

  it('DID 未解析 → 签名仍通过, 但只算 self-attested 并给出提示', async () => {
    const env = await buildEnv();
    const report = await verifyEnvelope(env, { resolveDid: async () => null });
    expect(report.trust).toBe('self-attested');
    expect(report.warnings.join(' ')).toContain('DID 未解析');
  });

  it('本机联调凭据 → 即使签名通过也只算 self-attested 并标注非链上', async () => {
    const env = await buildEnv('{"a":1}', 'local-dev');
    const report = await verifyEnvelope(env, { resolveDid: resolver });
    expect(report.trust).toBe('self-attested');
    expect(report.warnings.join(' ')).toContain('local-dev');
  });

  it('itemId 掉包检测', async () => {
    const env = await buildEnv();
    const report = await verifyEnvelope(env, { resolveDid: resolver, expectItemId: 'info_other' });
    expect(report.checks.find((c) => c.name === 'expected-item')!.ok).toBe(false);
    expect(report.ok).toBe(false);
  });

  it('来源声明为可核验但没给引用 → 检查失败并提示', async () => {
    const env = await buildEnv();
    env.item.source = { kind: 'derived', refs: [] };
    const report = await verifyEnvelope(env, { resolveDid: resolver });
    expect(report.checks.find((c) => c.name === 'source-provenance')!.ok).toBe(false);
    expect(report.warnings.join(' ')).toContain('没给引用');
  });

  it('用别人的公钥验签 → 失败 (公钥必须真属于签发方)', async () => {
    const env = await buildEnv();
    env.proof.publicKeyHex = OTHER_PUB;
    const report = await verifyEnvelope(env, { resolveDid: resolver });
    expect(report.checks.find((c) => c.name === 'provider-signature')!.ok).toBe(false);
  });

  it('内容哈希与 item 不一致时拒绝签发 (防"挂 A 卖 B")', async () => {
    const item = makeItem('内容A');
    await expect(buildSignedEnvelope({
      item,
      content: '内容B',
      keypair: { did: DID, publicKey: keypair.publicKey, privateKey: keypair.privateKey },
      payment: { mode: 'facilitator', receipt: 'r', network: 'base-sepolia', amount: '0', currency: 'USDC' },
    })).rejects.toThrow(/不一致/);
  });
});

describe('paid-info 协议: 付款校验', () => {
  const requirements = () => buildPaymentRequired(makeItem('x'));

  it('没有 X-PAYMENT → 明确报"未付款"', async () => {
    const r = await checkAndSettlePayment({ requirements: requirements() });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('未付款');
  });

  it('既无 facilitator 也没开联调 → 如实拒绝 (不假装收到钱)', async () => {
    process.env.BOLLOON_X402_LOCAL_VERIFY = '0';
    delete process.env.BOLLOON_X402_FACILITATOR;
    const r = await checkAndSettlePayment({
      requirements: requirements(),
      paymentHeader: encodePaymentResponse({ x402Version: 2, accepted: { amount: '2000' }, payload: {} }),
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('无法校验真实付款');
  });

  it('本机联调模式: 金额/收款一致才放行, 回执标记 local-dev', async () => {
    process.env.BOLLOON_X402_LOCAL_VERIFY = '1';
    const req = requirements();
    const accepted = req.accepts[0];
    const good = await checkAndSettlePayment({
      requirements: req,
      paymentHeader: encodePaymentResponse({ x402Version: 2, accepted, payload: { localDev: true } }),
    });
    expect(good.ok).toBe(true);
    expect(good.mode).toBe('local-dev');
    const decoded = JSON.parse(Buffer.from(good.receipt!, 'base64').toString('utf-8'));
    expect(decoded.mode).toBe('local-dev');
    expect(decoded.note).toContain('非链上');

    const badAmount = await checkAndSettlePayment({
      requirements: req,
      paymentHeader: encodePaymentResponse({ x402Version: 2, accepted: { ...accepted, amount: '1' }, payload: {} }),
    });
    expect(badAmount.ok).toBe(false);
    expect(badAmount.error).toContain('金额');
  });

  it('facilitator 模式: verify 不过 → 拒绝; verify+settle 都过 → 回执为结算结果', async () => {
    delete process.env.BOLLOON_X402_LOCAL_VERIFY;
    const req = requirements();
    const header = encodePaymentResponse({ x402Version: 2, accepted: req.accepts[0], payload: {} });

    const failing: typeof fetch = (async () => new Response(JSON.stringify({ isValid: false, invalidReason: 'insufficient_funds' }), { status: 200 })) as any;
    const bad = await checkAndSettlePayment({ requirements: req, paymentHeader: header, facilitatorUrl: 'https://f.test', fetchImpl: failing });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('insufficient_funds');

    const urls: string[] = [];
    const okFetch: typeof fetch = (async (input: any) => {
      urls.push(String(input));
      return new Response(JSON.stringify(urls.length === 1
        ? { isValid: true, payer: '0xpayer' }
        : { success: true, transaction: '0xtx', network: 'base-sepolia', payer: '0xpayer' }), { status: 200 });
    }) as any;
    const good = await checkAndSettlePayment({ requirements: req, paymentHeader: header, facilitatorUrl: 'https://f.test', fetchImpl: okFetch });
    expect(good.ok).toBe(true);
    expect(good.mode).toBe('facilitator');
    expect(good.txHash).toBe('0xtx');
    expect(urls[0]).toContain('/verify');
    expect(urls[1]).toContain('/settle');
  });
});
