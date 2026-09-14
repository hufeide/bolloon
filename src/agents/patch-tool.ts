/**
 * patch-tool.ts — 精确补丁 (patch 工具)
 *
 * 与 edit_file 的区别 (为什么需要它):
 *   edit_file  = 全文 indexOf 替换, 不做唯一性检查 → 同一片段出现多次时**静默改错一处**
 *   patch      = 先精确匹配, 匹配不唯一就拒绝; 再退一步做**按行 + 空白容错**匹配
 *                (模型复述代码时常常少/多缩进、行尾空格不同, 传统 indexOf 直接失败)
 *
 * 安全: 路径仍走 checkWritePath 护栏; 写前 stageWrite 暂存快照 (支持审计/撤销)。
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { checkWritePath } from './shell-guard.js';
import type { ToolRegistryContext } from './pi-sdk-tools.js';

export interface PatchOptions {
  /** 匹配到多处时是否全部替换 (默认 false → 多处即拒绝) */
  replaceAll?: boolean;
}

export interface PatchOutcome {
  ok: boolean;
  /** 打补丁后的完整内容 (ok=false 时为空) */
  content?: string;
  /** 命中的匹配策略 */
  strategy?: 'exact' | 'line-normalized';
  /** 替换次数 */
  replacements?: number;
  removedLines?: number;
  addedLines?: number;
  error?: string;
}

/** 统计子串出现次数 */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/** 行归一化: 折叠所有空白 + 去首尾 (容错匹配用) */
function normLine(l: string): string {
  return l.replace(/\s+/g, ' ').trim();
}

/**
 * 按行做空白容错匹配, 返回所有命中的起始行号 (0-based)。
 * 目标行里的空行会被忽略 (模型常漏/多空行)。
 */
function findNormalizedLineMatches(originalLines: string[], targetLines: string[]): number[] {
  const hay = originalLines.map(normLine);
  const needle = targetLines.map(normLine).filter((l) => l.length > 0);
  if (needle.length === 0) return [];
  const hits: number[] = [];
  for (let i = 0; i + needle.length <= hay.length; i++) {
    // 起始行必须非空 (避免匹配到空行区段)
    if (hay[i].length === 0) continue;
    let matched = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) { matched = false; break; }
    }
    if (matched) hits.push(i);
  }
  return hits;
}

/**
 * 纯函数: 对文件内容打补丁 (无 IO, 便于单测)。
 * 策略 1 精确匹配; 策略 2 按行 + 空白容错匹配。
 */
export function applyTextPatch(
  original: string,
  oldString: string,
  newString: string,
  opts: PatchOptions = {},
): PatchOutcome {
  const oldStr = String(oldString ?? '');
  const newStr = String(newString ?? '');
  if (!oldStr) return { ok: false, error: 'old_string 必填 (不允许空匹配)' };
  if (oldStr === newStr) return { ok: false, error: 'old_string 与 new_string 相同, 无改动' };

  // ---- 策略 1: 精确匹配 ----
  const exactCount = countOccurrences(original, oldStr);
  if (exactCount === 1 || (exactCount > 1 && opts.replaceAll)) {
    const content = opts.replaceAll ? original.split(oldStr).join(newStr) : original.replace(oldStr, newStr);
    return {
      ok: true,
      content,
      strategy: 'exact',
      replacements: opts.replaceAll ? exactCount : 1,
      removedLines: oldStr.split('\n').length,
      addedLines: newStr.split('\n').length,
    };
  }
  if (exactCount > 1) {
    return {
      ok: false,
      error: `old_string 在文件中出现 ${exactCount} 次, 不唯一 — 请补足上下文行, 或设 replace_all=true 全部替换`,
    };
  }

  // ---- 策略 2: 按行 + 空白容错 ----
  const originalLines = original.split('\n');
  const targetLines = oldStr.split('\n');
  const needleLen = targetLines.map(normLine).filter((l) => l.length > 0).length;
  const hits = findNormalizedLineMatches(originalLines, targetLines);
  if (hits.length === 0) {
    return {
      ok: false,
      error: 'old_string 在文件中未找到 (精确匹配和空白容错匹配都失败). 请先 read_file 读最新内容, 不要凭记忆改文件',
    };
  }
  if (hits.length > 1 && !opts.replaceAll) {
    return {
      ok: false,
      error: `old_string 容错匹配命中 ${hits.length} 处, 不唯一 — 请补足上下文行, 或设 replace_all=true`,
    };
  }
  const targets = opts.replaceAll ? hits : [hits[0]];
  const outLines = [...originalLines];
  for (const start of [...targets].sort((a, b) => b - a)) {
    outLines.splice(start, needleLen, ...newStr.split('\n'));
  }
  return {
    ok: true,
    content: outLines.join('\n'),
    strategy: 'line-normalized',
    replacements: targets.length,
    removedLines: needleLen * targets.length,
    addedLines: newStr.split('\n').length * targets.length,
  };
}

/**
 * 注册 patch 工具。
 */
export function registerPatchTools(ctx: ToolRegistryContext): void {
  ctx.tools.set('patch', {
    name: 'patch',
    description: '精确修改文件: 把 old_string 唯一匹配处替换为 new_string。先精确匹配, 失败再按行 + 空白容错匹配 (容忍缩进/行尾空格差异)。匹配不唯一或找不到会拒绝写入, 绝不静默改错位置。改前自动暂存快照可撤销。',
    parameters: {
      path: '相对路径 (必填, 相对 cwd)',
      old_string: '要被替换的原文本 (必填, 需唯一匹配; 精确匹配优先)',
      new_string: '替换成的新文本 (必填, 传空字符串表示删除该段)',
      replace_all: '可选: "true" 表示匹配到多处时全部替换 (默认 false, 多处即拒绝)',
    },
    execute: async (args) => {
      const relPath = String(args.path || '').trim();
      const oldStr = String(args.old_string ?? '');
      const newStr = String(args.new_string ?? '');
      const replaceAll = String(args.replace_all ?? 'false').toLowerCase() === 'true';
      if (!relPath) return { success: false, error: 'path 必填' };
      if (!oldStr) return { success: false, error: 'old_string 必填' };
      const guard = checkWritePath(relPath);
      if (!guard.allowed) return { success: false, error: `路径被护栏拒: ${guard.reason}` };
      const absPath = path.resolve(ctx.cwd, relPath);
      let original: string;
      try {
        original = await fs.readFile(absPath, 'utf-8');
      } catch (e) {
        return { success: false, error: `读文件失败: ${String(e).slice(0, 200)}` };
      }
      const outcome = applyTextPatch(original, oldStr, newStr, { replaceAll });
      if (!outcome.ok) return { success: false, error: outcome.error };
      try {
        const { stageWrite } = await import('./write-staging.js');
        await stageWrite(relPath, original, outcome.content!, 'edit', ctx.cwd).catch(() => {});
        await fs.writeFile(absPath, outcome.content!, 'utf-8');
      } catch (e) {
        return { success: false, error: `写文件失败: ${String(e).slice(0, 200)}` };
      }
      return {
        success: true,
        output: `✅ patched ${relPath} (${outcome.strategy}, ${outcome.replacements} 处, +${outcome.addedLines ?? 0} -${outcome.removedLines ?? 0} 行)`,
      };
    },
  });
}
