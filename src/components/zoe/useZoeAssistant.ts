import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { safeUUID } from '@/lib/safeUUID';
import type { ZoeMorningBriefPayload } from '@/lib/zoe';

export type ZoeTurnOutcome =
  | 'answered'
  | 'clarify'
  | 'out_of_scope'
  | 'not_staff'
  | 'unmatched'
  | 'rate_limited'
  | 'blocked'
  | 'error';

export type ZoeFeedbackRating = 'up' | 'down';

export interface ZoeClarification {
  question: string;
  options: string[];
}

export interface ZoeMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  outcome?: ZoeTurnOutcome | null;
  source?: string | null;
  period?: string | null;
  clarification?: ZoeClarification | null;
  reportPayload?: Record<string, unknown> | null;
  feedback?: ZoeFeedbackRating | null;
  createdAt?: string;
}

interface StaffAssistantEdgeResponse {
  conversation_id?: string | null;
  message_id?: string | null;
  reply?: string;
  error?: string;
  outcome?: ZoeTurnOutcome;
  clarification?: ZoeClarification | null;
  source?: string | null;
  period?: string | null;
  report_payload?: Record<string, unknown> | null;
  mfa_required?: boolean;
  remaining_questions_today?: number;
  messages?: Array<{
    id: string;
    role: 'user' | 'assistant';
    content: string;
    outcome: ZoeTurnOutcome | null;
    source_label: string | null;
    period_label: string | null;
    report_payload: Record<string, unknown> | null;
    created_at: string;
  }>;
}

const FALLBACK_ERROR = "I'm having trouble reading that report right now. Please try again in a moment.";
const MAX_MESSAGE_LENGTH = 500;

function collectDevice() {
  if (typeof navigator === 'undefined') return undefined;
  let timezone: string | undefined;
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    /* ignore */
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

async function readEdgeResponse(data: unknown, error: unknown): Promise<StaffAssistantEdgeResponse> {
  if (!error) return (data ?? {}) as StaffAssistantEdgeResponse;
  const ctx = (error as { context?: unknown }).context;
  if (ctx instanceof Response) {
    try {
      return (await ctx.clone().json()) as StaffAssistantEdgeResponse;
    } catch {
      /* fall through */
    }
  }
  return { reply: FALLBACK_ERROR, error: FALLBACK_ERROR, outcome: 'error' };
}

/**
 * Checks whether the current signed-in user passes `public.staff_assistant_has_access()`.
 */
export function useZoeAccess() {
  const { user } = useAuth();
  return useQuery<boolean>({
    queryKey: ['staff-assistant-has-access', user?.id ?? null],
    enabled: Boolean(user?.id),
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      if (!user?.id) return false;
      const { data, error } = await supabase.rpc('staff_assistant_has_access' as never);
      if (error) return false;
      return data === true;
    },
  });
}

export interface UseZoeAssistantReturn {
  messages: ZoeMessage[];
  morningBrief: ZoeMorningBriefPayload | null;
  isLoading: boolean;
  isHistoryLoading: boolean;
  errorMessage: string | null;
  lastFailedPrompt: string | null;
  remainingQuestionsToday: number | null;
  sendMessage: (prompt: string) => Promise<void>;
  retryLastMessage: () => Promise<void>;
  submitFeedback: (messageId: string, rating: ZoeFeedbackRating) => Promise<void>;
  clearHistory: () => Promise<void>;
}

