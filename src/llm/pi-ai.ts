import * as path from 'path';
import * as fs from 'fs';
import { createHash } from 'crypto';
import { beginPromptProfile, addPromptParts } from './promptProfile.js';
import { request, Agent } from 'undici';

export type ModelProvider = 'openai' | 'anthropic' | 'ollama' | 'openrouter' | 'gemini' | 'minimax' | 'deepseek' | 'kimi' | 'glm' | 'qwen' | 'mimo' | 'grok' | 'local' | 'llamacpp';

export interface ModelConfig {
  provider: ModelProvider;
  apiKey?: string;
  baseUrl?: string;
  model: string;
}

/** 2026-09-22: native tool_call 结构 (OpenAI 协议) — 也被 ChatMessage / ChatResult 引用. */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

/**
 * 2026-09-22: OpenAI 协议原生工具定义.
 *
 * `GenerateOptions.tools` 现接受 `string[] | OpenAITool[]` — 前者是工具 id 列表 (调用方
 * 在代码侧查 schema, prompt 里只嵌一行说明); 后者是完整 schema, 会被规范化后放进
 * requestBody.tools, 由 serving 层 chat template 渲染.
 */
export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    /** JSON Schema. 内部结构可能含任意嵌套对象/数组. */
    parameters?: Record<string, any>;
  };
}

/**
 * 2026-09-22 (KV 友好化配套): ChatMessage 扩展支持 tool role + tool_calls 回带.
 *
 * 背景: 旧结构只有 system/user/assistant, 无法在 history 里表达完整的 tool-call 序列
 *   (assistant.tool_calls → tool.tool_call_id → 下一条 assistant). 这导致:
 *   1) 上层拼 history 时只能把 tool result 硬塞成 user 消息 → wire 形状错乱;
 *   2) 下一轮请求和 llama.cpp 上一轮真正渲染的 token prefix 对不上 → KV 永远 miss;
 *   3) DeepSeek 思考模式要求 assistant 回带 reasoning_content, 旧结构下只能对 assistant 生效,
 *      多轮 tool 循环的第 2 轮起就断 (见 prepareWireMessages 注释).
 *
 * 现在 role 显式含 'tool', 且 assistant 可携带 toolCalls / tool role 可携带 toolCallId,
 * prepareWireMessages 才能渲染出真正的 wire 形状 (tool_calls / tool_call_id),
 * 保证 history prefix 与 serving 层 slot 中的 KV 逐字节对齐.
 *
 * ⚠️ 上层调用方必须真正把 assistant 消息的 toolCalls / tool 消息的 toolCallId 存回 history.
 *   ChatMessage 只是"类型支持", 不代表"上层已经做了". 排查 KV miss 时, 先 grep 上层:
 *     rg "toolCalls|tool_calls|tool_call_id" src
 *   确认 history 真的形成了:
 *     assistant(tool_calls) → tool(tool_call_id) → assistant
 *   而不是:
 *     assistant(content) → user(content="tool result")  ← 会破坏 wire prefix.
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** 2026-09-15: 思考模式 provider (deepseek) 要求 assistant 消息回带 reasoning_content, 见 prepareWireMessages */
  reasoningContent?: string;
  /** 2026-09-22: assistant 消息携带的 native tool_calls (OpenAI 协议). 用于 history 回带. */
  toolCalls?: ToolCall[];
  /** 2026-09-22: tool 消息对应的 tool_call_id (OpenAI 协议). 用于 history 回带. */
  toolCallId?: string;
  /** 2026-09-22: tool 消息的 function name (部分 provider 需要). */
  name?: string;
}

export interface ChatResult {
  reply: string;
  /** 2026-09-15: 思考模型返回的思维链原文 (deepseek 等). 上层存进 history, 下一轮原样回带. */
  reasoningContent?: string;
  /** 2026-06-30: OpenAI 协议 native tool_calls 数组 (minimax/M3 返回)
   *  每个 tool_call 包含 id/type/function.name/function.arguments
   *  bolloon 用来给后续 tool result 提供 tool_call_id 引用 */
  toolCalls?: ToolCall[];
  /**
   * 2026-09-22 (#1 修复): 回带最终 wire messages (含注入的 CURRENT TURN 动态内容 + system 前缀).
   *
   * 根因: CURRENT TURN 动态区 (git/runtime/p2p reserve) 原本只在 chat() 内部瞬改进「最后一条 user
   *   消息」, 返回时只给 reply. 调用方自己的 history 里该 user 消息不带 D → 下一轮前缀从 U1 起失配:
   *     第1次: S H D1 U1       第2次: S H U1 U2   (U1 在第2次丢了 D1)
   *   而正确应是: S H D1 U1 U2 (D1 作为 U1 的一部分被持久化, 成为后续轮的稳定前缀).
   *
   * 处置: chat() 既把注入后的 content 写回调用方传入的 history 数组 (原地, 见下方注入逻辑),
   *   也在此回带完整 wire messages. 持有独立历史存储的调用方 (如 pi-sdk 的 messageHistory,
   *   其 messages 是每轮 buildMessages() 重建的全新数组) 必须据此把最后一条 user 的 content
   *   写回自身 history, 否则动态内容仍只活一轮.
   */
  messages?: ChatMessage[];
}

export interface SummarizeResult {
  summary: string;
  qualityScore: number;
}

export interface GenerateOptions {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /**
   * 工具定义:
   *   - string[]:  工具 id 列表 (代码侧 tool-manifest 查 schema; prompt 里只嵌一行说明 — 兜底路径).
   *   - OpenAITool[]: 完整 OpenAI 协议 tools schema (会被规范化后放进 requestBody.tools, 由 serving
   *     层 chat template 渲染). **推荐路径** — 避免工具信息在 system + requestBody.tools 中重复.
   */
  tools?: string[] | OpenAITool[];
  /** 2026-09-22: 流式输出回调 — 传入时 callOpenAI 走 SSE, 每收到一段 content delta 调一次.
   *  非 OpenAI 兼容 provider (anthropic/ollama/...) 暂忽略, 退化为整段返回. */
  onToken?: (delta: string) => void;
  /** 2026-09-22: 调用用途标记 — 透传到 callOpenAI 入口打 [pi-ai] 日志,
   *  配合 llama.cpp 的 task id 一眼区分每条请求: main-agent=主 agent 推理,
   *  summarize=文档/历史摘要, autoCompact=上下文自动压缩, improve=文档改进, chat=其他. */
  purpose?: string;
  /** 调用来源标记 (粗分类, 与 purpose 正交): health=健康检查探针 | social=社交心跳决策 | main-agent=主 agent 推理 | cron=定时任务. 不填则日志显示 '-'. */
  source?: string;
  /**
   * ⚠️ 仅 Anthropic 生效. 其他 provider 忽略此字段 — 它们靠 chat template 从 messages 里渲染.
   *
   * Anthropic 无自动前缀缓存, 需要显式 cache_control 断点. 这里的 `stable` 会被打成单个
   * text block 并以 `cache_control: {type:'ephemeral'}` 结尾 (整段视为可缓存前缀);
   * `dynamic` 若存在则作为第二个 block 且不加断点 (兼容老调用方).
   *
   * 2026-09-22 KV 友好化后, `chat()` 只传 `dynamic: ''` — CURRENT TURN 内容已挪到
   * currentTurnPreamble, 由 `chat()` 注入到最后一条 user 消息前部, 不再走 system.
   */
  systemParts?: { stable: string; dynamic: string };
}

/**
 * 外部 system 注入钩子.
 * 调用方 (e.g. auto-evolve-loop) 用 setSystemPrependProvider() 注册一个返回字符串的函数,
 * chat() 在拼 messages 后, 把返回的字符串作为 CURRENT TURN 动态区一部分,
 * 注入到最后一条 user 消息前部 (位于 IMMUTABLE PREFIX + CONVERSATION HISTORY 之后).
 *
 * 用途: P2P 协作时把"行级 reserve 状态"实时塞给 LLM,
 *       让 LLM 主动避开对方正在改的代码行.
 *
 * ⚠️ 2026-09-22: 只在 chat() 路径生效; summarize/improveContent 等直接走 generateText()
 *   的独立请求不注入 — 避免 P2P reserve 污染非 agent 请求的 prompt 前缀.
 *
 * 返回 '' / null / undefined → 不注入.
 */
