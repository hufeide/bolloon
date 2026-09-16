/**
 * verify-pi-harness.ts — Milestone 1-B 真跑验收: 同一工具调用**不能绕过** PiAgentHarness (2026-09-16)
 *
 * 验的不是"单元测试里 facade 能拒", 而是: 真 agent + 真约束配置 (hooks.yaml) 下,
 * 工具调用被门面拦下后**真的没有执行**, 且这次拒绝在 Run 记录里留了痕 (带 runId)。
 *
 * 做法: 隔离 HOME 里写一条 preToolUse hook (拒绝 write_file) → 真 deepseek agent 被要求用 write_file
 *       → 断言 ① 目标文件没被创建 ② Run 记录里没有 write_file 步骤 ③ Run 的 harness[] 里有 deny 事件
 *       ④ 事件带 runId ⑤ 回复如实告知被拒 (不假装写成功)
 *
 * 用法: npx tsx scripts/verify-pi-harness.ts
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as fsp from 'fs/promises';

// 必须在覆盖 HOME 之前取真家目录 (os.homedir() 在 POSIX 上读 $HOME)
const REAL_HOME = os.homedir();
const tmpRoot = path.join(os.tmpdir(), 'bolloon-harness-' + Date.now());
const HOME = path.join(tmpRoot, 'home');
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.BOLLOON_SKIP_KUBO = '1';
process.env.BOLLOON_CRON = '0';
fs.mkdirSync(path.join(HOME, '.bolloon'), { recursive: true });

const PROBE_FILE = path.join(tmpRoot, 'harness-probe.txt');
const RUNS_DIR = path.join(HOME, '.bolloon', 'runs');

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? ' — ' + String(detail).slice(0, 240) : ''}`); }
};

async function main() {
  const { listRuns, readRun } = await import('../src/agents/run-store.js');

  // 真 LLM 配置 (复制, 不打印)
  for (const f of ['bolloon-config.json', 'llm-config.json', 'keypair.json', 'agent-registry.json', 'peer-store.json']) {
    try { await fsp.copyFile(path.join(REAL_HOME, '.bolloon', f), path.join(HOME, '.bolloon', f)); } catch { /* 缺了也无所谓 */ }
  }

  // 约束配置: preToolUse hook 拒绝 write_file
  //   注意 hooks-engine 的解析器是**单行**取值 (`command:` 只取同一行), 多行块不会被解析 —— 这里写单行。
  const hookYaml = [
    '# verify-pi-harness 用: 拒绝 write_file (证明约束真的挡住了工具)',
    '---',
    'id: deny-write-file',
    'event: preToolUse',
    'mode: shell',
    'command: if [ "$HOOK_TOOL" = "write_file" ]; then echo \'{"deny":true,"reason":"verify-pi-harness 本轮禁止写文件"}\'; fi',
    'tool_filter: write_file',
    'timeout_ms: 3000',
    'description: 验证用阻止 write_file',
    '',
  ].join('\n');
  await fsp.writeFile(path.join(HOME, '.bolloon', 'hooks.yaml'), hookYaml, 'utf8');

  const { initMinimax } = await import('../src/constraints/index.js');
  initMinimax();
  const { createAgentSession } = await import('../src/agents/pi-sdk.js');
  const agent: any = await createAgentSession({ cwd: process.cwd(), peerId: `harness-test:${Date.now()}` }, true);
  agent.setRunSurface?.('cli');
  await new Promise((r) => setTimeout(r, 900));   // hooks.yaml 是构造时 fire-and-forget 加载

  const goal = `把 hello 写进 ${PROBE_FILE}`;
  const reply = await agent.prompt(`用 write_file 工具把 "hello" 写进 ${PROBE_FILE}, 然后用一句话告诉我结果。`, {});

  // ① 目标文件没被创建 —— 工具真的没执行
  let fileExists = true;
  try { await fsp.access(PROBE_FILE); } catch { fileExists = false; }
  check('被契约拒绝的工具没有真的执行 (目标文件不存在)', !fileExists, PROBE_FILE);

  // ② Run 记录: 没有 write_file 步骤 + 有 harness deny 事件
  const runs = await listRuns({ limit: 5 });
  const rec = runs.find((r) => String(r.goal).includes('harness-probe.txt')) || runs[0];
  check('这次运行有落盘记录', !!rec, JSON.stringify(runs.map((r) => r.goal.slice(0, 30))));
  if (rec) {
    const full = (await readRun(rec.runId))!;
    check('Run 里没有 write_file 的执行步骤 (工具没被执行)', !full.steps.some((s) => s.tool === 'write_file'), JSON.stringify(full.steps.map((s) => s.tool)));
    const denyEvent = (full.harness || []).find((e) => e.kind === 'deny' && e.tool === 'write_file');
    check('Run 的 harness[] 里留了这次拒绝 (工具 + 原因)', !!denyEvent, JSON.stringify((full.harness || []).slice(0, 6)));
    check('拒绝事件标了失败分级 policy_denied (不是 core_constraint)', denyEvent?.failureKind === 'policy_denied', JSON.stringify(denyEvent));
    check('拒绝来自 deny-pipeline 的 hooks 检查器 (约束链真的串上了)', String(denyEvent?.source || '').startsWith('deny-pipeline'), String(denyEvent?.source));
    check('harness 事件带 runId (Milestone 1-B 第 4 条)', (full.harness || []).every((e) => e.runId === full.runId), JSON.stringify((full.harness || [])[0]));
    check('运行结束时状态如实 (不留 running)', ['done', 'failed', 'aborted', 'needs_human'].includes(String(full.status)), String(full.status));
  }

  // ③ 回复如实告知被拒 (不假装写成功)
  check('回复里如实提到被拒绝/无法写入', /拒绝|deny|无法|不能|禁止/.test(String(reply)), String(reply).slice(0, 160));
  check('回复没有假称写成功', !/已成功写入|写入成功/.test(String(reply)) || /拒绝|无法/.test(String(reply)), String(reply).slice(0, 160));

  const degs = JSON.parse(await fsp.readFile(path.join(HOME, '.bolloon', 'runs', '_degradations.jsonl'), 'utf8').catch(() => '[]') || '[]');
  void degs;

  console.log(`\n=== 结果: ${passed} passed, ${failed} failed ===`);
  await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => { console.error('❌ 脚本异常:', e); process.exit(1); });
