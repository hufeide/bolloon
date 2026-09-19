/**
 * resource-advisor.ts — M1 薄层 ②: 资源顾问
 *
 * 只回答三个问题:
 *   ① 当前任务是否缺外部能力?
 *   ② 本地 Registry 里哪个可执行 Skill 满足契约?
 *   ③ 为什么选它?
 *
 * M1 明确**不做**: 语义搜索 / 向量检索 / P2P 发现 / 竞价 / 推荐系统。
 * 这里只有: 关键词确定性匹配 + 契约完整性检查 + 价格来源(报价)检查, 同分用名字排序 (可复现)。
 *
 * "本地 Registry" = 已装技能目录 (`defaultSkillPaths` + `~/.bolloon/skills`)
 *                × 本机 x402 报价 (`listInfo`), 两者按约定关联 (见 linkListing)。
 */

import * as os from 'os';
import * as path from 'path';
import { defaultSkillPaths, loadSkillsDir } from '../skill-loader.js';
import { listInfo } from '../x402/paid-info-store.js';
import { parseResourceContract, type ResourceContract } from '../x402/resource-contract.js';

export interface AdvisorListing {
  itemId: string;
  title: string;
  amount: string;
  currency: string;
  network: string;
  payTo: string;
  /** 报价里声明的技能名 (约定字段) */
  skillName?: string;
}

export interface AdvisorCandidate {
  name: string;
  version: string;
  dir: string;
  contract: ResourceContract;
  score: number;
  why: string[];
  /** 没有报价 = 买不到 (M1 不假装能买) */
  listing?: AdvisorListing;
}

export interface AdvisorResult {
  /** 任务是否"缺外部能力" (有可执行候选 = 缺) */
  needed: boolean;
  reason: string;
  candidates: AdvisorCandidate[];
  chosen?: AdvisorCandidate;
  notes: string[];
}

/** 中文按 bigram、英文/数字按词切; 去停用词。确定性, 无随机。 */
export function tokenizeTask(task: string): string[] {
  const text = String(task || '').toLowerCase();
  const out: string[] = [];
  for (const m of text.matchAll(/[a-z0-9][a-z0-9._-]+/g)) out.push(m[0]);
  const cjk = text.replace(/[^\u4e00-\u9fff]+/g, ' ');
  for (const seg of cjk.split(/\s+/)) {
    if (!seg) continue;
    if (seg.length <= 2) { out.push(seg); continue; }
    for (let i = 0; i + 2 <= seg.length; i++) out.push(seg.slice(i, i + 2));
  }
  const stop = new Set(['这个', '那个', '一个', '是否', '请问', '帮我', 'the', 'and', 'for', 'with', 'task']);
  return Array.from(new Set(out.filter((t) => t.length >= 2 && !stop.has(t))));
}

/** 关键词命中打分: 只在名字 / 描述 / triggers / capability 文本里找, 命中即记 why。 */
export function scoreSkill(args: {
  tokens: string[];
  name: string;
  description?: string;
  triggers?: string[];
  capability?: string;
  guarantees?: string[];
}): { score: number; why: string[] } {
  const fields: Array<[string, string]> = [
    ['name', args.name || ''],
    ['description', args.description || ''],
    ['triggers', (args.triggers || []).join(' ')],
    ['capability', args.capability || ''],
    ['guarantees', (args.guarantees || []).join(' ')],
  ];
  const lowered = fields.map(([k, v]) => [k, v.toLowerCase()] as const);
  const why: string[] = [];
  let score = 0;
  for (const tok of args.tokens) {
    for (const [field, text] of lowered) {
      if (!text) continue;
      if (text.includes(tok)) {
        const w = field === 'name' ? 3 : field === 'capability' ? 2 : 1;
        score += w;
        why.push(`命中 ${field}: "${tok}" (+${w})`);
        break;
      }
    }
  }
  return { score, why };
}

/**
 * 报价 ↔ 技能 的关联约定 (M1 确定性规则, 不做模糊匹配):
 *   ① item.id === skill 名  ② item.source.note 含 `skill=<name>`  ③ item.title 含技能名
 */
