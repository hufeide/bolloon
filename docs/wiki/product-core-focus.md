---
title: 产品核心收缩 (Core Focus) — M1 只证明一件事
source: session (leo 2026-09-18 乔布斯视角减法判断 + leo 定下的三条冻结规则)
created: 2026-09-18
last_confirmed: 2026-09-18
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: chapter
tags: [product, core-focus, freeze, roadmap, m1-m4, cli-task, report-card, subtraction]
---

# 产品核心收缩 (2026-09-18)

> **一句话核心**:Bolloon 让 Agent **买到完成任务所需的能力**,并对结果负责 ——
> 并把"这项能力被真实、受约束、可恢复地使用过"证明出来。
>
> **不是** "拥有 Agent 的交易平台"。

## 0. 现状核对 (先摆事实, 再谈取舍)

| 维度 | 今天的真实规模 | 对核心的贡献 |
| --- | --- | --- |
| Web 路由 | **163 条** (`src/web/server.ts`), 含 p2p/iroh/chat-inbox/self-improve/permission-mode/context/registry | 主入口候选, 但复杂度来源 |
| CLI 子命令 | 14 个: `cli web gui init setup model engine improve read summarize trace update version passthrough` | `trace` 直接服务核心; 其余大多不服务 |
| 用户可见交易态 | 生命周期 **10 态** + 结算事实 **8 态** 直出 (`/tx`、审计 API) | 内部必须保留, **外部不该看到** |
| 可执行资源 | `~/.bolloon/skills` 仅 **1 个**; 夹具 `scripts/fixtures/skills/cross-border-market-research` | 已经是 M1 的那个"一" |
| 买能力入口 | 埋在 `src/index.ts:1688` (`buyInfo`), 无独立任务入口 | 核心动作, 但没被产品化 |
| 任务报告卡 | **不存在** (grep `本次使用`/`reportCard` 全仓 0 命中) | **M1 最大缺口** |
| 任务预算闸 | `trade.ts` 已有 `taskBudget` 参数 (独立于 policy 的第二道闸), 但**全仓无任何调用者** | 接线即可用 |
| 钱的两道闸现状 | `economic-policy.ts:75-76` 默认 **单笔 ≤ \$1 / 每日 ≤ \$10** | 对 M1 **太宽**, 必须收紧 |
| 可靠性地基 | Run 持久化 / Goal continuation / Harness 门 / Supervisor tick / payment recovery / evidence 桥 / 不重复付款 | 已投入最多, 且**正好服务核心** |

**结论**:地基是核心需要的, 表层复杂度是核心不需要的。**一行代码不用删**, 要改的是**主推什么、暴露什么、下一步做什么**。

## 1. 核心体验 (只此五步)

```text
提出任务 → Agent 判断缺什么 → 购买一个资源 → 使用资源完成任务 → 返回结果 + 证据
```

用户**不应该**理解: Goal / Run / Harness / Supervisor / 10 态生命周期 / 两层结算 / lease / recovery / facilitator / P2P / DID / IPFS / OrbitDB。

用户**不应该看到**: `quoted` · `payment_required` · `fully_settled` · `chainSettled` · `lease` · `retry_wait` · `facilitator` —— 这些只出现在 `/trace`、`/tx`、诊断模式。

用户**应该**看到(**5 个**用户态, 内部状态只做映射 —— 此前写成"4 态"是错的):

```text
准备中 → 正在获取能力 → 正在执行 → 已完成 / 需要你处理
```

## 2. 三个问题砍每一项计划

1. 它是否让 Agent 更容易完成核心任务?
2. 它是否让购买的资源更可信?
3. 它是否让用户更少操心?

**三个都是"不" → 不做**(或冻结)。

| 能力 | 三问结论 | 处置 |
| --- | --- | --- |
| 可执行 Skill 真实执行 + 输出契约校验 | ✅✅✅ | **做** (Phase 2 已通) |
| 支付中断不重复付款 (recovery) | ✅✅✅ | **做** (Phase 3 已通) |
| Goal/Run evidence 可回放 | ✅✅✅ | **做** (trace 已通) |
| Base Sepolia 真支付 | ✅✅ | **做** (M3, **不是 M1 完成条件**) |
| 争议/责任最小版 (不假绿) | ✅✅✅ | **最小版** (M4 三条) |
| P2P 多节点发现 / iroh 传输 | ❌❌❌ | **冻结** |
| 多链钱包 / 多支付网络 | ❌❌❌ | **冻结** |
| 手机端完整交易体验 | ❌❌ | **冻结** (名片小工具只做身份/轨迹交换) |
| 自动声誉经济 / 开放市场 / 竞价推荐 | ❌❌❌ | **冻结** |
| 多种资源类别 (数据集/API/商品/Agent 服务…) | ❌❌❌ | **冻结** (先锁死 1 类) |
| 自动退款 / 复杂仲裁 / 多里程碑 UI | ❌❌❌ | **冻结** (规模化后再说) |
| self-improve / permission-mode 面板作主叙事 | ❌❌❌ | **冻结** |

