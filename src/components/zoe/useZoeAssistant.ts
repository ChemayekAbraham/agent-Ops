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

export interface ZoeConversationListItem {
  id: string;
  title: string;
  message_count: number;
  last_active_at: string;
  created_at: string;
}

export interface ZoeNoteItem {
  id: string;
  note_text: string;
  created_at: string;
}

export interface ZoeGlossaryEntry {
  slug: string;
  term: string;
  category: string;
  plain_definition: string;
  measurement_gotcha: string;
  official_source: string;
  screen_path: string;
  keywords?: string[];
  updated_at?: string;
}

export interface ZoeGlossaryUpsertInput {
  slug: string;
  term: string;
  category: string;
  plain_definition: string;
  measurement_gotcha?: string;
  official_source?: string;
  screen_path?: string;
  keywords?: string[];
  is_active?: boolean;
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
  followUpSuggestions?: string[];
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
  follow_up_suggestions?: string[];
  status_steps?: string[];
  mfa_required?: boolean;
  remaining_questions_today?: number;
  conversations?: ZoeConversationListItem[];
  conversation?: ZoeConversationListItem;
  title?: string;
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
export const MAX_MESSAGE_LENGTH = 2000;

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
  conversations: ZoeConversationListItem[];
  activeConversationId: string | null;
  morningBrief: ZoeMorningBriefPayload | null;
  notes: ZoeNoteItem[];
  glossaryEntries: ZoeGlossaryEntry[];
  isLoading: boolean;
  isHistoryLoading: boolean;
  streamingText: string | null;
  statusLine: string | null;
  errorMessage: string | null;
  lastFailedPrompt: string | null;
  remainingQuestionsToday: number | null;
  sendMessage: (prompt: string) => Promise<void>;
  stopGenerating: () => void;
  regenerateLastAnswer: () => Promise<void>;
  retryLastMessage: () => Promise<void>;
  submitFeedback: (messageId: string, rating: ZoeFeedbackRating) => Promise<void>;
  clearHistory: () => Promise<void>;
  selectConversation: (conversationId: string) => Promise<void>;
  startNewChat: () => Promise<void>;
  renameConversation: (conversationId: string, title: string) => Promise<void>;
  addNote: (noteText: string) => Promise<{ ok: boolean; error?: string }>;
  deleteNote: (noteId: string) => Promise<{ ok: boolean }>;
  saveGlossaryEntry: (input: ZoeGlossaryUpsertInput) => Promise<{ ok: boolean; error?: string }>;
}

