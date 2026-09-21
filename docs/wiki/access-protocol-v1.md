---
title: 外部接入协议 v1 (P1 冻结) — 版本策略 · 统一 JSON 信封 · 错误码表 · 状态映射 · 红线
source: docs/wiki/agent-access-layer.md §2/§5/§7 (P1 收尾) + 本仓代码逐条核对 (src/cli-entry.ts · src/agents/task-contract.ts · src/agents/x402/settlement-state.ts · src/agents/x402/transaction-protocol.ts · src/agents/x402/payment-recovery.ts · src/agents/task/report-card.ts · src/setup/onboard.ts · src/agents/p2p-info.ts · src/agents/trace-export.ts · src/web/server.ts · src/agents/gateway-network.ts)
created: 2026-09-21
last_confirmed: 2026-09-21
schema_version: 2
audience: public
stage: current
status: current
confidence: high
entity_type: protocol
tags: [access-protocol, p1-frozen, envelope, error-codes, state-mapping, local-dev, bolloon-task-1]
---

# 外部接入协议 v1 (P1 冻结, 2026-09-21)

> **一句话**: 把 Bolloon 对外那层 (任务 / 支付 / 交易) 冻结成**可引用的规范** ——
> 版本怎么变、JSON 怎么回、错误怎么码、内部状态怎么映射成用户能懂的 4 个态、哪些红线永远不许碰。
>
> **这是外部 Agent 与验收脚本可以引用的权威口径**; `docs/wiki/agent-access-layer.md` §2/§5 的落地细节以本页为准。

## 0. 怎么读这一页 (冻结 ≠ 已实现)

**P1 的产物是"协议" —— 冻结一份别的东西可以照着实现的契约。** 本仓现状是"契约层已落, 入口层未落":

| 层 | 本仓现状 | 证据 |
|---|---|---|
| 任务契约 (`bolloon-task/1`) | **已落** | `src/agents/task-contract.ts` + `src/test/task-contract.test.ts` 22/22 |
| 交易两层状态 + verified 门 | **已落** | `src/agents/x402/settlement-state.ts` (44/44 验收) · 单测 18/18 |
| 支付恢复 / 对账 | **已落** | `src/agents/x402/payment-recovery.ts` (57/57, 真 SIGKILL) |
| CLI 子命令 (P3) | **部分**: 只有 M1 的 `bolloon task` 等少数命令 | `src/cli-entry.ts:136-201` |
| 统一 JSON 信封 (§2) | **未落**: 今天没有一条命令按本页格式输出 | 见 §2.1 真实输出对照 |
| 错误码 (§3) | **未落**: `src/` 里不存在任何本页错误码常量 | `grep` 零命中 |
| MCP 适配层 (P4) | **未落**: 无 `bolloon mcp` 子命令 | `grep "case 'mcp'" src/cli-entry.ts` 零命中 |

**标记法 (全页统一)**:
- `(planned)` = 规范已冻结, **代码里还没有**。外部 Agent **不许**当它已存在。
- 没有 `(planned)` 标记的命令/端点/字段 = **今天真能跑**, 且给了 `文件:行号`。

---

## 1. 协议版本策略

### 1.1 命名规则

```
bolloon-task/<major>
```

- `major` = **正整数**, 从 1 开始, **没有小数点** (不允许 `bolloon-task/1.1`)。
- 常量落在代码里: `export const TASK_PROTOCOL = 'bolloon-task/1'` (`src/agents/task-contract.ts:22`)。
- 该字段出现在**每一个**协议信封上: `TaskRequest.protocol` · `TaskQuote.protocol` · `TaskAccept.protocol` · `TaskReject.protocol` · `TaskResult.protocol` · `TaskFailure.protocol` (`task-contract.ts:124-194`)。
- 比较是**精确相等**, 不做前缀/区间匹配: `req.protocol !== TASK_PROTOCOL` → 拒 (`task-contract.ts:222`)。

### 1.2 何时 bump (不兼容变更)

| 变更 | bump? | 理由 |
|---|---|---|
| 删除/改语义任一已有字段 | **bump** | 老实现会读到不同意思的同一个键 |
| 改 `TASK_TRANSITIONS` 的合法边 (`task-contract.ts:45-60`) | **bump** | 老实现的状态推进会被新实现判非法 |
| 改 `TASK_PAYMENT_FACTS` / `SETTLEMENT_FACTS` 的**取值集合语义** (`task-contract.ts:85-88`, `settlement-state.ts:156-165`) | **bump** | 支付事实是与 x402 做**集合相等断言**的一层, 改了就分叉 |
| 改 §2 信封字段的**含义** (非新增) | **bump** | Agent 按旧含义解析会得到错误结论 |
| 改 §3 错误码的**含义**或把成功码改成失败码 | **bump** | 码是机器分派依据 |
| 改 §4 对外 4 态的**集合** | **bump** | 这是用户可见口径 |

