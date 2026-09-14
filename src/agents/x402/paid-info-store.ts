/**
 * paid-info-store.ts — 微支付信息服务: 发布 / 索引 / 402 收款 / 付款校验
 *
 * 三个角色:
 *   ① 提供方 (卖方): publishInfo() 落盘 → GET /api/x402/info/:id 未付款返回 402 (x402 v2 accepts),
 *      付款通过 → 结算 → 返回带签名的信封 (content + proof + payment)
 *   ② 购买方 (买方): buyInfo() 走标准 x402 客户端 (402 → 钱包签名 → 重试) 拿到信封
 *   ③ 验真: verifyEnvelope() 分档报告 (见 paid-info-protocol.ts)
 *
 * 支付两种模式:
 *   facilitator — 真链上: BOLLOON_X402_FACILITATOR=https://... → POST /verify + /settle
 *   local-dev   — 本机联调: 显式 env BOLLOON_X402_LOCAL_VERIFY=1, 回执带 mode:'local-dev'
 *                 (验真报告会标注"非链上支付", 绝不冒充真实付款)
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import {
  INFO_PROTOCOL, computeContentHash, sha256Hex,
  type PaidInfoItem, type InfoSource, type InfoCategory,
} from './paid-info-protocol.js';

// ---------------------------------------------------------------- 存储

export interface StoredInfo { item: PaidInfoItem; content: string }

export function x402InfoDir(home: string = os.homedir()): string {
  return path.join(home, '.bolloon', 'x402-info');
}

function itemFile(id: string, home: string): string {
  return path.join(x402InfoDir(home), `${id.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
}

export interface PublishInfoInput {
  title: string;
  category: InfoCategory;
  content: string;
  description?: string;
  price: { amount: string; currency: 'USDC' | 'ETH'; network?: string; payTo: string };
  source: InfoSource;
  provider: { did: string; name?: string; agentId?: string; endpoint?: string };
  contentCid?: string;
  id?: string;
}

export async function publishInfo(input: PublishInfoInput, opts: { home?: string } = {}): Promise<PaidInfoItem> {
  const home = opts.home ?? os.homedir();
  const title = String(input.title || '').trim();
  if (!title) throw new Error('title 必填');
  if (!String(input.content ?? '').length) throw new Error('content 必填 (要卖的信息本体)');
  if (!input.price?.payTo) throw new Error('price.payTo 必填 (收款地址)');
  if (!input.provider?.did) throw new Error('provider.did 必填 (卖方 DIAP 身份)');
  const id = input.id || `info_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
  const now = new Date().toISOString();
  const item: PaidInfoItem = {
    protocol: INFO_PROTOCOL,
    id,
    title,
    category: input.category || 'other',
    description: input.description,
    price: {
      amount: String(input.price.amount ?? '0'),
      currency: input.price.currency || 'USDC',
      network: input.price.network || 'base-sepolia',
      payTo: input.price.payTo,
    },
    provider: input.provider,
    contentHash: computeContentHash(String(input.content)),
    contentCid: input.contentCid,
    source: input.source || { kind: 'self', refs: [] },
    createdAt: now,
    updatedAt: now,
  };
  await fs.mkdir(x402InfoDir(home), { recursive: true });
  await fs.writeFile(itemFile(id, home), JSON.stringify({ item, content: String(input.content) }, null, 2), 'utf-8');
  return item;
}

export async function listInfo(home: string = os.homedir()): Promise<PaidInfoItem[]> {
  try {
    const dir = x402InfoDir(home);
    const files = await fs.readdir(dir);
    const out: PaidInfoItem[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(dir, f), 'utf-8'));
        if (parsed?.item) out.push(parsed.item);
      } catch { /* 跳过坏文件 */ }
    }
    return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  } catch {
    return [];
  }
}

export async function getStoredInfo(id: string, home: string = os.homedir()): Promise<StoredInfo | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(itemFile(id, home), 'utf-8'));
    return parsed?.item ? parsed : null;
  } catch {
    return null;
  }
}

