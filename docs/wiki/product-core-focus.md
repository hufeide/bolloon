---
title: 产品核心收缩 (Core Focus) — 从"什么都能做"到一个闭环
source: session (leo 2026-09-18 以乔布斯视角给的减法判断 + 仓库现状核对)
created: 2026-09-18
last_confirmed: 2026-09-18
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: chapter
tags: [product, core-focus, freeze, roadmap, m1-m4, subtraction, job-to-be-done]
---

# 产品核心收缩 (2026-09-18)

> **一句话核心**:Bolloon 让 Agent **买到完成任务所需的能力**,
> 并把"这项能力被真实、受约束、可恢复地使用过"证明出来。
>
> 不是 "Agent 网络 / P2P 交易平台 / x402 支付系统 / Skill 市场 / 长期执行框架"。
> 那些是**内部实现**,不承担产品叙事。

## 0. 现状核对 (先摆事实, 再谈取舍)

| 维度 | 今天的真实规模 | 对核心的贡献 |
| --- | --- | --- |
| Web 路由 | **163 条** (`src/web/server.ts`), 含 p2p/iroh/chat-inbox/self-improve/permission-mode/context/registry 等 | 主入口候选, 但复杂度来源 |
| CLI 子命令 | 14 个: `cli web gui init setup model engine improve read summarize trace update version passthrough` | `trace` 直接服务核心; 其余大多不服务 |
| 用户可见交易态 | 生命周期 **10 态** + 结算事实 **8 态** 直出 (`/tx`、审计 API) | 内部必须保留, **外部不该看到** |
| 可执行资源 | `~/.bolloon/skills` 仅 **1 个**; 夹具 `scripts/fixtures/skills/cross-border-market-research` | 已经是 M1 的那个"一" |
| 买能力入口 | 埋在 `src/index.ts:1688` (`buyInfo`), 对话里可达, **无独立任务入口** | 核心动作, 但没被产品化 |
| 任务报告卡 | **不存在** (grep `本次使用`/`reportCard` 全仓 0 命中) | **M1 最大的缺口** |
| 可靠性地基 | Run 持久化 / Goal continuation / Harness 门 / Supervisor tick / payment recovery / evidence 桥 / 不重复付款 | 已投入最多, 且**正好服务核心** |

**结论**:地基是核心需要的, 表层复杂度是核心不需要的。所以**一行代码不用删**, 要改的是**主推什么、暴露什么、接下来做什么**。

## 1. 核心体验 (只此五步)

```text
提出任务 → Agent 判断缺什么 → 购买一个资源 → 使用资源完成任务 → 返回结果 + 证据
```

用户**不应该**理解: Goal / Run / Harness / Supervisor / 10 态生命周期 / 两层结算 / lease / recovery / facilitator / P2P / DID / IPFS / OrbitDB。

用户**应该**看到(4 个人类状态, 内部 10 态只做映射):

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
| 可执行 Skill 真实执行 + 输出契约校验 | ✅✅✅ | **做** (已是 Phase 2) |
| 支付中断不重复付款 (recovery) | ✅✅✅ | **做** (已是 Phase 3) |
| Goal/Run evidence 可回放 | ✅✅✅ | **做** (trace 已通) |
| Base Sepolia 真支付 | ✅✅ | **做** (Phase 1, 但不阻塞 M1) |
| 争议/责任最小版 (不假绿) | ✅✅✅ | **最小版** (Phase 4 只留"不装作成功") |
| P2P 多节点发现 / iroh 传输 | ❌❌❌ | **冻结** |
| 多链钱包 / 多支付网络 | ❌❌❌ | **冻结** |
| 手机端完整交易体验 | ❌❌ | **冻结** (名片小工具保留为"身份入口"叙事) |
| 自动声誉经济 / 自由交易市场 | ❌❌❌ | **冻结** |
| 多种资源类别同时上线 | ❌❌❌ | **冻结** (先 1 类) |
| 自动退款 / 复杂仲裁 / 多阶段结算 UI | ❌❌❌ | **冻结** |
| self-improve / permission-mode 面板等 | ❌❌❌ | **冻结** (不作为主叙事) |

## 3. 冻结清单 (不改代码; 只改"暴露面"与"下一步做什么")

### 3.1 冻结为"非主叙事"(代码保留, 文档/入口不再主推)

| 现状 | 冻结方式 (先不用, 不删) |
| --- | --- |
| Web 163 路由中的 p2p / iroh / chat-inbox / self-improve / permission-mode / context / registry 面板 | 不作为 M1 入口; 不写进产品说明; 不进新人路径 |
| CLI `gui` / `improve` / `engine` / `read` / `summarize` / `passthrough` / `model` / `update` | 留在 CLI, 但从"核心体验"叙事移除 |
| `mobile/snapshot`、移动端交易体验 | 冻结; 小工具继续只做身份名片/轨迹交换 |
| 10 态生命周期 + 8 态结算事实的**外部直出** | 内部保留; 对外一律映射 **4 态** |
| Milestone 分次付款 / 自动退款 / 仲裁 UI | 冻结 (Phase 4 已做的最小版足够: 不静默关闭 + 证据留住) |

