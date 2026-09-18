/**
 * gen-copyright-doc.ts — 软件著作权登记「文档」材料生成器 (设计说明书 · 前 30 页 + 后 30 页)
 *
 * 登记要求 (中国版权保护中心):
 *   ① 提交文档**连续的前 30 页**和**连续的后 30 页**, 每页不少于 30 行;
 *   ② 前后各 30 页可按开发时间排序, 也可按功能主次等自定义排序;
 *   ③ 若整个文档不到 60 页, 应提交整个文档。
 *   文档指描述程序内容、组成、设计、功能规格、开发情况、测试结果及使用方法的文字资料与图表,
 *   本材料取《Bolloon 智能体软件设计说明书》(含用户手册与测试结果)。
 *
 * 本脚本做四件事:
 *   ① 读 docs/copyright/doc/*.md 正文章节 (封面 → 概述 → 总体设计 → 功能规格 → 模块设计 → 数据 →
 *      接口 → 安全 → 开发情况 → 测试情况 → 用户手册 → 术语表);
 *   ② 按仓库真实现状**自动生成附录 A–E** (源程序模块清单 / HTTP 接口清单 / 工具清单 /
 *      验收脚本清单 / 版本演进摘要) —— 附录内容全部来自仓库, 不是手抄;
 *   ③ Markdown → 等宽定宽文本 (表格转行、代码块原样、正文折行), 插入自动目录 (页码按最终分页回填),
 *      再按固定行数分页;
 *   ④ 出 TXT / HTML / PDF (前 30 页、后 30 页、合订), 并自检「页数 / 每页行数 / 页码」。
 *
 * 用法:
 *   npx tsx scripts/gen-copyright-doc.ts --report          # 只打印统计, 不落盘
 *   npx tsx scripts/gen-copyright-doc.ts --write           # 写 docs/copyright/out/*
 *   npx tsx scripts/gen-copyright-doc.ts --write --pdf     # 再出 PDF (需本机 Chrome)
 *   npx tsx scripts/gen-copyright-doc.ts --check           # 校验已生成材料
 *
 * 分页/折行/页眉/PDF 复用 scripts/lib/copyright-common.ts, 避免两类材料的排版口径漂移。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  ROOT,
  buildPages,
  displayWidth,
  loadRegisterConfig,
  pageHeader,
  printPdf,
  toHtml,
  toTxt,
  wrapLine
} from './lib/copyright-common.js';
import { collectSourceStats } from './lib/copyright-source-scope.js';

const DOC_DIR = join(ROOT, 'docs', 'copyright', 'doc');
const OUT_DIR = join(ROOT, 'docs', 'copyright', 'out');

// ---------------------------------------------------------------------------
// Markdown → 等宽定宽文本
// ---------------------------------------------------------------------------

interface RenderedChapter {
  file: string;
  lines: string[];
  headings: Array<{ level: number; text: string; line: number }>;
}

/** 去掉行内 Markdown 标记, 保留可读文本 */
function cleanInline(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+$/, '');
}

function underline(char: string, text: string): string {
  return char.repeat(Math.max(6, Math.min(96, displayWidth(text))));
}

/** 表格行 `|a|b|` → `a | b` (分隔行丢弃) */
function renderTableRow(line: string): string | null {
  const cells = line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => cleanInline(c.trim()));
  if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) return null;
  return cells.filter((c) => c !== '').join(' | ');
}

