---
title: Bolloon 初始化协议 (Setup Protocol)
source: session (leo 2026-09-16 指令 + Hermes 初次配置对照)
created: 2026-09-16
last_confirmed: 2026-09-16
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: chapter
tags: [setup, onboarding, first-run, setup-store, readiness, gate, fail-closed, state-machine, hermes, cli, web, supervisor]
---

# Bolloon 初始化协议 (Setup Protocol)

> 状态: **M0 协议冻结 + M1 SetupStore 已落地 / M2–M6 待做** (2026-09-16)
> 事实来源: `~/.bolloon/setup-state.json`(本页定义的唯一初始化状态), 由 `src/setup/setup-store.ts` 读写。

## 0. 为什么要有这页

Bolloon 的初始化此前是「向导脚本」而不是「可恢复的初始化状态机」, 由此产生三个真实故障:

| 故障 | 旧行为 | 后果 |
|---|---|---|
| 判定失败当成"不需要初始化" | `isFirstRun()` 的 catch **返回 false** | 读配置失败 → 直接进正常模式, 半成品配置被当成"已配置" |
| 启动 fail-open | 向导抛错只 `console.warn('不阻塞启动')` | 初始化没完成也能进对话, 用户看到「启动成功、实际不可执行」 |
| 无统一 readiness | 身份/LLM/模型/运行时/技能各由不同模块判断, 没有"ready 事实" | Web 没有首启流程; 没有一处能回答"初始化到哪一步、为什么停" |

**这一页的目标**: 让 Bolloon 任何时候都能回答 —— *现在初始化到哪一步、为什么停、下一步是什么、重启后从哪里继续*。

## 1. 状态机 (M0 冻结)

```
uninitialized
  → identity_pending        (身份: 姓名/DID)
  → provider_pending        (模型供应商)
  → credential_pending      (供应商密钥)
  → model_pending           (模型名)
  → connectivity_pending    (连通性实测)
  → runtime_pending         (运行时: LLM 层初始化)
  → ready
异常:
  needs_repair   配置损坏/写盘失败 → 就地修, **不回退成默认配置假装正常**
  blocked        唯一"不能自动继续"的情形: 配置根目录不可写
```

**阶段单调推进**: 任一时刻停在「第一个未满足的阶段」, 不做跳跃。
「缺供应商/缺密钥/模型没测过」都是**可修**的 → 结论是 `setup`(继续向导), 不是 `blocked`。

## 2. 唯一事实与分层 readiness

`SetupStore` **只汇总, 不新增重复配置库**:

| 领域事实 | 仍然在这些地方 | SetupStore 只做 |
|---|---|---|
| 身份 | `~/.bolloon/user.json` / `identity.json` | 读 + 校验存在 |
| LLM/密钥/模型 | `~/.bolloon/llm-config.json` | 读结构 + **只判"有没有 key", 不读密钥值** |
| 技能 | `~/.bolloon/skills-registry.json` (SkillsManager) | 健康度汇总 (不合格数) |
| 长期执行 | `~/.bolloon/supervisor.json` + Goal/Run store | 是否可解析执行器 |
| 初始化 | `~/.bolloon/setup-state.json` | 阶段/已完成/输入/错误分类/可恢复动作/门禁 |

**readiness 分层** (不允许被"普通聊天能跑"掩盖):

```
basicReady     身份 + LLM + session 可用        → 能对话
agentReady     basicReady + Harness/Skills 可用  → agent 能力完整
durableReady   basicReady (+ RunStore/GoalStore/Supervisor) → 长期执行
networkReady   P2P / Kubo (可选, 不阻塞基础对话)
```

## 3. 启动硬门禁 (M4)

```
加载 SetupStore → validate
  ├─ ready   → 启动运行时
  ├─ setup   → 先初始化 (向导/续办)
  ├─ repair  → 就地修复 (不重置身份/不清 key)
  └─ blocked → 只允许诊断与修复
```

行为规则:

- **ready 之前不能执行 Agent**。CLI 进入前先评估: 未就绪 → 跑向导 → 仍不就绪则**非零退出**(不再"warn 后继续")。
- Web 可以启动, 但 agent 执行路由 (`POST /message`、`/api/supervisor/tick` 等) 返回 **503 + 结构化初始化状态**; `GET /api/setup` 给出 gate/stage/readiness/下一步。
- Supervisor 未 ready **只诊断**: 不注入 runnerResolver, 不建 Run, 不改 Goal 状态 (与 §15 的"解析不到执行器只诊断"同一原则)。
- `BOLLOON_SKIP_SETUP=1` **只进诊断模式**, 不绕过执行门禁。
- 初始化失败必须**非零退出**, 并留下结构化错误 (`lastError.stage/errorClass/message`)。

