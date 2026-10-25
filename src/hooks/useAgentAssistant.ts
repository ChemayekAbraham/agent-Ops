import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { safeUUID } from '@/lib/safeUUID';
import { useAuth } from '@/hooks/useAuth';
import { captureSmartLocation } from '@/hooks/useSmartLocation';
import { isPersonalAgentWorkQuery, acceptsPersonalAnswer } from '@/lib/assistantRouting';
import { requestAssistantPublicReply } from './assistantPublicReply';
import { toAuthGatedUrl } from '@/lib/nexaSalesEngine';

/**
 * Data hook for the agent assistant (read-only personal assistant). Logic only; presentation is
 * the chat component's job.
 *
 * Personal work uses agent-assistant with server-owned history and JWT checks. Public turns
 * use the existing Nexa boundary with a separate complete public transcript; private replies
 * never enter that transcript. No client-provided role or user id can authorize account reads.
 */

export type AssistantOutcome =
  | 'answered'
  | 'clarify'
  | 'out_of_scope'
  | 'not_an_agent'
  | 'unmatched'
  | 'rate_limited'
  | 'blocked'
  | 'not_enabled'
  | 'error';

export interface AssistantMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  outcome?: AssistantOutcome;
  /** Tappable answers when the assistant asks a clarifying question. */
  quickReplies?: string[];
  /** True when the UI should offer "send this to support". */
  escalationOffered?: boolean;
}

interface AssistantResponse {
  conversation_id?: string;
  reply?: string;
  outcome?: AssistantOutcome;
  quick_replies?: string[];
  escalation_offered?: boolean;
  error?: string;
}

const FALLBACK_ERROR = "I'm having trouble right now. Please try again in a moment.";
const MAX_MESSAGE_LENGTH = 500;

export type LocationStatus = 'idle' | 'requesting' | 'granted' | 'denied' | 'unavailable';

interface ReportedGeo {
  lat: number;
  lng: number;
  accuracy_m?: number;
}

/**
 * Device details reported to the CRM log. The server also records the IP and user agent itself;
 * what is sent here is a client-reported hint and is treated as untrusted on the server.
 */
function collectDevice() {
  if (typeof navigator === 'undefined') return undefined;
  let timezone: string | undefined;
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    /* not available */
  }
  return {
    platform: navigator.platform?.slice(0, 40) || undefined,
    language: navigator.language?.slice(0, 20) || undefined,
    timezone: timezone?.slice(0, 60),
    screen_w: typeof screen !== 'undefined' ? Math.round(screen.width) : undefined,
    screen_h: typeof screen !== 'undefined' ? Math.round(screen.height) : undefined,
    pixel_ratio: typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 10) : undefined,
    touch: typeof navigator.maxTouchPoints === 'number' ? navigator.maxTouchPoints > 0 : undefined,
  };
}

/** supabase-js hides the JSON body of non-2xx replies inside `error.context`; recover it. */
async function readResponse(data: unknown, error: unknown): Promise<AssistantResponse> {
  if (!error) return (data ?? {}) as AssistantResponse;
  const ctx = (error as { context?: unknown }).context;
  if (ctx instanceof Response) {
    try {
      return (await ctx.clone().json()) as AssistantResponse;
    } catch {
      /* fall through */
    }
  }
  return { reply: FALLBACK_ERROR, outcome: 'error' };
}

