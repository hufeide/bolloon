---
title: 联系方式与社交身份协议 (绑定 → 受约束调用 → 等待回复 → 唤醒任务 → 证据回放)
source: session (leo 2026-09-19 计划 + 真跑验收)
created: 2026-09-19
last_confirmed: 2026-09-19
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: chapter
tags: [contacts, social-identity, phone, email, otp, consent, secretref, contact-policy, batch-forbidden, awaiting-reply, supervisor, evidence, pairing, skills, smtp, http-webhook, local-sink, phase-0-9, acceptance-matrix]
---

# 联系方式与社交身份协议

## 一句话

Bolloon 的社交身份 = **DID 主身份 + 已验证联系方式 + 联系能力 Skill + 调用权限 + 可恢复任务证据**。
不是"公开手机号/邮箱", 也不是"再做一个社交平台"。它要解决的是长期任务缺的那一段:

```
绑定联系方式 → Agent 受约束调用 → 联系结果进长期任务 → 等待回复/人工确认 → Supervisor 恢复 → 结果与通信证据可回放
```

## 边界 (第一版冻结)

只做两个能力: `phone.contact` · `email.contact`。每个能力只支持: 绑定 / 验证 / 查看状态 / 发一条 / 记录或接收回复 / 撤销 / 作为长期任务的等待条件。

**明确不做**: 社交信息流 · 公开通讯录 · 自动群发 · 推荐联系人 · 社交积分 · 自动读全量邮箱 · 自动读全部手机通讯录 · 多账号合并 · 复杂 CRM · 关系图谱 · 自动代表用户做高风险承诺 · 用联系方式替代 DID。

## 外部只看到四类状态

| 外部状态 | 含义 |
|---|---|
| 已验证 | 验证通过, 但当前策略不允许直接联系 (如 `draft_only`) |
| 可联系 | 验证通过 + 有 send 能力 + 策略允许 |
| 不可联系 | `blocked` / `expired` / 未验证 |
| 需要重新授权 | 用户撤销过 (`revoked`) |

内部状态另有 `unbound` / `pending_verification` —— **不对外暴露**。

## 数据模型 (落盘事实)

`~/.bolloon/contacts/`

| 文件 | 内容 | 权限 |
|---|---|---|
| `social-identity.json` | SocialIdentity (ownerDid / verifiedContacts / privacyPolicy) | 默认 |
| `contacts.json` | VerifiedContact[] (**含 normalizedValue —— 真发信要用**) | **0600** |
| `secrets.json` | Secret Store (SMTP 密码 / 网关 token) | **0600** |
| `consents.json` | 人工批准请求 (只有脱敏预览) | 默认 |
| `pending/<requestId>.json` | 待批准的真实正文 + 执行参数 (发完即删) | **0600** |
| `otp.json` | 验证码挑战 (**只有 sha256(salt+code)**) | 默认 |
| `sent.json` | 发送台账 (requestId ↔ threadToken ↔ goalId, 摘要脱敏) | 默认 |
| `ledger.jsonl` | 只追加的通信台账 (每条带 evidenceRef) | 默认 |
| `outbox/` | `local-sink` 通道的真落盘发件箱 | 默认 |

硬规则: **明文手机号/邮箱不进 prompt、不进 Run、不进 Goal、不进 Git**; Goal/Run 只保存 `contactId` / provider / 动作 / 状态 / 证据引用。

## 调用链 (不可绕过)

```
Agent → PiAgentHarness → contact policy → consent → recipient → rate limit → preview → provider Skill → send → evidence
```

策略门判定顺序 (每种拒绝都有机器可读的 `blockKind`):

| # | 检查 | blockKind |
|---|---|---|
| 1 | 联系方式存在 | `not_found` |
| 2 | 已撤销 | `consent_revoked` |
| 3 | blocked / expired | `contact_blocked` / `verification_expired` |
| 4 | 未验证 | `unverified_contact` |
| 5 | 真外发通道的 secret 是否在 | `provider_not_configured` |
| 6 | 收件人 >1 | `batch_forbidden` (**批量永远禁止**) |
| 7 | 正文非空 | `missing_content` |
| 8 | `draft_only` | `policy_draft_only` |
| 9 | 同一 requestId 已发/已排队 | `duplicate_request` |
| 10 | 每天 / 每任务条数 | `rate_limited` |
| 11 | 任务存在且未结束 | `not_bound_to_task` / `goal_closed` |
| 12 | 是否绑定到这个任务 | `not_bound_to_task` |

