---
title: 交易两层状态协议 (Two-Layer Transaction State)
source: session (leo 2026-09-18 交易闭环完成批次 Phase 0)
created: 2026-09-18
last_confirmed: 2026-09-18
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: chapter
tags: [x402, transaction, two-layer-state, lifecycle, settlement-fact, responsibility, migration, verified-gate, local-dev, base-sepolia, phase-0]
---

# 交易两层状态协议 (Phase 0 冻结, 2026-09-18)

> 一句话: **"这笔交易走到哪一步" 与 "钱到底动没动" 必须分开记**。
> 代码: `src/agents/x402/settlement-state.ts` · 存储: `src/agents/x402/transaction-store.ts` ·
> 验收: `scripts/verify-two-layer-state.ts` (44/44) · 单测: `src/test/settlement-state.test.ts` (18)。

## 1. 为什么必须两层

一层状态表达不了这些**真实**组合, 而它们每一种都对应不同的下一步动作:

| 组合 | 意思 | 下一步 |
| --- | --- | --- |
| `paying + payment_submitted` | 付款请求发出去了, 还没回执 | 等回执 / 对账 |
| `settled + unknown` | facilitator 说成了, 链上状态待确认 | 先对账, **不许重付** |
| `settled + fully_settled` | 钱真到了, 正文还没验 | 交付 + 验真 |
| `delivery_failed + fully_settled` | 钱付了, 正文没交 | 追责 / 退款流程, **绝不重付** |
| `verification_failed + partially_settled` | 部分结算 + 验真不过 | 争议, 不计入 Goal 成功证据 |

## 2. 生命周期 (10 态)

```text
discovered → quoted → payment_required → paying → settled → delivered → verified
      ↘            ↘                      ↓                    ↘ delivery_failed
        policy_denied            (对账可回退 payment_required)      ↘ verification_failed
      ↘ delivered (免费资源, 没有付款环节 → 永远到不了 verified)
```

- 终态: `verified` / `delivery_failed` / `verification_failed` / `policy_denied` / 旧状态 `failed`
- `paying → payment_required` 只在对账确认**没有支付证据**时允许 (回退重试的唯一合法路径)
- 旧状态 `failed` 仍可读 (迁移时保留), 但**已经付过钱的交易不许标 `failed`** (见 §5)
- 免费资源 `discovered → delivered`: 没有付款就没有结算事实, 最高 `delivered`

## 3. 结算事实 (8 态)

```text
unpaid → payment_submitted → payment_verified → fully_settled
                          ↘ partially_settled ↗
        unknown (对账前的不确定)     fully_settled / partially_settled → refund_pending → refunded
```

两条硬规则:

- **`local-dev` 永远不能产生链上结算事实** (最高 `payment_submitted`): 模拟提交 ≠ 链上事实
- 一步跳到 `fully_settled` **必须有链上证据** (`chainSettled=true` + `txHash`), 否则只认 `payment_verified`

语义精度(真跑逼出来的): **取得付款权 ≠ 发出付款凭据**。`claimPayment` 成功只把交易推进到 `paying`,
`settlementFact` 仍是 `unpaid`; 只有真正发出 x402 付款请求那一刻才记 `payment_submitted`
(`paid-info-store` 的 `payment_sending` 事件)。否则"没付款的失败"会被误判成"可能付过钱"。

## 4. 责任候选 (6 类; 机器只给候选, 不做赔偿判决)

| 证据 | 责任候选 |
| --- | --- |
| 内容哈希错误 / 卖方签名错误 / 输出不符 outputSchema | `provider_fault` |
| 输入不符合 inputSchema | `buyer_fault` |
| agent 越过 Policy 付款 | `agent_fault` |
| 交易记录丢失或重复扣款 | `platform_fault` |
| 缺少支付回执 / facilitator·RPC 异常 | `payment_infrastructure_fault` |
| 正文没拿到 / 资源执行失败 / 证据不足 | `undetermined` |

`undetermined` 不是兜底垃圾箱, 而是**明确表态"证据不足不硬归责"**; 候选连证据列表一起写进交易记录
(`responsibility_candidate` 事件), 审计可回溯。

