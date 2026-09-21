/**
 * mcp.ts — P4 `bolloon mcp serve` (MCP 适配层入口)
 *
 * 只有三条子命令:
 *   serve  启动 stdio MCP server (给 Claude Code / Cursor / 任何 MCP 客户端接)
 *   tools  列出本次暴露的 tools / resources 清单 (验收/排查用; 不改任何状态)
 *   help   帮助
 *
 * 硬要求: `serve` 期间 **stdout 只走 JSON-RPC** —— 所以这里把 console.log/info/debug/warn
 * 改道到 stderr (任何被包服务顺手打的日志都不许污染协议流)。
 */

import { serveStdio, inventory } from '../mcp/server.js';
import { NOT_EXPOSED } from '../mcp/tools.js';
import { title } from '../protocol-envelope.js';

export const MCP_USAGE = `
${title('bolloon mcp')}
  bolloon mcp serve            启动 MCP server (stdio; 只调 P3 命令/服务层, 不复制业务逻辑)
  bolloon mcp tools [--json]   列出暴露的 tools / resources (只读清单)
  bolloon mcp help             本帮助

接入客户端 (示例, 放进 MCP 配置):
  { "mcpServers": { "bolloon": { "command": "bolloon", "args": ["mcp", "serve"] } } }

判据永远是信封里的 ok/code (失败也返回信封 + isError=true), 不是退出码;
不返回私钥/助记词 · 不绕过 payment policy · 不改交易历史 · 不伪造 verified · 无授权不切自主支付。
`;

/** 把 console.log 一类的"顺手日志"改道 stderr, 保护 stdout 的 JSON-RPC 流 */
function protectStdout(): void {
  const toStderr = (...a: unknown[]) => {
    const s = a.map((x) => {
      if (typeof x === 'string') return x;
      try { return JSON.stringify(x); } catch { return String(x); }
    }).join(' ');
    process.stderr.write(`${s}\n`);
  };
  console.log = toStderr as typeof console.log;
  console.info = toStderr as typeof console.info;
  console.debug = toStderr as typeof console.debug;
  console.warn = toStderr as typeof console.warn;
}

export async function runMcpCommand(args: string[]): Promise<number> {
  const sub = args[0];
  switch (sub) {
    case 'serve':
    case 'server':
      return mcpServe(args.slice(1));
    case 'tools':
    case 'list':
      return mcpTools(args.slice(1));
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(MCP_USAGE);
      return sub === undefined ? 1 : 0;
    default:
      console.log(`未知 mcp 子命令: ${sub}`);
      console.log(MCP_USAGE);
      return 1;
  }
}

async function mcpServe(rest: string[]): Promise<number> {
  if (rest.includes('--help') || rest.includes('-h')) {
    console.log(MCP_USAGE);
    return 0;
  }
  if (rest.length) {
    console.error(`bolloon mcp serve 不接受参数 (收到: ${rest.join(' ')}) —— 所有调用都走 JSON-RPC (stdio)`);
    return 1;
  }
  protectStdout();
  return serveStdio();
}

function mcpTools(rest: string[]): number {
  const inv = inventory();
  if (rest.includes('--json')) {
    console.log(JSON.stringify(inv, null, 2));
    return 0;
  }
  console.log(`\nbolloon mcp (server ${inv.server.name}@${inv.server.version}, MCP ${inv.server.protocolVersions[0]})`);
  console.log(`\n  工具 (${inv.tools.length}, 每个 = 一条 P3 子命令的薄包装):`);
  for (const t of inv.tools) console.log(`    · ${t.name.padEnd(28)} ${t.title}  [${t.params.join(', ')}]`);
  console.log(`\n  资源 (${inv.resources.length}):`);
  for (const r of inv.resources) console.log(`    · ${r.uri.padEnd(30)} ${r.name}`);
  console.log('\n  **刻意不暴露** (暴露就得在 MCP 层假装成功):');
  for (const n of NOT_EXPOSED) console.log(`    · ${n.command}\n      ${n.reason}`);
  console.log('');
  return 0;
}