要求人工批准的情形: **首次联系** (`first_contact`)、**敏感内容** (`sensitive_content`，卡号/身份证/密钥/密码/银行账号)、**每次确认** (`each_time`)、**策略要求** (`policy`)。用户明确给某个长期任务开 `auto_send` 后才可能免批 (仍需: 已绑定任务 + 非首次 + 无敏感内容 + 未超频)。

## 通道适配器

| provider | 行为 | secret | 真外发 |
|---|---|---|---|
| `local-sink` | 真写 `outbox/<requestId>.json` | 不需要 | **否** (预览/证据必须标"本地落盘(未真实外发)") |
| `http-webhook` | 真 HTTP POST (Bearer) | `{endpoint, token}` | 是 (短信网关) |
| `smtp` | 真 SMTP 会话 (net/tls + AUTH LOGIN, 支持多行应答) | `{host, port, user, pass, from}` | 是 |

未配置 = `provider_not_configured` **明确失败**, 绝不假装发送。

## 与长期任务/Supervisor 的接线 (复用既有地基)

- 发送成功且 `replyExpected` 且有 `goalId` → `bindExternalWait(goalId, { requestId, continuationId, expectedSource: 'contact', expectedEvent: 'reply', expiresAt })` → `Goal.status = awaiting_external`。
- 回复 → `deliverExternalEvent({ source: 'contact', eventId, requestId })` → 由既有实现按 **requestId 只唤醒对应 Goal**; 来源/关联不符 → 不唤醒。
- 来源校验在 chain 层: 回信地址必须等于绑定的联系方式, 否则记 `contact.reply_untrusted` —— **不计入证据、不唤醒**。
- 超时 → 既有 `expireExternalWaits` 把 Goal 转 `needs_human` + 记 `unresolvedItems` (不允许无限等)。
- 撤销 → 历史上等待该联系人的任务: 清等待 + 记 unresolved (不允许重试, 也不算完成)。
- **新增的外部事件来源 `'contact'`** 定义在 `goal-store.ts` 的 `GoalExternalSource` (单一事实, external-events 复用)。

## 通信台账 (证据可回放)

`contact.discovered` · `authorization_requested` · `approved` · `rejected` · `denied` · `sent` · `delivery_confirmed` · `reply_received` · `reply_untrusted` · `failed` · `revoked` · `wait_expired`

每条台账: `{ ts, activity, contactId, goalId, runId, eventId?, detail(脱敏, ≤300), evidenceRef }`,
`evidenceRef = contact:<contactId>@<ts>#<activity>` —— 同时写进 **Run.evidence** 与 **Goal.evidence**。

## 双端分工 (手机 / 桌面)

| 手机端负责 | 桌面端负责 |
|---|---|
| 输入手机号/邮箱 · OTP/验证链接确认 · 生物识别授权 · 展示待发内容 · 批准高风险联系 | 长期 Goal/Run · Supervisor · 执行与恢复 · 状态持久化 · 通信证据 · 等待回复 |

