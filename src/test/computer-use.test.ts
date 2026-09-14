/**
 * computer-use.test.ts — 桌面操作工具单测 (注入 exec, 不真的动鼠标)
 *
 * 覆盖: 平台门、截图落盘校验、点击/按键/输入的 AppleScript 形状、
 *       辅助功能未授权的错误翻译、剪贴板读写、未知 action、异常兜底。
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { runComputerUseAction, type ExecResult, type ExecFn } from '../agents/computer-use.js';

/** 记录调用的假执行器 */
function fakeExec(handler?: (cmd: string, args: string[]) => Partial<ExecResult> | void) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const exec: ExecFn = async (cmd, args) => {
    calls.push({ cmd, args });
    const h = handler?.(cmd, args) || {};
    return { code: h.code ?? 0, stdout: h.stdout ?? '', stderr: h.stderr ?? '' };
  };
  return { exec, calls };
}

describe('computer_use (桌面操作)', () => {
  it('非 macOS 平台 → 如实拒绝, 不假装成功', async () => {
    const r = await runComputerUseAction('screenshot', {}, { platform: 'linux' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('macOS');
  });

  it('未知 action → 列出可用动作', async () => {
    const r = await runComputerUseAction('fly', {}, { platform: 'darwin' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('未知 action');
    expect(r.error).toContain('screenshot');
  });

  it('screenshot: 文件为空 → 报错 (不返回假路径)', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bolloon-cu-'));
    const file = path.join(tmp, 'shot.png');
    // 假执行器不写文件 → 应报"截图文件为空"
    const { exec } = fakeExec();
    const r = await runComputerUseAction('screenshot', { path: file }, { platform: 'darwin', exec });
    expect(r.success).toBe(false);
    expect(r.error).toContain('为空');
  });

  it('screenshot: 文件真存在 → 返回路径与大小', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bolloon-cu-'));
    const file = path.join(tmp, 'shot.png');
    const { exec, calls } = fakeExec(() => ({ code: 0 }));
    // 假 screencapture: 在 exec 里落一个真实文件
    const exec2: ExecFn = async (cmd, args, opts) => {
      await fs.writeFile(file, Buffer.alloc(2048, 1));
      return exec(cmd, args, opts);
    };
    const r = await runComputerUseAction('screenshot', { path: file }, { platform: 'darwin', exec: exec2 });
    expect(r.success).toBe(true);
    expect(r.path).toBe(file);
    expect(r.output).toContain('KB');
    expect(calls[0].cmd).toBe('screencapture');
    expect(calls[0].args).toContain('-x');
  });

  it('click: x/y 经 argv 传给 System Events', async () => {
    const { exec, calls } = fakeExec();
    const r = await runComputerUseAction('click', { x: 120.6, y: '44' }, { platform: 'darwin', exec });
    expect(r.success).toBe(true);
    expect(calls[0].cmd).toBe('osascript');
    expect(calls[0].args.join(' ')).toContain('click at');
    expect(calls[0].args.slice(-2)).toEqual(['121', '44']);
  });

  it('click 缺少坐标 → 报错', async () => {
    const { exec } = fakeExec();
    const r = await runComputerUseAction('click', {}, { platform: 'darwin', exec });
    expect(r.success).toBe(false);
    expect(r.error).toContain('x, y');
  });

  it('辅助功能未授权 → 翻译成可操作中文提示', async () => {
    const { exec } = fakeExec(() => ({ code: 1, stderr: 'execution error: Not allowed to send keystrokes. (-1719)' }));
    const r = await runComputerUseAction('key', { key: 'Enter' }, { platform: 'darwin', exec });
    expect(r.success).toBe(false);
    expect(r.error).toContain('辅助功能');
  });

  it('key Enter → key code 36; cmd+c → keystroke using command down', async () => {
    const { exec, calls } = fakeExec();
    await runComputerUseAction('key', { key: 'Enter' }, { platform: 'darwin', exec });
    expect(calls[0].args.join(' ')).toContain('key code 36');

    const second = fakeExec();
    await runComputerUseAction('key', { key: 'cmd+c' }, { platform: 'darwin', exec: second.exec });
    const script = second.calls[0].args.join(' ');
    expect(script).toContain('using {command down}');
    expect(second.calls[0].args.slice(-1)).toEqual(['c']);
  });

  it('key 不认识的键名 → 报错并列出可用键', async () => {
    const { exec } = fakeExec();
    const r = await runComputerUseAction('key', { key: 'SuperKey' }, { platform: 'darwin', exec });
    expect(r.success).toBe(false);
    expect(r.error).toContain('Enter');
  });

  it('type: 多行文本按行输入 + 行间回车', async () => {
    const { exec, calls } = fakeExec();
    const r = await runComputerUseAction('type', { text: '第一行\n第二行' }, { platform: 'darwin', exec });
    expect(r.success).toBe(true);
    const scripts = calls.map((c) => c.args.join(' ')).join(' || ');
    expect(scripts).toContain('keystroke');
    expect(scripts).toContain('key code 36');
    expect(calls.length).toBe(3);   // keystroke + return + keystroke
  });

  it('clipboard_get 空 → 友好提示; clipboard_set 走 pbcopy 并把文本写进 stdin', async () => {
    const { exec } = fakeExec();
    const empty = await runComputerUseAction('clipboard_get', {}, { platform: 'darwin', exec });
    expect(empty.success).toBe(true);
    expect(empty.output).toContain('为空');

    let stdinSeen = '';
    const exec2: ExecFn = async (cmd, args, opts) => {
      if (cmd === 'pbcopy') stdinSeen = String(opts?.input ?? '');
      return { code: 0, stdout: '', stderr: '' };
    };
    const r = await runComputerUseAction('clipboard_set', { text: 'hello' }, { platform: 'darwin', exec: exec2 });
    expect(r.success).toBe(true);
    expect(stdinSeen).toBe('hello');
  });

  it('scroll 用 PageUp/PageDown 近似并如实说明', async () => {
    const { exec, calls } = fakeExec();
    const r = await runComputerUseAction('scroll', { direction: 'up', amount: 2 }, { platform: 'darwin', exec });
    expect(r.success).toBe(true);
    expect(r.output).toContain('PageUp');
    expect(calls).toHaveLength(2);
  });

  it('open_app: url → open <url>; app 名 → open -a <名>', async () => {
    const a = fakeExec();
    await runComputerUseAction('open_app', { url: 'https://example.com' }, { platform: 'darwin', exec: a.exec });
    expect(a.calls[0].args).toEqual(['https://example.com']);

    const b = fakeExec();
    await runComputerUseAction('open_app', { app: 'Safari' }, { platform: 'darwin', exec: b.exec });
    expect(b.calls[0].args).toEqual(['-a', 'Safari']);
  });

  it('执行器抛异常 → 结构化 error, 不冒泡', async () => {
    const exec: ExecFn = async () => { throw new Error('boom'); };
    const r = await runComputerUseAction('frontmost', {}, { platform: 'darwin', exec });
    expect(r.success).toBe(false);
    expect(r.error).toContain('computer_use 执行异常');
  });
});
