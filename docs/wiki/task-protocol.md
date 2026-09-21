---
title: 任务协议 (bolloon-task/1) — 统一任务生命周期 + 受控自主签名
source: session (leo 2026-09-21 经济闭环计划 + 支付规则修正; 真实实现与真跑结论)
created: 2026-09-21
last_confirmed: 2026-09-21
schema_version: 2
audience: self
stage: current
status: current
tags: [task-protocol, economy, payment, wallet, signature, phase1]
---

# 任务协议 bolloon-task/1 (Phase 1)

## 一句话

把「任务委派」与「交易协议」统一: 任务有**自己的状态机**, 支付**分层叠加**, 两者**严格分离** ——
"已付款" 永远不等于 "任务成功"。

模块: `src/agents/task-contract.ts`(纯契约层: 类型 + 状态机 + 校验 + 签名 + 审计 + 公开投影, 不做 IO 编排) ·
单测 `src/test/task-contract.test.ts`(**22/22**)。

## 1. 任务状态机 (14 态, 与支付事实分离)

```
discovered → quoted → submitted → accepted → payment_required → paying → paid
                                                              → running → delivered → verified ★
终态: verified ★ · rejected · failed · cancelled · policy_denied
```

- **非法迁移一律拒绝**, 返回 `{ok:false, reason:'非法任务迁移 X → Y (拒绝, 不静默修正)'}` —— 与交易层的写路径裁决同一条纪律。
- `paying → payment_required` 是**合法**的 (付款不确定 → 回去等对账, **不许当失败**); `paying → verified` 非法。
- `delivered → verified` 是必经一步: 交付完还要验真, 才能算成功。

## 2. 支付事实 (与 `x402/settlement-state.ts` 同一套)

`TASK_PAYMENT_FACTS` 与 settlement-state 的 `SETTLEMENT_FACTS` **做集合相等断言**(防两套口径漂移)。
`maxFactForMode`: `facilitator → fully_settled`(链上口径上限) / `local-dev → payment_submitted`(取自 `LOCAL_DEV_MAX_FACT`) / `none → unpaid`。

**成功的唯一判据** `isTaskSuccessful` = `state==='verified'` ∧ 事实 ∈ {`fully_settled`, `payment_verified`}。
→ **local-dev 永远不算任务成功**(`payment_submitted` 不是成功)。

## 3. 幂等

- `taskRequestId({instruction, capability, buyerDid, salt})` = `treq-<sha256 前 16 位>` —— **确定性**: 同一任务重发得到同一 requestId, 不会产生第二笔付款。
- `dedupeInbox(inbox, incoming)` —— 接收方按 requestId 去重: **不重复接受、不重复执行、不重复收费**。
- 报价必须与请求自洽: `validateQuoteAgainstRequest` 校验 `taskId` / `requestId` / `capability` / 金额 ≤ 预算 / 币种 / 网络 —— **回执不能跨请求复用**。

## 4. 支付模式 (含 leo 2026-09-21 修正)

`manual | policy | autonomous | agent-authorized`

> **规则修正(用户原话)**: 删除"智能体不得接触私钥"; 改为**允许受控的本地 Agent Runtime 自主签名** ——
> 私钥**仍只在本机**; 公共网页 / P2P 消息 / Network Pulse / 公开交易记录**永远拿不到**;
> 每次签名写入审计账本; 越权网络 / 越额 / 重复 requestId 一律拒绝。
> 高级模式("智能体可直接读原始私钥字符串")只在本地进程、**默认关闭**、不经网页配置、不进 P2P、不写任务记录/日志。

`authorizeWalletSignature(req)` 是**唯一放行闸 (fail-closed)**, 9 条检查全过才允许本机钱包模块去签:

| 检查 | 拒绝条件 |
|---|---|
| `modeIsAutonomous` | manual / policy 模式不走此闸(要人工确认) |
| `agentAuthorized` | 用户未在本地显式开启自主签名 |
| `walletAvailable` | 本机钱包不可用 |
| `networkAllowed` | 网络不在允许列表 |
| `capabilityAllowed` | 能力不在白名单 |
| `underPerTx` | 超过单笔上限 |
| `underDaily` | 今日累计 + 本次 > 日上限 |
| `notDuplicate` | requestId 已签过 |
| `amountIsInteger` | 金额不是正整数原子单位(浮点 = 模糊边界, 拒) |

它**不做签名动作**, 只决定"允不允许" —— 私钥永远不流经这里。

## 5. 签名与审计

- 信封签名覆盖 **去掉 `signature` 字段后的规范化 JSON**(`canonicalize`, 与 Pulse 同一套规范化);
- 签名**存 base64 字符串**(便于走 JSON/P2P), 验签前解回 **64 字节 Uint8Array** ——
  @diap/sdk 的 `KeyManager.sign/verify` 走的是 ed25519 原始字节。**真跑抓到的 bug**: 存 base64 却按字符串验 → 每个签名都验不过 → 已修 + 加"解出来必须 64 字节"的断言。
- `recordSignatureAudit` 写 `~/.bolloon/wallet-signatures.jsonl`(append-only): 时间 / 类型 / 模式 / requestId / taskId / 金额 / 网络 / 能力 / 签名者指纹 / payload 摘要。
  **只记摘要**: 不记私钥、不记任务正文、不记 seed(`assertAuditSafe` 用 `AUDIT_FORBIDDEN_KEYS` 扫描)。
- `readSignatureAudit(home, limit)` 给本地 Web UI 的"签名记录"用。

## 6. 公开投影 (Phase 5 用)

`toPublicSummary(task)` 只给: `kind`(task_posted / task_accepted / task_completed / trade_settled / trade_verified) ·
`capabilityGroup`(**粗类别**) · `amountBucket`(**区间**: tiny/small/medium/large, 不给精确金额) · `settlement`(`chain` / `local-dev` / `none`) · `state`。
**绝不包含**: DID · 任务正文 · 精确金额 · 交易哈希 · 私有 Agent 名。
`local-dev` 的投影明确标 `local-dev`, **不冒充链上**。

## 7. 与 `agent_delegate` 的关系

`agent_delegate` 保留为**快速委派**; `bolloon-task/1` 是**标准化生命周期**。两者共用同一套支付/恢复/证据基础设施, 不新造平行 harness。

## 8. 单测覆盖 (22 项)

状态机合法/非法/终态无出边 · 付款不确定回退 · 事实集合与 settlement-state 相等 · local-dev 不算成功 ·
requestId 确定性 + 收件箱去重 · 请求校验 9 条拒绝路径 · 报价篡改 6 条 · 签名放行闸 8 条拒绝 + 2 条放行 ·
签名往返/篡改/异密钥 + 编码 64 字节 · 审计不含正文/私钥 + 敏感键扫描 · 金额区间边界 · 公开投影无私人字段。

## 9. 下一步 (未做)

- **Phase 2**: 任务收件箱 + P2P 任务帧(把契约接到真实传输)。
- **Phase 3**: 把 `authorizeWalletSignature` 接到真实签名路径 + 签名审计的本地 Web UI 视图。
- **Phase 4-6**: 任务↔交易绑定面板 / 公共经济脉冲(新增 5 类事件 + Pulse schema 升级, 保持原五类兼容) / 网关页 Agent Economy 区。
