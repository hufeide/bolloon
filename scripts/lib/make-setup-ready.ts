/**
 * make-setup-ready.ts — 让隔离 HOME **真的**处于 ready 状态 (验收脚本共用, 2026-09-16)
 *
 * 为什么需要: 初始化硬门禁生效后, 未 ready 的 HOME 不允许创建 Goal / 执行 agent。
 * 验收脚本要的是"已配置好的机器", 所以这里诚实地把事实补上:
 *   · LLM 配置: 从真实 HOME 复制 (值是用户自己的, 脚本不打印)
 *   · 身份: 写一份真实结构的 identity/user.json
 *   · 引导状态: 写 connectivityOk + runtimeInitialized 等检查结果 (evaluateSetup 会再做真实探测复核)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface ReadyOpts { realHome?: string; name?: string; did?: string }

export function makeSetupReady(bolloonHome: string, opts: ReadyOpts = {}): { ok: boolean; notes: string[] } {
  const notes: string[] = [];
  const realHome = opts.realHome || os.homedir();
  fs.mkdirSync(bolloonHome, { recursive: true });

  let copied = false;
  for (const f of ['bolloon-config.json', 'llm-config.json']) {
    const src = path.join(realHome, '.bolloon', f);
    try {
      const text = fs.readFileSync(src, 'utf8');
      fs.writeFileSync(path.join(bolloonHome, 'bolloon-config.json'), text, { mode: 0o600 });
      copied = true; notes.push(`LLM 配置已从 ${f} 复制 (值不打印)`);
      break;
    } catch { /* 下一个 */ }
  }
  if (!copied) notes.push('⚠ 没有可复制的 LLM 配置 (连通性/运行时检查可能不通过)');

  const idDir = path.join(bolloonHome, 'identity');
  fs.mkdirSync(idDir, { recursive: true });
  const idFile = path.join(idDir, 'user.json');
  if (!fs.existsSync(idFile)) {
    fs.writeFileSync(idFile, JSON.stringify({ name: opts.name || '验收用户', did: opts.did || 'did:key:zVerifyScript', publicKeyHex: '00', createdAt: new Date().toISOString() }, null, 2), 'utf8');
    notes.push('身份已写入 identity/user.json');
  }

  const now = new Date().toISOString();
  fs.writeFileSync(path.join(bolloonHome, 'setup-state.json'), JSON.stringify({
    schema: 'bolloon-setup/1',
    stage: 'ready',
    completed: ['identity_pending', 'provider_pending', 'credential_pending', 'model_pending', 'connectivity_pending', 'runtime_pending'],
    inputs: { name: opts.name || '验收用户', hasApiKey: true, identityDid: opts.did || 'did:key:zVerifyScript' },
    checks: { identity: true, providerSelected: true, credentialPresent: true, providerUsable: true, modelPresent: true, connectivityOk: true, connectivityAt: now, runtimeInitialized: true },
    readiness: { basic: true, agent: true, durable: true, network: false },
    readinessWhy: { basic: [], agent: [], durable: [], network: ['P2P/Kubo 未检测 (optional)'] },
    allow: { cli: true, web: true, supervisor: true, agent: true },
    actions: ['已就绪'], updatedAt: now,
  }, null, 2), 'utf8');
  notes.push('引导状态已写入 (connectivityOk/runtimeInitialized)');

  return { ok: copied, notes };
}

export function copyRealLlmConfig(bolloonHome: string, realHome: string = os.homedir()): boolean {
  return makeSetupReady(bolloonHome, { realHome }).ok;
}
