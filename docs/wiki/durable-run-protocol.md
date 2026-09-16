---
title: Durable Run 协议 (Goal → Run → Checkpoint → Recovery)
source: session (leo 2026-09-16 设计稿 + 现状盘点)
created: 2026-09-16
last_confirmed: 2026-09-16
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: chapter
tags: [durable-run, run-store, goal, checkpoint, recovery, harness, state-machine, phase-0, acceptance-matrix, web, cli, pi-agent]
---

# Durable Run 协议 (Phase 0)

> 目标: 把 Bolloon 从「有很多局部防护的**单次** agent 调用」收敛成
> 「由 pi agent 驱动、Goal 持续存在、Run 可恢复、Checkpoint 可证明、Web/CLI 只是视图」的单一持久化运行时。
> 本文是 **Phase 0 产物**: 状态机 + 字段协议 + 验收矩阵 + 现状盘点。代码在 `src/agents/run-store.ts`。

## 1. 唯一执行链

```
Goal → Durable Run → Pi Agent Loop → Policy / Harness Gates → Tool Execution → Checkpoint + Recovery → done/failed/paused/awaiting_external/needs_human
```

Web / CLI / Cron / Mobile **只提交目标 + 展示状态**, 不再各自实现 agent 执行逻辑 (现状: web 走 `createAgentSession` + pivot loop, CLI 走同一个 `PiAgentSession`, 已经是同一个 runtime —— 但"视图"侧还没有统一 run API, 见 §6)。

## 2. 状态机 (唯一事实)

| 状态 | 含义 | 谁能进 |
|---|---|---|
| `queued` | 已登记未开始 | startRun(排队模式) |
| `running` | 正在跑 | queued / recovering / paused / awaiting_external / needs_human |
| `recovering` | 正在从错误/中断恢复 | running / interrupted / stalled |
| `paused` | 人类主动暂停 | running |
| `awaiting_external` | 等外部节点/服务回话 (不算失败) | running |
| `done` | 完成**且有证据** | running |
| `failed` | 跑完但没达成 (含模型/工具/鉴权错误) | running / recovering / awaiting_external |
| `aborted` | 主动中止 (预算用尽/用户中断) | running / recovering / paused / awaiting_external / interrupted / stalled / needs_human |
| `interrupted` | 进程死了 (启动对账判的) | running / queued |
| `stalled` | 活着但长时间没进展 (巡检判的) | running / recovering / awaiting_external |
| `needs_human` | 需要人处置 (重复失败/鉴权/非法状态) | running / stalled / recovering |

合法迁移表在 `RUN_TRANSITIONS` (`src/agents/run-store.ts`); **非法迁移一律拒绝** (`canTransition` / `setRunStatus` / `finishRun` 都会挡), 防止"偷偷回到 running"这类假状态。

## 3. 字段协议

Goal (`~/.bolloon/goals/<goalId>.json`, 2026-09-16 Milestone 2 起是**独立事实来源**):

```ts
GoalRecord {
  goalId, objective,
  successCriteria[], constraints[], budget?,
  status: 'open'|'active'|'paused'|'completed'|'failed'|'abandoned',
  channelId?, agentId?, createdBy?, createdAt, updatedAt,
  currentRunId?, runs[],                       // ← runId → goalId 反查链
  completedCriteria[], unresolvedItems[], evidence[],
  resolution?: { reason, at },
}
```

与既有 Goal 模型的关系 (**不删旧模块, 先定唯一关系**):

| 模型 | 定位 |
|---|---|
| `goal-store.ts` (GoalStore) | **目标事实来源** (本协议用) |
| `pi-ecosystem-goals` (queue.json) | 目标队列/草稿 (仍是生产者, 迁移待做) |
| `goal-resume.ts` (park/resume) | 双栖接力的会话级快照 (保留) |
| `plan-store` / `task-state` | Goal 的执行辅助结构 (不承载目标状态) |

Run (`~/.bolloon/runs/<runId>.json`):

```
Run { runId, goalId?, surface, goal, channelId?, agentId?, sessionKey?, pid, host,
      startedAt, updatedAt, status, steps[], budget{maxSteps,deadlineMs},
      checkpoint?, recovery[], summary?, error?, errorClass?, evidence[] }
Step { n, ts, tool, argsDigest?, ok, ms?, summary?, error? }      ← 事实层: 只写真发生的事
Checkpoint { completedActions, pendingAction?, nextAction?, contextRef?, ts }
RecoveryAttempt { ts, errorClass, message, action, attempt, checkpointBefore?, checkpointAfter?, changedPlan?, recovered? }
```

错误分类 → 默认动作 (`classifyError` + 协议表):

| errorClass | 默认动作 | 实现状态 |
|---|---|---|
| `persist_failed` (2026-09-16) | **停** (交人) — 记录都写不进去, 继续跑 = 无记录执行 | ✅ 已接线: `RunPersistenceError` + pi 循环硬闸 + `needs_human` |
| `transient` (网络/429/5xx) | 指数退避重试 | pi-ai 内置重试; run 只记录 |
| `auth` (401/403) | **不重试**, 交人 | ✅ 已接线 (`needs_human`) |
| `bad_args` | 修正参数重试一次 | react-loop 有连续失败计数; 未落 recovery ← 待办 |
| `no_such_tool` | 换工具/重规划 | `decideNext` unknown tool → continue |
| `policy_denied` | 不重试走策略分支 | deny-pipeline / pre-tool-validator |
| `external_no_reply` | 标 `awaiting_external` | 委派端 504 已有; 状态未落 ← 待办 |
| `unparsable` | 重提示一次再暂停 | 已有 sentinel/reflection |
| `repeat_failure` | 熔断 → `needs_human` | `MAX_SAME_TOOL_FAILURES=3` + `repeatedFailureCount` 已有; 未落 run 状态 ← 待办 |
| `crash` | 从最近 checkpoint 恢复 | ✅ 对账判 interrupted 时已正确分类 (`crash`); 自动 resume ← 待办 (Milestone 2) |
| `corrupt_state` | 用最后有效 checkpoint + 记修复事件 | ✅ 已接线: `.bak` 回退 + `corrupt_state` 恢复事件 + 降级留痕 |

