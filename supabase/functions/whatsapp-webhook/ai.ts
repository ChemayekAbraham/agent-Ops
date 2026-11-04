import { createLovableAiGatewayRunIdFetch } from './run-id.ts';

const BASE_URL = 'https://ai.gateway.lovable.dev/v1';
const MODEL = 'openai/gpt-6-astra';
const MAX_REPLY_CHARS = 4000;

/**
 * One-shot WhatsApp text consumes a streamed gateway result; no account data.
 *
 * The gateway is called directly over its OpenAI-compatible chat completions
 * endpoint — the same way every other edge function reaches it — so this
 * function carries no AI SDK dependency of its own.
 */
export async function buildWhatsAppAiReply(apiKey: string, instructions: string, question: string, signal: AbortSignal) {
  const gateway = createLovableAiGatewayRunIdFetch();
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: `Bearer ${apiKey}`,
      'Lovable-API-Key': apiKey,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: instructions },
        { role: 'user', content: question },
      ],
      stream: true,
    }),
    signal,
  });
  // Never surface the provider's body; keep the status only.
  if (!res.ok || !res.body) throw new Error(`model request failed: ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let pending = '';
  let closed = false;
  while (!closed) {
    const chunk = await reader.read();
    closed = chunk.done;
    pending += decoder.decode(chunk.value, { stream: !closed });
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      const payload = line.trim();
      if (!payload.startsWith('data:')) continue;
      const data = payload.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const json = JSON.parse(data);
        const delta = json?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string') text += delta;
      } catch {
        // Keep-alive or partial frame: nothing to add.
      }
    }
  }

  const answer = text.trim().slice(0, MAX_REPLY_CHARS);
  if (!answer) throw new Error('Empty AI response');
  return answer;
}
