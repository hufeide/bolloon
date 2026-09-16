/**
 * skills-manager 单测 (2026-09-16, 批次 2-G.1)
 *
 * 覆盖统一事实模型的硬语义:
 *  - discover: 多目录合并 + 来源标注 + 目录没 SKILL.md 也算「存在但不合格」(不许静默消失)
 *  - contentHash: 覆盖整个技能目录 (改 references 也算漂移)
 *  - status: 结构坏 → invalid; registry 的 disabled/archived/quarantined 优先
 *  - 管理动作: disable/enable/approve/quarantine/validate 落 registry, 重启 (新 manager) 后仍生效
 *  - health: 漂移/不合格/同名多处/registry 缺盘 都能检出
 *  - resolve/snapshot: 缺技能与未启用分别说清; snapshot 固定版本 + hash
 *  - export → install 往返 (真文件系统, 不经 IPFS)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

let TMP = '';
let HOME = '';
let CWD = '';
const OLD_HOME = process.env.HOME;
const OLD_UP = process.env.USERPROFILE;

beforeEach(async () => {
  TMP = path.join(os.tmpdir(), `bolloon-sm-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  HOME = path.join(TMP, 'home');
  CWD = path.join(TMP, 'proj');
  await fs.mkdir(HOME, { recursive: true });
  await fs.mkdir(CWD, { recursive: true });
  process.env.HOME = HOME;
  process.env.USERPROFILE = HOME;
});

afterEach(async () => {
  process.env.HOME = OLD_HOME;
  process.env.USERPROFILE = OLD_UP;
  await fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

function skillMd(name: string, opts: { description?: string; version?: string; status?: string; body?: string } = {}): string {
  const body = opts.body ?? `# ${name}\n\n这是 ${name} 的正文, 内容足够长以通过最小长度校验。\n\n## 用法\n\n按说明执行。\n`;
  return `---
name: ${name}
description: ${opts.description ?? `${name} 的说明`}
version: ${opts.version ?? '1.0.0'}
${opts.status ? `status: ${opts.status}\n` : ''}triggers: [测试]
---

${body}`;
}

async function writeSkill(layer: 'user' | 'project', name: string, opts: Parameters<typeof skillMd>[1] = {}, extraFiles: Record<string, string> = {}) {
  const base = layer === 'user' ? path.join(HOME, '.bolloon', 'skills') : path.join(CWD, '.bolloon', 'skills');
  const dir = path.join(base, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), skillMd(name, opts), 'utf8');
  for (const [rel, content] of Object.entries(extraFiles)) {
    const p = path.join(dir, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content, 'utf8');
  }
  return dir;
}

async function mk(opts: { home?: string; cwd?: string } = {}) {
  const m = await import('../agents/skills-manager.js');
  m.resetSkillsManagerForTest();
  return new m.SkillsManager({ home: opts.home ?? HOME, cwd: opts.cwd ?? CWD });
}

// ─────────────────────────────────────────────────────────────────────────────

describe('discover — 统一事实模型', () => {
  it('扫到 user + project 两层的技能, 来源标注正确', async () => {
    await writeSkill('user', 'alpha');
    await writeSkill('project', 'beta');
    const sm = await mk();
    const list = await sm.view();
    const names = list.map((s) => s.name).sort();
    expect(names).toEqual(['alpha', 'beta']);
    expect(list.find((s) => s.name === 'alpha')!.source).toBe('user');
    expect(list.find((s) => s.name === 'beta')!.source).toBe('project');
    expect(list.every((s) => s.status === 'enabled')).toBe(true);
    expect(list.every((s) => s.contentHash.length === 32)).toBe(true);
  });

  it('目录存在但缺 SKILL.md → 进视图且标 invalid (不静默消失)', async () => {
    await fs.mkdir(path.join(HOME, '.bolloon', 'skills', 'broken'), { recursive: true });
    const sm = await mk();
    const list = await sm.view();
    const broken = list.find((s) => s.name === 'broken');
    expect(broken).toBeTruthy();
    expect(broken!.status).toBe('invalid');
    expect(broken!.issues.join(' ')).toContain('SKILL.md');
  });

  it('缺 description / 正文过短 → invalid 并列出问题', async () => {
    await writeSkill('user', 'nodesc', { description: '' });
    await writeSkill('user', 'tinybody', { body: '短' });
    const sm = await mk();
    const list = await sm.view();
    expect(list.find((s) => s.name === 'nodesc')!.status).toBe('invalid');
    expect(list.find((s) => s.name === 'nodesc')!.issues.join(' ')).toContain('description');
    expect(list.find((s) => s.name === 'tinybody')!.status).toBe('invalid');
  });

  it('contentHash 覆盖整个目录 (改 references 也算变了)', async () => {
    const dir = await writeSkill('user', 'hashy', {}, { 'references/api.md': 'v1' });
    const sm = await mk();
    const before = (await sm.inspect('hashy'))!.contentHash;
    await fs.writeFile(path.join(dir, 'references/api.md'), 'v2', 'utf8');
    const sm2 = await mk();
    const after = (await sm2.inspect('hashy'))!.contentHash;
    expect(after).not.toBe(before);
  });
});

describe('管理动作 — 状态落 registry, 重启后仍生效', () => {
  it('disable → 新 manager 仍 disabled; enable 恢复', async () => {
    await writeSkill('user', 'toggle');
    const sm = await mk();
    expect((await sm.disable('toggle')).ok).toBe(true);
    const fresh = await mk();
    expect((await fresh.inspect('toggle'))!.status).toBe('disabled');
    expect((await fresh.enable('toggle')).ok).toBe(true);
    const fresh2 = await mk();
    expect((await fresh2.inspect('toggle'))!.status).toBe('enabled');
  });

  it('不合格技能不允许 enable (给原因, 不静默通过)', async () => {
    await fs.mkdir(path.join(HOME, '.bolloon', 'skills', 'bad1'), { recursive: true });
    const sm = await mk();
    const r = await sm.enable('bad1');
    expect(r.ok).toBe(false);
    expect(String(r.reason)).toContain('不合格');
  });

  it('approve → trust=verified 且记录批准人; quarantine → 状态与原因落盘', async () => {
    await writeSkill('user', 'trustme');
    const sm = await mk();
    const ap = await sm.approve('trustme', 'unit-test');
    expect(ap.ok).toBe(true);
    expect((await (await mk()).inspect('trustme'))!.trust).toBe('verified');
    expect((await (await mk()).inspect('trustme'))!.approvedBy).toBe('unit-test');
    await sm.quarantine('trustme', '来源不可信');
    const q = await (await mk()).inspect('trustme');
    expect(q!.status).toBe('quarantined');
    expect(q!.trust).toBe('quarantined');
    expect((await sm.health()).byStatus.quarantined).toBe(1);
  });

  it('validate 对坏技能落 invalid, 修好后能回到 enabled', async () => {
    const dir = path.join(HOME, '.bolloon', 'skills', 'fixme');
    await fs.mkdir(dir, { recursive: true });
    const sm = await mk();
    await sm.validate('fixme');
    expect((await (await mk()).inspect('fixme'))!.status).toBe('invalid');
    await fs.writeFile(path.join(dir, 'SKILL.md'), skillMd('fixme'), 'utf8');
    await sm.validate('fixme');
    expect((await (await mk()).inspect('fixme'))!.status).toBe('enabled');
  });
});

describe('health / resolve / snapshot', () => {
  it('health: 漂移 / 不合格 / 同名多处 / registry 缺盘 都能检出', async () => {
    const dir = await writeSkill('user', 'driftme');
    await writeSkill('user', 'same', { version: '1.0.0' });
    await writeSkill('project', 'same', { version: '2.0.0' });
    await fs.mkdir(path.join(HOME, '.bolloon', 'skills', 'noMd'), { recursive: true });
    const sm = await mk();
    await sm.discover();                                     // 建基线
    await fs.writeFile(path.join(dir, 'SKILL.md'), skillMd('driftme', { version: '9.9.9' }), 'utf8');

    const h = await (await mk()).health();
    expect(h.drifted.map((d) => d.name)).toContain('driftme');
    expect(h.invalid.map((i) => i.name)).toContain('noMd');
    expect(h.duplicates.map((d) => d.name)).toContain('same');

    // registry 里有记录但目录被删 → missing
    await fs.rm(path.join(HOME, '.bolloon', 'skills', 'driftme'), { recursive: true, force: true });
    const h2 = await (await mk()).health();
    expect(h2.missing).toContain('driftme');
  });

  it('resolve: 缺技能与未启用分别说清; snapshot 固定版本与 hash', async () => {
    await writeSkill('user', 'ready', { version: '3.1.4' });
    await writeSkill('user', 'off');
    const sm = await mk();
    await sm.disable('off');
    const r = await (await mk()).resolve(['ready', 'off', 'ghost']);
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['ghost']);
    expect(r.notEnabled).toEqual(['off']);
    expect(r.resolved.map((s) => s.name).sort()).toEqual(['off', 'ready']);

    const snap = await (await mk()).snapshot(['ready']);
    expect(snap.ok).toBe(true);
    expect(snap.entries[0]).toMatchObject({ name: 'ready', version: '3.1.4', source: 'user' });
    expect(snap.entries[0].contentHash.length).toBe(32);
    expect(Date.parse(snap.entries[0].resolvedAt)).toBeGreaterThan(0);
  });
});

describe('export → install 往返 (真文件系统)', () => {
  it('导出技能包 → 装到另一个 HOME → 新 manager 能解析到, 状态 installed/unverified', async () => {
    await writeSkill('user', 'portable', { version: '2.0.0' }, { 'references/x.md': '细节' });
    const sm = await mk();
    const exp = await sm.export('portable');
    expect(exp.ok).toBe(true);
    expect(Object.keys(exp.bundle!.files).sort()).toEqual(['SKILL.md', 'references/x.md']);

    const OTHER = path.join(TMP, 'home2');
    await fs.mkdir(OTHER, { recursive: true });
    const sm2 = new (await import('../agents/skills-manager.js')).SkillsManager({ home: OTHER, cwd: path.join(TMP, 'proj2') });
    const inst = await sm2.install(JSON.stringify(exp.bundle));
    expect(inst.error).toBeUndefined();      // 失败时把原因带出来 (而不是只说 ok=false)
    expect(inst.ok).toBe(true);
    const list = await sm2.view();
    const rec = list.find((s) => s.name === 'portable')!;
    expect(rec.status).toBe('installed');
    expect(rec.source).toBe('imported');
    expect(rec.trust).toBe('unverified');
    expect(rec.version).toBe('2.0.0');
    const srcHash = (await (await mk()).inspect('portable'))!.contentHash;
    expect(rec.contentHash).toBe(srcHash);       // 同样的文件 → 同样的内容指纹 (跨 HOME 可复算)
  });

  it('非法技能包 → 明确拒绝 (不产生半成品目录)', async () => {
    const OTHER = path.join(TMP, 'home3');
    await fs.mkdir(OTHER, { recursive: true });
    const sm = new (await import('../agents/skills-manager.js')).SkillsManager({ home: OTHER, cwd: path.join(TMP, 'proj3') });
    const bad = await sm.install('{"schema":"wrong","name":"x","files":{}}');
    expect(bad.ok).toBe(false);
    expect((await sm.view()).length).toBe(0);
  });
});
