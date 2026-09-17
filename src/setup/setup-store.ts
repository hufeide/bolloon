/**
 * setup-store.ts — 初始化的**唯一事实来源** (2026-09-16, M0/M1)
 *
 * 现状问题 (修的就是这些):
 *   - `isFirstRun()` 出错时 `return false` → 初始化判断失败被当成"不需要初始化" (fail-open);
 *   - 启动处向导失败只 `console.warn` 后继续 → 半成品配置也能进运行态;
 *   - CLI 有向导、Web 没有统一首启流程;`config-store` 在模块加载时固定 HOME;
 *   - 没有任何一处能回答"现在初始化到哪一步、为什么停、下一步是什么、重启后从哪继续"。
 *
 * 这一层只做三件事:
 *   ① 冻结初始化状态机 (M0) 并把状态落 `~/.bolloon/setup-state.json`;
 *   ② 汇总各领域事实来源的 readiness (身份 / LLM / 模型 / 连通性 / 运行时 / Skills / Supervisor),
 *      **不新增重复配置库** —— 身份仍看 user.json, LLM 仍看 llm-config.json, 技能看 skills-registry.json;
 *   ③ 给启动层一个确定性门禁 (ready / setup / repair / blocked), 未 ready 绝不执行 Agent。
 *
 * 与 Hermes 对齐的经验 (可迁移部分): 分段 step + 可回退重放、`--reconfigure` 只补缺失项、
 * readiness 分层摘要、"managed vs provider" 要说清来源。
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';

// ─────────────────────────────────────────────────────────────────────────────
// 路径统一 (M1): 所有入口都走这一个解析, 不在模块顶层永久缓存 HOME
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 解析 Bolloon 配置根目录。优先级: `BOLLOON_HOME` 环境变量 > `~/.bolloon`。
 * 每次调用都重新读环境变量 —— 独立 Supervisor 宿主 / 测试注入 HOME / 长驻进程都不会拿到过期路径。
 */
export function resolveBolloonHome(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const explicit = env.BOLLOON_HOME?.trim();
  if (explicit) return explicit;
  return path.join(env.HOME || home, '.bolloon');
}

export function setupStatePath(bolloonHome: string = resolveBolloonHome()): string {
  return path.join(bolloonHome, 'setup-state.json');
}

// ─────────────────────────────────────────────────────────────────────────────
// M0: 初始化状态机
// ─────────────────────────────────────────────────────────────────────────────

export const SETUP_STAGES = [
  'uninitialized',
  'identity_pending',
  'provider_pending',
  'credential_pending',
  'model_pending',
  'connectivity_pending',
  'runtime_pending',
  'ready',
] as const;

export type SetupStage = typeof SETUP_STAGES[number];
/** 异常状态: 配置坏了要修 / 被硬阻塞 (缺必需项且不能自动继续) */
export type SetupFaultStage = 'needs_repair' | 'blocked';

export type ErrorClass = 'config' | 'auth' | 'network' | 'timeout' | 'io' | 'model' | 'runtime' | 'unknown';

export interface SetupReadiness {
  /** 身份 + LLM + session 可用 (普通对话能跑) */
  basic: boolean;
  /** Harness + Skills 可用 (agent 能力完整) */
  agent: boolean;
  /** RunStore + GoalStore + Supervisor 可用 (长期执行) */
  durable: boolean;
  /** P2P / Kubo 可用 (可选, 不阻塞基础对话) */
  network: boolean;
}

export interface SetupState {
  schema: 'bolloon-setup/1';
  stage: SetupStage | SetupFaultStage;
  /** 已完成的阶段 (顺序保留) */
  completed: SetupStage[];
  /** 本轮已保存的输入 (**永不存 apiKey 明文**, 只记"有没有") */
  inputs: {
    name?: string;
    provider?: string;
    model?: string;
    hasApiKey?: boolean;
    identityDid?: string;
  };
  checks: {
    identity?: boolean;
    providerUsable?: boolean;
    modelPresent?: boolean;
    connectivityOk?: boolean;
    connectivityAt?: string;
    runtimeInitialized?: boolean;
    skillsOk?: boolean;
    supervisorResolvable?: boolean;
  };
  readiness: SetupReadiness;
  /** 未 ready 时各入口是否允许运行 (启动硬门禁的事实) */
  allow: { cli: boolean; web: boolean; supervisor: boolean; agent: boolean };
  lastError?: { at: string; stage: string; errorClass: ErrorClass; message: string };
  lastAttemptAt?: string;
  /** 可恢复动作 (人话, 给 CLI/Web 直接展示) */
  actions: string[];
  configVersion?: number;
  configHash?: string;
  updatedAt: string;
}