## 3.5 持久化等级 (2026-09-16 Milestone 1)

「持久化失败继续跑」是这一层最危险的失败模式: agent 实际运行了、run 没记录、UI 显示旧状态、重启后无从知晓、
结果还可能被错标 `done`。所以持久化操作按**等级**处置:

| 等级 | 内容 | 失败处置 |
|---|---|---|
| **core** (核心状态) | `startRun` / 状态迁移 / `recordStep`(含 checkpoint) / `finishRun` / `recordRecovery` / run 锁 | **阻止或暂停运行** → `needs_human`; 由 `RunPersistenceError` 抛出, pi 循环顶部硬闸 break, 且**不重试** (`runPersistenceBlocked`) |
| **observational** (观测) | SSE 广播 / UI 刷新 / 调试日志 | 可继续运行, 但必须落 `_degradations.jsonl` (runs 目录写不进去 → 退到 `~/.bolloon/run-degradations.jsonl` 再试, 最后才 stderr) |

开关: `~/.bolloon/harness.json` 的 `persistence: 'strict' | 'degraded'` (默认 `strict`; env `BOLLOON_RUN_PERSIST=degraded` 可临时放宽)。
`degraded` 只给明确的弱环境用 —— 它意味着"允许没有记录的运行", 不是默认姿势。

并发与损坏:

- **同 run 写入串行化**: 进程内 promise 链 + 跨进程 lock 文件 (`<runId>.lock`, 记 pid/ts; 持锁进程已死或超过 `lockStaleMs` → 回收)。并发 `recordStep` 不再互相覆盖步骤。
- **原子写 + 最后有效备份**: 写盘先 `.tmp` 再 `rename`; 每次写前把**上一次能 parse 的内容**留成 `<runId>.json.bak`。
- **损坏回退**: 主文件 parse 失败 → 用 `.bak` 修复主文件 + 追加一条 `corrupt_state` 恢复事件 (`recovered: true`), 而不是把这条运行当成"不存在"。

## 4. 「全绿」的定义 (不只是测试通过)

1. 所有 active run 都有**合法状态** (状态机校验)。
2. 没有幽灵 `running` (启动对账 + 失速巡检)。
3. 每个 run 能回答: 目标是什么 / 做到哪一步 / 下一步是什么 / 为什么停 (`goal` + `checkpoint` + `error` + `errorClass`)。
4. 失败必须有 **recovery decision** (`recovery[]` 留痕)。
5. 重启后能恢复 **目标 + checkpoint + 约束**。
6. CLI / Web 显示**同一份** run 状态 (同一个 `/api/runs` 与 `/runs`)。

## 5. 现状盘点 (Phase 1 要冻结的清单)

**约束层 (分散, 待收敛成单一 Policy Engine)**

| 组件 | 位置 | 职责 | 现状问题 |
|---|---|---|---|
| ReactHarness | `src/security/react-harness.ts` | pre/post tool gate + 路由 hint | 只在单次 prompt 内存里; 出错 `fail-open` |
| deny-pipeline | `src/agents/deny-pipeline.ts` | 工具黑名单/危险命令 | 与 pre-tool-validator 职责重叠 |
| pre-tool-validator | `src/agents/pre-tool-validator.ts` | 参数校验 | 同上 |
| hooks-engine | `src/hooks/hooks-engine.ts` | onLoopStart 等生命周期钩子 | 各 hook 失败静默 (fail-open) |
| economic-policy / payment-gate | `src/agents/{economic-policy.ts,payment-gate.ts}` | 支付/预算闸门 | 与 run budget 无关联 |
| loop-review | `src/agents/loop-review.ts` | final 前目标对齐 review | 只看当轮 |
| bollharness | `src/bollharness/` | **给编码 agent (Claude Code hooks)** 的治理框架 | 与 bolloon 运行时无关, 别混为一谈 |

**目标/任务/会话模型 (并行, 待收敛)**

| 模型 | 位置 | 持久化 | 缺口 |
|---|---|---|---|
| Goal | `src/agents/goal-resume.ts` | 有 | 与 run 未强绑定 |
| Plan/Task | `src/agents/plan-store.ts` / `task-state.ts` | `~/.bolloon/tasks/*.yaml` | 不绑定 run |
| Session | `src/agents/session-store.ts` | `~/.bolloon/sessions/**` | 恢复=回灌历史, 不是恢复执行 |
| Trajectory | `src/orbitdb/trajectory-store.ts` | OrbitDB | **跑完才写**, fire-and-forget → 崩了没有 |
| **Run** | `src/agents/run-store.ts` (本协议) | `~/.bolloon/runs/*.json` | 已有: 逐步落盘/预算/对账/巡检/状态机/恢复留痕 |

**守护层 (可复用)**: `src/cron/` — tick 锁 + executions-store + DND + monitor; 失速巡检已挂在 server 启动块 (`每 60s`)。

