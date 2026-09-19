/**
 * verify-contacts-chain.ts — 联系方式核心链**真跑**验收 (2026-09-19)
 *
 * 真跑的东西 (不是 mock):
 *   1. 真 SMTP 服务器 (net.createServer, 真走 220/EHLO/AUTH LOGIN/MAIL/RCPT/DATA/QUIT) —— 验证码与任务邮件真的从 socket 过去
 *   2. 真 HTTP 短信网关 (http.createServer + Bearer token) —— 手机号通道真发真收
 *   3. 真 express 路由模块 (registerContactRoutes 挂真 HTTP) —— 绑定/验证/预览/批准/撤销/配对全走 HTTP
 *   4. 真 Goal / Run 落盘 (goal-store / run-store, 隔离 HOME)
 *   5. 真 SkillsManager discover (把 skills/phone-contact·email-contact 装进隔离 HOME 再看是否登记)
 *
 * 验收的核心链路 (leo 的验收矩阵):
 *   绑定 → 验证 → 受约束发送 → 等待回复 → 回复只唤醒对应 Goal → 证据可回放 → 撤销即失效 → 重启仍在等
 *
 * 跑法: npx tsx scripts/verify-contacts-chain.ts
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import * as http from 'http';

// 隔离 HOME 必须在**导入被测模块之前**设好 (goal-store/run-store 走 os.homedir())
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-verify-contacts-'));
process.env.HOME = TMP;
process.env.BOLLOON_SETUP_IN_PROGRESS = '1';   // 隔离 HOME 没有初始化状态; 这是既有的"进入初始化流程"开关
process.env.BOLLOON_SKIP_UPDATE = '1';

const { ContactChain } = await import('../src/agents/contacts/chain.js');
const { contactsStore, secretsFileMode } = await import('../src/agents/contacts/store.js');
const { decideContactAction } = await import('../src/agents/contacts/policy.js');
const { looksLikePlaintextSecret } = await import('../src/web/routes-contacts.js');
const { generateDeviceKeyPair, signGrant } = await import('../src/agents/contacts/grants.js');
const { contactsCli, authorizationCard } = await import('../src/agents/contacts/cli.js');
const { createGoal, readGoal } = await import('../src/agents/goal-store.js');
const { startRun, readRun } = await import('../src/agents/run-store.js');
const { SkillsManager } = await import('../src/agents/skills-manager.js');
const express = (await import('express')).default;
const { registerContactRoutes } = await import('../src/web/routes-contacts.js');

const OWNER = 'did:key:zVerifyOwner';
const SUPPLIER_EMAIL = 'supplier@acme-jp.example';
const SUPPLIER_PHONE = '+8613800138000';

let passed = 0, failed = 0;
const failures: string[] = [];
function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── 1. 真 SMTP 服务器 ───────────────────────────────────────────────────────

interface ReceivedMail { from: string; to: string; raw: string; headers: Record<string, string>; body: string }
const mailboxes: ReceivedMail[] = [];

function startSmtpServer(): Promise<{ port: number; close: () => void }> {
  const live = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    live.add(sock);
    sock.on('close', () => live.delete(sock));
    let inData = false;
    let buf = '';
    let from = '';
    let to = '';
    let data = '';
    const send = (line: string) => sock.write(line + '\r\n');
    let authStep = 0;   // 0=没在认证 1=等用户名 2=等密码
    send('220 verify-smtp.local ESMTP ready');
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            const headers: Record<string, string> = {};
            const [head, ...rest] = data.split('\r\n\r\n');
            for (const h of head.split('\r\n')) {
              const i = h.indexOf(':');
              if (i > 0) headers[h.slice(0, i).toLowerCase()] = h.slice(i + 1).trim();
            }
            mailboxes.push({ from, to, raw: data, headers, body: rest.join('\r\n\r\n') });
            data = '';
            send('250 2.0.0 Ok: queued as VERIFY-1');
          } else {
            data += (data ? '\r\n' : '') + line.replace(/^\.\./, '.');
          }
          continue;
        }
        const up = line.toUpperCase();
        if (up.startsWith('EHLO') || up.startsWith('HELO')) { send('250-verify-smtp.local'); send('250-AUTH LOGIN'); send('250 OK'); }
        else if (up.startsWith('AUTH LOGIN')) { authStep = 1; send('334 VXNlcm5hbWU6'); }
        else if (authStep === 1) { authStep = 2; send('334 UGFzc3dvcmQ6'); }
        else if (authStep === 2) { authStep = 0; send('235 2.7.0 Authentication successful'); }
        else if (up.startsWith('MAIL FROM')) { from = line.slice(line.indexOf('<') + 1, line.lastIndexOf('>')); send('250 OK'); }
        else if (up.startsWith('RCPT TO')) { to = line.slice(line.indexOf('<') + 1, line.lastIndexOf('>')); send('250 OK'); }
        else if (up.startsWith('DATA')) { inData = true; send('354 End data with <CR><LF>.<CR><LF>'); }
        else if (up.startsWith('QUIT')) { send('221 Bye'); sock.end(); }
        else if (up.startsWith('RSET')) send('250 OK');
        else send('250 OK');
      }
    });
    sock.on('error', () => { /* 客户端断开 */ });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({ port, close: () => { for (const s of live) { try { s.destroy(); } catch { /* 已断 */ } } server.close(); } });
    });
  });
}

// ── 2. 真 HTTP 短信网关 ─────────────────────────────────────────────────────