export const SETUP_STATE_VERSION = 1 as const;

export function emptySetupState(now = new Date()): SetupState {
  return {
    schema: 'bolloon-setup/1',
    stage: 'uninitialized',
    completed: [],
    inputs: {},
    checks: {},
    readiness: { basic: false, agent: false, durable: false, network: false },
    allow: { cli: true, web: false, supervisor: false, agent: false },
    actions: ['运行 `bolloon setup` 完成初始化 (身份 → 供应商 → 密钥 → 模型 → 连通性 → 运行时)'],
    updatedAt: now.toISOString(),
  };
}

export async function readSetupState(bolloonHome: string = resolveBolloonHome()): Promise<SetupState | null> {
  try {
    const raw = JSON.parse(await fs.readFile(setupStatePath(bolloonHome), 'utf8')) as SetupState;
    if (raw && raw.schema === 'bolloon-setup/1') return raw;
    return null;
  } catch {
    return null;
  }
}

/** 原子写 (临时文件 + rename): 半份状态文件比没有状态文件更危险 */
export async function writeSetupState(state: SetupState, bolloonHome: string = resolveBolloonHome()): Promise<void> {
  await fs.mkdir(bolloonHome, { recursive: true });
  const p = setupStatePath(bolloonHome);
  const tmp = `${p}.tmp`;
  const next = { ...state, updatedAt: new Date().toISOString() };
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
  await fs.rename(tmp, p);
}

/** 配置 content hash (用于判断"配置变过没有", 不碰密钥值) */
export async function hashConfigFiles(bolloonHome: string = resolveBolloonHome()): Promise<{ hash: string; version?: number }> {
  const files = ['llm-config.json', 'bolloon-config.json', 'user.json'];
  const h = crypto.createHash('sha256');
  let version: number | undefined;
  for (const f of files) {
    try {
      const buf = await fs.readFile(path.join(bolloonHome, f));
      h.update(f).update('\0').update(buf);
      if (f === 'bolloon-config.json') {
        try { version = Number(JSON.parse(buf.toString('utf8'))?.version) || undefined; } catch { /* 无版本字段 */ }
      }
    } catch { /* 缺文件也算进指纹 (缺失本身是状态) */ h.update(f).update('\0').update('<missing>'); }
  }
  return { hash: h.digest('hex').slice(0, 32), version };
}

// ─────────────────────────────────────────────────────────────────────────────
// 评估: 汇总各领域事实来源 (不新增配置库)
// ─────────────────────────────────────────────────────────────────────────────

export interface EvaluateOptions {
  bolloonHome?: string;
  /** 注入: 家目录是否可写 (测试) */
  homeWritableProbe?: () => Promise<boolean>;
  /** 跳过可能昂贵的检查 (Web 首启/诊断用) */
  light?: boolean;
  /** 注入: LLM 配置 (测试) */
  readLlmConfig?: () => Promise<any>;
  /** 注入: 身份 (测试) */
  readIdentity?: () => Promise<{ did?: string; name?: string } | null>;
  /** 注入: 技能健康 (测试) */
  readSkills?: () => Promise<{ total: number; invalid: number } | null>;
  /** 注入: 运行时是否已 initMinimax (测试) */
  runtimeReady?: () => Promise<boolean>;
  /** 连通性结果的有效期 (默认 24h) */
  connectivityTtlMs?: number;
  now?: () => number;
}

/** 供应商是否"可用" (与 setup-wizard 的判据一致: 有 key 或不需要 key) */
export function providerUsable(p: { enabled?: boolean; apiKey?: string; requiresApiKey?: boolean }): boolean {
  if (!p) return false;
  if (p.enabled === false) return false;
  if (p.apiKey) return true;
  return p.requiresApiKey === false;
}