## 6. 验收矩阵 (Phase 6 四组)

| 组 | 条目 | 状态 |
|---|---|---|
| A 持久化 | 工具执行中 SIGKILL → 记录仍完整 | ✅ `verify-durable-runs.ts [1]` |
| A | 页面刷新不丢 run | ✅ (落盘 + `/api/runs`) |
| A | CLI 与 Web 读到同一 run | ✅ 同一 store (端到端 UI 面板待做) |
| A | 并发写入不覆盖步骤 | ✅ (2026-09-16 Milestone 1: 进程内锁 + 跨进程 lock; 单测 20 并发不丢步) |
| A | 文件损坏 → 回退最后有效状态 | ✅ (`.bak` 回退 + `corrupt_state` 修复事件, 单测 + 降级留痕) |
| A | 核心写失败 → 阻止继续执行 | ✅ (strict 默认: `RunPersistenceError` + pi 循环硬闸 + `needs_human`; 真 agent 验收 `[7]`) |
| B 恢复 | 网络错误最终恢复 | ⚠️ pi-ai 重试已有; run 未记 recovery |
| B | 参数错误能纠正 | ⚠️ loop 有计数; 未落 recovery |
| B | 非幂等工具不重复执行 | ❌ 待做 (checkpoint 已有, 无重放守卫) |
| B | 连续失败熔断 | ⚠️ `MAX_SAME_TOOL_FAILURES` + `repeatedFailureCount` 已有; 未落 `needs_human` |
| B | 外部等待不误判失败 | ❌ 待做 (`awaiting_external` 未接线) |
| B | 恢复失败 → `needs_human` | ⚠️ 状态机已有, 未接线 |
| C 目标持续 | 重启后 Goal 仍在 | ⚠️ Goal 有存储, 未绑 run |
| C | 从 checkpoint 继续 (不从头) | ❌ `resumeRun` 待做 (Milestone 2) |
| C | 已完成步骤不重复 | ❌ 待做 |
| C | 目标未达成不许显示完成 | ✅ done 需 evidence 校验位置已在协议里 (强校验待做) |
| C | 目标漂移检测 | ❌ 待做 (loop-review 只管当轮) |
| D 双端一致 | Web/CLI/Cron 同一状态 | ✅ 同一 store; Web 面板待做 |
| D | Web 发起的 run 可由 CLI 恢复 | ⚠️ `/runs` 可看; `/resume` 待做 |
| D | CLI 发起的 run 可在 Web 看 | ✅ `/api/runs` |
| D | UI 断开 agent 仍执行 | ✅ (执行在服务端进程) |
| D | UI 恢复后补齐历史 | ⚠️ 需前端拉 `/api/runs` |

## 7. 明确不做 (第一阶段)

- 不新增独立 harness (只收敛)。
- 不在 Web/CLI 里复制 agent loop。
- 不先做 RAG / 更多 memory 层。
- 不把"自动重试成功"当恢复完成。
- 不把所有错误都设成 `fail-open`。
- 不以"最终生成了文本"作为完成标准。

## 8. 验证

```bash
npx tsx scripts/verify-durable-runs.ts    # A 组 + 预算 + 失速 + 真 LLM 在环
npx tsx scripts/run-pc-closed-loop.sh     # 入网闭环回归 (PC)
```

**实测 (2026-09-16): `35 passed / 0 failed`** (`[1]-[7]`, 含真 SIGKILL 子进程、真 deepseek 在环、真 agent 遇持久化失败停止)。
单测: `src/test/run-store.test.ts` **31 条** (状态机/分类/checkpoint/20 并发不丢步/锁回收/损坏回退/strict 抛错/degraded 降级/预算/对账/失速/降级日志兜底)。

上一次留在这里的「真 LLM 在环撞 401, key 有第二个来源 (尾 `2d23`)」是**误判**, 根因在验收脚本自己身上:

```ts
const tmpRoot = ...; const HOME = path.join(tmpRoot, 'home');
process.env.HOME = HOME;            // ← 先覆盖了 HOME
const REAL_HOME = os.homedir();     // ← 再取: POSIX 上 os.homedir() 读 $HOME → 拿到空的隔离目录
```

于是「把本机 `~/.bolloon/{llm-config,keypair,…}.json` 复制进隔离 HOME」那步**静默复制不到任何东西** (copyFile 被 try/catch 吞掉) → agent 退化成默认 provider (`openai` / `gpt-5.6`, 无 key) → 症状是 `401` / `OPENAI_API_KEY not set`。即 **「真 LLM 在环」这条用例自建起就没真正跑过**, 而它是最关键的一条 (唯一能证明「真 agent 运行 → 落盘记录里有真步骤」的用例)。把 `REAL_HOME` 提到覆盖 HOME 之前后: 真 deepseek (`deepseek-v4-flash`) 在环跑通 —— 真 `shell_exec` 步骤进记录、`surface=web`、收尾 `done`。「key 第二个来源」的结论**未复现**, 不再作为走查方向。

**教训 (写进验收纪律)**: 隔离 HOME 的测试必须先取真家目录再覆盖环境变量; 配置复制被 `try/catch` 吞掉时, 「没有 key」会被误读成「key 不对」—— 静默吞错会把错误引导到完全错误的方向。

## 9. 完成度台账 (2026-09-16, 对照 leo 的六阶段)

