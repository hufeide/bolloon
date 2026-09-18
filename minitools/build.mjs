#!/usr/bin/env node
/**
 * build.mjs — 小工具打包流水线 (校验 → 修复提示 → 打包)  v1
 *
 * 依据: .skill/minitool-zip-builder (v1.6.0) 的 SKILL.md 与 references/*
 *   - zip-artifact-spec.md   §1 目录/打包 · §2 文件类型 · §3 CSP 加载规则 · §4 路径 · §5 模板 · §6 自检
 *   - device-capabilities.md §3 不可用 Web API · §4 不可用行为 · §7 扫描清单
 *   - performance-budget.md  §1 体积门禁 · §2 静态数据 · §3 Base64 · §4-5 WebGL
 *   - js-compatibility.md / css-compatibility.md / cross-platform-h5.md
 *
 * 用法:
 *   node minitools/build.mjs                      # 默认打 minitools/starter
 *   node minitools/build.mjs minitools/<工具名>    # 指定工具目录 (里面要有 src/)
 *
 * 退出码: 0 = 无 ERROR (可交付) · 1 = 有 ERROR (不许交付) · 2 = 用法/环境错误
 * 门禁是硬性的: 审计脚本只是辅助, 缺运行时也不跳过检查 (performance-budget §1)。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SKILL = path.join(ROOT, '.skill', 'minitool-zip-builder');

const MIB = 1024 * 1024;
const ZIP_LIMIT = 10 * MIB;
const ZIP_RECOMMENDED = 2 * MIB;
const TEXT_FILE_WARN = 2 * MIB;
const TEXT_TOTAL_WARN = 5 * MIB;
const BASE64_WARN = 100 * 1024;
const BASE64_LIMIT = 1 * MIB;

const errors = [];
const warnings = [];
const notes = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);
const note = (m) => notes.push(m);

// ── 允许的文件类型 (zip-artifact-spec §2) ────────────────────────────────────
const ALLOWED_EXT = new Set([
  '.html', '.css', '.js',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg',
  '.woff', '.woff2',
  '.json',
]);
// zip 内禁止出现 (zip-artifact-spec §1)
const FORBIDDEN_BASENAMES = new Set(['.DS_Store', 'Thumbs.db']);
const FORBIDDEN_PATTERNS = [
  { re: /^node_modules$/i, why: 'node_modules 不许进包' },
  { re: /^\.git$/i, why: '.git 不许进包' },
  { re: /\.map$/i, why: 'sourcemap 不许进包 (*.map)' },
  { re: /^(vite|webpack|rollup|esbuild|babel)\.config\./i, why: '构建配置文件不许进包' },
  { re: /^(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/i, why: '锁文件不许进包' },
];

// 不可用 API / 行为 (device-capabilities §3/§4/§7)
const BANNED_API = [
  [/\bfetch\s*\(/, 'fetch('],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
  [/new\s+WebSocket\s*\(/, 'new WebSocket('],
  [/new\s+EventSource\s*\(/, 'new EventSource('],
  [/new\s+RTCPeerConnection\s*\(/, 'new RTCPeerConnection('],
  [/navigator\.geolocation\.(getCurrentPosition|watchPosition)/, 'navigator.geolocation'],
  [/navigator\.clipboard\.(readText|writeText)/, 'navigator.clipboard'],
  [/document\.execCommand\s*\(\s*['"](copy|cut|paste)['"]/, "document.execCommand('copy')"],
  [/navigator\.(bluetooth|usb|hid|serial)/, 'navigator.bluetooth/usb/hid/serial'],
  [/navigator\.(getBattery|connection|credentials|locks)/, 'navigator.getBattery/connection/credentials/locks'],
  [/navigator\.mediaDevices\.(enumerateDevices|getDisplayMedia)/, 'navigator.mediaDevices.enumerateDevices/getDisplayMedia'],
  [/navigator\.storage\.persist/, 'navigator.storage.persist'],
  [/navigator\.serviceWorker\.register/, 'navigator.serviceWorker.register'],
  [/new\s+(Worker|SharedWorker)\s*\(/, 'new Worker('],
  [/new\s+(Accelerometer|Gyroscope|Magnetometer)\s*\(/, 'new Accelerometer()/Gyroscope/Magnetometer'],
  [/\b(DeviceMotionEvent|DeviceOrientationEvent)\b/, 'DeviceMotionEvent/DeviceOrientationEvent'],
  [/addEventListener\s*\(\s*['"](devicemotion|deviceorientation)['"]/, "addEventListener('devicemotion'/'deviceorientation')"],
  [/requestFullscreen|webkitRequestFullscreen/, 'Element.requestFullscreen'],
  [/\beval\s*\(/, 'eval('],
  [/new\s+Function\s*\(/, 'new Function('],
  [/WebAssembly\s*\./, 'WebAssembly.'],
  [/window\.open\s*\(/, 'window.open('],
  [/window\.prompt\s*\(/, 'window.prompt('],
  [/location\.(href\s*=|assign\s*\(|replace\s*\()/, 'location.href/assign/replace (跳转站外)'],
  [/SharedArrayBuffer/, 'SharedArrayBuffer'],
];

// ── 工具函数 ────────────────────────────────────────────────────────────────
const fmt = (n) => `${(n / MIB).toFixed(2)} MiB`;
const rel = (root, p) => path.relative(root, p).split(path.sep).join('/');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

// ── 1. 结构检查 ─────────────────────────────────────────────────────────────
function checkStructure(srcDir) {
  if (!fs.existsSync(srcDir)) { err(`产物目录不存在: ${srcDir}`); return null; }
  const files = walk(srcDir);

  if (!files.some((f) => path.dirname(f) === srcDir && path.basename(f) === 'index.html')) {
    const nested = files.find((f) => path.basename(f) === 'index.html');
    err(nested
      ? `index.html 不在根目录 (现在是 ${rel(srcDir, nested)}) — 容器只认根目录的 index.html`
      : '缺少 index.html (入口必需)');
  }
  const hu = files.filter((f) => path.extname(f).toLowerCase() === '.html');
  if (hu.length > 1) warn(`包内有 ${hu.length} 个 .html;规范要求单页 (一个 index.html + JS 切视图): ${hu.map((f) => rel(srcDir, f)).join(', ')}`);

  for (const f of files) {
    const base = path.basename(f);
    const r = rel(srcDir, f);
    if (FORBIDDEN_BASENAMES.has(base)) err(`禁止文件: ${r}`);
    for (const { re, why } of FORBIDDEN_PATTERNS) {
      if (re.test(base) || f.split(path.sep).some((seg) => re.test(seg))) err(`禁止内容 ${r} — ${why}`);
    }
    const ext = path.extname(f).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) err(`不支持的文件类型 ${r} (${ext || '无扩展名'}) — 见 zip-artifact-spec §2`);
  }
  return files;
}

// ── 2. HTML 检查 (§3/§4/§5 + §7) ────────────────────────────────────────────
function checkHtml(files, srcDir) {
  for (const f of files.filter((x) => path.extname(x).toLowerCase() === '.html')) {
    const t = readText(f);
    const r = rel(srcDir, f);
    const isIndex = path.basename(f) === 'index.html';

    if (!/<!DOCTYPE html>/i.test(t)) err(`${r}: 缺 <!DOCTYPE html>`);
    if (isIndex && !/<html[^>]*\slang=/i.test(t)) err(`${r}: <html> 缺 lang 属性`);
    if (!/<meta[^>]+charset\s*=\s*["']?utf-8/i.test(t)) err(`${r}: 缺 <meta charset="UTF-8">`);
    if (isIndex) {
      const vp = (t.match(/<meta[^>]+name=["']viewport["'][^>]*>/i) || [''])[0];
      if (!vp) err(`${r}: 缺 viewport meta`);
      else {
        if (!/width=device-width/i.test(vp)) err(`${r}: viewport 缺 width=device-width`);
        if (!/initial-scale=1(\.0)?/i.test(vp)) err(`${r}: viewport 缺 initial-scale=1.0`);
        if (!/viewport-fit=cover/i.test(vp)) err(`${r}: viewport 缺 viewport-fit=cover (真机安全区)`);
      }
    }
    if (/<base\b/i.test(t)) err(`${r}: 用了 <base href> (破坏真机路径)`);
    if (/<iframe\b/i.test(t) || /<object\b/i.test(t)) err(`${r}: 出现 <iframe>/<object> (容器禁止)`);
    if (/<meta[^>]+http-equiv=["']Content-Security-Policy["']/i.test(t)) err(`${r}: 自建 CSP meta (安全策略由容器管理)`);
    if (/<script[^>]*type=["']module["']/i.test(t)) err(`${r}: <script type="module"> 不可用 (离线 zip 里 module 解析不可靠)`);

    // 内联脚本: <script> 必须带 src。
    //   注释里的残留没有执行风险 (§7 说的"残留"主要指被禁能力), 因此只提示; 可执行的内联脚本才是 ERROR。
    const live = t.replace(/<!--[\s\S]*?-->/g, '');
    const scripts = live.match(/<script\b[^>]*>/gi) || [];
    for (const s of scripts) if (!/\ssrc\s*=/i.test(s)) err(`${r}: 有内联 <script> (CSP script-src 不含 unsafe-inline), 必须外置成 <script src="./x.js">`);
    const commented = t.replace(/<!--([\s\S]*?)-->/g, (m) => `\u0000${m}\u0000`).match(/\u0000[\s\S]*?<script\b(?![^>]*\ssrc=)[\s\S]*?\u0000/gi) || [];
    if (commented.length) warn(`${r}: 注释里残留 <script> 片段 ${commented.length} 处 (不会执行, 但属残留建议删)`);
    // 行内事件
    const inlineEvt = t.match(/\son[a-z]+\s*=\s*["']/gi) || [];
    if (inlineEvt.length) err(`${r}: 行内事件 ${[...new Set(inlineEvt.map((x) => x.trim().split('=')[0]))].join(', ')} 不可用 — 改用 addEventListener`);
    if (/javascript:/i.test(t)) err(`${r}: 出现 javascript: URI`);
    if (/target\s*=\s*["']_blank["']/i.test(t)) err(`${r}: target="_blank" 不可用 (不打开新窗口)`);
    if (/<a\b[^>]*\sdownload\b/i.test(t)) err(`${r}: <a download> 不可用 (无文件下载)`);
    if (/<form\b/i.test(t)) warn(`${r}: 出现 <form>;若有提交跳转必须 e.preventDefault() 后用 JS 处理`);

    // 外部资源 (一切联网引用)
    const ext = t.match(/(?:src|href)\s*=\s*["']https?:\/\/[^"']+/gi) || [];
    if (ext.length) err(`${r}: 外部资源引用 ${ext.slice(0, 3).join(' , ')} — 必须下载进包改相对路径`);
    const cssImport = t.match(/@import\s+url\(\s*["']?https?:\/\//gi) || [];
    if (cssImport.length) err(`${r}: @import 外部样式`);

    // 绝对路径引用
    const abs = t.match(/(?:src|href)\s*=\s*["']\/(?!\/)[^"']*/gi) || [];
    if (abs.length) err(`${r}: 绝对路径引用 ${abs.slice(0, 3).join(' , ')} — 离线 zip 根为 /, 必须用 ./ 相对路径`);
  }
}

