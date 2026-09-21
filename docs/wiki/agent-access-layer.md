---
title: Agent 接入层 — CLI 为主协议 · MCP 为薄适配 · Skill 为使用说明
source: raw/paste_4 (leo 2026-09-21 接入层设计计划, 638 行) + 本仓落地状态核对
created: 2026-09-21
last_confirmed: 2026-09-21
schema_version: 2
audience: self
stage: current
status: current
tags: [access-layer, cli, mcp, skill, agent-interop, phase1]
---

# Agent 接入层设计 (从 paste_4 编译)

## 一句话

> **CLI = 跨 Agent 的稳定入口 · MCP = Agent 工具适配层 · Skill = 使用说明 · Bolloon Runtime = 身份/网络/任务/钱包/交易的执行层 · Network Pulse = 公共匿名观察层。**

外部 Agent 只需要读一个公开 Skill, 不需要了解 bolloon 内部模块。

```
外部 Agent
   ↓ 读取 Skill
CLI / MCP
   ↓
Bolloon 本地 Runtime
   ↓
DID · Manifest · P2P · Registry · Task · x402 · Transaction
```

**硬约束**: MCP **不复制业务逻辑** —— 只调 CLI(或共享 CLI service 层)。否则支付、任务状态、身份逻辑会分叉成两套。

## 1. 外部 Agent 的两条流程

**发任务方**: 读 Skill → 检查本机有无 CLI → 初始化/复用 DID → 加入网络 → 发布 manifest → heartbeat → 发现 capability → 发起任务 → 收报价 → 按策略自主支付 → 拿结果与验真凭据 → 查交易记录。

**接任务方**: 注册本地 Agent → 声明 capability → 收 `task_request` → 接受/拒绝 → 执行 → 返回**签名结果** → 等付款/完成结算 → 留任务与交易审计记录。

## 2. CLI 设计 (全部命令共同要求)

`默认人类可读` · `--json` · `--quiet` · `--timeout` · `--request-id`

统一返回(成功**和**失败都必须结构化):

```json
{ "ok": true,  "code": "TASK_SUBMITTED",    "message": "Task submitted",
  "data": {}, "evidence": [], "next_action": null }
{ "ok": false, "code": "PAYMENT_REQUIRED",  "message": "Payment approval is required",
  "data": { "approval_id": "approval-..." }, "next_action": "approve payment or change payment policy" }
```

| 组 | 命令 |
|---|---|
| 网络 | `network init` · `network join <link>` · `network status` · `network leave <network>` · `network peers` |
| 注册/发现 | `agent register --id --name --capability ... --status` · `agent manifest` · `agent discover --capability` · `agent inspect <svc>` |
| 发任务 | `task send --capability --instruction --input --max-payment --currency --network --payment` · `--stdin`/json 文件 |
| 管任务 | `task list` · `status <id>` · `cancel <id>` · `retry <id>` · `result <id>` |
| 收任务 | `task inbox` · `accept <id>` · `reject <id> --reason` · `run <id>` · `complete <id> --result` |
| 钱包/支付 | `wallet status` · `wallet policy` · `wallet set-policy` · `payment pending` · `payment approve <approval-id>` · `payment reject` |
| 交易 | `trade list` · `trade show <id>` · `trade events <id>` · `trade reconcile` |

**加入来源**: `orbitdb://` · `ipns://` · `https://.../registry` · 公开 bootstrap 配置 · Skill 里的默认入口。
`network join` **不许只说"加入成功"** —— 必须报:DID · 网络名 · manifest 是否注册 · P2P 是否在线 · registry 是否同步 · 是否离线降级 · 下一步建议。

**交易命令必须区分**(不许合并成一个"成功"): `local-dev` · `payment_submitted` · `payment_verified` · `fully_settled` · `delivered` · `verified` · `delivery_failed` · `verification_failed`。

## 3. MCP 设计

**Tools (15)**: `bolloon_network_join` · `network_status` · `agent_register` · `agent_discover` · `task_send` · `task_list` · `task_accept` · `task_reject` · `task_status` · `task_cancel` · `task_result` · `payment_status` · `trade_list` · `trade_show` · `trade_reconcile`

**Resources (8)**: `bolloon://network/status` · `network/capabilities` · `agent/manifest` · `tasks/inbox` · `tasks/recent` · `trades/recent` · `wallet/policy` · `skill/current`

**可以**: 发任务 · 接任务 · 查报价 · 请求支付 · **使用已授权的钱包签名** · 查交易结果。
**不可以**: 把私钥返回远端 · 把完整回执写进公共网络 · 绕过 payment policy · 修改交易历史 · **伪造 `verified`** · 无授权时切到自主支付。

## 4. 自主支付与私钥 (与 leo 修正一致)

模式: `manual`(每笔人工确认) · `policy`(命中白名单+限额后自动签, 否则进审批) · `autonomous`(已授权的本地 Agent 直接调钱包签名)。

> ⚠️ **待决**: 本计划写 **3 模式**, 而 leo 2026-09-21 的支付规则修正 + 我的 Phase 1 落地是 **4 模式**(多 `agent-authorized`)。默认保留 4 个, 把 `agent-authorized` 当"**显式授权的 autonomous 变体**"——它必须带用户显式开启标记, 无标记一律拒。请 leo 定夺是否并回 3 个。

自主支付必须串过: 任务预算 → 服务白名单 → 收款地址校验 → 网络校验 → 单笔限额 → 日累计限额 → requestId 幂等 → 交易签名 → x402 settlement → 交易审计。