## 5. 写路径规则 (存储层强制, 不靠调用方自觉)

1. **非法迁移拒绝**: `updateTransaction` 用 `checkLifecycleMove()` / `canTransitionSettlement()` 判定,
   不合法 → 抛 `IllegalTransactionTransition` (带 reason/transactionId/target), **记录不被修改**。
2. **有支付证据不许 `failed`**: `txHash` / 回执 / `chainSettled` / 结算事实非 unpaid-unknown 任一存在 →
   拒绝标 `failed`, 只能 `delivery_failed` / `verification_failed` / 回 `payment_required` 走对账。
3. **`verified` 有硬前置**: `chainSettled=true` + `protocolVerified=true` + `contentHash===deliveryHash` + `receiptHash`
   (完整八项门见 §6)。
4. **结算事实变化无条件留痕**: 即使调用方忘了给 event, 也会自动追加 `settlement:<fact>` 事件 (审计不许丢)。

## 6. 最终 verified 门 (八项全满足)

```text
chainSettled === true · protocolVerified === true · 交付正文在盘上 · 交付字节哈希与交付时一致
· 支付回执哈希已绑定 · 结算事实 ∈ {fully_settled, partially_settled} · 资源执行成功 + 输出合契约 · Goal 判据命中
```

- 正文实体落在 `~/.bolloon/x402/deliveries/<transactionId>.txt`, 验真时**重算哈希**, 不信记录自述
- 协议层规范化哈希 (`contentHash`/`deliveryHash`) 与字节哈希 (`deliveryBytesHash`) 是**两套独立校验**, 不互相冒充
- Goal 侧纵深防御: 即使有人绕过门写成 `verified`, 没有 `chainSettled=true` 也不计入 Goal 成功证据

## 7. 迁移 (老记录 → v2)

- 读路径幂等迁移: 补 `schemaVersion=2` + 按**既有证据**推导 `settlementFact` (`deriveSettlementFact`)
- 保留原 `status` 与**全部** events; 追加一条 `migrate-v2` 说明推导来源; 原文件备份 `.bak-v1`
- 推导不出确定事实时给 `unknown` (诚实: "不知道钱动没动"), 不猜
- 迁移后仍受同一套迁移表约束 (不能回到 `paying`)

## 8. 这一轮真跑逼出来的三个真 bug (已修 + 有断言)

1. **付了钱仍标 `failed`** (`trade.ts` 失败路径): 付款成功后资源侧失败 → 旧代码一律 `failed`, 支付证据被抹掉
   → 改为结构化付款结果 (`attempted` / `settled` / `settlementUncertain` / `verifyRejected`) 决定状态:
   已付款 → `delivery_failed`; 不确定 → `payment_required + unknown` (先对账); 明确没付成 → `payment_required`; 没凭据 → `failed`。
2. **同 requestId 重放重驱付款流程**: 旧记录已 `delivered`/`paying` 时仍从头跑"报价→付款"
   → 加幂等短路 (已走过付款流程的状态直接返回既有事实)。
3. **结算事实变化可静默不留痕**: 调用方不给 event 就丢审计 → 写路径无条件补 `settlement:*` 事件。

## 9. 验收与未做

- 验收 `scripts/verify-two-layer-state.ts` **44/44**: 老记录迁移(事件不丢+备份) · 非法迁移拒绝且记录未变 ·
  local-dev 0 次 `fully_settled` · `chainSettled=false` 0 次 `verified` · 四种组合可表达 · verified 门八项逐一缺失都拒 ·
  正文被换过能检出 · 交易证据进 Run 带结算事实与责任
- 单测 `src/test/settlement-state.test.ts` **18/18**
- **未做**: Phase 1 Base Sepolia 真支付 (等 facilitator + 充值钱包) · Phase 2 可执行 Skill 闭环 ·
  Phase 3 Supervisor 五类支付恢复 (SIGKILL 时点) · Phase 4 PartiallySettled 里程碑 / dispute / 退款状态机落地
