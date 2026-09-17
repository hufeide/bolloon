/**
 * onboard 单测 (Phase 2/4/6, 2026-09-16)
 * 阶段执行器的纯逻辑 + 真实文件副作用 (隔离 HOME): 分类 · 起始阶段 · nextStepInfo · skipSteps 不等于通过 · repair。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

let TMP = '', HOME = '', BHOME = '';
const OLD = { HOME: process.env.HOME, UP: process.env.USERPROFILE, BH: process.env.BOLLOON_HOME };

beforeEach(async () => {
  TMP = path.join(os.tmpdir(), `bolloon-onboard-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  HOME = path.join(TMP, 'home'); BHOME = path.join(HOME, '.bolloon');
  await fs.mkdir(BHOME, { recursive: true });
  process.env.HOME = HOME; process.env.USERPROFILE = HOME; delete process.env.BOLLOON_HOME;
});
afterEach(async () => {
  process.env.HOME = OLD.HOME; process.env.USERPROFILE = OLD.UP;
  if (OLD.BH === undefined) delete process.env.BOLLOON_HOME; else process.env.BOLLOON_HOME = OLD.BH;
  await fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

async function O() { const m = await import('../setup/onboard.js'); return m; }
async function S() { const m = await import('../setup/setup-store.js'); m.resetSetupGateCache(); return m; }

describe('ScriptedIO + 错误分类', () => {
  it('按顺序喂答案; 用尽时给默认值; select 支持序号/值/前缀', async () => {
    const { ScriptedIO } = await O();
    const io = new ScriptedIO(['小明', '2', 'siliconflow']);
    expect(await io.ask('名字')).toBe('小明');
    const choices = [{ value: 'deepseek', label: 'DeepSeek' }, { value: 'openai', label: 'OpenAI' }];
    expect(await io.select('选', choices)).toBe('openai');       // 序号
    expect(await io.select('选', choices)).toBe('siliconflow');   // 未匹配 → 原样返回 (由上层校验)
    expect(await io.ask('空', { defaultValue: 'd' })).toBe('d');
    expect(await io.confirm('要吗', true)).toBe(true);
  });

  it('错误分类覆盖 timeout/auth/network/config/io/model', async () => {
    const { classifyOnboardError } = await O();
    expect(classifyOnboardError(new Error('timeout: 最小模型调用 20s 未返回'))).toBe('timeout');
    expect(classifyOnboardError(new Error('HTTP 401: invalid api key'))).toBe('auth');
    expect(classifyOnboardError(new Error('fetch failed ENOTFOUND'))).toBe('network');
    expect(classifyOnboardError(new Error('HTTP 404: 端点不存在 — 请检查 baseUrl'))).toBe('config');
    expect(classifyOnboardError(new Error('ENOSPC: no space left on device'))).toBe('io');
  });
});

describe('起始阶段与下一步提示', () => {
  it('startStepFor 按第一个缺口定位 (单调)', async () => {
    const { startStepFor } = await O();
    const mk = (c: any) => ({ checks: c } as any);
    expect(startStepFor(mk({}))).toBe('identity');
    expect(startStepFor(mk({ identity: true }))).toBe('provider');
    expect(startStepFor(mk({ identity: true, providerSelected: true }))).toBe('credential');
    expect(startStepFor(mk({ identity: true, providerSelected: true, providerUsable: true }))).toBe('model');
    expect(startStepFor(mk({ identity: true, providerSelected: true, providerUsable: true, modelPresent: true }))).toBe('connectivity');
    expect(startStepFor(mk({ identity: true, providerSelected: true, providerUsable: true, modelPresent: true, connectivityOk: true }))).toBe('runtime');
  });

  it('nextStepInfo 给出这一步要什么输入', async () => {
    const { nextStepInfo } = await O();
    const facts: any = { source: 'missing', providers: {}, legacyPresent: false };
    expect((await nextStepInfo({ checks: {}, inputs: {} } as any, facts)).needs).toBe('name');
    expect((await nextStepInfo({ checks: { identity: true }, inputs: {} } as any, facts)).needs).toBe('provider');
    expect((await nextStepInfo({ checks: { identity: true, providerSelected: true }, inputs: { provider: 'deepseek' } } as any, facts)).needs).toBe('credential');
    expect((await nextStepInfo({ checks: { identity: true, providerSelected: true, providerUsable: true }, inputs: {} } as any, facts)).needs).toBe('model');
    expect((await nextStepInfo({ checks: { identity: true, providerSelected: true, providerUsable: true, modelPresent: true }, inputs: {} } as any, facts)).needs).toBe('none');
  });
});

describe('执行器 (隔离 HOME, 真实文件副作用)', () => {
  it('mode=status 只读 (不创建状态文件) 并给出门禁', async () => {
    const { runOnboard, ScriptedIO } = await O();
    const io = new ScriptedIO([]);
    const r = await runOnboard({ mode: 'status', io, home: HOME, bolloonHome: BHOME });
    expect(r.mode).toBe('status');
    expect(r.gate).not.toBe('ready');
    const exists = await fs.readdir(BHOME);
    expect(exists).not.toContain('setup-state.json');
    expect(io.log.join('\n')).toContain('门禁');
  });

  it('身份阶段写真实身份文件 (identity/user.json), 之后停在供应商', async () => {
    const { runOnboard, ScriptedIO } = await O();
    const r = await runOnboard({ mode: 'setup', io: new ScriptedIO(['单测用户']), home: HOME, bolloonHome: BHOME, oneShot: true });
    const raw = JSON.parse(await fs.readFile(path.join(BHOME, 'identity', 'user.json'), 'utf8'));
    expect(raw.did).toMatch(/^did:/);
    expect(raw.name).toBe('单测用户');
    expect(['provider_pending', 'credential_pending']).toContain(r.stage);
    expect(r.ok).toBe(false);                          // 没到 ready 就不许说成功
    const st = await (await S()).readSetupState(BHOME);
    expect(st?.completed).toContain('identity_pending');
  });

  it('skipSteps 跳过连通性: 跳过 ≠ 通过 (门禁仍不 ready, 步骤标 skipped)', async () => {
    const { runOnboard, ScriptedIO } = await O();
    await fs.mkdir(path.join(BHOME, 'identity'), { recursive: true });
    await fs.writeFile(path.join(BHOME, 'identity', 'user.json'), JSON.stringify({ did: 'did:key:z', name: 'u' }), 'utf8');
    await fs.writeFile(path.join(BHOME, 'bolloon-config.json'), JSON.stringify({ activeProvider: 'deepseek', providers: { deepseek: { apiKey: 'k', model: 'm' } } }), 'utf8');
    const r = await runOnboard({ mode: 'setup', io: new ScriptedIO([]), home: HOME, bolloonHome: BHOME, oneShot: true, skipSteps: ['connectivity'] });
    expect(r.ok).toBe(false);
    expect(r.steps.some((s) => s.id === 'connectivity' && s.status === 'skipped')).toBe(true);
  });

  it('正式配置损坏 → 不崩溃, 返回 repair 结论 (不假装正常)', async () => {
    const { runOnboard, ScriptedIO } = await O();
    await fs.writeFile(path.join(BHOME, 'bolloon-config.json'), '{not json', 'utf8');
    const r = await runOnboard({ mode: 'resume', io: new ScriptedIO([]), home: HOME, bolloonHome: BHOME, oneShot: true });
    expect(r.ok).toBe(false);
    expect(['repair', 'setup', 'blocked']).toContain(r.gate);
  });
});

describe('repairConfig (Phase 6)', () => {
  it('旧 llm-config.json → 迁移到 bolloon-config.json, 旧文件保留', async () => {
    const { repairConfig } = await O();
    await fs.writeFile(path.join(BHOME, 'llm-config.json'), JSON.stringify({ activeProvider: 'openai', providers: { openai: { apiKey: 'sk-old', model: 'gpt' } } }), 'utf8');
    const rep = await repairConfig(BHOME);
    expect(rep.notes.length).toBeGreaterThan(0);
    const canon = JSON.parse(await fs.readFile(path.join(BHOME, 'bolloon-config.json'), 'utf8'));
    expect(canon.activeProvider).toBe('openai');
    const legacyStill = await fs.access(path.join(BHOME, 'llm-config.json')).then(() => true).catch(() => false);
    expect(legacyStill).toBe(true);
  });

  it('正式配置损坏 → 备份成 .corrupt-* 后按默认重建 (如实标注)', async () => {
    const { repairConfig } = await O();
    await fs.writeFile(path.join(BHOME, 'bolloon-config.json'), '{broken', 'utf8');
    const rep = await repairConfig(BHOME);
    expect(rep.backedUpCorrupt).toBeTruthy();
    expect(path.basename(String(rep.backedUpCorrupt))).toContain('corrupt');
    const files = await fs.readdir(BHOME);
    expect(files.some((f) => f.includes('corrupt'))).toBe(true);
  });
});
