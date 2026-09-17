---
title: Bolloon 初始化协议 (Setup Protocol)
source: session (leo 2026-09-16 Onboard 计划 + Hermes 初次配置对照)
created: 2026-09-16
last_confirmed: 2026-09-16
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: chapter
tags: [setup, onboarding, first-run, setup-store, onboard, readiness, gate, fail-closed, state-machine, migration, repair, reconfigure, hermes, cli, web, electron, supervisor]
---

# Bolloon 初始化协议 (Setup Protocol)

> 状态: **Phase 1–7 已落地 (真跑 51/51); 批次 2-C.4 / 2-G.2 / 2-G.3 / 2-G.4 / 2-F / 2-H 全部完成 (真跑 30+18+30+30)**。
> 唯一状态文件: `~/.bolloon/setup-state.json` (由 `src/setup/setup-store.ts` 读写);
> 唯一执行器: `src/setup/onboard.ts` (CLI / Web / Electron 全部走它)。

## 0. 为什么要有这页

初始化此前是「向导脚本」而不是「可恢复的初始化状态机」, 由此产生真实故障:

| 故障 | 旧行为 | 后果 |
|---|---|---|
| 判定失败当成"不需要初始化" | `isFirstRun()` 的 catch **返回 false** | 读配置失败 → 直接进正常模式 |
| 启动 fail-open | 向导抛错只 `console.warn('不阻塞启动')` | 半成品配置也能进对话 ("启动成功、实际不可执行") |
| 事实来源不一致 | 状态层读 `llm-config.json` / `user.json`, 真实写入却是 `bolloon-config.json` / `identity/user.json` | 明明配好了却判"未配置" |
| 状态不可达 | 缺 key 被归类成 `provider_pending` | `credential_pending` 永远进不去 |
| 无统一入口 | CLI 有向导, Web 没有;Electron 用 flag 当事实 | 三端看到的初始化状态可能不同 |

## 1. 状态机与四条不可混淆 (Phase 1)

```
uninitialized → identity_pending → provider_pending → credential_pending
              → model_pending → connectivity_pending → runtime_pending → ready
异常: needs_repair (配置损坏/写盘失败 → 就地修, 不回退默认假装正常)
      blocked     (唯一"不能自动继续": 配置根目录不可写)
```

```
Provider 已选择 ≠ 凭证已可用       (缺 key 停在 credential_pending)
凭证存在     ≠ 模型可用             (缺模型名停在 model_pending)
模型可用     ≠ 运行时已初始化       (停在 runtime_pending)
runtime ready ≠ 长期执行 ready      (durable 另算)
```

## 2. 事实来源 (只汇总, 不新增配置库)

| 领域 | 真实文件 | 说明 |
|---|---|---|
| 身份 | `~/.bolloon/identity/user.json` | **修正**: 之前状态层读 `user.json`/`identity.json`, 与真实写入路径不一致 |
| LLM | `~/.bolloon/bolloon-config.json` | **唯一正式文件**;`llm-config.json` 只作迁移输入 (来源标 `legacy`) |
| 技能 | `~/.bolloon/skills-registry.json` | SkillsManager 健康度 (不合格数) |
| 长期执行 | `~/.bolloon/supervisor.json` + `runs/` `goals/` | 最近一次 `lastResolution` 决定 runner 是否可解析 |
| 初始化 | `~/.bolloon/setup-state.json` | 只存进度/校验/readiness; **永不存 apiKey 明文** |

路径统一: `resolveBolloonHome()` = `BOLLOON_HOME` > `$HOME/.bolloon`, **不在模块顶层缓存**;
`config-store` 也不再用加载时固定的 `CONFIG_DIR`, 且 **目录变化或文件外部改动都会让内存缓存失效** (否则 A 目录的配置会被写进 B 目录)。

## 3. readiness 四层是真实检查 (Phase 5)

```
basic   = identity + provider + credential + model + connectivity(24h 内) + runtime(真实 initMinimax/session/最小调用)
agent   = basic + PiAgentHarness + 技能健康   (skillsOk 未知 **不算通过**)
durable = agent + runs/goals 目录可写 + lease 可写 + Supervisor runner 可解析
network = P2P / Kubo (optional, 不阻塞基础对话)
```

每条 readiness 都带 **`readinessWhy`**: 缺什么、怎么修 (直接展示给用户)。