let _prependProvider: (() => string | null | undefined | Promise<string | null | undefined>) | null = null;
export function setSystemPrependProvider(
  p: (() => string | null | undefined | Promise<string | null | undefined>) | null
): void {
  _prependProvider = p;
}
export function getSystemPrependProvider(): typeof _prependProvider {
  return _prependProvider;
}

/**
 * 2026-09-22: 系统提示词进程内缓存 (Node 侧 CPU/IO 缓存, 与 serving 层 KV 无关).
 *
 * 背景 (用户观测: "发对话都要再加载提示词, 没有用到 kv"):
 *   - 旧实现每轮 chat 都调 buildSystemPromptAsync → assembleSystemPrompt → 25 次 fs.readFile
 *     重新装配, 这就是"再加载提示词"的来源 (无谓磁盘 IO + 装配开销).
 *   - 更关键: 要让 serving 层 (llama.cpp / OpenAI / DeepSeek / vLLM) 命中「前缀 KV 缓存」复用,
 *     系统提示词前缀必须**逐字节一致**. 每轮若重新装配且内容有微差 (动态层时间戳 / git 状态),
 *     前缀失配 → KV 永远用不上, 每轮都得重新 prefill 整个 system prompt.
 *
 * ⚠️ 注意: 这是**应用层缓存**, 与 llama.cpp 的 KV cache 是两层完全不同的东西.
 *   它只能避免 CPU/IO 重复装配, **不会**让 llama.cpp 复用 KV. 真正 KV hit 需要:
 *     messages 序列 + tools schema 经 chat template 渲染出的 token prefix 与 slot 中已有 KV 完全一致.
 *   这层缓存做好后, 剩下的都在 serving 层 / 上层 history 组装那边.
 *
 * 处置: 把最终装配好的系统提示词按 working dir (context) 缓存, 只算一次;
 *   之后每轮直接返回同一份文本 → 前缀稳定 → serving 层自动复用 KV.
 *   配置/provider 变更 (initPiAI) 时清空, 避免拿到陈旧提示词.
 *   动态 project-context 层自身有 24h 缓存, 因此缓存期内文本本就一致.
 *
 * 2026-09-22 KV 友好化: 缓存拆成「稳定段 stableText」+「动态段 dynamicText」.
 *   dynamicText (project-context) 现由 chat() 从 system 中移出, 由 chat() 自身
 *   注入到最后一条 user 消息前部 (CURRENT TURN 区). 这样 system 逐字节稳定.
 */
const SYSTEM_PROMPT_CACHE_TTL_MS = 10 * 60 * 1000;
let _systemPromptCache: { key: string; stableText: string; dynamicText: string; at: number } | null = null;

/** 清空系统提示词缓存 (配置/provider 变更、layer 文件热更时调用) */
export function clearSystemPromptCache(): void {
  _systemPromptCache = null;
}

/**
 * 2026-09-22: JSON canonicalization — 递归对对象 key 排序, 数组保持原顺序.
 *
 * 目的: 工具 schema (parameters.properties / required 等) 内部 key 顺序若由调用方
 *   动态生成, 每次可能不同 (例如从 JS object 遍历而来). 即使语义相同, 经 chat template
 *   渲染后 token 序列也会不同 → 前缀 KV 命中失败. 规范化后序列化为稳定的 JSON 字符串,
 *   保证工具定义"逐字节可复现".
 *
 * ⚠️ 只排对象 key, 不动数组. 数组语义可能有序 (e.g. required 列表), 保留原顺序.
 */
function canonicalizeJson(value: any): any {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value && typeof value === 'object') {
    const sorted: Record<string, any> = {};
    for (const k of Object.keys(value).sort()) {
      sorted[k] = canonicalizeJson(value[k]);
    }
    return sorted;
  }
  return value;
}

/**
 * 2026-09-22: 工具定义规范化 + 按 function.name 排序.
 *
 * KV 命中前提: 跨轮 chat template 渲染出的 token prefix 必须完全一致.
 * 工具集合相同, 但:
 *   - 顺序不同 (read,write,grep vs read,grep,write)
 *   - schema 内 properties key 顺序不同 (path,content vs content,path)
 * 都会导致 token prefix 断裂. 这里强制规范化消除此类抖动.
 */
function canonicalizeTools(tools: OpenAITool[]): OpenAITool[] {
  return tools
    .map((t) => canonicalizeJson(t) as OpenAITool)
    .sort((a, b) => String(a?.function?.name || '').localeCompare(String(b?.function?.name || '')));
}

/** 判断 tools 数组是否为原生 schema (OpenAITool[]), 而非 string[] id 列表. */
function isNativeTools(tools: string[] | OpenAITool[]): tools is OpenAITool[] {
  if (!Array.isArray(tools) || tools.length === 0) return false;
  const first = tools[0];
  return typeof first === 'object' && first !== null && (first as any).type === 'function';
}

export class PiAIModel {
  private config: ModelConfig;
  private provider: ModelProvider;
  /** 单次 LLM HTTP 请求硬上限 (ms), 防止上游卡住挂死整个 loop. 可通过 BOLLOON_LLM_TIMEOUT 覆盖.
   *  2026-09-22: 默认从 120s 提到 300s — 本地思考模型 (Qwen3 系等) 在 16K system prompt + 工具定义
   *    下首 token 前思考可能 30~60s+, 120s 会被 AbortSignal.timeout 截断 →
   *    "AbortError: This operation was aborted" + "AI 未返回内容". 与 server.ts 的 5min pivot 超时对齐. */
  private requestTimeoutMs: number;

  constructor(config: ModelConfig) {
    this.config = config;
    this.provider = config.provider;
    const envTimeout = Number(process.env.BOLLOON_LLM_TIMEOUT);
    this.requestTimeoutMs = Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 300_000;
  }

  /**
   * 把外部 signal 和内部 timeout 合并: 任一触发都 abort.
   * - 外部 signal 优先 (用户主动 abort)
   * - 否则套 timeout
   * - 任一不合法 (非 AbortSignal 实例) 时退到无 signal
   */
  private combinedSignal(external?: AbortSignal): AbortSignal | undefined {
    const valid = external instanceof AbortSignal ? external : undefined;
    if (typeof AbortSignal !== 'undefined' && typeof (AbortSignal as any).timeout === 'function') {
      const timeoutSignal = (AbortSignal as any).timeout(this.requestTimeoutMs);
      if (!valid) return timeoutSignal;
      const ctrl = new AbortController();
      const onAbort = () => ctrl.abort();
      valid.addEventListener('abort', onAbort, { once: true });
      timeoutSignal.addEventListener('abort', onAbort, { once: true });
      if (valid.aborted || timeoutSignal.aborted) ctrl.abort();
      return ctrl.signal;
    }
    return valid;
  }

