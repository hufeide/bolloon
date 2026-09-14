/**
 * computer-use.ts — 桌面操作 (computer_use 工具)
 *
 * 让 agent 真的去操作人类桌面: 截图看屏幕 / 移动点击 / 输入文字 / 按键 / 滚动 /
 * 读写剪贴板 / 查询前台 App / 打开 App 或网址。
 *
 * 平台: macOS 已实现 (screencapture + osascript System Events + pbcopy/pbpaste + open)。
 *   其他平台如实返回"不支持", 不假装成功。
 * 权限: 点击/按键/取窗口列表需要 系统设置 → 隐私与安全性 → 辅助功能 授权给运行进程
 *   (终端 / bolloon)。未授权时 osascript 报 -1719 / "not allowed assistive access",
 *   这里翻译成可操作的中文提示。
 *
 * 注意: 这个工具能点到屏幕上任何东西 → 默认 permission mode 下被 deny-pipeline 拦,
 *   需要显式切到 acceptEdits / bypassPermissions 才放行。
 */

import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { ToolRegistryContext } from './pi-sdk-tools.js';

export interface ExecResult { code: number; stdout: string; stderr: string }
export type ExecFn = (cmd: string, args: string[], opts?: { input?: string; timeoutMs?: number }) => Promise<ExecResult>;

export interface ComputerUseDeps {
  platform?: string;
  exec?: ExecFn;
  tmpDir?: string;
}

export interface ComputerUseResult {
  success: boolean;
  output?: string;
  error?: string;
  /** screenshot 生成的文件绝对路径 */
  path?: string;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/** 默认执行器: execFile (shell:false, 不走 shell 拼接) */
export const defaultExec: ExecFn = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      { timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err && typeof (err as any).code === 'number' ? (err as any).code : (err ? 1 : 0);
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    } else {
      child.stdin?.end();
    }
  });

/** 常见命名键 → macOS key code */
const KEY_CODES: Record<string, number> = {
  return: 36, enter: 36, tab: 48, space: 49, backspace: 51, delete: 51,
  forwarddelete: 117, escape: 53, esc: 53,
  left: 123, right: 124, down: 125, up: 126,
  home: 115, end: 119, pageup: 116, pagedown: 121,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100,
  f9: 101, f10: 109, f11: 103, f12: 111,
};

/** 辅助功能未授权时的错误翻译 */
function translatePermissionError(stderr: string): string | null {
  const s = String(stderr || '');
  if (/not allowed assistive access|-1719|1743|assistive/i.test(s)) {
    return '系统未授权"辅助功能"。请到 系统设置 → 隐私与安全性 → 辅助功能, 勾选运行 bolloon 的终端 (或 bolloon 本体) 后再试。';
  }
  if (/not authorized|-1743|osascript is not allowed to send keystrokes/i.test(s)) {
    return '系统未授权发送按键。请到 系统设置 → 隐私与安全性 → 辅助功能 授权后再试。';
  }
  return null;
}

