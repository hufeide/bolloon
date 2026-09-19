/**
 * CLI 构建脚本
 *
 * 生成 bin/bolloon.js 和 bin/bolloon.cmd 入口文件
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');

const binDir = path.join(rootDir, 'bin');
if (!fs.existsSync(binDir)) {
  fs.mkdirSync(binDir, { recursive: true });
}

// Windows 批处理入口
// Windows 入口: 同样只指向真入口 (cli-entry.js), 不再指向 dist/index.js
const winContent = `@echo off
set "BOLLOON_ROOT=%~dp0"
set "BOLLOON_ROOT=%BOLLOON_ROOT:~0,-1%"

set "ENTRY=%BOLLOON_ROOT%\\dist\\cli-entry.js"
if not exist "%ENTRY%" (
    set "ENTRY=%BOLLOON_ROOT%\\dist\\index.js"
)
if not exist "%ENTRY%" (
    echo 找不到 dist 入口, 请先构建: npm run build:main
    exit /b 1
)

node "%ENTRY%" %*
`;

fs.writeFileSync(path.join(binDir, 'bolloon.cmd'), winContent);

// Unix/Linux/Mac 入口脚本
//
// 2026-09-19 修正: 这里以前生成的是**一整套重复实现** —— 第二套命令解析 + 第二份版本号
// (硬编码 `v0.1.1`, 而当时真实版本已是 0.4.x) + 自己的 banner/启动分支。同一个包在两个入口上
// 会给出两个答案 ("我是什么版本" 有 4 个来源就是这个原因之一)。
// 现在生成的只是一个**转发器**: 一律转发到真入口 `dist/cli-entry.js`
// (package.json 的 bin 字段也是它) —— 版本、命令、子命令只有一份实现。
// 见 docs/wiki/update-protocol.md §1。
const unixContent = `#!/usr/bin/env node
/**
 * 遗留 CJS 入口 (兼容老脚本/老文档里的 \`node bin/bolloon.cjs\`)。
 * 真入口是 dist/cli-entry.js; 这里只转发, 不重复实现任何命令。
 * NOTE: 本文件由 scripts/build-cli.js 生成 —— 改行为请改生成器, 别只改这里。
 */
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const candidates = [
  path.join(__dirname, "..", "dist", "cli-entry.js"),
  path.join(__dirname, "..", "dist", "cli-entry.cjs"),
];
const entry = candidates.find((p) => fs.existsSync(p));

if (!entry) {
  console.error("❌ 找不到 dist/cli-entry.js —— 请先构建: npm run build:main");
  process.exit(1);
}

const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], { stdio: "inherit" });
child.on("error", (err) => {
  console.error("启动失败:", err.message);
  process.exit(1);
});
child.on("exit", (code) => process.exit(code || 0));
`;

fs.writeFileSync(path.join(binDir, 'bolloon.cjs'), unixContent);

// 确保 bin/bolloon.js 存在（npm link 需要）
// 优先用符号链接（POSIX），Windows 上若权限不足则退化为复制文件
const jsSymlink = path.join(binDir, 'bolloon.js');
if (fs.existsSync(jsSymlink)) fs.unlinkSync(jsSymlink);
try {
  fs.symlinkSync('bolloon.cjs', jsSymlink);
} catch (err) {
  if (err && err.code === 'EPERM') {
    fs.copyFileSync(path.join(binDir, 'bolloon.cjs'), jsSymlink);
    console.warn('  ⚠ symlink 不支持（Windows），已退化为文件复制');
  } else {
    throw err;
  }
}

console.log("✓ CLI 构建完成");
console.log("  bin/bolloon.cjs    - CommonJS 入口");
console.log("  bin/bolloon.js     - 符号链接 -> bolloon.cjs");
console.log("  bin/bolloon.cmd    - Windows 入口");