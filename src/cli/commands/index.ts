/**
 * index.ts — P3 命令组调度 (network / agent / task / wallet / payment / trade)
 *
 * 每个命令组只做两件事: 解析全局选项 (`--json`/`--quiet`/`--request-id`/`--timeout`),
 * 然后把活交给对应模块里的**薄包装**。业务逻辑一律不在这里, 也不在命令模块里重实现。
 */

import { parseFlags, runCommand } from '../protocol-envelope.js';
import { networkCommand } from './network.js';
import { agentCommand } from './agent.js';
import { taskCommand } from './tasks.js';
import { walletCommand } from './wallet.js';
import { paymentCommand } from './payment.js';
import { tradeCommand } from './trade.js';

/** P3 命令组名 (cli-entry 的 parseArgs 也认这些) */
export const SERVICE_GROUPS = ['network', 'agent', 'task', 'wallet', 'payment', 'trade'] as const;
export type ServiceGroup = (typeof SERVICE_GROUPS)[number];

export function isServiceGroup(mode: string): mode is ServiceGroup {
  return (SERVICE_GROUPS as readonly string[]).includes(mode);
}

export const GROUPS_HELP = `
命令组 (P3, 统一信封 { ok, code, message, data, evidence, next_action }):

  bolloon network   status | init | join [link] | peers | leave(未实现)
  bolloon agent     discover | register | manifest | inspect
  bolloon task      list | status | result | retry | run | send|inbox|accept|reject|complete|cancel(未实现)
  bolloon wallet    status | policy | set-policy
  bolloon payment   pending | approve | reject
  bolloon trade     list | show | events | reconcile

全局选项 (全命令组有效):
  --json                输出 §2 冻结信封 (失败也结构化: ok:false + code + next_action)
  --quiet               只输出结果 (payload 的 JSON)
  --request-id <id>     幂等键原样透传 (用在真实做幂等查找/派生的命令上)
  --timeout <ms>        硬超时; 超时给 code=TIMEOUT (不是"打印一行错误就退出")

判据永远是 ok / code, **不是**退出码; 也不要把 paid / delivered 读成成功
(local-dev 永远不是链上结算 —— 见 docs/wiki/access-protocol-v1.md §5)。
`;

/** 跑一个命令组, 返回进程退出码 (0=ok, 1=失败) */
export async function runServiceGroup(mode: string, args: string[]): Promise<number> {
  const flags = parseFlags(args);
  switch (mode) {
    case 'network': return runCommand(flags, networkCommand);
    case 'agent': return runCommand(flags, agentCommand);
    case 'task': return runCommand(flags, taskCommand);
    case 'wallet': return runCommand(flags, walletCommand);
    case 'payment': return runCommand(flags, paymentCommand);
    case 'trade': return runCommand(flags, tradeCommand);
    default:
      console.log(GROUPS_HELP);
      return 1;
  }
}
