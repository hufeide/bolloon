/**
 * user-questions.test.ts — 人机问答通道 (clarify) 单测
 *
 * 覆盖: ask/answer 配对、选项归一化 (序号 → 文本)、超时如实返回、重复回答被拒、
 *       onQuestion 订阅、无人界面时的判定。用临时文件, 不碰真实 ~/.bolloon。
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { UserQuestionStore, normalizeAnswer, formatQuestion } from '../agents/user-questions.js';

const stores: UserQuestionStore[] = [];
async function newStore(): Promise<{ store: UserQuestionStore; file: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bolloon-q-'));
  const file = path.join(dir, 'user-questions.json');
  const store = new UserQuestionStore(file);
  stores.push(store);
  return { store, file };
}

afterEach(async () => {
  for (const s of stores) s.__resetForTest();
  stores.length = 0;
});

describe('user-questions (clarify 通道)', () => {
  it('ask 等待 → answer 解析 promise, 返回 answered + 回答', async () => {
    const { store } = await newStore();
    const promise = store.ask({ question: '选哪个方案?', choices: ['A', 'B'], timeoutMs: 5000 });
    // 等 ask 建好问题 (listeners 同步触发, pending 通过文件/内存可见)
    await new Promise((r) => setTimeout(r, 10));
    const pending = await store.pending();
    expect(pending).toHaveLength(1);
    const r = await store.answer(pending[0].id, '1');
    expect(r.ok).toBe(true);
    const q = await promise;
    expect(q.status).toBe('answered');
    expect(q.answer).toBe('A');   // 序号 → 选项文本
  });

  it('超时 → status=expired (如实返回, 不伪造答案)', async () => {
    const { store } = await newStore();
    const q = await store.ask({ question: '在吗?', timeoutMs: 60 });
    expect(q.status).toBe('expired');
    expect(q.answer).toBeUndefined();
  });

  it('同一问题回答两次 → 第二次被拒 (防 UI 重复点击)', async () => {
    const { store } = await newStore();
    const promise = store.ask({ question: '继续?', timeoutMs: 3000 });
    await new Promise((r) => setTimeout(r, 10));
    const [p] = await store.pending();
    expect((await store.answer(p.id, '是')).ok).toBe(true);
    const second = await store.answer(p.id, '否');
    expect(second.ok).toBe(false);
    expect(second.error).toContain('已经回答过');
    await promise;
  });

  it('answer 省略 id → 回答最早的待处理问题; 无待处理 → 报错', async () => {
    const { store } = await newStore();
    const none = await store.answer(null, '随便');
    expect(none.ok).toBe(false);
    const promise = store.ask({ question: 'Q1', timeoutMs: 3000 });
    await new Promise((r) => setTimeout(r, 10));
    const r = await store.answer(null, '答1');
    expect(r.ok).toBe(true);
    expect((await promise).answer).toBe('答1');
  });

  it('onQuestion 订阅收到新问题; 取消订阅后不再收', async () => {
    const { store } = await newStore();
    const seen: string[] = [];
    const unsub = store.onQuestion((q) => seen.push(q.question));
    expect(store.hasHumanChannel()).toBe(true);
    const p1 = store.ask({ question: 'Q-A', timeoutMs: 100 });
    await p1;
    expect(seen).toContain('Q-A');
    unsub();
    expect(store.hasHumanChannel()).toBe(false);
    const p2 = store.ask({ question: 'Q-B', timeoutMs: 40 });
    await p2;
    expect(seen).not.toContain('Q-B');
  });

  it('落盘后重新载入仍能看到待处理问题 (人类回来还能答)', async () => {
    const { store, file } = await newStore();
    const promise = store.ask({ question: '重启后还在吗?', timeoutMs: 5 });
    await promise;   // 超时 → 文件里应留下 expired 记录
    const reloaded = new UserQuestionStore(file);
    stores.push(reloaded);
    const hist = await reloaded.history(5);
    expect(hist.map((h) => h.question)).toContain('重启后还在吗?');
  });

  it('cancel 取消待处理问题 → promise 以 cancelled 落定', async () => {
    const { store } = await newStore();
    const promise = store.ask({ question: '取消测试', timeoutMs: 3000 });
    await new Promise((r) => setTimeout(r, 10));
    const [p] = await store.pending();
    expect(await store.cancel(p.id)).toBe(true);
    expect((await promise).status).toBe('cancelled');
  });

  it('normalizeAnswer: 多选序号 / 非序号原样 / 越界序号回原文', () => {
    const q = { choices: ['甲', '乙', '丙'], multiSelect: true } as any;
    expect(normalizeAnswer(q, '1,3')).toBe('甲, 丙');
    expect(normalizeAnswer(q, '随便说说')).toBe('随便说说');
    expect(normalizeAnswer(q, '9')).toBe('9');
    expect(normalizeAnswer({ choices: ['甲', '乙'] } as any, '2')).toBe('乙');
  });

  it('formatQuestion 渲染选项编号', () => {
    const text = formatQuestion({ question: '选?', choices: ['A', 'B'] } as any);
    expect(text).toContain('选?');
    expect(text).toContain('1. A');
    expect(text).toContain('2. B');
  });
});
