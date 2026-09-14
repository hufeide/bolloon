/**
 * skill-share.ts — 技能沉淀 / 分享 / 安装 (IPFS + P2P)
 *
 * 目标: 智能体的 skills 不止在本地沉淀, 还能**打包 → 走已有 IPFS 互传 → 对端安装**,
 * 也能把链接通过已有 P2P 通道发给好友。
 *
 * 技能包格式 (单个 JSON, 便于用现有 ipfs_add/ipfs_cat 原语搬运):
 *   { schema:'bolloon-skill-bundle/1', name, description, version, triggers, exportedAt,
 *     author, files: { 'SKILL.md': '...', 'references/x.md': '...' } }
 *
 * 分享引用 (link) 支持三种写法, 都归一化成 CID:
 *   bolloon://skill/<cid>   |   ipfs://<cid>   |   <cid>
 *
 * 版本与更新流程 (避免"装回旧版"):
 *   - 导出时 version 取 SKILL.md frontmatter 的 version, 缺省 '1.0.0'
 *   - 安装时: 本地无 → 写入; 本地有且新版更新 → 覆盖 (旧目录备份为 <name>.bak-<ts>);
 *     本地版本 >= 来的版本且未 force → 拒绝, 告知原因 (不静默降级)
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { kuboApi, ensureKuboReady } from './pi-sdk-tools.js';
import { sanitizeSkillName, getUserSkillsDir, getProjectSkillsDir } from './skill-writer.js';
import { parseSkillFile } from './skill-loader.js';
import type { ToolRegistryContext } from './pi-sdk-tools.js';

export const SKILL_BUNDLE_SCHEMA = 'bolloon-skill-bundle/1';
/** 技能包体积上限 (防把整个仓库塞进 IPFS) */
const MAX_BUNDLE_BYTES = 512 * 1024;

export interface SkillBundle {
  schema: string;
  name: string;
  description: string;
  version: string;
  triggers?: string[];
  exportedAt: string;
  author?: string;
  files: Record<string, string>;
}

export interface SkillBundleResult {
  ok: boolean;
  bundle?: SkillBundle;
  error?: string;
}

/** 收集一个技能目录 → 技能包 */
export async function collectSkillBundle(
  skillDir: string,
  opts: { name?: string; author?: string } = {},
): Promise<SkillBundleResult> {
  try {
    const st = await fs.stat(skillDir).catch(() => null);
    if (!st || !st.isDirectory()) return { ok: false, error: `技能目录不存在: ${skillDir}` };
    const files: Record<string, string> = {};
    let total = 0;
    const walk = async (dir: string, prefix: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;               // 跳过隐藏文件
        if (e.name.includes('.bak-')) continue;             // 跳过备份
        const abs = path.join(dir, e.name);
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) { await walk(abs, rel); continue; }
        if (!e.isFile()) continue;
        const content = await fs.readFile(abs, 'utf-8');
        total += content.length;
        if (total > MAX_BUNDLE_BYTES) return;
        files[rel] = content;
      }
    };
    await walk(skillDir, '');
    if (!files['SKILL.md']) return { ok: false, error: `技能目录缺少 SKILL.md: ${skillDir}` };
    const meta = await parseSkillFile(path.join(skillDir, 'SKILL.md'));
    const fm = (meta?.frontmatter || {}) as Record<string, any>;
    const version = String(fm.version ?? '1.0.0');
    const name = sanitizeSkillName(String(opts.name || meta?.name || path.basename(skillDir)));
    return {
      ok: true,
      bundle: {
        schema: SKILL_BUNDLE_SCHEMA,
        name,
        description: String(meta?.description ?? fm.description ?? ''),
        version,
        triggers: Array.isArray(meta?.triggers) ? meta!.triggers : undefined,
        exportedAt: new Date().toISOString(),
        author: opts.author,
        files,
      },
    };
  } catch (e: any) {
    return { ok: false, error: `收集技能失败: ${String(e?.message || e).slice(0, 200)}` };
  }
}