function renderMarkdown(text: string, chapterFile: string, maxColumns: number): RenderedChapter {
  const lines: string[] = [];
  const headings: Array<{ level: number; text: string; line: number }> = [];
  let inFence = false;

  for (const raw of text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)) {
    const line = raw.replace(/\t/g, '    ').replace(/\s+$/, '');

    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      lines.push(inFence ? '---------------------------------------- (以下为示例内容)' : '----------------------------------------');
      continue;
    }
    if (inFence) {
      if (!line.trim()) continue;
      lines.push(...wrapLine(line, maxColumns, '    '));
      continue;
    }
    if (!line.trim()) continue;

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const title = cleanInline(heading[2]);
      headings.push({ level, text: title, line: lines.length });
      lines.push(title);
      if (level <= 2) lines.push(underline(level === 1 ? '=' : '-', title));
      continue;
    }
    if (/^\s*\|/.test(line)) {
      const row = renderTableRow(line);
      if (row) lines.push(...wrapLine(row, maxColumns, '    '));
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      const body = cleanInline(quote[1]);
      if (body) lines.push(...wrapLine(body, maxColumns, '    '));
      continue;
    }
    const bullet = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (bullet) {
      const body = cleanInline(bullet[2]);
      if (body) {
        const wrapped = wrapLine(`${bullet[1]} ${body}`, maxColumns);
        lines.push(...wrapped.map((w, i) => (i === 0 ? w : `   ${w}`)));
      }
      continue;
    }
    const body = cleanInline(line);
    if (body) lines.push(...wrapLine(body, maxColumns));
  }

  return { file: chapterFile, lines, headings };
}

// ---------------------------------------------------------------------------
// 附录 A–E (按仓库真实现状生成, 不是手抄)
// ---------------------------------------------------------------------------

function appendixSourceInventory(): { lines: string[]; files: number; rows: number } {
  const { stats } = collectSourceStats();
  const lines: string[] = [];
  let currentTier = '';
  for (const s of stats) {
    if (s.tier !== currentTier) {
      currentTier = s.tier;
      lines.push('');
      lines.push(`【${currentTier}】`);
    }
    lines.push(`${s.path}  (${s.rows} 行 / ${s.bytes} 字节)`);
  }
  return { lines, files: stats.length, rows: stats.reduce((sum, s) => sum + s.rows, 0) };
}

function appendixHttpRoutes(): { lines: string[]; count: number } {
  const dir = join(ROOT, 'src', 'web');
  const seen = new Set<string>();
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.ts') || name.endsWith('.test.ts') || name.endsWith('.bak')) continue;
    const text = readFileSync(join(dir, name), 'utf8');
    for (const m of text.matchAll(/app\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/g)) {
      seen.add(`${m[1].toUpperCase()} ${m[2]}`);
    }
  }
  const lines = [...seen].sort((a, b) => a.split(' ')[1].localeCompare(b.split(' ')[1]) || a.localeCompare(b));
  return { lines, count: lines.length };
}

function appendixTools(): { lines: string[]; count: number } {
  const dir = join(ROOT, 'src', 'agents');
  const names = new Set<string>();
  const walk = (abs: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const p = join(abs, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
        walk(p);
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
      const text = readFileSync(p, 'utf8');
      for (const m of text.matchAll(/\bname:\s*'([a-z][a-z0-9_]{2,})'/g)) names.add(m[1]);
    }
  };
  walk(dir);
  const lines = [...names].sort();
  return { lines, count: lines.length };
}

function appendixVerifyScripts(): { lines: string[]; count: number } {
  const dir = join(ROOT, 'scripts');
  const files = readdirSync(dir).filter((f) => /^verify-.*\.ts$/.test(f)).sort();
  const lines = files.map((f) => {
    const head = readFileSync(join(dir, f), 'utf8').split('\n').slice(0, 6);
    const desc = head
      .map((l) => l.replace(/^\s*(\/\*\*|\*\/|\*)\s?/, '').trim())
      .find((l) => l && !l.startsWith('*/') && !l.startsWith('/**'));
    return `${f}  — ${(desc ?? '').slice(0, 70)}`;
  });
  return { lines, count: files.length };
}

function appendixVersionHistory(limit: number): { lines: string[]; count: number } {
  const out = execFileSync('git', ['log', `-n${limit}`, '--date=short', '--pretty=%ad  %s'], { cwd: ROOT, encoding: 'utf8' });
  const lines = out.split('\n').filter(Boolean).map((l) => (displayWidth(l) > 100 ? l.slice(0, 64) + ' …' : l));
  return { lines, count: lines.length };
}

