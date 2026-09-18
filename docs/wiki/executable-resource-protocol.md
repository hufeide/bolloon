---
title: 可执行资源协议 (Executable Resource Protocol)
source: session (leo 2026-09-18 交易闭环完成批次 Phase 2)
created: 2026-09-18
last_confirmed: 2026-09-18
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: chapter
tags: [x402, executable-resource, skill-contract, inputSchema, outputSchema, entrypoint, requiredTools, verification, guarantees, install-fidelity, drift, harness, goal-linkage, phase-2]
---

# 可执行资源协议 (Phase 2, 2026-09-18)

> 一句话: **买到的不该是一段说明文字, 而是一个能真跑、且能验证它真跑对了的资源**。
> 代码: `src/agents/x402/resource-contract.ts` · 夹具资源: `scripts/fixtures/skills/cross-border-market-research/`
> 验收: `scripts/verify-executable-skill-transaction.ts` (51/51) · 单测: `src/test/resource-contract.test.ts` (15)。

## 1. 资源契约 (写在 SKILL.md frontmatter)

```yaml
resource:
  name: cross-border-market-research
  version: 1.0.0
  inputSchema:  {...}     # 买方必须满足的输入形状
  outputSchema: {...}     # 卖方承诺的输出形状
  execution: { entrypoint: run.mjs, requiredTools: [read_file], maxDurationMs: 20000 }
  verification: { requiredFields: [summary, findings], evidenceFields: [sources] }
  guarantees: [schema_valid, source_declared, content_hash_bound]
  doesNotGuarantee: [business_success, market_profit]
```

**硬规则**: 声明了 `guarantees` 就**必须**声明 `doesNotGuarantee` —— 不许把"能跑"吹成"能赚"
(契约解析层直接拒绝, 真跑有断言)。

## 2. 买到 → 能执行 的检查链 (三段, 缺一段就不成立)

```text
① 内容保真: sha256(手里这份 content) == 交易记录 contentHash        → 就是当时交付的那份
② 安装保真: 包内文件集哈希 == 落盘技能目录哈希 (同一算法)           → 装的时候没丢没加
③ 绑定: 交易 itemId / providerDid / 版本 == 预期 + 快照存在         → 买的是这个卖方的这一版
```

- ①②由 `verifyInstallFidelity()` 做, ③由 `verifyResourceAgainstTransaction()` 做
- **不许混口径**: 交易里的 `contentHash` 是**协议哈希** (`sha256:<hex>` of content),
  `snapshot.contentHash` 是**技能目录哈希** (`hashSkillDir`: 相对路径 + `\0` + 文件内容 sha256, 取 32 hex)。
  两者是不同对象, 直接比大小就是错的 —— 真跑抓到过这个错。
- 遍历顺序必须一致: `hashBundleFiles()` 用 `dfsOrder()` 复刻 `hashSkillDir` 的**每层 `localeCompare` 排序 DFS**
  (默认 `sort()` 对 `SKILL.md` vs `run.mjs` 给出相反顺序 → 同内容算出不同哈希, 真跑抓到过)
- 漂移检查 `checkResourceDrift()`: 执行前比对快照与当前目录哈希; 改一个字节就拒绝执行

## 3. 执行 (Harness 约束, 不静默降级)

| 情况 | 行为 |
| --- | --- |
| 输入不合 `inputSchema` | **不执行、不付款** (协议层拒绝, 不是"执行后报错") |
| `requiredTools` 超出宿主允许清单 | 拒绝执行 (缺哪个工具说清哪个) |
| 未显式同意执行下载来的代码 (`allowCodeExecution=false`) | 拒绝执行 |
| `entrypoint` 越出技能目录 | 拒绝加载 (路径穿越) |
| 入口不存在 / 没导出 `execute` | 拒绝, 如实报错 |
| 超时 (`maxDurationMs`) | 判定失败 (不留"可能跑完了"的模糊态) |
| 输出不合 `outputSchema` / 缺必填 | `schemaOk=false` → 交易**不能** `verified` |
| 缺 `evidenceFields` (来源) | `sourceDeclared=false` → 只能 `verification_failed` |

执行证据 (`execution`) 写进交易记录: `{ok, tool, startedAt, durationMs, outputHash, schemaOk, sourceDeclared, reason}` ——
可审计、可回放, 且**参数原文不入证据**(只留哈希)。

## 4. 与 Goal / 交易状态的联动

```text
交易 verified (链上结算 + 协议验真 + 正文在 + 回执绑定 + 结算事实)
  ∧ 资源执行成功 (ok ∧ schemaOk)
  ∧ 命中 Goal 判据
  → 才计入 Goal 成功证据
```

- 只付款成功 / 只拿到内容 / 只执行成功 (没改善 Goal) → **都不算** Goal 成功证据 (但都会留审计痕迹, 不静默)
- Run 侧: 交易证据行带 `settlementFact` + `responsibility` + `executionOk/schemaOk`
- local-dev 买的技能**可测试执行**, 但 `chainSettled=false` → 永远到不了 `verified`

## 5. 验收 (真跑 51/51)

`scripts/verify-executable-skill-transaction.ts` 覆盖 leo 的 must-verify 清单:

| 项 | 断言 |
| --- | --- |
| 技能购买后进入技能目录 | 技能包解包 → SKILL.md + run.mjs 真落盘 |
| 版本与 contentHash 与交易一致 | 内容保真 + 安装保真两条链都过; 偷改文件 → 链断 |
| 漂移后不能执行 | 改一个字节 → `checkResourceDrift` 拒绝 |
| 输入不合 schema 不付款不执行 | 校验拦 + 执行器拒绝 + 花钱计数不变 |
| 输出不合 schema 不能 verified | 门返回不通过 + 交易如实记 `verification_failed` |
| 缺来源证据只能 verification_failed | `sourceDeclared=false` → 门不通过 |
| 执行失败不算资源可用 | 抛错如实上报 → 门不通过 |
| 买到但没改善 Goal 不计成功证据 | 桥接 `goalEvidenceWritten=false` |
| local-dev 不能产生最终 verified | 执行成功 + 命中判据 → 仍缺 `chainSettled` |

## 6. 未做 / 边界 (如实)

- **沙箱不是本层提供的**: 执行的是卖方交付的代码, 本层只做"入口路径校验 + 工具允许清单 + 超时 + 显式同意"。
  真要跑不信任的资源需要 OS 级沙箱 (容器/seatbelt), 这一条**还没做**, 写在这里不装作有。
- 只支持 JS 模块入口 (`entrypoint` → `execute(params, ctx)`); 其它语言/声明式资源 (`execution.kind='declared'`) 会明确报"不能在这里真跑"。
- 契约只支持 JSON Schema 的**受限子集** (type/required/properties/items/enum/minimum/maximum/minLength/maxLength/pattern);
  不支持 `oneOf` / `$ref` / `additionalProperties`。
- 里程碑结算 (partially_settled 与资源分期交付的绑定) 属 Phase 4, 未做。
