/**
 * verify-next-tools.ts — 下一代工具集端到端验证 (真跑, 不 mock)
 *
 * 覆盖:
 *   ① 注册齐全 (clarify / execute_code / patch / computer_use / browser / git_* / skill_export|import|share)
 *   ② clarify 真人应答往返 (onQuestion → answer → 工具拿到回答)
 *   ③ execute_code 真跑 python
 *   ④ patch 真改文件 (写入 temp, 精确替换)
 *   ⑤ git_status 真读仓库
 *   ⑥ computer_use 真截图 (screencapture → 文件存在)
 *   ⑦ browser 真开 headless Chrome 取文本
 *   ⑧ 技能包 IPFS 真往返 (上传 → 拉回 → 装到临时 HOME)
 *
 * 用法: npx tsx scripts/verify-next-tools.ts
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { registerBuiltinTools } from '../src/agents/pi-sdk-tools.js';
import { userQuestions } from '../src/agents/user-questions.js';
import { collectSkillBundle, uploadSkillBundle, fetchSkillBundle, installSkillBundle, skillShareLink } from '../src/agents/skill-share.js';

const results: Array<{ name: string; ok: boolean; note: string }> = [];
function record(name: string, ok: boolean, note = '') {
  results.push({ name, ok, note });
  console.log(`${ok ? '✅' : '❌'} ${name}${note ? ` — ${note}` : ''}`);
}

async function main() {
  const tools = new Map<string, any>();
  const ctx: any = {
    tools,
    cwd: process.cwd(),
    identity: { did: 'did:verify:next-tools', name: 'verify' },
    persona: null,
    minimaxAvailable: false,
    setPersona: async () => {},
    sessionManager: { addFileContext: () => {} },
    constraintLayer: { getLogs: () => [] },
    _inboxMessages: [],
  };
  registerBuiltinTools(ctx);
  await new Promise((r) => setTimeout(r, 500));   // 等 browser 异步注册

  // ① 注册
  const need = [
    'clarify', 'execute_code', 'patch', 'computer_use', 'browser',
    'git_status', 'git_add', 'git_restore',
    'skill_export', 'skill_import', 'skill_share',
  ];
  const missing = need.filter((n) => !tools.has(n));
  record('① 工具注册齐全', missing.length === 0, missing.length ? `缺: ${missing.join(', ')}` : `${need.length} 个全在 (总工具 ${tools.size})`);

  // ② clarify 真往返
  try {
    const unsub = userQuestions.onQuestion((q) => {
      setTimeout(() => { void userQuestions.answer(q.id, '2'); }, 120);
    });
    const r = await tools.get('clarify').execute({ question: '验证: 选哪个?', choices: '甲 | 乙 | 丙', timeout_s: '20' });
    unsub();
    const ok = r.success === true && String(r.output || '').includes('乙');
    record('② clarify 人机往返 (序号 → 选项)', ok, ok ? '工具拿到回答 "乙"' : `意外结果: ${JSON.stringify(r).slice(0, 200)}`);
  } catch (e: any) {
    record('② clarify 人机往返', false, String(e?.message || e).slice(0, 200));
  }

  // ②b 无人界面时应如实拒绝
  try {
    const r = await tools.get('clarify').execute({ question: '没人看得到', timeout_s: '1' });
    record('②b clarify 无人界面时拒绝 (不空等)', r.success === false && String(r.error).includes('无人值守'), r.error?.slice(0, 80));
  } catch (e: any) {
    record('②b clarify 无人界面时拒绝', false, String(e?.message || e).slice(0, 120));
  }

  // ③ execute_code 真跑
  try {
    const r = await tools.get('execute_code').execute({ code: 'print(6*7)', language: 'python', timeout_ms: '20000' });
    const ok = r.success === true && String(r.output || '').includes('42');
    record('③ execute_code 真跑 python', ok, ok ? 'stdout 含 42' : JSON.stringify(r).slice(0, 200));
  } catch (e: any) {
    record('③ execute_code 真跑 python', false, String(e?.message || e).slice(0, 200));
  }

  // ④ patch 真改文件 (写白名单内的 *.md, 与 agent 实际可用路径一致)
  try {
    const rel = `bolloon-verify-patch-${Date.now()}.md`;
    const abs = path.join(process.cwd(), rel);
    await fs.writeFile(abs, 'hello\nworld\n', 'utf-8');
    const r = await tools.get('patch').execute({ path: rel, old_string: 'world', new_string: 'bolloon' });
    const after = await fs.readFile(abs, 'utf-8');
    await fs.rm(abs, { force: true });
    const ok = r.success === true && after.includes('bolloon') && !after.includes('world');
    record('④ patch 真改文件', ok, ok ? 'world → bolloon 落盘确认' : JSON.stringify(r).slice(0, 200));
  } catch (e: any) {
    record('④ patch 真改文件', false, String(e?.message || e).slice(0, 200));
  }

  // ④b patch 不唯一时拒绝 (文件必须保持原样)
  try {
    const rel = `bolloon-verify-dup-${Date.now()}.md`;
    const abs = path.join(process.cwd(), rel);
    await fs.writeFile(abs, 'x\nx\n', 'utf-8');
    const r = await tools.get('patch').execute({ path: rel, old_string: 'x', new_string: 'y' });
    const after = await fs.readFile(abs, 'utf-8');
    await fs.rm(abs, { force: true });
    record('④b patch 不唯一拒绝 (文件未被改)', r.success === false && after === 'x\nx\n', r.error?.slice(0, 90));
  } catch (e: any) {
    record('④b patch 不唯一拒绝', false, String(e?.message || e).slice(0, 150));
  }

  // ⑤ git_status 真读
  try {
    const r = await tools.get('git_status').execute({});
    const ok = r.success === true && /\S/.test(String(r.output || ''));
    record('⑤ git_status 真读仓库', ok, String(r.output || '').split('\n')[0].slice(0, 80));
  } catch (e: any) {
    record('⑤ git_status 真读仓库', false, String(e?.message || e).slice(0, 200));
  }

  // ⑥ computer_use 真截图
  try {
    const r = await tools.get('computer_use').execute({ action: 'screenshot' });
    const st = r.path ? await fs.stat(r.path).catch(() => null) : null;
    const ok = r.success === true && !!st && st.size > 1000;
    record('⑥ computer_use 真截图', ok, ok ? `${path.basename(r.path!)} ${Math.round(st!.size / 1024)}KB` : JSON.stringify(r).slice(0, 200));
  } catch (e: any) {
    record('⑥ computer_use 真截图', false, String(e?.message || e).slice(0, 200));
  }

  // ⑦ browser 真开 Chrome
  try {
    const html = path.join(os.tmpdir(), `bolloon-verify-${Date.now()}.html`);
    await fs.writeFile(html, '<html><head><title>VerifyPage</title></head><body><h1>BOLLOON_BROWSER_OK</h1><a href="https://example.com">link</a></body></html>', 'utf-8');
    const open = await tools.get('browser').execute({ action: 'open', url: `file://${html}` });
    const text = await tools.get('browser').execute({ action: 'text' });
    const links = await tools.get('browser').execute({ action: 'links' });
    await tools.get('browser').execute({ action: 'close' });
    await fs.rm(html, { force: true });
    const ok = open.success === true && String(text.output || '').includes('BOLLOON_BROWSER_OK') && String(links.output || '').includes('example.com');
    record('⑦ browser 真开 headless Chrome', ok, ok ? '取到标题文本 + 链接' : `open=${String(open.output || open.error).slice(0, 60)} text=${String(text.output || text.error).slice(0, 80)}`);
  } catch (e: any) {
    record('⑦ browser 真开 headless Chrome', false, String(e?.message || e).slice(0, 200));
  }

  // ⑧ 技能包 IPFS 真往返
  try {
    const src = await fs.mkdtemp(path.join(os.tmpdir(), 'bolloon-verify-skill-'));
    const skillDir = path.join(src, 'verify-share-skill');
    await fs.mkdir(path.join(skillDir, 'references'), { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: verify-share-skill\ndescription: 验证技能\nversion: 1.0.0\n---\n\n# 验证\n正文\n', 'utf-8');
    await fs.writeFile(path.join(skillDir, 'references', 'r.md'), '参考', 'utf-8');
    const b = await collectSkillBundle(skillDir, { name: 'verify-share-skill' });
    if (!b.ok || !b.bundle) throw new Error(b.error);
    const up = await uploadSkillBundle(b.bundle);
    if (!up.ok || !up.cid) throw new Error(up.error);
    const back = await fetchSkillBundle(up.cid);
    if (!back.ok || !back.bundle) throw new Error(back.error);
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'bolloon-verify-home-'));
    const inst = await installSkillBundle(back.bundle, { home });
    if (!inst.ok) throw new Error(inst.error);
    const written = await fs.readFile(path.join(home, '.bolloon', 'skills', 'verify-share-skill', 'SKILL.md'), 'utf-8');
    const ok = written.includes('验证技能');
    record('⑧ 技能包 IPFS 真往返 (上传→拉回→安装)', ok, ok ? `CID ${up.cid.slice(0, 14)}… 链接 ${skillShareLink(up.cid).slice(0, 30)}…` : '内容不符');
    await fs.rm(src, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  } catch (e: any) {
    record('⑧ 技能包 IPFS 真往返', false, `(需要本地 Kubo) ${String(e?.message || e).slice(0, 160)}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n──────────────────────────────');
  console.log(`结果: ${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log(`失败: ${failed.map((f) => f.name).join(' | ')}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => { console.error('verify 异常:', e); process.exit(1); });
