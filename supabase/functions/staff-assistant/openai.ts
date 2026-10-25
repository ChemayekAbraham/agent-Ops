// Single AI provider file for Zoe (My Space Staff Assistant).
// Provider: Lovable AI Gateway (https://ai.gateway.lovable.dev/v1), model google/gemini-3-flash-preview, LOVABLE_API_KEY.

export const AI_GATEWAY_URL = "https://ai.gateway.lovable.dev/v1";
export const DEFAULT_ZOE_MODEL = "google/gemini-3-flash-preview";

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
}): Promise<{ message: ChatMessage; model: string }> {
  const { apiKey, baseUrl, model } = config();
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: opts.maxTokens ?? 450,
      messages: opts.messages,
      ...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools, tool_choice: "auto" } : {}),
    }),
  });

  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`AI provider HTTP ${res.status}: ${detail}`);
  }
  const data = await res.json();
  const message = data?.choices?.[0]?.message as ChatMessage | undefined;
  if (!message) throw new Error("AI provider returned no message");
  return { message, model: data?.model ?? model };
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