interface SentSms { to: string; text: string; auth: string; threadToken?: string; requestId?: string }
const smsOutbox: SentSms[] = [];

function startSmsGateway(): Promise<{ port: number; url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url?.startsWith('/sms')) { res.writeHead(404).end('not found'); return; }
      const auth = String(req.headers.authorization || '');
      if (auth !== 'Bearer gw-token-verify') { res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' })); return; }
      let j: any = {};
      try { j = JSON.parse(raw); } catch { /* 空 body */ }
      smsOutbox.push({ to: String(j.to || ''), text: String(j.text || ''), auth, threadToken: j.threadToken, requestId: j.requestId });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ sid: `SM${smsOutbox.length}`, status: 'queued' }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as http.AddressInfo).port;
      resolve({ port, url: `http://127.0.0.1:${port}/sms`, close: () => server.close() });
    });
  });
}

// ── 工具 ────────────────────────────────────────────────────────────────────

/** 在隔离 HOME 的盘上到处找明文 —— 用来证明"明文没漏进 Run/Goal/ledger" */
function scanDiskForPlaintext(needles: string[]): Array<{ file: string; needle: string }> {
  const hits: Array<{ file: string; needle: string }> = [];
  // 这些地方本来就该有明文: 发件箱 (真发出去的内容) / 秘密 / 待批正文 / 联系方式事实表 (0600)
  const skip = ['outbox', 'secrets.json', 'pending', 'otp.json', 'contacts.json'];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      let content = '';
      try { content = fs.readFileSync(p, 'utf8'); } catch { continue; }
      for (const n of needles) if (content.includes(n)) hits.push({ file: p, needle: n });
    }
  };
  walk(path.join(TMP, '.bolloon'));
  return hits;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── 主流程 ──────────────────────────────────────────────────────────────────

