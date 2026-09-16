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

Goal (尚未落成独立文件, 见 §5 待办):

```
Goal { goalId, objective, successCriteria[], constraints[], budget, status, currentRunId }
```

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

| errorClass | 默认动作 | 现有实现 |
|---|---|---|
| `transient` (网络/429/5xx) | 指数退避重试 | pi-ai 内置重试; run 只记录 |
| `auth` (401/403) | **不重试**, 交人 | 已按哨兵终止; 但还没进 `needs_human` ← 待办 |
| `bad_args` | 修正参数重试一次 | react-loop 有连续失败计数 |
| `no_such_tool` | 换工具/重规划 | `decideNext` unknown tool → continue |
| `policy_denied` | 不重试走策略分支 | deny-pipeline / pre-tool-validator |
| `external_no_reply` | 标 `awaiting_external` | 委派端 504 已有; 状态未落 ← 待办 |
| `unparsable` | 重提示一次再暂停 | 已有 sentinel/reflection |
| `repeat_failure` | 熔断 → `needs_human` | `MAX_SAME_TOOL_FAILURES=3` 已有; 未落 run 状态 |
| `crash` | 从最近 checkpoint 恢复 | 启动对账 `reconcileOrphans()` 已有; 自动 resume ← 待办 |
| `corrupt_state` | 用最后有效 checkpoint + 记修复 | 原子写 (`tmp + rename`) 已有; 损坏回退 ← 待办 |

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
| A | 并发写入不覆盖步骤 | ⚠️ 同 run 并发写未加锁 (单写者假设) |
| A | 文件损坏 → 回退最后有效状态 | ❌ 待做 (原子写已降低概率) |
| B 恢复 | 网络错误最终恢复 | ⚠️ pi-ai 重试已有; run 未记 recovery |
| B | 参数错误能纠正 | ⚠️ loop 有计数; 未落 recovery |
| B | 非幂等工具不重复执行 | ❌ 待做 (checkpoint 已有, 无重放守卫) |
| B | 连续失败熔断 | ⚠️ `MAX_SAME_TOOL_FAILURES` 已有; 未落 `needs_human` |
| B | 外部等待不误判失败 | ❌ 待做 (`awaiting_external` 未接线) |
| B | 恢复失败 → `needs_human` | ⚠️ 状态机已有, 未接线 |
| C 目标持续 | 重启后 Goal 仍在 | ⚠️ Goal 有存储, 未绑 run |
| C | 从 checkpoint 继续 (不从头) | ❌ `resumeRun` 待做 |
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

**实测 (2026-09-16 两次复跑): `31 passed / 0 failed`。**

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
| **1 收敛成唯一权威入口 `PiAgentHarness`** | ❌ 0% | 六处约束层仍在 (`react-harness` / `deny-pipeline` / `pre-tool-validator` / `hooks-engine` / `tool-gate` / `loop-review`); pi-sdk 里只 fire 了 `onLoopStart` 一个 hook; 没有 before/after_model_call、before/after_tool_call 的统一适配层; **run-store 仍是「附加层」** —— 所有调用被 `try/catch + console.warn` 包着, 正是 leo 说的那个根因本身 |
| **2 Goal → Run → Checkpoint** | ⚠️ 40% | 每步自动写 checkpoint ✅; `Run.goal` 文本 ✅; **但 `goalId` 从未被赋值** (pi-sdk `startRun` 不传, Goal 仍只在 `goal-resume.ts` 里); 没有 `resumeRun`, 「从 checkpoint 继续」尚未实现 |
| **3 错误恢复闭环** | ⚠️ 20% | `classifyError` + `errorClass` 落盘 ✅; `RecoveryAttempt` 结构 + `recordRecovery` ✅ **但运行时不调用它** (只有验收脚本调); `repeatedFailureCount` 定义了却未接进循环 → 无熔断; `recovering` / `paused` / `awaiting_external` 三个状态**运行时永远不会被写入** (只在状态机表里存在) |
| **4 持续目标 + 进度证明** | ⚠️ 10% | `evidence[]` 字段有, 但 pi-sdk 收尾 `finishRun` **不传 evidence** → `done` 无证据也照样绿; 无 success criteria 定义与校验; 无目标漂移检测; `loop-review` 是既有的按轮 review, 不是 run 级三检查 |
| **5 Web / CLI 只做视图** | ⚠️ 35% | `GET /api/runs` ✅ + CLI `/runs`、`/runs <id>` ✅ (同一 store); **Web 前端零接入** (`client.ts` 未动, 无目标卡片/checkpoint/恢复记录); `/resume` `/pause` `/approve` `/goals` 全无; 手机端未接 |
| **6 可靠性门禁** | ⚠️ 30% | A 组 3.5/5 (并发同 run 写无锁 · 文件损坏回退未做); B 组 1/6; C 组 2/5; D 组 3/5 —— 逐条状态见 §6 |

**推荐实施顺序的 10 步实际走到哪**: ① 协议 ✅ · ② 盘点 ⚠️ (表有了, 代码职责未冻结) · ③ 选定 pi 生命周期为唯一入口 ❌ · ④ run-store 改造为权威 Run Controller ⚠️ 部分 (落盘/对账/巡检/预算在, 但无 resume/pause/approve, 且是旁路) · ⑤ 合并 Policy Engine ❌ · ⑥ checkpoint + 恢复状态机 ⚠️ (结构齐, 未接线) · ⑦ Goal 绑 Run ❌ · ⑧ Web/CLI 统一 API ⚠️ (只读 + CLI) · ⑨ 崩溃/错误恢复验收 ⚠️ (A 组过, B 组没做) · ⑩ 性能/UI ❌ (按计划本就最后做)。

**一句话**: 协议层 (Phase 0) 完成, 执行层没动 —— 现在拿到的是「跑得动、看得见、死了不留幽灵」的**可观测持久层**, 还不是「Goal 持续 + 可恢复 + 有证据」的**运行时**。**下一步第一刀应该是 fail-open 收口** (Phase 1 的纪律要求): 持久化层写失败必须影响运行决策, 而不是 warn 后继续跑。