## 4. 启动硬门禁 (Phase 3)

- **CLI**: 进对话前先评估; 未就绪 → 跑 Onboard → 仍不就绪 → **非零退出**; 评估抛错也 fail-closed 退出。
  `BOLLOON_SKIP_SETUP=1` 只进诊断模式, **不绕过硬门禁**。
- **Agent**: `PiAgentSession.prompt` 在非测试环境读 30s 门禁缓存, 未 ready 直接拒绝执行并如实回话。
- **Goal**: `createGoal` 未 ready **拒绝创建长期 Goal** (生产路径, fail-closed)。
- **Web**: `POST /message` / `POST /api/supervisor/tick` 未就绪返回 503 + 结构化状态; `GET /api/setup` 给出 gate/stage/readiness/下一步。
- **Supervisor**: 未ready 只诊断 —— 不注入 runnerResolver、不建 Run、不改 Goal。
- **Electron**: 首启**事实来自 setup-state.json** (`readSetupFact()`),first-run flag 只控制"是否自动弹窗"; 未 ready 时无论 flag 都弹。

## 5. 可恢复阶段执行器 (Phase 2)

```
env → identity → provider → credential → model → connectivity → runtime → final commit
```

每一步: `load state → 显示已有输入 → 收集本次修改 → 本地校验 → 必要时真实验证 → 原子提交该阶段 → 重新评估推进`。

- 失败: 保留已完成步骤 · 不清配置 · 记 `{stage, errorClass, message}` · 给 **重试 / 修改 / 返回上一步 / 修复 / 停止** 菜单 · **不显示"配置完成"** · agent 不执行。
- `--no-test` / `skipSteps`: 跳过 = `skipped` (明确标注), **跳过 ≠ 通过**, 门禁仍不会 ready。
- 连通性用**最终保存的** provider/key/baseUrl/model 真测; 超时/401/404/限流/网络错误分别分类。
- 运行时真跑: `initMinimax()` + 建 session + 最小模型调用 (只检查 singleton **不算通过**)。

## 6. CLI / Web / Electron 统一入口 (Phase 4)

```
bolloon setup                      # 交互向导 (可中断, 下次从失败阶段继续)
bolloon setup --status             # 只读: 阶段/门禁/四层 readiness/缺什么/下一步 (未 ready 退出码 1)
bolloon setup --resume             # 从失败阶段继续
bolloon setup --repair             # 迁移旧文件 / 备份坏文件后就地修
bolloon setup --reconfigure        # 只改选中项 (默认 provider/凭证/模型; 新配置测通才切 active)
bolloon setup --test               # 重跑连通性 + 运行时

Web: GET /api/setup · POST /api/setup/{start,step,resume,test,repair,reconfigure,commit,identity,provider}
     GET /setup                    # 首启页面: 显示阶段/已完成/配置来源/最近错误/readiness/下一步; 提交单步输入
Electron: readSetupFact() / shouldShowOnboard() / maybeShowFirstRun()
```

## 7. 修复 / 重配置 / 迁移 (Phase 6)

- **迁移**: 旧 `llm-config.json` → `bolloon-config.json` (直接文件迁移, 旧文件保留; 目录里同时存在时以正式文件为准并提示 `--repair`)。
- **修复**: 正式文件损坏 → **备份成 `bolloon-config.json.corrupt-<ts>`** 后按默认重建, 并如实标注"配置被重置为默认" (不静默丢弃)。
- **重配置**: 默认保留当前可用 provider; 新 provider **测通后**才切 active; 新配置失败不破坏旧配置; key 只替换不存明文; 改完重新验证 runtime 并重算 configHash + readiness。

## 8. 验收 (Phase 7)

`scripts/verify-onboard.ts` —— **51 passed / 0 failed**, 覆盖: 全新 HOME 进 Onboard · 只完成身份即中断后从供应商继续且 **DID 不重复生成** · 缺 key 停 `credential_pending` · 错 key/网络不可达→分类 auth/network 且不进 ready · 中断写盘不留半份 · 旧 `llm-config.json` 迁移 (来源从 `legacy` 变 `canonical`, 内容一致, 旧文件保留) · **CLI 半程 → Web 续办 (同一阶段)** 且未 ready 时对话路由不执行 agent (Run 数不增) · 首启页面可访问 · **未 ready 时 `createGoal` 被拒绝且无 Run;已 ready 时可建 (正例)** · 配置损坏→`repair` 且坏文件被备份, 输入保留 · `--reconfigure` 只改 model (key/provider 不动) · 坏技能被 `readinessWhy` 指出 · **真 deepseek 跑通**: 连通性真通过 + 运行时真初始化 → `gate=ready`, 四层 readiness 与 allow 正确, 配置指纹已算, 重复评估稳定。

