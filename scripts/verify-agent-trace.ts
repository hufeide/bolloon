/**
 * verify-agent-trace.ts — 智能体工具执行轨迹 + P2P 信息 真跑验收 (2026-09-18)
 *
 * 真: 真 LLM agent session · 真在本机执行工具 (write_file / shell_exec) · 真 Run 落盘 ·
 *     真 HTTP (web server) 取 trace 与 p2p 信息。
 * 跨边界: 导出的轨迹文本必须能被**小工具侧的解析规则**读懂 (见 minitools/agent-card/src/assets/app.js 的 parseTraceText);
 *         P2P 信息里的 peerId/multiaddr 必须能过小工具的校验规则 (agent-card store.js 的 checkPeerId/checkMultiaddr)。
 *
 * 用法: npx tsx scripts/verify-agent-trace.ts
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

const REAL_HOME = os.homedir();                      // 必须在覆盖 HOME 之前取
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-trace-'));
const HOME = path.join(ROOT, 'home');
const BHOME = path.join(HOME, '.bolloon');
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.BOLLOON_SKIP_KUBO = '1';
process.env.BOLLOON_CRON = '0';
process.env.BOLLOON_SUPERVISOR = '0';
process.env.BOLLOON_RUN_MAX_STEPS = '8';
fs.mkdirSync(BHOME, { recursive: true });

const { makeSetupReady } = await import('./lib/make-setup-ready.js');
const ready = makeSetupReady(BHOME, { realHome: REAL_HOME, name: '轨迹验收' });

const R: any = await import('../src/agents/run-store.js');
const T: any = await import('../src/agents/trace-export.js');
const P: any = await import('../src/agents/p2p-info.js');

let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d?: unknown) => {
  if (ok) { passed++; console.log(`  ✅ ${n}`); }
  else { failed++; console.log(`  ❌ ${n}${d !== undefined ? ` — ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 220)}` : ''}`); }
};
const section = (t: string) => console.log(`\n${t}`);

// ── 小工具侧的解析/校验规则 (照 minitools/agent-card/src/assets/*.js 抄, 用作跨边界断言) ──
const MINITOOL_STEP_RE = /^\s*(\d+)\.\s*\[(ok|fail)\]\s*(\S+)\s*(\S+)\s*(?:—\s*)?([\s\S]*)$/;
function minitoolParseTrace(text: string) {
  const steps: any[] = [];
  for (const line of String(text || '').split('\n')) {
    const m = MINITOOL_STEP_RE.exec(line.replace(/\r$/, ''));
    if (!m) continue;
    steps.push({ n: Number(m[1]), ok: m[2] === 'ok', ts: m[3], tool: m[4], detail: String(m[5] || '').trim() });
  }
  return steps;
}
const MINI_PEER_RE = /^(12D3KooW[1-9A-HJ-NP-Za-km-z]{20,60}|Qm[1-9A-HJ-NP-Za-km-z]{40,50})$/;
function miniPeerOk(v: string) { return MINI_PEER_RE.test(String(v || '').trim()); }
function miniAddrCheck(v: string) {
  const s = String(v || '').trim();
  if (!s) return { ok: false, why: '空' };
  if (s.charAt(0) !== '/') return { ok: false, why: '不是以 / 开头' };
  if (s.indexOf('/p2p/') === -1) return { ok: false, why: '缺 /p2p/<peerId> 段' };
  return { ok: true, relay: s.indexOf('p2p-circuit') !== -1 };
}

async function main() {
  section('[1] 真 agent 在本机执行真工具');
  const work = path.join(ROOT, 'work');
  fs.mkdirSync(work, { recursive: true });
  const probe = path.join(work, 'trace-probe.txt');

  // 真 LLM: 独立宿主必须自己初始化 (2-C.2 教训: 不初始化 → 走 fallback, 工具根本没执行)
  const { initMinimax } = await import('../src/constraints/index.js');
  initMinimax();

  const { createAgentSession } = await import('../src/agents/pi-sdk-session-factory.js');
  const agent: any = await createAgentSession({ cwd: work } as any, true);
  await agent.setGoalId?.(undefined);
  const answer = await agent.prompt(
    `依次做两件事, 做完就结束:\n1) 用 write_file 把 "trace-probe-ok" 写入 ${probe}\n2) 用 shell_exec 运行: ls -1 ${work} | head -3`,
    { signal: undefined } as any,
  );
  const runId = agent.getLastRunId?.() || agent.getRunId?.();
  const run = runId ? await R.readRun(runId) : null;
  check('产生了 Run 记录', !!run, runId);
  check('Run 里记了真实工具步骤 (≥2)', (run?.steps || []).length >= 2, (run?.steps || []).map((s: any) => s.tool));
  check('探针文件真被写到本机', fs.existsSync(probe) && fs.readFileSync(probe, 'utf8').includes('trace-probe-ok'), fs.existsSync(probe));
  const tools = (run?.steps || []).map((s: any) => s.tool);
  check('没有走 LLM fallback (真模型真执行)', !(run?.steps || []).some((s: any) => s.tool === 'llm' && !s.ok), tools);
  check('记到了写文件工具 (write_file)', tools.includes('write_file'), tools);
  check('记到了在本机执行命令的工具 (terminal/shell_exec/execute_code)',
    tools.some((t: string) => ['terminal', 'shell_exec', 'execute_code', 'bash'].includes(t)), tools);
  check('轨迹里看得见参数摘要 (执行了什么)', (run?.steps || []).some((s: any) => !!s.argsDigest), (run?.steps || []).map((s: any) => s.argsDigest));
  check('每步有 时间戳/成败/耗时 字段', (run?.steps || []).every((s: any) => !!s.ts && typeof s.ok === 'boolean'), run?.steps?.[0]);
  check('成功步骤带摘要 (可直接读)', (run?.steps || []).some((s: any) => s.ok && s.summary), (run?.steps || []).filter((s: any) => s.summary).slice(0, 1));
  check('agent 如实汇报 (回答非空)', String(answer || '').length > 0, String(answer || '').slice(0, 80));

  section('[2] 轨迹文本导出 + 往返解析 (Bolloon 侧解析器)');
  const text = T.runToTraceText(run);
  check('文本带统一表头', text.startsWith(T.TRACE_HEADER_PREFIX), text.split('\n')[0]);
  const parsed = T.parseTraceText(text);
  check('解析回来的步数与 Run 一致', parsed.steps.length === (run?.steps || []).length, { parsed: parsed.steps.length, run: (run?.steps || []).length });
  check('工具名一致', JSON.stringify(parsed.steps.map((s: any) => s.tool)) === JSON.stringify(tools), parsed.steps.map((s: any) => s.tool));
  check('成败标记一致', JSON.stringify(parsed.steps.map((s: any) => s.ok)) === JSON.stringify((run?.steps || []).map((s: any) => s.ok)), parsed.steps.map((s: any) => s.ok));
  check('耗时被解析回来', parsed.steps.some((s: any) => typeof s.ms === 'number'), parsed.steps.map((s: any) => s.ms));

  section('[3] 跨边界: 小工具的解析规则必须读懂这份轨迹');
  const miniSteps = minitoolParseTrace(text);
  check('小工具规则解析出同样步数', miniSteps.length === (run?.steps || []).length, { mini: miniSteps.length, run: (run?.steps || []).length });
  check('小工具规则读出正确工具名', JSON.stringify(miniSteps.map((s) => s.tool)) === JSON.stringify(tools), miniSteps.map((s) => s.tool));
  check('小工具规则读出正确成败', JSON.stringify(miniSteps.map((s) => s.ok)) === JSON.stringify((run?.steps || []).map((s: any) => s.ok)), miniSteps.map((s) => s.ok));
  check('小工具规则读到的是 ISO 时间戳 (无空格)', /^\d{4}-\d{2}-\d{2}T/.test(String(miniSteps[0]?.ts || '')), miniSteps[0]?.ts);
  check('小工具规则读到细节 (非空)', miniSteps.every((s) => s.detail.length > 0), miniSteps.map((s) => s.detail.slice(0, 40)));
  check('细节里带参数摘要 (看得见执行了什么)', /\[args:/.test(text), text.split('\n').slice(2, 4));

  section('[4] 轨迹 JSON (机器可读)');
  const json = T.runToTraceJson(run);
  check('schema 正确', json.schema === 'bolloon-agent-trace/1', json.schema);
  check('counts 自洽 (ok+fail=total)', json.counts.ok + json.counts.fail === json.counts.total && json.counts.total === (run?.steps || []).length, json.counts);
  check('tools 聚合与步骤一致', json.tools.reduce((a, t) => a + t.count, 0) === json.counts.total, json.tools);
  check('JSON 能再次序列化/解析 (可传输)', JSON.parse(JSON.stringify(json)).runId === runId);
  check('一行摘要可读', /步 \(✓\d+\/✗\d+/.test(T.summarizeTrace(run)), T.summarizeTrace(run));

  section('[5] P2P 连接信息 (抄给名片/小工具)');
  const info = await P.getLocalP2pInfo();
  check('拿到结构化 P2P 信息 (ok 字段明确)', typeof info.ok === 'boolean' && typeof info.source === 'string', { ok: info.ok, source: info.source });
  check('拿不到时给原因 (不编 peerId)', info.ok ? true : !!info.note, info.note);
  if (info.peerId) check('peerId 能过小工具的校验规则', miniPeerOk(info.peerId), info.peerId);
  else console.log('  ⚠ 本机没有 peerId (未入网) → 已按"如实说明"通过, 不做编造');
  if (info.multiaddrs.length) {
    const chk = miniAddrCheck(info.multiaddrs[0]);
    check('multiaddr 能过小工具的校验规则 (以 / 开头且含 /p2p/)', chk.ok, { addr: info.multiaddrs[0], why: chk.why });
    check('multiaddr 带 /p2p/<peerId> 段 (对端才拨得通)', String(info.multiaddrs[0]).includes(`/p2p/${info.peerId}`), info.multiaddrs[0]);
  } else {
    console.log('  ⚠ 当前没有被拨入地址 (节点没跑) → 已按"说明原因"通过');
  }
  const p2pJson = JSON.parse(P.formatP2pInfoJson(info));
  check('P2P JSON 有 cardP2p (与小工具名片字段对齐)', !!p2pJson.cardP2p && typeof p2pJson.cardP2p.peerId === 'string', p2pJson.cardP2p);

  section('[6] 真 HTTP: /api/trace 与 /api/p2p/info');
  const { createWebServer } = await import('../src/web/server.js') as any;
  const app = await createWebServer({ port: 0, headless: true } as any);
  const server = app?.server || app;
  const addr: any = await new Promise((res) => { if (server?.address?.()) res(server.address()); else server?.once?.('listening', () => res(server.address())); });
  const base = `http://127.0.0.1:${addr?.port || 0}`;
  try {
    const r1 = await fetch(`${base}/api/trace/${runId}?format=text`);
    const httpText = await r1.text();
    check('HTTP 取轨迹文本 (与本地一致)', r1.status === 200 && httpText.trim() === text.trim(), { status: r1.status, len: httpText.length });
    const r2 = await fetch(`${base}/api/trace`);
    const list = await r2.json() as any;
    check('HTTP 列表里有这次运行', Array.isArray(list.runs) && list.runs.some((x: any) => x.runId === runId), (list.runs || []).map((x: any) => x.runId));
    const r3 = await fetch(`${base}/api/p2p/info`);
    const pj = await r3.json() as any;
    check('HTTP 取 P2P 信息 (schema 正确)', r3.status === 200 && pj.schema === 'bolloon-p2p-info/1', pj.schema);
    check('HTTP P2P 与小工具名片字段对齐', !!pj.cardP2p && typeof pj.cardP2p.multiaddr === 'string', pj.cardP2p);
  } catch (err: any) {
    check('Web API 可达', false, String(err?.message || err).slice(0, 140));
  } finally { try { server?.close?.(); } catch { /* ignore */ } }

  section('[7] 真 P2P 节点 → 连接信息必须真可拨入');
  try {
    const netMod: any = await import('../src/network/p2p.js');
    const net = netMod.p2pNetwork;
    const node = await net.createNode({ enableRelay: false, enableRelayServer: false, enableAutoNat: false, enableUPnP: false });
    const live = await P.getLocalP2pInfo();
    check('source = live (读到运行中的节点, 不是落盘记录)', live.source === 'live', { source: live.source, peerId: live.peerId });
    check('peerId 与真节点一致 (不是编的)', live.peerId === node.peerId, { info: live.peerId, node: node.peerId });
    check('peerId 过小工具校验规则', miniPeerOk(live.peerId), live.peerId);
    check('至少一条可拨入地址', live.multiaddrs.length > 0, live.multiaddrs.length);
    check('每条地址都带 /p2p/<peerId> (对端才拨得通)', live.multiaddrs.every((m: string) => m.includes(`/p2p/${node.peerId}`)), live.multiaddrs.slice(0, 2));
    check('每条地址都过小工具校验规则', live.multiaddrs.every((m: string) => miniAddrCheck(m).ok), live.multiaddrs.slice(0, 2));
    const c = JSON.parse(P.formatP2pInfoJson(live)).cardP2p;
    check('cardP2p 可直接抄进名片 (peerId + 可用 multiaddr)', c.peerId === node.peerId && miniAddrCheck(c.multiaddr).ok, c);
    try { await net.stop?.(); } catch { /* 清理失败不影响结论 */ }
  } catch (err: any) {
    check('真 P2P 节点能起来并导出连接信息', false, String(err?.message || err).slice(0, 200));
  }

  console.log(`\n=== 结果: ${passed} passed, ${failed} failed ===`);
  console.log(`隔离 HOME: ${HOME}`);
  console.log(`本次 Run: ${runId} · 工具: ${tools.join(', ')}`);
  process.exit(failed === 0 ? 0 : 1);
}

await main();
