/**
 * skills-manager.ts — Skills Manager Runtime 的统一门面 (2026-09-16, 批次 2-G.1)
 *
 * 之前的问题: 技能能力被拆成四个各自为政的入口 (skill-loader 扫描 / skill-share 打包分享 /
 * skill-writer 生成 / skill-organizer 整理), 谁也不知道"这个技能现在到底是什么状态、来自哪里、能不能用",
 * CLI / Web / agent 各看各的。长期执行的 Goal 因此无法固定"我依赖的技能是哪一版"。
 *
 * 这一层做的事 (2-G.1 范围):
 *   - **统一事实模型**: 每个技能一条 `SkillRecord` (skillId/name/version/contentHash/source/sourceRef/
 *     status/trust/compatibility/installedAt/updatedAt);
 *   - **统一入口**: discover / inspect / install / import / enable / disable / validate / resolve /
 *     snapshot / health / export —— CLI / Web / Supervisor / agent 都只走这里, 不再各自直调底层模块;
 *   - **内容真值仍是 SKILL.md**, 管理元数据落在 `~/.bolloon/skills-registry.json` (不让 loader/share/writer 各自推断)。
 *
 * 2-G.1 **刻意不改执行行为**: enable/disable/status 只被记录与展示; 真正用它拦执行 (readiness gate)
 * 与 Goal 级 skill snapshot 属 2-G.2/2-G.4。
 */

import * as os from 'os';
import * as path from 'path';
import * as fsp from 'fs/promises';
import * as crypto from 'crypto';
import { parseSkillFile, SkillMeta, defaultSkillPaths } from './skill-loader.js';
import { getUserSkillsDir, getProjectSkillsDir } from './skill-writer.js';
import {
  collectSkillBundle, parseSkillBundle, parseSkillRef, fetchSkillBundle, installSkillBundle,
  type SkillBundle,
} from './skill-share.js';

// ─────────────────────────────────────────────────────────────────────────────
// 事实模型
// ─────────────────────────────────────────────────────────────────────────────

export type SkillStatus = 'discovered' | 'installed' | 'enabled' | 'disabled' | 'archived' | 'invalid' | 'quarantined';
export type SkillSource = 'project' | 'user' | 'imported' | 'shared' | 'generated';
export type SkillTrust = 'verified' | 'unverified' | 'quarantined';

export interface SkillRecord {
  /** 稳定 id (= name 的规范形式; 单独留字段以便以后换命名空间) */
  skillId: string;
  name: string;
  description: string;
  version: string;
  /** 技能目录整体内容摘要 (SKILL.md + references 等, 排序后逐文件摘要) */
  contentHash: string;
  source: SkillSource;
  /** 来源指向: 本地路径 / CID / 分享链接 / 生成它的 runId */
  sourceRef?: string;
  status: SkillStatus;
  trust: SkillTrust;
  compatibility?: string;
  tier: string;
  triggers: string[];
  /** SKILL.md 绝对路径 */
  skillFile: string;
  dir: string;
  fileCount: number;
  bytes: number;
  installedAt: string;
  updatedAt: string;
  /** validate() 发现的问题 (空 = 没有问题) */
  issues: string[];
  /** registry 记录的 hash (用于检出内容漂移) */
  registryHash?: string;
  /** 人工批准信息 (approve()) */
  approvedBy?: string;
  approvedAt?: string;
  /** 被隔离的原因与时间 (quarantine()) */
  quarantineReason?: string;
  quarantinedAt?: string;
}

export interface SkillSnapshotEntry {
  name: string;
  version: string;
  contentHash: string;
  source: SkillSource;
  resolvedAt: string;
}

export interface SkillsRegistryFile {
  schema: 'bolloon-skills-registry/1';
  /** name → 管理元数据 (内容真值仍在 SKILL.md) */
  skills: Record<string, Partial<SkillRecord> & { name: string }>;
  updatedAt: string;
}

export interface SkillHealth {
  total: number;
  byStatus: Record<string, number>;
  bySource: Record<string, number>;
  /** 内容被改过 (hash 与 registry 不一致) */
  drifted: { name: string; expected?: string; actual: string }[];
  /** 结构/内容有问题的 */
  invalid: { name: string; issues: string[] }[];
  /** 同名出现在多个目录 */
  duplicates: { name: string; dirs: string[] }[];
  /** registry 里记着、盘上找不到的 */
  missing: string[];
}

