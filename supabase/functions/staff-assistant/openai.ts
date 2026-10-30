// OpenAI-compatible client for the My Space Staff AI Assistant (Zoe).
// Provider: Lovable AI Gateway (https://ai.gateway.lovable.dev/v1), LOVABLE_API_KEY.
// Model tiers: ZOE_MODEL_FAST and ZOE_MODEL_DEEP configured in `public.staff_assistant_config`.

export const AI_GATEWAY_URL = "https://ai.gateway.lovable.dev/v1";
export const DEFAULT_ZOE_MODEL_FAST = "google/gemini-2.5-flash";
export const DEFAULT_ZOE_MODEL_DEEP = "google/gemini-2.5-pro";
export const DEFAULT_ZOE_MODEL = "google/gemini-3-flash-preview";

export const DEFAULT_CHAT_TEMPERATURE = 0.2;
export const DEFAULT_CHAT_MAX_TOKENS = 3200;
export const DEFAULT_MAX_COST_USD_PER_QUESTION = 0.08;
export const MAX_FAST_MODEL_ROUNDS = 4;
export const MAX_FAST_TOOL_CALLS = 6;
export const MAX_DEEP_MODEL_ROUNDS = 8;
export const MAX_DEEP_TOOL_CALLS = 12;

export const AI_CALL_TIMEOUT_MS = 22_000;
export const AI_MAX_RETRIES = 1;

export interface ZoeModelTierConfig {
  modelFast?: string;
  modelDeep?: string;
  temperature?: number;
  maxTokens?: number;
  maxCostUsdPerQuestion?: number;
  maxFastModelRounds?: number;
  maxFastToolCalls?: number;
  maxDeepModelRounds?: number;
  maxDeepToolCalls?: number;
  researchMode?: boolean;
}