### 1.3 何时**不** bump (兼容变更)

| 变更 | 处理 |
|---|---|
| 新增**可选**字段 (老实现忽略即可) | 不 bump, 但必须在 §2 标 `optional` |
| 新增**错误码** | 不 bump。**客户端必须忽略未知 `code`** (见 §2.2 硬规则 3), 否则每加一个码就要全世界改客户端 |
| 内部状态改名、但不改 §4 对外映射 | 不 bump (对外 4 态是契约, 内部 14/11 态不是) |
| `message` 文案变化 | 不 bump。**`message` 不保证稳定, 不许程序判断它** |

### 1.4 旧版本如何被拒绝 (真实行为, 非设计)

`validateTaskRequest` (`src/agents/task-contract.ts:216-246`) 的**第一条**检查就是版本:

```ts
if (req?.protocol !== TASK_PROTOCOL) issues.push(`协议版本不对: ${String(req?.protocol)} (要 ${TASK_PROTOCOL})`);
```

→ 返回 `{ ok: false, issues: ['协议版本不对: bolloon-task/2 (要 bolloon-task/1)'] }`。

冻结语义 (对齐仓库既有纪律"拒绝, 不静默修正"):

1. **不降级、不猜测、不部分接受**: 版本不对就是整体拒收, 不会"就当 1 处理"。
2. **报价侧同样**: `validateQuoteAgainstRequest` 也查 `quote.protocol !== TASK_PROTOCOL` (`task-contract.ts:251`), 防"请求一个新版本、回执一个老版本"。
3. **未知状态/未知枚举同样拒**: `checkTaskMove` 对未知状态给 `未知任务状态: X → Y` (`task-contract.ts:74`); `isLifecycleStatus` / `isSettlementFact` 对未知取值返回 false (`settlement-state.ts:44-46`, `168-170`)。
4. **对外码**: 版本不对 → `PROTOCOL_VERSION_UNSUPPORTED` (§3)。
5. **今天还没有版本协商** (无 `Accept-Protocol` / capability 握手)。未做, 如实标 `(planned)`; v1 的唯一协商方式就是"客户端读本页 + 发 `bolloon-task/1`"。

---

## 2. 统一 JSON 输出信封

### 2.1 信封 (冻结格式)

```json
{ "ok": true, "code": "TASK_SUBMITTED", "message": "Task submitted",
  "data": {}, "evidence": [], "next_action": null }
```

| 字段 | 类型 | 含义与硬规则 |
|---|---|---|
| `ok` | `boolean` | **唯一的成功/失败分派位**。`ok:false` 时 `data` 里可能仍有有效载荷 (如待审批的付款)。退出码/人读文本**都不**是判据 |
| `code` | `string` | `SCREAMING_SNAKE_CASE`, 取自 §3 表。机器按它分派; **必须能忽略未知 code** (见硬规则 3) |
| `message` | `string` | 人可读一句话 (中文/英文均可)。**不保证稳定**, 不许用来做程序判断 |
| `data` | `object` | 该动作的载荷。字段命名统一 **camelCase** (与代码一致: `taskId`/`requestId`/`amountAtomic`/`settlementFact`)。**永不含私钥、seed、任务正文以外的敏感值** |
| `evidence` | `string[]` | 机器**可核验的引用**: `requestId` / `taskId` / `transactionId` / `txHash` / `contentHash` / `runId` / 审计文件路径。空数组 = "这次没有可核验凭据", **不等于失败**。每条引用都能被独立复查 |
| `next_action` | `string \| null` | 机器可读的**受控词表**串 (§2.3), `null` = 无需额外动作。**不是自由文本** |

**三条硬规则 (冻结)**:

1. **成功和失败都必须结构化** —— 任何命令, `--json` 下失败也要给 `ok:false` + `code` + `next_action`, 不许"打印一行错误就退出"。
2. **"已付款" ≠ "任务成功"** —— `code`/`state` 里出现的 `paid` / `delivered` 都不是成功; 成功的唯一判据是 §5.2。
3. **客户端必须忽略未知 `code`** —— 老客户端遇到新错误码时, 按 `ok:false` + `next_action` 处理, 不崩、不猜; 这是第 1.3 节"新增码不 bump 版本"的前提。

### 2.2.1 相关约定: 字段命名风格

