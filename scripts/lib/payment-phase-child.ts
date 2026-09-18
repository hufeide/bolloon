/**
 * payment-phase-child.ts — Phase 3 验收的"被杀子进程" (2026-09-18)
 *
 * 用法: npx tsx scripts/lib/payment-phase-child.ts <phase> <home> <requestId> [txHash]
 *   before_payment      ① 付款前 (只有 discovered → quoted)
 *   after_claim         ② 拿到付款权后 (paying, 无任何支付凭据)
 *   after_settle        ③ facilitator settle 后 (有 txHash + 已结算, 还没交付)
 *   mid_delivery        ④ 支付成功、交付进行中 (正文已落盘, 状态还没到 delivered)
 *   after_delivery      ⑤ 交付后、验真前 (delivered + 哈希齐全)
 *   unknown_with_receipt 附加: 有回执但查不到 txHash → 结算事实 unknown
 *
 * 打完标记就挂住, 等父进程 SIGKILL (真杀, 不是模拟异常)。
 */
const phase = process.argv[2];
const home = process.argv[3];
const requestId = process.argv[4];
const txHash = process.argv[5] || '';

(async () => {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const TXS: any = await import('../../src/agents/x402/transaction-store.js');
  const SS: any = await import('../../src/agents/x402/settlement-state.js');

  const { record } = await TXS.beginTransaction({ requestId, metadata: { itemId: 'skill-res-item' }, buyerDid: 'did:key:zChild', providerDid: 'did:key:zSeller' }, home);
  const id = record.transactionId;
  // 有 txHash 的场景 = facilitator 真结算路径; 没有 = 本机联调 (两条路的结算事实上限不同)
  const mode = txHash ? 'facilitator' : 'local-dev';
  await TXS.updateTransaction(id, { status: 'quoted', paymentMode: mode, contentHash: 'sha256:content', amount: '1000', currency: 'USDC', network: 'base-sepolia' }, home);

  if (phase !== 'before_payment') {
    await TXS.updateTransaction(id, { status: 'paying', event: { kind: 'paying', detail: '已取得付款权' } }, home);
    await TXS.claimPayment(requestId, id, home);
  }
  if (phase === 'after_settle' || phase === 'mid_delivery' || phase === 'after_delivery') {
    await TXS.updateTransaction(id, { settlementFact: 'payment_submitted', paymentReceipt: 'rcpt-1', ...(txHash ? { txHash } : {}) } as any, home);
    if (txHash) await TXS.updateTransaction(id, { chainSettled: true, settlementFact: 'payment_verified' } as any, home);
  }
  if (phase === 'unknown_with_receipt') {
    // 有回执 (说明发出去了) 但没有 txHash → 结算事实 unknown (不假装知道)
    await TXS.updateTransaction(id, { settlementFact: 'unknown', paymentReceipt: 'rcpt-unknown' } as any, home);
  }
  if (phase === 'mid_delivery' || phase === 'after_delivery') {
    const w = SS.writeDeliveryContent(id, '跨境市场调研正文 (交付夹具)', home);
    await TXS.updateTransaction(id, { deliveryHash: 'sha256:content', deliveryBytesHash: w.hash } as any, home);
  }
  if (phase === 'after_delivery') {
    await TXS.updateTransaction(id, { status: 'delivered' }, home);
  }

  console.log(`PHASE_READY ${phase} ${id}`);
  await new Promise(() => {});        // 挂住等被杀
})();
