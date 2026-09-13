/**
 * verify-x402-info.ts — 微支付信息服务 端到端验证 (真跑 HTTP + 真签名, 不 mock)
 *
 * 流程: 发布 → 未付款收 402 → 付款 (本机联调凭据) → 拿到签名信封 → 验真 → 篡改检测,
 *       并同时验证 agent 工具层 (x402_info_publish / list / buy / verify)。
 *
 * 说明: 链上结算需要 funded 钱包 + facilitator (BOLLOON_X402_FACILITATOR),
 *   本脚本用 BOLLOON_X402_LOCAL_VERIFY=1 走"本机联调凭据" — 信封与验真报告都会
 *   明确标注 local-dev / 非链上, 不会冒充真实付款。
 *
 * 用法: npx tsx scripts/verify-x402-info.ts
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const results: Array<{ name: string; ok: boolean; note: string }> = [];
function record(name: string, ok: boolean, note = '') {
  results.push({ name, ok, note });
  console.log(`${ok ? '✅' : '❌'} ${name}${note ? ` — ${note}` : ''}`);
}

async function main() {
  // 临时 HOME: 身份 / 发布的信息都落在这里, 不碰真实 ~/.bolloon
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'bolloon-x402-verify-'));
  process.env.HOME = home;
  process.env.BOLLOON_X402_LOCAL_VERIFY = '1';
  delete process.env.BOLLOON_X402_FACILITATOR;

  // ① 造一个真身份 (DIAP Ed25519) 写进临时 HOME
  const { KeyManager } = await import('@diap/sdk');
  const kp = KeyManager.generate();
  const identityFile = path.join(home, '.bolloon', 'identity.json');
  await fs.mkdir(path.dirname(identityFile), { recursive: true });
  await KeyManager.saveToFile(kp, identityFile);
  record('① 生成并保存 DIAP 身份', !!(kp as any).did, String((kp as any).did).slice(0, 34) + '…');

  const express = (await import('express')).default;
  const { registerX402InfoRoutes } = await import('../src/web/routes-x402-info.js');
  const app = express();
  app.use(express.json());
  registerX402InfoRoutes(app);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;
  record('② 起服务 (x402 路由挂载)', !!port, base);

  const CONTENT = JSON.stringify({ city: '杭州', temp_c: 21.5, ts: '2026-09-13T11:00:00Z' });
  let itemId = '';

  try {
    // ③ 发布 (HTTP)
    const pub = await fetch(`${base}/api/x402/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '杭州实时气温数据',
        category: 'data',
        content: CONTENT,
        description: '每分钟更新的站台气温',
        price: { amount: '0.002', currency: 'USDC', network: 'base-sepolia', payTo: '0x1111111111111111111111111111111111111111' },
        source: { kind: 'measured', refs: ['https://example.com/hz-sensor-log.csv'], note: '来自自建气象站' },
      }),
    });
    const pubBody: any = await pub.json();
    itemId = pubBody?.item?.id || '';
    record('③ 发布付费信息 (HTTP POST)', pub.status === 200 && !!itemId, `id=${itemId} hash=${String(pubBody?.item?.contentHash).slice(0, 20)}…`);

    // ④ 未付款 → 402 (x402 规范)
    const unpaid = await fetch(`${base}/api/x402/info/${itemId}`);
    const unpaidBody: any = await unpaid.json();
    const acc = unpaidBody?.accepts?.[0];
    record('④ 未付款返回 402 + accepts', unpaid.status === 402 && !!acc && !!acc.amount,
      `status=${unpaid.status} scheme=${acc?.scheme} amount=${acc?.amount} payTo=${String(acc?.payTo).slice(0, 10)}… itemId=${acc?.extra?.itemId}`);

    // ⑤ 免费元数据可读 (发现/比价不需要付款)
    const meta = await fetch(`${base}/api/x402/info/${itemId}/meta`);
    const metaBody: any = await meta.json();
    const list = await fetch(`${base}/api/x402/info`);
    const listBody: any = await list.json();
    record('⑤ 元数据与列表免费可读', meta.status === 200 && listBody?.count === 1 && !String(JSON.stringify(metaBody)).includes('21.5'),
      `meta.title=${metaBody?.item?.title} · list.count=${listBody?.count} · 内容未泄露`);

    // ⑥ 付款 (本机联调) → 200 + 签名信封
    const localHeader = Buffer.from(JSON.stringify({
      x402Version: 2, accepted: acc, payload: { localDev: true }, payer: 'local-dev',
    }), 'utf-8').toString('base64');
    const paid = await fetch(`${base}/api/x402/info/${itemId}`, { headers: { 'X-PAYMENT': localHeader } });
    const env: any = await paid.json();
    const receipt = paid.headers.get('x-payment-response') || '';
    record('⑥ 付款后拿到签名信封', paid.status === 200 && !!env?.proof?.signature && env?.content === CONTENT,
      `内容一致 · 签名 ${String(env?.proof?.signature).slice(0, 12)}… · 回执头 ${receipt ? '有' : '缺'}`);

    // ⑦ 验真 (服务端接口)
    const v = await fetch(`${base}/api/x402/info/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ envelope: env, itemId }),
    });
    const vBody: any = await v.json();
    const checks: any[] = vBody?.report?.checks || [];
    record('⑦ 验真: 签名/哈希/支付绑定/DID/来源 全过',
      vBody?.ok === true && checks.every((c) => c.ok) && vBody?.report?.trust === 'self-attested',
      `${vBody?.summary}`);

    // ⑧ 篡改内容 → 必须验不过
    const tampered = JSON.parse(JSON.stringify(env));
    tampered.content = tampered.content.replace('21.5', '99.9');
    const v2 = await fetch(`${base}/api/x402/info/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ envelope: tampered, itemId }),
    });
    const v2Body: any = await v2.json();
    record('⑧ 篡改内容被识破 (unverified)', v2Body?.ok === false && v2Body?.report?.trust === 'unverified', String(v2Body?.summary));

    // ⑨ agent 工具层: 发布 / 列表 / 购买 / 验真
    const { registerPaidInfoTools } = await import('../src/agents/x402/paid-info-tools.js');
    const tools = new Map<string, any>();
    registerPaidInfoTools({
      tools, cwd: process.cwd(), identity: { did: (kp as any).did, name: 'verify-agent' },
    } as any);

    const pubTool = await tools.get('x402_info_publish').execute({
      title: '验证用技能包说明',
      category: 'skill',
      content: '# skill demo\nstep1\nstep2',
      price_amount: '0.001',
      pay_to: '0x2222222222222222222222222222222222222222',
      source_kind: 'self',
    });
    const listTool = await tools.get('x402_info_list').execute({});
    record('⑨a 工具: 发布 + 列表', pubTool.success === true && listTool.success === true && String(listTool.output).includes('验证用技能包说明'),
      String(pubTool.output).split('\n')[1] || '');

    const buyTool = await tools.get('x402_info_buy').execute({
      url: `${base}/api/x402/info/${itemId}`,
      max_payment: '0.01',
      item_id: itemId,
      allow_local_dev: 'true',
    });
    record('⑨b 工具: 走 402 付款买下 + 自动验真',
      buyTool.success === true && String(buyTool.output).includes('杭州') && String(buyTool.output).includes('验真'),
      String(buyTool.output).split('\n')[2] || '');

    const verifyTool = await tools.get('x402_info_verify').execute({ ref: JSON.stringify(env), item_id: itemId });
    record('⑨c 工具: 只验真 (不付款)', verifyTool.success === true && String(verifyTool.output).includes('self-attested'),
      String(verifyTool.output).split('\n')[0] || '');

    const verifyToolBad = await tools.get('x402_info_verify').execute({ ref: JSON.stringify(tampered) });
    record('⑨d 工具: 篡改信封被识破', verifyToolBad.success === true && String(verifyToolBad.output).includes('unverified'),
      String(verifyToolBad.output).split('\n')[0] || '');

    // ⑩ 钱包地址缺失时必须拒绝发布 (不静默用 0x0)
    const noPayTo = await tools.get('x402_info_publish').execute({ title: 'x', content: 'y' });
    record('⑩ 无收款地址时拒绝发布', noPayTo.success === false && String(noPayTo.error).includes('收款地址'), String(noPayTo.error).slice(0, 60));
  } catch (e: any) {
    record('异常', false, String(e?.message || e).slice(0, 200));
  } finally {
    server.close();
    await fs.rm(home, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n──────────────────────────────');
  console.log(`结果: ${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log(`失败: ${failed.map((f) => f.name).join(' | ')}`);
    process.exit(1);
  }
  process.exit(0);
}

void main();