export function useZoeAssistant(enabled = true): UseZoeAssistantReturn {
  const { user } = useAuth();
  const [messages, setMessages] = useState<ZoeMessage[]>([]);
  const [morningBrief, setMorningBrief] = useState<ZoeMorningBriefPayload | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastFailedPrompt, setLastFailedPrompt] = useState<string | null>(null);
  const [remainingQuestionsToday, setRemainingQuestionsToday] = useState<number | null>(null);

  const conversationIdRef = useRef<string | undefined>(undefined);
  const inFlightRef = useRef(false);
  const generationRef = useRef(0);

  // Load recent server-owned conversation history when mounted or when user changes
  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    inFlightRef.current = false;
    conversationIdRef.current = undefined;
    setMessages([]);
    setIsLoading(false);
    setErrorMessage(null);
    setLastFailedPrompt(null);

    if (!user?.id || !enabled) {
      setIsHistoryLoading(false);
      return;
    }

    let cancelled = false;
    setIsHistoryLoading(true);
    setMorningBrief(null);
    supabase.functions
      .invoke('staff-assistant', { body: { action: 'history', limit: 30 } })
      .then(async ({ data, error }) => {
        if (cancelled || generation !== generationRef.current) return;
        const res = await readEdgeResponse(data, error);
        if (res.conversation_id) {
          conversationIdRef.current = res.conversation_id;
        }
        if (Array.isArray(res.messages) && res.messages.length > 0) {
          setMessages(
            res.messages.map((m) => ({
              id: m.id,
              role: m.role,
              content: m.content,
              outcome: m.outcome ?? null,
              source: m.source_label ?? null,
              period: m.period_label ?? null,
              reportPayload: m.report_payload ?? null,
              createdAt: m.created_at,
            })),
          );
        }
      })
      .catch(() => {
        /* ignore history load error on initial open */
      })
      .finally(() => {
        if (!cancelled && generation === generationRef.current) {
          setIsHistoryLoading(false);
        }
      });

    // Also load the optional 07:30 Kampala Morning Brief (off by default, turned on per person)
    supabase.functions
      .invoke<{ morning_brief?: ZoeMorningBriefPayload }>('staff-assistant', {
        body: { action: 'morning_brief', force: false },
      })
      .then(({ data }) => {
        if (cancelled || generation !== generationRef.current) return;
        if (data?.morning_brief) {
          setMorningBrief(data.morning_brief);
        }
      })
      .catch(() => {
        /* ignore brief load error */
      });

    return () => {
      cancelled = true;
    };
  }, [user?.id, enabled]);

  const sendMessage = useCallback(
    async (rawText: string) => {
      const prompt = rawText.trim().slice(0, MAX_MESSAGE_LENGTH);
      if (!prompt || inFlightRef.current || !user?.id) return;

      inFlightRef.current = true;
      setIsLoading(true);
      setErrorMessage(null);
      setLastFailedPrompt(null);

      const userTurnId = safeUUID();
      setMessages((prev) => [...prev, { id: userTurnId, role: 'user', content: prompt }]);
      const generation = generationRef.current;

      try {
        const { data, error } = await supabase.functions
          .invoke('staff-assistant', {
            body: {
              action: 'message',
              message: prompt,
              ...(conversationIdRef.current ? { conversation_id: conversationIdRef.current } : {}),
              client_context: { device: collectDevice() },
            },
          })
          .catch(() => ({ data: null, error: new Error(FALLBACK_ERROR) }));

        if (generation !== generationRef.current) return;
        const res = await readEdgeResponse(data, error);

        if (res.conversation_id) {
          conversationIdRef.current = res.conversation_id;
        }
        if (typeof res.remaining_questions_today === 'number') {
          setRemainingQuestionsToday(res.remaining_questions_today);
        }

        const outcome = res.outcome ?? (error ? 'error' : 'answered');
        const replyText = res.reply ?? res.error ?? FALLBACK_ERROR;

        if (outcome === 'error' || (error && !res.reply)) {
          setErrorMessage(replyText);
          setLastFailedPrompt(prompt);
          return;
        }

        setMessages((prev) => [
          ...prev,
          {
            id: res.message_id || safeUUID(),
            role: 'assistant',
            content: replyText,
            outcome,
            source: res.source ?? null,
            period: res.period ?? null,
            clarification: res.clarification ?? null,
            reportPayload: res.report_payload ?? null,
          },
        ]);
      } catch {
        if (generation === generationRef.current) {
          setErrorMessage(FALLBACK_ERROR);
          setLastFailedPrompt(prompt);
        }
      } finally {
        if (generation === generationRef.current) {
          inFlightRef.current = false;
          setIsLoading(false);
        }
      }
    },
    [user?.id],
  );

  const retryLastMessage = useCallback(async () => {
    if (!lastFailedPrompt || inFlightRef.current) return;
    const promptToRetry = lastFailedPrompt;
    // Remove the trailing failed user bubble before re-sending so it isn't duplicated
    setMessages((prev) => {
      if (prev.length > 0 && prev[prev.length - 1].role === 'user' && prev[prev.length - 1].content === promptToRetry) {
        return prev.slice(0, -1);
      }
      return prev;
    });
    await sendMessage(promptToRetry);
  }, [lastFailedPrompt, sendMessage]);

  const submitFeedback = useCallback(
    async (messageId: string, rating: ZoeFeedbackRating) => {
      if (!user?.id) return;
      setMessages((prev) =>
        prev.map((m) => (m.id === messageId ? { ...m, feedback: rating } : m)),
      );

      const convId = conversationIdRef.current;
      if (!convId) return;

      await supabase.functions
        .invoke('staff-assistant', {
          body: {
            action: 'feedback',
            conversation_id: convId,
            message_id: messageId,
            rating,
          },
        })
        .catch(() => {
          /* non-blocking */
        });
    },
    [user?.id],
  );

  const clearHistory = useCallback(async () => {
    const convId = conversationIdRef.current;
    generationRef.current += 1;
    inFlightRef.current = false;
    conversationIdRef.current = undefined;
    setMessages([]);
    setIsLoading(false);
    setErrorMessage(null);
    setLastFailedPrompt(null);

    if (!user?.id) return;
    await supabase.functions
      .invoke('staff-assistant', {
        body: {
          action: 'clear_history',
          ...(convId ? { conversation_id: convId } : {}),
        },
      })
      .catch(() => {
        /* ignore */
      });
  }, [user?.id]);

  return {
    messages,
    morningBrief,
    isLoading,
    isHistoryLoading,
    errorMessage,
    lastFailedPrompt,
    remainingQuestionsToday,
    sendMessage,
    retryLastMessage,
    submitFeedback,
    clearHistory,
  };
}