export function useAgentAssistant() {
  const { user } = useAuth();
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [escalated, setEscalated] = useState(false);
  const [locationStatus, setLocationStatus] = useState<LocationStatus>('idle');
  const conversationIdRef = useRef<string | undefined>(undefined);
  const inFlightRef = useRef(false);
  const generationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const publicHistoryRef = useRef<{ role: 'user' | 'assistant'; content: string }[]>([]);
  // Latest GPS fix, kept in memory only. Never written to storage.
  const geoRef = useRef<ReportedGeo | undefined>(undefined);

  /**
   * Ask the browser for the agent's location. Must be called from a user action (a tap on
   * "Share my location") so the permission prompt is consented to. The assistant works fine
   * without it; a denial only leaves the GPS fields empty in the CRM log.
   */
  const requestLocation = useCallback(async () => {
    setLocationStatus('requesting');
    const generation = generationRef.current;
    const result = await captureSmartLocation();
    if (generation !== generationRef.current) return;
    if (result.ok === true) {
      geoRef.current = { lat: result.latitude, lng: result.longitude, accuracy_m: result.accuracy };
      setLocationStatus('granted');
    } else setLocationStatus(result.reason === 'denied' ? 'denied' : 'unavailable');
  }, []);

  const append = useCallback((m: Omit<AssistantMessage, 'id'>) => {
    setMessages((prev) => [...prev, { id: safeUUID(), ...m }]);
  }, []);

  const send = useCallback(
    async (text: string) => {
      const message = text.trim().slice(0, MAX_MESSAGE_LENGTH);
      if (!message || inFlightRef.current) return;
      inFlightRef.current = true;
      setIsLoading(true);
      append({ role: 'user', content: message });
      const generation = generationRef.current;
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        if (user?.id && isPersonalAgentWorkQuery(message)) {
        const { data, error } = await supabase.functions.invoke('agent-assistant', {
          body: {
            action: 'message',
            message,
            ...(conversationIdRef.current ? { conversation_id: conversationIdRef.current } : {}),
            client_context: { device: collectDevice(), ...(geoRef.current ? { geo: geoRef.current } : {}) },
          },
        }).catch(() => ({ data: null, error: new Error(FALLBACK_ERROR) }));
        const res = await readResponse(data, error);
        if (generation !== generationRef.current) return;
        if (res.conversation_id) {
          if (res.conversation_id !== conversationIdRef.current) setEscalated(false);
          conversationIdRef.current = res.conversation_id;
        }
        if (!error && acceptsPersonalAnswer(res)) { append({
          role: 'assistant',
          content: res.reply ?? (res.error || FALLBACK_ERROR),
          outcome: res.outcome ?? 'error',
          quickReplies: res.quick_replies?.length ? res.quick_replies : undefined,
          escalationOffered: res.escalation_offered ?? false,
        }); return; }
        }
        const turns = [...publicHistoryRef.current, { role: 'user' as const, content: message }];
        const replyId = safeUUID();
        const reply = await requestAssistantPublicReply(turns, controller.signal, (content) => {
          if (generation !== generationRef.current) return;
          setMessages(previous => previous.some(turn => turn.id === replyId)
            ? previous.map(turn => turn.id === replyId ? { ...turn, content } : turn)
            : [...previous, { id: replyId, role: 'assistant', content, outcome: 'answered' }]);
        });
        if (generation === generationRef.current) publicHistoryRef.current = [...turns, { role: 'assistant', content: reply }];
      } catch (error) {
        if (generation === generationRef.current && !controller.signal.aborted) append({ role: 'assistant', content: error instanceof Error ? error.message : FALLBACK_ERROR, outcome: 'error', escalationOffered: true });
      } finally {
        if (generation === generationRef.current) {
        inFlightRef.current = false;
        setIsLoading(false);
        abortRef.current = null;
        }
      }
    },
    [append, user?.id],
  );

  /** Send the current conversation to the support (CRM) team. */
  const escalate = useCallback(
    async (note?: string) => {
      const conversationId = conversationIdRef.current;
      if (inFlightRef.current) return;
      if (!user || !conversationId) {
        append({ role: 'assistant', content: `Contact [Welile support](https://wa.me/256777607640) to share your conversation. For private account help, [sign in first](${toAuthGatedUrl('/dashboard')}).`, outcome: 'answered' });
        return;
      }
      inFlightRef.current = true;
      setIsLoading(true);
      const generation = generationRef.current;
      try {
        const { data, error } = await supabase.functions.invoke('agent-assistant', {
          body: {
            action: 'escalate',
            conversation_id: conversationId,
            ...(note?.trim() ? { note: note.trim().slice(0, 1000) } : {}),
          },
        });
        const res = await readResponse(data, error);
        if (generation !== generationRef.current) return;
        if (!error) setEscalated(true);
        append({
          role: 'assistant',
          content: res.reply ?? (res.error || FALLBACK_ERROR),
          outcome: res.outcome ?? (error ? 'error' : 'answered'),
          escalationOffered: false,
        });
      } catch {
        if (generation === generationRef.current) append({ role: 'assistant', content: FALLBACK_ERROR, outcome: 'error', escalationOffered: false });
      } finally {
        if (generation === generationRef.current) {
        inFlightRef.current = false;
        setIsLoading(false);
        }
      }
    },
    [append, user],
  );

  /** Start over locally. The server also rotates sessions after 30 idle minutes. */
  const reset = useCallback(() => {
    generationRef.current += 1;
    abortRef.current?.abort();
    inFlightRef.current = false;
    publicHistoryRef.current = [];
    geoRef.current = undefined;
    conversationIdRef.current = undefined;
    setMessages([]);
    setEscalated(false);
    setIsLoading(false);
    setLocationStatus('idle');
  }, []);

  useEffect(() => { reset(); return () => { generationRef.current += 1; abortRef.current?.abort(); }; }, [user?.id, reset]);

  return { messages, isLoading, escalated, locationStatus, requestLocation, send, escalate, reset };
}
