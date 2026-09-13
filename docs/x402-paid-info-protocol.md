---
title: 微支付信息协议 (bolloon-x402-info/1)
source: session
created: 2026-09-13
last_confirmed: 2026-09-13
schema_version: 2
audience: public
stage: current
status: current
confidence: high
entity_type: protocol
tags: [x402, micro-payment, paid-info, provenance, verify, diap, ipfs, mobile, desktop]
---

# 微支付信息协议 (bolloon-x402-info/1)

> 一句话: **付费才给内容, 给的内容可验真**。
> 智能体把"特定信息"(数据 / 技能 / 商品信息 / 艺术作品 / 其它) 标价提供;
> 另一个智能体走 x402 微支付买到; 拿到手的东西必须能自己证明没被掉包、是谁给的、钱花在哪条内容上。

## 1. 为什么需要它

微支付要奖励的是**真实信息**。只做一个"付款后返回字符串"的接口, 会出现三个洞:

1. 卖方挂 A 卖 B (收钱后给别的内容)
2. 中间人/传输层改内容 (拿到手的不是卖方发的)
3. 拿同一条信息的支付回执去别的信息上复用 (回执与内容不绑定)

所以协议把 **内容哈希** + **来源声明** + **支付回执哈希** 一起纳入提供方 DIAP Ed25519 签名载荷。

## 2. 角色

| 角色 | 能力 | 入口 |
|------|------|------|
| 提供方 (卖方) | 发布 / 报价 / 收款 / 签发信封 | 工具 `x402_info_publish`; `POST /api/x402/info`; `GET /api/x402/info/:id` |
| 购买方 (买方) | 发现 / 比价 / 付款 / 验真 | 工具 `x402_info_buy` `x402_info_verify`; `POST /api/x402/info/buy`; CLI `/x402 buy|verify` |
| 人类 (两端) | 手机端点按浏览+购买, 电脑端 Web/CLI 管理 | 手机端网络页「微信息」; CLI `/x402` |

## 3. item (免费可读的公开元数据)

```
{
  protocol: 'bolloon-x402-info/1',
  id, title, category: 'data'|'skill'|'goods'|'art'|'other',
  description?,
  price: { amount: '0.002', currency: 'USDC'|'ETH', network: 'base-sepolia', payTo: '0x…' },
  provider: { did, name?, agentId?, endpoint? },
  contentHash: 'sha256:<hex>',          // 内容本体摘要
  contentCid?,                          // 内容已上 IPFS 时的 CID (可独立核验)
  source: { kind: 'self'|'measured'|'derived'|'quoted', refs: [url|cid|paper|dataset], note? },
  createdAt, updatedAt
}
```

`GET /api/x402/info` 与 `/api/x402/info/:id/meta` 免费返回 item (发现/索引用, **不含内容**)。

## 4. 402 付款要求 (x402 v2 形状)

```
HTTP/1.1 402 Payment Required
{
  "x402Version": 2,
  "resource": { "url": "...", "description": "...", "mimeType": "application/json",
                "serviceName": "bolloon-paid-info", "tags": ["data"] },
  "accepts": [{
    "scheme": "exact", "network": "base-sepolia",
    "asset": "0x…",                     // USDC 地址; ETH 用零地址
    "amount": "2000",                   // 原子单位 (USDC 6 位 / ETH 18 位)
    "payTo": "0x…", "maxTimeoutSeconds": 60,
    "extra": { "name": "USDC", "itemId": "info_…", "category": "data", "providerDid": "did:…" }
  }]
}
```

买方在 `X-PAYMENT` 头里回传 base64(JSON) 的支付载荷 (x402 标准)。
服务端校验 → 结算 → 返回内容。

## 5. 信封 (付款后返回的全部东西)

```
{
  protocol: 'bolloon-x402-info/1',
  item:     <公开元数据>,
  content:  '<内容本体>',
  proof: {
    alg: 'ed25519',
    did: 'did:key:…',  publicKeyHex: '<64 hex>',
    signature: 'base64(ed25519(canonicalize(payload)))',
    payload: {                       // 逐字段纳入签名
      protocol, itemId, providerDid,
      contentHash, contentCid?,
      source,                        // 来源声明本身也被签名
      receiptHash: 'sha256:<hex>',   // 支付回执哈希 → 回执与内容绑定
      issuedAt
    }
  },
  payment: { mode: 'facilitator'|'local-dev', receipt, receiptHash, txHash?, network, amount, currency, payer?, settledAt? }
}
```