/** 把附录节写入行数组 (返回各附录的行区间, 便于报告) */
function buildAppendix(cfg: RegisterConfig): { lines: string[]; stats: Record<string, number> } {
  const lines: string[] = [];
  const push = (text: string) => lines.push(...wrapLine(text, cfg.maxColumns, '    '));

  const src = appendixSourceInventory();
  lines.push('附录 A 源程序模块清单（按功能主次排序，行数为去空行后的有效行数）');
  lines.push(underline('-', '附录 A 源程序模块清单（按功能主次排序，行数为去空行后的有效行数）'));
  push(`合计 ${src.files} 个源文件、${src.rows} 行；明细如下（括号内为该文件有效行数与字节数）。`);
  for (const l of src.lines) lines.push(...(l === '' ? [''] : wrapLine(l, cfg.maxColumns, '    ')));

  const routes = appendixHttpRoutes();
  lines.push('');
  lines.push('附录 B 本机 HTTP 接口清单（从服务端源码自动汇总）');
  lines.push(underline('-', '附录 B 本机 HTTP 接口清单（从服务端源码自动汇总）'));
  push(`合计 ${routes.count} 条路由，格式「方法 路径」。`);
  for (const l of routes.lines) lines.push(...wrapLine(l, cfg.maxColumns, '    '));

  const tools = appendixTools();
  lines.push('');
  lines.push('附录 C 智能体工具清单（从工具注册源码自动汇总）');
  lines.push(underline('-', '附录 C 智能体工具清单（从工具注册源码自动汇总）'));
  push(`合计 ${tools.count} 个工具名，按字典序排列。`);
  for (const l of tools.lines) lines.push(...wrapLine(l, cfg.maxColumns, '    '));

  const verify = appendixVerifyScripts();
  lines.push('');
  lines.push('附录 D 端到端验收脚本清单（从工程脚本目录自动汇总）');
  lines.push(underline('-', '附录 D 端到端验收脚本清单（从工程脚本目录自动汇总）'));
  push(`合计 ${verify.count} 个验收脚本，格式「脚本名 — 脚本用途」。`);
  for (const l of verify.lines) lines.push(...wrapLine(l, cfg.maxColumns, '    '));

  const version = appendixVersionHistory(120);
  lines.push('');
  lines.push('附录 E 版本演进摘要（最近 120 次提交的日期与说明，从版本库自动汇总）');
  lines.push(underline('-', '附录 E 版本演进摘要（最近 120 次提交的日期与说明，从版本库自动汇总）'));
  for (const l of version.lines) lines.push(...wrapLine(l, cfg.maxColumns, '    '));

  return {
    lines,
    stats: {
      sourceFiles: src.files,
      sourceRows: src.rows,
      routes: routes.count,
      tools: tools.count,
      verifyScripts: verify.count,
      commitEntries: version.count
    }
  };
}

// ---------------------------------------------------------------------------
// 装配 (章节 + 自动目录 + 附录) 与分页
// ---------------------------------------------------------------------------

type Page = PageOf<string>;

interface DocPlan {
  cfg: RegisterConfig;
  mode: 'front-back' | 'all';
  lines: string[];
  pages: Page[];
  totalLines: number;
  totalPages: number;
  frontLines: number;
  backLines: number;
  backStart: number;
  tocEntries: Array<{ level: number; text: string; page: number }>;
  appendixStats: Record<string, number>;
  chapters: Array<{ file: string; lines: number }>;
}

const APPENDIX_TITLES = [
  '附录 A 源程序模块清单（按功能主次排序，行数为去空行后的有效行数）',
  '附录 B 本机 HTTP 接口清单（从服务端源码自动汇总）',
  '附录 C 智能体工具清单（从工具注册源码自动汇总）',
  '附录 D 端到端验收脚本清单（从工程脚本目录自动汇总）',
  '附录 E 版本演进摘要（最近 120 次提交的日期与说明，从版本库自动汇总）'
];