全部 **camelCase**, 与代码一致; 集合/枚举用**小写下划线**字面量 (`payment_submitted` / `agent-authorized` / `local-dev`)。理由: 信封与载荷来自同一套 TS 类型, 不要发明第二套命名。

### 2.2.2 成功示例 1 — `TASK_SUBMITTED` (任务已签发并提交)

```json
{
  "ok": true,
  "code": "TASK_SUBMITTED",
  "message": "Task submitted",
  "data": {
    "taskId": "task-mf3k2a-9c1e04",
    "requestId": "treq-4a7d1c9b3e8f2065",
    "capability": "research",
    "paymentMode": "policy",
    "state": "submitted",
    "budget": { "maxAmount": "50000", "currency": "USDC", "network": "base-sepolia" }
  },
  "evidence": ["treq-4a7d1c9b3e8f2065", "task-mf3k2a-9c1e04"],
  "next_action": null
}
```

(`requestId` 形态取自 `taskRequestId` = `treq-` + sha256 前 16 位, `task-contract.ts:203-206`; `taskId` 形态取自 `newTaskId` = `task-<base36 时间>-<6 hex>`, `task-contract.ts:208-210`; `budget` 字段名取自 `TaskBudget`, `task-contract.ts:118-122`。)

### 2.2.3 成功示例 2 — `TASK_VERIFIED` (已验真, 且支付事实到链上口径)

```json
{
  "ok": true,
  "code": "TASK_VERIFIED",
  "message": "Task verified",
  "data": {
    "taskId": "task-mf3k2a-9c1e04",
    "requestId": "treq-4a7d1c9b3e8f2065",
    "state": "verified",
    "settlementFact": "fully_settled",
    "chainSettled": true,
    "transactionId": "tx-mf3k2b-a71c02",
    "txHash": "0x9f...",
    "contentHash": "3b1f...",
    "deliveryHash": "3b1f...",
    "receiptHash": "c07a...",
    "amountBucket": "small"
  },
  "evidence": ["tx-mf3k2b-a71c02", "0x9f...", "3b1f...", "receipt:c07a..."],
  "next_action": null
}
```

字段名逐一来自代码: `settlementFact`/`chainSettled`/`txHash`/`contentHash`/`deliveryHash`/`receiptHash` (`transaction-protocol.ts:64-127`) · `amountBucket` (`task-contract.ts:419-429`)。
**注意**: `partially_settled` 在交易层 verified 门里算通过 (`settlement-state.ts:394`), 但在任务层的成功判据里**不算** (只认 `fully_settled`/`payment_verified`, `task-contract.ts:102-105`)。这个口径差已标记在 §6。

### 2.2.4 失败示例 1 — `PAYMENT_REQUIRED` (需要人/策略放行, 不是失败于任务)

```json
{
  "ok": false,
  "code": "PAYMENT_REQUIRED",
  "message": "Payment approval is required",
  "data": {
    "taskId": "task-mf3k2a-9c1e04",
    "requestId": "treq-4a7d1c9b3e8f2065",
    "paymentMode": "manual",
    "amountAtomic": "1000",
    "currency": "USDC",
    "network": "base-sepolia",
    "payTo": "0x8dF...",
    "capability": "research"
  },
  "evidence": ["treq-4a7d1c9b3e8f2065"],
  "next_action": "approve_payment"
}
```

(`amountAtomic` 的正整数原子单位纪律见 `task-contract.ts:214` `ATOMIC_RE`; `payTo` 来自 `TaskQuote.payTo` / `InfoItemMetadata.payTo`。) **这就是"付款待放行"的正确表达 —— 不是错误, 不是重试信号。**

### 2.2.5 失败示例 2 — `NETWORK_NOT_JOINED` (前置条件没满足)

```json
{
  "ok": false,
  "code": "NETWORK_NOT_JOINED",
  "message": "This node has not joined any network yet",
  "data": {
    "did": "did:diap:abc...",
    "joinedNetworks": [],
    "registryReady": false
  },
  "evidence": [],
  "next_action": "rejoin_network"
}
```

(`did` 与 `capabilities` 形态取自 `src/agents/p2p-info.ts:167-179` 的 `bolloon-p2p-info/1` JSON; `registry.ready` 取自 `GET /api/registry` 真实返回 `{services, count, ready}`, `src/web/server.ts:3493-3503`。)

### 2.3 `next_action` 受控词表 (冻结)

