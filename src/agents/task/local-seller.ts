/**
 * local-seller.ts — M1 的"卖方" (本地 Registry 节点)
 *
 * M1 只做**本地 Registry**: 卖方就是你自己本机的报价端点。
 * 这里**不重新实现协议** —— 直接把项目真实的卖方路由
 * (`src/web/routes-x402-info.ts: registerX402InfoRoutes`) 挂到一个极小的
 * express 风格适配器上, 用真 HTTP 跑真 402 → 付款校验 → 签名信封。
 *
 * 注意: 卖方路由内部用 `os.homedir()` 找 `~/.bolloon/{identity.json, x402-info/}`,
 *       所以调用方若做隔离测试, 需要在启动前设好 `process.env.HOME`。
 */

import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

interface MiniRoute {
  method: string;
  path: string;
  handler: (req: any, res: any) => any;
}

export interface MiniApp {
  get(path: string, handler: (req: any, res: any) => any): void;
  post(path: string, handler: (req: any, res: any) => any): void;
  delete(path: string, handler: (req: any, res: any) => any): void;
}

function matchPath(pattern: string, actual: string): { hit: boolean; params: Record<string, string> } {
  const p = pattern.split('/').filter(Boolean);
  const a = actual.split('/').filter(Boolean);
  if (pattern.endsWith('/') && p.length !== a.length) return { hit: false, params: {} };
  if (p.length !== a.length) return { hit: false, params: {} };
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(a[i]);
    else if (p[i] !== a[i]) return { hit: false, params: {} };
  }
  return { hit: true, params };
}

function makeRes(): { res: any; done: Promise<{ status: number; headers: Record<string, string>; body: string }> } {
  let settle: (v: any) => void;
  const done = new Promise<{ status: number; headers: Record<string, string>; body: string }>((r) => { settle = r; });
  const headers: Record<string, string> = {};
  const res: any = {
    _status: 200,
    status(n: number) { res._status = n; return res; },
    set(k: string, v: string) { headers[k] = String(v); return res; },
    json(obj: any) {
      headers['content-type'] = 'application/json';
      settle({ status: res._status, headers, body: JSON.stringify(obj ?? null) });
      return res;
    },
    send(text: string) {
      settle({ status: res._status, headers, body: String(text ?? '') });
      return res;
    },
  };
  return { res, done };
}

/** 极小的 express 风格 app (只实现卖方路由用到的 get/post/delete + res.json/status/set) */
export function createMiniApp(): { app: MiniApp; dispatch: (method: string, url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; headers: Record<string, string>; body: string } | null> } {
  const routes: MiniRoute[] = [];
  const add = (method: string) => (p: string, h: (req: any, res: any) => any) => { routes.push({ method, path: p, handler: h }); };
  const app: MiniApp = { get: add('GET'), post: add('POST'), delete: add('DELETE') };

  const dispatch = async (method: string, url: string, headers: Record<string, string>, body: string) => {
    const u = new URL(url, 'http://127.0.0.1');
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = matchPath(r.path, u.pathname);
      if (!m.hit) continue;
      const { res, done } = makeRes();
      let parsed: any = undefined;
      if (body) { try { parsed = JSON.parse(body); } catch { parsed = undefined; } }
      const req: any = {
        method,
        url,
        headers,
        params: m.params,
        query: Object.fromEntries(u.searchParams.entries()),
        body: parsed,
        protocol: 'http',
      };
      try {
        await r.handler(req, res);
      } catch (e: any) {
        return { status: 500, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: String(e?.message || e) }) };
      }
      return await done;
    }
    return null;
  };

  return { app, dispatch };
}

/** 卖方的 DIAP 身份 (签发信封用) — 缺失就生成一个本机身份, 不静默跳过 */
export async function ensureSellerIdentity(home: string = os.homedir()): Promise<{ created: boolean; did?: string }> {
  const dir = path.join(home, '.bolloon');
  const file = path.join(dir, 'identity.json');
  if (fs.existsSync(file)) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { created: false, did: raw?.did };
    } catch {
      return { created: false };
    }
  }
  try {
    const { KeyManager } = await import('@diap/sdk');
    const kp = (KeyManager as any).generate();
    fs.mkdirSync(dir, { recursive: true });
    await (KeyManager as any).saveToFile(kp, file);
    return { created: true, did: kp?.did };
  } catch (e: any) {
    return { created: false };
  }
}

export interface LocalSeller {
  url: string;
  port: number;
  /** 当前卖家拥有的报价数 (方便脚本判断"还没发布就买"这种错) */
  itemCount: () => Promise<number>;
  close: () => Promise<void>;
}

/** 启动本地卖方节点: 真 HTTP + 项目真实卖方路由 */
export async function startLocalSeller(opts: { port?: number } = {}): Promise<LocalSeller> {
  const { registerX402InfoRoutes } = await import('../../web/routes-x402-info.js');
  const { app, dispatch } = createMiniApp();
  registerX402InfoRoutes(app);
  const { listInfo } = await import('../x402/paid-info-store.js');

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const out = await dispatch(req.method || 'GET', req.url || '/', req.headers as any, body);
      if (!out) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      res.writeHead(out.status, out.headers);
      res.end(out.body);
    });
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', () => resolve()));
  const port = (server.address() as any)?.port as number;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    itemCount: async () => (await listInfo()).length,
    close: async () => { await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}