/** 目录条目排成一行: 标题 + 点线 + 右对齐页码 (保证占且仅占一行) */
function tocLine(text: string, page: number | null, maxColumns: number): string {
  const pageText = page === null ? '--' : String(page);
  const indent = '  ';
  const room = maxColumns - indent.length - pageText.length - 2;
  let title = text;
  if (displayWidth(title) > room) {
    while (displayWidth(title) > room - 1 && title.length > 4) title = title.slice(0, -1);
    title += '…';
  }
  const dots = Math.max(1, room - displayWidth(title));
  return `${indent}${title}${'.'.repeat(dots)}${pageText}`;
}

function assemblePlan(cfg: RegisterConfig): DocPlan {
  const files = readdirSync(DOC_DIR).filter((f) => f.endsWith('.md') && !f.endsWith('.bak')).sort();
  if (files.length === 0) throw new Error(`未找到文档正文章节: ${DOC_DIR}/*.md`);

  const chapters = files.map((f) => renderMarkdown(readFileSync(join(DOC_DIR, f), 'utf8'), basename(f), cfg.maxColumns));
  const cover = chapters[0];
  const body = chapters.slice(1);

  const appendix = buildAppendix(cfg);
  const appendixHeadings = APPENDIX_TITLES.map((title) => {
    const line = appendix.lines.indexOf(title);
    if (line < 0) throw new Error(`附录标题未在附录中找到: ${title}`);
    return { level: 1, text: title, line };
  });

  // 目录条目 = 正文各章的 1/2 级标题 + 五个附录
  const spec: Array<{ level: number; text: string; src: 'body' | 'appendix'; line: number }> = [
    ...body.flatMap((c) => c.headings.filter((h) => h.level <= 2).map((h) => ({ level: h.level, text: h.text, src: 'body' as const, line: c.lines.length && h.line }))),
    ...appendixHeadings.map((h) => ({ level: h.level, text: h.text, src: 'appendix' as const, line: h.line }))
  ];

  // 目录块: 标题 + 下划线 + 每个条目一行 (占位符与最终内容行数一致, 两遍装配行数不变)
  const tocSize = 2 + spec.length;
  const tocPlaceholder = ['目录', underline('=', '目录'), ...spec.map((_, i) => `  (TOC-${i})`)];

  const bodyLines = body.flatMap((c) => c.lines);
  const linesPass1 = [...cover.lines, ...tocPlaceholder, ...bodyLines, ...appendix.lines];

  const perPage = cfg.docLinesPerPage;
  const totalLines = linesPass1.length;
  const totalPages = Math.ceil(totalLines / perPage);
  const pageOfLine = (idx: number) => Math.floor(idx / perPage) + 1;

  const bodyOffset = cover.lines.length + tocSize;
  const appendixOffset = bodyOffset + bodyLines.length;
  const tocEntries = spec.map((s) => ({
    level: s.level,
    text: s.text,
    page: pageOfLine(s.src === 'body'
      ? bodyOffset + (bodyIndexLine(body, s.text) ?? 0)
      : appendixOffset + s.line)
  }));

  const tocBlock = ['目录', underline('=', '目录'), ...tocEntries.map((e) => tocLine(e.text, e.page, cfg.maxColumns))];
  const lines = [...cover.lines, ...tocBlock, ...bodyLines, ...appendix.lines];
  if (lines.length !== linesPass1.length) {
    // 目录行数变化会让所有页码整体偏移 → 必须是一致才允许继续
    throw new Error(`目录装配后行数变化: ${lines.length} ≠ ${linesPass1.length} (页码会错位)`);
  }

  const materialLines = (cfg.docFrontPages + cfg.docBackPages) * perPage;
  const mode: DocPlan['mode'] = totalLines < materialLines ? 'all' : 'front-back';

  let pages: Page[];
  let frontLines: number;
  let backLines: number;
  let backStart: number;
  if (mode === 'all') {
    pages = buildPages(lines, perPage, 'front', 1);
    frontLines = totalLines;
    backLines = 0;
    backStart = totalLines;
  } else {
    frontLines = cfg.docFrontPages * perPage;
    backLines = cfg.docBackPages * perPage;
    backStart = totalLines - backLines;
    pages = [
      ...buildPages(lines.slice(0, frontLines), perPage, 'front', 1),
      ...buildPages(lines.slice(backStart), perPage, 'back', cfg.docFrontPages + 1)
    ];
  }

  return {
    cfg, mode, lines, pages,
    totalLines, totalPages,
    frontLines, backLines, backStart,
    tocEntries,
    appendixStats: appendix.stats,
    chapters: chapters.map((c) => ({ file: c.file, lines: c.lines.length }))
  };
}

