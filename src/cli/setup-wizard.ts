/**
 * setup-wizard.ts — 初始化引导 + 模型供应商 API 配置流程
 *
 * 两个入口共用这一个模块:
 *   ① `bolloon setup`  首次运行向导: 用户称呼 → 供应商 → API key → 模型 → 连通性测试 → 落盘
 *   ② `bolloon model`  日常切换/查看/测试 (无参列表 / <provider> [model] / key <provider> / test)
 *
 * 设计要点:
 *   - API key 只在**隐藏输入**里收 (不回显、不回读、不写日志), 存 ~/.bolloon/bolloon-config.json (永不入 git)
 *   - 非交互模式 (--provider/--api-key/--model/--name) 供脚本/自动化用, 与交互式同一套写盘路径
 *   - 用户身份写 ~/.bolloon/identity/user.json (DID 首次生成后复用, 与 Web 端同一文件同一 schema)
 *   - io 可注入 → 单测不碰真实 stdin/stdout
 */

import * as readline from 'readline';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { llmConfigStore, PROVIDER_INFO, DEFAULT_PROVIDER_CONFIGS, type ModelProvider } from '../llm/config-store.js';

/** 向导推荐的供应商顺序 (第一个是最省事的国内直连) */
export const RECOMMENDED_PROVIDERS: ModelProvider[] = [
  'deepseek', 'minimax', 'openai', 'anthropic', 'openrouter', 'gemini',
  'kimi', 'glm', 'qwen', 'grok', 'mimo', 'ollama', 'local',
];

export interface WizardIO {
  print(line: string): void;
  /** hidden=true 时输入不回显 (API key 用) */
  ask(q: string, opts?: { hidden?: boolean; default?: string }): Promise<string>;
}

export function defaultWizardIO(): WizardIO {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return {
    print: (line: string) => { process.stdout.write(line + '\n'); },
    ask: (q: string, opts: { hidden?: boolean; default?: string } = {}) =>
      new Promise<string>((resolve) => {
        const prompt = `${q}${opts.default ? ` [${opts.default}]` : ''} `;
        if (!opts.hidden || !process.stdout.isTTY) {
          rl.question(prompt, (ans) => resolve(String(ans ?? '').trim()));
          return;
        }
        // 隐藏输入: 临时吞掉回显 (提示行本身仍要显示)
        const anyRl = rl as any;
        const orig = anyRl._writeToOutput?.bind(anyRl);
        anyRl._writeToOutput = function (s: string) { if (s.includes(q) || s.includes('[')) process.stdout.write(s); };
        rl.question(prompt, (ans) => {
          if (orig) anyRl._writeToOutput = orig;
          process.stdout.write('\n');
          resolve(String(ans ?? '').trim());
        });
      }),
    };
}

/** 一次性隐藏输入 (bolloon model key <provider> 用; 单独开 readline, 用完即关, 不回显) */
export async function askHiddenLine(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise<string>((resolve) => {
    const anyRl = rl as any;
    const orig = anyRl._writeToOutput?.bind(anyRl);
    anyRl._writeToOutput = function (s: string) { if (String(s).includes(question)) process.stdout.write(s); };
    rl.question(`${question} `, (ans) => {
      if (orig) anyRl._writeToOutput = orig;
      process.stdout.write('\n');
      rl.close();
      resolve(String(ans ?? '').trim());
    });
  });
}

// ---------------------------------------------------------------- 用户身份

export function getUserIdentityFile(home: string = os.homedir()): string {
  return path.join(home, '.bolloon', 'identity', 'user.json');
}

export interface UserIdentity {
  did: string;
  didShort?: string;
  publicKeyHex: string;
  name: string;
  createdAt?: string;
}

export async function readUserIdentity(home: string = os.homedir()): Promise<UserIdentity | null> {
  try {
    const raw = await fs.readFile(getUserIdentityFile(home), 'utf-8');
    const p = JSON.parse(raw);
    if (p && typeof p.did === 'string' && p.did) return p as UserIdentity;
    return null;
  } catch { return null; }
}

/**
 * 写用户身份 (没有就生成 DID, 有就只改名字)。返回是否新建。
 * 与 Web 端 /api/user/identity 同一文件、同一 schema。
 */
