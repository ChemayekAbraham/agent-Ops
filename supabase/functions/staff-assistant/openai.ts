// Single AI provider file for Zoe (My Space Staff Assistant).
// Provider: Lovable AI Gateway (https://ai.gateway.lovable.dev/v1), model google/gemini-3-flash-preview, LOVABLE_API_KEY.

export const AI_GATEWAY_URL = "https://ai.gateway.lovable.dev/v1";
export const DEFAULT_ZOE_MODEL = "google/gemini-3-flash-preview";
export const AI_CALL_TIMEOUT_MS = 20_000;
export const AI_MAX_RETRIES = 1;

export class AiGatewayError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail: string,
  ) {
    super(`AI provider HTTP ${status}: ${detail}`);
    this.name = "AiGatewayError";
  }
}

function config() {
  const apiKey = Deno.env.get("LOVABLE_API_KEY");
  if (!apiKey) throw new Error("LOVABLE_API_KEY is not configured");
  const baseUrl = (Deno.env.get("AI_BASE_URL") ?? AI_GATEWAY_URL).replace(/\/+$/, "");
  const model = Deno.env.get("ZOE_ASSISTANT_MODEL") ?? DEFAULT_ZOE_MODEL;
  return { apiKey, baseUrl, model };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
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

export async function chatCompletion(opts: {
  messages: ChatMessage[];
  tools?: OpenAiTool[];
  maxTokens?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<{ message: ChatMessage; model: string }> {
  const { apiKey, baseUrl, model } = config();
  const timeoutMs = opts.timeoutMs ?? AI_CALL_TIMEOUT_MS;
  const doFetch = opts.fetchImpl ?? fetch;

  let lastErr: unknown = null;

  for (let attempt = 0; attempt <= AI_MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("AI call timed out after 20s"), timeoutMs);

    try {
      const res = await doFetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: opts.maxTokens ?? 1800,
          messages: opts.messages,
          ...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools, tool_choice: "auto" } : {}),
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const detail = (await res.text().catch(() => "")).slice(0, 200);
        const gatewayErr = new AiGatewayError(res.status, detail);
        // Retry once on transient 5xx or 429; never retry 402 (out of credit) or 4xx client errors
        if ((res.status >= 500 || res.status === 429) && attempt < AI_MAX_RETRIES) {
          lastErr = gatewayErr;
          continue;
        }
        throw gatewayErr;
      }

      const data = await res.json();
      const message = data?.choices?.[0]?.message as ChatMessage | undefined;
      if (!message) throw new Error("AI provider returned no message");
      return { message, model: data?.model ?? model };
    } catch (err) {
      lastErr = err;
      if (err instanceof AiGatewayError) {
        if ((err.status >= 500 || err.status === 429) && attempt < AI_MAX_RETRIES) {
          continue;
        }
        throw err;
      }
      // Timeout / network error: retry once
      if (attempt < AI_MAX_RETRIES) {
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error("AI call failed");
}

/** Cheap single-shot JSON classification call with no tools and a tiny token cap. */
export async function classifyText(systemPrompt: string, userMessage: string): Promise<string> {
  const { message } = await chatCompletion({
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    maxTokens: 40,
  });
  return message.content ?? "";
}
