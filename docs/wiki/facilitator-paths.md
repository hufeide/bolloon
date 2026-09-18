---
title: facilitator 路径 (Facilitator Paths) — Phase 1 准备
source: session (leo 2026-09-18 交易闭环批次 Phase 1 的本地可验部分)
created: 2026-09-18
last_confirmed: 2026-09-18
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: chapter
tags: [x402, facilitator, verify, settle, txhash, phase-1, mock-facilitator, local-verification]
---

# facilitator 路径 (Phase 1 准备, 2026-09-18)

> 真链上要等外部条件(facilitator 地址 + 买方私钥 + 已充值 Base Sepolia 钱包 + 真卖方 `payTo`)。
> 但 facilitator 的**协议路径**现在就能用**本地 mock facilitator**(真 HTTP 服务, 不是打桩函数)真跑。
> 验收: `scripts/verify-facilitator-paths.ts` (**26/26**)。

## 1. 四条路径如实 (本地真跑过)

| 场景 | 期望 | 实测 |
| --- | --- | --- |
| verify 通过 + settle 成功 + **有 txHash** | `ok=true` · `mode=facilitator` · 真 txHash · 回执可绑信封 · `attempted=true` | ✅ |
| settle 成功但**没有 txHash** | `ok=true` 但 `txHash` 缺失; 落卡片时 `chainSettled: !!txHash` → **false** (不能认定链上结算) | ✅ |
| verify 被拒 (如 `insufficient_funds`) | `ok=false` + `attempted=true` + `verifyRejected=true` + `settlementUncertain=false`; **不会走到 settle** | ✅ |
| settle 失败 (`settle_reverted`) / facilitator 不可达 | `ok=false` + `attempted=true` + `settlementUncertain=true` (**先对账, 不许重付**) | ✅ |

## 2. 报价自洽与凭据绑定 (本地真跑过)

- `validatePaymentRequirements`: metadata↔402 的 `payTo` / `network` / **`itemId`** 全要比对 + 金额上限 + 允许网络白名单
- **凭据绑定**: `expectedItemId` 与凭据里的 `itemId` 不一致 → 拒 (「回执不能跨资源复用」); 一致 → 放行

## 3. 这一轮真跑逼出的 2 个真漏洞 (已修)

1. **facilitator 模式下凭据绑定校验根本没执行** —— 那段校验原先只写在 local-dev 分支里, 而 facilitator 分支提前 `return` 了
   → 拿 A 资源的回执去买 B 资源**不会被拦**。修法: 把绑定校验**提到分模式之前** (两种模式都查)。
   这是 leo Phase 1 清单里「itemId 与支付凭据一致」那一条的本地可见证据。
2. **402 自带的 `itemId` 不参与自洽校验** —— 原来只比 `metadata.itemId`, 与 `payTo`/`network` 的检查不对称
   → 402 声称另一条资源而 metadata 正常时完全不查。修法: 402 的 `itemId`(顶层或 `extra`) 与 metadata/预期不一致 → 拒。

## 4. 还没覆盖的 (等真链, 不装作验过)

```
余额不足 · gas 不足 · 真 RPC 对账 · 真 txHash 可查买卖双方与金额
· Base Sepolia 上至少一笔 verified (需要 BOLLOON_X402_FACILITATOR + BOLLOON_X402_BUYER_KEY + 已充值钱包)
```

未配置这些环境变量时, `verify-minimal-payment-loop.ts --testnet` 会**如实输出"未验证"并跳过**,
不会把 local-dev 结果升格成真链上结果 (这是 Phase 0 就立下的红线)。
