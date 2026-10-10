import { useCallback, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { safeUUID } from '@/lib/safeUUID';

/**
 * Data hook for the agent assistant (read-only personal assistant). Logic only; presentation is
 * the chat component's job.
 *
 * Everything goes through the `agent-assistant` edge function. The client sends ONLY the new
 * message and the server-issued conversation id: no history, role, persona or user id. The
 * server verifies the JWT, gates on agent status, owns the history and logs for the CRM.
 */

export type AssistantOutcome =
  | 'answered'
  | 'clarify'
  | 'out_of_scope'
  | 'not_an_agent'
  | 'unmatched'
  | 'rate_limited'
  | 'blocked'
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
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [escalated, setEscalated] = useState(false);
  const [locationStatus, setLocationStatus] = useState<LocationStatus>('idle');
  const conversationIdRef = useRef<string | undefined>(undefined);
  const inFlightRef = useRef(false);
  // Latest GPS fix, kept in memory only. Never written to storage.
  const geoRef = useRef<ReportedGeo | undefined>(undefined);

  /**
   * Ask the browser for the agent's location. Must be called from a user action (a tap on
   * "Share my location") so the permission prompt is consented to. The assistant works fine
   * without it; a denial only leaves the GPS fields empty in the CRM log.
   */
  const requestLocation = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setLocationStatus('unavailable');
      return;
    }
    setLocationStatus('requesting');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        geoRef.current = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy_m: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : undefined,
        };
        setLocationStatus('granted');
      },
      (err) => setLocationStatus(err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable'),
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 },
    );
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

      try {
        const { data, error } = await supabase.functions.invoke('agent-assistant', {
          body: {
            action: 'message',
            message,
            ...(conversationIdRef.current ? { conversation_id: conversationIdRef.current } : {}),
            client_context: { device: collectDevice(), ...(geoRef.current ? { geo: geoRef.current } : {}) },
          },
        });
        const res = await readResponse(data, error);
        if (res.conversation_id) {
          if (res.conversation_id !== conversationIdRef.current) setEscalated(false);
          conversationIdRef.current = res.conversation_id;
        }
        append({
          role: 'assistant',
          content: res.reply ?? (res.error || FALLBACK_ERROR),
          outcome: res.outcome ?? 'error',
          quickReplies: res.quick_replies?.length ? res.quick_replies : undefined,
          escalationOffered: res.escalation_offered ?? false,
        });
      } catch {
        append({ role: 'assistant', content: FALLBACK_ERROR, outcome: 'error', escalationOffered: false });
      } finally {
        inFlightRef.current = false;
        setIsLoading(false);
      }
    },
    [append],
  );

  /** Send the current conversation to the support (CRM) team. */
  const escalate = useCallback(
    async (note?: string) => {
      const conversationId = conversationIdRef.current;
      if (!conversationId || inFlightRef.current) return;
      inFlightRef.current = true;
      setIsLoading(true);
      try {
        const { data, error } = await supabase.functions.invoke('agent-assistant', {
          body: {
            action: 'escalate',
            conversation_id: conversationId,
            ...(note?.trim() ? { note: note.trim().slice(0, 1000) } : {}),
          },
        });
        const res = await readResponse(data, error);
        if (!error) setEscalated(true);
        append({
          role: 'assistant',
          content: res.reply ?? (res.error || FALLBACK_ERROR),
          outcome: res.outcome ?? (error ? 'error' : 'answered'),
          escalationOffered: false,
        });
      } catch {
        append({ role: 'assistant', content: FALLBACK_ERROR, outcome: 'error', escalationOffered: false });
      } finally {
        inFlightRef.current = false;
        setIsLoading(false);
      }
    },
    [append],
  );

  /** Start over locally. The server also rotates sessions after 30 idle minutes. */
  const reset = useCallback(() => {
    conversationIdRef.current = undefined;
    setMessages([]);
    setEscalated(false);
  }, []);

  return { messages, isLoading, escalated, locationStatus, requestLocation, send, escalate, reset };
}
