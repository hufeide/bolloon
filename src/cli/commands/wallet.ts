/**
 * wallet.ts — P3 `bolloon wallet status|policy|set-policy`
 *
 * 薄包装 (不重实现):
 *   status     → 读 `~/.bolloon/wallet.json` (**只读**; 绝不为了看一眼状态就创建钱包) + `economic-policy` 配置 + 签名审计账本摘要
 *   policy     → `economic-policy.LocalEconomicPolicy` (load 后读 config/dailySpent)
 *   set-policy → 同上 + `updateConfig()` + 落盘 (`~/.bolloon/economic-policy.json`)
 *
 * 红线 (P1 §5.5 / §5.6): **私钥绝不进 stdout/日志**; 审计账本只输出摘要字段。
 * 这里**不做签名**、**不代付款**: 放行闸是 `task-contract.authorizeWalletSignature` (fail-closed), 私钥不流经它。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  type CliFlags, type CommandResult, okEnvelope, failEnvelope,
  line, title, hint, plain, opt, optAll,
} from '../protocol-envelope.js';

export const WALLET_USAGE = `
${title('bolloon wallet')}
  bolloon wallet status [--json]               钱包可用性 + 策略 + 最近签名审计 (只读; 不创建钱包)
  bolloon wallet policy [--json]               当前支付策略 (单笔/日限额/白名单/速率)
  bolloon wallet set-policy --per-tx 1 --daily 10 [--allow-service research] [--allow-recipient 0x..] [--rate-limit 5]

选项: --json · --quiet · --request-id <id> · --timeout <ms>
`;

const walletFile = (): string => path.join(process.env.HOME || os.homedir(), '.bolloon', 'wallet.json');

/**
 * 只读探测钱包 (不创建)。存在性检查与地址读取都走文件, 不调 `loadOrCreateWallet`
 * —— 那是**写路径** (没有就生成新钱包), 不该被一条 status 查询触发。
 */
function readWallet(): { present: boolean; address: string | null; error?: string } {
  const f = walletFile();
  if (!fs.existsSync(f)) return { present: false, address: null };
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const addr = typeof j?.address === 'string' && j.address ? j.address : null;
    // ★ 私钥连读都不往外带 (它只在本机进程里用)
    return { present: !!addr, address: addr };
  } catch (e: any) {
    return { present: false, address: null, error: `wallet.json 读不出来: ${String(e?.message || e).slice(0, 120)}` };
  }
}

/** 策略读取: 用类实例 + 显式 await load (getEconomicPolicy() 的 load 是不 await 的, 一次性 CLI 会读到默认值) */
async function loadPolicy(): Promise<import('../../agents/economic-policy.js').LocalEconomicPolicy> {
  const { LocalEconomicPolicy } = await import('../../agents/economic-policy.js');
  const p = new LocalEconomicPolicy();
  // 注意 (如实标注): load() 内含 resetIfNewDay() → 跨天时会**落盘**一份默认配置
  // (`~/.bolloon/economic-policy.json`)。这是既有服务自身的行为 (Runtime 每次读策略也一样), 不是 CLI 另加的写。
  await p.load();
  return p;
}

export async function walletCommand(flags: CliFlags): Promise<CommandResult> {
  const sub = flags.positionals[0];
  switch (sub) {
    case 'status': return walletStatus(flags);
    case 'policy': return walletPolicy(flags);
    case 'set-policy': return walletSetPolicy(flags);
    default:
      return {
        envelope: failEnvelope('INVALID_ARGUMENT', sub ? `未知 wallet 子命令: ${sub}` : '缺少 wallet 子命令', { usage: plain(WALLET_USAGE.trim()) }, [], 'needs_human'),
        human: WALLET_USAGE,
      };
  }
}

async function walletStatus(flags: CliFlags): Promise<CommandResult> {
  const w = readWallet();
  const policy = await loadPolicy();
  const cfg = policy.config();
  const spent = await policy.dailySpent();
  const { readSignatureAudit } = await import('../../agents/task-contract.js');
  const audit = await readSignatureAudit(undefined, 5);

  const data = {
    walletAvailable: w.present,
    address: w.address,                       // 公开地址 (收款用); **私钥永不出现**
    privateKeyPrinted: false,
    walletFile: '~/.bolloon/wallet.json',
    readOnly: true,
    walletFileError: w.error || null,
    policy: {
      perTransactionLimit: cfg.perTransactionLimit,
      dailyLimit: cfg.dailyLimit,
      allowedRecipients: cfg.allowedRecipients,
      allowedServices: cfg.allowedServices,
      rateLimitPerMinute: cfg.rateLimitPerMinute,
      dailySpent: spent,
      source: '~/.bolloon/economic-policy.json (缺文件 = 保守默认值)',
    },
    signatureAudit: {
      file: '~/.bolloon/wallet-signatures.jsonl',
      recent: audit.map((a) => ({ at: a.at, kind: a.kind, mode: a.mode, requestId: a.requestId, taskId: a.taskId || null, signerFingerprint: a.signerFingerprint })),
    },
  };
  const human = [
    title('bolloon wallet status'),
    line('钱包可用', w.present ? '是 (地址已就绪)' : '否 —— 本机还没有钱包 (首次 x402 付款时自动生成)'),
    ...(w.address ? [line('地址', w.address)] : []),
    line('私钥', '未输出 (只在本机进程可用; 这条命令是只读的)'),
    line('单笔上限', `${cfg.perTransactionLimit} USDC`),
    line('日限额', `${cfg.dailyLimit} USDC (今日已用 ${spent})`),
    line('白名单', `收款方 ${cfg.allowedRecipients.length ? cfg.allowedRecipients.join(', ') : '(全部)'} · 服务 ${cfg.allowedServices.length ? cfg.allowedServices.join(', ') : '(全部)'}`),
    line('速率', `${cfg.rateLimitPerMinute}/min`),
    line('签名审计', `${audit.length} 条 (最近; 只给摘要, 无正文/无私钥)`),
    ...(w.error ? [line('说明', w.error)] : []),
  ].join('\n');
  if (!w.present) {
    // §3 WALLET_UNAVAILABLE (放行闸 walletAvailable=false): 说清现状与下一步, 不编造地址
    return {
      envelope: failEnvelope('WALLET_UNAVAILABLE', '本机还没有可用钱包 (wallet.json 不存在或不可读)', data, [], 'needs_human'),
      human: `${human}\n\n${hint('下一步: 钱包在首次 x402 付款时自动生成 (~/.bolloon/wallet.json, 0600); 或 bolloon model / bolloon setup 先跑一遍初始化。策略见 bolloon wallet policy')}`,
    };
  }
  return {
    envelope: okEnvelope('OK', `钱包可用 (${String(w.address).slice(0, 10)}…), 策略: 单笔 ≤ ${cfg.perTransactionLimit} / 日 ≤ ${cfg.dailyLimit}`, data, w.address ? [String(w.address)] : [], null),
    human,
  };
}