  /**
   * 与 LLM 对话.
   *
   * 支持三种调用形式:
   *   - 旧: chat(message: string, context?: string, signal?)
   *   - 新: chat(messages: ChatMessage[], context?: string, signal?)
   *       完整 messages 数组, 含 user/assistant/tool/system role.
   *   - pivot loop 兼容: chat(context: string, systemPrompt: string, signal?)
   *       第二参超过 2K 时视为 system prompt 覆盖.
   *
   * 2026-09-22 KV 友好化 (三段式布局):
   *   ┌─ IMMUTABLE PREFIX ─┐  system message: Role/Persona/Agent/Workflow/Capabilities/
   *                          Tool defs/Working directory/Runtime version — 逐字节稳定
   *   ├─ CONVERSATION ─────┤  user / assistant / tool ... 天然可复用
   *   └─ CURRENT TURN ─────┘  runtime state / git state / P2P reserve / 用户请求
   *                          → 由 chat() 直接把动态内容拼进「最后一条 user 消息」前部.
   *
   * 2026-09-22 二次修复 (currentTurnPreamble 与当前 user 消息绑定):
   *   之前 generateText 里靠 `last message.role === 'user'` 猜哪条是当前轮. 现在合并逻辑
   *   上移到 chat() — 因为 chat() 明确知道 `messageOrMessages` 的最后一条就是当前轮
   *   (调用方传入的 history 约定最后一条是当前 user 消息). 这样:
   *   - 语义明确, 不再有"猜"的模糊地带;
   *   - 若历史最后一条不是 user, 明确追加一条新 user 消息 (不写回 system).
   */
  async chat(
    messageOrMessages: string | ChatMessage[],
    contextOrSystemPrompt?: string,
    signal?: AbortSignal,
    tools?: string[] | OpenAITool[],
    onToken?: (delta: string) => void,
    purpose?: string,
    source?: string
  ): Promise<ChatResult> {
    let messages: ChatMessage[];
    /** ⚠️ 仅 Anthropic 使用. 现只含 IMMUTABLE PREFIX (dynamic 恒为空). */
    let systemParts: { stable: string; dynamic: string } | undefined;
    /** 2026-09-22: CURRENT TURN 动态区 (project-context 等). 由 chat() 自身注入到最后一条 user 消息前部. */
    let currentTurnPreamble = '';

    if (Array.isArray(messageOrMessages)) {
      if (contextOrSystemPrompt && contextOrSystemPrompt.length > 2000) {
        // 全局分层提示词 (stableText) + agent 静态段 (contextOrSystemPrompt) → IMMUTABLE PREFIX.
        // dynamicText (project-context) 从 system 中移出, 由 chat() 注入 CURRENT TURN.
        const { stableText, dynamicText } = await this.buildSystemPromptParts(undefined);
        const immutablePrefix = `${stableText}\n\n${contextOrSystemPrompt}`;
        currentTurnPreamble = dynamicText;

        if (process.env.DEBUG_PROMPT_PREFIX) {
          const h = createHash('sha256').update(immutablePrefix).digest('hex').slice(0, 12);
          console.log(`[prompt-prefix] immutable_prefix sha256[:12]=${h} chars=${immutablePrefix.length}`);
        }

        messages = [
          { role: 'system', content: immutablePrefix },
          ...messageOrMessages
        ];
        systemParts = { stable: immutablePrefix, dynamic: '' };

        if (process.env.BOLLOON_PROMPT_PROFILE === '1') {
          const _ppr = (globalThis as any).__ppRound;
          if (_ppr && !(globalThis as any).__ppAiAdded) {
            (globalThis as any).__ppAiAdded = true;
            addPromptParts(_ppr, {
              stableText: stableText || '',
              dynamicText: dynamicText || '',
              messages: JSON.stringify(messages),
            }, 'pi-ai');
          }
        }
      } else {
        const { stableText, dynamicText } = await this.buildSystemPromptParts(contextOrSystemPrompt);
        currentTurnPreamble = dynamicText;
        messages = [{ role: 'system', content: stableText }, ...messageOrMessages];
        systemParts = { stable: stableText, dynamic: '' };
      }
    } else {
      const { stableText, dynamicText } = await this.buildSystemPromptParts(contextOrSystemPrompt);
      currentTurnPreamble = dynamicText;
      messages = [
        { role: 'system', content: stableText },
        { role: 'user', content: messageOrMessages }
      ];
      systemParts = { stable: stableText, dynamic: '' };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2026-09-22 (二次修复): CURRENT TURN 动态区合并.
    //
    // 由 chat() 直接把动态内容拼进「最后一条 user 消息」前部 — 不留给 generateText 猜.
    // 两条规则:
    //   1. 动态内容 + P2P prepend 都在 stable prefix (system + history) 之后;
    //   2. **绝不写回 system** — 避免破坏 IMMUTABLE PREFIX, 让跨轮前缀 KV 命中失败.
    // ─────────────────────────────────────────────────────────────────────────
    const dynParts: string[] = [];
    if (currentTurnPreamble && currentTurnPreamble.trim()) {
      dynParts.push(currentTurnPreamble);
    }
    if (_prependProvider) {
      try {
        const pre = await _prependProvider();
        if (pre && typeof pre === 'string' && pre.trim()) dynParts.push(pre);
      } catch (err: any) {
        console.warn('[pi-ai] systemPrepend 失败:', err?.message?.slice(0, 100));
      }
    }

    if (dynParts.length > 0) {
      const combined = dynParts.join('\n\n');
      const MARKER = '<!-- current-turn: runtime/git/p2p -->';
      // 找 messages 中「最后一条 user」(= 当前轮用户输入), 而非最后一条消息 —
      //   工具循环里最后一条可能是 assistant/tool, 往那注入会污染 history 并追加多余 user 消息.
      //   messages 比 messageOrMessages 多一个 system 前缀 (头部), 故偏移 -1 映射回调用方数组.
      let userIdx = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') { userIdx = i; break; }
      }
      if (userIdx >= 0) {
        const uMsg = messages[userIdx];
        if (!uMsg.content.includes(MARKER)) {
          // 未注入过 → 把动态区拼到当前 user 前部, 并写回调用方 history 数组 (原地改, 下一轮前缀一致).
          const injected = `${MARKER}\n${combined}\n\n---\n\n` + uMsg.content;
          messages = messages.slice();
          messages[userIdx] = { ...uMsg, content: injected };
          if (Array.isArray(messageOrMessages)) {
            const srcMsg = (messageOrMessages as any[])[userIdx - 1];
            if (srcMsg && srcMsg.role === 'user') srcMsg.content = injected;
          }
        }
        // 已含 MARKER → 幂等跳过 (多 iteration / 重试不重复注入, 也不追加多余 user).
      } else {
        // 极端: 整段没有任何 user 消息 — 明确追加一条 (绝不写回 system, 保持 IMMUTABLE PREFIX 稳定).
        const injected = `${MARKER}\n${combined}`;
        messages = [...messages, { role: 'user', content: injected }];
        if (Array.isArray(messageOrMessages)) (messageOrMessages as any[]).push({ role: 'user', content: injected });
      }
    }

    try {
      const response = await this.generateText({
        messages,
        temperature: 0.8,
        maxTokens: 16384,
        signal,
        tools,
        onToken,
        purpose,
        source,
        systemParts,
      });
      return { reply: response.reply, toolCalls: response.toolCalls, reasoningContent: response.reasoningContent, messages };
    } catch (error: any) {
      if (signal?.aborted || error?.name === 'AbortError') {
        throw error;
      }
      const { ErrorLessonStore, planRecovery, MAX_RECOVERY_ATTEMPTS, classifyApiError } = await import('./error-lessons.js');
      const store = (chatErrorLessons ??= new ErrorLessonStore());
      const baseLesson = store.learn(error);
      if (baseLesson.isNewLesson) {
        console.warn(`[llm-lesson] 新错误教训: ${baseLesson.classified.category} (${baseLesson.classified.pattern}) → ${baseLesson.classified.recovery}`);
      }

      for (let attempt = 0; attempt < MAX_RECOVERY_ATTEMPTS; attempt++) {
        const classified = classifyApiError(error);
        const plan = planRecovery(classified, attempt);
        if (!plan.shouldRetry) break;
        const backoffMs = plan.backoffMs;
        console.warn(`[llm-recovery] ${classified.category} attempt ${attempt + 1}/${MAX_RECOVERY_ATTEMPTS}, 退避 ${backoffMs}ms 重试`);
        await new Promise<void>((r) => setTimeout(r, backoffMs));
        try {
          const response = await this.generateText({
            messages,
            temperature: 0.8,
            maxTokens: 16384,
            signal,
            tools,
            onToken,
            purpose,
            source,
            systemParts,
          });
          return { reply: response.reply, toolCalls: response.toolCalls, reasoningContent: response.reasoningContent, messages };
        } catch (retryErr: any) {
          if (signal?.aborted || retryErr?.name === 'AbortError') throw retryErr;
          error = retryErr;
        }
      }
      console.error('PiAI chat error:', error);
      const causeMsg = error?.cause?.message ? ` (cause: ${String(error.cause.message).slice(0, 150)})` : '';
      const errMsg = ((error?.message || '') + causeMsg).slice(0, 300);
      return {
        reply: `[AI 服务调用失败] ${errMsg}\n\n这是一个**底层 API 错误**（401 / 鉴权失败 / 网络中断 / 配额耗尽等），不是你的任务有问题。**请直接把这个错误消息回复给用户，不要再循环尝试。**`,
      };
    }
  }

