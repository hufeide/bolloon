/**
 * setup-store 单测 (2026-09-16, M0/M1/M4)
 *
 * 修的就是 leo 点的两个 P0: 判定失败不能当"不需要初始化"; 半成品配置不能进运行态。
 *  - 状态机单调推进 (身份 → 供应商 → 模型 → 连通性 → 运行时 → ready)
 *  - **fail-closed**: 配置坏了 → needs_repair; 家目录不可写 → blocked; 评估抛错 → 不进 ready
 *  - 连通性过期不算 ready
 *  - 未 ready 时 allow.{agent,web,supervisor}=false (启动硬门禁的事实来源)
 *  - 失败记录不清空已有输入 (身份/密钥不因一次失败丢失)
 *  - 状态文件原子写 (不留 .tmp), 路径解析不缓存 HOME
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

let TMP = '';
let BHOME = '';
const OLD = { HOME: process.env.HOME, UP: process.env.USERPROFILE, BH: process.env.BOLLOON_HOME };

beforeEach(async () => {
  TMP = path.join(os.tmpdir(), `bolloon-setup-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  BHOME = path.join(TMP, '.bolloon');
  await fs.mkdir(BHOME, { recursive: true });
  process.env.HOME = TMP;
  process.env.USERPROFILE = TMP;
  delete process.env.BOLLOON_HOME;
});

afterEach(async () => {
  process.env.HOME = OLD.HOME;
  process.env.USERPROFILE = OLD.UP;
  if (OLD.BH === undefined) delete process.env.BOLLOON_HOME; else process.env.BOLLOON_HOME = OLD.BH;
  await fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

async function mod() {
  const m = await import('../setup/setup-store.js');
  m.resetSetupGateCache();
  return m;
}

async function writeIdentity(name = 'leo') { await fs.writeFile(path.join(BHOME, 'user.json'), JSON.stringify({ name, did: 'did:key:zTest' }), 'utf8'); }
async function writeLlm(provider = 'deepseek', opts: { apiKey?: string; model?: string; requiresApiKey?: boolean } = {}) {
  await fs.writeFile(path.join(BHOME, 'llm-config.json'), JSON.stringify({
    activeProvider: provider,
    providers: { [provider]: { model: opts.model ?? 'deepseek-v4-flash', requiresApiKey: opts.requiresApiKey !== false, apiKey: opts.apiKey } },
  }), 'utf8');
}
const readyOpts = () => ({ readIdentity: async () => ({ name: 'leo', did: 'did:key:zTest' }), readLlmConfig: async () => ({ activeProvider: 'deepseek', providers: { deepseek: { model: 'm-1', apiKey: 'sk-x' } } }), runtimeReady: async () => true, readSkills: async () => ({ total: 1, invalid: 0 }) });

describe('路径解析 (M1: 不在模块顶层缓存 HOME)', () => {
  it('BOLLOON_HOME 优先; 否则 $HOME/.bolloon; 改 env 立刻生效', async () => {
    const m = await mod();
    expect(m.resolveBolloonHome()).toBe(path.join(TMP, '.bolloon'));
    process.env.BOLLOON_HOME = path.join(TMP, 'custom-home');
    expect(m.resolveBolloonHome()).toBe(path.join(TMP, 'custom-home'));
    delete process.env.BOLLOON_HOME;
    process.env.HOME = path.join(TMP, 'other');
    expect(m.resolveBolloonHome()).toBe(path.join(TMP, 'other', '.bolloon'));
  });
});

describe('状态机: 单调推进 + 失败 fail-closed', () => {
  it('全新 HOME → setup / identity_pending, agent+web+supervisor 一律不允许', async () => {
    const m = await mod();
    const ev = await m.evaluateSetup({ readIdentity: async () => null, readLlmConfig: async () => ({}), runtimeReady: async () => false });
    expect(ev.gate).toBe('setup');
    expect(ev.state.stage).toBe('identity_pending');
    expect(ev.state.allow).toEqual({ cli: true, web: false, supervisor: false, agent: false });
    expect(ev.state.actions[0]).toContain('身份');
  });

  it('身份有、供应商缺 → 停在 provider_pending (不是 ready, 也不是 blocked)', async () => {
    const m = await mod();
    const ev = await m.evaluateSetup({ readIdentity: async () => ({ did: 'did:key:z' }), readLlmConfig: async () => ({ providers: {} }), runtimeReady: async () => true });
    expect(ev.state.stage).toBe('provider_pending');
    expect(ev.gate).toBe('setup');
    expect(ev.reasons.join(' ')).toContain('供应商');
  });

  it('有 provider 但缺 key → credential/auth 类原因, 不 ready', async () => {
    const m = await mod();
    const ev = await m.evaluateSetup({ readIdentity: async () => ({ did: 'd' }), readLlmConfig: async () => ({ activeProvider: 'deepseek', providers: { deepseek: { model: 'm' } } }), runtimeReady: async () => true });
    expect(ev.state.stage).toBe('provider_pending');
    expect(ev.reasons.join(' ')).toContain('apiKey');
  });

  it('各项齐备但连通性没测过 → connectivity_pending (未测试不算 ready)', async () => {
    const m = await mod();
    const ev = await m.evaluateSetup(readyOpts());
    expect(ev.state.stage).toBe('connectivity_pending');
    expect(ev.gate).toBe('setup');
  });

  it('连通性结果过期 (>24h) → 回到 connectivity_pending, 理由说清"已过期"', async () => {
    const m = await mod();
    await m.recordSetupStage('connectivity_pending', { checks: { connectivityOk: true, connectivityAt: new Date(Date.now() - 48 * 3600_000).toISOString(), identity: true, providerUsable: true, modelPresent: true, runtimeInitialized: true } });
    const ev = await m.evaluateSetup(readyOpts());
    expect(ev.state.stage).toBe('connectivity_pending');
    expect(ev.reasons.join(' ')).toContain('过期');
  });

  it('全部满足 (连通性在有效期内) → ready + allow.agent/supervisor', async () => {
    const m = await mod();
    await m.recordSetupStage('connectivity_pending', { checks: { connectivityOk: true, connectivityAt: new Date().toISOString() } });
    const ev = await m.evaluateSetup(readyOpts());
    expect(ev.gate).toBe('ready');
    expect(ev.state.stage).toBe('ready');
    expect(ev.state.readiness.basic).toBe(true);
    expect(ev.state.allow.agent).toBe(true);
    expect(ev.state.allow.supervisor).toBe(true);
    expect(ev.state.completed).toContain('connectivity_pending');
  });

  it('配置损坏 → needs_repair (有历史) / setup (全新), 且**不清空**已有输入', async () => {
    const m = await mod();
    // 全新: 无历史 → setup
    const fresh = await m.evaluateSetup({ readIdentity: async () => null, readLlmConfig: async () => { throw new Error('Unexpected token in JSON'); }, runtimeReady: async () => false });
    expect(fresh.gate).toBe('setup');
    // 有历史 → repair
    await m.recordSetupStage('identity_pending', { inputs: { name: 'leo', identityDid: 'did:key:z' } });
    const broken = await m.evaluateSetup({ readIdentity: async () => ({ did: 'did:key:z' }), readLlmConfig: async () => { throw new Error('Unexpected token in JSON'); }, runtimeReady: async () => true });
    expect(broken.gate).toBe('repair');
    expect(broken.state.inputs.identityDid).toBe('did:key:z');       // 输入保留
    expect(broken.state.lastError?.errorClass).toBe('config');
    expect(broken.state.actions.join(' ')).toContain('repair');
  });

  it('家目录不可写 → blocked (唯一"不能自动继续"的情形)', async () => {
    const m = await mod();
    const ev = await m.evaluateSetup({ ...readyOpts(), homeWritableProbe: async () => false });
    expect(ev.gate).toBe('blocked');
    expect(ev.reasons.join(' ')).toContain('不可写');
  });

  it('评估自身抛错 → 门禁缓存按 blocked 处理 (fail-closed), reset 后可重算', async () => {
    const m = await mod();
    // 让 home 解析指向一个"文件"而不是目录 → mkdir/write 必失败
    const asFile = path.join(TMP, 'not-a-dir');
    await fs.writeFile(asFile, 'x', 'utf8');
    process.env.BOLLOON_HOME = asFile;
    const cached = await m.getSetupGateCached();
    expect(cached.gate).toBe('blocked');
    m.resetSetupGateCache();
    process.env.BOLLOON_HOME = BHOME;
    const again = await m.getSetupGateCached();
    expect(again.gate === 'ready' || again.gate === 'setup').toBe(true);
    delete process.env.BOLLOON_HOME;
  });
});

describe('阶段记录: 失败不许写成成功', () => {
  it('recordSetupFailure 落分类 + 关掉 agent/web/supervisor, 不改 ready', async () => {
    const m = await mod();
    await m.recordSetupStage('runtime_pending');
    const st = await m.recordSetupFailure('connectivity_pending', 'timeout', '连通性测试超时 (10s)');
    expect(st.lastError?.errorClass).toBe('timeout');
    expect(st.lastError?.stage).toBe('connectivity_pending');
    expect(st.allow).toEqual({ cli: true, web: false, supervisor: false, agent: false });
    expect(st.stage).not.toBe('ready');
    expect(st.actions.join(' ')).toContain('重试');
  });

  it('recordSetupStage 推进阶段并清掉上次错误 (恢复路径)', async () => {
    const m = await mod();
    await m.recordSetupFailure('provider_pending', 'auth', 'key 无效');
    const st = await m.recordSetupStage('model_pending', { inputs: { provider: 'deepseek', hasApiKey: true } });
    expect(st.completed).toContain('model_pending');
    expect(st.lastError).toBeUndefined();
    expect(st.inputs.provider).toBe('deepseek');
    expect(st.inputs.hasApiKey).toBe(true);
  });

  it('状态文件原子写: 可解析且不留 .tmp 残留', async () => {
    const m = await mod();
    await m.writeSetupState(m.emptySetupState());
    const raw = await fs.readFile(m.setupStatePath(BHOME), 'utf8');
    expect(JSON.parse(raw).schema).toBe('bolloon-setup/1');
    const leftovers = (await fs.readdir(BHOME)).filter((f) => f.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('配置指纹对"缺文件"也敏感 (缺 → 有 指纹必变)', async () => {
    const m = await mod();
    const a = await m.hashConfigFiles(BHOME);
    await writeLlm('deepseek', { apiKey: 'sk-x' });
    const b = await m.hashConfigFiles(BHOME);
    expect(b.hash).not.toBe(a.hash);
  });
});
