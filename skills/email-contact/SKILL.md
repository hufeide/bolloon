---
name: email-contact
description: 邮箱联系能力 —— 绑定/验证后, 让 Agent 受约束地发一封结构化任务邮件, 并等待回复唤醒长期任务。第一版不读全量邮箱。
version: 1.0.0
status: active
tier: capability
triggers:
  - 联系邮箱
  - 发邮件
  - email.contact
capabilities:
  - email.contact.verify
  - email.contact.send
  - email.contact.status
  - email.contact.revoke
inputSchema:
  - "verify: { contactId, challengeId, code }"
  - "send: { contactId, subject, body, goalId?, runId?, requestId?, replyExpected? }"
  - "status: { requestId }"
  - "revoke: { contactId, reason? }"
outputSchema:
  - "verify: { ok, verificationStatus, capabilities }"
  - "send: { status: sent|awaiting_reply|awaiting_approval|denied|failed, requestId, evidenceRef?, blockKind?, goalStatus? }"
  - "status: { status, replied, timedOut, evidence[] }"
requiredSecrets:
  - "smtp: { host, port, secure?, user?, pass?, from }  # 缺则 provider_not_configured"
permissionScopes:
  - 单条任务相关邮件
  - 等待并接收与任务绑定的回复
maxRecipients: 1
rateLimit: "每 contact 每天 5 封 · 每任务 3 封"
verification: "绑定后必须验证码/验证链接确认; 只有内部状态 verified 才能发送"
guarantees:
  - 发送内容结构化 (recipientContactId/subject/body/taskContext/replyExpected/expiresAt)
  - 禁止 Agent 直接拼任意邮件头或任意收件人地址
  - 第一次联系默认 send_after_approval (人工批准后才发)
  - 明文邮箱不进 prompt / Run / 证据 / Git
doesNotGuarantee:
  - 读取用户全量邮箱 (第一版**不做**)
  - 保证对方回复
  - 自动续接无关邮件线程
replyCanWakeGoal: true
---

# email-contact — 邮箱联系能力 (第一版)

## 这一版做什么

只做**一个稳定发送路径** + 与任务绑定的回复接收:

```
绑定邮箱 → 验证 → 发一封结构化任务邮件 → 等待回复 → 回复进 Goal → 继续任务 → 证据回放
```

## 发送内容必须结构化

```json
{
  "recipientContactId": "ct-email-xxx",
  "subject": "日本市场供货周期确认",
  "body": "……",
  "taskContext": { "goalId": "g-xxx", "objective": "跨境调研" },
  "replyExpected": true,
  "expiresAt": "2026-09-21T10:00:00Z"
}
```

`发送的邮件头由通道生成` (From/Date/Message-ID/X-Bolloon-Thread), Agent 只能给 `subject` / `body` / `contactId`。

## 权限分级

| policy | 行为 |
|---|---|
| `draft_only` | 只允许起草, 发送一律拒绝 (`policy_draft_only`) |
| `send_after_approval` | **默认**; 首次联系/敏感内容/未按任务授权 → 人工批准后才发 |
| `auto_send` | 用户明确给某类长期任务授权后才用 (仍需: 已绑定任务 + 非首次联系 + 无敏感内容 + 未超频) |

## 通道

| provider | 行为 | 是否需要 secret |
|---|---|---|
| `local-sink` | 真写本地 outbox 文件, **没有真外发** (预览/证据必须标注) | 否 |
| `smtp` | 真 SMTP 会话 (net/tls + AUTH LOGIN) | 是 (`{host, port, user, pass, from}`) |

## 回复

只接收**与当前任务绑定**的回复: 回信必须带对 `X-Bolloon-Thread` (或 requestId), 且发信地址必须等于绑定的邮箱;
否则记 `contact.reply_untrusted` —— **不计入证据、不唤醒任务**。第一版不把邮箱变成无限上下文入口。
