/**
 * browser-cdp.ts — 自包含的真实浏览器自动化模块 (Chrome DevTools Protocol)
 *
 * 设计原则:
 *   - 只用 Node 内置能力: child_process.spawn 启动 Chrome, 全局 fetch 轮询
 *     /json/version 拿 webSocketDebuggerUrl, 全局 WebSocket 手写轻量 CDP 客户端。
 *   - 零 npm 依赖。
 *   - 懒启动: 首次调用才拉起 headless Chrome; 后续复用同一浏览器实例。
 *   - 空闲 5 分钟自动关闭, 避免 Chrome 常驻吃内存。
 *
 * 导出:
 *   - registerBrowserTools(ctx): 注册名为 'browser' 的工具到 ctx.tools
 *   - BrowserCdpSession: 可复用会话 (可单独 new 出来直接驱动)
 *   - resolveChromePath(): 解析 Chrome 可执行文件路径 (供测试判断是否 skip)
 *   - __shutdownBrowserForTest(): 测试收尾清理 (kill Chrome + 关闭 ws)
 */

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { ToolRegistryContext } from './pi-sdk-tools.js';
import type { ToolResult } from './pi-sdk-types.js';

/** 会话空闲多久后自动关闭 (5 分钟) */
const IDLE_SHUTDOWN_MS = 5 * 60 * 1000;
/** 默认单次请求超时 */
const DEFAULT_TIMEOUT_MS = 20000;
/** text/html 输出截断长度 */
const TRUNCATE_LEN = 8000;
/** links 最多返回条数 */
const MAX_LINKS = 50;

/** browser 工具返回结构 (比 ToolResult 多一个 screenshotPath) */
export interface BrowserToolResult extends ToolResult {
  screenshotPath?: string;
}

// ---------------------------------------------------------------------------
// Chrome 可执行文件解析
// ---------------------------------------------------------------------------

/** 用 `which` 找可执行文件, 找不到返回 null */
function whichSync(bin: string): string | null {
  try {
    const out = execFileSync('which', [bin], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8'
    }).trim();
    return out && fs.existsSync(out) ? out : null;
  } catch {
    return null;
  }
}

/**
 * 解析 Chrome 可执行文件路径。优先 env BOLLOON_CHROME_PATH, 其次各平台常见位置。
 * 找不到返回 null (调用方据此返回 "未找到 Chrome 可执行文件")。
 */