  async summarize(text: string, context?: string): Promise<SummarizeResult> {
    const prompt = this.buildSummarizePrompt(text, context);

    try {
      const response = await this.generateText({
        messages: [
          { role: 'system', content: 'You are a professional document summarizer.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        purpose: 'summarize'
      });

      const qualityScore = this.estimateQuality(text, response.reply);
      return { summary: response.reply, qualityScore };
    } catch (error) {
      console.error('PiAI summarize error:', error);
      return {
        summary: text.substring(0, 500) + '...',
        qualityScore: 0.5
      };
    }
  }

  async improveContent(content: string, requirements: string, context?: string): Promise<string> {
    const prompt = this.buildImprovePrompt(content, requirements, context);

    try {
      const response = await this.generateText({
        messages: [
          { role: 'system', content: 'You are a professional document editor and improver.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.8,
        purpose: 'improve'
      });
      return response.reply;
    } catch (error) {
      console.error('PiAI improve error:', error);
      return content;
    }
  }

  private async generateText(options: GenerateOptions): Promise<ChatResult> {
    const {
      messages,
      temperature = 0.7,
      maxTokens = 4096,
      signal,
      tools,
      onToken,
      purpose,
      source,
    } = options;

    // 2026-09-22 二次修复: CURRENT TURN 动态合并已上移到 chat(). 这里只处理:
    //   1) 工具定义规范化 (排序 + JSON canonicalize)
    //   2) 分发到各 provider
    // 动态内容合并后, messages 已是最终 wire messages (含 stable prefix + history + 当前轮).
    let finalMessages = messages;

    // ── 工具定义 ──
    let openaiTools: OpenAITool[] | undefined;
    if (tools && tools.length > 0) {
      if (isNativeTools(tools)) {
        // 原生 tools (OpenAI schema). 规范化:
        //   - 按 function.name 排序 (跨轮顺序稳定)
        //   - 递归对对象 key 排序 (schema 内 properties key 顺序稳定)
        // 消除 chat template 渲染出的 token prefix 抖动 → serving 层前缀 KV 可命中.
        openaiTools = canonicalizeTools(tools);
        // 不再向 system 追加 "## 可用工具" 摘要 —— requestBody.tools 是唯一工具定义来源.
      } else {
        // 字符串 id 数组: 无原生 schema → 降级为 system 内文本描述 (兜底路径).
        const toolDescriptions = (tools as string[]).map(t => `- ${t}`).join('\n');
        const sysIdx = finalMessages.findIndex((m) => m.role === 'system');
        if (sysIdx >= 0) {
          finalMessages = finalMessages.slice();
          finalMessages[sysIdx] = {
            ...finalMessages[sysIdx],
            content: `${finalMessages[sysIdx].content}\n\n## 可用工具\n${toolDescriptions}`,
          };
        } else {
          finalMessages = [{ role: 'system', content: `## 可用工具\n${toolDescriptions}` }, ...finalMessages];
        }
      }
    }

    switch (this.provider) {
      case 'openai':
      case 'minimax':
      case 'deepseek':
      case 'kimi':
      case 'glm':
      case 'qwen':
      case 'mimo':
      case 'grok':
      case 'llamacpp':
        return this.callOpenAI(finalMessages, temperature, maxTokens, signal, openaiTools, onToken, purpose, source);
      case 'anthropic':
        // systemParts 仅 Anthropic 生效 (OpenAI 系忽略, 靠 messages 里的 system 消息).
        return this.callAnthropic(finalMessages, temperature, maxTokens, signal, options.systemParts);
      case 'ollama':
        return this.callOllama(finalMessages, temperature, signal);
      case 'openrouter':
        return this.callOpenRouter(finalMessages, temperature, maxTokens, signal);
      case 'gemini':
        return this.callGemini(finalMessages, temperature, maxTokens, signal);
      case 'local':
        return this.callLocal(finalMessages, temperature, signal);
      default:
        throw new Error(`Unsupported provider: ${this.provider}`);
    }
  }

  private getApiKey(): string {
    return this.config.apiKey || this.getEnvApiKey();
  }

  private getEnvApiKey(): string {
    const envVars: Record<ModelProvider, string> = {
      openai: process.env.OPENAI_API_KEY || '',
      anthropic: process.env.ANTHROPIC_API_KEY || '',
      ollama: '',
      openrouter: process.env.OPENROUTER_API_KEY || '',
      gemini: process.env.GEMINI_API_KEY || '',
      minimax: process.env.MINIMAX_API_KEY || '',
      deepseek: process.env.DEEPSEEK_API_KEY || '',
      kimi: process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY || '',
      glm: process.env.GLM_API_KEY || process.env.ZHIPU_API_KEY || '',
      qwen: process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY || '',
      mimo: process.env.MIMO_API_KEY || '',
      grok: process.env.XAI_API_KEY || '',
      local: '',
      llamacpp: process.env.LLAMACPP_API_KEY || ''
    };
    return envVars[this.provider] || '';
  }

  private getBaseUrl(): string {
    if (this.config.baseUrl) {
      return this.config.baseUrl;
    }

    const baseUrls: Record<ModelProvider, string> = {
      openai: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      anthropic: 'https://api.anthropic.com/v1',
      ollama: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
      openrouter: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
      gemini: 'https://generativelanguage.googleapis.com/v1beta',
      minimax: process.env.MINIMAX_BASE_URL || 'https://api.minimaxi.com/v1',
      deepseek: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
      kimi: process.env.KIMI_BASE_URL || process.env.MOONSHOT_BASE_URL || 'https://api.moonshot.cn/v1',
      glm: process.env.GLM_BASE_URL || process.env.ZHIPU_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4',
      qwen: process.env.QWEN_BASE_URL || process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      mimo: process.env.MIMO_BASE_URL || 'https://api.xiaomi.com/v1',
      grok: process.env.XAI_BASE_URL || 'https://api.x.ai/v1',
      local: 'http://localhost:11434',
      llamacpp: process.env.LLAMACPP_BASE_URL || 'http://localhost:8080/v1'
    };

    return baseUrls[this.provider];
  }

  private mapModel(): string {
    const modelMap: Record<ModelProvider, string> = {
      openai: this.config.model || process.env.OPENAI_MODEL || 'gpt-5.6',
      anthropic: this.config.model || process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
      ollama: this.config.model || 'llama4',
      openrouter: this.config.model || process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-5',
      gemini: this.config.model || process.env.GEMINI_MODEL || 'gemini-3.5-flash',
      minimax: this.config.model || process.env.MINIMAX_MODEL || 'MiniMax-M3',
      deepseek: this.config.model || process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
      kimi: this.config.model || process.env.KIMI_MODEL || process.env.MOONSHOT_MODEL || 'kimi-k3',
      glm: this.config.model || process.env.GLM_MODEL || process.env.ZHIPU_MODEL || 'glm-5.2',
      qwen: this.config.model || process.env.QWEN_MODEL || process.env.DASHSCOPE_MODEL || 'qwen3-max',
      mimo: this.config.model || process.env.MIMO_MODEL || 'mimo-v2.5-pro',
      grok: this.config.model || process.env.XAI_MODEL || 'grok-4.5',
      local: this.config.model || 'llama4',
      llamacpp: this.config.model || process.env.LLAMACPP_MODEL || 'local'
    };
    return modelMap[this.provider];
  }

  /**
   * 2026-09-15 / 2026-09-22: 出网前把 messages 规整成 wire 形状.
   *
   * 处理项:
   *   - system / user: 原样透传.
   *   - assistant: 携带 tool_calls (native tool calling); deepseek 思考模式额外回带 reasoning_content
   *     (否则 HTTP 400 "The `reasoning_content` in the thinking mode must be passed back to the API").
   *   - tool: 携带 tool_call_id (+ 可选 name), content 是工具返回值.
   *
   * 为什么 KV 友好化后必须做这一步:
   *   llama.cpp 真正看到的 token prefix 是 chat_template(wire_messages). 若 history 里
   *   assistant.tool_calls / tool.tool_call_id 没有以 wire 形状回带, 下一轮渲染出的 token prefix
   *   就和上一轮 slot 中的 KV 对不上 → 前缀命中失败.
   */
  private prepareWireMessages(messages: ChatMessage[]): any[] {
    const echoReasoning = this.provider === 'deepseek';
    return messages.map((m) => {
      if (m.role === 'assistant') {
        const out: any = { role: 'assistant', content: m.content ?? '' };
        // 2026-09-22 (#10 修复): 仅当 reasoning_content 真实存在才回带, 不发送
        //   "reasoning_content": "" — 空串与字段缺失经 chat template 后 token 不完全等价, 会断 KV.
        if (echoReasoning && m.reasoningContent != null) out.reasoning_content = m.reasoningContent;
        if (m.toolCalls && m.toolCalls.length > 0) out.tool_calls = m.toolCalls;
        return out;
      }
      if (m.role === 'tool') {
        const out: any = { role: 'tool', content: m.content ?? '' };
        if (m.toolCallId) out.tool_call_id = m.toolCallId;
        if (m.name) out.name = m.name;
        return out;
      }
      // system / user
      return { role: m.role, content: m.content ?? '' };
    });
  }

  private async callOpenAI(messages: ChatMessage[], temperature: number, maxTokens: number, signal?: AbortSignal, tools?: OpenAITool[], onToken?: (delta: string) => void, purpose?: string, source?: string): Promise<ChatResult> {
    const _purpose = purpose || 'chat';
    const _estTok = Math.ceil(messages.reduce((n, m) => n + (m.content?.length || 0), 0) / 4);
    const _ts = new Date().toISOString().slice(11, 23);
    console.log(`[pi-ai] ▶ purpose=${_purpose} source=${source || '-'} prompt≈${_estTok}tok ${_ts}`);

    const wireMessages = this.prepareWireMessages(messages);

    // 2026-09-22 KV 友好化调试: 逐消息打印 **真正发送给 serving 层** 的 wire 前缀哈希.
    //   ⚠️ 这只是 HTTP JSON 层的 prefix hash, 不是 chat template 渲染后的 token prefix hash.
    //   真正的 KV hit 仍需对照 llama-server 的 prompt eval / cached tokens 日志.
    //   用途: 快速定位"应用层 messages 前缀在哪里断裂", 缩小排查范围.
    //   - msg0 (system) hash 跨轮一致但后面开始分叉 → history 组装问题 (上层未回带 assistant/tool).
    //   - msg0..N 一致, 仅 msgN+1 不同 → 完美前缀, CURRENT TURN 只在最后一条 user.
    if (process.env.DEBUG_PROMPT_PREFIX) {
      let acc = '';
      for (let i = 0; i < wireMessages.length; i++) {
        acc += JSON.stringify(wireMessages[i]);
        const h = createHash('sha256').update(acc).digest('hex').slice(0, 12);
        const m = wireMessages[i];
        console.log(`[kv-debug] msg=${i} role=${m.role} prefixHash=${h} chars=${acc.length}`);
      }
      const toolsHash = tools && tools.length > 0
        ? createHash('sha256').update(JSON.stringify(tools)).digest('hex').slice(0, 12)
        : '-';
      console.log(`[kv-debug] tools count=${tools?.length ?? 0} hash=${toolsHash}`);
    }

    const apiKey = this.getApiKey();
    const authHeader = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

    const requestBody: any = {
      model: this.mapModel(),
      messages: wireMessages,
      temperature,
      max_tokens: maxTokens,
      // 2026-09-22: 前缀 KV 缓存 — 仅 main-agent 开启, 其余关闭.
      //   背景: llama-server 是 -np 1 (单 slot), 同时只缓存一条 prompt 的 KV. 若 chat / summarize /
      //   autoCompact / improve 等探针也带 cache_prompt, 会抢占 slot 0 并驱逐 main-agent 已缓存的
      //   前缀 → 下一轮 main-agent 前缀 miss、整段重算 (这就是"kv 失效"的真凶).
      //   故非 main-agent 一律关, 把单槽留给主对话跨轮复用. BOLLOON_DISABLE_CACHE_PROMPT=1 可彻底关闭 (含 main-agent).
      //   ⚠️ cache_prompt=true 只表示"允许 server 尝试复用", 真正 hit 仍需 chat template 渲染的
      //     token prefix 与 slot 中已有 KV 逐字节一致 (stable system + 仅追加 history 才能命中).
      cache_prompt: process.env.BOLLOON_DISABLE_CACHE_PROMPT === '1' ? false : (_purpose === 'main-agent')
    };

    if (tools && tools.length > 0) {
      requestBody.tools = tools;
      requestBody.tool_choice = 'auto';
    }

    if (onToken) {
      requestBody.stream = true;
      // 2026-09-22: 开启 usage 回传, 让 llama.cpp 在 SSE 末帧带 prompt_tokens_details.cached_tokens,
      //   用于 server 级 KV 命中诊断 ([kv-server] 日志).
      requestBody.stream_options = { include_usage: true };
    }

    let lastFinishReason = '';
    const _t0 = Date.now();
    let retryAgent: Agent | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const _tFetch = Date.now();
      let statusCode = 0;
      let body: any;
      try {
        const reqInit: any = {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...authHeader,
          },
          body: JSON.stringify(requestBody),
          signal: this.combinedSignal(signal),
        };
        if (retryAgent) reqInit.dispatcher = retryAgent;
        const res = await request(`${this.getBaseUrl()}/chat/completions`, reqInit);
        statusCode = res.statusCode;
        body = res.body;
      } catch (err: any) {
        if (err?.name === 'AbortError' || signal?.aborted) throw err;
        const netMsg = String(err?.message || err?.cause?.message || '');
        const isNetworkErr = /terminated|other side closed|ECONNRESET|socket hang up|fetch failed|network|ETIMEDOUT|ECONNREFUSED|UND_ERR/i.test(netMsg);
        if (attempt < 3 && isNetworkErr) {
          const backoff = 1000 * (2 ** attempt);
          console.warn(`[pi-ai] 网络错误 attempt ${attempt + 1}/4: ${netMsg.slice(0, 120)}, 退避 ${backoff}ms 重试 (新连接)`);
          retryAgent?.destroy().catch(() => {});
          retryAgent = new Agent({ connect: { timeout: 30_000 } });
          await new Promise<void>(resolve => setTimeout(resolve, backoff));
          continue;
        }
        throw err;
      }
      const _tResp = Date.now();
      if (statusCode < 200 || statusCode >= 300) {
        const errBody = await body.text().catch(() => '(no body)');
        console.log(`[pi-ai DEBUG] OpenAI 错误 ${statusCode}: ${String(errBody).slice(0, 500)}`);
        console.log(`[pi-ai DEBUG] 请求体: model=${requestBody.model}, messages=${requestBody.messages?.length}, max_tokens=${requestBody.max_tokens}, baseUrl=${this.getBaseUrl()}`);
        if (process.env.BOLLOON_DUMP_BODY === '1') {
          try {
            const fsx = await import('fs');
            const p = `/tmp/bolloon-req-${Date.now()}.json`;
            fsx.writeFileSync(p, JSON.stringify(requestBody, null, 2));
            console.log(`[pi-ai DEBUG] 失败请求体已落盘: ${p}`);
          } catch { /* 调试用, 失败忽略 */ }
        }
        retryAgent?.destroy().catch(() => {});
        throw new Error(`OpenAI API error: ${statusCode} ${String(errBody).slice(0, 300)}`);
      }

      if (onToken) {
        const reader: any = body;
        let buf = '';
        let rawBody = '';
        let content = '';
        let reasoningContentStream: string | undefined;
        const toolCallsAcc: Map<number, { id?: string; type?: string; function: { name?: string; arguments?: string } }> = new Map();
        // 2026-09-22: 捕获 SSE 末帧 usage (含 cached_tokens), 用于 server 级 KV 命中诊断.
        let lastUsage: any;
        const decoder = new TextDecoder();
        try {
          for await (const chunk of reader) {
            const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
            buf += text;
            rawBody += text;
            let nl: number;
            while ((nl = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (!line.startsWith('data:')) continue;
              const payload = line.slice(5).trim();
              if (!payload || payload === '[DONE]') continue;
              let json: any;
              try { json = JSON.parse(payload); } catch { continue; }
              const choice = json.choices?.[0];
              if (!choice) continue;
              if (json.usage) lastUsage = json.usage;
              const delta = choice.delta || {};
              if (typeof delta.content === 'string' && delta.content) {
                content += delta.content;
                try { onToken(delta.content); } catch { /* 回调异常不阻断流 */ }
              }
              if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
                reasoningContentStream = (reasoningContentStream || '') + delta.reasoning_content;
              }
              if (Array.isArray(delta.tool_calls)) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? 0;
                  if (!toolCallsAcc.has(idx)) toolCallsAcc.set(idx, { function: {} });
                  const acc = toolCallsAcc.get(idx)!;
                  if (tc.id) acc.id = tc.id;
                  if (tc.type) acc.type = tc.type;
                  if (tc.function?.name) acc.function.name = (acc.function.name || '') + tc.function.name;
                  if (tc.function?.arguments) acc.function.arguments = (acc.function.arguments || '') + tc.function.arguments;
                }
              }
            }
          }
        } catch (streamErr: any) {
          if (streamErr?.name === 'AbortError' || signal?.aborted) throw streamErr;
          console.warn('[pi-ai] stream 中断 (已输出部分):', String(streamErr?.message || streamErr).slice(0, 120));
        }
        // 兜底: provider 忽略 stream:true 直接返回整段 JSON (不是 SSE). 尝试解析 body 全文.
        // (标准 SSE 场景下 rawBody 是多条 `data: {...}` 拼起来, JSON.parse 会失败 → 保持 content 空.)
        if (content === '' && toolCallsAcc.size === 0 && rawBody.trim()) {
          try {
            const data = JSON.parse(rawBody);
            const choice = data.choices?.[0];
            if (choice?.message?.content) content = choice.message.content;
            if (choice?.message?.reasoning_content) reasoningContentStream = choice.message.reasoning_content;
            if (Array.isArray(choice?.message?.tool_calls)) {
              let i = 0;
              for (const tc of choice.message.tool_calls) {
                toolCallsAcc.set(i++, {
                  id: tc.id ?? '',
                  type: tc.type || 'function',
                  function: { name: tc.function?.name || '', arguments: tc.function?.arguments || '' },
                });
              }
            }
          } catch { /* 标准 SSE: 保留 content 空, 上层走空回复处理 */ }
        }
        if (lastUsage) {
          const _cached = lastUsage.prompt_tokens_details?.cached_tokens ?? lastUsage.cached_tokens ?? 0;
          const _prompt = lastUsage.prompt_tokens ?? 0;
          console.log(`[kv-server] purpose=${_purpose} stream cached=${_cached} prompt=${_prompt} hit=${_prompt ? ((_cached / _prompt) * 100).toFixed(1) + '%' : '?'}`);
        }
        const toolCalls = Array.from(toolCallsAcc.values()).map((t) => ({
          id: t.id ?? '',
          type: t.type || 'function',
          function: { name: t.function.name || '', arguments: t.function.arguments || '' },
        }));
        const _tAfter = Date.now();
        const promptBytes = JSON.stringify(messages).length;
        console.log(`[pi-ai timing] total=${_tAfter - _t0}ms stream reply=${content.length}B toolCalls=${toolCalls.length} model=${this.mapModel()} prompt=${promptBytes}B`);
        retryAgent?.destroy().catch(() => {});
        return { reply: content, toolCalls: toolCalls.length > 0 ? (toolCalls as ToolCall[]) : undefined, reasoningContent: reasoningContentStream };
      }

      const data = await body.json() as {
        choices?: { message?: { content?: string; tool_calls?: any[]; reasoning_content?: string }; finish_reason?: string; index?: number }[];
      };
      const _tParse = Date.now();
      const choice = data.choices?.[0];
      const content = choice?.message?.content || '';
      const toolCalls = choice?.message?.tool_calls;
      const reasoningContent = choice?.message?.reasoning_content || undefined;
      lastFinishReason = choice?.finish_reason || '';
      // 2026-09-22: server 级 KV 命中诊断 (llama.cpp 在 timings/cached_tokens 回传复用 token 数).
      {
        const _t = (data as any).timings || {};
        const _cached = (data as any).usage?.prompt_tokens_details?.cached_tokens ?? _t.cache_n ?? 0;
        const _prompt = (data as any).usage?.prompt_tokens ?? _t.prompt_n ?? 0;
        console.log(`[kv-server] purpose=${_purpose} cached=${_cached} prompt=${_prompt} hit=${_prompt ? ((_cached / _prompt) * 100).toFixed(1) + '%' : '?'}`);
      }
      if (content || (toolCalls && toolCalls.length > 0)) {
        if (lastFinishReason === 'length') {
          console.warn(`[pi-ai] hit max_tokens ceiling (model=${this.mapModel()}, max_tokens=${maxTokens}) — caller should trim prompt or raise cap`);
        }
        const _tAfter = Date.now();
        const promptBytes = JSON.stringify(messages).length;
        console.log(`[pi-ai timing] total=${_tAfter - _t0}ms attempt=${attempt + 1} fetch=${_tResp - _tFetch}ms parse=${_tParse - _tResp}ms reply=${content.length}B toolCalls=${toolCalls?.length ?? 0} model=${this.mapModel()} prompt=${promptBytes}B`);
        retryAgent?.destroy().catch(() => {});
        return { reply: content, toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined, reasoningContent };
      }
      console.warn(`[pi-ai] attempt ${attempt + 1}/3: 空 content (finish_reason=${lastFinishReason}), 退避 1.5s 重试`);
      const _tSleep = Date.now();
      await new Promise<void>(resolve => setTimeout(resolve, 1500));
      console.log(`[pi-ai timing] attempt=${attempt + 1} empty; backoff=${Date.now() - _tSleep}ms; total=${Date.now() - _t0}ms so far`);
    }
    console.warn(`[pi-ai] 3 次重试都返回空 content (finish_reason=${lastFinishReason})`);
    retryAgent?.destroy().catch(() => {});
    return { reply: '' };
  }