export interface SelectedModelTier {
  tier: "fast" | "deep";
  model: string;
  temperature: number;
  maxTokens: number;
  maxCostUsdPerQuestion: number;
  maxModelRounds: number;
  maxToolCalls: number;
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  estimatedCostUsd: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  name?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenAiTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export class AiGatewayError extends Error {
  readonly status: number;
  readonly code: "RATE_LIMITED" | "CREDITS_EXHAUSTED" | "TIMEOUT" | "UPSTREAM";

  constructor(
    message: string,
    status: number,
    code: "RATE_LIMITED" | "CREDITS_EXHAUSTED" | "TIMEOUT" | "UPSTREAM",
  ) {
    super(message);
    this.name = "AiGatewayError";
    this.status = status;
    this.code = code;
  }
}

const DEEP_REASONING_RE =
  /\b(why\b|analy[sz]e|analysis|compare|comparison|versus|\bvs\.?\b|trend|trends|advice|advise|recommend|recommendation|suggest|suggestion|improve|improvement|bottleneck|anomal(?:y|ies)|root\s+cause|explain\s+why|what\s+drove|what\s+caused|difference\s+between|how\s+can\s+we|what\s+should\s+we|way\s+forward|plan\s+review|review\s+(?:this|my|our)\s+plan|research|deep\s+dive|correlat|forecast\s+vs|week[\s-]+on[\s-]+week|month[\s-]+on[\s-]+month)\b/i;

/**
 * Determines whether a staff question asks for analysis, comparison, research, advice, or "why"
 * and therefore warrants the deep model tier (`ZOE_MODEL_DEEP`) and multi-step limits.
 */
export function isDeepQuestion(userMessage: string, researchMode = false): boolean {
  if (researchMode) return true;
  const cleaned = (userMessage ?? "").trim();
  if (!cleaned) return false;
  return DEEP_REASONING_RE.test(cleaned);
}

function readEnvSafe(key: string): string | undefined {
  try {
    if (typeof Deno !== "undefined" && typeof Deno.env?.get === "function") {
      const val = Deno.env.get(key)?.trim();
      return val || undefined;
    }
  } catch {
    /* ignore env access error in restricted test sandboxes */
  }
  return undefined;
}

/**
 * Selects the fast or deep model tier and per-question loop budgets from
 * `staff_assistant_config` (with `ZOE_MODEL_FAST` / `ZOE_MODEL_DEEP` env overrides).
 */
export function selectModelTier(
  userMessage: string,
  config?: ZoeModelTierConfig,
): SelectedModelTier {
  const deep = isDeepQuestion(userMessage, Boolean(config?.researchMode));
  const fastModel =
    config?.modelFast?.trim() ||
    readEnvSafe("ZOE_MODEL_FAST") ||
    DEFAULT_ZOE_MODEL_FAST;
  const deepModel =
    config?.modelDeep?.trim() ||
    readEnvSafe("ZOE_MODEL_DEEP") ||
    DEFAULT_ZOE_MODEL_DEEP;

  const temperature =
    typeof config?.temperature === "number" &&
      Number.isFinite(config.temperature) &&
      config.temperature >= 0 &&
      config.temperature <= 1
      ? config.temperature
      : DEFAULT_CHAT_TEMPERATURE;

  const maxTokens =
    typeof config?.maxTokens === "number" &&
      Number.isFinite(config.maxTokens) &&
      config.maxTokens >= 256
      ? Math.min(Math.trunc(config.maxTokens), 8192)
      : DEFAULT_CHAT_MAX_TOKENS;

  const maxCostUsdPerQuestion =
    typeof config?.maxCostUsdPerQuestion === "number" &&
      Number.isFinite(config.maxCostUsdPerQuestion) &&
      config.maxCostUsdPerQuestion > 0
      ? Math.min(config.maxCostUsdPerQuestion, 1.0)
      : DEFAULT_MAX_COST_USD_PER_QUESTION;

  const fastRounds = Math.min(
    Math.max(config?.maxFastModelRounds ?? MAX_FAST_MODEL_ROUNDS, 1),
    8,
  );
  const fastTools = Math.min(
    Math.max(config?.maxFastToolCalls ?? MAX_FAST_TOOL_CALLS, 1),
    12,
  );
  const deepRounds = Math.min(
    Math.max(config?.maxDeepModelRounds ?? MAX_DEEP_MODEL_ROUNDS, fastRounds),
    12,
  );
  const deepTools = Math.min(
    Math.max(config?.maxDeepToolCalls ?? MAX_DEEP_TOOL_CALLS, fastTools),
    20,
  );

  return {
    tier: deep ? "deep" : "fast",
    model: deep ? deepModel : fastModel,
    temperature,
    maxTokens,
    maxCostUsdPerQuestion,
    maxModelRounds: deep ? deepRounds : fastRounds,
    maxToolCalls: deep ? deepTools : fastTools,
  };
}

/**
 * Estimates the USD cost of a single gateway call from token usage, accounting for
 * 75% discounted prompt cache hits (`cachedTokens`).
 */
export function estimateCallCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
  cachedTokens = 0,
): number {
  const m = (model || "").toLowerCase();
  let inputPer1M = 0.15;
  let outputPer1M = 0.60;
  if (m.includes("pro") || (m.includes("gpt-5") && !m.includes("mini") && !m.includes("nano"))) {
    inputPer1M = 1.25;
    outputPer1M = 5.0;
  } else if (m.includes("gpt-5-mini")) {
    inputPer1M = 0.25;
    outputPer1M = 2.0;
  }

  const safePrompt = Math.max(0, promptTokens);
  const safeCached = Math.min(Math.max(0, cachedTokens), safePrompt);
  const uncachedPrompt = safePrompt - safeCached;
  const safeCompletion = Math.max(0, completionTokens);

  const cost =
    (uncachedPrompt / 1_000_000) * inputPer1M +
    (safeCached / 1_000_000) * (inputPer1M * 0.25) +
    (safeCompletion / 1_000_000) * outputPer1M;

  return Number(cost.toFixed(6));
}

