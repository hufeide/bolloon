/**
 * resource-contract.test.ts — 可执行资源契约 (Phase 2) 单测
 *
 * 覆盖: 契约解析 (含"不许把能力说满") · 受限 JSON Schema 校验 · 输入/输出校验 ·
 *      执行 (成功/输入不合/工具未获准/未同意执行/入口越界/入口缺失/超时/输出不合契约) · 绑定与漂移。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseResourceContract, validateJsonSchema, validateResourceInput, validateResourceOutput,
  executeContractSkill, loadResourceContract, parseFrontmatter, buildResourceSnapshot,
  verifyResourceAgainstTransaction, checkResourceDrift, hashBundleFiles,
} from '../agents/x402/resource-contract.js';

const FIXTURE = path.resolve('scripts/fixtures/skills/cross-border-market-research');

const goodFm = {
  resource: {
    name: 'demo', version: '1.0.0',
    inputSchema: { type: 'object', required: ['product'], properties: { product: { type: 'string', minLength: 2 }, n: { type: 'number', minimum: 0 } } },
    outputSchema: { type: 'object', required: ['summary'], properties: { summary: { type: 'string', minLength: 5 } } },
    execution: { entrypoint: 'run.mjs', requiredTools: ['read_file'], maxDurationMs: 5000 },
    verification: { requiredFields: ['summary'], evidenceFields: ['sources'] },
    guarantees: ['schema_valid'], doesNotGuarantee: ['market_profit'],
  },
};

describe('Phase 2 · 契约解析', () => {
  it('解析出完整契约', () => {
    const r = parseResourceContract(goodFm);
    expect(r.ok).toBe(true);
    expect(r.contract?.execution.entrypoint).toBe('run.mjs');
    expect(r.contract?.execution.kind).toBe('js-module');
    expect(r.contract?.verification.evidenceFields).toEqual(['sources']);
    expect(r.contract?.doesNotGuarantee).toContain('market_profit');
  });

  it('没有契约字段 → 不是可执行资源 (普通技能不受影响)', () => {
    const r = parseResourceContract({ name: 'x', description: '普通技能' });
    expect(r.ok).toBe(false);
    expect(String(r.issues[0])).toContain('没有资源契约字段');
  });

  it('声明了 guarantees 却不说 doesNotGuarantee → 拒绝 (不许把能力说满)', () => {
    const r = parseResourceContract({ resource: { ...goodFm.resource, doesNotGuarantee: [] } });
    expect(r.ok).toBe(false);
    expect(String(r.issues.join(' '))).toContain('doesNotGuarantee');
  });

  it('缺 name/version 或字段类型错 → 拒绝', () => {
    expect(parseResourceContract({ resource: { ...goodFm.resource, name: '' } }).ok).toBe(false);
    expect(parseResourceContract({ resource: { ...goodFm.resource, maxDurationMs: -1, execution: { maxDurationMs: -1 } } }).ok).toBe(false);
    expect(parseResourceContract({ resource: { ...goodFm.resource, guarantees: 'schema_valid' } }).ok).toBe(false);
  });

  it('真读夹具技能的 SKILL.md (含可执行入口)', async () => {
    const loaded = await loadResourceContract(FIXTURE);
    expect(loaded.ok).toBe(true);
    expect(loaded.contract?.name).toBe('cross-border-market-research');
    expect(loaded.contract?.execution.requiredTools).toEqual(['read_file']);
    expect(loaded.contract?.verification.evidenceFields).toEqual(['sources']);
  });

  it('frontmatter 解析: 标量/数组/一层嵌套/内联 JSON 都能读', () => {
    const fm = parseFrontmatter(['---', 'name: a', 'version: "1.0.0"', 'tags: [x, y]', 'execution: {"entrypoint":"r.mjs"}', '---', 'body'].join('\n'));
    expect(fm.data.name).toBe('a');
    expect(fm.data.version).toBe('1.0.0');
    expect(fm.data.tags).toEqual(['x', 'y']);
    expect((fm.data.execution as any).entrypoint).toBe('r.mjs');
    expect(fm.body).toBe('body');
  });
});

describe('Phase 2 · 受限 JSON Schema 校验', () => {
  it('类型/必填/enum/范围/长度/pattern/数组项', () => {
    expect(validateJsonSchema({ type: 'string' }, 1)).toHaveLength(1);
    expect(validateJsonSchema({ type: 'integer' }, 1.5)[0]).toContain('integer');
    expect(validateJsonSchema({ type: 'object', required: ['a'] }, {})[0]).toContain('a 缺失');
    expect(validateJsonSchema({ enum: ['x'] }, 'y')[0]).toContain('enum');
    expect(validateJsonSchema({ type: 'number', minimum: 5 }, 1)[0]).toContain('小于最小值');
    expect(validateJsonSchema({ type: 'string', minLength: 5 }, 'ab')[0]).toContain('长度小于');
    expect(validateJsonSchema({ type: 'string', pattern: '^a' }, 'b')[0]).toContain('pattern');
    expect(validateJsonSchema({ type: 'array', items: { type: 'number' } }, ['a'])[0]).toContain('[0]');
    expect(validateJsonSchema({ type: 'object' }, { ok: true })).toHaveLength(0);
  });

  it('输入/输出校验各司其职', () => {
    const c = parseResourceContract(goodFm).contract!;
    expect(validateResourceInput(c, { product: 'x' }).ok).toBe(false);            // minLength
    expect(validateResourceInput(c, { product: '手机支架' }).ok).toBe(true);
    const out = validateResourceOutput(c, { summary: '短' });
    expect(out.ok).toBe(false);
    expect(out.missingEvidence).toEqual(['sources']);                             // 缺证据字段
    expect(validateResourceOutput(c, { summary: '足够长的结论', sources: ['a'] }).ok).toBe(true);
  });
});

describe('Phase 2 · 执行 (Harness 约束)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-res-'));
  const writeSkill = (entry: string, body: string) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, entry), body, 'utf8');
  };

  it('真跑夹具资源: 输出合契约 + 来源证据齐全', async () => {
    const { contract } = await loadResourceContract(FIXTURE);
    const res = await executeContractSkill({ contract: contract!, skillDir: FIXTURE, input: { product: '便携榨汁杯', market: '越南', budgetUsd: 3000 }, allowedTools: ['read_file'], allowCodeExecution: true });
    expect(res.issues).toEqual([]);
    expect(res.execution.ok).toBe(true);
    expect(res.execution.schemaOk).toBe(true);
    expect(res.execution.sourceDeclared).toBe(true);
    expect((res.output as any).findings.length).toBeGreaterThanOrEqual(3);
    expect((res.output as any).sources.length).toBeGreaterThanOrEqual(3);
  });

  it('输入不合 inputSchema → 不执行 (不产生输出)', async () => {
    const { contract } = await loadResourceContract(FIXTURE);
    const res = await executeContractSkill({ contract: contract!, skillDir: FIXTURE, input: { product: 'x' }, allowedTools: ['read_file'], allowCodeExecution: true });
    expect(res.execution.ok).toBe(false);
    expect(res.output).toBeUndefined();
    expect(String(res.execution.reason)).toContain('inputSchema');
  });

  it('工具未获准 / 未同意执行代码 / 入口缺失或越界 → 拒绝执行 (不静默降级)', async () => {
    const contract = parseResourceContract(goodFm).contract!;
    const noTool = await executeContractSkill({ contract, skillDir: dir, input: { product: 'ab' }, allowedTools: [], allowCodeExecution: true });
    expect(String(noTool.execution.reason)).toContain('未获准的工具');
    const noConsent = await executeContractSkill({ contract, skillDir: dir, input: { product: 'ab' }, allowedTools: ['read_file'], allowCodeExecution: false });
    expect(String(noConsent.execution.reason)).toContain('未同意');
    const missing = await executeContractSkill({ contract, skillDir: dir, input: { product: 'ab' }, allowedTools: ['read_file'], allowCodeExecution: true });
    expect(String(missing.execution.reason)).toContain('不存在');
    const escaped = parseResourceContract({ resource: { ...goodFm.resource, execution: { entrypoint: '../../evil.mjs' } } }).contract!;
    const esc = await executeContractSkill({ contract: escaped, skillDir: dir, input: { product: 'ab' }, allowedTools: ['read_file'], allowCodeExecution: true });
    expect(String(esc.execution.reason)).toContain('越出技能目录');
  });

  it('执行抛错 / 超时 → 不算资源可用', async () => {
    writeSkill('throw.mjs', 'export async function execute(){ throw new Error("boom"); }');
    const throwC = parseResourceContract({ resource: { ...goodFm.resource, execution: { entrypoint: 'throw.mjs', requiredTools: ['read_file'], maxDurationMs: 3000 } } }).contract!;
    const r1 = await executeContractSkill({ contract: throwC, skillDir: dir, input: { product: 'ab' }, allowedTools: ['read_file'], allowCodeExecution: true });
    expect(r1.execution.ok).toBe(false);
    expect(String(r1.execution.reason)).toContain('boom');

    writeSkill('slow.mjs', 'export async function execute(){ await new Promise(r => setTimeout(r, 2000)); return { summary: "够长的结论", sources: ["a"] }; }');
    const slowC = parseResourceContract({ resource: { ...goodFm.resource, execution: { entrypoint: 'slow.mjs', requiredTools: ['read_file'], maxDurationMs: 300 } } }).contract!;
    const r2 = await executeContractSkill({ contract: slowC, skillDir: dir, input: { product: 'ab' }, allowedTools: ['read_file'], allowCodeExecution: true });
    expect(r2.execution.ok).toBe(false);
    expect(String(r2.execution.reason)).toContain('超时');
  });

  it('输出不合契约 / 缺证据 → ok=false 且说明缺什么', async () => {
    const { contract } = await loadResourceContract(FIXTURE);
    const bad = await executeContractSkill({
      contract: contract!, skillDir: FIXTURE, input: { product: '便携榨汁杯' }, allowedTools: ['read_file'], allowCodeExecution: true,
      maxDurationMs: 5000,
    });
    expect(bad.execution.ok).toBe(true);      // 正常路径先确认没问题
    // 用一个只声明"必须有 findings 且要有 sources"的契约去打同一个输出
    const strict = parseResourceContract({ resource: { ...goodFm.resource, outputSchema: { type: 'object', required: ['nope_field'] }, verification: { requiredFields: ['nope_field'], evidenceFields: ['nope_evidence'] } } }).contract!;
    const res = await executeContractSkill({ contract: strict, skillDir: FIXTURE, input: { product: '便携榨汁杯' }, allowedTools: ['read_file'], allowCodeExecution: true });
    expect(res.execution.ok).toBe(false);
    expect(res.execution.schemaOk).toBe(false);
    expect(res.execution.sourceDeclared).toBe(false);
  });
});

describe('Phase 2 · 绑定与漂移', () => {
  it('快照绑定交易 (itemId/providerDid/contentHash)', async () => {
    const { contract } = await loadResourceContract(FIXTURE);
    const snap = await buildResourceSnapshot(FIXTURE, contract!, 'registry:fixture');
    expect(snap.contentHash).toHaveLength(32);        // 项目技能内容哈希口径 (hashSkillDir: sha256 前 32 hex)
    expect(snap.version).toBe('1.0.0');
    const ok = verifyResourceAgainstTransaction({ itemId: 'item-1', contentHash: snap.contentHash, providerDid: 'did:key:zS' }, snap, { itemId: 'item-1', providerDid: 'did:key:zS' });
    expect(ok.ok).toBe(true);
    // 版本不符 → 拒绝 (内容绑定由 verifyInstallFidelity 负责, 这里不混口径)
    const badVersion = verifyResourceAgainstTransaction({ itemId: 'item-1', contentHash: 'deadbeef' }, snap, { itemId: 'item-1', version: '9.9.9' });
    expect(badVersion.ok).toBe(false);
    expect(String(badVersion.issues[0])).toContain('版本');
    // 打包哈希与目录哈希必须同口径 (遍历顺序一致)
    expect(hashBundleFiles({ 'run.mjs': 'b', 'SKILL.md': 'a' })).toBe(hashBundleFiles({ 'SKILL.md': 'a', 'run.mjs': 'b' }));
  });

  it('内容漂移 → 不能继续执行', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-drift-'));
    fs.cpSync(FIXTURE, tmp, { recursive: true });
    const { contract } = await loadResourceContract(tmp);
    const snap = await buildResourceSnapshot(tmp, contract!);
    expect((await checkResourceDrift(tmp, snap)).ok).toBe(true);
    fs.appendFileSync(path.join(tmp, 'run.mjs'), '\n// 被改过\n');
    const drift = await checkResourceDrift(tmp, snap);
    expect(drift.ok).toBe(false);
    expect(String(drift.issues[0])).toContain('漂移');
  });
});
