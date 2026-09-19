/**
 * contacts/preview-types.ts — 预览/限额的共享类型 (2026-09-19)
 *
 * 单独一个文件是为了断开 types.ts ↔ policy.ts 的循环引用: 两边都要用这两个形状。
 */

export interface ContactLimits {
  /** 每天最多发几条 (按 contact 计) */
  dailyMax: number;
  /** 单个任务最多发几条 */
  perTaskMax: number;
  /** true = 每次发送都要人工批准 (即使已授权任务) */
  requireApprovalEachTime: boolean;
}

/** 发送前给用户看的那份可审计预览 (人读 + 机器读同一份) */
export interface ContactPreview {
  contactName: string;
  channel: 'phone' | 'email';
  provider: string;
  channelLabel: string;
  /** 通道是否真外发 (本地落盘时 false, 必须让用户看见) */
  reallySent: boolean;
  /** 脱敏收件人 */
  recipient: string;
  subject?: string;
  goalId?: string;
  goalObjective?: string;
  permission: string;
  usage: { today: number; todayMax: number; forGoal: number; goalMax: number };
  replyExpected?: string;
  firstContact: boolean;
  requiresApproval: boolean;
  approvalReason?: string;
  sensitive: string[];
  /** 人读渲染的原始行 (CLI/Web 直接打印) */
  lines: string[];
}
