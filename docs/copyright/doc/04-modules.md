# 第四章 模块设计说明

## 4.1 源代码组织

软件源代码位于工程根目录 `src/` 下，按职责分为若干子目录；每个子目录内的文件名即模块名，模块之间通过显式导入建立依赖。工程另设 `scripts/`（构建与验收脚本）、`android/`、`ios/`（移动端原生外壳工程）、`docs/`（文档）等目录。本章按第一章 1.3 节的十二个模块说明其目录、职责与关键文件。

## 4.2 程序入口与命令分发模块

- 目录与文件：`src/index.ts`（命令行入口，约 4,557 行）、`src/cli-entry.ts`（独立命令行入口）、`src/types.d.ts`（全局类型声明）。
- 职责：解析启动参数（共 56 个命令行开关），决定运行形态（交互命令行、浏览器模式、桌面模式、守护模式、一次性子命令）；完成环境变量与配置装载；把控制权交给对应运行器。
- 关键设计：参数解析与业务实现分离，入口文件内不实现业务逻辑，只做编排与错误兜底；启动失败时输出可读原因并以非零状态退出。

## 4.3 启动引导与初始化模块

- 目录与文件：`src/bootstrap/`（17 个文件），包括 `bootstrap.ts`、`context-os.ts`、`context-manager.ts`、`context-collector.ts`、`context-hierarchy.ts`、`memory-compressor.ts`、`persona-loader.ts`、`project-context.ts`、`project-state.ts`、`session-window.ts`、`snip-collapse.ts`、`vector-index.ts`、`event-log.ts`、`lifecycle-hooks.ts`、`chat-archiver.ts`、`remote-mirror.ts`、`exhaust-scrubber.ts`。
- 职责：为会话装配上下文（人格、项目、会话、知识四层记忆），建立会话视窗与向量索引，压缩超限记忆，记录生命周期事件，同步远端镜像。
- 关键设计：上下文按层装配、按预算裁剪，装配结果与占用统计一并产出，便于界面显示与问题定位。

## 4.4 智能体核心引擎模块

- 目录与文件：`src/agents/`（78 个文件）。核心文件为 `pi-sdk.ts`（智能体主类与迭代循环，约 3,485 行）、`pi-sdk-tools.ts`（内置工具注册）、`pi-sdk-types.ts`（类型定义）、`pi-sdk-session-factory.ts`、`pi-sdk-session-manager.ts`。
- 工具与执行相关：`shell-tool.ts`、`shell-guard.ts`、`patch-tool.ts`、`browser-cdp.ts`、`computer-use.ts`、`user-questions.ts`、`parse-tool-call.ts`、`deny-pipeline.ts`、`permission-mode.ts`、`error-classifier.ts`。
- 任务与技能相关：`goal-store.ts`、`goal-criteria.ts`、`goal-resume.ts`、`execution-supervisor.ts`、`external-events.ts`、`skill-readiness.ts`、`skill-supervisor-link.ts`、`skills-manager.ts`、`skill-share.ts`、`skill-loader.ts`。
- 记忆与治理相关：`memory-recall.ts`、`knowledge-organizer.ts`、`loop-review.ts`、`decision-store.ts`、`judgment-protocol.ts`、`agent-registry.ts`、`agent-identity.ts`、`agent-identity-store.ts`。
- 网络与协作相关：`p2p-chat-tools.ts`、`p2p-document-tools.ts`、`agent-gateway.ts`、`gateway-join.ts`、`gateway-group.ts`、`gateway-network.ts`、`network-link.ts` 及委派执行相关文件。
- 经济与支付相关（可选）：`x402/`（微支付与验真）、`payment-gate.ts`、`payment-approval.ts`、`economic-policy.ts`。
- 职责：实现推理与行动迭代循环；注册与调度工具；管理会话生命周期；执行长期任务的运行与监督；处理外部事件唤醒。
- 关键设计：工具调用统一走「参数校验 → 权限闸门 → 执行 → 审计」四步；工具结果统一结构化，失败必带原因；副作用工具带幂等键防重复执行。

## 4.5 生态扩展协议模块