## 3. 冻结清单 (不改代码; 只改"暴露面"与"下一步做什么")

### 3.1 三条 M1 冻结规则 (leo 2026-09-18 定, 硬约束)

```text
① M1 唯一入口 = CLI task     (Web/移动端不做任务入口, Web 只做结果与证据查看)
② M1 唯一资源 = 本地 Registry 中的可执行 Skill  (不做开放市场发现)
③ M1 固定预算 = 单任务 0.05 USDC / 单次购买 0.02 USDC / 单日测试 0.10 USDC
```

预算规则(所有层取**最小值**, 且**用户只在开始时给一次, Agent 不得在执行中自动扩大**):

```text
taskBudget ≤ 0.05 ; 每次购买 ≤ 0.02 ; 单日 ≤ 0.10 ; 多层取 min
```

> 现默认 `单笔 \$1 / 每日 \$10` 对 M1 太宽 → M1 显式收紧(该值属于配置, 不改地基逻辑)。

### 3.2 冻结为"非主叙事"(代码保留, 文档/入口不再主推)

| 现状 | 冻结方式 (先不用, 不删) |
| --- | --- |
| Web 163 路由中的 p2p / iroh / chat-inbox / self-improve / permission-mode / context / registry 面板 | 不作为 M1 入口; 不写进产品说明 |
| CLI `gui` / `improve` / `engine` / `read` / `summarize` / `passthrough` / `model` / `update` | 留在 CLI, 从"核心体验"叙事移除 |
| 移动端交易、`mobile/snapshot` | 冻结 |
| 10 态 + 8 态结算事实的**外部直出** | 内部保留; 对外一律 **5 个用户态** |
| 远程 Registry / P2P 发现 / 竞价 / 语义搜索 | 冻结 (M1 只做本地 Registry 内的**确定性匹配**) |

### 3.3 只保留"服务核心"的地基 (Layer 2)

Run 持久化 · Goal continuation · Harness 约束 · Supervisor tick · payment recovery · transaction evidence · skill snapshot · 不重复付款 · 真实验真。

> **判断原则**:任何不能直接提高「任务成功率 / 结果可信度 / 资金安全」的基础设施, 一律暂缓。

### 3.4 冻结技术扩张 (一段时间内只允许一个)

```text
场景: 跨境商品进入目标市场调研
资源: 可执行 Skill (唯一资源类型, 本地 Registry)
支付: Base Sepolia USDC (唯一网络; M1 用 local-dev 即算通过)
入口: CLI `bolloon task` (唯一入口)
Agent: 一个主 Agent
结果: 结构化调研报告 + 报告卡
验证: resource-contract (唯一验证协议)
```

## 4. 路线图 (M1 → M4, 按用户价值排序, 不按技术完整度)

### M1 — **只证明一件事**:一个任务 → 一个 Skill → 一个报告

```text
bolloon task "判断这款厨房用品是否适合进入日本市场" --budget 0.05
bolloon task --resume <goalId>
```

内部流程(用户不需要知道):

```text
创建 Goal → Agent 分析任务 → 判断现有能力不足 → 从本地 Registry 发现市场调研 Skill
→ 检查版本/输入输出契约/价格 → Policy 允许(且 ≤ 任务预算) → 完成购买 → 校验资源内容
→ 执行 Skill → 校验输出 → 写 Run/Goal evidence → 生成报告卡
```

报告卡(M1 **唯一面向人的主出口**, 先做 CLI 文本渲染, 不做 Web 可视化):

```text
任务: 判断厨房用品是否适合进入日本市场

结论: 适合 / 不适合 / 证据不足

本次使用:
- Skill: cross-border-market-research
- 版本: 1.0
- 花费: 0.012 USDC
- 来源: 3 个数据源
- 输出契约: 通过
- 资源验证: 通过
- 任务证据: 完整
- 状态: 已完成

查看完整证据: <goalId>
```