同时通过 `X-PAYMENT-RESPONSE` 头返回结算结果原文。

## 6. 验真规则 (买方必须做, 工具自动做)

| # | 检查 | 不过的后果 |
|---|------|-----------|
| 1 | protocol 标识正确 | 不可用 |
| 2 | `sha256(content) == item.contentHash` | **unverified** (内容被改) |
| 3 | Ed25519 签名对 `canonicalize(payload)` 验签通过 | content-only (无签名/伪造) |
| 4 | 载荷自洽: payload 的 itemId/providerDid/contentHash/**source**/contentCid/receiptHash 与信封外层一致 | content-only (外层被改) |
| 5 | 支付绑定: `sha256(receipt) == payment.receiptHash == payload.receiptHash` | content-only (回执被换/复用) |
| 6 | (软) DID 公钥绑定: 解析 DID 文档, 公钥与签名公钥一致 | 降档 self-attested |
| 7 | 来源声明: kind ≠ self 时必须给 refs | 判不可用 (声明不成立) |
| 8 | (软) 时效 / 期望 itemId 防掉包 | 降档 / 判不可用 |

**信任分档 (明确区分, 不把"能解出内容"说成"信息可信")**:

| 档 | 含义 |
|----|------|
| `verified` | 1-5 全过 + DID 公钥绑定成立 + 链上 (facilitator) 支付 |
| `self-attested` | 签名/哈希/支付绑定都对, 但 DID 未解析 或 支付是本机联调凭据 |
| `content-only` | 只有内容哈希对得上 (无签名/签名缺公钥) — 只保证传输未篡改 |
| `unverified` | 内容哈希都对不上 |

DID 解析两条路: ① 本机身份文件 (`~/.bolloon/identity.json` / `agent-keys/*` / `identity/user.json`);
② 本地 Kubo 里名为 `did-<did>` 的 IPNS key → `name/resolve` → `cat` DID 文档取公钥 (**跨机器验真路径**)。

## 7. 支付模式 (诚实优先)

| 模式 | 什么时候 | 回执 |
|------|---------|------|
| `facilitator` | 配了 `BOLLOON_X402_FACILITATOR=https://…` | 走 `/verify` + `/settle`, 返回链上 txHash |
| `local-dev` | 显式 `BOLLOON_X402_LOCAL_VERIFY=1` | 本机联调凭据, 回执 `mode:'local-dev'` + **验真报告写"非链上结算"** |
| 未配置 | 默认 | **拒绝**: "无法校验真实付款" — 不假装收到钱 |

买方付款私钥来源: 当前 channel 钱包 (AES-256-GCM 解密) / `X402_PRIVATE_KEY` / 工具参数。

## 8. 这套协议**不**保证什么 (边界)

- 不保证内容"符合事实": 只能证明**是谁签发的、有没有被改、钱花在哪条内容上**。事实性靠 `source` 声明 + 买方自行核验引用。
- `kind: 'self'` 时来源不可核验 → 报告只给 self-attested 并明确提示。
- 链上结算需要 funded 钱包 + facilitator; 本机联调凭据永不冒充链上支付 (报告里带警告)。

## 9. 实现位置

| 层 | 文件 |
|----|------|
| 协议 (签名/验真/分档) | `src/agents/x402/paid-info-protocol.ts` |
| 存储 + 402 + 付款校验 + 买方 | `src/agents/x402/paid-info-store.ts` |
| agent 工具 (publish/list/unpublish/buy/verify) + DID 解析 | `src/agents/x402/paid-info-tools.ts` |
| HTTP 路由 | `src/web/routes-x402-info.ts` |
| CLI | `src/index.ts` 的 `/x402 list|show|buy|verify` |
| 手机端 | 网络页「微信息」区块 (浏览 → 点按购买 → 验真结果) |
| 端到端验证 | `scripts/verify-x402-info.ts` (13 项, 真 HTTP + 真签名) |

## 10. 与技能分享的关系

技能也可以走这套协议卖: `skill_export` 出 CID → 用 `x402_info_publish` 把 (技能说明 + CID + 价格) 发布 →
买方付款后拿到信封, 用 `skill_import(ref=bolloon://skill/<cid>)` 安装, 并可用信封里的 `source.refs` 追溯来源。
