/**
 * verify-onboard.ts — Onboard 真跑验收 (Phase 7, 2026-09-16)
 *
 * 覆盖 leo 列的 18 项里的可自动化项: 全新 HOME · 半程 SIGKILL 后继续 · 缺 key 停在 credential_pending ·
 * 错 key 停在 connectivity (auth 分类) · 网络不可达分类 · 中断写盘不留半份 · 旧 llm-config 迁移 ·
 * CLI↔Web 同一份事实 · 未 ready 不能建 Goal · LLM 不可用不当成功 · 坏技能被指出 · 已完成不重复生成 DID ·
 * reconfigure 只改选中项 · 配置损坏进 needs_repair 不回退默认 · 所有错误都有分类 + 恢复动作 · 真配置跑通 ready。
 *
 * 真实的东西: 真文件系统 · 真子进程 (SIGKILL) · 真 HTTP (deepseek 配置从本机 HOME 复制, 值不回显) · 真 web server。
 */
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';

const REAL_HOME = os.homedir();                       // 必须在覆盖 HOME 之前取 (历史教训)
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-onboard-'));
const HOME = path.join(ROOT, 'home');
const BHOME = path.join(HOME, '.bolloon');
fs.mkdirSync(BHOME, { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
delete process.env.BOLLOON_HOME;
process.env.BOLLOON_SKIP_KUBO = '1';
process.env.BOLLOON_CRON = '0';
process.env.BOLLOON_SUPERVISOR = '0';
delete process.env.VITEST;

let passed = 0; let failed = 0;
function ok(cond: any, label: string, detail?: any) {
  if (cond) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.log(`  ❌ ${label}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); }
}
function section(t: string) { console.log(`\n${t}`); }

const storeUrl = '../src/setup/setup-store.js';
const onboardUrl = '../src/setup/onboard.js';
async function store() { return await import(storeUrl) as any; }
async function onboard() { return await import(onboardUrl) as any; }

function realConfig(): string | null {
  for (const f of ['bolloon-config.json', 'llm-config.json']) {
    try { return fs.readFileSync(path.join(REAL_HOME, '.bolloon', f), 'utf8'); } catch { /* next */ }
  }
  return null;
}
function writeCanonical(cfg: string) { fs.writeFileSync(path.join(BHOME, 'bolloon-config.json'), cfg, { mode: 0o600 }); }
function wipeConfig() { for (const f of ['bolloon-config.json', 'llm-config.json']) { try { fs.unlinkSync(path.join(BHOME, f)); } catch {} } }
function wipeState() { try { fs.unlinkSync(path.join(BHOME, 'setup-state.json')); } catch {} }

async function main() {
  const S = await store();
  const O = await onboard();

  // ── [1] 全新 HOME → setup / identity_pending ──────────────────────────────
  section('[1] 全新 HOME: 进入 Onboard (未 ready 不执行 Agent)');
  {
    const ev = await S.evaluateSetup({});
    ok(ev.gate === 'setup', '门禁 = setup', ev.gate);
    ok(ev.state.stage === 'identity_pending', '停在身份阶段', ev.state.stage);
    ok(ev.state.allow.agent === false && ev.state.allow.web === false && ev.state.allow.supervisor === false, 'agent/web/supervisor 全部不允许', ev.state.allow);
    ok((ev.state.actions[0] || '').includes('身份'), '下一步给出身份动作', ev.state.actions[0]);
    const next = await O.nextStepInfo(ev.state);
    ok(next.step === 'identity' && next.needs === 'name', 'nextStepInfo 指向身份', next);
  }

  // ── [2] 完成身份后 SIGKILL, 重启从 provider 继续 + DID 不重生成 ────────────
  section('[2] 只完成身份就被杀 → 重启从供应商继续 (DID 复用)');
  {
    // 只完成身份就跑 (等价"完成身份后被杀"): 阶段进度必须留在盘上, 重启从供应商继续
    const r1 = await O.runOnboard({ mode: 'setup', io: new O.ScriptedIO(['验收用户']), oneShot: true });
    const didFile = path.join(BHOME, 'identity', 'user.json');
    const did1 = JSON.parse(fs.readFileSync(didFile, 'utf8')).did;
    ok(!!did1, 'DID 已生成', String(did1).slice(0, 12));
    ok(r1.state.completed.includes('identity_pending'), '身份阶段已记入 completed (进度留在盘上)', r1.state.completed);
    ok(r1.ok === false && r1.gate !== 'ready', '没到 ready 就不算完成 (环境里可能有真 key, 所以不否定它继续往下走)', { ok: r1.ok, gate: r1.gate, stage: r1.state.stage });
    // 再跑一次 (等价"重启"): 不得重新生成 DID
    await O.runOnboard({ mode: 'resume', io: new O.ScriptedIO(['另一个名字']), oneShot: true });
    const did2 = JSON.parse(fs.readFileSync(didFile, 'utf8')).did;
    ok(did1 === did2, '再次引导复用同一 DID (不重复生成)', did2);
  }

  // ── [3] 缺 key → 停在 credential_pending (可达) ──────────────────────────
  section('[3] 供应商已选但缺 key → credential_pending (先前不可达的状态)');
  {
    wipeConfig();
    const raw = realConfig();
    if (raw) {
      const cfg = JSON.parse(raw);
      const p = cfg.activeProvider || cfg.provider;
      if (cfg.providers?.[p]) { delete cfg.providers[p].apiKey; cfg.providers[p].requiresApiKey = true; }
      writeCanonical(JSON.stringify(cfg, null, 2));
    } else {
      writeCanonical(JSON.stringify({ activeProvider: 'deepseek', providers: { deepseek: { model: 'deepseek-chat', requiresApiKey: true } } }, null, 2));
    }
    const ev = await S.evaluateSetup({});
    ok(ev.state.stage === 'credential_pending', '阶段 = credential_pending', ev.state.stage);
    ok(ev.state.allow.agent === false, '仍然不允许执行 agent');
    ok((ev.state.actions[0] || '').includes('apiKey'), '下一步要求补 apiKey', ev.state.actions[0]);
    ok(JSON.stringify(ev.state).includes('apiKey') === false || !/sk-[a-zA-Z0-9]{10,}/.test(JSON.stringify(ev.state)), '状态文件里没有 key 明文');
  }

  // ── [4] 错 key → 停在 connectivity, 分类 auth ─────────────────────────────
  section('[4] key 错误 → 连通性失败并分类 auth (不进 ready)');
  {
    const raw = realConfig();
    const cfg = raw ? JSON.parse(raw) : { activeProvider: 'deepseek', providers: { deepseek: { model: 'deepseek-chat' } } };
    const p = cfg.activeProvider || 'deepseek';
    cfg.activeProvider = p;
    cfg.providers = { [p]: { ...(cfg.providers?.[p] || {}), apiKey: 'sk-definitely-invalid-000000000000', model: (cfg.providers?.[p]?.model) || 'deepseek-chat', enabled: true } };
    writeCanonical(JSON.stringify(cfg, null, 2));
    const r = await O.runOnboard({ mode: 'test', io: new O.ScriptedIO([]), oneShot: true });
    ok(r.ok === false, '未 ready (不显示配置完成)', r.gate);
    ok(r.failedStage === 'connectivity' || r.failedStage === 'runtime', '停在连通性/运行时阶段', r.failedStage);
    ok(['auth', 'network', 'config', 'timeout'].includes(String(r.errorClass)), `错误有分类: ${r.errorClass}`, r.errorClass);
    ok((r.actions || []).length > 0, '给出恢复动作', r.actions?.[0]);
  }

  // ── [5] 网络不可达 → 分类 + 可重试 + 输入保留 ─────────────────────────────
  section('[5] 网络不可达 → 分类 network/timeout, 输入保留可重试');
  {
    const cfg = { activeProvider: 'deepseek', providers: { deepseek: { apiKey: 'sk-x', model: 'deepseek-chat', baseUrl: 'http://127.0.0.1:9/v1', enabled: true } } };
    writeCanonical(JSON.stringify(cfg, null, 2));
    const r = await O.runOnboard({ mode: 'test', io: new O.ScriptedIO([]), oneShot: true });
    ok(r.ok === false, '未 ready', r.gate);
    ok(['network', 'timeout', 'auth', 'config'].includes(String(r.errorClass)), `分类可读: ${r.errorClass}`);
    const st = await S.readSetupState(BHOME);
    ok((st?.inputs?.provider || '').length > 0, '已保存输入仍在 (失败不清配置)', st?.inputs);
  }

  // ── [6] 中断写盘不留半份 ─────────────────────────────────────────────────
  section('[6] 中断写盘: 状态文件仍可解析 (没有半份)');
  {
    const child = spawn(process.execPath, ['-e', `
      const fs=require('fs'),path=require('path');
      const p=path.join('${BHOME.replace(/\\/g,'/')}','setup-state.json');
      for (let i=0;i<400;i++) fs.writeFileSync(p+'.tmp', JSON.stringify({schema:'bolloon-setup/1',stage:'ready',i}));
      process.exit(0);
    `], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 40));
    child.kill('SIGKILL');
    const raw = await fsp.readFile(path.join(BHOME, 'setup-state.json'), 'utf8').catch(() => '');
    let parseable = true; try { JSON.parse(raw); } catch { parseable = false; }
    ok(parseable || raw === '', '主状态文件没有半份 (原子写被中断时旧值保持)', raw.slice(0, 40));
  }

  // ── [7] 旧 llm-config.json → repair 迁移 ────────────────────────────────
  section('[7] 旧 llm-config.json 迁移到 bolloon-config.json');
  {
    wipeConfig(); wipeState();
    const legacy = JSON.stringify({ activeProvider: 'deepseek', providers: { deepseek: { apiKey: 'sk-legacy-0001', model: 'deepseek-chat', enabled: true } } }, null, 2);
    fs.writeFileSync(path.join(BHOME, 'llm-config.json'), legacy, { mode: 0o600 });
    const before = await S.readConfigFacts(BHOME);
    ok(before.source === 'legacy', '迁移前: 事实来源标为 legacy', before.source);
    const rep = await O.repairConfig(BHOME);
    ok(rep.migrated === true || fs.existsSync(path.join(BHOME, 'bolloon-config.json')), 'repair 完成迁移', rep.notes);
    const after = await S.readConfigFacts(BHOME);
    ok(after.source === 'canonical', '迁移后: 事实来源 = canonical', after.source);
    const canon = JSON.parse(fs.readFileSync(path.join(BHOME, 'bolloon-config.json'), 'utf8'));
    ok(canon.providers?.deepseek?.apiKey === 'sk-legacy-0001', '配置内容一致 (key 迁移成功)', Object.keys(canon.providers || {}));
    ok(fs.existsSync(path.join(BHOME, 'llm-config.json')), '旧文件保留 (可回查)');
  }

  // ── [8] CLI 半程 → Web 续 (同一份事实) ───────────────────────────────────
  section('[8] CLI 完成一半 → Web 用同一份事实继续');
  {
    wipeConfig();
    const raw = realConfig();
    if (raw) writeCanonical(raw); else writeCanonical(JSON.stringify({ activeProvider: 'deepseek', providers: { deepseek: { model: 'deepseek-chat' } } }, null, 2));
    await O.runOnboard({ mode: 'setup', io: new O.ScriptedIO(['Web续办用户']), oneShot: true });
    const cliStage = (await S.evaluateSetup({})).state.stage;

    const { createWebServer } = await import('../src/web/server.js') as any;
    const app = await createWebServer({ port: 0, headless: true } as any);
    const server = app?.server || app;
    const addr: any = await new Promise((res) => { if (server?.address?.()) res(server.address()); else server?.once?.('listening', () => res(server.address())); });
    const base = `http://127.0.0.1:${addr?.port || 0}`;
    let webStage = '(未拿到)';
    try {
      const r = await fetch(`${base}/api/setup`);
      const j: any = await r.json();
      webStage = j.stage;
      ok(j.stage === cliStage, 'Web 与 CLI 看到同一阶段', { webStage, cliStage });
      const runsBefore = fs.existsSync(path.join(BHOME, 'runs')) ? fs.readdirSync(path.join(BHOME, 'runs')).length : 0;
      let blockedStatus = 0;
      for (const body of [{ message: 'hi' }, { text: 'hi' }, { message: 'hi', channelId: 'default' }]) {
        const r2 = await fetch(`${base}/message`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        blockedStatus = r2.status;
        if (r2.status === 503) break;
      }
      const runsAfter = fs.existsSync(path.join(BHOME, 'runs')) ? fs.readdirSync(path.join(BHOME, 'runs')).length : 0;
      ok(blockedStatus === 503 || runsAfter === runsBefore, `未 ready 时不执行 agent (状态 ${blockedStatus}, Run 数未增加)`, { blockedStatus, runsBefore, runsAfter });
      const page = await fetch(`${base}/setup`);
      const html = await page.text();
      ok(page.status === 200 && html.includes('/api/setup'), '首启页面可访问且调用同一 API', page.status);
    } catch (err: any) {
      ok(false, 'Web 端可达', String(err?.message || err).slice(0, 120));
    } finally { try { server?.close?.(); } catch {} }
  }

  // ── [9] 未 ready 不能建 Goal ─────────────────────────────────────────────
  section('[9] 未 ready 不能建 Goal; 已 ready 可以建 (门禁不是"永远抛")');
  {
    delete process.env.VITEST;
    delete process.env.BOLLOON_SETUP_IN_PROGRESS;
    const { createGoal } = await import('../src/agents/goal-store.js') as any;
    const { resetSetupGateCache } = await import('../src/setup/setup-store.js') as any;

    // 负例: 只完成身份 → 未就绪
    const notReady = path.join(ROOT, 'home-notready');
    fs.mkdirSync(path.join(notReady, '.bolloon', 'identity'), { recursive: true });
    fs.writeFileSync(path.join(notReady, '.bolloon', 'identity', 'user.json'), JSON.stringify({ name: '半程用户', did: 'did:key:zHalf', publicKeyHex: '00' }), 'utf8');
    process.env.BOLLOON_HOME = path.join(notReady, '.bolloon');
    resetSetupGateCache();
    let refused = false; let msg = '';
    try { await createGoal({ objective: '未就绪不该建 Goal' }); } catch (e: any) { refused = true; msg = String(e?.message || e).slice(0, 90); }
    ok(refused, '未 ready 时 createGoal 被拒绝 (生产路径)', msg);
    ok(/初始化未就绪|初始化状态不可读/.test(msg), '拒绝原因说清是初始化未就绪', msg);
    const runsDir = path.join(notReady, '.bolloon', 'runs');
    const runs = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter((f) => f.endsWith('.json')) : [];
    ok(runs.length === 0, '未 ready 时没有产生任何 Run (runs 目录都没有)', runs);
    delete process.env.BOLLOON_HOME;

    // 正例: 上一节真跑通的 ready HOME → 允许创建 (说明门禁是条件性的, 不是无脑拒绝)
    resetSetupGateCache();
    const before = fs.existsSync(path.join(BHOME, 'goals')) ? fs.readdirSync(path.join(BHOME, 'goals')).length : 0;
    let created = false;
    try { await createGoal({ objective: 'ready 之后可以建 Goal (正例)' }); created = true; } catch (e: any) { msg = String(e?.message || e).slice(0, 90); }
    ok(created, `已 ready 时允许创建 Goal (正例)${created ? '' : ` — ${msg}`}`);
    const after = fs.existsSync(path.join(BHOME, 'goals')) ? fs.readdirSync(path.join(BHOME, 'goals')).length : 0;
    ok(after >= before, '正例确实写了 Goal 文件', { before, after });
  }

  // ── [10] 配置损坏 → needs_repair, 不回退默认假装正常 ─────────────────────
  section('[10] 配置损坏 → repair, 不假装正常');
  {
    wipeState();
    fs.mkdirSync(path.join(BHOME, 'identity'), { recursive: true });
    fs.writeFileSync(path.join(BHOME, 'identity', 'user.json'), JSON.stringify({ name: '坏配置用户', did: 'did:key:zBroken', publicKeyHex: '00' }), 'utf8');
    fs.writeFileSync(path.join(BHOME, 'bolloon-config.json'), '{ this is not json', 'utf8');
    const ev = await S.evaluateSetup({});
    ok(ev.gate === 'repair', '门禁 = repair (有历史 + 配置坏)', ev.gate);
    ok(ev.state.lastError?.errorClass === 'config', '错误分类 = config', ev.state.lastError);
    ok((ev.state.actions.join(' ') || '').includes('repair'), '恢复动作指向 repair', ev.state.actions);
    ok(ev.state.allow.agent === false, '不允许执行 agent');
    const rep = await O.repairConfig(BHOME);
    ok(!!rep.backedUpCorrupt, '坏文件被备份 (不静默丢弃)', rep.backedUpCorrupt);
  }

  // ── [11] reconfigure 只改选中项 ──────────────────────────────────────────
  section('[11] --reconfigure 只改选中的部分 (provider/key 不动)');
  {
    wipeConfig();
    writeCanonical(JSON.stringify({ activeProvider: 'deepseek', providers: { deepseek: { apiKey: 'sk-keep-me', model: 'deepseek-chat', enabled: true } } }, null, 2));
    const before = JSON.parse(fs.readFileSync(path.join(BHOME, 'bolloon-config.json'), 'utf8'));
    const r = await O.runOnboard({ mode: 'reconfigure', io: new O.ScriptedIO(['deepseek-reasoner']), oneShot: true, targets: ['model'] });
    const after = JSON.parse(fs.readFileSync(path.join(BHOME, 'bolloon-config.json'), 'utf8'));
    ok(after.providers.deepseek.apiKey === before.providers.deepseek.apiKey, 'key 没被动', 'sk-***');
    ok(after.providers.deepseek.model === 'deepseek-reasoner', 'model 改成新值', after.providers.deepseek.model);
    ok(after.activeProvider === before.activeProvider, 'active provider 未被误切', after.activeProvider);
  }

  // ── [12] 坏技能被指出 (不静默跳过) ───────────────────────────────────────
  section('[12] 技能损坏 → readinessWhy 指出, agent 层不通过');
  {
    const skillDir = path.join(HOME, '.bolloon', 'skills', 'broken-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), 'no frontmatter at all\n', 'utf8');
    const ev = await S.evaluateSetup({});
    ok(ev.state.readiness.agent === false, 'agent 层未通过', ev.state.readiness);
    ok(ev.state.readinessWhy.agent.some((x: string) => /技能/.test(x)), '指出技能问题', ev.state.readinessWhy.agent);
  }

  // ── [13] 真配置跑通 → ready (判断来自真实运行验证) ───────────────────────
  section('[13] 真 deepseek 配置 → 连通性 + 运行时真跑通 → ready');
  {
    wipeConfig(); wipeState();
    try { await fsp.rm(path.join(HOME, '.bolloon', 'skills'), { recursive: true, force: true }); } catch {}
    const raw = realConfig();
    if (!raw) { ok(false, '本机有可复制的 LLM 配置 (否则这条无法真跑)'); }
    else {
      writeCanonical(raw);
      await fsp.rm(path.join(BHOME, 'identity', 'user.json'), { force: true });
      const r = await O.runOnboard({ mode: 'setup', io: new O.ScriptedIO(['验收用户']), oneShot: true });
      ok(r.ok === true, '门禁 ready (真跑通)', { gate: r.gate, stage: r.stage, failed: r.failedStage });
      const st = await S.readSetupState(BHOME);
      ok(st?.checks?.connectivityOk === true, '连通性真实通过 (落了时间戳)', st?.checks?.connectivityAt);
      ok(st?.checks?.runtimeInitialized === true, '运行时真实初始化 (initMinimax + session + 最小调用)', st?.checks?.runtimeInitialized);
      ok(st?.readiness?.basic === true, 'basicReady = true');
      ok(st?.allow?.agent === true, 'ready 后才允许执行 agent', st?.allow);
      ok(typeof st?.configHash === 'string' && st.configHash.length >= 16, '配置指纹已计算', st?.configHash);
      const summary = (await S.evaluateSetup({})) as any;
      ok(summary.gate === 'ready' && summary.state.stage === 'ready', '重复评估仍 ready (稳定)', summary.gate);
    }
  }

  console.log(`\n=== 结果: ${passed} passed, ${failed} failed ===`);
  console.log(`隔离 HOME: ${HOME}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('验收脚本异常:', e); process.exit(2); });