| 值 | 含义 | 今天存在? |
|---|---|---|
| `null` | 无需额外动作 (成功终态) | — |
| `x402_payment_retry:<transactionId>` | 对账已确认可安全付款, 由**持钱包的一方**走同一 requestId 的幂等路径 | **是**, 字面量在 `payment-recovery.ts:299` |
| `x402_continue:<transactionId>` | 继续未完结交易 (交付/验真) | **是**, `payment-recovery.ts:300` |
| `reconcile` | 付款状态不确定 → **先对账**, 绝不重付 | 语义已冻 (`payment-recovery.md` §1), 串待 P3 接出 |
| `approve_payment` | 等人工/本地策略放行 | (planned: P3) |
| `needs_human` | 需要人处理 (争议/越权/预算) | 字面量已在仓库用作 `wakeReason` (`payment-recovery.ts:285`) |
| `retry_same_request` | 同 requestId 重发 (幂等, 不会产生第二笔) | (planned: P3) |
| `rejoin_network` / `redefine_capability` / `raise_budget` / `upgrade_client` | 前置条件类 | (planned: P3) |
| `wait` | 远端仍在执行, 稍后再查 | (planned: P3) |

### 2.4 今天真实能拿到的 JSON (照实对照, 别把信封当成已有)

| 命令 | 真实输出顶层键 | 证据 |
|---|---|---|
| `bolloon task "<任务>" --json` | `ok, status, conclusion, card, goalId, runId, transactionId, advisor, payment, outputIssues, budget, stages` | `cli-entry.ts:389-395` |
| `bolloon task --resume <goalId> --json` | `resumed, action, reason, mustNotRepay, card` | `cli-entry.ts:359` |
| `bolloon trace [<runId>] --json` | `schema:"bolloon-agent-trace/1", runId, goalId, status, steps[], counts{total,ok,fail,totalMs}, tools[], evidence[], error` | `trace-export.ts:31-45` |
| `bolloon p2p --json` | `schema:"bolloon-p2p-info/1", ok, source, did, name, peerId, multiaddr, multiaddrs[], relayAddrs[], isRelay, relayService, natStatus, capabilities[], note` | `p2p-info.ts:163-179` |
| `bolloon x402 fetch/balance --json` | `success, data, status, error, paymentInfo{rawHeader,header}, balance, network` | `cli-entry.ts:271-298`, `x402Pay.ts:221-268` |

**结论**: `ok`/`evidence` 与 trace 系的 `schema` 命名风格已经存在; `code`/`message`/`next_action` 三层信封是 P3 要接出来的 (本页冻结, 尚未落地)。

---

## 3. 错误码表 (冻结)

**可重试性口径 (与仓库既有 `retryable` 语义一致)** ——
`TaskFailure.retryable: boolean` (`src/agents/task-contract.ts:192`) 是协议里既有的字段; 仓库目前**唯一**真实产出的地方是 onboard 的连通性测试, 规则是
`retryable = errorClass ∈ {timeout, network, unknown}` (`src/setup/onboard.ts:268`, 分类器 `onboard.ts:88-96`; `ErrorClass = config|auth|network|timeout|io|model|runtime|unknown`, `setup-store.ts:51`)。

本表按同一原则延伸 (✅/❌ 只表示**同一 requestId 重发**是否可能成功且**无重复副作用**):

- ✅ = 纯重查 / 瞬时基础设施故障 / 客户端可修的前置条件 → 重发安全
- ❌ = 重发不会改变结果 (幂等短路、已付款、需要人), **或重发有重复副作用风险**

