---
name: cross-border-market-research
description: 跨境商品目标市场调研 — 输入商品与目标市场, 输出结构化调研报告与来源证据
version: 1.0.0
resource: {"name":"cross-border-market-research","version":"1.0.0","inputSchema":{"type":"object","required":["product"],"properties":{"product":{"type":"string","minLength":2},"market":{"type":"string"},"budgetUsd":{"type":"number","minimum":0}}},"outputSchema":{"type":"object","required":["summary","findings"],"properties":{"summary":{"type":"string","minLength":10},"findings":{"type":"array","items":{"type":"object","required":["claim","source"]}}}},"execution":{"entrypoint":"run.mjs","requiredTools":["read_file"],"maxDurationMs":20000},"verification":{"requiredFields":["summary","findings"],"evidenceFields":["sources"]},"guarantees":["schema_valid","source_declared","content_hash_bound"],"doesNotGuarantee":["business_success","market_profit"]}
---

# 跨境商品目标市场调研

这是一个**可执行资源** (Phase 2 验收夹具): 买方买到的不是一段说明文字, 而是能真跑出结构化报告的资源。

## 契约

- 输入: `{ product, market?, budgetUsd? }`
- 输出: `{ summary, findings: [{ claim, source }], sources: [...] }`
- 执行: `run.mjs` 导出 `execute(params, ctx)`, 只声明需要 `read_file` 工具, 20s 超时
- 验真: 必填字段 `summary/findings`; 证据字段 `sources` (缺了只能算 verification_failed)

## 保证 / 不保证

- 保证: `schema_valid` · `source_declared` · `content_hash_bound`
- **不保证**: `business_success` · `market_profit` —— schema 通过 ≠ 这个市场真能赚钱
