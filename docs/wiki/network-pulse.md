---
title: 网络脉冲 (Network Pulse) — 匿名可验证的公开观察投影
source: session (leo 2026-09-18 计划 + 真实实现与真跑结论)
created: 2026-09-21
last_confirmed: 2026-09-21
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: chapter
tags: [network-pulse, public-projection, privacy, gateway, bolloon-ui, observed, verified, stale]
---

# 网络脉冲 (Network Pulse) — 2026-09-21

> **一句话**:把已有 P2P 生命周期投影成**匿名、可验证、可降级**的公开统计,
> 供 bolloon-UI 网关页动态展示; 单节点看到的数据**不许说成全网精确总量**。

借鉴点来自 EigenFlux(只借产品与工程思想: 时间窗统计 · 服务端生成匿名活动文本 · `live/stale/unavailable` ·
短缓存与时间边界 · 隐私阈值 · 前端轮询/超时/退避 · 白名单投影),**不借**其 Go/Postgres/API/身份体系,
也不把 Bolloon 变成它的客户端。

## 1. 事件模型 (只记公开统计)

`src/agents/network-pulse.ts`

```ts
type NetworkEventType = 'node_joined' | 'manifest_published' | 'capability_announced'
                      | 'peer_connected' | 'delegation_completed';   // 白名单, 其它一律拒

interface NetworkPulseEvent {
  type: NetworkEventType;
  bucket: string;              // epoch 小时
  capabilityGroup?: string;    // **粗类别** (原始能力名不落盘)
  occurredAt: number;
  sourceProof: string;         // sha256('bolloon-pulse|'+DID) 前 16 位 —— 不可逆
  agentProof?: string;         // sha256(node:agentId) 前 16 位
  signed?: boolean;            // 决定 scope 能否升到 verified
  integrity?: string;          // 本地完整性标记
}
```

挂点(fire-and-forget, **统计失败绝不影响主路径**):

| 生命周期 | 位置 | 记什么 |
| --- | --- | --- |
| 本机发布/更新 manifest | `agent-manifest-protocol.ts:setLocalManifest` | `manifest_published` + 每个 capability 一条 `capability_announced`(signed) |
| 收到远端 manifest | `agent-manifest-protocol.ts:cacheRemoteManifest` | `peer_connected` + 对方 capability |
| 入网成功 | `gateway-network.ts:joinNetwork` | `node_joined`(signed) |
| 委派成功 | `agent-gateway.ts:gatewayCallAgent` | `delegation_completed`(失败不进公开统计) |

## 2. 快照 (对外唯一的投影)

```json
{ "status": "live", "generated_at": 0, "fresh_until": 0,
  "scope": "observed", "scope_label": { "zh": "当前节点观察到", "en": "Observed by this node" },
  "totals": { "nodes": 0, "agents": 0, "active_agents": 0, "seen_last_24h": 0 },
  "capabilities": [ { "key": "research", "count": 3 } ],
  "recent_activity": [ { "kind": "node_joined", "at": 0, "text": { "zh": "有新节点加入网络", "en": "A node joined the network" } } ],
  "notes": [ "单节点观察: 这是本节点能看到的部分网络, 不是全网精确总量" ] }
```

硬规则(全部有断言):

- **去重**: 同节点同小时重复 `node_joined` 只记一次(不虚增节点数); capability 计数 = **不同 Agent 数**(同一 Agent 重复声明不虚增)。
- **隐私阈值** `privacyThreshold=3`: 少于 3 个 Agent 的类别**不单独暴露**, 合并进 `other`。小网络的正确表现就是"只有一个 other"。
- **上限**: 事件 5000 条 / 窗口 24h / 桶 1h / capability 最多 12 类 / 活动流最多 8 条; 超出丢最旧。
- **匿名**: 原始 DID、能力名、peerId、IP、钱包、任务正文**都不落盘、不出网**(事件文件里连 `did:key` 子串都没有)。
- **状态**: 新鲜期(30s)内 `live`; 过期 `stale`(**不伪装实时**); 观察层不可用 `unavailable`, 并明确写"这**不是**网络为空"。
- **scope 可信边界**: 单来源 → `observed`; **≥2 个签名来源** → `verified`(文案 `Verified network snapshot`)。两种都不等于"全网精确总量"。
- **malformed 安全**: 坏 events.json / 空数组里的 null / 缺字段的垃圾对象一律丢弃, 快照返回全 0 而不是崩。

## 3. 公开只读接口

```text
GET /api/public/network/progress
```

- **无认证**; `Cache-Control: public, max-age=15, stale-while-revalidate=15`; 带 `ETag`, 支持 `If-None-Match` → **304**。
- 空网络安全返回(全 0 且 `live`); 观察层不可用 → `unavailable`。
- **不暴露** Registry 原始数据; 本地接口(`/api/agent/*`、`/api/gateway/*`)保持原样, 继续只服务本地 Agent 与节点控制, **不给网站用**。

## 4. 真跑证据 (2026-09-21)

- 单测 `src/test/network-pulse.test.ts` → **17/17**(白名单 · 去重 · 时间窗 · 隐私阈值 · 私有字段清理 · live/stale/unavailable · 空网络 · malformed · canonicalize · 活动文本模板)。
- 双节点集成 `scripts/verify-network-pulse.ts` → **36 passed / 0 failed / EXIT=0**:
  ① A 发布 manifest → B 缓存 → 观察层看到 2 节点 2 Agent · 原始 DID 与原始能力名**都没落盘**;
  ② 小网络类别全进 `other`; 达阈值后 `research` 计数 = 4 个不同 Agent, 重复声明不虚增;
  ③ 缓存命中 / `stale` / `unavailable` 三态;
  ④ 坏数据不崩;
  ⑤ 真 HTTP: 无凭据 200 · Cache-Control · ETag · **304** · 响应无私有字段 · 本地接口仍在;
  ⑥ 前端消费契约(字段齐全 · 双语 scope_label · 无任务正文字段)。

## 5. 前端 (bolloon-UI 网关页)

网关页新增「全球网络脉冲 / Network pulse」区: 三到四个大数值 · capability 分布 · 匿名活动流 · 快照时间 ·
`live/stale/unavailable` 标签 · `Observed` / `Verified snapshot` 范围说明 · notes 里那句"不是全网精确总量"可见。

取数策略(诚实优先, **绝不编造数字**): ① `?pulse=<url>` 显式指定节点 → ② 同源 `network-pulse.json` 静态签名快照(过期就显示 `stale`)→ ③ 都拿不到 → `unavailable` + 说明如何用 `?pulse=` 指向本机节点。

前端行为: 首屏 loading · 成功 live · 快照过期 stale · 失败 unavailable · 30s 轮询 · 请求超时(AbortController)·
失败指数退避 · **任何失败不得影响页面其它区域** · 活动文本只用 `textContent`(禁 innerHTML) · 双语走 `data-zh/data-en` ·
相对时间只改文字节点 · 尊重 `prefers-reduced-motion` · `aria-live="polite"` · 移动端纵向堆叠。

## 6. 本批未做 (如实)

- 真正的**全球**公共观察入口(需要长期在线的观察者节点/Explorer); v1 只做"节点本地观察 + 可指定端点 + 静态签名快照"。
- 链上强绑定 · 世界地图 · Agent 头像/主页 · 公开 DID 列表 · 任务内容流 · WebSocket/SSE。