| 代码 | 触发条件 (真实来源) | 可重试 | `next_action` |
|---|---|---|---|
| `TASK_SUBMITTED` | 任务已签名发出, 进入 `submitted`。**成功码** (`task-contract.ts:49`, 迁移表) | ❌ | `null` (等对方接受/拒绝) |
| `TASK_ACCEPTED` | 对方 `accepted`, 交易进入获取/执行段 (`TaskAccept`, `task-contract.ts:153-161`) | ❌ | `null` |
| `TASK_COMPLETED` | 进入 `delivered` —— **交付 ≠ 成功** (`task-contract.ts:55` 注释: 必经一步) | ❌ | `verify_result` |
| `TASK_VERIFIED` | `state==='verified'` ∧ 支付事实 ∈ {`fully_settled`,`payment_verified`} (`task-contract.ts:102-105`) | ❌ | `null` |
| `PAYMENT_REQUIRED` | 需要付款/审批: `manual` 模式, 或策略未命中白名单 (`authorizeWalletSignature.modeIsAutonomous` 为假, `task-contract.ts:348`) | ❌ | `approve_payment` |
| `PAYMENT_PENDING` | 付款已发出、结果未定: `paying` + 事实 `payment_submitted`/`unknown`; 或 Facilitator 说成功但**没 txHash** (`payment-recovery.md` §3) | ❌ (**绝不重发付款**) | `reconcile` |
| `POLICY_DENIED` | 策略拒绝: 终态 `policy_denied` (`task-contract.ts:30/47`); 或放行闸任一检查为假 → `拒绝签名: <failList>` (`task-contract.ts:359`) | ❌ | `needs_human` |
| `BUDGET_EXCEEDED` | `budget.maxAmount > maxAmountAtomic` (`task-contract.ts:233-235`); 或 `underPerTx` / `underDaily` 为假 (`task-contract.ts:353-354`) | ❌ (改预算后可用**原 requestId** 重发) | `raise_budget` |
| `NETWORK_NOT_JOINED` | 本机没有任何已加入网络; 无 peerId (`p2p-info.ts:124-126` 的 `note` 就是这条状态的人读版) | ❌ | `rejoin_network` |
| `CAPABILITY_NOT_FOUND` | Registry 里 `discover()` 找不到该 capability (`agent-registry.ts:186-194`, `GET /api/registry?q=`) | ✅ (**只重查发现**, 绝不因此重发付款) | `redefine_capability` |
| `RESULT_UNVERIFIED` | `delivered` 但未过 verified 门 (八项缺任一) (`settlement-state.ts:385-407`); 或 `verification_failed` (`:34`) | ❌ (**绝不重付**) | `needs_human` (走追责/争议) |
| `PROTOCOL_VERSION_UNSUPPORTED` | `protocol !== 'bolloon-task/1'` (`task-contract.ts:222`, `:251`) | ❌ | `upgrade_client` |
| `PAYMENT_UNCERTAIN` | 有回执、无 `txHash` → 事实维持 `unknown`, `mustNotRepay=true` (`payment-recovery.md` §3; `payment-recovery.ts`) | ❌ | `reconcile` |
| `DUPLICATE_REQUEST` | 同一 `requestId` 已在收件箱/已签过 (`dedupeInbox`, `task-contract.ts:270-273`; `notDuplicate`, `:355`) | ❌ (幂等, 返回既有事实) | `null` |
| `TASK_TRANSITION_REJECTED` | 非法迁移: `非法任务迁移 X → Y (拒绝, 不静默修正)` (`task-contract.ts:76-78`) | ❌ | `needs_human` |
| `SIGNATURE_REQUIRED` | `validateTaskRequest`: 缺签名 (`task-contract.ts:241`) / 缺必填字段 (`:223-225`) | ❌ | `retry_same_request` (补签后) |
| `SIGNATURE_INVALID` | `verifyTaskEnvelope` 验签失败 (`task-contract.ts:305-314`) | ❌ | `needs_human` |
| `DEADLINE_EXPIRED` | `deadline <= now` 或 `deadline` 荒谬久远 (`task-contract.ts:237-244`) | ❌ | `retry_same_request` (重设 deadline) |
| `WALLET_UNAVAILABLE` | 放行闸 `walletAvailable` 为假 (`task-contract.ts:350`) | ✅ (修好本机钱包后重发; 同一 requestId 只签一次) | `needs_human` |
| `AGENT_NOT_AUTHORIZED` | 用户未在本地显式开启自主签名: `agentAuthorized !== true` (`task-contract.ts:349`) | ❌ | `needs_human` |
| `LOCAL_DEV_NOT_CHAIN` | 本机联调想写到链上事实: `本机联调 (local-dev) 不能产生 <fact>` (`settlement-state.ts:196-198`) | ❌ (**永不**) | `null` (改用链上模式才谈结算) |
| `DISPUTE_OPEN` | 争议期间的重付/标成功/静默关闭 (`disputeForbids`, `settlement-state.ts:118-131`) | ❌ | `needs_human` |
| `DELIVERY_FAILED` | 付了钱但没交付 (`settlement-state.ts:34`); 已有支付证据**不许**标普通 `failed` (`:144-146`) | ❌ (**绝不重付**) | `needs_human` |

---

## 4. 状态映射表 (内部 → 对外 4 态)

**对外 4 态** (外部 Agent 唯一需要处理的四个态):

```
① 准备中  ·  ② 正在获取能力  ·  ③ 正在执行  ·  ④ 已完成或需要你处理
```

> 仓库真值是 **5** 个 `HumanStatus`: `'准备中' | '正在获取能力' | '正在执行' | '已完成' | '需要你处理'`
> (`src/agents/task/report-card.ts:15`)。对外 4 态 = 把后两个**合并**成"已完成或需要你处理" —— 因为外部 Agent 对这两者
> 的动作相同 (要么收结果, 要么找人)。**内部 5 态一个字都不改**, 合并只发生在对外口径。

### 4.1 任务状态 (14 态, `task-contract.ts:26-41`)

