/**
 * The model behind the assistant. This is the ONLY file that knows which provider is in use, so
 * moving from OpenAI to a self-hosted model is a config change: point OPENAI_BASE_URL at any
 * OpenAI-compatible endpoint (vLLM, Ollama, ...) and set OPENAI_MODEL.
 *
 *   OPENAI_API_KEY   required (a Supabase secret; never in the frontend, never in .env)
 *   OPENAI_MODEL     default gpt-4o-mini
 *   OPENAI_BASE_URL  default https://api.openai.com/v1
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ModelReply {
  message: ChatMessage;
  model: string;
}

export class ModelError extends Error {}

const TIMEOUT_MS = 25_000;

function config() {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) throw new ModelError("OPENAI_API_KEY is not configured");
  return {
    apiKey,
    model: Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini",
    baseUrl: (Deno.env.get("OPENAI_BASE_URL") || "https://api.openai.com/v1").replace(/\/+$/, ""),
  };
}

export async function callModel(opts: {
  messages: ChatMessage[];
  tools?: unknown[];
  json?: boolean;
  maxTokens?: number;
}): Promise<ModelReply> {
  const { apiKey, model, baseUrl } = config();
  const body: Record<string, unknown> = {
    model,
    messages: opts.messages,
    temperature: 0,
    max_tokens: opts.maxTokens ?? 400,
  };
  if (opts.tools?.length) {
    body.tools = opts.tools;
    body.tool_choice = "auto";
  }
  if (opts.json) body.response_format = { type: "json_object" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      // Never surface the provider's body to the client; keep status only for our logs.
      throw new ModelError(`model request failed: ${res.status}`);
    }
    const json = await res.json();
    const message = json?.choices?.[0]?.message;
    if (!message) throw new ModelError("model returned no message");
    return { message, model: json.model ?? model };
  } catch (e) {
    if (e instanceof ModelError) throw e;
    throw new ModelError(e instanceof Error ? e.message : "model request failed");
  } finally {
    clearTimeout(timer);
  }
}
