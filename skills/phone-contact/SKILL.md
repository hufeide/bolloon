---
name: phone-contact
description: 手机号联系能力 —— 绑定/验证后, 让 Agent 受约束地发一条任务相关短信, 并等待回复唤醒长期任务。不含群发、营销、联系人导入。
version: 1.0.0
status: active
tier: capability
triggers:
  - 联系手机
  - 发短信
  - phone.contact
capabilities:
  - phone.contact.verify
  - phone.contact.send
  - phone.contact.status
  - phone.contact.revoke
inputSchema:
  - "verify: { contactId, challengeId, code }"
  - "send: { contactId, body, subject?, goalId?, runId?, requestId?, replyExpected? }"
  - "status: { requestId }"
  - "revoke: { contactId, reason? }"
outputSchema:
  - "verify: { ok, verificationStatus, capabilities }"
  - "send: { status: sent|awaiting_reply|awaiting_approval|denied|failed, requestId, evidenceRef?, blockKind?, goalStatus? }"
  - "status: { status, replied, timedOut, evidence[] }"
  - "revoke: { ok, affectedGoals[] }"
requiredSecrets:
  - "http-webhook: { endpoint, token }  # 短信网关; 缺则 provider_not_configured, 不假装发送"
permissionScopes:
  - 单条任务相关消息
  - 等待并接收回复
maxRecipients: 1
rateLimit: "每 contact 每天 5 条 · 每任务 3 条 (limits.dailyMax/perTaskMax 可调, 批量永远禁止)"
verification: "绑定后必须 OTP 验证 (6 位, 10 分钟有效, 最多 5 次尝试, 一次性); 只有内部状态 verified 才能发送"
guarantees:
  - 未验证/已撤销的联系方式绝不会被发送
  - 发送前给可审计预览, 首次联系必须人工批准
  - 同一 requestId 不会重复发送
  - 发送失败会如实报错并保留旧状态, 不伪装成功
  - 明文手机号不进 prompt / Run / 证据 / Git
doesNotGuarantee:
  - 对方一定会收到 (运营商/网关侧可能失败)
  - 对方一定会回复
  - 语音/彩信/联系人批量导入 (第一版不做)
replyCanWakeGoal: true
---

# phone-contact — 手机号联系能力 (第一版)

## 这一版做什么

只做一条链: **绑定 → 验证 → 受约束发送一条 → 等待回复 → 唤醒原任务 → 留证据**。

不做 (明确): 群发 / 营销 / 自动转发 / 代表用户确认合同 / 语音 / 彩信 / 通讯录导入 / 自动加陌生联系人。

## 调用形态

Agent 只能拿到 `contactId` + 脱敏展示值 (`+86******1234`), **拿不到明文号码**:

```
contact.list_authorized            → 已授权联系方式 (脱敏)
phone.contact.verify { contactId, challengeId, code }
phone.contact.send   { contactId, body, goalId, requestId?, replyExpected? }
phone.contact.status { requestId }
phone.contact.revoke { contactId }
```

## 权限默认值

```
可以:   发送单条任务相关消息
不可以: 群发 · 营销 · 自动转发 · 代表用户确认合同
首次联系: 必须人工批准
敏感内容 (卡号/身份证/密钥/密码): 必须人工批准
```

## 通道

| provider | 行为 | 是否需要 secret |
|---|---|---|
| `local-sink` | 真写本地 outbox 文件, **没有真外发** (预览/证据必须标注) | 否 |
| `http-webhook` | 真 HTTP POST 到短信网关 | 是 (`{endpoint, token}`) |

未配置通道 → `provider_not_configured` 明确失败, 绝不假装已发送。

## 与长期任务的接口

发送成功且 `replyExpected=true` 且有 `goalId` 时:

```
Goal.status = awaiting_external
continuation.external = { requestId, continuationId, expectedSource: 'contact', expectedEvent: 'reply', expiresAt }
```

回复到达 → `external-events` 按 requestId 只唤醒**对应的那个** Goal; 来源不匹配 → 不计入证据、不唤醒。
超时 → Goal 转人工 (`needs_human`) 并记 `unresolvedItems`。