/** 正文里某标题的行下标 (相对章节数组整体) */
function bodyIndexLine(body: RenderedChapter[], title: string): number | null {
  let offset = 0;
  for (const c of body) {
    const hit = c.headings.find((h) => h.text === title);
    if (hit) return offset + hit.line;
    offset += c.lines.length;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 落盘 / PDF / 自检 / 报告
// ---------------------------------------------------------------------------

function baseName(plan: DocPlan, suffix: string): string {
  return join(OUT_DIR, `${plan.cfg.softwareShortName}-软件设计说明书-${suffix}`);
}

function writeOutputs(plan: DocPlan, withPdf: boolean): Record<string, string> {
  const { cfg, pages } = plan;
  const submitted = cfg.docFrontPages + cfg.docBackPages;
  mkdirSync(OUT_DIR, { recursive: true });

  const head = `${cfg.softwareFullName} ${cfg.version} 软件设计说明书`;
  const total = plan.mode === 'all' ? plan.totalPages : submitted;
  const rendered = (list: Page[]) => list.map((p) => ({ header: pageHeader(head, p.number, total, 52), lines: p.lines }));
  const title = `${cfg.softwareFullName} ${cfg.version} 软件设计说明书 (前 30 页 + 后 30 页)`;
  const files: Record<string, string> = {};
  const front = pages.filter((p) => p.segment === 'front');
  const back = pages.filter((p) => p.segment === 'back');

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
    stamp(`前${cfg.docFrontPages}页`, front);
    stamp(`后${cfg.docBackPages}页`, back);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    generator: 'scripts/gen-copyright-doc.ts',
    software: {
      fullName: cfg.softwareFullName,
      shortName: cfg.softwareShortName,
      version: cfg.version,
      copyrightOwner: cfg.copyrightOwner,
      devLanguage: cfg.devLanguage,
      devCompletedDate: cfg.devCompletedDate,
      firstPublishDate: cfg.firstPublishDate
    },
    document: {
      name: `${cfg.softwareFullName} ${cfg.version} 软件设计说明书`,
      chapters: plan.chapters,
      appendix: plan.appendixStats,
      tocEntries: plan.tocEntries.length
    },
    rule: {
      linesPerPage: cfg.docLinesPerPage,
      frontPages: cfg.docFrontPages,
      backPages: cfg.docBackPages,
      submittedPages: plan.mode === 'all' ? plan.totalPages : submitted,
      mode: plan.mode,
      modeNote: plan.mode === 'all'
        ? '整份文档不足 60 页 → 按登记要求提交整个文档'
        : '文档超过 60 页 → 提交连续前 30 页 + 连续后 30 页, 共 60 页',
      maxColumns: cfg.maxColumns
    },
    totals: { lines: plan.totalLines, pages: plan.totalPages },
    materials: {
      front: { pages: front.length, rowRange: [1, plan.frontLines] },
      back: { pages: back.length, rowRange: [plan.backStart + 1, plan.totalLines] }
    },
    minLinesPerPage: Math.min(...pages.map((p) => p.lines.length)),
    toc: plan.tocEntries
  };

  files.report = join(OUT_DIR, 'doc-report.json');
  writeFileSync(files.report, JSON.stringify(report, null, 2) + '\n', 'utf8');
  return files;
}

/** 自检: 页数 / 每页行数 / 页码 / 前段后段不重叠 / 目录页码与正文实际页码一致 */
function runCheck(plan: DocPlan): number {
  const { cfg, pages } = plan;
  const submitted = plan.mode === 'all' ? plan.totalPages : cfg.docFrontPages + cfg.docBackPages;
  const problems: string[] = [];

  if (plan.mode === 'front-back') {
    if (pages.length !== submitted) problems.push(`页数 ${pages.length} ≠ 期望 ${submitted}`);
    pages.forEach((p, idx) => {
      if (p.lines.length !== cfg.docLinesPerPage) problems.push(`第 ${p.number} 页 ${p.lines.length} 行 ≠ ${cfg.docLinesPerPage}`);
      if (idx + 1 !== p.number) problems.push(`页序错位: 第 ${idx + 1} 个页面对象的页码为 ${p.number}`);
    });
    if (plan.backStart < plan.frontLines) problems.push('前 30 页与后 30 页重叠: 不是「连续前段 + 连续后段」');
  }
  for (const p of pages) {
    if (p.lines.length < 30) problems.push(`第 ${p.number} 页 ${p.lines.length} 行 < 30 (不满足登记要求)`);
  }

  // 目录页码: 每个条目标题必须真实出现在它所标注的那一页
  const pageByLine = new Map<string, number>();
  for (const p of pages) for (const line of p.lines) if (!pageByLine.has(line)) pageByLine.set(line, p.number);
  for (const entry of plan.tocEntries) {
    const actual = pageByLine.get(entry.text);
    if (actual === undefined) problems.push(`目录条目「${entry.text}」在正文中找不到`);
    else if (actual !== entry.page) problems.push(`目录页码错: 「${entry.text}」标注 ${entry.page} 页, 实际 ${actual} 页`);
  }

  if (problems.length) {
    console.log('gen-copyright-doc: 自检 FAILED');
    for (const p of problems.slice(0, 20)) console.log(`- ${p}`);
    if (problems.length > 20) console.log(`- …… 共 ${problems.length} 条问题`);
    return 1;
  }
  console.log('gen-copyright-doc: 自检 OK');
  console.log(`- 模式: ${plan.mode === 'all' ? '整个文档' : `前 ${cfg.docFrontPages} 页 + 后 ${cfg.docBackPages} 页`}, 每页 ${cfg.docLinesPerPage} 行`);
  console.log(`- 目录条目 ${plan.tocEntries.length} 条, 页码与正文实际页一致`);
  return 0;
}

function printReport(plan: DocPlan): void {
  const { cfg } = plan;
  console.log('=== 软著文档材料统计 ===');
  console.log(`文档: ${cfg.softwareFullName} ${cfg.version} 软件设计说明书 (著作权人 ${cfg.copyrightOwner})`);
  console.log(`正文行数: ${plan.totalLines} 行   文档总页数: ${plan.totalPages} 页 (每页 ${cfg.docLinesPerPage} 行)`);
  console.log(`提交模式: ${plan.mode === 'all' ? '整个文档 (不足 60 页)' : `前 ${cfg.docFrontPages} 页 + 后 ${cfg.docBackPages} 页 = ${cfg.docFrontPages + cfg.docBackPages} 页`}`);
  if (plan.mode === 'front-back') {
    console.log(`前段行区间: 1..${plan.frontLines}   后段行区间: ${plan.backStart + 1}..${plan.totalLines}`);
  }
  console.log('--- 章节行数 ---');
  for (const c of plan.chapters) console.log(`${c.file}: ${c.lines} 行`);
  console.log('--- 附录 (按仓库真实现状自动汇总) ---');
  for (const [k, v] of Object.entries(plan.appendixStats)) console.log(`${k}: ${v}`);
  console.log('--- 目录条目 (前 6 条) ---');
  for (const e of plan.tocEntries.slice(0, 6)) console.log(`${'  '.repeat(e.level - 1)}${e.text} …… ${e.page}`);
}

function main(): void {
  const args = process.argv.slice(2);
  const plan = assemblePlan(loadRegisterConfig());

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

  console.log('用法: npx tsx scripts/gen-copyright-doc.ts --report | --write [--pdf] | --check');
}

main();