| Phase | 完成度 | 证据 / 缺口 |
|---|---|---|
| **0 冻结现状 + 定义「全绿」** | ✅ 100% | 11 状态 + `RUN_TRANSITIONS` + 字段协议 + 验收矩阵全部落纸 (`durable-run-protocol.md` §2/§3/§6) |
| **1 收敛成唯一权威入口 `PiAgentHarness`** | ⚠️ 40% | **Milestone 1-B 完成**: `src/agents/pi-harness.ts` 成为唯一门面, pi-sdk 里已**零直连** (`this.reactHarness.preToolCall/postToolCall/getLastRouteHint`、`this._denyPipeline.check`、`decideAfterReview`、`validatePreToolUse` 全部消失, 由单测做源码级断言锁住); 9 个生命周期方法 + 四类失败分级 + 事件带 runId/goalId。**仍未做**: 旧模块之间的职责边界没有真正合并 (只是入口收敛), tool-gate 仍未纳入门面, bollharness 仍是独立集成 |
| **2 Goal → Run → Checkpoint** | ⚠️ 40% | 每步自动写 checkpoint ✅; `Run.goal` 文本 ✅; **但 `goalId` 从未被赋值** (pi-sdk `startRun` 不传, Goal 仍只在 `goal-resume.ts` 里); 没有 `resumeRun`, 「从 checkpoint 继续」尚未实现 |
| **3 错误恢复闭环** | ⚠️ 25% | `classifyError` + `errorClass` 落盘 ✅; `crash`(对账) / `corrupt_state`(.bak 回退) / `persist_failed`(停) 三条已接线 ✅; **但 `recordRecovery` / `repeatedFailureCount` 运行时仍未接进循环**, `recovering` / `paused` / `awaiting_external` 运行时永不写入 |
| **4 持续目标 + 进度证明** | ⚠️ 10% | `evidence[]` 字段有, 但 pi-sdk 收尾 `finishRun` **不传 evidence** → `done` 无证据也照样绿; 无 success criteria 定义与校验; 无目标漂移检测; `loop-review` 是既有的按轮 review, 不是 run 级三检查 |
| **5 Web / CLI 只做视图** | ⚠️ 35% | `GET /api/runs` ✅ + CLI `/runs`、`/runs <id>` ✅ (同一 store); **Web 前端零接入** (`client.ts` 未动, 无目标卡片/checkpoint/恢复记录); `/resume` `/pause` `/approve` `/goals` 全无; 手机端未接 |
| **6 可靠性门禁** | ⚠️ 40% | A 组 **6/6 全绿** (Milestone 1 补齐并发锁 + 损坏回退 + 核心写失败阻止执行); B 组 1/6; C 组 2/5; D 组 3/5 —— 逐条状态见 §6 |

**推荐实施顺序的 10 步实际走到哪**: ① 协议 ✅ · ② 盘点 ⚠️ (表有了, 代码职责未冻结) · ③ 选定 pi 生命周期为唯一入口 ❌ · ④ run-store 改造为权威 Run Controller ⚠️ 部分 (落盘/对账/巡检/预算在, 但无 resume/pause/approve, 且是旁路) · ⑤ 合并 Policy Engine ❌ · ⑥ checkpoint + 恢复状态机 ⚠️ (结构齐, 未接线) · ⑦ Goal 绑 Run ❌ · ⑧ Web/CLI 统一 API ⚠️ (只读 + CLI) · ⑨ 崩溃/错误恢复验收 ⚠️ (A 组过, B 组没做) · ⑩ 性能/UI ❌ (按计划本就最后做)。

**一句话**: 协议层 (Phase 0) 完成; Milestone 1 把「持久化必须是硬约束」做掉 (A 组 6/6 全绿);
Milestone 1-B 把「所有约束必经一个门面」做掉 (pi-sdk 零直连 gate, 真跑证明工具绕不过去)。
现在拿到的是「跑得动、看得见、死了不留幽灵、**写不进去就停**、**约束只有一个入口**」的持久层 + 约束门面;
还不是「Goal 持续 + 可恢复 + 有证据」的运行时 —— 那三件事 (M2 Goal 绑定/resume、M3 恢复接线、M4 完成门) 都还没开始。

## 10. Milestone 1 清单 (2026-09-16)

| 项 | 状态 | 证据 |
|---|---|---|
| 持久化失败不再全部 fail-open | ✅ | `RunPersistenceError` + pi 循环顶部硬闸 + `runPersistenceBlocked` (不重试) + `needs_human` 落状态; 真 agent 验收 `[7]` |
| run-store vitest 单测 | ✅ | `src/test/run-store.test.ts` 31 条 |
| 并发写入保护 | ✅ | 进程内 promise 链 + 跨进程 `<runId>.lock` (pid/ts + 陈旧回收); 单测 20 并发不丢步 |
| 文件损坏回退 | ✅ | `<runId>.json.bak` (只存能 parse 的上一版) + 修复事件 `corrupt_state` |
| 降级留痕 (观测失败不许静默) | ✅ | `_degradations.jsonl`; runs 目录写不进去时退到 `~/.bolloon/run-degradations.jsonl` |

## 11. Milestone 1-B: 唯一 PiAgentHarness (2026-09-16)

代码: `src/agents/pi-harness.ts` (门面) + `src/agents/pi-sdk.ts` (只依赖门面)。

**生命周期 (pi-sdk 只调这些)**

```
sessionStart → beforeModelCall → afterModelCall → beforeToolCall → afterToolCall
             → checkpoint → recover → pause → sessionEnd (+ reviewFinal)
```

**六层模块现在的定位** (都没删, 只是不再被 pi-sdk 直调)

