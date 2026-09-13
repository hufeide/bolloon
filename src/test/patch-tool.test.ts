/**
 * patch-tool.test.ts — 精确补丁 (patch) 纯函数单测
 *
 * 覆盖: 精确匹配、不唯一拒绝、找不到拒绝、replace_all、
 *       按行 + 空白容错 (缩进/行尾空格/空行差异)、删除语义、old==new 拒绝。
 */

import { describe, it, expect } from 'vitest';
import { applyTextPatch } from '../agents/patch-tool.js';

const ORIG = [
  'function a() {',
  '  return 1;',
  '}',
  '',
  'function b() {',
  '  return 1;',
  '}',
  '',
].join('\n');

describe('applyTextPatch', () => {
  it('精确匹配唯一 → 替换', () => {
    const r = applyTextPatch(ORIG, 'function a() {\n  return 1;\n}', 'function a() {\n  return 42;\n}');
    expect(r.ok).toBe(true);
    expect(r.strategy).toBe('exact');
    expect(r.replacements).toBe(1);
    expect(r.content).toContain('return 42;');
    expect(r.content).toContain('function b() {\n  return 1;');
  });

  it('多处匹配且未指定 replace_all → 拒绝 (不静默改错一处)', () => {
    const r = applyTextPatch(ORIG, '  return 1;', '  return 2;');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('出现 2 次');
    expect(r.content).toBeUndefined();
  });

  it('replace_all=true → 全部替换', () => {
    const r = applyTextPatch(ORIG, '  return 1;', '  return 2;', { replaceAll: true });
    expect(r.ok).toBe(true);
    expect(r.replacements).toBe(2);
    expect(r.content!.match(/return 2;/g)).toHaveLength(2);
  });

  it('找不到 → 拒绝并提示先 read_file (不靠猜)', () => {
    const r = applyTextPatch(ORIG, 'function zzz() {}', 'x');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('未找到');
  });

  it('缩进不同 → 走空白容错匹配', () => {
    const r = applyTextPatch(ORIG, 'function a() {\nreturn 1;\n}', 'function a() {\n  return 7;\n}');
    expect(r.ok).toBe(true);
    expect(r.strategy).toBe('line-normalized');
    expect(r.content).toContain('return 7;');
  });

  it('空行差异不影响容错匹配', () => {
    const withBlanks = 'function a() {\n\n  return 1;\n\n}';
    const r = applyTextPatch(ORIG, withBlanks, 'function a() {\n  return 9;\n}');
    expect(r.ok).toBe(true);
    expect(r.content).toContain('return 9;');
  });

  it('容错匹配命中多处且未 replace_all → 拒绝 (空白折叠后撞车)', () => {
    // 'return   1;' 原文里不存在 (多余空格) → 走容错; 折叠空白后两处函数体都命中 → 不唯一
    const r = applyTextPatch(ORIG, 'return   1;', 'return 2;');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/不唯一/);
  });

  it('容错匹配命中多处 + replace_all → 全部替换', () => {
    const r = applyTextPatch(ORIG, 'return   1;', 'return 2;', { replaceAll: true });
    expect(r.ok).toBe(true);
    expect(r.strategy).toBe('line-normalized');
    expect(r.content!.match(/return 2;/g)).toHaveLength(2);
  });

  it('new_string 为空字符串 → 删除该段', () => {
    const src = 'line1\nline2\nline3\n';
    const r = applyTextPatch(src, 'line2\n', '');
    expect(r.ok).toBe(true);
    expect(r.content).toBe('line1\nline3\n');
  });

  it('old_string 与 new_string 相同 → 拒绝', () => {
    const r = applyTextPatch(ORIG, 'abc', 'abc');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('无改动');
  });

  it('old_string 为空 → 拒绝', () => {
    const r = applyTextPatch(ORIG, '', 'x');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('old_string 必填');
  });

  it('统计行数变化 (+added/-removed)', () => {
    const r = applyTextPatch('a\nb\nc\n', 'a\nb', 'a\nB\nB2');
    expect(r.ok).toBe(true);
    expect(r.addedLines).toBe(3);
    expect(r.removedLines).toBe(2);
  });
});