/** 跑 AppleScript (通过 run argv 传参, 免转义地狱) */
async function osa(exec: ExecFn, scriptLines: string[], argv: string[] = [], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ExecResult> {
  const args: string[] = [];
  for (const line of scriptLines) args.push('-e', line);
  args.push('--', ...argv);
  return exec('osascript', args, { timeoutMs });
}

/** 修饰键解析: "cmd+shift+t" → { modifiers:['command down','shift down'], key:'t' } */
function parseCombo(spec: string): { modifiers: string[]; key: string } {
  const parts = String(spec || '').split('+').map((p) => p.trim()).filter(Boolean);
  const key = parts.pop() ?? '';
  const modifiers = parts.map((m) => {
    const k = m.toLowerCase();
    if (k === 'cmd' || k === 'command' || k === 'meta' || k === 'super') return 'command down';
    if (k === 'ctrl' || k === 'control') return 'control down';
    if (k === 'alt' || k === 'option' || k === 'opt') return 'option down';
    if (k === 'shift') return 'shift down';
    return '';
  }).filter(Boolean);
  return { modifiers, key };
}

/**
 * 执行一个桌面动作。所有分支都返回结构化结果, 不抛异常。
 */
export async function runComputerUseAction(
  action: string,
  args: Record<string, any>,
  deps: ComputerUseDeps = {},
): Promise<ComputerUseResult> {
  const platform = deps.platform ?? process.platform;
  const exec = deps.exec ?? defaultExec;
  const tmpDir = deps.tmpDir ?? os.tmpdir();
  const act = String(action || '').trim().toLowerCase();
  if (!act) return { success: false, error: 'action 必填' };
  if (platform !== 'darwin') {
    return {
      success: false,
      error: `computer_use 目前在 macOS 上实现 (当前平台 ${platform})。其他平台可用 browser 工具或 terminal 完成同类任务。`,
    };
  }

  const fail = (r: ExecResult, fallback: string): ComputerUseResult => {
    const perm = translatePermissionError(r.stderr) || translatePermissionError(r.stdout);
    if (perm) return { success: false, error: perm };
    return { success: false, error: `${fallback}: ${(r.stderr || r.stdout || `exit ${r.code}`).trim().slice(0, 300)}` };
  };

  try {
    switch (act) {
      case 'screenshot': {
        const file = args.path
          ? String(args.path)
          : path.join(tmpDir, `bolloon-screen-${Date.now()}.png`);
        await fs.mkdir(path.dirname(file), { recursive: true }).catch(() => {});
        // -x: 静音; -R x,y,w,h: 指定区域
        const argv = ['-x'];
        if (args.x !== undefined && args.y !== undefined && args.width !== undefined && args.height !== undefined) {
          argv.push('-R', `${Number(args.x)},${Number(args.y)},${Number(args.width)},${Number(args.height)}`);
        }
        argv.push(file);
        const r = await exec('screencapture', argv, { timeoutMs: DEFAULT_TIMEOUT_MS });
        if (r.code !== 0) return fail(r, '截图失败');
        const st = await fs.stat(file).catch(() => null);
        if (!st || st.size === 0) return { success: false, error: `截图文件为空: ${file}` };
        return { success: true, path: file, output: `📸 截图已保存: ${file} (${Math.round(st.size / 1024)} KB)\n提示: 用 read_file 读图片需要视觉模型; 也可先拍照再判断坐标。` };
      }

      case 'screen_size': {
        const r = await osa(exec, ['tell application "Finder" to get bounds of window of desktop']);
        if (r.code !== 0) return fail(r, '取屏幕尺寸失败');
        const m = r.stdout.trim().match(/(-?\d+),\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)/);
        if (!m) return { success: false, error: `无法解析屏幕尺寸: ${r.stdout.trim()}` };
        const w = Number(m[3]) - Number(m[1]);
        const h = Number(m[4]) - Number(m[2]);
        return { success: true, output: `屏幕 ${w}x${h} (原点 ${m[1]},${m[2]})` };
      }

      case 'frontmost': {
        const r = await osa(exec, ['tell application "System Events" to get name of first application process whose frontmost is true']);
        if (r.code !== 0) return fail(r, '查询前台 App 失败');
        return { success: true, output: `前台 App: ${r.stdout.trim()}` };
      }

      case 'list_windows': {
        const r = await osa(exec, [
          'tell application "System Events"',
          'set out to ""',
          'repeat with p in (every application process whose visible is true)',
          'set out to out & (name of p) & linefeed',
          'end repeat',
          'return out',
          'end tell',
        ]);
        if (r.code !== 0) return fail(r, '列窗口失败 (需要辅助功能授权)');
        const names = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
        return { success: true, output: names.length ? `可见 App (${names.length}):\n${names.map((n) => `  · ${n}`).join('\n')}` : '无可见 App' };
      }

      case 'click':
      case 'doubleclick':
      case 'move': {
        const x = Number(args.x);
        const y = Number(args.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return { success: false, error: 'click/move 需要 x, y 坐标 (数字)' };
        if (act === 'move') {
          // System Events 无 move; 用 click at 的副作用会真的点下去 → 明确不支持, 不假装
          return { success: false, error: 'macOS System Events 不支持"仅移动不点击"; 请直接用 click (x, y)' };
        }
        const times = act === 'doubleclick' ? 2 : 1;
        for (let i = 0; i < times; i++) {
          const r = await osa(exec, ['tell application "System Events" to click at {item 1 of argv as integer, item 2 of argv as integer}'], [String(Math.round(x)), String(Math.round(y))]);
          if (r.code !== 0) return fail(r, '点击失败 (需要辅助功能授权)');
          if (times > 1) await new Promise((res) => setTimeout(res, 80));
        }
        return { success: true, output: `🖱️ 已${times > 1 ? '双击' : '点击'} (${Math.round(x)}, ${Math.round(y)})` };
      }

      case 'type': {
        const text = String(args.text ?? '');
        if (!text) return { success: false, error: 'type 需要 text' };
        // keystroke 经 argv 传入, 换行分段敲 (keystroke 不含回车)
        const segments = text.split('\n');
        for (let i = 0; i < segments.length; i++) {
          if (segments[i]) {
            const r = await osa(exec, ['tell application "System Events" to keystroke (item 1 of argv)'], [segments[i]]);
            if (r.code !== 0) return fail(r, '输入文字失败 (需要辅助功能授权)');
          }
          if (i < segments.length - 1) {
            const r2 = await osa(exec, ['tell application "System Events" to key code 36']);
            if (r2.code !== 0) return fail(r2, '回车失败');
          }
        }
        return { success: true, output: `⌨️ 已输入 ${text.length} 字符 (到前台 App)` };
      }

      case 'key': {
        const spec = String(args.key ?? args.keys ?? '').trim();
        if (!spec) return { success: false, error: 'key 需要按键名 (如 Enter / cmd+shift+t / ArrowDown)' };
        const { modifiers, key } = parseCombo(spec);
        const usingClause = modifiers.length ? ` using {${modifiers.join(', ')}}` : '';
        const lower = key.toLowerCase().replace(/^arrow/, '');
        const code = KEY_CODES[lower];
        if (code !== undefined) {
          const script = modifiers.length
            ? `tell application "System Events" to key code ${code} using {${modifiers.join(', ')}}`
            : `tell application "System Events" to key code ${code}`;
          const r = await osa(exec, [script]);
          if (r.code !== 0) return fail(r, '按键失败 (需要辅助功能授权)');
        } else {
          if (key.length !== 1) {
            return {
              success: false,
              error: `不认识的按键: ${key}。可用: Enter / Tab / Escape / Space / Backspace / Delete / ArrowUp / ArrowDown / ArrowLeft / ArrowRight / Home / End / PageUp / PageDown / F1-F12, 或用单字符组合 (如 cmd+c / ctrl+shift+t)`,
            };
          }
          const r = await osa(exec, [`tell application "System Events" to keystroke (item 1 of argv)${usingClause}`], [key]);
          if (r.code !== 0) return fail(r, '按键失败 (需要辅助功能授权)');
        }
        return { success: true, output: `⌨️ 已按 ${spec}` };
      }

      case 'scroll': {
        const dir = String(args.direction || 'down').toLowerCase();
        const amount = Math.max(1, Math.min(30, Number(args.amount) || 3));
        // 无原生滚动 API → 用 PageDown/PageUp (116/121) 近似, 并如实说明
        const code = dir === 'up' ? 116 : 121;
        for (let i = 0; i < amount; i++) {
          const r = await osa(exec, [`tell application "System Events" to key code ${code}`]);
          if (r.code !== 0) return fail(r, '滚动失败 (需要辅助功能授权)');
        }
        return { success: true, output: `🖱️ 已向${dir === 'up' ? '上' : '下'}滚动 ${amount} 屏 (Page${dir === 'up' ? 'Up' : 'Down'} 近似)` };
      }

      case 'clipboard_get': {
        const r = await exec('pbpaste', []);
        if (r.code !== 0) return fail(r, '读剪贴板失败');
        const text = r.stdout;
        return { success: true, output: text ? `📋 剪贴板 (${text.length} 字符):\n${text.slice(0, 2000)}${text.length > 2000 ? '\n...(截断)' : ''}` : '📋 剪贴板为空' };
      }

      case 'clipboard_set': {
        const text = String(args.text ?? '');
        const r = await exec('pbcopy', [], { input: text });
        if (r.code !== 0) return fail(r, '写剪贴板失败');
        return { success: true, output: `📋 已写入剪贴板 (${text.length} 字符)` };
      }

      case 'open_app':
      case 'open': {
        const target = String(args.app ?? args.url ?? args.target ?? '').trim();
        if (!target) return { success: false, error: 'open_app 需要 app 名 或 url' };
        const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(target);
        const argv = isUrl ? [target] : ['-a', target];
        const r = await exec('open', argv, { timeoutMs: DEFAULT_TIMEOUT_MS });
        if (r.code !== 0) return fail(r, `打开 ${target} 失败`);
        return { success: true, output: `🚀 已打开: ${target}` };
      }

      default:
        return {
          success: false,
          error: `未知 action '${action}'. 可用: screenshot / screen_size / frontmost / list_windows / click / doubleclick / type / key / scroll / clipboard_get / clipboard_set / open_app`,
        };
    }
  } catch (e: any) {
    return { success: false, error: `computer_use 执行异常: ${String(e?.message || e).slice(0, 300)}` };
  }
}

/** 注册 computer_use 工具 */
export function registerComputerUseTools(ctx: ToolRegistryContext): void {
  ctx.tools.set('computer_use', {
    name: 'computer_use',
    description: '操作人类桌面 (macOS): 截图看屏幕 / 点击 / 双击 / 输入文字 / 按键 (含 cmd+c 组合键) / 滚动 / 读剪贴板 / 写剪贴板 / 查前台 App / 列可见 App / 打开 App 或网址。截图后用 read_file 看图片确定坐标, 再 click。点击与按键需要系统"辅助功能"授权。',
    parameters: {
      action: 'screenshot | screen_size | frontmost | list_windows | click | doubleclick | type | key | scroll | clipboard_get | clipboard_set | open_app (必填)',
      x: 'click/doubleclick 的 x 坐标 (必填)',
      y: 'click/doubleclick 的 y 坐标 (必填)',
      text: 'type / clipboard_set 的文本',
      key: 'key 要按的键: Enter / Tab / Escape / ArrowDown / cmd+shift+t',
      direction: 'scroll 方向: up | down (默认 down)',
      amount: 'scroll 屏数 (1-30, 默认 3)',
      app: 'open_app 的 App 名 (如 Safari)',
      url: 'open_app 也可直接给网址',
      path: 'screenshot 保存路径 (可选, 默认 /tmp)',
    },
    execute: async (args) => {
      const action = String(args.action || '').trim();
      try {
        return await runComputerUseAction(action, args);
      } catch (e: any) {
        return { success: false, error: `computer_use 失败: ${String(e?.message || e).slice(0, 200)}` };
      }
    },
  });
}