function getGatewayConfig(explicitModel?: string) {
  const apiKey = readEnvSafe("LOVABLE_API_KEY");
  if (!apiKey) {
    throw new AiGatewayError("LOVABLE_API_KEY is not configured", 500, "UPSTREAM");
  }
  const model =
    explicitModel?.trim() ||
    readEnvSafe("ZOE_MODEL_FAST") ||
    readEnvSafe("ZOE_MODEL") ||
    DEFAULT_ZOE_MODEL_FAST;
  return { apiKey, model, baseUrl: AI_GATEWAY_URL };
}

async function postChatCompletions(
  apiKey: string,
  baseUrl: string,
  body: Record<string, unknown>,
  externalSignal?: AbortSignal,
): Promise<Record<string, unknown>> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= AI_MAX_RETRIES; attempt++) {
    if (externalSignal?.aborted) {
      throw new AiGatewayError("Generation stopped by user", 499, "TIMEOUT");
    }
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), AI_CALL_TIMEOUT_MS);

    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (res.status === 429) {
        throw new AiGatewayError("AI Gateway rate limited", 429, "RATE_LIMITED");
      }
      if (res.status === 402) {
        throw new AiGatewayError("AI Gateway credits exhausted", 402, "CREDITS_EXHAUSTED");
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        if (res.status >= 500 && attempt < AI_MAX_RETRIES) {
          lastError = new AiGatewayError(
            `AI Gateway HTTP ${res.status}: ${text.slice(0, 200)}`,
            res.status,
            "UPSTREAM",
          );
          continue;
        }
        throw new AiGatewayError(
          `AI Gateway HTTP ${res.status}: ${text.slice(0, 200)}`,
          res.status,
          "UPSTREAM",
        );
      }

      return (await res.json()) as Record<string, unknown>;
    } catch (err) {
      if (err instanceof AiGatewayError) {
        throw err;
      }
      if (externalSignal?.aborted) {
        throw new AiGatewayError("Generation stopped by user", 499, "TIMEOUT");
      }
      const isAbort = err instanceof DOMException && err.name === "AbortError";
      if (isAbort && attempt < AI_MAX_RETRIES) {
        lastError = new AiGatewayError("AI Gateway timed out", 504, "TIMEOUT");
        continue;
      }
      if (isAbort) {
        throw new AiGatewayError("AI Gateway timed out", 504, "TIMEOUT");
      }
      lastError = err;
      if (attempt >= AI_MAX_RETRIES) {
        throw new AiGatewayError(
          err instanceof Error ? err.message : "AI Gateway request failed",
          502,
          "UPSTREAM",
        );
      }
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }
  }

  throw lastError instanceof AiGatewayError
    ? lastError
    : new AiGatewayError("AI Gateway request failed", 502, "UPSTREAM");
}

function parseGatewayUsage(rawUsage: unknown, model: string): ChatUsage {
  const u = rawUsage && typeof rawUsage === "object" ? (rawUsage as Record<string, unknown>) : {};
  const promptTokens = typeof u.prompt_tokens === "number" ? u.prompt_tokens : 0;
  const completionTokens = typeof u.completion_tokens === "number" ? u.completion_tokens : 0;
  const totalTokens =
    typeof u.total_tokens === "number" ? u.total_tokens : promptTokens + completionTokens;
  const details =
    u.prompt_tokens_details && typeof u.prompt_tokens_details === "object"
      ? (u.prompt_tokens_details as Record<string, unknown>)
      : {};
  const cachedTokens = typeof details.cached_tokens === "number" ? details.cached_tokens : 0;

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cachedTokens,
    estimatedCostUsd: estimateCallCostUsd(model, promptTokens, completionTokens, cachedTokens),
  };
}

/**
 * Cheap JSON-only classification call (no tools). Returns raw content string.
 */
