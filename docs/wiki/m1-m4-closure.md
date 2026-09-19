---
title: M1–M4 收口验收口径 (Frozen Acceptance Contract)
source: session (leo 2026-09-18 M1–M4 收口计划 + 真跑结论)
created: 2026-09-18
last_confirmed: 2026-09-18
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: chapter
tags: [m1, m2, m3, m4, closure, acceptance, evidence, no-fake-green]
---

# M1–M4 收口验收口径 (2026-09-18 冻结)

> 目的: 防止"测试绿了, 但产品闭环仍有两套事实"。本页是**唯一口径**, 与代码冲突时以本页为准并修代码。

## 1. 四个唯一事实来源

| 事实来源 | 回答什么 | 落盘位置 |
| --- | --- | --- |
| **Goal** | 任务是否完成、判据是否满足 | `~/.bolloon/goals/<goalId>.json` |
| **Run** | 本次执行做了什么、是否中断、是否恢复 | `~/.bolloon/runs/<runId>.json` |
| **Transaction** | 是否付款、是否交付、是否验真 | `~/.bolloon/x402/transactions/<txId>.json` |
| **Report Card** | **用户唯一看到的结果** | CLI 文本 / `--json` |

## 2. 四条不可违反的规则

```text
① local-dev 永远不能变成链上 verified
② 付款成功但没有执行 → 不得显示完成
③ 执行成功但没有完整证据 → 不得显示完成
④ 同一 requestId 永远不能产生第二笔付款
```

规则 ②③ 的落地位置: `src/agents/task/report-card.ts:buildReportCard` (两条硬门 `bought_not_executed` / `executed_without_evidence`)。
规则 ① 的落地位置: `settlement-state.ts:evaluateVerifiedGate` (八项门) + `settlement-state.ts` 的信任阶梯。
规则 ④ 的落地位置: `task-runner.ts:defaultRequestId` (按任务+预算确定性派生) + `trade.ts` 的幂等短路 + `claimPayment` 独占。

## 3. 用户态只有 5 个 (不是 "4 态")

口径修正 (leo 2026-09-18 指出): 代码里实际有 **5 个用户可见状态**, 文档此前写"4 态"是错的。

```text
准备中 → 正在获取能力 → 正在执行 → 已完成 / 需要你处理
```

内部 10 态生命周期与 8 态结算事实**只在** `/trace`、`/tx`、诊断模式出现, 不进报告卡。

## 4. 里程碑状态与证据 (2026-09-18)

| 里程碑 | 状态 | 证据 |
| --- | --- | --- |
| **M1** 一个任务 → 一个 Skill → 一个报告 | ✅ 落地 | `scripts/verify-task-loop.ts` 59/0 · `bolloon task` CLI 真跑 |
| **M2** 中断可恢复、不重复付款、不重复执行 | ✅ 落地 | `scripts/verify-task-closure.ts` 的 **[C]** 五个真 SIGKILL 时点 + Supervisor 接回 |
| **M3** 支付边界 (不跑真链) | ✅ 落地 | **[D]** local-dev / mock facilitator / 未配置 三模式互不冒充 |
| **M4** 失败安全与最小争议出口 | ✅ 落地 | **[B]** 预算不足 / 无 Skill / 输出缺字段 / 执行超时 / 重复提交 / 已买未执行 |
| 真实 Base Sepolia 链上支付 | ⏳ **本批明确不做** | 需 facilitator + 钱包 + 真卖方 payTo; M1/M2 不被它阻塞 |

## 5. 跨 M1–M4 验收矩阵 (`scripts/verify-task-closure.ts`)

```text
[A] 用户主路径   : 自动找 Skill · 预算门 · local-dev 付款 · 真执行 · 报告卡已完成 · Goal completed · Run done
                    · Transaction 有 resourceOutcome · 无链上冒充 · 证据走统一证据桥
[B] 失败路径     : B1 预算不足(不付款) · B2 无可用 Skill · B3 输出缺字段(verification_failed)
                    · B4 执行超时(delivery_failed) · B5 重复提交(一笔付款) · B6 已买未执行(不重复执行)
[C] M2 恢复     : before_payment / after_payment / after_install / before_execute / after_execute
                    五个**真 SIGKILL** → 同一 Goal 续跑 · 付款最多一笔 · 非幂等不重复执行 · Goal 不误标完成
[D] M3 边界     : 三模式互不冒充 · 八项门拒绝假 verified
[E] Supervisor   : tickOnce 真跑, task 目标走**同一个恢复决策函数**
```

## 6. 失败 → 出口映射 (M4)

| 失败形态 | 交易状态 | 用户看到 |
| --- | --- | --- |
| 价格超预算 | 无交易 (`policy_denied` 前置) | 需要你处理 + 哪一层拦的 |
| 无可用 Skill | 无交易 | 需要你处理 + 说明原因 |
| 技能产出了输出但契约不过 | `verification_failed` | 需要你处理 + 输出契约未通过 |
| 技能崩了/超时/没装上 | `delivery_failed` | 需要你处理 + 卡在哪一步 |
| 付款事实不确定 | 维持 `payment_required` + `unknown` | 需要你处理 + "先对账, 不许重付" |
| 争议未解决 | `disputed` | 需要你处理 (只能 `resolveDispute` 带证据关闭) |

责任信息保留在交易记录: 失败阶段 (`resourceOutcome.failureStage`) · 付款证据 (`paymentMode`/`paymentReceipt`/`chainSettled`/`txHash`) · 交付证据 (`contentHash`/`deliveryHash`/`deliveryBytesHash`) · 输出契约结果 · Run/Goal 关联 · 责任候选。

## 7. 本批明确不做 (冻结)

真实链上支付 · P2P 发现 · 多链 · 自动退款 · 复杂仲裁 · Web 任务入口 · 移动端任务入口。
