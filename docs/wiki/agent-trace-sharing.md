---
title: 智能体执行轨迹与 P2P 连接信息 (Trace / P2P Sharing)
source: session (leo 2026-09-18 「agent trace = 智能体可以执行工具执行, 操作本机」 + P2P 交换需求)
created: 2026-09-18
last_confirmed: 2026-09-18
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: chapter
tags: [trace, agent-trace, tool-execution, run-steps, trace-export, p2p-info, peer-id, multiaddr, circuit-relay, interchange, minitool, agent-card, cli, web, cross-boundary]
---

# 智能体执行轨迹与 P2P 连接信息 (trace / p2p 出口)

> 2026-09-18 落地。回答两个问题:
> ① 「这个智能体**真的**在本机干了什么」→ 工具执行轨迹;
> ② 「它怎么被别的智能体**拨通**」→ P2P 连接信息。
> 两者都收敛成**可交换的文本/JSON**,好让 App、CLI、Web 与外部工具(小红书小工具)看到同一份事实。

## 0. 事实来源(不新增存储)

| 要什么 | 真值在哪 | 谁产生 |
| --- | --- | --- |
| 工具执行轨迹 | `~/.bolloon/runs/<runId>.json` 的 `steps[]` | PiAgent 执行时逐步落盘(`n / ts / tool / argsDigest / ok / ms / summary / error`) |
| P2P 连接信息 | 运行中的 `p2pNetwork`(live) / `~/.bolloon/gateway-join.json`(persisted) | P2P 节点启动、`join_global_gateway` 入网 |
| 身份 | `~/.bolloon/identity/user.json` | Onboard / 入网 |

**不新增 trace 库**:轨迹就是 Run 的步骤,导出只是**投影**,不复制一份会漂移的事实。

## 1. 轨迹文本格式(跨边界契约)

```
# Bolloon 执行轨迹 · run <runId> (<N> 步)
# 目标: <goal 单行, ≤160 字>
# 状态: <run 状态> · goal <goalId> · surface <cli|web|...>
1. [ok] 2026-09-18T08:00:01.000Z write_file — 写入 18 字节 [args:a1b2c3d4] (12ms)
2. [fail] 2026-09-18T08:00:04.000Z shell_exec — EACCES: permission denied [args:ffeeddcc] (3ms)
# 结束原因: <有则一行>
```

硬规则(改格式前先看两侧解析器):

- 一行一步:`<n>. [ok|fail] <时间戳> <工具名> — <细节>`
- **时间戳与工具名都不能含空格**(消费方按空格切分);时间戳用 ISO 8601
- 细节里可带 `[args:<前 8 位>]`(参数摘要)与 `(<ms>ms)`(耗时)
- 解析器容错:不认识的行忽略,不猜

两侧解析器**(必须同步改)**:

- Bolloon 侧:`src/agents/trace-export.ts:parseTraceText`
- 小工具侧:`minitools/agent-card/src/assets/app.js:parseTraceText`

## 2. 轨迹 JSON(机器可读)

`bolloon-agent-trace/1`:

```json
{
  "schema": "bolloon-agent-trace/1",
  "runId": "…", "goalId": "…", "surface": "cli", "status": "done",
  "steps": [{ "n": 1, "ts": "…", "tool": "write_file", "ok": true, "ms": 12, "summary": "…", "argsDigest": "…" }],
  "counts": { "total": 2, "ok": 1, "fail": 1, "totalMs": 15 },
  "tools": [{ "tool": "write_file", "count": 1, "fail": 0 }],
  "evidence": ["…"], "error": "…"
}
```

`counts.ok + counts.fail === counts.total` 是消费方可以依赖的不变式。

## 3. P2P 连接信息(可拨入性)

`bolloon-p2p-info/1`:

```json
{
  "schema": "bolloon-p2p-info/1",
  "ok": true, "source": "live|persisted|none",
  "did": "did:key:…", "name": "…", "peerId": "12D3KooW…",
  "multiaddr": "/ip4/1.2.3.4/tcp/4001/ws/p2p/<peerId>",
  "multiaddrs": ["…"], "relayAddrs": ["…/p2p-circuit/p2p/<peerId>"],
  "isRelay": false, "relayService": null, "natStatus": null,
  "capabilities": ["chat"], "note": null,
  "cardP2p": { "peerId": "…", "multiaddr": "…", "relay": "" }
}
```

- **`cardP2p` 就是名片/小工具里 `p2p` 区块的字段形状** —— 直接粘贴可用,不需要二次转换
- 可拨入地址必须带 `/p2p/<peerId>` 段(否则对端拨不通);`ensureDialable()` 负责补
- 诚实原则:节点没跑 / 没入网 → `ok:false` + `note` 说清**原因与下一步**,**不编 peerId**,不假装"能连通"

## 4. 出口(三端)

| 形态 | 命令 / 接口 |
| --- | --- |
| 交互 CLI | `/trace`(最近几次的每步摘要) · `/trace <runId>`(完整文本,可复制) · `/trace <runId> --json` |
| CLI 子命令 | `bolloon trace [runId] [--json] [--last N]` · `bolloon p2p [--json]` |
| Web | `GET /api/trace` · `GET /api/trace/:runId?format=text|json` · `GET /api/p2p/info` |

## 5. 边界:小工具为什么不能"真执行"

小红书小工具容器硬约束(见 `.skill/minitool-zip-builder/`):

- 禁 `fetch` / XHR / WebSocket / EventSource,禁 Worker / WASM → **不能调 LLM API,跑不了 agent 循环**
- JSBridge 只有 4 个 API(`postNote` / `saveImageToPhotosAlbum` / `openRedPage` / `writeTempFile`)→ **没有文件/Shell/进程能力,操作不了本机**

因此分工固定:

```text
小工具 = 身份采集 + 名片生成 + 入口(存相册/发笔记/跳 App 页) + 轨迹展示与交换
App / PC 侧智能体 = 真执行工具、操作本机、产生轨迹
```

轨迹和小工具之间是**文本/JSON 交换**(复制粘贴、笔记正文、二维码),不是网络调用。

## 6. 验收与已知缺口

- 验收:`scripts/verify-agent-trace.ts`(真 LLM agent 在本机真执行工具 → 真 Run → 导出 → **用小工具侧解析规则回读** → 真 HTTP 取回) · 单测 `src/test/trace-export.test.ts`
- 未做:手机端 App 内直接展示/导出轨迹(目前手机端有自己的 `.agent-trace` 渲染,但**不产出这份可交换格式**);轨迹去敏感(参数摘要目前是 hash,原文不入轨迹);`/api/trace` 未做分页
