/**
 * verify-executable-skill-transaction.ts — Phase 2 验收: 买到的是**可执行资源**
 * (2026-09-18)
 *
 * 与 "买到一段内容" 的区别 (leo 的 Phase 2 must-verify 清单):
 *   ① 技能购买后确实进入技能目录/registry     ② 版本与 contentHash 与交易记录一致
 *   ③ 技能漂移后不能继续执行                 ④ 输入不符合 inputSchema 时不付款不执行
 *   ⑤ 输出不符合 outputSchema → 交易不能 verified   ⑥ 缺来源证据 → 只能 verification_failed
 *   ⑦ 执行失败不算资源可用                    ⑧ 资源买到但没改善 Goal → 不计入 Goal 成功证据
 *   ⑨ local-dev 买的技能可测试执行, 但不能产生最终 verified
 *
 * 真跑: 真 HTTP 服务端 + 真 402 报价 + 真 local-dev 付款 + **真执行技能代码** (夹具 run.mjs)。
 * 用法: npx tsx scripts/verify-executable-skill-transaction.ts
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

const REAL_HOME = os.homedir();          // ★ 必须在覆盖 HOME 之前取 (os.homedir() 会读 $HOME)
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-skill-tx-'));
const HOME = path.join(ROOT, 'home');
const BHOME = path.join(HOME, '.bolloon');
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.BOLLOON_X402_LOCAL_VERIFY = '1';
process.env.BOLLOON_SUPERVISOR = '0';
fs.mkdirSync(BHOME, { recursive: true });

const { makeSetupReady } = await import('./lib/make-setup-ready.js');
makeSetupReady(BHOME, { realHome: REAL_HOME, name: '技能交易验收' });

const { KeyManager } = await import('@diap/sdk') as any;      // 与 verify-minimal-payment-loop 同一口径
const ST: any = await import('../src/agents/x402/paid-info-store.js');
const TXS: any = await import('../src/agents/x402/transaction-store.js');
const TRADE: any = await import('../src/agents/x402/trade.js');
const POL: any = await import('../src/agents/economic-policy.js');
const SHARE: any = await import('../src/agents/skill-share.js');
const RC: any = await import('../src/agents/x402/resource-contract.js');
const SS: any = await import('../src/agents/x402/settlement-state.js');
const GS: any = await import('../src/agents/goal-store.js');
const BRIDGE: any = await import('../src/agents/x402/goal-run-bridge.js');

let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d?: unknown) => {
  if (ok) { passed++; console.log(`  ✅ ${n}`); }
  else { failed++; console.log(`  ❌ ${n}${d !== undefined ? ` — ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 240)}` : ''}`); }
};
const section = (t: string) => console.log(`\n${t}`);

const FIXTURE = path.resolve('scripts/fixtures/skills/cross-border-market-research');
const PAY_TO = '0x1111111111111111111111111111111111111111';
const NETWORK = 'base-sepolia';
const BUYER_DID = 'did:key:zBuyerSkillVerify';

// ── 卖方: 把技能打成**技能包**当资源卖 ─────────────────────────────────────
section('[0] 卖方把技能打包成资源 (买到的是技能包, 不是一段说明)');
const bundle = await SHARE.collectSkillBundle(FIXTURE);
check('技能打包成功 (含 SKILL.md + 可执行入口)', bundle.ok === true, bundle.error);
check('包里有 SKILL.md', !!bundle.bundle?.files?.['SKILL.md']);
check('包里有可执行入口 run.mjs', !!bundle.bundle?.files?.['run.mjs']);

const seller = KeyManager.generate();
const sellerDid = seller.did;
await KeyManager.saveToFile(seller, path.join(BHOME, 'identity.json'));
const pubHex = Buffer.from(seller.publicKey).toString('hex');

const item = await ST.publishInfo({
  title: '可执行资源: 跨境商品目标市场调研 v1.0.0', category: 'data',
  content: JSON.stringify(bundle.bundle),
  price: { amount: '0.001', currency: 'USDC', network: NETWORK, payTo: PAY_TO },
  source: { kind: 'skill', refs: ['fixture:cross-border-market-research'], note: '可执行技能资源' },
  provider: { did: sellerDid, name: '卖方 Agent (技能验收)' },
}, { home: HOME });
check('资源已发布 (itemId 可寻址)', !!item.id, item);

const resolveDid = async (did: string) => (did === sellerDid ? { publicKeyHex: pubHex } : null);

const { createWebServer } = await import('../src/web/server.js') as any;
const app = await createWebServer({ port: 0, headless: true } as any);
const server: any = app?.server || app;
const addr: any = await new Promise((r) => { if (server?.address?.()) r(server.address()); else server?.once?.('listening', () => r(server.address())); });
const BASE = `http://127.0.0.1:${addr?.port || 0}`;
const URL_ITEM = `${BASE}/api/x402/info/${item.id}`;
const policy: any = POL.getEconomicPolicy();
policy.updateConfig({ perTransactionLimit: 1, dailyLimit: 10, allowedRecipients: [PAY_TO], allowedServices: [], rateLimitPerMinute: 100 } as any);

// ── [1] 资源契约 ───────────────────────────────────────────────────────────
section('[1] 资源契约: 输入/输出/执行/验真 + 能力边界');
const loaded = await RC.loadResourceContract(FIXTURE);
check('契约可解析 (name/version/execution/verification)', loaded.ok === true, loaded.issues);
const contract = loaded.contract;
check('声明了执行入口 + 需要哪些工具', contract?.execution.entrypoint === 'run.mjs' && contract?.execution.requiredTools.includes('read_file'), contract?.execution);
check('声明了验真字段与证据字段', contract?.verification.requiredFields.includes('summary') && contract?.verification.evidenceFields.includes('sources'), contract?.verification);
check('能力边界写清 (guarantees + doesNotGuarantee)', (contract?.doesNotGuarantee || []).includes('market_profit'), contract?.doesNotGuarantee);
const greedy = RC.parseResourceContract({ resource: { ...contract, doesNotGuarantee: [] } });
check('不许把能力说满 (guarantees 无 doesNotGuarantee → 拒绝)', greedy.ok === false, greedy.issues);

// ── [2] 输入不合 schema → 不付款 ───────────────────────────────────────────
section('[2] 输入不合 inputSchema → 不执行、不付款');
const badInput = { product: 'x' };                       // minLength=2 不满足
const inChk = RC.validateResourceInput(contract, badInput);
check('输入校验能拦住', inChk.ok === false, inChk.issues);
const spentBefore = await TXS.spentSummary(HOME);
const violationExec = await RC.executeContractSkill({ contract, skillDir: FIXTURE, input: badInput, allowedTools: ['read_file'], allowCodeExecution: true });
check('执行器也拒绝执行 (不产生输出)', violationExec.execution.ok === false && violationExec.output === undefined, violationExec.execution.reason);
const spentAfter = await TXS.spentSummary(HOME);
check('没有因为坏输入花钱', spentAfter.count === spentBefore.count, { before: spentBefore.count, after: spentAfter.count });

// ── [3] 真买一笔 (local-dev) ───────────────────────────────────────────────
section('[3] 真购买 (local-dev): 交付 + 内容哈希 + 回执绑定');
const REQ = `skill-tx-${Date.now().toString(36)}`;
const bought = await TRADE.buyInfoAsTransaction({
  url: URL_ITEM, requestId: REQ, buyerDid: BUYER_DID, allowLocalDev: true, resolveDid,
  home: HOME, expectItemId: item.id, taskBudget: 1,
});
check('购买成功 (拿到技能包正文)', bought.ok === true && !!bought.envelope, { status: bought.status, error: bought.error });
const rec = bought.record;
check('交易记录: 内容哈希与交付哈希一致', !!rec?.contentHash && rec.contentHash === rec.deliveryHash, { c: rec?.contentHash, d: rec?.deliveryHash });
check('交易记录: 回执哈希已绑定', !!rec?.receiptHash);
check('local-dev 如实标 chainSettled=false + 结算事实 payment_submitted', rec?.chainSettled === false && rec?.settlementFact === 'payment_submitted', { cs: rec?.chainSettled, sf: rec?.settlementFact });
check('状态是 delivered (联调最高, 不是 verified)', rec?.status === 'delivered', rec?.status);

// ── [4] 落地为技能 + 快照绑定 ──────────────────────────────────────────────
section('[4] 买到的是技能包 → 落地技能目录 + 快照绑定交易');
const content = String(bought.envelope?.content || bought.envelope?.body || '');
const parsedBundle = SHARE.parseSkillBundle(content);
check('技能包可解析', parsedBundle.ok === true, parsedBundle.error);
const skillDir = path.join(HOME, '.bolloon', 'skills', parsedBundle.bundle?.name || 'skill');
fs.mkdirSync(skillDir, { recursive: true });
for (const [rel, body] of Object.entries(parsedBundle.bundle?.files || {})) {
  const target = path.resolve(skillDir, rel);
  if (!target.startsWith(path.resolve(skillDir) + path.sep)) continue;      // 路径穿越拒绝
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, String(body), 'utf8');
}
check('技能已进入技能目录 (SKILL.md + run.mjs)', fs.existsSync(path.join(skillDir, 'SKILL.md')) && fs.existsSync(path.join(skillDir, 'run.mjs')));
const installed = await RC.loadResourceContract(skillDir);
const snapshot = await RC.buildResourceSnapshot(skillDir, installed.contract, 'registry:fixture');
check('版本与交易记录一致', snapshot.version === installed.contract.version, { snap: snapshot.version, contract: installed.contract.version });
// 绑定要做**检查链**: ① 手里这份 content 重算协议哈希 == 交易记录 (就是这份内容)
//                     ② 解包落盘无损 (包内文件集哈希 == 目录哈希)
const fidelity = await RC.verifyInstallFidelity({ content, rec, installDir: skillDir });
check('内容保真: 重算协议哈希 == 交易记录 contentHash', fidelity.contentHashOk === true, fidelity.issues);
check('安装保真: 解包落盘无损 (包内哈希 == 目录哈希)', fidelity.installLossless === true, fidelity.issues);
const bound = RC.verifyResourceAgainstTransaction(rec, snapshot, { itemId: item.id, providerDid: sellerDid });
check('绑定校验通过 (itemId/providerDid + 快照存在)', bound.ok === true, bound.issues);
// 负例: 装完之后偷偷改一个文件 → 保真链必须断
const tamperFile = path.join(skillDir, 'run.mjs');
const original = fs.readFileSync(tamperFile, 'utf8');
fs.writeFileSync(tamperFile, original + '\n// 偷改\n', 'utf8');
const fidelityTampered = await RC.verifyInstallFidelity({ content, rec, installDir: skillDir });
check('偷改文件 → 保真链断 (装出来的不是买的)', fidelityTampered.ok === false, fidelityTampered.issues);
fs.writeFileSync(tamperFile, original, 'utf8');
check('还原后保真链恢复', (await RC.verifyInstallFidelity({ content, rec, installDir: skillDir })).ok === true);
const wrongProvider = RC.verifyResourceAgainstTransaction(rec, snapshot, { itemId: item.id, providerDid: 'did:key:zSomeoneElse' });
check('卖方不符 → 拒绝', wrongProvider.ok === false, wrongProvider.issues);

// ── [5] 漂移 → 不能执行 ────────────────────────────────────────────────────
section('[5] 技能漂移后不能继续执行');
check('漂移前: 一致', (await RC.checkResourceDrift(skillDir, snapshot)).ok === true);
fs.appendFileSync(path.join(skillDir, 'run.mjs'), '\n// 买后被改过\n');
const drift = await RC.checkResourceDrift(skillDir, snapshot);
check('买后内容被改 → 检出漂移', drift.ok === false, drift.issues);
fs.writeFileSync(path.join(skillDir, 'run.mjs'), parsedBundle.bundle.files['run.mjs'], 'utf8');   // 还原
check('还原后又能执行', (await RC.checkResourceDrift(skillDir, snapshot)).ok === true);

// ── [6]-[8] Harness 约束下真执行 ───────────────────────────────────────────
section('[6] Harness 约束: 工具未获准 / 未同意执行代码 → 拒绝');
const noTool = await RC.executeContractSkill({ contract: installed.contract, skillDir, input: { product: '便携榨汁杯' }, allowedTools: [], allowCodeExecution: true });
check('需要 read_file 但未获准 → 拒绝执行', noTool.execution.ok === false && String(noTool.execution.reason).includes('未获准'), noTool.execution.reason);
const noConsent = await RC.executeContractSkill({ contract: installed.contract, skillDir, input: { product: '便携榨汁杯' }, allowedTools: ['read_file'], allowCodeExecution: false });
check('未显式同意执行下载来的代码 → 拒绝执行', noConsent.execution.ok === false && String(noConsent.execution.reason).includes('未同意'), noConsent.execution.reason);

section('[7] 真执行: 输出合契约 + 来源证据齐全');
const exec = await RC.executeContractSkill({ contract: installed.contract, skillDir, input: { product: '便携榨汁杯', market: '越南', budgetUsd: 3000 }, allowedTools: ['read_file'], allowCodeExecution: true });
check('执行成功', exec.execution.ok === true, exec.execution.reason);
check('输出满足 outputSchema', exec.execution.schemaOk === true, exec.issues);
check('来源证据字段齐全', exec.execution.sourceDeclared === true);
check('执行证据带耗时与输出哈希 (可审计)', typeof exec.execution.durationMs === 'number' && !!exec.execution.outputHash, { ms: exec.execution.durationMs, hash: String(exec.execution.outputHash).slice(0, 12) });
check('输出内容可用 (有结论与条目)', String((exec.output as any)?.summary || '').length > 10 && ((exec.output as any)?.findings || []).length >= 3);

section('[8] 执行证据写进交易记录 (证据链闭合)');
const withExec = await TXS.updateTransaction(rec.transactionId, {
  execution: exec.execution,
  event: { kind: 'resource_executed', detail: `ok=${exec.execution.ok} schemaOk=${exec.execution.schemaOk} durationMs=${exec.execution.durationMs}` },
} as any, HOME);
check('交易记录里能看到执行证据', !!withExec?.execution && withExec.execution.ok === true, withExec?.execution);

// ── [9]-[10] 输出不合契约 / 缺证据 → verification_failed ───────────────────
section('[9] 输出不合契约 / 缺来源证据 → 交易只能 verification_failed');
const strictContract = RC.parseResourceContract({
  resource: { ...installed.contract, outputSchema: { type: 'object', required: ['market_share_pct'] }, verification: { requiredFields: ['market_share_pct'], evidenceFields: ['official_stats'] } },
}).contract;
fs.writeFileSync(path.join(skillDir, 'bad.mjs'), 'export async function execute(){ return { summary: "只有一句话, 没有统计字段", sources: [] }; }', 'utf8');
const strictExec = await RC.executeContractSkill({ contract: { ...strictContract, execution: { ...strictContract.execution, entrypoint: 'bad.mjs' } }, skillDir, input: { product: '便携榨汁杯' }, allowedTools: ['read_file'], allowCodeExecution: true });
check('输出缺必填字段 → schemaOk=false', strictExec.execution.schemaOk === false, strictExec.execution.reason);
check('缺证据字段 → sourceDeclared=false', strictExec.execution.sourceDeclared === false);
const failedTx = await TXS.updateTransaction(rec.transactionId, { execution: strictExec.execution } as any, HOME);
const gateOnBadOutput = SS.evaluateVerifiedGate({ rec: failedTx, home: HOME, execution: strictExec.execution, goalCriteriaMet: true });
check('不合契约的输出 → 交易不能 verified', gateOnBadOutput.verified === false && gateOnBadOutput.missing.some((m: string) => m.includes('outputSchema') || m.includes('执行失败')), gateOnBadOutput.missing);
const vf = await TXS.setTransactionStatus(rec.transactionId, 'verification_failed', '资源输出不满足契约', HOME);
check('交易如实记 verification_failed (不是 failed)', vf?.status === 'verification_failed', vf?.status);
fs.rmSync(path.join(skillDir, 'bad.mjs'), { force: true });

// ── [11] 执行失败 ≠ 资源可用 ───────────────────────────────────────────────
section('[10] 执行失败/超时 → 不算资源可用');
fs.writeFileSync(path.join(skillDir, 'boom.mjs'), 'export async function execute(){ throw new Error("依赖缺失: 数据源不可用"); }', 'utf8');
const boomExec = await RC.executeContractSkill({ contract: { ...installed.contract, execution: { ...installed.contract.execution, entrypoint: 'boom.mjs' } }, skillDir, input: { product: '便携榨汁杯' }, allowedTools: ['read_file'], allowCodeExecution: true });
check('执行失败如实报错 (不返回假成功)', boomExec.execution.ok === false && String(boomExec.execution.reason).includes('依赖缺失'), boomExec.execution.reason);
const boomGate = SS.evaluateVerifiedGate({ rec: { ...failedTx, execution: boomExec.execution }, home: HOME, execution: boomExec.execution, goalCriteriaMet: true });
check('执行失败的资源 → 交易不能 verified', boomGate.verified === false, boomGate.missing);
fs.rmSync(path.join(skillDir, 'boom.mjs'), { force: true });

// ── [12] local-dev 的边界 + 八项门 ─────────────────────────────────────────
section('[11] local-dev: 能测试执行, 但不能产生最终 verified');
const legalTx = await TXS.readTransaction(rec.transactionId, HOME);
const localGate = SS.evaluateVerifiedGate({ rec: { ...legalTx, status: 'delivered', execution: exec.execution }, home: HOME, execution: exec.execution, goalCriteriaMet: true });
check('local-dev + 执行成功 + 命中判据 → 仍不能 verified (链上没结算)', localGate.verified === false && localGate.missing.some((m: string) => m.includes('chainSettled')), localGate.missing);

// 合成一条**链上结算**记录 (只为验证八项门的组合逻辑; 明确不是真链上支付)
const synth: any = {
  ...legalTx, transactionId: 'tx-synth-chain', status: 'verified',
  chainSettled: true, txHash: '0xsynth', protocolVerified: true, settlementFact: 'fully_settled',
  contentHash: legalTx.contentHash, deliveryHash: legalTx.deliveryHash, receiptHash: legalTx.receiptHash,
};
SS.writeDeliveryContent('tx-synth-chain', content, HOME);
const synthBytesHash = SS.verifyDelivery({ ...synth, deliveryBytesHash: undefined }, HOME).bytesHash;
const synthFull = { ...synth, deliveryBytesHash: synthBytesHash, execution: exec.execution };
const synthVerified = { ...synthFull };
const fullGate = SS.evaluateVerifiedGate({ rec: synthVerified, home: HOME, execution: exec.execution, goalCriteriaMet: true });
check('八项全满足 (合成链上记录) → verified 门通过', fullGate.verified === true, fullGate.missing);
const synthNoExec = { ...synthVerified, execution: undefined } as any;
const noExecGate = SS.evaluateVerifiedGate({ rec: synthNoExec, home: HOME, execution: undefined, goalCriteriaMet: true });
check('同一记录缺执行证据 → 不通过 (可执行资源必须真跑过)', noExecGate.verified === false && noExecGate.missing.some((m: string) => m.includes('执行证据')), noExecGate.missing);

// ── [13] Goal 联动 ─────────────────────────────────────────────────────────
section('[12] 资源买到但没有改善 Goal → 不计入 Goal 成功证据');
const goal = await GS.createGoal({
  title: '把便携榨汁杯卖进越南市场', channelId: 'verify', requiredSkills: [],
  criteria: ['拿到可执行的目标市场调研报告并验证来源'],
  criteriaSource: 'user', criteriaConfirmed: true,
} as any);
const goalId = goal.goalId || goal.id;
const before = await GS.readGoal(goalId);
const bridgeBad = await BRIDGE.bridgeTransactionToRunGoal(synthVerified, { goalId, executionOk: true, goalCriteriaHit: false, summary: '跨境市场调研' });
const afterBad = await GS.readGoal(goalId);
const evBad = (afterBad?.evidence || []).join(' ');
check('未命中判据 → 无 Goal 成功证据', bridgeBad.goalEvidenceWritten === false && !evBad.includes('已执行并命中判据'), evBad.slice(0, 120));
check('但仍留下"资源已验证"的审计痕迹 (不静默)', evBad.includes('已验证') || evBad.includes('未成立'), evBad.slice(0, 160));

const bridgeGood = await BRIDGE.bridgeTransactionToRunGoal(synthVerified, { goalId, executionOk: true, goalCriteriaHit: true, summary: '跨境市场调研' });
const afterGood = await GS.readGoal(goalId);
check('命中判据 + 执行成功 + 链上结算 → 计入成功证据', bridgeGood.goalEvidenceWritten === true && (afterGood?.evidence || []).join(' ').includes('已执行并命中判据'), (afterGood?.evidence || []).length);

const bridgeNoExec = await BRIDGE.bridgeTransactionToRunGoal(synthVerified, { goalId, executionOk: false, goalCriteriaHit: true, summary: '跨境市场调研' });
check('执行没成功 → 即使命中判据也不计入 (买到 ≠ 用上)', bridgeNoExec.goalEvidenceWritten === false);

const goalNow = await GS.readGoal(goalId);
check('Goal 判据与证据可读回 (审计闭合)', !!goalNow && (goalNow.evidence || []).length >= 2, (goalNow?.evidence || []).length);

// ── 收尾 ───────────────────────────────────────────────────────────────────
const finalSpent = await TXS.spentSummary(HOME);
console.log(`\n=== 结果: ${passed} passed, ${failed} failed ===`);
console.log(`隔离 HOME: ${HOME}`);
console.log(`本次交易: ${rec.transactionId} · 状态 ${(await TXS.readTransaction(rec.transactionId, HOME))?.status} · 结算事实 ${(await TXS.readTransaction(rec.transactionId, HOME))?.settlementFact}`);
console.log(`钱: 本机联调 ${finalSpent.count} 笔 (chainSettled=false → 从未真上链)`);
console.log(`结论: 买到的可执行资源 · 0 次不合法输入产生执行 · 0 次不合契约输出通过 verified · 0 次缺证据计成功 · 0 次 local-dev 冒充链上`);
try { server?.close?.(); } catch { /* ignore */ }
process.exit(failed === 0 ? 0 : 1);