  private async callAnthropic(messages: ChatMessage[], temperature: number, maxTokens: number, signal?: AbortSignal, systemParts?: { stable: string; dynamic: string }): Promise<ChatResult> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY not set');
    }

    // ① IMMUTABLE PREFIX — 整段几乎永久不变 → 作为单个 system block, 以 ephemeral 断点结尾, 跨轮命中缓存.
    //   ⚠️ systemParts 只在此 provider 生效; OpenAI 系忽略它 (靠 messages 里的 system 消息).
    const systemField = systemParts?.stable
      ? [{ type: 'text', text: systemParts.stable, cache_control: { type: 'ephemeral' } }]
      : [{ type: 'text', text: messages.find(m => m.role === 'system')?.content || '', cache_control: { type: 'ephemeral' } }];

    // ② 非 system 消息 → Anthropic wire format.
    //   - tool 消息 → role=user + content=[{type:'tool_result', tool_use_id, content}]
    //   - assistant 带 toolCalls → content=[{type:'text'}?, {type:'tool_use'}...]
    //   - 其余原样透传 (string content)
    const nonSystemMessages = messages.filter(m => m.role !== 'system');
    const wireMessages: any[] = nonSystemMessages.map((m, i) => {
      const isLastHistory = nonSystemMessages.length > 1 && i === nonSystemMessages.length - 2;

      if (m.role === 'tool') {
        return {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: m.toolCallId || '',
            content: m.content ?? '',
          }],
        };
      }
      if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
        const blocks: any[] = [];
        if (m.content) blocks.push({ type: 'text', text: m.content });
        for (const tc of m.toolCalls) {
          let input: any = {};
          try { input = JSON.parse(tc.function.arguments || '{}'); }
          catch { input = { _raw: tc.function.arguments }; }
          blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
        }
        return { role: 'assistant', content: blocks };
      }
      // 纯文本消息 — 在最后一条历史消息 (当前轮之前) 上打 ephemeral 断点, 让历史前缀可复用.
      if (isLastHistory && m.role === 'user') {
        return { role: 'user', content: [{ type: 'text', text: m.content ?? '', cache_control: { type: 'ephemeral' } }] };
      }
      return { role: m.role, content: m.content ?? '' };
    });

    const response = await fetch(`${this.getBaseUrl()}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: this.mapModel(),
        messages: wireMessages,
        system: systemField,
        temperature,
        max_tokens: maxTokens
      }),
      signal: this.combinedSignal(signal),
    });

    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status}`);
    }

    const data = await response.json() as { content?: { text?: string }[] };
    return { reply: data.content?.[0]?.text || '' };
  }

  private async callOllama(messages: ChatMessage[], temperature: number, signal?: AbortSignal): Promise<ChatResult> {
    const response = await fetch(`${this.getBaseUrl()}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: this.mapModel(),
        messages,
        temperature,
        stream: false
      }),
      signal: this.combinedSignal(signal),
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status}`);
    }

    const data = await response.json() as { message?: { content?: string } };
    return { reply: data.message?.content || '' };
  }

  private async callOpenRouter(messages: ChatMessage[], temperature: number, maxTokens: number, signal?: AbortSignal): Promise<ChatResult> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('OPENROUTER_API_KEY not set');
    }

    const response = await fetch(`${this.getBaseUrl()}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://openclaw.ai',
        'X-Title': 'OpenClaw'
      },
      body: JSON.stringify({
        model: this.mapModel(),
        messages,
        temperature,
        max_tokens: maxTokens
      }),
      signal: this.combinedSignal(signal),
    });

    if (!response.ok) {
      throw new Error(`OpenRouter API error: ${response.status}`);
    }

    const data = await response.json() as { choices?: { message?: { content?: string } }[] };
    return { reply: data.choices?.[0]?.message?.content || '' };
  }

  private async callGemini(messages: ChatMessage[], temperature: number, maxTokens: number, signal?: AbortSignal): Promise<ChatResult> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY not set');
    }

    const contents = messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      }));

    const systemInstruction = messages.find(m => m.role === 'system')?.content;

    const response = await fetch(
      `${this.getBaseUrl()}/models/${this.mapModel()}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          contents,
          systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
          generationConfig: {
            temperature,
            maxOutputTokens: maxTokens
          }
        }),
        signal: this.combinedSignal(signal),
      }
    );

    if (!response.ok) {
      throw new Error(`Gemini API error: ${response.status}`);
    }

    const data = await response.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    return { reply: data.candidates?.[0]?.content?.parts?.[0]?.text || '' };
  }

  private async callLocal(messages: ChatMessage[], temperature: number, signal?: AbortSignal): Promise<ChatResult> {
    return this.callOllama(messages, temperature, signal);
  }

  /**
   * 装配系统提示词 (带进程内缓存), 返回完整文本 (稳定段 + 动态段拼好).
   * 兜底保留; 主路径应走 buildSystemPromptParts().
   */
  private async buildSystemPromptAsync(context?: string): Promise<string> {
    const { stableText, dynamicText } = await this.buildSystemPromptParts(context);
    return dynamicText ? `${stableText}\n\n${dynamicText}` : stableText;
  }

  /**
   * 装配系统提示词, 拆开「稳定段」与「动态段」返回.
   *
   * 2026-09-22 KV 友好化后: 调用方把 dynamicText 从 system 中移出, 由 chat()
   *   注入到最后一条 user 消息前部 (CURRENT TURN 区). 这样:
   *   ┌─ IMMUTABLE PREFIX ─┐ system (stableText) — 逐字节稳定, 命中前缀 KV
   *   ├─ CONVERSATION ─────┤ user / assistant / tool — 天然可复用
   *   └─ CURRENT TURN ─────┘ dynamicText + P2P reserve + 用户请求 — 每轮变化, 只在尾部
   */
  private async buildSystemPromptParts(context?: string): Promise<{ stableText: string; dynamicText: string }> {
    const key = context || process.cwd();
    const now = Date.now();
    if (_systemPromptCache && _systemPromptCache.key === key && now - _systemPromptCache.at < SYSTEM_PROMPT_CACHE_TTL_MS) {
      return { stableText: _systemPromptCache.stableText, dynamicText: _systemPromptCache.dynamicText };
    }
    const parts = await this.assembleSystemPromptPartsText(context);
    _systemPromptCache = { key, stableText: parts.stableText, dynamicText: parts.dynamicText, at: now };
    return parts;
  }

  /**
   * 真正装配 (无缓存); 把 source==='function' 的动态层拆到 dynamicText; 失败降级为硬编码.
   *
   * ⚠️ 已知脆弱点 (2026-09-22 记录, 未重构 registry 接口): 目前通过 HTML 注释标记
   *   `<!-- ${id}@...` + 下一个 `\n\n<!-- ` 作为 layer boundary 从最终字符串里反向解析
   *   动态层. 若 registry 输出格式改变 (换行数 / 注释风格), 拆分可能不准. 更稳的做法是
   *   让 assembleSystemPrompt() 直接返回 { stableLayers, dynamicLayers } 结构化结果.
   *   现版本: 若找不到标记则跳过该 id (不抛错), 保持 stable 原样 — 保证不会因此挂掉,
   *   但动态层可能残留在 stable 里. 排查时可用 DEBUG_PROMPT_PREFIX 对比前缀 hash.
   */
  private async assembleSystemPromptPartsText(context?: string): Promise<{ stableText: string; dynamicText: string }> {
    try {
      const { assembleSystemPrompt, SYSTEM_PROMPT_VERSION } = await import(
        './system-prompt/registry.js' as any
      ).catch(() => import('./system-prompt/registry.js'));
      const ctx = { channel: 'local' as const, role: 'expert' as const };
      const result = await assembleSystemPrompt(ctx);
      const dynIds = result.layers.filter((l: any) => l.source === 'function').map((l: any) => l.id);
      let stable = result.text;
      let dynamic = '';
      for (const id of dynIds) {
        const marker = `<!-- ${id}@`;
        const idx = stable.indexOf(marker);
        if (idx < 0) continue;
        let blockEnd = stable.indexOf('\n\n<!-- ', idx);
        if (blockEnd < 0) blockEnd = stable.length;
        dynamic += stable.slice(idx, blockEnd).replace(/\n+$/, '') + '\n\n';
        stable = stable.slice(0, idx) + stable.slice(blockEnd);
      }
      stable = stable.replace(/\n+$/, '');
      dynamic = dynamic.replace(/\n+$/, '');
      const suffix = `\n\n## User Working Directory\n${context || process.cwd()}\n\n## bolloon-runtime\n${SYSTEM_PROMPT_VERSION} · layers: ${result.layerIds.join(',')}`;
      return { stableText: stable + suffix, dynamicText: dynamic };
    } catch (err: any) {
      console.warn('[pi-ai] layer registry 不可用, 降级:', err.message?.slice(0, 100));
      const envDetails = this.getEnvironmentDetails();
      return {
        stableText: `You are a friendly AI assistant in a P2P document collaboration network.

## User Working Directory
${context || process.cwd()}

## Environment
${envDetails}`,
        dynamicText: '',
      };
    }
  }

  private buildSystemPrompt(context?: string): string {
    const envDetails = this.getEnvironmentDetails();
    return `You are a friendly AI assistant in a P2P document collaboration network.

## User Working Directory
${context || process.cwd()}

## Environment
${envDetails}`;
  }

  private getEnvironmentDetails(): string {
    return `
## Available Workflows
- read - Read documents
- summarize - Summarize documents  
- improve - Improve documents
- collaborate - Multi-agent collaboration
- query - Query status
- report - Generate reports

## System Capabilities
- Document processing (Markdown, Text, PDF, DOCX)
- Multi-agent collaboration (P2P network)
- Workflow engine (constraint layer)
- Quality assessment and auto-send

## Current Time
${new Date().toISOString()}`;
  }

  private buildSummarizePrompt(text: string, context?: string): string {
    const maxLength = 8000;
    const truncatedText = text.length > maxLength ? text.substring(0, maxLength) + '...' : text;

    let prompt = `Please generate a concise and accurate summary for the following document:

${truncatedText}

Please output in the following format:
## Summary
[Write summary here]

## Quality Self-Assessment
[Score 1-10, with reasoning]`;

    if (context) {
      prompt = `Context: ${context}

${prompt}`;
    }

    return prompt;
  }

  private buildImprovePrompt(content: string, requirements: string, context?: string): string {
    const maxLength = 8000;
    const truncatedContent = content.length > maxLength ? content.substring(0, maxLength) + '...' : content;

    let prompt = `Please improve the document according to the following requirements:

Requirements: ${requirements}

Original Document:
${truncatedContent}

Please output only the improved document without additional explanation.`;

    if (context) {
      prompt = `Context: ${context}

${prompt}`;
    }

    return prompt;
  }

  estimateQuality(original: string, summary: string): number {
    const coverageRatio = summary.length / Math.max(original.length, 1);
    const hasKeyPoints = /\d+\s*[.。]/.test(summary);
    const decentLength = summary.length > 100 && summary.length < original.length * 0.5;

    let score = 0.5;
    if (coverageRatio > 0.1 && coverageRatio < 0.5) score += 0.2;
    if (hasKeyPoints) score += 0.15;
    if (decentLength) score += 0.15;

    return Math.min(1, score);
  }

  async shouldAutoSend(qualityScore: number, threshold: number = 0.7): Promise<boolean> {
    return qualityScore >= threshold;
  }
}