export function useZoeAssistant(enabled = true): UseZoeAssistantReturn {
  const { user } = useAuth();
  const [messages, setMessages] = useState<ZoeMessage[]>([]);
  const [conversations, setConversations] = useState<ZoeConversationListItem[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [morningBrief, setMorningBrief] = useState<ZoeMorningBriefPayload | null>(null);
  const [notes, setNotes] = useState<ZoeNoteItem[]>([]);
  const [glossaryEntries, setGlossaryEntries] = useState<ZoeGlossaryEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [statusLine, setStatusLine] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastFailedPrompt, setLastFailedPrompt] = useState<string | null>(null);
  const [remainingQuestionsToday, setRemainingQuestionsToday] = useState<number | null>(null);

  const conversationIdRef = useRef<string | undefined>(undefined);
  const inFlightRef = useRef(false);
  const generationRef = useRef(0);
  const streamTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);


  const clearStreamTimer = useCallback(() => {
    if (streamTimerRef.current) {
      clearInterval(streamTimerRef.current);
      streamTimerRef.current = null;
    }
  }, []);

  // Load recent server-owned conversation history and conversation list when mounted or when user changes
  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    clearStreamTimer();
    inFlightRef.current = false;
    conversationIdRef.current = undefined;
    setActiveConversationId(null);
    setMessages([]);
    setConversations([]);
    setIsLoading(false);
    setStreamingText(null);
    setStatusLine(null);
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
      .invoke('staff-assistant', { body: { action: 'history', limit: 40 } })
      .then(async ({ data, error }) => {
        if (cancelled || generation !== generationRef.current) return;
        const res = await readEdgeResponse(data, error);
        if (res.conversation_id) {
          conversationIdRef.current = res.conversation_id;
          setActiveConversationId(res.conversation_id);
        }
        if (Array.isArray(res.messages) && res.messages.length > 0) {
          setMessages(
            res.messages.map((m) => {
              const rp = m.report_payload ?? null;
              const followUps =
                rp && Array.isArray(rp.follow_up_suggestions)
                  ? (rp.follow_up_suggestions as string[])
                  : undefined;
              return {
                id: m.id,
                role: m.role,
                content: m.content,
                outcome: m.outcome ?? null,
                source: m.source_label ?? null,
                period: m.period_label ?? null,
                reportPayload: rp,
                followUpSuggestions: followUps,
                createdAt: m.created_at,
              };
            }),
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

    // Load conversation list
    supabase.functions
      .invoke('staff-assistant', { body: { action: 'conversations', limit: 25 } })
      .then(async ({ data, error }) => {
        if (cancelled || generation !== generationRef.current) return;
        const res = await readEdgeResponse(data, error);
        if (Array.isArray(res.conversations)) {
          setConversations(res.conversations);
        }
      })
      .catch(() => {
        /* ignore */
      });

    // Load optional 07:30 Kampala Morning Brief
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

    // Load per-person Zoe notes (up to 20 short preferences)
    supabase.functions
      .invoke<{ notes?: ZoeNoteItem[] }>('staff-assistant', {
        body: { action: 'list_notes' },
      })
      .then(({ data }) => {
        if (cancelled || generation !== generationRef.current) return;
        if (Array.isArray(data?.notes)) {
          setNotes(data.notes);
        }
      })
      .catch(() => {
        /* ignore notes load error */
      });

    // Load Welile glossary entries
    supabase.functions
      .invoke<{ rows?: ZoeGlossaryEntry[] }>('staff-assistant', {
        body: { action: 'list_glossary' },
      })
      .then(({ data }) => {
        if (cancelled || generation !== generationRef.current) return;
        if (Array.isArray(data?.rows)) {
          setGlossaryEntries(data.rows);
        }
      })
      .catch(() => {
        /* ignore glossary load error */
      });

    return () => {
      cancelled = true;
      clearStreamTimer();
    };
  }, [user?.id, enabled, clearStreamTimer]);

  const stopGenerating = useCallback(() => {
    generationRef.current += 1;
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    clearStreamTimer();
    inFlightRef.current = false;
    setIsLoading(false);
    setStreamingText(null);
    setStatusLine(null);
  }, [clearStreamTimer]);


  const sendMessage = useCallback(
    async (rawText: string) => {
      const prompt = rawText.trim().slice(0, MAX_MESSAGE_LENGTH);
      if (!prompt || inFlightRef.current || !user?.id) return;

      clearStreamTimer();
      inFlightRef.current = true;
      setIsLoading(true);
      setStreamingText(null);
      setStatusLine(
        /compare|difference|vs|last week|last month/i.test(prompt)
          ? 'Comparing periods...'
          : 'Looking up official records...',
      );
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
          setActiveConversationId(res.conversation_id);
          setConversations((prev) => {
            const exists = prev.some((c) => c.id === res.conversation_id);
            const nowIso = new Date().toISOString();
            if (exists) {
              return prev.map((c) =>
                c.id === res.conversation_id
                  ? { ...c, last_active_at: nowIso, message_count: c.message_count + 2 }
                  : c,
              );
            }
            return [
              {
                id: res.conversation_id!,
                title: prompt.slice(0, 80),
                message_count: 2,
                last_active_at: nowIso,
                created_at: nowIso,
              },
              ...prev,
            ];
          });
        }
        if (typeof res.remaining_questions_today === 'number') {
          setRemainingQuestionsToday(res.remaining_questions_today);
        }

        if (Array.isArray(res.status_steps) && res.status_steps.length > 0) {
          setStatusLine(res.status_steps[res.status_steps.length - 1]);
        }

        const outcome = res.outcome ?? (error ? 'error' : 'answered');
        const replyText = res.reply ?? res.error ?? FALLBACK_ERROR;

        if (outcome === 'error' || (error && !res.reply)) {
          setErrorMessage(replyText);
          setLastFailedPrompt(prompt);
          return;
        }

        const followUps = Array.isArray(res.follow_up_suggestions)
          ? res.follow_up_suggestions
          : Array.isArray(res.report_payload?.follow_up_suggestions)
          ? (res.report_payload?.follow_up_suggestions as string[])
          : undefined;

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
            followUpSuggestions: followUps,
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
          setStreamingText(null);
          setStatusLine(null);
        }
      }
    },
    [user?.id, clearStreamTimer],
  );

  const regenerateLastAnswer = useCallback(async () => {
    if (inFlightRef.current) return;
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUserMsg) return;
    setMessages((prev) => {
      if (prev.length >= 2 && prev[prev.length - 1].role === 'assistant') {
        return prev.slice(0, -2);
      }
      return prev;
    });
    await sendMessage(lastUserMsg.content);
  }, [messages, sendMessage]);

  const retryLastMessage = useCallback(async () => {
    if (!lastFailedPrompt || inFlightRef.current) return;
    const promptToRetry = lastFailedPrompt;
    setMessages((prev) => {
      if (prev.length > 0 && prev[prev.length - 1].role === 'user' && prev[prev.length - 1].content === promptToRetry) {
        return prev.slice(0, -1);
      }
      return prev;
    });
    await sendMessage(promptToRetry);
  }, [lastFailedPrompt, sendMessage]);

  const submitFeedback = useCallback(
    async (
      messageId: string,
      rating: ZoeFeedbackRating,
      options?: { comment?: string; reportKind?: 'rating' | 'problem_report' },
    ) => {
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
            ...(options?.reportKind ? { report_kind: options.reportKind } : {}),
            ...(options?.comment?.trim() ? { comment: options.comment.trim() } : {}),
          },
        })
        .catch(() => {
          /* non-blocking */
        });
    },
    [user?.id],
  );

  const selectConversation = useCallback(
    async (conversationId: string) => {
      if (!user?.id || inFlightRef.current) return;
      conversationIdRef.current = conversationId;
      setActiveConversationId(conversationId);
      setIsHistoryLoading(true);
      setErrorMessage(null);
      try {
        const { data, error } = await supabase.functions.invoke('staff-assistant', {
          body: { action: 'history', conversation_id: conversationId, limit: 40 },
        });
        const res = await readEdgeResponse(data, error);
        if (Array.isArray(res.messages)) {
          setMessages(
            res.messages.map((m) => {
              const rp = m.report_payload ?? null;
              const followUps =
                rp && Array.isArray(rp.follow_up_suggestions)
                  ? (rp.follow_up_suggestions as string[])
                  : undefined;
              return {
                id: m.id,
                role: m.role,
                content: m.content,
                outcome: m.outcome ?? null,
                source: m.source_label ?? null,
                period: m.period_label ?? null,
                reportPayload: rp,
                followUpSuggestions: followUps,
                createdAt: m.created_at,
              };
            }),
          );
        } else {
          setMessages([]);
        }
      } catch {
        setMessages([]);
      } finally {
        setIsHistoryLoading(false);
      }
    },
    [user?.id],
  );

  const startNewChat = useCallback(async () => {
    stopGenerating();
    conversationIdRef.current = undefined;
    setActiveConversationId(null);
    setMessages([]);
    setErrorMessage(null);
    setLastFailedPrompt(null);

    if (!user?.id) return;
    try {
      const { data, error } = await supabase.functions.invoke('staff-assistant', {
        body: { action: 'new_conversation', title: 'New chat' },
      });
      const res = await readEdgeResponse(data, error);
      if (res.conversation?.id) {
        conversationIdRef.current = res.conversation.id;
        setActiveConversationId(res.conversation.id);
        setConversations((prev) => [res.conversation!, ...prev.filter((c) => c.id !== res.conversation!.id)]);
      }
    } catch {
      /* ignore */
    }
  }, [user?.id, stopGenerating]);

  const renameConversation = useCallback(
    async (conversationId: string, title: string) => {
      const clean = title.trim().slice(0, 120);
      if (!clean || !user?.id) return;
      setConversations((prev) =>
        prev.map((c) => (c.id === conversationId ? { ...c, title: clean } : c)),
      );
      await supabase.functions
        .invoke('staff-assistant', {
          body: {
            action: 'rename_conversation',
            conversation_id: conversationId,
            title: clean,
          },
        })
        .catch(() => {
          /* ignore */
        });
    },
    [user?.id],
  );

  const clearHistory = useCallback(async () => {
    const convId = conversationIdRef.current;
    generationRef.current += 1;
    clearStreamTimer();
    inFlightRef.current = false;
    conversationIdRef.current = undefined;
    setActiveConversationId(null);
    setMessages([]);
    setIsLoading(false);
    setStreamingText(null);
    setStatusLine(null);
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
  }, [user?.id, clearStreamTimer]);

  const addNote = useCallback(
    async (noteText: string): Promise<{ ok: boolean; error?: string }> => {
      const cleaned = noteText.trim();
      if (!cleaned || !user?.id) {
        return { ok: false, error: 'Please enter a short preference note (2–240 characters).' };
      }
      try {
        const { data, error } = await supabase.functions.invoke<{
          ok?: boolean;
          error?: string;
          notes?: ZoeNoteItem[];
        }>('staff-assistant', {
          body: { action: 'add_note', note_text: cleaned },
        });
        const res = await readEdgeResponse(data, error);
        if (Array.isArray((data as { notes?: ZoeNoteItem[] } | null)?.notes)) {
          setNotes((data as { notes: ZoeNoteItem[] }).notes);
        }
        if ((data as { ok?: boolean } | null)?.ok === false || error) {
          return {
            ok: false,
            error:
              res.error ||
              'Zoe notes may only store short preferences and must never contain business figures or personal data.',
          };
        }
        return { ok: true };
      } catch {
        return { ok: false, error: 'Could not save Zoe note right now.' };
      }
    },
    [user?.id],
  );

  const deleteNote = useCallback(
    async (noteId: string): Promise<{ ok: boolean }> => {
      if (!noteId || !user?.id) return { ok: false };
      setNotes((prev) => prev.filter((n) => n.id !== noteId));
      try {
        const { data } = await supabase.functions.invoke<{
          ok?: boolean;
          notes?: ZoeNoteItem[];
        }>('staff-assistant', {
          body: { action: 'delete_note', note_id: noteId },
        });
        if (Array.isArray(data?.notes)) {
          setNotes(data.notes);
        }
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
    [user?.id],
  );

  const saveGlossaryEntry = useCallback(
    async (input: ZoeGlossaryUpsertInput): Promise<{ ok: boolean; error?: string }> => {
      if (!user?.id) return { ok: false, error: 'Not signed in.' };
      try {
        const { data, error } = await supabase.rpc(
          'zoe_glossary_upsert_entry' as never,
          {
            p_slug: input.slug,
            p_term: input.term,
            p_category: input.category,
            p_plain_definition: input.plain_definition,
            p_measurement_gotcha: input.measurement_gotcha ?? '',
            p_official_source: input.official_source ?? '',
            p_screen_path: input.screen_path ?? '/me',
            p_keywords: input.keywords ?? [],
            p_is_active: input.is_active ?? true,
          } as never,
        );
        if (error) {
          return { ok: false, error: error.message };
        }
        const entry = (data as { entry?: ZoeGlossaryEntry } | null)?.entry;
        if (entry) {
          setGlossaryEntries((prev) => {
            const idx = prev.findIndex((e) => e.slug === entry.slug);
            if (idx >= 0) {
              const next = [...prev];
              next[idx] = entry;
              return next;
            }
            return [...prev, entry];
          });
        }
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'Could not save glossary entry.',
        };
      }
    },
    [user?.id],
  );

  return {
    messages,
    conversations,
    activeConversationId,
    morningBrief,
    notes,
    glossaryEntries,
    isLoading,
    isHistoryLoading,
    streamingText,
    statusLine,
    errorMessage,
    lastFailedPrompt,
    remainingQuestionsToday,
    sendMessage,
    stopGenerating,
    regenerateLastAnswer,
    retryLastMessage,
    submitFeedback,
    clearHistory,
    selectConversation,
    startNewChat,
    renameConversation,
    addNote,
    deleteNote,
    saveGlossaryEntry,
  };
}