export async function writeUserIdentity(
  name: string,
  home: string = os.homedir(),
): Promise<{ identity: UserIdentity; created: boolean; file: string }> {
  const file = getUserIdentityFile(home);
  const clean = String(name || '').trim().slice(0, 40);
  const existing = await readUserIdentity(home);
  let identity: UserIdentity;
  let created = false;
  if (existing) {
    identity = { ...existing, name: clean || existing.name };
  } else {
    const { KeyManager } = await import('@diap/sdk');
    const kp = KeyManager.generate();
    identity = {
      did: kp.did,
      didShort: kp.did.split(':').pop()?.slice(0, 8),
      publicKeyHex: Buffer.from(kp.publicKey as any).toString('hex'),
      name: clean || 'bolloon-user',
      createdAt: new Date().toISOString(),
    };
    created = true;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(identity, null, 2), { encoding: 'utf-8', mode: 0o600 });
  return { identity, created, file };
}

// ---------------------------------------------------------------- 首次运行判断

function providerUsable(p: { enabled?: boolean; apiKey?: string; requiresApiKey?: boolean }): boolean {
  if (!p?.enabled) return false;
  if (p.apiKey) return true;
  return p.requiresApiKey === false;   // 本地模型 (ollama/local) 不需要 key
}

/** 首次运行: 没有可用供应商, 或还没有用户身份 */
export async function isFirstRun(home: string = os.homedir()): Promise<boolean> {
  try {
    await llmConfigStore.initialize();
    const cfg = await llmConfigStore.getConfig();
    const usable = Object.values(cfg.providers || {}).some((p: any) => providerUsable(p));
    if (!usable) return true;
    const user = await readUserIdentity(home);
    return !user;
  } catch {
    return false;   // 判断失败不阻塞启动
  }
}

// ---------------------------------------------------------------- 向导

export interface SetupOptions {
  interactive?: boolean;
  provider?: string;
  apiKey?: string;
  model?: string;
  name?: string;
  home?: string;
  io?: WizardIO;
  /** 跳过连通性测试 */
  skipTest?: boolean;
}

export interface SetupResult {
  ok: boolean;
  userName?: string;
  provider?: string;
  model?: string;
  identityFile?: string;
  identityCreated?: boolean;
  test?: { success: boolean; latency?: number; error?: string };
  error?: string;
}