**fail-closed 三处**: 首次运行判定失败 → 需要初始化; 初始化评估自身抛错 → 进门前置检查失败; 门禁缓存读不到 → `blocked`。
（Agent 侧另有一道生产门禁: `PiAgentSession.prompt` 在非测试环境下会读门禁缓存, 未 ready 直接拒绝执行并如实回话。）

## 4. 路径统一 (M1)

- `resolveBolloonHome()` 是**唯一**路径解析: `BOLLOON_HOME` > `$HOME/.bolloon`。
- **禁止在模块顶层永久缓存 HOME**(`config-store` 原先 `const CONFIG_DIR = ...` 在加载时固定,
  长期运行/测试注入/独立 Supervisor 宿主都会拿到过期路径 —— 已改为惰性解析)。
- 优先级必须可解释并写进诊断: env > 文件 > 默认。

## 5. 可恢复事务向导 (M2, 待做)

向导不再"边问边写": 输入 → draft → 校验 → 真实测试 → 初始化运行时 → **全部成功才一次性提交**。
任何阶段失败: 保留已完成阶段、不覆盖可用配置、记明确分类 (`config/auth/network/timeout/io/model/runtime`)、下次从失败阶段继续、**禁止显示"配置完成"**。

特殊处理 (照抄 Hermes 的经验):

- 身份已生成但模型失败 → 下次**复用 DID**, 不重新生成。
- key 已存在但测试失败 → 标 `connectivity_pending`, **不清空 key**。
- provider 切换失败 → 保留旧 active provider。
- 连通性超时 → 可重试, 但**不能当作成功**。
- 写盘失败 → **不更新 ready 状态**。

Hermes 对照 (`/Users/apple/Downloads/hermes`): `hermes_cli/setup.py` 的分段 step + **回退重放**(左箭头回到上一步并重放已选值)、
`--reconfigure` **只补缺失项**、`hermes_cli/setup_summary.py` 的分层 readiness 摘要(逐能力行 + managed/provider 区分)。

## 6. CLI / Web 统一入口 (M3, 部分已通)

```
bolloon setup              # 交互向导 (可续办)
bolloon setup --status     # 结构化状态 + 下一步
bolloon setup --resume     # 从失败阶段继续
bolloon setup --repair     # 只修坏掉的部分 (不重置身份)
bolloon setup --reset      # 显式重置 (需二次确认)
Web: GET /api/setup        # 与 CLI 同一份事实
     POST /api/setup/{identity,provider,test,commit,resume,repair}
```

**验收 (M6)**: 全新 HOME 进入初始化页 · 只填身份后杀进程重启从 Provider 继续 · key 错误停在 connectivity 不进 ready ·
超时可重试 · 保存中 SIGKILL 不留半份配置 · 旧版 llm-config 迁移后状态一致 · env/文件优先级可解释 ·
CLI 完成一半 Web 接着做(反之亦然) · LLM 不可用时不建空 Run · 未 ready 时 Supervisor 只诊断 ·
已配置再跑 setup 只进修复模式不重置身份 · 配置损坏进 `needs_repair` 不假装正常 · Supervisor 重启读同一初始化事实。

## 7. 当前实现清单

| 项 | 位置 | 状态 |
|---|---|---|
| 状态机 + 落盘 (原子写) | `src/setup/setup-store.ts` | ✅ M0/M1 |
| 分层 readiness + 门禁 (ready/setup/repair/blocked) | 同上 | ✅ |
| 路径统一 `resolveBolloonHome()` | 同上 + `src/llm/config-store.ts` 惰性化 | ✅ |
| `isFirstRun()` fail-closed | `src/cli/setup-wizard.ts` | ✅ (P0) |
| CLI 启动硬门禁 + 非零退出 | `src/index.ts` | ✅ (P0/M4) |
| Web `GET /api/setup` + 执行路由 503 门禁 | `src/web/server.ts` | ✅ (M4 部分) |
| Supervisor 未 ready 只诊断 | `src/web/server.ts` | ✅ |
| Agent 侧门禁 (非测试环境) | `src/agents/pi-sdk.ts` | ✅ |
| 可恢复事务向导 (draft/commit) | — | ⏳ M2 |
| `bolloon setup --status/--resume/--repair/--reset` | 仅 `--status` 待接 | ⏳ M3 |
| Web 首启 Setup 页 | — | ⏳ M3 |
| Skills/Supervisor readiness 接入启动检查 | `readiness.agent/durable` 已汇总 | 🔶 M5 部分 |