export function resolveChromePath(): string | null {
  // 1) 环境变量显式指定
  const envPath = process.env.BOLLOON_CHROME_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;

  // 2) macOS 标准安装位置
  if (process.platform === 'darwin') {
    const candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ];
    for (const p of candidates) if (fs.existsSync(p)) return p;
  }

  // 3) Linux/macOS: which google-chrome / chromium / chrome / chromium-browser
  for (const bin of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome']) {
    const found = whichSync(bin);
    if (found) return found;
  }

  // 4) Windows 常见路径
  if (process.platform === 'win32') {
    const pf = process.env.PROGRAMFILES || 'C:\\Program Files';
    const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA || '';
    const winCandidates = [
      path.join(pf, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(pf86, 'Google\\Chrome\\Application\\chrome.exe'),
      local ? path.join(local, 'Google\\Chrome\\Application\\chrome.exe') : ''
    ];
    for (const p of winCandidates) if (p && fs.existsSync(p)) return p;
  }

  return null;
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 拿一个空闲端口 (bind 0 让系统分配, 取到端口后立刻释放) */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** 轮询 http://127.0.0.1:<port>/json/version, 拿到 webSocketDebuggerUrl */
async function fetchBrowserWsUrl(port: number, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) {
        const j = (await res.json()) as { webSocketDebuggerUrl?: string };
        if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
      }
      lastErr = new Error(`/json/version 返回 ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    await sleep(150);
  }
  throw new Error(`等待 Chrome DevTools 就绪超时 (端口 ${port}): ${String(lastErr)}`);
}

/** 把错误里可能带 connectionLost 标记的异常识别为"连接断开, 可重建" */
function isConnectionLost(e: unknown): boolean {
  return !!(e && typeof e === 'object' && (e as { connectionLost?: boolean }).connectionLost === true);
}

// ---------------------------------------------------------------------------
// 轻量 CDP 客户端 (JSON-RPC over WebSocket)
// ---------------------------------------------------------------------------

interface PendingEntry {
  resolve: (v: any) => void;
  reject: (e: any) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface EventWaiter {
  sessionId?: string;
  resolve: (params: any) => void;
}

/**
 * 极简 CDP 客户端:
 *   - 一个浏览器级 WebSocket 连接 (来自 /json/version)
 *   - id → pending 表, 每个请求独立超时
 *   - 支持 sessionId 透传 (Target.attachToTarget({flatten:true}) 之后的页面级命令)
 *   - 支持等待一次性事件 (如 Page.loadEventFired)
 */
class CdpClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingEntry>();
  private readonly eventWaiters = new Map<string, Set<EventWaiter>>();
  private closed = false;

  constructor(private readonly wsUrl: string) {}

  /** 建立 ws 连接 */
  async connect(timeoutMs: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      const timer = setTimeout(() => {
        try { ws.close(); } catch { /* ignore */ }
        reject(new Error('WebSocket 连接 CDP 超时'));
      }, timeoutMs);

      ws.addEventListener('open', () => {
        clearTimeout(timer);
        this.ws = ws;
        resolve();
      }, { once: true });

      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('WebSocket 连接 CDP 失败'));
      }, { once: true });

      ws.addEventListener('message', (ev: MessageEvent) => this.onMessage(ev));
      ws.addEventListener('close', () => this.onClose());
    });
  }

  private onMessage(ev: MessageEvent): void {
    let msg: any;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
    } catch {
      return;
    }

    // 1) 命令响应 (带 id)
    if (msg.id != null && this.pending.has(msg.id)) {
      const entry = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
        entry.reject(new Error(`CDP ${msg.error.message || 'unknown error'}`));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    // 2) 事件 (带 method) — 分发给等待者
    if (msg.method) {
      const waiters = this.eventWaiters.get(msg.method);
      if (waiters) {
        for (const w of Array.from(waiters)) {
          if (w.sessionId && msg.sessionId && w.sessionId !== msg.sessionId) continue;
          waiters.delete(w);
          w.resolve(msg.params);
        }
        if (waiters.size === 0) this.eventWaiters.delete(msg.method);
      }
    }
  }

  private onClose(): void {
    this.closed = true;
    // 连接断开 → 拒绝所有挂起请求, 并打 connectionLost 标记 (触发上层重建)
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      const err = new Error('CDP 连接已断开');
      (err as any).connectionLost = true;
      entry.reject(err);
    }
    this.pending.clear();
    for (const [, set] of this.eventWaiters) for (const w of set) w.resolve(null);
    this.eventWaiters.clear();
  }

  get isOpen(): boolean {
    return !this.closed && !!this.ws && this.ws.readyState === 1 /* OPEN */;
  }

  /** 发一条 CDP 命令并等结果 */
  request(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<any> {
    if (!this.isOpen || !this.ws) {
      const err = new Error('CDP 连接未就绪');
      (err as any).connectionLost = true;
      return Promise.reject(err);
    }
    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;

    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 命令超时: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws!.send(JSON.stringify(payload));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        const err = new Error(`CDP 发送失败: ${String(e)}`);
        (err as any).connectionLost = true;
        reject(err);
      }
    });
  }

  /** 等一次事件; 超时返回 null (不算失败) */
  waitForEvent(method: string, sessionId: string | undefined, timeoutMs: number): Promise<any | null> {
    return new Promise<any | null>((resolve) => {
      const waiter: EventWaiter = { sessionId, resolve };
      let set = this.eventWaiters.get(method);
      if (!set) {
        set = new Set();
        this.eventWaiters.set(method, set);
      }
      set.add(waiter);
      setTimeout(() => {
        const cur = this.eventWaiters.get(method);
        if (cur && cur.delete(waiter)) resolve(null);
      }, timeoutMs);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('CDP 客户端已关闭'));
    }
    this.pending.clear();
    this.eventWaiters.clear();
  }
}

// ---------------------------------------------------------------------------
// BrowserCdpSession
// ---------------------------------------------------------------------------

/**
 * 可复用的 Chrome CDP 会话。
 *   - 懒启动: 第一次 execute 时才 spawn Chrome。
 *   - 复用: 同一浏览器 + 同一页面 target, 多次调用共享状态 (登录/滚动位置等)。
 *   - 空闲 5 分钟自动关闭。
 */
export class BrowserCdpSession {
  private chromeProc: ChildProcess | null = null;
  private cdp: CdpClient | null = null;
  private port = 0;
  private userDataDir: string | null = null;
  private sessionId: string | null = null;
  private targetId: string | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private reqTimeout = DEFAULT_TIMEOUT_MS;

  /** 当前是否已启动 (供测试断言状态清理) */
  get isRunning(): boolean {
    return !!this.chromeProc && this.chromeProc.exitCode === null && !this.chromeProc.killed && this.cdp?.isOpen === true;
  }

  /** 启动 Chrome + 建立 CDP 连接 (幂等) */
  private async ensureStarted(): Promise<void> {
    if (this.isRunning) return;
    // 半启动状态残留 → 先清理
    if (this.chromeProc || this.cdp) await this.forceStop();

    const chromePath = resolveChromePath();
    if (!chromePath) {
      throw new Error('未找到 Chrome 可执行文件 (BOLLOON_CHROME_PATH 可指定)');
    }

    // 拿一个空闲端口 (bind 0 由系统分配) 再交给 Chrome, 避免端口冲突
    this.port = await getFreePort();
    this.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-chrome-'));

    const args = [
      '--headless=new',
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-extensions',
      '--window-size=1280,900',
      'about:blank'
    ];

    this.chromeProc = spawn(chromePath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    // Chrome 的 stderr 噪音很多, 吞掉即可 (不解析)
    this.chromeProc.stderr?.on('data', () => { /* noop */ });
    this.chromeProc.on('exit', () => {
      // 进程退出 → 让客户端知道连接已失效
      this.cdp?.close().catch(() => { /* ignore */ });
    });

    // 轮询 /json/version 等 Chrome 就绪
    const wsUrl = await fetchBrowserWsUrl(this.port, this.reqTimeout);

    // 连接浏览器级 ws, 然后创建一个页面 target 并 attach (flatten) 拿 sessionId
    this.cdp = new CdpClient(wsUrl);
    await this.cdp.connect(this.reqTimeout);

    const created = await this.cdp.request('Target.createTarget', { url: 'about:blank' }, undefined, this.reqTimeout);
    this.targetId = created.targetId as string;

    const attached = await this.cdp.request(
      'Target.attachToTarget',
      { targetId: this.targetId, flatten: true },
      undefined,
      this.reqTimeout
    );
    this.sessionId = attached.sessionId as string;

    // 打开 Page 域, 这样后面才能收到 Page.loadEventFired
    await this.cdp.request('Page.enable', {}, this.sessionId, this.reqTimeout);
  }

  /** 只 kill Chrome + 关闭 ws, 保留会话对象 (可再次 ensureStarted) */
  private async forceStop(): Promise<void> {
    try { await this.cdp?.close(); } catch { /* ignore */ }
    this.cdp = null;
    this.sessionId = null;
    this.targetId = null;

    const proc = this.chromeProc;
    this.chromeProc = null;
    if (proc && proc.exitCode === null && !proc.killed) {
      // 等进程真正退出再删临时目录, 否则 SIGKILL 后 Chrome 仍持有文件锁导致 rmSync 失败
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2000);
        proc.once('exit', () => { clearTimeout(timer); resolve(); });
        try { proc.kill('SIGKILL'); } catch { clearTimeout(timer); resolve(); }
      });
    }

    if (this.userDataDir) {
      // 带重试的目录清理 (文件锁释放有延迟)
      for (let i = 0; i < 3; i++) {
        try {
          fs.rmSync(this.userDataDir, { recursive: true, force: true });
          break;
        } catch {
          await sleep(150);
        }
      }
      this.userDataDir = null;
    }
  }

  /** 彻底关闭会话 (kill Chrome + 关 ws + 清理状态 + 停掉空闲计时器) */
  async shutdown(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    await this.forceStop();
  }

  /** 刷新空闲计时器: 每次调用后重置, 5 分钟无活动自动关闭 */
  private resetIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.shutdown().catch(() => { /* ignore */ });
    }, IDLE_SHUTDOWN_MS);
    // 不要因为这个计时器把进程挂住
    (this.idleTimer as any).unref?.();
  }

  // -------------------------------------------------------------------------
  // 底层便捷封装
  // -------------------------------------------------------------------------

  /** 页面级 CDP 命令 (自动带 sessionId + 超时) */
  private page(method: string, params: Record<string, unknown> = {}): Promise<any> {
    if (!this.cdp || !this.sessionId) throw new Error('浏览器会话未启动');
    return this.cdp.request(method, params, this.sessionId, this.reqTimeout);
  }

  /** 在页面里跑一段 JS, returnByValue */
  private async evaluate(expression: string, awaitPromise = false): Promise<any> {
    const r = await this.page('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise
    });
    if (r?.exceptionDetails) {
      const desc = r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'JS 执行异常';
      throw new Error(String(desc));
    }
    return r?.result?.value;
  }

  /** 坐标点击 (真实鼠标事件) */
  private async dispatchClick(x: number, y: number): Promise<void> {
    await this.page('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.page('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  // -------------------------------------------------------------------------
  // 主入口
  // -------------------------------------------------------------------------

  /**
   * 执行一次工具调用。
   * 全程 try/catch, 永远返回结构化结果, 不向调用方抛异常。
   */
  async execute(args: Record<string, string>): Promise<BrowserToolResult> {
    const action = String(args?.action ?? '').trim();
    if (!action) return { success: false, error: 'action 必填' };

    // close 不需要启动 Chrome, 直接关
    if (action === 'close') {
      await this.shutdown();
      return { success: true, output: '浏览器会话已关闭' };
    }

    // 解析超时
    const t = parseInt(String(args.timeoutMs ?? ''), 10);
    this.reqTimeout = Number.isFinite(t) && t > 0 ? t : DEFAULT_TIMEOUT_MS;

    this.resetIdle();

    // 最多 2 次: 第一次连接断开/进程崩溃则重建一次
    let rebuilt = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.ensureStarted();
        return await this.runAction(action, args);
      } catch (e) {
        if (!rebuilt && (isConnectionLost(e) || this.chromeProc === null)) {
          rebuilt = true;
          await this.forceStop();
          continue;
        }
        return { success: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
    return { success: false, error: '浏览器会话重建后仍失败' };
  }

  /** action 分发 */
  private async runAction(action: string, args: Record<string, string>): Promise<BrowserToolResult> {
    switch (action) {
      case 'open':
        return this.actionOpen(args);
      case 'text':
        return this.actionText(args);
      case 'html':
        return this.actionHtml(args);
      case 'links':
        return this.actionLinks();
      case 'screenshot':
        return this.actionScreenshot(args);
      case 'click':
        return this.actionClick(args);
      case 'type':
        return this.actionType(args);
      case 'key':
        return this.actionKey(args);
      case 'js':
        return this.actionJs(args);
      case 'back':
        return this.actionBack(args);
      default:
        return { success: false, error: `未知 action: ${action}` };
    }
  }

  /** open: Page.navigate + 等 Page.loadEventFired (超时不算失败, output 注明) */
  private async actionOpen(args: Record<string, string>): Promise<BrowserToolResult> {
    const url = String(args.url ?? '').trim();
    if (!url) return { success: false, error: 'open 需要 url' };

    // 先挂上 load 事件监听, 再 navigate, 避免竞态丢事件
    const loadWait = this.cdp!.waitForEvent('Page.loadEventFired', this.sessionId!, this.reqTimeout);
    const nav = await this.page('Page.navigate', { url });
    if (nav?.errorText) {
      return { success: false, error: `导航失败: ${nav.errorText}` };
    }

    const loaded = await loadWait;
    const title = await this.evaluate('document.title').catch(() => '');
    if (loaded === null) {
      return { success: true, output: `已打开 (load 事件等待超时, 页面可能仍在加载): ${url}\n标题: ${title ?? ''}` };
    }
    return { success: true, output: `已打开: ${url}\n标题: ${title ?? ''}` };
  }

  /** text: Runtime.evaluate 取 document.body.innerText (可带 selector), 截断 8000 */
  private async actionText(args: Record<string, string>): Promise<BrowserToolResult> {
    const selector = String(args.selector ?? '').trim();
    const expr = selector
      ? `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? (el.innerText || '') : ''; })()`
      : `(document.body ? document.body.innerText : '')`;
    const raw = String((await this.evaluate(expr)) ?? '');
    const text = raw.length > TRUNCATE_LEN ? raw.slice(0, TRUNCATE_LEN) + '\n...(已截断)' : raw;
    return { success: true, output: text };
  }

  /** html: 取 documentElement.outerHTML, 截断 8000 */
  private async actionHtml(args: Record<string, string>): Promise<BrowserToolResult> {
    const selector = String(args.selector ?? '').trim();
    const expr = selector
      ? `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.outerHTML : ''; })()`
      : `document.documentElement.outerHTML`;
    const raw = String((await this.evaluate(expr)) ?? '');
    const html = raw.length > TRUNCATE_LEN ? raw.slice(0, TRUNCATE_LEN) + '\n...(已截断)' : raw;
    return { success: true, output: html };
  }

  /** links: 取 a[href] 的 text + href, 最多 50 条 */
  private async actionLinks(): Promise<BrowserToolResult> {
    const value = await this.evaluate(
      `Array.from(document.querySelectorAll('a[href]')).slice(0, ${MAX_LINKS}).map(a => ({
        text: (a.innerText || a.textContent || '').trim().slice(0, 120),
        href: a.href
      }))`
    );
    const list: Array<{ text: string; href: string }> = Array.isArray(value) ? value : [];
    if (list.length === 0) return { success: true, output: '(未找到链接)' };
    const out = list.map((l, i) => `${i + 1}. ${l.text || '(无文本)'} → ${l.href}`).join('\n');
    return { success: true, output: out };
  }

  /** screenshot: Page.captureScreenshot, fullPage 时用 captureBeyondViewport:true */
  private async actionScreenshot(args: Record<string, string>): Promise<BrowserToolResult> {
    const fullPage = String(args.fullPage ?? '').toLowerCase() === 'true';
    const r = await this.page('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: fullPage
    });
    const data = r?.data as string | undefined;
    if (!data) return { success: false, error: '截图失败: 未返回 data' };
    const file = path.join(os.tmpdir(), `bolloon-browser-${Date.now()}.png`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    return { success: true, output: `截图已保存: ${file}`, screenshotPath: file };
  }

  /**
   * click: 有 selector 时先 scrollIntoView, 取 getBoundingClientRect 中心后用
   * Input.dispatchMouseEvent 发真实鼠标事件; 元素不可见时退回 el.click()。
   * 坐标模式 (x/y) 直接 Input.dispatchMouseEvent。
   */
  private async actionClick(args: Record<string, string>): Promise<BrowserToolResult> {
    const selector = String(args.selector ?? '').trim();

    if (selector) {
      const info = await this.evaluate(
        `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return { found: false };
          el.scrollIntoView({ block: 'center', inline: 'center' });
          const r = el.getBoundingClientRect();
          return { found: true, x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, tag: el.tagName };
        })()`
      );
      if (!info?.found) return { success: false, error: `click 找不到元素: ${selector}` };

      if (info.w > 0 && info.h > 0) {
        // 真实鼠标事件 (验证真实点击行为)
        await this.dispatchClick(Math.round(info.x), Math.round(info.y));
        return { success: true, output: `已点击 <${String(info.tag).toLowerCase()}> ${selector} @ (${Math.round(info.x)},${Math.round(info.y)})` };
      }
      // 元素尺寸为 0 (隐藏) → 退回直接 el.click()
      await this.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el) el.click(); })()`);
      return { success: true, output: `已 el.click() (元素不可见): ${selector}` };
    }

    // 坐标模式
    const x = Number(args.x);
    const y = Number(args.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { success: false, error: 'click 需要 selector 或 x/y 坐标' };
    }
    await this.dispatchClick(Math.round(x), Math.round(y));
    return { success: true, output: `已点击坐标 (${Math.round(x)},${Math.round(y)})` };
  }

  /** type: 有 selector 先聚焦/点击, 再 Input.insertText */
  private async actionType(args: Record<string, string>): Promise<BrowserToolResult> {
    const text = String(args.text ?? '');
    const selector = String(args.selector ?? '').trim();
    if (selector) {
      const ok = await this.evaluate(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.scrollIntoView({block:'center'}); el.focus(); if (el.click) el.click(); return true; })()`
      );
      if (!ok) return { success: false, error: `type 找不到元素: ${selector}` };
    }
    // insertText: 直接把文本插入当前焦点, 不模拟逐键
    await this.page('Input.insertText', { text });
    return { success: true, output: `已输入 ${text.length} 字符${selector ? ` → ${selector}` : ''}` };
  }

  /** key: Input.dispatchKeyEvent (rawKeyDown [+ char] + keyUp) */
  private async actionKey(args: Record<string, string>): Promise<BrowserToolResult> {
    const key = String(args.key ?? '').trim();
    if (!key) return { success: false, error: 'key 必填' };

    // 常用键 → { key, code, vk, text }
    const table: Record<string, { key: string; code: string; vk: number; text?: string }> = {
      Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
      Tab: { key: 'Tab', code: 'Tab', vk: 9 },
      Escape: { key: 'Escape', code: 'Escape', vk: 27 },
      Esc: { key: 'Escape', code: 'Escape', vk: 27 },
      Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
      Delete: { key: 'Delete', code: 'Delete', vk: 46 },
      ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
      ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
      ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
      ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
      Space: { key: ' ', code: 'Space', vk: 32, text: ' ' }
    };
    const info = table[key] ?? { key, code: key, vk: 0 };

    // rawKeyDown: 不产生 char 事件 (Enter 单独补 char)
    await this.page('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: info.key,
      code: info.code,
      windowsVirtualKeyCode: info.vk,
      nativeVirtualKeyCode: info.vk
    });
    // Enter/Space 需要额外 char 事件才能真正生效
    if (info.text) {
      await this.page('Input.dispatchKeyEvent', {
        type: 'char',
        key: info.key,
        code: info.code,
        text: info.text,
        unmodifiedText: info.text,
        windowsVirtualKeyCode: info.vk,
        nativeVirtualKeyCode: info.vk
      });
    }
    await this.page('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: info.key,
      code: info.code,
      windowsVirtualKeyCode: info.vk,
      nativeVirtualKeyCode: info.vk
    });
    return { success: true, output: `已按键: ${key}` };
  }

  /** js: Runtime.evaluate 表达式, 返回值 JSON 化; exceptionDetails → error */
  private async actionJs(args: Record<string, string>): Promise<BrowserToolResult> {
    const code = String(args.code ?? '').trim();
    if (!code) return { success: false, error: 'js 需要 code' };

    const r = await this.page('Runtime.evaluate', { expression: code, returnByValue: true, awaitPromise: true });
    if (r?.exceptionDetails) {
      const desc = r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'JS 执行异常';
      return { success: false, error: String(desc) };
    }
    const v = r?.result?.value;
    let out: string;
    if (typeof v === 'string') out = v;
    else if (v === undefined) out = r?.result?.description != null ? String(r.result.description) : 'undefined';
    else out = JSON.stringify(v);
    return { success: true, output: out };
  }

  /** back: history.back() + 等一次 load */
  private async actionBack(args: Record<string, string>): Promise<BrowserToolResult> {
    const loadWait = this.cdp!.waitForEvent('Page.loadEventFired', this.sessionId!, this.reqTimeout);
    await this.evaluate('history.back()');
    const loaded = await loadWait;
    const url = await this.evaluate('location.href').catch(() => '');
    return {
      success: true,
      output: loaded === null ? `已后退 (load 超时): ${url ?? ''}` : `已后退: ${url ?? ''}`
    };
  }
}

// ---------------------------------------------------------------------------
// 模块级共享会话 + 工具注册
// ---------------------------------------------------------------------------

const activeSessions = new Set<BrowserCdpSession>();
let sharedSession: BrowserCdpSession | null = null;

function getSharedSession(): BrowserCdpSession {
  if (!sharedSession) {
    sharedSession = new BrowserCdpSession();
    activeSessions.add(sharedSession);
  }
  return sharedSession;
}

/** 测试/退出时清理所有会话 (kill Chrome + 关闭 ws) */
export async function __shutdownBrowserForTest(): Promise<void> {
  for (const s of Array.from(activeSessions)) {
    try { await s.shutdown(); } catch { /* ignore */ }
  }
  activeSessions.clear();
  sharedSession = null;
}

/** 注册 'browser' 工具到 ctx.tools */
export function registerBrowserTools(ctx: ToolRegistryContext): void {
  ctx.tools.set('browser', {
    name: 'browser',
    description:
      '驱动真实浏览器 (Chrome CDP)。action 可选: open(打开网址) / text(取可见文本) / html(取 DOM) / ' +
      'links(取链接列表) / screenshot(截图存文件) / click(点击选择器或坐标) / type(输入文本) / key(按键) / ' +
      'js(执行 JS) / back / close。首次调用自动启动 headless Chrome, 后续复用同一会话。',
    parameters: {
      action: 'open|text|html|links|screenshot|click|type|key|js|back|close (必填)',
      url: 'open 的网址 (http/https/file/data 均可)',
      selector: 'CSS 选择器 (click/type/text 用)',
      x: 'click 坐标 x (无 selector 时用)',
      y: 'click 坐标 y',
      text: 'type 要输入的文本',
      key: 'key 要按的键 (Enter/Tab/Escape/ArrowDown...)',
      code: 'js 要执行的表达式',
      fullPage: 'screenshot 是否整页, "true"|"false"',
      timeoutMs: '超时毫秒, 默认 20000'
    },
    execute: async (args): Promise<BrowserToolResult> => {
      try {
        const session = getSharedSession();
        const result = await session.execute(args);
        // close 之后销毁共享会话, 下次调用重新懒启动
        if (String(args?.action ?? '').trim() === 'close') {
          activeSessions.delete(session);
          sharedSession = null;
        }
        return result;
      } catch (e) {
        // 兜底: execute 内部已 try/catch, 这里防止极端情况抛出
        return { success: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
  });
}