export function linkListing(
  skillName: string,
  items: Array<{ id: string; title?: string; source?: { note?: string }; price?: { amount?: string; currency?: string; network?: string; payTo?: string } }>,
): AdvisorListing | undefined {
  const lower = skillName.toLowerCase();
  const hit = items.find((i) => {
    if (String(i.id).toLowerCase() === lower) return true;
    const note = String(i.source?.note || '').toLowerCase();
    if (note.includes(`skill=${lower}`)) return true;
    return String(i.title || '').toLowerCase().includes(lower);
  });
  if (!hit) return undefined;
  return {
    itemId: hit.id,
    title: String(hit.title || hit.id),
    amount: String(hit.price?.amount ?? '0'),
    currency: String(hit.price?.currency ?? 'USDC'),
    network: String(hit.price?.network ?? 'base-sepolia'),
    payTo: String(hit.price?.payTo ?? ''),
    skillName: String((hit as any).source?.note || '').includes('skill=') ? skillName : undefined,
  };
}

/**
 * 顾问主函数: 扫本地 Registry → 过滤"有契约且可执行"的候选 → 确定性打分排序。
 * 不猜: 一个候选都没有 → needed:false 并说明原因。
 */
export async function adviseResource(opts: {
  task: string;
  home?: string;
  cwd?: string;
  skillPaths?: string[];
  minScore?: number;
}): Promise<AdvisorResult> {
  const home = opts.home ?? os.homedir();
  const cwd = opts.cwd ?? process.cwd();
  const notes: string[] = [];
  const paths = (opts.skillPaths ?? [...defaultSkillPaths(home, cwd), path.join(home, '.bolloon', 'skills')]);
  const merged: string[] = [];
  for (const p of paths) if (!merged.includes(p)) merged.push(p);

  const skillDirs: Array<{ name: string; version: string; dir: string; description?: string; triggers: string[]; contract: ResourceContract }> = [];
  for (const p of merged) {
    let metas: any[] = [];
    try {
      metas = await loadSkillsDir(p);
    } catch (e: any) {
      notes.push(`技能目录不可读 (跳过): ${p} — ${String(e?.message || e).slice(0, 80)}`);
      continue;
    }
    for (const meta of metas) {
      const fm = (meta.frontmatter || {}) as Record<string, unknown>;
      const parsed = parseResourceContract(fm, { skillName: String(meta.name), skillVersion: String(fm.version || '') });
      if (!parsed.ok || !parsed.contract) continue;                       // 非法契约直接不算候选
      const c = parsed.contract as any;
      if (!c.execution?.entrypoint) continue;                              // 不可执行 → 不是 M1 要的资源
      if (!c.inputSchema || !c.outputSchema) continue;                     // 无输入/输出契约 → 不买
      skillDirs.push({
        name: String(meta.name),
        version: String(fm.version || (c.version ?? '')),
        dir: path.dirname(String(meta.sourcePath)),
        description: String(meta.description || ''),
        triggers: (meta.triggers || []) as string[],
        contract: parsed.contract,
      });
    }
  }

  if (skillDirs.length === 0) {
    return { needed: false, reason: `本地 Registry 里没有"可执行且契约完整"的 Skill (已扫 ${merged.length} 个目录)`, candidates: [], notes };
  }

  const items = await listInfo(home);
  const tokens = tokenizeTask(opts.task);
  const candidates: AdvisorCandidate[] = skillDirs.map((s) => {
    const c = s.contract as any;
    const scored = scoreSkill({
      tokens,
      name: s.name,
      description: s.description,
      triggers: s.triggers,
      capability: c.capability,
      guarantees: c.guarantees,
    });
    return {
      name: s.name,
      version: s.version,
      dir: s.dir,
      contract: s.contract,
      score: scored.score,
      why: scored.why,
      listing: linkListing(s.name, items as any),
    };
  });

  // 确定性排序: 分数降序 → 名字升序
  candidates.sort((a, b) => (b.score - a.score) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const minScore = opts.minScore ?? 1;
  const top = candidates[0];
  if (!top || top.score < minScore) {
    return {
      needed: false,
      reason: `任务关键词与本地可执行 Skill 都不匹配 (最高分 ${top?.score ?? 0} < ${minScore}) — 不买不该买的东西`,
      candidates,
      notes,
    };
  }
  if (!top.listing) {
    notes.push(`候选 Skill "${top.name}" 没有本机报价 (listInfo 里没有对应 item) → M1 买不到, 会如实告诉你`);
  }
  return {
    needed: true,
    reason: `本地 Registry 命中 "${top.name}" (分数 ${top.score}: ${top.why.slice(0, 3).join(' / ') || '名字匹配'})`,
    candidates,
    chosen: top,
    notes,
  };
}