export async function classifyText(
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  const { apiKey, model, baseUrl } = getGatewayConfig();
  const data = await postChatCompletions(apiKey, baseUrl, {
    model,
    temperature: 0,
    max_tokens: 80,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
  });
  const choices = data.choices as Array<{ message?: { content?: string } }> | undefined;
  return choices?.[0]?.message?.content ?? "{}";
}

export async function chatCompletion(opts: {
  messages: ChatMessage[];
  tools?: OpenAiTool[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}): Promise<{ message: ChatMessage; model: string; usage?: ChatUsage }> {
  const { apiKey, model, baseUrl } = getGatewayConfig(opts.model);
  const temperature =
    typeof opts.temperature === "number" ? opts.temperature : DEFAULT_CHAT_TEMPERATURE;
  const maxTokens =
    typeof opts.maxTokens === "number" ? opts.maxTokens : DEFAULT_CHAT_MAX_TOKENS;

  const body: Record<string, unknown> = {
    model,
    temperature,
    max_tokens: maxTokens,
    messages: opts.messages,
  };
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools;
    body.tool_choice = "auto";
  }

  const data = await postChatCompletions(apiKey, baseUrl, body, opts.signal);
  const choices = data.choices as Array<{ message?: ChatMessage }> | undefined;
  const msg = choices?.[0]?.message;
  if (!msg) {
    throw new AiGatewayError("AI Gateway returned an empty response", 502, "UPSTREAM");
  }
  const resolvedModel = (data.model as string | undefined) ?? model;
  const usage = parseGatewayUsage(data.usage, resolvedModel);
  return { message: msg, model: resolvedModel, usage };
}

/**
 * Deliverable (2): Real token streaming from the AI Gateway (`stream: true`).
 * Forwards `AbortSignal` so clicking Stop in the browser cancels the upstream
 * model call immediately. Emits each token delta via `onTokenDelta` as it arrives,
 * while also assembling any streamed `tool_calls` and final `usage`.
 * Falls back gracefully if a test mock returns a non-stream JSON response.
 */
