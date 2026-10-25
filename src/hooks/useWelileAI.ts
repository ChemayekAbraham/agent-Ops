import { safeUUID } from '@/lib/safeUUID';
import { useState, useCallback, useRef, useEffect } from 'react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { buildNexaOfflineSalesReply, isNexaHumanEscalationRequest, type NexaLearnedKnowledge } from '@/lib/nexaSalesEngine';

export interface AIChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

const CHAT_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/welile-ai-chat`;

export function useWelileAI() {
  const [messages, setMessages] = useState<AIChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const [learnedKnowledge, setLearnedKnowledge] = useState<NexaLearnedKnowledge[]>([]);
  useEffect(() => {
    let active = true;
    const load = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { if (active) setLearnedKnowledge([]); return; }
      const client = supabase as unknown as { from: (name: string) => any };
      // Cache only non-private general reference data; scoped learning stays server-side.
      const { data, error } = await client.from('nexa_learned_knowledge').select('topic,question_pattern,canonical_answer,role_scope,active').eq('active',true).eq('role_scope','all').limit(20);
      if (active && !error) setLearnedKnowledge(data ?? []);
    };
    void load();
    return () => { active = false; abortRef.current?.abort(); };
  }, []);

  const sendMessage = useCallback(async (input: string) => {
    if (!input.trim() || isLoading) return;

    const userMsg: AIChatMessage = {
      id: safeUUID(),
      role: 'user',
      content: input.trim(),
      created_at: new Date().toISOString(),
    };

    setMessages(prev => [...prev, userMsg]);
    setIsLoading(true);

    const recentMessages = [...messages.slice(-18), userMsg].map(m => ({
      role: m.role,
      content: m.content,
    }));

    let assistantContent = '';
    let httpFailed = false;
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      if (!navigator.onLine) {
        setMessages(prev => [...prev, { id: safeUUID(), role:'assistant', content:buildNexaOfflineSalesReply(input), created_at:new Date().toISOString() }]);
        return;
      }
      const { data: { session } } = await supabase.auth.getSession();
      const resp = await fetch(CHAT_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ messages: recentMessages }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        httpFailed = true;
        const err = await resp.json().catch(() => ({ error: 'Failed' }));
        throw new Error(err.error || `Error ${resp.status}`);
      }

      if (!resp.body) throw new Error('No response body');

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let textBuffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        textBuffer += decoder.decode(value, { stream: true });

        let newlineIndex: number;
        while ((newlineIndex = textBuffer.indexOf('\n')) !== -1) {
          let line = textBuffer.slice(0, newlineIndex);
          textBuffer = textBuffer.slice(newlineIndex + 1);

          if (line.endsWith('\r')) line = line.slice(0, -1);
          if (line.startsWith(':') || line.trim() === '') continue;
          if (!line.startsWith('data: ')) continue;

          const jsonStr = line.slice(6).trim();
          if (jsonStr === '[DONE]') break;

          try {
            const parsed = JSON.parse(jsonStr);
            const content = parsed.choices?.[0]?.delta?.content as string | undefined;
            if (content) {
              assistantContent += content;
              setMessages(prev => {
                const last = prev[prev.length - 1];
                if (last?.role === 'assistant' && last.id === 'streaming') {
                  return prev.map((m, i) => i === prev.length - 1 ? { ...m, content: assistantContent } : m);
                }
                return [...prev, { id: 'streaming', role: 'assistant', content: assistantContent, created_at: new Date().toISOString() }];
              });
            }
          } catch {
            textBuffer = line + '\n' + textBuffer;
            break;
          }
        }
      }

      const finalId = safeUUID();
      setMessages(prev => prev.map(m => m.id === 'streaming' ? { ...m, id: finalId } : m));
    } catch (e: any) {
      if (e.name === 'AbortError') return;
      console.error('Welile AI error:', e);
      toast.error(e.message || 'Failed to get AI response');
      setMessages(prev => prev.filter(m => m.id !== 'streaming'));
      if (!httpFailed && !isNexaHumanEscalationRequest(input) && !assistantContent) {
        setMessages(prev => [...prev, { id:safeUUID(), role:'assistant', content:buildNexaOfflineSalesReply(input), created_at:new Date().toISOString() }]);
      } else if (isNexaHumanEscalationRequest(input)) {
        setMessages(prev => [...prev, { id:safeUUID(), role:'assistant', content:'Your request was not confirmed as sent. Please try again or contact Welile support.', created_at:new Date().toISOString() }]);
      }
    } finally {
      setIsLoading(false);
      abortRef.current = null;
    }
  }, [messages, isLoading]);

  const clearHistory = useCallback(() => {
    setMessages([]);
  }, []);

  const cancelStream = useCallback(() => {
    abortRef.current?.abort();
    setIsLoading(false);
  }, []);

  return { messages, isLoading, sendMessage, clearHistory, cancelStream, historyLoaded: true, learnedKnowledge };
}