let modelInstance: PiAIModel | null = null;
/** 2026-09-22 (#3 修复): initPiAI 幂等化 — 配置指纹一致即永远复用, 不再受时间窗口限制.
 *  背景: 上层若每轮 chat 前都调 initPiAI(), 会 clearSystemPromptCache() + 重建 PiAIModel,
 *        导致系统提示词反复装配. 现在: 仅当 provider/model/baseUrl/apiKey 真正变化时才清缓存重建,
 *        KV 友好 (系统提示词装配后保持稳定, 不随 idle 时间抖动). */
let _lastInitFingerprint: string | null = null;
let _lastInitAt = 0;

export interface PiAIConfig {
  provider?: ModelProvider;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

/** 2026-08-07: bolloon-config.json 优先, 旧 llm-config.json 兜底 (迁移期兼容) */
function resolveConfigPath(): string | null {
  const home = process.env.HOME || '/tmp';
  const base = path.join(home, '.bolloon');
  for (const name of ['bolloon-config.json', 'llm-config.json']) {
    const p = path.join(base, name);
    try { if (fs.existsSync(p)) return p; } catch { /* continue */ }
  }
  return null;
}

function detectProvider(): ModelProvider {
  try {
    const configPath = resolveConfigPath();
    if (configPath) {
      const configData = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (configData.activeProvider && configData.providers[configData.activeProvider]) {
        console.log('[PiAIModel] Detected provider from config:', configData.activeProvider);
        return configData.activeProvider;
      }
    }
  } catch {}

  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.OPENROUTER_API_KEY) return 'openrouter';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.OLLAMA_BASE_URL) return 'ollama';
  if (process.env.MINIMAX_API_KEY) return 'minimax';
  if (process.env.DEEPSEEK_API_KEY) return 'deepseek';
  if (process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY) return 'kimi';
  if (process.env.GLM_API_KEY || process.env.ZHIPU_API_KEY) return 'glm';
  if (process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY) return 'qwen';
  if (process.env.MIMO_API_KEY) return 'mimo';
  if (process.env.XAI_API_KEY) return 'grok';

  return 'openai';
}