/** 运行初始化向导 (交互式或参数式) */
export async function runSetupWizard(opts: SetupOptions = {}): Promise<SetupResult> {
  const io = opts.io ?? defaultWizardIO();
  const home = opts.home ?? os.homedir();
  const interactive = opts.interactive !== false;
  const P = (s: string) => io.print(s);

  try {
    await llmConfigStore.initialize();
  } catch (e: any) {
    return { ok: false, error: `读取配置失败: ${String(e?.message || e).slice(0, 200)}` };
  }

  P('');
  P('╭─ Bolloon 初始化 ─────────────────────────────╮');
  P('│ 三步: 你的称呼 → 模型供应商 → API key + 模型 │');
  P('╰──────────────────────────────────────────────╯');

  // ---- 1) 用户称呼 ----
  const existingUser = await readUserIdentity(home);
  let name = String(opts.name || '').trim();
  if (!name && interactive) {
    name = await io.ask('① 我该怎么称呼你?', { default: existingUser?.name || os.userInfo().username });
  }
  if (!name) name = existingUser?.name || os.userInfo().username;
  const idWrite = await writeUserIdentity(name, home);
  P(`   身份: ${idWrite.identity.name}${idWrite.created ? ' (已生成新 DID)' : ' (复用已有 DID)'}`);
  P(`   DID:  ${idWrite.identity.did.slice(0, 42)}...`);
  P(`   文件: ${idWrite.file}`);

  // ---- 2) 供应商 ----
  const cfg = await llmConfigStore.getConfig();
  const providers = cfg.providers as unknown as Record<string, any>;
  let provider = String(opts.provider || '').toLowerCase().trim();
  if (!provider && interactive) {
    P('');
    P('② 选一个模型供应商:');
    RECOMMENDED_PROVIDERS.forEach((p, i) => {
      const info = (PROVIDER_INFO as any)[p] || {};
      const st = providers[p];
      const mark = providerUsable(st) ? '🔑 已配置' : (st?.requiresApiKey === false ? '免 key' : '');
      P(`   ${String(i + 1).padStart(2)}. ${p.padEnd(11)} ${String(info.name || '').padEnd(16)} ${mark}`);
    });
    const ans = await io.ask('   序号或名字', { default: cfg.activeProvider });
    const idx = Number(ans);
    provider = Number.isFinite(idx) && idx >= 1 && idx <= RECOMMENDED_PROVIDERS.length
      ? RECOMMENDED_PROVIDERS[idx - 1]
      : ans.trim().toLowerCase();
  }
  if (!provider) provider = cfg.activeProvider;
  if (!providers[provider]) {
    return { ok: false, error: `未知供应商 '${provider}'. 可用: ${Object.keys(providers).join(', ')}` };
  }
  const info = (PROVIDER_INFO as any)[provider] || {};
  const current = providers[provider];
  const needsKey = current?.requiresApiKey !== false;

  // ---- 3) API key ----
  let apiKey = String(opts.apiKey || '').trim();
  if (!apiKey) apiKey = String(current?.apiKey || '').trim();     // 已配置的沿用
  if (!apiKey && needsKey && interactive) {
    P('');
    P(`③ ${info.name || provider} 需要 API key (输入不回显, 只写本地 ~/.bolloon/bolloon-config.json)`);
    apiKey = await io.ask(`   粘贴 ${provider} API key`, { hidden: true });
    if (!apiKey) P('   ⚠ 未输入 key — 该供应商会保持不可用 (可用 bolloon model key <provider> 之后再补)');
  }

  // ---- 4) 模型 ----
  const models: string[] = Array.isArray(info.models) ? info.models : [];
  let model = String(opts.model || '').trim();
  if (!model && interactive) {
    if (models.length > 0) P(`   可选模型: ${models.slice(0, 8).join(' / ')}`);
    model = await io.ask('④ 用哪个模型?', { default: current?.model || models[0] || '' });
  }
  if (!model) model = current?.model || models[0] || '';

  // ---- 5) 落盘 ----
  const patch: Record<string, any> = { enabled: true };
  if (apiKey) patch.apiKey = apiKey;
  if (model) patch.model = model;
  if (!current?.baseUrl) patch.baseUrl = (DEFAULT_PROVIDER_CONFIGS as any)[provider]?.baseUrl;
  await llmConfigStore.updateProvider(provider as ModelProvider, patch);
  const usableNow = apiKey || !needsKey;
  if (usableNow) {
    await llmConfigStore.setActiveProvider(provider as ModelProvider);
  }

  // ---- 6) 连通性测试 ----
  let test: SetupResult['test'];
  if (!opts.skipTest && usableNow) {
    P('');
    P('⑤ 测试连通性...');
    try {
      const r = await llmConfigStore.testProvider(provider as ModelProvider);
      test = { success: !!r.success, latency: r.latency, error: r.error };
      P(r.success ? `   ✅ 连通 (${r.latency ?? '?'} ms)` : `   ⚠ 未通过: ${String(r.error || '').slice(0, 160)}`);
    } catch (e: any) {
      test = { success: false, error: String(e?.message || e).slice(0, 200) };
      P(`   ⚠ 测试失败: ${test.error}`);
    }
  }

  P('');
  P(`✅ 配置完成 — 当前供应商: ${provider}${model ? `, 模型: ${model}` : ''}`);
  P(`   配置文件: ${path.join(home, '.bolloon', 'bolloon-config.json')}`);
  P('   开始对话: bolloon --cli');
  P('');
  return {
    ok: true,
    userName: idWrite.identity.name,
    provider,
    model,
    identityFile: idWrite.file,
    identityCreated: idWrite.created,
    test,
  };
}

// ---------------------------------------------------------------- /model 命令

