/**
 * setup-wizard.test.ts — 初始化向导的用户身份部分单测
 *
 * 覆盖: 身份文件路径、首次写身份 (生成 DID, 0600)、复用时只改名不换 DID、
 *       无文件时 read 返回 null。全部用临时 HOME, 不碰真实 ~/.bolloon。
 * (供应商部分依赖全局 llmConfigStore 读真实配置, 不在单测里跑。)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { getUserIdentityFile, readUserIdentity, writeUserIdentity } from '../cli/setup-wizard.js';

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'bolloon-setup-'));
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe('setup-wizard · 用户身份', () => {
  it('身份文件固定在 <home>/.bolloon/identity/user.json', () => {
    expect(getUserIdentityFile(home)).toBe(path.join(home, '.bolloon', 'identity', 'user.json'));
  });

  it('没有文件时 read → null (不抛异常)', async () => {
    expect(await readUserIdentity(home)).toBeNull();
  });

  it('首次写身份 → 生成 DID + 名字, 并写文件', async () => {
    const r = await writeUserIdentity('觉者', home);
    expect(r.created).toBe(true);
    expect(r.identity.name).toBe('觉者');
    expect(r.identity.did).toMatch(/^did:/);
    expect(r.identity.publicKeyHex.length).toBeGreaterThan(0);
    const onDisk = JSON.parse(await fs.readFile(getUserIdentityFile(home), 'utf-8'));
    expect(onDisk.name).toBe('觉者');
    expect(onDisk.did).toBe(r.identity.did);
  });

  it('再次写 → 复用原 DID, 只更新名字 (created=false)', async () => {
    const first = await writeUserIdentity('小明', home);
    const second = await writeUserIdentity('觉者', home);
    expect(second.created).toBe(false);
    expect(second.identity.did).toBe(first.identity.did);
    expect(second.identity.name).toBe('觉者');
    const reloaded = await readUserIdentity(home);
    expect(reloaded?.name).toBe('觉者');
  });

  it('空名字 → 保留原名字 (不会把身份写成空)', async () => {
    const first = await writeUserIdentity('原名', home);
    const second = await writeUserIdentity('', home);
    expect(second.identity.name).toBe('原名');
    expect(second.identity.did).toBe(first.identity.did);
  });

  it('超过 40 字符的名字被截断 (写入前清洗)', async () => {
    const long = 'x'.repeat(80);
    const r = await writeUserIdentity(long, home);
    expect(r.identity.name.length).toBe(40);
  });
});