async function walletPolicy(flags: CliFlags): Promise<CommandResult> {
  const policy = await loadPolicy();
  const cfg = policy.config();
  const spent = await policy.dailySpent();
  const data = { ...cfg, dailySpent: spent, source: '~/.bolloon/economic-policy.json (缺文件 = 保守默认值)' };
  return {
    envelope: okEnvelope('OK', `支付策略: 单笔 ≤ ${cfg.perTransactionLimit}, 日 ≤ ${cfg.dailyLimit} (今日已用 ${spent})`, data, [], null),
    human: [
      title('bolloon wallet policy'),
      line('单笔上限', `${cfg.perTransactionLimit} USDC`),
      line('每日预算', `${cfg.dailyLimit} USDC (今日已用 ${spent})`),
      line('允许收款方', cfg.allowedRecipients.length ? cfg.allowedRecipients.join(', ') : '(全部)'),
      line('允许服务', cfg.allowedServices.length ? cfg.allowedServices.join(', ') : '(全部)'),
      line('速率', `${cfg.rateLimitPerMinute}/min`),
      `\n  ${hint('改: bolloon wallet set-policy --per-tx 1 --daily 10 [--allow-service research]')}`,
    ].join('\n'),
  };
}

async function walletSetPolicy(flags: CliFlags): Promise<CommandResult> {
  const patch: Record<string, unknown> = {};
  const perTx = opt(flags, '--per-tx');
  const daily = opt(flags, '--daily');
  const rate = opt(flags, '--rate-limit');
  const recipients = optAll(flags, '--allow-recipient');
  const services = optAll(flags, '--allow-service');
  if (perTx !== undefined) patch.perTransactionLimit = Number(perTx);
  if (daily !== undefined) patch.dailyLimit = Number(daily);
  if (rate !== undefined) patch.rateLimitPerMinute = Number(rate);
  if (recipients.length) patch.allowedRecipients = recipients;
  if (services.length) patch.allowedServices = services;

  if (!Object.keys(patch).length) {
    return {
      envelope: failEnvelope('INVALID_ARGUMENT', '没有要改的字段', { usage: plain(WALLET_USAGE.trim()), accepted: ['--per-tx', '--daily', '--rate-limit', '--allow-recipient', '--allow-service'] }, [], 'needs_human'),
      human: `${WALLET_USAGE}\n${hint('示例: bolloon wallet set-policy --per-tx 0.05 --daily 0.1 --allow-service research')}`,
    };
  }
  const bad = Object.entries(patch).filter(([, v]) => typeof v === 'number' && !Number.isFinite(v as number));
  if (bad.length) {
    return {
      envelope: failEnvelope('INVALID_ARGUMENT', `数值不合法: ${bad.map(([k]) => k).join(', ')}`, { patch }, [], 'needs_human'),
      human: `${title('bolloon wallet set-policy')}\n  数值不合法: ${bad.map(([k]) => k).join(', ')}`,
    };
  }

  const policy = await loadPolicy();
  const before = policy.config();
  policy.updateConfig(patch as any);
  await policy.save();                       // 落盘: 与 recordSpend/resetIfNewDay 同一份文件格式
  const after = policy.config();
  const spent = await policy.dailySpent();
  const data = { before, after, changed: patch, dailySpent: spent, file: '~/.bolloon/economic-policy.json', sourceCommand: 'economic-policy.LocalEconomicPolicy.updateConfig + save' };
  return {
    envelope: okEnvelope('POLICY_UPDATED', `策略已更新: 单笔 ≤ ${after.perTransactionLimit}, 日 ≤ ${after.dailyLimit}`, data, [], null),
    human: [
      title('bolloon wallet set-policy'),
      line('单笔上限', `${before.perTransactionLimit} → ${after.perTransactionLimit}`),
      line('每日预算', `${before.dailyLimit} → ${after.dailyLimit}`),
      line('速率', `${before.rateLimitPerMinute} → ${after.rateLimitPerMinute}/min`),
      line('允许收款方', after.allowedRecipients.length ? after.allowedRecipients.join(', ') : '(全部)'),
      line('允许服务', after.allowedServices.length ? after.allowedServices.join(', ') : '(全部)'),
      line('落地文件', '~/.bolloon/economic-policy.json'),
      `\n  ${hint('注意: 这是系统级闸门; 任务级闸门 (M1 0.05/0.02/0.10) 独立生效, 两层都过才放行')}`,
    ].join('\n'),
  };
}