| 模块 | 在门面里的位置 |
|---|---|
| `deny-pipeline` | `beforeToolCall` 第 1 层 (deny-list → permission → hooks) |
| `pre-tool-validator` (经 human-value-pipeline 的 `onPreToolUse`) | `beforeToolCall` 第 2 层 (modeGate/blacklist/shell-guard/schema) |
| `ReactHarness` | `beforeToolCall` 第 3 层 (8-gate) + `afterToolCall` (router hint + output gate) + `sessionStart/sessionEnd` |
| `hooks-engine` | `sessionStart` 内 fire `onLoopStart` (次数与旧实现一致) |
| `loop-review` | `reviewFinal` (final 前的完成度自查) |
| `tool-gate` | **尚未纳入门面** (现状仍是被 ReactHarness 间接使用) — 待办 |
| `bollharness-integration` | 保持编码 agent 专用能力, 仍由 ReactHarness 内部持有, 不与 Durable Run 混成一套 |

**失败分级 (四类)**

| 分级 | 触发 | 处置 |
|---|---|---|
| `core_constraint` | 约束层自身抛错 (deny-pipeline / validator / 8-gate) | **阻止该工具调用** (fail-closed, 默认) + 事件 `kind=error` |
| `policy_denied` | 工具被策略拒绝 | 返回 agent 可处理的拒绝结果 (计数器 + 引导语), 不崩不静默放行 |
| `observational` | 观测/记账失败 (事件写入、hint 读取、output gate 失效) | 降级留痕, 决策不变 |
| `goal_review` | 审查器失效 | 按"未确认完成"处理 → **不许进 done** |

**刻意记下的行为变更 (不是顺带改动)**

1. **fail-open → fail-closed** (默认): 旧实现里 `deny-pipeline` 抛错 = 放行、`reactHarness.preToolCall` 抛错 = 放行。现在约束层失效 → **阻止该工具调用**并留痕。`failClosed: false` 是显式逃生门 (仅测试/弱环境用)。
2. **deny-pipeline 与 validator/8-gate 的判定点合并到未知工具检查之后**: 未知工具检查是纯 Map 查表 (无副作用), 移到最后会让"既是未知工具又被拒"的场景报 `未知工具` 而不是拒绝文案 —— 工具本身都不会执行, 差异只在文案。
3. **`beforeModelCall`/`afterModelCall` 不 fire 新 hook 事件**: 旧行为里模型调用前没有任何 hook; 加了会改变现有 `hooks.yaml` 用户的触发次数 (属于行为变更, 留待单独决策)。它们现在只计数 + 留事件。
4. **Harness 事件是"观测级"写入**: 记账失败绝不改变已做出的决策 (记录是账, 不是闸), 失败落降级日志。理由: 让一次磁盘抖动去中止一次已经判定为"允许"的工具调用, 是拿可用性换账面。
5. **output gate 失效仍放行原输出**, 但现在会记 `kind=degrade` (旧实现是彻底静默) —— 不允许"gate 没跑成"被看成"gate 通过了"。

**Run 里的留痕**: `Run.harness[]` (最多 50 条, `MAX_HARNESS_EVENTS`), 每条带 `runId`/`goalId`/`tool`/`source`/`failureKind`。

**验证**

```bash
npx tsx scripts/verify-pi-harness.ts    # 真跑: 工具绕不过门面 (10/10)
npx vitest run src/test/pi-harness.test.ts   # 门面单测 19 条 (含源码级"零直连"断言)
```

`verify-pi-harness.ts` 的做法与结果: 隔离 HOME 写一条 `preToolUse` hook 拒绝 `write_file` → 真 deepseek agent 被要求写文件 → **目标文件没被创建** / Run 里没有 `write_file` 步骤 / `Run.harness[]` 有 `deny`(source `deny-pipeline:hooks`, failureKind `policy_denied`) 且带 `runId` / agent 如实汇报"被护栏拦截、不重试不绕道" (10/10)。

## 12. Milestone 2/3/4: Goal 绑定 · resume · 恢复接线 · 完成门 (2026-09-16)

代码: `src/agents/goal-store.ts` (新) + `run-store.ts` (prepareResume 等) + `pi-sdk.ts` (入口/收尾接线) + `server.ts` / `index.ts` (控制面)。

### 12.1 目标绑定 (Run 向上有 Goal)

每个 prompt 入口 (非恢复模式) 必做:

```
有 goalId (CLI/Web 指定)         → 在该 Goal 下执行
没有 goalId + 该 channel/agent 有 open/active Goal
  且它上一次执行**没收尾**        → 继续该 Goal
否则                              → 新建 Goal
```

- `startRun({ goalId })` 现在收到**真 goalId**; `attachRun(goalId, runId)` 建立 `runId → goalId → objective/successCriteria` 反查链。
- 延续规则是**确定性**的 (看上一次 run 的状态), 不靠猜模型意图; 已完成 (completed) 的 Goal 不会被下一次 prompt 续上。
- 未声明 `successCriteria` 的新 Goal **永不自动完成** —— 这是有意的: 没有判据就说"完成"是最典型的假成功。

### 12.2 resume: 从 checkpoint 继续, 不是重发 prompt

```
prepareResume(runId)
  ├── 校验状态 ∈ {recovering, interrupted, stalled, paused, needs_human, awaiting_external}   (done/failed/aborted 是终态, 不复活)
  ├── 读 checkpoint + 已完成步骤 + Goal objective
  ├── 生成 ResumePlan { completedSteps, lastStep, nextAction, replayGuards[] }
  ├── 抢归属 (pid=当前进程, 否则启动对账会把它又判成 interrupted)
  ├── 状态 → recovering + 记一条 recovery(action='resume')
  └── 执行时 recovering → running, 走**同一个 runId** (历史保留)
```

