import { supabase } from '@/integrations/supabase/client';
import { buildNexaOfflineSalesReply, buildNexaPublicGuideReply, buildInternalStaffRefusalReply, isRestrictedInternalStaffQuery } from '@/lib/nexaSalesEngine';

type Turn = { role: 'user' | 'assistant'; content: string };

/** Reuse the existing public streaming boundary, never replay private work replies to it. */
export async function requestAssistantPublicReply(turns: Turn[], signal: AbortSignal, onText: (text: string) => void): Promise<string> {
  const input = turns.at(-1)?.content ?? '';
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const { data: { session } } = await supabase.auth.getSession();
  const fallback = () => { const reply = buildNexaOfflineSalesReply(input, !!session); onText(reply); return reply; };
  const guide = isRestrictedInternalStaffQuery(input) ? buildInternalStaffRefusalReply() : buildNexaPublicGuideReply(input, !!session);
  if (guide) { onText(guide); return guide; }
  if (!navigator.onLine) return fallback();
  if (turns.length > 20 || turns.some(turn => turn.content.length > 4000)) throw new Error('This conversation has reached its current limit. Start a new chat to keep asking Welile.');
  let response: Response;
  try {
    response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/welile-ai-chat`, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}) },
      body: JSON.stringify({ messages: turns }),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    return fallback();
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || body.error || `Welile Assistant is unavailable (${response.status}).`);
  }
  if (!response.body) return fallback();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = ''; let content = '';
  const consume = (line: string) => {
    if (!line.startsWith('data:')) return;
    const value = line.slice(5).trim();
    if (!value || value === '[DONE]') return;
    const event = JSON.parse(value);
    if (event.error) throw new Error(typeof event.error === 'string' ? event.error : event.error.message || 'Welile Assistant could not complete this reply.');
    const delta = event.choices?.[0]?.delta?.content;
    if (delta) { content += delta; onText(content); }
  };
  try {
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
    for (const line of lines) consume(line.trimEnd());
  }
  if (buffer.trim()) consume(buffer.trimEnd());
  } catch (error) {
    // Transport/parser failures may use local guidance. Explicit service errors/refusals stay visible.
    if (signal.aborted || (error instanceof Error && !(error instanceof SyntaxError) && !(error instanceof TypeError))) throw error;
    return fallback();
  } finally { reader.releaseLock(); }
  if (!content.trim()) throw new Error('Welile Assistant returned no answer. Please contact support.');
  return content;
}