/** 配置状态一览 (供 CLI 会话内 /model 与 bolloon model 共用) */
export async function formatProviderStatus(): Promise<string> {
  await llmConfigStore.initialize();
  const cfg = await llmConfigStore.getConfig();
  const providers = cfg.providers as unknown as Record<string, any>;
  const lines: string[] = [`模型供应商 (当前: ${cfg.activeProvider})`];
  for (const p of RECOMMENDED_PROVIDERS) {
    const st = providers[p];
    if (!st) continue;
    const info = (PROVIDER_INFO as any)[p] || {};
    const active = p === cfg.activeProvider ? '●' : '○';
    const keyState = st.apiKey ? '🔑' : (st.requiresApiKey === false ? '免key' : '—');
    const flag = providerUsable(st) ? '' : ' (未启用)';
    lines.push(`  ${active} ${p.padEnd(11)} ${String(info.name || '').padEnd(16)} ${keyState.padEnd(6)} model: ${st.model || '(默认)'}${flag}`);
  }
  lines.push('用法: /model <provider> [model] 切换 · /model test [provider] 测连通 · /model status 状态');
  return lines.join('\n');
}

export interface ModelCommandIO {
  /** 需要收 API key 时使用的隐藏输入 (会话内没有此能力 → 不传) */
  askHidden?: (q: string) => Promise<string>;
}

/**
 * `/model` / `bolloon model` 命令实现。
 * 参数为空 = 状态; `<provider> [model]` = 切换; `test [provider]` = 测试; `key <provider>` = 设 key。
 */
export async function runModelCommand(arg: string, io: ModelCommandIO = {}): Promise<string> {
  const parts = String(arg || '').trim().split(/\s+/).filter(Boolean);
  await llmConfigStore.initialize();

  if (parts.length === 0 || parts[0] === 'status' || parts[0] === 'list') {
    return formatProviderStatus();
  }

  const sub = parts[0].toLowerCase();

  // key <provider> [key]
  if (sub === 'key' || sub === 'auth') {
    const provider = (parts[1] || '').toLowerCase();
    if (!provider) return '用法: /model key <provider> (随后会提示粘贴 API key, 输入不回显)';
    const cfg = await llmConfigStore.getConfig();
    if (!(cfg.providers as any)[provider]) return `未知供应商 '${provider}'. 可用: ${Object.keys(cfg.providers).join(', ')}`;
    let key = parts[2] || '';
    if (!key) {
      if (!io.askHidden) {
        return [
          `在会话内不收取 API key (避免留在会话记录里)。请在系统终端执行:`,
          `  bolloon model key ${provider}`,
          `或打开 Web 配置页 (bolloon --web) 填 key。`,
        ].join('\n');
      }
      key = await io.askHidden(`粘贴 ${provider} API key`);
    }
    if (!key) return '未输入 key, 未改动配置';
    await llmConfigStore.updateProvider(provider as ModelProvider, { enabled: true, apiKey: key });
    await llmConfigStore.setActiveProvider(provider as ModelProvider);
    const tail = key.slice(-4);
    return `✅ 已配置并启用 ${provider} (key 尾号 ****${tail}, 已写入 ~/.bolloon/bolloon-config.json, 不会进 git)`;
  }

  // test [provider]
  if (sub === 'test') {
    const provider = (parts[1] || (await llmConfigStore.getActiveProvider())).toLowerCase();
    const r = await llmConfigStore.testProvider(provider as ModelProvider);
    return r.success
      ? `✅ ${provider} 连通 (${r.latency ?? '?'} ms)`
      : `⚠ ${provider} 测试失败: ${String(r.error || '').slice(0, 300)}`;
  }

  // <provider> [model]
  const provider = sub;
  const cfg = await llmConfigStore.getConfig();
  const st = (cfg.providers as any)[provider];
  if (!st) return `未知供应商 '${provider}'. 可用: ${Object.keys(cfg.providers).join(', ')}`;
  if (st.requiresApiKey !== false && !st.apiKey) {
    return `${provider} 还没有 API key — 用 /model key ${provider} 配置 (或 bolloon setup 走向导)`;
  }
  const patch: Record<string, any> = { enabled: true };
  if (parts[1]) patch.model = parts[1];
  await llmConfigStore.updateProvider(provider as ModelProvider, patch);
  await llmConfigStore.setActiveProvider(provider as ModelProvider);
  return `✅ 已切换到 ${provider}${parts[1] ? ` (model=${parts[1]})` : ''}`;
}