### 3.2 只保留"服务核心"的地基 (Layer 2)

Run 持久化 · Goal continuation · Harness 约束 · Supervisor tick · payment recovery · transaction evidence · skill snapshot · 不重复付款 · 真实验真。

> **判断原则**:任何不能直接提高「任务成功率 / 结果可信度 / 资金安全」的基础设施, 一律暂缓。

### 3.3 冻结技术扩张 (一段时间内只允许一个)

```text
场景: 跨境商品进入目标市场调研
资源: 可执行 Skill (唯一资源类型)
支付: Base Sepolia USDC (唯一网络)
入口: CLI (推荐) 或 Web, 二选一
Agent: 一个主 Agent
结果: 结构化调研报告 + 证据
验证: resource-contract (唯一验证协议)
```

## 4. 路线图 (M1 → M4, 按用户价值排序, 不按技术完整度)

### M1 — 一个跨境商品调研任务跑通 **(唯一 P0)**

```text
用户目标 → Agent 判断缺能力 → 报价/预算/来源检查 → Policy 放行 → 付款
→ 下载 + 内容保真校验 → 执行 Skill → 输出契约校验 → 结构化结论 + 证据
```

用户看到的(报告卡):

```text
结论: 适合进入日本市场, 预计售价 ¥2,980–3,480
本次使用: 日本市场调研 Skill v1.2 · 0.012 USDC · 来源 3 个公开数据源
资源已验证: 是   付款已结算: 是   耗时: 42 秒     查看完整证据 →
```

**M1 验收 (缺一项都不算完成)**

- [ ] 用户只输入一个任务(给预算), 不需要理解任何内部概念
- [ ] Agent **自动**判断是否需要外部资源(不是用户点名买哪个)
- [ ] 付款前能看到**价格与预算影响**
- [ ] 购买后资源**确实被执行**(不是只下载)
- [ ] 输出**符合资源契约**, 否则不计成功
- [ ] 结果里带**证据**(来源 / 内容哈希 / txHash / 事件链)
- [ ] 失败时明确告诉用户**卡在哪一步**(不装作成功)
- [ ] **不重复付款** (同 requestId 幂等)
- [ ] **重启后能继续** (recovery 把任务接回来)
- [ ] 对外只显示 **4 态**, 不出现 10 态/8 态术语

### M2 — 这个任务可恢复且不重复付款

三个用户能感知的恢复点(五个 SIGKILL 场景继续留作测试):

```text
① 付款前中断 → 重启后继续, 未付款不产生扣款
② 付款已完成但交付未完成 → 不重付, 只补交付
③ 交付完成但验真未完成 → 不重付, 只补验真
```

### M3 — 至少一笔 Base Sepolia 真支付

`txHash` 可查 · 最终 `verified` · 与 M1 的 local-dev 结论**不混用**。

### M4 — 失败进争议, 不重付、不假绿

证据完整 · 责任候选清楚 · 停自动重试 · 等人工。

> **M1 完成前**: 不再扩展新的资源类型、支付网络、入口、社交能力。

## 5. M1 真实差距 (诚实版)

| 缺口 | 现状 | 要做的最小动作 |
| --- | --- | --- |
| **任务入口** | `buyInfo` 埋在 `src/index.ts:1688`, 无独立入口 | 一个 `bolloon task "<任务>" --budget <amt>`(或 `/task`)跑完整闭环 |
| **任务报告卡** | 全仓无渲染器 | 渲染: 结论 / 本次使用 / 花费 / 来源 / 已验证 / 已结算 / 耗时 / 证据指针 |
| **4 态映射** | `/tx` 直出 10 态 | 一个显示层映射 (内部状态不动) |
| **资源目录** | `~/.bolloon/skills` 只有 1 个技能, 报价路径靠夹具 | 让 Agent 从已装技能里**发现 → 报价 → 购买**, 而不是硬编码 |
| **一条 Goal criterion** | `goal-criteria.ts` 存在, 未接市场调研输出契约 | 把"结论 + 来源数"接成判据, 命中才算完成 |

## 6. 待确认 (需要 leo 定)

1. **唯一入口**: CLI 还是 Web?(建议 CLI — `trace`/`tx` 已通, Web 163 路由是复杂度主源; Web 以后只做"看证据")
2. **M1 资源类型**是否就锁死"可执行 Skill"(不引入数据/API 类资源)?
3. **预算单位与上限**: 单任务 0.05 USDC 这类硬上限 + 日预算, 是否就按现有 Policy 默认值?
