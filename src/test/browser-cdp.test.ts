/**
 * browser-cdp.test.ts — BrowserCdpSession 真机测试 (必须真跑真实 Chrome)
 *
 * 环境无 Chrome 时整组 skip; 本机 (macOS) 已验证 Chrome 存在并真跑通过。
 * vitest 默认 5s 太短, 每个用例显式 timeout: 60000。
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserCdpSession, __shutdownBrowserForTest, resolveChromePath } from '../agents/browser-cdp.js';

const chromePath = resolveChromePath();
// 无 Chrome → 跳过整组
const d = chromePath ? describe : describe.skip;

let htmlFile = '';
let session: BrowserCdpSession;

d('browser-cdp (真实 Chrome CDP)', () => {
  beforeAll(() => {
    // 写一个本地临时 html: 含 title / h1 / 按钮 (onclick 改 innerText) / 一个链接
    htmlFile = path.join(os.tmpdir(), `bolloon-cdp-test-${Date.now()}.html`);
    fs.writeFileSync(
      htmlFile,
      `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Bolloon CDP Test</title></head>
<body>
  <h1 id="h">Hello Bolloon H1</h1>
  <p id="msg">原始文本</p>
  <button id="btn" onclick="document.getElementById('msg').innerText='按钮已点击 OK'">点我</button>
  <a href="https://example.com/page">Example Link</a>
</body>
</html>`,
      'utf8'
    );
    session = new BrowserCdpSession();
  });

  afterAll(async () => {
    await __shutdownBrowserForTest();
    try { fs.rmSync(htmlFile, { force: true }); } catch { /* ignore */ }
  });

  it('① 启动会话 + open 本地 html → text 含 h1 文本', async () => {
    const url = 'file://' + htmlFile;
    const open = await session.execute({ action: 'open', url });
    expect(open.success).toBe(true);

    const text = await session.execute({ action: 'text' });
    expect(text.success).toBe(true);
    expect(text.output).toContain('Hello Bolloon H1');
    expect(text.output).toContain('原始文本');
  }, 60000);

  it('② click 按钮后再 text → 文本已变 (验证真实点击)', async () => {
    const click = await session.execute({ action: 'click', selector: '#btn' });
    expect(click.success).toBe(true);

    const text = await session.execute({ action: 'text' });
    expect(text.success).toBe(true);
    expect(text.output).toContain('按钮已点击 OK');
    expect(text.output).not.toContain('原始文本');
  }, 60000);

  it('③ js 执行 1+1 返回 2', async () => {
    const r = await session.execute({ action: 'js', code: '1+1' });
    expect(r.success).toBe(true);
    expect(String(r.output).trim()).toBe('2');
  }, 60000);

  it('④ screenshot 返回文件存在且大于 1000 字节', async () => {
    const r = await session.execute({ action: 'screenshot' });
    expect(r.success).toBe(true);
    expect(r.screenshotPath).toBeTruthy();
    expect(fs.existsSync(r.screenshotPath!)).toBe(true);
    expect(fs.statSync(r.screenshotPath!).size).toBeGreaterThan(1000);
  }, 60000);

  it('⑤ links 能取到链接 href', async () => {
    const r = await session.execute({ action: 'links' });
    expect(r.success).toBe(true);
    expect(r.output).toContain('https://example.com/page');
  }, 60000);

  it('⑥ close 后 state 清理', async () => {
    expect(session.isRunning).toBe(true);
    const r = await session.execute({ action: 'close' });
    expect(r.success).toBe(true);
    expect(session.isRunning).toBe(false);
  }, 60000);
});