**M1 验收 = "任务结果完整"(不是 "资源交易完整")**

- [ ] 1. 用户只输入一句任务 + 预算
- [ ] 2. 用户**不点名 Skill**
- [ ] 3. Agent 自动判断是否缺能力
- [ ] 4. 从 Registry 发现**唯一候选** Skill
- [ ] 5. 购买前显示**价格与预算影响**
- [ ] 6. Skill **被实际执行**(不是只下载)
- [ ] 7. 输出契约失败时任务**不能变绿**
- [ ] 8. 报告能回放资源、Run、Goal 与证据

**两条硬门(任一不满足 → M1 失败)**

```text
买到 Skill 但没有执行        → M1 失败
执行成功但没有报告/证据       → M1 失败
```

### M1 的三个薄层 (新增的不是大系统)

| 薄层 | 只负责 | 明确不做 |
| --- | --- | --- |
| **Task Runner** | `task text → Goal → runner → final report` 把 CLI 输入接到现有 Goal/Run/Supervisor | 不重新实现支付、恢复、Skill 执行 |
| **Resource Advisor** | 回答"当前任务是否缺外部能力? Registry 里哪个 Skill 满足契约? 为什么选它?"; 用 capability 描述 + 输入输出契约 + 任务关键词 + **确定性匹配** + Agent 最终确认 | 不做语义搜索 / P2P 发现 / 竞价 / 推荐系统 |
| **Report Card** | 唯一面向人的主出口: 结果 / 资源使用 / 花费 / 验证 / 证据入口 / 失败原因 | 不做 Web 可视化 (先 CLI 文本) |

### M2 — 同一条任务流程的恢复 (不扩展场景)

```text
① 付款前杀进程            → 任务继续执行, 不产生扣款
② 付款完成、交付前杀进程   → 不重付, 只补交付
③ 交付完成、验真前杀进程   → 不重付, 只补验真
```

用户体验只有: **任务继续执行 · 不重复扣款 · 不需要重新输入**。
(M2 不加新资源、不加新支付网络、不加新 UI。五个 SIGKILL 场景继续留作测试。)

### M3 — 同一任务至少一笔真实链上支付

它证明的是「**支付适配器与链上事实成立**」, 不证明「用户任务有价值」。
所以 **M1/M2 不被外部条件阻塞**: 没有 facilitator 与钱包时, M1/M2 用 local-dev 依然必须完成。

### M4 — 失败安全, 只保留三条

```text
有支付证据但资源失败 → 不自动重付
证据不完整           → 不判 verified
争议未解决           → 不静默关闭
```

**不做**: 自动退款 · 多里程碑 UI · 复杂仲裁 · 声誉惩罚 · 多方责任协商(规模化后的问题)。

## 5. M1 落地情况 (2026-09-18 已实现并真跑)

| 缺口 | 之前 | 现在 |
| --- | --- | --- |
| **任务入口** | `buyInfo` 埋在 `src/index.ts:1688`, 无入口 | ✅ `bolloon task "<任务>" --budget 0.05` / `bolloon task --resume <goalId>` (`src/cli-entry.ts: handleTaskCommand`) |
| **任务报告卡** | 全仓无渲染器 | ✅ `src/agents/task/report-card.ts` (CLI 文本; 唯一面向人的主出口) |
| **4 态映射** | `/tx` 直出 10 态 | ✅ `humanStatusFrom()` 把内部 10 态映射成 5 个用户态; 单测断言渲染文本**不含**任何内部术语 |
| **资源发现** | 靠夹具硬编码 | ✅ `src/agents/task/resource-advisor.ts`: capability + 契约完整性 + 任务关键词**确定性**匹配 (同分按名字), 关联本地报价 |
| **预算闸接线** | `trade.ts` 有 `taskBudget` 但**零调用者**; 默认 $1/$10 太宽 | ✅ `src/agents/task/task-budget.ts` (0.05/0.02/0.10, 多层取 min, 不许中途扩大) → `trade({taskBudget, maxPaymentAmount})` |
| **一条 Goal criterion** | `goal-criteria.ts` 未接 | ✅ 判据由资源契约 `verification` 生成 → `setCriteria(confirm)` → 逐条 `markCriterion` |

### 5.1 三个薄层 (全在 `src/agents/task/`, 都不重造轮子)

