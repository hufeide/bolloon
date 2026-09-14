/**
 * skill-share.test.ts — 技能打包 / 分享 / 安装单测 (不碰真实 IPFS)
 *
 * 覆盖: collectSkillBundle (目录收集/缺 SKILL.md 拒绝)、parseSkillBundle 校验、
 *       parseSkillRef 链接解析、compareVersions、installSkillBundle
 *       (新装 / 旧版本拒绝 / force 覆盖 + 备份 / 路径穿越拒绝)。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  collectSkillBundle, parseSkillBundle, parseSkillRef, skillShareLink,
  compareVersions, installSkillBundle, SKILL_BUNDLE_SCHEMA, type SkillBundle,
} from '../agents/skill-share.js';

let tmp: string;
const SKILL_MD = `---
name: demo-skill
description: 演示技能
version: 1.2.0
triggers: [demo]
---

# 演示

正文内容。
`;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bolloon-skill-'));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function makeSkillDir(base: string, name = 'demo-skill', version = '1.2.0') {
  const dir = path.join(base, name);
  await fs.mkdir(path.join(dir, 'references'), { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), SKILL_MD.replace('version: 1.2.0', `version: ${version}`), 'utf-8');
  await fs.writeFile(path.join(dir, 'references', 'note.md'), '参考内容', 'utf-8');
  return dir;
}

describe('skill-share', () => {
  it('collectSkillBundle: 收集 SKILL.md + references, 读取版本与描述', async () => {
    const dir = await makeSkillDir(tmp);
    const r = await collectSkillBundle(dir);
    expect(r.ok).toBe(true);
    expect(r.bundle!.schema).toBe(SKILL_BUNDLE_SCHEMA);
    expect(r.bundle!.name).toBe('demo-skill');
    expect(r.bundle!.version).toBe('1.2.0');
    expect(r.bundle!.description).toContain('演示技能');
    expect(Object.keys(r.bundle!.files).sort()).toEqual(['SKILL.md', 'references/note.md']);
  });

  it('collectSkillBundle: 目录不存在 / 缺 SKILL.md → 拒绝', async () => {
    const missing = await collectSkillBundle(path.join(tmp, 'nope'));
    expect(missing.ok).toBe(false);
    const empty = path.join(tmp, 'empty-skill');
    await fs.mkdir(empty, { recursive: true });
    const noSkill = await collectSkillBundle(empty);
    expect(noSkill.ok).toBe(false);
    expect(noSkill.error).toContain('SKILL.md');
  });

  it('parseSkillBundle: 非 JSON / 错 schema / 缺 SKILL.md 全部拒绝', () => {
    expect(parseSkillBundle('not json').ok).toBe(false);
    expect(parseSkillBundle(JSON.stringify({ schema: 'other/9', files: { 'SKILL.md': 'x' } })).ok).toBe(false);
    expect(parseSkillBundle(JSON.stringify({ schema: SKILL_BUNDLE_SCHEMA, files: {} })).ok).toBe(false);
  });

  it('parseSkillBundle → 往返一致 (导出再解析)', async () => {
    const dir = await makeSkillDir(tmp);
    const b = (await collectSkillBundle(dir)).bundle!;
    const round = parseSkillBundle(JSON.stringify(b));
    expect(round.ok).toBe(true);
    expect(round.bundle!.files['references/note.md']).toBe('参考内容');
  });

  it('parseSkillRef: 三种写法都归一成 CID; 垃圾输入返回 null', () => {
    const cid = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
    expect(parseSkillRef(`bolloon://skill/${cid}`)).toBe(cid);
    expect(parseSkillRef(`ipfs://${cid}`)).toBe(cid);
    expect(parseSkillRef(cid)).toBe(cid);
    expect(parseSkillRef('http://example.com')).toBeNull();
    expect(parseSkillRef('')).toBeNull();
    expect(skillShareLink(cid)).toBe(`bolloon://skill/${cid}`);
  });

  it('compareVersions: 语义化比较', () => {
    expect(compareVersions('1.2.0', '1.1.9')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.9', '1.0')).toBe(-1);
    expect(compareVersions('bad', '0.0.0')).toBe(0);
  });

  it('installSkillBundle: 新技能 → 落盘并返回版本/文件数', async () => {
    const home = path.join(tmp, 'home');
    const dir = await makeSkillDir(tmp);
    const bundle = (await collectSkillBundle(dir)).bundle!;
    const r = await installSkillBundle(bundle, { home });
    expect(r.ok).toBe(true);
    expect(r.version).toBe('1.2.0');
    expect(r.files).toBe(2);
    const written = await fs.readFile(path.join(home, '.bolloon', 'skills', 'demo-skill', 'SKILL.md'), 'utf-8');
    expect(written).toContain('演示技能');
    const ref = await fs.readFile(path.join(home, '.bolloon', 'skills', 'demo-skill', 'references', 'note.md'), 'utf-8');
    expect(ref).toBe('参考内容');
  });

  it('installSkillBundle: 本地版本 >= 来的版本 → 拒绝 (不静默降级), force 可覆盖并备份', async () => {
    const home = path.join(tmp, 'home');
    const dir = await makeSkillDir(tmp, 'demo-skill', '2.0.0');
    const newer = (await collectSkillBundle(dir)).bundle!;
    const first = await installSkillBundle(newer, { home });
    expect(first.ok).toBe(true);

    const olderDir = await makeSkillDir(path.join(tmp, 'src'), 'demo-skill', '1.0.0');
    const older = (await collectSkillBundle(olderDir)).bundle!;
    const refused = await installSkillBundle(older, { home });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('本地已有');

    const forced = await installSkillBundle(older, { home, force: true });
    expect(forced.ok).toBe(true);
    expect(forced.backup).toBeTruthy();
    const backup = await fs.stat(forced.backup!);
    expect(backup.isDirectory()).toBe(true);
  });

  it('installSkillBundle: 包内路径穿越 (../) → 拒绝', async () => {
    const home = path.join(tmp, 'home');
    const evil: SkillBundle = {
      schema: SKILL_BUNDLE_SCHEMA,
      name: 'evil',
      description: '',
      version: '1.0.0',
      exportedAt: '',
      files: { 'SKILL.md': '# x', '../../../../etc/pwn': 'boom' },
    };
    const r = await installSkillBundle(evil, { home });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('非法路径');
  });

  it('installSkillBundle: project scope 写到 cwd/.bolloon/skills', async () => {
    const cwd = path.join(tmp, 'proj');
    await fs.mkdir(cwd, { recursive: true });
    const dir = await makeSkillDir(tmp);
    const bundle = (await collectSkillBundle(dir)).bundle!;
    const r = await installSkillBundle(bundle, { cwd, scope: 'project' });
    expect(r.ok).toBe(true);
    expect(r.installed).toBe(path.join(cwd, '.bolloon', 'skills', 'demo-skill'));
  });
});
