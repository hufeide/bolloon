/**
 * copyright-source-scope.ts — 「哪些源码进登记材料 + 按功能主次怎么排」的单一定义
 *
 * 源程序材料生成器用它取行; 文档材料的「模块清单」附录也用它取同一份事实 ——
 * 两处口径必须一致, 否则文档说的模块数和源程序材料收录的文件数会对不上。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { ROOT } from './copyright-common.js';

export interface Tier {
  /** 档位说明 (进审计报告, 说明为什么这些代码排在前面/后面) */
  name: string;
  /** 收录的目录前缀 (相对 src/), 档内按路径升序 */
  dirs: string[];
  /** 显式置底的文件 (相对仓库根), 从 dirs 结果里摘出后按此顺序排在档尾 */
  tailFiles?: string[];
}

/** 功能主次: 程序入口 → 内核 → 网络 → 交互层 (末档置底 client.ts, 让「后 30 页」落在前端主逻辑) */
export const TIERS: Tier[] = [
  { name: '① 程序入口与类型声明 (命令分发 / 启动参数)', dirs: [], tailFiles: ['src/index.ts', 'src/cli-entry.ts', 'src/types.d.ts'] },
  { name: '② 启动引导与初始化 (session / context-os / 记忆装配)', dirs: ['bootstrap/'] },
  { name: '③ 智能体核心引擎 (ReAct 循环 / 工具注册 / 会话)', dirs: ['agents/'] },
  { name: '④ 生态扩展协议 (goals / judgment / mcp / subagents / a2ui)', dirs: ['pi-ecosystem/', 'pi-ecosystem-a2ui/', 'pi-ecosystem-colony/', 'pi-ecosystem-goals/', 'pi-ecosystem-judgment/', 'pi-ecosystem-mcp/', 'pi-ecosystem-subagents/', 'bollharness-integration/'] },
  { name: '⑤ 大模型接入与上下文压缩', dirs: ['llm/', 'context-compaction/'] },
  { name: '⑥ 约束层 / 安全闸门 / 钩子', dirs: ['constraints/', 'security/', 'hooks/'] },
  { name: '⑦ P2P 网络与身份 (DHT / DID / 社交与网关)', dirs: ['network/', 'orbitdb/', 'social/', 'git-transport/'] },
  { name: '⑧ 存储与运行态 (setup / cron / 心跳)', dirs: ['storage/', 'setup/', 'cron/', 'heartbeat/'] },
  { name: '⑨ 文档与知识处理 (reader / 判断 / 工作流 / LSP)', dirs: ['documents/', 'judgeness/', 'workflows/', 'lsp/', 'external-engines/', 'migration/', 'locales/', 'utils/', 'scripts/'] },
  { name: '⑩ 命令行界面与桌面外壳 (Ink TUI / Electron)', dirs: ['cli/', 'electron/'], tailFiles: ['src/electron.ts', 'src/electron-preload.ts'] },
  { name: '⑪ 自研运行时包 (@bolloon/constraint-runtime)', dirs: ['constraint-runtime/src/'] },
  { name: '⑫ Web 服务端与接口 / 交互层', dirs: ['web/'], tailFiles: ['src/web/mobile.js', 'src/web/client.ts'] }
];

const INCLUDE_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.css', '.html']);

/** 排除前缀 (测试 / 第三方 vendored / 构建产物) */
export const EXCLUDE_PREFIXES = [
  'src/test/',
  'src/bollharness/',
  'src/constraint-runtime/dist/',
  'src/constraint-runtime/node_modules/',
  'src/constraint-runtime/tests/'
];

/** 文件名级排除 */
export const EXCLUDE_SUFFIX = ['.test.ts', '.test.tsx', '.spec.ts', '.bak', '.min.js'];

export function isExcluded(rel: string): boolean {
  if (EXCLUDE_PREFIXES.some((p) => rel.startsWith(p))) return true;
  if (EXCLUDE_SUFFIX.some((s) => rel.endsWith(s))) return true;
  if (rel.includes('/node_modules/') || rel.includes('/dist/')) return true;
  return false;
}

/** 递归列出 src/ 下的候选源文件 (相对仓库根, 用 / 分隔, 升序) */
export function listSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (absDir: string): void => {
    for (const entry of readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(absDir, entry.name);
      const rel = relative(ROOT, abs).split(sep).join('/');
      if (entry.isDirectory()) {
        if (isExcluded(rel + '/')) continue;
        walk(abs);
      } else if (INCLUDE_EXT.has(entry.name.slice(entry.name.lastIndexOf('.')))) {
        if (!isExcluded(rel)) out.push(rel);
      }
    }
  };
  walk(join(ROOT, 'src'));
  return out.sort();
}

/** 按功能主次重排文件清单 */
export function orderFiles(all: string[]): Array<{ tier: string; path: string }> {
  const remaining = new Set(all);
  const ordered: Array<{ tier: string; path: string }> = [];

  for (const tier of TIERS) {
    const tails = (tier.tailFiles ?? []).filter((p) => remaining.has(p));
    for (const p of tails) remaining.delete(p);
    for (const dir of tier.dirs) {
      const prefix = `src/${dir}`;
      for (const p of [...remaining].filter((f) => f.startsWith(prefix)).sort()) {
        remaining.delete(p);
        ordered.push({ tier: tier.name, path: p });
      }
    }
    for (const p of tails) ordered.push({ tier: tier.name, path: p });
  }

  // 兜底: 没被任何档位匹配到的文件 (新增目录) 追加在末尾, 不能静默丢源码
  for (const p of [...remaining].sort()) ordered.push({ tier: '⑬ 未归类 (新增目录, 报告里会显式列出)', path: p });
  return ordered;
}

export interface SourceFileStat {
  path: string;
  tier: string;
  /** 源文件原始行数 */
  rawLines: number;
  /** 去掉空行后的有效行数 (登记材料按这个算) */
  rows: number;
  bytes: number;
}

/** 一次拿到: 排序后的文件清单 + 逐文件行数 (源程序材料与文档附录共用同一份事实) */
export function collectSourceStats(): { ordered: Array<{ tier: string; path: string }>; stats: SourceFileStat[] } {
  const ordered = orderFiles(listSourceFiles());
  const stats: SourceFileStat[] = ordered.map((f) => {
    const abs = join(ROOT, f.path);
    const text = readFileSync(abs, 'utf8').replace(/^\uFEFF/, '');
    const rawLines = text.split(/\r\n|\r|\n/).length;
    const rows = text.split(/\r\n|\r|\n/).filter((l) => l.trim().length > 0).length;
    return { path: f.path, tier: f.tier, rawLines, rows, bytes: statSync(abs).size };
  });
  return { ordered, stats };
}