export async function chatCompletionStream(opts: {
  messages: ChatMessage[];
  tools?: OpenAiTool[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  onTokenDelta?: (delta: string, accumulated: string) => void;
}): Promise<{ message: ChatMessage; model: string; usage?: ChatUsage }> {
  const { apiKey, model, baseUrl } = getGatewayConfig(opts.model);
  const temperature =
    typeof opts.temperature === "number" ? opts.temperature : DEFAULT_CHAT_TEMPERATURE;
  const maxTokens =
    typeof opts.maxTokens === "number" ? opts.maxTokens : DEFAULT_CHAT_MAX_TOKENS;

  if (opts.signal?.aborted) {
    throw new AiGatewayError("Generation stopped by user", 499, "TIMEOUT");
  }

  const body: Record<string, unknown> = {
    model,
    temperature,
    max_tokens: maxTokens,
    stream: true,
    messages: opts.messages,
  };
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools;
    body.tool_choice = "auto";
  }

  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onExternalAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), AI_CALL_TIMEOUT_MS);

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (res.status === 429) {
      throw new AiGatewayError("AI Gateway rate limited", 429, "RATE_LIMITED");
    }
    if (res.status === 402) {
      throw new AiGatewayError("AI Gateway credits exhausted", 402, "CREDITS_EXHAUSTED");
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new AiGatewayError(
        `AI Gateway HTTP ${res.status}: ${text.slice(0, 200)}`,
        res.status,
        "UPSTREAM",
      );
    }

    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    // If upstream (or a unit test mock) returned JSON instead of text/event-stream:
    if (!contentType.includes("text/event-stream") || !res.body) {
      const data = (await res.json()) as Record<string, unknown>;
      const choices = data.choices as Array<{ message?: ChatMessage }> | undefined;
      const msg = choices?.[0]?.message;
      if (!msg) {
        throw new AiGatewayError("AI Gateway returned an empty response", 502, "UPSTREAM");
      }
      if (typeof msg.content === "string" && msg.content.length > 0) {
        opts.onTokenDelta?.(msg.content, msg.content);
      }
      const resolvedModel = (data.model as string | undefined) ?? model;
      const usage = parseGatewayUsage(data.usage, resolvedModel);
      return { message: msg, model: resolvedModel, usage };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = "";
    let accumulatedContent = "";
    let resolvedModel = model;
    let rawUsage: unknown = undefined;
    const toolCallsByIndex = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();

    while (true) {
      if (opts.signal?.aborted) {
        await reader.cancel().catch(() => {});
        throw new AiGatewayError("Generation stopped by user", 499, "TIMEOUT");
      }
      const { value, done } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });

      let newlineIdx: number;
      while ((newlineIdx = sseBuffer.indexOf("\n")) >= 0) {
        const rawLine = sseBuffer.slice(0, newlineIdx).trim();
        sseBuffer = sseBuffer.slice(newlineIdx + 1);
        if (!rawLine || !rawLine.startsWith("data:")) continue;
        const payloadStr = rawLine.slice(5).trim();
        if (!payloadStr || payloadStr === "[DONE]") continue;

        try {
          const chunk = JSON.parse(payloadStr) as Record<string, unknown>;
          if (typeof chunk.model === "string" && chunk.model) {
            resolvedModel = chunk.model;
          }
          if (chunk.usage) {
            rawUsage = chunk.usage;
          }
          const choices = chunk.choices as
            | Array<{
                delta?: {
                  content?: string | null;
                  tool_calls?: Array<{
                    index?: number;
                    id?: string;
                    function?: { name?: string; arguments?: string };
                  }>;
                };
              }>
            | undefined;
          const delta = choices?.[0]?.delta;
          if (!delta) continue;

          if (typeof delta.content === "string" && delta.content.length > 0) {
            accumulatedContent += delta.content;
            opts.onTokenDelta?.(delta.content, accumulatedContent);
          }

          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = typeof tc.index === "number" ? tc.index : 0;
              const existing = toolCallsByIndex.get(idx) ?? {
                id: tc.id || `call_${idx}`,
                name: "",
                arguments: "",
              };
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) existing.name += tc.function.name;
              if (tc.function?.arguments) existing.arguments += tc.function.arguments;
              toolCallsByIndex.set(idx, existing);
            }
          }
        } catch {
          /* ignore malformed SSE line */
        }
      }
    }

    const assembledToolCalls: ToolCall[] = [...toolCallsByIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .filter(([, tc]) => Boolean(tc.name))
      .map(([, tc]) => ({
        id: tc.id,
        type: "function" as const,
        function: {
          name: tc.name,
          arguments: tc.arguments || "{}",
        },
      }));

    const message: ChatMessage = {
      role: "assistant",
      content: accumulatedContent || null,
      ...(assembledToolCalls.length > 0 ? { tool_calls: assembledToolCalls } : {}),
    };

    const usage = rawUsage
      ? parseGatewayUsage(rawUsage, resolvedModel)
      : parseGatewayUsage(
          {
            prompt_tokens: Math.ceil(JSON.stringify(opts.messages).length / 4),
            completion_tokens: Math.ceil(accumulatedContent.length / 4),
          },
          resolvedModel,
        );

    return { message, model: resolvedModel, usage };
  } catch (err) {
    if (err instanceof AiGatewayError) throw err;
    if (opts.signal?.aborted) {
      throw new AiGatewayError("Generation stopped by user", 499, "TIMEOUT");
    }
    const isAbort = err instanceof DOMException && err.name === "AbortError";
    if (isAbort) {
      throw new AiGatewayError("AI Gateway timed out", 504, "TIMEOUT");
    }
    throw new AiGatewayError(
      err instanceof Error ? err.message : "AI Gateway stream failed",
      502,
      "UPSTREAM",
    );
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onExternalAbort);
  }
}