- **非幂等重放守卫**: 恢复时若同一工具 + 同一组参数**在中断前已成功执行过**, 不再真执行, 直接复用当时结果并标 `[恢复保护]`。
  白名单 (`IDEMPOTENT_TOOLS`) 之外的**一律按非幂等保守处理** (不认识的工具也算非幂等)。
  局限 (如实): 守卫按 (tool + argsDigest) 精确匹配 —— 换个参数的同类操作属"另一次操作", 由恢复指令里的"不要重复"提示兜底, 不做更激进的推断。
- `buildResumeInstruction(plan)`: 把目标 / 已完成动作 / ⛔ 非幂等禁做清单 / 下一步写进指令, 明确"这是恢复不是新任务"。

### 12.3 恢复接线 (运行时真的发生, 不再只是数据结构)

| 情形 | 行为 |
|---|---|
| `transient` (超时/429/网络) | 记 `recordRecovery(action='backoff')`; 同工具同参数连续失败达 3 次 → **熔断** 落 `needs_human` + 循环硬闸停 |
| `external_no_reply` (对端 504/无响应) | 落 `awaiting_external` (不算失败); 之后有成功步骤 → 回 `running` |
| `auth` (401/403) | **不重试** → `needs_human` |
| 核心状态写入失败 | 沿用 M1 硬约束: 停 + `needs_human` + 不重试 |
| 外部 (CLI/Web) 改状态 | 循环在下一次检查时如实停: `paused` 保持 paused, `aborted` 保持 aborted (不覆盖成 done/failed) |

### 12.4 完成门 (M4): "模型说完成" ≠ "系统确认完成"

Run 收尾的确定性判定 (顺序即优先级):

```
持久化失败 / 熔断 / 鉴权  → needs_human
预算或用户中止            → aborted
AI 失败 (auth 除外)       → failed
末尾步骤仍失败            → failed     ← 旧的"工具失败→模型说完成→done"被这条挡住
有工具步骤但零成功证据    → failed
否则                      → done (+ evidence[] 从成功步骤写入)
```

Goal 侧 (`evaluateGoalCompletion`, 确定性): 判据全满足 **且** 有证据 **且** 无未解决项 → 才允许 `completed`;
否则 Goal 保持 active 并把缺失判据写进 `unresolvedItems` (不静默)。`Run done` 不等于 `Goal completed`。

### 12.5 控制面 (Web/CLI 只操作 store, 不碰 agent 内部状态)

```
GET  /api/runs            GET  /api/runs/:runId        (含 goal / checkpoint / steps / recovery / harness[])
POST /api/runs/:id/resume (不可恢复状态 → 409, 不假装已开始)
POST /api/runs/:id/pause  POST /api/runs/:id/abort     (非法迁移 → 409)
POST /api/runs/:id/approve (仅 needs_human)
GET  /api/goals           GET  /api/goals/:goalId      (带 completion 判定)

CLI: /runs · /runs <id> · /resume [id] · /pause [id] · /approve [id] · /goals [id]
```

### 12.6 验证

```bash
npx tsx scripts/verify-durable-recovery.ts        # 真 SIGKILL→真恢复 + 熔断/外部等待/完成门/目标链/真 HTTP
npx vitest run src/test/goal-store.test.ts src/test/run-store.test.ts
```

### 12.7 这一步**没有**做到的 (下一篇的起点)

- **没有 Supervisor**: `reconcileOrphans` 只把死进程的 run 判 `interrupted`, 不会自动 `interrupted → recovering → running`; `superviseRuns` 只标 `stalled`, 不会续跑。**触发恢复目前需要人 (CLI /resume 或 API)。**
- **没有 lease / 认领**: 两个进程可能同时恢复同一个 Goal。
- **没有持久化唤醒模型**: 预算耗尽/暂时失败/等待外部之后的"何时继续"没有落盘 (`retryAt`、wake 条件都不存在)。
- **Web 的 channel queue 仍是内存态**: 重启后未处理消息不会变成 durable work。
- **Cron 仍是"重新发 prompt"**, 不是继续 Goal。
- **Web 前端还没有 Run/Goal 面板** (API 已就绪)。

这些都归入下一阶段 **Durable Long-Running Execution** (见 §13)。

## 13. 下一阶段: Durable Long-Running Execution (Supervisor)

> 原则: **Harness 管一次执行是否安全; Supervisor 管这个目标是否继续活着。**

层次: `GoalStore (长期目标 + 唤醒意图) → Execution Supervisor (认领/租约/调度/续跑) → RunStore (有限执行片段) → PiAgentHarness (片段内约束) → Pi Agent`

要做的 (按 leo 2026-09-16 的 2-A…2-F):

1. **2-A 边界冻结**: Goal = 长期对象 (completed/failed/abandoned/needs_human 才结束); Run = 受预算限制的执行片段; Run 结束必须留下 continuation (目标/已完成/未完成/下一动作/唤醒条件/是否可自动继续/需要什么外部输入)。**不把长期任务做成一个超长 Run。**
2. **2-B ExecutionSupervisor** (常驻 worker, 不塞进 web request): 扫 open/active Goal → 认领 (lease) → 建/恢复 Run → 起 agent → 等结束 → 决策 (继续排队/延迟重试/等外部/暂停/交人/完成 Goal) → 释放 lease → 下一个。
   租约语义: `leaseOwner / leaseId / leaseUntil / lastHeartbeat / claimedAt`, 过期才能被别的 worker 回收。