配对: 桌面 `POST /api/contacts/pairing/challenge` (一次性, 5 分钟) → 手机带 code + `deviceDid` 调 `/confirm`。
**只同步** `identityId / contactId / verificationStatus / capability / consentScope / provider / secretRef 关联状态`;
**绝不同步** 明文手机号/邮箱、API key、OAuth token、SMTP 密码。同步载荷里出现明文/密钥字段 → **整个请求被拒** (守卫函数 `looksLikePlaintextSecret`)。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/contacts` | 脱敏列表 + 通道 + 待批准 + 最近发送 |
| POST | `/api/contacts/bind` | 绑定 (规范化 E.164 / 邮箱 → 发验证码 → pending) |
| POST | `/api/contacts/verify` | 验证码校验 → verified |
| POST | `/api/contacts/:id/authorize` | 把联系方式授权给某个长期任务 |
| POST | `/api/contacts/:id/revoke` | 撤销 (历史证据保留, 后续拒绝) |
| POST | `/api/contacts/preview` | 可审计预览 (不发送) |
| POST | `/api/contacts/send` | 受约束发送 (需批准则返回 `awaiting_approval`) |
| POST | `/api/contacts/approvals/:id/{approve,reject}` | 人工批准/拒绝 |
| POST | `/api/contacts/reply` | 通道回调/手机转投 (来源校验) |
| POST | `/api/contacts/pairing/{challenge,confirm}` | 手机—桌面配对 |

Agent 侧工具: `contact.list_authorized` · `contact.preview` · `contact.request_consent` · `contact.send` · `contact.await_reply` · `contact.revoke`
(**只收 contactId, 不收地址**; 拿不到明文)。

## 真跑验收 (2026-09-19)

`npx tsx scripts/verify-contacts-chain.ts` → **51 passed / 0 failed, EXIT=0**

真跑的东西: 真 SMTP 服务器 (真走 220/EHLO/AUTH LOGIN/MAIL/RCPT/DATA/QUIT) · 真 HTTP 短信网关 (Bearer 鉴权) · 真 express 路由 (绑/验/预览/批准/撤销/配对全走 HTTP) · 真 Goal/Run 落盘 · 真 SkillsManager discover。

覆盖: 绑定→验证 (码取自**真收到的邮件/短信**) · 首次联系必须批准且批准前对方收不到 · 批准后真外发 + 回信关联头 · Goal 进 `awaiting_external` 且写明等谁/等到何时 · 冒名回复不唤醒 · 可信回复只唤醒对应 Goal + 唤醒回调收到正确 goalId · 重启后新实例仍读到等待事实 · 同 requestId 不重复 · 手机号通道真发真收 · 批量/未验证/撤销/未配置/超频/超时 全部拒绝或转人工 · 配对拒绝含明文载荷 + 一次性 · Skill 真登记 (v1.0.0 + contentHash) · 盘上无明文 (Run/Goal/ledger/consents/otp) · 事实表与秘密表 0600。

单测: `src/test/contacts.test.ts` **46/46**。

## 真跑逼出来并修掉的真 bug

1. **SMTP 多行应答丢行**: 一条 chunk 里带 `250-x\r\n250-AUTH LOGIN\r\n250 OK` 时, 早先实现只喂第一个等待者、其余行丢弃 → 客户端死等超时 (表现: 一发 EHLO 就 `smtp_timeout`)。修: 行队列 + 错误/断开快速失败。
2. **问候语竞态**: TCP 建好瞬间服务器就发 `220`, 监听器挂晚了会丢 → 先挂监听再等连接。
3. **批准后丢执行参数**: 等待窗口/是否等回复没跟正文一起暂存 → 批准后回退默认 48h。修: `pending/<requestId>.json` 连执行参数一起存。
4. **幂等占位自撞**: 待批准时写的 `sent.json` 占位会让"批准后复检"把自己判成 `duplicate_request`。修: 不写占位, 幂等由 consent 的 requestId 保证。
5. **`contacts.json` 明文副本**: 含 `normalizedValue` 的落盘文件改成 **0600** (纵深防御)。

## 未做 / 已知边界 (如实)

- 未接真实运营商/邮箱服务商 (验收用真 SMTP 服务器 + 真 HTTP 网关, 属"真协议真 socket", 但不是商用通道)。
- 接收侧只做"与任务绑定的回复" (带 threadToken/requestId + 发信地址匹配), **没有** IMAP 收信轮询、没有全量邮箱读取。
- 手机端只提供配对/确认的 API 契约与载荷守卫; 移动端 UI 未改 (APK/IPA 未重出)。
- 一版只一个收件人 (批量永久禁止); 无模板/无附件/无群发审批流。
- 未做 `email.draft` 落地 (draft_only 只用于拒绝发送)。