- 目录与文件：`src/pi-ecosystem/`、`src/pi-ecosystem-a2ui/`、`src/pi-ecosystem-colony/`、`src/pi-ecosystem-goals/`、`src/pi-ecosystem-judgment/`、`src/pi-ecosystem-mcp/`、`src/pi-ecosystem-subagents/`、`src/bollharness-integration/`。
- 职责：以协议方式扩展内核能力，包括目标协议、判断力协议、模型上下文协议（外部工具接入）、子智能体协议、界面协议（智能体驱动界面）与蚁群协作模式。
- 关键设计：扩展通过协议接入而不修改内核主干，新增能力以独立目录增量接入，降低对既有功能的回归风险。

## 4.6 大模型接入与上下文压缩模块

- 目录与文件：`src/llm/`（`config-store.ts`、`pi-ai.ts`、`error-lessons.ts`、`llm-judgment-client.ts`、`audio-config-store.ts`、`video-config-store.ts`、`system-prompt/`）；`src/context-compaction/`（10 个文件：`auto-compact.ts`、`budget-gate.ts`、`budget-reduce.ts`、`context-collapse.ts`、`microcompact.ts`、`pipeline.ts`、`snip.ts`、`token-estimator.ts`、`index.ts`、`types.ts`）。
- 职责：模型配置的读写与迁移、多供应商请求封装、错误经验沉淀、提示词分层注册与装配（`system-prompt/registry.ts` 与分层文档目录）、上下文压缩流水线。
- 关键设计：模型配置只认唯一权威文件，旧配置仅作迁移输入；压缩按「微压缩 → 折叠 → 摘要 → 截断」分级执行，压缩前后保留边界标记。

## 4.7 约束层与安全模块

- 目录与文件：`src/constraints/index.ts`、`src/security/`（`tool-gate.ts`、`builtin-guards.ts`、`input-scanner.ts`、`react-harness.ts`、`context-router-tool.ts`）、`src/hooks/hooks-engine.ts`（配 `hooks.example.yaml` 示例）。
- 职责：工具执行闸门与内置守卫、输入扫描、钩子引擎（在事件点执行用户自定义动作）、约束规则装配。
- 关键设计：默认拒绝、按需放行；拒绝原因结构化，便于界面解释与日志审计。

## 4.8 点对点网络与身份模块

- 目录与文件：`src/network/`（20 个文件：`p2p-direct.ts`、`agent-network.ts`、`auto-peer-discovery.ts`、`known-peers.ts`、`hybrid-messenger.ts`、`local-inbox-bus.ts`、`p2p-outbox.ts`、`p2p-secret.ts`、`did-agent-resolver.ts`、`iroh-bootstrap.ts`、`iroh-discovery.ts`、`iroh-integration.ts`、`iroh-transport.ts`、`goal-event-bridge.ts` 等）、`src/orbitdb/`（10 个文件：`ipfs-node.ts`、`cid-database.ts`、`context-store.ts`、`task-store.ts`、`trajectory-store.ts`、`kanban-store.ts`、`did-catalog.ts` 与 `did-catalog-replication.ts`、`agent-tools.ts`、`ui-cid.ts`）、`src/social/`（7 个条目：`heartbeat.ts`、`agent-heartbeat.ts`、`dunbar-tier.ts`、`global-shared-context.ts`、`channels/`、`persona/`）、`src/git-transport/`（4 个文件：`chat-repo.ts`、`chat-render.ts`、`chat-types.ts`、`chat-watch.ts`）。
- 职责：节点发现与连接、身份生成与签名、消息与文档投递、内容寻址存储、社交关系与心跳、以版本库作为消息载体的可选传输。
- 关键设计：链路多级降级（直连 → 打洞 → 中继 → 离线）；入站内容一律先验签再处理；内容以内容标识寻址，天然去重。

## 4.9 存储与运行态模块

- 目录与文件：`src/storage/`（`did-catalog.ts`、`did-catalog-bridge.ts`）、`src/setup/`（`onboard.ts`、`setup-store.ts`）、`src/cron/`（11 个文件：`index.ts`、`scheduler.ts`、`tick-lock.ts`、`jobs-store.ts`、`executions-store.ts`、`dnd.ts`、`monitor.ts`、`cron-parser.ts`、`suggestions.ts`、`suggestion-catalog.ts`、`suggestions-command.ts`）、`src/heartbeat/`（7 个文件：`DaemonManager.ts`、`HealthMonitor.ts`、`StartupVerifier.ts`、`Watchdog.ts`、`self-improve-bus.ts`、`index.ts`、`types.ts`）。
- 职责：本机数据目录与文件读写、初始化状态机与就绪判定、定时任务调度与执行记录、进程健康监视与看门狗、自我改进总线。
- 关键设计：写入原子化（临时文件加替换）；调度单实例化（取锁执行）；安静时段与主任务优先保证不打扰用户。