3. **2-C 持久化唤醒模型**: Goal 状态 → 唤醒条件 (active 立即 / paused 等人 / awaiting_external 等事件 / recovering 立即 / stalled 巡检后处理 / needs_human 等人批 / retry_wait 到 `retryAt` / completed 不再唤醒)。
4. **2-D Run 结束 → Goal 决策**: 预算耗尽 → Run aborted / Goal active / 下一步新 Run; 暂时失败 → `retryAt`; 等 peer → awaiting_external; 崩溃 → Supervisor prepareResume; 连续失败 → Goal needs_human; 判据全满足 → Goal completed。
5. **2-E 四类恢复分离**: 同一 Run 内短重试 / Run 结束后跨 Run 恢复 / 崩溃后跨进程恢复 / 外部事件唤醒 —— 不混成一种"多重试几次"。
6. **2-F 成功执行但 Goal 未完成**: 创建 Goal 时生成或要求判据; 成功步骤产生 candidate evidence; 更新 criterion; `completeGoalIfEligible` 是**唯一**完成出口。

**下一批的验收 (按行为, 不按接口)**: ① 跨预算继续 (Run1 maxSteps → 自动 Run2 → Run3 → Goal completed) ② 进程崩溃自动恢复且已完成步骤不重跑 ③ 页面与进程都消失后重启 server 自动恢复 ④ 委派无响应 → awaiting_external → 事件到达自动唤醒 ⑤ 两个 worker 抢同一 Goal (A 崩溃后 lease 过期 B 才接管) ⑥ 用户 pause 后重启仍是 paused, resume 才继续。

## 14. 批次 1: Goal continuation + ExecutionSupervisor + lease (2-A / 2-B) — 2026-09-16

> 这一批补的是**长期执行层**: 不再是"一次执行能不能恢复", 而是"这个目标还要不要继续执行, 由谁执行, 什么时候执行"。

### 14.1 层次与职责分界

```
Goal (长期目标)            ← GoalStore = 目标唯一事实来源 (含调度元数据)
  ↓
ExecutionSupervisor        ← 持续调度与唤醒 (常驻 worker, 不依赖浏览器/页面)
  ↓
Run (一个有限执行片段)      ← RunStore = 一次执行事实来源
  ↓
PiAgentHarness             ← 这一段能不能安全执行 (生命周期的唯一入口)
  ↓
Pi Agent                   ← 实际执行
```

原则: **Harness 管「这一段能不能安全执行」; Supervisor 管「这个目标还要不要继续执行」。**
不把一个长期目标做成一个超长 Run —— Run 受预算限制, 结束后必须留下 continuation。

### 14.2 2-A 冻结: Goal / Run / Continuation 边界

**Goal 状态机与 2-C 唤醒表 1:1 对齐** (不再只用 active/paused 硬撑):

`open` · `active`(现在就能推进) · `recovering`(崩溃接管中) · `retry_wait`(等 retryAt) ·
`awaiting_external`(等外部事件) · `stalled`(失速待决策) · `paused` / `needs_human`(等人) ·
`completed` / `failed` / `abandoned`(终态)

**Continuation 字段挂在 Goal 上** (不新增第四套目标库):

| 字段 | 含义 |
|---|---|
| `nextAction` | 下一个 Run 的入口动作 (来自上一个 Run 的 checkpoint) |
| `wakeReason` | 唤醒原因 (状态机语义) |
| `wakeAt` | 何时可被唤醒 (retry_wait) |
| `autoContinue` | 是否允许自动继续 (false = 必须等人) |
| `needsExternal` | 在等什么外部事件 |
| `completedActions` | 跨 Run 累计已完成动作 |
| `replayGuards` | 跨 Run 非幂等重放守卫 |
| `attempts` | 自动继续尝试次数 (退避/熔断) |
| `lastRunId` | 最近一次执行的 runId |

完成标准 (本批已验证): **预算耗尽不会让 Goal 失败**; **Run 可以结束而 Goal 仍 active**;
**Goal 能明确指出下一次何时、因为什么被唤醒** (`wakeReport()`)。

### 14.3 2-B ExecutionSupervisor

常驻 worker (`src/agents/execution-supervisor.ts`), 不塞进 web request, 不依赖页面是否打开。
tick 默认 30s, lease TTL 90s, `maxPerTick` 1 (长期执行要克制)。

一个调度周期:

```
对账孤儿 reconcileOrphans + 失速巡检 superviseRuns
  → listRunnableGoals (含"为什么没被选中")
  → claimGoal (原子抢 lease, 抢不到就让路并记原因)
  → 乐观并发检查 (扫描后状态若被别的 worker 推进过 → 让路)
  → 决定 resume (可恢复状态) 或 continue_new_run (上一条 Run 已终结) 或 first_run
  → 执行 runner (期间按 TTL/3 续租; 续租失败 = 已被接管 → 记事件, 不掩盖)
  → 读回 Run → decideGoalOutcome → 写 Goal 状态 + continuation + 证据 → 释放 lease
  → 下一个 Goal
```

**runner 由调用方注入**: Web 用 channel agent (`setGoalId` + `prompt` / `resumeRun`), CLI 用当前会话 agent,
测试用假的。**没有注入 runner 时只诊断不执行 (dry-run), 绝不假装跑过。**

### 14.4 lease 语义 (跨进程排他)