function detectModel(provider: ModelProvider): string {
  const defaults: Record<ModelProvider, string> = {
    openai: 'gpt-5.6',
    anthropic: 'claude-sonnet-5',
    ollama: 'llama4',
    openrouter: 'anthropic/claude-sonnet-5',
    gemini: 'gemini-3.5-flash',
    minimax: 'MiniMax-M3',
    deepseek: 'deepseek-v4-flash',
    kimi: 'kimi-k3',
    glm: 'glm-5.2',
    qwen: 'qwen3-max',
    mimo: 'mimo-v2.5-pro',
    grok: 'grok-4.5',
    local: 'llama4',
    llamacpp: 'local'
  };
  return defaults[provider];
}

/**
 * 初始化 PiAI. 相同配置 + 短时间窗口内重复调用时, 直接复用现有实例.
 *
 * ⚠️ 上层调用方应把 initPiAI() 放在进程启动阶段执行一次, 而不是每轮 chat 前都调.
 *   虽然这里做了幂等复用, 但若频繁调用且配置变化 (apiKey/baseUrl/model 任一改变),
 *   仍会触发重建 + clearSystemPromptCache, 造成系统提示词反复装配.
 *   排查用: `rg "initPiAI\(" src`
 */
export function initPiAI(config: PiAIConfig = {}): PiAIModel {
  const provider = config.provider || detectProvider();
  let model = config.model || detectModel(provider);

  // 从配置文件兜底读取 apiKey / baseUrl / model (与上次行为一致).
  let apiKey = config.apiKey;
  let baseUrl = config.baseUrl;
  if (!apiKey || !baseUrl || !config.model) {
    try {
      const configPath = resolveConfigPath();
      if (configPath) {
        const configData = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        const providerConfig = configData.providers?.[provider];
        if (providerConfig) {
          if (!apiKey && providerConfig.apiKey) {
            apiKey = providerConfig.apiKey;
          }
          if (!baseUrl && providerConfig.baseUrl) {
            baseUrl = providerConfig.baseUrl;
          }
          if (!config.model && providerConfig.model) {
            model = providerConfig.model;
          }
        }
      }
    } catch (e) {
      console.log('[PiAIModel] Error reading config:', e);
    }
  }

  // 2026-09-22: 幂等复用 — 相同配置 + 30s 窗口内直接返回现有实例.
  // 避免上层每轮 chat 前都 initPiAI() 导致 clearSystemPromptCache + 重建.
  const fingerprint = JSON.stringify({
    provider,
    model,
    baseUrl: baseUrl || '',
    // apiKey 参与指纹 (不同 key 可能连不同账号配额), 但不打印.
    apiKeyHash: apiKey ? createHash('sha256').update(apiKey).digest('hex').slice(0, 8) : '',
  });
  const now = Date.now();
  // 2026-09-22 (#3 修复): 配置指纹一致 → 永远复用, 不再受 30s 窗口限制. 只有
  //   provider/model/baseUrl/apiKey 真正变化时才清缓存 + 重建 (见下方).
  if (modelInstance && _lastInitFingerprint === fingerprint) {
    return modelInstance;
  }

  console.log('[PiAIModel] Initializing with provider:', provider, 'model:', model, 'baseUrl:', baseUrl || '(default)');

  // 配置/provider 变化 → 清空系统提示词缓存, 下一轮重新装配.
  clearSystemPromptCache();

  modelInstance = new PiAIModel({
    provider,
    apiKey,
    baseUrl,
    model
  });

  _lastInitFingerprint = fingerprint;
  _lastInitAt = now;

  console.log('[PiAIModel] Model instance created, provider:', provider, 'baseUrl:', baseUrl);
  return modelInstance;
}

export function getModel(): PiAIModel {
  if (!modelInstance) {
    throw new Error('PiAI not initialized. Call initPiAI first.');
  }
  return modelInstance;
}

export function isModelAvailable(): boolean {
  return modelInstance !== null;
}

export function getMinimax(): PiAIModel {
  return getModel();
}

export function initMinimax(config: PiAIConfig = {}): PiAIModel {
  return initPiAI(config);
}

/** 2026-08-11: 会话级 LLM 错误教训存储 (Hermes error_classifier 模式) — 同类错误只学一次 */
let chatErrorLessons: import('./error-lessons.js').ErrorLessonStore | null = null;

export function getChatErrorLessons(): import('./error-lessons.js').ErrorLessonStore | null {
  return chatErrorLessons;
}

export { PiAIModel as MinimaxLLM };