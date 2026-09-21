/**
 * task-frame-node.ts — 起一个**真的** bolloon-task/1 任务帧节点 (P3, 2026-09-21)
 *
 * 用途: 双进程/跨机端到端验收 —— 一端起这个节点, 另一端用
 *   `bolloon task send --endpoint http://127.0.0.1:<port>`
 * 真发签名任务请求过来 (真 TCP, 真跨进程)。
 *
 * 用法:
 *   npx tsx scripts/task-frame-node.ts --port 54901 --home /tmp/nodeA [--capabilities research,coding]
 *
 * 注意: 这个端点**只落待处理收件箱** —— 不执行任务、不付款、不自动接单。
 */
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

function arg(name: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
}

const port = Number(arg('--port', '54901'));
const homeArg = arg('--home');
if (homeArg) {
  const home = path.resolve(homeArg);
  fs.mkdirSync(home, { recursive: true });
  // 必须在 import 业务模块**之前**覆盖 HOME (所有 store 都在 import 时求 home)
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.BOLLOON_SKIP_SETUP = '1';
}
const caps = String(arg('--capabilities', '') || '').split(',').map((s) => s.trim()).filter(Boolean);

const { createTaskFrameApp } = await import('../src/web/task-frame-server.js');
const { getUserOwnerDid } = await import('../src/agents/agent-identity.js');
const { loadLocalSigner } = await import('../src/agents/local-signer.js');

const selfDid = getUserOwnerDid() || '';
const signer = await loadLocalSigner(process.env.HOME);
const app = createTaskFrameApp({
  home: process.env.HOME,
  selfDid,
  capabilities: caps,
});

const server = app.listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({
    ok: true,
    node: 'bolloon-task-frame-node',
    port,
    home: process.env.HOME,
    selfDid: selfDid || null,
    publicKeyHex: signer?.publicKeyHex ? `${signer.publicKeyHex.slice(0, 16)}…` : null,
    capabilities: caps,
    endpoints: { health: `http://127.0.0.1:${port}/api/task/health`, frame: `http://127.0.0.1:${port}/api/task/frame` },
    note: '只落待处理收件箱: 不执行、不付款、不自动接单',
    pid: process.pid,
    cwd: os.homedir(),
  }));
});

const shutdown = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 500).unref?.(); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