| # | 内部状态 | 对外 4 态 | 只在 /trace·/tx·诊断出现? |
|---|---|---|---|
| 1 | `discovered` | 准备中 | 是 (内部细节) |
| 2 | `quoted` | 准备中 | 是 |
| 3 | `submitted` | 正在获取能力 | 否 (对外可见) |
| 4 | `accepted` | 正在获取能力 | 否 |
| 5 | `payment_required` | **需要你处理** | 否 |
| 6 | `paying` | 正在获取能力 (若 `next_action=reconcile` → 需要你处理) | 否 |
| 7 | `paid` | 正在获取能力 (**≠ 成功**) | 是 (细节) |
| 8 | `running` | 正在执行 | 否 |
| 9 | `delivered` | **已完成或需要你处理** (对外**不算完成**) | 否 |
| 10 | `verified` | 已完成 (仍须过 §5.2 支付口径, 否则 → 需要你处理) | 否 |
| 11 | `policy_denied` (终态) | 需要你处理 | 否 |
| 12 | `rejected` (终态) | 需要你处理 | 否 |
| 13 | `failed` (终态) | 需要你处理 | 否 |
| 14 | `cancelled` (终态) | 需要你处理 | 否 |

终态集合 `TASK_TERMINAL_STATES = ['policy_denied','verified','rejected','failed','cancelled']` (`task-contract.ts:62`)。

### 4.2 交易生命周期 (代码现值 **11** 态 + 1 遗留态)

> **口径更正 (如实)**: 任务书/设计文档说"10 态交易生命周期", 那是 Phase 0 冻结时的口径。
> 代码现值是 **11** 态 (`LIFECYCLE_STATUSES`, `settlement-state.ts:25-37`, 含 Phase 4 的 `disputed`),
> 另有**仍必须可读**的遗留态 `failed` (`LEGACY_STATUSES`, `:41`)。以代码为准。
> (`transaction-protocol.ts:39-51` 的 `TRANSACTION_STATUSES` 同样是 11 项, 无 `disputed` —— 两者是不同层的取值表。)

| # | 内部状态 | 对外 4 态 | 只在 /trace·/tx·诊断出现? |
|---|---|---|---|
| 1 | `discovered` | 准备中 | 是 |
| 2 | `quoted` | 准备中 | 是 |
| 3 | `policy_denied` (终态) | 需要你处理 | 否 |
| 4 | `payment_required` | 需要你处理 | 否 |
| 5 | `paying` | 正在获取能力 | 否 |
| 6 | `settled` | 正在获取能力 | 是 (细节) |
| 7 | `delivered` | 已完成或需要你处理 | 否 |
| 8 | `verified` (终态) | 已完成 | 否 |
| 9 | `delivery_failed` (终态) | 需要你处理 | 否 |
| 10 | `verification_failed` (终态) | 需要你处理 | 否 |
| 11 | `disputed` (终态) | 需要你处理 | 否 |
| — | `failed` (遗留终态) | 需要你处理 | 是 |

### 4.3 结算事实 (8 态, `settlement-state.ts:156-165`)

| # | 事实 | 对外 4 态 | 算任务成功? (§5.2) |
|---|---|---|---|
| 1 | `unpaid` | 准备中 | 否 |
| 2 | `payment_submitted` | 正在获取能力 (已发出, 等回执) | 否 —— **`local-dev` 最高只到这** (`LOCAL_DEV_MAX_FACT`, `:186`) |
| 3 | `payment_verified` | 正在获取能力 | **是** (但还需 `state==='verified'`) |
| 4 | `partially_settled` | 已完成或需要你处理 | 否 (见 §6 口径差) |
| 5 | `fully_settled` | 已完成 | **是** (但还需 `state==='verified'`) |
| 6 | `refund_pending` | 需要你处理 | 否 |
| 7 | `refunded` | 需要你处理 | 否 |
| 8 | `unknown` | 需要你处理 (**先对账**) | 否 |

链上口径事实集合: `CHAIN_BACKED_FACTS = ['payment_verified','partially_settled','fully_settled']` (`:184`)。

### 4.4 内部状态从哪看得见 (对外只有 4 态, 细节在这三处)

