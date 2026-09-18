/**
 * copyright-common.ts — 软著材料生成器的公共分页 / 折行 / 渲染 / PDF 能力
 *
 * 两类登记材料共用:
 *   · 源程序: 前 30 页 + 后 30 页, 每页不少于 50 行  (scripts/gen-copyright-source.ts)
 *   · 文档  : 前 30 页 + 后 30 页, 每页不少于 30 行  (scripts/gen-copyright-doc.ts)
 * 口径只差「每页行数」与内容来源, 分页/折行/页眉/PDF 必须完全一致 —— 放一份, 避免两处口径漂移
 * (页数或行数一旦不一致, 材料就不合规, 而且是看不出来的那种不一致)。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { resolveChromePath } from '../../src/agents/browser-cdp.js';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 一页 = 固定 N 行; segment 区分前段/后段 (页码连续) */
export interface Page<T> {
  number: number;
  segment: 'front' | 'back';
  lines: T[];
}

/** 渲染好的一页: 页眉 + 固定行数的正文 */
export interface RenderedPage {
  header: string;
  lines: string[];
}

// ---------------------------------------------------------------------------
// 等宽宽度与折行 (CJK 记 2 列, 保证等宽排版不撑破页宽)
// ---------------------------------------------------------------------------

const WIDE_RANGES: Array<[number, number]> = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe6f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f900, 0x1f9ff], [0x20000, 0x2fffd]
];

export function charWidth(codePoint: number): number {
  for (const [lo, hi] of WIDE_RANGES) if (codePoint >= lo && codePoint <= hi) return 2;
  return 1;
}

export function displayWidth(text: string): number {
  let w = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined) w += charWidth(cp);
  }
  return w;
}

export const CONTINUATION_PREFIX = '    ... ';

/** 超宽行折成多行 (续行带前缀), 保证任何一行都不超过 maxColumns 列 */
export function wrapLine(line: string, maxColumns: number, prefix = CONTINUATION_PREFIX): string[] {
  if (displayWidth(line) <= maxColumns) return [line];
  const out: string[] = [];
  let cur = '';
  let width = 0;
  for (const ch of line) {
    const cw = charWidth(ch.codePointAt(0) as number);
    if (width + cw > maxColumns) {
      out.push(cur);
      cur = prefix;
      width = prefix.length;
    }
    cur += ch;
    width += cw;
  }
  out.push(cur);
  return out;
}

// ---------------------------------------------------------------------------
// 固定行数分页 + 页眉
// ---------------------------------------------------------------------------

export function buildPages<T>(items: T[], perPage: number, segment: 'front' | 'back', startNumber: number): Array<Page<T>> {
  const pages: Array<Page<T>> = [];
  for (let i = 0; i < items.length; i += perPage) {
    pages.push({ number: startNumber + pages.length, segment, lines: items.slice(i, i + perPage) });
  }
  return pages;
}

/** 页眉: 左侧标题 + 右侧「第 N 页 共 M 页」 */
export function pageHeader(left: string, number: number, total: number, leftWidth = 60): string {
  const right = `第 ${number} 页 共 ${total} 页`;
  return left + ' '.repeat(Math.max(1, leftWidth - displayWidth(left))) + right;
}

// ---------------------------------------------------------------------------
// TXT / HTML / PDF
// ---------------------------------------------------------------------------