| 薄层 | 文件 | 说明 |
| --- | --- | --- |
| Task Runner | `task-runner.ts` | 串起 Goal → 顾问 → 报价 → 付款(`trade`) → 保真(`verifyInstallFidelity`) → 执行(`executeContractSkill`) → Run/Goal 证据 → 报告卡; `resumeTask` 按 `planTransactionRecovery` 接着做 |
| 本地卖方 | `local-seller.ts` | M1 的"本地 Registry 节点": 把项目**真实卖方路由** (`web/routes-x402-info.ts`) 挂到极小 HTTP 适配器上 —— 不重写协议, 真跑真 402 |
| Resource Advisor | `resource-advisor.ts` | 三问: 缺不缺能力 / 哪个 Skill 满足契约 / 为什么选它; 不做语义搜索与推荐 |
| Report Card | `report-card.ts` | 8 个字段 + 5 个用户态 + 两条硬门 (买到没执行 / 执行了没证据 → 一律"需要你处理") |

### 5.2 真跑证据 (2026-09-18)

- `scripts/verify-task-loop.ts` → **59 passed / 0 failed / EXIT=0**: 真 402 报价 → 真 local-dev 付款 → 真保真链 → **真执行技能代码** → 报告卡; 含 8 项验收 + 2 条硬门 + 3 层预算闸 + 幂等重跑 + 续跑。
- `src/test/task-loop.test.ts` → **25 项**单测 (预算闸 / 硬门 / 10 态→5 态映射 / 顾问确定性 / 输入推导 / requestId 幂等 / 安装越界拒绝)。
- CLI 真跑 (用户视角, 约 2.8 秒):

```text
  准备中      任务: 判断这款厨房用品是否适合进入日本市场 · 预算 0.05 USDC
  准备中      顾问判断缺能力 → 选 "cross-border-market-research"
  正在获取能力 本地 Registry 里没有报价 → 已按技能目录发布本地报价
  正在获取能力 价格 0.012 USDC · 占任务预算 24% · 购买后任务剩余 0.038 USDC
  正在执行     执行 cross-border-market-research
  报告        已完成

结论: 厨房用品进入日本的首轮调研结论: 需求成立但价格敏感, 合规与渠道是主要风险点, 建议小批量试单验证。
本次使用: cross-border-market-research @ 1.0.0 · 0.012 USDC (base-sepolia) · 来源 3 个
输出契约: 通过   资源验证: 通过   任务证据: 完整   状态: 已完成
查看完整证据: Goal g-… · Run … · 交易 tx-…
```

### 5.3 这一轮真跑逼出的真缺陷 (全部已修 + 有断言)

1. **契约解析只认对象** —— 手写 SKILL.md 的 `resource: {…}` 被最小 YAML 解析器留成**字符串**, `parseResourceContract` 于是判"没有资源契约字段", **顾问看不到任何可执行资源**(真跑抓到) → 修: 字符串也 `JSON.parse` (所有调用方受益)。
2. **`requestId` 每次新派生** —— 重跑同一任务会**第二次扣款**(违反 M2) → 改成按 (任务 + 预算) 确定性派生 `task-<sha256前16>`; 续跑复用同一 Goal。
3. **两条硬门原先没有实现** —— "买到没执行"/"执行了没证据"不会被拦 → 在报告卡里落地 (纯函数 + 真跑双验)。
4. **`bolloon task` 会直接抛栈**(setup 门禁) → 改成优雅报告卡: "本机还没初始化好, 不记账也不花钱"。
5. **输入推导漏可选字段 + 商品名残留"意思词"** → 可选字段识别到才填; 商品名清洗 (去"这款/是否/适合/市场"等)。

### 5.4 怎么用

```bash
bolloon task "判断这款厨房用品是否适合进入日本市场" --budget 0.05
bolloon task --resume <goalId>          # 断点续跑: 不重复付款
bolloon task "<任务>" --json            # 机器可读 (含 stages / budget / payment)
bolloon task                             # 看用法
```

## 6. 已定 (leo 2026-09-18)

1. **唯一入口** = CLI `bolloon task`(Web 只做结果/证据查看; 移动端不做任务入口)
2. **M1 资源类型** = 锁死"可执行 Skill", 且只从**本地 Registry** 发现(不做开放市场)
3. **预算** = 单任务 0.05 / 单次购买 0.02 / 单日 0.10 USDC, 多层取 min, 用户只在开始时给一次

## 7. 里程碑自检句

> 每完成一个里程碑问一次:**用户是否因此更容易得到一个可靠结果?**
> 如果答案只是"系统更完整了", 就暂停。
