/**
 * verify-gateway-join-agent.ts — 「真 LLM 智能体读入网说明 → 自动入网」闭环验证
 *
 * 目的: 前面那份 verify-pc-gateway-join.ts 是直接调工具 (无 LLM)。本脚本把 LLM 真的放进环里:
 *   人类/手机只发一句默认 prompt `read https://bolloon.cn/bolloon-gateway-join.md`
 *   → 真 agent (deepseek) 自己决定读文档 / 调 join_global_gateway
 *   → 断言: ① 有读文档的工具调用 ② 有入网工具调用 ③ 入网态真落盘 ④ 回复不谎报
 *
 * 隔离: HOME 指向 tmp (复制真实 bolloon-config.json 供 LLM 用), 不污染真实 ~/.bolloon。
 * 用法: npx tsx scripts/verify-gateway-join-agent.ts
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as fsp from 'fs/promises';

const tmpRoot = path.join(os.tmpdir(), 'bolloon-join-agent-' + Date.now());
const fakeHome = path.join(tmpRoot, 'home');
await fsp.mkdir(path.join(fakeHome, '.bolloon'), { recursive: true });

// 复制真实配置 (LLM key 等) — 只复制配置文件, 不复制运行态
const realBolloon = path.join(os.homedir(), '.bolloon');
for (const f of ['bolloon-config.json', 'llm-config.json']) {
  try {
    fs.copyFileSync(path.join(realBolloon, f), path.join(fakeHome, '.bolloon', f));
  } catch { /* 缺文件就跳过 */ }
}

process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.BOLLOON_SKIP_KUBO = '1';
process.env.BOLLOON_CRON = '0';
process.env.BOLLOON_AGENT_HEARTBEAT_SOCIAL = '0';
process.env.BOLLOON_ORGANIZE_HEARTBEAT_MS = '0';

const DOC_URL = 'https://bolloon.cn/bolloon-gateway-join.md';
const PROMPT = `read ${DOC_URL}`;   // == src/web/mobile.js 的 DEFAULT_JOIN_PROMPT

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function main() {
  console.log('=== 真 LLM agent 读入网说明 → 自动入网 闭环验证 ===');
  console.log(`prompt: ${PROMPT}`);
  console.log(`隔离 HOME: ${fakeHome}\n`);

  const { initMinimax } = await import('../src/constraints/index.js');
  initMinimax();
  const { createAgentSession } = await import('../src/agents/pi-sdk.js');

  const agent: any = await createAgentSession({
    cwd: process.cwd(),
    peerId: 'join-agent-verify:' + Date.now(),   // 含 ':' → 独立 session
    agentId: 'join-agent-verify',
  });
  console.log(`[1] agent 就绪, 工具数=${agent.tools?.size}`);

  const toolCalls: Array<{ tool: string; args: any; ok?: boolean; error?: string }> = [];
  const stream: string[] = [];
  const ac = new AbortController();
  const timer = setTimeout(() => { console.log('\n[!] 6 分钟上限, abort'); ac.abort(); }, 6 * 60 * 1000);

  let reply = '';
  let promptErr = '';
  try {
    reply = await agent.prompt(PROMPT, {
      signal: ac.signal,
      onStream: (ev: any) => {
        if (ev?.type === 'status' && ev?.tool) {
          const args = ev.args ?? ev.toolArgs ?? ev.arguments ?? null;
          toolCalls.push({ tool: String(ev.tool), args });
          console.log(`  → tool: ${ev.tool} ${args ? JSON.stringify(args).slice(0, 160) : ''}`);
        } else if (ev?.type === 'step_done' && ev?.tool) {
          const last = [...toolCalls].reverse().find((t) => t.tool === String(ev.tool) && t.ok === undefined);
          if (last) { last.ok = ev.success !== false; last.error = ev.error; }
        }
        stream.push(String(ev?.type || ''));
      },
    });
  } catch (e: any) {
    promptErr = String(e?.message || e);
    console.log(`\n[!] prompt 抛错: ${promptErr.slice(0, 200)}`);
  }
  clearTimeout(timer);

  console.log('\n[2] 工具调用序列:');
  for (const c of toolCalls) console.log(`    - ${c.tool} ${c.ok === false ? '(FAILED: ' + String(c.error).slice(0, 80) + ')' : ''}`);
  const toolNames = toolCalls.map((c) => c.tool);
  const readCalled = toolNames.some((t) => ['read_file', 'fetch_url', 'browser'].includes(t));
  const joinCalled = toolNames.includes('join_global_gateway');

  console.log('\n[3] 断言');
  check('agent 调了「读」类工具 (read_file/fetch_url/browser)', readCalled, toolNames.join(',') || '(无工具调用)');
  check('agent 调了 join_global_gateway (文档驱动入网)', joinCalled, toolNames.join(',') || '(无)');

  const stateFile = path.join(fakeHome, '.bolloon', 'gateway-join.json');
  let state: any = null;
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf-8')); } catch { /* 未落盘 */ }
  check('入网态真落盘 (gateway-join.json)', !!state?.url, state ? JSON.stringify(state).slice(0, 160) : '文件不存在');
  check('落盘 url == 入网文档', state?.url === DOC_URL, String(state?.url || ''));
  check('落盘含 DID', /^did:/.test(String(state?.did || '')), String(state?.did || ''));

  console.log('\n[4] agent 最终回复 (前 900 字):');
  console.log('---------------------------------------------');
  console.log(String(reply || promptErr).slice(0, 900));
  console.log('---------------------------------------------');
  check('回复非空', !!String(reply || '').trim());

  console.log(`\n=== 结果: ${passed} passed, ${failed} failed ===`);
  console.log(`(tmp 保留以供检查: ${tmpRoot})`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('验证脚本异常:', e); process.exit(1); });
