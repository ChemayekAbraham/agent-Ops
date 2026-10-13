/**
 * The model behind the assistant. This is the ONLY file that knows which provider is in use.
 * It calls the Lovable AI Gateway (OpenAI-compatible chat completions) with LOVABLE_API_KEY.
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
  // Lovable AI Gateway (built in, billed to workspace credits; no third-party key needed).
  const apiKey = Deno.env.get("LOVABLE_API_KEY");
  if (!apiKey) throw new ModelError("LOVABLE_API_KEY is not configured");
  return {
    apiKey,
    model: "google/gemini-3-flash-preview",
    baseUrl: "https://ai.gateway.lovable.dev/v1",
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
    max_tokens: opts.maxTokens ?? 1500,
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
