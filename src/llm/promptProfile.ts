/**
 * 提示词逐部分落盘诊断 (BOLLOON_PROMPT_PROFILE=1 时启用).
 *
 * 目的: 把最终发给 llama.cpp 的 messages 按逻辑部分拆开, 每部分完整文本 + 字符数 + sha256
 * 落盘到 /tmp/bolloon_prompt_parts/round<N>/, 便于跨轮 diff 定位"哪一部分每轮在变"
 * (从而判断 serving 层前缀 KV 缓存为何失效).
 *
 * 两部分来源:
 *   - pi-sdk (promptWithPivotLoop): 写 A 组 = systemPrompt / historyBlock / dynamicTail /
 *     intent / bootstrap / judgment / context / persona / tools / full
 *   - pi-ai (chat, 主 prompt >2000 分支): 写 B 组 = stableText / dynamicText / messages
 * 两者通过 globalThis.__ppRound 关联同一轮; pi-ai 同轮只记第一次主 prompt (防 pivot 多步重复).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';

const BASE = '/tmp/bolloon_prompt_parts';
let round = 0;

export function beginPromptProfile(): number {
  round++;
  (globalThis as any).__ppAiAdded = false;
  return round;
}

export function addPromptParts(r: number, parts: Record<string, string>, label?: string): void {
  if (!process.env.BOLLOON_PROMPT_PROFILE) return;
  if (typeof r !== 'number' || r <= 0) return;
  const dir = `${BASE}/round${r}`;
  try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  const mf = `${dir}/manifest.json`;
  let manifest: any = { round: r, label: label ?? '', parts: {} };
  if (existsSync(mf)) {
    try { manifest = JSON.parse(readFileSync(mf, 'utf8')); } catch { /* ignore */ }
  }
  for (const [k, v] of Object.entries(parts)) {
    if (typeof v !== 'string') continue;
    try { writeFileSync(`${dir}/${k}.txt`, v); } catch { /* ignore */ }
    manifest.parts[k] = {
      chars: v.length,
      sha: createHash('sha256').update(v).digest('hex').slice(0, 12),
    };
  }
  try { writeFileSync(mf, JSON.stringify(manifest, null, 2)); } catch { /* ignore */ }
}

export function getLastRound(): number {
  return round;
}
