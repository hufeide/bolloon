/**
 * 模块上下文工具 —— 让同一份源码在 **ESM(Node 主构建)** 与 **CJS(Electron 构建)** 下都能定位自己。
 *
 * 背景 (2026-09-19, 发布 `npm publish` 时才暴露):
 *   `tsconfig.electron.json` 是 `module: CommonJS`。只要某个文件被 electron 主进程链路
 *   (`electron.ts → auto-update → update-manager → version-info`) 间接引到, 文件里出现
 *   `import.meta` 就会 `TS1343` 编译失败 —— 而 `npm run build:main` / 日常 `tsx` 都走 ESM,
 *   完全看不出来。`prepublishOnly → build:all → build:electron` 一跑就红。
 *
 * 所以共享工具模块不许用 `import.meta` / 裸 `__dirname`, 统一走这里:
 *   - `cjsModuleDir()`  —— 只有 CJS 上下文给得出 (electron / dist 里的 CJS 产物)
 *   - `firstExisting()` —— 多个候选路径里挑第一个真实存在的 (构建产物 vs 源码目录)
 */
import * as fs from 'fs';
import * as path from 'path';
import { currentPackageRoot } from './version-info.js';

/**
 * CJS 上下文的 `__dirname`; ESM 下返回 `null`。
 *
 * 用 `new Function` 包一层是**故意**的: 直接写 `__dirname` 在 ESM 编译目标下会被 TS 拒绝
 * (未定义标识符), 而 `new Function` 的函数体不受模块作用域约束, CJS 里能拿到真的 `__dirname`,
 * ESM 里 `typeof __dirname === 'undefined'` 就返回 null。
 */
export function cjsModuleDir(): string | null {
  try {
    const dir = new Function('return typeof __dirname === "string" ? __dirname : null')() as string | null;
    return dir && dir.length > 0 ? dir : null;
  } catch {
    return null;
  }
}

/** 候选路径里第一个存在的; 都不存在就返回第一个候选 (让调用方的报错信息指回原始意图)。 */
export function firstExisting(candidates: string[]): string {
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch { /* 权限之类的读不了就当不存在 */ }
  }
  return candidates[0] ?? '';
}

/**
 * 包内资源目录候选, 按"离运行现场由近到远"排:
 *   ① CJS 产物同级 (`dist/.../<rel>`, electron 构建下的 `dist/electron-build/...`)
 *   ② `dist/<rel>`      —— 主构建产物 (build:web 会把 .md 一起拷进来)
 *   ③ `src/<rel>`       —— 开发态直接 `tsx src/...`
 */
export function packageDirCandidates(rel: string): string[] {
  const root = currentPackageRoot();
  const out: string[] = [];
  const here = cjsModuleDir();
  if (here) out.push(path.join(here, rel));
  out.push(path.join(root, 'dist', rel));
  out.push(path.join(root, 'src', rel));
  return out;
}