- 真值是 `<goalId>.lease` 文件, 用 `O_EXCL` 独占创建 → **claim 本身是原子操作**; Goal 上的 `lease` 字段只是镜像。
- 字段: `owner` `leaseId` `claimedAt` `lastHeartbeat` `leaseUntil` (+ `pid` / `host`)。
- 可回收 (任一): ① `leaseUntil` 过期 (TTL) ② **持有者进程已死** (更早回收 —— 持有者可证明已死, 不必等满 TTL)。
- 不可回收: 持有者活着且未过期 → 明确返回 `ok:false` + holder (调用方**让路**, 不是报错)。
- 被接管后旧 worker 不能再写: 旧 `leaseId` 的续租/释放一律失败 (`lease 已被接管`)。

### 14.5 2-D reducer: Run 结束 → Goal 决策 (确定性, 纯函数)

| Run 结果 | Goal | 下一步 |
|---|---|---|
| `done` + 判据全满足 | `completed` | 经 `completeGoalIfEligible` (唯一出口) |
| `done` + 判据未满足 | `active` | 继续下一个 Run (**Run done ≠ Goal completed**) |
| `aborted` (预算/人工) | `active` | 交给下一个 Run (Goal 不失败) |
| `interrupted` | `recovering` | Supervisor 走 `prepareResume` (同一条 Run) |
| `stalled` | `stalled` | Supervisor 决策恢复或转人工 |
| `awaiting_external` | `awaiting_external` | 等事件, **不重发请求** |
| `failed` transient/network/5xx | `retry_wait` | `wakeAt` = now + 退避 (0/15s/60s/5min/15min) |
| `failed` auth / repeat_failure / persist_failed / policy_denied / bad_args / no_such_tool, 或 `attempts ≥ 3` | `needs_human` | `autoContinue=false`, 等人 approve |
| `paused` (人定的) | `paused` | 不覆盖人的决定 |

### 14.6 唤醒表 (2-C 的运行时落地)

`listRunnableGoals()` 只把**现在就该跑**的 Goal 交出去, 其余连**原因**一起返回 (不静默跳过):

| 状态 | 能否自动唤醒 |
|---|---|
| `open` / `active` / `recovering` / `stalled` | ✅ 立即 |
| `retry_wait` | ✅ 但仅当 `wakeAt` 已到 |
| `awaiting_external` | ❌ 等外部事件 (`notifyExternal` 唤醒) |
| `paused` / `needs_human` | ❌ 等人 (重启也不会自动跑) |
| `completed` / `failed` / `abandoned` | ❌ 终态 |
| (任何状态) 有活 lease | ❌ 已被别的 worker 认领 |

### 14.7 控制面

```
GET  /api/supervisor            supervisor 状态 + 每个 Goal 的唤醒原因 + 可推进/跳过清单
POST /api/supervisor/tick       手动一个调度周期
POST /api/goals/:id/wake        外部事件到达 → 唤醒在等它的 Goal (不在等 → 409, 可 force)

CLI: /supervise · /supervise tick · /wake <goalId>

env: BOLLOON_SUPERVISOR=0 (关闭) · BOLLOON_SUPERVISOR_TICK_MS · BOLLOON_SUPERVISOR_LEASE_MS · BOLLOON_SUPERVISOR_MAX_PER_TICK
```

### 14.8 验证 (真跑, 2026-09-16)

```bash
npx tsx scripts/verify-supervisor.ts        # 37/37
npx vitest run src/test/supervisor-lease.test.ts   # 24/24
```

`verify-supervisor.ts` 的 8 组:
① 跨进程 lease 排他 (真两个进程) ② worker 崩溃接管 (SIGKILL 后死进程即时回收) ③ 被接管者不能写
④ 跨预算/跨 Run 继续 (真 deepseek: 一个 Goal 跨 2 条 Run, 新 Run 挂同一 Goal, 非幂等守卫跨 Run 传递)
⑤ 两个 Supervisor 同时 tick → 只执行一次 ⑥ 唤醒表 (paused/awaiting_external 不自动跑 + 事件唤醒)
⑦ 诊断可读 ⑧ 预算耗尽 → Run 如实 `aborted` + Goal 不失败 + Supervisor 自动开下一个 Run

**本批真跑抓到的两个真 bug** (都已修 + 有回归断言):

1. `prompt` 收尾会清空 `currentRunId` → 控制面/Supervisor 事后读 `getRunId()` 恒为空, 会**拿上一条 Run 做决策**。
   修法: 新增 `getLastRunId()` (收尾不清空), web/CLI/验收三处改用。
2. 并发 tick 下 "陈旧快照" 会让**同一个 Goal 被两个 worker 各跑一次** (lease 在对方释放后就成了合法认领)。
   修法: 认领后重读 Goal 做**乐观并发检查** (状态/当前 run/run 列表/continuation 变过就让路)。

### 14.9 本批**没有**做到的 (批次 2/3 的起点)

- **重启后自动继续**还没做端到端验收: Supervisor 会在 web 启动时 `start()`, `interrupted → recovering → resume` 的链路已接线,
  但"进程重启后真的自己续跑"这条验收属于批次 2 (2-C)。
- `retry_wait` 的到点唤醒只有状态与 `wakeAt` 落盘, **定时唤醒的端到端验收**待批次 2。
- **外部事件的真实来源** (peer/delegate 回调) 未接: `notifyExternal` + API + CLI 已通, 但真 P2P 事件端到端未验。
- **判据生成**: 新建 Goal 的 `successCriteria` 可能为空 → 完成门永远拒绝自动完成 (安全但不自动); 判据生成/更新属 2-F。
- **Web 前端 Run/Goal 面板**仍缺 (API 已就绪)。