export interface Evaluation {
  state: SetupState;
  /** 启动门禁结论 */
  gate: 'ready' | 'setup' | 'repair' | 'blocked';
  /** 为什么是这个结论 (人话, 直接给用户看) */
  reasons: string[];
  /** 下一步该做什么 */
  nextActions: string[];
}

/**
 * 评估初始化状态。**只读, 不改盘** —— 落盘由调用方 (commit/resume) 决定。
 * 失败一律 fail-closed: 读不到/坏掉/异常 → 不进 ready, 而是 setup / repair / blocked。
 */
export async function evaluateSetup(opts: EvaluateOptions = {}): Promise<Evaluation> {
  const bolloonHome = opts.bolloonHome ?? resolveBolloonHome();
  const now = opts.now ? opts.now() : Date.now();
  const ttl = opts.connectivityTtlMs ?? 24 * 60 * 60 * 1000;
  const prev = (await readSetupState(bolloonHome)) || emptySetupState();
  const reasons: string[] = [];
  const checks: SetupState['checks'] = { ...prev.checks };

  // 1. 身份
  let identity: { did?: string; name?: string } | null = null;
  try {
    identity = opts.readIdentity ? await opts.readIdentity() : await defaultReadIdentity(bolloonHome);
  } catch (err) {
    reasons.push(`身份读取失败: ${msg(err)}`);
    checks.identity = false;
  }
  if (identity) checks.identity = !!(identity.did || identity.name);
  else if (checks.identity === undefined) checks.identity = false;

  // 2. LLM 配置 (供应商 + 模型 + 密钥存在性) —— 只读结构与"有没有", 不读密钥值
  let provider: string | undefined;
  let model: string | undefined;
  let hasKey = false;
  let providerUsableNow = false;
  let configError: ErrorClass | undefined;
  try {
    const cfg = opts.readLlmConfig ? await opts.readLlmConfig() : await defaultReadLlmConfig(bolloonHome);
    provider = cfg?.activeProvider || cfg?.provider;
    const p = provider ? (cfg?.providers?.[provider] || {}) : {};
    model = p?.model;
    hasKey = !!p?.apiKey;
    providerUsableNow = providerUsable(p);
    if (!provider) { reasons.push('还没有选择模型供应商 (llm-config.json 无 activeProvider)'); configError = 'config'; }
    else if (!providerUsableNow) {
      reasons.push(`供应商 ${provider} 不可用: 需要 apiKey 但没配 (或已被禁用)`);
      configError = 'auth';
    }
    if (!model && providerUsableNow) reasons.push(`供应商 ${provider} 没有指定模型 (将用默认模型)`);
  } catch (err) {
    // 配置损坏 → needs_repair, 不回退成默认配置假装正常
    reasons.push(`LLM 配置不可读: ${msg(err)}`);
    configError = 'config';
  }
  checks.providerUsable = providerUsableNow;
  checks.modelPresent = !!model;

  // 3. 连通性结果是否仍然有效
  const connAt = checks.connectivityAt ? Date.parse(checks.connectivityAt) : 0;
  const connFresh = !!connAt && now - connAt < ttl;
  if (checks.connectivityOk && !connFresh) reasons.push('连通性结果已过期 (>24h), 需要重新测试');
  const connectivityOk = !!checks.connectivityOk && connFresh;

  // 4. 运行时 (initMinimax / session) —— 便宜且本地, 默认查
  let runtimeOk = checks.runtimeInitialized === true;
  if (!opts.light) {
    try {
      runtimeOk = opts.runtimeReady ? await opts.runtimeReady() : await defaultRuntimeReady();
    } catch { runtimeOk = false; }
  }
  checks.runtimeInitialized = runtimeOk;

  // 5. Skills registry 健康 (可选层: 只在不 light 时查, 且坏技能不阻塞 basic)
  let skillsOk: boolean | undefined = checks.skillsOk;
  if (!opts.light) {
    try {
      const s = opts.readSkills ? await opts.readSkills() : await defaultReadSkills(bolloonHome);
      skillsOk = s ? s.invalid === 0 : undefined;
      if (s && s.invalid > 0) reasons.push(`有 ${s.invalid} 个技能不合格 (不影响基础对话, 但长期执行前要修)`);
    } catch { skillsOk = undefined; }
  }
  checks.skillsOk = skillsOk;

  const readiness: SetupReadiness = {
    basic: !!checks.identity && providerUsableNow && connectivityOk && runtimeOk,
    agent: !!checks.identity && providerUsableNow && runtimeOk && skillsOk !== false,
    durable: !!checks.identity && providerUsableNow && runtimeOk,
    network: false,      // P2P/Kubo 是可选能力, 由网络层单独上报; 不阻塞 basic
  };

  // 阶段推进: 从已完成的最高阶段往后找第一个缺口 (单调, 不跳级)
  const stage = deriveStage({ identity: !!checks.identity, provider: providerUsableNow, model: !!model, connectivity: connectivityOk, runtime: runtimeOk });
  const completed: SetupStage[] = [];
  for (const s of SETUP_STAGES) {
    if (s === 'uninitialized') continue;
    if (stageIndex(stage) > stageIndex(s)) completed.push(s);
  }

  // 家目录可写性: 写不进去 = 不能初始化 = blocked (其余缺项都是可修的 → setup)
  let homeWritable = true;
  try {
    homeWritable = opts.homeWritableProbe ? await opts.homeWritableProbe() : await probeHomeWritable(bolloonHome);
  } catch { homeWritable = false; }
  if (!homeWritable) reasons.push(`配置根目录不可写: ${bolloonHome}`);

  // 门禁: ready 才允许执行 agent / supervisor; 配置坏(有历史) → repair; 不可写 → blocked; 其余缺项 → setup (继续向导)
  let gate: Evaluation['gate'];
  if (readiness.basic && stage === 'ready') gate = 'ready';
  else if (!homeWritable) gate = 'blocked';
  else if (configError === 'config' && setupHasPriorState(prev)) gate = 'repair';
  else gate = 'setup';

  const state: SetupState = {
    ...prev,
    schema: 'bolloon-setup/1',
    stage,
    completed,
    inputs: { ...prev.inputs, name: prev.inputs.name, provider: provider ?? prev.inputs.provider, model: model ?? prev.inputs.model, hasApiKey: hasKey || prev.inputs.hasApiKey, identityDid: identity?.did || prev.inputs.identityDid },
    checks,
    readiness,
    allow: {
      cli: true,                                   // CLI 永远可以进 (但它只能 setup/status/repair, 见启动门禁)
      web: gate === 'ready',                        // Web 仅在 ready 时提供正常功能
      supervisor: gate === 'ready' && readiness.durable,
      agent: gate === 'ready' && readiness.basic,
    },
    actions: nextActionsFor(stage, { identity: !!checks.identity, provider: providerUsableNow, model: !!model, connectivity: connectivityOk, runtime: runtimeOk, configError }),
    configVersion: (await hashConfigFiles(bolloonHome)).version,
    updatedAt: new Date().toISOString(),
  };
  state.configHash = (await hashConfigFiles(bolloonHome)).hash;
  if (gate !== 'ready') {
    state.lastError = configError
      ? { at: new Date().toISOString(), stage, errorClass: configError, message: reasons[0] || '配置不完整' }
      : state.lastError;
  }
  return { state, gate, reasons, nextActions: state.actions };
}