## 4.10 文档与知识处理模块

- 目录与文件：`src/documents/`（`reader.ts`、`store.ts`）、`src/judgeness/`（7 个文件：`protocol.ts`、`store.ts`、`rank.ts`、`reflect.ts`、`auto-add.ts`、`visibility.ts`、`types.ts`）、`src/workflows/`（`collaboration.ts`、`index.ts`）、`src/lsp/`（`lsp-manager.ts`、`lsp-tools.ts`）、`src/external-engines/`（`delegate.ts`、`delegate-handle.ts`、`discovery.ts`、`types.ts`、`index.ts`）、`src/migration/external-agent-migrator.ts`、`src/locales/`（`zh.ts`、`en.ts`）、`src/utils/`（`auto-update.ts`、`auto-evolve-policy.ts`、`clamp.ts`）。
- 职责：文档解析与存储、判断力记录与排序、协作工作流、语言服务接入、外部引擎委派、外部智能体迁移、多语言文案、通用工具函数。
- 关键设计：文档解析与业务解耦，reader 只负责抽取内容，权限与路径校验在调用侧前置完成。

## 4.11 命令行界面与桌面外壳模块

- 目录与文件：`src/cli/`（12 个文件：`ink-app.tsx`、`interface.ts`、`setup-wizard.ts`、`loading-tui.ts`、`markdown.ts`、`mention-data.ts`、`keymap.ts`、`theme.ts`、`content.ts`、`stores.ts`、`timing.ts`、`widget-host.ts`）、`src/electron/`（11 个文件：`main.ts`、`window.ts`、`server.ts`、`first-run.ts`、`tray.ts`、`menu.ts`、`ipc.ts`、`dialogs.ts`、`logger.ts`、`paths.ts`、`config.ts`），以及根目录 `src/electron.ts`、`src/electron-preload.ts`。
- 职责：终端界面的渲染与输入处理、初始化向导、桌面应用的窗口与托盘、主进程与页面通信、首次运行时的初始化。
- 关键设计：界面状态与业务状态分离；界面只调用内核对外接口；桌面外壳启动时选择空闲端口并把端口回报主进程。

## 4.12 自研运行时包模块

- 目录与文件：`src/constraint-runtime/`（独立包，含 `src/`、`dist/`、`tests/` 与自身的 `package.json` 与构建配置；登记材料只收录其 `src/` 下 90 个源文件）。
- 职责：以约束方式编排智能体工作流，提供命令图、约束求解与桥接能力；既可被主程序引用，也可独立安装使用。
- 关键设计：作为独立包发布，接口稳定，升级不影响主程序其他模块。

## 4.13 服务端与界面模块

- 目录与文件：`src/web/`（61 个条目）。服务端：`server.ts`（约 8,704 行）、`routes-tasks.ts`、`routes-judgments.ts` 等分域路由、`agent-delegate-server.ts`、`iroh-delegate-transport.ts`、`delivery-ledger.ts`、`input-validator.ts`。浏览器界面：`client.ts`（约 6,003 行）、`index.html`、`client-hearth.ts`、`client-loop-status.ts`、`i18n.ts`、`components/`、`icons/`。移动端：`mobile.html`、`mobile.js`（约 3,033 行）、`mobile-core.ts`、`mobile-data.ts`、`mobile-agent.ts`、`mobile-gateway.ts`、`mobile-p2p.ts`、`mobile-helia.ts`、`mobile-ipfs.ts`、`mobile-orbit.ts`、`mobile-social.ts`、`mobile-chain.ts`、`mobile-trade.ts`、`mobile-payments.ts`、`mobile-privacy.ts`、`mobile.css`、`sw.js`。
- 职责：对外提供本机接口（共 236 条路由声明），对内调用内核；提供浏览器与移动端界面；处理移动端与会话、网络、支付相关的数据通道。
- 关键设计：界面源文件单一（编译产物由脚本生成），避免手改产物造成前后端不一致；移动端界面与桌面端共用同一套接口语义。