| 面 | 今天真实的入口 | 看到什么 |
|---|---|---|
| **/trace** | `bolloon trace [<runId>] --json` (`cli-entry.ts:405-443`) · `GET /api/trace` · `GET /api/trace/:runId` (`web/server.ts:3027-3049`) | `schema:"bolloon-agent-trace/1"` 的逐步工具轨迹 + `counts` + `evidence[]` |
| **/tx** | `GET /api/x402/transactions` · `GET /api/x402/transactions/:id` (`web/server.ts:2990-3026`) | 交易记录原文: `status` + `settlementFact` + `chainSettled` + `events[]` + `responsibility` |
| **诊断模式** | `bolloon doctor` (`cli-entry.ts:777-779`) · `bolloon p2p --json` (`:450-458`) · `GET /api/health` (`web/server.ts:8194`) · `GET /api/watchdog` (`:8218`) · `GET /api/supervisor` (`:3322`) | 本机自洽性 / 网络可拨入地址 / 恢复 tick 报告 (`scanned/reconciled/awaitingPayment/mustNotRepay/closed`) |

**`/tx` 与 `/trace` 作为 CLI 子命令** (`bolloon trade show <id>` / `bolloon task status <id>`) 是 `(planned: P3)` —— 今天的同名路径是上面那两个 HTTP 接口。

---

## 5. 红线 (规范级, 不许被任何实现绕过)

### 5.1 `local-dev` 红线

`local-dev` = 本机联调模式, **链上一分钱没动**。三条不可混淆:

1. **永不 `fully_settled`**: `maxFactForMode('local-dev') === 'payment_submitted'` (`task-contract.ts:96-99`; 与 `LOCAL_DEV_MAX_FACT` 同值)。
   试图写链上事实直接被拒, 原话: `本机联调 (local-dev) 不能产生 <fact>: 链上没有真实结算, 联调最高只能是 payment_submitted` (`settlement-state.ts:196-198`)。
2. **永不 `verified`**: `evaluateTransactionSuccess` 首条就是 `paymentMode === 'local-dev' || chainSettled !== true` → `不能判 verified` (`transaction-protocol.ts:154-156`)。
3. **对外不许冒充链上**: 公开投影 `settlement` 只允许 `'chain' | 'local-dev' | 'none'`, `local-dev` 明确标 `local-dev` (`task-contract.ts:435`, `:451-454`); 且 `isTaskSuccessful` 对 `local-dev` 恒为 false (`:102-105`)。

**给外部 Agent 的说法**: 看到 `settlement: "local-dev"` 就是"协议跑通了, 钱没动" —— 既不是成功, 也不是失败。

### 5.2 `chainSettled !== true` 永不 `verified`

1. 硬前置: `if (rec.chainSettled !== true) return { ok:false, reason:'chainSettled !== true: 链上没有真实结算, 不能判 verified (联调最高 delivered)' }` (`settlement-state.ts:102`)。
2. 最终 verified 门**八项全满足**才算 (`settlement-state.ts:385-407`): `chainSettled` · `protocolVerified` · 交付正文在盘上 · 交付字节哈希与交付时一致 · `receiptHash` 已绑定 · 结算事实 ∈ {`fully_settled`,`partially_settled`} · 资源执行成功且输出合契约 · Goal 判据命中。
3. 任务层的成功判据再加一层: `state==='verified'` **且** 事实 ∈ {`fully_settled`,`payment_verified`} (`task-contract.ts:102-105`)。
4. Facilitator 说成功但**没 txHash** → 不算链上结算完成 (`payment-recovery.md` §3; `chainSettled: !!txHash`)。

### 5.3 付款三条铁律 (与恢复协议同源, `payment-recovery.md` §1)

```
payment uncertain ≠ payment failed      → 不确定先 reconcile, 不许当失败
payment failed    ≠ safe to retry       → 失败不等于可以重付
先 reconcile, 再决定 retry              → 顺序不许颠倒
```

- `paying → payment_required` 是**合法**迁移, 专门表达"付款不确定 → 回去等对账, **不许当失败**" (`task-contract.ts:52`)。
- 已有支付证据 (`txHash` / 回执 / `chainSettled` / 事实非 `unpaid`·`unknown`) → **不许**标普通 `failed` (`settlement-state.ts:144-146`); 也不能回到 `paying` (`:71-72`)。
- 同一 `requestId` 只能有一个付款者, 且**只签一次** (`notDuplicate`, `task-contract.ts:355`; `claimHeldByOther` → `wait`)。
- `requestId` 是**确定性**的: `treq-<sha256(instruction|capability|buyerDid|salt) 前16位>` —— 同一任务重发得到同一 requestId (`task-contract.ts:203-206`), 所以"重发"在设计上就**不可能**产生第二笔付款。**改预算不换 requestId**, 幂等保护依然有效。

### 5.4 非法迁移拒绝, 不静默修正

