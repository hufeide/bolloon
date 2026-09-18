# 软件著作权登记材料（Bolloon 智能体软件）

本目录存放**软件著作权登记**（中国版权保护中心）所需的两项材料，以及可复跑的生成器入口。

## 一、登记要求 ↔ 材料对照

| 登记要求 | 本目录对应材料 |
| --- | --- |
| 软件的主要功能，500 字 | [`主要功能说明.md`](./主要功能说明.md)（正文汉字 498 字，Word 口径 ≈ 506 字） |
| 源程序连续前 30 页 + 连续后 30 页，每页不少于 50 行 | `out/Bolloon-源程序-前30页.txt`、`out/Bolloon-源程序-后30页.txt`、`out/Bolloon-源程序-共60页.txt` |
| 网上提交（PDF） | `out/Bolloon-源程序-共60页.pdf`（实测 **60 页**，每页 50 行，页眉「Bolloon 智能体软件 V1.0 源程序 + 第 N 页 共 60 页」） |
| 源程序整体不到 60 页 → 提交全部 | 本仓自研源程序 **125,942 行 ≈ 2,519 页**（远超 60 页），因此走「前 30 + 后 30」方案；脚本内置 `mode='all'` 分支，若换个软件规模不足会自动改提交全部 |
| 前后各 30 页可按开发时间排序，也可按功能主次自定义排序 | 采用**功能主次**排序：程序入口 → 启动引导 → 智能体核心 → 生态协议 → 大模型层 → 安全层 → P2P 网络 → 存储运行态 → 文档知识 → CLI/桌面 → 自研运行时包 → Web 服务端与交互层（末档把 `client.ts` 置底，使「后 30 页」落在前端主逻辑而非零碎文件） |

## 二、材料清单

```
docs/copyright/
├── README.md                  # 本文件
├── register.json              # 登记基础信息 (软件全称/版本/著作权人/日期/每页行数)
├── 主要功能说明.md             # 500 字主要功能 + 申请表可抄的基本信息表
└── out/                       # 生成产物 (可复跑重建)
    ├── Bolloon-源程序-前30页.txt      # 前 30 页 (页码 1..30, 页脚标注共 60 页)
    ├── Bolloon-源程序-后30页.txt      # 后 30 页 (页码 31..60)
    ├── Bolloon-源程序-共60页.txt      # 合订 (=== \f 分页)
    ├── Bolloon-源程序-共60页.html     # A4 排版源 (Chrome 打印即得 PDF)
    ├── Bolloon-源程序-共60页.pdf      # 提交用 PDF (60 页)
    └── source-report.json            # 审计报告: 收录文件/行数/档位分布/页数/前后段行区间
```

## 三、生成与自检

```bash
# 1. 只统计 (不落盘): 看看收录了多少行、前后 30 页会落在哪些文件
npx tsx scripts/gen-copyright-source.ts --report

# 2. 正式生成 TXT + HTML + 审计报告, 并出 PDF (需本机 Chrome; 可用 BOLLOON_CHROME_PATH 指定)
npx tsx scripts/gen-copyright-source.ts --write --pdf

# 3. 自检: 共 60 页 / 每页恰好 50 行 / 页码连续 / 前后段不重叠 / 拆分文件页数正确
npx tsx scripts/gen-copyright-source.ts --check
```

改软件名称、版本号、著作权人、每页行数 → 编辑 `register.json` 后重跑步骤 2（页眉与文件名会随之更新）。

## 四、口径说明（审核前请自己确认一遍）

1. **行数口径**：按登记惯例**去掉空行**；注释保留（注释也是源程序的一部分）。原始 132,716 行 → 去空行后 125,942 行。若登记机构要求更紧凑，把 `register.json` 的 `dropCommentOnlyLines` 设为 `true` 再重跑。
2. **每页 50 行**：脚本按固定 50 行分页（不是打印后偶然对齐）；超过 100 显示列的代码行会折行并把续行计入行数，因此任何一页都严格 ≥50 行。自检与 PDF 实测页数均为 60。
3. **收录范围**：`src/` 下 `.ts/.tsx/.js/.mjs/.cjs/.css/.html`。**排除**：`src/test/**`、`*.test.ts(x)`（测试用例不是交付的程序本体）、`src/bollharness/**`（第三方 vendored 框架，版权属 “bollharness contributors”，不能混进登记材料）、`src/constraint-runtime/{dist,node_modules,tests}/**`（构建产物与测试）、`*.bak`。范围与排除项都写在 `scripts/gen-copyright-source.ts` 的 `TIERS` / `EXCLUDE_*` 常量里，可审计可改。
4. **需申请人补的字段**：`register.json` 里 `copyrightOwner`（登记须用身份证姓名）、`devCompletedDate`、`firstPublishDate`；`主要功能说明.md` 的基本信息表同步改（源程序量 125,942 行 / 版本号 V1.0 与本材料一致）。
5. **版本号**：材料按登记惯例写 `V1.0`；仓库代码内版本为 `0.4.26`（`package.json`）。登记版本号一经填写即固定，后续升级版本不影响本次登记。
6. **未发表**：如尚未公开发布，申请表选“未发表”，`firstPublishDate` 留“待填写”。