私钥**可以被本机 Agent 使用**, 但必须: 只存本机 · 不经 P2P 传输 · 不进 Skill · 不进 MCP 返回值 · 不写日志 · 不写 Network Pulse · 不写任务正文 · **每次签名记录 `agent_id` + `task_id` + `transaction_id` + 策略结果**。

Skill 中必须写明: > Agent 可以在用户授权的本地 Runtime 中使用钱包签名能力, 但**永远不能要求其他节点发送私钥**。

## 5. Skill 设计 (`skills/bolloon-network/SKILL.md`)

9 节: ① 元数据(name/version/description/inputSchema/outputSchema/execution{entrypoint: bolloon, modes:[cli,mcp]}/requires:[bolloon-cli]) ② 能力说明(是什么/怎么加入/怎么声明/怎么发现/怎么收发/怎么报价/怎么自主支付/怎么验真/怎么查交易) ③ 快速开始(可直接执行的命令) ④ 任务发送规范(必须 capability/instruction/预算/requestId; **不得把私钥写进任务参数**; 超时怎么处理; 怎么读 task_id/transaction_id) ⑤ 接收任务规范(inbox/验发送方/查 capability/接受拒绝/启动执行/结构化结果/内容哈希或 CID/取消与超时) ⑥ 支付规范(三模式差异/必须走本地钱包/可调签名/**不得索要私钥**/**不得把 local-dev 写成链上**/付款不确定不得重复付/怎么 reconcile) ⑦ 交易结果规范(逐状态含义 + 机器可读示例) ⑧ MCP 用法(`{"mcpServers":{"bolloon":{"command":"bolloon","args":["mcp","serve"]}}}`) ⑨ 故障处理(网络未加入/registry 不可用/找不到 capability/被拒/预算不足/policy 拒/付款不确定/远端超时/验真失败/节点离线/需 reconcile —— **不能让外部 Agent 把失败理解成成功**)。

先按 `skills/AGENTS.md` 确认路径与 frontmatter 规范。

## 6. 兼容矩阵与公开/私有分层

| Agent 类型 | 接入方式 |
|---|---|
| OpenClaw | Skill + MCP |
| Claude Code | Skill + CLI |
| Codex | Skill + CLI/MCP |
| 自研 Agent | CLI JSON |
| 普通脚本 | CLI `--json` |
| 移动端 Agent | 受限 MCP/HTTP bridge |

最低要求: 只会 shell 的 Agent 用 CLI · 支持 MCP 的用 MCP · 都不支持的**仍可读公开 Skill** · **不要求外部 Agent 导入 bolloon 内部 TS 包**。

**公开**: Skill · CLI 命令 · MCP schema · manifest 结构 · capability · 任务状态 · 交易状态 · 验真规则 · 错误码。
**私有**: 私钥 · 本地钱包配置 · 私有任务正文 · 未公开交易内容 · 本地 Agent session · 内部模型配置 · P2P 连接细节。
**Pulse 只显示匿名聚合**: Agent 数 · capability 类别 · 任务数 · 完成数 · 已验证交易数 · 交易量**区间** · 网络活跃状态 —— 不显示单笔私有交易完整信息。

## 7. 六阶段与落地状态

| 阶段 | 内容 | 本仓状态 |
|---|---|---|
| P1 冻结外部协议 | CLI 命令 · JSON 输出 · MCP tools/resources · 错误码 · 任务/报价/交易/结果 schema · 版本策略 | **部分**: `bolloon-task/1` 契约层已落 (`src/agents/task-contract.ts`, 22/22 单测); **错误码表 + JSON 信封 + 版本策略未冻结** |
| P2 写 Skill | `bolloon-network` Skill 9 节 | **未做** |
| P3 CLI 适配层 | 统一暴露 gateway/task/trade/wallet, 全命令 `--json` + 统一 requestId/状态码, **不绕过交易状态机** | **未做**(现有 CLI 子命令尚未逐条映射) |
| P4 MCP 适配层 | tools 调 CLI service + schema + 资源读取 + 超时与错误映射 + 授权钱包签名 | **未做** |
| P5 双节点验证 | 12 步(A 加网 → B 加网 → A 声明能力 → B 发现 → B 发任务 → A 接受 → B 自主支付 → A 执行 → A 返签名结果 → B 验真 → 双方可查 → **重启不重复支付**) | **未做**(Pulse 侧已有双节点集成 36/0 可复用) |
| P6 网页展示 | 本地 Web UI 任务/交易 · bolloon-UI 匿名经济脉冲 · Pulse 加任务与交易聚合 · 公共页给 Skill/CLI/MCP 安装入口 | 网关页 Pulse 已上线(真域名 67/0); **经济聚合未做** |

## 8. 与已落地件的关系

- `docs/wiki/task-protocol.md` (`bolloon-task/1`): P1 的 schema 骨架 —— 任务/报价/接受/结果/失败类型 + 14 态状态机 + 受控自主签名闸 + 签名审计 + 公开投影。
- `docs/wiki/network-pulse.md`: P6 的观察层 —— 事件白名单 + 匿名投影 + `GET /api/public/network/progress`。
- 本页: 把上面两者**对外**包装成 CLI / MCP / Skill 三层入口的协议规范。

## 9. 下一步 (建议顺序)

1. **P1 收尾**: 冻错误码表 + 统一 JSON 信封(`{ok,code,message,data,evidence,next_action}`)+ 协议版本策略(写进 wiki, 不写代码也能冻结)。
2. **P2**: 写 `skills/bolloon-network/SKILL.md`(先查 `skills/AGENTS.md`)。
3. **P3**: CLI 逐条映射(先做 `--json` 与统一 requestId), 复用既有交易状态机。
4. 之后再 P4 MCP / P5 双节点 / P6 经济脉冲。