/** 校验 + 解析技能包 JSON */
export function parseSkillBundle(json: string): SkillBundleResult {
  let obj: any;
  try {
    obj = JSON.parse(json);
  } catch (e: any) {
    return { ok: false, error: `技能包不是合法 JSON: ${String(e?.message || e).slice(0, 120)}` };
  }
  if (!obj || typeof obj !== 'object') return { ok: false, error: '技能包为空' };
  if (obj.schema !== SKILL_BUNDLE_SCHEMA) {
    return { ok: false, error: `不是 bolloon 技能包 (schema=${obj.schema ?? '缺失'}, 期望 ${SKILL_BUNDLE_SCHEMA})` };
  }
  if (!obj.files || typeof obj.files !== 'object' || !obj.files['SKILL.md']) {
    return { ok: false, error: '技能包缺少 files["SKILL.md"]' };
  }
  return {
    ok: true,
    bundle: {
      schema: obj.schema,
      name: sanitizeSkillName(String(obj.name || 'shared-skill')),
      description: String(obj.description ?? ''),
      version: String(obj.version ?? '1.0.0'),
      triggers: Array.isArray(obj.triggers) ? obj.triggers.map(String) : undefined,
      exportedAt: String(obj.exportedAt ?? ''),
      author: obj.author ? String(obj.author) : undefined,
      files: Object.fromEntries(Object.entries(obj.files).map(([k, v]) => [String(k), String(v)])),
    },
  };
}

