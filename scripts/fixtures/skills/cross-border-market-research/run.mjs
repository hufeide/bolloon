/**
 * 跨境商品目标市场调研 — 可执行入口 (夹具: 确定性、不联网、不写盘)
 * 导出 execute(params, ctx) → 结构化报告 (含来源证据)
 */
export async function execute(params, ctx) {
  const product = String(params?.product || '').trim();
  const market = String(params?.market || '东南亚').trim();
  const budget = params?.budgetUsd;
  if (!product) throw new Error('product 不能为空');

  const findings = [
    { claim: `${product} 在 ${market} 的需求主要由价格敏感人群驱动`, source: 'fixture:demand-model/v1' },
    { claim: `${market} 的合规门槛集中在标签与进口许可`, source: 'fixture:compliance-checklist/v1' },
    { claim: `建议先做小批量试单验证复购, 而不是一次性压货`, source: 'fixture:pilot-playbook/v1' },
  ];
  if (typeof budget === 'number') {
    findings.push({ claim: `按 ${budget} USD 预算, 首轮建议只覆盖 1 个城市 + 2 个渠道`, source: 'fixture:budget-heuristic/v1' });
  }

  const report = {
    product,
    market,
    summary: `${product} 进入 ${market} 的首轮调研结论: 需求成立但价格敏感, 合规与渠道是主要风险点, 建议小批量试单验证。`,
    findings,
    sources: findings.map((f) => f.source),
    generatedAt: new Date().toISOString(),
    generator: 'cross-border-market-research@1.0.0',
  };
  if (ctx?.tool) ctx.tool('read_file', { claim: 'fixture' });   // 声明式使用: 只记工具使用, 不真读外部文件
  return report;
}

/** 故意留一个坏输出入口, 供验收脚本验证"输出不合契约 → 不能 verified" */
export async function executeBad(params) {
  return { summary: '太短', findings: [] };
}

export default { execute, executeBad };