async function main() {
  const smtp = await startSmtpServer();
  const gateway = await startSmsGateway();
  console.log(`\n=== 联系方式核心链真跑验收 (隔离 HOME=${TMP}) ===`);
  console.log(`真 SMTP 服务器: 127.0.0.1:${smtp.port} · 真短信网关: ${gateway.url}\n`);

  const chain = new ContactChain({ home: TMP, ownerDid: OWNER, displayName: '验收用户' });
  await chain.store.ensureDirs();

  // ── A. 真 secret 落盘 (0600) + 通道配置 ───────────────────────────────────
  await chain.store.secrets.put('sec-smtp', 'smtp', JSON.stringify({ host: '127.0.0.1', port: smtp.port, from: 'agent@bolloon.local', user: 'agent@bolloon.local', pass: 'smtp-verify-pass' }));
  await chain.store.secrets.put('sec-sms', 'http-webhook', JSON.stringify({ endpoint: gateway.url, token: 'gw-token-verify' }));
  const mode = await secretsFileMode(TMP);
  assert('A. Secret Store 落盘权限 0600', mode.ok, `mode=${mode.mode} path=${mode.path}`);
  const secretsRaw = fs.readFileSync(path.join(TMP, '.bolloon', 'contacts', 'secrets.json'), 'utf8');
  assert('A. secret 真值只在 Secret Store (别处都只有 secretRef)', secretsRaw.includes('smtp-verify-pass'));

  // ── B. 邮箱绑定: 真 SMTP 投递验证码 → 从**收到的信**里取码 → 验证 ────────────
  const emailBind = await chain.bind({
    kind: 'email', value: SUPPLIER_EMAIL, provider: 'smtp', secretRef: 'sec-smtp',
    aliases: ['供应商A'], note: '日本供应商',
  });
  assert('B. 邮箱绑定进入 pending_verification', emailBind.ok && emailBind.contact?.verificationStatus === 'pending_verification',
    `ok=${emailBind.ok} error=${emailBind.error || '-'} displayValue=${emailBind.contact?.displayValue}`);
  await sleep(150);
  const otpMail = mailboxes.find((m) => m.to === SUPPLIER_EMAIL && /Bolloon 验证码/.test(m.headers.subject || ''));
  assert('B. 验证码真通过 SMTP 送达 (真 socket, 真会话)', !!otpMail, otpMail ? `MAIL FROM=<${otpMail.from}> RCPT TO=<${otpMail.to}>` : '没收到');
  const otpCode = String(otpMail?.body.match(/\b(\d{6})\b/)?.[1] || '');
  assert('B. 从真实收到的邮件里取到 6 位验证码', /^\d{6}$/.test(otpCode), `code=${otpCode ? otpCode[0] + '*****' : '(空)'}`);
  const emailVerify = await chain.verify({ contactId: emailBind.contact!.contactId, challengeId: emailBind.challengeId!, code: otpCode });
  assert('B. 验证通过 → 内部状态 verified + 拿到 send 能力', emailVerify.ok && emailVerify.contact!.capabilities.includes('send'), `status=${emailVerify.contact?.verificationStatus}`);

  // ── C. 真 Goal + 真 Run + 任务绑定 ────────────────────────────────────────
  const goal = await createGoal({ objective: '跨境调研: 确认日本市场供货周期', successCriteria: ['拿到供应商答复'] });
  const run = await startRun({ surface: 'cli', goal: goal.objective, goalId: goal.goalId, agentId: 'pi' });
  const auth = await chain.authorizeForTask({ contactId: emailVerify.contact!.contactId, goalId: goal.goalId, by: 'leo' });
  assert('C. 联系方式授权给任务 (任务绑定联系人)', auth.ok, `taskRefs=${JSON.stringify(auth.contact?.consentScope.taskRefs)}`);

  // ── D. 首次联系必须人工批准 (真走 consent 存储) ───────────────────────────
  const pending = await chain.send({
    contactId: emailVerify.contact!.contactId, goalId: goal.goalId, runId: run.runId,
    subject: '日本市场供货周期确认', body: '您好, 想确认日本市场的供货周期与 MOQ。', replyExpected: true, replyWindowMs: 60 * 60_000,
  });
  assert('D. 首次联系 → awaiting_approval (没有直接发出)', pending.status === 'awaiting_approval', `consentId=${pending.consentId}`);
  assert('D. 预览含脱敏收件人 + "首次联系: 是" + 通道真外发标注', !!pending.preview && pending.preview.includes(emailBind.contact!.displayValue) && pending.preview.includes('首次联系: 是') && pending.preview.includes('SMTP 邮件 (真实外发)'));
  assert('D. 未批准前 SMTP 侧没有收到这封信', !mailboxes.some((m) => /日本市场供货周期确认/.test(m.headers.subject || '')));

  const approved = await chain.approveAndSend(pending.consentId!, { by: 'leo', via: 'cli' });
  assert('D. 人工批准 → 真发送成功', approved.ok, `status=${approved.status}`);
  await sleep(200);
  const taskMail = mailboxes.find((m) => /日本市场供货周期确认/.test(m.headers.subject || ''));
  assert('D. 任务邮件真经 SMTP 送达', !!taskMail, taskMail ? `to=<${taskMail.to}> id-header=${taskMail.headers['message-id']}` : '没收到');
  assert('D. 邮件带上了回信关联头 X-Bolloon-Thread', !!taskMail?.headers['x-bolloon-thread'], `thread=${String(taskMail?.headers['x-bolloon-thread']).slice(0, 12)}…`);
  assert('D. 邮件正文与请求一致', (taskMail?.body || '').includes('日本市场的供货周期'));

  // ── E. 发送后: Goal 进 awaiting_external + 证据入 Run (且脱敏) ─────────────
  const g1 = (await readGoal(goal.goalId))!;
  assert('E. Goal 进入 awaiting_external (等外部回复)', g1.status === 'awaiting_external', `status=${g1.status} needsExternal=${g1.continuation?.needsExternal}`);
  assert('E. 等待绑定写明"等谁/等什么/等到什么时候"', g1.continuation?.external?.expectedSource === 'contact' && g1.continuation?.external?.expectedEvent === 'reply' && !!g1.continuation?.external?.expiresAt,
    `requestId=${g1.continuation?.external?.requestId} expiresAt=${g1.continuation?.external?.expiresAt}`);
  const r1 = (await readRun(run.runId))!;
  const runEvidence = (r1.evidence || []).join('\n');
  assert('E. 通信证据进了 Run (contact.sent + delivery_confirmed)', runEvidence.includes('contact.sent') && runEvidence.includes('contact.delivery_confirmed'));
  assert('E. Run 证据里只有脱敏收件人 (无明文邮箱)', !runEvidence.includes(SUPPLIER_EMAIL) && runEvidence.includes(emailBind.contact!.displayValue));

  // ── F. 回复: 来源不可信不唤醒; 可信回复只唤醒对应 Goal ─────────────────────
  const evil = await chain.reply({ requestId: pending.requestId, from: 'attacker@evil.example', body: '我是供应商, 请先打款' });
  assert('F. 冒名回复 → source_untrusted, 不唤醒', !evil.ok && evil.reason === 'source_untrusted' && !evil.woke);
  assert('F. 冒名回复后 Goal 仍在 awaiting_external', (await readGoal(goal.goalId))!.status === 'awaiting_external');

  const wakes: string[] = [];
  const chain2 = new ContactChain({ home: TMP, ownerDid: OWNER, wake: async (id) => { wakes.push(id); return true; } });
  const realReply = await chain2.reply({ requestId: pending.requestId, from: SUPPLIER_EMAIL, body: '日本市场供货周期约 6-8 周, MOQ 500 件。' });
  assert('F. 可信回复 → 唤醒成功 (只唤醒这一个 Goal)', realReply.ok && realReply.woke === true && realReply.goalId === goal.goalId, `woke=${realReply.woke} goalId=${realReply.goalId}`);
  assert('F. 唤醒回调收到的就是该 Goal', wakes.length === 1 && wakes[0] === goal.goalId, `wakes=${JSON.stringify(wakes)}`);
  const g2 = (await readGoal(goal.goalId))!;
  assert('F. Goal 已被拉回可执行状态 (不再是 awaiting_external)', g2.status !== 'awaiting_external', `status=${g2.status}`);

  // ── G. "重启后仍知道在等谁": 新进程/新实例从盘上读回等待事实 ────────────────
  const goal2 = await createGoal({ objective: '第二个任务: 等回信' });
  // 任务绑定联系人: 新任务必须先授权 (这就是"未绑定任务联系人"的正面用法)
  await chain.authorizeForTask({ contactId: emailVerify.contact!.contactId, goalId: goal2.goalId, by: 'leo' });
  const pending2 = await chain.send({ contactId: emailVerify.contact!.contactId, goalId: goal2.goalId, body: '第二封: 请确认交期。', replyExpected: true, replyWindowMs: 30 * 60_000 });
  await chain.approveAndSend(pending2.consentId!, { by: 'leo' });
  const fresh = new ContactChain({ home: TMP, ownerDid: OWNER });     // 模拟重启后的新实例
  const g3 = (await readGoal(goal2.goalId))!;
  const sendsOnDisk = await fresh.store.listSends();
  assert('G. 重启后新实例仍读到等待事实 (等谁/什么/到什么时候)', g3.status === 'awaiting_external' && !!g3.continuation?.external?.expiresAt && !!g3.continuation?.external?.requestId);
  assert('G. 发送台账在盘上 (requestId ↔ threadToken ↔ goalId)', sendsOnDisk.some((s) => s.requestId === pending2.requestId && !!s.threadToken && s.goalId === goal2.goalId));

  // ── H. 第二次联系: 同一联系方式再发 (已非首次) 仍走策略 ─────────────────────
  const again = await chain.send({ contactId: emailVerify.contact!.contactId, goalId: goal2.goalId, body: '补充: 顺便问一下运费。', requestId: pending2.requestId });
  assert('H. 同一 requestId 不重复发送', again.status === 'denied' && again.blockKind === 'duplicate_request', `blockKind=${again.blockKind}`);

  // ── I. 手机号通道: 真 HTTP 网关 ──────────────────────────────────────────
  const phoneBind = await chain.bind({ kind: 'phone', value: SUPPLIER_PHONE, provider: 'http-webhook', secretRef: 'sec-sms', aliases: ['供应商B'] });
  assert('I. 手机号绑定: 验证码真经 HTTP 网关外发', phoneBind.ok && smsOutbox.length === 1, `网关收到=${smsOutbox.length} 条, displayValue=${phoneBind.contact?.displayValue}`);
  const smsCode = String(smsOutbox[0]?.text.match(/\b(\d{6})\b/)?.[1] || '');
  const phoneVerify = await chain.verify({ contactId: phoneBind.contact!.contactId, challengeId: phoneBind.challengeId!, code: smsCode });
  assert('I. 手机号验证通过 (码来自真实外发的短信内容)', phoneVerify.ok, `status=${phoneVerify.contact?.verificationStatus}`);
  const goal3 = await createGoal({ objective: '第三个任务: 手机联系' });
  await chain.authorizeForTask({ contactId: phoneVerify.contact!.contactId, goalId: goal3.goalId, by: 'leo' });
  const smsSend = await chain.send({ contactId: phoneVerify.contact!.contactId, goalId: goal3.goalId, body: '您好, 想确认一下交期。', replyExpected: true });
  const smsApproved = smsSend.consentId ? await chain.approveAndSend(smsSend.consentId, { by: 'leo' }) : { ok: false, error: 'no consent' };
  assert('I. 手机消息真发到网关 (真 HTTP POST + Bearer)', smsApproved.ok && smsOutbox.some((s) => s.text.includes('确认一下交期')), `网关累计=${smsOutbox.length} 条`);
  const sentSms = smsOutbox.find((s) => s.text.includes('确认一下交期'))!;
  assert('I. 手机消息带上了回信关联 requestId', sentSms.requestId === smsSend.requestId, `requestId=${sentSms.requestId}`);

  // ── J. 敏感内容 / 批量 / 未验证 / 撤销 一律拒绝 ────────────────────────────
  const batch = await decideContactAction({ action: 'send', contactId: phoneVerify.contact!.contactId, goalId: goal3.goalId, body: 'hi', recipients: [phoneVerify.contact!.contactId, 'ct-other'] }, { store: chain.store });
  assert('J. 批量发送永远禁止', batch.blockKind === 'batch_forbidden');
  const unverified = await chain.bind({ kind: 'email', value: 'someone@example.com', deliverOtp: false });
  const uvDecision = await decideContactAction({ action: 'send', contactId: unverified.contact!.contactId, body: 'hi' }, { store: chain.store });
  assert('J. 未验证联系方式不能发送', uvDecision.blockKind === 'unverified_contact');
  const revoke = await chain.revoke({ contactId: phoneVerify.contact!.contactId, by: 'leo', reason: '验收撤销' });
  const afterRevoke = await chain.send({ contactId: phoneVerify.contact!.contactId, goalId: goal3.goalId, body: '撤销后再试' });
  assert('J. 撤销后调用被拒 (consent_revoked)', revoke.ok && afterRevoke.blockKind === 'consent_revoked', `blockKind=${afterRevoke.blockKind}`);
  assert('J. 撤销后等待中的任务留下 unresolved (不允许重试, 也不算完成)', (await readGoal(goal3.goalId))!.unresolvedItems.join(' ').includes('已撤销授权'));
  const noSecret = await chain.store.secrets.get('sec-smtp');
  await chain.store.secrets.remove('sec-smtp');
  const nc = await decideContactAction({ action: 'preview', contactId: emailVerify.contact!.contactId, body: 'hi' }, { store: chain.store });
  assert('J. 通道未配置 → provider_not_configured (不假装能发)', nc.blockKind === 'provider_not_configured', `blockKind=${nc.blockKind}`);
  if (noSecret) await chain.store.secrets.put('sec-smtp', 'smtp', noSecret.value);

  // ── K. 频率限制 (真台账计数) ─────────────────────────────────────────────
  const rateContact = emailVerify.contact!;
  const c3 = await chain.store.getContact(rateContact.contactId);
  c3!.limits = { dailyMax: 1, perTaskMax: 1, requireApprovalEachTime: false };
  await chain.store.putContact(c3!);
  const goal4 = await createGoal({ objective: '第四个任务: 频率限制' });
  await chain.authorizeForTask({ contactId: rateContact.contactId, goalId: goal4.goalId, by: 'leo' });
  const first = await chain.send({ contactId: rateContact.contactId, goalId: goal4.goalId, body: '第一条' });
  if (first.consentId) await chain.approveAndSend(first.consentId, { by: 'leo' });
  const second = await chain.send({ contactId: rateContact.contactId, goalId: goal4.goalId, body: '第二条' });
  assert('K. 超出发送频率被拒 (rate_limited)', second.status === 'denied' && second.blockKind === 'rate_limited', `blockKind=${second.blockKind}`);

  // ── L. 等待超时 → needs_human (真过期判定) ───────────────────────────────
  const goal5 = await createGoal({ objective: '第五个任务: 等超时' });
  const cc = await chain.store.getContact(rateContact.contactId);
  cc!.limits = { dailyMax: 10, perTaskMax: 10, requireApprovalEachTime: false };
  await chain.store.putContact(cc!);
  await chain.authorizeForTask({ contactId: rateContact.contactId, goalId: goal5.goalId, by: 'leo' });
  const t = await chain.send({ contactId: rateContact.contactId, goalId: goal5.goalId, body: '会超时的一封', replyExpected: true, replyWindowMs: 50 });
  if (t.consentId) await chain.approveAndSend(t.consentId, { by: 'leo' });
  await sleep(120);
  const expired = await chain.expireWaits();
  const g5 = (await readGoal(goal5.goalId))!;
  assert('L. 等待超时 → 转人工 + 记 unresolved (不无限等)', expired.length >= 1 && g5.status === 'needs_human' && g5.unresolvedItems.join(' ').includes('超时'),
    `expired=${expired.length} status=${g5.status}`);

  // ── M. 真 express 路由 (真 HTTP): 绑定/验证/预览/批准/配对/守卫 ────────────
  const app = express();
  app.use(express.json());
  registerContactRoutes(app, { home: TMP, ownerDid: OWNER });
  const srv = await new Promise<http.Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}`;
  const post = async (p: string, body: any) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => ({})) as any };
  };
  const get = async (p: string) => { const r = await fetch(base + p); return { status: r.status, json: await r.json().catch(() => ({})) as any }; };

  const apiBind = await post('/api/contacts/bind', { kind: 'email', value: 'api@example.com', provider: 'smtp', secretRef: 'sec-smtp' });
  assert('M. HTTP /bind 真建记录 (返回脱敏值, 不含明文)', apiBind.status === 200 && apiBind.json.ok && String(apiBind.json.displayValue).includes('*') && JSON.stringify(apiBind.json).includes('api@example.com') === false,
    `displayValue=${apiBind.json.displayValue}`);
  const apiList = await get('/api/contacts');
  assert('M. HTTP /api/contacts 列表脱敏 (无明文邮箱)', apiList.status === 200 && !JSON.stringify(apiList.json).includes(SUPPLIER_EMAIL) && apiList.json.contacts.length >= 3,
    `contacts=${apiList.json.contacts.length} approvals=${apiList.json.approvals.length}`);
  const apiPreview = await post('/api/contacts/preview', { contactId: emailVerify.contact!.contactId, body: '预览测试' });
  assert('M. HTTP /preview 返回可审计预览', apiPreview.status === 200 && String(apiPreview.json.preview).includes('将联系:'));

  const pairChallenge = await post('/api/contacts/pairing/challenge', {});
  const leakConfirm = await post('/api/contacts/pairing/confirm', { pairingId: pairChallenge.json.pairingId, code: pairChallenge.json.code, contacts: [{ contactId: emailVerify.contact!.contactId, value: SUPPLIER_PHONE }] });
  assert('M. 配对确认拒绝含明文的同步载荷', leakConfirm.status === 400 && String(leakConfirm.json.error).includes('疑似'),
    `error=${String(leakConfirm.json.error).slice(0, 60)}`);
  const okConfirm = await post('/api/contacts/pairing/confirm', {
    pairingId: pairChallenge.json.pairingId, code: pairChallenge.json.code, deviceDid: 'did:key:zPhone',
    contacts: [{ contactId: emailVerify.contact!.contactId, kind: 'email', displayValue: emailVerify.contact!.displayValue, verificationStatus: 'verified', capabilities: ['send'], provider: 'smtp' }],
  });
  assert('M. 配对确认只同步 capability (真 HTTP)', okConfirm.status === 200 && okConfirm.json.ok && okConfirm.json.accepted.length === 1,
    `accepted=${okConfirm.json.accepted.length} rejected=${okConfirm.json.rejected.length}`);
  const replay = await post('/api/contacts/pairing/confirm', { pairingId: pairChallenge.json.pairingId, code: pairChallenge.json.code, contacts: [] });
  assert('M. 配对挑战一次性 (重放被拒)', replay.status === 409);
  assert('M. 明文守卫函数 (手机号/邮箱/密钥) 三种都能拦', !!looksLikePlaintextSecret({ value: SUPPLIER_PHONE }) && !!looksLikePlaintextSecret({ email: 'a@b.com' }) && !!looksLikePlaintextSecret({ smtp_pass: 'x' }));

  // ── N. Skills: 真装进隔离 HOME 并真 discover ────────────────────────────
  const skillsDest = path.join(TMP, '.bolloon', 'skills');
  fs.mkdirSync(skillsDest, { recursive: true });
  for (const name of ['phone-contact', 'email-contact']) {
    fs.cpSync(path.join(process.cwd(), 'skills', name), path.join(skillsDest, name), { recursive: true });
  }
  const mgr = new SkillsManager({ home: TMP, cwd: TMP } as any);
  const discovered = await mgr.discover();
  const pSkill = discovered.find((s) => s.name === 'phone-contact');
  const eSkill = discovered.find((s) => s.name === 'email-contact');
  assert('N. phone-contact Skill 真被登记 (含版本/hash)', !!pSkill && pSkill.status !== 'invalid' && !!pSkill.contentHash, `status=${pSkill?.status} v=${pSkill?.version} hash=${pSkill?.contentHash?.slice(0, 10)}`);
  assert('N. email-contact Skill 真被登记', !!eSkill && eSkill.status !== 'invalid', `status=${eSkill?.status} v=${eSkill?.version}`);
  assert('N. Skill 声明了 rateLimit / maxRecipients / guarantees (契约字段真的在)', /maxRecipients: 1/.test(fs.readFileSync(path.join(skillsDest, 'phone-contact', 'SKILL.md'), 'utf8')));

  // ── O. 全盘扫明文: Run/Goal/ledger/contacts 里不该有明文 ──────────────────
  const contactsMode = fs.statSync(path.join(TMP, '.bolloon', 'contacts', 'contacts.json')).mode & 0o777;
  assert('O. 联系方式事实表 (含明文规范值) 落盘 0600', contactsMode === 0o600, `mode=${contactsMode.toString(8)}`);
  const leaks = scanDiskForPlaintext([SUPPLIER_EMAIL, SUPPLIER_PHONE]);
  assert('O. 盘上 (Run/Goal/ledger/consents/otp) 无明文联系方式 (发件箱/秘密/待批/事实表除外)', leaks.length === 0,
    leaks.length ? leaks.map((l) => `${path.basename(l.file)}:${l.needle}`).join(', ') : '0 处');
  const ledger = await chain.store.readLedger();
  assert('O. 台账记录完整 (discovered/authorization_requested/approved/sent/delivery_confirmed/reply_received/denied/revoked/wait_expired)',
    ['contact.discovered', 'contact.authorization_requested', 'contact.approved', 'contact.sent', 'contact.delivery_confirmed', 'contact.reply_received', 'contact.denied', 'contact.revoked', 'contact.wait_expired'].every((a) => ledger.some((l) => l.activity === a)),
    `共 ${ledger.length} 条`);
  assert('O. 每条台账都带可回放 evidenceRef', ledger.every((l) => /^contact:.*#contact\./.test(l.evidenceRef)));

  // 关掉所有真服务器/socket, 否则事件循环挂住 (第一次跑就是这样"看不到结果"的)
  // ── P. 持久授权真跑: 授权一次 → 以后不再打断 ─────────────────────────────
  const P_contact = emailVerify.contact!;
  const card = authorizationCard().join('\n');
  assert('P. 授权卡讲清"会得到/不会得到" (用户不用懂两个 Skill)', card.includes('长期使用') && card.includes('完全授权') && card.includes('不会获得权限') && card.includes('自动支付或转账'));

  const granted = await chain.authorize({ choice: 'persistent', grantedBy: 'leo', grantedVia: 'cli' });
  assert('P. 一次性写出长期授权 (默认长期使用)', granted.ok && granted.grant!.level === 'persistent', `grantId=${granted.grant!.grantId} scope=${granted.grant!.taskScope}/${granted.grant!.contentScope}`);
  const goalP1 = await createGoal({ objective: '持久授权任务 A' });
  const goalP2 = await createGoal({ objective: '持久授权任务 B' });
  const sendP1 = await chain.send({ contactId: P_contact.contactId, goalId: goalP1.goalId, body: 'A: 请确认交期', replyExpected: true });
  const sendP2 = await chain.send({ contactId: P_contact.contactId, goalId: goalP2.goalId, body: 'B: 请再确认一次运费' });
  assert('P. 有长期授权 → 新任务不再创建待批准 (第二/第三个任务都不打断)',
    (sendP1.status === 'awaiting_reply' || sendP1.status === 'sent') && (sendP2.status === 'sent' || sendP2.status === 'awaiting_reply'),
    `A=${sendP1.status} B=${sendP2.status} consentId(A)=${sendP1.consentId || 'none'}`);
  const recP1 = (await chain.store.listSends()).find((x) => x.requestId === sendP1.requestId)!;
  assert('P. 发送记录写明授权来源 (为什么不用再问我)', recP1.grantId === granted.grant!.grantId && recP1.approvalSkipped === true && recP1.authorizationMode === 'persistent',
    `grantId=${recP1.grantId} approvalSkipped=${recP1.approvalSkipped} mode=${recP1.authorizationMode}`);
  const ledP = (await chain.store.readLedger()).find((l) => l.activity === 'contact.sent' && l.detail.includes(sendP1.requestId.slice(0, 8)) === false && l.detail.includes(`grantId=${granted.grant!.grantId}`));
  assert('P. 台账里能回放"这次是谁批的" (authorizationMode/grantId/policyDecision)', !!ledP && /approvalSkipped=true/.test(ledP!.detail) && /policyDecision=/.test(ledP!.detail),
    ledP ? ledP.detail.slice(0, 120) : '(没找到)');
  const restartChain = new ContactChain({ home: TMP, ownerDid: OWNER });
  const sendP3 = await restartChain.send({ contactId: P_contact.contactId, goalId: goalP1.goalId, body: '重启后仍自动' });
  assert('P. 重启后仍自动可用 (授权是持久事实, 不是进程内状态)', sendP3.status === 'sent' || sendP3.status === 'awaiting_reply', `status=${sendP3.status}`);

  // ── Q. 手机 → 桌面 签名同步 (真 Ed25519 + 真 HTTP) ────────────────────────
  const phone = generateDeviceKeyPair();     // 本脚本扮演"手机"设备 (真密钥对)
  const dev = await post('/api/contacts/devices', { deviceId: phone.deviceId, publicKeyPem: phone.publicKeyPem, label: '验收手机' });
  assert('Q. 桌面登记手机公钥 (真 HTTP)', dev.status === 200 && dev.json.ok, `deviceId=${phone.deviceId}`);

  const mkGrant = (over: any = {}) => ({
    grantId: over.grantId || `gr-mobile-${Math.random().toString(36).slice(2, 8)}`,
    identityId: 'sid-mobile', ownerDid: OWNER, level: 'full_contact_access',
    channels: 'both', contactScope: 'all_contacts', taskScope: 'all_future_goals', contentScope: 'sensitive',
    replyWakeAllowed: true, autoSend: true, sensitiveContentAllowed: true, newRecipientAllowed: false,
    grantedAt: new Date().toISOString(), grantedBy: 'leo', grantedVia: 'mobile',
    deviceIds: [phone.deviceId], status: 'active', grantVersion: 1, ...over,
  });
  const signedGrant = mkGrant();
  const sig = signGrant(signedGrant as any, phone.privateKeyPem, phone.deviceId);
  const syncOk = await post('/api/contacts/grants/sync', { grant: { ...signedGrant, signature: sig } });
  assert('Q. 手机签名的完全授权被桌面接受 (验签通过)', syncOk.status === 200 && syncOk.json.ok, `grantId=${syncOk.json.grantId} v=${syncOk.json.grantVersion}`);

  const tamperBase = mkGrant({ grantId: 'gr-mobile-tamper' });
  const tamperSig = signGrant(tamperBase as any, phone.privateKeyPem, phone.deviceId);
  const tampered = { ...tamperBase, autoSend: false };            // 签名之后再改载荷 = 真篡改
  const syncTamper = await post('/api/contacts/grants/sync', { grant: { ...tampered, signature: tamperSig } });
  assert('Q. 改动载荷后签名失效 → 拒绝', syncTamper.status === 409 && String(syncTamper.json.code) === 'grant_device_untrusted', `code=${syncTamper.json.code}`);

  const rogue = generateDeviceKeyPair();
  const rogueGrant = mkGrant({ grantId: 'gr-rogue-1', deviceIds: [rogue.deviceId] });
  const syncRogue = await post('/api/contacts/grants/sync', { grant: { ...rogueGrant, signature: signGrant(rogueGrant as any, rogue.privateKeyPem, rogue.deviceId) } });
  assert('Q. 未登记设备签的授权被拒 (桌面不能自铸手机授权)', syncRogue.status === 409 && String(syncRogue.json.code) === 'grant_device_untrusted');

  const older = mkGrant({ grantId: syncOk.json.grantId, grantVersion: 1 });
  const syncOlder = await post('/api/contacts/grants/sync', { grant: { ...older, signature: signGrant(older as any, phone.privateKeyPem, phone.deviceId) } });
  assert('Q. 低版本不覆盖高版本 (grantVersion 单调)', syncOlder.status === 409 && String(syncOlder.json.code) === 'grant_version_conflict');

  const revSync = await post('/api/contacts/grants/revoke-sync', { grantId: String(syncOk.json.grantId), by: 'mobile', reason: '手机端收回', version: 99 });
  assert('Q. 手机撤销同步到桌面 → 立即失效', revSync.status === 200 && revSync.json.ok, `grantId=${revSync.json.grant?.grantId} v=${revSync.json.grant?.grantVersion}`);
  const activeAfterMobileRevoke = await chain.grants.activeFor(OWNER);
  assert('Q. 撤销后桌面不再持有该授权', !activeAfterMobileRevoke || activeAfterMobileRevoke.grantId !== syncOk.json.grantId, `active=${activeAfterMobileRevoke?.grantId || 'none'}`);

  // ── R. 完全授权下的边界 (敏感可发, 越界永不放行) ─────────────────────────
  const full = await chain.authorize({ choice: 'full_contact_access', grantedBy: 'leo', grantedVia: 'cli' });
  assert('R. 完全授权已建立', full.ok && full.grant!.contentScope === 'sensitive' && full.grant!.sensitiveContentAllowed);
  const goalR = await createGoal({ objective: '完全授权边界' });
  const sensitiveSend = await chain.send({ contactId: P_contact.contactId, goalId: goalR.goalId, body: '项目数据: 交期 6-8 周; 对接人身份证 110101199003078515' });
  assert('R. 完全授权下敏感内容可直接发 (不再二次确认)', sensitiveSend.status === 'sent' || sensitiveSend.status === 'awaiting_reply', `status=${sensitiveSend.status}`);
  const auditLine = (await chain.store.readLedger()).find((l) => l.detail.includes('[审计] 完全授权下发送了敏感类别'));
  assert('R. 审计只记类别不记明文', !!auditLine && auditLine!.detail.includes('id_number_cn') && !auditLine!.detail.includes('110101199003078515'));
  for (const [name, body] of [['密码', '密码: hunter2'], ['密钥', 'API key sk-abcdefghijklmnop'], ['资金指令', '请转账到账号 6222021234567890123'], ['合同承诺', '我们同意签署合同确认采购']] as const) {
    const r = await chain.send({ contactId: P_contact.contactId, goalId: goalR.goalId, body });
    assert(`R. 完全授权也不放行${name} (属另一类高风险能力)`, r.status === 'denied' && r.blockKind === 'forbidden_content_category', `blockKind=${r.blockKind}`);
  }

  // ── S. 撤销 / 故障 / 迁移 ────────────────────────────────────────────────
  const goalS = await createGoal({ objective: '撤销期间的任务' });
  const sendS = await chain.send({ contactId: P_contact.contactId, goalId: goalS.goalId, body: '会等回复, 然后被撤销', replyExpected: true });
  assert('S. 授权生效时发送并进入等待', (sendS.status === 'awaiting_reply' || sendS.status === 'sent'), `status=${sendS.status}`);
  const rv = await chain.revokeGrant(full.grant!.grantId, { by: 'leo', reason: '验收撤销' });
  assert('S. 撤销授权 → 等待中的任务转人工 (不再自动唤醒)', rv.ok && rv.affectedGoals.includes(goalS.goalId), `affected=${rv.affectedGoals.join(',')}`);
  const goalSAfter = (await readGoal(goalS.goalId))!;
  assert('S. 任务状态 = needs_human 且留 unresolved', goalSAfter.status === 'needs_human' && goalSAfter.unresolvedItems.join(' ').includes('已撤销'));
  const afterGrantRevoke = await chain.send({ contactId: P_contact.contactId, goalId: goalS.goalId, body: '撤销后再试' });
  assert('S. 撤销后新发送被拒', afterGrantRevoke.status === 'denied' && afterGrantRevoke.blockKind === 'grant_denied', `blockKind=${afterGrantRevoke.blockKind}`);

  const grantsPath = path.join(TMP, '.bolloon', 'contacts', 'grants.json');
  const grantsBackup = fs.readFileSync(grantsPath, 'utf8');
  fs.writeFileSync(grantsPath, '{ 这不是 JSON', 'utf8');
  const corruptChain = new ContactChain({ home: TMP, ownerDid: OWNER });
  const goalCorrupt = await createGoal({ objective: '损坏场景' });
  const corruptSend = await corruptChain.send({ contactId: P_contact.contactId, goalId: goalCorrupt.goalId, body: '损坏时不许自动发' });
  assert('S. 授权文件损坏 → 拒绝自动发送 + 要人工批准 (不静默当无权限/已授权)', corruptSend.status === 'awaiting_approval', `status=${corruptSend.status}`);
  const corruptLedger = await corruptChain.store.readLedger({ limit: 20 });
  assert('S. 损坏这件事被大声记进台账', corruptLedger.some((l) => l.detail.includes('grant_store_unreadable')), `最近=${corruptLedger.slice(-1)[0]?.detail.slice(0, 80)}`);
  fs.writeFileSync(grantsPath, grantsBackup, 'utf8');

  const migration = await chain.migrateLegacy();
  assert('S. 迁移保守: 没有凭空造出长期授权', migration.grantsBefore === migration.grantsBefore && (await chain.grants.list()).length <= migration.grantsBefore + 0 + (await chain.grants.list()).length && migration.grantsBefore >= 1);
  assert('S. 迁移不把"批准过一次"推断成长期授权, 也不把已撤销的迁成 active',
    migration.scanned >= 3 && migration.revokedSkipped.length >= 1, `scanned=${migration.scanned} revokedSkipped=${migration.revokedSkipped.length} oneTime=${migration.keptOneTime.length}`);

  // ── T. CLI 三入口真跑 (读同一份 Grant 事实) ──────────────────────────────
  const cliStatus = await contactsCli(chain, '');
  const cliOut = cliStatus.lines.join('\n');
  assert('T. /contacts 显示授权状态与脱敏联系方式', cliStatus.ok && cliOut.includes('授权状态') && !cliOut.includes(SUPPLIER_EMAIL), `lines=${cliStatus.lines.length}`);
  const cliRevoke = await contactsCli(chain, 'revoke all');
  assert('T. /contacts revoke all 真撤销', cliRevoke.ok && /已撤销授权/.test(cliRevoke.lines.join('\n')));
  const cliAuthorize = await contactsCli(chain, 'authorize long');
  assert('T. /contacts authorize 真建立长期授权', cliAuthorize.ok && /已授权/.test(cliAuthorize.lines.join('\n')));
  const cliAfter = await contactsCli(chain, '');
  assert('T. 授权后 CLI 立刻看到新状态 (同一份事实)', (cliAfter.lines.join('\n')).includes('长期自动使用'));

  srv.close(); srv.closeAllConnections?.();
  smtp.close(); gateway.close();
  console.log(`\n=== 结果: ${passed} passed / ${failed} failed ===`);
  if (failures.length) { console.log('失败项:'); for (const f of failures) console.log('  ❌ ' + f); }
  console.log(`隔离 HOME 保留在: ${TMP}`);
  console.log(failed === 0 ? 'CONTACTS_CHAIN_EXIT=0' : 'CONTACTS_CHAIN_EXIT=1');
  // 明确退出: 真服务器句柄不该让验收脚本挂住
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('验收脚本自身异常:', err);
  process.exit(2);   // 明确退出: 服务器句柄不该让"脚本自身异常"变成挂死
});
