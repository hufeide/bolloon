---
title: 支付中断恢复协议 (Payment Recovery Protocol)
source: session (leo 2026-09-18 交易闭环完成批次 Phase 3)
created: 2026-09-18
last_confirmed: 2026-09-18
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: chapter
tags: [x402, payment-recovery, sigkill, reconcile, claim, two-layer-state, supervisor, idempotency, phase-3]
---

# 支付中断恢复协议 (Phase 3, 2026-09-18)

> 三条铁律 (leo): `payment uncertain ≠ payment failed` · `payment failed ≠ safe to retry` · **先 reconcile, 再决定 retry**。
> 代码: `src/agents/x402/payment-recovery.ts` · 存储对账: `transaction-store.ts:reconcilePendingTransactions`
> 验收: `scripts/verify-payment-recovery.ts` (57/57, 真 SIGKILL) · 单测: `src/test/payment-recovery.test.ts` (14)。

## 1. 决策点只有一个 (纯函数)

```ts
planTransactionRecovery(rec, { claimHeldByOther }) → {
  action: 'retry_payment' | 'reconcile' | 'deliver' | 'verify' | 'complete' | 'closed' | 'wait',
  mustNotRepay, settlementFact, needsResponsibility, reason
}
```

Supervisor / CLI / 恢复脚本都走它, **不许各自 if-else**。判定顺序:

```text
终态 (verified / policy_denied / failed)        → complete / closed
delivery_failed / verification_failed           → closed + needsResponsibility (不重付, 进追责)
别人持有付款权                                   → wait (同一 requestId 只能有一个付款者)
结算事实 unknown 或 paying 且无凭据              → reconcile (不确定 → 先对账)
unpaid + quoted/payment_required                → retry_payment (确认没付过 → 可安全付款)
有支付证据                                       → deliver / verify (绝不重付)
其余                                             → closed (交人)
```

## 2. 五个 SIGKILL 时点 (真子进程真杀, 验收逐条断言)

| 时点 | 被杀时状态 | 恢复后做什么 | 付款次数 |
| --- | --- | --- | --- |
| ① 付款前 | `quoted` / `payment_required` + `unpaid` | 对账前即 `retry_payment` → 安全付款 | **1** |
| ② 拿到付款权后 | `paying` + 无任何凭据 | 对账前: 新 worker **拿不到**付款权(不重复付款); 对账确认没付过 → `payment_required` + `unpaid` → 新 worker 接管后付一次 | **1** |
| ③ facilitator settle 后 | `payment_submitted`/`payment_verified` + `txHash` | 先对账拿到 `txHash` → 禁重付 → 继续交付 → 验真 | **0** |
| ④ 支付成功、交付中 | 正文已落盘、状态未 `delivered` | 只补交付 (幂等) → 验真 | **0** |
| ⑤ 交付后、验真前 | `delivered` + 哈希齐全 | 只补验真 | **0** |

## 3. 两个附加场景 (必过)

- **支付状态未知** (有回执、无 `txHash`): 结算事实维持 `unknown` → `mustNotRepay=true`, 全程 **0 次付款**, 并挂进 `mustNotRepay` 队列等 facilitator 澄清。
- **facilitator 返回成功但没有 txHash**: **不能认定链上结算完成**。
  `paid-info-store` 里 `chainSettled: !!txHash` —— 没 txHash 时 `chainSettled=false`, 于是 `verified` 门必拒;
  并且一步跳到 `fully_settled` 需要 `chainSettled + txHash`, 也会被拒。

## 4. 这一轮真跑逼出的 4 个真问题 (已修 + 有断言)

1. **对账把 `unknown` 当成"没付过"** → 旧 `reconcilePendingTransactions` 只看 `paying && !txHash && !chainSettled` 就允许重试；
   改成两层状态驱动: **有支付凭据 (`receipt`/结算事实非 unpaid) → 一律 `mustNotRepay`**, 只有"连凭据都没有"才降级 `unpaid` + `payment_required`。
2. **对账确认"没付过"后状态没跟着退** → 状态仍停在 `paying`, 下一步永远还是"先对账", 恢复推不动。
   修: 对账结论 `unpaid` 且状态是 `paying` → 同时落 `payment_required` (合法迁移)。
3. **交付前不先对账** → 结算事实停在 `payment_submitted`/`unknown` 就往下走, 拿不到 `txHash`, 审计链也断。
   修: `deliver` 分支在结算事实未到链上口径时**先 reconcile 再交付** (leo 的 ③ 原话: 重启先对账, 发现真实 txHash 或 settled 事实, 禁止重新付款, 继续交付和验真)。
4. **验真用了内存里的旧对象** → 交付步骤刚写下的 `deliveryBytesHash` 只在盘上, 用旧对象验真会得出"正文没记过"的假结论 (真跑把 ④/③ 判成 `verification_failed`)。
   修: `RecoveryDeps.read` —— **验真前重读落盘记录**。同类问题: 对账后本地视图必须与刚落盘的 patch 一致 (少带 `status` 就会回到旧状态)。

## 5. 验收 (57/57) 与三个"0"

```
5 个 SIGKILL 时点全部走对路 · 0 次重复付款 · 0 条记录丢失 · 0 个错误 verified · 所有交易证据可回放
```

- 付款次数由**计数适配器**统计 (每个 transactionId 最多一次付款动作), 不是靠"看起来没重复"
- 记录丢失: 盘上交易条数 ≥ 期望; 非法迁移企图: 持久化回调的错误文件为空
- 证据可回放: 每条交易 `replayTransaction` 均 ≥1 条事件

## 6. 未做 (如实)

- **Supervisor 自动触发**: 恢复计划与执行器已就绪 (`planTransactionRecovery` / `runTransactionRecovery`), 但**还没接进 Supervisor 的 tick**
  (即"支付中断后无人值守自动恢复"目前要显式调用) —— 这是下一步。
- 真人 facilitator 对账: 目前 `reconcile` 只认 `txHash` 与既有凭据; 真链上对账 (查 RPC/facilitator 历史) 属 Phase 1 未做部分。
- 退款/争议状态机 (`refund_pending`/`refunded`/`disputed`) 属 Phase 4。