- 任务层: `checkTaskMove` → `非法任务迁移 X → Y (拒绝, 不静默修正)` (`task-contract.ts:73-80`)。
- 交易层: 写路径用 `checkLifecycleMove` / `canTransitionSettlement` 判定, 不合法抛 `IllegalTransactionTransition`, **记录不被修改** (`transaction-two-layer-state.md` §5; `settlement-state.ts:79-89`)。
- 结算事实变化**无条件留痕**: 调用方忘了给 event 也会自动补 `settlement:<fact>` (`transaction-two-layer-state.md` §5.4)。

### 5.5 私钥红线 (与 leo 2026-09-21 修正一致)

| 规矩 | 依据 |
|---|---|
| 私钥**只在**本机进程可用; 公共网页 / P2P 消息 / Network Pulse / 公开交易记录**永远拿不到** | `task-contract.ts:9-11` |
| `authorizeWalletSignature` 是**唯一放行闸 (fail-closed)**, 它**只决定允不允许**, 不做签名, 私钥不流经它 | `task-contract.ts:342-361` |
| 每次签名写审计账本 `~/.bolloon/wallet-signatures.jsonl` (append-only), 记 `requestId`/`taskId`/`amountAtomic`/`network`/`capability`/`signerFingerprint`/`payloadDigest` | `task-contract.ts:380-388` |
| 审计里**绝不允许**出现 `privateKey`/`secret`/`instruction`/`taskText`/`mnemonic`/`seed` | `AUDIT_FORBIDDEN_KEYS` `task-contract.ts:400` |
| **Agent 永远不能要求其他节点发送私钥** | 设计原文 `agent-access-layer.md` §4 (Skill 必须写明) |

### 5.6 公开/私有分层 (`agent-access-layer.md` §6, 与 Pulse 投影一致)

**公开**: 本页全部内容 (协议/信封/错误码/状态映射/manifest 结构/capability) · `GET /api/public/network/progress` (匿名聚合, 无认证)。
**私有**: 私钥 · 本地钱包配置 · 私有任务正文 · 未公开交易内容 · 本地 Agent session · 内部模型配置 · P2P 连接细节。
Pulse **只给**匿名聚合 (节点/Agent 数 · 粗类别 · 完成数 · 已验证交易数 · 金额**区间** · `live/stale/unavailable`) —— 已实现的隐私阈值 `privacyThreshold=3`、粗类别、金额区间 (`network-pulse.md` §2)。

---

## 6. 冻结时发现的口径差 (标记给 leo, 未擅自统一)

1. **`partially_settled` 两处口径不同** —— 交易层 verified 门**接受**它 (`settlement-state.ts:394`), 任务层成功判据**不接受** (`task-contract.ts:104` 只认 `fully_settled`/`payment_verified`)。两者判定的是不同对象 (交易记录 vs 任务成功), 但外部 Agent 容易读混; 建议裁决后写进 §5.2。
2. **交易生命周期"10 态 vs 11 态"** —— 设计文档写 10 态 (Phase 0 口径), 代码现值 11 态 (含 `disputed`), 另有遗留 `failed`。本页以代码为准 (§4.2)。
3. **对外 4 态 vs 代码 5 态** —— `report-card.ts:15` 是 5 个 `HumanStatus`, 本页对外合并成 4 态 (§4 开头已说明合并规则)。
4. **`retryable` 目前只有一个真实产出点** (onboard 连通性, `onboard.ts:268`); 任务/支付路径的 `TaskFailure.retryable` 还没有生产者。§3 表是**冻结语义 + 派生**, P3 接 CLI 时按它赋值。

## 7. 与其它页面的关系

- `docs/wiki/agent-access-layer.md` —— 上层设计 (CLI 主协议 / MCP 薄适配 / Skill / 六阶段); 本页是它的 **P1 收尾**。
- `docs/wiki/task-protocol.md` —— `bolloon-task/1` 契约层 (14 态 + 四支付模式 + 放行闸 + 审计 + 公开投影) 的说明页。
- `docs/wiki/transaction-two-layer-state.md` · `payment-recovery-protocol.md` —— §4.2/§4.3/§5.2/§5.3 的原始来源。
- `docs/wiki/network-pulse.md` —— §5.6 公开层的已上线实现 (`GET /api/public/network/progress`)。

## 8. 下一步 (P1 之后, 不在本页范围)

1. **P3** 把信封 + §3 错误码接进 CLI (`--json` / `--request-id` / `--timeout` / `--quiet` 全局化), 逐条映射现有子命令。
2. **P2** `skills/bolloon-network/SKILL.md` (对外唯一入口说明) —— 与本页配套。
3. **P4** MCP 适配层 (`bolloon mcp serve`), 只调 CLI service, **不复制业务逻辑**。
4. 裁决 §6 的四条口径差。