// ─────────────────────────────────────────────────────────────────────────────

export function registryPath(home: string = os.homedir()): string {
  return path.join(home, '.bolloon', 'skills-registry.json');
}

async function readRegistry(home: string): Promise<SkillsRegistryFile> {
  try {
    const raw = JSON.parse(await fsp.readFile(registryPath(home), 'utf8')) as SkillsRegistryFile;
    if (raw && typeof raw.skills === 'object' && raw.skills) return raw;
  } catch { /* 缺文件/坏文件 → 空 registry (不阻挡发现) */ }
  return { schema: 'bolloon-skills-registry/1', skills: {}, updatedAt: new Date(0).toISOString() };
}

async function writeRegistry(reg: SkillsRegistryFile, home: string): Promise<void> {
  const p = registryPath(home);
  await fsp.mkdir(path.dirname(p), { recursive: true });
  reg.updatedAt = new Date().toISOString();
  const tmp = `${p}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(reg, null, 2), 'utf8');
  await fsp.rename(tmp, p);                     // 原子替换
}

/** 技能目录内容摘要: 排序后逐文件 sha256 → 再摘要一次 (目录整体指纹) */
export async function hashSkillDir(dir: string): Promise<{ hash: string; fileCount: number; bytes: number; issues: string[] }> {
  const issues: string[] = [];
  const files: { rel: string; content: Buffer }[] = [];
  let bytes = 0;
  const walk = async (d: string, prefix: string): Promise<void> => {
    let entries;
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch (err) {
      issues.push(`目录不可读: ${String((err as Error)?.message || err).slice(0, 80)}`);
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(d, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isSymbolicLink()) { issues.push(`符号链接被跳过 (避免越界): ${rel}`); continue; }
      if (e.isDirectory()) { await walk(abs, rel); continue; }
      if (!e.isFile()) continue;
      try {
        const buf = await fsp.readFile(abs);
        bytes += buf.length;
        files.push({ rel, content: buf });
      } catch (err) {
        issues.push(`文件不可读: ${rel} (${String((err as Error)?.message || err).slice(0, 60)})`);
      }
    }
  };
  await walk(dir, '');
  const h = crypto.createHash('sha256');
  for (const f of files) {
    h.update(f.rel);
    h.update('\0');
    h.update(crypto.createHash('sha256').update(f.content).digest());
  }
  return { hash: h.digest('hex').slice(0, 32), fileCount: files.length, bytes, issues };
}

/** 单条记录的结构校验 (纯函数, 可单测) */
export function validateSkillRecord(input: { name: string; description: string; body: string; frontmatter: Record<string, unknown>; bytes: number; issues?: string[] }): string[] {
  const issues = [...(input.issues || [])];
  if (!input.name || !/^[a-z0-9_-]{1,64}$/i.test(input.name)) issues.push('技能名非法 (只允许字母数字下划线连字符, ≤64)');
  if (!input.description || input.description.trim().length < 4) issues.push('缺少 description (SKILL.md frontmatter)');
  if (!input.body || input.body.trim().length < 20) issues.push('正文内容过少 (可能不是有效的 SKILL.md)');
  if (input.bytes > 2 * 1024 * 1024) issues.push(`技能体积过大 (${Math.round(input.bytes / 1024)}KB > 2MB)`);
  const fmStatus = String(input.frontmatter?.status ?? 'active');
  if (!['active', 'archived', 'draft'].includes(fmStatus)) issues.push(`frontmatter.status 非法: ${fmStatus}`);
  return issues;
}

// ─────────────────────────────────────────────────────────────────────────────

export interface DiscoverOptions { home?: string; cwd?: string; writeRegistry?: boolean }

export class SkillsManager {
  private readonly home: string;
  private readonly cwd: string;
  private cache: SkillRecord[] | null = null;
  /** 同名技能出现在哪些目录 (discover 时记录; 同名会被覆盖成一条记录, 重复必须单独留痕) */
  private dirsByName = new Map<string, string[]>();

  constructor(opts: { home?: string; cwd?: string } = {}) {
    this.home = opts.home ?? os.homedir();
    this.cwd = opts.cwd ?? process.cwd();
  }

  /** 技能搜索路径 (去重, 顺序 = 优先级从低到高) */
  skillDirs(): { dir: string; source: SkillSource }[] {
    const out: { dir: string; source: SkillSource }[] = [
      { dir: path.join(this.cwd, '.bolloon', 'skills'), source: 'project' },
      { dir: getUserSkillsDir(this.home), source: 'user' },
    ];
    for (const p of defaultSkillPaths(this.home, this.cwd)) {
      if (!out.some((x) => x.dir === p)) out.push({ dir: p, source: 'user' });
    }
    return out;
  }

  /** 扫描所有技能目录 + registry → 统一视图 (同名: 后者覆盖前者, 与 loader 语义一致) */
  async discover(opts: DiscoverOptions = {}): Promise<SkillRecord[]> {
    const home = opts.home ?? this.home;
    const reg = await readRegistry(home);
    const byName = new Map<string, SkillRecord>();
    const dirsByName = new Map<string, string[]>();

    for (const { dir, source } of this.skillDirs()) {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch { continue; }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.')) continue;
        const skillDir = path.join(dir, e.name);
        const skillFile = path.join(skillDir, 'SKILL.md');
        const meta: SkillMeta | null = await parseSkillFile(skillFile).catch(() => null);
        const counted = await hashSkillDir(skillDir);
        if (!meta) {
          // 目录在但不是有效技能: 也进视图 (状态 invalid), 不许静默消失
          const rec = this.buildRecord({
            name: e.name, description: '', version: '0.0.0', frontmatter: {}, body: '',
            dir: skillDir, skillFile, source, hash: counted.hash, fileCount: counted.fileCount,
            bytes: counted.bytes, issues: [`SKILL.md 缺失或无法解析`, ...counted.issues], reg,
          });
          byName.set(rec.name, rec);
          dirsByName.set(rec.name, [...(dirsByName.get(rec.name) || []), skillDir]);
          continue;
        }
        const rec = this.buildRecord({
          name: meta.name || e.name, description: meta.description, version: String((meta.frontmatter as any)?.version ?? '0.0.0'),
          frontmatter: meta.frontmatter, body: meta.body, dir: skillDir, skillFile, source,
          hash: counted.hash, fileCount: counted.fileCount, bytes: counted.bytes, issues: counted.issues, reg, tier: meta.tier, triggers: meta.triggers,
        });
        byName.set(rec.name, rec);
        dirsByName.set(rec.name, [...(dirsByName.get(rec.name) || []), skillDir]);
      }
    }

    const records = Array.from(byName.values());
    this.cache = records;
    this.dirsByName = dirsByName;
    if (opts.writeRegistry !== false) {
      // 首次发现把缺记录补进 registry (内容 hash 作为基线), 以后才能检出漂移
      let changed = false;
      for (const r of records) {
        if (!reg.skills[r.name]) {
          reg.skills[r.name] = {
            skillId: r.skillId, name: r.name, version: r.version, contentHash: r.contentHash,
            source: r.source, sourceRef: r.dir, status: r.status, trust: r.trust,
            installedAt: r.installedAt, updatedAt: r.updatedAt,
          };
          changed = true;
        }
      }
      if (changed) await writeRegistry(reg, home).catch(() => {});
    }
    return records;
  }

  private buildRecord(input: {
    name: string; description: string; version: string; frontmatter: Record<string, unknown>; body: string;
    dir: string; skillFile: string; source: SkillSource; hash: string; fileCount: number; bytes: number;
    issues: string[]; reg: SkillsRegistryFile; tier?: string; triggers?: string[];
  }): SkillRecord {
    const prior = input.reg.skills[input.name];
    const issues = validateSkillRecord({
      name: input.name, description: input.description, body: input.body,
      frontmatter: input.frontmatter, bytes: input.bytes, issues: input.issues,
    });
    const fmStatus = String(input.frontmatter?.status ?? 'active');
    // 状态优先级: 结构坏 → invalid; registry 显式停用/隔离/归档 → 尊重; 否则按 frontmatter/来源推导
    let status: SkillStatus;
    if (issues.length) status = 'invalid';
    else if (prior?.status === 'disabled' || prior?.status === 'quarantined' || prior?.status === 'archived') status = prior.status as SkillStatus;
    else if (fmStatus === 'archived') status = 'archived';
    else if (fmStatus === 'draft') status = 'discovered';
    else status = prior?.status === 'installed' ? 'installed' : 'enabled';

    const source: SkillSource = (prior?.source as SkillSource)
      || (input.source === 'project' ? 'project' : 'user');
    const now = new Date().toISOString();
    return {
      skillId: prior?.skillId || input.name,
      name: input.name,
      description: input.description,
      version: input.version,
      contentHash: input.hash,
      source,
      sourceRef: prior?.sourceRef || input.dir,
      status,
      trust: (prior?.trust as SkillTrust) || 'unverified',
      compatibility: input.frontmatter?.compatibility ? String(input.frontmatter.compatibility) : undefined,
      tier: input.tier || 'utility',
      triggers: input.triggers || [],
      skillFile: input.skillFile,
      dir: input.dir,
      fileCount: input.fileCount,
      bytes: input.bytes,
      installedAt: prior?.installedAt || now,
      updatedAt: now,
      issues,
      registryHash: prior?.contentHash,
      approvedBy: prior?.approvedBy,
      approvedAt: prior?.approvedAt,
    };
  }

  /** 单技能详情 (含正文长度与漂移判定) */
  async inspect(name: string, opts: { home?: string } = {}): Promise<SkillRecord | null> {
    const all = this.cache && !opts.home ? this.cache : await this.discover(opts);
    return all.find((s) => s.name === name) || null;
  }

  /** 解析一组技能名 → 记录 (缺哪个说清); 2-G.2 的 readiness gate 就用这个 */
  async resolve(names: string[], opts: { home?: string } = {}): Promise<{ ok: boolean; resolved: SkillRecord[]; missing: string[]; notEnabled: string[] }> {
    const all = await this.discover(opts);
    const resolved: SkillRecord[] = [];
    const missing: string[] = [];
    const notEnabled: string[] = [];
    for (const n of names) {
      const hit = all.find((s) => s.name === n);
      if (!hit) { missing.push(n); continue; }
      if (hit.status !== 'enabled' && hit.status !== 'installed') notEnabled.push(n);
      resolved.push(hit);
    }
    return { ok: missing.length === 0 && notEnabled.length === 0, resolved, missing, notEnabled };
  }

  /** 版本固定的技能快照 (Goal 级固定版本用; resolvedAt 记录解析时刻) */
  async snapshot(names: string[], opts: { home?: string } = {}): Promise<{ ok: boolean; entries: SkillSnapshotEntry[]; missing: string[] }> {
    const r = await this.resolve(names, opts);
    const resolvedAt = new Date().toISOString();
    return {
      ok: r.missing.length === 0,
      missing: r.missing,
      entries: r.resolved.map((s) => ({ name: s.name, version: s.version, contentHash: s.contentHash, source: s.source, resolvedAt })),
    };
  }

  /** 健康检查: 状态/来源分布 + 漂移 + 不合格 + 重复 + registry 缺盘 */
  async health(opts: { home?: string } = {}): Promise<SkillHealth> {
    const home = opts.home ?? this.home;
    const all = await this.discover(opts);
    const reg = await readRegistry(home);
    const byStatus: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    const drifted: { name: string; expected?: string; actual: string }[] = [];
    const invalid: { name: string; issues: string[] }[] = [];
    const duplicates: { name: string; dirs: string[] }[] = [];
    for (const s of all) {
      byStatus[s.status] = (byStatus[s.status] || 0) + 1;
      bySource[s.source] = (bySource[s.source] || 0) + 1;
      if (s.issues.length) invalid.push({ name: s.name, issues: s.issues });
      const prior = reg.skills[s.name];
      if (prior?.contentHash && prior.contentHash !== s.contentHash) {
        drifted.push({ name: s.name, expected: prior.contentHash, actual: s.contentHash });
      }
    }
    for (const [name, dirs] of this.dirsByName) {
      const uniq = Array.from(new Set(dirs));
      if (uniq.length > 1) duplicates.push({ name, dirs: uniq });
    }

    const missing = Object.keys(reg.skills).filter((n) => !all.some((s) => s.name === n));
    return { total: all.length, byStatus, bySource, drifted, invalid, duplicates, missing };
  }

  // ── 管理动作 (2-G.1: 只改状态与账, 不改执行行为) ──────────────────────────

  private async patchRegistry(name: string, patch: Partial<SkillRecord>, home?: string): Promise<SkillRecord | null> {
    const h = home ?? this.home;
    const rec = await this.inspect(name, { home: h });
    if (!rec) return null;
    const reg = await readRegistry(h);
    reg.skills[name] = { ...(reg.skills[name] || {}), ...patch, name };
    await writeRegistry(reg, h);
    this.cache = null;
    const after = await this.inspect(name, { home: h });
    return after;
  }

  async enable(name: string, opts: { home?: string } = {}): Promise<{ ok: boolean; reason?: string; skill?: SkillRecord }> {
    const rec = await this.inspect(name, opts);
    if (!rec) return { ok: false, reason: `没有这个技能: ${name}` };
    if (rec.issues.length) return { ok: false, reason: `技能不合格, 不能启用: ${rec.issues.join('; ')}` };
    const skill = await this.patchRegistry(name, { status: 'enabled' }, opts.home);
    return { ok: true, skill: skill || undefined };
  }

  async disable(name: string, opts: { home?: string } = {}): Promise<{ ok: boolean; reason?: string; skill?: SkillRecord }> {
    const rec = await this.inspect(name, opts);
    if (!rec) return { ok: false, reason: `没有这个技能: ${name}` };
    const skill = await this.patchRegistry(name, { status: 'disabled' }, opts.home);
    return { ok: true, skill: skill || undefined };
  }

  /** 人工批准 (信任等级 verified); 2-G.3 的 import 事务会要求它才算"可用" */
  async approve(name: string, by = 'human', opts: { home?: string } = {}): Promise<{ ok: boolean; reason?: string; skill?: SkillRecord }> {
    const rec = await this.inspect(name, opts);
    if (!rec) return { ok: false, reason: `没有这个技能: ${name}` };
    const skill = await this.patchRegistry(name, { trust: 'verified', approvedBy: by, approvedAt: new Date().toISOString() }, opts.home);
    return { ok: true, skill: skill || undefined };
  }

  /** 隔离 (损坏/不可信来源); 被隔离的技能不允许长期 Goal 自动使用 */
  async quarantine(name: string, reason: string, opts: { home?: string } = {}): Promise<{ ok: boolean; skill?: SkillRecord }> {
    const rec = await this.inspect(name, opts);
    if (!rec) return { ok: false };
    const reg = await readRegistry(opts.home ?? this.home);
    reg.skills[name] = {
      ...(reg.skills[name] || {}), name,
      status: 'quarantined', trust: 'quarantined',
      quarantineReason: reason.slice(0, 200), quarantinedAt: new Date().toISOString(),
    };
    await writeRegistry(reg, opts.home ?? this.home);
    this.cache = null;
    return { ok: true, skill: (await this.inspect(name, opts)) || undefined };
  }

  /** 结构校验: 重算问题清单并把状态落成 invalid (或从 invalid 恢复) */
  async validate(name: string, opts: { home?: string } = {}): Promise<{ ok: boolean; issues: string[]; skill?: SkillRecord }> {
    const rec = await this.inspect(name, opts);
    if (!rec) return { ok: false, issues: [`没有这个技能: ${name}`] };
    const skill = await this.patchRegistry(name, { status: rec.issues.length ? 'invalid' : (rec.status === 'invalid' ? 'enabled' : rec.status) }, opts.home);
    return { ok: rec.issues.length === 0, issues: rec.issues, skill: skill || undefined };
  }

  /** 导出技能包 (复用 skill-share 的打包, 不重复实现) */
  async export(name: string, opts: { home?: string } = {}): Promise<{ ok: boolean; bundle?: SkillBundle; error?: string }> {
    const rec = await this.inspect(name, opts);
    if (!rec) return { ok: false, error: `没有这个技能: ${name}` };
    return collectSkillBundle(rec.dir, { name: rec.name });
  }

  /**
   * 导入技能 (对话/链接/CID 三种写法都支持)。
   * **2-G.1 只做统一入口 + 记账**: 下载 → 安装仍走现有 installSkillBundle (已有路径穿越校验 / 版本门 / 备份),
   * 事务化 (临时目录 + 原子移动 + hash 校验) 属 2-G.3。
   */
  async import(ref: string, opts: { home?: string; cwd?: string; force?: boolean; scope?: 'user' | 'project'; source?: SkillSource } = {}): Promise<{ ok: boolean; name?: string; version?: string; error?: string; skill?: SkillRecord }> {
    const cid = parseSkillRef(ref);
    if (!cid) return { ok: false, error: `无法识别的技能引用 (要 bolloon://skill/<cid> / ipfs://<cid> / 裸 CID): ${ref.slice(0, 60)}` };
    const fetched = await fetchSkillBundle(cid);
    if (!fetched.ok || !fetched.bundle) return { ok: false, error: fetched.error || '取包失败' };
    const inst = await installSkillBundle(fetched.bundle, { home: opts.home ?? this.home, cwd: opts.cwd ?? this.cwd, force: opts.force, scope: opts.scope });
    if (!inst.ok) return { ok: false, error: inst.error };
    const h = opts.home ?? this.home;
    const name = fetched.bundle.name;
    this.cache = null;
    const after = await this.inspect(name, { home: h });
    if (after) {
      await this.patchRegistry(name, {
        status: 'installed', source: opts.source || 'shared', sourceRef: cid, trust: 'unverified',
        contentHash: after.contentHash, version: after.version,
      }, h);
    }
    return { ok: true, name, version: fetched.bundle.version, skill: (await this.inspect(name, { home: h })) || undefined };
  }

  /** 从已解析的技能包装入 (本地文件/已取到的包) */
  async install(bundleJson: string, opts: { home?: string; cwd?: string; force?: boolean; source?: SkillSource; sourceRef?: string } = {}): Promise<{ ok: boolean; name?: string; error?: string; skill?: SkillRecord }> {
    const parsed = parseSkillBundle(bundleJson);
    if (!parsed.ok || !parsed.bundle) return { ok: false, error: parsed.error || '包格式非法' };
    const inst = await installSkillBundle(parsed.bundle, { home: opts.home ?? this.home, cwd: opts.cwd ?? this.cwd, force: opts.force });
    if (!inst.ok) return { ok: false, error: inst.error };
    const h = opts.home ?? this.home;
    this.cache = null;
    const after = await this.inspect(parsed.bundle.name, { home: h });
    if (after) {
      await this.patchRegistry(parsed.bundle.name, {
        status: 'installed', source: opts.source || 'imported', sourceRef: opts.sourceRef || 'local-bundle',
        trust: 'unverified', contentHash: after.contentHash, version: after.version,
      }, h);
    }
    return { ok: true, name: parsed.bundle.name, skill: (await this.inspect(parsed.bundle.name, { home: h })) || undefined };
  }

  // ── 视图 ─────────────────────────────────────────────────────────────────

  /** 给 CLI / Web / agent 的同一份列表 (字段一致, 顺序一致: name 升序) */
  async view(opts: { home?: string } = {}): Promise<SkillRecord[]> {
    const all = await this.discover(opts);
    return [...all].sort((a, b) => a.name.localeCompare(b.name));
  }
}

let singleton: SkillsManager | null = null;

/** 进程内单例 (CLI / Web / Supervisor 共用同一个视图实现) */
export function getSkillsManager(opts: { home?: string; cwd?: string } = {}): SkillsManager {
  if (!singleton) singleton = new SkillsManager(opts);
  return singleton;
}

export function resetSkillsManagerForTest(): void {
  singleton = null;
}

/** 一行摘要 (CLI / 日志用) */
export function formatSkillLine(s: SkillRecord): string {
  return `${s.name.padEnd(28)} ${String(s.status).padEnd(11)} ${String(s.source).padEnd(9)} ${String(s.trust).padEnd(10)} v${s.version.padEnd(8)} ${s.contentHash.slice(0, 10)}${s.issues.length ? `  ⚠ ${s.issues.length} 个问题` : ''}`;
}
