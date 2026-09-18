/**
 * gen-copyright-source.ts — 软件著作权登记「源程序」材料生成器 (前 30 页 + 后 30 页)
 *
 * 登记要求 (中国版权保护中心):
 *   ① 提交源程序**连续的前 30 页**和**连续的后 30 页**, 每页不少于 50 行;
 *   ② 前后各 30 页可按开发时间排序, 也可按功能主次等自定义排序;
 *   ③ 若源程序整体不到 60 页, 应提交全部源程序。
 * 本仓 src/ 下自研源码约 13 万行 (≈2600 页) → 走「前 30 + 后 30 = 60 页」方案。
 *
 * 本脚本做四件事:
 *   ① 按「功能主次」自定义排序收集自研源码 (程序入口 → 智能体核心 → 网络 → 交互层);
 *   ② 规范化行 (去空行 / Tab 展平 / 超宽行折行) 并按每页固定行数分页;
 *   ③ 生成 前 30 页 / 后 30 页 / 共 60 页 的 TXT (含 \f 分页) 与可直接打印的 HTML;
 *   ④ 可选: 调本机 Chrome 出 PDF (复用 src/agents/browser-cdp.ts 的 resolveChromePath)。
 *
 * 用法:
 *   npx tsx scripts/gen-copyright-source.ts --report          # 只打印统计, 不落盘
 *   npx tsx scripts/gen-copyright-source.ts --write           # 写 docs/copyright/out/*
 *   npx tsx scripts/gen-copyright-source.ts --write --pdf     # 再出 PDF (需本机 Chrome)
 *   npx tsx scripts/gen-copyright-source.ts --check           # 校验已生成材料 (60 页 × ≥50 行)
 *
 * 排序与取舍的边界 (可审计, 不藏):
 *   · 收录: src/ 下 .ts/.tsx/.js/.mjs/.cjs/.css/.html (自研代码与界面源);
 *   · 排除: src/test/** 与 *.test.ts(x) (测试用例不是交付的程序本体);
 *           src/bollharness/** (第三方 vendored 框架, 版权属 "bollharness contributors", 不混入登记材料);
 *           src/constraint-runtime/{dist,node_modules,tests}/** (构建产物与测试); *.bak 等编辑器残留。
 *   · 注释保留 (注释也是源程序的一部分), 只去空行; 需要更紧凑可把 register.json 的
 *     dropCommentOnlyLines 改成 true。
 *   · 排序 (功能主次 TIERS) 与排除清单都在 scripts/lib/copyright-source-scope.ts 单点定义 ——
 *     文档材料 (scripts/gen-copyright-doc.ts) 的模块清单附录读同一份事实, 避免两处口径漂移。
 *   · 分页/折行/页眉/PDF 走 scripts/lib/copyright-common.ts (与文档材料共用)。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Page as PageOf,
  type RegisterConfig,
  ROOT,
  buildPages,
  loadRegisterConfig,
  pageHeader,
  printPdf,
  toHtml,
  toTxt,
  wrapLine
} from './lib/copyright-common.js';
import { EXCLUDE_PREFIXES, EXCLUDE_SUFFIX, TIERS, collectSourceStats } from './lib/copyright-source-scope.js';

const OUT_DIR = join(ROOT, 'docs', 'copyright', 'out');

// ---------------------------------------------------------------------------
// 行规范化 (去空行 / Tab 展平 / 超宽行折行)
// ---------------------------------------------------------------------------

interface Row {
  text: string;
  /** 该行所属源文件 (相对仓库根) */
  path: string;
  /** 该行在源文件中的原始行号; 折行续行记 0 */
  line: number;
}
/** 纯注释行 / 纯括号行 (可选剔除; 默认保留, 因为注释也是源程序的一部分) */
const COMMENT_ONLY = /^\s*(\/\/|\/\*|\*|\*\/|#|<!--|-->|\{|\}|\)|\)\s*;?)\s*$/;

interface FileStat {
  path: string;
  tier: string;
  /** 去掉空行后的有效行数 */
  rows: number;
}

function buildRows(files: Array<{ tier: string; path: string }>, cfg: RegisterConfig): { rows: Row[]; perFile: FileStat[] } {
  const rows: Row[] = [];
  const perFile: FileStat[] = [];

  for (const file of files) {
    const text = readFileSync(join(ROOT, file.path), 'utf8').replace(/^\uFEFF/, '');
    const kept: Array<{ text: string; line: number }> = [];
    text.split(/\r\n|\r|\n/).forEach((raw, idx) => {
      const line = raw.replace(/\t/g, '    ').replace(/\s+$/, '');
      if (!line.trim()) return;                                  // 去空行: 登记材料按行计数, 空行不占地
      if (cfg.dropCommentOnlyLines && COMMENT_ONLY.test(line)) return;
      kept.push({ text: line, line: idx + 1 });
    });
    if (kept.length === 0) continue;

    if (cfg.includeFileMarkers) {
      rows.push({ text: `// ==================== 文件: ${file.path} (${kept.length} 行) ====================`, path: file.path, line: 0 });
    }
    for (const item of kept) {
      wrapLine(item.text, cfg.maxColumns).forEach((wrapped, i) => {
        rows.push({ text: wrapped, path: file.path, line: i === 0 ? item.line : 0 });
      });
    }
    perFile.push({ path: file.path, tier: file.tier, rows: kept.length });
  }

  return { rows, perFile };
}

// ---------------------------------------------------------------------------
// 生成计划 / 落盘 / PDF / 自检
// ---------------------------------------------------------------------------

/** 页码: 前 30 页为 1..30, 后 30 页为 31..60 */
type Page = PageOf<Row>;

interface Plan {
  cfg: RegisterConfig;
  /** 源程序整体不足 60 页时 → 提交全部 (mode='all') */
  mode: 'front-back' | 'all';
  rows: Row[];
  perFile: FileStat[];
  totalRows: number;
  totalPages: number;
  pages: Page[];
  frontRows: number;
  backRows: number;
  frontStartIndex: number;
  backStartIndex: number;
}

function buildPlan(cfg: RegisterConfig): Plan {
  const { ordered } = collectSourceStats();
  const { rows, perFile } = buildRows(ordered, cfg);

  const materialRows = (cfg.frontPages + cfg.backPages) * cfg.linesPerPage;
  const totalPages = Math.ceil(rows.length / cfg.linesPerPage);
  const mode: Plan['mode'] = rows.length < materialRows ? 'all' : 'front-back';

  if (mode === 'all') {
    // 不足 60 页 → 提交全部源程序
    const pages = buildPages(rows, cfg.linesPerPage, 'front', 1);
    return {
      cfg, mode, rows, perFile,
      totalRows: rows.length, totalPages,
      pages,
      frontRows: rows.length, backRows: 0,
      frontStartIndex: 0, backStartIndex: rows.length
    };
  }

  const frontRows = cfg.frontPages * cfg.linesPerPage;
  const backRows = cfg.backPages * cfg.linesPerPage;
  const backStart = rows.length - backRows;
  const pages = [
    ...buildPages(rows.slice(0, frontRows), cfg.linesPerPage, 'front', 1),
    ...buildPages(rows.slice(backStart), cfg.linesPerPage, 'back', cfg.frontPages + 1)
  ];

  return {
    cfg, mode, rows, perFile,
    totalRows: rows.length, totalPages,
    pages,
    frontRows, backRows,
    frontStartIndex: 0, backStartIndex: backStart
  };
}

function baseName(plan: Plan, suffix: string): string {
  return join(OUT_DIR, `${plan.cfg.softwareShortName}-源程序-${suffix}`);
}

/** 材料里实际出现的文件清单 (去重保序), 便于人工复核 */
function distinct(paths: string[]): string[] {
  const seen: string[] = [];
  for (const p of paths) if (!seen.includes(p)) seen.push(p);
  return seen;
}

function writeOutputs(plan: Plan, withPdf: boolean): Record<string, string> {
  const { cfg, pages } = plan;
  const submittedPages = cfg.frontPages + cfg.backPages;
  mkdirSync(OUT_DIR, { recursive: true });

  const files: Record<string, string> = {};
  const front = pages.filter((p) => p.segment === 'front');
  const back = pages.filter((p) => p.segment === 'back');
  const head = cfg.softwareFullName + ' ' + cfg.version + ' 源程序';
  // 页码口径: 提交 60 页时, 前段 1..30 / 后段 31..60, 页眉统一「共 60 页」
  const total = plan.mode === 'all' ? plan.totalPages : submittedPages;
  const rendered = (list: Page[]) => list.map((p) => ({ header: pageHeader(head, p.number, total, 60), lines: p.lines.map((r) => r.text) }));
  const title = `${cfg.softwareFullName} ${cfg.version} 源程序 (前 30 页 + 后 30 页)`;

  /** 出一份材料: TXT + HTML + (可选) PDF */
  const stamp = (suffix: string, list: Page[]) => {
    const txt = baseName(plan, `${suffix}.txt`);
    const html = baseName(plan, `${suffix}.html`);
    writeFileSync(txt, toTxt(rendered(list)), 'utf8');
    writeFileSync(html, toHtml(rendered(list), title), 'utf8');
    files[`${suffix}Txt`] = txt;
    files[`${suffix}Html`] = html;
    if (withPdf) {
      const pdf = baseName(plan, `${suffix}.pdf`);
      printPdf(html, pdf);
      files[`${suffix}Pdf`] = pdf;
    }
  };

  if (plan.mode === 'all') {
    stamp('全部页', pages);
  } else {
    stamp('共60页', pages);
    stamp(`前${cfg.frontPages}页`, front);
    stamp(`后${cfg.backPages}页`, back);
  }

  const frontLines = front.flatMap((p) => p.lines.map((r) => r.path));
  const backLines = back.flatMap((p) => p.lines.map((r) => r.path));
  // 行数拆成三部分, 便于审核方对账: 去空行代码行 + 文件分隔标注 + 超宽行折行续行
  const nonEmptyLines = plan.perFile.reduce((s, f) => s + f.rows, 0);
  const fileMarkers = cfg.includeFileMarkers ? plan.perFile.length : 0;
  const continuationLines = plan.totalRows - nonEmptyLines - fileMarkers;
  const report = {
    generatedAt: new Date().toISOString(),
    generator: 'scripts/gen-copyright-source.ts',
    software: {
      fullName: cfg.softwareFullName,
      shortName: cfg.softwareShortName,
      version: cfg.version,
      copyrightOwner: cfg.copyrightOwner,
      devLanguage: cfg.devLanguage,
      devCompletedDate: cfg.devCompletedDate,
      firstPublishDate: cfg.firstPublishDate
    },
    rule: {
      linesPerPage: cfg.linesPerPage,
      frontPages: cfg.frontPages,
      backPages: cfg.backPages,
      submittedPages: plan.mode === 'all' ? plan.totalPages : submittedPages,
      mode: plan.mode,
      modeNote: plan.mode === 'all'
        ? '源程序整体不足 60 页 → 按登记要求提交全部源程序'
        : '源程序超过 60 页 → 提交连续前 30 页 + 连续后 30 页, 共 60 页',
      maxColumns: cfg.maxColumns,
      includeFileMarkers: cfg.includeFileMarkers,
      dropCommentOnlyLines: cfg.dropCommentOnlyLines
    },
    totals: {
      files: plan.perFile.length,
      nonEmptyLines,
      fileMarkers,
      continuationLines,
      materialLines: plan.totalRows,
      sourcePages: plan.totalPages
    },
    materials: {
      front: { pages: front.length, rowRange: [1, plan.frontRows], startIndex: plan.frontStartIndex + 1 },
      back: { pages: back.length, rowRange: [plan.totalRows - plan.backRows + 1, plan.totalRows], startIndex: plan.backStartIndex + 1 }
    },
    minRowsPerPage: Math.min(...pages.map((p) => p.lines.length)),
    excluded: {
      prefixes: EXCLUDE_PREFIXES,
      suffixes: EXCLUDE_SUFFIX,
      note: '测试用例 / 第三方 vendored 框架 (src/bollharness) / 构建产物不进登记材料; 需调整改脚本里的 EXCLUDE_*'
    },
    tiers: TIERS.map((t) => ({
      name: t.name,
      files: plan.perFile.filter((f) => f.tier === t.name).length,
      rows: plan.perFile.filter((f) => f.tier === t.name).reduce((s, f) => s + f.rows, 0)
    })),
    frontFiles: distinct(frontLines),
    backFiles: distinct(backLines),
    files: plan.perFile
  };

  files.report = join(OUT_DIR, 'source-report.json');
  writeFileSync(files.report, JSON.stringify(report, null, 2) + '\n', 'utf8');
  return files;
}

function runCheck(plan: Plan): number {
  const { cfg } = plan;
  const submitted = plan.mode === 'all' ? plan.totalPages : cfg.frontPages + cfg.backPages;
  const txtPath = plan.mode === 'all' ? baseName(plan, '全部页.txt') : baseName(plan, '共60页.txt');
  const problems: string[] = [];

  if (!existsSync(txtPath)) {
    console.log(`gen-copyright-source: 自检 FAILED`);
    console.log(`- 材料不存在: ${txtPath} (先跑 --write)`);
    return 1;
  }
  const pages = readFileSync(txtPath, 'utf8').replace(/\n$/, '').split('\n\f\n');
  if (pages.length !== submitted) problems.push(`页数 ${pages.length} ≠ 期望 ${submitted}`);

  pages.forEach((page, idx) => {
    const lines = page.split('\n');
    const body = lines.slice(1);                       // 首行是页眉
    const no = idx + 1;
    if (!lines[0].includes(`第 ${no} 页 共 ${submitted} 页`)) problems.push(`第 ${no} 页页眉页码不对: ${lines[0]}`);
    if (plan.mode === 'front-back' && body.length !== cfg.linesPerPage) problems.push(`第 ${no} 页正文 ${body.length} 行 ≠ ${cfg.linesPerPage}`);
    if (body.length < 50) problems.push(`第 ${no} 页正文 ${body.length} 行 < 50 (不满足登记要求)`);
  });

  if (plan.mode === 'front-back') {
    if (plan.backStartIndex < plan.frontRows) problems.push('前 30 页与后 30 页重叠: 不是「连续前段 + 连续后段」');
    const frontTxt = baseName(plan, `前${cfg.frontPages}页.txt`);
    const backTxt = baseName(plan, `后${cfg.backPages}页.txt`);
    if (!existsSync(frontTxt) || !existsSync(backTxt)) {
      problems.push('缺少拆分后的 前30页/后30页 TXT');
    } else {
      const f = readFileSync(frontTxt, 'utf8').replace(/\n$/, '').split('\n\f\n');
      const b = readFileSync(backTxt, 'utf8').replace(/\n$/, '').split('\n\f\n');
      if (f.length !== cfg.frontPages) problems.push(`前 ${cfg.frontPages} 页 TXT 实际 ${f.length} 页`);
      if (b.length !== cfg.backPages) problems.push(`后 ${cfg.backPages} 页 TXT 实际 ${b.length} 页`);
    }
  }

  if (problems.length) {
    console.log('gen-copyright-source: 自检 FAILED');
    for (const p of problems) console.log(`- ${p}`);
    return 1;
  }
  console.log('gen-copyright-source: 自检 OK');
  console.log(`- 模式: ${plan.mode === 'all' ? '全部源程序' : `前 ${cfg.frontPages} 页 + 后 ${cfg.backPages} 页`}, 每页 ${cfg.linesPerPage} 行`);
  return 0;
}

function printReport(plan: Plan): void {
  const { cfg } = plan;
  const frontPaths = distinct(plan.pages.filter((p) => p.segment === 'front').flatMap((p) => p.lines.map((r) => r.path)));
  const backPaths = distinct(plan.pages.filter((p) => p.segment === 'back').flatMap((p) => p.lines.map((r) => r.path)));
  console.log('=== 软著源程序材料统计 ===');
  console.log(`软件: ${cfg.softwareFullName} ${cfg.version} (简称 ${cfg.softwareShortName}); 著作权人: ${cfg.copyrightOwner}`);
  console.log(`收录: ${plan.perFile.length} 个文件 / 去空行代码 ${plan.perFile.reduce((s, f) => s + f.rows, 0)} 行 → 材料行数 ${plan.totalRows} 行 (含文件标注与折行续行) / 源程序共 ${plan.totalPages} 页 (每页 ${cfg.linesPerPage} 行)`);
  console.log(`提交模式: ${plan.mode === 'all' ? '全部源程序 (整体不足 60 页)' : `前 ${cfg.frontPages} 页 + 后 ${cfg.backPages} 页 = ${cfg.frontPages + cfg.backPages} 页`}`);
  if (plan.mode === 'front-back') {
    console.log(`前段行区间: 1..${plan.frontRows} (${frontPaths.length} 个文件: ${frontPaths.slice(0, 6).join(', ')}${frontPaths.length > 6 ? ' …' : ''})`);
    console.log(`后段行区间: ${plan.backStartIndex + 1}..${plan.totalRows} (${backPaths.length} 个文件: ${backPaths.slice(0, 6).join(', ')}${backPaths.length > 6 ? ' …' : ''})`);
  }
  console.log('--- 档位分布 (功能主次) ---');
  for (const t of TIERS) {
    const files = plan.perFile.filter((f) => f.tier === t.name);
    if (!files.length) continue;
    console.log(`${t.name}: ${files.length} 文件 / ${files.reduce((s, f) => s + f.rows, 0)} 行`);
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const plan = buildPlan(loadRegisterConfig());

  if (args.includes('--report')) {
    printReport(plan);
    return;
  }
  if (args.includes('--check')) {
    printReport(plan);
    process.exitCode = runCheck(plan);
    return;
  }
  if (args.includes('--write')) {
    printReport(plan);
    const files = writeOutputs(plan, args.includes('--pdf'));
    console.log('--- 产出 ---');
    for (const [k, v] of Object.entries(files)) console.log(`${k}: ${v}`);
    process.exitCode = runCheck(plan);
    return;
  }

  console.log('用法: npx tsx scripts/gen-copyright-source.ts --report | --write [--pdf] | --check');
}

main();