// ── 3. JS/CSS/JSON 检查 ────────────────────────────────────────────────────
function checkCode(files, srcDir) {
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    if (!['.js', '.css', '.json'].includes(ext)) continue;
    const t = readText(f);
    const r = rel(srcDir, f);

    if (ext === '.json') {
      try { JSON.parse(t); } catch (e) { err(`${r}: JSON 解析失败 — ${e.message}`); }
    }
    if (ext === '.js') {
      // 经典脚本: 不许 import/export (module 语法)
      if (/^\s*import\s+[\w{*'"]/m.test(t) || /^\s*export\s+(default|const|function|class|\{)/m.test(t)) {
        err(`${r}: 出现 import/export — 脚本必须是经典脚本 (靠多个 <script src> + window 命名空间协作)`);
      }
      if (/^\s*await\s+/m.test(t) && !/async\s/.test(t)) err(`${r}: 疑似 top-level await (不支持)`);
      if (/=>\s*\{[^}]*\}\s*\?\./.test(t) || /\?\./.test(t)) warn(`${r}: 出现可选链 ?. (ES2020, 超出 Chrome 61/ES2017 基线)`);
      if (/\?\?/.test(t)) warn(`${r}: 出现空值合并 ?? (ES2020, 超出 Chrome 61/ES2017 基线)`);
      if (/\.flat\(|\.flatMap\(|Object\.fromEntries|\.replaceAll\(|\.at\(/.test(t)) warn(`${r}: 出现超出 ES2017 的 API (flat/flatMap/fromEntries/replaceAll/at)`);
    }
    if (ext === '.css') {
      if (/\bflex\b[^}]*\bgap\s*:/i.test(t) && /display\s*:\s*flex/i.test(t)) warn(`${r}: flex 容器里的 gap 在 Chrome 84 才有;建议改用 margin (css-compatibility)`);
      if (/:has\(|@container|:is\(|:where\(/.test(t)) note(`${r}: 使用现代 CSS (${[':has(#','@container',':is(',':where('].filter((s) => t.includes(s)).join(' ')});必须通过能力检测局部增强, 并在 Chrome 61 有基线回退`);
      if (/aspect-ratio/.test(t)) warn(`${r}: aspect-ratio 在 Chrome 88 才有;Chrome 61 需要 padding-top 百分比回退`);
    }

    // 禁用 API 扫描 (对 .js/.css 都做, css 里主要抓 url(http)
    for (const [re, label] of BANNED_API) {
      if (re.test(t)) {
        const line = t.split('\n').findIndex((l) => re.test(l)) + 1;
        err(`${r}:${line} 命中不可用能力 ${label} — 见 device-capabilities §3/§4/§7`);
      }
    }
    const cssExt = t.match(/url\(\s*["']?https?:\/\//gi) || [];
    if (cssExt.length) err(`${r}: CSS 里引用外部资源 url(http...)`);
  }
}

// ── 4. 体积 + Base64 (performance-budget §1/§3) ─────────────────────────────
function checkBudget(files, srcDir) {
  let textTotal = 0;
  for (const f of files) {
    const size = fs.statSync(f).size;
    const ext = path.extname(f).toLowerCase();
    const r = rel(srcDir, f);
    if (['.html', '.css', '.js', '.json'].includes(ext)) {
      textTotal += size;
      if (size > TEXT_FILE_WARN) warn(`${r}: 文本文件 ${fmt(size)} > 2 MiB(促发解析/内存风险)`);
    }
    if (['.js', '.html', '.css', '.svg'].includes(ext)) {
      const t = readText(f);
      const re = /data:([a-z0-9.+-]+\/[a-z0-9.+-]+)?;base64,([A-Za-z0-9+/=]{200,})/gi;
      let m; let n = 0;
      while ((m = re.exec(t))) {
        n++;
        const bytes = Math.floor(m[2].length * 3 / 4);
        const mine = (m[1] || '').toLowerCase();
        if (/^(video|audio)\//.test(mine)) err(`${r}: ${mine} 的 data: URI 不被容器支持 (音视频必须用包内文件)`);
        else if (bytes > BASE64_LIMIT) err(`${r}: 单条 Base64 解码后 ${fmt(bytes)} > 1 MiB — 必须改成独立包内文件`);
        else if (bytes > BASE64_WARN) warn(`${r}: #${n} 单条 Base64 解码后 ${fmt(bytes)} > 100 KiB — 优先改成独立包内文件`);
      }
      if (n) note(`${r}: 内联 Base64 ${n} 条 (已在体积门禁内)`);
    }
  }
  if (textTotal > TEXT_TOTAL_WARN) warn(`HTML/CSS/JS/JSON 解压后合计 ${fmt(textTotal)} > 5 MiB — 检查是否把数据集/生成内容塞进代码包`);
  return textTotal;
}

// ── 5. 调用 skill 自带审计脚本 (原始输出原样展示) ───────────────────────────
function runSkillAudits(srcDir) {
  const out = [];
  const nodeScript = path.join(SKILL, 'scripts', 'audit_artifact.mjs');
  const pyScript = path.join(SKILL, 'scripts', 'audit_artifact.py');
  const runs = [
    ['node', ['node', [nodeScript, srcDir]]],
    ['python3', ['python3', [pyScript, srcDir]]],
  ];
  for (const [label, [cmd, args]] of runs) {
    try {
      const r = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      out.push({ label, ok: true, text: r.trim() });
    } catch (e) {
      const text = `${e.stdout || ''}${e.stderr || ''}`.trim() || String(e.message);
      const missing = /ENOENT|not found/i.test(String(e.message));
      out.push({ label, ok: !missing && e.status === 0, text, skipped: missing });
      if (missing) note(`审计脚本 ${label} 不可用 → 已用 build.mjs 的内建检查代偿 (performance-budget §1 要求: 不因缺运行时跳过门禁)`);
    }
  }
  return out;
}

// ── 6. 打包 + zip 结构复核 (zip-artifact-spec §1) ───────────────────────────
function pack(srcDir, outDir, slug) {
  fs.mkdirSync(outDir, { recursive: true });
  const zipPath = path.join(outDir, `${slug}.zip`);
  if (fs.existsSync(zipPath)) fs.rmSync(zipPath);
  // 关键: 进入产物目录, 压缩"目录内容" (而不是目录本身), 否则 index.html 会被套一层
  execFileSync('zip', ['-r', '-q', zipPath, '.', '-x', '*.DS_Store', '-x', '__MACOSX/*'], { cwd: srcDir });
  return zipPath;
}

function checkZip(zipPath) {
  const size = fs.statSync(zipPath).size;
  if (size > ZIP_LIMIT) err(`最终 zip ${fmt(size)} 超过 10 MiB 上限`);
  else if (size > ZIP_RECOMMENDED) warn(`最终 zip ${fmt(size)} 超过建议值 2 MiB`);

  const list = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  if (!list.includes('index.html')) {
    err(`zip 根目录没有 index.html (顶层是: ${list.slice(0, 5).join(', ')}) — 压缩方式错了 (压了目录本身而不是目录内容)`);
  }
  for (const f of list) {
    if (f.startsWith('__MACOSX/') || f.endsWith('.DS_Store')) err(`zip 内出现系统垃圾文件: ${f}`);
    const base = path.basename(f);
    for (const { re, why } of FORBIDDEN_PATTERNS) if (re.test(base)) err(`zip 内出现禁止内容 ${f} — ${why}`);
    const ext = path.extname(f).toLowerCase();
    if (ext && !ALLOWED_EXT.has(ext)) err(`zip 内含不支持类型 ${f}`);
  }
  return { size, files: list.length, list };
}

// ── main ───────────────────────────────────────────────────────────────────
const toolArg = process.argv[2] || 'minitools/starter';
const toolDir = path.resolve(ROOT, toolArg);
const srcDir = path.join(toolDir, 'src');
const slug = path.basename(toolDir);
const outDir = path.join(ROOT, 'minitools', 'dist');

console.log(`小工具打包流水线 v1  ·  skill=${path.relative(ROOT, SKILL)}`);
console.log(`工具目录: ${path.relative(ROOT, toolDir)}  →  产物: minitools/dist/${slug}.zip\n`);

if (!fs.existsSync(SKILL)) { console.error(`找不到 skill: ${SKILL}`); process.exit(2); }

const files = checkStructure(srcDir);
if (files) {
  checkHtml(files, srcDir);
  checkCode(files, srcDir);
  const textTotal = checkBudget(files, srcDir);
  note(`文件数 ${files.length} · 源码体积 ${fmt(files.reduce((a, f) => a + fs.statSync(f).size, 0))} · 文本合计 ${fmt(textTotal)}`);
}

console.log('── skill 自带审计脚本 ──────────────────────────────');
for (const r of runSkillAudits(srcDir)) {
  console.log(`[${r.label}]${r.skipped ? ' (不可用, 已跳过)' : ''}\n${r.text || '(无输出)'}\n`);
}

let zipInfo = null;
if (!files) {
  console.log('产物目录缺失 → 跳过打包');
} else if (errors.length) {
  console.log('── 打包 ────────────────────────────────────────────');
  console.log(`发现 ${errors.length} 个 ERROR → 按规范不打包 (先修再打)。`);
} else {
  const zipPath = pack(srcDir, outDir, slug);
  zipInfo = checkZip(zipPath);
  console.log('── 打包 + zip 结构复核 ─────────────────────────────');
  console.log(`产物: ${path.relative(ROOT, zipPath)}`);
  console.log(`大小: ${fmt(zipInfo.size)}${zipInfo.size > ZIP_RECOMMENDED ? ' (超过建议 2 MiB)' : ' (在建议值内)'} · 条目 ${zipInfo.files}`);
  try {
    const zipAudit = execFileSync('python3', [path.join(SKILL, 'scripts', 'audit_artifact.py'), zipPath], { encoding: 'utf8' }).trim();
    console.log(`[zip 审计]\n${zipAudit}`);
  } catch (e) { note(`zip 审计脚本对最终包执行失败: ${String(e.message).slice(0, 80)}`); }
}

console.log('\n── 校验摘要 ────────────────────────────────────────');
console.log(`ERROR ${errors.length} · WARN ${warnings.length}`);
for (const e of errors) console.log(`  ERROR  ${e}`);
for (const w of warnings) console.log(`  WARN   ${w}`);
for (const n of notes) console.log(`  note   ${n}`);

if (errors.length) {
  console.log('\n结果: ❌ 未通过 (按 zip-artifact-spec §6 / device-capabilities §7 / performance-budget §1/§6 修完再跑)');
  process.exit(1);
}
console.log('\n结果: ✅ 通过静态门禁');
if (zipInfo) console.log(`可交付产物: ${path.resolve(outDir, `${slug}.zip`)}`);
console.log('提示: 静态检查 ≠ 真机实测。帧率/首屏/内存未测时必须标注「性能未实测」(performance-budget §1/§6)。');
process.exit(0);