/** 页之间用 \f 分页 (Word/WPS 打开 TXT 时会转成真分页符) */
export function toTxt(pages: RenderedPage[]): string {
  return pages.map((p) => [p.header, ...p.lines].join('\n')).join('\n\f\n') + '\n';
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** A4 打印版: 每页固定 N 行 + 页眉, 一页正好一张纸 (Chrome 打印页数 = 逻辑页数) */
export function toHtml(pages: RenderedPage[], title: string): string {
  const body = pages
    .map((p) => `<section class="page"><div class="hd">${escapeHtml(p.header)}</div><div class="code">${p.lines.map(escapeHtml).join('\n')}</div></section>`)
    .join('\n');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  @page { size: A4; margin: 12mm 10mm; }
  html, body { margin: 0; padding: 0; }
  body { font-family: "Menlo", "DejaVu Sans Mono", "Courier New", monospace; font-size: 9.5pt; line-height: 1.35; color: #000; }
  .page { page-break-after: always; break-after: page; }
  .page:last-child { page-break-after: auto; break-after: auto; }
  .hd { border-bottom: 1px solid #000; padding-bottom: 2px; margin-bottom: 4px; white-space: pre; }
  .code { white-space: pre; }
</style></head>
<body>
${body}
</body></html>
`;
}

// ---------------------------------------------------------------------------
// 登记配置 (源程序材料与文档材料共读 docs/copyright/register.json)
// ---------------------------------------------------------------------------

export interface RegisterConfig {
  softwareFullName: string;
  softwareShortName: string;
  version: string;
  copyrightOwner: string;
  devLanguage: string;
  devCompletedDate: string;
  firstPublishDate: string;
  /** 源程序材料: 每页行数 (登记要求下限 50) */
  linesPerPage: number;
  frontPages: number;
  backPages: number;
  /** 文档材料: 每页行数 (登记要求下限 30) */
  docLinesPerPage: number;
  docFrontPages: number;
  docBackPages: number;
  maxColumns: number;
  includeFileMarkers: boolean;
  dropCommentOnlyLines: boolean;
}

export const DEFAULT_CONFIG: RegisterConfig = {
  softwareFullName: 'Bolloon 智能体软件',
  softwareShortName: 'Bolloon',
  version: 'V1.0',
  copyrightOwner: 'yuanjie liu',
  devLanguage: 'TypeScript / JavaScript',
  devCompletedDate: '待填写',
  firstPublishDate: '待填写',
  linesPerPage: 50,
  frontPages: 30,
  backPages: 30,
  docLinesPerPage: 30,
  docFrontPages: 30,
  docBackPages: 30,
  maxColumns: 100,
  includeFileMarkers: true,
  dropCommentOnlyLines: false
};

const CONFIG_PATH = join(ROOT, 'docs', 'copyright', 'register.json');

export function loadRegisterConfig(): RegisterConfig {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG };
  const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Partial<RegisterConfig>;
  const cfg: RegisterConfig = { ...DEFAULT_CONFIG, ...raw };
  if (cfg.linesPerPage < 50) {
    throw new Error(`register.json: linesPerPage=${cfg.linesPerPage} 低于源程序材料的下限 50 行/页`);
  }
  if (cfg.docLinesPerPage < 30) {
    throw new Error(`register.json: docLinesPerPage=${cfg.docLinesPerPage} 低于文档材料的下限 30 行/页`);
  }
  if (cfg.frontPages < 1 || cfg.backPages < 1 || cfg.docFrontPages < 1 || cfg.docBackPages < 1) {
    throw new Error('register.json: frontPages / backPages / docFrontPages / docBackPages 必须为正整数');
  }
  return cfg;
}

/** 调本机 Chrome 把材料 HTML 打成 PDF (headless, 不带默认页眉页脚) */
export function printPdf(htmlPath: string, pdfPath: string): void {
  const chrome = resolveChromePath();
  if (!chrome) throw new Error('未找到 Chrome 可执行文件 (BOLLOON_CHROME_PATH 可指定); TXT/HTML 仍可用, 可在 Word/浏览器里手动导出 PDF');
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-pdf-header-footer',
    '--run-all-compositor-stages-before-draw',
    '--virtual-time-budget=20000',
    `--user-data-dir=${join(tmpdir(), `bolloon-copyright-chrome-${process.pid}`)}`,
    `--print-to-pdf=${pdfPath}`,
    `file://${htmlPath}`
  ];
  const r = spawnSync(chrome, args, { encoding: 'utf8', timeout: 300000 });
  if (!existsSync(pdfPath) || statSync(pdfPath).size < 1024) {
    throw new Error(`Chrome 出 PDF 失败: ${(r.stderr || r.error?.message || '(无输出)').slice(-400)}`);
  }
}