/** 版本比较 (1.2.3 形式; 非法版本当 0.0.0) */
export function compareVersions(a: string, b: string): number {
  const seg = (v: string) => String(v).split('.').map((x) => parseInt(x, 10)).map((n) => (Number.isFinite(n) ? n : 0));
  const [x, y] = [seg(a), seg(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** 分享引用 → CID (支持 bolloon://skill/<cid> / ipfs://<cid> / 裸 CID) */
export function parseSkillRef(ref: string): string | null {
  const s = String(ref || '').trim();
  if (!s) return null;
  const m = s.match(/^(?:bolloon:\/\/skill\/|ipfs:\/\/|ipfs\/)([A-Za-z0-9]+)/);
  if (m) return m[1];
  if (/^[A-Za-z0-9]{20,}$/.test(s)) return s;
  return null;
}

/** CID → 分享链接 */
export function skillShareLink(cid: string): string {
  return `bolloon://skill/${cid}`;
}

/** 把技能包上传到本地 IPFS (Kubo), 返回 CID */
export async function uploadSkillBundle(bundle: SkillBundle): Promise<{ ok: boolean; cid?: string; error?: string }> {
  try {
    // 确保本地 Kubo 就绪 (缺则自动安装启动), 否则分享出去的链接没人能拉
    await ensureKuboReady();
    const json = JSON.stringify(bundle);
    const boundary = `----bolloon${Date.now().toString(16)}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${bundle.name}.skill.json"\r\nContent-Type: application/json\r\n\r\n`),
      Buffer.from(json, 'utf-8'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const raw = await kuboApi('/api/v0/add?cid-version=1&pin=true', {
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: body as any,
    }, 60_000);
    // Kubo 可能返回 NDJSON 文本, 也可能被 kuboApi 按 content-type 解析成对象 → 两种都兼容
    let parsed: any;
    if (raw && typeof raw === 'object') {
      parsed = raw;
    } else {
      const last = String(raw).trim().split('\n').filter(Boolean).pop() || '{}';
      parsed = JSON.parse(last);
    }
    if (!parsed.Hash) return { ok: false, error: `Kubo 未返回 CID: ${String(raw).slice(0, 200)}` };
    return { ok: true, cid: String(parsed.Hash) };
  } catch (e: any) {
    return { ok: false, error: `上传技能包失败 (Kubo 未就绪?): ${String(e?.message || e).slice(0, 200)}` };
  }
}

/** 从本地 IPFS 读技能包 */
export async function fetchSkillBundle(cid: string): Promise<SkillBundleResult> {
  try {
    const text = await kuboApi(`/api/v0/cat?arg=${encodeURIComponent(cid)}`, undefined, 60_000);
    return parseSkillBundle(String(text));
  } catch (e: any) {
    return { ok: false, error: `读取技能包失败: ${String(e?.message || e).slice(0, 200)}` };
  }
}

export interface InstallOptions {
  home?: string;
  cwd?: string;
  scope?: 'user' | 'project';
  /** true = 即使本地版本更新也覆盖 */
  force?: boolean;
}

export interface InstallResult {
  ok: boolean;
  installed?: string;
  version?: string;
  files?: number;
  backup?: string;
  error?: string;
}

/** 安装技能包到本地技能目录 (默认 user 层 ~/.bolloon/skills) */
export async function installSkillBundle(bundle: SkillBundle, opts: InstallOptions = {}): Promise<InstallResult> {
  const home = opts.home ?? os.homedir();
  const base = opts.scope === 'project' ? getProjectSkillsDir(opts.cwd ?? process.cwd()) : getUserSkillsDir(home);
  const name = sanitizeSkillName(bundle.name);
  if (!name) return { ok: false, error: '技能名非法 (清洗后为空)' };
  const targetDir = path.join(base, name);

  // 版本门: 本地更新则拒绝 (除非 force)
  const existing = await fs.stat(targetDir).catch(() => null);
  let backup: string | undefined;
  if (existing?.isDirectory()) {
    const localMeta = await parseSkillFile(path.join(targetDir, 'SKILL.md')).catch(() => null);
    const localVersion = String((localMeta?.frontmatter as any)?.version ?? '0.0.0');
    if (compareVersions(localVersion, bundle.version) >= 0 && !opts.force) {
      return {
        ok: false,
        error: `本地已有 ${name}@${localVersion}, 来的是 ${bundle.version} (不更新) — 要强制覆盖请传 force=true`,
      };
    }
    // 备份旧目录 (可回滚)
    backup = `${targetDir}.bak-${Date.now()}`;
    await fs.cp(targetDir, backup, { recursive: true }).catch(() => { backup = undefined; });
  }

  try {
    // 先整体校验路径 (防穿越), 再落盘 — 避免写一半才发现非法路径
    for (const rel of Object.keys(bundle.files)) {
      const norm = path.normalize(rel).replace(/^([/\\])+/, '');
      if (norm.startsWith('..') || path.isAbsolute(norm)) {
        return { ok: false, error: `技能包含非法路径: ${rel}` };
      }
    }
    for (const [rel, content] of Object.entries(bundle.files)) {
      const norm = path.normalize(rel).replace(/^([/\\])+/, '');
      const abs = path.join(targetDir, norm);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, 'utf-8');
    }
    return { ok: true, installed: targetDir, version: bundle.version, files: Object.keys(bundle.files).length, backup };
  } catch (e: any) {
    return { ok: false, error: `写入技能失败: ${String(e?.message || e).slice(0, 200)}` };
  }
}

/** 从本地技能目录里找一个技能 (user 层优先, 再 project 层) */
export async function findLocalSkillDir(name: string, opts: { home?: string; cwd?: string } = {}): Promise<string | null> {
  const home = opts.home ?? os.homedir();
  const safe = sanitizeSkillName(name);
  const candidates = [
    path.join(getUserSkillsDir(home), safe),
    path.join(getProjectSkillsDir(opts.cwd ?? process.cwd()), safe),
  ];
  for (const c of candidates) {
    const st = await fs.stat(c).catch(() => null);
    if (st?.isDirectory()) return c;
  }
  return null;
}

/** 注册 skill_export / skill_import / skill_share 三个工具 */
export function registerSkillShareTools(ctx: ToolRegistryContext): void {
  ctx.tools.set('skill_export', {
    name: 'skill_export',
    description: '把一个本地技能打包上传到 IPFS, 返回可分享的 CID 与 bolloon://skill/<cid> 链接 (别的智能体用 skill_import 装)。导出前请确认技能已沉淀完整 (create_skill / update_skill)。',
    parameters: { skill: '技能名 (必填, 见 list_skills)', publish: '可选: "true" 同时发布 IPNS 稳定名 (内容更新后链接不变)' },
    execute: async (args) => {
      const name = String(args.skill || '').trim();
      if (!name) return { success: false, error: 'skill 必填' };
      const dir = await findLocalSkillDir(name, { home: os.homedir(), cwd: ctx.cwd });
      if (!dir) return { success: false, error: `本地未找到技能 '${name}' (用 list_skills 看有哪些)` };
      const collected = await collectSkillBundle(dir, { name, author: ctx.identity?.did });
      if (!collected.ok || !collected.bundle) return { success: false, error: collected.error };
      const up = await uploadSkillBundle(collected.bundle);
      if (!up.ok) return { success: false, error: up.error };
      const link = skillShareLink(up.cid!);
      let ipns = '';
      if (String(args.publish ?? '').toLowerCase() === 'true') {
        try {
          const keyName = `skill-${collected.bundle.name}`;
          await kuboApi(`/api/v0/key/gen?arg=${encodeURIComponent(keyName)}`).catch(() => {});
          const r = await kuboApi(`/api/v0/name/publish?arg=${encodeURIComponent(up.cid!)}&key=${encodeURIComponent(keyName)}&allow-offline=true`, undefined, 60_000);
          const n = String((r as any)?.Name || '');
          if (n) ipns = `\n  IPNS (稳定名): ipns://${n}`;
        } catch { /* IPNS 失败不算致命 */ }
      }
      return {
        success: true,
        output: `✅ 技能已导出\n  技能: ${collected.bundle.name}@${collected.bundle.version}\n  文件: ${Object.keys(collected.bundle.files).length} 个\n  CID: ${up.cid}\n  分享链接: ${link}${ipns}\n\n对端安装: skill_import(ref="${link}")`,
      };
    },
  });

  ctx.tools.set('skill_import', {
    name: 'skill_import',
    description: '从 IPFS 安装别的智能体分享的技能: 传 bolloon://skill/<cid> 链接或 CID (也支持 ipfs://<cid>)。本地同版本或更新版本会拒绝覆盖, 除非 force=true; 覆盖前自动备份旧目录。',
    parameters: { ref: '分享链接或 CID (必填)', scope: 'user | project (默认 user = ~/.bolloon/skills)', force: '可选: "true" 强制覆盖本地较新版本' },
    execute: async (args) => {
      const ref = String(args.ref || '').trim();
      if (!ref) return { success: false, error: 'ref 必填' };
      const cid = parseSkillRef(ref);
      if (!cid) return { success: false, error: `无法识别的引用: ${ref} (支持 bolloon://skill/<cid> / ipfs://<cid> / CID)` };
      const fetched = await fetchSkillBundle(cid);
      if (!fetched.ok || !fetched.bundle) return { success: false, error: fetched.error };
      const scope = String(args.scope || 'user').toLowerCase() === 'project' ? 'project' : 'user';
      const inst = await installSkillBundle(fetched.bundle, {
        cwd: ctx.cwd,
        scope: scope as 'user' | 'project',
        force: String(args.force ?? '').toLowerCase() === 'true',
      });
      if (!inst.ok) return { success: false, error: inst.error };
      return {
        success: true,
        output: `✅ 已安装技能 ${fetched.bundle.name}@${inst.version}\n  位置: ${inst.installed}\n  文件: ${inst.files} 个${inst.backup ? `\n  旧版本备份: ${inst.backup}` : ''}\n  (下轮对话即可用 use_skill 调用)`,
      };
    },
  });

  ctx.tools.set('skill_share', {
    name: 'skill_share',
    description: '把本地技能分享给别人: 打包上传 IPFS 得到链接, 可选直接通过已有 P2P 通道把链接发给指定好友 (peer)。对方用 skill_import 一键安装。',
    parameters: { skill: '技能名 (必填)', peer: '可选: 好友 peer id / 名字 (给了就直接发过去)', message: '可选: 随链接附一句话' },
    execute: async (args) => {
      const name = String(args.skill || '').trim();
      if (!name) return { success: false, error: 'skill 必填' };
      const dir = await findLocalSkillDir(name, { home: os.homedir(), cwd: ctx.cwd });
      if (!dir) return { success: false, error: `本地未找到技能 '${name}'` };
      const collected = await collectSkillBundle(dir, { name, author: ctx.identity?.did });
      if (!collected.ok || !collected.bundle) return { success: false, error: collected.error };
      const up = await uploadSkillBundle(collected.bundle);
      if (!up.ok) return { success: false, error: up.error };
      const link = skillShareLink(up.cid!);
      const peer = String(args.peer || '').trim();
      let sent = '';
      if (peer) {
        try {
          const { p2pNetwork } = await import('../network/p2p.js');
          const note = String(args.message || '').trim();
          const text = `[技能分享] ${collected.bundle.name}@${collected.bundle.version}${collected.bundle.description ? ` — ${collected.bundle.description}` : ''}\n安装: skill_import(ref="${link}")${note ? `\n${note}` : ''}`;
          await p2pNetwork.sendMessage(peer, 'message', text);
          sent = `\n  已通过 P2P 发给 ${peer}`;
        } catch (e: any) {
          sent = `\n  ⚠ P2P 发送失败 (链接仍可手动转发): ${String(e?.message || e).slice(0, 120)}`;
        }
      }
      return {
        success: true,
        output: `✅ 技能已分享\n  技能: ${collected.bundle.name}@${collected.bundle.version}\n  链接: ${link}${sent}`,
      };
    },
  });
}
