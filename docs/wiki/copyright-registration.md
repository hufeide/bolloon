---
title: 软件著作权登记材料 (500 字主要功能 + 源程序前后各 30 页)
source: session
created: 2026-09-18
last_confirmed: 2026-09-18
schema_version: 2
audience: internal
stage: current
status: current
confidence: high
entity_type: chapter
tags: [copyright, compliance, deliverable, source-pages]
compiled_from: [copyright-registration-2026-09-18]
---

## 一句话

软著登记只要两样东西: **500 字主要功能** 与 **源程序连续前 30 页 + 连续后 30 页 (每页 ≥50 行)**; 本仓自研源程序 12.6 万行 ≈ 2,519 页 → 走 60 页方案, 材料与生成器都在 `docs/copyright/` + `scripts/gen-copyright-source.ts`。

## 登记要求 ↔ 落地

| 要求 | 落地 |
| --- | --- |
| 主要功能 500 字 | [`docs/copyright/主要功能说明.md`](../../docs/copyright/主要功能说明.md) — 正文 498 汉字 (Word 口径 ≈ 506 字), 另附申请表可抄的基本信息表 |
| 前 30 页 + 后 30 页, 每页不少于 50 行 | `docs/copyright/out/Bolloon-源程序-前30页.txt` / `后30页.txt` / `共60页.pdf` (实测 PDF 60 页, TXT 60 页 × 每页恰 50 行) |
| 前后 30 页可按功能主次自定义排序 | `scripts/gen-copyright-source.ts` 的 `TIERS` 12 档: ①入口 ②启动引导 ③智能体核心 ④生态协议 ⑤大模型层 ⑥约束/安全 ⑦P2P 网络 ⑧存储运行态 ⑨文档知识 ⑩CLI/桌面 ⑪自研运行时包 ⑫Web 服务端与交互层 |
| 不足 60 页则提交全部 | 脚本内置 `mode='all'` 分支 (源程序整体 < 3,000 行时自动改交全部并改页眉「共 N 页」) |

## 口径 (改前必须知道)

- **行数**: 按登记惯例**去空行**; 注释保留。原始 132,716 行 → 125,942 行 (438 个文件)。
- **每页 50 行**: 固定 50 行分页 (不是打印后偶然对齐); 超 100 显示列的代码行折行且续行计入行数 → 任何一页严格 ≥50 行。CJK 按 2 列计宽, 保证等宽排版不撑破。
- **收录**: `src/**` 的 `.ts/.tsx/.js/.mjs/.cjs/.css/.html`。
- **排除**: `src/test/**`、`*.test.ts(x)` (测试用例不是交付本体)、`src/bollharness/**` (第三方 vendored, 版权属 “bollharness contributors”, 混入会有权属风险)、`src/constraint-runtime/{dist,node_modules,tests}/**`、`*.bak`。
- **后 30 页落在哪**: 末档把 `src/web/mobile.js` 与 `src/web/client.ts` 显式置底 → 后段行区间 124,443..125,942 全在 `client.ts` 内 (前端主逻辑), 不是零碎文件; 前段 1..1,500 在 `src/index.ts` (程序入口)。
- **版本号**: 材料写 `V1.0` (登记惯例), 仓库代码版本 `0.4.26`; 登记版本号一经填写即固定。

## 生成 / 校验

```bash
npx tsx scripts/gen-copyright-source.ts --report          # 只统计
npx tsx scripts/gen-copyright-source.ts --write --pdf     # 出 TXT/HTML/PDF/审计报告 (需本机 Chrome)
npx tsx scripts/gen-copyright-source.ts --check           # 自检 60 页 × ≥50 行 + 页码 + 前后段不重叠
```

- 复用 `src/agents/browser-cdp.ts` 的 `resolveChromePath()` 找 Chrome, 调 headless `--print-to-pdf --no-pdf-header-footer` 出 PDF。
- 审计报告 `docs/copyright/out/source-report.json`: 收录文件 / 档位分布 / 前后段行区间 / 每页最少行数 / 排除项。
- 改软件名、版本、著作权人、每页行数 → 编辑 `docs/copyright/register.json` 后重跑 `--write --pdf`。

## 尚未闭合 (登记前必须由申请人补)

1. `register.json` 的 `copyrightOwner` 要用**身份证姓名** (现为 LICENSE 署名 `yuanjie liu`)。
2. `devCompletedDate` (现 2026-09-17) 与 `firstPublishDate` (现「待填写」) — 未发表则申请选“未发表”。
3. 源程序量/版本号与申请表其它栏位一致性 (源程序量填 125,942 行)。
4. 材料里含本仓源码副本 (`out/*.txt|html|pdf`), 提交前确认是否要随仓库公开 (当前未加 .gitignore)。

## 验证记录 (2026-09-18 真跑)

- `npx tsx scripts/gen-copyright-source.ts --write --pdf` → 收录 438 文件 / 125,942 行 / 2,519 页, 提交模式 = 前 30 + 后 30。
- `--check` → 自检 OK (60 页, 每页恰 50 行, 页码 1..60, 前后段不重叠, 前/后拆分文件各 30 页)。
- PDF 实测 `kMDItemNumberOfPages = 60` (即每页 50 行没溢出到第 61 页)。
- 字数: 正文 498 汉字 / Word 口径 ≈506 字。
- `npx tsc --noEmit` (仓库配置) exit 0; 生成器本身用 `npx tsx` 真跑通过。
