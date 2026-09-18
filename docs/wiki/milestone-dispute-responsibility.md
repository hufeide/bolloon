---
title: 里程碑结算 / 争议 / 责任 (Milestone, Dispute & Responsibility)
source: session (leo 2026-09-18 交易闭环完成批次 Phase 4)
created: 2026-09-18
last_confirmed: 2026-09-18
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: chapter
tags: [x402, milestone, partially-settled, dispute, refund, responsibility, audit, phase-4]
---

# 里程碑结算 / 争议 / 责任 (Phase 4, 2026-09-18)

> 代码: `src/agents/x402/milestone-settlement.ts` · 写路径: `transaction-store.ts` · 门槛: `goal-run-bridge.ts`
> 验收: `scripts/verify-settlement-responsibility.ts` (50/50) · 单测: `src/test/milestone-settlement.test.ts` (12)。

## 1. 里程碑结算 (PartiallySettled)

```ts
makeMilestone({ milestoneId, title, amount })   // amount = 正整数原子单位字符串 (浮点/0 直接拒)
milestonesMatchAmount(ms, txAmount)             // 合计必须 == 交易金额 (账不平就拒)
applyMilestoneResult(ms, id, { paymentStatus, deliveryStatus, verificationStatus, evidence })
aggregateMilestones(ms) → { paid, delivered, verified, failed, allComplete, partiallyComplete,
                            nextMilestoneId, settlementFact, shouldDispute, reason }
```

规则 (leo 原话落地):

```text
部分里程碑成功            → partially_settled
全部支付 + 全部交付 + 全部验真 → fully_settled (且状态才能 verified)
任一里程碑交付/验真失败     → shouldDispute = true → 进争议
★ partially_settled 一律**不进** Goal 成功证据
```

第一版只支持**明确里程碑**(`milestone_1 报告骨架` / `milestone_2 数据和来源` / `milestone_3 Skill 执行结果`),
每里程碑记 `amount / paymentStatus / deliveryStatus / verificationStatus / evidence`。

## 2. 争议 (Dispute)

生命周期新增 **`disputed`** (终态: 自动化到此为止; 钱的归宿在**结算层** `refund_pending → refunded`)。

**必须绑定的证据** (`buildDispute`): 原始报价(quote) · Payment Header · facilitator response · txHash ·
内容哈希 · 签名信封 · Run(step) · Goal evidence · 失败时点 · 责任候选。
缺项不阻塞开争议, 但**必须显式列在 `missingEvidence` 里** —— 后续人工/仲裁要看到缺口, 不许假装证据齐。

**三条禁令** (唯一实现 `settlement-state.ts:disputeForbids`, 写路径与验收共用):

| 禁令 | 表现 |
| --- | --- |
| 不能自动重付 | `disputed` → `paying` / `payment_required` 一律拒绝 |
| 不能标 verified | `disputed` → `verified` 一律拒绝 |
| **不能静默关闭** | 无 `resolution` 时不许改状态; 收尾必须走 `resolveDispute({decision, by, reason, evidence[]})`, **不带证据直接抛错** |

## 3. 退款路径 (结算层, 单调)

```text
payment_verified / partially_settled / fully_settled → refund_pending → refunded (终态)
```

★ 真跑抓到一个**真漏洞**: 「一步到 `fully_settled` 需链上证据」那条例外会把 **`refunded` 绕回 `fully_settled`**
(钱退出去又算结算)。已修: 例外只对"还没到链上口径"的事实生效, `refunded`/`refund_pending` 明确排除。

## 4. 责任判定 (机器只给候选)

证据 → 候选表 (Phase 0 起就在用, Phase 4 落到交易记录 + Run/Goal 证据):

| 证据 | 候选 |
| --- | --- |
| 内容哈希错 / 卖方签名错 / 输出不符契约 | `provider_fault` |
| 输入不符 inputSchema | `buyer_fault` |
| 越过 Policy | `agent_fault` |
| 记录丢失/重复扣款 | `platform_fault` |
| 缺回执 / facilitator·RPC 异常 | `payment_infrastructure_fault` |
| 证据不足 / 执行失败但交付物合契约 | `undetermined` |

## 5. Goal 成功证据的最终门槛

```ts
milestoneGoalEligibility(rec, { executionOk, goalCriteriaHit })
= 无未收尾争议 ∧ (里程碑全完成 或 无里程碑) ∧ 结算事实 ≠ partially_settled
  ∧ status === verified ∧ chainSettled ∧ executionOk ∧ goalCriteriaHit
```

证据桥 (`goal-run-bridge.ts`) 已改用这个门槛, 并把 `milestones=x/y`、`milestoneSettlement=`、`dispute=opened/resolved`
写进 Run/Goal 证据行 —— 审计一眼能看出"钱到哪一步、货到哪一步、有没有争议"。

## 6. 审计出口

| 形态 | 接口 |
| --- | --- |
| Web | `GET /api/x402/transactions`(列表 + 里程碑聚合 + 争议/部分结算标记) · `GET /api/x402/transactions/:id`(明细 + 里程碑 + 争议 + 责任 + Goal 资格 + 证据链回放; 不存在 → 404) |
| CLI | `/tx`(最近交易两层状态一览) · `/tx <transactionId>`(完整审计) |

## 7. 验收 (50/50) 与未做

- 覆盖: 里程碑账平/浮点拒 · 部分完成 → `partially_settled` 且不进成功证据 · 全完成+链上 → `verified` 才计入 ·
  失败 → 争议 · 证据缺口显式列出 · 三条禁令(纯函数 + 写路径双验) · 收尾必须带证据 · 退款单调且不许被绕回 ·
  责任 8 类逐条 · Run 证据带里程碑/争议/责任 · 审计 API(含 404)
- **未做**: 里程碑的**分次付款**(目前里程碑只记状态, 真链上按里程碑分批付款要 Phase 1 的多笔结算) ·
  自动退款(第一版只有状态机, 不自动执行退款) · 仲裁 UI