/** 从校验结果推导"当前应该停在哪个阶段" (单调: 第一个未满足的阶段) */
export function deriveStage(c: { identity: boolean; provider: boolean; model: boolean; connectivity: boolean; runtime: boolean }): SetupStage {
  if (!c.identity) return 'identity_pending';
  if (!c.provider) return 'provider_pending';
  if (!c.model) return 'model_pending';
  if (!c.connectivity) return 'connectivity_pending';
  if (!c.runtime) return 'runtime_pending';
  return 'ready';
}

/** 配置根目录是否可写 (能 mkdir + 写一个临时文件) */
async function probeHomeWritable(bolloonHome: string): Promise<boolean> {
  try {
    await fs.mkdir(bolloonHome, { recursive: true });
    const probe = path.join(bolloonHome, '.setup-write-probe');
    await fs.writeFile(probe, 'ok', 'utf8');
    await fs.rm(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

function stageIndex(s: SetupStage | SetupFaultStage): number {
  if (s === 'needs_repair' || s === 'blocked') return -1;
  return SETUP_STAGES.indexOf(s as SetupStage);
}

function setupHasPriorState(prev: SetupState): boolean {
  return prev.completed.length > 0 || !!prev.inputs.provider || !!prev.inputs.identityDid || prev.stage !== 'uninitialized';
}

function nextActionsFor(
  stage: SetupStage | SetupFaultStage,
  c: { identity: boolean; provider: boolean; model: boolean; connectivity: boolean; runtime: boolean; configError?: ErrorClass },
): string[] {
  switch (stage) {
    case 'identity_pending': return ['先生成/填写身份 (姓名) — `bolloon setup` 会复用已有 DID, 不会重复生成'];
    case 'provider_pending': return c.configError === 'config'
      ? ['llm-config.json 损坏或缺失 → `bolloon setup --repair` (不会重置已有身份)']
      : ['选择模型供应商 (provider) — `bolloon setup` 的 provider 步骤'];
    case 'credential_pending': return ['补 provider 的 apiKey (隐藏输入, 不落明文日志)'];
    case 'model_pending': return ['指定该 provider 的模型名 (留空用默认)'];
    case 'connectivity_pending': return ['跑一次连通性测试 — 未测试通过不算 ready (超时可重试, 不当成功)'];
    case 'runtime_pending': return ['初始化运行时 (LLM 层) — 失败会让 agent 走 fallback, 必须修好才 ready'];
    case 'needs_repair': return ['配置文件损坏 → `bolloon setup --repair` (就地修复, 不回退成默认配置)', '修完再启动; 期间只允许诊断'];
    case 'blocked': return ['缺必需项且无法自动继续 → 检查 provider/key/网络后 `bolloon setup --resume`'];
    default: return ['已就绪'];
  }
}

/** 从阶段 → 门禁结论 (供启动层直接用) */
export function gateFor(stage: SetupStage | SetupFaultStage, readiness: SetupReadiness): Evaluation['gate'] {
  if (stage === 'ready' && readiness.basic) return 'ready';
  if (stage === 'needs_repair') return 'repair';
  if (stage === 'blocked') return 'blocked';
  return 'setup';
}

// ─────────────────────────────────────────────────────────────────────────────
// 默认探测 (尽量便宜: 只读文件 + 本地初始化)
// ─────────────────────────────────────────────────────────────────────────────

async function defaultReadIdentity(bolloonHome: string): Promise<{ did?: string; name?: string } | null> {
  for (const f of ['user.json', 'identity.json']) {
    try {
      const j = JSON.parse(await fs.readFile(path.join(bolloonHome, f), 'utf8'));
      if (j?.did || j?.name || j?.identity?.did) return { did: j.did || j.identity?.did, name: j.name || j.identity?.name };
    } catch { /* 试下一个 */ }
  }
  return null;
}

async function defaultReadLlmConfig(bolloonHome: string): Promise<any> {
  return JSON.parse(await fs.readFile(path.join(bolloonHome, 'llm-config.json'), 'utf8'));
}

async function defaultRuntimeReady(): Promise<boolean> {
  try {
    const { getMinimax } = await import('../constraints/index.js');
    getMinimax();
    return true;
  } catch {
    return false;
  }
}

async function defaultReadSkills(bolloonHome: string): Promise<{ total: number; invalid: number } | null> {
  try {
    const { SkillsManager } = await import('../agents/skills-manager.js');
    const sm = new SkillsManager({ home: path.dirname(bolloonHome), cwd: process.cwd() });
    const h = await sm.health({ home: path.dirname(bolloonHome) });
    return { total: h.total, invalid: h.invalid.length };
  } catch {
    return null;
  }
}

function msg(err: unknown): string {
  return String((err as Error)?.message || err).slice(0, 160);
}

// ─────────────────────────────────────────────────────────────────────────────
// 门禁 + 落盘
// ─────────────────────────────────────────────────────────────────────────────

/** 评估并落盘 (启动层/向导用; 只读评估用 evaluateSetup) */
export async function refreshSetupState(opts: EvaluateOptions = {}): Promise<Evaluation> {
  const ev = await evaluateSetup(opts);
  await writeSetupState(ev.state, opts.bolloonHome ?? resolveBolloonHome());
  return ev;
}

/** 记录一次失败 (分类 + 可恢复动作), **不改 ready 判定** —— 失败不许把状态写成成功 */
export async function recordSetupFailure(
  stage: string,
  errorClass: ErrorClass,
  message: string,
  bolloonHome: string = resolveBolloonHome(),
): Promise<SetupState> {
  const prev = (await readSetupState(bolloonHome)) || emptySetupState();
  const state: SetupState = {
    ...prev,
    stage: errorClass === 'config' || errorClass === 'io' ? 'needs_repair' : prev.stage,
    lastError: { at: new Date().toISOString(), stage, errorClass, message: String(message).slice(0, 300) },
    lastAttemptAt: new Date().toISOString(),
    actions: [`${stage} 阶段失败 (${errorClass}) → 重试 / 修改 / 返回上一步`, '再次运行 `bolloon setup` 会从失败阶段继续 (已保存的输入不会被清掉)'],
    allow: { ...prev.allow, agent: false, supervisor: false, web: false },
    updatedAt: new Date().toISOString(),
  };
  await writeSetupState(state, bolloonHome);
  return state;
}

/** 记录一次成功阶段 (阶段推进 + 已完成清单) */
export async function recordSetupStage(
  stage: SetupStage,
  patch: Partial<Pick<SetupState, 'inputs' | 'checks'>> = {},
  bolloonHome: string = resolveBolloonHome(),
): Promise<SetupState> {
  const prev = (await readSetupState(bolloonHome)) || emptySetupState();
  const completed = Array.from(new Set([...prev.completed, ...(stage === 'uninitialized' ? [] : [stage])]));
  const state: SetupState = {
    ...prev,
    stage,
    completed,
    inputs: { ...prev.inputs, ...(patch.inputs || {}) },
    checks: { ...prev.checks, ...(patch.checks || {}) },
    lastAttemptAt: new Date().toISOString(),
    lastError: undefined,
    updatedAt: new Date().toISOString(),
  };
  await writeSetupState(state, bolloonHome);
  return state;
}

/** 供启动层/CLI/Web 展示的一段人话摘要 */
export function describeSetup(ev: Evaluation): string {
  const s = ev.state;
  const lines = [
    `初始化状态: ${s.stage}   门禁: ${ev.gate}`,
    `就绪度: basic=${s.readiness.basic ? '✓' : '✗'} agent=${s.readiness.agent ? '✓' : '✗'} durable=${s.readiness.durable ? '✓' : '✗'} network=${s.readiness.network ? '✓' : '✗'}`,
    `已完成: ${s.completed.join(' → ') || '(无)'}`,
  ];
  if (s.inputs.provider) lines.push(`已存输入: provider=${s.inputs.provider}${s.inputs.model ? ` model=${s.inputs.model}` : ''} key=${s.inputs.hasApiKey ? '有' : '无'}${s.inputs.identityDid ? ' 身份=已保存' : ''}`);
  if (s.lastError) lines.push(`上次错误 [${s.lastError.errorClass}] ${s.lastError.stage}: ${s.lastError.message}`);
  for (const r of ev.reasons) lines.push(`· ${r}`);
  lines.push(`下一步: ${ev.nextActions[0]}`);
  return lines.join('\n');
}


// ─────────────────────────────────────────────────────────────────────────────
// 门禁缓存 (给"执行前"的热路径用: 不让每次 prompt 都去读盘)
// ─────────────────────────────────────────────────────────────────────────────

let gateCache: { gate: Evaluation['gate']; at: number; state: SetupState } | null = null;
const GATE_TTL_MS = 30_000;

/** 取当前门禁 (30s 缓存)。失败 fail-closed: 读不出来 → 当作未就绪 */
export async function getSetupGateCached(now = Date.now()): Promise<{ gate: Evaluation['gate']; state: SetupState }> {
  if (gateCache && now - gateCache.at < GATE_TTL_MS) return { gate: gateCache.gate, state: gateCache.state };
  try {
    const ev = await evaluateSetup({ light: true });
    gateCache = { gate: ev.gate, at: now, state: ev.state };
    return { gate: ev.gate, state: ev.state };
  } catch {
    const fallback = { gate: 'blocked' as const, at: now, state: emptySetupState() };
    gateCache = fallback;
    return { gate: fallback.gate, state: fallback.state };
  }
}

export function resetSetupGateCache(): void {
  gateCache = null;
}