export async function removeInfo(id: string, home: string = os.homedir()): Promise<boolean> {
  try {
    await fs.rm(itemFile(id, home));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- x402 402 / 校验

const USDC_BY_NETWORK: Record<string, string> = {
  base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  mainnet: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  sepolia: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
};
/** 原生 ETH 在 x402 里用零地址占位 */
const NATIVE_ASSET = '0x0000000000000000000000000000000000000000';

export function assetFor(currency: string, network: string): string {
  if (currency === 'USDC') return USDC_BY_NETWORK[network] || USDC_BY_NETWORK['base-sepolia'];
  return NATIVE_ASSET;
}

/** 人类金额 → 原子单位 (USDC 6 位 / ETH 18 位), 纯整数运算防浮点误差 */
export function toAtomicAmount(amount: string, currency: string): string {
  const decimals = currency === 'USDC' ? 6 : 18;
  const s = String(amount || '0').trim();
  const [i, f = ''] = s.split('.');
  const frac = (f + '0'.repeat(decimals)).slice(0, decimals);
  const int = i.replace(/[^0-9]/g, '') || '0';
  return `${int}${frac}`.replace(/^0+(?=\d)/, '');
}

export interface PaymentRequiredBody {
  x402Version: number;
  error?: string;
  resource: { url: string; description?: string; mimeType?: string; serviceName?: string; tags?: string[] };
  accepts: Array<Record<string, unknown>>;
}

/** 生成 x402 v2 规范的 402 响应体 */
export function buildPaymentRequired(item: PaidInfoItem, url?: string, error?: string): PaymentRequiredBody {
  const network = item.price.network;
  return {
    x402Version: 2,
    ...(error ? { error } : {}),
    resource: {
      url: url || item.provider.endpoint || `bolloon://x402/info/${item.id}`,
      description: item.description || item.title,
      mimeType: 'application/json',
      serviceName: 'bolloon-paid-info',
      tags: [item.category],
    },
    accepts: [{
      scheme: 'exact',
      network,
      asset: assetFor(item.price.currency, network),
      amount: toAtomicAmount(item.price.amount, item.price.currency),
      payTo: item.price.payTo,
      maxTimeoutSeconds: 60,
      extra: { name: item.price.currency, itemId: item.id, category: item.category, providerDid: item.provider.did },
    }],
  };
}

export function decodePaymentHeader(header: string): any | null {
  try {
    const raw = Buffer.from(String(header || '').trim(), 'base64').toString('utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function encodePaymentResponse(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), 'utf-8').toString('base64');
}

export interface PaymentOutcome {
  ok: boolean;
  mode: 'facilitator' | 'local-dev' | 'none';
  /** 回执原文 (X-PAYMENT-RESPONSE 的值) */
  receipt?: string;
  txHash?: string;
  payer?: string;
  network?: string;
  error?: string;
}

export interface CheckPaymentOptions {
  paymentHeader?: string;
  requirements: PaymentRequiredBody;
  facilitatorUrl?: string;
  /** 显式允许本机联调凭据 (默认 false) */
  allowLocalDev?: boolean;
  fetchImpl?: typeof fetch;
}

/**
 * 校验并结算一笔微支付。
 * facilitator 模式走标准 /verify + /settle; local-dev 只在显式开启时可用并如实标记。
 */
export async function checkAndSettlePayment(opts: CheckPaymentOptions): Promise<PaymentOutcome> {
  const req = opts.requirements.accepts[0];
  const network = String(req.network);
  if (!opts.paymentHeader) return { ok: false, mode: 'none', error: '缺少 X-PAYMENT 头 (未付款)' };
  const payload = decodePaymentHeader(opts.paymentHeader);
  if (!payload) return { ok: false, mode: 'none', error: 'X-PAYMENT 不是合法 base64 JSON' };

  const facilitatorUrl = opts.facilitatorUrl ?? process.env.BOLLOON_X402_FACILITATOR ?? '';
  const allowLocalDev = opts.allowLocalDev ?? (process.env.BOLLOON_X402_LOCAL_VERIFY === '1');

  if (facilitatorUrl) {
    const f = opts.fetchImpl ?? fetch;
    const body = { x402Version: 2, paymentPayload: payload, paymentRequirements: req };
    try {
      const vres = await f(`${facilitatorUrl.replace(/\/$/, '')}/verify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const v = await vres.json() as any;
      if (!v?.isValid) {
        return { ok: false, mode: 'facilitator', error: `facilitator 校验未通过: ${v?.invalidReason || v?.invalidMessage || 'unknown'}` };
      }
      const sres = await f(`${facilitatorUrl.replace(/\/$/, '')}/settle`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const s = await sres.json() as any;
      if (!s?.success) {
        return { ok: false, mode: 'facilitator', error: `结算失败: ${s?.errorReason || s?.errorMessage || 'unknown'}` };
      }
      const receipt = encodePaymentResponse(s);
      return { ok: true, mode: 'facilitator', receipt, txHash: s.transaction, payer: s.payer || v.payer, network };
    } catch (e: any) {
      return { ok: false, mode: 'facilitator', error: `facilitator 不可达: ${String(e?.message || e).slice(0, 160)}` };
    }
  }

  if (!allowLocalDev) {
    return {
      ok: false,
      mode: 'none',
      error: '未配置 facilitator (BOLLOON_X402_FACILITATOR), 也未开启本机联调模式 (BOLLOON_X402_LOCAL_VERIFY=1) — 无法校验真实付款',
    };
  }

  // 本机联调: 只检查 payload 声明的收款/金额与要求一致, 明确标记非链上
  const accepted = payload.accepted || {};
  if (accepted.payTo && String(accepted.payTo).toLowerCase() !== String(req.payTo).toLowerCase()) {
    return { ok: false, mode: 'local-dev', error: '本机联调: 付款声明收款地址与要求不一致' };
  }
  if (accepted.amount && String(accepted.amount) !== String(req.amount)) {
    return { ok: false, mode: 'local-dev', error: '本机联调: 付款声明金额与要求不一致' };
  }
  const receiptObj = {
    mode: 'local-dev',
    success: true,
    network,
    payer: payload.payer || 'local-dev',
    transaction: `local-dev:${sha256Hex(JSON.stringify(payload)).slice(0, 32)}`,
    settledAt: new Date().toISOString(),
    note: '本机联调凭据, 非链上支付',
  };
  return { ok: true, mode: 'local-dev', receipt: encodePaymentResponse(receiptObj), txHash: receiptObj.transaction, payer: receiptObj.payer, network };
}

// ---------------------------------------------------------------- 买方

export interface BuyInfoResult {
  ok: boolean;
  status?: number;
  /** 已验真的信封 (直接给智能体用) */
  envelope?: any;
  verify?: import('./paid-info-protocol.js').VerifyReport;
  payment?: { mode: string; txHash?: string; receipt?: string };
  raw?: string;
  error?: string;
}

/**
 * 购买一条信息: 未付款时服务端回 402, 这里用标准 x402 客户端 (402→签名→重试) 完成支付。
 * 无钱包私钥时, 只有显式 allowLocalDev 才走本机联调头。
 */
export async function buyInfo(params: {
  url: string;
  privateKey?: string;
  maxPaymentAmount?: string;
  network?: string;
  rpcUrl?: string;
  allowLocalDev?: boolean;
  resolveDid?: import('./paid-info-protocol.js').DidKeyResolver;
  expectItemId?: string;
  fetchImpl?: typeof fetch;
}): Promise<BuyInfoResult> {
  const { verifyEnvelope } = await import('./paid-info-protocol.js');
  const doFetch = params.fetchImpl ?? fetch;

  // ① 先探一次: 判断是否 402 (以及免费信息直接返回)
  let res: Response;
  try {
    res = await doFetch(params.url, { method: 'GET' });
  } catch (e: any) {
    return { ok: false, error: `请求失败: ${String(e?.message || e).slice(0, 160)}` };
  }
  if (res.status !== 402) {
    const text = await res.text();
    if (res.status >= 200 && res.status < 300) {
      // 免费 (或已经不带支付就给了内容)
      const parsed = safeJson(text);
      const report = parsed?.proof ? await verifyEnvelope(parsed, { resolveDid: params.resolveDid, expectItemId: params.expectItemId }) : undefined;
      return { ok: true, status: res.status, envelope: parsed, verify: report, raw: text };
    }
    return { ok: false, status: res.status, error: `服务端返回 ${res.status}: ${text.slice(0, 200)}` };
  }

  // ② 402 → 支付 → 重试
  const requirementBody = safeJson(await res.text());
  const requirements = requirementBody?.accepts?.[0];
  if (!requirements) return { ok: false, status: 402, error: '402 响应缺少 accepts' };

  let paymentHeader = '';
  let mode = '';
  if (params.privateKey) {
    // 标准 x402 客户端: 用 @x402/fetch 里同一套 createX402PaymentFetch 完成签名支付
    const { createX402PaymentFetch } = await import('./x402Pay.js');
    const paymentFetch = await createX402PaymentFetch({
      privateKey: params.privateKey,
      network: params.network,
      maxPaymentAmount: params.maxPaymentAmount,
      rpcUrl: params.rpcUrl,
    });
    const retry = await paymentFetch(params.url, { method: 'GET' });
    const text = await retry.text();
    const parsed = safeJson(text);
    const receipt = retry.headers.get('x-payment-response') || parsed?.payment?.receipt || '';
    if (retry.status < 200 || retry.status >= 300) {
      return { ok: false, status: retry.status, error: `付款后重试失败 ${retry.status}: ${text.slice(0, 200)}` };
    }
    mode = 'facilitator';
    const report = parsed?.proof ? await verifyEnvelope(parsed, { resolveDid: params.resolveDid, expectItemId: params.expectItemId }) : undefined;
    return { ok: true, status: retry.status, envelope: parsed, verify: report, payment: { mode, receipt }, raw: text };
  }

  if (!params.allowLocalDev) {
    return { ok: false, status: 402, error: '需要钱包私钥才能支付 (未提供 privateKey; 本机联调请显式 allowLocalDev)' };
  }
  paymentHeader = Buffer.from(JSON.stringify({
    x402Version: 2,
    accepted: requirements,
    payload: { localDev: true, at: new Date().toISOString() },
    payer: 'local-dev',
  }), 'utf-8').toString('base64');
  const retry = await doFetch(params.url, { method: 'GET', headers: { 'X-PAYMENT': paymentHeader } });
  const text = await retry.text();
  const parsed = safeJson(text);
  if (retry.status < 200 || retry.status >= 300) {
    return { ok: false, status: retry.status, error: `本机联调付款被拒 ${retry.status}: ${text.slice(0, 200)}` };
  }
  mode = 'local-dev';
  const report = parsed?.proof ? await verifyEnvelope(parsed, { resolveDid: params.resolveDid, expectItemId: params.expectItemId }) : undefined;
  return {
    ok: true, status: retry.status, envelope: parsed, verify: report,
    payment: { mode, receipt: retry.headers.get('x-payment-response') || parsed?.payment?.receipt }, raw: text,
  };
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