单测: `src/test/setup-store.test.ts` (23) + `src/test/onboard.test.ts` (8)。
门禁: `tsc --noEmit` 0 错 · 全量 vitest **170 文件 / 1900 测试全绿**。

## 9. 本批真跑抓到的真 bug (都已修 + 有断言)

1. **身份路径读错** —— 状态层读 `~/.bolloon/user.json`, 真实文件是 `identity/user.json` → 明明配好身份却判"未配置"(与配置文件名问题同源)。
2. **`credential_pending` 不可达** —— 缺 key 被归到 `provider_pending` → 阶段现在按"provider 已选 / 凭证可用 / 模型可用"分开判定。
3. **config-store 缓存跨目录串配置** —— 切换 HOME (独立宿主/测试) 后仍用旧内存配置, 会把 A 的 key 写进 B。
4. **config-store 不感知外部改动** —— repair / agent 工具 / 用户手改配置文件后进程仍用旧值 → 现在按目录 + 文件签名 (mtime/size) 失效。
5. **未选供应商时没有可读原因** —— 只写了 why, 缺 `reasons` 文案 → 现在明确"配置里没有 activeProvider"。
6. **ScriptedIO 静默回退到第一个选项** —— Web 传入未知供应商会被悄悄改成 deepseek → 改为原样返回并由阶段校验 (未知供应商明确报错)。

## 10. 尚未完成 (如实)

| 项 | 状态 |
|---|---|
| 2-C.4 真 P2P / delegate 事件唤醒 Goal | **已完成** (2026-09-16): 外部等待协议 (requestId/continuationId/expectedSource/expectedEvent/expiresAt) + 来源/correlation/过期/eventId 去重 + 真签名入站 (`AgentMessaging.dispatchSignedMessage` → goal-event-bridge) + 超时转人工; 真跑 **30/30** (`verify-goal-external-wake.ts`) |
| 2-G.2 Goal 级 skill snapshot + 执行前门禁 | **已完成**: 首次执行冻结 name/version/contentHash/resolvedAt, 缺/未启用/损坏/漂移 → 不启动 Run + needs_human, 可选技能缺失只记降级, 漂移要人工批准; 真跑 **18/18** (`verify-skill-gate.ts`) |
| 2-G.3 事务型 skill import | **已完成**: 预备校验 (名字/路径穿越/SKILL.md frontmatter/版本门) → 暂存 → 原子替换 (旧目录改名保留) → 读回校验 → registry; 失败回滚 + 原因可查 (`importHistory`); SIGKILL 中断可恢复; 真跑 **30/30** (`verify-skill-import.ts` [1]-[7]) |
| 2-G.4 skill 与 Supervisor 长期联动 | **已完成**: 导入/启用 → 被拦 Goal 自动重评回 active; 禁用/隔离 → 下一次 Run 前门禁拦 (不打断当前 Run); 漂移不隐式升级; 真跑见上 (`verify-skill-import.ts` [8][9]) |
| 2-F 判据自动生成与长期证据汇总 | **已完成**: criteriaSource/criteriaConfirmed/criteriaVersion; 用户给判据=已确认, 没给→agent 提候选 (未确认永不完成); 模糊目标交人; 证据跨 Run 汇总; 完成门 = 判据存在+已确认+全满足+有证据+无未解决项+最近 Run 健康; 真跑 **30/30** (`verify-goal-criteria.ts`) |
| 2-H Web 长期执行面板 (Goal/Run) | **已完成**: `GET /goals` 面板 (Goals/Runs/Supervisor 状态 + 确认判据/提候选/唤醒/resume/pause/abort) + `GET/POST /api/goals/:id/criteria`; 与 CLI 同一份事实; 见 `verify-goal-criteria.ts` [7] |
| Electron 打包后的 Onboard 页面路由 | 事实层已接 (`readSetupFact/shouldShowOnboard`), 打包侧调用待确认 |
